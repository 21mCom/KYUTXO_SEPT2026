import { db } from "@/lib/database";
import type { Record as VaultRecord, RecordOrigin } from "@/lib/database";
import { isHiddenDiscoveryTier, isValidImportanceTier } from "@/lib/db-types";
import { getStaleTypeSpecificFields } from "@/lib/record-type-clears";
import { isEncryptedPlaceholder } from "@/lib/legacy-decrypt";
import { canonicalizeRecordIdentifier } from "@/lib/bitcoin";
import { detectSingularFieldConflicts } from "@/lib/conflict-detection";
import { getAddressSyncStateAfterId } from "@/lib/data/address-sync-crud";
import { getPrivacyAuditHistory } from "@/lib/data/privacy-history-crud";
import { loadAuditSession } from "@/lib/data/privacy-audit-session-store";
import { getRecordsAfterId } from "@/lib/data/record-crud";
import { getRecordOriginsByRecordIds } from "@/lib/data/record-origins-crud";

export type VaultHealthStatus = "healthy" | "warning" | "problem";

export interface HealthTableCount {
  name: string;
  count: number;
  error: boolean;
}

export interface VaultHealthSnapshot {
  checkedAt: number;
  tableCounts: HealthTableCount[];
  integrity: {
    totalRecords: number;
    lockedUnreadable: number;
    blankIdentifiers: number;
    tableErrors: number;
  };
  metadata: {
    missingTier: number;
    invalidTier: number;
    searchKeyDesynced: number;
    staleTypeFields: number;
    nonCanonicalIdentifiers: number;
    canonicalIdentifierCollisions: number;
    hiddenTagged: number;
  };
  conflicts: {
    records: number;
    fields: number;
  };
  sync: {
    addressRecords: number;
    neverSynced: number;
    stale: number;
    syncStateRows: number;
    latestSyncedAt?: number;
    unavailable: boolean;
  };
  backup: {
    recordCount: number;
    attachmentCount: number;
    tableCount: number;
    canExport: boolean;
  };
  privacy: {
    hasRun: boolean;
    interrupted: boolean;
    lastRunAt?: number;
    score?: number;
    findings: number;
    criticalOrHigh: number;
    unavailable: boolean;
  };
}

export interface VaultHealthProgress {
  phase: string;
  processed?: number;
  total?: number;
}

export class VaultHealthCancelledError extends Error {
  constructor() {
    super("Vault health check cancelled");
    this.name = "VaultHealthCancelledError";
  }
}

const BATCH_SIZE = 1000;
const SYNC_STALE_MS = 30 * 24 * 60 * 60 * 1000;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new VaultHealthCancelledError();
}

async function yieldToUi(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  throwIfAborted(signal);
}

async function scanById<T extends { id?: number }>(
  read: (afterId: number, limit: number) => Promise<T[]>,
  onBatch: (rows: T[]) => void | Promise<void>,
  signal?: AbortSignal,
  onProgress?: (processed: number) => void,
): Promise<number> {
  let afterId = 0;
  let processed = 0;
  for (;;) {
    throwIfAborted(signal);
    const rows = await read(afterId, BATCH_SIZE);
    if (rows.length === 0) break;
    await onBatch(rows);
    processed += rows.length;
    onProgress?.(processed);
    const lastId = rows[rows.length - 1].id;
    if (lastId == null || rows.length < BATCH_SIZE) break;
    afterId = lastId;
    await yieldToUi(signal);
  }
  return processed;
}

function hasEncryptionMarker(row: VaultRecord): boolean {
  const legacy = (row as unknown as Record<string, unknown>)["_legacyEncryptedPayload"];
  const encryptedPayload = (row as unknown as Record<string, unknown>)["encryptedPayload"];
  return (
    (typeof legacy === "string" && legacy.length > 0) ||
    (typeof encryptedPayload === "string" && encryptedPayload.length > 0) ||
    (row as unknown as Record<string, unknown>)["isEncrypted"] === true
  );
}

function isUnreadable(row: VaultRecord): boolean {
  return (
    row.inputString == null ||
    (typeof row.inputString === "string" && row.inputString.trim() === "") ||
    isEncryptedPlaceholder(row.inputString)
  );
}

export function getVaultHealthStatus(snapshot: VaultHealthSnapshot): VaultHealthStatus {
  if (
    snapshot.integrity.lockedUnreadable > 0 ||
    snapshot.integrity.tableErrors > 0 ||
    snapshot.metadata.canonicalIdentifierCollisions > 0 ||
    snapshot.sync.unavailable ||
    snapshot.privacy.unavailable ||
    snapshot.privacy.criticalOrHigh > 0
  ) {
    return "problem";
  }
  if (
    snapshot.integrity.blankIdentifiers > 0 ||
    snapshot.metadata.missingTier > 0 ||
    snapshot.metadata.invalidTier > 0 ||
    snapshot.metadata.searchKeyDesynced > 0 ||
    snapshot.metadata.staleTypeFields > 0 ||
    snapshot.metadata.nonCanonicalIdentifiers > 0 ||
    snapshot.metadata.hiddenTagged > 0 ||
    snapshot.conflicts.records > 0 ||
    snapshot.sync.neverSynced > 0 ||
    snapshot.sync.stale > 0 ||
    !snapshot.privacy.hasRun ||
    snapshot.privacy.interrupted ||
    snapshot.privacy.findings > 0
  ) {
    return "warning";
  }
  return "healthy";
}

export async function runVaultHealthCheck(options: {
  signal?: AbortSignal;
  onProgress?: (progress: VaultHealthProgress) => void;
} = {}): Promise<VaultHealthSnapshot> {
  const { signal, onProgress } = options;
  throwIfAborted(signal);

  onProgress?.({ phase: "Counting local tables…" });
  const tableCounts: HealthTableCount[] = [];
  await Promise.all(
    db.tables.map(async (table) => {
      try {
        tableCounts.push({ name: table.name, count: await table.count(), error: false });
      } catch {
        tableCounts.push({ name: table.name, count: 0, error: true });
      }
    }),
  );
  tableCounts.sort((a, b) => a.name.localeCompare(b.name));

  const recordTable = tableCounts.find((table) => table.name === "records");
  const totalRecords = recordTable?.count ?? 0;
  const addressRecordIdsByInput = new Map<string, Set<number>>();
  const addressRecordIds = new Set<number>();
  const canonicalKeyCounts = new Map<string, { total: number; nonCanonical: number }>();
  const integrity = {
    totalRecords: 0,
    lockedUnreadable: 0,
    blankIdentifiers: 0,
    tableErrors: tableCounts.filter((table) => table.error).length,
  };
  const metadata = {
    missingTier: 0,
    invalidTier: 0,
    searchKeyDesynced: 0,
    staleTypeFields: 0,
    nonCanonicalIdentifiers: 0,
    canonicalIdentifierCollisions: 0,
    hiddenTagged: 0,
  };
  let conflictRecords = 0;
  let conflictFields = 0;
  const originTable = tableCounts.find((table) => table.name === "recordOrigins");

  if (!recordTable?.error) {
    onProgress?.({ phase: "Checking records and conflicts…", processed: 0, total: totalRecords });
    await scanById(
      (afterId, limit) => getRecordsAfterId(afterId, limit),
      async (rows) => {
        throwIfAborted(signal);
        const originsByRecordId = new Map<number, RecordOrigin[]>();
        if (!originTable?.error) {
          const ids = rows.flatMap((row) => (row.id == null ? [] : [row.id]));
          const origins = await getRecordOriginsByRecordIds(ids);
          for (const origin of origins) {
            const list = originsByRecordId.get(origin.recordId);
            if (list) list.push(origin);
            else originsByRecordId.set(origin.recordId, [origin]);
          }
        }
      for (const row of rows) {
        integrity.totalRecords += 1;
        const unreadable = isUnreadable(row);
        if (unreadable) integrity.blankIdentifiers += 1;
        if (hasEncryptionMarker(row) && unreadable) integrity.lockedUnreadable += 1;

        if (row.type === "address") {
          if (row.id != null) {
            addressRecordIds.add(row.id);
            if (row.inputString) {
              const ids = addressRecordIdsByInput.get(row.inputString) ?? new Set<number>();
              ids.add(row.id);
              addressRecordIdsByInput.set(row.inputString, ids);
            }
          }
        }
        if (typeof row.inputString === "string" && row.inputString.length > 0) {
          const canonical = canonicalizeRecordIdentifier(row.inputString);
          const counts = canonicalKeyCounts.get(canonical) ?? { total: 0, nonCanonical: 0 };
          counts.total += 1;
          if (canonical !== row.inputString) {
            counts.nonCanonical += 1;
            metadata.nonCanonicalIdentifiers += 1;
          }
          canonicalKeyCounts.set(canonical, counts);
        }

        // Old restored rows can carry an empty or unrecognized tier even
        // though the current TypeScript shape only permits known values.
        const tier: unknown = row.addressImportance;
        if (tier == null || tier === "") metadata.missingTier += 1;
        else if (!isValidImportanceTier(tier)) metadata.invalidTier += 1;
        const expectedLower =
          typeof row.inputString === "string" && row.inputString
            ? row.inputString.toLowerCase()
            : "";
        if (row.inputStringLower !== expectedLower) metadata.searchKeyDesynced += 1;
        if (getStaleTypeSpecificFields(row).length > 0) metadata.staleTypeFields += 1;
        if (isHiddenDiscoveryTier(typeof tier === "string" ? tier : undefined)) {
          const hasUserMetadata =
            Boolean(row.label?.trim()) ||
            Boolean(row.notes?.trim()) ||
            (Array.isArray(row.tags) && row.tags.length > 0);
          if (hasUserMetadata) metadata.hiddenTagged += 1;
        }
        if (row.id != null) {
          const origins = originsByRecordId.get(row.id) ?? [];
          if (origins.length >= 2) {
            const conflicts = detectSingularFieldConflicts(row, origins);
            if (conflicts.length > 0) {
              conflictRecords += 1;
              conflictFields += conflicts.length;
            }
          }
        }
      }
      onProgress?.({
        phase: "Checking records and conflicts…",
        processed: integrity.totalRecords,
        total: totalRecords,
      });
      },
      signal,
    );
  }
  metadata.canonicalIdentifierCollisions = Array.from(canonicalKeyCounts.values()).reduce(
    (total, counts) => total + (counts.total > 1 ? counts.nonCanonical : 0),
    0,
  );

  const sync = {
    addressRecords: addressRecordIds.size,
    neverSynced: addressRecordIds.size,
    stale: 0,
    syncStateRows: 0,
    latestSyncedAt: undefined as number | undefined,
    unavailable: tableCounts.find((table) => table.name === "addressSyncState")?.error ?? false,
  };
  const syncedRecordIds = new Set<number>();
  const staleRecordIds = new Set<number>();
  if (!sync.unavailable) {
    try {
      onProgress?.({ phase: "Checking sync freshness…" });
      await scanById(
        (afterId, limit) => getAddressSyncStateAfterId(afterId, limit),
        (rows) => {
          const now = Date.now();
          for (const row of rows) {
            sync.syncStateRows += 1;
            const linkedIds =
              row.recordId != null && addressRecordIds.has(row.recordId)
                ? [row.recordId]
                : Array.from(addressRecordIdsByInput.get(row.address) ?? []);
            if (linkedIds.length === 0) continue;
            for (const recordId of linkedIds) syncedRecordIds.add(recordId);
            if (row.lastSyncedAt > (sync.latestSyncedAt ?? 0)) {
              sync.latestSyncedAt = row.lastSyncedAt;
            }
            if (!row.lastSyncedAt || now - row.lastSyncedAt > SYNC_STALE_MS) {
              for (const recordId of linkedIds) staleRecordIds.add(recordId);
            }
          }
          onProgress?.({ phase: "Checking sync freshness…", processed: sync.syncStateRows });
        },
        signal,
      );
    } catch (error) {
      if (error instanceof VaultHealthCancelledError) throw error;
      sync.unavailable = true;
    }
  }
  if (!sync.unavailable) {
    sync.neverSynced = Math.max(0, addressRecordIds.size - syncedRecordIds.size);
    sync.stale = staleRecordIds.size;
  }

  onProgress?.({ phase: "Reading privacy and backup readiness…" });
  let privacyUnavailable =
    tableCounts.find((table) => table.name === "privacyAuditHistory")?.error ?? false;
  let privacyHistory: Awaited<ReturnType<typeof getPrivacyAuditHistory>> = [];
  let privacySession: Awaited<ReturnType<typeof loadAuditSession>> = null;
  if (!privacyUnavailable) {
    try {
      [privacyHistory, privacySession] = await Promise.all([
        getPrivacyAuditHistory(1),
        loadAuditSession(),
      ]);
    } catch (error) {
      if (error instanceof VaultHealthCancelledError) throw error;
      privacyUnavailable = true;
    }
  }
  const latestPrivacy = privacyHistory[privacyHistory.length - 1];
  const privacy = {
    hasRun: Boolean(latestPrivacy),
    interrupted: privacySession?.phase === "auditing",
    lastRunAt: latestPrivacy?.timestamp,
    score: latestPrivacy?.score,
    findings: latestPrivacy?.totalFindings ?? 0,
    criticalOrHigh:
      (latestPrivacy?.severityCounts.CRITICAL ?? 0) +
      (latestPrivacy?.severityCounts.HIGH ?? 0),
    unavailable: privacyUnavailable,
  };
  throwIfAborted(signal);

  return {
    checkedAt: Date.now(),
    tableCounts,
    integrity,
    metadata,
    conflicts: { records: conflictRecords, fields: conflictFields },
    sync,
    backup: {
      recordCount: totalRecords,
      attachmentCount: tableCounts.find((table) => table.name === "attachments")?.count ?? 0,
      tableCount: tableCounts.length,
      canExport: tableCounts.every((table) => !table.error),
    },
    privacy,
  };
}
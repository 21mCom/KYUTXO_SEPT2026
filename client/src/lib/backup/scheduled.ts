import { getElectronAPISafe } from "@/lib/electron";
import { getSettings, mutateSettings } from "@/lib/data/settings-crud";
import { countRecords } from "@/lib/data/record-crud";
import { countAttachments, sumAttachmentSizes } from "@/lib/data/attachments-crud";
import { countTransactions, countTransactionParticipants } from "@/lib/data/transaction-crud";
import { countAddressSyncState } from "@/lib/data/address-sync-crud";
import { countUtxoLineage, countCustodySegments, countLineageSnapshots } from "@/lib/data/lineage-crud";
import { estimateExportBytes, exportBackup } from "./export";
import { computeCompactPlan } from "./compact";
import { BackupCancelledError, type BackupSink } from "./sink";
import { peekManifest } from "./restore";
import {
  isV3Manifest,
  parseInline,
  parseBatchLine,
  getBackupKdfParams,
  isStreamedTablePath,
  STREAMED_TABLES,
  ATTACHMENTS_DIR,
  CHECK_SENTINEL,
  type BackupManifest,
  type StreamedTable,
} from "./format";
import { deriveKeyWithParams, base64ToBuffer, decrypt } from "@/lib/crypto";
import { readZipStream, lineConsumer, collectBytesConsumer } from "./zip-stream";
import type {
  BackupDestination,
  BackupDestinationState,
  BackupFreeSpaceReading,
  BackupScheduleSettings,
} from "@/lib/db-types";

export const DEFAULT_BACKUP_SCHEDULE: BackupScheduleSettings = {
  enabled: false,
  destinations: [],
  cadenceDays: 7,
  retentionCount: 5,
  compact: false,
  encrypted: true,
  promptBehavior: "ask",
};

// Health checks are user-initiated and may happen more often than scheduled
// backups. Keep enough points for a useful trend without allowing settings to
// grow without bound.
export const BACKUP_FREE_SPACE_HISTORY_LIMIT = 30;

function normalizeFreeSpaceHistory(value: unknown): BackupFreeSpaceReading[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const readings = value
    .filter((reading): reading is BackupFreeSpaceReading =>
      Boolean(reading) &&
      typeof reading === "object" &&
      typeof (reading as BackupFreeSpaceReading).at === "number" &&
      Number.isFinite((reading as BackupFreeSpaceReading).at) &&
      typeof (reading as BackupFreeSpaceReading).freeBytes === "number" &&
      Number.isFinite((reading as BackupFreeSpaceReading).freeBytes) &&
      (reading as BackupFreeSpaceReading).freeBytes >= 0,
    )
    .map((reading) => ({
      at: reading.at,
      freeBytes: Math.max(0, reading.freeBytes),
    }))
    .sort((a, b) => a.at - b.at);
  return readings.length > 0 ? readings.slice(-BACKUP_FREE_SPACE_HISTORY_LIMIT) : undefined;
}

export function appendBackupFreeSpaceReading(
  history: BackupFreeSpaceReading[] | undefined,
  reading: BackupFreeSpaceReading,
): BackupFreeSpaceReading[] {
  const normalized = normalizeFreeSpaceHistory(history) ?? [];
  const last = normalized[normalized.length - 1];
  if (last?.at === reading.at && last.freeBytes === reading.freeBytes) return normalized;
  return [...normalized, { at: reading.at, freeBytes: Math.max(0, reading.freeBytes) }]
    .slice(-BACKUP_FREE_SPACE_HISTORY_LIMIT);
}

export function mergeVerifiedBackupDestination(
  schedule: BackupScheduleSettings,
  token: string,
  verified: { at: number; sizeBytes?: number; checksum?: string; label: string },
): BackupScheduleSettings {
  const current = schedule.destinationStates?.[token];
  return {
    ...schedule,
    lastVerifiedAt: verified.at,
    lastVerifiedDestination: verified.label,
    lastVerifiedSizeBytes: verified.sizeBytes,
    lastVerifiedChecksum: verified.checksum,
    destinationStates: {
      ...schedule.destinationStates,
      [token]: {
        ...current,
        lastVerifiedAt: verified.at,
        lastVerifiedSizeBytes: verified.sizeBytes,
        lastVerifiedChecksum: verified.checksum,
        lastFailureAt: undefined,
        lastFailureMessage: undefined,
      },
    },
  };
}

export function mergeBackupSchedulePolicy(
  currentValue: BackupScheduleSettings | undefined,
  editedValue: BackupScheduleSettings,
): BackupScheduleSettings {
  const current = normalizeBackupSchedule(currentValue);
  const edited = normalizeBackupSchedule(editedValue);
  const configuredTokens = new Set(edited.destinations.map((destination) => destination.token));
  const destinationStates = Object.fromEntries(
    Object.entries(current.destinationStates ?? {}).filter(([token]) => configuredTokens.has(token)),
  );
  return {
    ...current,
    enabled: edited.enabled,
    destinations: edited.destinations,
    cadenceDays: edited.cadenceDays,
    retentionCount: edited.retentionCount,
    compact: edited.compact,
    encrypted: edited.encrypted,
    promptBehavior: edited.promptBehavior,
    destinationStates: Object.keys(destinationStates).length > 0 ? destinationStates : undefined,
  };
}

async function mutateBackupSchedule(
  mutate: (current: BackupScheduleSettings) => BackupScheduleSettings,
): Promise<BackupScheduleSettings> {
  const updated = await mutateSettings("default", (settings) => ({
    backupSchedule: mutate(normalizeBackupSchedule(settings.backupSchedule)),
  }));
  return normalizeBackupSchedule(updated?.backupSchedule);
}

export function normalizeBackupSchedule(value?: BackupScheduleSettings): BackupScheduleSettings {
  const source: Partial<BackupScheduleSettings> = value ?? {};
  const cadenceValue = source.cadenceDays;
  const cadence = typeof cadenceValue === "number" && [1, 7, 14, 30, 90].includes(cadenceValue)
    ? cadenceValue
    : 7;
  const retentionValue = source.retentionCount;
  const destinationStates = source.destinationStates && typeof source.destinationStates === "object"
    ? Object.fromEntries(
      Object.entries(source.destinationStates).flatMap(([token, state]) => {
        if (!/^[a-f0-9]{32}$/i.test(token) || !state || typeof state !== "object") return [];
        const typedState = state as BackupDestinationState;
        const freeSpaceHistory = normalizeFreeSpaceHistory(typedState.freeSpaceHistory);
        return [[token, {
          ...typedState,
          ...(freeSpaceHistory ? { freeSpaceHistory } : { freeSpaceHistory: undefined }),
        }]];
      }),
    )
    : undefined;
  return {
    ...DEFAULT_BACKUP_SCHEDULE,
    ...source,
    // Legacy path strings are intentionally discarded: only picker-created
    // opaque capabilities may authorize main-process filesystem access.
    destinations: Array.isArray(source.destinations)
      ? source.destinations.filter((p: unknown): p is BackupDestination =>
        Boolean(p) && typeof p === "object" && typeof (p as BackupDestination).token === "string" &&
        /^[a-f0-9]{32}$/i.test((p as BackupDestination).token) && typeof (p as BackupDestination).label === "string").slice(0, 2)
      : [],
    cadenceDays: cadence as BackupScheduleSettings["cadenceDays"],
    retentionCount: typeof retentionValue === "number" && Number.isFinite(retentionValue)
      ? Math.max(1, Math.min(100, Math.floor(retentionValue)))
      : 5,
    promptBehavior: source.promptBehavior === "automatic" ? "automatic" : "ask",
    destinationStates,
  };
}

export function isBackupDue(lastVerifiedAt: number | undefined, cadenceDays: number, now = Date.now()): boolean {
  return !lastVerifiedAt || !Number.isFinite(lastVerifiedAt) ||
    now - lastVerifiedAt >= Math.max(1, cadenceDays) * 24 * 60 * 60 * 1000;
}

export interface RotationCandidate {
  name: string;
  modifiedAt: number;
  sizeBytes: number;
}

function monthKey(time: number): string {
  return new Date(time).toISOString().slice(0, 7);
}

/**
 * Keep the newest verified archives, plus the newest archive from every month
 * represented by the input. The caller deletes only the returned entries.
 * The final guard makes it impossible for rotation to remove the only copy.
 */
export function selectBackupsForRotation(
  files: RotationCandidate[],
  retentionCount: number,
): RotationCandidate[] {
  const ordered = [...files].sort((a, b) => b.modifiedAt - a.modifiedAt || b.name.localeCompare(a.name));
  if (ordered.length <= 1) return [];
  const keep = new Set<string>();
  ordered.slice(0, Math.max(1, Math.floor(retentionCount))).forEach((f) => keep.add(f.name));
  const newestByMonth = new Map<string, RotationCandidate>();
  for (const file of ordered) {
    const month = monthKey(file.modifiedAt);
    if (!newestByMonth.has(month)) newestByMonth.set(month, file);
  }
  for (const file of newestByMonth.values()) keep.add(file.name);
  const removable = ordered.filter((file) => !keep.has(file.name));
  return removable.length < ordered.length ? removable : removable.slice(0, -1);
}

class ScheduledFileSink implements BackupSink {
  private tail = Promise.resolve();
  private failure: unknown = null;
  checksum?: string;
  constructor(private readonly id: string, private readonly api: NonNullable<ReturnType<typeof getElectronAPISafe>>) {}
  write(chunk: Uint8Array): void {
    const copy = chunk.slice();
    this.tail = this.tail.then(async () => {
      const result = await this.api.scheduledBackupWrite?.(this.id, copy.buffer as ArrayBuffer);
      if (!result?.success) throw new Error(result?.error || "Scheduled backup write failed");
    }).catch((error) => { if (this.failure == null) this.failure = error; });
  }
  async drain(): Promise<void> {
    await this.tail;
    if (this.failure) throw this.failure;
  }
  async close(): Promise<void> {
    await this.drain();
    const result = await this.api.scheduledBackupClose?.(this.id);
    if (!result?.success) throw new Error(result?.error || "Scheduled backup close failed");
    this.checksum = result.checksum;
  }
  async abort(): Promise<void> {
    try { await this.api.scheduledBackupAbort?.(this.id); } catch { /* best effort */ }
  }
}

async function* scheduledChunks(id: string, api: NonNullable<ReturnType<typeof getElectronAPISafe>>, signal?: AbortSignal): AsyncIterable<Uint8Array> {
  let offset = 0;
  for (;;) {
    throwIfCancelled(signal);
    const result = await api.scheduledBackupRead?.(id, offset);
    if (!result?.success) throw new Error(result?.error || "Could not read scheduled backup");
    const data = result.data ? new Uint8Array(result.data) : new Uint8Array();
    if (data.length) {
      offset += data.length;
      throwIfCancelled(signal);
      yield data;
    }
    if (result.eof || data.length === 0) return;
  }
}

export interface ScheduledBackupVerification {
  manifest: BackupManifest;
  counts: Record<StreamedTable, number>;
}
function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BackupCancelledError();
}

function u16(bytes: Uint8Array, at: number): number { return bytes[at] | (bytes[at + 1] << 8); }
function u32(bytes: Uint8Array, at: number): number { return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0; }

/** Streaming, browser-safe ZIP central-directory validation.  It retains only
 * the EOCD tail and a single central-directory entry, not the archive. */
async function validateZipStructure(sourceFactory: () => AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<void> {
  let total = 0;
  let tail = new Uint8Array();
  for await (const chunk of sourceFactory()) {
    throwIfCancelled(signal);
    total += chunk.length;
    const merged = new Uint8Array(Math.min(0xffff + 22, tail.length + chunk.length));
    const start = Math.max(0, tail.length + chunk.length - merged.length);
    if (start < tail.length) merged.set(tail.subarray(start), 0);
    if (start + merged.length > tail.length) merged.set(chunk.subarray(Math.max(0, start - tail.length)), Math.max(0, tail.length - start));
    tail = merged;
  }
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50 && i + 22 + u16(tail, i + 20) === tail.length) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Scheduled backup ZIP has no complete end record");
  const entries = u16(tail, eocd + 10);
  const centralSize = u32(tail, eocd + 12);
  const centralOffset = u32(tail, eocd + 16);
  const centralEnd = centralOffset + centralSize;
  if (centralEnd !== total - tail.length + eocd) throw new Error("Scheduled backup ZIP central directory is incomplete");
  let position = 0, seen = 0, consumed = 0, pending = new Uint8Array();
  for await (const chunk of sourceFactory()) {
    throwIfCancelled(signal);
    const chunkStart = position, chunkEnd = position + chunk.length;
    position = chunkEnd;
    const from = Math.max(centralOffset, chunkStart), to = Math.min(centralEnd, chunkEnd);
    if (from >= to) continue;
    const merged = new Uint8Array(pending.length + to - from);
    merged.set(pending); merged.set(chunk.subarray(from - chunkStart, to - chunkStart), pending.length);
    let offset = 0;
    while (merged.length - offset >= 46) {
      if (u32(merged, offset) !== 0x02014b50) throw new Error("Scheduled backup ZIP central directory is invalid");
      const length = 46 + u16(merged, offset + 28) + u16(merged, offset + 30) + u16(merged, offset + 32);
      if (merged.length - offset < length) break;
      offset += length; seen++; consumed += length;
    }
    pending = merged.subarray(offset);
  }
  if (pending.length || seen !== entries || consumed !== centralSize) throw new Error("Scheduled backup ZIP central directory is incomplete");
}

/**
 * Read back the just-written partial archive using the existing manifest and
 * line parsing primitives. No vault tables are touched. A bad password,
 * truncated ZIP, malformed NDJSON, or count mismatch rejects before promotion.
 */
export async function verifyScheduledBackup(
  sourceFactory: () => AsyncIterable<Uint8Array>,
  password?: string,
  signal?: AbortSignal,
): Promise<ScheduledBackupVerification> {
  throwIfCancelled(signal);
  const peek = await peekManifest(sourceFactory());
  await validateZipStructure(sourceFactory, signal);
  if (!isV3Manifest(peek)) throw new Error("Scheduled backup is not a valid KYUTXO v3 archive");
  let key: CryptoKey | null = null;
  if (peek.encrypted) {
    if (!password) throw new Error("An encryption password is required to verify this backup");
    key = await deriveKeyWithParams(password, base64ToBuffer(peek.salt ?? ""), getBackupKdfParams(peek));
    if (!peek.check || await decrypt(peek.check, key) !== CHECK_SENTINEL) {
      throw new Error("The backup password is incorrect");
    }
  }
  await parseInline(peek, key);
  const counts = Object.fromEntries(STREAMED_TABLES.map((table) => [table, 0])) as Record<StreamedTable, number>;
  const seenTables = new Set<StreamedTable>();
  let attachmentFiles = 0;
  let manifestRead = false;
  await readZipStream(sourceFactory(), {
    onEntry(name) {
      const table = isStreamedTablePath(name);
      if (table) {
        seenTables.add(table);
        return lineConsumer(async (line) => {
          throwIfCancelled(signal);
          const rows = await parseBatchLine(line, key);
          if (!Array.isArray(rows)) throw new Error(`Invalid ${table} batch`);
          counts[table] = (counts[table] ?? 0) + rows.length;
        });
      }
      if (name === "backup.json") {
        return collectBytesConsumer(() => { manifestRead = true; }, { maxBytes: 16 * 1024 * 1024 });
      }
      if (name.startsWith(`${ATTACHMENTS_DIR}/`)) {
        attachmentFiles++;
        return { onChunk() {}, onEnd() {} };
      }
      return null;
    },
  });
  throwIfCancelled(signal);
  if (!manifestRead) throw new Error("Scheduled backup is missing its manifest");
  for (const table of STREAMED_TABLES) {
    if (!seenTables.has(table)) throw new Error(`Scheduled backup is missing ${table}`);
    const expected = peek.counts?.[table] ?? 0;
    if (counts[table] !== expected) throw new Error(`Scheduled backup verification count mismatch for ${table}`);
  }
  if (attachmentFiles !== (peek.counts?.attachmentFiles ?? 0)) {
    throw new Error("Scheduled backup verification count mismatch for attachment files");
  }
  return { manifest: peek, counts };
}

function scheduledName(now: number): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-").replace("Z", "Z");
  return `kyutxo-scheduled-${stamp}.zip`;
}

export interface ScheduledBackupRunResult {
  verified: number;
  skipped: boolean;
  failures: string[];
}

export async function runDueScheduledBackup(options: {
  now?: number;
  requestConfirmation?: () => Promise<boolean>;
  requestPassword?: () => Promise<string | null>;
  onProgress?: (phase: string) => void;
  signal?: AbortSignal;
} = {}): Promise<ScheduledBackupRunResult> {
  const api = getElectronAPISafe();
  if (!api?.scheduledBackupOpen || !api.scheduledBackupWrite || !api.scheduledBackupClose ||
      !api.scheduledBackupRead || !api.scheduledBackupValidate || !api.scheduledBackupPromote || !api.scheduledBackupAbort) {
    return { verified: 0, skipped: true, failures: [] };
  }
  const settings = await getSettings("default");
  const schedule = normalizeBackupSchedule(settings?.backupSchedule);
  const now = options.now ?? Date.now();
  const anyDestinationDue = schedule.destinations.some((destination) => {
    const state = schedule.destinationStates?.[destination.token];
    return Boolean(state?.lastFailureAt) || isBackupDue(state?.lastVerifiedAt ?? schedule.lastVerifiedAt, schedule.cadenceDays, now);
  });
  if (!schedule.enabled || schedule.destinations.length === 0 || !anyDestinationDue) {
    return { verified: 0, skipped: true, failures: [] };
  }
  if (schedule.promptBehavior === "ask") {
    const confirmed = options.requestConfirmation
      ? await options.requestConfirmation()
      : typeof window !== "undefined" ? window.confirm("Your scheduled KYUTXO backup is due. Create it now?") : false;
    if (!confirmed) return { verified: 0, skipped: true, failures: [] };
  }
  let password: string | undefined;
  if (schedule.encrypted) {
    const value = options.requestPassword
      ? await options.requestPassword()
      : typeof window !== "undefined" ? window.prompt("Enter the backup password for this scheduled run") : null;
    if (!value) {
      await mutateBackupSchedule((current) => ({
        ...current,
        lastFailureAt: now,
        lastFailureMessage: "Scheduled backup was not created because no password was provided.",
      }));
      return { verified: 0, skipped: false, failures: ["No encryption password was provided."] };
    }
    password = value;
  }
  let compactPlan;
  if (schedule.compact) compactPlan = await computeCompactPlan({ onProgress: (p) => options.onProgress?.(p.phase) });
  const [records, transactions, participants, sync, lineage, segments, snapshots, attachments] = await Promise.all([
    countRecords(), countTransactions(), countTransactionParticipants(), countAddressSyncState(),
    countUtxoLineage(), countCustodySegments(), countLineageSnapshots(), countAttachments(),
  ]);
  const rowCount = records + transactions + participants + sync + lineage + segments + snapshots;
  const attachmentBytes = await sumAttachmentSizes();
  const failures: string[] = [];
  let verified = 0;
  let statusSchedule = schedule;
  for (const destination of schedule.destinations.slice(0, 2)) {
    const state = statusSchedule.destinationStates?.[destination.token];
    // A healthy target can wait for cadence; unhealthy targets are retried
    // independently after every unlock.
    if (!isBackupDue(state?.lastVerifiedAt ?? schedule.lastVerifiedAt, schedule.cadenceDays, now) && !state?.lastFailureAt) continue;
    let id: string | undefined;
    try {
      throwIfCancelled(options.signal);
      const space = await api.getScheduledBackupDiskSpace?.(destination.token);
      if (space?.success && typeof space.freeBytes === "number" &&
          space.freeBytes < estimateExportBytes({ attachmentBytes, rowCount })) {
        throw new Error("Not enough free disk space for the scheduled backup.");
      }
      const opened = await api.scheduledBackupOpen(destination.token, scheduledName(now));
      if (!opened.success || !opened.id) throw new Error(opened.error || "Could not open the backup destination.");
      id = opened.id;
      options.onProgress?.(`Creating backup in ${destination.label}`);
      const sink = new ScheduledFileSink(id, api);
      await exportBackup({
        sink,
        encrypted: schedule.encrypted,
        password,
        compactPlan,
        attachmentIO: {
          listAll: async () => {
            const result = await api.listAllAttachments();
            if (!result.success) throw new Error(result.error || "Could not list attachments");
            return result.files ?? [];
          },
          read: async (path) => {
            const result = await api.readAttachment(path);
            return result.success ? result.data ?? null : null;
          },
          totalBytes: async () => {
            const result = await api.listAllAttachments();
            return result.success && typeof result.totalBytes === "number" ? result.totalBytes : null;
          },
        },
        onProgress: (p) => options.onProgress?.(p.phase),
        signal: options.signal,
      });
      await verifyScheduledBackup(() => scheduledChunks(id!, api, options.signal), password, options.signal);
      throwIfCancelled(options.signal);
      const mainValidated = await api.scheduledBackupValidate?.(id, sink.checksum ?? "");
      if (!mainValidated?.success) throw new Error(mainValidated?.error || "Could not validate scheduled backup.");
      throwIfCancelled(options.signal);
      const promoted = await api.scheduledBackupPromote(id, scheduledName(now), true);
      if (!promoted.success) throw new Error(promoted.error || "Could not promote verified backup.");
      id = undefined;
      verified++;
      throwIfCancelled(options.signal);
      statusSchedule = await mutateBackupSchedule((current) =>
        mergeVerifiedBackupDestination(current, destination.token, {
          at: now,
          label: destination.label,
          sizeBytes: promoted.sizeBytes,
          checksum: promoted.checksum,
        }));
    } catch (error) {
      if (id) await api.scheduledBackupAbort(id);
      const message = error instanceof BackupCancelledError ? "Scheduled backup was cancelled." : error instanceof Error ? error.message : String(error);
      failures.push(`${destination.label}: ${message}`);
      throwIfCancelled(options.signal);
      statusSchedule = await mutateBackupSchedule((current) => ({
        ...current,
        lastFailureAt: now,
        lastFailureMessage: message,
        destinationStates: {
          ...current.destinationStates,
          [destination.token]: {
            ...current.destinationStates?.[destination.token],
            lastFailureAt: now,
            lastFailureMessage: message,
          },
        },
      }));
    }
  }
  if (verified > 0) {
    const current = await getSettings("default");
    const finalSchedule = normalizeBackupSchedule(current?.backupSchedule);
    for (const destination of finalSchedule.destinations.slice(0, 2)) {
      const listed = await api.listScheduledBackups?.(destination.token);
      if (!listed?.success || !listed.files) continue;
      for (const file of selectBackupsForRotation(listed.files, finalSchedule.retentionCount)) {
        await api.deleteScheduledBackup?.(destination.token, file.name);
      }
    }
  }
  return { verified, skipped: false, failures };
}
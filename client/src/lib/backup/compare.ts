// Read-only "what changed?" comparison between two v3 backup files.
//
// Answers two recurring questions without touching the live vault:
//   - "what did I actually change since my last backup?"
//   - "did that merge restore do what I think it did?"
//
// Pipeline:
//   1. readBackupSnapshot streams ONE backup ZIP with the same reader the
//      restore/analysis pipelines use (readZipStream + lineConsumer +
//      parseBatchLine) and folds every streamed table into a lightweight
//      natural-key -> row map. Natural keys are the SAME identities the merge
//      restore de-dupes by (merge-keys.ts / legacy-restore.ts), so a row that
//      survives a merge restore also compares as "the same row" here.
//      Attachment FILE bytes are never read — metadata rows only.
//   2. diffSnapshots compares two snapshots per table: keys only in the newer
//      backup are "added", only in the older "removed", in both with differing
//      fields "changed" (with a field-level delta that skips machine-noise
//      fields like id / updatedAt / remapped foreign keys).
//   3. Compact backups compare cleanly: when the side a row is MISSING from
//      was exported with the compact filter, a missing discovery-only row
//      (prunable record shape, or history that only involves pruned records)
//      is NOT reported as removed/added — it is counted as `suppressed`.
//
// Wrong-password / malformed archives fail during the manifest read of the
// FIRST file that is wrong — before any comparison output is produced — with
// the same error wording the restore pre-flight uses, prefixed by which file
// failed. Cancellation uses the shared BackupCancelledError contract.

import {
  isStreamedTablePath,
  parseBatchLine,
  parseInline,
  isV3Manifest,
  MANIFEST_FILENAME,
  ATTACHMENTS_DIR,
  CHECK_SENTINEL,
  getBackupKdfParams,
  STREAMED_TABLES,
  type BackupManifest,
  type BackupCounts,
  type StreamedTable,
} from "./format";
import { readZipStream, lineConsumer, collectBytesConsumer } from "./zip-stream";
import { BackupCancelledError } from "./sink";
import { deriveKeyWithParams, decrypt, base64ToBuffer } from "@/lib/crypto";
import {
  recordMergeIdentity,
  syncStateMergeAddress,
  segmentMergeId,
  snapshotMergeId,
  derivationTemplateIdentity,
} from "./merge-keys";
import {
  participantKey,
  participantMatchKey,
  mergeDuplicateTransactionsByTxid,
} from "./legacy-restore";
import { lineageIdentity } from "./legacy-restore-misc";
import { isPrunableRecordShape } from "./compact";
import { evidenceIdentity } from "@/lib/data/evidence-crud";
import { priceDedupKey } from "@/lib/data/price-data-crud";
import { toOutpoint } from "@/lib/data/dust-flags-crud";
import { previewSettingsPreferences } from "./inline-tables";
import { csvField, csvEscape } from "@/lib/csv-export";
import type { Record as VaultRecord } from "@/lib/db-types";
import type { RestoreProgress } from "./restore";

// ---------------------------------------------------------------------------
// Snapshot model
// ---------------------------------------------------------------------------

// Inline (manifest-carried) tables the comparison covers, in report order.
// `settings` is compared through its PORTABLE-PREFERENCE projection only
// (device-local preferences intentionally never leave a device — see
// inline-tables.ts), and nodeSettings is compared by its singleton id.
export const COMPARED_INLINE_TABLES = [
  "tags",
  "categories",
  "owners",
  "walletNames",
  "seedNames",
  "walletSoftware",
  "customFields",
  "derivationTemplates",
  "recordOrigins",
  "evidence",
  "evidenceAttachments",
  "priceData",
  "settings",
  "nodeSettings",
  "dustFlags",
  "savedPsbts",
] as const;
export type ComparedInlineTable = (typeof COMPARED_INLINE_TABLES)[number];

export interface BackupSnapshot {
  manifest: BackupManifest;
  // Backup record id -> the record's natural identity (inputString, or an
  // id-keyed fallback for blank identities). Used to remap foreign keys into
  // identities so rows compare across backups whose local ids differ.
  recordIdentityByBackupId: Map<number, string>;
  streamed: Record<StreamedTable, Map<string, any>>;
  inline: Record<ComparedInlineTable, Map<string, any>>;
  // Derived discovery-only oracle used for compact suppression (built from
  // THIS snapshot's own rows):
  //   keptRecordIdentities — inputStrings of records that are NOT prunable
  //     (a compact export would have kept them).
  //   keptAddresses — keptRecordIdentities of address-type records.
  //   discoveryOnlyTxids — txids in which no kept record participates (their
  //     transactions/participants rows would have been pruned by a compact
  //     export), mirroring computeCompactPlan pass 2.
  keptRecordIdentities: Set<string>;
  keptAddresses: Set<string>;
  discoveryOnlyTxids: Set<string>;
}

export interface SnapshotOptions {
  source: AsyncIterable<Uint8Array>;
  password?: string;
  onProgress?: (p: RestoreProgress) => void;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Natural keys
// ---------------------------------------------------------------------------

// Records key by their inputString identity — the exact merge identity. Blank
// identities are never de-duped by a merge; for a diff they fall back to the
// backup-local id, which is stable across two backups of the same vault.
function recordSnapshotKey(row: any): string {
  const identity = recordMergeIdentity(row);
  if (identity) return identity;
  return typeof row?.id === "number" ? `#id:${row.id}` : `#row:${cryptoSafeRandom()}`;
}

let syntheticCounter = 0;
// Last-resort key for rows with no natural identity and no id (malformed):
// unique per stream so such rows never falsely match each other.
function cryptoSafeRandom(): string {
  return `${Date.now().toString(36)}:${(syntheticCounter++).toString(36)}`;
}

function participantSnapshotKey(p: any): string {
  return participantMatchKey(p) ?? participantKey(p);
}

function streamedRowKey(table: StreamedTable, row: any, snap: BackupSnapshot): string {
  switch (table) {
    case "records":
      return recordSnapshotKey(row);
    case "attachments": {
      // objectStoragePath primary (sha-derived, stable across backups); the
      // fallback remaps the backup-local recordId to the record's identity so
      // two backups with different local id spaces still match.
      const ownerIdentity =
        typeof row?.recordId === "number"
          ? snap.recordIdentityByBackupId.get(row.recordId) ?? `#missing:${row.recordId}`
          : `#missing:${String(row?.recordId ?? "")}`;
      const path = row?.objectStoragePath;
      return typeof path === "string" && path !== ""
        ? path
        : `${ownerIdentity}:${String(row?.filename ?? "")}`;
    }
    case "transactionParticipants":
      return participantSnapshotKey(row);
    case "addressSyncState": {
      const addr = syncStateMergeAddress(row);
      return addr || (typeof row?.id === "number" ? `#id:${row.id}` : `#row:${cryptoSafeRandom()}`);
    }
    case "blockchainTransactions": {
      const txid = typeof row?.txid === "string" ? row.txid : "";
      return txid || (typeof row?.id === "number" ? `#id:${row.id}` : `#row:${cryptoSafeRandom()}`);
    }
    case "utxoLineage":
      return lineageIdentity(row ?? {});
    case "custodySegments":
      return (
        segmentMergeId(row) ??
        (typeof row?.id === "number" ? `#id:${row.id}` : `#row:${cryptoSafeRandom()}`)
      );
    case "lineageSnapshots":
      return (
        snapshotMergeId(row) ??
        (typeof row?.id === "number" ? `#id:${row.id}` : `#row:${cryptoSafeRandom()}`)
      );
  }
}

// ---------------------------------------------------------------------------
// Snapshot reader
// ---------------------------------------------------------------------------

// Streams one v3 backup into a natural-key snapshot. Throws the same
// "Invalid password or corrupted backup" / "Not a v3 backup" errors the
// restore pre-flight produces; throws BackupCancelledError when cancelled.
export async function readBackupSnapshot(opts: SnapshotOptions): Promise<BackupSnapshot> {
  let manifest: BackupManifest | null = null;
  let manifestSeen = false;
  let key: CryptoKey | null = null;

  const snap: BackupSnapshot = {
    manifest: null as unknown as BackupManifest,
    recordIdentityByBackupId: new Map(),
    streamed: {
      records: new Map(),
      attachments: new Map(),
      transactionParticipants: new Map(),
      addressSyncState: new Map(),
      blockchainTransactions: new Map(),
      utxoLineage: new Map(),
      custodySegments: new Map(),
      lineageSnapshots: new Map(),
    },
    inline: {
      tags: new Map(),
      categories: new Map(),
      owners: new Map(),
      walletNames: new Map(),
      seedNames: new Map(),
      walletSoftware: new Map(),
      customFields: new Map(),
      derivationTemplates: new Map(),
      recordOrigins: new Map(),
      evidence: new Map(),
      evidenceAttachments: new Map(),
      priceData: new Map(),
      settings: new Map(),
      nodeSettings: new Map(),
      dustFlags: new Map(),
      savedPsbts: new Map(),
    },
    keptRecordIdentities: new Set(),
    keptAddresses: new Set(),
    discoveryOnlyTxids: new Set(),
  };

  const throwIfAborted = () => {
    if (opts.signal?.aborted) throw new BackupCancelledError();
  };

  let processed = 0;
  const total = () =>
    manifest
      ? (manifest.counts.records +
          manifest.counts.attachments +
          manifest.counts.transactionParticipants +
          manifest.counts.addressSyncState +
          manifest.counts.blockchainTransactions +
          (manifest.counts.utxoLineage ?? 0) +
          (manifest.counts.custodySegments ?? 0) +
          (manifest.counts.lineageSnapshots ?? 0)) || 1
      : 1;

  let linesSinceYield = 0;
  const maybeYield = async () => {
    // Plaintext backups parse each batch line synchronously (one JSON.parse of
    // a whole batch). Give the event loop real air every few lines so the page
    // stays responsive and cancellation lands promptly on huge archives.
    if (++linesSinceYield >= 20) {
      linesSinceYield = 0;
      await new Promise((r) => setTimeout(r, 0));
    }
  };

  async function absorbBatch(table: StreamedTable, rows: any[]): Promise<void> {
    throwIfAborted();
    const map = snap.streamed[table];
    for (const row of rows) {
      const k = streamedRowKey(table, row, snap);
      if (table === "records") {
        if (typeof row?.id === "number") {
          snap.recordIdentityByBackupId.set(row.id, k);
        }
        map.set(k, row);
      } else if (table === "blockchainTransactions" && map.has(k)) {
        // Same-txid rows can repeat ACROSS batch lines; fold them into one
        // row with the richer fields winning — the same semantics
        // mergeDuplicateTransactionsByTxid applies within a batch.
        map.set(k, mergeDuplicateTransactionsByTxid([map.get(k), row])[0]);
      } else {
        map.set(k, row);
      }
    }
    processed += rows.length;
    opts.onProgress?.({
      percent: Math.min(99, Math.round((processed / total()) * 99)),
      phase: `Reading ${table}...`,
    });
    await maybeYield();
  }

  await readZipStream(opts.source, {
    onEntry(name) {
      if (name === MANIFEST_FILENAME) {
        manifestSeen = true;
        return collectBytesConsumer(async (bytes) => {
          throwIfAborted();
          const parsed = JSON.parse(new TextDecoder().decode(bytes));
          if (!isV3Manifest(parsed)) {
            throw new Error("Not a v3 backup");
          }
          manifest = parsed;
          if (manifest.encrypted) {
            if (!opts.password) throw new Error("Password required for encrypted backup");
            const salt = base64ToBuffer(manifest.salt ?? "");
            key = await deriveKeyWithParams(opts.password, salt, getBackupKdfParams(manifest));
            // Verify BEFORE any snapshot data is built, so a wrong password
            // fails the comparison before anything runs.
            let ok = false;
            try {
              ok = (await decrypt(manifest.check ?? "", key)) === CHECK_SENTINEL;
            } catch {
              ok = false;
            }
            if (!ok) throw new Error("Invalid password or corrupted backup");
          }
        });
      }

      // Same ordering guard as the restore/analysis pipelines.
      if (!manifestSeen) {
        if (
          isStreamedTablePath(name) ||
          (name.startsWith(`${ATTACHMENTS_DIR}/`) && !name.endsWith("/"))
        ) {
          throw new Error("Malformed backup: manifest must be the first entry");
        }
      }

      const table = isStreamedTablePath(name);
      if (table) {
        return lineConsumer(async (line) => {
          const rows = await parseBatchLine(line, key);
          if (rows.length) await absorbBatch(table, rows);
        });
      }

      // Attachment file bytes are never read (metadata-only comparison).
      return null;
    },
  });

  throwIfAborted();
  if (!manifest) throw new Error("Invalid backup: missing manifest");
  snap.manifest = manifest;

  // ---- inline tables (manifest-carried) -----------------------------------
  const data = await parseInline(manifest, key);
  const arr = (k: string): any[] => (Array.isArray(data[k]) ? (data[k] as any[]) : []);

  const putAll = (table: ComparedInlineTable, rows: any[], keyOf: (row: any) => string | null) => {
    const map = snap.inline[table];
    for (const row of rows) {
      const k = keyOf(row);
      if (k != null) map.set(k, row);
    }
  };
  const vocabKey = (row: any) => {
    const name = typeof row?.name === "string" ? row.name : "";
    return name || null;
  };
  putAll("tags", arr("tags"), vocabKey);
  putAll("categories", arr("categories"), vocabKey);
  putAll("owners", arr("owners"), vocabKey);
  putAll("walletNames", arr("walletNames"), vocabKey);
  putAll("seedNames", arr("seedNames"), vocabKey);
  putAll("walletSoftware", arr("walletSoftware"), vocabKey);
  putAll("customFields", arr("customFields"), (row) =>
    typeof row?.slug === "string" && row.slug ? row.slug : null,
  );
  putAll("derivationTemplates", arr("derivationTemplates"), (row) =>
    derivationTemplateIdentity(row ?? {}),
  );
  // recordOrigins reference records by backup-local id; remap to the record
  // identity so origins compare across backups with different id spaces.
  putAll("recordOrigins", arr("recordOrigins"), (row) => {
    const ownerIdentity =
      typeof row?.recordId === "number"
        ? snap.recordIdentityByBackupId.get(row.recordId) ?? `#missing:${row.recordId}`
        : `#missing:${String(row?.recordId ?? "")}`;
    return [ownerIdentity, row?.originType ?? "", row?.source ?? "", row?.createdAt ?? ""].join("|");
  });
  putAll("evidence", arr("evidence"), (row) => evidenceIdentity(row ?? {}));
  // Evidence attachment rows follow their document; remap evidenceId to the
  // document identity (evidence ids are backup-local).
  const evidenceIdentityByBackupId = new Map<number, string>();
  for (const ev of arr("evidence")) {
    if (typeof ev?.id === "number") evidenceIdentityByBackupId.set(ev.id, evidenceIdentity(ev));
  }
  putAll("evidenceAttachments", arr("evidenceAttachments"), (row) => {
    const doc =
      typeof row?.evidenceId === "number"
        ? evidenceIdentityByBackupId.get(row.evidenceId) ?? `#missing:${row.evidenceId}`
        : `#missing:${String(row?.evidenceId ?? "")}`;
    return `${doc}:${String(row?.filename ?? "")}`;
  });
  putAll("priceData", arr("priceData"), (row) => priceDedupKey(row?.date, row?.currency, row?.asset));
  // Settings: only the portable-preference projection is comparable — the
  // values are pre-formatted by the shared descriptor list.
  {
    const previews = previewSettingsPreferences(arr("settings"));
    const projected: Record<string, string> = {};
    for (const p of previews) {
      if (p.fromBackup && p.backupValue != null) projected[p.key] = p.backupValue;
    }
    if (Object.keys(projected).length > 0) snap.inline.settings.set("default", projected);
  }
  putAll("nodeSettings", arr("nodeSettings"), (row) => String(row?.id ?? "default"));
  putAll("dustFlags", arr("dustFlags"), (row) => {
    if (typeof row?.outpoint === "string" && row.outpoint) return row.outpoint;
    if (typeof row?.txid === "string" && typeof row?.vout === "number") {
      return toOutpoint(row.txid, row.vout);
    }
    return null;
  });
  putAll("savedPsbts", arr("savedPsbts"), (row) =>
    typeof row?.psbtBase64 === "string" && row.psbtBase64 ? row.psbtBase64 : null,
  );

  // ---- discovery-only oracle (compact suppression) ------------------------
  buildDiscoveryOracle(snap);

  throwIfAborted();
  return snap;
}

// Derives kept-record / kept-address / discovery-only-txid sets from the
// snapshot's own rows, mirroring computeCompactPlan's classification at shape
// level: a record the compact filter would keep is one that is NOT prunable
// shape; a txid is discovery-only when no kept record participates in it
// (directly as a transaction record, or through any participant row anchored
// by record link or by a kept address).
function buildDiscoveryOracle(snap: BackupSnapshot): void {
  for (const [identity, row] of snap.streamed.records) {
    if (isPrunableRecordShape(row as VaultRecord)) continue;
    snap.keptRecordIdentities.add(identity);
    if (row?.type === "address") snap.keptAddresses.add(identity);
  }
  const anchored = new Set<string>();
  for (const p of snap.streamed.transactionParticipants.values()) {
    const txid = typeof p?.txid === "string" ? p.txid : "";
    if (!txid || anchored.has(txid)) continue;
    const linkedIdentity =
      typeof p?.recordId === "number" ? snap.recordIdentityByBackupId.get(p.recordId) : undefined;
    if (linkedIdentity && snap.keptRecordIdentities.has(linkedIdentity)) {
      anchored.add(txid);
      continue;
    }
    if (typeof p?.address === "string" && snap.keptAddresses.has(p.address)) {
      anchored.add(txid);
    }
  }
  for (const [key] of snap.streamed.blockchainTransactions) {
    // A kept transaction-type record anchors its txid directly (identity ===
    // txid for transaction records).
    if (snap.keptRecordIdentities.has(key)) continue;
    if (!anchored.has(key)) snap.discoveryOnlyTxids.add(key);
  }
  // Participants can reference txids that have no transaction row at all —
  // those txids are discovery-only too when unanchored.
  for (const p of snap.streamed.transactionParticipants.values()) {
    const txid = typeof p?.txid === "string" ? p.txid : "";
    if (txid && !anchored.has(txid) && !snap.keptRecordIdentities.has(txid)) {
      snap.discoveryOnlyTxids.add(txid);
    }
  }
}

// ---------------------------------------------------------------------------
// Diff engine
// ---------------------------------------------------------------------------

export type DiffChangeKind = "added" | "removed" | "changed";

export interface FieldDelta {
  field: string;
  // Display-ready values; null = field absent on that side.
  oldValue: string | null;
  newValue: string | null;
}

export interface DiffEntry {
  key: string;
  change: DiffChangeKind;
  // Present for changed entries: which fields differed (old vs new value).
  deltas?: FieldDelta[];
}

export interface TableDiff {
  table: string;
  label: string;
  added: number;
  removed: number;
  changed: number;
  // Rows absent from a COMPACT side whose absence is explained by the compact
  // filter (discovery-only data) — deliberately not counted as removed/added.
  suppressed: number;
  entries: DiffEntry[];
}

export interface BackupDiffResult {
  older: BackupFileSummary;
  newer: BackupFileSummary;
  tables: TableDiff[];
  csv: {
    parts: string[];
    rowCount: number;
  };
}

export interface BackupFileSummary {
  exportDate: string;
  appVersion: string;
  encrypted: boolean;
  compact: boolean;
  counts: BackupCounts;
}

export const DIFF_CSV_HEADER = ["Table", "Change", "Key", "Field", "Old Value", "New Value"] as const;

const TABLE_LABELS: Record<string, string> = {
  records: "Records",
  attachments: "Attachments",
  transactionParticipants: "Transaction participants",
  addressSyncState: "Address sync state",
  blockchainTransactions: "Transactions",
  utxoLineage: "UTXO lineage",
  custodySegments: "Custody segments",
  lineageSnapshots: "Lineage snapshots",
  tags: "Tags",
  categories: "Categories",
  owners: "Owners",
  walletNames: "Wallet names",
  seedNames: "Seed names",
  walletSoftware: "Wallet software",
  customFields: "Custom fields",
  derivationTemplates: "Derivation templates",
  recordOrigins: "Record origins",
  evidence: "Evidence documents",
  evidenceAttachments: "Evidence attachments",
  priceData: "Price data",
  settings: "Settings (portable preferences)",
  nodeSettings: "Node settings",
  dustFlags: "Dust flags",
  savedPsbts: "Saved PSBTs",
};

// Machine-noise fields skipped by the field-level delta: ids and remapped
// foreign keys are backup-local, updatedAt bumps travel with any edit,
// underscore-prefixed fields are internal markers, and the per-address stats
// cache (cached* / statsComputedAt — recomputed from local data, see
// RECORD_FIELD_CLASSIFICATION in compact.ts) plus fetch timestamps (syncedAt)
// change without any user edit.
const SKIP_FIELDS_COMMON = new Set(["id", "updatedAt"]);
const SKIP_FIELDS_BY_TABLE: Record<string, Set<string>> = {
  records: new Set([
    "discoveredFromRecordId",
    "cachedBalanceSats",
    "cachedTxCount",
    "cachedLastActivityTime",
    "cachedUtxoCount",
    "statsComputedAt",
  ]),
  attachments: new Set(["recordId"]),
  transactionParticipants: new Set(["recordId"]),
  blockchainTransactions: new Set(["syncedAt"]),
  recordOrigins: new Set(["recordId"]),
  evidenceAttachments: new Set(["evidenceId"]),
};

function isSkippedField(table: string, field: string): boolean {
  if (field.startsWith("_")) return true;
  if (SKIP_FIELDS_COMMON.has(field)) return true;
  return SKIP_FIELDS_BY_TABLE[table]?.has(field) ?? false;
}

// Canonical comparison value: undefined/missing collapses to null; objects
// compare by sorted-key JSON so key order never produces phantom diffs.
function canon(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "object") return JSON.stringify(sortDeep(v));
  return `${typeof v}:${String(v)}`;
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      out[k] = sortDeep((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

const MAX_VALUE_LEN = 400;

// Display rendering of a field value for the delta lists and CSV.
export function formatDiffValue(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  let s: string;
  if (typeof v === "string") s = v;
  else if (typeof v === "number" || typeof v === "boolean") s = String(v);
  else if (Array.isArray(v) && v.every((x) => x === null || ["string", "number", "boolean"].includes(typeof x))) {
    s = v.map((x) => String(x)).join("; ");
  } else {
    s = JSON.stringify(v);
  }
  return s.length > MAX_VALUE_LEN ? `${s.slice(0, MAX_VALUE_LEN)}…` : s;
}

function fieldDeltas(table: string, oldRow: any, newRow: any): FieldDelta[] {
  const deltas: FieldDelta[] = [];
  const fields = new Set<string>();
  if (oldRow && typeof oldRow === "object") for (const f of Object.keys(oldRow)) fields.add(f);
  if (newRow && typeof newRow === "object") for (const f of Object.keys(newRow)) fields.add(f);
  for (const field of Array.from(fields).sort()) {
    if (isSkippedField(table, field)) continue;
    const ov = oldRow?.[field];
    const nv = newRow?.[field];
    if (canon(ov) === canon(nv)) continue;
    deltas.push({ field, oldValue: formatDiffValue(ov), newValue: formatDiffValue(nv) });
  }
  return deltas;
}

// Should a row present in `presentSide` but absent from a COMPACT other side
// be suppressed (explained by the compact filter) rather than reported?
function isCompactPruned(table: string, row: any, presentSide: BackupSnapshot): boolean {
  switch (table) {
    case "records":
      return isPrunableRecordShape(row as VaultRecord);
    case "blockchainTransactions": {
      const txid = typeof row?.txid === "string" ? row.txid : "";
      return txid !== "" && presentSide.discoveryOnlyTxids.has(txid);
    }
    case "transactionParticipants": {
      const txid = typeof row?.txid === "string" ? row.txid : "";
      return txid !== "" && presentSide.discoveryOnlyTxids.has(txid);
    }
    case "addressSyncState": {
      // Sync state drops with its (pruned) address record: prunable record, or
      // no record at all in the present side.
      const addr = syncStateMergeAddress(row);
      if (!addr) return false;
      const rec = presentSide.streamed.records.get(addr);
      if (!rec) return true;
      return isPrunableRecordShape(rec as VaultRecord);
    }
    case "utxoLineage": {
      // Mirrors compactRowFilters.dropLineage: every involved txid dropped and
      // no involved address kept.
      const txDropped = (t: unknown) =>
        typeof t === "string" && t !== "" && presentSide.discoveryOnlyTxids.has(t);
      const addressKept = (a: unknown) =>
        typeof a === "string" && a !== "" && presentSide.keptAddresses.has(a);
      return (
        txDropped(row?.spentTxid) &&
        txDropped(row?.consumingTxid) &&
        txDropped(row?.createdTxid) &&
        !addressKept(row?.spentAddress) &&
        !addressKept(row?.createdAddress)
      );
    }
    case "custodySegments": {
      // Mirrors compactRowFilters.dropSegment.
      const txDropped = (t: unknown) =>
        typeof t === "string" && t !== "" && presentSide.discoveryOnlyTxids.has(t);
      const addressKept = (a: unknown) =>
        typeof a === "string" && a !== "" && presentSide.keptAddresses.has(a);
      if (!txDropped(row?.originTxid)) return false;
      if (addressKept(row?.originAddress) || addressKept(row?.currentAddress)) return false;
      if (
        typeof row?.currentTxid === "string" &&
        row.currentTxid !== "" &&
        !txDropped(row.currentTxid)
      ) {
        return false;
      }
      const evidence = Array.isArray(row?.evidenceTxids) ? row.evidenceTxids : [];
      for (const txid of evidence) {
        if (!txDropped(txid)) return false;
      }
      return true;
    }
    default:
      return false;
  }
}

function mapForTable(snap: BackupSnapshot, table: string): Map<string, any> {
  return (snap.streamed as Record<string, Map<string, any>>)[table] ??
    (snap.inline as Record<string, Map<string, any>>)[table];
}

// Compares two snapshots table-by-table. `older`/`newer` are purely labels —
// pass the snapshots in whichever order tells the story you want.
export function diffSnapshots(older: BackupSnapshot, newer: BackupSnapshot): BackupDiffResult {
  const tables: TableDiff[] = [];
  const csvParts: string[] = [DIFF_CSV_HEADER.join(",") + "\r\n"];
  let csvRowCount = 0;

  const pushCsv = (cells: string[]) => {
    csvParts.push(cells.join(",") + "\r\n");
    csvRowCount += 1;
  };

  const tableNames = [...STREAMED_TABLES, ...COMPARED_INLINE_TABLES] as string[];
  for (const table of tableNames) {
    const label = TABLE_LABELS[table] ?? table;
    const olderMap = mapForTable(older, table);
    const newerMap = mapForTable(newer, table);
    const diff: TableDiff = {
      table,
      label,
      added: 0,
      removed: 0,
      changed: 0,
      suppressed: 0,
      entries: [],
    };

    // Removed from (or unchanged/changed against) the newer snapshot.
    for (const [key, oldRow] of olderMap) {
      if (!newerMap.has(key)) {
        // Absent from the newer side. When the NEWER backup is compact and the
        // row is discovery-only data (per the OLDER side's own rows), the
        // compact filter explains the absence — not a user deletion.
        if (newer.manifest.compact === true && isCompactPruned(table, oldRow, older)) {
          diff.suppressed += 1;
          continue;
        }
        diff.removed += 1;
        diff.entries.push({ key, change: "removed" });
        pushCsv([csvEscape(label), csvEscape("removed"), csvField(key), "", "", ""]);
        continue;
      }
      const newRow = newerMap.get(key);
      const deltas = fieldDeltas(table, oldRow, newRow);
      if (deltas.length > 0) {
        diff.changed += 1;
        diff.entries.push({ key, change: "changed", deltas });
        for (const d of deltas) {
          pushCsv([
            csvEscape(label),
            csvEscape("changed"),
            csvField(key),
            csvField(d.field),
            csvField(d.oldValue ?? ""),
            csvField(d.newValue ?? ""),
          ]);
        }
      }
    }
    // Added in the newer snapshot.
    for (const [key, newRow] of newerMap) {
      if (olderMap.has(key)) continue;
      // Mirror of the removed-side rule: when the OLDER backup is compact, a
      // discovery-only row showing up in the newer backup is history a compact
      // export would have pruned from the older one — not a user addition.
      if (older.manifest.compact === true && isCompactPruned(table, newRow, newer)) {
        diff.suppressed += 1;
        continue;
      }
      diff.added += 1;
      diff.entries.push({ key, change: "added" });
      pushCsv([csvEscape(label), csvEscape("added"), csvField(key), "", "", ""]);
    }

    tables.push(diff);
  }

  const summarize = (snap: BackupSnapshot): BackupFileSummary => ({
    exportDate: snap.manifest.exportDate,
    appVersion: snap.manifest.appVersion,
    encrypted: snap.manifest.encrypted === true,
    compact: snap.manifest.compact === true,
    counts: snap.manifest.counts,
  });

  return {
    older: summarize(older),
    newer: summarize(newer),
    tables,
    csv: { parts: csvParts, rowCount: csvRowCount },
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface CompareBackupInput {
  source: AsyncIterable<Uint8Array>;
  password?: string;
}

export interface CompareBackupsOptions {
  older: CompareBackupInput;
  newer: CompareBackupInput;
  onProgress?: (p: RestoreProgress) => void;
  signal?: AbortSignal;
}

// Streams both backups into snapshots (older first, then newer — never both
// ZIPs at once) and diffs them. Errors are prefixed with which file failed so
// a wrong password on either side is unambiguous.
export async function compareBackups(opts: CompareBackupsOptions): Promise<BackupDiffResult> {
  const progress = (base: number, span: number) => (p: RestoreProgress) => {
    opts.onProgress?.({
      percent: base + Math.round((p.percent / 100) * span),
      phase: p.phase,
    });
  };

  let older: BackupSnapshot;
  try {
    opts.onProgress?.({ percent: 1, phase: "Reading older backup..." });
    older = await readBackupSnapshot({
      source: opts.older.source,
      password: opts.older.password,
      onProgress: progress(0, 45),
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof BackupCancelledError) throw e;
    throw new Error(`Older backup: ${e instanceof Error ? e.message : String(e)}`);
  }

  let newer: BackupSnapshot;
  try {
    opts.onProgress?.({ percent: 46, phase: "Reading newer backup..." });
    newer = await readBackupSnapshot({
      source: opts.newer.source,
      password: opts.newer.password,
      onProgress: progress(45, 45),
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof BackupCancelledError) throw e;
    throw new Error(`Newer backup: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (opts.signal?.aborted) throw new BackupCancelledError();
  opts.onProgress?.({ percent: 92, phase: "Comparing..." });
  const result = diffSnapshots(older, newer);
  opts.onProgress?.({ percent: 100, phase: "Comparison complete" });
  return result;
}

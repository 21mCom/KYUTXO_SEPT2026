// Streaming backup restore (v3). Reads the ZIP as a byte stream, processing one
// entry at a time so the whole vault is never held in memory:
//   1. backup.json (first): verify password, clear everything, restore the
//      small inline tables — all before any big-table row is processed.
//   2. records.ndjson: insert each batch via CRUD, building old->new id map.
//   3. dependent NDJSON (attachments / participants / addressSyncState): rewrite
//      recordId through the id map, then bulk-insert per batch.
//   4. blockchainTransactions.ndjson: keyed by txid, inserted as-is.
//   5. attachments/<relPath>: write each attachment file's bytes.
//
// Clearing happens inside the manifest entry's handler, which (because entry
// processing is serialized) completes before any data row is touched. A wrong
// password throws BEFORE clearing, so the existing vault is left intact.
//
// Legacy (pre-v3) backups are NOT handled here — callers detect them via
// peekManifest() and keep using the existing whole-file restore path.

import {
  isStreamedTablePath,
  parseBatchLine,
  parseInline,
  isV3Manifest,
  MANIFEST_FILENAME,
  ATTACHMENTS_DIR,
  CHECK_SENTINEL,
  type BackupManifest,
  type StreamedTable,
} from "./format";
import {
  readZipStream,
  lineConsumer,
  collectBytesConsumer,
} from "./zip-stream";
import { BackupCancelledError } from "./sink";
import { deriveKey, decrypt, base64ToBuffer } from "@/lib/crypto";
import { clearAuditSession } from "@/lib/data/privacy-audit-session-store";
import {
  bulkCreateRecords,
  clearAllRecords,
  getRecordsByInputStrings,
  type CreateRecordData,
} from "@/lib/data/record-crud";
import {
  bulkAddAttachments,
  clearAttachments,
  getAllAttachments,
  type CreateAttachmentData,
} from "@/lib/data/attachments-crud";
import {
  bulkAddParticipants,
  bulkPutParticipants,
  bulkAddTransactions,
  clearParticipants,
  clearTransactions,
  getTransactionsByTxids,
  getParticipantsByTxids,
  updateTransaction,
  type CreateTransactionData,
} from "@/lib/data/transaction-crud";
import {
  bulkAddAddressSyncState,
  clearAddressSyncState,
  getAllAddressSyncState,
  type CreateAddressSyncStateData,
} from "@/lib/data/address-sync-crud";
import {
  bulkAddUtxoLineage,
  bulkAddCustodySegments,
  bulkAddLineageSnapshots,
  clearUtxoLineage,
  clearCustodySegments,
  clearLineageSnapshots,
  getAllUtxoLineage,
  getExistingSegmentIds,
  getExistingSnapshotIds,
} from "@/lib/data/lineage-crud";
import type {
  TransactionParticipant,
  UtxoLineage,
  CustodySegment,
  LineageSnapshot,
} from "@/lib/database";
import { clearInlineTables, restoreInlineTables } from "./inline-tables";
import {
  mergeDuplicateTransactionsByTxid,
  computeTransactionEnrichment,
  computeParticipantEnrichment,
  participantKey,
  participantMatchKey,
  type RestoreMode,
} from "./legacy-restore";
import { lineageIdentity } from "./legacy-restore-misc";

// Thrown when a restore is cancelled AFTER the destructive clear but the vault
// could NOT be reset to a clean state. The vault is then in an unknown partial
// state — distinct from BackupCancelledError, which always implies a known
// outcome (existing data intact, or a verified-empty vault).
export class RestoreInterruptedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "RestoreInterruptedError";
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

// Thrown when writing a single attachment file fails (e.g. the disk is full or
// the write endpoint rejected the file). Carries the attachment's relative path
// and the underlying error so the UI can give the user a specific, actionable
// message instead of a raw endpoint error. After the destructive clear this is
// surfaced as the `cause` of a RestoreInterruptedError.
export class AttachmentWriteError extends Error {
  relPath: string;
  // How many attachment files this restore had SUCCESSFULLY written to disk
  // before this one failed. Lets the UI tell the user how far the restore got
  // (useful for diagnosing a single corrupt file vs. a disk that filled up).
  filesWrittenBefore: number;
  constructor(
    relPath: string,
    message: string,
    options?: { cause?: unknown; filesWrittenBefore?: number },
  ) {
    super(message);
    this.name = "AttachmentWriteError";
    this.relPath = relPath;
    this.filesWrittenBefore = options?.filesWrittenBefore ?? 0;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

// Result of a pre-flight disk-space check run BEFORE the destructive clear.
export interface DiskSpaceEstimate {
  // Raw estimate of bytes the restore will write to disk.
  estimatedBytes: number;
  // estimatedBytes padded by the safety factor — the threshold actually
  // compared against free space.
  requiredBytes: number;
  freeBytes: number;
  // True when free space is at least requiredBytes.
  sufficient: boolean;
}

// Decides whether a restore should be allowed to start given the bytes it is
// estimated to need and the disk space currently free.
//
// The estimate is the backup file's own size: attachment files are stored
// UNCOMPRESSED in the v3 ZIP, so the archive size is a safe upper bound on the
// bytes a restore writes to disk (the compressed NDJSON tables it also contains
// only make the estimate more conservative). A small safety factor leaves head
// room for filesystem overhead. This lets the user free space BEFORE the
// destructive clear, instead of discovering a disk-full failure only after the
// existing vault is already gone.
export function evaluateDiskSpace(
  estimatedBytes: number,
  freeBytes: number,
  safetyFactor = 1.1,
): DiskSpaceEstimate {
  const estimate = Number.isFinite(estimatedBytes)
    ? Math.max(0, Math.ceil(estimatedBytes))
    : 0;
  const requiredBytes = Math.ceil(estimate * safetyFactor);
  return {
    estimatedBytes: estimate,
    requiredBytes,
    freeBytes,
    sufficient: freeBytes >= requiredBytes,
  };
}

export interface AttachmentFileWriter {
  write(relPath: string, data: ArrayBuffer): Promise<void>;
  // Optional: remove a previously-written attachment file. Used both to sweep
  // files this restore wrote when the restore fails (or is cancelled) AFTER the
  // destructive clear, AND to reclaim OLD-vault files a SUCCESSFUL restore left
  // behind (see sweepOrphanedOldFiles). clearVault only resets DB/inline tables,
  // so without this delete those files would be stranded on disk as orphans.
  // Best-effort: a failure to delete must not mask the primary error.
  delete?(relPath: string): Promise<void>;
  // Optional: list every attachment file currently on disk (relative paths, no
  // `attachments/` prefix). Snapshotted BEFORE the write phase so a successful
  // restore can delete any prior-vault file the new vault does not reference
  // (the write phase only overwrites colliding paths; clearVault never touches
  // files). Best-effort: if absent or it throws, the old-vault sweep is skipped.
  list?(): Promise<string[]>;
  // Optional: write an attachment whose owning record was absent (orphan) to a
  // Needs Review folder under the original filename instead of the normal pool.
  // Called in place of write() for orphaned files. Best-effort: failures are
  // swallowed rather than aborting the restore (the orphan is counted but the
  // bytes are lost, which is still better than silently vanishing).
  writeReview?(originalFilename: string, data: ArrayBuffer): Promise<void>;
}

export interface RestoreProgress {
  percent: number;
  phase: string;
}

export interface RestoreOptions {
  source: AsyncIterable<Uint8Array>;
  password?: string;
  attachmentWriter: AttachmentFileWriter;
  // "replace" (default): clear the whole vault first, then restore everything.
  // "merge": NEVER clears — backup rows are added alongside existing data, with
  // per-table de-duplication by each table's natural key (records by
  // inputString, transactions by txid, addressSyncState by address, lineage
  // tables by their natural keys, attachments by objectStoragePath, inline
  // tables via restoreInlineTables(data, "merge")). Colliding transactions and
  // participants ENRICH the live row's missing fields instead of duplicating it.
  restoreMode?: RestoreMode;
  clearInline?: () => Promise<void>;
  restoreInline?: (
    data: Record<string, unknown>,
    restoreMode: RestoreMode,
  ) => Promise<void>;
  onProgress?: (p: RestoreProgress) => void;
  signal?: AbortSignal;
}

export interface RestoreResult {
  manifest: BackupManifest;
  counts: {
    records: number;
    attachments: number;
    transactionParticipants: number;
    addressSyncState: number;
    blockchainTransactions: number;
    utxoLineage: number;
    custodySegments: number;
    lineageSnapshots: number;
    attachmentFiles: number;
    // Number of attachment files whose owning record was absent and were
    // routed to the Needs Review folder (never linked to any DB row).
    orphanedAttachmentFiles: number;
    // Subset of orphanedAttachmentFiles whose writeReview() failed, so their
    // bytes could NOT be saved anywhere and were lost. Counted separately so
    // the UI can warn the user about actual data loss.
    orphanedAttachmentFilesLost: number;
  };
}

// Peeks just the manifest (first ZIP entry) without reading the whole archive,
// so callers can detect v3 vs legacy and decide which restore path to use.
export async function peekManifest(
  source: AsyncIterable<Uint8Array>,
): Promise<unknown | null> {
  let result: unknown = null;
  const STOP = Symbol("stop");
  try {
    await readZipStream(source, {
      onEntry(name) {
        if (name !== MANIFEST_FILENAME) return null;
        return collectBytesConsumer((bytes) => {
          result = JSON.parse(new TextDecoder().decode(bytes));
          throw STOP; // stop early; manifest is the first entry
        });
      },
    });
  } catch (e) {
    if (e !== STOP) throw e;
  }
  return result;
}

const remap = (idMap: Map<number, number>, oldId: unknown): number | undefined => {
  if (typeof oldId !== "number") return undefined;
  return idMap.get(oldId);
};

export async function restoreV3Backup(opts: RestoreOptions): Promise<RestoreResult> {
  const restoreMode: RestoreMode = opts.restoreMode ?? "replace";
  const isMerge = restoreMode === "merge";
  const clearInlineFn = opts.clearInline ?? clearInlineTables;
  const restoreInlineFn = opts.restoreInline ?? restoreInlineTables;

  // Merge-mode de-dup state, loaded lazily on the first batch of each table so
  // a replace restore (or a merge without that table) pays no cost. Keys added
  // during the restore are tracked too so the incoming stream never duplicates
  // itself across batches.
  let existingAttachmentKeys: Set<string> | null = null;
  let existingSyncAddresses: Set<string> | null = null;
  let existingLineageKeys: Set<string> | null = null;
  let existingSegmentIds: Set<string> | null = null;
  let existingSnapshotIds: Set<string> | null = null;
  // Participants added during this merge (exact keys), so the incoming set
  // never duplicates itself across batches.
  const addedParticipantKeys = new Set<string>();
  // Restore-wide inputString → live record id map: seeded per batch from the
  // DB and extended after every successful create, so a record identity that
  // repeats in a LATER streamed batch maps to the already-inserted row instead
  // of creating a duplicate with a diverging id for dependent rows.
  const mergedRecordIdByInputString = new Map<string, number>();

  let manifest: BackupManifest | null = null;
  // Set synchronously when the manifest entry's header is reached. onEntry is
  // fflate's sync header callback, whereas `manifest` is only assigned later in
  // the async consumer chain — so ordering checks must use this flag, not
  // `manifest`, which lags behind by one (or more) entry headers.
  let manifestSeen = false;
  let key: CryptoKey | null = null;
  const idMap = new Map<number, number>();
  // Orphaned attachment metadata: relPath (objectStoragePath) → original
  // filename. Populated in handleBatch("attachments") for rows whose owning
  // record is absent. When the ZIP file bytes entry for that relPath arrives,
  // the bytes are routed to writeReview() instead of write(), so no hidden
  // duplicate is left in the normal attachment pool.
  const orphanRelPaths = new Map<string, string>();
  const counts = {
    records: 0,
    attachments: 0,
    transactionParticipants: 0,
    addressSyncState: 0,
    blockchainTransactions: 0,
    utxoLineage: 0,
    custodySegments: 0,
    lineageSnapshots: 0,
    attachmentFiles: 0,
    orphanedAttachmentFiles: 0,
    orphanedAttachmentFilesLost: 0,
  };

  // Becomes true once the destructive clear has run. After this point the
  // existing vault is gone, so a user-initiated cancel cannot return to the
  // prior state — instead we reset to a known-empty state (see clearVault).
  let cleared = false;

  // Relative paths of attachment files this restore has SUCCESSFULLY written to
  // disk. clearVault only wipes DB/inline tables, so if the restore fails or is
  // cancelled after the destructive clear we must also sweep these files —
  // otherwise they are stranded on disk as orphans (see sweepWrittenFiles).
  const writtenFiles: string[] = [];

  // Snapshot of the OLD vault's on-disk attachment files (normalised relative
  // paths), taken BEFORE the write phase. After a SUCCESSFUL restore, any file
  // here that the new vault did NOT write is a prior-vault orphan and is swept
  // (see sweepOrphanedOldFiles). Null when listing is unavailable/failed, in
  // which case the old-vault sweep is skipped entirely.
  let preExistingFiles: Set<string> | null = null;

  // Normalise a relative attachment path so on-disk listings and the paths this
  // restore wrote compare equal: forward slashes, no `attachments/` prefix.
  const normalizeRelPath = (p: string): string => {
    const fwd = p.replace(/\\/g, "/");
    return fwd.startsWith(`${ATTACHMENTS_DIR}/`)
      ? fwd.slice(ATTACHMENTS_DIR.length + 1)
      : fwd;
  };

  const throwIfAborted = () => {
    if (opts.signal?.aborted) throw new BackupCancelledError();
  };

  // Wipes every table touched by a restore. Used both for the initial
  // destructive clear and to reset to a known-empty state if the user cancels
  // mid-restore after that clear has already happened.
  async function clearVault(): Promise<void> {
    await clearAllRecords({ skipNotification: true });
    await clearAttachments({ skipNotification: true });
    await clearParticipants({ skipNotification: true });
    await clearTransactions({ skipNotification: true });
    await clearAddressSyncState({ skipNotification: true });
    await clearUtxoLineage({ skipNotification: true });
    await clearCustodySegments({ skipNotification: true });
    await clearLineageSnapshots({ skipNotification: true });
    await clearInlineFn();
    // Drop any persisted Privacy Audit / Adversary View session — it was
    // computed from the vault that was just wiped, so restoring it after this
    // point would show results about data that no longer exists. Best-effort:
    // this scratch store lives in a separate IndexedDB database and its
    // failure must never turn a clean clear into a restore error.
    try {
      await clearAuditSession();
    } catch (err) {
      console.warn("Failed to clear saved privacy audit session:", err);
    }
  }

  // Best-effort removal of attachment files this restore wrote to disk. Called
  // when a restore fails or is cancelled AFTER the destructive clear so those
  // files are not left stranded as orphans (clearVault only touches the DB). A
  // delete that itself fails must NOT mask the primary restore error — any file
  // we cannot remove here remains discoverable by the attachment audit/repair
  // tools, so we swallow per-file errors and keep going.
  async function sweepWrittenFiles(): Promise<void> {
    const del = opts.attachmentWriter.delete;
    if (!del || writtenFiles.length === 0) return;
    for (const relPath of writtenFiles) {
      try {
        await del.call(opts.attachmentWriter, relPath);
      } catch {
        // intentionally ignored — see comment above
      }
    }
    writtenFiles.length = 0;
  }

  // Best-effort removal of OLD-vault attachment files a SUCCESSFUL restore left
  // stranded on disk. clearVault only wipes the DB, and the write phase only
  // overwrites files whose paths collide with a backup entry — so any prior file
  // whose path is NOT present in the restored vault would otherwise linger
  // forever as an orphan (wasting space, polluting attachment audits). We delete
  // only files that (a) existed on disk BEFORE this restore and (b) were NOT
  // written by it, so a file the new vault references is never removed. Per-file
  // delete errors are swallowed (the orphan stays discoverable by the audit).
  async function sweepOrphanedOldFiles(): Promise<void> {
    const del = opts.attachmentWriter.delete;
    if (!del || preExistingFiles === null || preExistingFiles.size === 0) return;
    const written = new Set(writtenFiles.map(normalizeRelPath));
    for (const oldRel of preExistingFiles) {
      if (written.has(oldRel)) continue;
      try {
        await del.call(opts.attachmentWriter, oldRel);
      } catch {
        // intentionally ignored — see comment above
      }
    }
  }

  const total = () =>
    manifest
      ? (manifest.counts.records +
          manifest.counts.attachments +
          manifest.counts.transactionParticipants +
          manifest.counts.addressSyncState +
          manifest.counts.blockchainTransactions +
          (manifest.counts.utxoLineage ?? 0) +
          (manifest.counts.custodySegments ?? 0) +
          (manifest.counts.lineageSnapshots ?? 0) +
          manifest.counts.attachmentFiles) || 1
      : 1;
  let processed = 0;
  const report = (phase: string) => {
    const pct = 10 + Math.min(89, Math.round((processed / total()) * 89));
    opts.onProgress?.({ percent: pct, phase });
  };

  async function handleBatch(table: StreamedTable, rows: any[]): Promise<void> {
    throwIfAborted();
    if (table === "records") {
      // Merge mode: skip records whose `inputString` already exists, mapping
      // the backup id to the EXISTING live id so dependent rows (attachments,
      // participants, addressSyncState) still link correctly. Mirrors the
      // legacy merge path's de-dup key.
      let toCreate = rows;
      // Same-batch duplicates: backup ids whose row was skipped because an
      // EARLIER row in this batch carries the same inputString; they map to
      // that first row's eventual new id once the batch insert completes.
      const deferredIdLinks: Array<{ oldId: number; index: number }> = [];
      if (isMerge) {
        // Only hit the DB for identities not already known from earlier
        // batches (live rows queried before, or rows this merge created).
        const unknown = rows
          .map((r) => r.inputString)
          .filter(
            (s): s is string =>
              typeof s === "string" && s !== "" && !mergedRecordIdByInputString.has(s),
          );
        if (unknown.length) {
          const found = await getRecordsByInputStrings(unknown);
          for (const r of found) {
            if (typeof r.id === "number") {
              mergedRecordIdByInputString.set(r.inputString, r.id);
            }
          }
        }
        toCreate = [];
        // inputString → index in toCreate, so a duplicate identity WITHIN this
        // batch collapses onto the first occurrence instead of inserting twice
        // (records.inputString is indexed but NOT unique — nothing else stops it).
        const pendingIndexByInput = new Map<string, number>();
        for (const r of rows) {
          const s = typeof r.inputString === "string" ? r.inputString : "";
          const existingId = s ? mergedRecordIdByInputString.get(s) : undefined;
          if (existingId !== undefined) {
            if (typeof r.id === "number") idMap.set(r.id, existingId);
            continue;
          }
          const pendingIndex = s ? pendingIndexByInput.get(s) : undefined;
          if (pendingIndex !== undefined) {
            if (typeof r.id === "number") {
              deferredIdLinks.push({ oldId: r.id, index: pendingIndex });
            }
            continue;
          }
          if (s) pendingIndexByInput.set(s, toCreate.length);
          toCreate.push(r);
        }
      }
      const oldIds = toCreate.map((r) => r.id);
      const payload: CreateRecordData[] = toCreate.map(({ id, ...rest }) => rest as CreateRecordData);
      const newIds = await bulkCreateRecords(payload, {
        skipNotification: true,
        skipVocabularySync: true,
      });
      for (let i = 0; i < newIds.length; i++) {
        const o = oldIds[i];
        if (typeof o === "number") idMap.set(o, newIds[i]);
        if (isMerge) {
          const s = toCreate[i]?.inputString;
          if (typeof s === "string" && s !== "" && !mergedRecordIdByInputString.has(s)) {
            mergedRecordIdByInputString.set(s, newIds[i]);
          }
        }
      }
      // Same-batch duplicates now resolve to the first occurrence's new id.
      for (const link of deferredIdLinks) {
        idMap.set(link.oldId, newIds[link.index]);
      }
      counts.records += newIds.length;
    } else if (table === "attachments") {
      // Merge mode: de-dup by `objectStoragePath` (sha256-derived, unique per
      // stored file), falling back to `recordId:filename` — same identity key
      // as the legacy merge path. Loaded once, then extended as rows are added
      // so the incoming stream never duplicates itself across batches.
      if (isMerge && existingAttachmentKeys === null) {
        existingAttachmentKeys = new Set<string>();
        for (const att of await getAllAttachments()) {
          existingAttachmentKeys.add(
            att.objectStoragePath || `${att.recordId}:${att.filename}`,
          );
        }
      }
      const out: CreateAttachmentData[] = [];
      for (const a of rows) {
        const { id, ...d } = a;
        const recordId = remap(idMap, d.recordId);
        if (recordId === undefined) {
          // Orphan: owning record absent. Track the relPath so the file bytes
          // can be routed to the review folder when the ZIP entry arrives.
          if (d.objectStoragePath) {
            orphanRelPaths.set(
              String(d.objectStoragePath),
              String(d.filename || "unknown"),
            );
          }
          continue;
        }
        if (isMerge) {
          const attKey = d.objectStoragePath || `${recordId}:${d.filename}`;
          if (existingAttachmentKeys!.has(attKey)) continue;
          existingAttachmentKeys!.add(attKey);
        }
        out.push({ ...d, recordId } as CreateAttachmentData);
      }
      if (out.length) await bulkAddAttachments(out, { skipNotification: true });
      counts.attachments += out.length;
    } else if (table === "transactionParticipants") {
      let incoming = rows;
      const toEnrichById = new Map<number, TransactionParticipant>();
      if (isMerge) {
        // Merge mode: a participant's transaction may already exist live (the
        // participants stream BEFORE blockchainTransactions, so any live
        // participant for a batch txid predates this restore). Match each
        // backup participant to its live counterpart (outpoint for inputs /
        // vout for outputs, falling back to the exact key): a match ENRICHES
        // the live row's missing fields instead of duplicating it; unmatched
        // rows are added, de-duped against the incoming stream itself.
        const batchTxids = Array.from(
          new Set(
            rows.map((p) => p.txid).filter((t): t is string => typeof t === "string" && t !== ""),
          ),
        );
        const liveByMatchKey = new Map<string, TransactionParticipant>();
        const liveByExactKey = new Map<string, TransactionParticipant>();
        if (batchTxids.length) {
          for (const lp of await getParticipantsByTxids(batchTxids)) {
            if (!liveByExactKey.has(participantKey(lp))) {
              liveByExactKey.set(participantKey(lp), lp);
            }
            const mk = participantMatchKey(lp);
            if (mk && !liveByMatchKey.has(mk)) liveByMatchKey.set(mk, lp);
          }
        }
        incoming = [];
        for (const p of rows) {
          const remappedRecordId = remap(idMap, p.recordId);
          const mk = participantMatchKey(p);
          const liveMatch =
            (mk ? liveByMatchKey.get(mk) : undefined) ??
            liveByExactKey.get(participantKey(p));
          if (liveMatch && typeof liveMatch.id === "number") {
            const existing = toEnrichById.get(liveMatch.id) ?? liveMatch;
            const changes = computeParticipantEnrichment(existing, {
              ...p,
              recordId: remappedRecordId,
            });
            if (Object.keys(changes).length > 0) {
              toEnrichById.set(liveMatch.id, { ...existing, ...changes });
            }
            continue;
          }
          const key = participantKey(p);
          if (addedParticipantKeys.has(key)) continue;
          addedParticipantKeys.add(key);
          incoming.push(p);
        }
      }
      const out = incoming.map(({ id, ...d }) => ({
        ...d,
        recordId: remap(idMap, d.recordId),
      }));
      if (out.length) {
        await bulkAddParticipants(out as TransactionParticipant[], { skipNotification: true });
      }
      if (toEnrichById.size > 0) {
        await bulkPutParticipants(Array.from(toEnrichById.values()), {
          skipNotification: true,
        });
      }
      counts.transactionParticipants += out.length;
    } else if (table === "addressSyncState") {
      // The `address` index is unique, so in merge mode rows whose address is
      // already present (or repeated within the stream) must be skipped or the
      // bulk insert would abort the whole restore.
      if (isMerge && existingSyncAddresses === null) {
        existingSyncAddresses = new Set<string>();
        for (const s of await getAllAddressSyncState()) {
          existingSyncAddresses.add(s.address);
        }
      }
      let incoming = rows;
      if (isMerge) {
        incoming = rows.filter((s) => {
          if (!s.address || existingSyncAddresses!.has(s.address)) return false;
          existingSyncAddresses!.add(s.address);
          return true;
        });
      }
      const out = incoming.map(({ id, ...d }) => ({
        ...d,
        recordId: remap(idMap, d.recordId),
      }));
      if (out.length) {
        await bulkAddAddressSyncState(out as CreateAddressSyncStateData[], {
          skipNotification: true,
        });
      }
      counts.addressSyncState += out.length;
    } else if (table === "blockchainTransactions") {
      // In replace mode the vault was cleared first, so a same-txid collision
      // with an EXISTING row can never happen — but a malformed/hand-edited
      // backup could still repeat a txid within the stream, so duplicates in
      // the batch are always collapsed via enrichment (neither dropping the
      // richer row nor crashing on the unique-`txid` constraint).
      //
      // In merge mode a batch txid may also collide with a LIVE row: the live
      // transaction is kept, and fields that are missing/empty/placeholder on
      // it are filled in from the backup row (never overwriting populated
      // fields) — mirroring the legacy merge path's enrichment semantics.
      const deduped = mergeDuplicateTransactionsByTxid(rows);
      let toInsert = deduped;
      if (isMerge) {
        const batchTxids = deduped
          .map((t) => t.txid)
          .filter((t): t is string => typeof t === "string" && t !== "");
        const liveByTxid = new Map<string, any>();
        if (batchTxids.length) {
          for (const tx of await getTransactionsByTxids(batchTxids)) {
            liveByTxid.set(tx.txid, tx);
          }
        }
        toInsert = [];
        for (const tx of deduped) {
          const live = typeof tx.txid === "string" ? liveByTxid.get(tx.txid) : undefined;
          if (live && typeof live.id === "number") {
            const changes = computeTransactionEnrichment(live, tx);
            if (Object.keys(changes).length > 0) {
              await updateTransaction(live.id, changes, { skipNotification: true });
            }
            continue;
          }
          toInsert.push(tx);
        }
      }
      const out = toInsert.map(({ id, ...d }) => d as CreateTransactionData);
      if (out.length) await bulkAddTransactions(out, { skipNotification: true });
      counts.blockchainTransactions += out.length;
    } else if (table === "utxoLineage") {
      // No recordId: rows relink by txid/vout, so insert as-is (drop old id).
      // utxoLineage has no unique index, so in merge mode rows whose
      // `lineageIdentity` already exists are skipped to avoid duplicate edges.
      if (isMerge && existingLineageKeys === null) {
        existingLineageKeys = new Set<string>();
        for (const l of await getAllUtxoLineage()) {
          existingLineageKeys.add(lineageIdentity(l));
        }
      }
      let incoming = rows;
      if (isMerge) {
        incoming = rows.filter((d) => {
          const key = lineageIdentity(d);
          if (existingLineageKeys!.has(key)) return false;
          existingLineageKeys!.add(key);
          return true;
        });
      }
      const out = incoming.map(({ id, ...d }) => d as UtxoLineage);
      if (out.length) await bulkAddUtxoLineage(out, { skipNotification: true });
      counts.utxoLineage += out.length;
    } else if (table === "custodySegments") {
      // No recordId: rows relink by segmentId/txid, so insert as-is (drop old
      // id). `segmentId` is a UNIQUE index, so in merge mode already-present
      // segments are skipped or the insert would abort the restore mid-way.
      if (isMerge && existingSegmentIds === null) {
        existingSegmentIds = await getExistingSegmentIds();
      }
      let incoming = rows;
      if (isMerge) {
        incoming = rows.filter((d) => {
          const segmentId = d.segmentId;
          if (typeof segmentId === "string" && existingSegmentIds!.has(segmentId)) return false;
          if (typeof segmentId === "string") existingSegmentIds!.add(segmentId);
          return true;
        });
      }
      const out = incoming.map(({ id, ...d }) => d as CustodySegment);
      if (out.length) await bulkAddCustodySegments(out, { skipNotification: true });
      counts.custodySegments += out.length;
    } else if (table === "lineageSnapshots") {
      // No recordId: selective-disclosure proof artifacts keyed by their own
      // unique `snapshotId`, so insert as-is (drop old id). In merge mode
      // already-present snapshotIds are skipped (unique index), mirroring
      // custodySegments.
      if (isMerge && existingSnapshotIds === null) {
        existingSnapshotIds = await getExistingSnapshotIds();
      }
      let incoming = rows;
      if (isMerge) {
        incoming = rows.filter((d) => {
          const snapshotId = d.snapshotId;
          if (typeof snapshotId === "string" && existingSnapshotIds!.has(snapshotId)) return false;
          if (typeof snapshotId === "string") existingSnapshotIds!.add(snapshotId);
          return true;
        });
      }
      const out = incoming.map(({ id, ...d }) => d as LineageSnapshot);
      if (out.length) await bulkAddLineageSnapshots(out, { skipNotification: true });
      counts.lineageSnapshots += out.length;
    }
    processed += rows.length;
    report(`Restoring ${table}...`);
  }

  try {
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
              key = await deriveKey(opts.password, salt);
              // Verify BEFORE any destructive clear.
              let ok = false;
              try {
                ok = (await decrypt(manifest.check ?? "", key)) === CHECK_SENTINEL;
              } catch {
                ok = false;
              }
              if (!ok) throw new Error("Invalid password or corrupted backup");
            }

            // A cancel requested before the clear leaves the existing vault
            // intact; check one last time on the point-of-no-return boundary.
            throwIfAborted();

            if (!isMerge) {
              // Snapshot the OLD vault's on-disk attachment files BEFORE writing
              // anything, so a successful restore can later delete any prior-vault
              // file the new vault does not reference. clearVault never touches
              // files, so doing this just before it is equivalent and keeps the
              // listing close to the point of no return. Best-effort: a listing
              // failure simply disables the post-restore sweep.
              // (Merge mode never lists or sweeps: existing files stay referenced
              // by the kept vault rows, so deleting "unwritten" old files would
              // destroy live attachments.)
              const listFn = opts.attachmentWriter.list;
              if (listFn) {
                try {
                  const existing = await listFn.call(opts.attachmentWriter);
                  preExistingFiles = new Set(existing.map(normalizeRelPath));
                } catch {
                  preExistingFiles = null;
                }
              }

              opts.onProgress?.({ percent: 8, phase: "Clearing existing data..." });
              await clearVault();
              cleared = true;
            } else {
              // Merge mode: the vault is NEVER cleared. But any persisted
              // Privacy Audit / Adversary View session was computed from the
              // pre-merge vault, so it would show stale results about a vault
              // that now contains more data. Best-effort, mirroring clearVault.
              try {
                await clearAuditSession();
              } catch (err) {
                console.warn("Failed to clear saved privacy audit session:", err);
              }
            }

            opts.onProgress?.({ percent: 9, phase: "Restoring metadata..." });
            const inline = await parseInline(manifest, key);
            await restoreInlineFn(inline, restoreMode);
          });
        }

        // Every non-manifest entry is data. The manifest must physically precede
        // all data so its async handler (verify password, derive key, clear the
        // vault) runs — on the serialized consumer chain — before any data row is
        // written. `manifestSeen` reflects header order (set synchronously above),
        // so reject any archive that front-loads data before the manifest.
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
            if (rows.length) await handleBatch(table, rows);
          });
        }

        if (name.startsWith(`${ATTACHMENTS_DIR}/`) && !name.endsWith("/")) {
          const relPath = name.slice(ATTACHMENTS_DIR.length + 1);
          return collectBytesConsumer(async (bytes) => {
            throwIfAborted();
            const ab = bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer;

            const orphanFilename = orphanRelPaths.get(relPath);
            if (orphanFilename !== undefined) {
              // Orphaned file: no owning record. Route to the review folder
              // under the original filename instead of the normal attachment
              // pool, so no hidden duplicate is left behind. Best-effort: a
              // writeReview failure is swallowed so it cannot abort the restore
              // — the orphan is still counted for the UI notification, and the
              // failure is tallied separately so the user can be warned that
              // those bytes could not be saved anywhere.
              try {
                await opts.attachmentWriter.writeReview?.(orphanFilename, ab);
              } catch {
                // intentionally swallowed — best-effort routing
                counts.orphanedAttachmentFilesLost += 1;
              }
              counts.orphanedAttachmentFiles += 1;
              processed += 1;
              report("Restoring attachment files...");
              return;
            }

            try {
              await opts.attachmentWriter.write(relPath, ab);
            } catch (writeErr) {
              // Tag the failure with its kind + path so the caller can show a
              // specific "disk may be full / file rejected" message rather than
              // a raw endpoint error. Cancellation must NOT be reclassified.
              if (writeErr instanceof BackupCancelledError) throw writeErr;
              throw new AttachmentWriteError(
                relPath,
                writeErr instanceof Error ? writeErr.message : String(writeErr),
                { cause: writeErr, filesWrittenBefore: counts.attachmentFiles },
              );
            }
            writtenFiles.push(relPath);
            counts.attachmentFiles += 1;
            processed += 1;
            report("Restoring attachment files...");
          });
        }

        return null; // ignore anything else
      },
    });
  } catch (err) {
    const aborted = opts.signal?.aborted ?? false;
    if (err instanceof BackupCancelledError || aborted) {
      if (!cleared) {
        // Cancelled before the destructive clear: the existing vault was never
        // touched, so it is left fully intact.
        const cancelErr =
          err instanceof BackupCancelledError ? err : new BackupCancelledError();
        cancelErr.clearedBeforeCancel = false;
        throw cancelErr;
      }

      // Cancelled after the clear: the old vault is already gone and only part
      // of the backup was written. We must reset to a known-empty state so the
      // vault is never left half-restored. This cleanup MUST succeed for us to
      // honestly report an empty vault — if it fails, the vault is in an unknown
      // partial state, so we fail CLOSED with a distinct hard error rather than
      // claiming a clean cancel.
      opts.onProgress?.({ percent: 0, phase: "Cancelling — clearing partial data..." });
      // Sweep any attachment files this restore wrote so they are not stranded
      // on disk once the DB is reset to empty (clearVault only wipes the DB).
      await sweepWrittenFiles();
      try {
        await clearVault();
      } catch (cleanupErr) {
        throw new RestoreInterruptedError(
          "Restore was cancelled after the existing data had been cleared, but the " +
            "vault could not be reset to a clean state. The vault is now in an " +
            "unknown, partial state — restore again to recover your data.",
          { cause: cleanupErr },
        );
      }
      opts.onProgress?.({ percent: 0, phase: "Cancelled — vault is empty" });
      const cancelErr =
        err instanceof BackupCancelledError ? err : new BackupCancelledError();
      cancelErr.clearedBeforeCancel = true;
      throw cancelErr;
    }

    // Not a cancel — a genuine failure (e.g. an attachment file write threw for
    // a real-world reason like disk-full or permission-denied).
    if (!cleared) {
      // Failed BEFORE the destructive clear: the existing vault was never
      // touched, so just propagate the raw error.
      //
      // MERGE-MODE FAILURE CONTRACT: `cleared` is always false in merge mode
      // (merge never clears), so every merge failure lands here. Existing data
      // is guaranteed intact, but rows already merged from the backup BEFORE
      // the failure remain — merge is additive-idempotent, not atomic. Callers
      // must surface that partial backup data may remain and invalidate
      // dependent state (orphan check, audit results — the audit session was
      // already cleared up-front). Re-running the same merge after fixing the
      // cause is safe: every table de-dupes by its natural key, so already-
      // merged rows are skipped, not duplicated.
      throw err;
    }

    // Failed AFTER the destructive clear: the old vault is gone, the inline DB
    // tables are already restored, and only part of the backup was written —
    // leaving DB links that may point at attachment files that were never
    // written. Mirror the cancel-after-clear contract: reset to a known-empty
    // state and surface a distinct hard error (RestoreInterruptedError, never
    // the raw error) so the user is never silently left with a half-restored,
    // unusable vault. If the reset itself fails, we still fail CLOSED with the
    // same distinct error rather than claiming success.
    opts.onProgress?.({ percent: 0, phase: "Restore failed — clearing partial data..." });
    // Sweep any attachment files this restore wrote so they are not stranded
    // on disk once the DB is reset to empty (clearVault only wipes the DB).
    await sweepWrittenFiles();
    try {
      await clearVault();
    } catch (cleanupErr) {
      throw new RestoreInterruptedError(
        "Restore failed partway through, after the existing data had been " +
          "cleared, and the vault could not be reset to a clean state. The vault " +
          "is now in an unknown, partial state — restore again to recover your data.",
        { cause: cleanupErr },
      );
    }
    opts.onProgress?.({ percent: 0, phase: "Restore failed — vault is empty" });
    throw new RestoreInterruptedError(
      "Restore failed partway through, after the existing data had been cleared, " +
        "so the vault is only partially restored. It has been reset to empty — " +
        "restore again to recover your data.",
      { cause: err },
    );
  }

  if (!manifest) throw new Error("Invalid backup: missing manifest");

  // Restore succeeded. Reclaim any OLD-vault attachment files the new vault does
  // not reference (clearVault wiped only the DB; the write phase only overwrote
  // colliding paths). Best-effort — never affects the restored data, and a
  // failure here must not turn a successful restore into a failure.
  await sweepOrphanedOldFiles();

  opts.onProgress?.({ percent: 100, phase: "Restore complete" });
  return { manifest, counts };
}

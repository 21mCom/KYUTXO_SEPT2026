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
  getBackupKdfIterations,
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
import { rearmSearchVisibilityRepair } from "@/lib/vault";
import { clearAuditSession } from "@/lib/data/privacy-audit-session-store";
import {
  bulkCreateRecords,
  bulkDeleteRecords,
  bulkSetDiscoveredFromRecordId,
  clearAllRecords,
  getRecordsByInputStrings,
  type CreateRecordData,
} from "@/lib/data/record-crud";
import {
  bulkAddAttachments,
  bulkDeleteAttachments,
  clearAttachments,
  getAllAttachments,
  type CreateAttachmentData,
} from "@/lib/data/attachments-crud";
import {
  bulkAddParticipants,
  bulkPutParticipants,
  bulkAddTransactions,
  bulkDeleteParticipants,
  bulkDeleteTransactions,
  clearParticipants,
  clearTransactions,
  getTransactionsByTxids,
  getParticipantsByTxids,
  updateTransaction,
  type CreateTransactionData,
} from "@/lib/data/transaction-crud";
import {
  bulkAddAddressSyncState,
  bulkDeleteAddressSyncState,
  clearAddressSyncState,
  getAllAddressSyncState,
  type CreateAddressSyncStateData,
} from "@/lib/data/address-sync-crud";
import {
  bulkAddUtxoLineage,
  bulkAddCustodySegments,
  bulkAddLineageSnapshots,
  bulkDeleteUtxoLineage,
  bulkDeleteCustodySegments,
  bulkDeleteLineageSnapshots,
  clearUtxoLineage,
  clearCustodySegments,
  clearLineageSnapshots,
  getAllUtxoLineage,
  getExistingSegmentIds,
  getExistingSnapshotIds,
} from "@/lib/data/lineage-crud";
import {
  bulkAddRecordOrigins,
  bulkDeleteRecordOrigins,
  getRecordOriginsByRecordIds,
  type CreateRecordOriginData,
} from "@/lib/data/record-origins-crud";
import type {
  TransactionParticipant,
  UtxoLineage,
  CustodySegment,
  LineageSnapshot,
} from "@/lib/database";
import {
  clearInlineTables,
  restoreInlineTables,
  type InlineRestoreResult,
} from "./inline-tables";
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
  // Should return the FINAL filename actually written (the folder de-dupes
  // colliding names), so a cancelled merge can undo exactly that file via
  // deleteReview(); `void` is tolerated (no undo possible, e.g. web no-op).
  writeReview?(originalFilename: string, data: ArrayBuffer): Promise<string | void>;
  // Optional: delete a file previously written by writeReview(), identified by
  // the exact filename writeReview() returned. Used only by the merge-cancel
  // undo pass; best-effort.
  deleteReview?(name: string): Promise<void>;
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
  // Should return the InlineRestoreResult from restoreInlineTables (ids of any
  // lineage rows inserted from inline compatibility data, so a merge cancel
  // can undo them); `void` is tolerated for older test doubles.
  restoreInline?: (
    data: Record<string, unknown>,
    restoreMode: RestoreMode,
  ) => Promise<InlineRestoreResult | void>;
  onProgress?: (p: RestoreProgress) => void;
  signal?: AbortSignal;
  // Test hook: override the per-attachment-file byte cap (defaults to
  // MAX_ATTACHMENT_FILE_BYTES) so tests can exercise the streaming bound
  // without crafting 100 MiB archive entries.
  maxAttachmentFileBytes?: number;
}

export interface RestoreResult {
  manifest: BackupManifest;
  counts: {
    records: number;
    attachments: number;
    transactionParticipants: number;
    addressSyncState: number;
    blockchainTransactions: number;
    // Record-origin (source history) rows re-linked to their restored records.
    recordOrigins: number;
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
    // Discovered-record shells CREATED locally while restoring a compact
    // backup (manifest.compact): participant rows whose record was pruned at
    // export get a minimal blockchain-discovered address record rebuilt for
    // their address, so no recordId dangles. Always 0 for full backups.
    rebuiltDiscoveredShells: number;
  };
}

export const MAX_ATTACHMENT_FILE_BYTES = 100 * 1024 * 1024; // 100 MiB
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

  // ---------------------------------------------------------------------------
  // MERGE-CANCEL UNDO — approach decision (task: cleanly recover after
  // cancelling a merge halfway through).
  //
  // Chosen approach: an IN-MEMORY restore-session undo log. While a merge
  // streams, every row it INSERTS is recorded by primary key (the bulkAdd*
  // helpers return the new ids), and every live row it ENRICHES records the
  // prior values of exactly the fields it changed. If the user cancels, the
  // undo pass deletes precisely those rows and reverts precisely those fields,
  // returning the streamed tables to their pre-merge state.
  //
  // Alternatives considered and rejected:
  //   - Tagging merged rows with a restore session id in the DB: requires a
  //     Dexie schema bump across all eight streamed tables (plus an engine
  //     schema bump — see the engine-mirror rules), leaks restore bookkeeping
  //     into every row forever, and still needs a separate mechanism for
  //     enrichment (which modifies EXISTING rows and so can't be found by tag).
  //   - Snapshot-diff (snapshot the vault before the merge, diff after cancel):
  //     unaffordable at scale — vaults can hold millions of rows and the whole
  //     point of the streaming restore is never materialising them.
  //
  // The log lives only for the duration of this restore call, which is exactly
  // the window in which a cancel can happen; it costs one id per inserted row.
  // Scope: the undo covers every DATA table a merge can insert into — the
  // STREAMED tables (records, attachments, transactions, participants,
  // addressSyncState, lineage tables), the attachment FILES this merge wrote,
  // AND lineage/segments/snapshots restored from INLINE compatibility data in
  // older v3 backups (restoreInlineTables returns their inserted ids, which
  // join this log). Inline METADATA merged from the manifest (vocabulary
  // names, custom fields, templates, evidence, prices, dust flags, saved
  // PSBTs) is rolled back too: restoreInlineTables tracks what it inserted
  // and returns an `undoInlineMetadata` closure that this log carries, so a
  // cancel removes even those tiny rows. Portable preferences remain
  // separately restored by the UI's pre-restore snapshot (undoInlinePrefs) —
  // they merge INTO existing singleton rows rather than inserting new ones.
  // If the undo pass itself fails partway, the cancel error reports
  // mergeUndoFailed and the old contract holds: re-running the merge is safe
  // because every table de-dupes by natural key.
  // ---------------------------------------------------------------------------
  const mergeUndoLog = isMerge
    ? {
        recordIds: [] as number[],
        attachmentIds: [] as number[],
        participantIds: [] as number[],
        transactionIds: [] as number[],
        syncStateIds: [] as number[],
        originIds: [] as number[],
        lineageIds: [] as number[],
        segmentIds: [] as number[],
        snapshotIds: [] as number[],
        // Prior values of the exact fields updateTransaction() enriched, so a
        // cancel restores the live transaction to its pre-merge shape.
        txEnrichPriors: [] as Array<{ id: number; prior: Partial<CreateTransactionData> }>,
        // Original live participant rows captured BEFORE their first
        // enrichment this merge (full-row put restores them verbatim).
        participantPriorById: new Map<number, TransactionParticipant>(),
        // objectStoragePaths of attachment ROWS this merge inserted. Only the
        // files backing these rows are deleted on undo — a written file whose
        // row was de-duped collided with pre-existing content (sha-derived
        // path) and must be kept, since a live row still references it.
        insertedAttachmentPaths: new Set<string>(),
        // Exact filenames writeReview() reported writing to the Needs Review
        // folder during THIS merge, so a cancel removes those bytes too.
        reviewFilesWritten: [] as string[],
        // Undo closure from restoreInlineTables: removes the inline METADATA
        // rows (vocabulary, custom fields, templates, evidence, prices, dust
        // flags, saved PSBTs) this merge inserted from the manifest.
        inlineMetadataUndo: null as (() => Promise<number>) | null,
      }
    : null;

  // Removes everything the (cancelled) merge added: inserted rows by id,
  // enrichment reverts, and attachment files whose rows this merge created.
  // Returns the number of inserted rows removed.
  async function undoMergeAdditions(): Promise<number> {
    const log = mergeUndoLog!;
    // Dependent rows first, records last, enrich-reverts anywhere after their
    // tables' deletes (they touch rows that pre-existed the merge).
    await bulkDeleteAttachments(log.attachmentIds, { skipNotification: true });
    await bulkDeleteParticipants(log.participantIds, { skipNotification: true });
    await bulkDeleteAddressSyncState(log.syncStateIds, { skipNotification: true });
    await bulkDeleteRecordOrigins(log.originIds, { skipNotification: true });
    await bulkDeleteUtxoLineage(log.lineageIds, { skipNotification: true });
    await bulkDeleteCustodySegments(log.segmentIds, { skipNotification: true });
    await bulkDeleteLineageSnapshots(log.snapshotIds, { skipNotification: true });
    await bulkDeleteTransactions(log.transactionIds, { skipNotification: true });
    for (const { id, prior } of log.txEnrichPriors) {
      await updateTransaction(id, prior, { skipNotification: true });
    }
    if (log.participantPriorById.size > 0) {
      await bulkPutParticipants(Array.from(log.participantPriorById.values()), {
        skipNotification: true,
      });
    }
    await bulkDeleteRecords(log.recordIds, { skipNotification: true });
    // Inline METADATA the merge added from the manifest (vocabulary names,
    // custom fields, templates, evidence, prices, dust flags, saved PSBTs) —
    // removed AFTER the records that might reference the vocabulary names, so
    // no live row is left pointing at a just-deleted name mid-undo.
    const inlineMetadataRemoved = log.inlineMetadataUndo
      ? await log.inlineMetadataUndo()
      : 0;
    // Attachment files: sweep only files backing rows THIS merge inserted.
    const del = opts.attachmentWriter.delete;
    if (del) {
      for (const relPath of writtenFiles) {
        if (!log.insertedAttachmentPaths.has(relPath)) continue;
        try {
          await del.call(opts.attachmentWriter, relPath);
        } catch {
          // best-effort — an undeleted file stays discoverable by the audit
        }
      }
    }
    // Needs Review files this merge created for orphaned attachments: remove
    // them too, using the exact filenames writeReview() reported.
    const delReview = opts.attachmentWriter.deleteReview;
    if (delReview) {
      for (const name of log.reviewFilesWritten) {
        try {
          await delReview.call(opts.attachmentWriter, name);
        } catch {
          // best-effort — the file stays visible in the Needs Review folder
        }
      }
    }
    return (
      log.recordIds.length +
      log.attachmentIds.length +
      log.participantIds.length +
      log.transactionIds.length +
      log.syncStateIds.length +
      log.originIds.length +
      log.lineageIds.length +
      log.segmentIds.length +
      log.snapshotIds.length +
      inlineMetadataRemoved
    );
  }

  // Raw recordOrigins rows from the backup's inline data (source history that
  // drives the Conflict Resolution page). Their `recordId` foreign keys
  // reference BACKUP record ids, so they can only be inserted after the
  // records stream has built the old→new id map — see
  // restorePendingRecordOrigins(), called once the ZIP stream completes.
  let pendingRecordOrigins: any[] = [];

  // Discovery-tree pointer fixup: `discoveredFromRecordId` on a backup record
  // references a BACKUP record id, which may be a forward reference (the id
  // map is only complete once the records stream — and, for compact backups,
  // the shell rebuild — has finished). The field is therefore STRIPPED from
  // every inserted row, and each stripped pointer is queued here as
  // (new live id → old backup id). After the ZIP stream completes,
  // remapDiscoveryPointers() re-points every link whose target exists in the
  // id map; a pointer whose target is absent from the backup stays cleared,
  // so a restore can never leave a pointer dangling or aimed at an unrelated
  // record that happens to reuse the old auto-increment id.
  const pendingDiscoveryLinks: Array<{ newId: number; oldTargetId: number }> = [];

  let manifest: BackupManifest | null = null;
  // Set synchronously when the manifest entry's header is reached. onEntry is
  // fflate's sync header callback, whereas `manifest` is only assigned later in
  // the async consumer chain — so ordering checks must use this flag, not
  // `manifest`, which lags behind by one (or more) entry headers.
  let manifestSeen = false;
  let key: CryptoKey | null = null;
  const idMap = new Map<number, number>();
  // Compact-backup shell rebuild (manifest.compact === true): a compact export
  // prunes bare blockchain-discovered records but keeps every participant row
  // of the transactions that survive, still carrying the pruned record's old
  // id. This maps each such ADDRESS to the record id that stands in for it —
  // a reused live/restored record when one exists, else a shell created here.
  let compactRestore = false;
  const shellIdByAddress = new Map<string, number>();
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
    recordOrigins: 0,
    utxoLineage: 0,
    custodySegments: 0,
    lineageSnapshots: 0,
    attachmentFiles: 0,
    orphanedAttachmentFiles: 0,
    orphanedAttachmentFilesLost: 0,
    rebuiltDiscoveredShells: 0,
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

  // COMPACT BACKUP SHELL REBUILD — rebuilds a minimal blockchain-discovered
  // address record for every participant row whose backup recordId is absent
  // from the id map (its record was pruned by the compact export). A
  // post-restore sync can NOT re-create those records (syncAddress skips
  // already-synced heights and already-known txids, and counterparty discovery
  // only runs for newly imported transactions), so they must be rebuilt
  // locally from the kept rows. Resolution order per address: a record already
  // resolved earlier in this restore, then an existing record with the same
  // inputString (live rows in merge mode; just-restored rows in replace mode —
  // records stream before participants), then a freshly created shell. Created
  // shells join the merge undo log so cancelling a merge removes them.
  async function rebuildDiscoveredShells(rows: any[]): Promise<void> {
    // address → backup record ids awaiting a mapping; the first txid seen per
    // address is kept as discovery provenance for a created shell.
    const pendingOldIds = new Map<string, Set<number>>();
    const firstTxidByAddress = new Map<string, string>();
    for (const p of rows) {
      const oldId = p?.recordId;
      if (typeof oldId !== "number" || idMap.has(oldId)) continue;
      const address = typeof p?.address === "string" ? p.address : "";
      if (!address) continue; // nothing to rebuild from — row stays unlinked
      const known = shellIdByAddress.get(address);
      if (known !== undefined) {
        idMap.set(oldId, known);
        continue;
      }
      let set = pendingOldIds.get(address);
      if (!set) {
        set = new Set<number>();
        pendingOldIds.set(address, set);
      }
      set.add(oldId);
      if (!firstTxidByAddress.has(address) && typeof p?.txid === "string" && p.txid !== "") {
        firstTxidByAddress.set(address, p.txid);
      }
    }
    if (pendingOldIds.size === 0) return;

    const resolve = (address: string, id: number) => {
      shellIdByAddress.set(address, id);
      for (const oldId of pendingOldIds.get(address) ?? []) idMap.set(oldId, id);
      pendingOldIds.delete(address);
    };

    // Reuse identities this restore already knows (merge de-dup map) ...
    for (const address of Array.from(pendingOldIds.keys())) {
      const mapped = mergedRecordIdByInputString.get(address);
      if (mapped !== undefined) resolve(address, mapped);
    }
    // ... then address records already in the DB.
    if (pendingOldIds.size > 0) {
      const found = await getRecordsByInputStrings(Array.from(pendingOldIds.keys()));
      for (const r of found) {
        if (r.type !== "address" || typeof r.id !== "number") continue;
        if (!pendingOldIds.has(r.inputString)) continue;
        resolve(r.inputString, r.id);
      }
    }
    if (pendingOldIds.size === 0) return;

    // Create fresh shells for the rest — the same minimal shape sync's own
    // discovery creates (see findOrCreateAddressRecord), so they behave
    // exactly like locally discovered rows. maxSyncedDepth -1 = never synced,
    // so "Sync Deeper" naturally rebuilds their history on the next run.
    const addresses = Array.from(pendingOldIds.keys());
    const payload: CreateRecordData[] = addresses.map(
      (address) =>
        ({
          type: "address",
          inputString: address,
          label: "",
          tags: [],
          categories: [],
          owner: "Pending Review",
          source: "blockchain-sync",
          syncDepth: 1,
          maxSyncedDepth: -1,
          discoveredInTxid: firstTxidByAddress.get(address),
          addressImportance: "blockchain-discovered",
        }) as CreateRecordData,
    );
    const newIds = await bulkCreateRecords(payload, {
      skipNotification: true,
      skipVocabularySync: true,
    });
    if (mergeUndoLog) mergeUndoLog.recordIds.push(...newIds);
    for (let i = 0; i < addresses.length; i++) {
      const address = addresses[i];
      resolve(address, newIds[i]);
      if (isMerge && !mergedRecordIdByInputString.has(address)) {
        mergedRecordIdByInputString.set(address, newIds[i]);
      }
    }
    counts.rebuiltDiscoveredShells += addresses.length;
  }

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
      // Strip `discoveredFromRecordId` before insert — it holds a BACKUP id
      // that can only be remapped once the id map is complete (see
      // pendingDiscoveryLinks / remapDiscoveryPointers).
      const oldDiscoveryTargets = toCreate.map((r) =>
        typeof r.discoveredFromRecordId === "number" ? r.discoveredFromRecordId : undefined,
      );
      const payload: CreateRecordData[] = toCreate.map(
        ({ id, discoveredFromRecordId, ...rest }) => rest as CreateRecordData,
      );
      const newIds = await bulkCreateRecords(payload, {
        skipNotification: true,
        skipVocabularySync: true,
      });
      if (mergeUndoLog) mergeUndoLog.recordIds.push(...newIds);
      for (let i = 0; i < newIds.length; i++) {
        const o = oldIds[i];
        if (typeof o === "number") idMap.set(o, newIds[i]);
        const target = oldDiscoveryTargets[i];
        if (typeof target === "number") {
          pendingDiscoveryLinks.push({ newId: newIds[i], oldTargetId: target });
        }
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
      if (out.length) {
        const newIds = await bulkAddAttachments(out, { skipNotification: true });
        if (mergeUndoLog) {
          mergeUndoLog.attachmentIds.push(...newIds);
          for (const a of out) {
            if (a.objectStoragePath) {
              mergeUndoLog.insertedAttachmentPaths.add(String(a.objectStoragePath));
            }
          }
        }
      }
      counts.attachments += out.length;
    } else if (table === "transactionParticipants") {
      // Compact backups: resolve pruned recordIds to reused records or locally
      // rebuilt shells BEFORE any remap below (both the merge enrichment path
      // and the insert path call remap), so no participant is left dangling.
      if (compactRestore) {
        await rebuildDiscoveredShells(rows);
      }
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
              // Capture the ORIGINAL live row before its first enrichment this
              // merge, so a cancel can put it back verbatim.
              if (mergeUndoLog && !mergeUndoLog.participantPriorById.has(liveMatch.id)) {
                mergeUndoLog.participantPriorById.set(liveMatch.id, { ...liveMatch });
              }
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
        const newIds = await bulkAddParticipants(out as TransactionParticipant[], {
          skipNotification: true,
        });
        if (mergeUndoLog) mergeUndoLog.participantIds.push(...newIds);
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
        const newIds = await bulkAddAddressSyncState(out as CreateAddressSyncStateData[], {
          skipNotification: true,
        });
        if (mergeUndoLog) mergeUndoLog.syncStateIds.push(...newIds);
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
              if (mergeUndoLog) {
                // Record the live row's prior values for exactly the fields
                // this enrichment writes, so a cancel can revert them.
                const prior: Record<string, unknown> = {};
                for (const k of Object.keys(changes)) {
                  prior[k] = (live as Record<string, unknown>)[k];
                }
                mergeUndoLog.txEnrichPriors.push({
                  id: live.id,
                  prior: prior as Partial<CreateTransactionData>,
                });
              }
              await updateTransaction(live.id, changes, { skipNotification: true });
            }
            continue;
          }
          toInsert.push(tx);
        }
      }
      const out = toInsert.map(({ id, ...d }) => d as CreateTransactionData);
      if (out.length) {
        const newIds = await bulkAddTransactions(out, { skipNotification: true });
        if (mergeUndoLog) mergeUndoLog.transactionIds.push(...newIds);
      }
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
      if (out.length) {
        const newIds = await bulkAddUtxoLineage(out, { skipNotification: true });
        if (mergeUndoLog) mergeUndoLog.lineageIds.push(...newIds);
      }
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
      if (out.length) {
        const newIds = await bulkAddCustodySegments(out, { skipNotification: true });
        if (mergeUndoLog) mergeUndoLog.segmentIds.push(...newIds);
      }
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
      if (out.length) {
        const newIds = await bulkAddLineageSnapshots(out, { skipNotification: true });
        if (mergeUndoLog) mergeUndoLog.snapshotIds.push(...newIds);
      }
      counts.lineageSnapshots += out.length;
    }
    processed += rows.length;
    report(`Restoring ${table}...`);
  }

  // Insert the backup's recordOrigins rows (source history driving the
  // Conflict Resolution page) once the whole ZIP stream has been processed, so
  // the records old→new id map is complete. Rows whose owning record is absent
  // (orphaned/skipped) are dropped — an origin without its record is
  // meaningless. In merge mode rows are de-duped by their natural key
  // (live recordId + originType + source + createdAt), covering both origins
  // already live on the record AND duplicates within the incoming backup, so
  // re-merging the identical backup is idempotent.
  async function restorePendingRecordOrigins(): Promise<void> {
    if (pendingRecordOrigins.length === 0) return;
    throwIfAborted();
    const remapped: CreateRecordOriginData[] = [];
    for (const o of pendingRecordOrigins) {
      if (!o || typeof o !== "object") continue;
      const { id, ...d } = o as Record<string, unknown>;
      const recordId = remap(idMap, d.recordId);
      if (recordId === undefined) continue;
      remapped.push({ ...d, recordId } as CreateRecordOriginData);
    }
    if (remapped.length === 0) return;

    let toInsert = remapped;
    if (isMerge) {
      const originKey = (o: {
        recordId: number;
        originType?: unknown;
        source?: unknown;
        createdAt?: unknown;
      }): string =>
        [o.recordId, o.originType ?? "", o.source ?? "", o.createdAt ?? ""].join("|");
      const affectedRecordIds = Array.from(new Set(remapped.map((o) => o.recordId)));
      const seen = new Set<string>();
      for (const live of await getRecordOriginsByRecordIds(affectedRecordIds)) {
        seen.add(originKey(live));
      }
      toInsert = [];
      for (const o of remapped) {
        const k = originKey(o);
        if (seen.has(k)) continue;
        seen.add(k);
        toInsert.push(o);
      }
    }
    if (toInsert.length > 0) {
      const newIds = await bulkAddRecordOrigins(toInsert, { skipNotification: true });
      if (mergeUndoLog) mergeUndoLog.originIds.push(...newIds);
      counts.recordOrigins += toInsert.length;
    }
  }

  // Re-points discoveredFromRecordId on the just-inserted records, now that
  // the old→new id map is complete (records stream + compact shell rebuild).
  // Pointers whose backup target is absent from the map stay CLEARED — the
  // field was stripped at insert, so no dangling/colliding pointer can ever
  // reach the vault. Only rows this restore inserted are touched, so a live
  // record's pointer is never rewritten in merge mode, and merge-cancel undo
  // (which deletes those rows) needs no extra bookkeeping.
  async function remapDiscoveryPointers(): Promise<void> {
    const BATCH = 500;
    let batch: Array<{ id: number; discoveredFromRecordId: number }> = [];
    for (const link of pendingDiscoveryLinks) {
      throwIfAborted();
      const mapped = idMap.get(link.oldTargetId);
      if (mapped === undefined || mapped === link.newId) continue; // absent → stays cleared
      batch.push({ id: link.newId, discoveredFromRecordId: mapped });
      if (batch.length >= BATCH) {
        await bulkSetDiscoveredFromRecordId(batch, { skipNotification: true });
        batch = [];
      }
    }
    if (batch.length > 0) {
      await bulkSetDiscoveredFromRecordId(batch, { skipNotification: true });
    }
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
            compactRestore = manifest.compact === true;

            if (manifest.encrypted) {
              if (!opts.password) throw new Error("Password required for encrypted backup");
              const salt = base64ToBuffer(manifest.salt ?? "");
              // The manifest records the KDF parameters the backup key was
              // derived with; absent = pre-strengthening backup (legacy 100k).
              key = await deriveKey(opts.password, salt, getBackupKdfIterations(manifest));
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
            const inlineResult = await restoreInlineFn(inline, restoreMode);
            // Origins are inserted AFTER the records stream (id remap); older
            // backups without the key (and older test doubles returning void)
            // simply leave this empty.
            if (inlineResult && Array.isArray(inlineResult.pendingRecordOrigins)) {
              pendingRecordOrigins = inlineResult.pendingRecordOrigins;
            }
            // Older v3 backups carry lineage/segments/snapshots INLINE instead
            // of streamed; those inserts are data rows too and must be part of
            // the merge-cancel undo log or cancelling a merge of an old backup
            // would leave them behind.
            if (mergeUndoLog && inlineResult) {
              mergeUndoLog.lineageIds.push(...inlineResult.insertedUtxoLineageIds);
              mergeUndoLog.segmentIds.push(...inlineResult.insertedCustodySegmentIds);
              mergeUndoLog.snapshotIds.push(...inlineResult.insertedLineageSnapshotIds);
              // Inline metadata (vocabulary, custom fields, evidence, ...) the
              // merge added is undone via this closure on cancel.
              mergeUndoLog.inlineMetadataUndo =
                inlineResult.undoInlineMetadata ?? null;
            }
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
          // A crafted archive can carry traversal/absolute entry names that
          // lexically escape the attachments dir. Reject the archive with a
          // clear error instead of writing outside the root (the platform
          // writers would refuse anyway, with a much less actionable error).
          if (!isSafeAttachmentRelPath(relPath)) {
            throw new Error(
              `Unsafe attachment path in backup archive: ${JSON.stringify(name)}`,
            );
          }
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
                const reviewName = await opts.attachmentWriter.writeReview?.(
                  orphanFilename,
                  ab,
                );
                // A cancelled merge must sweep Needs Review files it created;
                // the writer reports the de-duped final filename.
                if (mergeUndoLog && typeof reviewName === "string") {
                  mergeUndoLog.reviewFilesWritten.push(reviewName);
                }
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
          }, { maxBytes: opts.maxAttachmentFileBytes ?? MAX_ATTACHMENT_FILE_BYTES });
        }

        return null; // ignore anything else
      },
    });

    // The records id map is complete now — re-link and insert source-history
    // rows. Runs inside the try so a failure/cancel here follows the same
    // contracts as any other post-clear failure (reset-to-empty in replace
    // mode, undo log in merge mode).
    await restorePendingRecordOrigins();

    // Re-link discovery-tree pointers through the completed id map — same
    // failure/cancel contracts as above.
    await remapDiscoveryPointers();
  } catch (err) {
    const aborted = opts.signal?.aborted ?? false;
    if (err instanceof BackupCancelledError || aborted) {
      if (!cleared) {
        // Cancelled before the destructive clear: the existing vault was never
        // touched, so it is left fully intact.
        const cancelErr =
          err instanceof BackupCancelledError ? err : new BackupCancelledError();
        cancelErr.clearedBeforeCancel = false;
        // Merge mode always lands here (merge never clears). Undo everything
        // this merge already added so a cancel leaves the vault EXACTLY as it
        // was — see the merge undo log above for the approach decision. If the
        // undo itself fails partway, report it honestly on the error: partial
        // additions may remain, but re-running the merge stays safe (every
        // table de-dupes by natural key).
        if (mergeUndoLog) {
          opts.onProgress?.({ percent: 0, phase: "Cancelling — removing merged rows..." });
          try {
            cancelErr.mergeUndoRowsRemoved = await undoMergeAdditions();
            cancelErr.mergeUndone = true;
          } catch (undoErr) {
            console.warn("Merge-cancel undo failed:", undoErr);
            cancelErr.mergeUndone = false;
            cancelErr.mergeUndoFailed = true;
          }
        }
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

  // Re-arm the once-per-vault startup search-visibility repair: restored rows
  // (both replace and merge) can carry legacy/unknown importance tiers or
  // stale inputStringLower search keys verbatim from old backups, so the next
  // login must re-scan and repair. Best-effort — a failure to update the flag
  // must never turn a successful restore into a failure (the Database Doctor
  // repair buttons remain the manual fallback).
  try {
    await rearmSearchVisibilityRepair();
  } catch {}

  opts.onProgress?.({ percent: 100, phase: "Restore complete" });
  return { manifest, counts };
}

export function isSafeAttachmentRelPath(relPath: unknown): relPath is string {
  if (typeof relPath !== "string" || relPath.length === 0) return false;
  if (relPath.includes("\0")) return false;
  if (relPath.startsWith("/") || relPath.startsWith("\\")) return false;
  if (/^[a-zA-Z]:[\\/]/.test(relPath)) return false; // Windows drive absolute
  const segments = relPath.split(/[\\/]+/);
  if (segments.some((s) => s === "..")) return false;
  return true;
}

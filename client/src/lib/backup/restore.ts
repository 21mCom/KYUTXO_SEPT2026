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
import {
  bulkCreateRecords,
  clearAllRecords,
  type CreateRecordData,
} from "@/lib/data/record-crud";
import {
  bulkAddAttachments,
  clearAttachments,
  type CreateAttachmentData,
} from "@/lib/data/attachments-crud";
import {
  bulkAddParticipants,
  bulkAddTransactions,
  clearParticipants,
  clearTransactions,
  type CreateTransactionData,
} from "@/lib/data/transaction-crud";
import {
  bulkAddAddressSyncState,
  clearAddressSyncState,
  type CreateAddressSyncStateData,
} from "@/lib/data/address-sync-crud";
import {
  bulkAddUtxoLineage,
  bulkAddCustodySegments,
  clearUtxoLineage,
  clearCustodySegments,
} from "@/lib/data/lineage-crud";
import type {
  TransactionParticipant,
  UtxoLineage,
  CustodySegment,
} from "@/lib/database";
import { clearInlineTables, restoreInlineTables } from "./inline-tables";

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
  constructor(relPath: string, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "AttachmentWriteError";
    this.relPath = relPath;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export interface AttachmentFileWriter {
  write(relPath: string, data: ArrayBuffer): Promise<void>;
  // Optional: remove a previously-written attachment file. Used only to sweep
  // files this restore wrote when the restore fails (or is cancelled) AFTER the
  // destructive clear. clearVault only resets DB/inline tables, so without this
  // sweep the files written before the failure would be stranded on disk as
  // orphans. Best-effort: a failure to delete must not mask the primary error.
  delete?(relPath: string): Promise<void>;
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
  clearInline?: () => Promise<void>;
  restoreInline?: (data: Record<string, unknown>) => Promise<void>;
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
    attachmentFiles: number;
    // Number of attachment files whose owning record was absent and were
    // routed to the Needs Review folder (never linked to any DB row).
    orphanedAttachmentFiles: number;
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
  const clearInlineFn = opts.clearInline ?? clearInlineTables;
  const restoreInlineFn = opts.restoreInline ?? restoreInlineTables;

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
    attachmentFiles: 0,
    orphanedAttachmentFiles: 0,
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
    await clearInlineFn();
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

  const total = () =>
    manifest
      ? (manifest.counts.records +
          manifest.counts.attachments +
          manifest.counts.transactionParticipants +
          manifest.counts.addressSyncState +
          manifest.counts.blockchainTransactions +
          (manifest.counts.utxoLineage ?? 0) +
          (manifest.counts.custodySegments ?? 0) +
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
      const oldIds = rows.map((r) => r.id);
      const payload: CreateRecordData[] = rows.map(({ id, ...rest }) => rest as CreateRecordData);
      const newIds = await bulkCreateRecords(payload, {
        skipNotification: true,
        skipVocabularySync: true,
      });
      for (let i = 0; i < newIds.length; i++) {
        const o = oldIds[i];
        if (typeof o === "number") idMap.set(o, newIds[i]);
      }
      counts.records += newIds.length;
    } else if (table === "attachments") {
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
        out.push({ ...d, recordId } as CreateAttachmentData);
      }
      if (out.length) await bulkAddAttachments(out, { skipNotification: true });
      counts.attachments += out.length;
    } else if (table === "transactionParticipants") {
      const out = rows.map(({ id, ...d }) => ({
        ...d,
        recordId: remap(idMap, d.recordId),
      }));
      if (out.length) {
        await bulkAddParticipants(out as TransactionParticipant[], { skipNotification: true });
      }
      counts.transactionParticipants += out.length;
    } else if (table === "addressSyncState") {
      const out = rows.map(({ id, ...d }) => ({
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
      const out = rows.map(({ id, ...d }) => d as CreateTransactionData);
      if (out.length) await bulkAddTransactions(out, { skipNotification: true });
      counts.blockchainTransactions += out.length;
    } else if (table === "utxoLineage") {
      // No recordId: rows relink by txid/vout, so insert as-is (drop old id).
      const out = rows.map(({ id, ...d }) => d as UtxoLineage);
      if (out.length) await bulkAddUtxoLineage(out, { skipNotification: true });
      counts.utxoLineage += out.length;
    } else if (table === "custodySegments") {
      // No recordId: rows relink by segmentId/txid, so insert as-is (drop old id).
      const out = rows.map(({ id, ...d }) => d as CustodySegment);
      if (out.length) await bulkAddCustodySegments(out, { skipNotification: true });
      counts.custodySegments += out.length;
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
            opts.onProgress?.({ percent: 8, phase: "Clearing existing data..." });
            await clearVault();
            cleared = true;

            opts.onProgress?.({ percent: 9, phase: "Restoring metadata..." });
            const inline = await parseInline(manifest, key);
            await restoreInlineFn(inline);
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
              // — the orphan is still counted for the UI notification.
              try {
                await opts.attachmentWriter.writeReview?.(orphanFilename, ab);
              } catch {
                // intentionally swallowed — best-effort routing
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
                { cause: writeErr },
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
  opts.onProgress?.({ percent: 100, phase: "Restore complete" });
  return { manifest, counts };
}

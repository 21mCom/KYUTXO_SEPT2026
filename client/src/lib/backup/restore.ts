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
import type { TransactionParticipant } from "@/lib/database";
import { clearInlineTables, restoreInlineTables } from "./inline-tables";

export interface AttachmentFileWriter {
  write(relPath: string, data: ArrayBuffer): Promise<void>;
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
  restoreInline?: (data: Record<string, unknown[]>) => Promise<void>;
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
    attachmentFiles: number;
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
  let key: CryptoKey | null = null;
  const idMap = new Map<number, number>();
  const counts = {
    records: 0,
    attachments: 0,
    transactionParticipants: 0,
    addressSyncState: 0,
    blockchainTransactions: 0,
    attachmentFiles: 0,
  };

  const throwIfAborted = () => {
    if (opts.signal?.aborted) throw new BackupCancelledError();
  };

  const total = () =>
    manifest
      ? (manifest.counts.records +
          manifest.counts.attachments +
          manifest.counts.transactionParticipants +
          manifest.counts.addressSyncState +
          manifest.counts.blockchainTransactions +
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
        if (recordId === undefined) continue; // orphan: owning record absent
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
    }
    processed += rows.length;
    report(`Restoring ${table}...`);
  }

  await readZipStream(opts.source, {
    onEntry(name) {
      if (name === MANIFEST_FILENAME) {
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

          opts.onProgress?.({ percent: 8, phase: "Clearing existing data..." });
          await clearAllRecords({ skipNotification: true });
          await clearAttachments({ skipNotification: true });
          await clearParticipants({ skipNotification: true });
          await clearTransactions({ skipNotification: true });
          await clearAddressSyncState({ skipNotification: true });
          await clearInlineFn();

          opts.onProgress?.({ percent: 9, phase: "Restoring metadata..." });
          const inline = await parseInline(manifest, key);
          await restoreInlineFn(inline);
        });
      }

      // Every non-manifest entry is data. The manifest handler is what verifies
      // the password, clears existing data, and derives the decryption key — and
      // because readZipStream serializes entries, it has already run by now for a
      // well-formed archive. Reject any archive that front-loads data before the
      // manifest rather than writing rows into a not-yet-cleared vault.
      if (!manifest) {
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
          await opts.attachmentWriter.write(relPath, ab);
          counts.attachmentFiles += 1;
          processed += 1;
          report("Restoring attachment files...");
        });
      }

      return null; // ignore anything else
    },
  });

  if (!manifest) throw new Error("Invalid backup: missing manifest");
  opts.onProgress?.({ percent: 100, phase: "Restore complete" });
  return { manifest, counts };
}

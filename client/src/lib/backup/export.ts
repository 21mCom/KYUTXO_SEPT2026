// Streaming backup export (v3). Walks each of the five large tables with bounded
// id-keyset pages, serializes every page as one NDJSON line, deflates it into a
// ZIP entry, and drains to the sink before the next page — so the whole vault is
// never held in memory. Attachment files are streamed one at a time. The small
// tables ride inline in the manifest, which is written first.
//
// This module is UI-agnostic and fully injectable (sink, attachment IO, inline
// reader, progress, abort) so it can be exercised by the runtime memory test.

import type { BackupSink } from "./sink";
import { BackupCancelledError } from "./sink";
import { ZipStreamWriter } from "./zip-stream";
import {
  BACKUP_FORMAT_VERSION,
  MANIFEST_FILENAME,
  ATTACHMENTS_DIR,
  STREAMED_TABLES,
  CHECK_SENTINEL,
  ndjsonPath,
  serializeBatchLine,
  serializeInline,
  type BackupManifest,
  type BackupCounts,
  type StreamedTable,
} from "./format";
import { deriveKey, generateSalt, bufferToBase64, encrypt } from "@/lib/crypto";
import { getRecordsAfterId, countRecords } from "@/lib/data/record-crud";
import { getAttachmentsAfterId, countAttachments, sumAttachmentSizes } from "@/lib/data/attachments-crud";
import {
  getTransactionsAfterId,
  countTransactions,
  getTransactionParticipantsAfterId,
  countTransactionParticipants,
} from "@/lib/data/transaction-crud";
import {
  getAddressSyncStateAfterId,
  countAddressSyncState,
} from "@/lib/data/address-sync-crud";
import {
  getUtxoLineageAfterId,
  getCustodySegmentsAfterId,
  countUtxoLineage,
  countCustodySegments,
} from "@/lib/data/lineage-crud";
import { readInlineTables } from "./inline-tables";

export interface AttachmentFileIO {
  listAll(): Promise<string[]>;
  read(relPath: string): Promise<ArrayBuffer | null>;
  // Optional: the exact total bytes of every attachment FILE on disk — i.e. the
  // bytes that will be stored UNCOMPRESSED in the ZIP. Preferred over the DB
  // metadata sum because it reflects the archive's true attachment footprint,
  // including legacy root-level files that have no `db.attachments` row. Returns
  // null (or is absent) when the IO impl cannot provide it, in which case the
  // export falls back to summing the attachment metadata `size`.
  totalBytes?(): Promise<number | null>;
}

export interface ExportProgress {
  percent: number; // 0..100
  phase: string;
}

export interface ExportOptions {
  sink: BackupSink;
  encrypted: boolean;
  password?: string;
  appVersion?: string;
  batchSize?: number;
  attachmentIO: AttachmentFileIO;
  readInline?: () => Promise<Record<string, unknown[]>>;
  onProgress?: (p: ExportProgress) => void;
  signal?: AbortSignal;
}

// Rough per-row disk allowance for the streamed DB tables in the backup ZIP.
// Those NDJSON tables are deflate-compressed, so this is a conservative upper
// bound on a row's on-disk footprint rather than its raw serialized size.
// Attachment files (stored UNCOMPRESSED in the ZIP) usually dominate the total.
export const EXPORT_BYTES_PER_ROW = 256;

export interface ExportSizeEstimateInput {
  // Total byte size of all attachment files (stored uncompressed in the ZIP).
  attachmentBytes: number;
  // Combined row count of every streamed DB table (records, transactions,
  // participants, sync state, lineage, custody segments).
  rowCount: number;
  // Override the per-row allowance (defaults to EXPORT_BYTES_PER_ROW).
  bytesPerRow?: number;
}

// Estimates the bytes an Electron streaming export will write to disk: the sum
// of attachment file sizes plus a per-row allowance for the compressed NDJSON
// tables. Used for a pre-flight disk-space check so the user can free space
// BEFORE a partial/truncated archive is written, instead of discovering a
// disk-full failure only after the export aborts mid-stream.
export function estimateExportBytes(input: ExportSizeEstimateInput): number {
  const attach = Number.isFinite(input.attachmentBytes)
    ? Math.max(0, input.attachmentBytes)
    : 0;
  const rows = Number.isFinite(input.rowCount) ? Math.max(0, input.rowCount) : 0;
  const perRow = Number.isFinite(input.bytesPerRow ?? NaN)
    ? Math.max(0, input.bytesPerRow as number)
    : EXPORT_BYTES_PER_ROW;
  return Math.ceil(attach + rows * perRow);
}

type Row = { id?: number };
type PageReader = (afterId: number, limit: number) => Promise<Row[]>;

const STREAM_READERS: Record<StreamedTable, PageReader> = {
  records: getRecordsAfterId as unknown as PageReader,
  attachments: getAttachmentsAfterId as unknown as PageReader,
  transactionParticipants: getTransactionParticipantsAfterId as unknown as PageReader,
  addressSyncState: getAddressSyncStateAfterId as unknown as PageReader,
  blockchainTransactions: getTransactionsAfterId as unknown as PageReader,
  utxoLineage: getUtxoLineageAfterId as unknown as PageReader,
  custodySegments: getCustodySegmentsAfterId as unknown as PageReader,
};

const DEFAULT_BATCH = 1000;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BackupCancelledError();
}

export async function exportBackup(opts: ExportOptions): Promise<void> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const readInline = opts.readInline ?? readInlineTables;
  const signal = opts.signal;

  throwIfAborted(signal);

  // Encryption setup (key + salt + password check sentinel).
  let key: CryptoKey | null = null;
  let salt: Uint8Array | null = null;
  let check: string | undefined;
  if (opts.encrypted) {
    if (!opts.password) throw new Error("Password required for encrypted backup");
    salt = generateSalt();
    key = await deriveKey(opts.password, salt);
    check = await encrypt(CHECK_SENTINEL, key);
  }

  // Counts (cheap, indexed) for the manifest + progress denominator.
  const [
    recordsCount,
    attachmentsCount,
    participantsCount,
    addressSyncCount,
    transactionsCount,
    utxoLineageCount,
    custodySegmentsCount,
  ] = await Promise.all([
    countRecords(),
    countAttachments(),
    countTransactionParticipants(),
    countAddressSyncState(),
    countTransactions(),
    countUtxoLineage(),
    countCustodySegments(),
  ]);

  opts.onProgress?.({ percent: 2, phase: "Listing attachment files..." });
  const attachmentPaths = await opts.attachmentIO.listAll();

  // Exact total bytes of the attachment FILES written into the ZIP (stored
  // uncompressed), recorded in the manifest so the restore pre-flight can size
  // disk space precisely rather than inferring it from the compressed backup
  // file. Prefer the IO's on-disk total (which reflects the true archive
  // footprint, including legacy root-level files with no DB row); fall back to
  // summing the attachment metadata `size` when the IO can't report it.
  let totalAttachmentBytes: number;
  const ioTotal = opts.attachmentIO.totalBytes
    ? await opts.attachmentIO.totalBytes()
    : null;
  if (typeof ioTotal === "number" && Number.isFinite(ioTotal) && ioTotal >= 0) {
    totalAttachmentBytes = ioTotal;
  } else {
    totalAttachmentBytes = await sumAttachmentSizes();
  }

  const counts: BackupCounts = {
    records: recordsCount,
    attachments: attachmentsCount,
    transactionParticipants: participantsCount,
    addressSyncState: addressSyncCount,
    blockchainTransactions: transactionsCount,
    utxoLineage: utxoLineageCount,
    custodySegments: custodySegmentsCount,
    attachmentFiles: attachmentPaths.length,
  };

  const totalUnits =
    counts.records +
    counts.attachments +
    counts.transactionParticipants +
    counts.addressSyncState +
    counts.blockchainTransactions +
    counts.utxoLineage +
    counts.custodySegments +
    counts.attachmentFiles || 1;
  let processedUnits = 0;
  const reportUnits = (phase: string) => {
    // Reserve 5% head (counts/inline) and 5% tail (finalize).
    const pct = 5 + Math.min(90, Math.round((processedUnits / totalUnits) * 90));
    opts.onProgress?.({ percent: pct, phase });
  };

  // Inline (small) tables → manifest.
  opts.onProgress?.({ percent: 4, phase: "Gathering metadata..." });
  const inlineData = await readInline();
  const inlineEnvelope = await serializeInline(inlineData, key);

  const manifest: BackupManifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    app: "KYUTXO",
    appVersion: opts.appVersion ?? "3.0.0",
    exportDate: new Date().toISOString(),
    encrypted: opts.encrypted,
    salt: salt ? bufferToBase64(salt) : undefined,
    check,
    counts,
    totalAttachmentBytes,
    streamedTables: [...STREAMED_TABLES],
    ...inlineEnvelope,
  };

  const writer = new ZipStreamWriter(opts.sink);
  try {
    // 1) Manifest first (so restore can read it + clear before any data rows).
    throwIfAborted(signal);
    await writer.addBytes(
      MANIFEST_FILENAME,
      new TextEncoder().encode(JSON.stringify(manifest)),
    );

    // 2) The five big tables as NDJSON (one batch per line).
    for (const table of STREAMED_TABLES) {
      const reader = STREAM_READERS[table];
      const lines = (async function* () {
        let afterId = 0;
        for (;;) {
          throwIfAborted(signal);
          const batch = await reader(afterId, batchSize);
          if (batch.length === 0) break;
          yield await serializeBatchLine(batch, key);
          processedUnits += batch.length;
          reportUnits(`Exporting ${table}...`);
          const last = batch[batch.length - 1];
          if (last.id == null) break;
          afterId = last.id;
        }
      })();
      await writer.addFile(ndjsonPath(table), lines);
    }

    // 3) Attachment files, one at a time (stored, not re-compressed).
    for (let i = 0; i < attachmentPaths.length; i++) {
      throwIfAborted(signal);
      const relPath = attachmentPaths[i];
      const data = await opts.attachmentIO.read(relPath);
      if (data) {
        await writer.addBytes(`${ATTACHMENTS_DIR}/${relPath}`, new Uint8Array(data), {
          compress: false,
        });
      }
      processedUnits += 1;
      reportUnits(`Exporting attachment ${i + 1} of ${attachmentPaths.length}...`);
    }

    throwIfAborted(signal);
    opts.onProgress?.({ percent: 97, phase: "Finalizing archive..." });
    await writer.finalize();
    opts.onProgress?.({ percent: 100, phase: "Export complete" });
  } catch (err) {
    await opts.sink.abort();
    throw err;
  }
}

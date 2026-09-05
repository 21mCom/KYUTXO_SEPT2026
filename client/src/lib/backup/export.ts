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
import {
  deriveKeyWithParams,
  generateSalt,
  bufferToBase64,
  encrypt,
  CURRENT_KDF_PARAMS,
} from "@/lib/crypto";
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
  getLineageSnapshotsAfterId,
  countUtxoLineage,
  countCustodySegments,
  countLineageSnapshots,
} from "@/lib/data/lineage-crud";
import { readInlineTables } from "./inline-tables";
import { compactRowFilters, type CompactPlan, type CompactRowFilters } from "./compact";

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
  // Compact backup: pre-computed drop plan (see compact.ts computeCompactPlan).
  // When present, the stream omits the planned rows, the manifest carries the
  // FILTERED counts (so restore progress/size estimates match the archive), and
  // manifest.compact/compactDropped are set. Callers compute the plan first so
  // memory-safety gates and disk estimates can use the filtered counts too.
  compactPlan?: CompactPlan;
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
  lineageSnapshots: getLineageSnapshotsAfterId as unknown as PageReader,
};

const DEFAULT_BATCH = 1000;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BackupCancelledError();
}

// Applies the compact plan's per-table drop/scrub rules to one raw page.
// Tables without a rule (attachments, lineageSnapshots) pass through untouched.
function applyCompactFilters(
  table: StreamedTable,
  batch: Row[],
  filters: CompactRowFilters,
): Row[] {
  switch (table) {
    case "records":
      return (batch as Parameters<CompactRowFilters["dropRecord"]>[0][])
        .filter((r) => !filters.dropRecord(r))
        .map((r) => filters.scrubRecord(r));
    case "transactionParticipants":
      return (batch as Parameters<CompactRowFilters["dropParticipant"]>[0][]).filter(
        (r) => !filters.dropParticipant(r),
      );
    case "blockchainTransactions":
      return (batch as Parameters<CompactRowFilters["dropTransaction"]>[0][]).filter(
        (r) => !filters.dropTransaction(r),
      );
    case "addressSyncState":
      return (batch as Parameters<CompactRowFilters["dropSyncState"]>[0][]).filter(
        (r) => !filters.dropSyncState(r),
      );
    case "utxoLineage":
      return (batch as Parameters<CompactRowFilters["dropLineage"]>[0][]).filter(
        (r) => !filters.dropLineage(r),
      );
    case "custodySegments":
      return (batch as Parameters<CompactRowFilters["dropSegment"]>[0][]).filter(
        (r) => !filters.dropSegment(r),
      );
    default:
      return batch;
  }
}

// Normalized model rows ride in the small inline manifest tables.  Compact
// exports must apply the same retained-record/transaction boundary as the
// streamed tables, then retain only the parent rows those annotations use.
function compactInlineRecordModel(
  inline: Record<string, unknown[]>,
  plan: CompactPlan,
): Record<string, unknown[]> {
  const rows = (name: string): any[] => Array.isArray(inline[name]) ? inline[name] as any[] : [];
  const ownership = rows("addressOwnership")
    .filter(row => typeof row.recordId === "number" && !plan.droppedRecordIds.has(row.recordId))
    .map(row => ({ ...row }));
  const metadata = rows("transactionMetadata")
    .filter(row => typeof row.txid === "string" && !plan.droppedTxids.has(row.txid));
  const legs = rows("transactionLegMetadata")
    .filter(row => typeof row.txid === "string" && !plan.droppedTxids.has(row.txid))
    .map(row => ({ ...row }));
  const walletIds = new Set<number>();
  const entityIds = new Set<number>();
  for (const row of [...ownership, ...legs, ...metadata]) {
    if (typeof row.walletId === "number") walletIds.add(row.walletId);
    if (typeof row.entityId === "number") entityIds.add(row.entityId);
    if (typeof row.counterpartyEntityId === "number") entityIds.add(row.counterpartyEntityId);
  }
  const wallets = rows("wallets").filter(row => typeof row.id === "number" && walletIds.has(row.id));
  for (const wallet of wallets) if (typeof wallet.entityId === "number") entityIds.add(wallet.entityId);
  const entities = rows("entities").filter(row => typeof row.id === "number" && entityIds.has(row.id));
  const keptEntityIds = new Set(entities.map(row => row.id));
  const keptWalletIds = new Set(wallets.map(row => row.id));
  for (const row of [...ownership, ...legs]) {
    if (typeof row.entityId === "number" && !keptEntityIds.has(row.entityId)) delete row.entityId;
    if (typeof row.walletId === "number" && !keptWalletIds.has(row.walletId)) delete row.walletId;
  }
  for (const row of [...ownership, ...metadata]) {
    if (typeof row.counterpartyEntityId === "number" && !keptEntityIds.has(row.counterpartyEntityId)) {
      delete row.counterpartyEntityId;
    }
  }
  return { ...inline, entities, wallets, addressOwnership: ownership, transactionMetadata: metadata, transactionLegMetadata: legs };
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
    key = await deriveKeyWithParams(opts.password, salt, CURRENT_KDF_PARAMS);
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
    lineageSnapshotsCount,
  ] = await Promise.all([
    countRecords(),
    countAttachments(),
    countTransactionParticipants(),
    countAddressSyncState(),
    countTransactions(),
    countUtxoLineage(),
    countCustodySegments(),
    countLineageSnapshots(),
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

  // Manifest counts: with a compact plan, the six filtered tables use the
  // plan's exact post-filter counts (computed by the same predicates the
  // stream below applies) so restore progress, the memory-export OOM guard,
  // and disk estimates all describe the rows actually in the archive.
  // Attachments and lineage snapshots are never filtered.
  const plan = opts.compactPlan;
  const counts: BackupCounts = {
    records: plan ? plan.counts.records : recordsCount,
    attachments: attachmentsCount,
    transactionParticipants: plan
      ? plan.counts.transactionParticipants
      : participantsCount,
    addressSyncState: plan ? plan.counts.addressSyncState : addressSyncCount,
    blockchainTransactions: plan
      ? plan.counts.blockchainTransactions
      : transactionsCount,
    utxoLineage: plan ? plan.counts.utxoLineage : utxoLineageCount,
    custodySegments: plan ? plan.counts.custodySegments : custodySegmentsCount,
    lineageSnapshots: lineageSnapshotsCount,
    attachmentFiles: attachmentPaths.length,
  };

  // Progress denominator uses the RAW table sizes: a compact export still
  // walks every row (dropping some), so raw units keep the bar honest.
  const totalUnits =
    recordsCount +
    attachmentsCount +
    participantsCount +
    addressSyncCount +
    transactionsCount +
    utxoLineageCount +
    custodySegmentsCount +
    lineageSnapshotsCount +
    attachmentPaths.length || 1;
  let processedUnits = 0;
  const reportUnits = (phase: string) => {
    // Reserve 5% head (counts/inline) and 5% tail (finalize).
    const pct = 5 + Math.min(90, Math.round((processedUnits / totalUnits) * 90));
    opts.onProgress?.({ percent: pct, phase });
  };

  // Inline (small) tables → manifest.
  opts.onProgress?.({ percent: 4, phase: "Gathering metadata..." });
  const inlineData = await readInline();
  const backupInlineData = opts.compactPlan
    ? compactInlineRecordModel(inlineData, opts.compactPlan)
    : inlineData;
  const inlineEnvelope = await serializeInline(backupInlineData, key);

  const manifest: BackupManifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    app: "KYUTXO",
    appVersion: opts.appVersion ?? "3.0.0",
    exportDate: new Date().toISOString(),
    encrypted: opts.encrypted,
    salt: salt ? bufferToBase64(salt) : undefined,
    // Record the KDF parameters alongside the salt so restore can re-derive
    // the key even after the app's defaults move again.
    kdf: key ? CURRENT_KDF_PARAMS : undefined,
    check,
    counts,
    totalAttachmentBytes,
    streamedTables: [...STREAMED_TABLES],
    ...(plan
      ? { compact: true, compactDropped: { ...plan.dropped } }
      : {}),
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

    // 2) The five big tables as NDJSON (one batch per line). With a compact
    // plan, each table's rows pass through the plan's drop predicates — the
    // same functions that produced the manifest counts — and kept records get
    // dangling `discoveredFromRecordId` pointers scrubbed. Keyset paging
    // advances on the RAW batch (filtering must never stall the cursor), and
    // fully-dropped batches simply emit no line.
    const filters: CompactRowFilters | null = plan ? compactRowFilters(plan) : null;
    for (const table of STREAMED_TABLES) {
      const reader = STREAM_READERS[table];
      const lines = (async function* () {
        let afterId = 0;
        for (;;) {
          throwIfAborted(signal);
          const batch = await reader(afterId, batchSize);
          if (batch.length === 0) break;
          const outRows = filters ? applyCompactFilters(table, batch, filters) : batch;
          if (outRows.length > 0) {
            yield await serializeBatchLine(outRows, key);
          }
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

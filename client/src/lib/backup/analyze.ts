// Read-only merge analysis for v3 backups ("what would a merge actually add?").
//
// Walks the backup ZIP with the same streaming reader the restore pipeline
// uses, classifies every streamed-table row against the LIVE vault using the
// exact natural keys merge restore dedupes by (see merge-keys.ts — shared so
// the two can never drift), and reports per-table new / already-present
// counts. It NEVER writes to the vault: only read helpers are called.
//
// Two deliberate divergences from what a merge literally inserts, both by
// design:
//   1. Records whose only source is blockchain discovery (the compact-backup
//      prunable shape) are NOT counted as addable — sync would re-find them
//      anyway. They are reported separately as `discoveryOnlySkipped`. (A
//      merge WOULD insert them, so addable + discoveryOnlySkipped predicts
//      the merge's record insert count.)
//   2. Attachment rows whose owning record is absent from both the vault and
//      the backup (orphans) are counted as `orphanedSkipped` — a merge routes
//      their file bytes to Needs Review and inserts no row.
//
// The addable records (the rows a merge would insert, minus discovery-only)
// are also rendered to a CSV report as they are classified, chunked into
// Blob-ready parts so even a huge report never builds one giant string.

import {
  isStreamedTablePath,
  parseBatchLine,
  isV3Manifest,
  MANIFEST_FILENAME,
  ATTACHMENTS_DIR,
  CHECK_SENTINEL,
  getBackupKdfParams,
  type BackupManifest,
  type StreamedTable,
} from "./format";
import { readZipStream, lineConsumer, collectBytesConsumer } from "./zip-stream";
import { BackupCancelledError } from "./sink";
import { deriveKeyWithParams, decrypt, base64ToBuffer } from "@/lib/crypto";
import { getRecordsByInputStrings } from "@/lib/data/record-crud";
import { getAllAttachments } from "@/lib/data/attachments-crud";
import {
  getTransactionsByTxids,
  getParticipantsByTxids,
} from "@/lib/data/transaction-crud";
import { getAllAddressSyncState } from "@/lib/data/address-sync-crud";
import {
  getAllUtxoLineage,
  getExistingSegmentIds,
  getExistingSnapshotIds,
} from "@/lib/data/lineage-crud";
import {
  participantKey,
  participantMatchKey,
  mergeDuplicateTransactionsByTxid,
} from "./legacy-restore";
import { lineageIdentity } from "./legacy-restore-misc";
import {
  recordMergeIdentity,
  attachmentMergeKey,
  syncStateMergeAddress,
  segmentMergeId,
  snapshotMergeId,
} from "./merge-keys";
import { isPrunableRecordShape } from "./compact";
import { CSV_EXPORT_HEADER, recordToCsvRow, type CsvExportableRecord } from "@/lib/csv-export";
import type { Record as VaultRecord, TransactionParticipant } from "@/lib/db-types";
import type { RestoreProgress } from "./restore";

export interface AnalyzeOptions {
  source: AsyncIterable<Uint8Array>;
  password?: string;
  onProgress?: (p: RestoreProgress) => void;
  signal?: AbortSignal;
}

export interface MergeTableAnalysis {
  // Rows of this table carried by the backup.
  total: number;
  // Rows a merge would INSERT (absent from the live vault, first occurrence
  // within the backup stream).
  added: number;
  // Rows a merge would SKIP: they match a live row by the table's natural key,
  // or repeat an identity already seen earlier in the backup stream.
  alreadyPresent: number;
}

export interface RecordsTableAnalysis extends MergeTableAnalysis {
  // Backup records a merge would insert but which carry ONLY blockchain-
  // discovery data (no user metadata, exact 'blockchain-discovered' tier) —
  // excluded from `added` and from the CSV report because sync re-finds them.
  discoveryOnlySkipped: number;
}

export interface AttachmentsTableAnalysis extends MergeTableAnalysis {
  // Attachment rows whose owning record is absent from vault AND backup — a
  // merge inserts no row for these (their file bytes go to Needs Review).
  orphanedSkipped: number;
}

export interface MergeAnalysisResult {
  manifest: BackupManifest;
  tables: {
    records: RecordsTableAnalysis;
    attachments: AttachmentsTableAnalysis;
    transactionParticipants: MergeTableAnalysis;
    addressSyncState: MergeTableAnalysis;
    blockchainTransactions: MergeTableAnalysis;
    utxoLineage: MergeTableAnalysis;
    custodySegments: MergeTableAnalysis;
    lineageSnapshots: MergeTableAnalysis;
  };
  report: {
    // CSV chunks in key order: parts[0] is the header row. Pass straight to
    // `new Blob(parts, { type: "text/csv" })`.
    parts: string[];
    // Addable-record rows written (excludes the header).
    rowCount: number;
  };
}

// Analyzes a v3 backup against the live vault WITHOUT writing anything. Throws
// BackupCancelledError when cancelled; throws the same "Invalid password or
// corrupted backup" style errors the restore pre-flight produces for bad
// passwords / malformed archives.
export async function analyzeV3Backup(opts: AnalyzeOptions): Promise<MergeAnalysisResult> {
  let manifest: BackupManifest | null = null;
  // Set synchronously when the manifest entry's header is reached (onEntry is
  // fflate's sync callback), so data-before-manifest archives are rejected in
  // entry order — mirroring the restore pipeline's guard.
  let manifestSeen = false;
  let key: CryptoKey | null = null;

  const tables: MergeAnalysisResult["tables"] = {
    records: { total: 0, added: 0, alreadyPresent: 0, discoveryOnlySkipped: 0 },
    attachments: { total: 0, added: 0, alreadyPresent: 0, orphanedSkipped: 0 },
    transactionParticipants: { total: 0, added: 0, alreadyPresent: 0 },
    addressSyncState: { total: 0, added: 0, alreadyPresent: 0 },
    blockchainTransactions: { total: 0, added: 0, alreadyPresent: 0 },
    utxoLineage: { total: 0, added: 0, alreadyPresent: 0 },
    custodySegments: { total: 0, added: 0, alreadyPresent: 0 },
    lineageSnapshots: { total: 0, added: 0, alreadyPresent: 0 },
  };

  // Backup record id → the live record id it de-dupes onto, or a SYNTHETIC
  // negative id standing in for the fresh id a merge would assign. Negative
  // ids can never collide with live autoincrement ids, so dependent-row keys
  // (the attachment `recordId:filename` fallback) classify exactly like merge.
  const idMap = new Map<number, number>();
  let nextSyntheticId = -1;
  // inputString → live id (de-dupe) or synthetic id (first occurrence this
  // stream) — the read-only mirror of merge's mergedRecordIdByInputString.
  const resolvedIdByInputString = new Map<string, number>();

  // Live merge-key sets, loaded lazily on the first batch of each table (same
  // laziness as merge: a backup without that table pays no query cost).
  let existingAttachmentKeys: Set<string> | null = null;
  let existingSyncAddresses: Set<string> | null = null;
  let existingLineageKeys: Set<string> | null = null;
  let existingSegmentIds: Set<string> | null = null;
  let existingSnapshotIds: Set<string> | null = null;
  // Participant exact-keys already counted as added this stream, so the
  // incoming stream never double-counts itself across batches.
  const addedParticipantKeys = new Set<string>();

  const csvParts: string[] = [CSV_EXPORT_HEADER.join(",") + "\r\n"];
  let csvRowCount = 0;

  let processed = 0;
  // Progress total: the streamed-table row counts only. Attachment FILE bytes
  // are never read (byte-level comparison is out of scope), so they are not
  // part of the work this pass does.
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
  const report = (phase: string) => {
    const pct = 10 + Math.min(89, Math.round((processed / total()) * 89));
    opts.onProgress?.({ percent: pct, phase });
  };
  const throwIfAborted = () => {
    if (opts.signal?.aborted) throw new BackupCancelledError();
  };

  async function analyzeBatch(table: StreamedTable, rows: any[]): Promise<void> {
    throwIfAborted();
    if (table === "records") {
      // Mirror merge's records branch: look up only identities not already
      // resolved (live rows queried before, or first occurrences this stream).
      const unknown = rows
        .map(recordMergeIdentity)
        .filter((s) => s !== "" && !resolvedIdByInputString.has(s));
      if (unknown.length) {
        const found = await getRecordsByInputStrings(unknown);
        for (const r of found) {
          if (typeof r.id === "number") {
            resolvedIdByInputString.set(r.inputString, r.id);
          }
        }
      }
      const csvRows: string[] = [];
      for (const r of rows) {
        tables.records.total += 1;
        const s = recordMergeIdentity(r);
        const mapped = s ? resolvedIdByInputString.get(s) : undefined;
        if (mapped !== undefined) {
          // Live duplicate, or a repeat of an identity first seen earlier in
          // the backup stream — a merge inserts nothing for either.
          tables.records.alreadyPresent += 1;
          if (typeof r.id === "number") idMap.set(r.id, mapped);
          continue;
        }
        // First occurrence of an identity a merge would insert.
        const syntheticId = nextSyntheticId--;
        if (s) resolvedIdByInputString.set(s, syntheticId);
        if (typeof r.id === "number") idMap.set(r.id, syntheticId);
        if (isPrunableRecordShape(r as VaultRecord)) {
          // Blockchain-discovery-only: sync re-finds these; not addable.
          tables.records.discoveryOnlySkipped += 1;
          continue;
        }
        tables.records.added += 1;
        csvRows.push(recordToCsvRow(r as CsvExportableRecord));
      }
      if (csvRows.length > 0) {
        csvParts.push(csvRows.join("\r\n") + "\r\n");
        csvRowCount += csvRows.length;
      }
    } else if (table === "attachments") {
      if (existingAttachmentKeys === null) {
        existingAttachmentKeys = new Set<string>();
        for (const att of await getAllAttachments()) {
          existingAttachmentKeys.add(attachmentMergeKey(att, att.recordId));
        }
      }
      for (const a of rows) {
        tables.attachments.total += 1;
        const recordId = typeof a?.recordId === "number" ? idMap.get(a.recordId) : undefined;
        if (recordId === undefined) {
          // Orphan: owning record absent — a merge inserts no row (the file
          // bytes are routed to Needs Review instead).
          tables.attachments.orphanedSkipped += 1;
          continue;
        }
        const attKey = attachmentMergeKey(a, recordId);
        if (existingAttachmentKeys.has(attKey)) {
          tables.attachments.alreadyPresent += 1;
          continue;
        }
        existingAttachmentKeys.add(attKey);
        tables.attachments.added += 1;
      }
    } else if (table === "transactionParticipants") {
      // Mirror merge: a live counterpart (outpoint for inputs / vout for
      // outputs, exact key as fallback) is ENRICHED, not duplicated.
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
      for (const p of rows) {
        tables.transactionParticipants.total += 1;
        const mk = participantMatchKey(p);
        const liveMatch =
          (mk ? liveByMatchKey.get(mk) : undefined) ?? liveByExactKey.get(participantKey(p));
        if (liveMatch) {
          tables.transactionParticipants.alreadyPresent += 1;
          continue;
        }
        const k = participantKey(p);
        if (addedParticipantKeys.has(k)) {
          tables.transactionParticipants.alreadyPresent += 1;
          continue;
        }
        addedParticipantKeys.add(k);
        tables.transactionParticipants.added += 1;
      }
    } else if (table === "addressSyncState") {
      if (existingSyncAddresses === null) {
        existingSyncAddresses = new Set<string>();
        for (const s of await getAllAddressSyncState()) {
          existingSyncAddresses.add(s.address);
        }
      }
      for (const s of rows) {
        tables.addressSyncState.total += 1;
        const address = syncStateMergeAddress(s);
        if (!address || existingSyncAddresses.has(address)) {
          tables.addressSyncState.alreadyPresent += 1;
          continue;
        }
        existingSyncAddresses.add(address);
        tables.addressSyncState.added += 1;
      }
    } else if (table === "blockchainTransactions") {
      // Same-txid repeats within the batch collapse into one row (merge
      // enriches rather than duplicating), then each survivor is matched
      // against the live vault by txid.
      const deduped = mergeDuplicateTransactionsByTxid(rows);
      tables.blockchainTransactions.total += rows.length;
      tables.blockchainTransactions.alreadyPresent += rows.length - deduped.length;
      const batchTxids = deduped
        .map((t) => t.txid)
        .filter((t): t is string => typeof t === "string" && t !== "");
      const liveByTxid = new Map<string, unknown>();
      if (batchTxids.length) {
        for (const tx of await getTransactionsByTxids(batchTxids)) {
          liveByTxid.set(tx.txid, tx);
        }
      }
      for (const tx of deduped) {
        const live = typeof tx.txid === "string" ? liveByTxid.get(tx.txid) : undefined;
        if (live) {
          tables.blockchainTransactions.alreadyPresent += 1;
        } else {
          tables.blockchainTransactions.added += 1;
        }
      }
    } else if (table === "utxoLineage") {
      if (existingLineageKeys === null) {
        existingLineageKeys = new Set<string>();
        for (const l of await getAllUtxoLineage()) {
          existingLineageKeys.add(lineageIdentity(l));
        }
      }
      for (const d of rows) {
        tables.utxoLineage.total += 1;
        const k = lineageIdentity(d);
        if (existingLineageKeys.has(k)) {
          tables.utxoLineage.alreadyPresent += 1;
          continue;
        }
        existingLineageKeys.add(k);
        tables.utxoLineage.added += 1;
      }
    } else if (table === "custodySegments") {
      if (existingSegmentIds === null) {
        existingSegmentIds = await getExistingSegmentIds();
      }
      for (const d of rows) {
        tables.custodySegments.total += 1;
        const segmentId = segmentMergeId(d);
        if (segmentId !== null && existingSegmentIds.has(segmentId)) {
          tables.custodySegments.alreadyPresent += 1;
          continue;
        }
        if (segmentId !== null) existingSegmentIds.add(segmentId);
        tables.custodySegments.added += 1;
      }
    } else if (table === "lineageSnapshots") {
      if (existingSnapshotIds === null) {
        existingSnapshotIds = await getExistingSnapshotIds();
      }
      for (const d of rows) {
        tables.lineageSnapshots.total += 1;
        const snapshotId = snapshotMergeId(d);
        if (snapshotId !== null && existingSnapshotIds.has(snapshotId)) {
          tables.lineageSnapshots.alreadyPresent += 1;
          continue;
        }
        if (snapshotId !== null) existingSnapshotIds.add(snapshotId);
        tables.lineageSnapshots.added += 1;
      }
    }
    processed += rows.length;
    report(`Analyzing ${table}...`);
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
            // KDF parameters travel in the manifest; absent = pre-strengthening
            // backup (legacy 100k) — same resolution as the restore pipeline.
            key = await deriveKeyWithParams(opts.password, salt, getBackupKdfParams(manifest));
            // Verify BEFORE reporting anything, so a wrong password fails the
            // analysis with the same error the restore pre-flight produces.
            let ok = false;
            try {
              ok = (await decrypt(manifest.check ?? "", key)) === CHECK_SENTINEL;
            } catch {
              ok = false;
            }
            if (!ok) throw new Error("Invalid password or corrupted backup");
          }
          opts.onProgress?.({ percent: 5, phase: "Verifying backup..." });
        });
      }

      // The manifest must physically precede all data — reject archives that
      // front-load data before it (same guard as the restore pipeline).
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
          if (rows.length) await analyzeBatch(table, rows);
        });
      }

      // Attachment file bytes are never read: path-level de-dupe of the
      // metadata rows is enough for the analysis.
      return null;
    },
  });

  // A cancel can land between the last batch and here (e.g. requested from the
  // final progress callback) — honor it instead of reporting a result.
  throwIfAborted();
  if (!manifest) throw new Error("Invalid backup: missing manifest");

  opts.onProgress?.({ percent: 100, phase: "Analysis complete" });
  return { manifest, tables, report: { parts: csvParts, rowCount: csvRowCount } };
}

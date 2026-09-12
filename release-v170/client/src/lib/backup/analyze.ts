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
  parseInline,
  classifyBackupManifest,
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
import { MergeClassifier } from "./merge-classify";
import {
  recordOriginMergeKey,
  derivationTemplateIdentity,
} from "./merge-keys";
import {
  getTags,
  getCategories,
  getOwners,
  getWalletNames,
  getSeedNames,
  getWalletSoftware,
} from "@/lib/data/vocabulary-crud";
import { getAllCustomFields } from "@/lib/data/custom-fields-crud";
import { getAllDerivationTemplates } from "@/lib/data/derivation-templates-crud";
import { getRecordOriginsByRecordIds } from "@/lib/data/record-origins-crud";
import { getAllEvidence, evidenceIdentity } from "@/lib/data/evidence-crud";
import {
  getPriceDataByDateCurrencyAssetKeys,
  priceDedupKey,
} from "@/lib/data/price-data-crud";
import { getAllDustFlags, toOutpoint } from "@/lib/data/dust-flags-crud";
import { getAllSavedPsbts } from "@/lib/data/saved-psbts-crud";
import {
  getAllAdversaryScenarios,
  adversaryScenarioIdentity,
} from "@/lib/data/adversary-scenarios-crud";
import { isPrunableRecordShape } from "./compact";
import { CSV_EXPORT_HEADER, recordToCsvRow, type CsvExportableRecord } from "@/lib/csv-export";
import type { Record as VaultRecord } from "@/lib/db-types";
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

export interface RecordOriginsAnalysis extends MergeTableAnalysis {
  // Origin rows whose owning record is absent from both the vault and the
  // backup — a merge drops them (an origin without its record is meaningless).
  orphanedSkipped: number;
}

// New/already-present counts for the small inline-metadata tables a merge also
// restores from the manifest, classified with the SAME natural keys
// restoreInlineTables / restorePendingRecordOrigins de-dupe by (vocabulary:
// name; custom fields: slug; derivation templates: derivationTemplateIdentity;
// recordOrigins: recordOriginMergeKey after id remap).
export interface InlineMetadataAnalysis {
  tags: MergeTableAnalysis;
  categories: MergeTableAnalysis;
  owners: MergeTableAnalysis;
  walletNames: MergeTableAnalysis;
  seedNames: MergeTableAnalysis;
  walletSoftware: MergeTableAnalysis;
  customFields: MergeTableAnalysis;
  derivationTemplates: MergeTableAnalysis;
  recordOrigins: RecordOriginsAnalysis;
  // Other inline data tables a merge also restores, classified with the same
  // natural keys the shared restore helpers de-dupe by (evidence:
  // evidenceIdentity — attachment rows follow their document; priceData:
  // [date+currency+asset]; dustFlags: outpoint; savedPsbts: psbtBase64;
  // adversaryScenarios: name+counterparty identity).
  evidence: MergeTableAnalysis;
  priceData: MergeTableAnalysis;
  dustFlags: MergeTableAnalysis;
  savedPsbts: MergeTableAnalysis;
  adversaryScenarios: MergeTableAnalysis;
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
  // Inline-metadata counts (vocabulary, custom fields, derivation templates,
  // recordOrigins source history) — what a merge would additionally restore
  // from the manifest, beyond the streamed tables above.
  inline: InlineMetadataAnalysis;
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

  // THE shared per-row merge classifier (see merge-classify.ts) — the exact
  // implementation merge restore drives its writes from, so this analysis
  // cannot drift from what a merge actually does. All merge de-dup state
  // (lazy live natural-key sets, stream-added keys, the inputString → id map)
  // lives inside it; this pass only counts its decisions.
  const classifier = new MergeClassifier();

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
      const { decisions, newIdentities } = await classifier.classifyRecords(rows);
      // Assign a synthetic id to every row a merge would insert, and register
      // them so later batches resolve repeats — the read-only counterpart of
      // merge registering the real inserted ids.
      const syntheticIds = newIdentities.map(() => nextSyntheticId--);
      classifier.registerNewRecordIds(newIdentities, syntheticIds);
      const csvRows: string[] = [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const d = decisions[i];
        tables.records.total += 1;
        if (d.kind !== "new") {
          // Live duplicate, or a repeat of an identity first seen earlier in
          // the backup stream/batch — a merge inserts nothing for either.
          tables.records.alreadyPresent += 1;
          if (typeof r.id === "number") {
            idMap.set(r.id, d.kind === "existing" ? d.id : syntheticIds[d.newIndex]);
          }
          continue;
        }
        // First occurrence of an identity a merge would insert.
        if (typeof r.id === "number") idMap.set(r.id, syntheticIds[d.newIndex]);
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
      const decisions = await classifier.classifyAttachments(
        rows,
        (oldId) => (typeof oldId === "number" ? idMap.get(oldId) : undefined),
        true,
      );
      for (const decision of decisions) {
        tables.attachments.total += 1;
        if (decision.kind === "orphan") {
          // Orphan: owning record absent — a merge inserts no row (the file
          // bytes are routed to Needs Review instead).
          tables.attachments.orphanedSkipped += 1;
        } else if (decision.kind === "duplicate") {
          tables.attachments.alreadyPresent += 1;
        } else {
          tables.attachments.added += 1;
        }
      }
    } else if (table === "transactionParticipants") {
      // A live counterpart (outpoint for inputs / vout for outputs, exact key
      // as fallback) is ENRICHED by a merge, not duplicated — so both enrich
      // and stream-duplicate decisions count as already present.
      const decisions = await classifier.classifyParticipants(rows);
      for (const decision of decisions) {
        tables.transactionParticipants.total += 1;
        if (decision.kind === "insert") {
          tables.transactionParticipants.added += 1;
        } else {
          tables.transactionParticipants.alreadyPresent += 1;
        }
      }
    } else if (table === "addressSyncState") {
      const inserts = await classifier.classifySyncState(rows);
      for (const insert of inserts) {
        tables.addressSyncState.total += 1;
        if (insert) tables.addressSyncState.added += 1;
        else tables.addressSyncState.alreadyPresent += 1;
      }
    } else if (table === "blockchainTransactions") {
      // Same-txid repeats within the batch collapse into one row (merge
      // enriches rather than duplicating), then each survivor is matched
      // against the live vault by txid.
      const { deduped, decisions } = await classifier.classifyTransactions(rows, true);
      tables.blockchainTransactions.total += rows.length;
      tables.blockchainTransactions.alreadyPresent += rows.length - deduped.length;
      for (const decision of decisions) {
        if (decision.kind === "enrich") {
          tables.blockchainTransactions.alreadyPresent += 1;
        } else {
          tables.blockchainTransactions.added += 1;
        }
      }
    } else if (table === "utxoLineage") {
      const inserts = await classifier.classifyLineage(rows);
      for (const insert of inserts) {
        tables.utxoLineage.total += 1;
        if (insert) tables.utxoLineage.added += 1;
        else tables.utxoLineage.alreadyPresent += 1;
      }
    } else if (table === "custodySegments") {
      const inserts = await classifier.classifySegments(rows);
      for (const insert of inserts) {
        tables.custodySegments.total += 1;
        if (insert) tables.custodySegments.added += 1;
        else tables.custodySegments.alreadyPresent += 1;
      }
    } else if (table === "lineageSnapshots") {
      const inserts = await classifier.classifySnapshots(rows);
      for (const insert of inserts) {
        tables.lineageSnapshots.total += 1;
        if (insert) tables.lineageSnapshots.added += 1;
        else tables.lineageSnapshots.alreadyPresent += 1;
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
          if (!classifyBackupManifest(parsed)) throw new Error("Not a v3 backup");
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

  // Inline-metadata classification runs AFTER the stream: recordOrigins
  // reference records by backup id, and the old→(live|synthetic) id map is
  // only complete once the records NDJSON has been processed — the same
  // ordering restore.ts uses for restorePendingRecordOrigins.
  const inline = await analyzeInlineMetadata(manifest, key, idMap, throwIfAborted);

  opts.onProgress?.({ percent: 100, phase: "Analysis complete" });
  return { manifest, tables, inline, report: { parts: csvParts, rowCount: csvRowCount } };
}

// Classifies the manifest's inline metadata (vocabulary, custom fields,
// derivation templates, recordOrigins) against the live vault, read-only,
// using the exact natural keys the merge restore de-dupes by:
//   - vocabulary: `name` (blank names and repeats within the backup are
//     skipped by restoreInlineTables, so they count as alreadyPresent);
//   - custom fields: unique `slug` (a blank slug is always inserted);
//   - derivation templates: derivationTemplateIdentity (shared helper);
//   - recordOrigins: recordOriginMergeKey over the remapped record id —
//     rows whose owning record is absent from vault AND backup are dropped
//     by a merge and reported as orphanedSkipped.
async function analyzeInlineMetadata(
  manifest: BackupManifest,
  key: CryptoKey | null,
  idMap: Map<number, number>,
  throwIfAborted: () => void,
): Promise<InlineMetadataAnalysis> {
  const data = await parseInline(manifest, key);
  const arr = (k: string): any[] => (Array.isArray(data[k]) ? (data[k] as any[]) : []);
  const blank = (): MergeTableAnalysis => ({ total: 0, added: 0, alreadyPresent: 0 });

  // Mirror of restoreInlineTables' vocabSeen/vocabSkip in merge mode. The live
  // names are loaded only when the backup actually carries rows for the table.
  const vocab = async (
    tableKey: string,
    existing: () => Promise<Array<{ name: string }>>,
  ): Promise<MergeTableAnalysis> => {
    const t = blank();
    const rows = arr(tableKey);
    if (rows.length === 0) return t;
    throwIfAborted();
    const seen = new Set<string>();
    for (const v of await existing()) seen.add(v.name);
    for (const row of rows) {
      t.total += 1;
      const name = (row?.name as string) || "";
      if (!name || seen.has(name)) {
        t.alreadyPresent += 1;
        continue;
      }
      seen.add(name);
      t.added += 1;
    }
    return t;
  };

  const customFields = blank();
  {
    const rows = arr("customFields");
    if (rows.length) {
      throwIfAborted();
      const seenSlugs = new Set<string>();
      for (const f of await getAllCustomFields()) seenSlugs.add(f.slug);
      for (const row of rows) {
        customFields.total += 1;
        const slug = typeof row?.slug === "string" ? row.slug : "";
        if (slug && seenSlugs.has(slug)) {
          customFields.alreadyPresent += 1;
          continue;
        }
        if (slug) seenSlugs.add(slug);
        customFields.added += 1;
      }
    }
  }

  const derivationTemplates = blank();
  {
    const rows = arr("derivationTemplates");
    if (rows.length) {
      throwIfAborted();
      const seenKeys = new Set<string>();
      for (const t of await getAllDerivationTemplates()) {
        seenKeys.add(derivationTemplateIdentity(t));
      }
      for (const row of rows) {
        derivationTemplates.total += 1;
        const k = derivationTemplateIdentity(row ?? {});
        if (seenKeys.has(k)) {
          derivationTemplates.alreadyPresent += 1;
          continue;
        }
        seenKeys.add(k);
        derivationTemplates.added += 1;
      }
    }
  }

  const recordOrigins: RecordOriginsAnalysis = { ...blank(), orphanedSkipped: 0 };
  {
    const rows = arr("recordOrigins");
    if (rows.length) {
      throwIfAborted();
      // Remap backup record ids exactly like restorePendingRecordOrigins:
      // live ids for de-duped records, synthetic negative ids for records the
      // merge would insert (their origins can only collide within the backup).
      const remapped: Array<{ key: string }> = [];
      for (const o of rows) {
        recordOrigins.total += 1;
        const backupId = o && typeof o === "object" ? (o as any).recordId : undefined;
        const mapped = typeof backupId === "number" ? idMap.get(backupId) : undefined;
        if (mapped === undefined) {
          recordOrigins.orphanedSkipped += 1;
          continue;
        }
        remapped.push({ key: recordOriginMergeKey({ ...(o as any), recordId: mapped }) });
      }
      if (remapped.length) {
        // Only positive (live) record ids can have live origins; synthetic
        // negative ids simply return no rows from the query, like merge.
        const liveIds = Array.from(
          new Set(
            rows
              .map((o: any) => (typeof o?.recordId === "number" ? idMap.get(o.recordId) : undefined))
              .filter((id): id is number => typeof id === "number" && id > 0),
          ),
        );
        const seen = new Set<string>();
        if (liveIds.length) {
          for (const live of await getRecordOriginsByRecordIds(liveIds)) {
            seen.add(recordOriginMergeKey(live));
          }
        }
        for (const r of remapped) {
          if (seen.has(r.key)) {
            recordOrigins.alreadyPresent += 1;
            continue;
          }
          seen.add(r.key);
          recordOrigins.added += 1;
        }
      }
    }
  }

  // Evidence documents de-dupe by evidenceIdentity (restoreEvidenceRows).
  // Their attachment rows follow the document (skipped documents skip their
  // attachments too), so documents are the unit users compare — attachment
  // rows are not counted separately.
  const evidence = blank();
  {
    const rows = arr("evidence");
    if (rows.length) {
      throwIfAborted();
      const seen = new Set<string>();
      for (const ev of await getAllEvidence()) seen.add(evidenceIdentity(ev));
      for (const row of rows) {
        evidence.total += 1;
        const k = evidenceIdentity(row ?? {});
        if (seen.has(k)) {
          evidence.alreadyPresent += 1;
          continue;
        }
        seen.add(k);
        evidence.added += 1;
      }
    }
  }

  // Daily price rows de-dupe by [date+currency+asset] (restorePriceDataRows).
  // Rows with a malformed key (non-string components) are always inserted by
  // the restore helper, so they count as added here too.
  const priceData = blank();
  {
    const rows = arr("priceData");
    if (rows.length) {
      throwIfAborted();
      const keys: [string, string, string][] = [];
      for (const pd of rows) {
        if (
          pd &&
          typeof pd.date === "string" &&
          typeof pd.currency === "string" &&
          typeof pd.asset === "string"
        ) {
          keys.push([pd.date, pd.currency, pd.asset]);
        }
      }
      const seen = new Set<string>();
      for (const e of await getPriceDataByDateCurrencyAssetKeys(keys)) {
        seen.add(priceDedupKey(e.date, e.currency, e.asset));
      }
      for (const row of rows) {
        priceData.total += 1;
        const k = priceDedupKey(row?.date, row?.currency, row?.asset);
        if (seen.has(k)) {
          priceData.alreadyPresent += 1;
          continue;
        }
        seen.add(k);
        priceData.added += 1;
      }
    }
  }

  // Dust flags de-dupe by their unique outpoint (restoreDustFlagRows), which
  // also derives txid:vout when the outpoint field is absent. Rows with no
  // derivable outpoint are dropped by the restore, so they count as
  // alreadyPresent (a merge inserts nothing for them).
  const dustFlags = blank();
  {
    const rows = arr("dustFlags");
    if (rows.length) {
      throwIfAborted();
      const seen = new Set<string>();
      for (const f of await getAllDustFlags()) seen.add(f.outpoint);
      for (const row of rows) {
        dustFlags.total += 1;
        let outpoint: string | undefined =
          typeof row?.outpoint === "string" && row.outpoint.length > 0
            ? row.outpoint
            : undefined;
        if (!outpoint && typeof row?.txid === "string" && typeof row?.vout === "number") {
          outpoint = toOutpoint(row.txid, row.vout);
        }
        if (!outpoint || seen.has(outpoint)) {
          dustFlags.alreadyPresent += 1;
          continue;
        }
        seen.add(outpoint);
        dustFlags.added += 1;
      }
    }
  }

  // Saved PSBTs de-dupe by their PSBT bytes (restoreSavedPsbtRows). Rows with
  // no usable psbtBase64 are dropped by the restore, so they count as
  // alreadyPresent (a merge inserts nothing for them).
  const savedPsbts = blank();
  {
    const rows = arr("savedPsbts");
    if (rows.length) {
      throwIfAborted();
      const seen = new Set<string>();
      for (const p of await getAllSavedPsbts()) seen.add(p.psbtBase64);
      for (const row of rows) {
        savedPsbts.total += 1;
        const b64 = typeof row?.psbtBase64 === "string" ? row.psbtBase64 : "";
        if (!b64 || seen.has(b64)) {
          savedPsbts.alreadyPresent += 1;
          continue;
        }
        seen.add(b64);
        savedPsbts.added += 1;
      }
    }
  }

  // Adversary scenarios de-dupe by their (name, counterparty) identity
  // (restoreAdversaryScenarioRows). Every row is restorable — the helper only
  // normalizes fields — so nothing counts as dropped.
  const adversaryScenarios = blank();
  {
    const rows = arr("adversaryScenarios");
    if (rows.length) {
      throwIfAborted();
      const seen = new Set<string>();
      for (const s of await getAllAdversaryScenarios()) {
        seen.add(adversaryScenarioIdentity(s));
      }
      for (const row of rows) {
        adversaryScenarios.total += 1;
        const key = adversaryScenarioIdentity(row ?? {});
        if (seen.has(key)) {
          adversaryScenarios.alreadyPresent += 1;
          continue;
        }
        seen.add(key);
        adversaryScenarios.added += 1;
      }
    }
  }

  return {
    tags: await vocab("tags", getTags),
    categories: await vocab("categories", getCategories),
    owners: await vocab("owners", getOwners),
    walletNames: await vocab("walletNames", getWalletNames),
    seedNames: await vocab("seedNames", getSeedNames),
    walletSoftware: await vocab("walletSoftware", getWalletSoftware),
    customFields,
    derivationTemplates,
    recordOrigins,
    evidence,
    priceData,
    dustFlags,
    savedPsbts,
    adversaryScenarios,
  };
}

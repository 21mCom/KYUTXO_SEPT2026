// Shared per-row merge classification for the v3 restore pipeline.
//
// MergeClassifier is the SINGLE implementation of "what would a merge do with
// this row?" — used by BOTH the actual merge restore (restore.ts, which applies
// writes based on each decision) and the read-only merge analysis (analyze.ts,
// which only counts the decisions). Because the two drive off one classifier,
// a dedupe-rule change (new table, changed skip rule, different natural key)
// cannot update one without the other: the analysis structurally predicts
// exactly what a merge would insert/skip/enrich.
//
// The classifier owns all merge de-dup state: the live-vault natural-key sets
// (loaded lazily on the first batch of each table, so a backup without that
// table pays no query cost) plus the keys added during the stream, so the
// incoming stream never duplicates itself across batches. It performs READS
// only — writes (and write-only concerns like undo logging, enrichment
// application, orphan file routing) stay with the callers.

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
import type { TransactionParticipant } from "@/lib/db-types";

// What a merge does with one records-table row:
//  - existing:        identity matches a live row, or a row already resolved
//                     earlier in the stream — nothing is inserted; dependent
//                     rows link to `id`.
//  - duplicateOfNew:  identity repeats WITHIN this batch — nothing is
//                     inserted; the row resolves to the id eventually assigned
//                     to the batch's first occurrence (`newIndex` into the
//                     first-occurrence list).
//  - new:             first occurrence of an identity a merge inserts
//                     (`newIndex` into the first-occurrence list).
export type RecordRowDecision =
  | { kind: "existing"; id: number }
  | { kind: "duplicateOfNew"; newIndex: number }
  | { kind: "new"; newIndex: number };

export interface RecordBatchClassification {
  decisions: RecordRowDecision[];
  // Merge identities of the first-occurrence rows, in `newIndex` order. After
  // the caller has assigned ids to those rows (real inserted ids for restore,
  // synthetic ids for analysis) it MUST call registerNewRecordIds() with them
  // so later batches resolve repeats of these identities.
  newIdentities: string[];
}

// What a merge does with one attachments-table row:
//  - orphan:    the owning record is absent from vault and backup — no row is
//               inserted (restore routes the file bytes to Needs Review).
//  - duplicate: matches a live row (or an earlier stream row) by natural key.
//  - insert:    a merge inserts it, linked to `recordId`.
export type AttachmentRowDecision =
  | { kind: "orphan" }
  | { kind: "duplicate" }
  | { kind: "insert"; recordId: number };

// What a merge does with one transactionParticipants-table row:
//  - enrich:    a live counterpart exists (outpoint for inputs / vout for
//               outputs, exact key as fallback) — the live row is ENRICHED,
//               never duplicated. `live` is the matched live row.
//  - duplicate: repeats the exact key of a row already added this stream.
//  - insert:    a merge inserts it.
export type ParticipantRowDecision =
  | { kind: "enrich"; live: TransactionParticipant }
  | { kind: "duplicate" }
  | { kind: "insert" };

// What a merge does with one same-batch-deduped blockchainTransactions row:
//  - enrich: a live row shares the txid — kept and enriched, not duplicated.
//  - insert: a merge inserts it.
export type TransactionRowDecision =
  | { kind: "enrich"; live: any }
  | { kind: "insert" };

export interface TransactionBatchClassification {
  // Same-txid repeats within the batch collapsed into one row (merge enriches
  // rather than duplicating). `rows.length - deduped.length` rows were
  // swallowed by that collapse.
  deduped: any[];
  // One decision per deduped row.
  decisions: TransactionRowDecision[];
}

export class MergeClassifier {
  // inputString → resolved record id: live rows queried before, plus ids the
  // caller registered for rows inserted (or synthetically assigned) earlier
  // in the stream.
  private resolvedIdByInputString = new Map<string, number>();
  // Live merge-key sets, loaded lazily on the first batch of each table.
  private existingAttachmentKeys: Set<string> | null = null;
  private existingSyncAddresses: Set<string> | null = null;
  private existingLineageKeys: Set<string> | null = null;
  private existingSegmentIds: Set<string> | null = null;
  private existingSnapshotIds: Set<string> | null = null;
  // Participant exact-keys already classified as insert this stream, so the
  // incoming stream never duplicates itself across batches.
  private addedParticipantKeys = new Set<string>();
  // Match keys (outpoint/vout identities) of participants already classified
  // as insert this stream. Used by the blank-input ordinal pairing so a later
  // batch never pairs a blank live row with an outpoint the stream already
  // decided to insert.
  private addedParticipantMatchKeys = new Set<string>();
  // Live ids of fully-blank input rows already consumed by ordinal pairing in
  // an earlier batch. The analysis never writes, so without this a later batch
  // for the same txid would re-load the same (still-blank) rows and could pair
  // them twice; the restore benefits too when its enrichment produced no
  // visible change.
  private pairedBlankLiveIds = new Set<number>();

  // records ------------------------------------------------------------------

  async classifyRecords(rows: any[]): Promise<RecordBatchClassification> {
    // Only hit the DB for identities not already known from earlier batches.
    const unknown = rows
      .map(recordMergeIdentity)
      .filter((s) => s !== "" && !this.resolvedIdByInputString.has(s));
    if (unknown.length) {
      const found = await getRecordsByInputStrings(unknown);
      for (const r of found) {
        if (typeof r.id === "number") {
          this.resolvedIdByInputString.set(r.inputString, r.id);
        }
      }
    }
    const decisions: RecordRowDecision[] = [];
    const newIdentities: string[] = [];
    // inputString → newIndex, so a duplicate identity WITHIN this batch
    // collapses onto the first occurrence instead of inserting twice
    // (records.inputString is indexed but NOT unique — nothing else stops it).
    const pendingIndexByInput = new Map<string, number>();
    for (const r of rows) {
      const s = recordMergeIdentity(r);
      const existingId = s ? this.resolvedIdByInputString.get(s) : undefined;
      if (existingId !== undefined) {
        decisions.push({ kind: "existing", id: existingId });
        continue;
      }
      const pendingIndex = s ? pendingIndexByInput.get(s) : undefined;
      if (pendingIndex !== undefined) {
        decisions.push({ kind: "duplicateOfNew", newIndex: pendingIndex });
        continue;
      }
      const newIndex = newIdentities.length;
      if (s) pendingIndexByInput.set(s, newIndex);
      decisions.push({ kind: "new", newIndex });
      newIdentities.push(s);
    }
    return { decisions, newIdentities };
  }

  // Registers the ids assigned to a batch's first-occurrence rows (in
  // classifyRecords' `newIdentities` order), so later batches resolve repeats.
  registerNewRecordIds(newIdentities: string[], ids: number[]): void {
    for (let i = 0; i < newIdentities.length; i++) {
      const s = newIdentities[i];
      if (s !== "" && !this.resolvedIdByInputString.has(s)) {
        this.resolvedIdByInputString.set(s, ids[i]);
      }
    }
  }

  // Record-id lookups shared with the compact-backup shell rebuild.
  getRecordIdForInput(inputString: string): number | undefined {
    return this.resolvedIdByInputString.get(inputString);
  }

  noteRecordIdForInput(inputString: string, id: number): void {
    if (!this.resolvedIdByInputString.has(inputString)) {
      this.resolvedIdByInputString.set(inputString, id);
    }
  }

  // attachments ---------------------------------------------------------------

  // `mapRecordId` resolves a backup recordId to the id the row would link to
  // (a live id, or the id assigned to a record inserted/synthesised earlier
  // this stream); undefined = owning record absent → orphan. When `dedupe` is
  // false (replace-mode restore) only the orphan rule applies.
  async classifyAttachments(
    rows: any[],
    mapRecordId: (oldId: unknown) => number | undefined,
    dedupe: boolean,
  ): Promise<AttachmentRowDecision[]> {
    if (dedupe && this.existingAttachmentKeys === null) {
      this.existingAttachmentKeys = new Set<string>();
      for (const att of await getAllAttachments()) {
        this.existingAttachmentKeys.add(attachmentMergeKey(att, att.recordId));
      }
    }
    const decisions: AttachmentRowDecision[] = [];
    for (const a of rows) {
      const recordId = mapRecordId(a?.recordId);
      if (recordId === undefined) {
        decisions.push({ kind: "orphan" });
        continue;
      }
      if (dedupe) {
        const attKey = attachmentMergeKey(a, recordId);
        if (this.existingAttachmentKeys!.has(attKey)) {
          decisions.push({ kind: "duplicate" });
          continue;
        }
        this.existingAttachmentKeys!.add(attKey);
      }
      decisions.push({ kind: "insert", recordId });
    }
    return decisions;
  }

  // transactionParticipants ----------------------------------------------------

  async classifyParticipants(rows: any[]): Promise<ParticipantRowDecision[]> {
    // A participant's transaction may already exist live (the participants
    // stream BEFORE blockchainTransactions, so any live participant for a
    // batch txid predates this restore). Match each backup participant to its
    // live counterpart: a match is enriched, never duplicated; unmatched rows
    // are added, de-duped against the incoming stream itself.
    const batchTxids = Array.from(
      new Set(
        rows.map((p) => p.txid).filter((t): t is string => typeof t === "string" && t !== ""),
      ),
    );
    const liveByMatchKey = new Map<string, TransactionParticipant>();
    const liveByExactKey = new Map<string, TransactionParticipant>();
    // FULLY-BLANK live inputs per txid: rows with only txid+role='input' (no
    // address AND no resolved prevout). They have no stable identity of their
    // own — a richer backup input carrying prevTxid/prevVout can never match
    // them by key — so without extra care the backup input is classified as
    // insert, leaving two rows for the same logical spend. Collected here (NOT
    // via liveByExactKey, which collapses all blanks for a txid onto one exact
    // key) for the ordinal-pairing pass below. Kept in load order; sorted by
    // id before pairing. Mirrors the legacy restore's ordinal-pairing block.
    const blankLiveInputsByTxid = new Map<string, TransactionParticipant[]>();
    if (batchTxids.length) {
      for (const lp of await getParticipantsByTxids(batchTxids)) {
        if (!liveByExactKey.has(participantKey(lp))) {
          liveByExactKey.set(participantKey(lp), lp);
        }
        const mk = participantMatchKey(lp);
        if (mk && !liveByMatchKey.has(mk)) liveByMatchKey.set(mk, lp);
        const addrBlank =
          lp.address === undefined || lp.address === null || String(lp.address).trim() === "";
        if (
          lp.role === "input" &&
          mk === null &&
          addrBlank &&
          typeof lp.id === "number" &&
          !this.pairedBlankLiveIds.has(lp.id)
        ) {
          const list = blankLiveInputsByTxid.get(lp.txid);
          if (list) list.push(lp);
          else blankLiveInputsByTxid.set(lp.txid, [lp]);
        }
      }
    }

    // Ordinal pairing for fully-blank live inputs: there is no persisted vin
    // index, so pairing is only safe when it is UNAMBIGUOUS — for a txid, when
    // the number of blank live inputs exactly equals the number of DISTINCT
    // backup input outpoints (in this batch) that matched no live participant
    // and were not already inserted earlier this stream, each blank row must
    // correspond to one of those spends (a tx's inputs are a fixed set — the
    // backup simply resolved what sync had not). Both sides preserve vin order
    // in practice (sync inserts inputs in vin order → ascending ids; the backup
    // stream keeps export order), so they are paired ordinally: i-th blank live
    // input (by id) ↔ i-th unmatched backup outpoint (by first appearance).
    // When the counts differ (including a txid's inputs split across batches)
    // the pairing IS ambiguous, so the backup input is inserted as before —
    // the documented, deliberate fallback.
    if (blankLiveInputsByTxid.size > 0) {
      const unmatchedBackupInputKeysByTxid = new Map<string, string[]>();
      const seenUnmatchedKeys = new Set<string>();
      for (const p of rows) {
        if (!p.txid || p.role !== "input" || !blankLiveInputsByTxid.has(p.txid)) continue;
        const mk = participantMatchKey(p);
        if (
          !mk ||
          liveByMatchKey.has(mk) ||
          seenUnmatchedKeys.has(mk) ||
          this.addedParticipantMatchKeys.has(mk)
        ) {
          continue;
        }
        seenUnmatchedKeys.add(mk);
        const list = unmatchedBackupInputKeysByTxid.get(p.txid);
        if (list) list.push(mk);
        else unmatchedBackupInputKeysByTxid.set(p.txid, [mk]);
      }
      for (const [txid, blanks] of blankLiveInputsByTxid) {
        const keys = unmatchedBackupInputKeysByTxid.get(txid);
        if (!keys || keys.length !== blanks.length) continue;
        const ordered = [...blanks].sort((a, b) => (a.id as number) - (b.id as number));
        for (let i = 0; i < keys.length; i++) {
          // Registering the blank row under the backup outpoint's match key
          // makes the loop below classify it as ENRICH (the restore fills
          // prevTxid/prevVout/address/amount/recordId) instead of insert.
          liveByMatchKey.set(keys[i], ordered[i]);
          this.pairedBlankLiveIds.add(ordered[i].id as number);
        }
      }
    }

    const decisions: ParticipantRowDecision[] = [];
    for (const p of rows) {
      const mk = participantMatchKey(p);
      const liveMatch =
        (mk ? liveByMatchKey.get(mk) : undefined) ?? liveByExactKey.get(participantKey(p));
      if (liveMatch) {
        decisions.push({ kind: "enrich", live: liveMatch });
        continue;
      }
      const k = participantKey(p);
      if (this.addedParticipantKeys.has(k)) {
        decisions.push({ kind: "duplicate" });
        continue;
      }
      this.addedParticipantKeys.add(k);
      if (mk) this.addedParticipantMatchKeys.add(mk);
      decisions.push({ kind: "insert" });
    }
    return decisions;
  }

  // blockchainTransactions ------------------------------------------------------

  // Collapses same-txid repeats within the batch, then (when `checkLive`)
  // matches each survivor against the live vault by txid. `checkLive` false =
  // replace-mode restore, where the vault was cleared first so a live
  // collision can never happen.
  async classifyTransactions(
    rows: any[],
    checkLive: boolean,
  ): Promise<TransactionBatchClassification> {
    const deduped = mergeDuplicateTransactionsByTxid(rows);
    const liveByTxid = new Map<string, any>();
    if (checkLive) {
      const batchTxids = deduped
        .map((t) => t.txid)
        .filter((t): t is string => typeof t === "string" && t !== "");
      if (batchTxids.length) {
        for (const tx of await getTransactionsByTxids(batchTxids)) {
          liveByTxid.set(tx.txid, tx);
        }
      }
    }
    const decisions: TransactionRowDecision[] = deduped.map((tx) => {
      const live = typeof tx.txid === "string" ? liveByTxid.get(tx.txid) : undefined;
      return live ? { kind: "enrich", live } : { kind: "insert" };
    });
    return { deduped, decisions };
  }

  // addressSyncState ------------------------------------------------------------

  // true = a merge inserts the row; false = skipped (blank address, address
  // already live, or repeated within the stream — the `address` index is
  // unique, so inserting a duplicate would abort the whole restore).
  async classifySyncState(rows: any[]): Promise<boolean[]> {
    if (this.existingSyncAddresses === null) {
      this.existingSyncAddresses = new Set<string>();
      for (const s of await getAllAddressSyncState()) {
        this.existingSyncAddresses.add(s.address);
      }
    }
    return rows.map((s) => {
      const address = syncStateMergeAddress(s);
      if (!address || this.existingSyncAddresses!.has(address)) return false;
      this.existingSyncAddresses!.add(address);
      return true;
    });
  }

  // utxoLineage -------------------------------------------------------------------

  // utxoLineage has no unique index, so rows whose lineageIdentity already
  // exists are skipped to avoid duplicate edges.
  async classifyLineage(rows: any[]): Promise<boolean[]> {
    if (this.existingLineageKeys === null) {
      this.existingLineageKeys = new Set<string>();
      for (const l of await getAllUtxoLineage()) {
        this.existingLineageKeys.add(lineageIdentity(l));
      }
    }
    return rows.map((d) => {
      const key = lineageIdentity(d);
      if (this.existingLineageKeys!.has(key)) return false;
      this.existingLineageKeys!.add(key);
      return true;
    });
  }

  // custodySegments -----------------------------------------------------------------

  // `segmentId` is a UNIQUE index, so already-present segments are skipped or
  // the insert would abort the restore mid-way. Rows without a string
  // segmentId can never collide, so they are always inserted.
  async classifySegments(rows: any[]): Promise<boolean[]> {
    if (this.existingSegmentIds === null) {
      this.existingSegmentIds = await getExistingSegmentIds();
    }
    return rows.map((d) => {
      const segmentId = segmentMergeId(d);
      if (segmentId !== null && this.existingSegmentIds!.has(segmentId)) return false;
      if (segmentId !== null) this.existingSegmentIds!.add(segmentId);
      return true;
    });
  }

  // lineageSnapshots ------------------------------------------------------------------

  // Unique `snapshotId`, mirroring custodySegments.
  async classifySnapshots(rows: any[]): Promise<boolean[]> {
    if (this.existingSnapshotIds === null) {
      this.existingSnapshotIds = await getExistingSnapshotIds();
    }
    return rows.map((d) => {
      const snapshotId = snapshotMergeId(d);
      if (snapshotId !== null && this.existingSnapshotIds!.has(snapshotId)) return false;
      if (snapshotId !== null) this.existingSnapshotIds!.add(snapshotId);
      return true;
    });
  }
}

// Shared helpers for the LEGACY (pre-v3) backup restore path. SettingsPage's
// `handleRestore` used to inline ~250 lines of restore logic for the high-risk,
// id-remapping tables (records, attachments, blockchain transactions +
// participants, address sync state). That inline code was exercised by no
// automated test, so a regression in the merge-vs-replace de-duplication or the
// recordId remapping would have gone unnoticed.
//
// These helpers extract that logic verbatim (same de-dup keys, same field
// defaults, same id remapping) so the real restore path can be unit-tested over
// the live `@/lib/database` schema via fake-indexeddb, mirroring the v3
// round-trip tests. Behaviour MUST stay identical to the original inline code:
//   - records de-dup by `inputString` (merge mode), fresh autoincrement ids,
//     backup id -> live id recorded in `recordIdMap` for dependent rows.
//   - attachments de-dup by `objectStoragePath` (falling back to
//     `recordId:filename`); orphans (owning record absent) are dropped.
//   - transactions de-dup by `txid`; participants only added for transactions
//     actually inserted; both remap `recordId` through `recordIdMap`.
//   - addressSyncState de-dup by the unique `address` index (existing + within
//     the incoming set); `recordId` remapped.
// Every write goes through the table's CRUD module (CRUD-guard compliant).

import {
  bulkCreateRecords,
  bulkSetDiscoveredFromRecordId,
  getRecordsByInputStrings,
  type CreateRecordData,
} from "@/lib/data/record-crud";
import {
  addAttachment,
  getAllAttachments,
  type CreateAttachmentData,
} from "@/lib/data/attachments-crud";
import {
  bulkAddTransactions,
  bulkAddParticipants,
  bulkPutParticipants,
  updateTransaction,
  getTransactionsByTxids,
  getParticipantsByTxids,
  type CreateTransactionData,
} from "@/lib/data/transaction-crud";
import type { TransactionParticipant } from "@/lib/database";
import {
  bulkAddAddressSyncState,
  getAllAddressSyncState,
  type CreateAddressSyncStateData,
} from "@/lib/data/address-sync-crud";

export type RestoreMode = "merge" | "replace";

/**
 * Rewrite a backup recordId to the live id assigned during restore. Dependent
 * rows (attachments, participants, address sync state) call this so they link to
 * the restored record instead of a stale backup id. Returns `undefined` when the
 * id is missing or the owning record was not restored.
 */
export function remapRecordId(
  recordIdMap: Map<number, number>,
  oldId: number | undefined | null,
): number | undefined {
  return oldId === undefined || oldId === null ? undefined : recordIdMap.get(oldId);
}

/**
 * Restore the `records` table. In merge mode, records whose `inputString`
 * already exists are skipped (and their backup id is mapped to the existing live
 * id so dependent rows still link correctly). New records get fresh
 * autoincrement ids via `bulkCreateRecords`; the backup id -> new id mapping is
 * recorded into `recordIdMap` for later dependent-row remapping.
 */
export async function restoreLegacyRecords(
  records: any[] | undefined,
  restoreMode: RestoreMode,
  recordIdMap: Map<number, number>,
): Promise<{ recordsAdded: number; recordsSkipped: number }> {
  let recordsAdded = 0;
  let recordsSkipped = 0;
  if (!records || records.length === 0) return { recordsAdded, recordsSkipped };

  const existingByInputString = new Map<string, number>();
  if (restoreMode === "merge") {
    const backupInputStrings: string[] = [];
    for (const rec of records) {
      if (rec.inputString) backupInputStrings.push(rec.inputString);
    }
    const MERGE_BATCH = 500;
    for (let i = 0; i < backupInputStrings.length; i += MERGE_BATCH) {
      const batch = backupInputStrings.slice(i, i + MERGE_BATCH);
      const found = await getRecordsByInputStrings(batch);
      for (const r of found) {
        if (typeof r.id === "number") existingByInputString.set(r.inputString, r.id);
      }
    }
  }

  const recordsToCreate: CreateRecordData[] = [];
  const oldIdsForCreate: Array<number | undefined> = [];
  // Backup-id discovery targets for the records we create, index-aligned with
  // recordsToCreate. `discoveredFromRecordId` is deliberately NOT copied into
  // the insert payload — it is re-pointed through `recordIdMap` after the map
  // is complete, and stays cleared when the target record is absent from the
  // backup, so a restored pointer can never dangle or hit an unrelated record
  // that reuses the old auto-increment id (mirrors the v3 restore path).
  const oldDiscoveryTargets: Array<number | undefined> = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const { id, ...recordData } = record;

    if (restoreMode === "merge" && existingByInputString.has(recordData.inputString)) {
      // Record already present: link dependent rows to the existing one.
      if (typeof id === "number") {
        recordIdMap.set(id, existingByInputString.get(recordData.inputString)!);
      }
      recordsSkipped++;
      continue;
    }

    recordsToCreate.push({
      type: recordData.type || "address",
      inputString: recordData.inputString || "",
      label: recordData.label || "Restored Record",
      notes: recordData.notes,
      amount: recordData.amount,
      date: recordData.date,
      tags: recordData.tags || [],
      categories: recordData.categories || [],
      chainType: recordData.chainType,
      seedName: recordData.seedName,
      walletSoftware: recordData.walletSoftware,
      privateKeyStatus: recordData.privateKeyStatus,
      owner: recordData.owner,
      walletName: recordData.walletName,
      source: recordData.source,
      customFields: recordData.customFields,
      addressImportance: recordData.addressImportance,
      syncDepth: recordData.syncDepth,
      xpub: recordData.xpub,
      derivationPath: recordData.derivationPath,
      createdAt: recordData.createdAt || Date.now(),
      updatedAt: recordData.updatedAt || Date.now(),
    } as CreateRecordData);
    oldIdsForCreate.push(typeof id === "number" ? id : undefined);
    oldDiscoveryTargets.push(
      typeof recordData.discoveredFromRecordId === "number"
        ? recordData.discoveredFromRecordId
        : undefined,
    );
  }

  if (recordsToCreate.length > 0) {
    const newRecordIds = await bulkCreateRecords(recordsToCreate, {
      skipNotification: true,
      skipVocabularySync: true,
    });
    for (let j = 0; j < newRecordIds.length; j++) {
      const oldId = oldIdsForCreate[j];
      if (typeof oldId === "number") recordIdMap.set(oldId, newRecordIds[j]);
    }
    recordsAdded = recordsToCreate.length;

    // Re-point discoveredFromRecordId through the now-complete recordIdMap
    // (covers both created and merge-skipped source records). Targets absent
    // from the backup stay cleared — the field was never inserted — so no
    // dangling or colliding pointer can reach the vault. Only rows THIS
    // restore inserted are touched; live records are never rewritten.
    const BATCH = 500;
    let batch: Array<{ id: number; discoveredFromRecordId: number }> = [];
    for (let j = 0; j < newRecordIds.length; j++) {
      const target = oldDiscoveryTargets[j];
      if (target === undefined) continue;
      const mapped = recordIdMap.get(target);
      if (mapped === undefined || mapped === newRecordIds[j]) continue;
      batch.push({ id: newRecordIds[j], discoveredFromRecordId: mapped });
      if (batch.length >= BATCH) {
        await bulkSetDiscoveredFromRecordId(batch, { skipNotification: true });
        batch = [];
      }
    }
    if (batch.length > 0) {
      await bulkSetDiscoveredFromRecordId(batch, { skipNotification: true });
    }
  }

  return { recordsAdded, recordsSkipped };
}

export interface LegacyAttachmentsResult {
  /** Number of attachment DB rows successfully linked to a live record. */
  attachmentsAdded: number;
  /**
   * Attachment files whose owning record was absent (never restored). Maps
   * `objectStoragePath` (the ZIP entry relPath) → original filename. Callers
   * should route these bytes to the Needs Review folder instead of the normal
   * attachment pool, and never link them to any record.
   */
  orphanedRelPaths: Map<string, string>;
}

/**
 * Restore attachment metadata rows. Each attachment requires a live record, so
 * its backup `recordId` is rewritten through `recordIdMap`; orphans (owning
 * record absent) are tracked in the returned map instead of silently dropped.
 * In merge mode, identity is keyed by `objectStoragePath` (sha256-derived,
 * unique per stored file), falling back to `recordId:filename` so duplicates
 * are not re-added.
 */
export async function restoreLegacyAttachments(
  attachments: any[] | undefined,
  restoreMode: RestoreMode,
  recordIdMap: Map<number, number>,
): Promise<LegacyAttachmentsResult> {
  const orphanedRelPaths = new Map<string, string>();
  let attachmentsAdded = 0;
  if (!attachments || attachments.length === 0) {
    return { attachmentsAdded, orphanedRelPaths };
  }

  const existingAttachmentKeys = new Set<string>();
  if (restoreMode === "merge") {
    const existingAttachments = await getAllAttachments();
    for (const att of existingAttachments) {
      const key = att.objectStoragePath || `${att.recordId}:${att.filename}`;
      existingAttachmentKeys.add(key);
    }
  }

  for (const attachment of attachments) {
    const { id, ...attData } = attachment;
    const mappedRecordId = remapRecordId(recordIdMap, attData.recordId);
    if (mappedRecordId === undefined) {
      // Orphan: owning record absent. Record the relPath → filename so callers
      // can route the file bytes to the Needs Review folder.
      if (attData.objectStoragePath) {
        orphanedRelPaths.set(
          String(attData.objectStoragePath),
          String(attData.filename || "unknown"),
        );
      }
      continue;
    }
    const attKey = attData.objectStoragePath || `${mappedRecordId}:${attData.filename}`;

    if (restoreMode === "merge" && existingAttachmentKeys.has(attKey)) {
      continue;
    }

    const newAttachment: CreateAttachmentData = {
      recordId: mappedRecordId,
      filename: attData.filename || "unknown",
      mimeType: attData.mimeType || "application/octet-stream",
      size: attData.size || 0,
      objectStoragePath: attData.objectStoragePath || "",
      createdAt: attData.createdAt || Date.now(),
    };

    await addAttachment(newAttachment, { skipNotification: true });
    existingAttachmentKeys.add(attKey);
    attachmentsAdded++;
  }

  return { attachmentsAdded, orphanedRelPaths };
}

/**
 * Build a stable de-dup key for a participant so the same logical input/output
 * is never stored twice for a transaction. Keyed by `txid+role+address+vout`
 * (vout uniquely identifies an output; for inputs it is normally undefined, so
 * address+role disambiguate). The id is deliberately excluded — backup and live
 * rows for the same participant carry different autoincrement ids.
 */
export function participantKey(p: {
  txid?: string;
  role?: string;
  address?: string;
  vout?: number | null;
}): string {
  return `${p.txid ?? ""}|${p.role ?? ""}|${p.address ?? ""}|${p.vout ?? ""}`;
}

/**
 * Build a *resolution-independent* identity key for a participant, used to match a
 * backup participant to its existing live counterpart even when address-level
 * details differ (e.g. a live input whose address is still blank vs. the backup
 * input whose prevout has been resolved to an address). Unlike
 * {@link participantKey}, this deliberately excludes the enrichable fields
 * (address/amount/recordId):
 *   - an OUTPUT is identified by its `vout` (unique within a tx),
 *   - an INPUT is identified by the outpoint it spends (`prevTxid:prevVout`).
 * Returns `null` when no stable identity is available (an output without a vout,
 * or an input without a resolved prevout) — those fall back to
 * {@link participantKey} matching instead.
 */
export function participantMatchKey(p: {
  txid?: string;
  role?: string;
  vout?: number | null;
  prevTxid?: string | null;
  prevVout?: number | null;
}): string | null {
  if (!p.txid) return null;
  if (p.role === "output") {
    return typeof p.vout === "number" ? `o|${p.txid}|${p.vout}` : null;
  }
  if (p.role === "input") {
    if (p.prevTxid && typeof p.prevVout === "number") {
      return `i|${p.txid}|${p.prevTxid}|${p.prevVout}`;
    }
    return null;
  }
  return null;
}

/**
 * Compute the fields to fill on a live participant row from a richer backup
 * participant for the SAME logical input/output (merge mode). Mirrors
 * {@link computeTransactionEnrichment}: only fields that are missing/empty on the
 * live row are returned; any field already populated on the live row is omitted so
 * it is never overwritten. `txid`, `role`, `vout`, and `id` are never touched.
 *
 * The backup's `recordId` MUST already be remapped through `recordIdMap` by the
 * caller (this is a pure comparison of resolved values). Fields considered:
 *   - `address`: missing when undefined/null/blank; filled from a non-blank backup
 *     string (this is the prevout address sync had not yet resolved).
 *   - `amount`: a `0` is treated as the not-yet-known placeholder, so it is filled
 *     from a non-zero backup number (a genuine 0-value output stays 0 because the
 *     backup's value is 0 too).
 *   - `prevTxid`: missing when undefined/null/blank; filled from a non-blank backup
 *     string.
 *   - `prevVout`: `0` is a legitimate vout, so missing only when undefined/null;
 *     filled from any defined backup number.
 *   - `recordId`: missing when undefined/null; filled from any defined backup
 *     number (already remapped).
 */
export function computeParticipantEnrichment(
  live: Record<string, any>,
  backup: Record<string, any>,
): Partial<TransactionParticipant> {
  const changes: Record<string, any> = {};

  const liveAddr = live.address;
  const backupAddr = backup.address;
  const liveAddrMissing =
    liveAddr === undefined || liveAddr === null || String(liveAddr).trim() === "";
  if (liveAddrMissing && typeof backupAddr === "string" && backupAddr.trim() !== "") {
    changes.address = backupAddr;
  }

  const liveAmount = live.amount;
  const backupAmount = backup.amount;
  const liveAmountMissing =
    liveAmount === undefined || liveAmount === null || liveAmount === 0;
  if (liveAmountMissing && typeof backupAmount === "number" && backupAmount !== 0) {
    changes.amount = backupAmount;
  }

  const livePrevTxid = live.prevTxid;
  const backupPrevTxid = backup.prevTxid;
  const livePrevTxidMissing =
    livePrevTxid === undefined || livePrevTxid === null || String(livePrevTxid).trim() === "";
  if (
    livePrevTxidMissing &&
    typeof backupPrevTxid === "string" &&
    backupPrevTxid.trim() !== ""
  ) {
    changes.prevTxid = backupPrevTxid;
  }

  const livePrevVout = live.prevVout;
  const backupPrevVout = backup.prevVout;
  const livePrevVoutMissing = livePrevVout === undefined || livePrevVout === null;
  if (livePrevVoutMissing && typeof backupPrevVout === "number") {
    changes.prevVout = backupPrevVout;
  }

  const liveRecordId = live.recordId;
  const backupRecordId = backup.recordId;
  const liveRecordIdMissing = liveRecordId === undefined || liveRecordId === null;
  if (liveRecordIdMissing && typeof backupRecordId === "number") {
    changes.recordId = backupRecordId;
  }

  return changes as Partial<TransactionParticipant>;
}

/**
 * Numeric transaction fields where a value of `0` means "not known yet" — the
 * placeholder blockchain sync writes before it has resolved the real value
 * (e.g. an unconfirmed tx synced with `blockHeight`/`blockTime`/`fee` still 0).
 * For these, the live row is treated as missing when undefined/null/0, and is
 * filled only from a backup value that is itself a meaningful (non-zero) number.
 */
const ENRICH_ZERO_PLACEHOLDER_FIELDS = [
  "blockHeight",
  "blockTime",
  "fee",
  "feeRate",
  "syncedAt",
  "size",
  "weight",
  "vsize",
] as const;

/**
 * Numeric fields where `0` is a legitimate value (e.g. `nLockTime` 0 = "no
 * lock"), so the live row only counts as missing when undefined/null. Filled
 * from any defined backup number.
 */
const ENRICH_NULLABLE_NUMERIC_FIELDS = ["nVersion", "nLockTime"] as const;

/**
 * Boolean fingerprint/flag fields. `false` is a real, known value, so the live
 * row is missing only when undefined/null; filled from any defined backup
 * boolean.
 */
const ENRICH_BOOLEAN_FIELDS = [
  "hasOpReturn",
  "rawFingerprintCaptured",
  "hasRbf",
  "isBip69Ordered",
  "hasLowRSig",
  "hasWitness",
  "hasMixedWitness",
  "hasCoinbaseInput",
] as const;

/**
 * Compute the fields to fill on a live transaction row from a richer backup row
 * for the SAME txid (merge mode). Only fields that are missing/empty/placeholder
 * on the live row are returned; any field already populated on the live row is
 * omitted so it is never overwritten. `txid` and `id` are never touched. Returns
 * an empty object when the live row already has everything the backup could add.
 */
export function computeTransactionEnrichment(
  live: Record<string, any>,
  backup: Record<string, any>,
): Partial<CreateTransactionData> {
  const changes: Record<string, any> = {};

  for (const field of ENRICH_ZERO_PLACEHOLDER_FIELDS) {
    const liveVal = live[field];
    const backupVal = backup[field];
    const liveMissing = liveVal === undefined || liveVal === null || liveVal === 0;
    if (liveMissing && typeof backupVal === "number" && backupVal !== 0) {
      changes[field] = backupVal;
    }
  }

  for (const field of ENRICH_NULLABLE_NUMERIC_FIELDS) {
    const liveVal = live[field];
    const backupVal = backup[field];
    const liveMissing = liveVal === undefined || liveVal === null;
    if (liveMissing && typeof backupVal === "number") {
      changes[field] = backupVal;
    }
  }

  for (const field of ENRICH_BOOLEAN_FIELDS) {
    const liveVal = live[field];
    const backupVal = backup[field];
    const liveMissing = liveVal === undefined || liveVal === null;
    if (liveMissing && typeof backupVal === "boolean") {
      changes[field] = backupVal;
    }
  }

  // opReturnData is an array; the live row is missing when undefined/null/empty.
  const liveOpReturn = live.opReturnData;
  const backupOpReturn = backup.opReturnData;
  const liveOpReturnMissing =
    liveOpReturn === undefined ||
    liveOpReturn === null ||
    (Array.isArray(liveOpReturn) && liveOpReturn.length === 0);
  if (liveOpReturnMissing && Array.isArray(backupOpReturn) && backupOpReturn.length > 0) {
    changes.opReturnData = backupOpReturn;
  }

  return changes as Partial<CreateTransactionData>;
}

/**
 * Collapse duplicate-`txid` rows within a single incoming set into one row per
 * txid, keeping the RICHEST combination: the first occurrence is kept and any
 * field it is missing/empty/placeholder for is filled from later occurrences via
 * {@link computeTransactionEnrichment}. Already-populated fields on the kept row
 * are never overwritten. Rows without a usable `txid` are passed through
 * unchanged (they cannot be de-duped). The first occurrence's position is
 * preserved.
 *
 * A backup exported from KYUTXO's unique-`txid` table never contains duplicate
 * txids, so in practice this is a no-op pass-through. It exists so that a
 * malformed/hand-edited backup carrying the same txid twice (e.g. one
 * placeholder row and one resolved row) neither loses the richer row to a
 * first-wins drop nor crashes on the unique-`txid` constraint when bulk-inserted
 * (the same data-loss class fixed for the live-collision merge path).
 */
export function mergeDuplicateTransactionsByTxid<T extends Record<string, any>>(
  rows: T[],
): T[] {
  const result: T[] = [];
  const indexByTxid = new Map<string, number>();
  for (const row of rows) {
    const txid = row?.txid;
    if (typeof txid !== "string" || txid === "") {
      result.push(row);
      continue;
    }
    const existingIdx = indexByTxid.get(txid);
    if (existingIdx === undefined) {
      indexByTxid.set(txid, result.length);
      result.push(row);
      continue;
    }
    const kept = result[existingIdx];
    const changes = computeTransactionEnrichment(kept, row);
    if (Object.keys(changes).length > 0) {
      result[existingIdx] = { ...kept, ...changes };
    }
  }
  return result;
}

/**
 * Restore confirmed blockchain transactions and their input/output
 * participants. Transactions are de-duped by `txid` (existing rows in merge
 * mode, and within the incoming set in both modes).
 *
 * For a txid that collides with an existing row (merge mode), the live
 * transaction row itself is NOT replaced — but fields that are
 * missing/empty/placeholder on the live row (e.g. `blockHeight` 0, missing
 * `fee`/`feeRate`/`blockTime`) ARE filled in from the richer backup row via
 * {@link computeTransactionEnrichment}. Fields already populated on the live row
 * are never overwritten.
 *
 * Participants are added for transactions actually inserted AND — in merge mode
 * — reconciled against transactions that already existed (collided by `txid`): a
 * backup may carry richer participant data the live row lacks (resolved input
 * prevouts, addresses, amounts, or `recordId` links). For each collided txid each
 * backup participant is matched to its existing live counterpart (by outpoint for
 * inputs / vout for outputs, falling back to the full `txid+role+address+vout`
 * key); a match ENRICHES the live participant's missing/empty fields (address,
 * amount, prevTxid, prevVout, recordId) via {@link computeParticipantEnrichment}
 * — never overwriting a populated field — while an unmatched backup participant is
 * added. Existing live participants are never duplicated. All participants'
 * `recordId` is remapped through `recordIdMap`.
 *
 * FULLY-BLANK live inputs (only txid+role='input' — no address, no resolved
 * prevout) have no key-based identity. When, for a collided txid, the number of
 * such blank rows exactly equals the number of distinct backup input outpoints
 * that matched nothing, they are paired ordinally (blank rows by id ↔ backup
 * outpoints by first appearance) and enriched instead of duplicated; when the
 * counts differ the pairing is ambiguous and the backup input is added as
 * before (see the ordinal-pairing block inside).
 */
export async function restoreLegacyTransactions(
  blockchainTransactions: any[] | undefined,
  transactionParticipants: any[] | undefined,
  restoreMode: RestoreMode,
  recordIdMap: Map<number, number>,
): Promise<{
  transactionsAdded: number;
  participantsAdded: number;
  transactionsEnriched: number;
  participantsEnriched: number;
}> {
  let transactionsAdded = 0;
  let participantsAdded = 0;
  let transactionsEnriched = 0;
  let participantsEnriched = 0;

  const restoredTxids = new Set<string>();
  // Txids present in the backup that already exist in the vault (merge mode).
  // Their transaction row is kept as-is, but missing fields are filled from the
  // backup row and their participants are merged in. Maps txid -> live row so we
  // can enrich without reloading.
  const collidedTxids = new Set<string>();
  const existingTxRowsByTxid = new Map<string, any>();
  if (blockchainTransactions && blockchainTransactions.length > 0) {
    const existingTxids = new Set<string>();
    if (restoreMode === "merge") {
      const incomingTxids = blockchainTransactions
        .map((t: any) => t.txid)
        .filter((t: any) => typeof t === "string");
      const TX_MERGE_BATCH = 500;
      for (let i = 0; i < incomingTxids.length; i += TX_MERGE_BATCH) {
        const found = await getTransactionsByTxids(incomingTxids.slice(i, i + TX_MERGE_BATCH));
        for (const tx of found) {
          existingTxids.add(tx.txid);
          existingTxRowsByTxid.set(tx.txid, tx);
        }
      }
    }

    // Split the incoming rows into those that collide with an existing live row
    // (merge mode only — `existingTxids` is empty otherwise) and the genuinely
    // new ones. Each group is de-duped within itself by `txid` via enrichment so
    // a backup carrying the same txid twice (one placeholder, one resolved) keeps
    // the richest combination instead of dropping the richer row or crashing on
    // the unique-`txid` constraint when inserted (covers replace mode, which has
    // no live collisions but previously kept only the first incoming row).
    const collidedBackupRows: any[] = [];
    const newBackupRows: any[] = [];
    for (const tx of blockchainTransactions) {
      if (!tx.txid) continue;
      if (existingTxids.has(tx.txid)) {
        collidedTxids.add(tx.txid);
        collidedBackupRows.push(tx);
      } else {
        newBackupRows.push(tx);
      }
    }

    const txToAdd: CreateTransactionData[] = [];
    for (const tx of mergeDuplicateTransactionsByTxid(newBackupRows)) {
      const { id, ...txData } = tx;
      txToAdd.push(txData as CreateTransactionData);
      restoredTxids.add(tx.txid);
    }
    await bulkAddTransactions(txToAdd, { skipNotification: true });
    transactionsAdded = txToAdd.length;

    // Richest backup row per collided txid (combines any duplicate backup rows
    // for that txid) drives the live-row enrichment below.
    const backupRowByCollidedTxid = new Map<string, any>();
    for (const tx of mergeDuplicateTransactionsByTxid(collidedBackupRows)) {
      backupRowByCollidedTxid.set(tx.txid, tx);
    }

    // Fill missing/placeholder fields on each collided live row from its backup
    // row. Already-populated live fields are left untouched.
    for (const [txid, backupRow] of backupRowByCollidedTxid) {
      const liveRow = existingTxRowsByTxid.get(txid);
      if (!liveRow || typeof liveRow.id !== "number") continue;
      const changes = computeTransactionEnrichment(liveRow, backupRow);
      if (Object.keys(changes).length === 0) continue;
      await updateTransaction(liveRow.id, changes, { skipNotification: true });
      transactionsEnriched++;
    }
  }

  if (transactionParticipants && transactionParticipants.length > 0) {
    // Pre-existing live participants for collided txids, so we can (a) skip backup
    // participants the live row already has, and (b) ENRICH an existing live
    // participant whose details the backup resolved. Loaded once, in batches, and
    // indexed two ways:
    //   - `liveByMatchKey`: by the resolution-independent identity (outpoint for
    //     inputs, vout for outputs) so a blank-address live input still matches the
    //     backup input whose address/amount/recordId was resolved.
    //   - `liveByExactKey`: by the full stable key, the fallback identity for
    //     participants that have no stable match key (an output without a vout, an
    //     input without a resolved prevout) — preserving the original add-if-absent
    //     de-dup so the same backup never doubles a row.
    const liveByMatchKey = new Map<string, TransactionParticipant>();
    const liveByExactKey = new Map<string, TransactionParticipant>();
    // FULLY-BLANK live inputs per collided txid: rows with only txid+role='input'
    // (no address AND no resolved prevout). They have no stable identity of their
    // own — a richer backup input carrying prevTxid/prevVout can never match them
    // by key — so without extra care the backup input is ADDED, leaving two rows
    // for the same logical spend. Collected here (NOT via liveByExactKey, which
    // collapses all blanks for a txid onto one exact key) for the ordinal-pairing
    // pass below. Kept in load order; sorted by id before pairing.
    const blankLiveInputsByTxid = new Map<string, TransactionParticipant[]>();
    if (collidedTxids.size > 0) {
      const collidedArr = Array.from(collidedTxids);
      const PARTICIPANT_BATCH = 500;
      for (let i = 0; i < collidedArr.length; i += PARTICIPANT_BATCH) {
        const live = await getParticipantsByTxids(collidedArr.slice(i, i + PARTICIPANT_BATCH));
        for (const lp of live) {
          if (!liveByExactKey.has(participantKey(lp))) liveByExactKey.set(participantKey(lp), lp);
          const mk = participantMatchKey(lp);
          if (mk && !liveByMatchKey.has(mk)) liveByMatchKey.set(mk, lp);
          const addrBlank =
            lp.address === undefined || lp.address === null || String(lp.address).trim() === "";
          if (lp.role === "input" && mk === null && addrBlank && typeof lp.id === "number") {
            const list = blankLiveInputsByTxid.get(lp.txid);
            if (list) list.push(lp);
            else blankLiveInputsByTxid.set(lp.txid, [lp]);
          }
        }
      }
    }

    // Ordinal pairing for fully-blank live inputs (task: a restored backup that
    // resolves an outpoint the live row never knew must ENRICH, not duplicate).
    // There is no persisted vin index, so pairing is only safe when it is
    // UNAMBIGUOUS: for a collided txid, when the number of blank live inputs
    // exactly equals the number of DISTINCT backup input outpoints that matched
    // no live participant, each blank row must correspond to one of those spends
    // (a tx's inputs are a fixed set — the backup simply resolved what sync had
    // not). Both sides preserve vin order in practice (sync inserts inputs in
    // vin order → ascending ids; the backup array keeps its export order), so
    // they are paired ordinally: i-th blank live input (by id) ↔ i-th unmatched
    // backup outpoint (by first appearance). Even if the relative order ever
    // differed, every pairing still maps a real spend of this tx onto a blank
    // placeholder row of the same tx, so no wrong data can be attached — only,
    // at worst, to a sibling placeholder. When the counts differ the pairing IS
    // ambiguous (e.g. some blanks belong to spends the backup doesn't carry),
    // so those rows stay unmatched and the backup input is added as before —
    // the documented, deliberate fallback.
    if (blankLiveInputsByTxid.size > 0) {
      const unmatchedBackupInputKeysByTxid = new Map<string, string[]>();
      const seenUnmatchedKeys = new Set<string>();
      for (const p of transactionParticipants) {
        if (!p.txid || p.role !== "input" || !blankLiveInputsByTxid.has(p.txid)) continue;
        const mk = participantMatchKey(p);
        if (!mk || liveByMatchKey.has(mk) || seenUnmatchedKeys.has(mk)) continue;
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
          // makes the main loop below find and ENRICH it (filling prevTxid/
          // prevVout/address/amount/recordId) instead of adding a duplicate.
          liveByMatchKey.set(keys[i], ordered[i]);
        }
      }
    }

    // Track keys added during this restore so the incoming set never duplicates
    // itself (covers both freshly inserted and merged-into transactions).
    const addedKeys = new Set<string>();
    const participantsToAdd = [];
    // Live participants enriched in place (keyed by live id so the same row is
    // only enriched once even if several backup rows would touch it).
    const participantsToEnrichById = new Map<number, TransactionParticipant>();
    for (const p of transactionParticipants) {
      if (!p.txid) continue;
      const isNew = restoredTxids.has(p.txid);
      const isCollision = collidedTxids.has(p.txid);
      if (!isNew && !isCollision) continue;

      const remappedRecordId = remapRecordId(recordIdMap, p.recordId);

      if (isCollision) {
        // Find the existing live participant this backup row corresponds to:
        // prefer the resolution-independent match key, fall back to the exact key.
        const mk = participantMatchKey(p);
        const liveMatch =
          (mk ? liveByMatchKey.get(mk) : undefined) ?? liveByExactKey.get(participantKey(p));
        if (liveMatch && typeof liveMatch.id === "number") {
          // Matched an existing live participant: enrich its missing/empty fields
          // from the backup (never overwrite populated fields), and never add a
          // duplicate row for it.
          const existing = participantsToEnrichById.get(liveMatch.id) ?? liveMatch;
          const changes = computeParticipantEnrichment(existing, {
            ...p,
            recordId: remappedRecordId,
          });
          if (Object.keys(changes).length > 0) {
            participantsToEnrichById.set(liveMatch.id, { ...existing, ...changes });
          }
          continue;
        }
        // No existing live participant matched: fall through to add it (de-duping
        // the incoming set against itself by exact key).
      }

      const key = participantKey(p);
      if (addedKeys.has(key)) continue;
      addedKeys.add(key);

      const { id, ...pData } = p;
      participantsToAdd.push({
        ...pData,
        recordId: remappedRecordId,
      });
    }
    await bulkAddParticipants(participantsToAdd, { skipNotification: true });
    participantsAdded = participantsToAdd.length;

    if (participantsToEnrichById.size > 0) {
      await bulkPutParticipants(Array.from(participantsToEnrichById.values()), {
        skipNotification: true,
      });
      participantsEnriched = participantsToEnrichById.size;
    }
  }

  return { transactionsAdded, participantsAdded, transactionsEnriched, participantsEnriched };
}

/**
 * Restore per-address sync state. The `address` index is unique, so duplicates
 * would throw: addresses already present (merge mode) are skipped, and the
 * incoming set is de-duped against itself in both modes. Each row's `recordId`
 * is remapped through `recordIdMap`.
 */
export async function restoreLegacyAddressSyncState(
  addressSyncState: any[] | undefined,
  restoreMode: RestoreMode,
  recordIdMap: Map<number, number>,
): Promise<number> {
  if (!addressSyncState || addressSyncState.length === 0) return 0;

  const existingAddresses = new Set<string>();
  if (restoreMode === "merge") {
    const existing = await getAllAddressSyncState();
    for (const s of existing) existingAddresses.add(s.address);
  }
  const seenAddresses = new Set<string>();
  const syncToAdd: CreateAddressSyncStateData[] = [];
  for (const s of addressSyncState) {
    if (!s.address || existingAddresses.has(s.address) || seenAddresses.has(s.address)) continue;
    const { id, ...sData } = s;
    syncToAdd.push({
      ...sData,
      recordId: remapRecordId(recordIdMap, sData.recordId),
    } as CreateAddressSyncStateData);
    seenAddresses.add(s.address);
  }
  await bulkAddAddressSyncState(syncToAdd, { skipNotification: true });
  return syncToAdd.length;
}

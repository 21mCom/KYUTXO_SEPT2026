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
  updateTransaction,
  getTransactionsByTxids,
  getParticipantsByTxids,
  type CreateTransactionData,
} from "@/lib/data/transaction-crud";
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
function participantKey(p: {
  txid?: string;
  role?: string;
  address?: string;
  vout?: number | null;
}): string {
  return `${p.txid ?? ""}|${p.role ?? ""}|${p.address ?? ""}|${p.vout ?? ""}`;
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
 * — merged into transactions that already existed (collided by `txid`): a backup
 * may carry richer participant data the live row lacks (resolved input prevouts,
 * addresses, amounts, or `recordId` links). For each collided txid, backup
 * participants whose stable key (`txid+role+address+vout`) is not already present
 * on the live row are added; existing live participants are never duplicated. All
 * participants' `recordId` is remapped through `recordIdMap`.
 */
export async function restoreLegacyTransactions(
  blockchainTransactions: any[] | undefined,
  transactionParticipants: any[] | undefined,
  restoreMode: RestoreMode,
  recordIdMap: Map<number, number>,
): Promise<{ transactionsAdded: number; participantsAdded: number; transactionsEnriched: number }> {
  let transactionsAdded = 0;
  let participantsAdded = 0;
  let transactionsEnriched = 0;

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

    const txToAdd: CreateTransactionData[] = [];
    // Keep the LAST backup row per collided txid (matches the de-dup rule that a
    // later incoming row wins) so its richer fields drive enrichment.
    const backupRowByCollidedTxid = new Map<string, any>();
    for (const tx of blockchainTransactions) {
      if (!tx.txid) continue;
      if (existingTxids.has(tx.txid)) {
        collidedTxids.add(tx.txid);
        backupRowByCollidedTxid.set(tx.txid, tx);
        continue;
      }
      if (restoredTxids.has(tx.txid)) continue;
      const { id, ...txData } = tx;
      txToAdd.push(txData as CreateTransactionData);
      restoredTxids.add(tx.txid);
    }
    await bulkAddTransactions(txToAdd, { skipNotification: true });
    transactionsAdded = txToAdd.length;

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
    // Pre-existing live participants for collided txids, so we can skip backup
    // participants that already exist and only merge in the genuinely missing
    // ones. Loaded once, in batches, keyed by the stable participant key.
    const existingParticipantKeys = new Set<string>();
    if (collidedTxids.size > 0) {
      const collidedArr = Array.from(collidedTxids);
      const PARTICIPANT_BATCH = 500;
      for (let i = 0; i < collidedArr.length; i += PARTICIPANT_BATCH) {
        const live = await getParticipantsByTxids(collidedArr.slice(i, i + PARTICIPANT_BATCH));
        for (const lp of live) existingParticipantKeys.add(participantKey(lp));
      }
    }

    // Track keys added during this restore so the incoming set never duplicates
    // itself (covers both freshly inserted and merged-into transactions).
    const addedKeys = new Set<string>();
    const participantsToAdd = [];
    for (const p of transactionParticipants) {
      if (!p.txid) continue;
      const isNew = restoredTxids.has(p.txid);
      const isCollision = collidedTxids.has(p.txid);
      if (!isNew && !isCollision) continue;

      const key = participantKey(p);
      // For collided txids, never re-add a participant the live row already has.
      if (isCollision && existingParticipantKeys.has(key)) continue;
      if (addedKeys.has(key)) continue;
      addedKeys.add(key);

      const { id, ...pData } = p;
      participantsToAdd.push({
        ...pData,
        recordId: remapRecordId(recordIdMap, pData.recordId),
      });
    }
    await bulkAddParticipants(participantsToAdd, { skipNotification: true });
    participantsAdded = participantsToAdd.length;
  }

  return { transactionsAdded, participantsAdded, transactionsEnriched };
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

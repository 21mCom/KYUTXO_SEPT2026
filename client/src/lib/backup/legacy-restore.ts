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
  getTransactionsByTxids,
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

/**
 * Restore attachment metadata rows. Each attachment requires a live record, so
 * its backup `recordId` is rewritten through `recordIdMap`; orphans (owning
 * record absent) are dropped rather than left dangling. In merge mode, identity
 * is keyed by `objectStoragePath` (sha256-derived, unique per stored file),
 * falling back to `recordId:filename` so duplicates are not re-added.
 */
export async function restoreLegacyAttachments(
  attachments: any[] | undefined,
  restoreMode: RestoreMode,
  recordIdMap: Map<number, number>,
): Promise<number> {
  let attachmentsAdded = 0;
  if (!attachments || attachments.length === 0) return attachmentsAdded;

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

  return attachmentsAdded;
}

/**
 * Restore confirmed blockchain transactions and their input/output
 * participants. Transactions are de-duped by `txid` (existing rows in merge
 * mode, and within the incoming set in both modes). Participants are only added
 * for transactions actually inserted — so merge mode never duplicates
 * participants for transactions that already existed — and their `recordId` is
 * remapped through `recordIdMap`.
 */
export async function restoreLegacyTransactions(
  blockchainTransactions: any[] | undefined,
  transactionParticipants: any[] | undefined,
  restoreMode: RestoreMode,
  recordIdMap: Map<number, number>,
): Promise<{ transactionsAdded: number; participantsAdded: number }> {
  let transactionsAdded = 0;
  let participantsAdded = 0;

  const restoredTxids = new Set<string>();
  if (blockchainTransactions && blockchainTransactions.length > 0) {
    const existingTxids = new Set<string>();
    if (restoreMode === "merge") {
      const incomingTxids = blockchainTransactions
        .map((t: any) => t.txid)
        .filter((t: any) => typeof t === "string");
      const TX_MERGE_BATCH = 500;
      for (let i = 0; i < incomingTxids.length; i += TX_MERGE_BATCH) {
        const found = await getTransactionsByTxids(incomingTxids.slice(i, i + TX_MERGE_BATCH));
        for (const tx of found) existingTxids.add(tx.txid);
      }
    }

    const txToAdd: CreateTransactionData[] = [];
    for (const tx of blockchainTransactions) {
      if (!tx.txid || existingTxids.has(tx.txid) || restoredTxids.has(tx.txid)) continue;
      const { id, ...txData } = tx;
      txToAdd.push(txData as CreateTransactionData);
      restoredTxids.add(tx.txid);
    }
    await bulkAddTransactions(txToAdd, { skipNotification: true });
    transactionsAdded = txToAdd.length;
  }

  if (
    transactionParticipants &&
    transactionParticipants.length > 0 &&
    restoredTxids.size > 0
  ) {
    const participantsToAdd = transactionParticipants
      .filter((p: any) => p.txid && restoredTxids.has(p.txid))
      .map((p: any) => {
        const { id, ...pData } = p;
        return { ...pData, recordId: remapRecordId(recordIdMap, pData.recordId) };
      });
    await bulkAddParticipants(participantsToAdd, { skipNotification: true });
    participantsAdded = participantsToAdd.length;
  }

  return { transactionsAdded, participantsAdded };
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

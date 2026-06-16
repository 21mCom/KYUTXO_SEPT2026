import type { IndexableType } from 'dexie';
import { db, notifyDbChange, type BlockchainTransaction, type TransactionParticipant } from '../database';

export type CreateTransactionData = Omit<BlockchainTransaction, 'id'>;

export interface TransactionWriteOptions {
  skipNotification?: boolean;
}

export async function addTransaction(
  data: CreateTransactionData,
  options?: TransactionWriteOptions
): Promise<number> {
  const id = await db.blockchainTransactions.add(data);

  if (!options?.skipNotification) {
    notifyDbChange('blockchainTransactions');
  }

  return id as number;
}

export async function bulkAddTransactions(
  transactions: CreateTransactionData[],
  options?: TransactionWriteOptions
): Promise<void> {
  if (transactions.length === 0) return;

  await db.blockchainTransactions.bulkAdd(transactions);

  if (!options?.skipNotification) {
    notifyDbChange('blockchainTransactions');
  }
}

export async function bulkAddParticipants(
  participants: TransactionParticipant[],
  options?: TransactionWriteOptions
): Promise<void> {
  if (participants.length === 0) return;

  await db.transactionParticipants.bulkAdd(participants);

  if (!options?.skipNotification) {
    notifyDbChange('transactionParticipants');
  }
}

export async function addParticipant(
  data: TransactionParticipant,
  options?: TransactionWriteOptions
): Promise<number> {
  const id = await db.transactionParticipants.add(data);

  if (!options?.skipNotification) {
    notifyDbChange('transactionParticipants');
  }

  return id as number;
}

export async function putParticipant(
  data: TransactionParticipant,
  options?: TransactionWriteOptions
): Promise<void> {
  if (!data.id) throw new Error('Cannot put participant without an id');

  await db.transactionParticipants.put(data);

  if (!options?.skipNotification) {
    notifyDbChange('transactionParticipants');
  }
}

export async function bulkPutParticipants(
  participants: TransactionParticipant[],
  options?: TransactionWriteOptions
): Promise<void> {
  if (participants.length === 0) return;

  await db.transaction('rw', db.transactionParticipants, async () => {
    for (const p of participants) {
      if (p.id) await db.transactionParticipants.put(p);
    }
  });

  if (!options?.skipNotification) {
    notifyDbChange('transactionParticipants');
  }
}

export async function clearTransactions(
  options?: TransactionWriteOptions
): Promise<void> {
  await db.blockchainTransactions.clear();

  if (!options?.skipNotification) {
    notifyDbChange('blockchainTransactions');
  }
}

export async function clearParticipants(
  options?: TransactionWriteOptions
): Promise<void> {
  await db.transactionParticipants.clear();

  if (!options?.skipNotification) {
    notifyDbChange('transactionParticipants');
  }
}

export async function clearAllTransactionData(
  options?: TransactionWriteOptions
): Promise<void> {
  await db.blockchainTransactions.clear();
  await db.transactionParticipants.clear();

  if (!options?.skipNotification) {
    notifyDbChange(['blockchainTransactions', 'transactionParticipants']);
  }
}

// =============================================================================
// READ HELPERS — blockchainTransactions
// =============================================================================

export async function getAllTransactions(): Promise<BlockchainTransaction[]> {
  return db.blockchainTransactions.toArray();
}

// Bounded id-keyset page. Used by the streaming backup export so the whole
// transaction table is never materialised at once: callers walk the table by
// repeatedly passing the last id they saw.
export async function getTransactionsAfterId(
  afterId: number,
  limit: number
): Promise<BlockchainTransaction[]> {
  return db.blockchainTransactions.where('id').above(afterId).limit(limit).toArray();
}

export async function getTransactionByTxid(
  txid: string
): Promise<BlockchainTransaction | undefined> {
  return db.blockchainTransactions.where('txid').equals(txid).first();
}

export async function getTransactionsByTxids(
  txids: string[]
): Promise<BlockchainTransaction[]> {
  if (txids.length === 0) return [];
  return db.blockchainTransactions.where('txid').anyOf(txids).toArray();
}

export async function bulkGetTransactionsByPrimaryKeys(
  keys: string[]
): Promise<(BlockchainTransaction | undefined)[]> {
  if (keys.length === 0) return [];
  return db.blockchainTransactions.bulkGet(keys);
}

export async function countTransactions(): Promise<number> {
  return db.blockchainTransactions.count();
}

export async function countTransactionsWithOpReturn(): Promise<number> {
  return db.blockchainTransactions.where('hasOpReturn').equals(true as unknown as IndexableType).count();
}

export async function getTransactionsPageByBlockTime(
  offset: number,
  limit: number
): Promise<BlockchainTransaction[]> {
  return db.blockchainTransactions
    .orderBy('blockTime')
    .reverse()
    .offset(offset)
    .limit(limit)
    .toArray();
}

export async function getOpReturnTransactionsPageByBlockTime(
  offset: number,
  limit: number
): Promise<BlockchainTransaction[]> {
  return db.blockchainTransactions
    .orderBy('blockTime')
    .reverse()
    .filter(tx => tx.hasOpReturn === true)
    .offset(offset)
    .limit(limit)
    .toArray();
}

export async function getTransactionsByTxidStartsWith(
  prefix: string,
  limit: number
): Promise<BlockchainTransaction[]> {
  return db.blockchainTransactions
    .where('txid')
    .startsWithIgnoreCase(prefix)
    .limit(limit)
    .toArray();
}

export async function getOrderedTransactionPrimaryKeysByBlockTime(): Promise<string[]> {
  return (await db.blockchainTransactions
    .orderBy('blockTime')
    .reverse()
    .primaryKeys()) as unknown as string[];
}

export async function getOpReturnTransactionPrimaryKeys(): Promise<string[]> {
  return (await db.blockchainTransactions
    .where('hasOpReturn')
    .equals(true as unknown as IndexableType)
    .primaryKeys()) as unknown as string[];
}

// =============================================================================
// READ HELPERS — transactionParticipants
// =============================================================================

export async function countTransactionParticipants(): Promise<number> {
  return db.transactionParticipants.count();
}

export async function getAllTransactionParticipants(): Promise<TransactionParticipant[]> {
  return db.transactionParticipants.toArray();
}

// Bounded id-keyset page. Used by the streaming backup export so the whole
// participant table is never materialised at once.
export async function getTransactionParticipantsAfterId(
  afterId: number,
  limit: number
): Promise<TransactionParticipant[]> {
  return db.transactionParticipants.where('id').above(afterId).limit(limit).toArray();
}

export async function getInputParticipants(): Promise<TransactionParticipant[]> {
  return db.transactionParticipants.where('role').equals('input').toArray();
}

export async function getParticipantsByPrevOutKeys(
  keys: Array<[string, number]>
): Promise<TransactionParticipant[]> {
  if (keys.length === 0) return [];
  return db.transactionParticipants
    .where('[prevTxid+prevVout]')
    .anyOf(keys)
    .toArray();
}

export async function getParticipantsByRecordIds(
  recordIds: number[]
): Promise<TransactionParticipant[]> {
  if (recordIds.length === 0) return [];
  return db.transactionParticipants.where('recordId').anyOf(recordIds).toArray();
}

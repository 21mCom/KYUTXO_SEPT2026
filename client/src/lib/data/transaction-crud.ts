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

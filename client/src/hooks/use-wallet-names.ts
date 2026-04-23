import { useLiveQuery } from 'dexie-react-hooks';
import { db, type WalletName } from '@/lib/database';

export function useWalletNames() {
  const walletNames = useLiveQuery(() => db.walletNames.orderBy('name').toArray());

  return {
    walletNames: walletNames ?? [],
    isLoading: walletNames === undefined,
  };
}

export async function createWalletName(name: string) {
  if (!name.trim()) {
    throw new Error('Wallet name cannot be empty');
  }

  const trimmedName = name.trim();
  const existing = await db.walletNames.where('name').equalsIgnoreCase(trimmedName).first();
  if (existing) {
    throw new Error('Wallet name already exists');
  }

  return await db.walletNames.add({ name: trimmedName, createdAt: Date.now() });
}

export async function updateWalletName(id: number, data: Partial<WalletName>) {
  await db.walletNames.update(id, data);
}

export async function deleteWalletName(id: number) {
  await db.walletNames.delete(id);
}

export async function getWalletNameUsageCount(walletNameValue: string): Promise<number> {
  return db.records.where('walletName').equals(walletNameValue).count();
}

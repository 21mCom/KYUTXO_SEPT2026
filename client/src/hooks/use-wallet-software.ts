import { useLiveQuery } from 'dexie-react-hooks';
import { db, type WalletSoftware } from '@/lib/database';

export function useWalletSoftware() {
  const walletSoftware = useLiveQuery(() => db.walletSoftware.orderBy('name').toArray());

  return {
    walletSoftware: walletSoftware ?? [],
    isLoading: walletSoftware === undefined,
  };
}

export async function createWalletSoftware(name: string) {
  if (!name.trim()) {
    throw new Error('Wallet software name cannot be empty');
  }

  const trimmedName = name.trim();
  const existing = await db.walletSoftware.where('name').equalsIgnoreCase(trimmedName).first();
  if (existing) {
    throw new Error('Wallet software already exists');
  }

  return await db.walletSoftware.add({ name: trimmedName, createdAt: Date.now() });
}

export async function updateWalletSoftware(id: number, data: Partial<WalletSoftware>) {
  await db.walletSoftware.update(id, data);
}

export async function deleteWalletSoftware(id: number) {
  await db.walletSoftware.delete(id);
}

export async function getWalletSoftwareUsageCount(walletSoftwareValue: string): Promise<number> {
  return db.records.where('walletSoftware').equals(walletSoftwareValue).count();
}

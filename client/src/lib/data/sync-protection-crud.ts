import { db, notifyDbChange, type SkippedAddress, type AddressBlacklist } from '../database';
import { getVaultRepository, ProtectedVaultRepository } from '../repository';

const protectedQuery = <T>(table: 'skippedAddresses' | 'addressBlacklist', name: Parameters<ProtectedVaultRepository['query']>[1], value: unknown, limit?: number) => {
  const repository = getVaultRepository();
  return repository instanceof ProtectedVaultRepository ? repository.query<T>(table, name, value, limit) : null;
};

export type CreateSkippedAddressData = Omit<SkippedAddress, 'id' | 'createdAt'> & {
  createdAt?: number;
};

export type CreateAddressBlacklistData = Omit<AddressBlacklist, 'id' | 'addedAt'> & {
  addedAt?: number;
};

export interface SyncProtectionWriteOptions {
  skipNotification?: boolean;
}

// Skipped addresses

export async function addSkippedAddress(
  data: CreateSkippedAddressData,
  options?: SyncProtectionWriteOptions
): Promise<number> {
  const entry: SkippedAddress = {
    ...data,
    createdAt: data.createdAt ?? Date.now(),
  };

  const repository = getVaultRepository();
  const id = repository.kind === 'protected' ? await repository.add('skippedAddresses', entry) : await db.skippedAddresses.add(entry);

  if (!options?.skipNotification) {
    notifyDbChange('skippedAddresses');
  }

  return id as number;
}

export async function updateSkippedAddress(
  id: number,
  changes: Partial<SkippedAddress>,
  options?: SyncProtectionWriteOptions
): Promise<void> {
  const repository = getVaultRepository();
  if (repository.kind === 'protected') await repository.update('skippedAddresses', id, changes);
  else await db.skippedAddresses.update(id, changes);

  if (!options?.skipNotification) {
    notifyDbChange('skippedAddresses');
  }
}

export async function dismissAllSkippedAddresses(
  options?: SyncProtectionWriteOptions
): Promise<void> {
  const rows = await protectedQuery<SkippedAddress>('skippedAddresses', 'sync.dismissAllSkipped', 'all');
  if (rows) await Promise.all(rows.map(row => getVaultRepository().update('skippedAddresses', row.id!, { dismissed: 1 })));
  else await db.skippedAddresses.toCollection().modify({ dismissed: 1 });

  if (!options?.skipNotification) {
    notifyDbChange('skippedAddresses');
  }
}

export async function getSkippedAddressesByRun(
  syncRunTimestamp: number
): Promise<SkippedAddress[]> {
  const rows = await protectedQuery<SkippedAddress>('skippedAddresses', 'sync.skippedByRun', syncRunTimestamp);
  return rows ?? db.skippedAddresses.where('syncRunTimestamp').equals(syncRunTimestamp).toArray();
}

export async function getActiveSkippedAddresses(): Promise<SkippedAddress[]> {
  const rows = await protectedQuery<SkippedAddress>('skippedAddresses', 'sync.activeSkipped', 'active');
  return rows ?? db.skippedAddresses.filter(r => !r.dismissed).toArray();
}

// Address blacklist

export async function getBlacklistEntryByAddress(
  address: string
): Promise<AddressBlacklist | undefined> {
  const rows = await protectedQuery<AddressBlacklist>('addressBlacklist', 'sync.byAddress', address, 1);
  return rows ? rows[0] : db.addressBlacklist.where('address').equals(address).first();
}

export async function isAddressBlacklisted(address: string): Promise<boolean> {
  const entry = await getBlacklistEntryByAddress(address);
  return !!entry;
}

export async function addToBlacklist(
  data: CreateAddressBlacklistData,
  options?: SyncProtectionWriteOptions
): Promise<number> {
  const entry: AddressBlacklist = {
    ...data,
    addedAt: data.addedAt ?? Date.now(),
  };

  const repository = getVaultRepository();
  const id = repository.kind === 'protected' ? await repository.add('addressBlacklist', entry) : await db.addressBlacklist.add(entry);

  if (!options?.skipNotification) {
    notifyDbChange('addressBlacklist');
  }

  return id as number;
}

export async function removeFromBlacklistByAddress(
  address: string,
  options?: SyncProtectionWriteOptions
): Promise<void> {
  const rows = await protectedQuery<AddressBlacklist>('addressBlacklist', 'sync.byAddress', address);
  if (rows) await getVaultRepository().bulkDelete('addressBlacklist', rows.flatMap(row => row.id === undefined ? [] : [row.id]));
  else await db.addressBlacklist.where('address').equals(address).delete();

  if (!options?.skipNotification) {
    notifyDbChange('addressBlacklist');
  }
}

export async function getAllBlacklist(): Promise<AddressBlacklist[]> {
  const repository = getVaultRepository();
  if (repository.kind === 'protected') {
    throw new Error('Protected vault native query "addressBlacklist.all" is required; unbounded blacklist reads are not permitted');
  }
  return db.addressBlacklist.toArray();
}

import { db, notifyDbChange, type SkippedAddress, type AddressBlacklist } from '../database';

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

  const id = await db.skippedAddresses.add(entry);

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
  await db.skippedAddresses.update(id, changes);

  if (!options?.skipNotification) {
    notifyDbChange('skippedAddresses');
  }
}

export async function dismissAllSkippedAddresses(
  options?: SyncProtectionWriteOptions
): Promise<void> {
  await db.skippedAddresses.toCollection().modify({ dismissed: 1 });

  if (!options?.skipNotification) {
    notifyDbChange('skippedAddresses');
  }
}

export async function getSkippedAddressesByRun(
  syncRunTimestamp: number
): Promise<SkippedAddress[]> {
  return db.skippedAddresses.where('syncRunTimestamp').equals(syncRunTimestamp).toArray();
}

export async function getActiveSkippedAddresses(): Promise<SkippedAddress[]> {
  return db.skippedAddresses.filter(r => !r.dismissed).toArray();
}

// Address blacklist

export async function getBlacklistEntryByAddress(
  address: string
): Promise<AddressBlacklist | undefined> {
  return db.addressBlacklist.where('address').equals(address).first();
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

  const id = await db.addressBlacklist.add(entry);

  if (!options?.skipNotification) {
    notifyDbChange('addressBlacklist');
  }

  return id as number;
}

export async function removeFromBlacklistByAddress(
  address: string,
  options?: SyncProtectionWriteOptions
): Promise<void> {
  await db.addressBlacklist.where('address').equals(address).delete();

  if (!options?.skipNotification) {
    notifyDbChange('addressBlacklist');
  }
}

export async function getAllBlacklist(): Promise<AddressBlacklist[]> {
  return db.addressBlacklist.toArray();
}

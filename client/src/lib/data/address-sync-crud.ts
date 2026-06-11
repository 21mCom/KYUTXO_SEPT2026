import { db, notifyDbChange, type AddressSyncState } from '../database';

export type CreateAddressSyncStateData = Omit<AddressSyncState, 'id'>;

export interface AddressSyncStateWriteOptions {
  skipNotification?: boolean;
}

export async function addAddressSyncState(
  data: CreateAddressSyncStateData,
  options?: AddressSyncStateWriteOptions
): Promise<number> {
  const id = await db.addressSyncState.add(data as AddressSyncState);

  if (!options?.skipNotification) {
    notifyDbChange('addressSyncState');
  }

  return id as number;
}

export async function updateAddressSyncState(
  id: number,
  changes: Partial<AddressSyncState>,
  options?: AddressSyncStateWriteOptions
): Promise<void> {
  await db.addressSyncState.update(id, changes);

  if (!options?.skipNotification) {
    notifyDbChange('addressSyncState');
  }
}

export async function clearAddressSyncState(
  options?: AddressSyncStateWriteOptions
): Promise<void> {
  await db.addressSyncState.clear();

  if (!options?.skipNotification) {
    notifyDbChange('addressSyncState');
  }
}

export async function getAddressSyncStateByAddress(
  address: string
): Promise<AddressSyncState | undefined> {
  return db.addressSyncState.where('address').equals(address).first();
}

export async function getAllAddressSyncState(): Promise<AddressSyncState[]> {
  return db.addressSyncState.toArray();
}

export async function countAddressSyncState(): Promise<number> {
  return db.addressSyncState.count();
}

export async function getLatestAddressSyncState(): Promise<AddressSyncState | undefined> {
  return db.addressSyncState.orderBy('lastSyncedAt').reverse().first();
}

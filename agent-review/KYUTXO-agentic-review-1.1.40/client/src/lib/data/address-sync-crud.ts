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

export async function bulkAddAddressSyncState(
  data: CreateAddressSyncStateData[],
  options?: AddressSyncStateWriteOptions
): Promise<number[]> {
  if (data.length === 0) return [];

  const ids = await db.addressSyncState.bulkAdd(data as AddressSyncState[], {
    allKeys: true,
  });

  if (!options?.skipNotification) {
    notifyDbChange('addressSyncState');
  }

  return ids as number[];
}

// Bulk delete by primary key. Used by the merge-cancel undo pass in the v3
// restore to remove exactly the rows that merge inserted.
export async function bulkDeleteAddressSyncState(
  ids: number[],
  options?: AddressSyncStateWriteOptions
): Promise<void> {
  if (ids.length === 0) return;

  await db.addressSyncState.bulkDelete(ids);

  if (!options?.skipNotification) {
    notifyDbChange('addressSyncState');
  }
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

// Bounded id-keyset page. Used by the streaming backup export so the whole
// address-sync-state table is never materialised at once.
export async function getAddressSyncStateAfterId(
  afterId: number,
  limit: number
): Promise<AddressSyncState[]> {
  return db.addressSyncState.where('id').above(afterId).limit(limit).toArray();
}

export async function countAddressSyncState(): Promise<number> {
  return db.addressSyncState.count();
}

export async function getLatestAddressSyncState(): Promise<AddressSyncState | undefined> {
  return db.addressSyncState.orderBy('lastSyncedAt').reverse().first();
}

import { db, notifyDbChange, type AddressSyncState } from '../database';
import { getVaultRepository, ProtectedVaultRepository } from '../repository';

const protectedQuery = <T>(name: Parameters<ProtectedVaultRepository['query']>[1], value: unknown, limit?: number) => {
  const repository = getVaultRepository();
  return repository instanceof ProtectedVaultRepository
    ? repository.query<T>('addressSyncState', name, value, limit)
    : null;
};

export type CreateAddressSyncStateData = Omit<AddressSyncState, 'id'>;

export interface AddressSyncStateWriteOptions {
  skipNotification?: boolean;
}

export async function addAddressSyncState(
  data: CreateAddressSyncStateData,
  options?: AddressSyncStateWriteOptions
): Promise<number> {
  const repository = getVaultRepository();
  const id = repository.kind === 'protected'
    ? await repository.add('addressSyncState', data as AddressSyncState)
    : await db.addressSyncState.add(data as AddressSyncState);

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

  const repository = getVaultRepository();
  const ids = repository.kind === 'protected'
    ? await Promise.all(data.map(row => repository.add('addressSyncState', row as AddressSyncState)))
    : await db.addressSyncState.bulkAdd(data as AddressSyncState[], { allKeys: true });

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

  const repository = getVaultRepository();
  if (repository.kind === 'protected') await repository.bulkDelete('addressSyncState', ids);
  else await db.addressSyncState.bulkDelete(ids);

  if (!options?.skipNotification) {
    notifyDbChange('addressSyncState');
  }
}

export async function updateAddressSyncState(
  id: number,
  changes: Partial<AddressSyncState>,
  options?: AddressSyncStateWriteOptions
): Promise<void> {
  const repository = getVaultRepository();
  if (repository.kind === 'protected') await repository.update('addressSyncState', id, changes);
  else await db.addressSyncState.update(id, changes);

  if (!options?.skipNotification) {
    notifyDbChange('addressSyncState');
  }
}

export async function clearAddressSyncState(
  options?: AddressSyncStateWriteOptions
): Promise<void> {
  const repository = getVaultRepository();
  if (repository.kind === 'protected') await repository.clear('addressSyncState');
  else await db.addressSyncState.clear();

  if (!options?.skipNotification) {
    notifyDbChange('addressSyncState');
  }
}

export async function getAddressSyncStateByAddress(
  address: string
): Promise<AddressSyncState | undefined> {
  const protectedRows = await protectedQuery<AddressSyncState>('sync.byAddress', address, 1);
  return protectedRows ? protectedRows[0] : db.addressSyncState.where('address').equals(address).first();
}

export async function getAllAddressSyncState(): Promise<AddressSyncState[]> {
  const repository = getVaultRepository();
  if (repository.kind === 'protected') {
    throw new Error('Protected vault native query "addressSyncState.all" is required; unbounded address-sync reads are not permitted');
  }
  return db.addressSyncState.toArray();
}

// Bounded id-keyset page. Used by the streaming backup export so the whole
// address-sync-state table is never materialised at once.
export async function getAddressSyncStateAfterId(
  afterId: number,
  limit: number
): Promise<AddressSyncState[]> {
  const repository = getVaultRepository();
  if (repository.kind === 'protected') {
    const page = await repository.list('addressSyncState', { cursor: afterId, limit });
    return page.rows;
  }
  return db.addressSyncState.where('id').above(afterId).limit(limit).toArray();
}

export async function countAddressSyncState(): Promise<number> {
  const repository = getVaultRepository();
  return repository.kind === 'protected' ? repository.count('addressSyncState') : db.addressSyncState.count();
}

export async function getLatestAddressSyncState(): Promise<AddressSyncState | undefined> {
  const protectedRows = await protectedQuery<AddressSyncState>('sync.byLastSyncedAt', 'latest', 1);
  return protectedRows ? protectedRows[0] : db.addressSyncState.orderBy('lastSyncedAt').reverse().first();
}

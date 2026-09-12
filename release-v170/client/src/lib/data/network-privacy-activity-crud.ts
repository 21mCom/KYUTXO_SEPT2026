import {
  db,
  notifyDbChange,
  type NetworkPrivacyActivityEntry,
  type NetworkPrivacyActivityType,
} from '../database';
import { getVaultRepository } from '../repository';

// Keep the local log useful without allowing repeated syncs to grow it forever.
export const MAX_NETWORK_PRIVACY_ACTIVITY_ENTRIES = 200;

export type CreateNetworkPrivacyActivityEntry = Omit<NetworkPrivacyActivityEntry, 'id'>;

export async function addNetworkPrivacyActivity(
  entry: CreateNetworkPrivacyActivityEntry,
): Promise<number> {
  const providerClasses = new Set(['own-node', 'electrum', 'public-tor', 'public-direct']);
  const actions = new Set(['sync', 'address-check', 'provider-test', 'price-source']);
  if (!Number.isFinite(entry.timestamp)) {
    throw new Error('Network privacy activity timestamp must be finite');
  }
  if (!providerClasses.has(entry.providerClass)) {
    throw new Error('Unknown network privacy provider class');
  }
  if (!actions.has(entry.action)) {
    throw new Error('Unknown network privacy activity action');
  }
  const addressCount =
    typeof entry.addressCount === 'number' && Number.isFinite(entry.addressCount)
      ? Math.max(0, Math.floor(entry.addressCount))
      : undefined;
  // Reconstruct the row at the persistence boundary. Even a caller that
  // bypasses the shared recorder cannot smuggle an address, URL, or response.
  const safeEntry: NetworkPrivacyActivityEntry = {
    timestamp: entry.timestamp,
    providerClass: entry.providerClass,
    action: entry.action,
    ...(addressCount === undefined ? {} : { addressCount }),
  };
  const repository = getVaultRepository();
  if (repository.kind === 'protected') {
    const id = await repository.add('networkPrivacyActivity', safeEntry);
    const rows = await getNetworkPrivacyActivity();
    const excess = rows.length - MAX_NETWORK_PRIVACY_ACTIVITY_ENTRIES;
    if (excess > 0) {
      await repository.bulkDelete('networkPrivacyActivity', rows.slice(-excess).map((row) => row.id!));
    }
    notifyDbChange('networkPrivacyActivity');
    return id as number;
  }
  let id: number;
  await db.transaction('rw', db.networkPrivacyActivity, async () => {
    id = (await db.networkPrivacyActivity.add(safeEntry)) as number;
    const excess = (await db.networkPrivacyActivity.count()) - MAX_NETWORK_PRIVACY_ACTIVITY_ENTRIES;
    if (excess > 0) {
      const oldest = await db.networkPrivacyActivity
        .orderBy('timestamp')
        .limit(excess)
        .primaryKeys();
      await db.networkPrivacyActivity.bulkDelete(oldest as number[]);
    }
  });
  notifyDbChange('networkPrivacyActivity');
  return id!;
}

export async function getNetworkPrivacyActivity(): Promise<NetworkPrivacyActivityEntry[]> {
  const repository = getVaultRepository();
  if (repository.kind !== 'protected') return db.networkPrivacyActivity.orderBy('timestamp').reverse().toArray();
  const rows: NetworkPrivacyActivityEntry[] = [];
  let cursor: string | number | undefined;
  do {
    const page = await repository.list('networkPrivacyActivity', { cursor, limit: 1000 });
    rows.push(...page.rows);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return rows.sort((a, b) => b.timestamp - a.timestamp || (b.id ?? 0) - (a.id ?? 0));
}

export async function getNetworkPrivacyActivityCount(): Promise<number> {
  const repository = getVaultRepository();
  return repository.kind === 'protected'
    ? repository.count('networkPrivacyActivity')
    : db.networkPrivacyActivity.count();
}

export async function clearNetworkPrivacyActivity(): Promise<void> {
  const repository = getVaultRepository();
  if (repository.kind === 'protected') await repository.clear('networkPrivacyActivity');
  else await db.networkPrivacyActivity.clear();
  notifyDbChange('networkPrivacyActivity');
}

export type NetworkPrivacyActivityInput = {
  action: NetworkPrivacyActivityType;
  addressCount?: number;
};
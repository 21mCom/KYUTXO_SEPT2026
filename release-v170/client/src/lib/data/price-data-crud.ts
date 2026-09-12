import { db, notifyDbChange, type PriceData } from '../database';
import { getVaultRepository, ProtectedVaultRepository } from '../repository';

const protectedQuery = <T>(name: Parameters<ProtectedVaultRepository['query']>[1], value: unknown, limit?: number) => {
  const repository = getVaultRepository();
  return repository instanceof ProtectedVaultRepository ? repository.query<T>('priceData', name, value, limit) : null;
};

export type CreatePriceData = Omit<PriceData, 'id'>;

export interface PriceDataWriteOptions {
  skipNotification?: boolean;
}

export async function addPriceData(
  data: CreatePriceData,
  options?: PriceDataWriteOptions
): Promise<number> {
  const repository = getVaultRepository();
  const id = repository.kind === 'protected' ? await repository.add('priceData', data as PriceData) : await db.priceData.add(data as PriceData);

  if (!options?.skipNotification) {
    notifyDbChange('priceData');
  }

  return id as number;
}

export async function updatePriceData(
  id: number,
  changes: Partial<PriceData>,
  options?: PriceDataWriteOptions
): Promise<void> {
  const repository = getVaultRepository();
  if (repository.kind === 'protected') await repository.update('priceData', id, changes);
  else await db.priceData.update(id, changes);

  if (!options?.skipNotification) {
    notifyDbChange('priceData');
  }
}

export async function clearPriceData(
  options?: PriceDataWriteOptions
): Promise<void> {
  const repository = getVaultRepository();
  if (repository.kind === 'protected') await repository.clear('priceData');
  else await db.priceData.clear();

  if (!options?.skipNotification) {
    notifyDbChange('priceData');
  }
}

export async function getPriceDataByKey(
  date: string,
  currency: string,
  asset: string
): Promise<PriceData | undefined> {
  const rows = await protectedQuery<PriceData>('price.byDateCurrencyAsset', [date, currency, asset], 1);
  return rows ? rows[0] : db.priceData
    .where('[date+currency+asset]')
    .equals([date, currency, asset])
    .first();
}

export async function getAllPriceData(): Promise<PriceData[]> {
  const repository = getVaultRepository();
  if (repository.kind === 'protected') throw new Error('Protected vault native query "priceData.all" is required; unbounded price reads are not permitted');
  return db.priceData.toArray();
}

export async function getPriceDataByAsset(
  asset: string,
  currency?: string
): Promise<PriceData[]> {
  const rows = await protectedQuery<PriceData>('price.byAsset', { asset, currency });
  if (rows) return rows;
  const query = db.priceData.where('asset').equals(asset);
  if (currency) {
    return query.filter(p => p.currency === currency).toArray();
  }
  return query.toArray();
}

export async function countPriceData(): Promise<number> {
  const repository = getVaultRepository();
  return repository.kind === 'protected' ? repository.count('priceData') : db.priceData.count();
}

export async function getLatestPriceOnOrBefore(
  date: string,
  currency: string,
  asset: string
): Promise<PriceData | undefined> {
  const rows = await protectedQuery<PriceData>('price.latestOnOrBefore', { date, currency, asset }, 1);
  return rows ? rows[0] : db.priceData
    .where('date')
    .belowOrEqual(date)
    .and(p => p.currency === currency && p.asset === asset)
    .last();
}

export async function getBtcUsdPriceData(): Promise<PriceData[]> {
  const rows = await protectedQuery<PriceData>('price.byAsset', { asset: 'BTC', currency: 'USD' });
  return rows ?? db.priceData
    .where('asset').equals('BTC')
    .filter(p => p.currency === 'USD')
    .toArray();
}

export async function getPriceDataByDateCurrencyAssetKeys(
  keys: [string, string, string][]
): Promise<PriceData[]> {
  if (keys.length === 0) return [];
  const rows = await protectedQuery<PriceData>('price.byDateCurrencyAssetKeys', keys);
  return rows ?? db.priceData
    .where('[date+currency+asset]')
    .anyOf(keys)
    .toArray();
}

export type PriceRestoreMode = 'merge' | 'replace';

// Build the de-dup key for the non-unique [date+currency+asset] index. The NUL
// separator can never appear in any of the three string components, so distinct
// triples can never collide on the same key.
// Exported so the read-only merge analysis (backup/analyze.ts) classifies
// price rows with the EXACT key this restore de-dupes by.
export function priceDedupKey(date: unknown, currency: unknown, asset: unknown): string {
  return `${date}\u0000${currency}\u0000${asset}`;
}

/**
 * Restore daily price rows from a backup. SINGLE source of truth shared by BOTH
 * the legacy (pre-v3) restore path and the v3 inline path so they can never
 * diverge.
 *
 * The backup `id` is always stripped (every row gets a fresh autoincrement id).
 *
 * In MERGE mode, a row whose `[date+currency+asset]` already exists is skipped:
 * the index is NOT unique, so without this guard merging a backup that overlaps
 * the current vault's dates silently doubles up the daily price rows (which
 * skews any USD valuation that reads price history). The skip-set is seeded from
 * the rows already in the table AND extended as we add, so an internally
 * duplicated backup can't re-add the same day within one merge either.
 *
 * In REPLACE mode every row is added (the caller cleared the table first), which
 * preserves the original append-only behaviour exactly.
 *
 * Returns the number of rows actually written.
 */
export async function bulkDeletePriceData(
  ids: number[],
  options?: PriceDataWriteOptions
): Promise<void> {
  if (ids.length === 0) return;
  const repository = getVaultRepository();
  if (repository.kind === 'protected') await repository.bulkDelete('priceData', ids);
  else await db.priceData.bulkDelete(ids);
  if (!options?.skipNotification) {
    notifyDbChange('priceData');
  }
}

export async function restorePriceDataRows(
  priceData: any[] | undefined,
  restoreMode: PriceRestoreMode,
  // Optional collector: every freshly inserted row's id is pushed here, so a
  // cancelled merge can undo exactly the rows this restore added.
  collect?: { insertedIds?: number[] }
): Promise<number> {
  if (!priceData || priceData.length === 0) return 0;

  const seen = new Set<string>();

  if (restoreMode === 'merge') {
    const keys: [string, string, string][] = [];
    for (const pd of priceData) {
      if (
        pd &&
        typeof pd.date === 'string' &&
        typeof pd.currency === 'string' &&
        typeof pd.asset === 'string'
      ) {
        keys.push([pd.date, pd.currency, pd.asset]);
      }
    }
    const existing = await getPriceDataByDateCurrencyAssetKeys(keys);
    for (const e of existing) {
      seen.add(priceDedupKey(e.date, e.currency, e.asset));
    }
  }

  let added = 0;
  for (const pd of priceData) {
    const { id, ...pdData } = pd;
    if (restoreMode === 'merge') {
      const key = priceDedupKey(pdData.date, pdData.currency, pdData.asset);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const newId = await addPriceData(pdData as CreatePriceData, { skipNotification: true });
    collect?.insertedIds?.push(newId);
    added++;
  }

  return added;
}

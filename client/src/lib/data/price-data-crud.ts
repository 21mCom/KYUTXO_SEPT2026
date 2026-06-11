import { db, notifyDbChange, type PriceData } from '../database';

export type CreatePriceData = Omit<PriceData, 'id'>;

export interface PriceDataWriteOptions {
  skipNotification?: boolean;
}

export async function addPriceData(
  data: CreatePriceData,
  options?: PriceDataWriteOptions
): Promise<number> {
  const id = await db.priceData.add(data as PriceData);

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
  await db.priceData.update(id, changes);

  if (!options?.skipNotification) {
    notifyDbChange('priceData');
  }
}

export async function clearPriceData(
  options?: PriceDataWriteOptions
): Promise<void> {
  await db.priceData.clear();

  if (!options?.skipNotification) {
    notifyDbChange('priceData');
  }
}

export async function getPriceDataByKey(
  date: string,
  currency: string,
  asset: string
): Promise<PriceData | undefined> {
  return db.priceData
    .where('[date+currency+asset]')
    .equals([date, currency, asset])
    .first();
}

export async function getAllPriceData(): Promise<PriceData[]> {
  return db.priceData.toArray();
}

export async function getPriceDataByAsset(
  asset: string,
  currency?: string
): Promise<PriceData[]> {
  const query = db.priceData.where('asset').equals(asset);
  if (currency) {
    return query.filter(p => p.currency === currency).toArray();
  }
  return query.toArray();
}

export async function countPriceData(): Promise<number> {
  return db.priceData.count();
}

export async function getLatestPriceOnOrBefore(
  date: string,
  currency: string,
  asset: string
): Promise<PriceData | undefined> {
  return db.priceData
    .where('date')
    .belowOrEqual(date)
    .and(p => p.currency === currency && p.asset === asset)
    .last();
}

export async function getBtcUsdPriceData(): Promise<PriceData[]> {
  return db.priceData
    .where('asset').equals('BTC')
    .filter(p => p.currency === 'USD')
    .toArray();
}

export async function getPriceDataByDateCurrencyAssetKeys(
  keys: [string, string, string][]
): Promise<PriceData[]> {
  if (keys.length === 0) return [];
  return db.priceData
    .where('[date+currency+asset]')
    .anyOf(keys)
    .toArray();
}

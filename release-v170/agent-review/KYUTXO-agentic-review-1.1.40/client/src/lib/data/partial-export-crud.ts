import { db, notifyDbChange, type PartialExportBundle } from '../database';

export interface PartialExportWriteOptions {
  skipNotification?: boolean;
}

export async function getPartialExportBundleBySelectionKey(
  selectionKey: string
): Promise<PartialExportBundle | undefined> {
  return db.partialExportBundles
    .where('selectionKey')
    .equals(selectionKey)
    .first();
}

export async function addPartialExportBundle(
  data: Omit<PartialExportBundle, 'id'>,
  options?: PartialExportWriteOptions
): Promise<number> {
  const id = await db.partialExportBundles.add(data as PartialExportBundle);

  if (!options?.skipNotification) {
    notifyDbChange('partialExportBundles');
  }

  return id as number;
}

export async function updatePartialExportBundle(
  id: number,
  changes: Partial<PartialExportBundle>,
  options?: PartialExportWriteOptions
): Promise<void> {
  await db.partialExportBundles.update(id, changes);

  if (!options?.skipNotification) {
    notifyDbChange('partialExportBundles');
  }
}

export async function deletePartialExportBundlesBySelectionKey(
  selectionKey: string,
  options?: PartialExportWriteOptions
): Promise<void> {
  await db.partialExportBundles
    .where('selectionKey')
    .equals(selectionKey)
    .delete();

  if (!options?.skipNotification) {
    notifyDbChange('partialExportBundles');
  }
}

export async function clearPartialExportBundles(
  options?: PartialExportWriteOptions
): Promise<void> {
  await db.partialExportBundles.clear();

  if (!options?.skipNotification) {
    notifyDbChange('partialExportBundles');
  }
}

export async function deleteExpiredPartialExportBundles(
  cutoffTimestamp: number,
  options?: PartialExportWriteOptions
): Promise<number> {
  const count = await db.partialExportBundles
    .where('createdAt')
    .below(cutoffTimestamp)
    .delete();

  if (count > 0 && !options?.skipNotification) {
    notifyDbChange('partialExportBundles');
  }

  return count;
}

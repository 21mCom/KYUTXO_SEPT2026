import { notifyDbChange, type PartialExportBundle } from '../database';
import { getVaultRepository } from '../repository';
import { listVaultRows } from './repository-helpers';

export interface PartialExportWriteOptions {
  skipNotification?: boolean;
}

async function deleteBundleIds(ids: number[]): Promise<void> {
  const repository = getVaultRepository();
  // Protected-store batch operations are deliberately capped at 1,000 rows.
  // Chunking retains bounded native batches rather than falling back to
  // renderer-side individual deletes.
  for (let start = 0; start < ids.length; start += 1000) {
    await repository.bulkDelete('partialExportBundles', ids.slice(start, start + 1000));
  }
}

export async function getPartialExportBundleBySelectionKey(
  selectionKey: string
): Promise<PartialExportBundle | undefined> {
  return (await listVaultRows('partialExportBundles')).find(row => row.selectionKey === selectionKey);
}

export async function addPartialExportBundle(
  data: Omit<PartialExportBundle, 'id'>,
  options?: PartialExportWriteOptions
): Promise<number> {
  const id = await getVaultRepository().add('partialExportBundles', data as PartialExportBundle);

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
  await getVaultRepository().update('partialExportBundles', id, changes);

  if (!options?.skipNotification) {
    notifyDbChange('partialExportBundles');
  }
}

export async function deletePartialExportBundlesBySelectionKey(
  selectionKey: string,
  options?: PartialExportWriteOptions
): Promise<void> {
  const ids = (await listVaultRows('partialExportBundles'))
    .filter(row => row.selectionKey === selectionKey && row.id !== undefined)
    .map(row => row.id!);
  await deleteBundleIds(ids);

  if (!options?.skipNotification) {
    notifyDbChange('partialExportBundles');
  }
}

export async function clearPartialExportBundles(
  options?: PartialExportWriteOptions
): Promise<void> {
  await getVaultRepository().clear('partialExportBundles');

  if (!options?.skipNotification) {
    notifyDbChange('partialExportBundles');
  }
}

export async function deleteExpiredPartialExportBundles(
  cutoffTimestamp: number,
  options?: PartialExportWriteOptions
): Promise<number> {
  const ids = (await listVaultRows('partialExportBundles'))
    .filter(row => row.createdAt < cutoffTimestamp && row.id !== undefined)
    .map(row => row.id!);
  await deleteBundleIds(ids);
  const count = ids.length;

  if (count > 0 && !options?.skipNotification) {
    notifyDbChange('partialExportBundles');
  }

  return count;
}

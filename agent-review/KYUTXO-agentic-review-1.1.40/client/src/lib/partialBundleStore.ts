import type { EvidenceBundle } from './lineageEngine';
import type { PartialExportBundle } from './db-types';
import {
  addPartialExportBundle,
  clearPartialExportBundles,
  deleteExpiredPartialExportBundles,
  deletePartialExportBundlesBySelectionKey,
  getPartialExportBundleBySelectionKey,
  updatePartialExportBundle,
} from './data/partial-export-crud';

export const PARTIAL_BUNDLE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

function buildSelectionKey(segmentIds: string[]): string {
  return [...segmentIds].sort().join(',');
}

export async function savePartialBundle(
  bundle: EvidenceBundle,
  format: 'json' | 'pdf',
  selectedSegmentIds: string[]
): Promise<void> {
  const selectionKey = buildSelectionKey(selectedSegmentIds);
  const existing = await getPartialExportBundleBySelectionKey(selectionKey);

  const entry: PartialExportBundle = {
    selectionKey,
    bundle,
    format,
    selectedSegmentIds,
    createdAt: Date.now(),
  };

  if (existing?.id) {
    await updatePartialExportBundle(existing.id, entry);
  } else {
    await addPartialExportBundle(entry);
  }
}

export async function loadPartialBundle(
  selectedSegmentIds: string[]
): Promise<PartialExportBundle | undefined> {
  const selectionKey = buildSelectionKey(selectedSegmentIds);
  return getPartialExportBundleBySelectionKey(selectionKey);
}

export async function clearPartialBundle(
  selectedSegmentIds: string[]
): Promise<void> {
  const selectionKey = buildSelectionKey(selectedSegmentIds);
  await deletePartialExportBundlesBySelectionKey(selectionKey);
}

export async function clearAllPartialBundles(): Promise<void> {
  await clearPartialExportBundles();
}

export async function deleteExpiredPartialBundles(
  maxAgeMs: number = PARTIAL_BUNDLE_EXPIRY_MS
): Promise<number> {
  const cutoff = Date.now() - maxAgeMs;
  return deleteExpiredPartialExportBundles(cutoff);
}

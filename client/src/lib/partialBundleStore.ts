import { db } from './database';
import type { EvidenceBundle } from './lineageEngine';
import type { PartialExportBundle } from './db-types';

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
  const existing = await db.partialExportBundles
    .where('selectionKey')
    .equals(selectionKey)
    .first();

  const entry: PartialExportBundle = {
    selectionKey,
    bundle,
    format,
    selectedSegmentIds,
    createdAt: Date.now(),
  };

  if (existing?.id) {
    await db.partialExportBundles.update(existing.id, entry);
  } else {
    await db.partialExportBundles.add(entry);
  }
}

export async function loadPartialBundle(
  selectedSegmentIds: string[]
): Promise<PartialExportBundle | undefined> {
  const selectionKey = buildSelectionKey(selectedSegmentIds);
  return db.partialExportBundles
    .where('selectionKey')
    .equals(selectionKey)
    .first();
}

export async function clearPartialBundle(
  selectedSegmentIds: string[]
): Promise<void> {
  const selectionKey = buildSelectionKey(selectedSegmentIds);
  await db.partialExportBundles
    .where('selectionKey')
    .equals(selectionKey)
    .delete();
}

export async function clearAllPartialBundles(): Promise<void> {
  await db.partialExportBundles.clear();
}

export async function deleteExpiredPartialBundles(
  maxAgeMs: number = PARTIAL_BUNDLE_EXPIRY_MS
): Promise<number> {
  const cutoff = Date.now() - maxAgeMs;
  return db.partialExportBundles
    .where('createdAt')
    .below(cutoff)
    .delete();
}

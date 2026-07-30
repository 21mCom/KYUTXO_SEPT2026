import { db, notifyDbChange, type UtxoLineage, type CustodySegment, type LineageSnapshot } from '../database';

export type CreateUtxoLineageData = Omit<UtxoLineage, 'id'>;
export type CreateCustodySegmentData = Omit<CustodySegment, 'id'>;

export interface LineageWriteOptions {
  skipNotification?: boolean;
}

export async function addUtxoLineage(
  data: CreateUtxoLineageData,
  options?: LineageWriteOptions
): Promise<number> {
  const id = await db.utxoLineage.add(data);

  if (!options?.skipNotification) {
    notifyDbChange('utxoLineage');
  }

  return id as number;
}

export async function bulkAddUtxoLineage(
  records: UtxoLineage[],
  options?: LineageWriteOptions
): Promise<number[]> {
  if (records.length === 0) return [];

  const ids = await db.utxoLineage.bulkAdd(records, { allKeys: true });

  if (!options?.skipNotification) {
    notifyDbChange('utxoLineage');
  }

  return ids as number[];
}

// Bulk delete by primary key. Used by the merge-cancel undo pass in the v3
// restore to remove exactly the rows that merge inserted.
export async function bulkDeleteUtxoLineage(
  ids: number[],
  options?: LineageWriteOptions
): Promise<void> {
  if (ids.length === 0) return;

  await db.utxoLineage.bulkDelete(ids);

  if (!options?.skipNotification) {
    notifyDbChange('utxoLineage');
  }
}

export async function updateUtxoLineage(
  id: number,
  changes: Partial<UtxoLineage>,
  options?: LineageWriteOptions
): Promise<void> {
  await db.utxoLineage.update(id, changes);

  if (!options?.skipNotification) {
    notifyDbChange('utxoLineage');
  }
}

export async function clearUtxoLineage(
  options?: LineageWriteOptions
): Promise<void> {
  await db.utxoLineage.clear();

  if (!options?.skipNotification) {
    notifyDbChange('utxoLineage');
  }
}

export async function addCustodySegment(
  data: CreateCustodySegmentData,
  options?: LineageWriteOptions
): Promise<number> {
  const id = await db.custodySegments.add(data);

  if (!options?.skipNotification) {
    notifyDbChange('custodySegments');
  }

  return id as number;
}

export async function bulkAddCustodySegments(
  records: CustodySegment[],
  options?: LineageWriteOptions
): Promise<number[]> {
  if (records.length === 0) return [];

  const ids = await db.custodySegments.bulkAdd(records, { allKeys: true });

  if (!options?.skipNotification) {
    notifyDbChange('custodySegments');
  }

  return ids as number[];
}

// Bulk delete by primary key. Used by the merge-cancel undo pass in the v3
// restore to remove exactly the rows that merge inserted.
export async function bulkDeleteCustodySegments(
  ids: number[],
  options?: LineageWriteOptions
): Promise<void> {
  if (ids.length === 0) return;

  await db.custodySegments.bulkDelete(ids);

  if (!options?.skipNotification) {
    notifyDbChange('custodySegments');
  }
}

export async function clearCustodySegments(
  options?: LineageWriteOptions
): Promise<void> {
  await db.custodySegments.clear();

  if (!options?.skipNotification) {
    notifyDbChange('custodySegments');
  }
}

export async function clearAllLineageData(
  options?: LineageWriteOptions
): Promise<void> {
  await db.utxoLineage.clear();
  await db.custodySegments.clear();

  if (!options?.skipNotification) {
    notifyDbChange(['utxoLineage', 'custodySegments']);
  }
}

export type CreateLineageSnapshotData = Omit<LineageSnapshot, 'id'>;

export async function addLineageSnapshot(
  data: CreateLineageSnapshotData,
  options?: LineageWriteOptions
): Promise<number> {
  const id = await db.lineageSnapshots.add(data);

  if (!options?.skipNotification) {
    notifyDbChange('lineageSnapshots');
  }

  return id as number;
}

export async function bulkAddLineageSnapshots(
  records: LineageSnapshot[],
  options?: LineageWriteOptions
): Promise<number[]> {
  if (records.length === 0) return [];

  const ids = await db.lineageSnapshots.bulkAdd(records, { allKeys: true });

  if (!options?.skipNotification) {
    notifyDbChange('lineageSnapshots');
  }

  return ids as number[];
}

// Bulk delete by primary key. Used by the merge-cancel undo pass in the v3
// restore to remove exactly the rows that merge inserted.
export async function bulkDeleteLineageSnapshots(
  ids: number[],
  options?: LineageWriteOptions
): Promise<void> {
  if (ids.length === 0) return;

  await db.lineageSnapshots.bulkDelete(ids);

  if (!options?.skipNotification) {
    notifyDbChange('lineageSnapshots');
  }
}

export async function updateLineageSnapshot(
  id: number,
  changes: Partial<LineageSnapshot>,
  options?: LineageWriteOptions
): Promise<void> {
  await db.lineageSnapshots.update(id, changes);

  if (!options?.skipNotification) {
    notifyDbChange('lineageSnapshots');
  }
}

export async function deleteLineageSnapshot(
  id: number,
  options?: LineageWriteOptions
): Promise<void> {
  await db.lineageSnapshots.delete(id);

  if (!options?.skipNotification) {
    notifyDbChange('lineageSnapshots');
  }
}

export async function clearLineageSnapshots(
  options?: LineageWriteOptions
): Promise<void> {
  await db.lineageSnapshots.clear();

  if (!options?.skipNotification) {
    notifyDbChange('lineageSnapshots');
  }
}

// =============================================================================
// READ HELPERS
// =============================================================================

export async function getAllUtxoLineage(): Promise<UtxoLineage[]> {
  return db.utxoLineage.toArray();
}

export async function getAllCustodySegments(): Promise<CustodySegment[]> {
  return db.custodySegments.toArray();
}

// Bounded id-keyset page. Used by the streaming backup export so the whole
// utxoLineage table is never materialised at once.
export async function getUtxoLineageAfterId(
  afterId: number,
  limit: number
): Promise<UtxoLineage[]> {
  return db.utxoLineage.where('id').above(afterId).limit(limit).toArray();
}

// Bounded id-keyset page. Used by the streaming backup export so the whole
// custodySegments table is never materialised at once.
export async function getCustodySegmentsAfterId(
  afterId: number,
  limit: number
): Promise<CustodySegment[]> {
  return db.custodySegments.where('id').above(afterId).limit(limit).toArray();
}

// Returns the set of `segmentId` values already present, read via the unique
// `&segmentId` index (no full rows materialised). Used by merge-mode restore to
// skip custody segments whose segmentId already exists — appending them would
// otherwise violate the unique index and abort the whole restore mid-way.
export async function getExistingSegmentIds(): Promise<Set<string>> {
  const keys = await db.custodySegments.orderBy('segmentId').keys();
  return new Set(keys as unknown as string[]);
}

export async function countUtxoLineage(): Promise<number> {
  return db.utxoLineage.count();
}

export async function countCustodySegments(): Promise<number> {
  return db.custodySegments.count();
}

export async function getAllLineageSnapshots(): Promise<LineageSnapshot[]> {
  return db.lineageSnapshots.toArray();
}

// Bounded id-keyset page. Used by the streaming backup export so the whole
// lineageSnapshots table is never materialised at once.
export async function getLineageSnapshotsAfterId(
  afterId: number,
  limit: number
): Promise<LineageSnapshot[]> {
  return db.lineageSnapshots.where('id').above(afterId).limit(limit).toArray();
}

// Returns the set of `snapshotId` values already present, read via the unique
// `&snapshotId` index (no full rows materialised). Used by merge-mode restore to
// skip snapshots whose snapshotId already exists — appending them would
// otherwise violate the unique index and abort the whole restore mid-way.
export async function getExistingSnapshotIds(): Promise<Set<string>> {
  const keys = await db.lineageSnapshots.orderBy('snapshotId').keys();
  return new Set(keys as unknown as string[]);
}

export async function countLineageSnapshots(): Promise<number> {
  return db.lineageSnapshots.count();
}

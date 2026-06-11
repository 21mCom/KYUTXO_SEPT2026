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
): Promise<void> {
  if (records.length === 0) return;

  await db.utxoLineage.bulkAdd(records);

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
): Promise<void> {
  if (records.length === 0) return;

  await db.lineageSnapshots.bulkAdd(records);

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

export async function countUtxoLineage(): Promise<number> {
  return db.utxoLineage.count();
}

export async function countCustodySegments(): Promise<number> {
  return db.custodySegments.count();
}

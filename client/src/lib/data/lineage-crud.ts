import { db, notifyDbChange, type UtxoLineage, type CustodySegment, type CustodyStatus, type LineageSnapshot } from '../database';

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

export async function getUtxoLineageByOutpoints(
  outpoints: Array<{ txid: string; vout: number }>,
): Promise<UtxoLineage[]> {
  if (outpoints.length === 0) return [];
  const keys = outpoints.map(({ txid, vout }) => [txid, vout] as [string, number]);
  const rows = await db.utxoLineage
    .where("[spentTxid+spentVout]")
    .anyOf(keys)
    .toArray();
  const created = await db.utxoLineage
    .where("[createdTxid+createdVout]")
    .anyOf(keys)
    .toArray();
  const seen = new Set<number>();
  return [...rows, ...created].filter((row) => {
    if (row.id === undefined || seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}

export async function getAllCustodySegments(): Promise<CustodySegment[]> {
  return db.custodySegments.toArray();
}

export async function getCustodySegmentsBySegmentIds(segmentIds: string[]): Promise<CustodySegment[]> {
  if (segmentIds.length === 0) return [];
  return db.custodySegments.where("segmentId").anyOf(segmentIds).toArray();
}

export async function getLineageSnapshotsBySnapshotIds(snapshotIds: string[]): Promise<LineageSnapshot[]> {
  if (snapshotIds.length === 0) return [];
  return db.lineageSnapshots.where("snapshotId").anyOf(snapshotIds).toArray();
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

// Newest-first (descending id) bounded page. `beforeId` is exclusive — pass
// Number.MAX_SAFE_INTEGER for the first page. Used by the Continuity Proof
// all-segments list so thousands of segments are never mounted at once.
export async function getCustodySegmentsBeforeId(
  beforeId: number,
  limit: number
): Promise<CustodySegment[]> {
  return db.custodySegments.where('id').below(beforeId).reverse().limit(limit).toArray();
}

// Filters for the Continuity Proof all-segments list. All dimensions combine
// with AND; an absent/empty dimension matches everything.
export interface CustodySegmentListFilter {
  statuses?: readonly CustodyStatus[]; // empty/undefined = all statuses
  addressQuery?: string;               // case-insensitive substring vs origin OR current address
  originDateFrom?: number;             // Unix SECONDS, inclusive (originDate is stored in seconds)
  originDateTo?: number;               // Unix SECONDS, inclusive
}

interface NormalizedSegmentFilter {
  statuses: ReadonlySet<CustodyStatus> | null;
  addressQuery: string | null;
  originDateFrom: number | null;
  originDateTo: number | null;
}

function normalizeSegmentFilter(filter?: CustodySegmentListFilter): NormalizedSegmentFilter | null {
  if (!filter) return null;
  const statuses = filter.statuses && filter.statuses.length > 0 ? new Set(filter.statuses) : null;
  const addressQuery = filter.addressQuery?.trim().toLowerCase() || null;
  const originDateFrom =
    typeof filter.originDateFrom === 'number' && Number.isFinite(filter.originDateFrom)
      ? filter.originDateFrom
      : null;
  const originDateTo =
    typeof filter.originDateTo === 'number' && Number.isFinite(filter.originDateTo)
      ? filter.originDateTo
      : null;
  if (!statuses && !addressQuery && originDateFrom === null && originDateTo === null) return null;
  return { statuses, addressQuery, originDateFrom, originDateTo };
}

// True when any filter dimension actually narrows the result. The list UI uses
// this to decide whether the filtered count query is needed at all (the
// unfiltered table count is already loaded for the stat card).
export function isCustodySegmentFilterActive(filter?: CustodySegmentListFilter): boolean {
  return normalizeSegmentFilter(filter) !== null;
}

function matchesSegmentFilter(segment: CustodySegment, filter: NormalizedSegmentFilter): boolean {
  if (filter.statuses && !filter.statuses.has(segment.status)) return false;
  if (filter.addressQuery) {
    // Sparse rows restored from older backups may miss either address field.
    const origin = (segment.originAddress || '').toLowerCase();
    const current = (segment.currentAddress || '').toLowerCase();
    if (!origin.includes(filter.addressQuery) && !current.includes(filter.addressQuery)) {
      return false;
    }
  }
  // Segments with a missing/unknown origin date (0/unset blockTime) never
  // match a ranged query — any range excludes them rather than guessing.
  if (filter.originDateFrom !== null || filter.originDateTo !== null) {
    if (!(segment.originDate > 0)) return false;
    if (filter.originDateFrom !== null && segment.originDate < filter.originDateFrom) return false;
    if (filter.originDateTo !== null && segment.originDate > filter.originDateTo) return false;
  }
  return true;
}

// Filter-aware variant of getCustodySegmentsBeforeId: same newest-first id
// keyset pagination, with the filter applied during the cursor scan so each
// page genuinely narrows what is fetched (not client-side hiding of an
// already-loaded page). The id keyset bounds the scan to rows below the
// cursor and Dexie stops as soon as `limit` matches are found, so a page
// never materialises the whole table. With no active filter this is exactly
// the unfiltered query (no .filter() scan at all).
export async function getCustodySegmentsBeforeIdFiltered(
  beforeId: number,
  limit: number,
  filter?: CustodySegmentListFilter
): Promise<CustodySegment[]> {
  const normalized = normalizeSegmentFilter(filter);
  const collection = db.custodySegments.where('id').below(beforeId).reverse();
  if (!normalized) {
    return collection.limit(limit).toArray();
  }
  return collection.filter((segment) => matchesSegmentFilter(segment, normalized)).limit(limit).toArray();
}

// Count companion to getCustodySegmentsBeforeIdFiltered — must stay in
// lockstep with it so the "Showing X of Y" indicator reflects filtered
// totals. Returns the plain table count when no filter is active.
export async function countCustodySegmentsFiltered(
  filter?: CustodySegmentListFilter
): Promise<number> {
  const normalized = normalizeSegmentFilter(filter);
  if (!normalized) {
    return db.custodySegments.count();
  }
  return db.custodySegments.filter((segment) => matchesSegmentFilter(segment, normalized)).count();
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

import {
  db,
  notifyDbChange,
  type Record,
  type RecordOrigin,
  type RecordOriginType,
} from '../database';

export type CreateRecordOriginData = Omit<RecordOrigin, 'id' | 'createdAt'> & {
  createdAt?: number;
};

// Incoming metadata from a merge, sans recordId (taken from the record).
export type MergeOriginInput = Omit<CreateRecordOriginData, 'recordId'>;

export interface RecordOriginWriteOptions {
  skipNotification?: boolean;
}

export async function addRecordOrigin(
  data: CreateRecordOriginData,
  options?: RecordOriginWriteOptions
): Promise<number> {
  const origin: RecordOrigin = {
    ...data,
    createdAt: data.createdAt ?? Date.now(),
  };

  const id = await db.recordOrigins.add(origin);

  if (!options?.skipNotification) {
    notifyDbChange('recordOrigins');
  }

  return id as number;
}

export async function bulkAddRecordOrigins(
  rows: CreateRecordOriginData[],
  options?: RecordOriginWriteOptions
): Promise<number[]> {
  if (rows.length === 0) return [];
  const now = Date.now();
  const origins: RecordOrigin[] = rows.map((data) => ({
    ...data,
    createdAt: data.createdAt ?? now,
  }));

  const ids = await db.recordOrigins.bulkAdd(origins, { allKeys: true });

  if (!options?.skipNotification) {
    notifyDbChange('recordOrigins');
  }

  return ids as number[];
}
export async function deleteRecordOriginsByRecordId(
  recordId: number,
  options?: RecordOriginWriteOptions
): Promise<void> {
  await db.recordOrigins.where('recordId').equals(recordId).delete();

  if (!options?.skipNotification) {
    notifyDbChange('recordOrigins');
  }
}

export async function clearRecordOrigins(
  options?: RecordOriginWriteOptions
): Promise<void> {
  await db.recordOrigins.clear();

  if (!options?.skipNotification) {
    notifyDbChange('recordOrigins');
  }
}

export async function getRecordOriginsByRecordId(recordId: number): Promise<RecordOrigin[]> {
  return db.recordOrigins.where('recordId').equals(recordId).toArray();
}

export async function getRecordOriginsByRecordIds(
  recordIds: number[]
): Promise<RecordOrigin[]> {
  if (recordIds.length === 0) return [];
  return db.recordOrigins
    .where('recordId')
    .anyOf(recordIds)
    .toArray();
}

export async function getAllRecordOrigins(): Promise<RecordOrigin[]> {
  return db.recordOrigins.toArray();
}

// Singular string fields an origin row can carry (mirrors RecordOrigin).
const ORIGIN_STRING_FIELDS = [
  'label',
  'notes',
  'owner',
  'walletName',
  'seedName',
  'walletSoftware',
  'privateKeyStatus',
] as const;

function hasAnyOriginMetadata(incoming: MergeOriginInput): boolean {
  for (const key of ORIGIN_STRING_FIELDS) {
    const value = incoming[key];
    if (typeof value === 'string' && value.trim() !== '') return true;
  }
  if (incoming.tags && incoming.tags.length > 0) return true;
  if (incoming.categories && incoming.categories.length > 0) return true;
  if (incoming.xpub || incoming.derivationPath) return true;
  return false;
}

// Infer an origin type for a record that predates origin tracking. Mirrors
// the inference the use-records create hook applies when writing the
// creation origin, so backfilled baselines classify the same way.
export function inferOriginTypeForRecord(
  record: Pick<Record, 'source' | 'addressImportance' | 'xpub' | 'derivationPath'>
): RecordOriginType {
  if (
    record.source === 'blockchain-sync' ||
    record.addressImportance === 'blockchain-discovered'
  ) {
    return 'blockchain-sync';
  }
  if (
    record.source?.startsWith('walletImport-') ||
    record.addressImportance === 'wallet-import'
  ) {
    return 'wallet-sync';
  }
  if (
    record.addressImportance === 'xpub-derived' ||
    record.xpub ||
    record.derivationPath
  ) {
    return 'xpub-derived';
  }
  const sourceLower = record.source?.toLowerCase() || '';
  if (sourceLower.includes('bulk') || sourceLower.includes('import')) {
    return 'bulk-import';
  }
  return 'manual';
}

// Normalize a value for duplicate comparison: blank/whitespace strings and
// empty arrays collapse to undefined, arrays compare order-insensitively.
function normalizeOriginValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    return JSON.stringify([...value].sort());
  }
  if (value === null || value === undefined) return undefined;
  return String(value);
}

// Fields that constitute an origin's "value" for duplicate detection.
const ORIGIN_VALUE_FIELDS = [
  ...ORIGIN_STRING_FIELDS,
  'xpub',
  'derivationPath',
  'chainType',
  'tags',
  'categories',
] as const;

// True when the incoming origin carries exactly the same values as an
// existing origin row (same source + originType assumed by the caller).
function originValuesEqual(
  existing: RecordOrigin,
  incoming: MergeOriginInput
): boolean {
  for (const key of ORIGIN_VALUE_FIELDS) {
    if (
      normalizeOriginValue((existing as any)[key]) !==
      normalizeOriginValue((incoming as any)[key])
    ) {
      return false;
    }
  }
  return true;
}

// Record an import's incoming metadata as an origin row when a merge touches
// an existing record. When the record has no origin history at all (created
// via the raw data facade, restored from backup, etc.), first backfill a
// baseline origin snapshotting the record's current singular fields, tags,
// and categories so there is always something to compare the incoming values
// against on the Conflict Resolution page.
//
// Callers pass the PRE-merge record (loaded before updateRecord ran) so the
// baseline reflects what the record held before this import touched it.
// Non-fatal by design: origin bookkeeping must never fail a merge, matching
// the existing catch-and-log pattern around createRecordOrigin call sites.
export async function captureMergeOrigin(
  preMergeRecord: Record,
  incoming: MergeOriginInput
): Promise<void> {
  try {
    const recordId = preMergeRecord.id;
    if (!recordId) return;
    if (!hasAnyOriginMetadata(incoming)) return;

    const existingOrigins = await db.recordOrigins
      .where('recordId')
      .equals(recordId)
      .toArray();

    const now = Date.now();

    // De-dup: if the most recent origin from the same source/originType is
    // value-identical to the incoming one, refresh its timestamp instead of
    // appending another identical row. A changed value still appends (that
    // is what re-opens resolved conflicts).
    const sameSourceOrigins = existingOrigins
      .filter(
        (o) =>
          o.originType === incoming.originType &&
          (o.source || '') === (incoming.source || '')
      )
      .sort((a, b) => b.createdAt - a.createdAt);
    const latestSameSource = sameSourceOrigins[0];
    if (latestSameSource?.id && originValuesEqual(latestSameSource, incoming)) {
      await db.recordOrigins.update(latestSameSource.id, {
        createdAt: incoming.createdAt ?? now,
      });
      return;
    }

    if (existingOrigins.length === 0) {
      // Baseline must sort strictly before the incoming origin so "newest
      // origin" ordering reflects the merge direction.
      const baselineCreatedAt = Math.min(
        preMergeRecord.createdAt || now - 1,
        now - 1
      );
      await addRecordOrigin(
        {
          recordId,
          originType: inferOriginTypeForRecord(preMergeRecord),
          source: preMergeRecord.source || 'existing-record',
          label: preMergeRecord.label || undefined,
          notes: preMergeRecord.notes || undefined,
          owner: preMergeRecord.owner || undefined,
          walletName: preMergeRecord.walletName || undefined,
          seedName: preMergeRecord.seedName || undefined,
          walletSoftware: preMergeRecord.walletSoftware || undefined,
          privateKeyStatus: preMergeRecord.privateKeyStatus || undefined,
          xpub: preMergeRecord.xpub || undefined,
          derivationPath: preMergeRecord.derivationPath || undefined,
          tags:
            preMergeRecord.tags && preMergeRecord.tags.length > 0
              ? [...preMergeRecord.tags]
              : undefined,
          categories:
            preMergeRecord.categories && preMergeRecord.categories.length > 0
              ? [...preMergeRecord.categories]
              : undefined,
          createdAt: baselineCreatedAt,
        },
        { skipNotification: true }
      );
    }

    await addRecordOrigin(
      {
        ...incoming,
        recordId,
        createdAt: incoming.createdAt ?? now,
      },
      { skipNotification: true }
    );
  } catch (error) {
    console.error('Failed to record merge origin:', error);
  }
}

export async function bulkDeleteRecordOrigins(
  ids: number[],
  options?: RecordOriginWriteOptions
): Promise<void> {
  if (ids.length === 0) return;
  await db.recordOrigins.bulkDelete(ids);

  if (!options?.skipNotification) {
    notifyDbChange('recordOrigins');
  }
}

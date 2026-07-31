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

    const existingCount = await db.recordOrigins
      .where('recordId')
      .equals(recordId)
      .count();

    const now = Date.now();

    if (existingCount === 0) {
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

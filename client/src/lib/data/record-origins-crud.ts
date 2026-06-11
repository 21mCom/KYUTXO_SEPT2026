import { db, notifyDbChange, type RecordOrigin } from '../database';

export type CreateRecordOriginData = Omit<RecordOrigin, 'id' | 'createdAt'> & {
  createdAt?: number;
};

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

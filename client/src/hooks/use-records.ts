import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Record } from '@/lib/database';

export function useRecords() {
  const records = useLiveQuery(() => db.records.orderBy('updatedAt').reverse().toArray());
  
  return {
    records: records || [],
    isLoading: records === undefined,
  };
}

export function useRecord(id: number | undefined) {
  const record = useLiveQuery(
    () => id ? db.records.get(id) : undefined,
    [id]
  );
  
  return {
    record,
    isLoading: record === undefined && id !== undefined,
  };
}

export async function createRecord(data: Omit<Record, 'id' | 'createdAt' | 'updatedAt'>) {
  const now = Date.now();
  const id = await db.records.add({
    ...data,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export async function updateRecord(id: number, data: Partial<Record>) {
  await db.records.update(id, {
    ...data,
    updatedAt: Date.now(),
  });
}

export async function deleteRecord(id: number) {
  // Delete associated attachments first
  const attachments = await db.attachments.where('recordId').equals(id).toArray();
  await db.attachments.where('recordId').equals(id).delete();
  
  // Then delete the record
  await db.records.delete(id);
  
  return attachments;
}

export async function searchRecords(query: string) {
  if (!query.trim()) {
    return db.records.orderBy('updatedAt').reverse().toArray();
  }
  
  const lowerQuery = query.toLowerCase();
  
  return db.records
    .filter(record => 
      record.label.toLowerCase().includes(lowerQuery) ||
      record.inputString.toLowerCase().includes(lowerQuery) ||
      record.notes?.toLowerCase().includes(lowerQuery) ||
      record.tags.some(tag => tag.toLowerCase().includes(lowerQuery)) ||
      record.categories.some(cat => cat.toLowerCase().includes(lowerQuery))
    )
    .toArray();
}

export async function filterRecords(filters: {
  type?: 'address' | 'transaction' | 'all';
  tags?: string[];
  categories?: string[];
}) {
  let query = db.records.toCollection();
  
  if (filters.type && filters.type !== 'all') {
    query = query.filter(r => r.type === filters.type);
  }
  
  if (filters.tags && filters.tags.length > 0) {
    query = query.filter(r => filters.tags!.some(tag => r.tags.includes(tag)));
  }
  
  if (filters.categories && filters.categories.length > 0) {
    query = query.filter(r => filters.categories!.some(cat => r.categories.includes(cat)));
  }
  
  return query.reverse().sortBy('updatedAt');
}

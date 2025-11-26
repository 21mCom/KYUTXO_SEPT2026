import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Record } from '@/lib/database';
import { uploadAttachment, deleteAttachment } from '@/lib/attachments';

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

export async function createRecordWithAttachments(
  data: Omit<Record, 'id' | 'createdAt' | 'updatedAt'>,
  files: File[],
  onProgress?: (current: number, total: number) => void
): Promise<{ recordId: number; uploadedCount: number; failedCount: number }> {
  const now = Date.now();
  
  // First create the record to get an ID
  const recordId = await db.records.add({
    ...data,
    createdAt: now,
    updatedAt: now,
  }) as number;

  if (files.length === 0) {
    return { recordId, uploadedCount: 0, failedCount: 0 };
  }

  const uploadedAttachmentIds: number[] = [];
  let failedCount = 0;

  try {
    for (let i = 0; i < files.length; i++) {
      onProgress?.(i + 1, files.length);
      
      try {
        const result = await uploadAttachment(recordId, files[i]);
        uploadedAttachmentIds.push(result.id);
      } catch (error) {
        console.error(`Failed to upload file ${files[i].name}:`, error);
        failedCount++;
      }
    }

    // If all uploads failed, rollback
    if (failedCount === files.length && files.length > 0) {
      // Delete any successfully uploaded attachments
      for (const attachmentId of uploadedAttachmentIds) {
        try {
          await deleteAttachment(attachmentId);
        } catch (e) {
          console.error('Rollback attachment delete failed:', e);
        }
      }
      // Delete the record
      await db.records.delete(recordId);
      throw new Error('All file uploads failed. Record was not created.');
    }

    return { 
      recordId, 
      uploadedCount: uploadedAttachmentIds.length, 
      failedCount 
    };
  } catch (error) {
    // If something unexpected happened, try to rollback
    if (uploadedAttachmentIds.length > 0) {
      for (const attachmentId of uploadedAttachmentIds) {
        try {
          await deleteAttachment(attachmentId);
        } catch (e) {
          console.error('Rollback attachment delete failed:', e);
        }
      }
    }
    await db.records.delete(recordId);
    throw error;
  }
}

export async function updateRecord(id: number, data: Partial<Record>) {
  await db.records.update(id, {
    ...data,
    updatedAt: Date.now(),
  });
}

export async function deleteRecord(id: number) {
  // Delete associated attachments first - from both object storage and DB
  const attachments = await db.attachments.where('recordId').equals(id).toArray();
  
  for (const attachment of attachments) {
    try {
      // Delete from object storage
      const response = await fetch(`/api/attachments/${attachment.objectStoragePath}`, {
        method: 'DELETE',
      });
      
      if (!response.ok) {
        console.error(`Failed to delete attachment ${attachment.id} from object storage`);
      }
    } catch (error) {
      console.error(`Error deleting attachment ${attachment.id}:`, error);
    }
  }
  
  // Delete attachment metadata from IndexedDB
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

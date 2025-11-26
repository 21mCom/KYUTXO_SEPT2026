import { useLiveQuery } from 'dexie-react-hooks';
import { useState, useEffect } from 'react';
import { db, type Record } from '@/lib/database';
import { uploadAttachment, deleteAttachment } from '@/lib/attachments';
import { useAuth } from '@/contexts/AuthContext';
import { 
  createRecord as facadeCreateRecord,
  updateRecord as facadeUpdateRecord,
  deleteRecord as facadeDeleteRecord,
  decryptRecordById,
  decryptRecords,
  isEncryptionReady,
} from '@/lib/encryptionFacade';

// Hook to get all records with automatic decryption
export function useRecords() {
  const { encryptionKey } = useAuth();
  const [decryptedRecords, setDecryptedRecords] = useState<Record[]>([]);
  const [isDecrypting, setIsDecrypting] = useState(false);
  
  // Get raw records from database
  const rawRecords = useLiveQuery(
    () => db.records.orderBy('updatedAt').reverse().toArray()
  );
  
  // Decrypt records when they change
  useEffect(() => {
    const decrypt = async () => {
      if (!rawRecords) {
        setDecryptedRecords([]);
        return;
      }
      
      if (!isEncryptionReady()) {
        // If encryption not ready, show records as-is (may be plaintext)
        setDecryptedRecords(rawRecords);
        return;
      }
      
      setIsDecrypting(true);
      try {
        const decrypted = await decryptRecords(rawRecords);
        setDecryptedRecords(decrypted);
      } catch (error) {
        console.error('Failed to decrypt records:', error);
        // Fall back to raw records
        setDecryptedRecords(rawRecords);
      } finally {
        setIsDecrypting(false);
      }
    };
    
    decrypt();
  }, [rawRecords]);
  
  return {
    records: decryptedRecords,
    isLoading: rawRecords === undefined || isDecrypting,
  };
}

// Hook to get a single record with decryption
export function useRecord(id: number | undefined) {
  const { encryptionKey } = useAuth();
  const [decryptedRecord, setDecryptedRecord] = useState<Record | undefined>();
  const [isDecrypting, setIsDecrypting] = useState(false);
  
  const rawRecord = useLiveQuery(
    () => id ? db.records.get(id) : undefined,
    [id]
  );
  
  useEffect(() => {
    const decrypt = async () => {
      if (!rawRecord) {
        setDecryptedRecord(undefined);
        return;
      }
      
      if (!rawRecord.isEncrypted || !isEncryptionReady()) {
        setDecryptedRecord(rawRecord);
        return;
      }
      
      setIsDecrypting(true);
      try {
        const decrypted = await decryptRecordById(rawRecord.id!);
        setDecryptedRecord(decrypted);
      } catch (error) {
        console.error('Failed to decrypt record:', error);
        setDecryptedRecord(rawRecord);
      } finally {
        setIsDecrypting(false);
      }
    };
    
    decrypt();
  }, [rawRecord]);
  
  return {
    record: decryptedRecord,
    isLoading: (rawRecord === undefined && id !== undefined) || isDecrypting,
  };
}

// Create a new record (uses encryption facade)
export async function createRecord(data: Omit<Record, 'id' | 'createdAt' | 'updatedAt'>) {
  if (isEncryptionReady()) {
    return facadeCreateRecord(data);
  }
  
  // Fallback to unencrypted if not authenticated (shouldn't happen in normal flow)
  const now = Date.now();
  const id = await db.records.add({
    ...data,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

// Create record with attachments
export async function createRecordWithAttachments(
  data: Omit<Record, 'id' | 'createdAt' | 'updatedAt'>,
  files: File[],
  onProgress?: (current: number, total: number) => void
): Promise<{ recordId: number; uploadedCount: number; failedCount: number }> {
  // Create the record first
  const recordId = await createRecord(data) as number;

  if (files.length === 0) {
    return { recordId, uploadedCount: 0, failedCount: 0 };
  }

  const uploadedAttachmentIds: number[] = [];
  let failedCount = 0;

  try {
    for (let i = 0; i < files.length; i++) {
      onProgress?.(i + 1, files.length);
      
      try {
        const result = await uploadAttachment(recordId, files[i], data.inputString);
        
        // Note: Attachment metadata encryption is handled by the encryptAttachment import
        // which uses the encryption key from the facade
        
        uploadedAttachmentIds.push(result.id);
      } catch (error) {
        console.error(`Failed to upload file ${files[i].name}:`, error);
        failedCount++;
      }
    }

    // If all uploads failed, rollback
    if (failedCount === files.length && files.length > 0) {
      for (const attachmentId of uploadedAttachmentIds) {
        try {
          await deleteAttachment(attachmentId);
        } catch (e) {
          console.error('Rollback attachment delete failed:', e);
        }
      }
      await db.records.delete(recordId);
      throw new Error('All file uploads failed. Record was not created.');
    }

    return { 
      recordId, 
      uploadedCount: uploadedAttachmentIds.length, 
      failedCount 
    };
  } catch (error) {
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

// Update a record (uses encryption facade)
export async function updateRecord(id: number, data: Partial<Record>) {
  if (isEncryptionReady()) {
    return facadeUpdateRecord(id, data);
  }
  
  // Fallback to unencrypted
  await db.records.update(id, {
    ...data,
    updatedAt: Date.now(),
  });
}

// Delete a record (uses encryption facade)
export async function deleteRecord(id: number) {
  return facadeDeleteRecord(id);
}

// Search records (works with decrypted data in memory)
export async function searchRecords(query: string) {
  if (!query.trim()) {
    const records = await db.records.orderBy('updatedAt').reverse().toArray();
    if (isEncryptionReady()) {
      return decryptRecords(records);
    }
    return records;
  }
  
  const allRecords = await db.records.toArray();
  const decrypted = isEncryptionReady() 
    ? await decryptRecords(allRecords) 
    : allRecords;
  
  const lowerQuery = query.toLowerCase();
  
  return decrypted
    .filter(record => 
      record.label.toLowerCase().includes(lowerQuery) ||
      record.inputString.toLowerCase().includes(lowerQuery) ||
      record.notes?.toLowerCase().includes(lowerQuery) ||
      record.tags.some(tag => tag.toLowerCase().includes(lowerQuery)) ||
      record.categories.some(cat => cat.toLowerCase().includes(lowerQuery))
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// Filter records
export async function filterRecords(filters: {
  type?: 'address' | 'transaction' | 'other' | 'all';
  tags?: string[];
  categories?: string[];
}) {
  const allRecords = await db.records.toArray();
  const decrypted = isEncryptionReady() 
    ? await decryptRecords(allRecords) 
    : allRecords;
  
  let filtered = decrypted;
  
  if (filters.type && filters.type !== 'all') {
    filtered = filtered.filter(r => r.type === filters.type);
  }
  
  if (filters.tags && filters.tags.length > 0) {
    filtered = filtered.filter(r => filters.tags!.some(tag => r.tags.includes(tag)));
  }
  
  if (filters.categories && filters.categories.length > 0) {
    filtered = filtered.filter(r => filters.categories!.some(cat => r.categories.includes(cat)));
  }
  
  return filtered.sort((a, b) => b.updatedAt - a.updatedAt);
}

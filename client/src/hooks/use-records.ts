import { useLiveQuery } from 'dexie-react-hooks';
import { useState, useEffect, useCallback, useRef } from 'react';
import { db, type Record, type RecordOriginType, subscribeToDbChanges } from '@/lib/database';
import { uploadAttachment, deleteAttachment } from '@/lib/attachments';
import { useAuth } from '@/contexts/AuthContext';
import { 
  createRecord as facadeCreateRecord,
  updateRecord as facadeUpdateRecord,
  deleteRecord as facadeDeleteRecord,
  decryptRecordById,
  decryptRecords,
  isEncryptionReady,
  createRecordOrigin,
} from '@/lib/encryptionFacade';

// Hook to get all records with manual loading (no useLiveQuery)
// Loads once on mount and can be reloaded via the returned reload function
export function useRecords() {
  const [decryptedRecords, setDecryptedRecords] = useState<Record[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const loadVersionRef = useRef(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadRecords = useCallback(async () => {
    const version = ++loadVersionRef.current;
    setIsLoading(true);
    try {
      const rawRecords = await db.records.orderBy('updatedAt').reverse().toArray();
      if (loadVersionRef.current !== version) return;

      if (isEncryptionReady()) {
        const decrypted = await decryptRecords(rawRecords);
        if (loadVersionRef.current !== version) return;
        setDecryptedRecords(decrypted);
      } else {
        setDecryptedRecords(rawRecords);
      }
    } catch (error) {
      console.error('Failed to load records:', error);
      if (loadVersionRef.current === version) {
        setDecryptedRecords([]);
      }
    } finally {
      if (loadVersionRef.current === version) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    loadRecords();

    const unsubscribe = subscribeToDbChanges((tables) => {
      if (tables.includes('records') || tables.length === 0) {
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = setTimeout(() => {
          loadRecords();
        }, 500);
      }
    });

    return () => {
      unsubscribe();
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [loadRecords]);

  return {
    records: decryptedRecords,
    isLoading,
    reload: loadRecords,
  };
}

// User-curated importance tiers (records that should NOT be hidden when toggle is off)
const USER_CURATED_TIERS: string[] = ['verified', 'manual', 'wallet-import', 'xpub-derived'];
// Blockchain-discovered importance tiers
const BLOCKCHAIN_DISCOVERED_TIERS: string[] = ['blockchain-discovered', 'pending-review'];

// Hook to get filtered records with debounced manual loading (no useLiveQuery)
// Uses compound index [type+addressImportance] for zero-scan queries
// Supports optional pagination via offset/limit params for performance with large datasets
export function useFilteredRecords(
  includeBlockchainDiscovered: boolean,
  options?: { offset?: number; limit?: number }
) {
  const [decryptedRecords, setDecryptedRecords] = useState<Record[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [blockchainDiscoveredCount, setBlockchainDiscoveredCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const loadVersionRef = useRef(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const offset = options?.offset;
  const limit = options?.limit;

  const loadRecords = useCallback(async (includeBD: boolean, pgOffset?: number, pgLimit?: number) => {
    const version = ++loadVersionRef.current;
    setIsLoading(true);
    try {
      let rawRecords: Record[];
      let total: number;

      if (includeBD) {
        total = await db.records.count();
        if (loadVersionRef.current !== version) return;

        if (pgOffset !== undefined && pgLimit !== undefined) {
          rawRecords = await db.records.orderBy('updatedAt').reverse().offset(pgOffset).limit(pgLimit).toArray();
        } else {
          rawRecords = await db.records.orderBy('updatedAt').reverse().toArray();
        }
      } else {
        const curatedAddressCount = await db.records
          .where('[type+addressImportance]')
          .anyOf(USER_CURATED_TIERS.map(tier => ['address', tier]))
          .count();
        const transactionCount = await db.records
          .where('type')
          .equals('transaction')
          .count();
        const otherCount = await db.records
          .where('type')
          .equals('other')
          .count();
        total = curatedAddressCount + transactionCount + otherCount;
        if (loadVersionRef.current !== version) return;

        if (pgOffset !== undefined && pgLimit !== undefined) {
          const curatedAddresses = await db.records
            .where('[type+addressImportance]')
            .anyOf(USER_CURATED_TIERS.map(tier => ['address', tier]))
            .toArray();

          const transactions = await db.records
            .where('type')
            .equals('transaction')
            .toArray();

          const otherRecords = await db.records
            .where('type')
            .equals('other')
            .toArray();

          const combined = [...curatedAddresses, ...transactions, ...otherRecords];
          combined.sort((a, b) => b.updatedAt - a.updatedAt);
          rawRecords = combined.slice(pgOffset, pgOffset + pgLimit);
        } else {
          const curatedAddresses = await db.records
            .where('[type+addressImportance]')
            .anyOf(USER_CURATED_TIERS.map(tier => ['address', tier]))
            .toArray();

          const transactions = await db.records
            .where('type')
            .equals('transaction')
            .toArray();

          const otherRecords = await db.records
            .where('type')
            .equals('other')
            .toArray();

          const combined = [...curatedAddresses, ...transactions, ...otherRecords];
          combined.sort((a, b) => b.updatedAt - a.updatedAt);
          rawRecords = combined;
        }
      }

      if (loadVersionRef.current !== version) return;
      setTotalCount(total);

      const bdCount = await db.records
        .where('[type+addressImportance]')
        .anyOf(BLOCKCHAIN_DISCOVERED_TIERS.map(tier => ['address', tier]))
        .count();
      if (loadVersionRef.current !== version) return;
      setBlockchainDiscoveredCount(bdCount);

      if (isEncryptionReady()) {
        const decrypted = await decryptRecords(rawRecords);
        if (loadVersionRef.current !== version) return;
        setDecryptedRecords(decrypted);
      } else {
        setDecryptedRecords(rawRecords);
      }
    } catch (error) {
      console.error('Failed to load filtered records:', error);
      if (loadVersionRef.current === version) {
        setDecryptedRecords([]);
      }
    } finally {
      if (loadVersionRef.current === version) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    loadRecords(includeBlockchainDiscovered, offset, limit);

    const unsubscribe = subscribeToDbChanges((tables) => {
      if (tables.includes('records') || tables.length === 0) {
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = setTimeout(() => {
          loadRecords(includeBlockchainDiscovered, offset, limit);
        }, 500);
      }
    });

    return () => {
      unsubscribe();
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [includeBlockchainDiscovered, offset, limit, loadRecords]);

  return {
    records: decryptedRecords,
    isLoading,
    blockchainDiscoveredCount,
    totalCount,
    reload: () => loadRecords(includeBlockchainDiscovered, offset, limit),
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
// Also creates a RecordOrigin entry to track metadata provenance
export async function createRecord(data: Omit<Record, 'id' | 'createdAt' | 'updatedAt'>) {
  // Ensure addressImportance is set for compound index compatibility
  let addressImportance = data.addressImportance;
  if (!addressImportance) {
    if (data.type === 'transaction' || data.type === 'other') {
      addressImportance = 'manual';
    } else if ((data.syncDepth !== undefined && data.syncDepth > 0) || 
               data.source === 'blockchain-sync') {
      addressImportance = 'blockchain-discovered';
    } else if (data.source?.startsWith('walletImport-')) {
      addressImportance = 'wallet-import';
    } else if (data.source === 'xpub-import' || data.xpub || data.derivationPath) {
      addressImportance = 'xpub-derived';
    } else {
      addressImportance = 'manual';
    }
  }
  
  // Ensure syncDepth and maxSyncedDepth are set for new records
  // Manual/imported records are at depth 0, and haven't been synced (-1)
  const recordWithDefaults = {
    ...data,
    addressImportance,
    syncDepth: data.syncDepth ?? 0,
    maxSyncedDepth: data.maxSyncedDepth ?? -1,
  };
  
  let recordId: number;
  
  if (isEncryptionReady()) {
    recordId = await facadeCreateRecord(recordWithDefaults) as number;
    
    // Create a RecordOrigin entry to track the source of metadata
    // Determine origin type based on source field and addressImportance
    let originType: RecordOriginType = 'manual';
    
    if (data.source === 'blockchain-sync' || data.addressImportance === 'blockchain-discovered') {
      originType = 'blockchain-sync';
    } else if (data.source?.startsWith('walletImport-') || data.addressImportance === 'wallet-import') {
      originType = 'wallet-sync';
    } else if (data.addressImportance === 'xpub-derived' || data.xpub || data.derivationPath) {
      originType = 'xpub-derived';
    } else if (data.source?.includes('bulk') || data.source?.includes('import')) {
      originType = 'bulk-import';
    }
    
    try {
      await createRecordOrigin({
        recordId,
        originType,
        source: data.source || 'Manual entry',
        label: data.label,
        notes: data.notes,
        owner: data.owner,
        walletName: data.walletName,
        seedName: data.seedName,
        walletSoftware: data.walletSoftware,
        tags: data.tags,
        categories: data.categories,
      });
    } catch (originError) {
      console.error('[createRecord] Failed to create RecordOrigin:', originError);
      // Don't fail the record creation if origin creation fails
    }
    
    return recordId;
  }
  
  // Fallback to unencrypted if not authenticated (shouldn't happen in normal flow)
  const now = Date.now();
  const id = await db.records.add({
    ...recordWithDefaults,
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

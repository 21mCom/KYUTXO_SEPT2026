import { useLiveQuery } from 'dexie-react-hooks';
import { useState, useEffect, useCallback, useRef } from 'react';
import { db, type Record, type RecordOriginType, subscribeToDbChanges } from '@/lib/database';
import { uploadAttachment, deleteAttachment } from '@/lib/attachments';
import { 
  createRecord as facadeCreateRecord,
  updateRecord as facadeUpdateRecord,
  deleteRecord as facadeDeleteRecord,
  createRecordOrigin,
} from '@/lib/dataFacade';

export function useRecords() {
  const [records, setRecords] = useState<Record[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const loadVersionRef = useRef(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadRecords = useCallback(async () => {
    const version = ++loadVersionRef.current;
    setIsLoading(true);
    try {
      const rawRecords = await db.records.orderBy('updatedAt').reverse().toArray();
      if (loadVersionRef.current !== version) return;
      setRecords(rawRecords);
    } catch (error) {
      console.error('Failed to load records:', error);
      if (loadVersionRef.current === version) {
        setRecords([]);
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
    records,
    isLoading,
    reload: loadRecords,
  };
}

const USER_CURATED_TIERS: string[] = ['verified', 'manual', 'wallet-import', 'xpub-derived'];
const BLOCKCHAIN_DISCOVERED_TIERS: string[] = ['blockchain-discovered', 'pending-review'];

export function useFilteredRecords(
  includeBlockchainDiscovered: boolean,
  options?: { offset?: number; limit?: number }
) {
  const [records, setRecords] = useState<Record[]>([]);
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

      setRecords(rawRecords);
    } catch (error) {
      console.error('Failed to load filtered records:', error);
      if (loadVersionRef.current === version) {
        setRecords([]);
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
    records,
    isLoading,
    blockchainDiscoveredCount,
    totalCount,
    reload: () => loadRecords(includeBlockchainDiscovered, offset, limit),
  };
}

export function useRecord(id: number | undefined) {
  const [record, setRecord] = useState<Record | undefined>();
  
  const rawRecord = useLiveQuery(
    () => id ? db.records.get(id) : undefined,
    [id]
  );
  
  useEffect(() => {
    setRecord(rawRecord);
  }, [rawRecord]);
  
  return {
    record,
    isLoading: rawRecord === undefined && id !== undefined,
  };
}

export async function createRecord(data: Omit<Record, 'id' | 'createdAt' | 'updatedAt'>) {
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
  
  const recordWithDefaults = {
    ...data,
    addressImportance,
    syncDepth: data.syncDepth ?? 0,
    maxSyncedDepth: data.maxSyncedDepth ?? -1,
  };
  
  const recordId = await facadeCreateRecord(recordWithDefaults) as number;
  
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
  }
  
  return recordId;
}

export async function createRecordWithAttachments(
  data: Omit<Record, 'id' | 'createdAt' | 'updatedAt'>,
  files: File[],
  onProgress?: (current: number, total: number) => void
): Promise<{ recordId: number; uploadedCount: number; failedCount: number }> {
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
        uploadedAttachmentIds.push(result.id);
      } catch (error) {
        console.error(`Failed to upload file ${files[i].name}:`, error);
        failedCount++;
      }
    }

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

export async function updateRecord(id: number, data: Partial<Record>) {
  return facadeUpdateRecord(id, data);
}

export async function deleteRecord(id: number) {
  return facadeDeleteRecord(id);
}

export async function searchRecords(query: string) {
  if (!query.trim()) {
    return db.records.orderBy('updatedAt').reverse().toArray();
  }
  
  const allRecords = await db.records.toArray();
  const lowerQuery = query.toLowerCase();
  
  return allRecords
    .filter(record => 
      record.label.toLowerCase().includes(lowerQuery) ||
      record.inputString.toLowerCase().includes(lowerQuery) ||
      record.notes?.toLowerCase().includes(lowerQuery) ||
      record.tags.some(tag => tag.toLowerCase().includes(lowerQuery)) ||
      record.categories.some(cat => cat.toLowerCase().includes(lowerQuery))
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function filterRecords(filters: {
  type?: 'address' | 'transaction' | 'other' | 'all';
  tags?: string[];
  categories?: string[];
}) {
  const allRecords = await db.records.toArray();
  let filtered = allRecords;
  
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

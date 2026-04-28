import { useLiveQuery } from 'dexie-react-hooks';
import { useState, useEffect, useCallback, useRef } from 'react';
import { db, type Record, type RecordOriginType } from '@/lib/database';
import { uploadAttachment, deleteAttachment } from '@/lib/attachments';
import { 
  createRecord as facadeCreateRecord,
  updateRecord as facadeUpdateRecord,
  deleteRecord as facadeDeleteRecord,
  createRecordOrigin,
} from '@/lib/dataFacade';
import { useDbChangeSignal } from '@/hooks/use-db-change-signal';

const RECORDS_TABLES = ['records'];
const DEBOUNCE_MS = 500;

const DEFAULT_RECORDS_LIMIT = 5000;

export function useRecords(options?: { limit?: number }) {
  const recordLimit = options?.limit ?? DEFAULT_RECORDS_LIMIT;
  const [records, setRecords] = useState<Record[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const loadVersionRef = useRef(0);
  const dbChangeSignal = useDbChangeSignal(RECORDS_TABLES, DEBOUNCE_MS);

  const loadRecords = useCallback(async () => {
    const version = ++loadVersionRef.current;
    setIsLoading(true);
    try {
      const rawRecords = await db.records
        .orderBy('updatedAt')
        .reverse()
        .limit(recordLimit)
        .toArray();
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
  }, [recordLimit]);

  useEffect(() => {
    loadRecords();
  }, [loadRecords, dbChangeSignal]);

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
  const dbChangeSignal = useDbChangeSignal(RECORDS_TABLES, DEBOUNCE_MS);

  const offset = options?.offset;
  const limit = options?.limit;

  const loadRecords = useCallback(async (includeBD: boolean, pgOffset?: number, pgLimit?: number) => {
    const version = ++loadVersionRef.current;
    setIsLoading(true);
    try {
      let rawRecords: Record[];
      let total: number;

      const effectiveLimit = pgLimit ?? DEFAULT_RECORDS_LIMIT;
      const effectiveOffset = pgOffset ?? 0;

      if (includeBD) {
        total = await db.records.count();
        if (loadVersionRef.current !== version) return;

        rawRecords = await db.records
          .orderBy('updatedAt').reverse()
          .offset(effectiveOffset).limit(effectiveLimit).toArray();
      } else {
        const blockchainCount = await db.records
          .where('addressImportance')
          .anyOf(['blockchain-discovered', 'pending-review'])
          .count();
        total = (await db.records.count()) - blockchainCount;
        if (loadVersionRef.current !== version) return;

        const excludeBlockchain = (r: Record) =>
          r.addressImportance !== 'blockchain-discovered' &&
          r.addressImportance !== 'pending-review';

        rawRecords = await db.records
          .orderBy('updatedAt').reverse()
          .filter(excludeBlockchain)
          .offset(effectiveOffset).limit(effectiveLimit).toArray();
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
  }, [includeBlockchainDiscovered, offset, limit, loadRecords, dbChangeSignal]);

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
    return db.records.orderBy('updatedAt').reverse().limit(200).toArray();
  }
  
  const lowerQuery = query.toLowerCase();
  
  return db.records
    .orderBy('updatedAt')
    .reverse()
    .filter(record => 
      record.label.toLowerCase().includes(lowerQuery) ||
      record.inputString.toLowerCase().includes(lowerQuery) ||
      record.notes?.toLowerCase().includes(lowerQuery) ||
      record.tags.some(tag => tag.toLowerCase().includes(lowerQuery)) ||
      record.categories.some(cat => cat.toLowerCase().includes(lowerQuery))
    )
    .limit(200)
    .toArray();
}

export async function filterRecords(filters: {
  type?: 'address' | 'transaction' | 'other' | 'all';
  tags?: string[];
  categories?: string[];
}) {
  const hasTagFilter = filters.tags && filters.tags.length > 0;
  const hasCategoryFilter = filters.categories && filters.categories.length > 0;
  
  const additionalFilter = (r: Record) => {
    if (hasTagFilter && !filters.tags!.some(tag => r.tags.includes(tag))) return false;
    if (hasCategoryFilter && !filters.categories!.some(cat => r.categories.includes(cat))) return false;
    return true;
  };

  if (filters.type && filters.type !== 'all') {
    return db.records
      .where('type')
      .equals(filters.type)
      .filter(additionalFilter)
      .limit(500)
      .toArray();
  }
  
  return db.records
    .orderBy('updatedAt')
    .reverse()
    .filter(additionalFilter)
    .limit(500)
    .toArray();
}

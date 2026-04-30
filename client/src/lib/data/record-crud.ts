import { db, notifyDbChange, type Record, type Attachment, type RecordOrigin, type RecordOriginType, type DerivationTemplate, type AddressImportance } from '../database';
import { ensureOwner, ensureWalletName, ensureSeedName, ensureWalletSoftware } from './vocabulary-crud';
import { getActivityBus } from '../activity-bus';

async function syncRecordVocabulary(
  data: Partial<Record>
): Promise<void> {
  const syncTasks: Promise<void>[] = [];

  if (data.owner && data.owner !== 'Unknown') {
    syncTasks.push(ensureOwner(data.owner));
  }

  if (data.walletName) {
    syncTasks.push(ensureWalletName(data.walletName));
  }

  if (data.seedName) {
    syncTasks.push(ensureSeedName(data.seedName));
  }

  if (data.walletSoftware) {
    syncTasks.push(ensureWalletSoftware(data.walletSoftware));
  }

  await Promise.all(syncTasks);
}

export type CreateRecordData = Omit<Record, 'id' | 'createdAt' | 'updatedAt'> & {
  createdAt?: number;
  updatedAt?: number;
};

export interface CreateRecordOptions {
  skipNotification?: boolean;
  skipVocabularySync?: boolean;
}

function deriveAddressImportance(data: CreateRecordData): AddressImportance {
  if (data.addressImportance) return data.addressImportance;
  if (data.syncDepth !== undefined && data.syncDepth > 0) return 'blockchain-discovered';
  if (data.source === 'blockchain-sync') return 'blockchain-discovered';
  if (data.source?.startsWith('walletImport-')) return 'wallet-import';
  if (data.source === 'xpub-import' || data.xpub || data.derivationPath) return 'xpub-derived';
  return 'manual';
}

function buildFullRecord(data: CreateRecordData): Record {
  const now = Date.now();
  return {
    ...data,
    addressImportance: deriveAddressImportance(data),
    inputStringLower: data.inputString ? data.inputString.toLowerCase() : '',
    createdAt: data.createdAt ?? now,
    updatedAt: data.updatedAt ?? now,
  };
}

export async function createRecord(
  data: CreateRecordData,
  options?: CreateRecordOptions
): Promise<number> {
  const record = buildFullRecord(data);

  console.log(`[createRecord] Creating record: type=${data.type}, inputString=${data.inputString?.substring(0, 20)}...`);
  
  if (!options?.skipVocabularySync) {
    syncRecordVocabulary(data).catch((err) => {
      console.warn('[createRecord] Vocabulary sync failed:', err);
    });
  }
  
  const id = await db.records.add(record);
  
  if (!options?.skipNotification) {
    notifyDbChange('records');
  }
  
  console.log(`[createRecord] Record created with id=${id}`);
  
  return id as number;
}

export async function bulkCreateRecords(
  records: CreateRecordData[],
  options?: CreateRecordOptions
): Promise<number[]> {
  if (records.length === 0) return [];

  console.log(`[bulkCreateRecords] Creating ${records.length} records...`);
  const startTime = performance.now();
  try {
    getActivityBus().publishTask({
      id: 'bulk-create-records',
      label: 'Creating Records',
      phase: `Inserting ${records.length} records`,
      current: 0,
      total: records.length,
    });
  } catch {}

  try {
    const fullRecords = records.map(buildFullRecord);

    try {
      getActivityBus().publishTask({
        id: 'bulk-create-records',
        label: 'Creating Records',
        phase: `Writing ${records.length} records`,
        current: fullRecords.length,
        total: records.length,
      });
    } catch {}

    const ids = await db.transaction('rw', db.records, async () => {
      return await db.records.bulkAdd(fullRecords, { allKeys: true });
    });

    if (!options?.skipVocabularySync) {
      const vocabularyValues = {
        owners: new Set<string>(),
        walletNames: new Set<string>(),
        seedNames: new Set<string>(),
        walletSoftware: new Set<string>(),
      };

      for (const data of records) {
        if (data.owner && data.owner !== 'Unknown') vocabularyValues.owners.add(data.owner);
        if (data.walletName) vocabularyValues.walletNames.add(data.walletName);
        if (data.seedName) vocabularyValues.seedNames.add(data.seedName);
        if (data.walletSoftware) vocabularyValues.walletSoftware.add(data.walletSoftware);
      }

      batchSyncVocabulary(vocabularyValues).catch((err) => {
        console.warn('[bulkCreateRecords] Vocabulary sync failed:', err);
      });
    }

    if (!options?.skipNotification) {
      notifyDbChange('records');
    }

    const duration = performance.now() - startTime;
    console.log(`[bulkCreateRecords] Created ${ids.length} records in ${duration.toFixed(0)}ms`);

    return ids as number[];
  } finally {
    try { getActivityBus().completeTask('bulk-create-records'); } catch {}
  }
}

export interface UpdateRecordOptions {
  skipNotification?: boolean;
  skipVocabularySync?: boolean;
}

export async function updateRecord(
  id: number,
  updates: Partial<Record>,
  options?: UpdateRecordOptions
): Promise<void> {
  const existing = await db.records.get(id);
  if (!existing) throw new Error('Record not found');

  const merged = {
    ...existing,
    ...updates,
    id,
    updatedAt: Date.now(),
  };
  if (updates.inputString !== undefined) {
    merged.inputStringLower = updates.inputString ? updates.inputString.toLowerCase() : '';
  }
  const updated: Record = merged;

  if (!options?.skipVocabularySync) {
    syncRecordVocabulary(updates).catch((err) => {
      console.warn('[updateRecord] Vocabulary sync failed:', err);
    });
  }

  await db.records.put(updated);
  
  if (!options?.skipNotification) {
    notifyDbChange('records');
  }
}

function deduplicateByNormalizedKey(values: Set<string>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  Array.from(values).forEach(name => {
    const key = name.trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      unique.push(name);
    }
  });
  return unique;
}

async function ensureAllSequentially(
  names: string[],
  ensureFn: (name: string) => Promise<void>
): Promise<void> {
  for (let i = 0; i < names.length; i++) {
    await ensureFn(names[i]);
  }
}

async function batchSyncVocabulary(
  values: {
    owners: Set<string>;
    walletNames: Set<string>;
    seedNames: Set<string>;
    walletSoftware: Set<string>;
  }
): Promise<void> {
  const tasks: Promise<void>[] = [];

  const owners = deduplicateByNormalizedKey(values.owners);
  const walletNames = deduplicateByNormalizedKey(values.walletNames);
  const seedNames = deduplicateByNormalizedKey(values.seedNames);
  const walletSoftwareNames = deduplicateByNormalizedKey(values.walletSoftware);

  if (owners.length > 0) tasks.push(ensureAllSequentially(owners, ensureOwner));
  if (walletNames.length > 0) tasks.push(ensureAllSequentially(walletNames, ensureWalletName));
  if (seedNames.length > 0) tasks.push(ensureAllSequentially(seedNames, ensureSeedName));
  if (walletSoftwareNames.length > 0) tasks.push(ensureAllSequentially(walletSoftwareNames, ensureWalletSoftware));

  await Promise.all(tasks);
}

export async function bulkUpdateRecords(
  updates: Array<{ id: number; changes: Partial<Record> }>,
  options?: UpdateRecordOptions
): Promise<{ successCount: number; errorCount: number }> {
  const now = Date.now();
  
  if (updates.length === 0) {
    return { successCount: 0, errorCount: 0 };
  }
  
  console.log(`[bulkUpdateRecords] Processing ${updates.length} records...`);
  const startTime = performance.now();
  try {
    getActivityBus().publishTask({
      id: 'bulk-update-records',
      label: 'Updating Records',
      phase: `Updating ${updates.length} records`,
      current: 0,
      total: updates.length,
    });
  } catch {}
  
  try {
    const ids = updates.map(u => u.id);
    const existingRecords = await db.records.where('id').anyOf(ids).toArray();
    try {
      getActivityBus().publishTask({
        id: 'bulk-update-records',
        label: 'Updating Records',
        phase: `Writing ${updates.length} records`,
        current: existingRecords.length,
        total: updates.length,
      });
    } catch {}

    const existingMap = new Map<number, Record>();
    for (const record of existingRecords) {
      existingMap.set(record.id!, record);
    }
    
    const recordsToSave: Record[] = [];
    const allChanges: Partial<Record>[] = [];
    let errorCount = 0;
    
    for (const { id, changes } of updates) {
      const existing = existingMap.get(id);
      if (!existing) {
        console.warn(`[bulkUpdateRecords] Record ${id} not found, skipping`);
        errorCount++;
        continue;
      }
      
      const merged = {
        ...existing,
        ...changes,
        id,
        updatedAt: now,
      };
      if (changes.inputString !== undefined) {
        merged.inputStringLower = changes.inputString ? changes.inputString.toLowerCase() : '';
      }
      const updated: Record = merged;
      
      recordsToSave.push(updated);
      allChanges.push(changes);
    }
    
    await db.transaction('rw', db.records, async () => {
      await db.records.bulkPut(recordsToSave);
    });
    
    if (!options?.skipVocabularySync) {
      const vocabularyValues = {
        owners: new Set<string>(),
        walletNames: new Set<string>(),
        seedNames: new Set<string>(),
        walletSoftware: new Set<string>(),
      };
      
      for (const changes of allChanges) {
        if (changes.owner && changes.owner !== 'Unknown') {
          vocabularyValues.owners.add(changes.owner);
        }
        if (changes.walletName) {
          vocabularyValues.walletNames.add(changes.walletName);
        }
        if (changes.seedName) {
          vocabularyValues.seedNames.add(changes.seedName);
        }
        if (changes.walletSoftware) {
          vocabularyValues.walletSoftware.add(changes.walletSoftware);
        }
      }
      
      batchSyncVocabulary(vocabularyValues).catch((err) => {
        console.warn('[bulkUpdateRecords] Vocabulary sync failed:', err);
      });
    }
    
    if (!options?.skipNotification) {
      notifyDbChange('records');
    }
    
    const duration = performance.now() - startTime;
    console.log(`[bulkUpdateRecords] Completed: ${recordsToSave.length} records in ${duration.toFixed(0)}ms (${(duration / recordsToSave.length).toFixed(1)}ms/record)`);

    return { successCount: recordsToSave.length, errorCount };
  } finally {
    try { getActivityBus().completeTask('bulk-update-records'); } catch {}
  }
}

export interface DeleteRecordOptions {
  skipNotification?: boolean;
}

export async function deleteRecord(id: number, options?: DeleteRecordOptions): Promise<void> {
  const attachments = await db.attachments.where('recordId').equals(id).toArray();

  for (const attachment of attachments) {
    try {
      const response = await fetch(`/api/attachments/${attachment.objectStoragePath}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        console.error(`Failed to delete attachment ${attachment.id}`);
      }
    } catch (error) {
      console.error(`Error deleting attachment ${attachment.id}:`, error);
    }
  }

  await db.attachments.where('recordId').equals(id).delete();
  await db.records.delete(id);
  
  if (!options?.skipNotification) {
    notifyDbChange('records');
  }
}

export interface ClearAllRecordsOptions {
  skipNotification?: boolean;
}

export async function clearAllRecords(options?: ClearAllRecordsOptions): Promise<void> {
  await db.records.clear();

  if (!options?.skipNotification) {
    notifyDbChange('records');
  }
}

export async function findRecordByInputString(inputString: string): Promise<Record | undefined> {
  if (!inputString) return undefined;

  const trimmed = inputString.trim();

  const exactMatch = await db.records.where('inputString').equals(trimmed).first();
  if (exactMatch) return exactMatch;

  return await db.records.where('inputStringLower').equals(trimmed.toLowerCase()).first();
}

export async function createRecordOrigin(
  data: Omit<RecordOrigin, 'id' | 'createdAt'>
): Promise<number> {
  const origin: RecordOrigin = {
    ...data,
    createdAt: Date.now(),
  };

  const id = await db.recordOrigins.add(origin);
  return id as number;
}

export async function getRecordOrigins(recordId: number): Promise<RecordOrigin[]> {
  return db.recordOrigins.where('recordId').equals(recordId).toArray();
}

export function mergeRecordWithOrigins(
  record: Record, 
  origins: RecordOrigin[]
): Record {
  if (origins.length === 0) return record;
  
  const priorityOrder: { [key in RecordOriginType]: number } = {
    'manual': 0,
    'wallet-sync': 1,
    'xpub-derived': 2,
    'bulk-import': 3,
    'blockchain-sync': 4,
  };
  
  const sortedOrigins = [...origins].sort(
    (a, b) => priorityOrder[a.originType] - priorityOrder[b.originType]
  );
  
  const merged = { ...record };
  
  const allTags = new Set(record.tags || []);
  const allCategories = new Set(record.categories || []);
  
  for (const origin of sortedOrigins) {
    if (origin.tags) {
      origin.tags.forEach(t => allTags.add(t));
    }
    if (origin.categories) {
      origin.categories.forEach(c => allCategories.add(c));
    }
  }
  
  for (const origin of sortedOrigins) {
    if (!merged.label && origin.label) merged.label = origin.label;
    if (!merged.notes && origin.notes) merged.notes = origin.notes;
    if (!merged.seedName && origin.seedName) merged.seedName = origin.seedName;
    if (!merged.walletSoftware && origin.walletSoftware) merged.walletSoftware = origin.walletSoftware;
    if (!merged.privateKeyStatus && origin.privateKeyStatus) merged.privateKeyStatus = origin.privateKeyStatus;
    if (!merged.owner && origin.owner) merged.owner = origin.owner;
    if (!merged.walletName && origin.walletName) merged.walletName = origin.walletName;
    if (!merged.source && origin.source) merged.source = origin.source;
    if (!merged.xpub && origin.xpub) merged.xpub = origin.xpub;
    if (!merged.derivationPath && origin.derivationPath) merged.derivationPath = origin.derivationPath;
    if (!merged.chainType && origin.chainType) merged.chainType = origin.chainType;
  }
  
  merged.tags = Array.from(allTags);
  merged.categories = Array.from(allCategories);
  
  return merged;
}

export async function saveDerivationTemplate(template: {
  fingerprint: string;
  scriptType: 'P2WPKH' | 'P2PKH' | 'P2SH-P2WPKH' | 'P2TR';
  derivationPath: string;
  xpub: string;
  gapLimit: number;
  network: 'mainnet' | 'testnet';
  owner?: string;
  walletName?: string;
  seedName?: string;
  notes?: string;
}): Promise<number> {
  const now = Date.now();
  const derivationTemplate: DerivationTemplate = {
    fingerprint: template.fingerprint,
    scriptType: template.scriptType,
    derivationPath: template.derivationPath,
    xpub: template.xpub,
    gapLimit: template.gapLimit,
    network: template.network,
    owner: template.owner,
    walletName: template.walletName,
    seedName: template.seedName,
    notes: template.notes,
    createdAt: now,
    updatedAt: now,
  };
  
  return await db.derivationTemplates.add(derivationTemplate);
}

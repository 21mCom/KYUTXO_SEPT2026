import { db, notifyDbChange, type Record, type Attachment, type RecordOrigin, type RecordOriginType, type Owner, type WalletName, type SeedName, type WalletSoftware, type DerivationTemplate, type AddressImportance } from '../database';

async function syncRecordVocabulary(
  data: Partial<Record>
): Promise<void> {
  const syncTasks: Promise<void>[] = [];

  if (data.owner && data.owner !== 'Unknown') {
    syncTasks.push((async () => {
      const owners = await db.owners.toArray();
      const exists = owners.some(
        (o) => o.name && o.name.toLowerCase() === data.owner!.toLowerCase()
      );
      if (!exists) {
        await db.owners.add({ name: data.owner!, createdAt: Date.now() });
      }
    })());
  }

  if (data.walletName) {
    syncTasks.push((async () => {
      const walletNames = await db.walletNames.toArray();
      const exists = walletNames.some(
        (wn) => wn.name && wn.name.toLowerCase() === data.walletName!.toLowerCase()
      );
      if (!exists) {
        await db.walletNames.add({ name: data.walletName!, createdAt: Date.now() });
      }
    })());
  }

  if (data.seedName) {
    syncTasks.push((async () => {
      const seedNames = await db.seedNames.toArray();
      const exists = seedNames.some(
        (sn) => sn.name && sn.name.toLowerCase() === data.seedName!.toLowerCase()
      );
      if (!exists) {
        await db.seedNames.add({ name: data.seedName!, createdAt: Date.now() });
      }
    })());
  }

  if (data.walletSoftware) {
    syncTasks.push((async () => {
      const walletSoftwareList = await db.walletSoftware.toArray();
      const exists = walletSoftwareList.some(
        (ws) => ws.name && ws.name.toLowerCase() === data.walletSoftware!.toLowerCase()
      );
      if (!exists) {
        await db.walletSoftware.add({ name: data.walletSoftware!, createdAt: Date.now() });
      }
    })());
  }

  await Promise.all(syncTasks);
}

export async function createRecord(
  data: Omit<Record, 'id' | 'createdAt' | 'updatedAt'>
): Promise<number> {
  const now = Date.now();
  
  let addressImportance = data.addressImportance;
  if (!addressImportance) {
    if (data.syncDepth !== undefined && data.syncDepth > 0) {
      addressImportance = 'blockchain-discovered';
    } else if (data.source === 'blockchain-sync') {
      addressImportance = 'blockchain-discovered';
    } else if (data.source?.startsWith('walletImport-')) {
      addressImportance = 'wallet-import';
    } else if (data.source === 'xpub-import' || data.xpub || data.derivationPath) {
      addressImportance = 'xpub-derived';
    } else {
      addressImportance = 'manual';
    }
  }
  
  const record: Record = {
    ...data,
    addressImportance,
    createdAt: now,
    updatedAt: now,
  };

  console.log(`[createRecord] Creating record: type=${data.type}, inputString=${data.inputString?.substring(0, 20)}...`);
  
  syncRecordVocabulary(data).catch((err) => {
    console.warn('[createRecord] Vocabulary sync failed:', err);
  });
  
  const id = await db.records.add(record);
  
  notifyDbChange('records');
  
  console.log(`[createRecord] Record created with id=${id}`);
  
  return id as number;
}

export async function updateRecord(
  id: number,
  updates: Partial<Record>
): Promise<void> {
  const existing = await db.records.get(id);
  if (!existing) throw new Error('Record not found');

  const updated: Record = {
    ...existing,
    ...updates,
    id,
    updatedAt: Date.now(),
  };

  syncRecordVocabulary(updates).catch((err) => {
    console.warn('[updateRecord] Vocabulary sync failed:', err);
  });

  await db.records.put(updated);
  
  notifyDbChange('records');
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
  
  if (values.owners.size > 0) {
    tasks.push((async () => {
      const existing = await db.owners.toArray();
      const existingNames = new Set<string>();
      for (const o of existing) {
        if (o.name) existingNames.add(o.name.toLowerCase());
      }
      
      const toAdd: Owner[] = [];
      for (const name of Array.from(values.owners)) {
        if (!existingNames.has(name.toLowerCase())) {
          toAdd.push({ name, createdAt: Date.now() });
        }
      }
      
      if (toAdd.length > 0) {
        await db.owners.bulkAdd(toAdd);
      }
    })());
  }
  
  if (values.walletNames.size > 0) {
    tasks.push((async () => {
      const existing = await db.walletNames.toArray();
      const existingNames = new Set<string>();
      for (const wn of existing) {
        if (wn.name) existingNames.add(wn.name.toLowerCase());
      }
      
      const toAdd: WalletName[] = [];
      for (const name of Array.from(values.walletNames)) {
        if (!existingNames.has(name.toLowerCase())) {
          toAdd.push({ name, createdAt: Date.now() });
        }
      }
      
      if (toAdd.length > 0) {
        await db.walletNames.bulkAdd(toAdd);
      }
    })());
  }
  
  if (values.seedNames.size > 0) {
    tasks.push((async () => {
      const existing = await db.seedNames.toArray();
      const existingNames = new Set<string>();
      for (const sn of existing) {
        if (sn.name) existingNames.add(sn.name.toLowerCase());
      }
      
      const toAdd: SeedName[] = [];
      for (const name of Array.from(values.seedNames)) {
        if (!existingNames.has(name.toLowerCase())) {
          toAdd.push({ name, createdAt: Date.now() });
        }
      }
      
      if (toAdd.length > 0) {
        await db.seedNames.bulkAdd(toAdd);
      }
    })());
  }
  
  if (values.walletSoftware.size > 0) {
    tasks.push((async () => {
      const existing = await db.walletSoftware.toArray();
      const existingNames = new Set<string>();
      for (const ws of existing) {
        if (ws.name) existingNames.add(ws.name.toLowerCase());
      }
      
      const toAdd: WalletSoftware[] = [];
      for (const name of Array.from(values.walletSoftware)) {
        if (!existingNames.has(name.toLowerCase())) {
          toAdd.push({ name, createdAt: Date.now() });
        }
      }
      
      if (toAdd.length > 0) {
        await db.walletSoftware.bulkAdd(toAdd);
      }
    })());
  }
  
  await Promise.all(tasks);
}

export async function bulkUpdateRecords(
  updates: Array<{ id: number; changes: Partial<Record> }>
): Promise<{ successCount: number; errorCount: number }> {
  const now = Date.now();
  
  if (updates.length === 0) {
    return { successCount: 0, errorCount: 0 };
  }
  
  console.log(`[bulkUpdateRecords] Processing ${updates.length} records...`);
  const startTime = performance.now();
  
  const ids = updates.map(u => u.id);
  const existingRecords = await db.records.where('id').anyOf(ids).toArray();
  
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
    
    const updated: Record = {
      ...existing,
      ...changes,
      id,
      updatedAt: now,
    };
    
    recordsToSave.push(updated);
    allChanges.push(changes);
  }
  
  await db.transaction('rw', db.records, async () => {
    await db.records.bulkPut(recordsToSave);
  });
  
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
  
  notifyDbChange('records');
  
  const duration = performance.now() - startTime;
  console.log(`[bulkUpdateRecords] Completed: ${recordsToSave.length} records in ${duration.toFixed(0)}ms (${(duration / recordsToSave.length).toFixed(1)}ms/record)`);
  
  return { successCount: recordsToSave.length, errorCount };
}

export async function deleteRecord(id: number): Promise<void> {
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
  
  notifyDbChange('records');
}

export async function findRecordByInputString(inputString: string): Promise<Record | undefined> {
  if (!inputString) return undefined;
  
  const normalizedInput = inputString.trim().toLowerCase();
  
  const allRecords = await db.records.toArray();
  
  for (const record of allRecords) {
    if (record.inputString && record.inputString.trim().toLowerCase() === normalizedInput) {
      return record;
    }
  }
  
  return undefined;
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

export async function getDecryptedRecordOrigins(recordId: number): Promise<RecordOrigin[]> {
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

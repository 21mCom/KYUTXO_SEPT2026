import { db, notifyDbChange, type Record, type Attachment, type RecordOrigin, type RecordOriginType, type Owner, type WalletName, type SeedName, type WalletSoftware, type DerivationTemplate, type AddressImportance } from '../database';
import { encrypt } from '../crypto';
import {
  encryptRecord,
  decryptRecord,
  decryptAttachment,
  encryptRecordOrigin,
  decryptRecordOrigin,
  encryptOwner,
  decryptOwner,
  encryptWalletName,
  decryptWalletName,
  encryptSeedName,
  decryptSeedName,
  encryptWalletSoftware,
  decryptWalletSoftware,
} from '../dbEncryption';
import { getKey, getEncryptionKey } from './key-management';
import { invalidateCachedRecord, invalidateCachedRecords } from './decrypt-cache';

// ============ VOCABULARY SYNC ============

async function syncRecordVocabulary(
  data: Partial<Record>,
  key: CryptoKey
): Promise<void> {
  const syncTasks: Promise<void>[] = [];

  if (data.owner && data.owner !== 'Unknown' && data.owner !== '[encrypted]') {
    syncTasks.push((async () => {
      const owners = await db.owners.toArray();
      const decryptedNames = await Promise.all(
        owners.map(async (o) => {
          if (o.isEncrypted) {
            try {
              const decrypted = await decryptOwner(o, key);
              return decrypted.name;
            } catch {
              return null;
            }
          }
          return o.name;
        })
      );
      const exists = decryptedNames.some(
        (name) => name && name.toLowerCase() === data.owner!.toLowerCase()
      );
      if (!exists) {
        const owner: Owner = { name: data.owner!, createdAt: Date.now() };
        const encrypted = await encryptOwner(owner, key);
        await db.owners.add(encrypted);
      }
    })());
  }

  if (data.walletName && data.walletName !== '[encrypted]') {
    syncTasks.push((async () => {
      const walletNames = await db.walletNames.toArray();
      const decryptedNames = await Promise.all(
        walletNames.map(async (wn) => {
          if (wn.isEncrypted) {
            try {
              const decrypted = await decryptWalletName(wn, key);
              return decrypted.name;
            } catch {
              return null;
            }
          }
          return wn.name;
        })
      );
      const exists = decryptedNames.some(
        (name) => name && name.toLowerCase() === data.walletName!.toLowerCase()
      );
      if (!exists) {
        const walletName: WalletName = { name: data.walletName!, createdAt: Date.now() };
        const encrypted = await encryptWalletName(walletName, key);
        await db.walletNames.add(encrypted);
      }
    })());
  }

  if (data.seedName && data.seedName !== '[encrypted]') {
    syncTasks.push((async () => {
      const seedNames = await db.seedNames.toArray();
      const decryptedNames = await Promise.all(
        seedNames.map(async (sn) => {
          if (sn.isEncrypted) {
            try {
              const decrypted = await decryptSeedName(sn, key);
              return decrypted.name;
            } catch {
              return null;
            }
          }
          return sn.name;
        })
      );
      const exists = decryptedNames.some(
        (name) => name && name.toLowerCase() === data.seedName!.toLowerCase()
      );
      if (!exists) {
        const seedName: SeedName = { name: data.seedName!, createdAt: Date.now() };
        const encrypted = await encryptSeedName(seedName, key);
        await db.seedNames.add(encrypted);
      }
    })());
  }

  if (data.walletSoftware && data.walletSoftware !== '[encrypted]') {
    syncTasks.push((async () => {
      const walletSoftwareList = await db.walletSoftware.toArray();
      const decryptedNames = await Promise.all(
        walletSoftwareList.map(async (ws) => {
          if (ws.isEncrypted) {
            try {
              const decrypted = await decryptWalletSoftware(ws, key);
              return decrypted.name;
            } catch {
              return null;
            }
          }
          return ws.name;
        })
      );
      const exists = decryptedNames.some(
        (name) => name && name.toLowerCase() === data.walletSoftware!.toLowerCase()
      );
      if (!exists) {
        const walletSoftware: WalletSoftware = { name: data.walletSoftware!, createdAt: Date.now() };
        const encrypted = await encryptWalletSoftware(walletSoftware, key);
        await db.walletSoftware.add(encrypted);
      }
    })());
  }

  await Promise.all(syncTasks);
}

// ============ RECORD OPERATIONS ============

export async function createRecord(
  data: Omit<Record, 'id' | 'createdAt' | 'updatedAt'>
): Promise<number> {
  const key = getKey();
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
  
  syncRecordVocabulary(data, key).catch((err) => {
    console.warn('[createRecord] Vocabulary sync failed:', err);
  });
  
  const encrypted = await encryptRecord(record, key);
  const id = await db.records.add(encrypted);
  invalidateCachedRecord(id as number);
  
  notifyDbChange('records');
  
  console.log(`[createRecord] Record created with id=${id}`);
  
  const saved = await db.records.get(id as number);
  if (saved) {
    console.log(`[createRecord] Verified: record ${id} exists in database, isEncrypted=${saved.isEncrypted}`);
  } else {
    console.error(`[createRecord] ERROR: record ${id} NOT FOUND after creation!`);
  }
  
  return id as number;
}

export async function updateRecord(
  id: number,
  updates: Partial<Record>
): Promise<void> {
  const key = getKey();
  
  const existing = await db.records.get(id);
  if (!existing) throw new Error('Record not found');

  const decrypted = existing.isEncrypted
    ? await decryptRecord(existing, key)
    : existing;

  const updated: Record = {
    ...decrypted,
    ...updates,
    id,
    updatedAt: Date.now(),
  };

  syncRecordVocabulary(updates, key).catch((err) => {
    console.warn('[updateRecord] Vocabulary sync failed:', err);
  });

  const encrypted = await encryptRecord(updated, key);
  await db.records.put(encrypted);
  invalidateCachedRecord(id);
  
  notifyDbChange('records');
}

async function batchSyncVocabulary(
  values: {
    owners: Set<string>;
    walletNames: Set<string>;
    seedNames: Set<string>;
    walletSoftware: Set<string>;
  },
  key: CryptoKey
): Promise<void> {
  const tasks: Promise<void>[] = [];
  
  if (values.owners.size > 0) {
    tasks.push((async () => {
      const existing = await db.owners.toArray();
      const existingNames = new Set<string>();
      for (const o of existing) {
        if (o.isEncrypted) {
          try {
            const decrypted = await decryptOwner(o, key);
            existingNames.add(decrypted.name.toLowerCase());
          } catch { /* ignore */ }
        } else {
          existingNames.add(o.name.toLowerCase());
        }
      }
      
      const toAdd: Owner[] = [];
      for (const name of Array.from(values.owners)) {
        if (!existingNames.has(name.toLowerCase())) {
          toAdd.push({ name, createdAt: Date.now() });
        }
      }
      
      if (toAdd.length > 0) {
        const encrypted = await Promise.all(toAdd.map(o => encryptOwner(o, key)));
        await db.owners.bulkAdd(encrypted);
      }
    })());
  }
  
  if (values.walletNames.size > 0) {
    tasks.push((async () => {
      const existing = await db.walletNames.toArray();
      const existingNames = new Set<string>();
      for (const wn of existing) {
        if (wn.isEncrypted) {
          try {
            const decrypted = await decryptWalletName(wn, key);
            existingNames.add(decrypted.name.toLowerCase());
          } catch { /* ignore */ }
        } else {
          existingNames.add(wn.name.toLowerCase());
        }
      }
      
      const toAdd: WalletName[] = [];
      for (const name of Array.from(values.walletNames)) {
        if (!existingNames.has(name.toLowerCase())) {
          toAdd.push({ name, createdAt: Date.now() });
        }
      }
      
      if (toAdd.length > 0) {
        const encrypted = await Promise.all(toAdd.map(wn => encryptWalletName(wn, key)));
        await db.walletNames.bulkAdd(encrypted);
      }
    })());
  }
  
  if (values.seedNames.size > 0) {
    tasks.push((async () => {
      const existing = await db.seedNames.toArray();
      const existingNames = new Set<string>();
      for (const sn of existing) {
        if (sn.isEncrypted) {
          try {
            const decrypted = await decryptSeedName(sn, key);
            existingNames.add(decrypted.name.toLowerCase());
          } catch { /* ignore */ }
        } else {
          existingNames.add(sn.name.toLowerCase());
        }
      }
      
      const toAdd: SeedName[] = [];
      for (const name of Array.from(values.seedNames)) {
        if (!existingNames.has(name.toLowerCase())) {
          toAdd.push({ name, createdAt: Date.now() });
        }
      }
      
      if (toAdd.length > 0) {
        const encrypted = await Promise.all(toAdd.map(sn => encryptSeedName(sn, key)));
        await db.seedNames.bulkAdd(encrypted);
      }
    })());
  }
  
  if (values.walletSoftware.size > 0) {
    tasks.push((async () => {
      const existing = await db.walletSoftware.toArray();
      const existingNames = new Set<string>();
      for (const ws of existing) {
        if (ws.isEncrypted) {
          try {
            const decrypted = await decryptWalletSoftware(ws, key);
            existingNames.add(decrypted.name.toLowerCase());
          } catch { /* ignore */ }
        } else {
          existingNames.add(ws.name.toLowerCase());
        }
      }
      
      const toAdd: WalletSoftware[] = [];
      for (const name of Array.from(values.walletSoftware)) {
        if (!existingNames.has(name.toLowerCase())) {
          toAdd.push({ name, createdAt: Date.now() });
        }
      }
      
      if (toAdd.length > 0) {
        const encrypted = await Promise.all(toAdd.map(ws => encryptWalletSoftware(ws, key)));
        await db.walletSoftware.bulkAdd(encrypted);
      }
    })());
  }
  
  await Promise.all(tasks);
}

export async function bulkUpdateRecords(
  updates: Array<{ id: number; changes: Partial<Record> }>
): Promise<{ successCount: number; errorCount: number }> {
  const key = getKey();
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
  
  const decryptedRecords = await Promise.all(
    existingRecords.map(async (record) => {
      if (record.isEncrypted) {
        return await decryptRecord(record, key);
      }
      return record;
    })
  );
  
  const decryptedMap = new Map<number, Record>();
  for (const record of decryptedRecords) {
    decryptedMap.set(record.id!, record);
  }
  
  const recordsToSave: Record[] = [];
  const allChanges: Partial<Record>[] = [];
  let errorCount = 0;
  
  for (const { id, changes } of updates) {
    const decrypted = decryptedMap.get(id);
    if (!decrypted) {
      console.warn(`[bulkUpdateRecords] Record ${id} not found, skipping`);
      errorCount++;
      continue;
    }
    
    const updated: Record = {
      ...decrypted,
      ...changes,
      id,
      updatedAt: now,
    };
    
    recordsToSave.push(updated);
    allChanges.push(changes);
  }
  
  const CONCURRENCY_LIMIT = 8;
  const encryptedRecords: Record[] = [];
  
  for (let i = 0; i < recordsToSave.length; i += CONCURRENCY_LIMIT) {
    const batch = recordsToSave.slice(i, i + CONCURRENCY_LIMIT);
    const encryptedBatch = await Promise.all(
      batch.map(record => encryptRecord(record, key))
    );
    encryptedRecords.push(...encryptedBatch);
  }
  
  await db.transaction('rw', db.records, async () => {
    await db.records.bulkPut(encryptedRecords);
  });
  invalidateCachedRecords(updates.map(u => u.id));
  
  const vocabularyValues = {
    owners: new Set<string>(),
    walletNames: new Set<string>(),
    seedNames: new Set<string>(),
    walletSoftware: new Set<string>(),
  };
  
  for (const changes of allChanges) {
    if (changes.owner && changes.owner !== 'Unknown' && changes.owner !== '[encrypted]') {
      vocabularyValues.owners.add(changes.owner);
    }
    if (changes.walletName && changes.walletName !== '[encrypted]') {
      vocabularyValues.walletNames.add(changes.walletName);
    }
    if (changes.seedName && changes.seedName !== '[encrypted]') {
      vocabularyValues.seedNames.add(changes.seedName);
    }
    if (changes.walletSoftware && changes.walletSoftware !== '[encrypted]') {
      vocabularyValues.walletSoftware.add(changes.walletSoftware);
    }
  }
  
  batchSyncVocabulary(vocabularyValues, key).catch((err) => {
    console.warn('[bulkUpdateRecords] Vocabulary sync failed:', err);
  });
  
  notifyDbChange('records');
  
  const duration = performance.now() - startTime;
  console.log(`[bulkUpdateRecords] Completed: ${encryptedRecords.length} records in ${duration.toFixed(0)}ms (${(duration / encryptedRecords.length).toFixed(1)}ms/record)`);
  
  return { successCount: encryptedRecords.length, errorCount };
}

export async function deleteRecord(id: number): Promise<void> {
  const attachments = await db.attachments.where('recordId').equals(id).toArray();

  for (const attachment of attachments) {
    try {
      const _encryptionKey = getEncryptionKey();
      const decryptedAttachment = attachment.isEncrypted && _encryptionKey
        ? await decryptAttachment(attachment, _encryptionKey)
        : attachment;
      
      const response = await fetch(`/api/attachments/${decryptedAttachment.objectStoragePath}`, {
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
  invalidateCachedRecord(id);
  
  notifyDbChange('records');
}

// ============ DUPLICATE DETECTION ============

export async function findRecordByInputString(inputString: string): Promise<Record | undefined> {
  if (!inputString) return undefined;
  
  const key = getKey();
  const normalizedInput = inputString.trim().toLowerCase();
  
  const allRecords = await db.records.toArray();
  
  for (const record of allRecords) {
    let decryptedInputString: string;
    
    if (record.isEncrypted) {
      try {
        const decrypted = await decryptRecord(record, key);
        decryptedInputString = decrypted.inputString;
      } catch {
        continue;
      }
    } else {
      decryptedInputString = record.inputString;
    }
    
    if (decryptedInputString.trim().toLowerCase() === normalizedInput) {
      if (record.isEncrypted) {
        return await decryptRecord(record, key);
      }
      return record;
    }
  }
  
  return undefined;
}

// ============ RECORD ORIGIN OPERATIONS ============

export async function createRecordOrigin(
  data: Omit<RecordOrigin, 'id' | 'createdAt'>
): Promise<number> {
  const key = getKey();
  
  const origin: RecordOrigin = {
    ...data,
    createdAt: Date.now(),
  };

  const encrypted = await encryptRecordOrigin(origin, key);
  const id = await db.recordOrigins.add(encrypted);
  return id as number;
}

export async function getDecryptedRecordOrigins(recordId: number): Promise<RecordOrigin[]> {
  const key = getKey();
  const origins = await db.recordOrigins.where('recordId').equals(recordId).toArray();
  
  return Promise.all(
    origins.map(async (origin) => {
      if (origin.isEncrypted) {
        return await decryptRecordOrigin(origin, key);
      }
      return origin;
    })
  );
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

// ============ DERIVATION TEMPLATE HELPERS ============

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
  const key = getKey();
  
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
  
  const sensitivePayload = JSON.stringify({
    xpub: derivationTemplate.xpub,
    notes: derivationTemplate.notes,
    owner: derivationTemplate.owner,
    walletName: derivationTemplate.walletName,
    seedName: derivationTemplate.seedName,
  });
  
  const encryptedPayload = await encrypt(sensitivePayload, key);
  
  const encryptedTemplate: DerivationTemplate = {
    ...derivationTemplate,
    xpub: '[encrypted]',
    notes: derivationTemplate.notes ? '[encrypted]' : undefined,
    owner: derivationTemplate.owner ? '[encrypted]' : undefined,
    walletName: derivationTemplate.walletName ? '[encrypted]' : undefined,
    seedName: derivationTemplate.seedName ? '[encrypted]' : undefined,
    encryptedPayload,
    isEncrypted: true,
  };
  
  return await db.derivationTemplates.add(encryptedTemplate);
}

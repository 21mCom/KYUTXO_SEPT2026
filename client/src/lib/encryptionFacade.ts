// Encryption Facade
// Provides encryption-aware CRUD operations while maintaining compatibility
// with existing Dexie live queries

import { db, notifyDbChange, type Record, type Attachment, type Tag, type Category, type RecordOrigin, type RecordOriginType, type Owner, type WalletName, type SeedName, type WalletSoftware, type DerivationTemplate, type AddressImportance } from './database';
import { encrypt } from './crypto';
import { 
  encryptRecord, 
  decryptRecord, 
  encryptAttachment, 
  decryptAttachment,
  encryptTag,
  decryptTag,
  encryptCategory,
  decryptCategory,
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
} from './dbEncryption';

let _encryptionKey: CryptoKey | null = null;

// Initialize the facade with the encryption key (called after login)
export function initEncryptionFacade(key: CryptoKey): void {
  _encryptionKey = key;
}

// Clear the encryption key (called on logout)
export function clearEncryptionFacade(): void {
  _encryptionKey = null;
}

// Check if encryption is ready
export function isEncryptionReady(): boolean {
  return _encryptionKey !== null;
}

// Get the current encryption key (for file encryption)
export function getEncryptionKey(): CryptoKey | null {
  return _encryptionKey;
}

// Get the encryption key (throws if not ready)
function getKey(): CryptoKey {
  if (!_encryptionKey) {
    throw new Error('Encryption not initialized. Please login first.');
  }
  return _encryptionKey;
}

// ============ VOCABULARY SYNC ============

// Sync record vocabulary values to their respective tables
// This ensures any owner, walletName, seedName, or walletSoftware values
// used in records are also available as vocabulary options
async function syncRecordVocabulary(
  data: Partial<Record>,
  key: CryptoKey
): Promise<void> {
  const syncTasks: Promise<void>[] = [];

  // Sync owner
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

  // Sync walletName
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

  // Sync seedName
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

  // Sync walletSoftware
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

  // Run all sync tasks in parallel
  await Promise.all(syncTasks);
}

// ============ RECORD OPERATIONS ============

// Create a new record (encrypted)
export async function createRecord(
  data: Omit<Record, 'id' | 'createdAt' | 'updatedAt'>
): Promise<number> {
  const key = getKey();
  const now = Date.now();
  
  // Ensure addressImportance is always set for compound index compatibility
  // Default to 'manual' if not specified (user-entered data)
  let addressImportance = data.addressImportance;
  if (!addressImportance) {
    // Infer from source if available, otherwise default to 'manual'
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
  
  // Sync vocabulary values to their tables (in background, don't block record creation)
  syncRecordVocabulary(data, key).catch((err) => {
    console.warn('[createRecord] Vocabulary sync failed:', err);
  });
  
  const encrypted = await encryptRecord(record, key);
  const id = await db.records.add(encrypted);
  
  // Notify listeners of the change
  notifyDbChange('records');
  
  console.log(`[createRecord] Record created with id=${id}`);
  
  // Verify the record was saved
  const saved = await db.records.get(id as number);
  if (saved) {
    console.log(`[createRecord] Verified: record ${id} exists in database, isEncrypted=${saved.isEncrypted}`);
  } else {
    console.error(`[createRecord] ERROR: record ${id} NOT FOUND after creation!`);
  }
  
  return id as number;
}

// Update an existing record (encrypted)
export async function updateRecord(
  id: number,
  updates: Partial<Record>
): Promise<void> {
  const key = getKey();
  
  // Get the existing record
  const existing = await db.records.get(id);
  if (!existing) throw new Error('Record not found');

  // Decrypt if encrypted
  const decrypted = existing.isEncrypted
    ? await decryptRecord(existing, key)
    : existing;

  // Merge updates
  const updated: Record = {
    ...decrypted,
    ...updates,
    id,
    updatedAt: Date.now(),
  };

  // Sync vocabulary values to their tables (in background, don't block record update)
  syncRecordVocabulary(updates, key).catch((err) => {
    console.warn('[updateRecord] Vocabulary sync failed:', err);
  });

  // Encrypt and save
  const encrypted = await encryptRecord(updated, key);
  await db.records.put(encrypted);
  
  // Notify listeners of the change
  notifyDbChange('records');
}

// Batch update multiple records at once (optimized for bulk operations)
// This is much faster than calling updateRecord() in a loop
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
  
  // Step 1: Fetch all records we need to update
  const ids = updates.map(u => u.id);
  const existingRecords = await db.records.where('id').anyOf(ids).toArray();
  
  // Create a map for quick lookup
  const existingMap = new Map<number, Record>();
  for (const record of existingRecords) {
    existingMap.set(record.id!, record);
  }
  
  // Step 2: Decrypt all records in parallel
  const decryptedRecords = await Promise.all(
    existingRecords.map(async (record) => {
      if (record.isEncrypted) {
        return await decryptRecord(record, key);
      }
      return record;
    })
  );
  
  // Create decrypted map for quick lookup
  const decryptedMap = new Map<number, Record>();
  for (const record of decryptedRecords) {
    decryptedMap.set(record.id!, record);
  }
  
  // Step 3: Compute all updated records in memory
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
    
    // Merge changes
    const updated: Record = {
      ...decrypted,
      ...changes,
      id,
      updatedAt: now,
    };
    
    recordsToSave.push(updated);
    allChanges.push(changes);
  }
  
  // Step 4: Encrypt all records in parallel with concurrency limit
  const CONCURRENCY_LIMIT = 8;
  const encryptedRecords: Record[] = [];
  
  for (let i = 0; i < recordsToSave.length; i += CONCURRENCY_LIMIT) {
    const batch = recordsToSave.slice(i, i + CONCURRENCY_LIMIT);
    const encryptedBatch = await Promise.all(
      batch.map(record => encryptRecord(record, key))
    );
    encryptedRecords.push(...encryptedBatch);
  }
  
  // Step 5: Write all records in a single transaction
  await db.transaction('rw', db.records, async () => {
    await db.records.bulkPut(encryptedRecords);
  });
  
  // Step 6: Batch sync vocabulary (collect unique values, add once)
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
  
  // Sync vocabulary in background (don't block)
  batchSyncVocabulary(vocabularyValues, key).catch((err) => {
    console.warn('[bulkUpdateRecords] Vocabulary sync failed:', err);
  });
  
  // Step 7: Notify listeners once
  notifyDbChange('records');
  
  const duration = performance.now() - startTime;
  console.log(`[bulkUpdateRecords] Completed: ${encryptedRecords.length} records in ${duration.toFixed(0)}ms (${(duration / encryptedRecords.length).toFixed(1)}ms/record)`);
  
  return { successCount: encryptedRecords.length, errorCount };
}

// Batch sync vocabulary values (used by bulk operations)
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
  
  // Sync owners
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
  
  // Sync wallet names
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
  
  // Sync seed names
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
  
  // Sync wallet software
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

// Delete a record and its attachments
export async function deleteRecord(id: number): Promise<void> {
  // Delete associated attachments first
  const attachments = await db.attachments.where('recordId').equals(id).toArray();

  for (const attachment of attachments) {
    try {
      // Get the decrypted path if encrypted
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
  
  // Notify listeners of the change
  notifyDbChange('records');
}

// Decrypt a single record (for detail/edit views)
export async function decryptRecordById(id: number): Promise<Record | undefined> {
  const key = getKey();
  const record = await db.records.get(id);
  
  if (!record) return undefined;
  
  if (record.isEncrypted) {
    return await decryptRecord(record, key);
  }
  
  return record;
}

// Decrypt multiple records
export async function decryptRecords(records: Record[]): Promise<Record[]> {
  const key = getKey();
  
  return Promise.all(
    records.map(async (record) => {
      if (record.isEncrypted) {
        return await decryptRecord(record, key);
      }
      return record;
    })
  );
}

// ============ ATTACHMENT OPERATIONS ============

// Create an attachment entry (encrypted)
export async function createAttachment(
  data: Omit<Attachment, 'id' | 'createdAt'>
): Promise<number> {
  const key = getKey();
  
  const attachment: Attachment = {
    ...data,
    createdAt: Date.now(),
  };

  const encrypted = await encryptAttachment(attachment, key);
  const id = await db.attachments.add(encrypted);
  return id as number;
}

// Get decrypted attachments for a record
export async function getDecryptedAttachments(recordId: number): Promise<Attachment[]> {
  const key = getKey();
  const attachments = await db.attachments.where('recordId').equals(recordId).toArray();
  
  return Promise.all(
    attachments.map(async (att) => {
      if (att.isEncrypted) {
        return await decryptAttachment(att, key);
      }
      return att;
    })
  );
}

// ============ TAG OPERATIONS ============

// Create a tag (encrypted)
export async function createTag(name: string, color?: string): Promise<number> {
  const key = getKey();
  
  const tag: Tag = {
    name,
    color,
    createdAt: Date.now(),
  };

  const encrypted = await encryptTag(tag, key);
  const id = await db.tags.add(encrypted);
  return id as number;
}

// Get all decrypted tags
export async function getDecryptedTags(): Promise<Tag[]> {
  const key = getKey();
  const tags = await db.tags.toArray();
  
  return Promise.all(
    tags.map(async (tag) => {
      if (tag.isEncrypted) {
        return await decryptTag(tag, key);
      }
      return tag;
    })
  );
}

// Update a tag (encrypted)
export async function updateTag(id: number, data: Partial<Tag>): Promise<void> {
  const key = getKey();
  
  const existing = await db.tags.get(id);
  if (!existing) throw new Error('Tag not found');
  
  // Decrypt if encrypted
  const decrypted = existing.isEncrypted
    ? await decryptTag(existing, key)
    : existing;
  
  // Merge updates
  const updated: Tag = {
    ...decrypted,
    ...data,
    id,
  };
  
  // Encrypt and save
  const encrypted = await encryptTag(updated, key);
  await db.tags.put(encrypted);
}

// Delete a tag
export async function deleteTag(id: number): Promise<void> {
  await db.tags.delete(id);
}

// ============ CATEGORY OPERATIONS ============

// Create a category (encrypted)
export async function createCategory(name: string): Promise<number> {
  const key = getKey();
  
  const category: Category = {
    name,
    createdAt: Date.now(),
  };

  const encrypted = await encryptCategory(category, key);
  const id = await db.categories.add(encrypted);
  return id as number;
}

// Get all decrypted categories
export async function getDecryptedCategories(): Promise<Category[]> {
  const key = getKey();
  const categories = await db.categories.toArray();
  
  return Promise.all(
    categories.map(async (cat) => {
      if (cat.isEncrypted) {
        return await decryptCategory(cat, key);
      }
      return cat;
    })
  );
}

// Update a category (encrypted)
export async function updateCategory(id: number, data: Partial<Category>): Promise<void> {
  const key = getKey();
  
  const existing = await db.categories.get(id);
  if (!existing) throw new Error('Category not found');
  
  // Decrypt if encrypted
  const decrypted = existing.isEncrypted
    ? await decryptCategory(existing, key)
    : existing;
  
  // Merge updates
  const updated: Category = {
    ...decrypted,
    ...data,
    id,
  };
  
  // Encrypt and save
  const encrypted = await encryptCategory(updated, key);
  await db.categories.put(encrypted);
}

// Delete a category
export async function deleteCategory(id: number): Promise<void> {
  await db.categories.delete(id);
}

// ============ OWNER OPERATIONS ============

// Create an owner (encrypted)
export async function createOwner(name: string): Promise<number> {
  const key = getKey();
  
  const owner: Owner = {
    name,
    createdAt: Date.now(),
  };

  const encrypted = await encryptOwner(owner, key);
  const id = await db.owners.add(encrypted);
  return id as number;
}

// Get all decrypted owners
export async function getDecryptedOwners(): Promise<Owner[]> {
  const key = getKey();
  const owners = await db.owners.toArray();
  
  return Promise.all(
    owners.map(async (owner) => {
      if (owner.isEncrypted) {
        return await decryptOwner(owner, key);
      }
      return owner;
    })
  );
}

// Update an owner (encrypted)
export async function updateOwner(id: number, data: Partial<Owner>): Promise<void> {
  const key = getKey();
  
  const existing = await db.owners.get(id);
  if (!existing) throw new Error('Owner not found');
  
  const decrypted = existing.isEncrypted
    ? await decryptOwner(existing, key)
    : existing;
  
  const updated: Owner = {
    ...decrypted,
    ...data,
    id,
  };
  
  const encrypted = await encryptOwner(updated, key);
  await db.owners.put(encrypted);
}

// Delete an owner
export async function deleteOwner(id: number): Promise<void> {
  await db.owners.delete(id);
}

// ============ WALLET NAME OPERATIONS ============

// Create a wallet name (encrypted)
export async function createWalletNameEntry(name: string): Promise<number> {
  const key = getKey();
  
  const walletName: WalletName = {
    name,
    createdAt: Date.now(),
  };

  const encrypted = await encryptWalletName(walletName, key);
  const id = await db.walletNames.add(encrypted);
  return id as number;
}

// Get all decrypted wallet names
export async function getDecryptedWalletNames(): Promise<WalletName[]> {
  const key = getKey();
  const walletNames = await db.walletNames.toArray();
  
  return Promise.all(
    walletNames.map(async (wn) => {
      if (wn.isEncrypted) {
        return await decryptWalletName(wn, key);
      }
      return wn;
    })
  );
}

// Update a wallet name (encrypted)
export async function updateWalletNameEntry(id: number, data: Partial<WalletName>): Promise<void> {
  const key = getKey();
  
  const existing = await db.walletNames.get(id);
  if (!existing) throw new Error('Wallet name not found');
  
  const decrypted = existing.isEncrypted
    ? await decryptWalletName(existing, key)
    : existing;
  
  const updated: WalletName = {
    ...decrypted,
    ...data,
    id,
  };
  
  const encrypted = await encryptWalletName(updated, key);
  await db.walletNames.put(encrypted);
}

// Delete a wallet name
export async function deleteWalletNameEntry(id: number): Promise<void> {
  await db.walletNames.delete(id);
}

// ============ SEED NAME OPERATIONS ============

// Create a seed name (encrypted)
export async function createSeedNameEntry(name: string): Promise<number> {
  const key = getKey();
  
  const seedName: SeedName = {
    name,
    createdAt: Date.now(),
  };

  const encrypted = await encryptSeedName(seedName, key);
  const id = await db.seedNames.add(encrypted);
  return id as number;
}

// Get all decrypted seed names
export async function getDecryptedSeedNames(): Promise<SeedName[]> {
  const key = getKey();
  const seedNames = await db.seedNames.toArray();
  
  return Promise.all(
    seedNames.map(async (sn) => {
      if (sn.isEncrypted) {
        return await decryptSeedName(sn, key);
      }
      return sn;
    })
  );
}

// Update a seed name (encrypted)
export async function updateSeedNameEntry(id: number, data: Partial<SeedName>): Promise<void> {
  const key = getKey();
  
  const existing = await db.seedNames.get(id);
  if (!existing) throw new Error('Seed name not found');
  
  const decrypted = existing.isEncrypted
    ? await decryptSeedName(existing, key)
    : existing;
  
  const updated: SeedName = {
    ...decrypted,
    ...data,
    id,
  };
  
  const encrypted = await encryptSeedName(updated, key);
  await db.seedNames.put(encrypted);
}

// Delete a seed name
export async function deleteSeedNameEntry(id: number): Promise<void> {
  await db.seedNames.delete(id);
}

// ============ WALLET SOFTWARE OPERATIONS ============

// Create a wallet software entry (encrypted)
export async function createWalletSoftwareEntry(name: string): Promise<number> {
  const key = getKey();
  
  const walletSoftware: WalletSoftware = {
    name,
    createdAt: Date.now(),
  };

  const encrypted = await encryptWalletSoftware(walletSoftware, key);
  const id = await db.walletSoftware.add(encrypted);
  return id as number;
}

// Get all decrypted wallet software entries
export async function getDecryptedWalletSoftware(): Promise<WalletSoftware[]> {
  const key = getKey();
  const walletSoftware = await db.walletSoftware.toArray();
  
  return Promise.all(
    walletSoftware.map(async (ws) => {
      if (ws.isEncrypted) {
        return await decryptWalletSoftware(ws, key);
      }
      return ws;
    })
  );
}

// Update a wallet software entry (encrypted)
export async function updateWalletSoftwareEntry(id: number, data: Partial<WalletSoftware>): Promise<void> {
  const key = getKey();
  
  const existing = await db.walletSoftware.get(id);
  if (!existing) throw new Error('Wallet software not found');
  
  const decrypted = existing.isEncrypted
    ? await decryptWalletSoftware(existing, key)
    : existing;
  
  const updated: WalletSoftware = {
    ...decrypted,
    ...data,
    id,
  };
  
  const encrypted = await encryptWalletSoftware(updated, key);
  await db.walletSoftware.put(encrypted);
}

// Delete a wallet software entry
export async function deleteWalletSoftwareEntry(id: number): Promise<void> {
  await db.walletSoftware.delete(id);
}

// ============ DUPLICATE DETECTION ============

// Find an existing record by inputString (for duplicate detection)
// This requires decrypting all records to compare inputStrings
export async function findRecordByInputString(inputString: string): Promise<Record | undefined> {
  if (!inputString) return undefined;
  
  const key = getKey();
  const normalizedInput = inputString.trim().toLowerCase();
  
  // Get all records
  const allRecords = await db.records.toArray();
  
  // Decrypt and search
  for (const record of allRecords) {
    let decryptedInputString: string;
    
    if (record.isEncrypted) {
      try {
        const decrypted = await decryptRecord(record, key);
        decryptedInputString = decrypted.inputString;
      } catch {
        continue; // Skip records that can't be decrypted
      }
    } else {
      decryptedInputString = record.inputString;
    }
    
    if (decryptedInputString.trim().toLowerCase() === normalizedInput) {
      // Return the fully decrypted record
      if (record.isEncrypted) {
        return await decryptRecord(record, key);
      }
      return record;
    }
  }
  
  return undefined;
}

// ============ RECORD ORIGIN OPERATIONS ============

// Create a record origin entry (for tracking metadata sources)
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

// Get all decrypted origins for a record
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

// Merge metadata from multiple origins into a single record view
// Priority: manual > wallet-sync > xpub-derived > bulk-import > blockchain-sync
// Tags and categories are unioned (combined)
export function mergeRecordWithOrigins(
  record: Record, 
  origins: RecordOrigin[]
): Record {
  if (origins.length === 0) return record;
  
  // Sort by priority: manual first, then wallet-sync, xpub-derived, bulk-import, blockchain-sync last
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
  
  // Start with the record's current values
  const merged = { ...record };
  
  // Union all tags and categories from all origins
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
  
  // Apply values from highest priority origin that has them
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

// ============ SYNC HELPERS ============
// These helpers ensure tags/categories used in records are added to the master tables

// Sync tags from a record to the master tags table
// Creates any tags that don't already exist (case-insensitive check)
export async function syncTagsToMaster(tagNames: string[]): Promise<void> {
  if (!tagNames || tagNames.length === 0) return;
  
  const key = getKey();
  
  // Get all existing tags and decrypt them
  const existingTags = await db.tags.toArray();
  const decryptedTags = await Promise.all(
    existingTags.map(async (tag) => {
      if (tag.isEncrypted) {
        return await decryptTag(tag, key);
      }
      return tag;
    })
  );
  
  // Create a set of existing tag names (lowercase for case-insensitive comparison)
  const existingNames = new Set(
    decryptedTags.map(t => t.name.toLowerCase())
  );
  
  // Add any tags that don't exist
  for (const name of tagNames) {
    const trimmedName = name.trim();
    if (trimmedName && !existingNames.has(trimmedName.toLowerCase())) {
      const tag: Tag = {
        name: trimmedName,
        createdAt: Date.now(),
      };
      const encrypted = await encryptTag(tag, key);
      await db.tags.add(encrypted);
      // Add to set so we don't create duplicates within the same batch
      existingNames.add(trimmedName.toLowerCase());
    }
  }
}

// Sync categories from a record to the master categories table
// Creates any categories that don't already exist (case-insensitive check)
export async function syncCategoriesToMaster(categoryNames: string[]): Promise<void> {
  if (!categoryNames || categoryNames.length === 0) return;
  
  const key = getKey();
  
  // Get all existing categories and decrypt them
  const existingCategories = await db.categories.toArray();
  const decryptedCategories = await Promise.all(
    existingCategories.map(async (cat) => {
      if (cat.isEncrypted) {
        return await decryptCategory(cat, key);
      }
      return cat;
    })
  );
  
  // Create a set of existing category names (lowercase for case-insensitive comparison)
  const existingNames = new Set(
    decryptedCategories.map(c => c.name.toLowerCase())
  );
  
  // Add any categories that don't exist
  for (const name of categoryNames) {
    const trimmedName = name.trim();
    if (trimmedName && !existingNames.has(trimmedName.toLowerCase())) {
      const category: Category = {
        name: trimmedName,
        createdAt: Date.now(),
      };
      const encrypted = await encryptCategory(category, key);
      await db.categories.add(encrypted);
      // Add to set so we don't create duplicates within the same batch
      existingNames.add(trimmedName.toLowerCase());
    }
  }
}

// ============ DERIVATION TEMPLATE HELPERS ============

// Save a derivation template (xpub) for future address derivations
// The xpub is stored encrypted for privacy
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
  
  // Encrypt the sensitive payload (xpub and notes)
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

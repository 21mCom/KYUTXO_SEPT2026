// Encryption Facade
// Provides encryption-aware CRUD operations while maintaining compatibility
// with existing Dexie live queries

import { db, type Record, type Attachment, type Tag, type Category } from './database';
import { 
  encryptRecord, 
  decryptRecord, 
  encryptAttachment, 
  decryptAttachment,
  encryptTag,
  decryptTag,
  encryptCategory,
  decryptCategory,
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

// ============ RECORD OPERATIONS ============

// Create a new record (encrypted)
export async function createRecord(
  data: Omit<Record, 'id' | 'createdAt' | 'updatedAt'>
): Promise<number> {
  const key = getKey();
  const now = Date.now();
  
  const record: Record = {
    ...data,
    createdAt: now,
    updatedAt: now,
  };

  const encrypted = await encryptRecord(record, key);
  const id = await db.records.add(encrypted);
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

  // Encrypt and save
  const encrypted = await encryptRecord(updated, key);
  await db.records.put(encrypted);
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

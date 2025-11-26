// Encrypted record hooks
// These hooks provide encrypted/decrypted access to records

import { useLiveQuery } from 'dexie-react-hooks';
import { useState, useEffect, useCallback } from 'react';
import { db, type Record, type Attachment, type Tag, type Category } from '@/lib/database';
import { useAuth } from '@/contexts/AuthContext';
import {
  encryptRecord,
  decryptRecord,
  encryptAttachment,
  decryptAttachment,
  encryptTag,
  decryptTag,
  encryptCategory,
  decryptCategory,
} from '@/lib/dbEncryption';
import { uploadAttachment as uploadAttachmentApi, deleteAttachment as deleteAttachmentApi } from '@/lib/attachments';

// Hook to get all records (decrypted)
export function useEncryptedRecords() {
  const { encryptionKey } = useAuth();
  const [decryptedRecords, setDecryptedRecords] = useState<Record[]>([]);
  const [isDecrypting, setIsDecrypting] = useState(false);

  // Get raw records from DB
  const rawRecords = useLiveQuery(
    () => db.records.orderBy('updatedAt').reverse().toArray(),
    []
  );

  // Decrypt records when they change or when key becomes available
  useEffect(() => {
    const decryptAll = async () => {
      if (!rawRecords || !encryptionKey) {
        setDecryptedRecords([]);
        return;
      }

      setIsDecrypting(true);
      try {
        const decrypted = await Promise.all(
          rawRecords.map(async (record) => {
            if (record.isEncrypted) {
              return await decryptRecord(record, encryptionKey);
            }
            return record;
          })
        );
        setDecryptedRecords(decrypted);
      } catch (error) {
        console.error('Failed to decrypt records:', error);
        setDecryptedRecords([]);
      } finally {
        setIsDecrypting(false);
      }
    };

    decryptAll();
  }, [rawRecords, encryptionKey]);

  return {
    records: decryptedRecords,
    isLoading: rawRecords === undefined || isDecrypting,
  };
}

// Hook to get a single record (decrypted)
export function useEncryptedRecord(id: number | undefined) {
  const { encryptionKey } = useAuth();
  const [decryptedRecord, setDecryptedRecord] = useState<Record | undefined>();
  const [isDecrypting, setIsDecrypting] = useState(false);

  const rawRecord = useLiveQuery(
    () => (id ? db.records.get(id) : undefined),
    [id]
  );

  useEffect(() => {
    const decryptOne = async () => {
      if (!rawRecord || !encryptionKey) {
        setDecryptedRecord(undefined);
        return;
      }

      setIsDecrypting(true);
      try {
        if (rawRecord.isEncrypted) {
          const decrypted = await decryptRecord(rawRecord, encryptionKey);
          setDecryptedRecord(decrypted);
        } else {
          setDecryptedRecord(rawRecord);
        }
      } catch (error) {
        console.error('Failed to decrypt record:', error);
        setDecryptedRecord(undefined);
      } finally {
        setIsDecrypting(false);
      }
    };

    decryptOne();
  }, [rawRecord, encryptionKey]);

  return {
    record: decryptedRecord,
    isLoading: (rawRecord === undefined && id !== undefined) || isDecrypting,
  };
}

// Create a new record (encrypted)
export async function createEncryptedRecord(
  data: Omit<Record, 'id' | 'createdAt' | 'updatedAt'>,
  encryptionKey: CryptoKey
): Promise<number> {
  const now = Date.now();
  const record: Record = {
    ...data,
    createdAt: now,
    updatedAt: now,
  };

  const encrypted = await encryptRecord(record, encryptionKey);
  const id = await db.records.add(encrypted);
  return id as number;
}

// Create record with attachments (encrypted)
export async function createEncryptedRecordWithAttachments(
  data: Omit<Record, 'id' | 'createdAt' | 'updatedAt'>,
  files: File[],
  encryptionKey: CryptoKey,
  onProgress?: (current: number, total: number) => void
): Promise<{ recordId: number; uploadedCount: number; failedCount: number }> {
  const now = Date.now();
  const record: Record = {
    ...data,
    createdAt: now,
    updatedAt: now,
  };

  // Encrypt and create record
  const encrypted = await encryptRecord(record, encryptionKey);
  const recordId = (await db.records.add(encrypted)) as number;

  if (files.length === 0) {
    return { recordId, uploadedCount: 0, failedCount: 0 };
  }

  const uploadedAttachmentIds: number[] = [];
  let failedCount = 0;

  try {
    for (let i = 0; i < files.length; i++) {
      onProgress?.(i + 1, files.length);

      try {
        const result = await uploadAttachmentApi(recordId, files[i], data.inputString);
        
        // Encrypt the attachment metadata
        const attachmentData = await db.attachments.get(result.id);
        if (attachmentData && encryptionKey) {
          const encryptedAttachment = await encryptAttachment(attachmentData, encryptionKey);
          await db.attachments.put(encryptedAttachment);
        }
        
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
          await deleteAttachmentApi(attachmentId);
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
      failedCount,
    };
  } catch (error) {
    if (uploadedAttachmentIds.length > 0) {
      for (const attachmentId of uploadedAttachmentIds) {
        try {
          await deleteAttachmentApi(attachmentId);
        } catch (e) {
          console.error('Rollback attachment delete failed:', e);
        }
      }
    }
    await db.records.delete(recordId);
    throw error;
  }
}

// Update a record (encrypted)
export async function updateEncryptedRecord(
  id: number,
  data: Partial<Record>,
  encryptionKey: CryptoKey
): Promise<void> {
  const existing = await db.records.get(id);
  if (!existing) throw new Error('Record not found');

  // Decrypt existing record first
  const decrypted = existing.isEncrypted
    ? await decryptRecord(existing, encryptionKey)
    : existing;

  // Merge updates
  const updated: Record = {
    ...decrypted,
    ...data,
    id,
    updatedAt: Date.now(),
  };

  // Encrypt and save
  const encrypted = await encryptRecord(updated, encryptionKey);
  await db.records.put(encrypted);
}

// Delete a record
export async function deleteEncryptedRecord(id: number): Promise<void> {
  // Delete associated attachments first
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
}

// Hook for tags (decrypted)
export function useEncryptedTags() {
  const { encryptionKey } = useAuth();
  const [decryptedTags, setDecryptedTags] = useState<Tag[]>([]);

  const rawTags = useLiveQuery(() => db.tags.toArray(), []);

  useEffect(() => {
    const decryptAll = async () => {
      if (!rawTags || !encryptionKey) {
        setDecryptedTags(rawTags || []);
        return;
      }

      const decrypted = await Promise.all(
        rawTags.map(async (tag) => {
          if (tag.isEncrypted) {
            return await decryptTag(tag, encryptionKey);
          }
          return tag;
        })
      );
      setDecryptedTags(decrypted);
    };

    decryptAll();
  }, [rawTags, encryptionKey]);

  return {
    tags: decryptedTags,
    isLoading: rawTags === undefined,
  };
}

// Hook for categories (decrypted)
export function useEncryptedCategories() {
  const { encryptionKey } = useAuth();
  const [decryptedCategories, setDecryptedCategories] = useState<Category[]>([]);

  const rawCategories = useLiveQuery(() => db.categories.toArray(), []);

  useEffect(() => {
    const decryptAll = async () => {
      if (!rawCategories || !encryptionKey) {
        setDecryptedCategories(rawCategories || []);
        return;
      }

      const decrypted = await Promise.all(
        rawCategories.map(async (cat) => {
          if (cat.isEncrypted) {
            return await decryptCategory(cat, encryptionKey);
          }
          return cat;
        })
      );
      setDecryptedCategories(decrypted);
    };

    decryptAll();
  }, [rawCategories, encryptionKey]);

  return {
    categories: decryptedCategories,
    isLoading: rawCategories === undefined,
  };
}

// Create tag (encrypted)
export async function createEncryptedTag(
  name: string,
  color: string | undefined,
  encryptionKey: CryptoKey
): Promise<number> {
  const tag: Tag = {
    name,
    color,
    createdAt: Date.now(),
  };

  const encrypted = await encryptTag(tag, encryptionKey);
  const id = await db.tags.add(encrypted);
  return id as number;
}

// Create category (encrypted)
export async function createEncryptedCategory(
  name: string,
  encryptionKey: CryptoKey
): Promise<number> {
  const category: Category = {
    name,
    createdAt: Date.now(),
  };

  const encrypted = await encryptCategory(category, encryptionKey);
  const id = await db.categories.add(encrypted);
  return id as number;
}

// Get attachments for a record (decrypted)
export function useEncryptedAttachments(recordId: number | undefined) {
  const { encryptionKey } = useAuth();
  const [decryptedAttachments, setDecryptedAttachments] = useState<Attachment[]>([]);

  const rawAttachments = useLiveQuery(
    () => (recordId ? db.attachments.where('recordId').equals(recordId).toArray() : []),
    [recordId]
  );

  useEffect(() => {
    const decryptAll = async () => {
      if (!rawAttachments || !encryptionKey) {
        setDecryptedAttachments(rawAttachments || []);
        return;
      }

      const decrypted = await Promise.all(
        rawAttachments.map(async (att) => {
          if (att.isEncrypted) {
            return await decryptAttachment(att, encryptionKey);
          }
          return att;
        })
      );
      setDecryptedAttachments(decrypted);
    };

    decryptAll();
  }, [rawAttachments, encryptionKey]);

  return {
    attachments: decryptedAttachments,
    isLoading: rawAttachments === undefined,
  };
}

// Database encryption utilities
// Handles encryption/decryption of record data in IndexedDB

import { encrypt, decrypt } from './crypto';
import { db, type Record, type Attachment, type Tag, type Category, type RecordOrigin } from './database';

// Fields to encrypt for each record type
const RECORD_SENSITIVE_FIELDS: (keyof Record)[] = [
  'inputString',
  'label',
  'notes',
  'seedName',
  'walletSoftware',
  'owner',
  'walletName',
  'source',
  'customFields',
];

const ATTACHMENT_SENSITIVE_FIELDS: (keyof Attachment)[] = [
  'filename',
  'objectStoragePath',
];

const TAG_SENSITIVE_FIELDS: (keyof Tag)[] = ['name'];
const CATEGORY_SENSITIVE_FIELDS: (keyof Category)[] = ['name'];

const RECORD_ORIGIN_SENSITIVE_FIELDS: (keyof RecordOrigin)[] = [
  'label',
  'notes',
  'seedName',
  'walletSoftware',
  'owner',
  'walletName',
  'source',
  'xpub',
  'derivationPath',
];

// Encrypt a record's sensitive fields
export async function encryptRecord(record: Record, key: CryptoKey): Promise<Record> {
  const sensitiveData: Partial<Record> = {};
  
  for (const field of RECORD_SENSITIVE_FIELDS) {
    if (record[field] !== undefined) {
      sensitiveData[field] = record[field] as any;
    }
  }

  const encryptedPayload = await encrypt(JSON.stringify(sensitiveData), key);

  // Create record with encrypted payload, keeping metadata in plaintext
  const encryptedRecord: Record = {
    ...record,
    // Clear sensitive fields (replace with placeholder)
    inputString: '[encrypted]',
    label: '[encrypted]',
    notes: undefined,
    seedName: undefined,
    walletSoftware: undefined,
    owner: undefined,
    walletName: undefined,
    source: undefined,
    customFields: undefined,
    // Add encryption metadata
    encryptedPayload,
    isEncrypted: true,
  };

  return encryptedRecord;
}

// Decrypt a record's sensitive fields
export async function decryptRecord(record: Record, key: CryptoKey): Promise<Record> {
  if (!record.isEncrypted || !record.encryptedPayload) {
    return record; // Already plaintext
  }

  try {
    const decryptedJson = await decrypt(record.encryptedPayload, key);
    const sensitiveData = JSON.parse(decryptedJson);

    // Restore sensitive fields
    return {
      ...record,
      ...sensitiveData,
      encryptedPayload: undefined,
      isEncrypted: false,
    };
  } catch (error) {
    console.error('Failed to decrypt record:', error);
    throw new Error('Failed to decrypt record. Invalid key or corrupted data.');
  }
}

// Encrypt an attachment's sensitive fields
export async function encryptAttachment(attachment: Attachment, key: CryptoKey): Promise<Attachment> {
  const sensitiveData: Partial<Attachment> = {};
  
  for (const field of ATTACHMENT_SENSITIVE_FIELDS) {
    if (attachment[field] !== undefined) {
      sensitiveData[field] = attachment[field] as any;
    }
  }

  const encryptedPayload = await encrypt(JSON.stringify(sensitiveData), key);

  return {
    ...attachment,
    filename: '[encrypted]',
    objectStoragePath: '[encrypted]',
    encryptedPayload,
    isEncrypted: true,
  };
}

// Decrypt an attachment's sensitive fields
export async function decryptAttachment(attachment: Attachment, key: CryptoKey): Promise<Attachment> {
  if (!attachment.isEncrypted || !attachment.encryptedPayload) {
    return attachment;
  }

  try {
    const decryptedJson = await decrypt(attachment.encryptedPayload, key);
    const sensitiveData = JSON.parse(decryptedJson);

    return {
      ...attachment,
      ...sensitiveData,
      encryptedPayload: undefined,
      isEncrypted: false,
    };
  } catch (error) {
    console.error('Failed to decrypt attachment:', error);
    throw new Error('Failed to decrypt attachment.');
  }
}

// Encrypt a tag
export async function encryptTag(tag: Tag, key: CryptoKey): Promise<Tag> {
  const encryptedPayload = await encrypt(JSON.stringify({ name: tag.name }), key);

  return {
    ...tag,
    name: '[encrypted]',
    encryptedPayload,
    isEncrypted: true,
  };
}

// Decrypt a tag
export async function decryptTag(tag: Tag, key: CryptoKey): Promise<Tag> {
  if (!tag.isEncrypted || !tag.encryptedPayload) {
    return tag;
  }

  try {
    const decryptedJson = await decrypt(tag.encryptedPayload, key);
    const { name } = JSON.parse(decryptedJson);

    return {
      ...tag,
      name,
      encryptedPayload: undefined,
      isEncrypted: false,
    };
  } catch (error) {
    console.error('Failed to decrypt tag:', error);
    throw new Error('Failed to decrypt tag.');
  }
}

// Encrypt a category
export async function encryptCategory(category: Category, key: CryptoKey): Promise<Category> {
  const encryptedPayload = await encrypt(JSON.stringify({ name: category.name }), key);

  return {
    ...category,
    name: '[encrypted]',
    encryptedPayload,
    isEncrypted: true,
  };
}

// Decrypt a category
export async function decryptCategory(category: Category, key: CryptoKey): Promise<Category> {
  if (!category.isEncrypted || !category.encryptedPayload) {
    return category;
  }

  try {
    const decryptedJson = await decrypt(category.encryptedPayload, key);
    const { name } = JSON.parse(decryptedJson);

    return {
      ...category,
      name,
      encryptedPayload: undefined,
      isEncrypted: false,
    };
  } catch (error) {
    console.error('Failed to decrypt category:', error);
    throw new Error('Failed to decrypt category.');
  }
}

// Migrate all existing plaintext data to encrypted format
export async function migrateToEncrypted(key: CryptoKey): Promise<{
  records: number;
  attachments: number;
  tags: number;
  categories: number;
}> {
  let recordCount = 0;
  let attachmentCount = 0;
  let tagCount = 0;
  let categoryCount = 0;

  // Migrate records
  const plaintextRecords = await db.records
    .filter(r => !r.isEncrypted)
    .toArray();

  for (const record of plaintextRecords) {
    const encrypted = await encryptRecord(record, key);
    await db.records.put(encrypted);
    recordCount++;
  }

  // Migrate attachments
  const plaintextAttachments = await db.attachments
    .filter(a => !a.isEncrypted)
    .toArray();

  for (const attachment of plaintextAttachments) {
    const encrypted = await encryptAttachment(attachment, key);
    await db.attachments.put(encrypted);
    attachmentCount++;
  }

  // Migrate tags
  const plaintextTags = await db.tags
    .filter(t => !t.isEncrypted)
    .toArray();

  for (const tag of plaintextTags) {
    const encrypted = await encryptTag(tag, key);
    await db.tags.put(encrypted);
    tagCount++;
  }

  // Migrate categories
  const plaintextCategories = await db.categories
    .filter(c => !c.isEncrypted)
    .toArray();

  for (const category of plaintextCategories) {
    const encrypted = await encryptCategory(category, key);
    await db.categories.put(encrypted);
    categoryCount++;
  }

  return {
    records: recordCount,
    attachments: attachmentCount,
    tags: tagCount,
    categories: categoryCount,
  };
}

// Check if there's any plaintext data that needs migration
export async function hasPlaintextData(): Promise<boolean> {
  const plaintextRecords = await db.records.filter(r => !r.isEncrypted).count();
  if (plaintextRecords > 0) return true;

  const plaintextAttachments = await db.attachments.filter(a => !a.isEncrypted).count();
  if (plaintextAttachments > 0) return true;

  const plaintextTags = await db.tags.filter(t => !t.isEncrypted).count();
  if (plaintextTags > 0) return true;

  const plaintextCategories = await db.categories.filter(c => !c.isEncrypted).count();
  if (plaintextCategories > 0) return true;

  return false;
}

// Encrypt a record origin's sensitive fields
export async function encryptRecordOrigin(origin: RecordOrigin, key: CryptoKey): Promise<RecordOrigin> {
  const sensitiveData: Partial<RecordOrigin> = {};
  
  for (const field of RECORD_ORIGIN_SENSITIVE_FIELDS) {
    if (origin[field] !== undefined) {
      sensitiveData[field] = origin[field] as any;
    }
  }
  
  // Also include arrays
  if (origin.tags) sensitiveData.tags = origin.tags;
  if (origin.categories) sensitiveData.categories = origin.categories;

  const encryptedPayload = await encrypt(JSON.stringify(sensitiveData), key);

  return {
    ...origin,
    label: undefined,
    notes: undefined,
    seedName: undefined,
    walletSoftware: undefined,
    owner: undefined,
    walletName: undefined,
    source: undefined,
    xpub: undefined,
    derivationPath: undefined,
    tags: undefined,
    categories: undefined,
    encryptedPayload,
    isEncrypted: true,
  };
}

// Decrypt a record origin's sensitive fields
export async function decryptRecordOrigin(origin: RecordOrigin, key: CryptoKey): Promise<RecordOrigin> {
  if (!origin.isEncrypted || !origin.encryptedPayload) {
    return origin;
  }

  try {
    const decryptedJson = await decrypt(origin.encryptedPayload, key);
    const sensitiveData = JSON.parse(decryptedJson);

    return {
      ...origin,
      ...sensitiveData,
      encryptedPayload: undefined,
      isEncrypted: false,
    };
  } catch (error) {
    console.error('Failed to decrypt record origin:', error);
    throw new Error('Failed to decrypt record origin.');
  }
}

// Database encryption utilities
// Handles encryption/decryption of record data in IndexedDB

import { encrypt, decrypt } from './crypto';
import { db, type Record, type Attachment, type Tag, type Category, type RecordOrigin, type Owner, type WalletName, type SeedName, type WalletSoftware, type DerivationTemplate, type Evidence, type EvidenceAttachment, type TransactionParticipant } from './database';

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
  'costBasisUsd', // Financial data - user-provided cost basis
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
    costBasisUsd: undefined, // Encrypted financial data
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
  participants: number;
}> {
  let recordCount = 0;
  let attachmentCount = 0;
  let tagCount = 0;
  let categoryCount = 0;
  let participantCount = 0;

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

  // Migrate transaction participants (batched for performance)
  const plaintextParticipants = await db.transactionParticipants
    .filter(p => !p.isEncrypted)
    .toArray();

  for (let i = 0; i < plaintextParticipants.length; i += 200) {
    const chunk = plaintextParticipants.slice(i, i + 200);
    await db.transaction('rw', db.transactionParticipants, async () => {
      for (const p of chunk) {
        const encrypted = await encryptParticipant(p, key);
        await db.transactionParticipants.put(encrypted);
        participantCount++;
      }
    });
  }

  return {
    records: recordCount,
    attachments: attachmentCount,
    tags: tagCount,
    categories: categoryCount,
    participants: participantCount,
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

  const plaintextParticipants = await db.transactionParticipants.filter(p => !p.isEncrypted).count();
  if (plaintextParticipants > 0) return true;

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

// Generic vocabulary item encryption/decryption (for Owner, WalletName, SeedName, WalletSoftware)
// These all have the same structure: id, name, createdAt, encryptedPayload, isEncrypted

export async function encryptOwner(owner: Owner, key: CryptoKey): Promise<Owner> {
  const encryptedPayload = await encrypt(JSON.stringify({ name: owner.name }), key);
  return {
    ...owner,
    name: '[encrypted]',
    encryptedPayload,
    isEncrypted: true,
  };
}

export async function decryptOwner(owner: Owner, key: CryptoKey): Promise<Owner> {
  if (!owner.isEncrypted || !owner.encryptedPayload) {
    return owner;
  }
  try {
    const decryptedJson = await decrypt(owner.encryptedPayload, key);
    const { name } = JSON.parse(decryptedJson);
    return {
      ...owner,
      name,
      encryptedPayload: undefined,
      isEncrypted: false,
    };
  } catch (error) {
    console.error('Failed to decrypt owner:', error);
    throw new Error('Failed to decrypt owner.');
  }
}

export async function encryptWalletName(walletName: WalletName, key: CryptoKey): Promise<WalletName> {
  const encryptedPayload = await encrypt(JSON.stringify({ name: walletName.name }), key);
  return {
    ...walletName,
    name: '[encrypted]',
    encryptedPayload,
    isEncrypted: true,
  };
}

export async function decryptWalletName(walletName: WalletName, key: CryptoKey): Promise<WalletName> {
  if (!walletName.isEncrypted || !walletName.encryptedPayload) {
    return walletName;
  }
  try {
    const decryptedJson = await decrypt(walletName.encryptedPayload, key);
    const { name } = JSON.parse(decryptedJson);
    return {
      ...walletName,
      name,
      encryptedPayload: undefined,
      isEncrypted: false,
    };
  } catch (error) {
    console.error('Failed to decrypt wallet name:', error);
    throw new Error('Failed to decrypt wallet name.');
  }
}

export async function encryptSeedName(seedName: SeedName, key: CryptoKey): Promise<SeedName> {
  const encryptedPayload = await encrypt(JSON.stringify({ name: seedName.name }), key);
  return {
    ...seedName,
    name: '[encrypted]',
    encryptedPayload,
    isEncrypted: true,
  };
}

export async function decryptSeedName(seedName: SeedName, key: CryptoKey): Promise<SeedName> {
  if (!seedName.isEncrypted || !seedName.encryptedPayload) {
    return seedName;
  }
  try {
    const decryptedJson = await decrypt(seedName.encryptedPayload, key);
    const { name } = JSON.parse(decryptedJson);
    return {
      ...seedName,
      name,
      encryptedPayload: undefined,
      isEncrypted: false,
    };
  } catch (error) {
    console.error('Failed to decrypt seed name:', error);
    throw new Error('Failed to decrypt seed name.');
  }
}

export async function encryptWalletSoftware(walletSoftware: WalletSoftware, key: CryptoKey): Promise<WalletSoftware> {
  const encryptedPayload = await encrypt(JSON.stringify({ name: walletSoftware.name }), key);
  return {
    ...walletSoftware,
    name: '[encrypted]',
    encryptedPayload,
    isEncrypted: true,
  };
}

export async function decryptWalletSoftware(walletSoftware: WalletSoftware, key: CryptoKey): Promise<WalletSoftware> {
  if (!walletSoftware.isEncrypted || !walletSoftware.encryptedPayload) {
    return walletSoftware;
  }
  try {
    const decryptedJson = await decrypt(walletSoftware.encryptedPayload, key);
    const { name } = JSON.parse(decryptedJson);
    return {
      ...walletSoftware,
      name,
      encryptedPayload: undefined,
      isEncrypted: false,
    };
  } catch (error) {
    console.error('Failed to decrypt wallet software:', error);
    throw new Error('Failed to decrypt wallet software.');
  }
}

export async function encryptDerivationTemplate(template: DerivationTemplate, key: CryptoKey): Promise<DerivationTemplate> {
  const sensitivePayload = JSON.stringify({
    xpub: template.xpub,
    notes: template.notes,
    owner: template.owner,
    walletName: template.walletName,
    seedName: template.seedName,
  });
  
  const encryptedPayload = await encrypt(sensitivePayload, key);
  
  return {
    ...template,
    xpub: '[encrypted]',
    notes: template.notes ? '[encrypted]' : undefined,
    owner: template.owner ? '[encrypted]' : undefined,
    walletName: template.walletName ? '[encrypted]' : undefined,
    seedName: template.seedName ? '[encrypted]' : undefined,
    encryptedPayload,
    isEncrypted: true,
  };
}

export async function decryptDerivationTemplate(template: DerivationTemplate, key: CryptoKey): Promise<DerivationTemplate> {
  if (!template.isEncrypted || !template.encryptedPayload) {
    return template;
  }
  try {
    const decryptedJson = await decrypt(template.encryptedPayload, key);
    const { xpub, notes, owner, walletName, seedName } = JSON.parse(decryptedJson);
    return {
      ...template,
      xpub,
      notes,
      owner,
      walletName,
      seedName,
      encryptedPayload: undefined,
      isEncrypted: false,
    };
  } catch (error) {
    console.error('Failed to decrypt derivation template:', error);
    throw new Error('Failed to decrypt derivation template.');
  }
}

// ============ EVIDENCE ENCRYPTION ============

const EVIDENCE_SENSITIVE_FIELDS: (keyof Evidence)[] = [
  'title',
  'notes',
  'partiesInvolved',
  'source',
];

export async function encryptEvidence(evidence: Evidence, key: CryptoKey): Promise<Evidence> {
  const sensitiveData: Partial<Evidence> = {};
  
  for (const field of EVIDENCE_SENSITIVE_FIELDS) {
    if (evidence[field] !== undefined) {
      sensitiveData[field] = evidence[field] as any;
    }
  }

  const encryptedPayload = await encrypt(JSON.stringify(sensitiveData), key);

  return {
    ...evidence,
    title: '[encrypted]',
    notes: undefined,
    partiesInvolved: undefined,
    source: undefined,
    encryptedPayload,
    isEncrypted: true,
  };
}

export async function decryptEvidence(evidence: Evidence, key: CryptoKey): Promise<Evidence> {
  if (!evidence.isEncrypted || !evidence.encryptedPayload) {
    return evidence;
  }
  try {
    const decryptedJson = await decrypt(evidence.encryptedPayload, key);
    const sensitiveData = JSON.parse(decryptedJson);
    return {
      ...evidence,
      ...sensitiveData,
      encryptedPayload: undefined,
      isEncrypted: false,
    };
  } catch (error) {
    console.error('Failed to decrypt evidence:', error);
    throw new Error('Failed to decrypt evidence.');
  }
}

// ============ EVIDENCE ATTACHMENT ENCRYPTION ============

const EVIDENCE_ATTACHMENT_SENSITIVE_FIELDS: (keyof EvidenceAttachment)[] = [
  'filename',
  'objectStoragePath',
];

export async function encryptEvidenceAttachment(attachment: EvidenceAttachment, key: CryptoKey): Promise<EvidenceAttachment> {
  const sensitiveData: Partial<EvidenceAttachment> = {};
  
  for (const field of EVIDENCE_ATTACHMENT_SENSITIVE_FIELDS) {
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

export async function decryptEvidenceAttachment(attachment: EvidenceAttachment, key: CryptoKey): Promise<EvidenceAttachment> {
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
    console.error('Failed to decrypt evidence attachment:', error);
    throw new Error('Failed to decrypt evidence attachment.');
  }
}

// ============ TRANSACTION PARTICIPANT ENCRYPTION ============

const PARTICIPANT_SENSITIVE_FIELDS: (keyof TransactionParticipant)[] = [
  'address',
  'amount',
  'prevTxid',
  'prevVout',
  'scriptType',
];

export async function encryptParticipant(participant: TransactionParticipant, key: CryptoKey): Promise<TransactionParticipant> {
  const sensitiveData: Partial<TransactionParticipant> = {};

  for (const field of PARTICIPANT_SENSITIVE_FIELDS) {
    if (participant[field] !== undefined) {
      sensitiveData[field] = participant[field] as any;
    }
  }

  const encryptedPayload = await encrypt(JSON.stringify(sensitiveData), key);

  return {
    ...participant,
    address: '[encrypted]',
    amount: 0,
    prevTxid: participant.prevTxid !== undefined ? '[encrypted]' : undefined,
    prevVout: participant.prevVout !== undefined ? 0 : undefined,
    scriptType: undefined,
    encryptedPayload,
    isEncrypted: true,
  };
}

export async function decryptParticipant(participant: TransactionParticipant, key: CryptoKey): Promise<TransactionParticipant> {
  if (!participant.isEncrypted || !participant.encryptedPayload) {
    return participant;
  }

  try {
    const decryptedJson = await decrypt(participant.encryptedPayload, key);
    const sensitiveData = JSON.parse(decryptedJson);

    return {
      ...participant,
      ...sensitiveData,
    };
  } catch (error) {
    console.error('Failed to decrypt transaction participant:', error);
    throw new Error('Failed to decrypt transaction participant.');
  }
}

export async function encryptParticipantsBatch(
  participants: TransactionParticipant[],
  key: CryptoKey,
  chunkSize: number = 200
): Promise<TransactionParticipant[]> {
  const results: TransactionParticipant[] = [];
  for (let i = 0; i < participants.length; i += chunkSize) {
    const chunk = participants.slice(i, i + chunkSize);
    const encrypted = await Promise.all(chunk.map(p => encryptParticipant(p, key)));
    results.push(...encrypted);
    if (i + chunkSize < participants.length) {
      await new Promise(r => setTimeout(r, 0));
    }
  }
  return results;
}

export async function decryptParticipantsBatch(
  participants: TransactionParticipant[],
  key: CryptoKey,
  chunkSize: number = 100
): Promise<TransactionParticipant[]> {
  const results: TransactionParticipant[] = [];
  for (let i = 0; i < participants.length; i += chunkSize) {
    const chunk = participants.slice(i, i + chunkSize);
    const decrypted = await Promise.all(
      chunk.map(p => {
        if (!p.isEncrypted || !p.encryptedPayload) return Promise.resolve(p);
        return decryptParticipant(p, key);
      })
    );
    results.push(...decrypted);
    if (i + chunkSize < participants.length) {
      await new Promise(r => setTimeout(r, 0));
    }
  }
  return results;
}

// ============ RE-ENCRYPTION FOR PASSWORD CHANGE ============

export interface ReEncryptionProgress {
  stage: string;
  current: number;
  total: number;
  percentage: number;
}

export type ProgressCallback = (progress: ReEncryptionProgress) => void;

export async function reEncryptAllData(
  oldKey: CryptoKey, 
  newKey: CryptoKey,
  onProgress?: ProgressCallback
): Promise<{
  records: number;
  attachments: number;
  tags: number;
  categories: number;
  owners: number;
  walletNames: number;
  seedNames: number;
  walletSoftware: number;
  derivationTemplates: number;
  recordOrigins: number;
  evidence: number;
  evidenceAttachments: number;
  participants: number;
  failedItems: number;
}> {
  let recordCount = 0;
  let attachmentCount = 0;
  let tagCount = 0;
  let categoryCount = 0;
  let ownerCount = 0;
  let walletNameCount = 0;
  let seedNameCount = 0;
  let walletSoftwareCount = 0;
  let derivationTemplateCount = 0;
  let recordOriginCount = 0;
  let evidenceCount = 0;
  let evidenceAttachmentCount = 0;

  const reportProgress = (stage: string, current: number, total: number) => {
    if (onProgress) {
      onProgress({
        stage,
        current,
        total,
        percentage: total > 0 ? Math.round((current / total) * 100) : 100,
      });
    }
  };

  let failedItems: Array<{ table: string; id: any; error: string }> = [];

  async function reEncryptTable<T extends { id?: number; isEncrypted?: boolean }>(
    tableName: string,
    table: any,
    decryptFn: (item: T, key: CryptoKey) => Promise<T>,
    encryptFn: (item: T, key: CryptoKey) => Promise<T>,
  ): Promise<number> {
    const items = await table.filter((r: any) => r.isEncrypted === true).toArray();
    let count = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as T;
      reportProgress(tableName, i + 1, items.length);
      try {
        const decrypted = await decryptFn(item, oldKey);
        const reEncrypted = await encryptFn(decrypted, newKey);
        await table.put(reEncrypted);
        count++;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`[ReEncrypt] Failed ${tableName} id=${item.id}: ${errMsg}`);
        failedItems.push({ table: tableName, id: item.id, error: errMsg });
      }
      if (i % 50 === 0) await new Promise(r => setTimeout(r, 0));
    }
    return count;
  }

  recordCount = await reEncryptTable('Records', db.records, decryptRecord, encryptRecord);
  attachmentCount = await reEncryptTable('Attachments', db.attachments, decryptAttachment, encryptAttachment);
  tagCount = await reEncryptTable('Tags', db.tags, decryptTag, encryptTag);
  categoryCount = await reEncryptTable('Categories', db.categories, decryptCategory, encryptCategory);
  ownerCount = await reEncryptTable('Owners', db.owners, decryptOwner, encryptOwner);
  walletNameCount = await reEncryptTable('Wallet Names', db.walletNames, decryptWalletName, encryptWalletName);
  seedNameCount = await reEncryptTable('Seed Names', db.seedNames, decryptSeedName, encryptSeedName);
  walletSoftwareCount = await reEncryptTable('Wallet Software', db.walletSoftware, decryptWalletSoftware, encryptWalletSoftware);
  derivationTemplateCount = await reEncryptTable('Derivation Templates', db.derivationTemplates, decryptDerivationTemplate, encryptDerivationTemplate);
  recordOriginCount = await reEncryptTable('Record Origins', db.recordOrigins, decryptRecordOrigin, encryptRecordOrigin);
  evidenceCount = await reEncryptTable('Evidence', db.evidence, decryptEvidence, encryptEvidence);
  evidenceAttachmentCount = await reEncryptTable('Evidence Attachments', db.evidenceAttachments, decryptEvidenceAttachment, encryptEvidenceAttachment);

  let participantCount = 0;
  const participants = await db.transactionParticipants.filter(p => p.isEncrypted === true).toArray();
  for (let i = 0; i < participants.length; i++) {
    const p = participants[i];
    reportProgress('Transaction Participants', i + 1, participants.length);
    try {
      const decrypted = await decryptParticipant(p, oldKey);
      const reEncrypted = await encryptParticipant(decrypted, newKey);
      await db.transactionParticipants.put(reEncrypted);
      participantCount++;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[ReEncrypt] Failed Participant id=${p.id}: ${errMsg}`);
      failedItems.push({ table: 'Transaction Participants', id: p.id, error: errMsg });
    }
    if (i % 50 === 0) await new Promise(r => setTimeout(r, 0));
  }

  if (failedItems.length > 0) {
    console.warn(`[ReEncrypt] ${failedItems.length} items failed re-encryption:`, failedItems);
  }

  reportProgress('Complete', 1, 1);

  return {
    records: recordCount,
    attachments: attachmentCount,
    tags: tagCount,
    categories: categoryCount,
    owners: ownerCount,
    walletNames: walletNameCount,
    seedNames: seedNameCount,
    walletSoftware: walletSoftwareCount,
    derivationTemplates: derivationTemplateCount,
    recordOrigins: recordOriginCount,
    evidence: evidenceCount,
    evidenceAttachments: evidenceAttachmentCount,
    participants: participantCount,
    failedItems: failedItems.length,
  };
}

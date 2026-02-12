import { db, notifyDbChange, type Record, type Attachment, type Evidence, type EvidenceAttachment } from '../database';
import {
  encryptAttachment,
  decryptAttachment,
  decryptRecord,
  encryptEvidence,
  decryptEvidence,
  encryptEvidenceAttachment,
  decryptEvidenceAttachment,
} from '../dbEncryption';
import { getKey } from './key-management';

// ============ RECORD DECRYPTION ============

export async function decryptRecordById(id: number): Promise<Record | undefined> {
  const key = getKey();
  const record = await db.records.get(id);
  
  if (!record) return undefined;
  
  if (record.isEncrypted) {
    return await decryptRecord(record, key);
  }
  
  return record;
}

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

// ============ EVIDENCE OPERATIONS ============

export async function createEvidence(
  data: Omit<Evidence, 'id' | 'createdAt' | 'updatedAt'>
): Promise<number> {
  const key = getKey();
  
  const now = Date.now();
  const evidence: Evidence = {
    ...data,
    createdAt: now,
    updatedAt: now,
  };

  const encrypted = await encryptEvidence(evidence, key);
  const id = await db.evidence.add(encrypted);
  
  notifyDbChange('evidence');
  
  return id as number;
}

export async function getDecryptedEvidence(id: number): Promise<Evidence | undefined> {
  const key = getKey();
  
  const evidence = await db.evidence.get(id);
  
  if (!evidence) return undefined;
  
  if (evidence.isEncrypted) {
    return await decryptEvidence(evidence, key);
  }
  
  return evidence;
}

export async function getAllDecryptedEvidence(): Promise<Evidence[]> {
  const key = getKey();
  
  const allEvidence = await db.evidence.toArray();
  
  return Promise.all(
    allEvidence.map(async (evidence) => {
      if (evidence.isEncrypted) {
        return await decryptEvidence(evidence, key);
      }
      return evidence;
    })
  );
}

export async function decryptEvidenceList(evidenceList: Evidence[]): Promise<Evidence[]> {
  const key = getKey();
  
  return Promise.all(
    evidenceList.map(async (evidence) => {
      if (evidence.isEncrypted) {
        return await decryptEvidence(evidence, key);
      }
      return evidence;
    })
  );
}

export async function updateEvidence(
  id: number,
  updates: Partial<Evidence>
): Promise<void> {
  const key = getKey();
  
  const existing = await db.evidence.get(id);
  if (!existing) throw new Error('Evidence not found');

  const decrypted = existing.isEncrypted
    ? await decryptEvidence(existing, key)
    : existing;

  const updated: Evidence = {
    ...decrypted,
    ...updates,
    id,
    updatedAt: Date.now(),
  };

  const encrypted = await encryptEvidence(updated, key);
  await db.evidence.put(encrypted);
  
  notifyDbChange('evidence');
}

export async function deleteEvidence(id: number): Promise<void> {
  const attachments = await db.evidenceAttachments.where('evidenceId').equals(id).toArray();
  
  for (const attachment of attachments) {
    if (attachment.id) {
      await db.evidenceAttachments.delete(attachment.id);
    }
  }
  
  await db.evidence.delete(id);
  
  notifyDbChange('evidence');
}

// ============ EVIDENCE ATTACHMENT OPERATIONS ============

export async function createEvidenceAttachment(
  data: Omit<EvidenceAttachment, 'id' | 'createdAt'>
): Promise<number> {
  const key = getKey();
  
  const attachment: EvidenceAttachment = {
    ...data,
    createdAt: Date.now(),
  };

  const encrypted = await encryptEvidenceAttachment(attachment, key);
  const id = await db.evidenceAttachments.add(encrypted);
  return id as number;
}

export async function getDecryptedEvidenceAttachments(evidenceId: number): Promise<EvidenceAttachment[]> {
  const key = getKey();
  const attachments = await db.evidenceAttachments.where('evidenceId').equals(evidenceId).toArray();
  
  return Promise.all(
    attachments.map(async (att) => {
      if (att.isEncrypted) {
        return await decryptEvidenceAttachment(att, key);
      }
      return att;
    })
  );
}

export async function deleteEvidenceAttachment(id: number): Promise<void> {
  await db.evidenceAttachments.delete(id);
}

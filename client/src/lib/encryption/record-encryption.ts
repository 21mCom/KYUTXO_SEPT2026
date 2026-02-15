import { db, notifyDbChange, type Record, type Attachment, type Evidence, type EvidenceAttachment, type TransactionParticipant } from '../database';
import {
  encryptAttachment,
  decryptAttachment,
  decryptRecord,
  encryptEvidence,
  decryptEvidence,
  encryptEvidenceAttachment,
  decryptEvidenceAttachment,
  encryptParticipant,
  decryptParticipant,
  encryptParticipantsBatch,
  decryptParticipantsBatch,
} from '../dbEncryption';
import { getKey } from './key-management';
import { getCachedRecord, setCachedRecord } from './decrypt-cache';

// ============ RECORD DECRYPTION ============

export async function decryptRecordById(id: number): Promise<Record | undefined> {
  const cached = getCachedRecord(id);
  if (cached) return cached;

  const key = getKey();
  const record = await db.records.get(id);
  
  if (!record) return undefined;
  
  if (record.isEncrypted) {
    const decrypted = await decryptRecord(record, key);
    setCachedRecord(decrypted);
    return decrypted;
  }
  
  return record;
}

export async function decryptRecords(records: Record[]): Promise<Record[]> {
  const key = getKey();
  
  return Promise.all(
    records.map(async (record) => {
      if (record.id !== undefined) {
        const cached = getCachedRecord(record.id);
        if (cached) return cached;
      }
      if (record.isEncrypted) {
        const decrypted = await decryptRecord(record, key);
        setCachedRecord(decrypted);
        return decrypted;
      }
      return record;
    })
  );
}

export interface DecryptProgress {
  current: number;
  total: number;
  cached: number;
}

export async function decryptRecordsWithProgress(
  records: Record[],
  onProgress?: (progress: DecryptProgress) => void,
  chunkSize: number = 500,
): Promise<Record[]> {
  const key = getKey();
  const total = records.length;
  const results: Record[] = [];
  let cachedCount = 0;

  for (let i = 0; i < total; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize);
    const decrypted = await Promise.all(
      chunk.map(async (record) => {
        if (record.id !== undefined) {
          const cached = getCachedRecord(record.id);
          if (cached) {
            cachedCount++;
            return cached;
          }
        }
        if (record.isEncrypted) {
          const dec = await decryptRecord(record, key);
          setCachedRecord(dec);
          return dec;
        }
        return record;
      })
    );
    results.push(...decrypted);
    if (onProgress) {
      onProgress({ current: Math.min(i + chunkSize, total), total, cached: cachedCount });
    }
    if (i + chunkSize < total) {
      await new Promise(r => setTimeout(r, 0));
    }
  }

  return results;
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

// ============ TRANSACTION PARTICIPANT ENCRYPTION ============

export async function encryptParticipantData(participant: TransactionParticipant): Promise<TransactionParticipant> {
  const key = getKey();
  return encryptParticipant(participant, key);
}

export async function decryptParticipantData(participant: TransactionParticipant): Promise<TransactionParticipant> {
  if (!participant.isEncrypted || !participant.encryptedPayload) return participant;
  const key = getKey();
  return decryptParticipant(participant, key);
}

export async function encryptParticipantsBatchData(
  participants: TransactionParticipant[],
): Promise<TransactionParticipant[]> {
  const key = getKey();
  return encryptParticipantsBatch(participants, key);
}

export async function decryptParticipantsData(
  participants: TransactionParticipant[],
): Promise<TransactionParticipant[]> {
  if (participants.length === 0) return participants;
  const key = getKey();
  return decryptParticipantsBatch(participants, key);
}

export async function getAllDecryptedParticipants(): Promise<TransactionParticipant[]> {
  const raw = await db.transactionParticipants.toArray();
  return decryptParticipantsData(raw);
}

export async function getDecryptedParticipantsByTxid(txid: string): Promise<TransactionParticipant[]> {
  const raw = await db.transactionParticipants.where('txid').equals(txid).toArray();
  return decryptParticipantsData(raw);
}

export async function getDecryptedParticipantsByTxids(txids: string[]): Promise<TransactionParticipant[]> {
  const raw = await db.transactionParticipants.where('txid').anyOf(txids).toArray();
  return decryptParticipantsData(raw);
}

export async function getDecryptedParticipantsByAddress(address: string): Promise<TransactionParticipant[]> {
  const all = await getAllDecryptedParticipants();
  return all.filter(p => p.address === address);
}

export async function getDecryptedParticipantsByRecordId(recordId: number): Promise<TransactionParticipant[]> {
  const raw = await db.transactionParticipants.where('recordId').equals(recordId).toArray();
  return decryptParticipantsData(raw);
}

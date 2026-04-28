import { db, notifyDbChange, type Record, type Attachment, type Evidence, type EvidenceAttachment, type TransactionParticipant } from '../database';

export async function createAttachment(
  data: Omit<Attachment, 'id' | 'createdAt'>
): Promise<number> {
  const attachment: Attachment = {
    ...data,
    createdAt: Date.now(),
  };

  const id = await db.attachments.add(attachment);
  return id as number;
}

export async function getAttachments(recordId: number): Promise<Attachment[]> {
  return db.attachments.where('recordId').equals(recordId).toArray();
}

export async function createEvidence(
  data: Omit<Evidence, 'id' | 'createdAt' | 'updatedAt'>
): Promise<number> {
  const now = Date.now();
  const evidence: Evidence = {
    ...data,
    createdAt: now,
    updatedAt: now,
  };

  const id = await db.evidence.add(evidence);
  notifyDbChange('evidence');
  return id as number;
}

export async function getEvidence(id: number): Promise<Evidence | undefined> {
  return db.evidence.get(id);
}

export async function getAllEvidence(): Promise<Evidence[]> {
  return db.evidence.toArray();
}

export async function updateEvidence(
  id: number,
  updates: Partial<Evidence>
): Promise<void> {
  const existing = await db.evidence.get(id);
  if (!existing) throw new Error('Evidence not found');

  const updated: Evidence = {
    ...existing,
    ...updates,
    id,
    updatedAt: Date.now(),
  };

  await db.evidence.put(updated);
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

export async function createEvidenceAttachment(
  data: Omit<EvidenceAttachment, 'id' | 'createdAt'>
): Promise<number> {
  const attachment: EvidenceAttachment = {
    ...data,
    createdAt: Date.now(),
  };

  const id = await db.evidenceAttachments.add(attachment);
  return id as number;
}

export async function getEvidenceAttachments(evidenceId: number): Promise<EvidenceAttachment[]> {
  return db.evidenceAttachments.where('evidenceId').equals(evidenceId).toArray();
}

export async function deleteEvidenceAttachment(id: number): Promise<void> {
  await db.evidenceAttachments.delete(id);
}

export async function getAllParticipants(): Promise<TransactionParticipant[]> {
  return db.transactionParticipants.toArray();
}

export async function getParticipantsByTxid(txid: string): Promise<TransactionParticipant[]> {
  return db.transactionParticipants.where('txid').equals(txid).toArray();
}

export async function getParticipantsByTxids(txids: string[]): Promise<TransactionParticipant[]> {
  return db.transactionParticipants.where('txid').anyOf(txids).toArray();
}

export async function getParticipantsByAddress(address: string): Promise<TransactionParticipant[]> {
  return db.transactionParticipants.where('address').equals(address).toArray();
}

export async function getParticipantsByAddresses(addresses: string[], signal?: AbortSignal): Promise<TransactionParticipant[]> {
  if (addresses.length === 0) return [];
  const results: TransactionParticipant[] = [];
  const batchSize = 500;
  for (let i = 0; i < addresses.length; i += batchSize) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const batch = addresses.slice(i, i + batchSize);
    const raw = await db.transactionParticipants.where('address').anyOf(batch).toArray();
    results.push(...raw);
    if (i + batchSize < addresses.length) {
      await new Promise(r => setTimeout(r, 0));
    }
  }
  return results;
}

export async function getParticipantsByRecordId(recordId: number): Promise<TransactionParticipant[]> {
  return db.transactionParticipants.where('recordId').equals(recordId).toArray();
}

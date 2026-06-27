import { db, type Attachment, type EvidenceAttachment, type TransactionParticipant } from '../database';
import { addAttachment, getAttachmentsByRecordId } from './attachments-crud';

export async function createAttachment(
  data: Omit<Attachment, 'id' | 'createdAt'>
): Promise<number> {
  return addAttachment(data, { skipNotification: true });
}

export async function getAttachments(recordId: number): Promise<Attachment[]> {
  return getAttachmentsByRecordId(recordId);
}

export async function getEvidenceAttachments(evidenceId: number): Promise<EvidenceAttachment[]> {
  return db.evidenceAttachments.where('evidenceId').equals(evidenceId).toArray();
}

export async function getAllParticipants(): Promise<TransactionParticipant[]> {
  return db.transactionParticipants.toArray();
}

export async function getParticipantsByTxid(txid: string): Promise<TransactionParticipant[]> {
  return db.transactionParticipants.where('txid').equals(txid).toArray();
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

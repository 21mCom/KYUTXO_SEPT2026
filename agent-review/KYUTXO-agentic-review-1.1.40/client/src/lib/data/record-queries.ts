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

/**
 * Fetch INPUT participant rows that spend the given outpoints ("txid:vout"),
 * via the [prevTxid+prevVout] compound index. Needed for spent-output
 * detection: Electrum-synced inputs carry NO prevout address (stored with a
 * blank address string), so an address-based participant load never returns
 * them even though they spend owned outputs.
 */
export async function getSpendInputsByOutpoints(
  outpoints: Array<[string, number]>,
  signal?: AbortSignal,
): Promise<TransactionParticipant[]> {
  if (outpoints.length === 0) return [];
  const results: TransactionParticipant[] = [];
  const batchSize = 500;
  for (let i = 0; i < outpoints.length; i += batchSize) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const batch = outpoints.slice(i, i + batchSize);
    const raw = await db.transactionParticipants.where('[prevTxid+prevVout]').anyOf(batch).toArray();
    for (const p of raw) {
      if (p.role === 'input') results.push(p);
    }
    if (i + batchSize < outpoints.length) {
      await new Promise(r => setTimeout(r, 0));
    }
  }
  return results;
}

/**
 * Address-keyed participant load PLUS blank-address outpoint spend inputs.
 *
 * Electrum-synced spend inputs are stored with a blank address (only
 * prevTxid/prevVout), so `getParticipantsByAddresses` alone misses spend
 * transactions whose only link to an owned address is such an input. This
 * helper follows up with an outpoint-keyed load for inputs spending the
 * owned outputs found in the first pass and merges the missing rows in
 * (deduped by participant id), so tx-set discovery (AML screening,
 * Lightning detection, ...) sees those spends too.
 */
export async function getParticipantsByAddressesWithOutpointSpends(
  addresses: string[],
  signal?: AbortSignal,
): Promise<TransactionParticipant[]> {
  const participants = await getParticipantsByAddresses(addresses, signal);
  if (participants.length === 0) return participants;

  const seenIds = new Set<number>();
  const ownedOutpoints: Array<[string, number]> = [];
  for (const p of participants) {
    if (p.id !== undefined) seenIds.add(p.id);
    if (p.role === 'output' && p.vout !== undefined && p.vout !== null) {
      ownedOutpoints.push([p.txid, p.vout]);
    }
  }

  const spendInputs = await getSpendInputsByOutpoints(ownedOutpoints, signal);
  for (const p of spendInputs) {
    if (p.id !== undefined && seenIds.has(p.id)) continue;
    if (p.id !== undefined) seenIds.add(p.id);
    participants.push(p);
  }
  return participants;
}

export async function getParticipantsByRecordId(recordId: number): Promise<TransactionParticipant[]> {
  return db.transactionParticipants.where('recordId').equals(recordId).toArray();
}

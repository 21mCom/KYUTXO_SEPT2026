import { type Attachment, type EvidenceAttachment, type TransactionParticipant } from '../database';
import { getVaultRepository, type ProtectedRepositoryQueryName, type VaultRows, type VaultTableName } from '../repository';
import { addAttachment, getAttachmentsByRecordId } from './attachments-crud';

const PAGE_SIZE = 500;

async function participantRows(name: ProtectedRepositoryQueryName, value: unknown, limit?: number): Promise<TransactionParticipant[]> {
  return getVaultRepository().query<TransactionParticipant>('transactionParticipants', name, value, limit);
}

async function listRows<T extends VaultTableName>(table: T): Promise<VaultRows[T][]> {
  const repository = getVaultRepository();
  const rows: VaultRows[T][] = [];
  let cursor: string | number | undefined;
  do {
    const page = await repository.list(table, { cursor, limit: PAGE_SIZE });
    rows.push(...page.rows);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return rows;
}

export async function createAttachment(
  data: Omit<Attachment, 'id' | 'createdAt'>
): Promise<number> {
  return addAttachment(data, { skipNotification: true });
}

export async function getAttachments(recordId: number): Promise<Attachment[]> {
  return getAttachmentsByRecordId(recordId);
}

export async function getEvidenceAttachments(evidenceId: number): Promise<EvidenceAttachment[]> {
  return (await listRows('evidenceAttachments')).filter((row) => row.evidenceId === evidenceId);
}

export async function getAllParticipants(): Promise<TransactionParticipant[]> {
  if (getVaultRepository().kind === 'protected') {
    throw new Error('Protected vault native query "transactionParticipants.all" is required; unbounded participant reads are not permitted');
  }
  return listRows('transactionParticipants');
}

export async function getParticipantsByTxid(txid: string): Promise<TransactionParticipant[]> {
  return participantRows('participants.byTxid', txid);
}

export async function getParticipantsByAddress(address: string): Promise<TransactionParticipant[]> {
  return participantRows('participants.byAddress', address);
}

export async function getRecordParticipantsByAddresses(addresses: string[], signal?: AbortSignal): Promise<TransactionParticipant[]> {
  if (addresses.length === 0) return [];
  const results: TransactionParticipant[] = [];
  const batchSize = 500;
  const pageSize = 1000;
  for (let i = 0; i < addresses.length; i += batchSize) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const batch = addresses.slice(i, i + batchSize);
    let afterId = 0;
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const page = await participantRows(
        'participants.byAddressesAfterId',
        { addresses: batch, afterId },
        pageSize,
      );
      results.push(...page);
      if (page.length < pageSize) break;
      const lastId = page[page.length - 1]?.id;
      if (lastId === undefined || lastId <= afterId) {
        throw new Error("Participant address query did not advance");
      }
      afterId = lastId;
    }
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
    const raw = await participantRows('participants.byPrevouts', batch, batch.length);
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
  const participants = await getRecordParticipantsByAddresses(addresses, signal);
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
  return participantRows('participants.byRecordId', recordId);
}

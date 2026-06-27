import type { IndexableType } from 'dexie';
import { db, notifyDbChange, type BlockchainTransaction, type TransactionParticipant } from '../database';

export type CreateTransactionData = Omit<BlockchainTransaction, 'id'>;

export interface TransactionWriteOptions {
  skipNotification?: boolean;
}

export async function addTransaction(
  data: CreateTransactionData,
  options?: TransactionWriteOptions
): Promise<number> {
  const id = await db.blockchainTransactions.add(data);

  if (!options?.skipNotification) {
    notifyDbChange('blockchainTransactions');
  }

  return id as number;
}

export async function updateTransaction(
  id: number,
  changes: Partial<CreateTransactionData>,
  options?: TransactionWriteOptions
): Promise<void> {
  await db.blockchainTransactions.update(id, changes);

  if (!options?.skipNotification) {
    notifyDbChange('blockchainTransactions');
  }
}

export async function bulkAddTransactions(
  transactions: CreateTransactionData[],
  options?: TransactionWriteOptions
): Promise<void> {
  if (transactions.length === 0) return;

  await db.blockchainTransactions.bulkAdd(transactions);

  if (!options?.skipNotification) {
    notifyDbChange('blockchainTransactions');
  }
}

export async function bulkAddParticipants(
  participants: TransactionParticipant[],
  options?: TransactionWriteOptions
): Promise<void> {
  if (participants.length === 0) return;

  await db.transactionParticipants.bulkAdd(participants);

  if (!options?.skipNotification) {
    notifyDbChange('transactionParticipants');
  }
}

export async function addParticipant(
  data: TransactionParticipant,
  options?: TransactionWriteOptions
): Promise<number> {
  const id = await db.transactionParticipants.add(data);

  if (!options?.skipNotification) {
    notifyDbChange('transactionParticipants');
  }

  return id as number;
}

export async function putParticipant(
  data: TransactionParticipant,
  options?: TransactionWriteOptions
): Promise<void> {
  if (!data.id) throw new Error('Cannot put participant without an id');

  await db.transactionParticipants.put(data);

  if (!options?.skipNotification) {
    notifyDbChange('transactionParticipants');
  }
}

export async function bulkPutParticipants(
  participants: TransactionParticipant[],
  options?: TransactionWriteOptions
): Promise<void> {
  if (participants.length === 0) return;

  await db.transaction('rw', db.transactionParticipants, async () => {
    for (const p of participants) {
      if (p.id) await db.transactionParticipants.put(p);
    }
  });

  if (!options?.skipNotification) {
    notifyDbChange('transactionParticipants');
  }
}

export async function clearTransactions(
  options?: TransactionWriteOptions
): Promise<void> {
  await db.blockchainTransactions.clear();

  if (!options?.skipNotification) {
    notifyDbChange('blockchainTransactions');
  }
}

export async function clearParticipants(
  options?: TransactionWriteOptions
): Promise<void> {
  await db.transactionParticipants.clear();

  if (!options?.skipNotification) {
    notifyDbChange('transactionParticipants');
  }
}

export async function clearAllTransactionData(
  options?: TransactionWriteOptions
): Promise<void> {
  await db.blockchainTransactions.clear();
  await db.transactionParticipants.clear();

  if (!options?.skipNotification) {
    notifyDbChange(['blockchainTransactions', 'transactionParticipants']);
  }
}

// =============================================================================
// READ HELPERS — blockchainTransactions
// =============================================================================

export async function getAllTransactions(): Promise<BlockchainTransaction[]> {
  return db.blockchainTransactions.toArray();
}

// Bounded id-keyset page. Used by the streaming backup export so the whole
// transaction table is never materialised at once: callers walk the table by
// repeatedly passing the last id they saw.
export async function getTransactionsAfterId(
  afterId: number,
  limit: number
): Promise<BlockchainTransaction[]> {
  return db.blockchainTransactions.where('id').above(afterId).limit(limit).toArray();
}

export async function getTransactionByTxid(
  txid: string
): Promise<BlockchainTransaction | undefined> {
  return db.blockchainTransactions.where('txid').equals(txid).first();
}

export async function getTransactionsByTxids(
  txids: string[]
): Promise<BlockchainTransaction[]> {
  if (txids.length === 0) return [];
  return db.blockchainTransactions.where('txid').anyOf(txids).toArray();
}

export async function bulkGetTransactionsByPrimaryKeys(
  keys: string[]
): Promise<(BlockchainTransaction | undefined)[]> {
  if (keys.length === 0) return [];
  return db.blockchainTransactions.bulkGet(keys);
}

export async function countTransactions(): Promise<number> {
  return db.blockchainTransactions.count();
}

export async function countTransactionsWithOpReturn(): Promise<number> {
  return db.blockchainTransactions.where('hasOpReturn').equals(true as unknown as IndexableType).count();
}

export async function getTransactionsPageByBlockTime(
  offset: number,
  limit: number
): Promise<BlockchainTransaction[]> {
  return db.blockchainTransactions
    .orderBy('blockTime')
    .reverse()
    .offset(offset)
    .limit(limit)
    .toArray();
}

export async function getOpReturnTransactionsPageByBlockTime(
  offset: number,
  limit: number
): Promise<BlockchainTransaction[]> {
  return db.blockchainTransactions
    .orderBy('blockTime')
    .reverse()
    .filter(tx => tx.hasOpReturn === true)
    .offset(offset)
    .limit(limit)
    .toArray();
}

export async function getTransactionsByTxidStartsWith(
  prefix: string,
  limit: number
): Promise<BlockchainTransaction[]> {
  return db.blockchainTransactions
    .where('txid')
    .startsWithIgnoreCase(prefix)
    .limit(limit)
    .toArray();
}

export async function getOrderedTransactionPrimaryKeysByBlockTime(): Promise<string[]> {
  return (await db.blockchainTransactions
    .orderBy('blockTime')
    .reverse()
    .primaryKeys()) as unknown as string[];
}

export async function getOpReturnTransactionPrimaryKeys(): Promise<string[]> {
  return (await db.blockchainTransactions
    .where('hasOpReturn')
    .equals(true as unknown as IndexableType)
    .primaryKeys()) as unknown as string[];
}

// =============================================================================
// READ HELPERS — transactionParticipants
// =============================================================================

export async function countTransactionParticipants(): Promise<number> {
  return db.transactionParticipants.count();
}

export async function getAllTransactionParticipants(): Promise<TransactionParticipant[]> {
  return db.transactionParticipants.toArray();
}

// Bounded id-keyset page. Used by the streaming backup export so the whole
// participant table is never materialised at once.
export async function getTransactionParticipantsAfterId(
  afterId: number,
  limit: number
): Promise<TransactionParticipant[]> {
  return db.transactionParticipants.where('id').above(afterId).limit(limit).toArray();
}

export async function getInputParticipants(): Promise<TransactionParticipant[]> {
  return db.transactionParticipants.where('role').equals('input').toArray();
}

export async function getParticipantsByPrevOutKeys(
  keys: Array<[string, number]>
): Promise<TransactionParticipant[]> {
  if (keys.length === 0) return [];
  return db.transactionParticipants
    .where('[prevTxid+prevVout]')
    .anyOf(keys)
    .toArray();
}

export async function getParticipantsByRecordIds(
  recordIds: number[]
): Promise<TransactionParticipant[]> {
  if (recordIds.length === 0) return [];
  return db.transactionParticipants.where('recordId').anyOf(recordIds).toArray();
}

export async function getParticipantsByTxids(
  txids: string[]
): Promise<TransactionParticipant[]> {
  if (txids.length === 0) return [];
  return db.transactionParticipants.where('txid').anyOf(txids).toArray();
}

/**
 * Count transactionParticipants that have no address (blank, null, or
 * undefined). These rows are created by blockchain sync when it encounters
 * inputs that resolve to an OP_RETURN output or other non-standard scripts.
 * On vaults that ran deep multi-hop sync this count can be very large; it is
 * surfaced in the Data Stats audit so users can see the true nature of the
 * millions of rows rather than assuming data loss.
 */
export async function countAddresslessParticipants(): Promise<number> {
  return db.transactionParticipants
    .filter(p => !p.address || p.address.trim() === '')
    .count();
}

/**
 * Count input participant rows that are unresolved: they have a blank/empty
 * address but DO have prevTxid and prevVout populated. These represent spends
 * whose source address is not yet known. Until they are resolved the spending
 * amount is never subtracted from any address's balance, causing overstated
 * balances. Running prevout resolution can attribute them to the correct address.
 */
export async function countUnresolvedPrevoutInputs(): Promise<number> {
  return db.transactionParticipants
    .where('role').equals('input')
    .filter(p => (!p.address || p.address.trim() === '') && p.prevTxid !== undefined && p.prevVout !== undefined)
    .count();
}

/**
 * Attribute unresolved spend inputs (blank-address inputs with prevTxid/prevVout)
 * to the source address record they will deduct from once resolved. Each such
 * input's prevout (prevTxid:prevVout) points at a previous OUTPUT; when that
 * output belongs to one of our tracked addresses, the spend will eventually be
 * subtracted from that address's balance — so until it is resolved that wallet's
 * balance is overstated. We resolve prevouts against LOCAL output participants
 * only (never the network, KYUTXO stays offline) and return a map of
 * recordId -> number of unresolved spends pending attribution to that record.
 * Inputs whose prevout output is not locally known (or maps to no tracked
 * record) are simply omitted from the per-record map — they cannot be tied to a
 * specific wallet — but they ARE tallied separately as `unattributable` so the
 * UI can surface pending work that no single wallet card reflects.
 */
export interface UnresolvedSpendBreakdown {
  /** recordId -> number of unresolved spends pending attribution to that record. */
  byRecordId: Map<number, number>;
  /**
   * Unresolved spends whose prevout output is not locally known, or maps to no
   * tracked record. These overstate the overall balance picture but cannot be
   * attributed to any single wallet group.
   */
  unattributable: number;
}

export async function getUnresolvedSpendBreakdown(): Promise<UnresolvedSpendBreakdown> {
  const result = new Map<number, number>();

  const unresolvedInputs = await db.transactionParticipants
    .where('role').equals('input')
    .filter(p => (!p.address || p.address.trim() === '') && p.prevTxid !== undefined && p.prevVout !== undefined)
    .toArray();
  if (unresolvedInputs.length === 0) return { byRecordId: result, unattributable: 0 };

  // Batch-load the local OUTPUT participants for every referenced prevTxid so we
  // can map each unresolved input's (prevTxid, prevVout) to its source output.
  const prevTxids = new Set<string>();
  for (const inp of unresolvedInputs) {
    if (inp.prevTxid) prevTxids.add(inp.prevTxid);
  }
  const prevTxidArr = Array.from(prevTxids);
  const outputCache = new Map<string, { recordId?: number; address: string }>();
  for (let i = 0; i < prevTxidArr.length; i += 500) {
    const batch = prevTxidArr.slice(i, i + 500);
    const outputs = await db.transactionParticipants
      .where('txid').anyOf(batch)
      .and(p => p.role === 'output')
      .toArray();
    for (const o of outputs) {
      if (o.vout !== undefined) {
        outputCache.set(`${o.txid}:${o.vout}`, { recordId: o.recordId, address: o.address });
      }
    }
  }

  // Some source outputs carry an address but no recordId (e.g. created before the
  // address was tracked); resolve those addresses to a record via inputString.
  const addrsNeedingLookup = new Set<string>();
  for (const inp of unresolvedInputs) {
    const out = outputCache.get(`${inp.prevTxid}:${inp.prevVout}`);
    if (out && out.recordId === undefined && out.address) addrsNeedingLookup.add(out.address);
  }
  const addrToRecordId = new Map<string, number>();
  const addrArr = Array.from(addrsNeedingLookup);
  for (let i = 0; i < addrArr.length; i += 500) {
    const batch = addrArr.slice(i, i + 500);
    const records = await db.records.where('inputString').anyOf(batch).toArray();
    for (const r of records) {
      if (r.id != null && r.inputString) addrToRecordId.set(r.inputString, r.id);
    }
  }

  let unattributable = 0;
  for (const inp of unresolvedInputs) {
    const out = outputCache.get(`${inp.prevTxid}:${inp.prevVout}`);
    if (!out) {
      unattributable++;
      continue;
    }
    const recordId = out.recordId ?? (out.address ? addrToRecordId.get(out.address) : undefined);
    if (recordId === undefined) {
      unattributable++;
      continue;
    }
    result.set(recordId, (result.get(recordId) ?? 0) + 1);
  }

  return { byRecordId: result, unattributable };
}

/**
 * Backward-compatible accessor returning only the per-record attribution map.
 * Prefer {@link getUnresolvedSpendBreakdown} when the unattributable count is
 * also needed.
 */
export async function getUnresolvedSpendsByRecordId(): Promise<Map<number, number>> {
  const { byRecordId } = await getUnresolvedSpendBreakdown();
  return byRecordId;
}

/**
 * Distinct source transaction ids (prevTxids) behind unattributable spends whose
 * prevout OUTPUT is not stored locally. These are exactly the transactions that,
 * once fetched and imported, make the spend's source address known — turning an
 * unattributable spend into an attributable one so balances can self-correct.
 *
 * Spends whose source output IS locally known but maps to no tracked record are
 * deliberately excluded: importing more history cannot help them (the source
 * address simply isn't one we track), so there is nothing to fetch.
 */
export async function getMissingSourceTxids(): Promise<string[]> {
  const unresolvedInputs = await db.transactionParticipants
    .where('role').equals('input')
    .filter(p => (!p.address || p.address.trim() === '') && p.prevTxid !== undefined && p.prevVout !== undefined)
    .toArray();
  if (unresolvedInputs.length === 0) return [];

  // Batch-load the local OUTPUT participants for every referenced prevTxid so we
  // can tell which prevouts are already stored locally and which are missing.
  const prevTxids = new Set<string>();
  for (const inp of unresolvedInputs) {
    if (inp.prevTxid) prevTxids.add(inp.prevTxid);
  }
  const prevTxidArr = Array.from(prevTxids);
  const localOutputKeys = new Set<string>();
  for (let i = 0; i < prevTxidArr.length; i += 500) {
    const batch = prevTxidArr.slice(i, i + 500);
    const outputs = await db.transactionParticipants
      .where('txid').anyOf(batch)
      .and(p => p.role === 'output')
      .toArray();
    for (const o of outputs) {
      if (o.vout !== undefined) localOutputKeys.add(`${o.txid}:${o.vout}`);
    }
  }

  const missing = new Set<string>();
  for (const inp of unresolvedInputs) {
    const key = `${inp.prevTxid}:${inp.prevVout}`;
    if (inp.prevTxid && !localOutputKeys.has(key)) missing.add(inp.prevTxid);
  }
  return Array.from(missing);
}

/**
 * A single missing source transaction together with the spending transactions in
 * the vault that reference it. This is the offline-user equivalent of
 * {@link getMissingSourceTxids}: rather than fetching the missing history from a
 * provider, the user is given the exact list of source txids to import manually
 * (e.g. from a wallet export), along with the spending txids that depend on each
 * one so they can locate the right transactions.
 */
export interface MissingSourceDetail {
  /** The source transaction id whose output is not stored locally. */
  sourceTxid: string;
  /** Distinct spending transaction ids that reference this source output. */
  spendingTxids: string[];
}

/**
 * Like {@link getMissingSourceTxids} but also returns, for each missing source
 * transaction, the spending txids in the vault that reference it. Useful for the
 * offline path where the user imports the missing history manually and needs a
 * concrete, copyable list of which transactions to find. Results are sorted by
 * source txid for stable display.
 */
export async function getMissingSourceTxidDetails(): Promise<MissingSourceDetail[]> {
  const unresolvedInputs = await db.transactionParticipants
    .where('role').equals('input')
    .filter(p => (!p.address || p.address.trim() === '') && p.prevTxid !== undefined && p.prevVout !== undefined)
    .toArray();
  if (unresolvedInputs.length === 0) return [];

  const prevTxids = new Set<string>();
  for (const inp of unresolvedInputs) {
    if (inp.prevTxid) prevTxids.add(inp.prevTxid);
  }
  const prevTxidArr = Array.from(prevTxids);
  const localOutputKeys = new Set<string>();
  for (let i = 0; i < prevTxidArr.length; i += 500) {
    const batch = prevTxidArr.slice(i, i + 500);
    const outputs = await db.transactionParticipants
      .where('txid').anyOf(batch)
      .and(p => p.role === 'output')
      .toArray();
    for (const o of outputs) {
      if (o.vout !== undefined) localOutputKeys.add(`${o.txid}:${o.vout}`);
    }
  }

  const spendingBySource = new Map<string, Set<string>>();
  for (const inp of unresolvedInputs) {
    if (!inp.prevTxid) continue;
    const key = `${inp.prevTxid}:${inp.prevVout}`;
    if (localOutputKeys.has(key)) continue;
    let set = spendingBySource.get(inp.prevTxid);
    if (!set) {
      set = new Set<string>();
      spendingBySource.set(inp.prevTxid, set);
    }
    if (inp.txid) set.add(inp.txid);
  }

  return Array.from(spendingBySource.entries())
    .map(([sourceTxid, spending]) => ({
      sourceTxid,
      spendingTxids: Array.from(spending).sort(),
    }))
    .sort((a, b) => (a.sourceTxid < b.sourceTxid ? -1 : a.sourceTxid > b.sourceTxid ? 1 : 0));
}

/**
 * Serialise missing source details to a pretty-printed JSON string. Pure (no DOM,
 * no DB) so it can be unit-tested and reused by the offline download action in the
 * Balance page. Shape: `{ sourceTxid, spendingTxids }[]`, identical to the
 * in-memory detail list.
 */
export function buildMissingSourceJson(details: MissingSourceDetail[]): string {
  return JSON.stringify(
    details.map((d) => ({ sourceTxid: d.sourceTxid, spendingTxids: d.spendingTxids })),
    null,
    2,
  );
}

/** Quote a CSV field if it contains a comma, quote, or newline (RFC 4180). */
function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Serialise missing source details to a CSV string with a header row. One row per
 * source transaction: the source txid plus its referencing spend txids joined by
 * a space inside a single quoted cell, so the file opens cleanly in a spreadsheet.
 * Pure (no DOM, no DB) for testability and offline reuse.
 */
export function buildMissingSourceCsv(details: MissingSourceDetail[]): string {
  const lines = ["source_txid,referencing_spend_txids"];
  for (const d of details) {
    lines.push(`${csvEscape(d.sourceTxid)},${csvEscape(d.spendingTxids.join(" "))}`);
  }
  return lines.join("\r\n");
}

// =============================================================================
// FRESHNESS FINGERPRINTS — compared against the native engine mirror before a
// read is served from the engine. All reads below are index-only (count + the
// last row of an ordered index), never full table scans, so the gate stays cheap
// even on multi-million-row vaults.
// =============================================================================

/**
 * Freshness fingerprint for the live `blockchainTransactions` table — total
 * count, max id, and max blockTime. Owned-UTXO reads JOIN this table and exclude
 * blockTime <= 0, so a mismatch in any field means the mirror cannot be trusted:
 * count/maxId catch inserts and deletes; maxBlockTime catches an unconfirmed tx
 * confirming in place (its new block time becomes the max).
 */
export async function getTransactionsFingerprint(): Promise<{
  count: number;
  maxId: number;
  maxBlockTime: number;
}> {
  const [count, newestById, newestByBlockTime] = await Promise.all([
    db.blockchainTransactions.count(),
    db.blockchainTransactions.orderBy('id').last(),
    db.blockchainTransactions.orderBy('blockTime').last(),
  ]);
  return {
    count,
    maxId: newestById?.id ?? 0,
    maxBlockTime: newestByBlockTime?.blockTime ?? 0,
  };
}

/**
 * Freshness fingerprint for the live `transactionParticipants` table — total
 * count, max id, and the count of inputs with a resolved prevout. The owned-UTXO
 * anti-join detects spends via (prevTxid, prevVout), which prevout backfill fills
 * IN PLACE — so count/maxId alone miss it. The `[prevTxid+prevVout]` compound
 * index only contains rows where both keys are defined, so counting it yields the
 * resolved-input count, matching the engine's `prevTxid IS NOT NULL AND prevVout
 * IS NOT NULL` count, and moves whenever backfill resolves more inputs.
 */
export async function getParticipantsFingerprint(): Promise<{
  count: number;
  maxId: number;
  resolvedPrevoutCount: number;
}> {
  const [count, newestById, resolvedPrevoutCount] = await Promise.all([
    db.transactionParticipants.count(),
    db.transactionParticipants.orderBy('id').last(),
    db.transactionParticipants.orderBy('[prevTxid+prevVout]').count(),
  ]);
  return {
    count,
    maxId: newestById?.id ?? 0,
    resolvedPrevoutCount,
  };
}

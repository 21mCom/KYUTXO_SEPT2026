/**
 * Fund Trail Engine — read-only, offline-first
 *
 * Resolves any Bitcoin address to its "entity group" label (Wallet / Owner / Seed)
 * and computes one-hop incoming/outgoing fund flows between groups, suitable for
 * lazy expansion in the Fund Trail page.
 *
 * Attribution strategy:
 *   1. Prefer precise UTXO-level lineage links from utxoLineage (exact input→output
 *      amounts for transactions where lineage has been computed).
 *   2. Fall back to participant-level aggregation for txids not covered by lineage.
 *
 * No writes are performed anywhere in this module (CRUD-guard compliant).
 */

import { db } from '../database';
import type { Record as DbRecord, TransactionParticipant, UtxoLineage } from '../database';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GroupingDimension = 'walletName' | 'owner' | 'seedName';

export const UNKNOWN_SOURCE_LABEL = 'Unknown Source';
export const UNKNOWN_DEST_LABEL = 'Unknown Destination';

export interface GroupFlowDetail {
  address: string;
  txid: string;
  amount: number;
  blockTime: number;
  recordId?: number;
}

export interface GroupFlow {
  groupLabel: string;
  dimension: GroupingDimension;
  totalSats: number;
  details: GroupFlowDetail[];
  isUnknown: boolean;
  /** Addresses that can be used to expand this unknown group (populated only for isUnknown=true) */
  unknownAddresses?: string[];
}

export interface TrailHop {
  sources: GroupFlow[];
  destinations: GroupFlow[];
  /** True when the result was capped to the most recent N transactions for performance */
  isCapped?: boolean;
  /** Number of transactions actually processed (after any cap) */
  shownTxCount?: number;
  /** Total number of transactions that touched the group's addresses */
  totalTxCount?: number;
}

/**
 * Default cap on the number of transactions computeOneHop will fully process.
 * When a group's addresses touch more txids than this, only the most recent
 * `txLimit` (by blockTime, descending) are loaded to keep the browser responsive.
 */
export const DEFAULT_TX_LIMIT = 2000;

export interface ComputeOneHopOptions {
  /** Max number of (most-recent) txids to process; defaults to DEFAULT_TX_LIMIT */
  txLimit?: number;
}

/**
 * Optional date-range filter for fund-trail computation.
 * Both bounds are Unix timestamps in seconds (matching blockTime). Either may
 * be omitted for an open-ended window; `undefined`/no range means "all time".
 */
export interface DateRange {
  start?: number;
  end?: number;
}

/**
 * Returns true when the given blockTime falls within the (inclusive) range.
 * A flow detail with an unknown blockTime (0/falsy) is excluded whenever a
 * range is active, since it cannot be confidently placed inside the window.
 */
function isBlockTimeInRange(blockTime: number, range?: DateRange): boolean {
  if (!range || (range.start == null && range.end == null)) return true;
  if (!blockTime) return false;
  if (range.start != null && blockTime < range.start) return false;
  if (range.end != null && blockTime > range.end) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Entity grouping helpers
// ---------------------------------------------------------------------------

/**
 * Returns records matching any address in the set, keyed by inputString.
 * Uses the address index for O(1) Dexie lookups in batches.
 */
async function getRecordsByAddresses(
  addresses: string[]
): Promise<Map<string, DbRecord>> {
  const result = new Map<string, DbRecord>();
  if (addresses.length === 0) return result;

  const batchSize = 500;
  for (let i = 0; i < addresses.length; i += batchSize) {
    const batch = addresses.slice(i, i + batchSize);
    const records = await db.records
      .where('inputString')
      .anyOf(batch)
      .toArray();
    for (const r of records) {
      if (r.inputString && !result.has(r.inputString)) {
        result.set(r.inputString, r);
      }
    }
  }
  return result;
}

/**
 * Given a record and a grouping dimension, returns the group label or null
 * if the record has no value for that dimension.
 */
export function getGroupLabel(
  record: DbRecord | undefined,
  dimension: GroupingDimension
): string | null {
  if (!record) return null;
  const val = record[dimension];
  return val && val.trim() ? val.trim() : null;
}

/**
 * Lists all known group values (sorted, deduplicated) for the given dimension.
 */
export async function listGroupValues(
  dimension: GroupingDimension
): Promise<string[]> {
  const records = await db.records.toArray();
  const seen = new Set<string>();
  for (const r of records) {
    const val = r[dimension];
    if (val && val.trim()) seen.add(val.trim());
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b));
}

/**
 * Returns all address records belonging to a given group value on the given dimension.
 */
export async function getAddressesForGroup(
  dimension: GroupingDimension,
  groupValue: string
): Promise<DbRecord[]> {
  return db.records.where(dimension).equals(groupValue).toArray();
}

// ---------------------------------------------------------------------------
// Trail computation — one hop in both directions
// ---------------------------------------------------------------------------

/**
 * Computes one-hop incoming (sources) and outgoing (destinations) fund flows
 * for the given set of addresses.
 *
 * Attribution strategy:
 *   - For any transaction covered by utxoLineage, use lineage rows for precise
 *     input→output attribution (which tells us exact amounts per UTXO).
 *   - For txids NOT covered by lineage, fall back to participant-level aggregation.
 *
 * The caller should pass a `visitedLabels` set to guard against cycles when
 * walking outward from a hop.
 */
export async function computeOneHop(
  groupAddresses: string[],
  dimension: GroupingDimension,
  selfGroupLabel: string | null,
  dateRange?: DateRange,
  signal?: AbortSignal,
  options?: ComputeOneHopOptions
): Promise<TrailHop> {
  if (groupAddresses.length === 0) {
    return { sources: [], destinations: [], isCapped: false, shownTxCount: 0, totalTxCount: 0 };
  }

  const addrSet = new Set(groupAddresses);

  // -------------------------------------------------------------------------
  // Step 1: Lineage-based attribution
  // -------------------------------------------------------------------------

  // Incoming via lineage: rows where createdAddress ∈ our addresses
  let incomingLineage = await batchedLineageByAddress(groupAddresses, 'created', signal);
  // Outgoing via lineage: rows where spentAddress ∈ our addresses
  let outgoingLineage = await batchedLineageByAddress(groupAddresses, 'spent', signal);

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  // Txids already covered by lineage (won't need participant fallback for these)
  const incomingCoveredTxids = new Set(incomingLineage.map(l => l.consumingTxid));
  const outgoingCoveredTxids = new Set(outgoingLineage.map(l => l.consumingTxid));

  // -------------------------------------------------------------------------
  // Step 2: Participant-based fallback for txids not covered by lineage
  // -------------------------------------------------------------------------

  // Find txids involving our addresses from the participant table
  const allParticipants = await batchedParticipantsByAddresses(groupAddresses, signal);

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  // txids where we are an output (incoming)
  let incomingTxidsFromParticipants = new Set<string>();
  // txids where we are an input (outgoing)
  let outgoingTxidsFromParticipants = new Set<string>();

  for (const p of allParticipants) {
    if (p.role === 'output' && addrSet.has(p.address) && !incomingCoveredTxids.has(p.txid)) {
      incomingTxidsFromParticipants.add(p.txid);
    }
    if (p.role === 'input' && addrSet.has(p.address) && !outgoingCoveredTxids.has(p.txid)) {
      outgoingTxidsFromParticipants.add(p.txid);
    }
  }

  // -------------------------------------------------------------------------
  // Step 2.5: Cap workload to the most recent N txids on busy wallets
  // -------------------------------------------------------------------------
  // An exchange-style wallet can touch hundreds of thousands of participant
  // rows. Resolve blockTimes up front so we can rank candidate txids by recency
  // and, when the count exceeds the limit, only fully process the newest ones.
  const candidateTxids = new Set<string>([
    ...incomingCoveredTxids,
    ...outgoingCoveredTxids,
    ...incomingTxidsFromParticipants,
    ...outgoingTxidsFromParticipants,
  ]);
  const totalTxCount = candidateTxids.size;
  const txLimit = options?.txLimit ?? DEFAULT_TX_LIMIT;

  const blockTimes = await loadBlockTimes([...candidateTxids]);
  // Lineage rows carry their own blockTime; backfill any txid the
  // blockchainTransactions lookup didn't cover so ranking stays accurate.
  for (const l of incomingLineage) {
    if (!blockTimes.has(l.consumingTxid)) blockTimes.set(l.consumingTxid, l.blockTime);
  }
  for (const l of outgoingLineage) {
    if (!blockTimes.has(l.consumingTxid)) blockTimes.set(l.consumingTxid, l.blockTime);
  }

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  let isCapped = false;
  let shownTxCount = totalTxCount;
  if (totalTxCount > txLimit) {
    isCapped = true;
    const keptTxids = new Set(
      [...candidateTxids]
        .sort((a, b) => (blockTimes.get(b) ?? 0) - (blockTimes.get(a) ?? 0))
        .slice(0, txLimit)
    );
    shownTxCount = keptTxids.size;
    incomingLineage = incomingLineage.filter(l => keptTxids.has(l.consumingTxid));
    outgoingLineage = outgoingLineage.filter(l => keptTxids.has(l.consumingTxid));
    incomingTxidsFromParticipants = new Set(
      [...incomingTxidsFromParticipants].filter(t => keptTxids.has(t))
    );
    outgoingTxidsFromParticipants = new Set(
      [...outgoingTxidsFromParticipants].filter(t => keptTxids.has(t))
    );
  }

  const fallbackIncomingParticipants = incomingTxidsFromParticipants.size > 0
    ? await batchedParticipantsByTxids([...incomingTxidsFromParticipants], signal)
    : [];
  const fallbackOutgoingParticipants = outgoingTxidsFromParticipants.size > 0
    ? await batchedParticipantsByTxids([...outgoingTxidsFromParticipants], signal)
    : [];

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  // -------------------------------------------------------------------------
  // Step 3: Resolve group labels for all external addresses
  // -------------------------------------------------------------------------

  const externalAddresses = new Set<string>();

  // From lineage
  for (const l of incomingLineage) {
    if (!addrSet.has(l.spentAddress)) externalAddresses.add(l.spentAddress);
  }
  for (const l of outgoingLineage) {
    if (!addrSet.has(l.createdAddress)) externalAddresses.add(l.createdAddress);
  }

  // From participants
  for (const p of fallbackIncomingParticipants) {
    if (p.role === 'input' && !addrSet.has(p.address)) externalAddresses.add(p.address);
  }
  for (const p of fallbackOutgoingParticipants) {
    if (p.role === 'output' && !addrSet.has(p.address)) externalAddresses.add(p.address);
  }

  const recordsByAddr = await getRecordsByAddresses([...externalAddresses]);

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  // -------------------------------------------------------------------------
  // Step 4: Build source map (INCOMING)
  // -------------------------------------------------------------------------

  const sourceMap = new Map<string, GroupFlow>();

  // 4a: From lineage rows
  for (const l of incomingLineage) {
    if (addrSet.has(l.spentAddress)) continue; // same group

    const record = recordsByAddr.get(l.spentAddress);
    const label = getGroupLabel(record, dimension);

    // If same group as self, treat as internal movement
    if (label && selfGroupLabel && label === selfGroupLabel) continue;

    const detailBlockTime = blockTimes.get(l.consumingTxid) ?? l.blockTime;
    if (!isBlockTimeInRange(detailBlockTime, dateRange)) continue;

    const groupKey = label ?? UNKNOWN_SOURCE_LABEL;
    ensureFlow(sourceMap, groupKey, dimension, !label);
    const flow = sourceMap.get(groupKey)!;
    flow.totalSats += l.spentAmount;
    flow.details.push({
      address: l.spentAddress,
      txid: l.consumingTxid,
      amount: l.spentAmount,
      blockTime: detailBlockTime,
      recordId: record?.id,
    });
    if (!label) {
      flow.unknownAddresses = flow.unknownAddresses ?? [];
      if (!flow.unknownAddresses.includes(l.spentAddress)) {
        flow.unknownAddresses.push(l.spentAddress);
      }
    }
  }

  // 4b: From participant fallback (grouped by txid)
  const incomingTxParts = groupByTxid(fallbackIncomingParticipants);
  for (const [txid, txParts] of incomingTxParts) {
    const isIncoming = txParts.some(p => p.role === 'output' && addrSet.has(p.address));
    if (!isIncoming) continue;

    const inputs = txParts.filter(p => p.role === 'input');
    for (const inp of inputs) {
      if (addrSet.has(inp.address)) continue;

      const record = recordsByAddr.get(inp.address);
      const label = getGroupLabel(record, dimension);
      if (label && selfGroupLabel && label === selfGroupLabel) continue;

      const detailBlockTime = blockTimes.get(txid) ?? 0;
      if (!isBlockTimeInRange(detailBlockTime, dateRange)) continue;

      const groupKey = label ?? UNKNOWN_SOURCE_LABEL;
      ensureFlow(sourceMap, groupKey, dimension, !label);
      const flow = sourceMap.get(groupKey)!;
      flow.totalSats += inp.amount;
      flow.details.push({
        address: inp.address,
        txid,
        amount: inp.amount,
        blockTime: detailBlockTime,
        recordId: record?.id,
      });
      if (!label) {
        flow.unknownAddresses = flow.unknownAddresses ?? [];
        if (!flow.unknownAddresses.includes(inp.address)) {
          flow.unknownAddresses.push(inp.address);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 5: Build destination map (OUTGOING)
  // -------------------------------------------------------------------------

  const destMap = new Map<string, GroupFlow>();

  // 5a: From lineage rows
  for (const l of outgoingLineage) {
    if (addrSet.has(l.createdAddress)) continue; // change back to same group

    const record = recordsByAddr.get(l.createdAddress);
    const label = getGroupLabel(record, dimension);
    if (label && selfGroupLabel && label === selfGroupLabel) continue;

    const detailBlockTime = blockTimes.get(l.consumingTxid) ?? l.blockTime;
    if (!isBlockTimeInRange(detailBlockTime, dateRange)) continue;

    const groupKey = label ?? UNKNOWN_DEST_LABEL;
    ensureFlow(destMap, groupKey, dimension, !label);
    const flow = destMap.get(groupKey)!;
    flow.totalSats += l.createdAmount;
    flow.details.push({
      address: l.createdAddress,
      txid: l.consumingTxid,
      amount: l.createdAmount,
      blockTime: detailBlockTime,
      recordId: record?.id,
    });
    if (!label) {
      flow.unknownAddresses = flow.unknownAddresses ?? [];
      if (!flow.unknownAddresses.includes(l.createdAddress)) {
        flow.unknownAddresses.push(l.createdAddress);
      }
    }
  }

  // 5b: From participant fallback
  const outgoingTxParts = groupByTxid(fallbackOutgoingParticipants);
  for (const [txid, txParts] of outgoingTxParts) {
    const isOutgoing = txParts.some(p => p.role === 'input' && addrSet.has(p.address));
    if (!isOutgoing) continue;

    const outputs = txParts.filter(p => p.role === 'output');
    for (const out of outputs) {
      if (addrSet.has(out.address)) continue;

      const record = recordsByAddr.get(out.address);
      const label = getGroupLabel(record, dimension);
      if (label && selfGroupLabel && label === selfGroupLabel) continue;

      const detailBlockTime = blockTimes.get(txid) ?? 0;
      if (!isBlockTimeInRange(detailBlockTime, dateRange)) continue;

      const groupKey = label ?? UNKNOWN_DEST_LABEL;
      ensureFlow(destMap, groupKey, dimension, !label);
      const flow = destMap.get(groupKey)!;
      flow.totalSats += out.amount;
      flow.details.push({
        address: out.address,
        txid,
        amount: out.amount,
        blockTime: detailBlockTime,
        recordId: record?.id,
      });
      if (!label) {
        flow.unknownAddresses = flow.unknownAddresses ?? [];
        if (!flow.unknownAddresses.includes(out.address)) {
          flow.unknownAddresses.push(out.address);
        }
      }
    }
  }

  return {
    sources: sortFlows([...sourceMap.values()]),
    destinations: sortFlows([...destMap.values()]),
    isCapped,
    shownTxCount,
    totalTxCount,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function ensureFlow(
  map: Map<string, GroupFlow>,
  key: string,
  dimension: GroupingDimension,
  isUnknown: boolean
): void {
  if (!map.has(key)) {
    map.set(key, {
      groupLabel: key,
      dimension,
      totalSats: 0,
      details: [],
      isUnknown,
    });
  }
}

function groupByTxid(
  parts: TransactionParticipant[]
): Map<string, TransactionParticipant[]> {
  const map = new Map<string, TransactionParticipant[]>();
  for (const p of parts) {
    if (!map.has(p.txid)) map.set(p.txid, []);
    map.get(p.txid)!.push(p);
  }
  return map;
}

async function batchedLineageByAddress(
  addresses: string[],
  role: 'created' | 'spent',
  signal?: AbortSignal
): Promise<UtxoLineage[]> {
  if (addresses.length === 0) return [];
  const results: UtxoLineage[] = [];
  const indexField = role === 'created' ? 'createdAddress' : 'spentAddress';
  const batchSize = 500;

  for (let i = 0; i < addresses.length; i += batchSize) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const batch = addresses.slice(i, i + batchSize);
    const rows = await db.utxoLineage.where(indexField).anyOf(batch).toArray();
    results.push(...rows);
    if (i + batchSize < addresses.length) {
      await new Promise(r => setTimeout(r, 0));
    }
  }
  return results;
}

async function batchedParticipantsByAddresses(
  addresses: string[],
  signal?: AbortSignal
): Promise<TransactionParticipant[]> {
  if (addresses.length === 0) return [];
  const results: TransactionParticipant[] = [];
  const batchSize = 500;
  for (let i = 0; i < addresses.length; i += batchSize) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const batch = addresses.slice(i, i + batchSize);
    const raw = await db.transactionParticipants.where('address').anyOf(batch).toArray();
    results.push(...raw);
    if (i + batchSize < addresses.length) {
      await new Promise(r => setTimeout(r, 0));
    }
  }
  return results;
}

async function batchedParticipantsByTxids(
  txids: string[],
  signal?: AbortSignal
): Promise<TransactionParticipant[]> {
  if (txids.length === 0) return [];
  const results: TransactionParticipant[] = [];
  const batchSize = 500;
  for (let i = 0; i < txids.length; i += batchSize) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const batch = txids.slice(i, i + batchSize);
    const raw = await db.transactionParticipants.where('txid').anyOf(batch).toArray();
    results.push(...raw);
    if (i + batchSize < txids.length) {
      await new Promise(r => setTimeout(r, 0));
    }
  }
  return results;
}

async function loadBlockTimes(txids: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (txids.length === 0) return result;
  const batchSize = 500;
  for (let i = 0; i < txids.length; i += batchSize) {
    const batch = txids.slice(i, i + batchSize);
    const txRows = await db.blockchainTransactions.where('txid').anyOf(batch).toArray();
    for (const tx of txRows) {
      result.set(tx.txid, tx.blockTime);
    }
  }
  return result;
}

/** Sort flows: known groups by descending amount, then unknowns */
function sortFlows(flows: GroupFlow[]): GroupFlow[] {
  const known = flows.filter(f => !f.isUnknown).sort((a, b) => b.totalSats - a.totalSats);
  const unknown = flows.filter(f => f.isUnknown).sort((a, b) => b.totalSats - a.totalSats);
  return [...known, ...unknown];
}

// ---------------------------------------------------------------------------
// Public utilities
// ---------------------------------------------------------------------------

/** Format satoshis as a human-readable BTC string */
export function formatBtc(sats: number): string {
  return (sats / 1e8).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8,
  }) + ' BTC';
}

/** Format a Unix timestamp as a short date string */
export function formatDate(blockTime: number): string {
  if (!blockTime) return '—';
  return new Date(blockTime * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Deduplicate flow details by address+txid pair.
 */
export function deduplicateDetails(
  details: GroupFlowDetail[]
): GroupFlowDetail[] {
  const seen = new Set<string>();
  const result: GroupFlowDetail[] = [];
  for (const d of details) {
    const key = `${d.address}:${d.txid}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(d);
    }
  }
  return result;
}

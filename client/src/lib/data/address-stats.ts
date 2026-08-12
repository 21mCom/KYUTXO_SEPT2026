import Dexie from 'dexie';
import { db, notifyDbChange, type TransactionParticipant } from '../database';
import { getSpendInputsByOutpoints } from './record-queries';
import { bulkUpdateAddressStats, type AddressStatsCacheValues } from './record-crud';
import { getSettings, updateSettings } from './settings-crud';
import {
  behaviorLabelFromCachedStats,
  emptyBehaviorTally,
  type BehaviorTallyCounts,
} from '../behavior-profile';

/**
 * Local-only per-address stats recompute.
 *
 * Everything here is a pure read of transaction data already stored in
 * IndexedDB (participant rows + cached transaction block times). NOTHING in this
 * module ever contacts the node, Electrum, or any network source. It is used for:
 *   - the one-time backfill of existing data,
 *   - the manual "recompute stats" lever,
 *   - post-deletion corrections (e.g. after Database Cleanup),
 *   - and (via transaction-sync) updating stats for addresses a sync touched.
 */

export interface RecomputeProgress {
  processed: number;
  total: number;
}

export interface RecomputeOptions {
  /** Specific address strings to recompute. */
  addresses?: string[];
  /** Specific address record ids to recompute. Overrides `addresses` filtering. */
  recordIds?: number[];
  signal?: AbortSignal;
  onProgress?: (p: RecomputeProgress) => void;
  /** Notification origin tag for the resulting db-change pulse. */
  origin?: 'user' | 'blockchain-sync' | string;
  /** Batch size for processing address records. */
  batchSize?: number;
  /** Suppress the final db-change notification (caller will notify itself). */
  skipNotification?: boolean;
}

export interface RecomputeResult {
  updated: number;
  cancelled: boolean;
}

/** A single synced address whose cached balance disagrees with a fresh compute. */
export interface StaleAddressDetail {
  /** The address record's id, for linking to the Records page. */
  recordId: number;
  /** The address string. */
  address: string;
  /** The currently cached balance (sats). */
  cachedSats: number;
  /** The freshly computed balance (sats). */
  computedSats: number;
}

export interface StaleBalanceCheckResult {
  /** Number of synced address records sampled. */
  sampled: number;
  /** Number of those where cachedBalanceSats differs from a fresh compute. */
  staleCount: number;
  /**
   * Details of the mismatched addresses, collected when `collectDetails` is set.
   * Capped at `detailLimit` entries (the running `staleCount` is always exact).
   * When `onStaleBatch` is supplied the details are streamed to the caller
   * instead of accumulated here, so this array stays empty (the caller owns the
   * full set) and the check itself never holds every stale address in memory.
   */
  staleAddresses: StaleAddressDetail[];
  /** Whether the entire address table was scanned (no sampleLimit cap). */
  checkedAll: boolean;
  cancelled: boolean;
}

/**
 * Sample synced address records and count how many have a cached balance that
 * disagrees with a freshly computed value. Only considers addresses that have
 * been synced (have a statsComputedAt timestamp). By default it stops after
 * `sampleLimit` addresses to keep the check fast on large vaults; pass
 * `checkAll: true` to scan every synced address with no cap.
 *
 * This is an on-demand diagnostic; it should NOT run automatically on page
 * load. Callers are responsible for aborting and reporting progress.
 */
export async function detectStaleCachedBalances(opts: {
  sampleLimit?: number;
  signal?: AbortSignal;
  /**
   * Progress callback. `total`, when known (only in `checkAll` mode), is the
   * total number of address records the scan will page through.
   */
  onProgress?: (sampled: number, total?: number) => void;
  /** Collect details of each mismatched address into `staleAddresses`. */
  collectDetails?: boolean;
  /** Maximum number of detail entries to collect (default 5000). */
  detailLimit?: number;
  /**
   * Scan the entire address table instead of stopping at `sampleLimit`, and
   * collect every stale detail regardless of `detailLimit`. Intended for the
   * "Check all addresses" lever on very large vaults.
   */
  checkAll?: boolean;
  /**
   * Stream batches of newly-found stale addresses as the scan progresses. When
   * provided, details are handed off incrementally rather than accumulated in
   * the returned `staleAddresses`, so a full-table scan never retains the whole
   * stale set inside this function. May return a promise; the scan awaits it,
   * which lets callers spool each batch to durable storage with backpressure
   * before the next batch is gathered.
   */
  onStaleBatch?: (batch: StaleAddressDetail[]) => void | Promise<void>;
}): Promise<StaleBalanceCheckResult> {
  const checkAll = opts.checkAll ?? false;
  const limit = checkAll ? Infinity : (opts.sampleLimit ?? 2000);
  const detailLimit = checkAll ? Infinity : (opts.detailLimit ?? 5000);
  const streaming = !!opts.onStaleBatch;
  let sampled = 0;
  let staleCount = 0;
  let lastId = 0;
  const BATCH = 200;
  const staleAddresses: StaleAddressDetail[] = [];

  // In full-table mode, report a denominator so callers can show real progress.
  let total: number | undefined;
  if (checkAll) {
    total = await db.records.where('type').equals('address').count();
  }

  while (sampled < limit) {
    if (isAborted(opts.signal)) return { sampled, staleCount, staleAddresses, checkedAll: checkAll, cancelled: true };

    const batch = await db.records
      .where('[type+id]')
      .between(['address', lastId], ['address', Dexie.maxKey], false, true)
      .limit(BATCH)
      .toArray();

    if (batch.length === 0) break;
    lastId = batch[batch.length - 1].id!;

    // Only check addresses that have been synced (statsComputedAt set)
    const synced = batch.filter(r => r.statsComputedAt != null && r.inputString && r.id != null);
    if (synced.length === 0) {
      if (batch.length < BATCH) break;
      // On large vaults many records are unsynced, so a full 200-record page can
      // map to zero sampling work. Without a yield here, a long run of such
      // pages would loop tightly and starve the UI. We still don't report
      // progress (the running `sampled` count hasn't moved), but we hand control
      // back to the event loop between pages just like a sampled batch does.
      await yieldToEventLoop();
      continue;
    }

    const addresses = synced.map(r => r.inputString);
    const freshStats = await computeStatsForAddresses(addresses, opts.signal);

    // The participant/blocktime joins above are the heaviest part of a dense
    // page. On a page packed with synced rows, hand control back to the UI
    // before the per-row comparison loop so that work alone can't block the
    // event loop between the once-per-page yields below.
    if (synced.length >= ROW_YIELD_INTERVAL) await yieldToEventLoop();

    const batchStale: StaleAddressDetail[] = [];
    let rowsSinceYield = 0;
    for (const rec of synced) {
      const fresh = freshStats.get(rec.inputString);
      const freshBalance = fresh?.balanceSats ?? 0;
      const cached = rec.cachedBalanceSats ?? 0;
      if (cached !== freshBalance) {
        staleCount++;
        if (opts.collectDetails) {
          const detail: StaleAddressDetail = {
            recordId: rec.id!,
            address: rec.inputString,
            cachedSats: cached,
            computedSats: freshBalance,
          };
          if (streaming) {
            batchStale.push(detail);
          } else if (staleAddresses.length < detailLimit) {
            staleAddresses.push(detail);
          }
        }
      }
      sampled++;
      if (sampled >= limit) break;
      // For very dense synced pages, also yield periodically within the loop so
      // the comparison work itself can't monopolise the event loop between the
      // once-per-page yields.
      if (++rowsSinceYield >= ROW_YIELD_INTERVAL) {
        rowsSinceYield = 0;
        await yieldToEventLoop();
      }
    }

    if (streaming && batchStale.length > 0) await opts.onStaleBatch!(batchStale);

    opts.onProgress?.(sampled, total);
    await yieldToEventLoop();
    if (batch.length < BATCH || sampled >= limit) break;
  }

  return { sampled, staleCount, staleAddresses, checkedAll: checkAll, cancelled: isAborted(opts.signal) };
}

interface AddressAgg {
  outputSats: number;
  inputSats: number;
  lastTxTime: number;
  txids: Set<string>;
  outputs: TransactionParticipant[];
  inputs: TransactionParticipant[];
}

function isAborted(signal?: AbortSignal): boolean {
  return !!signal?.aborted;
}

/** Hand control back to the event loop so the UI can paint/respond. */
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Within a single sampling page, yield to the UI after the heavy participant
 * fetch and again every this-many rows of the mismatch comparison loop, so a
 * page densely packed with synced rows can't block the event loop between the
 * once-per-page yields.
 */
const ROW_YIELD_INTERVAL = 50;

/**
 * Compute the count and summed value of unspent outputs for a single address.
 *
 * Two modes (same as BalanceOverview's UTXO logic):
 *   - Exact mode (the address has at least one input carrying prevout data):
 *     an output is unspent unless its outpoint (txid:vout) is referenced by one
 *     of this address's inputs.
 *   - Heuristic mode (no prevout data): pair each output with a later input of
 *     the same amount (FIFO by block time); unmatched outputs are unspent.
 * Outputs whose transaction has no known block time (unconfirmed/missing) are
 * ignored. The returned `balanceSats` is always >= 0 (a sum of output amounts
 * can never be negative).
 *
 * HEURISTIC-MODE LIMITATION (coinjoin / batch transactions):
 * The FIFO same-amount pairing is only a guess. It is correct for ordinary
 * wallet activity, but it can mis-pair when a single address has MULTIPLE
 * outputs of the SAME value — exactly the shape coinjoins and batched payouts
 * produce. In that case any same-value later input is paired against the
 * earliest unmatched output regardless of which output was truly spent, so an
 * output that is actually still unspent can be marked spent (and vice-versa).
 * The result is an inflated or deflated UTXO count and balance for that address.
 * This branch only runs for addresses synced BEFORE prevout data was collected;
 * the exact branch above (and the native read-engine's prevout anti-join) are
 * not affected. Re-syncing such an address collects prevout data and promotes it
 * to exact mode, which is the correct fix. `countHeuristicMatchedAddresses`
 * counts how many addresses are still on this fallback so the Balance page can
 * nudge the user to re-sync them.
 */
function computeUtxoStatsForAddress(
  outputs: TransactionParticipant[],
  inputs: TransactionParticipant[],
  blockTimeOf: (txid: string) => number,
): { count: number; balanceSats: number } {
  const spentOutpoints = new Set<string>();
  for (const inp of inputs) {
    if (inp.prevTxid !== undefined && inp.prevVout !== undefined) {
      spentOutpoints.add(`${inp.prevTxid}:${inp.prevVout}`);
    }
  }

  const hasExactData = spentOutpoints.size > 0;
  if (hasExactData) {
    let count = 0;
    let balanceSats = 0;
    for (const output of outputs) {
      if ((blockTimeOf(output.txid) || 0) <= 0) continue;
      const outpoint = `${output.txid}:${output.vout ?? 0}`;
      if (spentOutpoints.has(outpoint)) continue;
      count += 1;
      balanceSats += output.amount;
    }
    return { count, balanceSats };
  }

  const outputsWithTime = outputs
    .map(output => ({ output, blockTime: blockTimeOf(output.txid) || 0 }))
    .filter(o => o.blockTime > 0)
    .sort((a, b) => a.blockTime - b.blockTime);

  const inputsByAmount = new Map<number, number[]>();
  for (const input of inputs) {
    const blockTime = blockTimeOf(input.txid) || 0;
    if (blockTime <= 0) continue;
    const arr = inputsByAmount.get(input.amount) || [];
    arr.push(blockTime);
    inputsByAmount.set(input.amount, arr);
  }
  inputsByAmount.forEach(arr => arr.sort((a, b) => a - b));

  const matchedIndex = new Map<number, number>();
  let count = 0;
  let balanceSats = 0;
  for (const { output, blockTime } of outputsWithTime) {
    const candidates = inputsByAmount.get(output.amount) || [];
    const start = matchedIndex.get(output.amount) || 0;
    let spendIdx = -1;
    for (let i = start; i < candidates.length; i++) {
      if (candidates[i] > blockTime) { spendIdx = i; break; }
    }
    if (spendIdx >= 0) {
      matchedIndex.set(output.amount, spendIdx + 1);
    } else {
      count += 1;
      balanceSats += output.amount;
    }
  }
  return { count, balanceSats };
}

/**
 * Count the unspent outputs (UTXOs) currently held by a single address from its
 * own output/input participant rows. Delegates to `computeUtxoStatsForAddress`;
 * use that function directly when you also need the unspent balance sum.
 */
export function computeUtxoCountForAddress(
  outputs: TransactionParticipant[],
  inputs: TransactionParticipant[],
  blockTimeOf: (txid: string) => number,
): number {
  return computeUtxoStatsForAddress(outputs, inputs, blockTimeOf).count;
}

/**
 * Count tracked addresses whose UTXO stats are still computed with the FIFO
 * heuristic rather than exact prevout matching. An address is "heuristic" when
 * it has spent (has input participants attributed to it) but NONE of those
 * inputs carry prevout data (`prevTxid`/`prevVout`) — the exact condition under
 * which `computeUtxoStatsForAddress` falls back to same-amount FIFO pairing,
 * which can mis-pair coinjoin/batch outputs and over- or under-state a balance.
 *
 * Receive-only addresses (no spends) are never counted: with no inputs there is
 * nothing to mis-pair. Blank-address inputs (unresolved spends, surfaced by the
 * separate "unattributed spends" warning) are ignored here.
 *
 * Pure local read over the `input`-role participant rows; never touches the
 * network. Streams a single cursor and holds only one boolean per distinct
 * spent address, so memory stays bounded by the number of spent addresses.
 */
export async function countHeuristicMatchedAddresses(signal?: AbortSignal): Promise<number> {
  const hasPrevoutByAddress = await buildHasPrevoutByAddress(signal);
  if (isAborted(signal)) return 0;

  let count = 0;
  hasPrevoutByAddress.forEach((hasPrevout) => {
    if (!hasPrevout) count += 1;
  });
  return count;
}

/**
 * Return the address strings still computed with the FIFO heuristic (the same
 * set `countHeuristicMatchedAddresses` counts). Used by the Balance page's
 * heuristic-mode banner so the user can re-sync exactly those addresses in one
 * action, promoting each to exact prevout matching. Pure local read; never
 * touches the network.
 */
export async function getHeuristicMatchedAddresses(signal?: AbortSignal): Promise<string[]> {
  const hasPrevoutByAddress = await buildHasPrevoutByAddress(signal);
  if (isAborted(signal)) return [];

  const addresses: string[] = [];
  hasPrevoutByAddress.forEach((hasPrevout, address) => {
    if (!hasPrevout) addresses.push(address);
  });
  return addresses;
}

/**
 * Scan the `input`-role participant rows once and build a map of
 * address -> whether ANY of its inputs carried prevout data. An address mapped
 * to `false` has spent but has no exact prevout data, so its UTXO stats fall
 * back to FIFO same-amount pairing (the heuristic). Blank-address inputs
 * (unresolved spends) are ignored. Memory stays bounded by the number of
 * distinct spent addresses.
 */
async function buildHasPrevoutByAddress(signal?: AbortSignal): Promise<Map<string, boolean>> {
  const hasPrevoutByAddress = new Map<string, boolean>();
  await db.transactionParticipants
    .where('role').equals('input')
    .each((p) => {
      const addr = p.address?.trim();
      if (!addr) return;
      const thisHasPrevout = p.prevTxid !== undefined && p.prevVout !== undefined;
      const prior = hasPrevoutByAddress.get(addr);
      if (prior === undefined) {
        hasPrevoutByAddress.set(addr, thisHasPrevout);
      } else if (thisHasPrevout && !prior) {
        hasPrevoutByAddress.set(addr, true);
      }
    });
  return hasPrevoutByAddress;
}

async function loadBlockTimes(txids: string[]): Promise<Map<string, number>> {
  const txMap = new Map<string, number>();
  for (let i = 0; i < txids.length; i += 500) {
    const batch = txids.slice(i, i + 500);
    const txs = await db.blockchainTransactions.where('txid').anyOf(batch).toArray();
    for (const tx of txs) {
      txMap.set(tx.txid, tx.blockTime);
    }
  }
  return txMap;
}

/**
 * Compute stats for a set of address strings from locally-stored participant
 * rows. Returns a map keyed by address string. Addresses with no participants
 * are simply absent from the returned map.
 */
export async function computeStatsForAddresses(
  addresses: string[],
  signal?: AbortSignal
): Promise<Map<string, { balanceSats: number; lastActivityTime: number; txCount: number; utxoCount: number }>> {
  const out = new Map<string, { balanceSats: number; lastActivityTime: number; txCount: number; utxoCount: number }>();
  if (addresses.length === 0) return out;

  // Gather participants for these addresses in batches.
  const participants: TransactionParticipant[] = [];
  for (let i = 0; i < addresses.length; i += 500) {
    if (isAborted(signal)) return out;
    const batch = addresses.slice(i, i + 500);
    const raw = await db.transactionParticipants.where('address').anyOf(batch).toArray();
    participants.push(...raw);
  }

  if (participants.length === 0) return out;

  // Address-keyed loads miss spend inputs that carry no prevout address
  // (Electrum-synced inputs are stored with a blank address string). Follow up
  // with an outpoint-keyed load for inputs spending the owned outputs we just
  // fetched, and attribute each such input to the address that owns the spent
  // output, so exact-mode spent detection sees those spends. Without this, an
  // Electrum-synced address's spentOutpoints set stays empty and its balance
  // inflates to "total received".
  const seenIds = new Set<number>();
  const ownerByOutpoint = new Map<string, string>();
  const ownedOutpoints: Array<[string, number]> = [];
  for (const p of participants) {
    if (p.id !== undefined) seenIds.add(p.id);
    if (p.role === 'output' && p.vout !== undefined && p.vout !== null) {
      ownedOutpoints.push([p.txid, p.vout]);
      ownerByOutpoint.set(`${p.txid}:${p.vout}`, p.address);
    }
  }
  const spendInputs = await getSpendInputsByOutpoints(ownedOutpoints, signal);
  if (isAborted(signal)) return out;
  /** Blank/foreign-address spend inputs, attributed to the owning address. */
  const attributedSpendInputs: Array<{ owner: string; participant: TransactionParticipant }> = [];
  for (const p of spendInputs) {
    if (p.id !== undefined && seenIds.has(p.id)) continue;
    const owner = ownerByOutpoint.get(`${p.prevTxid}:${p.prevVout}`);
    if (owner) attributedSpendInputs.push({ owner, participant: p });
  }

  const txids = Array.from(new Set([
    ...participants.map(p => p.txid),
    ...attributedSpendInputs.map(a => a.participant.txid),
  ]));
  const txMap = await loadBlockTimes(txids);

  const addrAgg = new Map<string, AddressAgg>();
  let aggRowsSinceYield = 0;
  for (const p of participants) {
    const agg = addrAgg.get(p.address) || { outputSats: 0, inputSats: 0, lastTxTime: 0, txids: new Set<string>(), outputs: [], inputs: [] };
    const blockTime = txMap.get(p.txid) || 0;
    if (p.role === 'output') {
      agg.outputSats += p.amount;
      agg.outputs.push(p);
    } else {
      agg.inputSats += p.amount;
      agg.inputs.push(p);
    }
    if (blockTime > agg.lastTxTime) agg.lastTxTime = blockTime;
    agg.txids.add(p.txid);
    addrAgg.set(p.address, agg);
    // Yield periodically so a single very busy address (tens of thousands of
    // participant rows) can't block the UI between the batch-level yields.
    if (++aggRowsSinceYield >= ROW_YIELD_INTERVAL) {
      aggRowsSinceYield = 0;
      await yieldToEventLoop();
      if (isAborted(signal)) return out;
    }
  }

  // Merge the outpoint-fetched spend inputs into their owning address's
  // aggregate. This is what a fully-resolved sync would have produced (an input
  // row carrying the owner's address), so the spend transaction also counts
  // toward txCount/lastActivityTime.
  for (const { owner, participant } of attributedSpendInputs) {
    const agg = addrAgg.get(owner);
    if (!agg) continue;
    agg.inputs.push(participant);
    agg.inputSats += participant.amount;
    agg.txids.add(participant.txid);
    const blockTime = txMap.get(participant.txid) || 0;
    if (blockTime > agg.lastTxTime) agg.lastTxTime = blockTime;
  }

  addrAgg.forEach((agg, address) => {
    const utxoStats = computeUtxoStatsForAddress(agg.outputs, agg.inputs, (txid) => txMap.get(txid) || 0);
    out.set(address, {
      balanceSats: utxoStats.balanceSats,
      lastActivityTime: agg.lastTxTime,
      txCount: agg.txids.size,
      utxoCount: utxoStats.count,
    });
  });

  return out;
}

/**
 * Above this many combined participant + transaction rows the full-vault
 * single-scan recompute falls back to the batched per-address path, so the
 * in-memory aggregation can never balloon on an extreme vault. Well above the
 * largest vaults seen in practice (30k addresses / 60k participants), while a
 * vault past this point still completes correctly via the batched path.
 */
export const FULL_SCAN_ROW_LIMIT = 2_000_000;

/** Page size for the full-table streaming scans. */
const FULL_SCAN_BATCH = 5_000;

/**
 * A FILTERED recompute (recordIds/addresses) also reuses the streaming
 * whole-vault scan when the requested set is large enough that per-batch
 * anyOf lookups would cost more than one full pass — e.g. Database Doctor
 * "recompute selected" over many thousands of rows, or a bulk re-sync's stats
 * refresh. Both gates must hold:
 *   - the request covers at least this fraction of the vault's addresses, and
 *   - the request is at least `FILTERED_SCAN_MIN_REQUESTED` rows (so small
 *     selections keep the cheap targeted path even in small vaults).
 * Writes are still restricted to exactly the requested subset — only the
 * stats *computation* is shared with the full-vault path.
 */
const FILTERED_SCAN_VAULT_FRACTION = 0.5;
const FILTERED_SCAN_MIN_REQUESTED = 1_000;

/**
 * Set-oriented full-vault stats computation: ONE streaming pass over the
 * transactionParticipants table plus ONE over blockchainTransactions, instead
 * of per-batch `anyOf(addresses)` index round-trips. On large vaults (tens of
 * thousands of addresses) this turns the one-time Balance-page backfill from
 * minutes into seconds — the batched path issues 4+ Dexie queries per 100
 * addresses (participants by address, spend inputs by outpoint, block times,
 * sync states), while this pass reads each row exactly once.
 *
 * Semantically equivalent to running `computeStatsForAddresses` over every
 * address: blank-address spend inputs (Electrum-synced rows carrying only
 * prevTxid/prevVout) are attributed to the address that owns the spent output,
 * so exact-mode spent detection sees them. Because the owned-outpoint map here
 * is vault-wide (not per-batch), attribution is if anything more complete than
 * the batched path.
 *
 * Returns null when the vault is too large for the in-memory aggregation
 * (caller falls back to the batched path) or when the signal aborts mid-scan.
 * Pure local read; never touches the network.
 */
async function computeStatsForAllAddressesByScan(
  signal?: AbortSignal,
): Promise<Map<string, { balanceSats: number; lastActivityTime: number; txCount: number; utxoCount: number }> | null> {
  const [participantCount, txCount] = await Promise.all([
    db.transactionParticipants.count(),
    db.blockchainTransactions.count(),
  ]);
  if (participantCount + txCount > FULL_SCAN_ROW_LIMIT) return null;
  if (isAborted(signal)) return null;

  // Pass 1: stream every participant row once. Aggregate rows under their own
  // address, remember who owns each outpoint, and buffer prevout-carrying
  // inputs for post-scan attribution (their owning output may appear later in
  // the scan than the input row does).
  const addrAgg = new Map<string, AddressAgg>();
  const ownerByOutpoint = new Map<string, string>();
  const prevoutInputs: TransactionParticipant[] = [];
  let lastPid = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (isAborted(signal)) return null;
    const batch = await db.transactionParticipants
      .where(':id')
      .above(lastPid)
      .limit(FULL_SCAN_BATCH)
      .toArray();
    if (batch.length === 0) break;
    lastPid = batch[batch.length - 1].id!;

    for (const p of batch) {
      if (p.role === 'output' && p.vout !== undefined && p.vout !== null && p.address) {
        ownerByOutpoint.set(`${p.txid}:${p.vout}`, p.address);
      }
      if (p.role === 'input' && p.prevTxid !== undefined && p.prevVout !== undefined) {
        prevoutInputs.push(p);
      }
      if (!p.address) continue; // blank-address rows are attributed post-scan
      let agg = addrAgg.get(p.address);
      if (!agg) {
        agg = { outputSats: 0, inputSats: 0, lastTxTime: 0, txids: new Set<string>(), outputs: [], inputs: [] };
        addrAgg.set(p.address, agg);
      }
      if (p.role === 'output') {
        agg.outputSats += p.amount;
        agg.outputs.push(p);
      } else {
        agg.inputSats += p.amount;
        agg.inputs.push(p);
      }
      agg.txids.add(p.txid);
    }

    await yieldToEventLoop();
    if (batch.length < FULL_SCAN_BATCH) break;
  }

  // Attribute prevout spend inputs to the address that owns the spent output
  // (unless the row already carries that address and was aggregated above).
  // This is what makes blank-address Electrum spends reduce the owner's
  // balance, mirroring computeStatsForAddresses' outpoint follow-up load.
  let rowsSinceYield = 0;
  for (const p of prevoutInputs) {
    const owner = ownerByOutpoint.get(`${p.prevTxid}:${p.prevVout}`);
    if (owner && owner !== p.address) {
      const agg = addrAgg.get(owner);
      if (agg) {
        agg.inputs.push(p);
        agg.inputSats += p.amount;
        agg.txids.add(p.txid);
      }
    }
    if (++rowsSinceYield >= FULL_SCAN_BATCH) {
      rowsSinceYield = 0;
      await yieldToEventLoop();
      if (isAborted(signal)) return null;
    }
  }

  // Pass 2: stream every transaction once for txid -> blockTime.
  const txMap = new Map<string, number>();
  let lastTid = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (isAborted(signal)) return null;
    const batch = await db.blockchainTransactions
      .where(':id')
      .above(lastTid)
      .limit(FULL_SCAN_BATCH)
      .toArray();
    if (batch.length === 0) break;
    lastTid = batch[batch.length - 1].id!;
    for (const tx of batch) txMap.set(tx.txid, tx.blockTime);
    await yieldToEventLoop();
    if (batch.length < FULL_SCAN_BATCH) break;
  }

  // Final fold: per-address UTXO stats + last activity, yielding periodically.
  const out = new Map<string, { balanceSats: number; lastActivityTime: number; txCount: number; utxoCount: number }>();
  const blockTimeOf = (txid: string) => txMap.get(txid) || 0;
  let addrsSinceYield = 0;
  for (const [address, agg] of Array.from(addrAgg.entries())) {
    let lastTxTime = 0;
    agg.txids.forEach((txid) => {
      const t = blockTimeOf(txid);
      if (t > lastTxTime) lastTxTime = t;
    });
    const utxoStats = computeUtxoStatsForAddress(agg.outputs, agg.inputs, blockTimeOf);
    out.set(address, {
      balanceSats: utxoStats.balanceSats,
      lastActivityTime: lastTxTime,
      txCount: agg.txids.size,
      utxoCount: utxoStats.count,
    });
    if (++addrsSinceYield >= 500) {
      addrsSinceYield = 0;
      await yieldToEventLoop();
      if (isAborted(signal)) return null;
    }
  }

  return out;
}

/**
 * Load address records to recompute, paging through the [type+id] index so we
 * never hold the entire address table in memory at once.
 */
async function* iterateAddressRecordBatches(
  options: RecomputeOptions
): AsyncGenerator<Array<{ id: number; inputString: string }>> {
  const batchSize = options.batchSize ?? 500;

  if (options.recordIds && options.recordIds.length > 0) {
    const ids = options.recordIds;
    for (let i = 0; i < ids.length; i += batchSize) {
      const slice = ids.slice(i, i + batchSize);
      const recs = await db.records.where('id').anyOf(slice).toArray();
      yield recs
        .filter(r => r.type === 'address' && r.inputString && r.id != null)
        .map(r => ({ id: r.id!, inputString: r.inputString }));
    }
    return;
  }

  if (options.addresses && options.addresses.length > 0) {
    const addrs = options.addresses;
    for (let i = 0; i < addrs.length; i += batchSize) {
      const slice = addrs.slice(i, i + batchSize);
      const recs = await db.records.where('inputString').anyOf(slice).toArray();
      yield recs
        .filter(r => r.type === 'address' && r.inputString && r.id != null)
        .map(r => ({ id: r.id!, inputString: r.inputString }));
    }
    return;
  }

  // All address records — page through the compound [type+id] index by id.
  let lastId = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await db.records
      .where('[type+id]')
      .between(['address', lastId], ['address', Dexie.maxKey], false, true)
      .limit(batchSize)
      .toArray();
    if (batch.length === 0) return;
    lastId = batch[batch.length - 1].id!;
    yield batch
      .filter(r => r.inputString && r.id != null)
      .map(r => ({ id: r.id!, inputString: r.inputString }));
  }
}

async function countAddressRecords(options: RecomputeOptions): Promise<number> {
  if (options.recordIds && options.recordIds.length > 0) return options.recordIds.length;
  if (options.addresses && options.addresses.length > 0) return options.addresses.length;
  return db.records.where('type').equals('address').count();
}

/**
 * Cancellable, progress-reporting recompute that rebuilds the stats cache for a
 * set of address records (all, by ids, or by address strings) from local data,
 * yielding between batches so it never freezes the UI. Never touches the network.
 */
export async function recomputeAddressStats(
  options: RecomputeOptions = {}
): Promise<RecomputeResult> {
  const now = Date.now();
  let updated = 0;
  let processed = 0;

  const total = await countAddressRecords(options);
  options.onProgress?.({ processed: 0, total });

  const fullRecompute =
    !(options.recordIds && options.recordIds.length > 0) &&
    !(options.addresses && options.addresses.length > 0);

  // Full-vault recompute fast path: build the whole stats map (and the synced
  // set) in a couple of streaming table scans up front, so the per-batch loop
  // below only does lookups + writes. Falls back to the batched per-address
  // computation when the vault is too large for the in-memory aggregation or
  // the scan was aborted (the loop's own abort check then returns cancelled).
  // Large FILTERED recomputes reuse the same scan: when the requested set
  // covers most of the vault, one streaming pass is cheaper than thousands of
  // per-batch anyOf round-trips. Writes below remain scoped to the requested
  // records (the batch iterator only yields those), so this changes only how
  // the stats are computed, never which rows are written.
  let useScan = fullRecompute;
  if (!fullRecompute && total >= FILTERED_SCAN_MIN_REQUESTED) {
    const vaultAddressCount = await db.records.where('type').equals('address').count();
    if (vaultAddressCount > 0 && total >= vaultAddressCount * FILTERED_SCAN_VAULT_FRACTION) {
      useScan = true;
    }
  }

  let precomputedStats: Awaited<ReturnType<typeof computeStatsForAllAddressesByScan>> = null;
  let precomputedSynced: Set<string> | null = null;
  if (useScan && !isAborted(options.signal)) {
    precomputedStats = await computeStatsForAllAddressesByScan(options.signal);
    if (precomputedStats && !isAborted(options.signal)) {
      const synced = new Set<string>();
      await db.addressSyncState.each(s => { synced.add(s.address); });
      precomputedSynced = synced;
    }
  }

  for await (const batch of iterateAddressRecordBatches(options)) {
    if (isAborted(options.signal)) {
      return { updated, cancelled: true };
    }
    if (batch.length === 0) continue;

    const addressStrings = batch.map(b => b.inputString);
    const statsByAddress =
      precomputedStats ?? await computeStatsForAddresses(addressStrings, options.signal);

    // Determine which addresses have been synced (have transaction data fetched)
    // even when they currently have no participants, so we can distinguish a
    // genuine zero balance from "not synced".
    let syncedSet: Set<string>;
    if (precomputedSynced) {
      syncedSet = precomputedSynced;
    } else {
      syncedSet = new Set<string>();
      for (let i = 0; i < addressStrings.length; i += 500) {
        const slice = addressStrings.slice(i, i + 500);
        const states = await db.addressSyncState.where('address').anyOf(slice).toArray();
        for (const s of states) syncedSet.add(s.address);
      }
    }

    const updates: Array<{ id: number; stats: AddressStatsCacheValues | null }> = [];
    for (const rec of batch) {
      const s = statsByAddress.get(rec.inputString);
      const hasData = !!s || syncedSet.has(rec.inputString);
      if (!hasData) {
        // No fetched transaction data → leave/reset as "not synced".
        updates.push({ id: rec.id, stats: null });
        continue;
      }
      updates.push({
        id: rec.id,
        stats: {
          cachedBalanceSats: s ? s.balanceSats : 0,
          cachedTxCount: s ? s.txCount : 0,
          cachedLastActivityTime: s ? s.lastActivityTime : 0,
          cachedUtxoCount: s ? s.utxoCount : 0,
          statsComputedAt: now,
        },
      });
    }

    updated += await bulkUpdateAddressStats(updates, {
      skipNotification: true,
      origin: options.origin,
    });

    processed += batch.length;
    options.onProgress?.({ processed, total });

    // Yield to the UI between batches.
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  if (updated > 0 && !options.skipNotification) {
    notifyDbChange('records', options.origin ? { origin: options.origin } : undefined);
  }

  // A full recompute (no id/address filter) has just refreshed the cached stats
  // for the entire vault, so this is the cheapest moment to refresh the
  // vault-wide behavior tally. Partial recomputes (sync, selection) leave the
  // tally to be refreshed lazily by the freshness fingerprint. Best-effort: a
  // tally failure must never fail the stats recompute itself.
  if (fullRecompute && !isAborted(options.signal)) {
    try {
      await materializeBehaviorTally({ signal: options.signal });
    } catch (err) {
      console.error('[address-stats] behavior tally refresh failed', err);
    }
  }

  return { updated, cancelled: isAborted(options.signal) };
}

// ── Vault-wide behavior tally ───────────────────────────────────────────────
//
// A precomputed count of how many addresses fall into each behavior label
// (Dormant, Accumulator, High Activity, …). The Records behavior filter
// classifies records client-side from cached stats, which only works on the
// loaded page; this tally answers "how many of each do I have in total?" without
// scanning the whole vault in memory on every render. It is a streamed,
// cancellable, local-only pass that reads only the cached stat columns already
// on each address record (no participant joins, no network) and yields between
// batches so it never freezes large vaults.

export interface BehaviorTallyResult {
  counts: BehaviorTallyCounts;
  /** Total address records scanned (freshness fingerprint). */
  addressCount: number;
  /** How many of those had been synced (statsComputedAt set). */
  syncedCount: number;
  cancelled: boolean;
}

export interface BehaviorTallyOptions {
  signal?: AbortSignal;
  onProgress?: (processed: number, total: number) => void;
  /** Page size for scanning address records. */
  batchSize?: number;
}

/**
 * Stream through every address record, classify each from its cached stats, and
 * return the per-label totals. Pure local read; never holds the whole table in
 * memory (pages the [type+id] index) and yields between batches.
 */
export async function computeBehaviorTally(
  options: BehaviorTallyOptions = {},
): Promise<BehaviorTallyResult> {
  const counts = emptyBehaviorTally();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const batchSize = options.batchSize ?? 1000;
  let addressCount = 0;
  let syncedCount = 0;
  let lastId = 0;

  const total = await db.records.where('type').equals('address').count();
  options.onProgress?.(0, total);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (isAborted(options.signal)) {
      return { counts, addressCount, syncedCount, cancelled: true };
    }

    const batch = await db.records
      .where('[type+id]')
      .between(['address', lastId], ['address', Dexie.maxKey], false, true)
      .limit(batchSize)
      .toArray();

    if (batch.length === 0) break;
    lastId = batch[batch.length - 1].id!;

    for (const rec of batch) {
      addressCount += 1;
      if (rec.statsComputedAt != null) syncedCount += 1;
      counts[behaviorLabelFromCachedStats(rec, nowSeconds)] += 1;
    }

    options.onProgress?.(addressCount, total);
    await new Promise(resolve => setTimeout(resolve, 0));
    if (batch.length < batchSize) break;
  }

  return { counts, addressCount, syncedCount, cancelled: isAborted(options.signal) };
}

/** Persist a freshly computed tally onto the default settings row. */
async function persistBehaviorTally(result: BehaviorTallyResult): Promise<void> {
  const settings = await getSettings('default');
  if (!settings) return; // Settings not initialised yet; nothing to attach to.
  await updateSettings('default', {
    behaviorTally: {
      computedAt: Date.now(),
      addressCount: result.addressCount,
      syncedCount: result.syncedCount,
      counts: result.counts,
    },
  });
}

/**
 * One-time self-healing backfill for addresses that completed a sync run before
 * the fix that widens the post-run stats recompute set.
 *
 * Symptoms: an address has an `addressSyncState` entry (it was genuinely synced)
 * but its record still has no `statsComputedAt` — so Records shows "Not Synced".
 *
 * This function finds those stuck records and runs `recomputeAddressStats` for
 * them only. It never churns unrelated records and does not trigger a full
 * engine re-seed.
 */
export async function backfillMissingSyncStats(): Promise<{ backfilled: number }> {
  // Collect the set of addresses that have ever completed a sync.
  const syncStates = await db.addressSyncState.toArray();
  if (syncStates.length === 0) return { backfilled: 0 };

  const syncedAddresses = new Set<string>(syncStates.map(s => s.address));

  // Page through address records to find those missing statsComputedAt.
  const stuckAddresses: string[] = [];
  let lastId = 0;
  const BATCH = 500;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await db.records
      .where('[type+id]')
      .between(['address', lastId], ['address', Dexie.maxKey], false, true)
      .limit(BATCH)
      .toArray();
    if (batch.length === 0) break;
    lastId = batch[batch.length - 1].id!;
    for (const rec of batch) {
      if (
        rec.statsComputedAt == null &&
        rec.inputString &&
        syncedAddresses.has(rec.inputString)
      ) {
        stuckAddresses.push(rec.inputString);
      }
    }
    if (batch.length < BATCH) break;
  }

  if (stuckAddresses.length === 0) return { backfilled: 0 };

  console.log(
    `[address-stats] backfillMissingSyncStats: recomputing ${stuckAddresses.length} stuck address(es)`,
  );

  const result = await recomputeAddressStats({
    addresses: stuckAddresses,
    origin: 'blockchain-sync',
  });

  return { backfilled: result.updated };
}

/**
 * Compute the vault-wide behavior tally and persist it to settings. Returns the
 * result; a cancelled pass is not persisted (the stale tally is left intact).
 */
export async function materializeBehaviorTally(
  options: BehaviorTallyOptions = {},
): Promise<BehaviorTallyResult> {
  const result = await computeBehaviorTally(options);
  if (!result.cancelled) {
    await persistBehaviorTally(result);
  }
  return result;
}

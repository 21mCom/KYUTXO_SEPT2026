import Dexie from 'dexie';
import { db, notifyDbChange, type TransactionParticipant } from '../database';
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
      continue;
    }

    const addresses = synced.map(r => r.inputString);
    const freshStats = await computeStatsForAddresses(addresses, opts.signal);

    const batchStale: StaleAddressDetail[] = [];
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
    }

    if (streaming && batchStale.length > 0) await opts.onStaleBatch!(batchStale);

    opts.onProgress?.(sampled, total);
    await new Promise(resolve => setTimeout(resolve, 0));
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

/**
 * Count the unspent outputs (UTXOs) currently held by a single address from its
 * own output/input participant rows. This mirrors BalanceOverview's former
 * in-page logic, but evaluated per-address so the result is independent of how
 * addresses are batched:
 *   - Exact mode (the address has at least one input carrying prevout data):
 *     an output is unspent unless its outpoint (txid:vout) is referenced by one
 *     of this address's inputs.
 *   - Heuristic mode (no prevout data): pair each output with a later input of
 *     the same amount (FIFO by block time); unmatched outputs are unspent.
 * Outputs whose transaction has no known block time (unconfirmed/missing) are
 * ignored, matching the page's prior behaviour.
 */
export function computeUtxoCountForAddress(
  outputs: TransactionParticipant[],
  inputs: TransactionParticipant[],
  blockTimeOf: (txid: string) => number,
): number {
  const spentOutpoints = new Set<string>();
  for (const inp of inputs) {
    if (inp.prevTxid !== undefined && inp.prevVout !== undefined) {
      spentOutpoints.add(`${inp.prevTxid}:${inp.prevVout}`);
    }
  }

  const hasExactData = spentOutpoints.size > 0;
  if (hasExactData) {
    let count = 0;
    for (const output of outputs) {
      if ((blockTimeOf(output.txid) || 0) <= 0) continue;
      const outpoint = `${output.txid}:${output.vout ?? 0}`;
      if (spentOutpoints.has(outpoint)) continue;
      count += 1;
    }
    return count;
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
    }
  }
  return count;
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

  const txids = Array.from(new Set(participants.map(p => p.txid)));
  const txMap = await loadBlockTimes(txids);

  const addrAgg = new Map<string, AddressAgg>();
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
  }

  addrAgg.forEach((agg, address) => {
    out.set(address, {
      balanceSats: agg.outputSats - agg.inputSats,
      lastActivityTime: agg.lastTxTime,
      txCount: agg.txids.size,
      utxoCount: computeUtxoCountForAddress(agg.outputs, agg.inputs, (txid) => txMap.get(txid) || 0),
    });
  });

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

  for await (const batch of iterateAddressRecordBatches(options)) {
    if (isAborted(options.signal)) {
      return { updated, cancelled: true };
    }
    if (batch.length === 0) continue;

    const addressStrings = batch.map(b => b.inputString);
    const statsByAddress = await computeStatsForAddresses(addressStrings, options.signal);

    // Determine which addresses have been synced (have transaction data fetched)
    // even when they currently have no participants, so we can distinguish a
    // genuine zero balance from "not synced".
    const syncedSet = new Set<string>();
    for (let i = 0; i < addressStrings.length; i += 500) {
      const slice = addressStrings.slice(i, i + 500);
      const states = await db.addressSyncState.where('address').anyOf(slice).toArray();
      for (const s of states) syncedSet.add(s.address);
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
  const fullRecompute =
    !(options.recordIds && options.recordIds.length > 0) &&
    !(options.addresses && options.addresses.length > 0);
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

import Dexie from 'dexie';
import { db, notifyDbChange, type TransactionParticipant } from '../database';
import { bulkUpdateAddressStats, type AddressStatsCacheValues } from './record-crud';

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

interface AddressAgg {
  outputSats: number;
  inputSats: number;
  lastTxTime: number;
  txids: Set<string>;
}

function isAborted(signal?: AbortSignal): boolean {
  return !!signal?.aborted;
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
): Promise<Map<string, { balanceSats: number; lastActivityTime: number; txCount: number }>> {
  const out = new Map<string, { balanceSats: number; lastActivityTime: number; txCount: number }>();
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
    const agg = addrAgg.get(p.address) || { outputSats: 0, inputSats: 0, lastTxTime: 0, txids: new Set<string>() };
    const blockTime = txMap.get(p.txid) || 0;
    if (p.role === 'output') {
      agg.outputSats += p.amount;
    } else {
      agg.inputSats += p.amount;
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

  return { updated, cancelled: isAborted(options.signal) };
}

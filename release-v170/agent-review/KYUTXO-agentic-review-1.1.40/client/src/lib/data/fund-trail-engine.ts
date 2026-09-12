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
import { canonicalizeRecordIdentifier } from '../bitcoin';
import { isUserCuratedImportance } from '../db-types';

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
 * Number of in-memory scan iterations to process between yields. A single hop
 * over an address with a huge number of transactions can still walk hundreds of
 * thousands of participant/lineage rows synchronously; yielding every
 * `SCAN_YIELD_EVERY` iterations lets the browser paint and lets us observe
 * cancellation *within* one wide hop, not just between hops.
 */
const SCAN_YIELD_EVERY = 5000;

/**
 * Hands control back to the event loop and observes cancellation. Throws an
 * AbortError if the signal has fired so callers unwind immediately.
 */
async function scanYield(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  await new Promise(r => setTimeout(r, 0));
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

export interface ListGroupValuesOptions {
  /**
   * When true, only records with a curated (non-discovered) importance tier
   * contribute a group value to the list — i.e. a group that exists only
   * because of discovered addresses won't be offered as a pickable trace
   * source. This does NOT affect which addresses a trace follows once a
   * group is selected (see getAddressesForGroup, which always returns every
   * address in the group, curated or discovered).
   */
  curatedOnly?: boolean;
}

/**
 * Lists all known group values (sorted, deduplicated) for the given dimension.
 */
export async function listGroupValues(
  dimension: GroupingDimension,
  options?: ListGroupValuesOptions
): Promise<string[]> {
  const records = await db.records.toArray();
  const seen = new Set<string>();
  for (const r of records) {
    if (options?.curatedOnly && !isUserCuratedImportance(r.addressImportance)) continue;
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

/**
 * Returns the first record whose inputString matches the given address, or undefined.
 * Read-only; safe to call from any context.
 */
export async function getRecordByAddress(
  address: string
): Promise<DbRecord | undefined> {
  // Canonicalize the lookup key so it matches canonically stored identifiers.
  return db.records.where('inputString').equals(canonicalizeRecordIdentifier(address)).first();
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

  let scanned = 0;
  for (const p of allParticipants) {
    if (p.role === 'output' && addrSet.has(p.address) && !incomingCoveredTxids.has(p.txid)) {
      incomingTxidsFromParticipants.add(p.txid);
    }
    if (p.role === 'input' && addrSet.has(p.address) && !outgoingCoveredTxids.has(p.txid)) {
      outgoingTxidsFromParticipants.add(p.txid);
    }
    if (++scanned % SCAN_YIELD_EVERY === 0) await scanYield(signal);
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

  // When a date range is active, restrict the recency cap to the txids whose
  // blockTime actually falls in the window. Otherwise, on a wallet with more
  // than `txLimit` transactions, newer out-of-window txids could consume the
  // cap and silently drop older in-window flows before steps 4/5 ever filter
  // by date. Scoping the candidate set here keeps totalTxCount/shownTxCount/
  // isCapped meaningful relative to the chosen window.
  const rangeActive = !!dateRange && (dateRange.start != null || dateRange.end != null);
  const cappableTxids = rangeActive
    ? [...candidateTxids].filter(t => isBlockTimeInRange(blockTimes.get(t) ?? 0, dateRange))
    : [...candidateTxids];

  const totalTxCount = cappableTxids.length;

  let isCapped = false;
  // shownTxCount is finalised AFTER the enrichment loops (steps 4/5) from the
  // txids that actually land in a source/destination row. Assigning it here from
  // keptTxids.size would overstate the count, because the enrichment loops drop
  // kept txids via several `continue` skip paths (same-group, self-label,
  // out-of-date-range, no matching participant/lineage row). Those skipped txids
  // are retained for processing but never shown, so counting them would make the
  // cap notice claim more transactions than the reader can see.
  let shownTxCount = totalTxCount;
  if (totalTxCount > txLimit) {
    isCapped = true;
    const keptTxids = new Set(
      cappableTxids
        .sort((a, b) => (blockTimes.get(b) ?? 0) - (blockTimes.get(a) ?? 0))
        .slice(0, txLimit)
    );
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
  let scanned4a = 0;
  for (const l of incomingLineage) {
    if (++scanned4a % SCAN_YIELD_EVERY === 0) await scanYield(signal);
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
  let scanned4b = 0;
  for (const [txid, txParts] of incomingTxParts) {
    if (++scanned4b % SCAN_YIELD_EVERY === 0) await scanYield(signal);
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
  let scanned5a = 0;
  for (const l of outgoingLineage) {
    if (++scanned5a % SCAN_YIELD_EVERY === 0) await scanYield(signal);
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
  let scanned5b = 0;
  for (const [txid, txParts] of outgoingTxParts) {
    if (++scanned5b % SCAN_YIELD_EVERY === 0) await scanYield(signal);
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

  // Finalise the shown-transaction count from the txids that actually produced a
  // source or destination row. When capped, this can be fewer than the kept set
  // because the enrichment loops above skip kept txids that map only to
  // same-group/self-label/out-of-range/unmatched flows. Counting only the txids
  // a reader can actually see keeps the cap notice honest.
  if (isCapped) {
    const shownTxids = new Set<string>();
    for (const flow of sourceMap.values()) {
      for (const d of flow.details) shownTxids.add(d.txid);
    }
    for (const flow of destMap.values()) {
      for (const d of flow.details) shownTxids.add(d.txid);
    }
    shownTxCount = shownTxids.size;
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
// Multi-hop known-entity traversal
// ---------------------------------------------------------------------------

/**
 * One entity node in a multi-hop trail result. Flat (not nested) so the UI
 * can render each node at the correct hop depth without nesting columns.
 */
export interface HopNode {
  groupLabel: string;
  dimension: GroupingDimension;
  /** 1 = direct counterparty, 2 = one unknown intermediary away, etc. */
  hopDepth: number;
  direction: 'source' | 'dest';
  totalSats: number;
  details: GroupFlowDetail[];
  isUnknown: boolean;
  unknownAddresses?: string[];
  /**
   * Ordered chain of unknown intermediary addresses traversed between the
   * center and this node. Empty/undefined for direct (hop 1) counterparties.
   * For deeper hops it lists every unknown address bucket followed to reach
   * this node, so an exported artifact can show *through which* addresses the
   * entity was reached. Because the engine aggregates all unknown addresses at
   * a hop into a single bucket, this is the union of every unknown address at
   * each preceding hop — it cannot pinpoint the single path to one entity.
   */
  pathAddresses?: string[];
}

export interface MultiHopCapEntry {
  depth: number;
  direction: 'source' | 'dest';
  isCapped: boolean;
  shownTxCount: number;
  totalTxCount: number;
}

export interface MultiHopTrailResult {
  sources: HopNode[];
  destinations: HopNode[];
  /** Cap metadata per hop direction + depth, for surfacing notices in the UI. */
  caps: MultiHopCapEntry[];
}

/**
 * Incremental progress reported while a multi-hop trail is being computed.
 *
 * The traversal runs backward (sources) first, then forward (destinations).
 * `phase` distinguishes the moment a hop *starts* ("tracing", emitted before the
 * potentially slow computeOneHop call so the UI can show "Tracing hop N…") from
 * the moment all work is finished ("done"). `sources`/`destinations`/`caps`
 * carry the *partial* results accumulated so far, so the caller can render
 * already-completed hops while deeper hops are still loading. They are fresh
 * shallow copies on every emission, safe to store directly in React state.
 */
export interface MultiHopProgress {
  direction: 'source' | 'dest';
  /** Current hop depth being traced (1-based). */
  depth: number;
  /** Max depth for the direction currently being traced. */
  maxDepth: number;
  phase: 'tracing' | 'done';
  sources: HopNode[];
  destinations: HopNode[];
  caps: MultiHopCapEntry[];
}

export type MultiHopProgressCallback = (progress: MultiHopProgress) => void;

/** Hard upper limit on hop depth for the multi-hop trail, to protect performance. */
export const MAX_HOP_DEPTH = 5;

/**
 * Compute a multi-hop known-entity trail.
 *
 * Traces backward (sources) up to `backwardHops` and forward (destinations) up
 * to `forwardHops`, automatically following chains through unidentified addresses
 * to surface known entities deeper in the chain. Only known entities appear as
 * named nodes; branches that exhaust hop budget while still in unknown territory
 * are collapsed into a single acknowledged "Unidentified" terminus at their
 * deepest hop so totals remain honest.
 *
 * Cycle-safe: each group label is visited at most once per direction.
 * Read-only, batched, and abortable — identical safety guarantees to computeOneHop.
 */
export async function computeMultiHopKnown(
  centerAddresses: string[],
  dimension: GroupingDimension,
  selfGroupLabel: string | null,
  backwardHops: number,
  forwardHops: number,
  dateRange?: DateRange,
  signal?: AbortSignal,
  options?: ComputeOneHopOptions,
  onProgress?: MultiHopProgressCallback,
): Promise<MultiHopTrailResult> {
  const clampedBack = Math.min(Math.max(1, backwardHops), MAX_HOP_DEPTH);
  const clampedFwd = Math.min(Math.max(1, forwardHops), MAX_HOP_DEPTH);

  const sources: HopNode[] = [];
  const destinations: HopNode[] = [];
  const caps: MultiHopCapEntry[] = [];

  // Emit a fresh snapshot of everything accumulated so far. Copies are shallow
  // but new arrays, so storing them straight into React state is safe.
  const emit = onProgress
    ? (direction: 'source' | 'dest', depth: number, maxDepth: number, phase: 'tracing' | 'done') => {
        onProgress({
          direction,
          depth,
          maxDepth,
          phase,
          sources: [...sources],
          destinations: [...destinations],
          caps: [...caps],
        });
      }
    : undefined;

  // Backward: who funded the center?
  await traceHopDirection(
    'source', centerAddresses, selfGroupLabel,
    clampedBack, dimension, dateRange, signal, options,
    sources, caps, emit,
  );

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  // Forward: where did the center send?
  await traceHopDirection(
    'dest', centerAddresses, selfGroupLabel,
    clampedFwd, dimension, dateRange, signal, options,
    destinations, caps, emit,
  );

  // Final emission so listeners can drop any "tracing" indicator.
  emit?.('dest', clampedFwd, clampedFwd, 'done');

  return { sources, destinations, caps };
}

/**
 * Internal: iteratively trace one direction (source or dest) through up to
 * `maxDepth` hops, following unknown-address buckets between hops.
 */
async function traceHopDirection(
  direction: 'source' | 'dest',
  startAddresses: string[],
  selfGroupLabel: string | null,
  maxDepth: number,
  dimension: GroupingDimension,
  dateRange: DateRange | undefined,
  signal: AbortSignal | undefined,
  options: ComputeOneHopOptions | undefined,
  result: HopNode[],
  caps: MultiHopCapEntry[],
  emit?: (direction: 'source' | 'dest', depth: number, maxDepth: number, phase: 'tracing' | 'done') => void,
): Promise<void> {
  let pendingAddresses = [...startAddresses];
  // Never re-visit a known group label (cycle protection + deduplication)
  const visitedGroups = new Set<string>(selfGroupLabel ? [selfGroupLabel] : []);

  // Accumulates the chain of unknown intermediary addresses followed so far.
  // Empty at hop 1 (direct counterparties); after we descend through an unknown
  // bucket it carries every unknown address traversed to reach deeper hops.
  let pathAddresses: string[] = [];
  const pathSnapshot = (): string[] | undefined =>
    pathAddresses.length > 0 ? [...pathAddresses] : undefined;

  // Track the last unknown flow we chose to follow deeper instead of surfacing
  // immediately, so we can surface it as a terminus if the chain dead-ends.
  let pendingUnknownTerminus:
    | { flow: GroupFlow; depth: number; path: string[] | undefined }
    | null = null;

  for (let depth = 1; depth <= maxDepth; depth++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (pendingAddresses.length === 0) break;

    // Announce the hop *before* the (potentially slow) computeOneHop call so a
    // "Tracing hop N…" indicator can appear while the work runs. The extra
    // macrotask yield lets the browser paint that indicator before we block on
    // the synchronous portions of computeOneHop.
    if (emit) {
      emit(direction, depth, maxDepth, 'tracing');
      await new Promise(r => setTimeout(r, 0));
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    }

    // At depth > 1 the "center" is the unknown intermediary addresses which
    // have no group label — pass null so computeOneHop doesn't self-filter.
    const selfLabel = depth === 1 ? selfGroupLabel : null;
    const hop = await computeOneHop(
      pendingAddresses, dimension, selfLabel, dateRange, signal, options,
    );

    caps.push({
      depth,
      direction,
      isCapped: hop.isCapped ?? false,
      shownTxCount: hop.shownTxCount ?? 0,
      totalTxCount: hop.totalTxCount ?? 0,
    });

    const flows = direction === 'source' ? hop.sources : hop.destinations;

    // Record every known entity we haven't seen yet
    for (const flow of flows) {
      if (flow.isUnknown) continue;
      if (visitedGroups.has(flow.groupLabel)) continue;
      visitedGroups.add(flow.groupLabel);
      result.push({ ...flow, hopDepth: depth, direction, pathAddresses: pathSnapshot() });
    }

    // Surface the partial results gathered at this depth so already-completed
    // hops render while deeper hops are still loading.
    emit?.(direction, depth, maxDepth, 'tracing');

    // Handle unknown remainder
    const unknownFlow = flows.find(f => f.isUnknown);

    if (!unknownFlow) {
      // No unknown bucket at this depth. If we were following unknown addresses
      // from a previous hop, surface the pending terminus so funds do not
      // silently disappear from the display.
      //
      // Note: when some unknown addresses resolved to known entities at this
      // depth, those known entities are already included in `result`. The
      // terminus represents the *remaining* unresolved portion of the unknown
      // bucket; `computeOneHop` aggregates all unknown addresses so we cannot
      // trivially separate which ones were fully resolved vs. dead-ended —
      // surfacing the terminus ensures "honest totals" for the unresolved share.
      if (pendingUnknownTerminus !== null) {
        result.push({
          ...pendingUnknownTerminus.flow,
          hopDepth: pendingUnknownTerminus.depth,
          direction,
          pathAddresses: pendingUnknownTerminus.path,
        });
        pendingUnknownTerminus = null;
      }
      break;
    }

    const unknownAddrs = unknownFlow.unknownAddresses ?? [];

    if (unknownAddrs.length === 0 || depth >= maxDepth) {
      // Either no further addresses to follow, or budget exhausted.
      // Surface this unknown as the terminus so totals stay honest.
      // Discard any earlier pendingUnknownTerminus — the current hop's unknown
      // bucket is the deeper (more accurate) terminus to report.
      result.push({ ...unknownFlow, hopDepth: depth, direction, pathAddresses: pathSnapshot() });
      pendingUnknownTerminus = null;
      break;
    }

    // We have more depth budget and addresses to explore. Remember this
    // unknown flow in case the next hop dead-ends without its own unknown.
    // Capture the path *before* descending so the terminus reflects the chain
    // leading up to (not through) its own unknown bucket.
    pendingUnknownTerminus = { flow: unknownFlow, depth, path: pathSnapshot() };
    pendingAddresses = unknownAddrs;
    pathAddresses = [...pathAddresses, ...unknownAddrs];
  }

  // If we exited the loop normally (exhausted maxDepth) but still have a
  // pending terminus (shouldn't happen — handled inside loop — but guard it).
  if (pendingUnknownTerminus !== null) {
    result.push({
      ...pendingUnknownTerminus.flow,
      hopDepth: pendingUnknownTerminus.depth,
      direction,
      pathAddresses: pendingUnknownTerminus.path,
    });
  }
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
 * Build a human-readable description of an active date filter window,
 * e.g. "Showing Oct 1 – Dec 31, 2023", "Showing from Oct 1, 2023", or
 * "Showing through Dec 31, 2023". Returns null when no range is active.
 */
export function formatDateRange(range?: DateRange | null): string | null {
  if (!range) return null;
  const { start, end } = range;
  if (start != null && end != null) {
    return `Showing ${formatDate(start)} – ${formatDate(end)}`;
  }
  if (start != null) {
    return `Showing from ${formatDate(start)}`;
  }
  if (end != null) {
    return `Showing through ${formatDate(end)}`;
  }
  return null;
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

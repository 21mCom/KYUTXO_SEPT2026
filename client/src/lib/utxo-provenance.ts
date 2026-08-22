// UTXO Provenance — traces every unspent output backwards through the
// transactions we have on record, classifying each hop as a partial spend
// (some value left the wallet, the rest came back as change) or a wallet
// reorganization (self-transfer / consolidation between owned addresses).
//
// All functions here are pure: the page layer loads Dexie rows and passes
// them in, which keeps this module trivially testable in Node and free of
// any direct database access.

import type { BlockchainTransaction, TransactionParticipant } from './db-types';

// ---------------------------------------------------------------------------
// Unspent detection
// ---------------------------------------------------------------------------

export interface ProvenanceUtxo {
  /** `${txid}:${vout}` */
  id: string;
  txid: string;
  vout: number;
  address: string;
  amountSats: number;
  /** Unix SECONDS (blockchainTransactions.blockTime convention). */
  blockTime: number;
  blockHeight: number;
}

/**
 * Outpoint-first spent detection, mirroring the UTXOs page semantics: an
 * input carrying prevTxid/prevVout authoritatively spends that exact output;
 * inputs missing outpoint data fall back to FIFO address:amount matching so
 * legacy-synced data still roughly works. Outputs restricted to `owned`
 * addresses (the caller decides which addresses count as the wallet).
 */
export function computeUnspentUtxos(
  participants: TransactionParticipant[],
  txidToTx: Map<string, BlockchainTransaction>,
  isWalletAddress: (address: string) => boolean,
): ProvenanceUtxo[] {
  const outputs: TransactionParticipant[] = [];
  const fifoInputs: TransactionParticipant[] = [];
  const spentOutpoints = new Set<string>();

  for (const p of participants) {
    if (p.role === 'output') {
      outputs.push(p);
    } else if (p.role === 'input') {
      if (p.prevTxid != null && p.prevVout != null) {
        const tx = txidToTx.get(p.txid);
        if ((tx?.blockTime ?? 0) > 0) {
          spentOutpoints.add(`${p.prevTxid}:${p.prevVout}`);
        }
      } else {
        fifoInputs.push(p);
      }
    }
  }

  const timed = <T extends TransactionParticipant>(rows: T[]) =>
    rows
      .map((p) => ({ p, blockTime: txidToTx.get(p.txid)?.blockTime ?? 0 }))
      .filter((x) => x.blockTime > 0);

  const outputsWithTime = timed(outputs).sort((a, b) =>
    a.blockTime !== b.blockTime ? a.blockTime - b.blockTime : (a.p.vout ?? 0) - (b.p.vout ?? 0),
  );
  const inputsWithTime = timed(fifoInputs).sort((a, b) => a.blockTime - b.blockTime);

  const inputsByAddressAmount = new Map<string, { p: TransactionParticipant; blockTime: number }[]>();
  for (const item of inputsWithTime) {
    const key = `${item.p.address}:${item.p.amount}`;
    const list = inputsByAddressAmount.get(key);
    if (list) list.push(item);
    else inputsByAddressAmount.set(key, [item]);
  }

  const result: ProvenanceUtxo[] = [];
  const matchedInputIndices = new Map<string, number>();

  for (const { p: output, blockTime } of outputsWithTime) {
    if (!isWalletAddress(output.address)) continue;

    const outpoint = `${output.txid}:${output.vout ?? 0}`;
    if (spentOutpoints.has(outpoint)) continue;

    const key = `${output.address}:${output.amount}`;
    const matchingInputs = inputsByAddressAmount.get(key) ?? [];
    const currentIndex = matchedInputIndices.get(key) ?? 0;
    const spendingInput = matchingInputs.find(
      (item, idx) => idx >= currentIndex && item.blockTime > blockTime,
    );
    if (spendingInput) {
      matchedInputIndices.set(key, matchingInputs.indexOf(spendingInput) + 1);
      continue;
    }

    const tx = txidToTx.get(output.txid);
    result.push({
      id: outpoint,
      txid: output.txid,
      vout: output.vout ?? 0,
      address: output.address,
      amountSats: output.amount,
      blockTime,
      blockHeight: tx?.blockHeight ?? 0,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Hop classification
// ---------------------------------------------------------------------------

/**
 * How a hop transaction looks from the wallet's perspective:
 * - 'origin':        no owned inputs — coins arrived from outside the wallet
 * - 'partial-spend': owned inputs AND at least one non-owned output — part of
 *                    the value left the wallet, the rest returned as change
 * - 'wallet-reorg':  owned inputs and every output owned — self-transfer or
 *                    consolidation between the user's own addresses
 * - 'coinbase':      transaction has no inputs (mined directly)
 * - 'unknown':       inputs exist but ownership can't be determined (no
 *                    address data on any participant)
 */
export type HopClassification =
  | 'origin'
  | 'partial-spend'
  | 'wallet-reorg'
  | 'coinbase'
  | 'unknown';

/**
 * @param resolveInputAddress Optional fallback for inputs whose address field
 * is blank (Electrum syncs store inputs without prevout addresses). Given an
 * input, return the address of the output it spends (looked up via
 * prevTxid/prevVout) when known, so ownership can still be determined.
 */
export function classifyHop(
  inputs: TransactionParticipant[],
  outputs: TransactionParticipant[],
  isWalletAddress: (address: string) => boolean,
  resolveInputAddress?: (input: TransactionParticipant) => string | undefined,
): HopClassification {
  if (inputs.length === 0) return 'coinbase';

  let sawAddress = false;
  let ownedInputs = 0;
  for (const i of inputs) {
    const address = i.address || resolveInputAddress?.(i) || '';
    if (!address) continue;
    sawAddress = true;
    if (isWalletAddress(address)) ownedInputs++;
  }

  let ownedOutputs = 0;
  let addressedOutputs = 0;
  for (const o of outputs) {
    if (!o.address) continue;
    sawAddress = true;
    addressedOutputs++;
    if (isWalletAddress(o.address)) ownedOutputs++;
  }

  if (!sawAddress) return 'unknown';
  if (ownedInputs === 0) return 'origin';
  if (addressedOutputs > 0 && ownedOutputs === addressedOutputs) return 'wallet-reorg';
  return 'partial-spend';
}

// ---------------------------------------------------------------------------
// Provenance walk
// ---------------------------------------------------------------------------

export type HopStopReason =
  | 'coinbase'          // reached a coinbase transaction
  | 'no-outpoint-data'  // inputs lack prevTxid/prevVout, cannot walk further
  | 'no-tx-record'      // an input references a transaction we never synced
  | 'depth-cap'         // stopped at the depth cap
  | 'ancestor-cap';     // stopped at the ancestor count cap

export interface ProvenanceHop {
  /** 1 = the transaction that created this UTXO, 2 = its inputs' creators, … */
  depth: number;
  txid: string;
  /** Unix SECONDS; 0 when unknown. */
  blockTime: number;
  blockHeight: number;
  classification: HopClassification;
  feeSats: number;
  inputCount: number;
  outputCount: number;
  totalInputSats: number;
  totalOutputSats: number;
  ownedInputCount: number;
  ownedOutputCount: number;
  /** Why this branch of the walk stops here, if it does. */
  stopReason?: HopStopReason;
}

export interface UtxoProvenanceResult {
  utxo: ProvenanceUtxo;
  /** All known ancestor hops, sorted by depth then blockTime. */
  hops: ProvenanceHop[];
  /** Longest fully-recorded chain length (1 = only the creating tx). */
  hopsBack: number;
  /** Whether any branch hit a walk cap. */
  truncated: boolean;
  /** Distinct classifications seen across all hops. */
  classifications: HopClassification[];
  /** Oldest known hop date (unix seconds), 0 when none. */
  oldestHopTime: number;
  /** Most recent hop date (unix seconds), 0 when none. */
  newestHopTime: number;
}

export const MAX_HOP_DEPTH = 25;
export const MAX_ANCESTORS = 200;

export interface ProvenanceWalkContext {
  txByTxid: Map<string, BlockchainTransaction>;
  participantsByTxid: Map<string, { inputs: TransactionParticipant[]; outputs: TransactionParticipant[] }>;
  isWalletAddress: (address: string) => boolean;
}

export interface TraceOptions {
  /** Override MAX_HOP_DEPTH (tests). */
  maxDepth?: number;
  /** Override MAX_ANCESTORS (tests). */
  maxAncestors?: number;
}

/**
 * Walk one UTXO backwards. Each transaction on the way is one hop; a hop's
 * inputs' prevouts lead to the next hop level. Shared `classificationCache`
 * lets repeated calls across many UTXOs skip re-classifying the same tx.
 */
export function traceUtxoProvenance(
  utxo: ProvenanceUtxo,
  ctx: ProvenanceWalkContext,
  classificationCache: Map<string, HopClassification> = new Map(),
  options: TraceOptions = {},
): UtxoProvenanceResult {
  const maxDepth = options.maxDepth ?? MAX_HOP_DEPTH;
  const maxAncestors = options.maxAncestors ?? MAX_ANCESTORS;
  const hops: ProvenanceHop[] = [];
  const visited = new Set<string>();
  // Txs that produced a hop record. `visited` also holds txs we looked at but
  // could not record (missing record, ancestor cap) — the stop-reason audit
  // below keys on `recorded`, not `visited`.
  const recorded = new Set<string>();
  let truncated = false;

  // Resolve the address an input spends from, for Electrum-synced inputs that
  // carry a blank address but do carry the prevout reference.
  const resolveInputAddress = (input: TransactionParticipant): string | undefined => {
    if (input.prevTxid == null || input.prevVout == null) return undefined;
    const prev = ctx.participantsByTxid.get(input.prevTxid);
    return prev?.outputs.find((o) => (o.vout ?? 0) === input.prevVout)?.address;
  };
  const isOwnedInput = (input: TransactionParticipant): boolean => {
    const address = input.address || resolveInputAddress(input) || '';
    return address !== '' && ctx.isWalletAddress(address);
  };

  const classify = (txid: string): HopClassification => {
    const cached = classificationCache.get(txid);
    if (cached) return cached;
    const parts = ctx.participantsByTxid.get(txid);
    const c = classifyHop(parts?.inputs ?? [], parts?.outputs ?? [], ctx.isWalletAddress, resolveInputAddress);
    classificationCache.set(txid, c);
    return c;
  };

  // BFS queue of transactions to visit at each depth.
  let frontier: string[] = [utxo.txid];
  let depth = 1;

  while (frontier.length > 0 && depth <= maxDepth) {
    const nextFrontier = new Set<string>();

    for (const txid of frontier) {
      if (visited.has(txid)) continue;
      visited.add(txid);
      if (hops.length >= maxAncestors) {
        truncated = true;
        break;
      }

      const tx = ctx.txByTxid.get(txid);
      if (!tx) {
        // An input pointed at a transaction we never synced.
        continue;
      }

      const parts = ctx.participantsByTxid.get(txid) ?? { inputs: [], outputs: [] };
      const classification = classify(txid);
      const totalInputSats = parts.inputs.reduce((s, p) => s + p.amount, 0);
      const totalOutputSats = parts.outputs.reduce((s, p) => s + p.amount, 0);

      let stopReason: HopStopReason | undefined;
      if (classification === 'coinbase') {
        stopReason = 'coinbase';
      } else if (depth >= maxDepth) {
        stopReason = 'depth-cap';
        truncated = true;
      } else {
        // Queue every input's creating transaction for the next level.
        let hasOutpoint = false;
        for (const input of parts.inputs) {
          if (input.prevTxid != null && input.prevVout != null) {
            hasOutpoint = true;
            if (!visited.has(input.prevTxid)) nextFrontier.add(input.prevTxid);
          }
        }
        if (!hasOutpoint) {
          stopReason = 'no-outpoint-data';
        }
      }

      recorded.add(txid);
      hops.push({
        depth,
        txid,
        blockTime: tx.blockTime ?? 0,
        blockHeight: tx.blockHeight ?? 0,
        classification,
        feeSats: tx.fee ?? 0,
        inputCount: parts.inputs.length,
        outputCount: parts.outputs.length,
        totalInputSats,
        totalOutputSats,
        ownedInputCount: parts.inputs.filter(isOwnedInput).length,
        ownedOutputCount: parts.outputs.filter((p) => p.address && ctx.isWalletAddress(p.address)).length,
        stopReason,
      });
    }

    if (hops.length >= maxAncestors) truncated = true;
    frontier = Array.from(nextFrontier);
    depth++;
  }

  if (frontier.length > 0 && depth > maxDepth) truncated = true;

  // Post-pass audit: every recorded hop whose trail stops without a reason
  // gets one. A branch stops when an input's prevout transaction never
  // produced a hop — either because it isn't on record at all
  // ('no-tx-record') or because the ancestor cap cut the walk short
  // ('ancestor-cap'). Keyed on `recorded`, not `visited`: visited also holds
  // txs that were looked at but could not be recorded.
  for (const hop of hops) {
    if (hop.stopReason) continue;
    const parts = ctx.participantsByTxid.get(hop.txid);
    if (!parts) continue;
    for (const input of parts.inputs) {
      if (input.prevTxid == null || input.prevVout == null) continue;
      if (recorded.has(input.prevTxid)) continue;
      hop.stopReason = ctx.txByTxid.has(input.prevTxid) ? 'ancestor-cap' : 'no-tx-record';
      break;
    }
  }

  hops.sort((a, b) =>
    a.depth !== b.depth ? a.depth - b.depth : a.blockTime !== b.blockTime ? a.blockTime - b.blockTime : a.txid.localeCompare(b.txid),
  );

  const hopsBack = hops.reduce((max, h) => Math.max(max, h.depth), 0);
  const times = hops.map((h) => h.blockTime).filter((t) => t > 0);
  const classifications = Array.from(new Set(hops.map((h) => h.classification)));

  return {
    utxo,
    hops,
    hopsBack,
    truncated,
    classifications,
    oldestHopTime: times.length > 0 ? Math.min(...times) : 0,
    newestHopTime: times.length > 0 ? Math.max(...times) : 0,
  };
}

/**
 * Trace provenance for many UTXOs in one pass, sharing the classification
 * cache. `onProgress(processed, total)` fires per UTXO; return a promise from
 * the walk driver (the page) so the caller can yield to the UI between
 * batches — this function itself is synchronous per UTXO.
 */
export function traceManyUtxos(
  utxos: ProvenanceUtxo[],
  ctx: ProvenanceWalkContext,
  options: TraceOptions = {},
): UtxoProvenanceResult[] {
  const cache = new Map<string, HopClassification>();
  return utxos.map((u) => traceUtxoProvenance(u, ctx, cache, options));
}

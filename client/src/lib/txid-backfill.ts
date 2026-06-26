// Txid-driven backfill engine
//
// Finds transaction records that have a valid Bitcoin txid as their inputString
// but have no matching row in blockchainTransactions (because the backup that
// created them pre-dates on-chain caching, or the user added them manually and
// never ran a sync). For each such "orphaned" record it fetches the raw
// transaction directly by txid, writes the blockchainTransactions row and all
// transactionParticipants through the CRUD layer, and links participants to any
// existing records (addresses or the transaction record itself) by inputString.
//
// CRUD constraint: all writes go through transaction-crud.ts as required by the
// crud-guards validation step.

import {
  db,
  type Record,
  type TransactionParticipant,
  type ScriptType,
} from './database';
import {
  createProviderFromSettings,
  parseTransaction,
  MINIMUM_CONFIRMATIONS,
} from './blockchain-api';
import {
  addTransaction,
  bulkAddParticipants,
  bulkPutParticipants,
  getTransactionByTxid,
} from './data/transaction-crud';
import { getNodeSettings } from './data/node-settings-crud';
import type { BlockchainProvider, ParsedTransaction } from './blockchain-api';

// ─── Public result types ────────────────────────────────────────────────────

export interface BackfillProgress {
  phase: 'scanning' | 'fetching' | 'resolving' | 'complete' | 'deferred';
  orphansFound: number;
  processed: number;
  rebuilt: number;
  skipped: number;
  failed: number;
  currentTxid?: string;
  message?: string;
  /**
   * During the 'resolving' phase: number of input rows whose address has been
   * written so far. Undefined until the bulk-write stage begins.
   */
  resolveProcessed?: number;
  /**
   * During the 'resolving' phase: total number of resolvable input rows to be
   * written. Undefined until the bulk-write stage begins.
   */
  resolveTotal?: number;
  /**
   * During the 'resolving' phase: number of previous transactions fetched from
   * the provider so far. Undefined unless the prevout fetch loop is running.
   */
  fetchProcessed?: number;
  /**
   * During the 'resolving' phase: total number of previous transactions that
   * need fetching from the provider. Undefined unless the fetch loop is running.
   */
  fetchTotal?: number;
}

export type BackfillProgressCallback = (progress: BackfillProgress) => void;

export interface BackfillResult {
  orphansFound: number;
  rebuilt: number;
  skipped: number;
  failed: number;
  /** Number of blank input addresses filled in by prevout resolution. */
  prevoutsResolved: number;
  deferred: boolean;
  deferReason?: string;
  errors: string[];
}

export interface BackfillOptions {
  signal?: AbortSignal;
  onProgress?: BackfillProgressCallback;
  concurrency?: number;
}

// ─── Validation ─────────────────────────────────────────────────────────────

const TXID_RE = /^[0-9a-f]{64}$/i;

function isValidTxid(s: string | undefined): boolean {
  return typeof s === 'string' && TXID_RE.test(s);
}

// ─── Detection ──────────────────────────────────────────────────────────────

/**
 * Returns the set of txids for transaction records that have no corresponding
 * row in blockchainTransactions. Processes in batches to stay responsive.
 */
export async function detectOrphanedTxRecords(): Promise<{
  txids: string[];
  recordIds: Map<string, number>;
}> {
  const SCAN_BATCH = 500;
  let lastId = 0;
  const orphanTxids: string[] = [];
  const txidToRecordId = new Map<string, number>();

  for (;;) {
    const batch: Record[] = await db.records
      .where('[type+id]')
      .between(['transaction', lastId], ['transaction', Infinity], false, true)
      .limit(SCAN_BATCH)
      .toArray();

    if (batch.length === 0) break;

    const candidateTxids: string[] = [];
    const candidateMap = new Map<string, number>(); // txid → recordId

    for (const r of batch) {
      if (r.id !== undefined && isValidTxid(r.inputString)) {
        candidateTxids.push(r.inputString!);
        candidateMap.set(r.inputString!, r.id);
      }
      lastId = r.id ?? lastId;
    }

    if (candidateTxids.length > 0) {
      // Check which ones already have a blockchain row
      const existing = await db.blockchainTransactions
        .where('txid')
        .anyOf(candidateTxids)
        .toArray();
      const existingSet = new Set(existing.map(tx => tx.txid));

      for (const txid of candidateTxids) {
        if (!existingSet.has(txid)) {
          orphanTxids.push(txid);
          txidToRecordId.set(txid, candidateMap.get(txid)!);
        }
      }
    }

    if (batch.length < SCAN_BATCH) break;

    // Yield between batches so the UI stays responsive
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  return { txids: orphanTxids, recordIds: txidToRecordId };
}

// ─── Backfill engine ─────────────────────────────────────────────────────────

/**
 * For a single parsed transaction, writes the blockchainTransactions row and
 * all transactionParticipants. Returns true if written, false if a row already
 * existed (idempotent guard).
 */
async function writeOnChainData(
  parsed: ParsedTransaction,
): Promise<boolean> {
  // Double-check: never create a second row for a txid that already has one
  const alreadyExists = await getTransactionByTxid(parsed.txid);
  if (alreadyExists) return false;

  // Write the blockchain transaction row
  await addTransaction({
    txid: parsed.txid,
    blockHeight: parsed.blockHeight,
    blockTime: parsed.blockTime,
    fee: parsed.fee,
    feeRate: parsed.feeRate,
    syncedAt: Date.now(),
    size: parsed.size,
    weight: parsed.weight,
    vsize: parsed.vsize,
    hasOpReturn: parsed.hasOpReturn,
    opReturnData: parsed.opReturnData.length > 0 ? parsed.opReturnData : undefined,
    // Wallet fingerprinting fields (populated when the API returns version/locktime/sequence)
    rawFingerprintCaptured: parsed.rawFingerprintCaptured,
    nVersion: parsed.nVersion,
    nLockTime: parsed.nLockTime,
    hasRbf: parsed.hasRbf,
    isBip69Ordered: parsed.isBip69Ordered,
    hasWitness: parsed.hasWitness,
    hasCoinbaseInput: parsed.hasCoinbaseInput,
    hasLowRSig: parsed.hasLowRSig,
    hasMixedWitness: parsed.hasMixedWitness,
  }, { skipNotification: true });

  // Build participant rows. For each address, look up an existing record by
  // inputString so we can set recordId (links participant to metadata).
  const allAddresses: string[] = [];
  for (const inp of parsed.inputs) {
    if (inp.address) allAddresses.push(inp.address);
  }
  for (const out of parsed.outputs) {
    if (out.address) allAddresses.push(out.address);
  }
  // Also look up the txid itself (there is a transaction record for it)
  allAddresses.push(parsed.txid);

  const addressToRecordId = new Map<string, number>();
  const dedupedAddresses = Array.from(new Set(allAddresses));
  // Batch lookups in chunks of 500
  for (let i = 0; i < dedupedAddresses.length; i += 500) {
    const chunk = dedupedAddresses.slice(i, i + 500);
    const found = await db.records
      .where('inputString')
      .anyOf(chunk)
      .toArray();
    for (const r of found) {
      if (r.id !== undefined && r.inputString) {
        addressToRecordId.set(r.inputString, r.id);
      }
    }
  }

  const participants: Parameters<typeof bulkAddParticipants>[0] = [];

  for (const inp of parsed.inputs) {
    participants.push({
      txid: parsed.txid,
      role: 'input',
      address: inp.address,
      amount: inp.amount,
      recordId: inp.address ? addressToRecordId.get(inp.address) : undefined,
      scriptType: inp.scriptType,
      prevTxid: inp.prevTxid,
      prevVout: inp.prevVout,
    });
  }

  for (const out of parsed.outputs) {
    participants.push({
      txid: parsed.txid,
      role: 'output',
      address: out.address,
      amount: out.amount,
      vout: out.vout,
      recordId: addressToRecordId.get(out.address),
      scriptType: out.scriptType,
    });
  }

  if (participants.length > 0) {
    await bulkAddParticipants(participants, { skipNotification: true });
  }

  return true;
}

/**
 * Main backfill function. Fetches each orphaned txid from the blockchain
 * provider and writes the on-chain data through CRUD modules. Processes in
 * parallel batches (default concurrency = 4) with per-item error isolation.
 *
 * Returns a result summary. Callers should call detectOrphanedTxRecords()
 * first if they want the orphan count before calling this.
 */
export async function runTxidBackfill(
  provider: BlockchainProvider,
  txids: string[],
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const { signal, onProgress, concurrency = 4 } = options;

  const result: BackfillResult = {
    orphansFound: txids.length,
    rebuilt: 0,
    skipped: 0,
    failed: 0,
    prevoutsResolved: 0,
    deferred: false,
    errors: [],
  };

  if (txids.length === 0) return result;

  let processed = 0;
  // Track which txids actually got new on-chain rows written so prevout
  // resolution only scans the participants we just created.
  const rebuiltTxids: string[] = [];

  const reportProgress = (currentTxid?: string) => {
    onProgress?.({
      phase: 'fetching',
      orphansFound: txids.length,
      processed,
      rebuilt: result.rebuilt,
      skipped: result.skipped,
      failed: result.failed,
      currentTxid,
    });
  };

  reportProgress();

  // Get the current block height once (for confirmation check)
  let currentHeight = 0;
  try {
    currentHeight = await provider.getBlockHeight();
  } catch {
    // If we can't get block height, we'll skip the confirmation check
    currentHeight = 0;
  }

  for (let i = 0; i < txids.length; i += concurrency) {
    if (signal?.aborted) break;

    const chunk = txids.slice(i, i + concurrency);

    const chunkResults = await Promise.allSettled(
      chunk.map(async (txid) => {
        // Guard: check again in case a concurrent run already wrote this row
        const alreadyHasRow = await getTransactionByTxid(txid);
        if (alreadyHasRow) {
          return { txid, status: 'skipped' as const };
        }

        const rawTx = await provider.getTransaction(txid);
        if (!rawTx) {
          return { txid, status: 'skipped' as const, reason: 'not-found' };
        }

        if (!rawTx.status.confirmed) {
          return { txid, status: 'skipped' as const, reason: 'unconfirmed' };
        }

        // Confirmation check (only if we have a valid block height)
        if (currentHeight > 0 && rawTx.status.block_height) {
          const confirmations = currentHeight - rawTx.status.block_height;
          if (confirmations < MINIMUM_CONFIRMATIONS) {
            return { txid, status: 'skipped' as const, reason: 'insufficient-confirmations' };
          }
        }

        const parsed = parseTransaction(rawTx);
        if (!parsed) {
          return { txid, status: 'skipped' as const, reason: 'parse-failed' };
        }

        const written = await writeOnChainData(parsed);
        return { txid, status: written ? 'rebuilt' : 'skipped' };
      })
    );

    for (let j = 0; j < chunkResults.length; j++) {
      const r = chunkResults[j];
      const txid = chunk[j];
      if (r.status === 'fulfilled') {
        if (r.value.status === 'rebuilt') {
          result.rebuilt++;
          rebuiltTxids.push(txid);
        } else {
          result.skipped++;
        }
      } else {
        result.failed++;
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        result.errors.push(`${txid.slice(0, 8)}…: ${msg}`);
      }
      processed++;
      reportProgress(txid);
    }

    // Yield between batches
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  // After importing, resolve any blank input addresses for the participants we
  // just wrote. The txid-driven path writes inputs straight from the raw tx,
  // which may lack prevout addresses (same gap the full sync closes with its
  // own resolvePrevouts() pass). Errors here never fail the backfill.
  if (!signal?.aborted && rebuiltTxids.length > 0) {
    try {
      onProgress?.({
        phase: 'resolving',
        orphansFound: txids.length,
        processed,
        rebuilt: result.rebuilt,
        skipped: result.skipped,
        failed: result.failed,
        message: 'Resolving input addresses…',
      });
      result.prevoutsResolved = await resolveBackfillPrevouts(
        provider,
        rebuiltTxids,
        {
          signal,
          concurrency,
          onFetchProgress: (fetchProcessed, fetchTotal) => {
            onProgress?.({
              phase: 'resolving',
              orphansFound: txids.length,
              processed,
              rebuilt: result.rebuilt,
              skipped: result.skipped,
              failed: result.failed,
              message: 'Fetching previous transactions…',
              fetchProcessed,
              fetchTotal,
            });
          },
          onWriteProgress: (resolveProcessed, resolveTotal) => {
            onProgress?.({
              phase: 'resolving',
              orphansFound: txids.length,
              processed,
              rebuilt: result.rebuilt,
              skipped: result.skipped,
              failed: result.failed,
              message: 'Resolving input addresses…',
              resolveProcessed,
              resolveTotal,
            });
          },
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`prevout resolution: ${msg}`);
    }
  }

  onProgress?.({
    phase: 'complete',
    orphansFound: txids.length,
    processed,
    rebuilt: result.rebuilt,
    skipped: result.skipped,
    failed: result.failed,
  });

  return result;
}

/**
 * Resolves blank input addresses for the given (just-rebuilt) txids.
 *
 * Inputs written by the txid backfill may have no address when the raw
 * transaction did not include prevout data. For each such input we look up the
 * referenced previous output — first from participant rows we already hold
 * locally, then by fetching the previous transaction from the provider — and
 * fill in the address, amount, scriptType, and recordId.
 *
 * This is a slimmed, standalone equivalent of
 * TransactionSyncService.resolvePrevouts(): it is scoped to the txids we just
 * wrote (instead of every input in the database) and uses the provider already
 * configured for the backfill, so no second TransactionSyncService instance is
 * created. All writes go through transaction-crud.ts.
 *
 * Returns the number of inputs whose address was filled in.
 */
async function resolveBackfillPrevouts(
  provider: BlockchainProvider,
  txids: string[],
  options: {
    signal?: AbortSignal;
    concurrency?: number;
    onFetchProgress?: (fetched: number, total: number) => void;
    onWriteProgress?: (written: number, total: number) => void;
  } = {},
): Promise<number> {
  const { signal, concurrency = 4, onFetchProgress, onWriteProgress } = options;

  // Collect the input participants for the rebuilt txids that still need an
  // address but carry a prevout reference we can chase.
  const unresolvedInputs: TransactionParticipant[] = [];
  for (let i = 0; i < txids.length; i += 500) {
    if (signal?.aborted) return 0;
    const batch = txids.slice(i, i + 500);
    const inputs = await db.transactionParticipants
      .where('txid')
      .anyOf(batch)
      .and(p => p.role === 'input')
      .toArray();
    for (const p of inputs) {
      if (
        (!p.address || p.address === '') &&
        p.prevTxid !== undefined &&
        p.prevVout !== undefined
      ) {
        unresolvedInputs.push(p);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  // Forward the shared core's fetch- and write-phase progress hooks so the
  // manual backfill UI can show a progress bar both while fetching missing
  // previous transactions over the network and during the final, cancellable
  // write phase.
  return resolveUnresolvedInputs(provider, unresolvedInputs, {
    signal,
    concurrency,
    onFetchProgress,
    onWriteProgress,
  });
}

/**
 * Shared core of prevout resolution. Given a list of input participants that
 * lack an address but carry a prevout reference (`prevTxid`/`prevVout`), this
 * resolves each referenced previous output — first from participant rows we
 * already hold locally, then by fetching the previous transaction from the
 * provider — and fills in the address, amount, scriptType, and recordId.
 *
 * Both the scoped backfill path (resolveBackfillPrevouts) and the whole-
 * database pass (resolveAllBlankPrevouts) feed their unresolved inputs through
 * here so the cache/fetch/link/write logic lives in one place. All writes go
 * through transaction-crud.ts.
 *
 * Returns the number of inputs whose address was filled in.
 */
async function resolveUnresolvedInputs(
  provider: BlockchainProvider,
  unresolvedInputs: TransactionParticipant[],
  options: {
    signal?: AbortSignal;
    concurrency?: number;
    onFetchProgress?: (fetched: number, total: number) => void;
    onWriteProgress?: (written: number, total: number) => void;
  } = {},
): Promise<number> {
  const { signal, concurrency = 4, onFetchProgress, onWriteProgress } = options;

  if (unresolvedInputs.length === 0) return 0;

  // Build a cache of previous outputs from participant rows we already have.
  const outputCache = new Map<string, { address: string; amount: number; scriptType?: ScriptType }>();
  const prevTxids = new Set<string>();
  for (const inp of unresolvedInputs) {
    if (inp.prevTxid) prevTxids.add(inp.prevTxid);
  }
  const prevTxidArr = Array.from(prevTxids);
  for (let i = 0; i < prevTxidArr.length; i += 500) {
    if (signal?.aborted) return 0;
    const batch = prevTxidArr.slice(i, i + 500);
    const outputs = await db.transactionParticipants
      .where('txid')
      .anyOf(batch)
      .and(p => p.role === 'output')
      .toArray();
    for (const o of outputs) {
      if (o.vout !== undefined) {
        outputCache.set(`${o.txid}:${o.vout}`, {
          address: o.address,
          amount: Number(o.amount) || 0,
          scriptType: o.scriptType,
        });
      }
    }
  }

  // Determine which previous transactions we still need to fetch.
  const needFetch = new Set<string>();
  for (const inp of unresolvedInputs) {
    const key = `${inp.prevTxid}:${inp.prevVout}`;
    if (!outputCache.has(key) && inp.prevTxid) {
      needFetch.add(inp.prevTxid);
    }
  }

  if (needFetch.size > 0) {
    const fetchArr = Array.from(needFetch);
    let fetched = 0;
    onFetchProgress?.(0, fetchArr.length);
    for (let i = 0; i < fetchArr.length; i += concurrency) {
      if (signal?.aborted) break;
      const chunk = fetchArr.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        chunk.map(txid => provider.getTransaction(txid).then(apiTx => ({ txid, apiTx }))),
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.apiTx) {
          const { txid, apiTx } = r.value;
          for (const vout of apiTx.vout) {
            if (vout.scriptpubkey_address) {
              outputCache.set(`${txid}:${vout.n}`, {
                address: vout.scriptpubkey_address,
                amount: vout.value,
                scriptType: vout.scriptpubkey_type as ScriptType,
              });
            }
          }
        }
      }
      fetched += chunk.length;
      onFetchProgress?.(Math.min(fetched, fetchArr.length), fetchArr.length);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  // Map resolved addresses to existing record ids so participants stay linked.
  const resolvedAddresses = new Set<string>();
  for (const inp of unresolvedInputs) {
    const resolved = outputCache.get(`${inp.prevTxid}:${inp.prevVout}`);
    if (resolved?.address) resolvedAddresses.add(resolved.address);
  }

  const addressToRecordId = new Map<string, number>();
  const addrArr = Array.from(resolvedAddresses);
  for (let i = 0; i < addrArr.length; i += 500) {
    const batch = addrArr.slice(i, i + 500);
    const records = await db.records
      .where('inputString')
      .anyOf(batch)
      .toArray();
    for (const r of records) {
      if (r.id !== undefined && r.inputString) {
        addressToRecordId.set(r.inputString, r.id);
      }
    }
  }

  // Build the updated participant rows.
  const updated: TransactionParticipant[] = [];
  for (const inp of unresolvedInputs) {
    const resolved = outputCache.get(`${inp.prevTxid}:${inp.prevVout}`);
    if (resolved?.address && inp.id) {
      updated.push({
        ...inp,
        address: resolved.address,
        amount: resolved.amount,
        scriptType: resolved.scriptType,
        recordId: addressToRecordId.get(resolved.address),
      });
    }
  }

  if (updated.length === 0) return 0;

  // Final bulk-write phase. This can take a while for large backfills, so we
  // check the abort signal between batches (prompt cancellation) and report
  // incremental progress. Each completed batch is committed, so stopping early
  // leaves the DB consistent — a re-run resumes from the still-unresolved rows.
  const total = updated.length;
  let written = 0;
  onWriteProgress?.(written, total);
  for (let i = 0; i < updated.length; i += 200) {
    if (signal?.aborted) return written;
    const batch = updated.slice(i, i + 200);
    await bulkPutParticipants(batch, { skipNotification: true });
    written += batch.length;
    onWriteProgress?.(written, total);
    // Yield between batches so cancellation and the UI stay responsive.
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  return written;
}

// ─── Whole-database blank-input resolution ───────────────────────────────────

export interface ResolveAllInputsProgress {
  phase: 'scanning' | 'resolving' | 'complete';
  /** Unresolved blank inputs discovered so far (or total once scanning ends). */
  unresolvedFound: number;
  /** Previous transactions fetched from the provider so far. */
  fetched: number;
  /** Total previous transactions that need fetching (known after scanning). */
  totalToFetch: number;
}

export type ResolveAllInputsProgressCallback = (progress: ResolveAllInputsProgress) => void;

export interface ResolveAllInputsResult {
  /** Number of blank inputs found that carried a chaseable prevout reference. */
  unresolvedFound: number;
  /** Number of inputs whose address was actually filled in. */
  resolved: number;
  deferred: boolean;
  deferReason?: string;
  errors: string[];
}

export interface ResolveAllInputsOptions {
  signal?: AbortSignal;
  onProgress?: ResolveAllInputsProgressCallback;
  concurrency?: number;
}

/**
 * Scans the entire database for input participants that still have a blank
 * address but carry a prevout reference, and resolves them through the shared
 * resolution core. Unlike resolveBackfillPrevouts (scoped to a freshly-rebuilt
 * set of txids), this covers transactions rebuilt by earlier backfills that
 * pre-date the automatic resolution step.
 *
 * Returns the number of inputs whose address was filled in.
 */
async function resolveAllBlankPrevouts(
  provider: BlockchainProvider,
  options: ResolveAllInputsOptions = {},
): Promise<{ unresolvedFound: number; resolved: number }> {
  const { signal, onProgress, concurrency = 4 } = options;

  // Scan every input participant by id keyset, collecting only those that are
  // blank but reference a previous output we can chase. Keyset paging keeps the
  // UI responsive on databases with millions of participant rows.
  const SCAN_BATCH = 1000;
  let lastId = 0;
  const unresolvedInputs: TransactionParticipant[] = [];

  for (;;) {
    if (signal?.aborted) break;
    const batch = await db.transactionParticipants
      .where('id')
      .above(lastId)
      .limit(SCAN_BATCH)
      .toArray();

    if (batch.length === 0) break;

    for (const p of batch) {
      if (p.id !== undefined) lastId = p.id;
      if (
        p.role === 'input' &&
        (!p.address || p.address === '') &&
        p.prevTxid !== undefined &&
        p.prevVout !== undefined
      ) {
        unresolvedInputs.push(p);
      }
    }

    onProgress?.({
      phase: 'scanning',
      unresolvedFound: unresolvedInputs.length,
      fetched: 0,
      totalToFetch: 0,
    });

    if (batch.length < SCAN_BATCH) break;
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  if (signal?.aborted || unresolvedInputs.length === 0) {
    return { unresolvedFound: unresolvedInputs.length, resolved: 0 };
  }

  const resolved = await resolveUnresolvedInputs(provider, unresolvedInputs, {
    signal,
    concurrency,
    onFetchProgress: (fetched, total) => {
      onProgress?.({
        phase: 'resolving',
        unresolvedFound: unresolvedInputs.length,
        fetched,
        totalToFetch: total,
      });
    },
  });

  return { unresolvedFound: unresolvedInputs.length, resolved };
}

/**
 * High-level convenience for the Settings "Resolve Input Addresses" action:
 * builds a provider from stored node settings, then resolves all remaining
 * blank input addresses across the whole database. If no node is configured or
 * connectivity fails, returns a deferred result instead of throwing.
 */
export async function resolveAllBlankInputAddresses(
  options: ResolveAllInputsOptions = {},
): Promise<ResolveAllInputsResult> {
  const { signal, onProgress } = options;

  // Build a provider from stored node settings (mirrors detectAndBackfill()).
  let provider: BlockchainProvider;
  try {
    const nodeSettings = await getNodeSettings('default');
    if (!nodeSettings) {
      return {
        unresolvedFound: 0,
        resolved: 0,
        deferred: true,
        deferReason: 'No node settings configured. Configure a blockchain provider in Settings to resolve input addresses.',
        errors: [],
      };
    }
    provider = createProviderFromSettings(nodeSettings);

    // Quick connectivity probe
    await provider.getBlockHeight();
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Connection failed';
    return {
      unresolvedFound: 0,
      resolved: 0,
      deferred: true,
      deferReason: `Could not connect to blockchain provider: ${msg}. Try again when a blockchain node is reachable.`,
      errors: [],
    };
  }

  if (signal?.aborted) {
    return { unresolvedFound: 0, resolved: 0, deferred: false, errors: [] };
  }

  const errors: string[] = [];
  try {
    const { unresolvedFound, resolved } = await resolveAllBlankPrevouts(provider, options);
    onProgress?.({
      phase: 'complete',
      unresolvedFound,
      fetched: 0,
      totalToFetch: 0,
    });
    return { unresolvedFound, resolved, deferred: false, errors };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(msg);
    return { unresolvedFound: 0, resolved: 0, deferred: false, errors };
  }
}

/**
 * High-level convenience: detect orphans, create provider from stored node
 * settings, run the backfill. If connectivity fails or no node is configured,
 * returns a deferred result instead of throwing.
 */
export async function detectAndBackfill(
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const { signal, onProgress } = options;

  onProgress?.({
    phase: 'scanning',
    orphansFound: 0,
    processed: 0,
    rebuilt: 0,
    skipped: 0,
    failed: 0,
    message: 'Scanning for orphaned transaction records…',
  });

  const { txids, recordIds: _recordIds } = await detectOrphanedTxRecords();

  if (txids.length === 0) {
    onProgress?.({
      phase: 'complete',
      orphansFound: 0,
      processed: 0,
      rebuilt: 0,
      skipped: 0,
      failed: 0,
    });
    return {
      orphansFound: 0,
      rebuilt: 0,
      skipped: 0,
      failed: 0,
      prevoutsResolved: 0,
      deferred: false,
      errors: [],
    };
  }

  // Try to build a provider from stored node settings
  let provider: BlockchainProvider;
  try {
    const nodeSettings = await getNodeSettings('default');
    if (!nodeSettings) {
      return {
        orphansFound: txids.length,
        rebuilt: 0,
        skipped: 0,
        failed: 0,
        prevoutsResolved: 0,
        deferred: true,
        deferReason: 'No node settings configured. Configure a blockchain provider in Settings to rebuild missing transaction data.',
        errors: [],
      };
    }
    provider = createProviderFromSettings(nodeSettings);

    // Quick connectivity probe
    await provider.getBlockHeight();
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Connection failed';
    return {
      orphansFound: txids.length,
      rebuilt: 0,
      skipped: 0,
      failed: 0,
      prevoutsResolved: 0,
      deferred: true,
      deferReason: `Could not connect to blockchain provider: ${msg}. You can rebuild missing transaction data later from Settings > Data Management.`,
      errors: [],
    };
  }

  if (signal?.aborted) {
    return {
      orphansFound: txids.length,
      rebuilt: 0,
      skipped: 0,
      failed: 0,
      prevoutsResolved: 0,
      deferred: false,
      errors: [],
    };
  }

  return runTxidBackfill(provider, txids, options);
}

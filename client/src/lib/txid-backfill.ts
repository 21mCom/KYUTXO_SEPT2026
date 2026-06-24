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
} from './database';
import {
  createProviderFromSettings,
  parseTransaction,
  MINIMUM_CONFIRMATIONS,
} from './blockchain-api';
import {
  addTransaction,
  bulkAddParticipants,
  getTransactionByTxid,
} from './data/transaction-crud';
import { getNodeSettings } from './data/node-settings-crud';
import type { BlockchainProvider, ParsedTransaction } from './blockchain-api';

// ─── Public result types ────────────────────────────────────────────────────

export interface BackfillProgress {
  phase: 'scanning' | 'fetching' | 'complete' | 'deferred';
  orphansFound: number;
  processed: number;
  rebuilt: number;
  skipped: number;
  failed: number;
  currentTxid?: string;
  message?: string;
}

export type BackfillProgressCallback = (progress: BackfillProgress) => void;

export interface BackfillResult {
  orphansFound: number;
  rebuilt: number;
  skipped: number;
  failed: number;
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
    deferred: false,
    errors: [],
  };

  if (txids.length === 0) return result;

  let processed = 0;

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
      deferred: false,
      errors: [],
    };
  }

  return runTxidBackfill(provider, txids, options);
}

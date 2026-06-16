// ============================================================================
// Large-scale synthetic vault generator (DEVELOPER TOOL ONLY)
// ============================================================================
//
// For months, scale fixes shipped looking "done" on a tiny dev database, then
// fell over on the real vault (100k+ records, ~10M transactions, ~20M
// participants). The root cause of the cycle is that nothing was ever exercised
// at real scale. This module is the missing foundation: it builds a realistic,
// huge synthetic vault on demand so every later fix becomes provable.
//
// Design rules (see Task #251):
//   * ALL writes go through the dedicated CRUD modules (re-exported via
//     dataFacade). This file performs NO direct `db.<table>` writes, so the
//     `crud-guards` validation keeps protecting the guarded tables.
//   * The generator NEVER materialises the whole dataset in memory. It builds
//     one batch at a time, writes it, drops the reference, and yields to the
//     event loop so the UI stays responsive. The only thing it retains is a
//     compact array of address-record ids used to wire participants/attachments
//     to real records.
//   * Generation is cancellable (AbortSignal) and reports progress.
//
// It is wired only into the dev-gated DevTestData page; it is never reachable
// from the normal/production UI.

import { notifyDbChange } from './database';
import type { TransactionParticipant, ScriptType, AddressImportance } from './db-types';
import {
  bulkCreateRecords,
  clearAllRecords,
  type CreateRecordData,
} from './data/record-crud';
import {
  bulkAddTransactions,
  bulkAddParticipants,
  clearTransactions,
  clearParticipants,
  type CreateTransactionData,
} from './data/transaction-crud';
import {
  bulkAddAttachments,
  clearAttachments,
  type CreateAttachmentData,
} from './data/attachments-crud';
import {
  ensureOwner,
  ensureWalletName,
  ensureSeedName,
  ensureWalletSoftware,
  syncTagsToMaster,
  syncCategoriesToMaster,
} from './data/vocabulary-crud';

// ---- Configuration ---------------------------------------------------------

export interface LargeVaultConfig {
  /** Total records (address-type + transaction-type). */
  records: number;
  /** Blockchain transaction rows. */
  transactions: number;
  /** Transaction participant rows (inputs + outputs). */
  participants: number;
  /** Attachment metadata rows (no real file bytes are written). */
  attachments: number;
  /** Fraction of records that are address-type (the rest are transaction-type). */
  addressRatio?: number;
  /** Wipe existing big-table data before generating. Default true. */
  clearExisting?: boolean;
  /** Per-batch sizes. Sensible defaults are applied when omitted. */
  recordBatch?: number;
  txBatch?: number;
  participantBatch?: number;
  attachmentBatch?: number;
}

/**
 * The real vault we keep failing on. Generating this takes a long time but
 * completes reliably.
 */
export const REAL_SCALE_CONFIG: LargeVaultConfig = {
  records: 100_000,
  transactions: 10_000_000,
  participants: 20_000_000,
  attachments: 5_000,
};

/**
 * A "big enough to feel slow, small enough to finish in a minute or two"
 * preset for quick manual checks.
 */
export const MODERATE_CONFIG: LargeVaultConfig = {
  records: 5_000,
  transactions: 20_000,
  participants: 40_000,
  attachments: 1_000,
};

const DEFAULT_BATCHES = {
  recordBatch: 2_000,
  txBatch: 5_000,
  participantBatch: 10_000,
  attachmentBatch: 2_000,
};

// ---- Progress / cancellation ----------------------------------------------

export type SeedPhase =
  | 'clearing'
  | 'vocabulary'
  | 'records'
  | 'transactions'
  | 'participants'
  | 'attachments'
  | 'done';

export interface SeedProgress {
  phase: SeedPhase;
  /** Rows written so far in the current phase. */
  current: number;
  /** Total rows planned for the current phase. */
  total: number;
  /** Overall fraction complete across all phases, 0..1. */
  overall: number;
}

export type ProgressCallback = (progress: SeedProgress) => void;

export interface GenerateOptions {
  onProgress?: ProgressCallback;
  signal?: AbortSignal;
}

export interface LargeVaultResult {
  records: number;
  transactions: number;
  participants: number;
  attachments: number;
  durationMs: number;
}

/** Thrown when generation is cancelled via an AbortSignal. */
export class SeedAbortError extends Error {
  constructor() {
    super('Vault generation was cancelled');
    this.name = 'SeedAbortError';
  }
}

// ---- Deterministic synthetic data ------------------------------------------

const BASE_BLOCK_TIME = 1_231_006_505; // Bitcoin genesis block time (seconds)
const TX_PER_BLOCK = 3;

const OWNER_POOL = ['Personal', 'Business', 'Cold Storage', 'Exchange', 'Unknown'];
const WALLET_POOL = ['Primary', 'Savings', 'Trading', 'Hardware', 'Watch-only'];
const SEED_POOL = ['Seed A', 'Seed B', 'Seed C'];
const SOFTWARE_POOL = ['Sparrow', 'Electrum', 'BlueWallet', 'Specter'];
const TAG_POOL = ['kyc', 'coinjoin', 'donation', 'change', 'consolidation'];
const CATEGORY_POOL = ['Income', 'Expense', 'Transfer', 'Mining'];
const IMPORTANCE_POOL: AddressImportance[] = [
  'verified',
  'manual',
  'wallet-import',
  'xpub-derived',
  'blockchain-discovered',
  'pending-review',
];
const SCRIPT_TYPES: ScriptType[] = ['v0_p2wpkh', 'v1_p2tr', 'p2sh', 'p2pkh'];

function syntheticAddress(i: number): string {
  return 'bc1q' + i.toString(16).padStart(38, '0');
}

function syntheticTxid(i: number): string {
  return i.toString(16).padStart(64, '0');
}

function hex(i: number, len: number): string {
  return i.toString(16).padStart(len, '0').slice(-len);
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SeedAbortError();
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---- Row builders (one row at a time — never a full-table array) -----------

function buildAddressRecord(i: number): CreateRecordData {
  return {
    type: 'address',
    inputString: syntheticAddress(i),
    label: `Address ${i}`,
    tags: i % 5 === 0 ? [TAG_POOL[i % TAG_POOL.length]] : [],
    categories: i % 7 === 0 ? [CATEGORY_POOL[i % CATEGORY_POOL.length]] : [],
    owner: i % 3 === 0 ? OWNER_POOL[i % OWNER_POOL.length] : undefined,
    walletName: i % 4 === 0 ? WALLET_POOL[i % WALLET_POOL.length] : undefined,
    seedName: i % 6 === 0 ? SEED_POOL[i % SEED_POOL.length] : undefined,
    walletSoftware: i % 8 === 0 ? SOFTWARE_POOL[i % SOFTWARE_POOL.length] : undefined,
    addressImportance: IMPORTANCE_POOL[i % IMPORTANCE_POOL.length],
    firstSeenBlockTime: BASE_BLOCK_TIME + i * 600,
    cachedBalanceSats: (i % 1000) * 1000,
    cachedTxCount: i % 50,
    cachedLastActivityTime: BASE_BLOCK_TIME + i * 600,
    cachedUtxoCount: (i % 1000) === 0 ? 0 : ((i % 3) + 1),
    statsComputedAt: BASE_BLOCK_TIME * 1000,
  };
}

function buildTransactionRecord(i: number): CreateRecordData {
  return {
    type: 'transaction',
    inputString: syntheticTxid(i),
    label: `Transaction ${i}`,
    tags: [],
    categories: [],
    addressImportance: 'manual',
    firstSeenBlockTime: BASE_BLOCK_TIME + i * 600,
  };
}

function buildTransaction(i: number): CreateTransactionData {
  const blockHeight = Math.floor(i / TX_PER_BLOCK);
  return {
    txid: syntheticTxid(i),
    blockHeight,
    blockTime: BASE_BLOCK_TIME + blockHeight * 600,
    fee: 1000 + (i % 9000),
    feeRate: 1 + (i % 200),
    syncedAt: BASE_BLOCK_TIME * 1000,
    size: 200 + (i % 800),
    weight: 800 + (i % 3200),
    vsize: 200 + (i % 800),
    hasOpReturn: i % 50 === 0,
  };
}

function buildParticipant(
  j: number,
  transactions: number,
  addressRecordIds: number[]
): TransactionParticipant {
  const numAddr = addressRecordIds.length;
  const txIndex = j % transactions;
  const addrIdx = j % numAddr;
  const isInput = j % 2 === 0;
  return {
    txid: syntheticTxid(txIndex),
    role: isInput ? 'input' : 'output',
    address: syntheticAddress(addrIdx),
    amount: 1000 + (j % 1_000_000),
    vout: isInput ? undefined : j % 4,
    prevTxid: isInput ? syntheticTxid((txIndex + 1) % transactions) : undefined,
    prevVout: isInput ? j % 4 : undefined,
    recordId: addressRecordIds[addrIdx],
    scriptType: SCRIPT_TYPES[j % SCRIPT_TYPES.length],
  };
}

function buildAttachment(k: number, addressRecordIds: number[]): CreateAttachmentData {
  return {
    recordId: addressRecordIds[k % addressRecordIds.length],
    filename: `file-${k}.pdf`,
    mimeType: 'application/pdf',
    size: 2048 + (k % 4096),
    // Already-migrated shape: hashed dir + opaque filename. (The legacy /
    // pre-migration shape is produced separately by generateLegacyFixture.)
    objectStoragePath: `${hex(k, 64)}/${hex(k, 32)}.pdf`,
  };
}

// ---- Generator -------------------------------------------------------------

/**
 * Generate a synthetic vault at the requested scale. Writes in batches through
 * the CRUD layer, yields between batches, and reports progress. Pass an
 * AbortSignal to cancel; cancellation throws SeedAbortError after the current
 * batch finishes (partial data is left in place).
 */
export async function generateLargeVault(
  config: LargeVaultConfig,
  options: GenerateOptions = {}
): Promise<LargeVaultResult> {
  const { onProgress, signal } = options;
  const start = performance.now();

  const addressRatio = config.addressRatio ?? 0.7;
  // Clamp every batch size to >= 1: a zero or negative batch would make the
  // `s += batch` loops below never advance, hanging the generator forever.
  const recordBatch = Math.max(1, Math.floor(config.recordBatch ?? DEFAULT_BATCHES.recordBatch));
  const txBatch = Math.max(1, Math.floor(config.txBatch ?? DEFAULT_BATCHES.txBatch));
  const participantBatch = Math.max(1, Math.floor(config.participantBatch ?? DEFAULT_BATCHES.participantBatch));
  const attachmentBatch = Math.max(1, Math.floor(config.attachmentBatch ?? DEFAULT_BATCHES.attachmentBatch));

  const totalRecords = Math.max(0, Math.floor(config.records));
  const totalTransactions = Math.max(0, Math.floor(config.transactions));
  const totalParticipants = Math.max(0, Math.floor(config.participants));
  const totalAttachments = Math.max(0, Math.floor(config.attachments));

  // At least one address record so participants/attachments have something to
  // link to (when any records are requested at all).
  const numAddressRecords =
    totalRecords > 0 ? Math.max(1, Math.floor(totalRecords * addressRatio)) : 0;

  const grandTotal =
    totalRecords + totalTransactions + totalParticipants + totalAttachments || 1;
  let writtenOverall = 0;
  const report = (phase: SeedPhase, current: number, total: number) => {
    onProgress?.({
      phase,
      current,
      total,
      overall: Math.min(1, writtenOverall / grandTotal),
    });
  };

  // ---- Clear (optional) ----
  if (config.clearExisting !== false) {
    report('clearing', 0, 0);
    await clearAllRecords({ skipNotification: true });
    await clearTransactions({ skipNotification: true });
    await clearParticipants({ skipNotification: true });
    await clearAttachments({ skipNotification: true });
    checkAbort(signal);
  }

  // ---- Vocabulary (created once, up front) ----
  // Records below are written with skipVocabularySync to avoid per-batch
  // vocabulary scans; we seed the dropdown vocabularies a single time here.
  report('vocabulary', 0, 0);
  await Promise.all([
    ...OWNER_POOL.filter((o) => o !== 'Unknown').map((o) => ensureOwner(o)),
    ...WALLET_POOL.map((w) => ensureWalletName(w)),
    ...SEED_POOL.map((s) => ensureSeedName(s)),
    ...SOFTWARE_POOL.map((s) => ensureWalletSoftware(s)),
  ]);
  await syncTagsToMaster(TAG_POOL);
  await syncCategoriesToMaster(CATEGORY_POOL);
  checkAbort(signal);

  // ---- Records ----
  // Address-type records first so their ids are contiguous and can be captured
  // for linking participants/attachments to real records.
  const addressRecordIds: number[] = [];
  let recordsDone = 0;

  for (let s = 0; s < numAddressRecords; s += recordBatch) {
    checkAbort(signal);
    const end = Math.min(s + recordBatch, numAddressRecords);
    const batch: CreateRecordData[] = [];
    for (let i = s; i < end; i++) batch.push(buildAddressRecord(i));
    const ids = await bulkCreateRecords(batch, {
      skipNotification: true,
      skipVocabularySync: true,
    });
    for (const id of ids) addressRecordIds.push(id);
    recordsDone += batch.length;
    writtenOverall += batch.length;
    report('records', recordsDone, totalRecords);
    await yieldToEventLoop();
  }

  for (let s = numAddressRecords; s < totalRecords; s += recordBatch) {
    checkAbort(signal);
    const end = Math.min(s + recordBatch, totalRecords);
    const batch: CreateRecordData[] = [];
    for (let i = s; i < end; i++) batch.push(buildTransactionRecord(i));
    await bulkCreateRecords(batch, {
      skipNotification: true,
      skipVocabularySync: true,
    });
    recordsDone += batch.length;
    writtenOverall += batch.length;
    report('records', recordsDone, totalRecords);
    await yieldToEventLoop();
  }

  // ---- Transactions ----
  let txDone = 0;
  for (let s = 0; s < totalTransactions; s += txBatch) {
    checkAbort(signal);
    const end = Math.min(s + txBatch, totalTransactions);
    const batch: CreateTransactionData[] = [];
    for (let i = s; i < end; i++) batch.push(buildTransaction(i));
    await bulkAddTransactions(batch, { skipNotification: true });
    txDone += batch.length;
    writtenOverall += batch.length;
    report('transactions', txDone, totalTransactions);
    await yieldToEventLoop();
  }

  // ---- Participants ----
  let partDone = 0;
  if (numAddressRecords > 0 && totalTransactions > 0) {
    for (let s = 0; s < totalParticipants; s += participantBatch) {
      checkAbort(signal);
      const end = Math.min(s + participantBatch, totalParticipants);
      const batch: TransactionParticipant[] = [];
      for (let j = s; j < end; j++) {
        batch.push(buildParticipant(j, totalTransactions, addressRecordIds));
      }
      await bulkAddParticipants(batch, { skipNotification: true });
      partDone += batch.length;
      writtenOverall += batch.length;
      report('participants', partDone, totalParticipants);
      await yieldToEventLoop();
    }
  }

  // ---- Attachments ----
  let attDone = 0;
  if (numAddressRecords > 0) {
    for (let s = 0; s < totalAttachments; s += attachmentBatch) {
      checkAbort(signal);
      const end = Math.min(s + attachmentBatch, totalAttachments);
      const batch: CreateAttachmentData[] = [];
      for (let k = s; k < end; k++) batch.push(buildAttachment(k, addressRecordIds));
      await bulkAddAttachments(batch, { skipNotification: true });
      attDone += batch.length;
      writtenOverall += batch.length;
      report('attachments', attDone, totalAttachments);
      await yieldToEventLoop();
    }
  }

  // One notification at the end so the UI refreshes once, not per batch.
  notifyDbChange(['records', 'blockchainTransactions', 'transactionParticipants', 'attachments']);
  report('done', grandTotal, grandTotal);

  return {
    records: recordsDone,
    transactions: txDone,
    participants: partDone,
    attachments: attDone,
    durationMs: performance.now() - start,
  };
}

/**
 * KYUTXO native read-engine worker (worker_threads).
 *
 * Runs the SQLite read replica on a dedicated thread inside Electron's Node side,
 * so neither the UI thread nor Electron's main thread ever blocks on the heavy
 * seed or the at-scale anti-join. The database is a single native better-sqlite3
 * file that lives on the portable USB (journal_mode=TRUNCATE — never WAL — so the
 * vault stays one file that survives removal).
 *
 * This file is bundled to `electron/engine/engine-worker.bundle.cjs` by
 * `scripts/build-native-engine.mjs` (better-sqlite3 stays external and is loaded
 * natively at runtime via asarUnpack). Electron's main process owns the worker
 * via `electron/engine-handlers.cjs`.
 *
 * Protocol (request/response, correlation-id):
 *   init | status | seedBegin | seedBatch | seedFinish |
 *   query | benchmark | reopen | integrityCheck | clear
 *
 * Seed is PUSH-based: the renderer reads IndexedDB + maps Dexie rows (it owns the
 * source schema) and streams already-mapped batches via `seedBatch`. The worker
 * only owns the SQLite side and the EMPTY→LOADING→INDEXING→READY/ERROR state
 * machine. Exactly one seed job runs at a time.
 *
 * The SQL itself lives in engine-core.ts (pure, unit-tested + benchmarked in
 * Node against the same better-sqlite3 driver).
 */
import { isMainThread, parentPort, workerData } from 'node:worker_threads';

import { openEngineDb, type BetterSqlite3EngineDb } from '../lib/engine/better-sqlite3-adapter';
import {
  applyConnectionPragmas,
  applyBulkLoadPragmas,
  applyIndexBuildPragmas,
  applyReadPragmas,
  createTablesOnly,
  createIndexesYielding,
  INDEX_BUILD_STEPS,
  buildOwnedUtxos,
  generateSyntheticData,
  dropMirrorTables,
  resetSeedMeta,
  insertRecords,
  insertTransactions,
  insertParticipants,
  insertTransactionMetadata,
  upsertSeedProgress,
  getAllSeedMeta,
  markSeedCompleteIfDone,
  getEngineSchemaVersion,
  writeEngineSchemaVersion,
  isEngineReady,
  integrityCheck,
  countTable,
  getRecordPage,
  getRecordPageByUpdatedAt,
  countRecords,
  getRecordsFingerprint,
  getTransactionsFingerprint,
  getParticipantsFingerprint,
  getTransactionMetadataFingerprint,
  getAddressAggregates,
  getOwnedUtxos,
  countOwnedUtxos,
  getOutpointCoverage,
  getHeuristicOwnedUtxos,
  countHeuristicOwnedUtxos,
  buildHeuristicOwnedUtxos,
  getParticipantsByTxids,
  getParticipantsByAddresses,
  countTransactions,
  getTransactionPage,
  getBalanceGroupSummaries,
  getWalletUsageSummaries,
  getVaultSummaries,
  getCoinOrigins,
  getCoinOriginsPage,
  getDbFileStats,
  MIRROR_TABLES,
  type MirrorTable,
  type SeedMeta,
  type RecordRow,
  type TransactionRow,
  type ParticipantRow,
  type TransactionMetadataRow,
  type RecordPageOptions,
  type RecordPageByUpdatedAtOptions,
  type RecordQueryOptions,
  type TransactionQueryOptions,
  type TransactionPageOptions,
  type BalanceGroupBy,
  type DbFileStats,
  type SyntheticSpec,
  type CoinOriginsPageOptions,
} from '../lib/engine/engine-core';

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export type EngineState = 'EMPTY' | 'LOADING' | 'INDEXING' | 'READY' | 'ERROR';

export interface EngineWorkerData {
  /** Absolute path to the engine SQLite file (on the USB in production). */
  dbPath: string;
}

export type EngineRequest =
  | { id: number; type: 'init' }
  | { id: number; type: 'status' }
  | { id: number; type: 'seedBegin' }
  | { id: number; type: 'seedBatch'; table: MirrorTable; rows: unknown[] }
  | { id: number; type: 'seedFinish'; sourceCounts: Record<MirrorTable, number> }
  | { id: number; type: 'query'; name: string; args: unknown }
  | { id: number; type: 'benchmark' }
  | { id: number; type: 'reopen' }
  | { id: number; type: 'integrityCheck' }
  | { id: number; type: 'clear' }
  | { id: number; type: 'generateSynthetic'; spec: SyntheticSpec };

export interface EngineResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface EngineSnapshot {
  state: EngineState;
  ready: boolean;
  seeding: boolean;
  counts: Record<MirrorTable, number>;
  seedMeta: SeedMeta[];
  fileStats: DbFileStats;
  dbPath: string;
  errorMessage: string | null;
}

export interface BenchmarkRow {
  label: string;
  ms: number;
  rows: number;
}

/**
 * Pushed (un-correlated) progress for the finalize phase — the long, formerly
 * silent step that builds indexes, materializes the owned-UTXO sets and runs the
 * integrity check. Emitted out-of-band between sub-steps so the UI is never blank
 * while the worker is busy and cannot answer `status` polls.
 */
export interface FinalizeProgress {
  /** Coarse phase the finalize is in. */
  phase: 'indexing' | 'materializing-utxos' | 'materializing-heuristic' | 'verifying';
  /** Human-readable description of the current sub-step. */
  label: string;
  /** 1-based position of the current sub-step. */
  step: number;
  /** Total number of finalize sub-steps. */
  totalSteps: number;
}

/** Worker → main push envelope for finalize progress (no correlation id). */
export interface FinalizeProgressMessage {
  kind: 'finalizeProgress';
  progress: FinalizeProgress;
}

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

let db: BetterSqlite3EngineDb | null = null;
let dbPath = '';
let state: EngineState = 'EMPTY';
let seeding = false;
let errorMessage: string | null = null;
const copied: Record<MirrorTable, number> = {
  records: 0,
  blockchainTransactions: 0,
  transactionParticipants: 0,
  transactionMetadata: 0,
};

function requireDb(): BetterSqlite3EngineDb {
  if (!db) throw new Error('Engine worker not initialized — send "init" first');
  return db;
}

function counts(): Record<MirrorTable, number> {
  const d = requireDb();
  return {
    records: countTable(d, 'records'),
    blockchainTransactions: countTable(d, 'blockchainTransactions'),
    transactionParticipants: countTable(d, 'transactionParticipants'),
    transactionMetadata: countTable(d, 'transactionMetadata'),
  };
}

function snapshot(): EngineSnapshot {
  const d = requireDb();
  return {
    state,
    ready: isEngineReady(d),
    seeding,
    counts: counts(),
    seedMeta: getAllSeedMeta(d),
    fileStats: getDbFileStats(d),
    dbPath,
    errorMessage,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle handlers
// ---------------------------------------------------------------------------

function handleInit(): EngineSnapshot {
  if (!db) {
    db = openEngineDb(dbPath);
    applyConnectionPragmas(db);
    createTablesOnly(db); // ensures seedMeta + tables exist for a first open
    applyReadPragmas(db);
    state = isEngineReady(db) ? 'READY' : 'EMPTY';
  }
  return snapshot();
}

function handleSeedBegin(): EngineSnapshot {
  // Full-rebuild model with a single renderer orchestrator: every seedBegin is a
  // fresh start. We deliberately do NOT throw on a stale `seeding` flag (e.g. one
  // left over from a cancelled job) — we just reset and rebuild from clean.
  const d = requireDb();
  seeding = true;
  errorMessage = null;
  state = 'LOADING';
  // Full-rebuild model: never resume a partial seed — always start clean.
  applyBulkLoadPragmas(d);
  dropMirrorTables(d);
  createTablesOnly(d);
  resetSeedMeta(d);
  copied.records = 0;
  copied.blockchainTransactions = 0;
  copied.transactionParticipants = 0;
  copied.transactionMetadata = 0;
  return snapshot();
}

function insertBatch(table: MirrorTable, rows: unknown[]): void {
  const d = requireDb();
  switch (table) {
    case 'records':
      insertRecords(d, rows as RecordRow[]);
      break;
    case 'blockchainTransactions':
      insertTransactions(d, rows as TransactionRow[]);
      break;
    case 'transactionParticipants':
      insertParticipants(d, rows as ParticipantRow[]);
      break;
    case 'transactionMetadata':
      insertTransactionMetadata(d, rows as TransactionMetadataRow[]);
      break;
    default: {
      const _exhaustive: never = table;
      throw new Error(`Unknown mirror table: ${String(_exhaustive)}`);
    }
  }
}

function handleSeedBatch(table: MirrorTable, rows: unknown[]): { table: MirrorTable; copied: number } {
  if (!seeding) throw new Error('seedBatch received outside an active seed (call seedBegin first)');
  if (!MIRROR_TABLES.includes(table)) throw new Error(`Unknown mirror table: ${String(table)}`);
  if (!Array.isArray(rows)) throw new Error('seedBatch rows must be an array');
  insertBatch(table, rows);
  copied[table] += rows.length;
  // Persist a coarse high-water mark so a crash leaves an auditable trail (the
  // rebuild ignores it and starts clean, but the UI can show partial progress).
  upsertSeedProgress(requireDb(), table, {
    highWaterId: copied[table],
    copied: copied[table],
    sourceCount: 0,
    complete: false,
  });
  return { table, copied: copied[table] };
}

// ---------------------------------------------------------------------------
// Finalize (build indexes → materialize UTXOs → verify) with PUSHED progress
// ---------------------------------------------------------------------------
//
// Finalize is one long, synchronous, formerly-silent step. The worker is
// single-threaded, so while it runs it cannot answer `status` polls — which is
// exactly why the screen used to look frozen on "pending". We instead PUSH
// progress out-of-band via `parentPort` between sub-steps. Those messages cross
// to the main thread (a different OS thread, whose event loop is free) the moment
// they are posted, even though this handler has not returned, so the UI updates
// live. They carry a `kind` discriminator and NO correlation `id`, so the main
// bridge tells them apart from request/response envelopes.

// indexes + ANALYZE (INDEX_BUILD_STEPS) + owned-UTXOs + heuristic-UTXOs + verify
const FINALIZE_TOTAL_STEPS = INDEX_BUILD_STEPS.length + 3;

function postFinalizeProgress(progress: FinalizeProgress): void {
  const msg: FinalizeProgressMessage = { kind: 'finalizeProgress', progress };
  parentPort?.postMessage(msg);
}

/**
 * Return control to the worker's event loop for one tick. While the finalize is
 * paused here, the single worker thread drains any queued `status`/`schemaVersion`
 * requests (their handlers are read-only and fast) before resuming the next, still
 * synchronous, finalize sub-step. setImmediate (not a Promise microtask) is used
 * deliberately so MessagePort message callbacks — which run as macrotasks — get a
 * chance to execute in the gap rather than being starved by a microtask loop.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Shared finalize sequence for BOTH the real seed and the synthetic load test:
 * build indexes (spilling the sort to fast local temp to bound memory),
 * materialize the owned-UTXO sets, restore read pragmas, then integrity_check.
 *
 * Finalize used to run as ONE long synchronous block, so the single-threaded
 * worker could not answer `status` polls while it rebuilt and the screen looked
 * frozen on "pending". It now yields between every sub-step (each index build, and
 * before each materialize/verify pass) so the worker keeps answering polls and the
 * pushed progress reflects live state. The individual SQLite statements are still
 * synchronous — SQLite cannot be interrupted mid-statement — but the inter-step
 * gaps remove the cumulative whole-finalize stall. Returns the integrity result.
 */
async function runFinalize(d: BetterSqlite3EngineDb): Promise<string> {
  applyIndexBuildPragmas(d);
  try {
    await createIndexesYielding(
      d,
      (step, index) => {
        postFinalizeProgress({
          phase: 'indexing',
          label: `Building indexes — ${step.label}`,
          step: index,
          totalSteps: FINALIZE_TOTAL_STEPS,
        });
      },
      yieldToEventLoop,
    );
    // Materialize the owned-UTXO set once so countOwnedUtxos / first-page reads are
    // sub-second on big vaults instead of a multi-second per-output anti-join.
    postFinalizeProgress({
      phase: 'materializing-utxos',
      label: 'Materializing owned UTXOs',
      step: INDEX_BUILD_STEPS.length + 1,
      totalSteps: FINALIZE_TOTAL_STEPS,
    });
    await yieldToEventLoop();
    buildOwnedUtxos(d);
    // Same for the heuristic (no-prevout) owned-UTXO set so its count/first-page
    // reads are sub-second instead of a full window-function pass.
    postFinalizeProgress({
      phase: 'materializing-heuristic',
      label: 'Materializing heuristic UTXOs',
      step: INDEX_BUILD_STEPS.length + 2,
      totalSteps: FINALIZE_TOTAL_STEPS,
    });
    await yieldToEventLoop();
    buildHeuristicOwnedUtxos(d);
  } finally {
    // Always restore the read pragmas (temp_store=MEMORY) — even if index build or
    // materialization throws — so a failed connection is never left stuck in the
    // index-build configuration (temp_store=FILE) for any later reads/reopen.
    applyReadPragmas(d);
  }
  postFinalizeProgress({
    phase: 'verifying',
    label: 'Verifying database integrity',
    step: INDEX_BUILD_STEPS.length + 3,
    totalSteps: FINALIZE_TOTAL_STEPS,
  });
  await yieldToEventLoop();
  return integrityCheck(d);
}

async function handleSeedFinish(sourceCounts: Record<MirrorTable, number>): Promise<EngineSnapshot> {
  const d = requireDb();
  try {
    state = 'INDEXING';
    const integrity = await runFinalize(d);
    let allComplete = true;
    for (const t of MIRROR_TABLES) {
      const ok = markSeedCompleteIfDone(d, t, sourceCounts[t] ?? countTable(d, t));
      if (!ok) allComplete = false;
    }
    if (integrity !== 'ok') {
      state = 'ERROR';
      errorMessage = `integrity_check failed: ${integrity}`;
    } else if (allComplete && isEngineReady(d)) {
      // Stamp the schema version ONLY now that the mirror is fully built + verified,
      // so a half-built/interrupted mirror never advertises the current shape.
      writeEngineSchemaVersion(d);
      state = 'READY';
    } else {
      state = 'ERROR';
      errorMessage = 'Seed finished but row counts did not match source counts';
    }
  } catch (err) {
    state = 'ERROR';
    errorMessage = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    seeding = false;
  }
  return snapshot();
}

function handleReopen(): { before: number; after: number; ready: boolean; fileStats: DbFileStats } {
  const d = requireDb();
  const before = countTable(d, 'transactionParticipants');
  d.close();
  db = openEngineDb(dbPath);
  applyConnectionPragmas(db);
  applyReadPragmas(db);
  const after = countTable(db, 'transactionParticipants');
  state = isEngineReady(db) ? 'READY' : state;
  return { before, after, ready: isEngineReady(db), fileStats: getDbFileStats(db) };
}

function handleClear(): EngineSnapshot {
  const d = requireDb();
  dropMirrorTables(d);
  createTablesOnly(d);
  resetSeedMeta(d);
  state = 'EMPTY';
  errorMessage = null;
  // clear doubles as "abort": a cancelled seed leaves `seeding` true, so reset it
  // here so the next seedBegin is never blocked by a stale flag.
  seeding = false;
  return snapshot();
}

/**
 * Self-contained synthetic load test (benchmarking lever). Generation runs here
 * in Node — reusing the same engine-core path the real seed and the bench use —
 * so the user can stress their actual machine/USB at scale without a huge real
 * vault. Mirrors the bench flow: reset → generate → index → integrity → ready.
 */
async function handleGenerateSynthetic(
  spec: SyntheticSpec,
): Promise<{ records: number; transactions: number; participants: number }> {
  const d = requireDb();
  seeding = true;
  errorMessage = null;
  state = 'LOADING';
  try {
    applyBulkLoadPragmas(d);
    dropMirrorTables(d);
    createTablesOnly(d);
    resetSeedMeta(d);
    const result = generateSyntheticData(d, spec);
    state = 'INDEXING';
    const integrity = await runFinalize(d);
    markSeedCompleteIfDone(d, 'records', result.records);
    markSeedCompleteIfDone(d, 'blockchainTransactions', result.transactions);
    markSeedCompleteIfDone(d, 'transactionParticipants', result.participants);
    markSeedCompleteIfDone(d, 'transactionMetadata', 0);
    if (integrity !== 'ok') {
      state = 'ERROR';
      errorMessage = `integrity_check failed: ${integrity}`;
    } else if (isEngineReady(d)) {
      // Stamp the schema version only on a fully-built, verified mirror (same rule
      // as the real seed finalize) so the freshness gate accepts the synthetic load.
      writeEngineSchemaVersion(d);
      state = 'READY';
    } else {
      state = 'ERROR';
      errorMessage = 'Synthetic generation finished but counts did not match';
    }
    return result;
  } catch (err) {
    state = 'ERROR';
    errorMessage = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    seeding = false;
  }
}

// ---------------------------------------------------------------------------
// Query dispatch
// ---------------------------------------------------------------------------

function handleQuery(name: string, args: unknown): unknown {
  const d = requireDb();
  switch (name) {
    case 'getRecordPage':
      return getRecordPage(d, args as RecordPageOptions);
    case 'getRecordPageByUpdatedAt':
      return getRecordPageByUpdatedAt(d, args as RecordPageByUpdatedAtOptions);
    case 'countRecords':
      return countRecords(d, args as RecordQueryOptions);
    case 'getEngineSchemaVersion':
      return getEngineSchemaVersion(d);
    case 'getRecordsFingerprint':
      return getRecordsFingerprint(d);
    case 'getTransactionsFingerprint':
      return getTransactionsFingerprint(d);
    case 'getParticipantsFingerprint':
      return getParticipantsFingerprint(d);
    case 'getTransactionMetadataFingerprint':
      return getTransactionMetadataFingerprint(d);
    case 'getAddressAggregates':
      return Array.from(getAddressAggregates(d, args as string[]).values());
    case 'getOwnedUtxos':
      return getOwnedUtxos(
        d,
        args as { tiers?: string[]; afterId?: number; limit: number; asOfBlockTime?: number },
      );
    case 'countOwnedUtxos':
      return countOwnedUtxos(d, args as { tiers?: string[]; asOfBlockTime?: number } | undefined);
    case 'getOutpointCoverage':
      return getOutpointCoverage(d, args as { tiers?: string[] } | undefined);
    case 'getHeuristicOwnedUtxos':
      return getHeuristicOwnedUtxos(
        d,
        args as { tiers?: string[]; afterId?: number; limit: number; asOfBlockTime?: number },
      );
    case 'countHeuristicOwnedUtxos':
      return countHeuristicOwnedUtxos(
        d,
        args as { tiers?: string[]; asOfBlockTime?: number } | undefined,
      );
    case 'getParticipantsByTxids':
      return getParticipantsByTxids(d, args as string[]);
    case 'getParticipantsByAddresses':
      return getParticipantsByAddresses(d, args as string[]);
    case 'countTransactions':
      return countTransactions(d, (args as TransactionQueryOptions | undefined) ?? {});
    case 'getTransactionPage':
      return getTransactionPage(d, args as TransactionPageOptions);
    case 'getBalanceGroupSummaries':
      return getBalanceGroupSummaries(d, args as { groupBy: BalanceGroupBy });
    case 'getWalletUsageSummaries':
      return getWalletUsageSummaries(d);
    case 'getVaultSummaries':
      return getVaultSummaries(d, (args as { search?: string } | undefined) ?? {});
    case 'getCoinOrigins':
      return getCoinOrigins(d, (args as { walletName?: string } | undefined) ?? {});
    case 'getCoinOriginsPage':
      return getCoinOriginsPage(d, (args as CoinOriginsPageOptions | undefined) ?? {});
    default:
      throw new Error(`Unknown query: ${name}`);
  }
}

function handleBenchmark(): BenchmarkRow[] {
  const d = requireDb();
  const results: BenchmarkRow[] = [];
  const t = (label: string, fn: () => number) => {
    const t0 = performance.now();
    const rows = fn();
    results.push({ label, ms: performance.now() - t0, rows });
  };
  t('countRecords (all tiers)', () => countRecords(d, { includeBlockchainDiscovered: true }));
  t('countRecords (owned only)', () => countRecords(d, { includeBlockchainDiscovered: false }));
  t('record page (first 100)', () => getRecordPage(d, { limit: 100, includeBlockchainDiscovered: true }).length);
  t('record search', () => getRecordPage(d, { limit: 100, search: 'synth', includeBlockchainDiscovered: true }).length);
  t('count owned UTXOs (anti-join)', () => countOwnedUtxos(d));
  t('owned UTXO page (first 500)', () => getOwnedUtxos(d, { limit: 500 }).length);
  t('address aggregates (200 addrs)', () => {
    const addrs: string[] = [];
    for (let i = 1; i <= 200; i++) addrs.push(`bc1qsynth${i}`);
    return getAddressAggregates(d, addrs).size;
  });
  return results;
}

// ---------------------------------------------------------------------------
// Request dispatch
// ---------------------------------------------------------------------------

function dispatch(req: EngineRequest): unknown | Promise<unknown> {
  switch (req.type) {
    case 'init':
      return handleInit();
    case 'status':
      return snapshot();
    case 'seedBegin':
      return handleSeedBegin();
    case 'seedBatch':
      return handleSeedBatch(req.table, req.rows);
    case 'seedFinish':
      return handleSeedFinish(req.sourceCounts);
    case 'query':
      return handleQuery(req.name, req.args);
    case 'benchmark':
      return handleBenchmark();
    case 'reopen':
      return handleReopen();
    case 'integrityCheck':
      return integrityCheck(requireDb());
    case 'clear':
      return handleClear();
    case 'generateSynthetic':
      return handleGenerateSynthetic(req.spec);
    default: {
      const _exhaustive: never = req;
      throw new Error(`Unknown request: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function runWorker(): void {
  const port = parentPort;
  if (!port) throw new Error('engine-node-worker must run as a worker_thread');
  dbPath = (workerData as EngineWorkerData)?.dbPath ?? '';
  if (!dbPath) throw new Error('engine-node-worker requires workerData.dbPath');

  port.on('message', async (req: EngineRequest) => {
    let res: EngineResponse;
    try {
      // `await` covers both sync handlers (await of a plain value is a no-op) and
      // the async, cooperatively-yielding finalize handlers. Because the handler
      // is async, while a long finalize is parked on a yield the event loop
      // delivers queued `status`/`schemaVersion` messages and runs their (fast,
      // read-only) handlers — so the worker stays responsive during a rebuild.
      res = { id: req.id, ok: true, result: await dispatch(req) };
    } catch (err) {
      res = { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    port.postMessage(res);
  });
}

if (!isMainThread) {
  runWorker();
} else if (process.argv.includes('--self-test')) {
  // Lazy import keeps the production bundle free of the self-test harness path.
  void import('./engine-node-worker.selftest').then((m) => m.runSelfTest());
}

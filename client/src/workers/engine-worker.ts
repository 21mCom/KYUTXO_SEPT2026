/**
 * KYUTXO SQLite read-engine worker (Task #271).
 *
 * Runs the SQLite read replica entirely off the main thread. Storage uses the
 * OPFS SAH Pool VFS (persistent, no COOP/COEP requirement). All heavy reads and
 * the seed copy happen here so the UI thread never blocks.
 *
 * Hard rules baked in (from the validation-first mandate):
 *   - Persistence is REQUIRED. If OPFS is unavailable we fall back to in-memory
 *     but record it as a non-persistent mode, and REFUSE to seed large datasets
 *     into memory (which would OOM). The caller surfaces this as a hard no-go.
 *   - Seeding is RESUMABLE via a persisted per-table high-water mark, and a
 *     table is only marked "complete" once its mirrored row count matches the
 *     source count — partial data is never presented as the full dataset.
 *
 * The actual SQL lives in engine-core.ts (pure, unit-tested in Node). This file
 * only adds OPFS init, the IndexedDB keyset reader, Comlink wiring, and the
 * benchmark/reopen plumbing.
 */
import * as Comlink from 'comlink';
import sqlite3InitModule, { type Sqlite3Static, type Database } from '@sqlite.org/sqlite-wasm';
// Resolve the wasm binary through Vite so it gets a real served URL in BOTH dev
// and production. Without this, sqlite-wasm's default loader fetches a relative
// path that the dev server answers with index.html (SPA fallback), producing the
// "expected magic word 00 61 73 6d, found 3c 21 44 4f" (<!DO…) compile error.
import sqlite3WasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm?url';
import {
  createSchema,
  applyTuningPragmas,
  insertRecords,
  insertTransactions,
  insertParticipants,
  upsertSeedProgress,
  getSeedMeta,
  getAllSeedMeta,
  markSeedCompleteIfDone,
  isEngineReady,
  countTable,
  getRecordPage,
  countRecords,
  getAddressAggregates,
  getOwnedUtxos,
  countOwnedUtxos,
  getParticipantsByTxids,
  getParticipantsByAddresses,
  getDbFileStats,
  generateSyntheticData,
  type MirrorTable,
  type SeedMeta,
  type RecordRow,
  type TransactionRow,
  type ParticipantRow,
  type RecordPageOptions,
  type RecordQueryOptions,
  type AddressAggregate,
  type OwnedUtxo,
  type DbFileStats,
  type SyntheticSpec,
} from '../lib/engine/engine-core';

const DB_FILENAME = '/kyutxo-engine.sqlite3';
const SAH_POOL_NAME = 'kyutxo-engine-sahpool';
const IDB_NAME = 'KYUTXODatabase';

// SAH Pool needs one slot per file (DB + journal/temp). A generous capacity
// avoids "pool exhausted" surprises; slots are cheap when unused.
const SAH_INITIAL_CAPACITY = 32;

const SEED_CHUNK_SIZE = 10000;

// Above this many source rows we refuse to seed into a non-persistent in-memory
// DB (it would exhaust RAM and silently mislead). Small vaults can still run in
// memory if OPFS is somehow unavailable.
const MEMORY_MAX_ROWS = 500_000;

export type StorageMode = 'opfs-sahpool' | 'memory';

export interface StorageEstimate {
  usage: number | null;
  quota: number | null;
}

export interface InitResult {
  storageMode: StorageMode;
  persistent: boolean;
  persisted: boolean | null;
  sqliteVersion: string;
  estimate: StorageEstimate;
  fileStats: DbFileStats;
  seedMeta: SeedMeta[];
  ready: boolean;
}

export interface SeedProgress {
  table: MirrorTable;
  processed: number;
  total: number;
}

export interface SeedResult {
  table: MirrorTable;
  copied: number;
  sourceCount: number;
  durationMs: number;
  cancelled: boolean;
  complete: boolean;
}

export interface EngineStatus {
  initialized: boolean;
  storageMode: StorageMode;
  persistent: boolean;
  ready: boolean;
  seedMeta: SeedMeta[];
  counts: { records: number; blockchainTransactions: number; transactionParticipants: number };
  fileStats: DbFileStats;
  estimate: StorageEstimate;
}

export interface QueryBenchmarkResult {
  label: string;
  ms: number;
  rows: number;
}

let sqlite3: Sqlite3Static | null = null;
let db: Database | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let poolUtil: any = null;
let storageMode: StorageMode = 'memory';
let cancelRequested = false;

function requireDb(): Database {
  if (!db) throw new Error('Engine worker not initialized — call init() first');
  return db;
}

async function getEstimate(): Promise<StorageEstimate> {
  try {
    // navigator.storage.estimate() is available in worker scope.
    const nav = (self as unknown as { navigator?: Navigator }).navigator;
    if (nav?.storage?.estimate) {
      const e = await nav.storage.estimate();
      return { usage: e.usage ?? null, quota: e.quota ?? null };
    }
  } catch {
    /* ignore */
  }
  return { usage: null, quota: null };
}

async function getPersisted(): Promise<boolean | null> {
  try {
    const nav = (self as unknown as { navigator?: Navigator }).navigator;
    if (nav?.storage?.persisted) return await nav.storage.persisted();
  } catch {
    /* ignore */
  }
  return null;
}

async function openDatabase(): Promise<void> {
  try {
    poolUtil = await sqlite3!.installOpfsSAHPoolVfs({
      name: SAH_POOL_NAME,
      initialCapacity: SAH_INITIAL_CAPACITY,
      clearOnInit: false,
    });
    db = new poolUtil.OpfsSAHPoolDb(DB_FILENAME);
    storageMode = 'opfs-sahpool';
    console.log('[engine-worker] storage mode: OPFS SAH Pool VFS (persistent)');
  } catch (err) {
    console.warn('[engine-worker] OPFS SAH Pool unavailable — falling back to in-memory (NON-persistent)', err);
    db = new sqlite3!.oo1.DB(':memory:', 'c');
    storageMode = 'memory';
  }
  applyTuningPragmas(requireDb());
  createSchema(requireDb());
}

async function init(): Promise<InitResult> {
  if (db && sqlite3) {
    return buildInitResult();
  }
  // The bundled .d.ts types sqlite3InitModule() as taking no args, but the
  // Emscripten runtime accepts a module config (locateFile etc.). Cast to call it.
  const initWithConfig = sqlite3InitModule as unknown as (
    config?: { locateFile?: (path: string) => string },
  ) => Promise<Sqlite3Static>;
  sqlite3 = await initWithConfig({
    locateFile: (path: string) => (path.endsWith('.wasm') ? sqlite3WasmUrl : path),
  });
  await openDatabase();
  return buildInitResult();
}

async function buildInitResult(): Promise<InitResult> {
  const estimate = await getEstimate();
  const persisted = await getPersisted();
  return {
    storageMode,
    persistent: storageMode === 'opfs-sahpool',
    persisted,
    sqliteVersion: sqlite3!.version.libVersion,
    estimate,
    fileStats: getDbFileStats(requireDb()),
    seedMeta: getAllSeedMeta(requireDb()),
    ready: isEngineReady(requireDb()),
  };
}

async function getStatus(): Promise<EngineStatus> {
  const database = requireDb();
  return {
    initialized: true,
    storageMode,
    persistent: storageMode === 'opfs-sahpool',
    ready: isEngineReady(database),
    seedMeta: getAllSeedMeta(database),
    counts: {
      records: countTable(database, 'records'),
      blockchainTransactions: countTable(database, 'blockchainTransactions'),
      transactionParticipants: countTable(database, 'transactionParticipants'),
    },
    fileStats: getDbFileStats(database),
    estimate: await getEstimate(),
  };
}

// --------------------------------------------------------------------------
// IndexedDB keyset reader
// --------------------------------------------------------------------------

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

function idbCount(idb: IDBDatabase, store: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(store, 'readonly');
    const req = tx.objectStore(store).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB count failed'));
  });
}

function idbGetBatch(idb: IDBDatabase, store: string, lastId: number, limit: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(store, 'readonly');
    const range = IDBKeyRange.lowerBound(lastId, true);
    const req = tx.objectStore(store).getAll(range, limit);
    req.onsuccess = () => resolve(req.result as unknown[]);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB getAll failed'));
  });
}

// --------------------------------------------------------------------------
// Row mappers (Dexie object -> mirror row)
// --------------------------------------------------------------------------

function toInt(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

function jsonArray(v: unknown): string {
  if (Array.isArray(v)) return JSON.stringify(v);
  return '[]';
}

function mapRecord(o: Record<string, unknown>): RecordRow {
  const inputString = toText(o.inputString) ?? '';
  return {
    id: Number(o.id),
    type: toText(o.type) ?? 'other',
    inputString,
    inputStringLower: toText(o.inputStringLower) ?? inputString.toLowerCase(),
    label: toText(o.label),
    notes: toText(o.notes),
    owner: toText(o.owner),
    walletName: toText(o.walletName),
    seedName: toText(o.seedName),
    walletSoftware: toText(o.walletSoftware),
    addressImportance: toText(o.addressImportance),
    chainType: toText(o.chainType),
    syncDepth: toInt(o.syncDepth),
    firstSeenBlockTime: toInt(o.firstSeenBlockTime),
    cachedBalanceSats: toInt(o.cachedBalanceSats),
    cachedTxCount: toInt(o.cachedTxCount),
    cachedUtxoCount: toInt(o.cachedUtxoCount),
    statsComputedAt: toInt(o.statsComputedAt),
    createdAt: toInt(o.createdAt),
    updatedAt: toInt(o.updatedAt),
    tags: jsonArray(o.tags),
    categories: jsonArray(o.categories),
  };
}

function mapTransaction(o: Record<string, unknown>): TransactionRow {
  return {
    id: Number(o.id),
    txid: toText(o.txid) ?? '',
    blockHeight: toInt(o.blockHeight),
    blockTime: toInt(o.blockTime),
    fee: toInt(o.fee),
    feeRate: typeof o.feeRate === 'number' ? o.feeRate : toInt(o.feeRate),
    vsize: toInt(o.vsize),
    hasOpReturn: toInt(o.hasOpReturn),
  };
}

function mapParticipant(o: Record<string, unknown>): ParticipantRow {
  return {
    id: Number(o.id),
    txid: toText(o.txid) ?? '',
    role: (toText(o.role) as 'input' | 'output') ?? 'output',
    address: toText(o.address) ?? '',
    amount: toInt(o.amount) ?? 0,
    vout: toInt(o.vout),
    prevTxid: toText(o.prevTxid),
    prevVout: toInt(o.prevVout),
    recordId: toInt(o.recordId),
    scriptType: toText(o.scriptType),
  };
}

const TABLE_CONFIG: {
  [K in MirrorTable]: {
    store: string;
    map: (o: Record<string, unknown>) => unknown;
    insert: (database: Database, rows: unknown[]) => void;
  };
} = {
  records: {
    store: 'records',
    map: mapRecord,
    insert: (database, rows) => insertRecords(database, rows as RecordRow[]),
  },
  blockchainTransactions: {
    store: 'blockchainTransactions',
    map: mapTransaction,
    insert: (database, rows) => insertTransactions(database, rows as TransactionRow[]),
  },
  transactionParticipants: {
    store: 'transactionParticipants',
    map: mapParticipant,
    insert: (database, rows) => insertParticipants(database, rows as ParticipantRow[]),
  },
};

// --------------------------------------------------------------------------
// Resumable seed
// --------------------------------------------------------------------------

function cancelSeeding(): void {
  cancelRequested = true;
}

async function seedTable(
  table: MirrorTable,
  onProgress?: (p: SeedProgress) => void,
): Promise<SeedResult> {
  const database = requireDb();
  cancelRequested = false;
  const start = performance.now();
  const cfg = TABLE_CONFIG[table];

  let idb: IDBDatabase;
  try {
    idb = await openIdb();
  } catch (err) {
    console.warn('[engine-worker] could not open source IndexedDB', err);
    return { table, copied: countTable(database, table), sourceCount: 0, durationMs: 0, cancelled: false, complete: false };
  }

  try {
    if (!idb.objectStoreNames.contains(cfg.store)) {
      // Source store doesn't exist (e.g. empty/new vault). Nothing to copy; mark
      // complete against a source count of zero so the table is considered ready.
      markSeedCompleteIfDone(database, table, 0);
      return { table, copied: 0, sourceCount: 0, durationMs: performance.now() - start, cancelled: false, complete: true };
    }

    let sourceCount = 0;
    try {
      sourceCount = await idbCount(idb, cfg.store);
    } catch {
      sourceCount = 0;
    }

    // HARD FAIL: refuse to load a large dataset into a non-persistent in-memory
    // DB. This is the explicit guard against silently OOMing / misleading the
    // user when OPFS is unavailable.
    if (storageMode === 'memory' && sourceCount > MEMORY_MAX_ROWS) {
      throw new Error(
        `Persistent storage (OPFS) is unavailable, so the engine is running in memory. ` +
          `Refusing to mirror ${sourceCount.toLocaleString()} rows of "${table}" into memory ` +
          `(limit ${MEMORY_MAX_ROWS.toLocaleString()}). This would exhaust RAM. ` +
          `The structural rebuild cannot proceed without persistent storage.`,
      );
    }

    // Resume from the persisted high-water mark; recount what we already have so
    // the progress base is accurate even after a crash mid-batch.
    const meta = getSeedMeta(database, table);
    let lastId = meta.highWaterId;
    let copied = countTable(database, table);
    let cancelled = false;

    onProgress?.({ table, processed: copied, total: Math.max(sourceCount, copied) });

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (cancelRequested) {
        cancelled = true;
        break;
      }
      const batch = await idbGetBatch(idb, cfg.store, lastId, SEED_CHUNK_SIZE);
      if (batch.length === 0) break;

      const mapped = batch.map((o) => cfg.map(o as Record<string, unknown>));
      cfg.insert(database, mapped);

      const lastRow = batch[batch.length - 1] as { id: number };
      lastId = Number(lastRow.id);
      copied += batch.length;

      // Persist progress (separate tiny tx). Inserts are idempotent, so a crash
      // between the insert commit and this write only costs a re-copied batch.
      upsertSeedProgress(database, table, {
        highWaterId: lastId,
        copied,
        sourceCount,
        complete: false,
      });

      onProgress?.({ table, processed: copied, total: Math.max(sourceCount, copied) });

      if (batch.length < SEED_CHUNK_SIZE) break;
    }

    // Re-read the source count (it may have grown during a long copy) and only
    // mark complete if our mirror is not short of it.
    let finalSource = sourceCount;
    try {
      finalSource = await idbCount(idb, cfg.store);
    } catch {
      /* keep prior */
    }
    const complete = !cancelled && markSeedCompleteIfDone(database, table, finalSource);

    return {
      table,
      copied: countTable(database, table),
      sourceCount: finalSource,
      durationMs: performance.now() - start,
      cancelled,
      complete,
    };
  } finally {
    idb.close();
  }
}

async function seedAll(onProgress?: (p: SeedProgress) => void): Promise<SeedResult[]> {
  const results: SeedResult[] = [];
  for (const table of ['records', 'blockchainTransactions', 'transactionParticipants'] as MirrorTable[]) {
    const r = await seedTable(table, onProgress);
    results.push(r);
    if (r.cancelled) break;
  }
  return results;
}

// --------------------------------------------------------------------------
// Persistence reopen check
// --------------------------------------------------------------------------

/**
 * Close and reopen the database to prove data survives a fresh open. For OPFS
 * this re-opens the same persisted file; counts before/after must match. (A full
 * worker/process restart is the ultimate proof — the diagnostics page also lets
 * the user reload the whole app to confirm.)
 */
async function reopenAndVerify(): Promise<{
  storageMode: StorageMode;
  before: number;
  after: number;
  fileStats: DbFileStats;
}> {
  const database = requireDb();
  const before = countTable(database, 'transactionParticipants');
  try {
    database.close();
  } catch {
    /* ignore */
  }
  db = null;
  if (storageMode === 'opfs-sahpool' && poolUtil) {
    db = new poolUtil.OpfsSAHPoolDb(DB_FILENAME);
    applyTuningPragmas(requireDb());
  } else {
    // In-memory cannot survive a close; reopen yields an empty DB which is itself
    // the proof that memory mode is non-persistent.
    db = new sqlite3!.oo1.DB(':memory:', 'c');
    applyTuningPragmas(requireDb());
    createSchema(requireDb());
  }
  const after = countTable(requireDb(), 'transactionParticipants');
  return { storageMode, before, after, fileStats: getDbFileStats(requireDb()) };
}

// --------------------------------------------------------------------------
// Benchmark
// --------------------------------------------------------------------------

function generateSynthetic(spec: SyntheticSpec): { records: number; transactions: number; participants: number } {
  return generateSyntheticData(requireDb(), spec);
}

function runQueryBenchmark(): QueryBenchmarkResult[] {
  const database = requireDb();
  const results: QueryBenchmarkResult[] = [];
  const time = (label: string, fn: () => number) => {
    const t0 = performance.now();
    const rows = fn();
    results.push({ label, ms: performance.now() - t0, rows });
  };

  time('countRecords (all tiers)', () => countRecords(database, { includeBlockchainDiscovered: true }));
  time('countRecords (owned only)', () => countRecords(database, { includeBlockchainDiscovered: false }));
  time('record page (first 100)', () => getRecordPage(database, { limit: 100, includeBlockchainDiscovered: true }).length);
  time('record search "synth"', () =>
    getRecordPage(database, { limit: 100, search: 'synth', includeBlockchainDiscovered: true }).length,
  );
  time('count owned UTXOs (anti-join)', () => countOwnedUtxos(database));
  time('owned UTXO page (first 500)', () => getOwnedUtxos(database, { limit: 500 }).length);
  time('address aggregates (200 addrs)', () => {
    const addrs: string[] = [];
    for (let i = 1; i <= 200; i++) addrs.push(`bc1qsynth${i}`);
    return getAddressAggregates(database, addrs).size;
  });

  return results;
}

function clearAll(): void {
  const database = requireDb();
  database.exec('DELETE FROM records; DELETE FROM blockchainTransactions; DELETE FROM transactionParticipants; DELETE FROM seedMeta;');
}

// --------------------------------------------------------------------------
// Query passthrough
// --------------------------------------------------------------------------

function qRecordPage(opts: RecordPageOptions): RecordRow[] {
  return getRecordPage(requireDb(), opts);
}
function qCountRecords(opts: RecordQueryOptions): number {
  return countRecords(requireDb(), opts);
}
function qAddressAggregates(addresses: string[]): AddressAggregate[] {
  return Array.from(getAddressAggregates(requireDb(), addresses).values());
}
function qOwnedUtxos(opts: { tiers?: string[]; afterId?: number; limit: number }): OwnedUtxo[] {
  return getOwnedUtxos(requireDb(), opts);
}
function qCountOwnedUtxos(tiers?: string[]): number {
  return countOwnedUtxos(requireDb(), tiers);
}
function qParticipantsByTxids(txids: string[]): ParticipantRow[] {
  return getParticipantsByTxids(requireDb(), txids);
}
function qParticipantsByAddresses(addresses: string[]): ParticipantRow[] {
  return getParticipantsByAddresses(requireDb(), addresses);
}

const api = {
  init,
  getStatus,
  seedTable,
  seedAll,
  cancelSeeding,
  reopenAndVerify,
  generateSynthetic,
  runQueryBenchmark,
  clearAll,
  getRecordPage: qRecordPage,
  countRecords: qCountRecords,
  getAddressAggregates: qAddressAggregates,
  getOwnedUtxos: qOwnedUtxos,
  countOwnedUtxos: qCountOwnedUtxos,
  getParticipantsByTxids: qParticipantsByTxids,
  getParticipantsByAddresses: qParticipantsByAddresses,
};

export type EngineWorkerApi = typeof api;

Comlink.expose(api);

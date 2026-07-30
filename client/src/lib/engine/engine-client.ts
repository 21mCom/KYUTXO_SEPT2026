/**
 * Renderer-side client for the KYUTXO NATIVE read-engine (Task #272).
 *
 * The SQLite work runs in a better-sqlite3 worker_thread on Electron's Node side
 * (see client/src/workers/engine-node-worker.ts), reached through a FIXED set of
 * IPC channels exposed by the preload as `window.electronAPI.engine.*`. The
 * renderer can never pass arbitrary SQL or file paths — only a closed enum of
 * query names and pre-mapped rows.
 *
 * What lives HERE (the renderer): the IndexedDB keyset reader + the Dexie→mirror
 * row mappers + the PUSH seed loop (seedBegin → stream seedBatch → seedFinish).
 * The renderer owns the source (Dexie) schema, so it maps rows and streams them;
 * the worker owns the SQLite side and the EMPTY→LOADING→INDEXING→READY/ERROR
 * state machine.
 *
 * This is an ISOLATED engine surface — it does not touch the live Dexie data
 * paths. Screens are ported onto it only after the foundation is proven at scale.
 */
import type { EngineBridge, EngineEnvelope } from '../electron';
import type {
  RecordRow,
  RecordPageOptions,
  RecordPageByUpdatedAtOptions,
  RecordQueryOptions,
  CreatedAtEngineCursor,
  RecordsFingerprint,
  TransactionsFingerprint,
  ParticipantsFingerprint,
  AddressAggregate,
  OwnedUtxo,
  OutpointCoverage,
  ParticipantRow,
  TransactionQueryOptions,
  TransactionPageOptions,
  TransactionPageRow,
  TransactionPageCursor,
  TransactionAggregate,
  BalanceGroupBy,
  BalanceGroupSummary,
  BalanceSummariesResult,
  WalletUsageSummary,
  VaultSummaryRow,
  SeedMeta,
  MirrorTable,
  DbFileStats,
  SyntheticSpec,
} from './engine-core';
// Type-only — fully erased at build, so the Node worker module (which imports
// better-sqlite3) is never pulled into the renderer bundle.
import type {
  EngineState,
  EngineSnapshot,
  BenchmarkRow,
  FinalizeProgress,
} from '../../workers/engine-node-worker';
import { withEngineTimeout } from './engine-timeout';

export type {
  RecordRow,
  RecordPageOptions,
  RecordPageByUpdatedAtOptions,
  RecordQueryOptions,
  CreatedAtEngineCursor,
  RecordsFingerprint,
  TransactionsFingerprint,
  ParticipantsFingerprint,
  AddressAggregate,
  OwnedUtxo,
  OutpointCoverage,
  ParticipantRow,
  TransactionQueryOptions,
  TransactionPageOptions,
  TransactionPageRow,
  TransactionPageCursor,
  TransactionAggregate,
  BalanceGroupBy,
  BalanceGroupSummary,
  BalanceSummariesResult,
  WalletUsageSummary,
  VaultSummaryRow,
  SeedMeta,
  MirrorTable,
  DbFileStats,
  SyntheticSpec,
  EngineState,
  EngineSnapshot,
  BenchmarkRow,
  FinalizeProgress,
};

export interface ReopenResult {
  before: number;
  after: number;
  ready: boolean;
  fileStats: DbFileStats;
}

export interface DbInfo {
  dbPath: string;
  portableMode: boolean;
}

export interface SeedProgress {
  table: MirrorTable;
  processed: number;
  total: number;
  /** 1-based position of the table currently streaming (e.g. 2 of 3). */
  tableIndex: number;
  /** Total number of tables mirrored in this seed run. */
  tableCount: number;
  /**
   * Rows processed across every table so far (this table included). Combined
   * with `overallTotal` this gives a single steady percentage that moves
   * forward across all tables instead of resetting per table.
   */
  overallProcessed: number;
  /**
   * Total rows across every table, counted up front before any streaming
   * begins so a global total is known from the first progress event.
   */
  overallTotal: number;
}

export interface SeedResult {
  table: MirrorTable;
  copied: number;
  sourceCount: number;
  durationMs: number;
  cancelled: boolean;
  complete: boolean;
}

export interface SyntheticResult {
  records: number;
  transactions: number;
  participants: number;
}

export const ENGINE_UNAVAILABLE_MESSAGE =
  'The native read-engine runs only in the KYUTXO desktop app. Open this page from the ' +
  'desktop build — it is not available in the browser preview.';

// Source IndexedDB (Dexie) database + the stores we mirror.
const IDB_NAME = 'KYUTXODatabase';
let seedChunkSize = 10000;
const MIRROR_TABLES: MirrorTable[] = ['records', 'blockchainTransactions', 'transactionParticipants'];

/**
 * Test-only seam: override the keyset batch size so unit tests can exercise the
 * multi-batch paging loop without inserting tens of thousands of rows. Pass no
 * argument to restore the production default. Not used in production code.
 */
export function __setSeedChunkSizeForTests(size?: number): void {
  seedChunkSize = size && size > 0 ? size : 10000;
}

// ---------------------------------------------------------------------------
// IPC plumbing
// ---------------------------------------------------------------------------

export function isEngineAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI?.engine;
}

function getEngine(): EngineBridge {
  const engine = typeof window !== 'undefined' ? window.electronAPI?.engine : undefined;
  if (!engine) throw new Error(ENGINE_UNAVAILABLE_MESSAGE);
  return engine;
}

/** Unwrap the uniform { ok, result, error } envelope into a value or a throw. */
async function unwrap<T>(p: Promise<EngineEnvelope>): Promise<T> {
  const env = await p;
  if (!env || !env.ok) throw new Error(env?.error || 'Engine call failed');
  return env.result as T;
}

let initPromise: Promise<EngineSnapshot> | null = null;
let cancelRequested = false;

export async function ensureEngineInit(): Promise<EngineSnapshot> {
  if (!isEngineAvailable()) throw new Error(ENGINE_UNAVAILABLE_MESSAGE);
  if (!initPromise) {
    initPromise = unwrap<EngineSnapshot>(getEngine().init()).catch((err) => {
      initPromise = null; // allow a retry after a failed init
      throw err;
    });
  }
  return initPromise;
}

export async function getEngineStatus(): Promise<EngineSnapshot> {
  await ensureEngineInit();
  return unwrap<EngineSnapshot>(getEngine().status());
}

export async function getDbInfo(): Promise<DbInfo> {
  return unwrap<DbInfo>(getEngine().dbInfo());
}

/**
 * Cheap "can a live screen read from the engine right now?" probe. Returns false
 * (never throws) in the browser preview or whenever the engine is not fully
 * mirrored/indexed, so callers can transparently fall back to the Dexie path.
 * The freshness matters: it re-queries status so a seed that finished after the
 * cached init snapshot is reflected immediately.
 */
export async function engineReadyForReads(): Promise<boolean> {
  if (!isEngineAvailable()) return false;
  try {
    // Bounded like the read gate: the worker is single-threaded, so while it runs
    // the long synchronous seed `finalize` step it cannot answer `status`. Without
    // a timeout the readiness poll's first sample would block until finalize ended
    // and then silently baseline as `ready` — missing the not-ready→ready
    // transition, so pages that fell back to Dexie during the seed would never be
    // told to re-query. Timing out keeps the baseline `false` until READY is real.
    const snap = await withEngineTimeout(getEngineStatus());
    return !!snap.ready;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Readiness change subscription
// ---------------------------------------------------------------------------
//
// The engine worker owns the EMPTY→LOADING→INDEXING→READY state machine but has
// no push channel back to the renderer, so a screen sitting idle while a
// seed/mirror finishes in the background would otherwise never learn the faster
// engine path became available. This is a tiny shared poll that watches
// engineReadyForReads() and notifies listeners only on a *transition* (ready ↔
// not-ready, in either direction). The poll exists only while there is at least
// one listener AND the engine is available, so the browser preview (no engine)
// pays nothing — subscribe() is a no-op there and starts no timer.

type ReadinessListener = (ready: boolean) => void;
const readinessListeners = new Set<ReadinessListener>();
let readinessPollTimer: ReturnType<typeof setInterval> | null = null;
let lastReadyState: boolean | null = null;
let readinessPollInFlight = false;
const READINESS_POLL_MS = 2000;

async function pollReadinessOnce(): Promise<void> {
  if (readinessPollInFlight) return; // never overlap a slow status() call
  readinessPollInFlight = true;
  try {
    const ready = await engineReadyForReads();
    if (lastReadyState === null) {
      // First sample after subscribe: establish the baseline without firing, so
      // we only ever notify on an actual change the screen hasn't seen yet.
      lastReadyState = ready;
      return;
    }
    if (ready !== lastReadyState) {
      lastReadyState = ready;
      readinessListeners.forEach((listener) => {
        try {
          listener(ready);
        } catch {
          // A misbehaving listener must not stop the others or the poll.
        }
      });
    }
  } finally {
    readinessPollInFlight = false;
  }
}

/**
 * Subscribe to engine readiness transitions. The callback fires whenever the
 * engine flips between ready and not-ready while you are subscribed (e.g. a
 * background seed reaches READY). Returns an unsubscribe function; the shared
 * poll stops once the last listener unsubscribes.
 *
 * In the browser preview (no engine) this is a no-op that starts no polling.
 */
export function subscribeEngineReadiness(listener: ReadinessListener): () => void {
  if (!isEngineAvailable()) return () => {};
  readinessListeners.add(listener);
  if (!readinessPollTimer) {
    void pollReadinessOnce(); // prime the baseline immediately
    readinessPollTimer = setInterval(() => void pollReadinessOnce(), READINESS_POLL_MS);
  }
  return () => {
    readinessListeners.delete(listener);
    if (readinessListeners.size === 0 && readinessPollTimer) {
      clearInterval(readinessPollTimer);
      readinessPollTimer = null;
      lastReadyState = null; // re-baseline on the next subscribe
    }
  };
}

/**
 * Subscribe to PUSHED finalize-phase progress (build indexes → materialize
 * owned-UTXO sets → integrity check). Unlike readiness, these events are pushed
 * from the worker between sub-steps, so they keep flowing even while the worker
 * is busy in the synchronous finalize and cannot answer `status` polls — which is
 * exactly when the screen used to look frozen on "pending".
 *
 * Returns an unsubscribe function. No-op (returns a no-op unsubscribe) in the
 * browser preview or if the desktop bridge predates this channel.
 */
export function subscribeFinalizeProgress(
  listener: (progress: FinalizeProgress) => void,
): () => void {
  if (!isEngineAvailable()) return () => {};
  const engine = getEngine();
  if (typeof engine.onFinalizeProgress !== 'function') return () => {};
  return engine.onFinalizeProgress((progress) => listener(progress as FinalizeProgress));
}

// ---------------------------------------------------------------------------
// IndexedDB keyset reader (source = the live Dexie vault)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Row mappers (Dexie object -> mirror row)
// ---------------------------------------------------------------------------

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

export function mapRecord(o: Record<string, unknown>): RecordRow {
  const inputString = toText(o.inputString) ?? '';
  // Dexie stores vault metadata as a NESTED object (record.vault.*); flatten it
  // into the mirror's v2 columns so Vaults can group by it without a join.
  const vault =
    o.vault && typeof o.vault === 'object' ? (o.vault as Record<string, unknown>) : null;
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
    derivationPath: toText(o.derivationPath),
    discoveredInTxid: toText(o.discoveredInTxid),
    vaultIsVaultXpub: vault?.isVaultXpub ? 1 : 0,
    vaultM: toInt(vault?.m),
    vaultN: toInt(vault?.n),
    vaultName: toText(vault?.vaultName),
    vaultNotes: toText(vault?.vaultNotes),
  };
}

export function mapTransaction(o: Record<string, unknown>) {
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

export function mapParticipant(o: Record<string, unknown>): ParticipantRow {
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

const TABLE_MAPPERS: Record<MirrorTable, (o: Record<string, unknown>) => unknown> = {
  records: mapRecord,
  blockchainTransactions: mapTransaction,
  transactionParticipants: mapParticipant,
};

// ---------------------------------------------------------------------------
// Seed (PUSH): read Dexie keyset → map → stream batches over IPC
// ---------------------------------------------------------------------------

export function cancelSeeding(): void {
  cancelRequested = true;
}

/** Count a source store up front, treating a missing/erroring store as empty. */
async function countSource(idb: IDBDatabase, table: MirrorTable): Promise<number> {
  if (!idb.objectStoreNames.contains(table)) return 0;
  try {
    return await idbCount(idb, table);
  } catch {
    return 0;
  }
}

/** Aggregate context shared across every table so progress is a single steady total. */
interface SeedAggregate {
  /** Source row count for this table, counted up front. */
  sourceCount: number;
  /** 1-based position of this table in the seed run. */
  tableIndex: number;
  /** Total number of tables in the seed run. */
  tableCount: number;
  /** Rows already copied by previously-completed tables. */
  priorProcessed: number;
  /** Total rows across every table, known before streaming begins. */
  overallTotal: number;
}

async function seedTableStream(
  idb: IDBDatabase,
  table: MirrorTable,
  agg: SeedAggregate,
  onProgress?: (p: SeedProgress) => void,
): Promise<SeedResult> {
  const start = performance.now();
  const engine = getEngine();
  const { sourceCount, tableIndex, tableCount, priorProcessed, overallTotal } = agg;

  const emit = (processed: number, total: number) => {
    onProgress?.({
      table,
      processed,
      total,
      tableIndex,
      tableCount,
      overallProcessed: priorProcessed + processed,
      overallTotal,
    });
  };

  // Empty / new vault: the source store may not exist. Nothing to copy.
  if (!idb.objectStoreNames.contains(table)) {
    emit(0, sourceCount);
    return { table, copied: 0, sourceCount: 0, durationMs: performance.now() - start, cancelled: false, complete: true };
  }

  const map = TABLE_MAPPERS[table];
  let lastId = 0; // full rebuild — seedBegin already dropped everything
  let copied = 0;
  let cancelled = false;

  emit(0, sourceCount);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (cancelRequested) {
      cancelled = true;
      break;
    }
    const batch = await idbGetBatch(idb, table, lastId, seedChunkSize);
    if (batch.length === 0) break;

    const mapped = batch.map((o) => map(o as Record<string, unknown>));
    await unwrap(engine.seedBatch(table, mapped));

    const lastRow = batch[batch.length - 1] as { id: number };
    lastId = Number(lastRow.id);
    copied += batch.length;
    emit(copied, Math.max(sourceCount, copied));

    if (batch.length < seedChunkSize) break;
  }

  return {
    table,
    copied,
    sourceCount,
    durationMs: performance.now() - start,
    cancelled,
    complete: !cancelled && copied >= sourceCount,
  };
}

// ---------------------------------------------------------------------------
// Single renderer seed lock
// ---------------------------------------------------------------------------
//
// Seeding is a full rebuild: seedBegin drops everything, then a single stream of
// seedBatch calls repopulates each table. Two seed streams running at once (e.g.
// the launch auto-seed and a manual Diagnostics seed) would interleave their
// seedBatch writes after a shared seedBegin and corrupt the mirror. So only ONE
// renderer seed may be in flight at a time: a second caller awaits the existing
// run instead of starting a second rebuild. The first caller's onProgress wins;
// later callers just resolve with the same results.

let seedInFlight: Promise<SeedResult[]> | null = null;

/** True while a renderer seed (auto or manual) is streaming into the engine. */
export function engineSeedInFlight(): boolean {
  return seedInFlight !== null;
}

/**
 * Full-rebuild seed of the whole vault into the engine. Drops + rebuilds via
 * seedBegin, streams every table, then seedFinish builds indexes, runs
 * integrity_check and marks the engine READY. On cancel it aborts via clear() so
 * the worker is never left in a half-seeded LOADING state.
 *
 * Guarded by the single-seed lock above: concurrent callers share one rebuild.
 */
export function seedAll(onProgress?: (p: SeedProgress) => void): Promise<SeedResult[]> {
  if (seedInFlight) return seedInFlight;
  seedInFlight = seedAllInner(onProgress).finally(() => {
    seedInFlight = null;
  });
  return seedInFlight;
}

async function seedAllInner(onProgress?: (p: SeedProgress) => void): Promise<SeedResult[]> {
  await ensureEngineInit();
  const engine = getEngine();
  cancelRequested = false;

  await unwrap(engine.seedBegin());

  const idb = await openIdb();
  const sourceCounts: Record<MirrorTable, number> = {
    records: 0,
    blockchainTransactions: 0,
    transactionParticipants: 0,
  };
  const results: SeedResult[] = [];
  let cancelled = false;
  try {
    // Gather every source count up front so the aggregate total is known
    // before any streaming begins. This lets the UI render one steady
    // percentage across all tables instead of three bars resetting.
    for (const table of MIRROR_TABLES) {
      sourceCounts[table] = await countSource(idb, table);
    }
    const overallTotal = MIRROR_TABLES.reduce((sum, t) => sum + sourceCounts[t], 0);

    let priorProcessed = 0;
    for (let i = 0; i < MIRROR_TABLES.length; i++) {
      const table = MIRROR_TABLES[i];
      const r = await seedTableStream(
        idb,
        table,
        {
          sourceCount: sourceCounts[table],
          tableIndex: i + 1,
          tableCount: MIRROR_TABLES.length,
          priorProcessed,
          overallTotal,
        },
        onProgress,
      );
      results.push(r);
      priorProcessed += r.copied;
      if (r.cancelled) {
        cancelled = true;
        break;
      }
    }
  } finally {
    idb.close();
  }

  if (cancelled) {
    // Abort: drop the partial mirror and clear the worker's seeding flag.
    await unwrap(engine.clear());
  } else {
    await unwrap(engine.seedFinish(sourceCounts));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Lifecycle / diagnostics
// ---------------------------------------------------------------------------

export async function reopenAndVerify(): Promise<ReopenResult> {
  await ensureEngineInit();
  return unwrap<ReopenResult>(getEngine().reopen());
}

export async function engineIntegrityCheck(): Promise<string> {
  await ensureEngineInit();
  return unwrap<string>(getEngine().integrityCheck());
}

export async function runQueryBenchmark(): Promise<BenchmarkRow[]> {
  await ensureEngineInit();
  return unwrap<BenchmarkRow[]>(getEngine().benchmark());
}

export async function generateSynthetic(spec: SyntheticSpec): Promise<SyntheticResult> {
  await ensureEngineInit();
  return unwrap<SyntheticResult>(getEngine().generateSynthetic(spec));
}

export async function clearEngine(): Promise<EngineSnapshot> {
  await ensureEngineInit();
  return unwrap<EngineSnapshot>(getEngine().clear());
}

// ---------------------------------------------------------------------------
// Query passthrough (closed enum of names enforced by the worker)
// ---------------------------------------------------------------------------

export async function engineGetRecordPage(opts: RecordPageOptions): Promise<RecordRow[]> {
  await ensureEngineInit();
  return unwrap<RecordRow[]>(getEngine().query('getRecordPage', opts));
}

/**
 * Records page ordered by updatedAt DESC, id DESC (the Dashboard's order). Used
 * to pick the ordered ids for a page; full records are then hydrated from Dexie
 * by primary key so the returned objects stay identical to the Dexie fallback.
 */
export async function engineGetRecordPageByUpdatedAt(
  opts: RecordPageByUpdatedAtOptions,
): Promise<RecordRow[]> {
  await ensureEngineInit();
  return unwrap<RecordRow[]>(getEngine().query('getRecordPageByUpdatedAt', opts));
}

/**
 * Schema version stamped into the mirror at its last successful finalize (0 for a
 * pre-versioning mirror). The freshness gate refuses the engine when this differs
 * from ENGINE_SCHEMA_VERSION so a stale-shape mirror can never serve NULL columns.
 */
export async function engineGetSchemaVersion(): Promise<number> {
  await ensureEngineInit();
  return unwrap<number>(getEngine().query('getEngineSchemaVersion', null));
}

export async function engineCountRecords(opts: RecordQueryOptions = {}): Promise<number> {
  await ensureEngineInit();
  return unwrap<number>(getEngine().query('countRecords', opts));
}

/**
 * Freshness fingerprint of the mirror's `records` table (count + maxId +
 * maxUpdatedAt). Callers compare this against the live Dexie source to confirm
 * the mirror is current before serving a read from the engine.
 */
export async function engineGetRecordsFingerprint(): Promise<RecordsFingerprint> {
  await ensureEngineInit();
  return unwrap<RecordsFingerprint>(getEngine().query('getRecordsFingerprint', null));
}

/**
 * Freshness fingerprint of the mirror's `blockchainTransactions` table (count +
 * maxId + maxBlockTime). Compared against the live Dexie source alongside the
 * records + participants fingerprints before serving an owned-UTXO read.
 */
export async function engineGetTransactionsFingerprint(): Promise<TransactionsFingerprint> {
  await ensureEngineInit();
  return unwrap<TransactionsFingerprint>(getEngine().query('getTransactionsFingerprint', null));
}

/**
 * Freshness fingerprint of the mirror's `transactionParticipants` table (count +
 * maxId + resolvedPrevoutCount). The resolved-prevout count catches in-place
 * prevout backfill that inserts/deletes alone would miss.
 */
export async function engineGetParticipantsFingerprint(): Promise<ParticipantsFingerprint> {
  await ensureEngineInit();
  return unwrap<ParticipantsFingerprint>(getEngine().query('getParticipantsFingerprint', null));
}

export async function engineGetAddressAggregates(addresses: string[]): Promise<AddressAggregate[]> {
  await ensureEngineInit();
  return unwrap<AddressAggregate[]>(getEngine().query('getAddressAggregates', addresses));
}

export async function engineGetOwnedUtxos(opts: {
  tiers?: string[];
  afterId?: number;
  limit: number;
  /** Unix-seconds cutoff for an "as of" historical owned-UTXO read. */
  asOfBlockTime?: number;
}): Promise<OwnedUtxo[]> {
  await ensureEngineInit();
  return unwrap<OwnedUtxo[]>(getEngine().query('getOwnedUtxos', opts));
}

export async function engineCountOwnedUtxos(
  opts: { tiers?: string[]; asOfBlockTime?: number } = {},
): Promise<number> {
  await ensureEngineInit();
  return unwrap<number>(getEngine().query('countOwnedUtxos', opts));
}

/**
 * Outpoint (prevTxid/prevVout) coverage across the inputs of the owned tx set,
 * for the UTXOs page's Standard-mode accuracy warning on the engine fast path.
 */
export async function engineGetOutpointCoverage(
  opts: { tiers?: string[] } = {},
): Promise<OutpointCoverage> {
  await ensureEngineInit();
  return unwrap<OutpointCoverage>(getEngine().query('getOutpointCoverage', opts));
}

export async function engineGetHeuristicOwnedUtxos(opts: {
  tiers?: string[];
  afterId?: number;
  limit: number;
  /** Unix-seconds cutoff for an "as of" historical heuristic owned-UTXO read. */
  asOfBlockTime?: number;
}): Promise<OwnedUtxo[]> {
  await ensureEngineInit();
  return unwrap<OwnedUtxo[]>(getEngine().query('getHeuristicOwnedUtxos', opts));
}

export async function engineCountHeuristicOwnedUtxos(
  opts: { tiers?: string[]; asOfBlockTime?: number } = {},
): Promise<number> {
  await ensureEngineInit();
  return unwrap<number>(getEngine().query('countHeuristicOwnedUtxos', opts));
}

export async function engineGetParticipantsByTxids(txids: string[]): Promise<ParticipantRow[]> {
  await ensureEngineInit();
  return unwrap<ParticipantRow[]>(getEngine().query('getParticipantsByTxids', txids));
}

export async function engineGetParticipantsByAddresses(addresses: string[]): Promise<ParticipantRow[]> {
  await ensureEngineInit();
  return unwrap<ParticipantRow[]>(getEngine().query('getParticipantsByAddresses', addresses));
}

// ---------------------------------------------------------------------------
// Transactions screen
// ---------------------------------------------------------------------------

/** Total transactions (optionally OP_RETURN-only), for the Transactions header count. */
export async function engineCountTransactions(opts: TransactionQueryOptions = {}): Promise<number> {
  await ensureEngineInit();
  return unwrap<number>(getEngine().query('countTransactions', opts));
}

/**
 * One keyset page of transactions (newest first), each enriched with
 * totalOutputValue + input/output participant counts. Pass the previous page's
 * last-row cursor to fetch the next page for virtual scrolling.
 */
export async function engineGetTransactionPage(
  opts: TransactionPageOptions,
): Promise<TransactionPageRow[]> {
  await ensureEngineInit();
  return unwrap<TransactionPageRow[]>(getEngine().query('getTransactionPage', opts));
}

// ---------------------------------------------------------------------------
// Overview screens (balance / wallet / vaults)
// ---------------------------------------------------------------------------

/** Balance overview group summaries + deduped grand totals for one grouping dimension. */
export async function engineGetBalanceGroupSummaries(
  groupBy: BalanceGroupBy,
): Promise<BalanceSummariesResult> {
  await ensureEngineInit();
  return unwrap<BalanceSummariesResult>(getEngine().query('getBalanceGroupSummaries', { groupBy }));
}

/** Wallet overview receive/change usage summaries grouped by walletName. */
export async function engineGetWalletUsageSummaries(): Promise<WalletUsageSummary[]> {
  await ensureEngineInit();
  return unwrap<WalletUsageSummary[]>(getEngine().query('getWalletUsageSummaries', null));
}

/** Vault summaries grouped by flattened vault metadata, with an optional coarse search prefilter. */
export async function engineGetVaultSummaries(
  opts: { search?: string } = {},
): Promise<VaultSummaryRow[]> {
  await ensureEngineInit();
  return unwrap<VaultSummaryRow[]>(getEngine().query('getVaultSummaries', opts));
}

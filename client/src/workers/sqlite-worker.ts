/**
 * SQLite-WASM Web Worker (prototype, Task #229)
 *
 * Runs SQLite-WASM entirely off the main thread. Storage uses the OPFS SAH Pool
 * VFS (which does NOT require COOP/COEP cross-origin isolation), with a graceful
 * fall back to an in-memory database when OPFS is unavailable.
 *
 * Seeding reads `transactionParticipants` directly from the existing Dexie
 * IndexedDB database via the raw IndexedDB API, paged by primary key in small
 * chunks. Because all of this happens inside the worker, the main thread can
 * never freeze — this is the explicit fix for the earlier prototype hang, which
 * was caused by copying millions of rows on the main thread without yielding.
 */
import * as Comlink from 'comlink';
import sqlite3InitModule, { type Sqlite3Static, type Database } from '@sqlite.org/sqlite-wasm';

const DB_FILENAME = '/kyutxo-prototype.sqlite3';
const SAH_POOL_NAME = 'kyutxo-sahpool';
const IDB_NAME = 'KYUTXODatabase';
const IDB_STORE = 'transactionParticipants';

// How many rows to move per chunk during seeding. Small enough to stay
// responsive and report frequent progress, large enough to be efficient.
const SEED_CHUNK_SIZE = 5000;
// SQLite limits the number of bound parameters per statement; keep IN() lists
// comfortably under the default ceiling.
const PARAM_BATCH_SIZE = 800;

export type StorageMode = 'opfs-sahpool' | 'memory';

export interface InitResult {
  storageMode: StorageMode;
  sqliteVersion: string;
}

/** Tables mirrored into the SQLite prototype, in seed order. */
const MIRROR_TABLES = ['transactionParticipants'] as const;
type MirrorTable = (typeof MIRROR_TABLES)[number];

export interface SeedProgress {
  /** The table currently streaming. */
  table: MirrorTable;
  /** Rows processed for the current table. */
  processed: number;
  /** Source row count for the current table. */
  total: number;
  /** 1-based position of the table currently streaming (e.g. 1 of 1). */
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
  rowCount: number;
  durationMs: number;
  cancelled: boolean;
}

export interface SqliteStatus {
  initialized: boolean;
  storageMode: StorageMode;
  rowCount: number;
}

export interface ParticipantRow {
  id: number;
  txid: string;
  role: 'input' | 'output';
  address: string;
  amount: number;
  vout: number | null;
  prevTxid: string | null;
  prevVout: number | null;
  recordId: number | null;
  scriptType: string | null;
}

let sqlite3: Sqlite3Static | null = null;
let db: Database | null = null;
let storageMode: StorageMode = 'memory';
let cancelRequested = false;

function requireDb(): Database {
  if (!db) throw new Error('SQLite worker not initialized — call init() first');
  return db;
}

function createSchema(): void {
  // Mirrors the Dexie schema for transactionParticipants:
  //   ++id, [txid+role], txid, role, address, recordId, [prevTxid+prevVout]
  requireDb().exec(`
    CREATE TABLE IF NOT EXISTS transactionParticipants (
      id        INTEGER PRIMARY KEY,
      txid      TEXT    NOT NULL,
      role      TEXT    NOT NULL,
      address   TEXT    NOT NULL,
      amount    INTEGER NOT NULL,
      vout      INTEGER,
      prevTxid  TEXT,
      prevVout  INTEGER,
      recordId  INTEGER,
      scriptType TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tp_txid_role ON transactionParticipants(txid, role);
    CREATE INDEX IF NOT EXISTS idx_tp_txid      ON transactionParticipants(txid);
    CREATE INDEX IF NOT EXISTS idx_tp_role      ON transactionParticipants(role);
    CREATE INDEX IF NOT EXISTS idx_tp_address   ON transactionParticipants(address);
    CREATE INDEX IF NOT EXISTS idx_tp_recordId  ON transactionParticipants(recordId);
    CREATE INDEX IF NOT EXISTS idx_tp_prev      ON transactionParticipants(prevTxid, prevVout);
  `);
}

async function init(): Promise<InitResult> {
  if (db && sqlite3) {
    return { storageMode, sqliteVersion: sqlite3.version.libVersion };
  }

  sqlite3 = await sqlite3InitModule();

  try {
    const poolUtil = await sqlite3.installOpfsSAHPoolVfs({ name: SAH_POOL_NAME });
    db = new poolUtil.OpfsSAHPoolDb(DB_FILENAME);
    storageMode = 'opfs-sahpool';
    console.log('[sqlite-worker] storage mode: OPFS SAH Pool VFS (persistent)');
  } catch (err) {
    console.warn('[sqlite-worker] OPFS SAH Pool unavailable, falling back to in-memory database', err);
    db = new sqlite3.oo1.DB(':memory:', 'c');
    storageMode = 'memory';
    console.log('[sqlite-worker] storage mode: in-memory (non-persistent fallback)');
  }

  createSchema();
  return { storageMode, sqliteVersion: sqlite3.version.libVersion };
}

function countParticipants(): number {
  const rows: Array<{ c: number }> = [];
  requireDb().exec({
    sql: 'SELECT COUNT(*) AS c FROM transactionParticipants',
    rowMode: 'object',
    resultRows: rows,
  });
  return rows[0]?.c ?? 0;
}

function getStatus(): SqliteStatus {
  if (!db) {
    return { initialized: false, storageMode, rowCount: 0 };
  }
  return { initialized: true, storageMode, rowCount: countParticipants() };
}

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // No version specified: opens the existing DB at its current version without
    // triggering a Dexie upgrade or conflicting with the main thread.
    const req = indexedDB.open(IDB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

function idbCount(idb: IDBDatabase): Promise<number> {
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB count failed'));
  });
}

// Read one page of rows with id > lastId, ordered by primary key. A fresh
// transaction is created per page because IndexedDB transactions auto-close
// once control returns to the event loop between awaits.
function idbGetBatch(idb: IDBDatabase, lastId: number, limit: number): Promise<ParticipantRow[]> {
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, 'readonly');
    const store = tx.objectStore(IDB_STORE);
    const range = IDBKeyRange.lowerBound(lastId, true);
    const req = store.getAll(range, limit);
    req.onsuccess = () => resolve(req.result as ParticipantRow[]);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB getAll failed'));
  });
}

function insertBatch(rows: ParticipantRow[]): void {
  const database = requireDb();
  database.exec('BEGIN');
  try {
    const stmt = database.prepare(
      `INSERT OR REPLACE INTO transactionParticipants
        (id, txid, role, address, amount, vout, prevTxid, prevVout, recordId, scriptType)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    try {
      for (const r of rows) {
        stmt.bind([
          r.id,
          r.txid,
          r.role,
          r.address,
          r.amount ?? 0,
          r.vout ?? null,
          r.prevTxid ?? null,
          r.prevVout ?? null,
          r.recordId ?? null,
          r.scriptType ?? null,
        ]);
        stmt.step();
        stmt.reset();
      }
    } finally {
      stmt.finalize();
    }
    database.exec('COMMIT');
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
}

function cancelSeeding(): void {
  cancelRequested = true;
}

async function seedFromIndexedDB(
  onProgress?: (p: SeedProgress) => void,
  options?: { force?: boolean }
): Promise<SeedResult> {
  requireDb();
  cancelRequested = false;
  const start = performance.now();

  const existing = countParticipants();
  if (existing > 0 && !options?.force) {
    return { rowCount: existing, durationMs: 0, cancelled: false };
  }

  // Start from a clean slate so re-seeding is deterministic.
  requireDb().exec('DELETE FROM transactionParticipants');

  let idb: IDBDatabase;
  try {
    idb = await openIdb();
  } catch (err) {
    console.warn('[sqlite-worker] Could not open source IndexedDB for seeding', err);
    return { rowCount: 0, durationMs: performance.now() - start, cancelled: false };
  }

  if (!idb.objectStoreNames.contains(IDB_STORE)) {
    idb.close();
    return { rowCount: 0, durationMs: performance.now() - start, cancelled: false };
  }

  // Gather every source count up front so the aggregate total is known before
  // any streaming begins. This lets the UI render one steady percentage that
  // moves forward across all mirrored tables instead of resetting per table.
  let total = 0;
  try {
    total = await idbCount(idb);
  } catch {
    total = 0;
  }
  const overallTotal = total;
  const tableCount = MIRROR_TABLES.length;
  const tableIndex = 1;

  let processed = 0;
  let lastId = 0;
  let cancelled = false;

  const emit = (processedCount: number, tableTotal: number) => {
    onProgress?.({
      table: 'transactionParticipants',
      processed: processedCount,
      total: tableTotal,
      tableIndex,
      tableCount,
      overallProcessed: processedCount,
      overallTotal: Math.max(overallTotal, processedCount),
    });
  };

  emit(0, total);

  try {
    // Each loop iteration awaits a fresh IndexedDB read, which yields control
    // back to the worker event loop — keeping seeding fully cancellable and the
    // main thread completely free.
    while (true) {
      if (cancelRequested) {
        cancelled = true;
        break;
      }
      const batch = await idbGetBatch(idb, lastId, SEED_CHUNK_SIZE);
      if (batch.length === 0) break;

      insertBatch(batch);
      lastId = batch[batch.length - 1].id;
      processed += batch.length;
      emit(processed, Math.max(total, processed));

      if (batch.length < SEED_CHUNK_SIZE) break;
    }
  } finally {
    idb.close();
  }

  return {
    rowCount: countParticipants(),
    durationMs: performance.now() - start,
    cancelled,
  };
}

function queryRows(sql: string, bind: unknown[]): ParticipantRow[] {
  const rows: ParticipantRow[] = [];
  requireDb().exec({
    sql,
    bind: bind as never,
    rowMode: 'object',
    resultRows: rows as unknown[],
  } as never);
  return rows;
}

function getParticipantsByTxids(txids: string[]): ParticipantRow[] {
  if (txids.length === 0) return [];
  const results: ParticipantRow[] = [];
  for (let i = 0; i < txids.length; i += PARAM_BATCH_SIZE) {
    const batch = txids.slice(i, i + PARAM_BATCH_SIZE);
    const placeholders = batch.map(() => '?').join(',');
    results.push(
      ...queryRows(
        `SELECT * FROM transactionParticipants WHERE txid IN (${placeholders})`,
        batch
      )
    );
  }
  return results;
}

function getParticipantsByAddresses(addresses: string[]): ParticipantRow[] {
  if (addresses.length === 0) return [];
  const results: ParticipantRow[] = [];
  for (let i = 0; i < addresses.length; i += PARAM_BATCH_SIZE) {
    const batch = addresses.slice(i, i + PARAM_BATCH_SIZE);
    const placeholders = batch.map(() => '?').join(',');
    results.push(
      ...queryRows(
        `SELECT * FROM transactionParticipants WHERE address IN (${placeholders})`,
        batch
      )
    );
  }
  return results;
}

function clearData(): void {
  requireDb().exec('DELETE FROM transactionParticipants');
}

const api = {
  init,
  getStatus,
  countParticipants,
  seedFromIndexedDB,
  cancelSeeding,
  getParticipantsByTxids,
  getParticipantsByAddresses,
  clearData,
};

export type SqliteWorkerApi = typeof api;

Comlink.expose(api);

/**
 * KYUTXO SQLite read-engine — pure core.
 *
 * This module contains ZERO browser/OPFS/Comlink/Electron dependencies. It runs
 * against the small `EngineDb` driver contract (see below), so the exact same SQL
 * logic can be:
 *   - driven by the native better-sqlite3 worker inside Electron's Node side
 *     (production: DB file lives on the portable USB), and
 *   - unit-tested and benchmarked in plain Node against better-sqlite3.
 *
 * Responsibilities:
 *   - schema for the mirrored read tables, split into `createTablesOnly`
 *     (bulk-load phase, no secondary indexes) and `createIndexes` (+ANALYZE),
 *   - batched bulk inserts via the driver's single-transaction `insertMany`,
 *   - a `seedMeta` high-water table that lets the UI distinguish "fully mirrored"
 *     from "partially mirrored" (never show partial data as if it were complete);
 *     the seed uses a full-rebuild model — drop + re-seed on any interruption,
 *   - the target read queries (record page / counts / search, per-address
 *     aggregates, owned-UTXO exact anti-join, participant lookups),
 *   - synthetic data generation for at-scale benchmarking.
 *
 * Source-of-truth remains Dexie/IndexedDB. This engine is a derived read replica.
 */

/**
 * Minimal database driver contract this engine runs against. Implemented by a
 * thin adapter over better-sqlite3 (production worker + Node tests/benchmark).
 * Keeping the engine driver-agnostic means the exact same SQL is exercised in
 * Node tests and in the packaged Electron app.
 */
export interface EngineDb {
  /** Run one or more statements with no bound parameters (DDL, PRAGMA, ANALYZE). */
  exec(sql: string): void;
  /** Run a single parameterized statement (INSERT/UPDATE/DELETE or PRAGMA set). */
  run(sql: string, bind?: unknown[]): void;
  /** Select rows as plain objects keyed by column name. */
  selectRows<T = Record<string, unknown>>(sql: string, bind?: unknown[]): T[];
  /** Select the first column of the first row as a number (0 when no rows). */
  selectScalar(sql: string, bind?: unknown[]): number;
  /**
   * Prepare `sql` once and run it for every parameter tuple inside a SINGLE
   * transaction. This is the hot path for bulk-seeding tens of millions of rows.
   */
  insertMany(sql: string, rows: unknown[][]): void;
  /** Run `fn` inside a transaction (commit on success, rollback on throw). */
  transaction(fn: () => void): void;
}

// The tables we mirror in this stage. Lineage/custody are intentionally excluded
// here (not an existential-risk surface) and added when those screens are ported.
export type MirrorTable =
  | 'records'
  | 'blockchainTransactions'
  | 'transactionParticipants';

export const MIRROR_TABLES: MirrorTable[] = [
  'records',
  'blockchainTransactions',
  'transactionParticipants',
];

// The importance tiers that represent user-curated ("owned") addresses. Kept in
// sync with USER_CURATED_TIERS in db-types.ts (duplicated here so the pure core
// has no app imports).
export const OWNED_TIERS = ['verified', 'manual', 'wallet-import', 'xpub-derived'];

// SQL predicate selecting user-curated address rows (NULL importance = legacy
// manual entry, treated as curated). Allowlist-based like
// isUserCuratedImportance in db-types.ts so an unknown/future tier is excluded
// on BOTH the Dexie and engine paths — keep the tier list in sync.
export const CURATED_ADDRESS_SQL = `(addressImportance IS NULL OR addressImportance IN (${OWNED_TIERS.map((t) => `'${t}'`).join(', ')}))`;

// SQLite caps bound parameters per statement (default 32766 in modern builds,
// but historically 999). Stay well under the conservative ceiling for IN() lists.
const PARAM_BATCH_SIZE = 800;

// engineMeta keys for the materialized owned-UTXO set (see buildOwnedUtxos). The
// tiers signature records which owned tiers the materialized table was built for
// so reads only trust it when the requested tiers match; the count is cached so
// `countOwnedUtxos` is O(1) instead of scanning a multi-million-row table.
const OWNED_UTXOS_TIERS_KEY = 'owned_utxos_tiers';
const OWNED_UTXOS_COUNT_KEY = 'owned_utxos_count';

// engineMeta keys for the materialized HEURISTIC owned-UTXO set (see
// buildHeuristicOwnedUtxos). Mirrors the exact-mode keys above but for the
// no-prevout amount-matching computation, so the two materialized sets never
// collide and each is gated on its own tier signature.
const HEURISTIC_UTXOS_TIERS_KEY = 'heuristic_utxos_tiers';
const HEURISTIC_UTXOS_COUNT_KEY = 'heuristic_utxos_count';

// ---------------------------------------------------------------------------
// Row shapes (mirror columns). The worker maps Dexie objects onto these.
// ---------------------------------------------------------------------------

export interface RecordRow {
  id: number;
  type: string;
  inputString: string;
  inputStringLower: string;
  label: string | null;
  notes: string | null;
  owner: string | null;
  walletName: string | null;
  seedName: string | null;
  walletSoftware: string | null;
  addressImportance: string | null;
  chainType: string | null;
  syncDepth: number | null;
  firstSeenBlockTime: number | null;
  cachedBalanceSats: number | null;
  cachedTxCount: number | null;
  cachedUtxoCount: number | null;
  statsComputedAt: number | null;
  createdAt: number | null;
  updatedAt: number | null;
  tags: string | null; // JSON array text
  categories: string | null; // JSON array text
  // v2 columns — needed by Vaults + Wallet Overview engine aggregates. Optional so
  // the synthetic generator and existing fixtures stay valid; insertRecords binds null.
  derivationPath?: string | null;
  discoveredInTxid?: string | null;
  vaultIsVaultXpub?: number | null; // 0/1
  vaultM?: number | null;
  vaultN?: number | null;
  vaultName?: string | null;
  vaultNotes?: string | null;
}

export interface TransactionRow {
  id: number;
  txid: string;
  blockHeight: number | null;
  blockTime: number | null;
  fee: number | null;
  feeRate: number | null;
  vsize: number | null;
  hasOpReturn: number | null; // 0/1
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

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

function selectRows<T>(db: EngineDb, sql: string, bind: unknown[] = []): T[] {
  return db.selectRows<T>(sql, bind);
}

function selectScalar(db: EngineDb, sql: string, bind: unknown[] = []): number {
  return db.selectScalar(sql, bind);
}

function runInTx(db: EngineDb, fn: () => void): void {
  db.transaction(fn);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Create the mirror + seedMeta TABLES only — NO secondary indexes. The seed path
 * loads all rows into index-free tables (fast bulk inserts) and then calls
 * `createIndexes` once at the end. seedMeta always carries its PK so progress can
 * be tracked while data tables are still index-free.
 */
export function createTablesOnly(db: EngineDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS records (
      id                 INTEGER PRIMARY KEY,
      type               TEXT,
      inputString        TEXT,
      inputStringLower   TEXT,
      label              TEXT,
      notes              TEXT,
      owner              TEXT,
      walletName         TEXT,
      seedName           TEXT,
      walletSoftware     TEXT,
      addressImportance  TEXT,
      chainType          TEXT,
      syncDepth          INTEGER,
      firstSeenBlockTime INTEGER,
      cachedBalanceSats  INTEGER,
      cachedTxCount      INTEGER,
      cachedUtxoCount    INTEGER,
      statsComputedAt    INTEGER,
      createdAt          INTEGER,
      updatedAt          INTEGER,
      tags               TEXT,
      categories         TEXT,
      derivationPath     TEXT,
      discoveredInTxid   TEXT,
      vaultIsVaultXpub   INTEGER,
      vaultM             INTEGER,
      vaultN             INTEGER,
      vaultName          TEXT,
      vaultNotes         TEXT
    );

    CREATE TABLE IF NOT EXISTS blockchainTransactions (
      id          INTEGER PRIMARY KEY,
      txid        TEXT NOT NULL,
      blockHeight INTEGER,
      blockTime   INTEGER,
      fee         INTEGER,
      feeRate     REAL,
      vsize       INTEGER,
      hasOpReturn INTEGER
    );

    CREATE TABLE IF NOT EXISTS transactionParticipants (
      id         INTEGER PRIMARY KEY,
      txid       TEXT NOT NULL,
      role       TEXT NOT NULL,
      address    TEXT NOT NULL,
      amount     INTEGER NOT NULL,
      vout       INTEGER,
      prevTxid   TEXT,
      prevVout   INTEGER,
      recordId   INTEGER,
      scriptType TEXT
    );

    CREATE TABLE IF NOT EXISTS seedMeta (
      tableName    TEXT PRIMARY KEY,
      highWaterId  INTEGER NOT NULL DEFAULT 0,
      copied       INTEGER NOT NULL DEFAULT 0,
      sourceCount  INTEGER NOT NULL DEFAULT 0,
      complete     INTEGER NOT NULL DEFAULT 0,
      updatedAt    INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS engineMeta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

/**
 * One CREATE INDEX (or ANALYZE) step in the finalize phase, paired with a short
 * human-readable label so the UI can report which index is currently building.
 */
export interface IndexBuildStep {
  label: string;
  sql: string;
}

/**
 * Ordered list of every secondary index plus the trailing ANALYZE. This is the
 * single source of truth BOTH for the engine's read query plans AND for finalize
 * progress reporting: `createIndexes` runs each entry in turn so the worker can
 * push a "building index N of M (label)" update between statements (the index
 * build is the longest, formerly-silent part of the seed).
 */
export const INDEX_BUILD_STEPS: readonly IndexBuildStep[] = [
  { label: 'records by type', sql: 'CREATE INDEX IF NOT EXISTS idx_records_type_id ON records(type, id);' },
  { label: 'records by importance', sql: 'CREATE INDEX IF NOT EXISTS idx_records_importance_id ON records(addressImportance, id);' },
  { label: 'records by address', sql: 'CREATE INDEX IF NOT EXISTS idx_records_inputlower ON records(inputStringLower);' },
  { label: 'records by owner', sql: 'CREATE INDEX IF NOT EXISTS idx_records_owner ON records(owner);' },
  { label: 'records by wallet', sql: 'CREATE INDEX IF NOT EXISTS idx_records_walletName ON records(walletName);' },
  { label: 'owned-address lookup', sql: 'CREATE INDEX IF NOT EXISTS idx_records_addr_owned ON records(inputString, type, addressImportance);' },
  // Keyset order for the Records page's Date Added sort: (createdAt, id) matches
  // the Dexie createdAt-index iteration order (id ascending within ties), so the
  // engine can serve (createdAt asc/desc, id asc/desc) pages with a seek instead
  // of a full sort. NULL createdAt rows are excluded by the query (parity with
  // IndexedDB, which never indexes missing keys), so no COALESCE is needed.
  { label: 'records by date added (keyset)', sql: 'CREATE INDEX IF NOT EXISTS idx_records_createdAt_id ON records(createdAt, id);' },
  { label: 'transactions by txid', sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_bt_txid ON blockchainTransactions(txid);' },
  { label: 'transactions by time', sql: 'CREATE INDEX IF NOT EXISTS idx_bt_blockTime ON blockchainTransactions(blockTime);' },
  // Keyset order for the Transactions page: COALESCE(blockTime,0) DESC, id DESC.
  // An EXPRESSION index on the exact ORDER BY key lets the page scan newest-first
  // and seek past prior pages by (blockTime,id) instead of re-sorting every page.
  { label: 'transactions by time + id (keyset)', sql: 'CREATE INDEX IF NOT EXISTS idx_bt_time_id ON blockchainTransactions(COALESCE(blockTime,0), id);' },
  { label: 'participants by txid + role', sql: 'CREATE INDEX IF NOT EXISTS idx_tp_txid_role ON transactionParticipants(txid, role);' },
  { label: 'participants by txid', sql: 'CREATE INDEX IF NOT EXISTS idx_tp_txid ON transactionParticipants(txid);' },
  { label: 'participants by address', sql: 'CREATE INDEX IF NOT EXISTS idx_tp_address ON transactionParticipants(address);' },
  { label: 'participants by record', sql: 'CREATE INDEX IF NOT EXISTS idx_tp_recordId ON transactionParticipants(recordId);' },
  // Spent-check correlation for the UTXO anti-join: probe by (prevTxid, prevVout)
  // then confirm role='input'. Including role keeps the probe covering at scale.
  { label: 'spent-output lookup', sql: 'CREATE INDEX IF NOT EXISTS idx_tp_prev ON transactionParticipants(prevTxid, prevVout, role);' },
  // Owned-output scan + anti-join correlation (needs txid, vout) + keyset order (id).
  // Covering index so the owned-UTXO sweep avoids row lookups at 20M scale.
  { label: 'owned-output scan', sql: 'CREATE INDEX IF NOT EXISTS idx_tp_out ON transactionParticipants(role, address, txid, vout, id);' },
  { label: 'optimizing query planner', sql: 'ANALYZE;' },
];

/**
 * Create every secondary index and run ANALYZE. Called once after a bulk load so
 * index maintenance does not slow the insert phase. Runs each entry in
 * `INDEX_BUILD_STEPS` in turn; the optional `onStep` callback fires BEFORE each
 * statement so the finalize UI can report the sub-step currently running. The
 * statements are identical to the previous single-exec form — only split so each
 * can be announced.
 */
export function createIndexes(
  db: EngineDb,
  onStep?: (step: IndexBuildStep, index: number, total: number) => void,
): void {
  const total = INDEX_BUILD_STEPS.length;
  INDEX_BUILD_STEPS.forEach((step, i) => {
    onStep?.(step, i + 1, total);
    db.exec(step.sql);
  });
}

/**
 * Async, cooperatively-yielding variant of {@link createIndexes}. Same statements
 * in the same order (it shares the single {@link INDEX_BUILD_STEPS} source), but
 * it awaits `yieldFn` BEFORE each `db.exec` so the single-threaded worker drains
 * any queued `status`/`schemaVersion` messages in the gap between index builds
 * instead of blocking for the whole finalize. Each individual index build is still
 * synchronous (SQLite can't be interrupted mid-statement), but the per-step gaps
 * keep the worker answering polls so Engine Diagnostics shows live progress rather
 * than appearing frozen. `onStep` fires before the yield so the pushed progress
 * reflects the step that is about to run.
 */
export async function createIndexesYielding(
  db: EngineDb,
  onStep: ((step: IndexBuildStep, index: number, total: number) => void) | undefined,
  yieldFn: () => Promise<void>,
): Promise<void> {
  const total = INDEX_BUILD_STEPS.length;
  for (let i = 0; i < total; i++) {
    const step = INDEX_BUILD_STEPS[i];
    onStep?.(step, i + 1, total);
    await yieldFn();
    db.exec(step.sql);
  }
}

/**
 * Convenience: tables + indexes in one call. Used by unit tests and any caller
 * that wants a query-ready database immediately (small data, no bulk-load phase).
 */
export function createSchema(db: EngineDb): void {
  createTablesOnly(db);
  createIndexes(db);
}

/**
 * Drop the mirror DATA tables (records / blockchainTransactions /
 * transactionParticipants). Used by the full-rebuild seed path on (re)start so
 * an interrupted seed never leaves half-mirrored rows — we always start clean.
 * seedMeta is preserved (callers reset it explicitly via `resetSeedMeta`).
 */
export function dropMirrorTables(db: EngineDb): void {
  db.exec(`
    DROP TABLE IF EXISTS records;
    DROP TABLE IF EXISTS blockchainTransactions;
    DROP TABLE IF EXISTS transactionParticipants;
    DROP TABLE IF EXISTS ownedUtxos;
    DROP TABLE IF EXISTS heuristicOwnedUtxos;
  `);
  // Invalidate the materialized owned-UTXO metadata so a partial/cleared state
  // never serves a stale count. engineMeta may not exist yet on the very first
  // drop (before createTablesOnly), so ensure it before clearing.
  db.exec('CREATE TABLE IF NOT EXISTS engineMeta (key TEXT PRIMARY KEY, value TEXT);');
  db.run('DELETE FROM engineMeta WHERE key IN (?, ?, ?, ?)', [
    OWNED_UTXOS_TIERS_KEY,
    OWNED_UTXOS_COUNT_KEY,
    HEURISTIC_UTXOS_TIERS_KEY,
    HEURISTIC_UTXOS_COUNT_KEY,
  ]);
}

/** Clear all per-table seed progress rows (full-rebuild reset). */
export function resetSeedMeta(db: EngineDb): void {
  db.exec('DELETE FROM seedMeta;');
}

// ---------------------------------------------------------------------------
// engineMeta — small key/value store for derived/materialized state
// ---------------------------------------------------------------------------

export function getEngineMeta(db: EngineDb, key: string): string | null {
  const rows = selectRows<{ value: string }>(db, 'SELECT value FROM engineMeta WHERE key = ?', [key]);
  return rows[0]?.value ?? null;
}

function setEngineMeta(db: EngineDb, key: string, value: string): void {
  db.run(
    'INSERT INTO engineMeta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
}

// ---------------------------------------------------------------------------
// Engine schema version
//
// The freshness gate compares count + maxId + maxUpdatedAt, which says nothing
// about the mirror's column SHAPE. A mirror seeded by an OLDER build would pass
// that fingerprint yet read back NULL for any column added later (and
// createTablesOnly's CREATE TABLE IF NOT EXISTS never adds columns to an
// existing table). So bump ENGINE_SCHEMA_VERSION whenever the mirror table shape
// changes: getEngineSchemaVersion(db) returns 0 for any pre-versioning mirror,
// and the gate refuses the engine on a mismatch so the launch bootstrap reseeds.
// The version is stamped ONLY at a successful finalize (writeEngineSchemaVersion),
// so a half-built/interrupted mirror never advertises the new shape.
//   v2: added records.{derivationPath, discoveredInTxid, vaultIsVaultXpub, vaultM,
//       vaultN, vaultName, vaultNotes} for Vaults + Wallet Overview aggregates.
//   v4: added idx_records_createdAt_id so the Records page's Date Added sort can
//       stay on the engine fast path. An index is a perf (not correctness) shape,
//       but without it a pre-v4 mirror would serve createdAt-keyset pages with a
//       full sort — exactly the slowdown the fast path exists to avoid — so the
//       bump forces a reseed that builds the index.
// ---------------------------------------------------------------------------

export const ENGINE_SCHEMA_VERSION = 4;
const SCHEMA_VERSION_KEY = 'schemaVersion';

/** Schema version stamped by the last successful finalize; 0 if never written. */
export function getEngineSchemaVersion(db: EngineDb): number {
  const v = getEngineMeta(db, SCHEMA_VERSION_KEY);
  if (v == null) return 0;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

/** Stamp the current schema version. Call ONLY after a successful seed finalize. */
export function writeEngineSchemaVersion(db: EngineDb): void {
  setEngineMeta(db, SCHEMA_VERSION_KEY, String(ENGINE_SCHEMA_VERSION));
}

// ---------------------------------------------------------------------------
// seedMeta — resumability + readiness
// ---------------------------------------------------------------------------

export interface SeedMeta {
  tableName: string;
  highWaterId: number;
  copied: number;
  sourceCount: number;
  complete: number;
  updatedAt: number;
}

export function getSeedMeta(db: EngineDb, table: MirrorTable): SeedMeta {
  const rows = selectRows<SeedMeta>(
    db,
    'SELECT tableName, highWaterId, copied, sourceCount, complete, updatedAt FROM seedMeta WHERE tableName = ?',
    [table],
  );
  return (
    rows[0] ?? {
      tableName: table,
      highWaterId: 0,
      copied: 0,
      sourceCount: 0,
      complete: 0,
      updatedAt: 0,
    }
  );
}

export function getAllSeedMeta(db: EngineDb): SeedMeta[] {
  return MIRROR_TABLES.map((t) => getSeedMeta(db, t));
}

/**
 * Persist seed progress for a table. `complete` is only ever set true when the
 * caller has copied at least as many rows as the source contains AND has reached
 * the end of the source keyset — see markSeedCompleteIfDone.
 */
export function upsertSeedProgress(
  db: EngineDb,
  table: MirrorTable,
  fields: { highWaterId: number; copied: number; sourceCount: number; complete?: boolean },
): void {
  db.run(
    `
      INSERT INTO seedMeta (tableName, highWaterId, copied, sourceCount, complete, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(tableName) DO UPDATE SET
        highWaterId = excluded.highWaterId,
        copied      = excluded.copied,
        sourceCount = excluded.sourceCount,
        complete    = excluded.complete,
        updatedAt   = excluded.updatedAt
    `,
    [
      table,
      fields.highWaterId,
      fields.copied,
      fields.sourceCount,
      fields.complete ? 1 : 0,
      Date.now(),
    ],
  );
}

/**
 * Mark a table complete only if the mirrored row count matches the source count.
 * Returns true when complete. This is the single gate that prevents partial data
 * from ever being presented as the full dataset.
 */
export function markSeedCompleteIfDone(
  db: EngineDb,
  table: MirrorTable,
  sourceCount: number,
): boolean {
  const copied = countTable(db, table);
  const meta = getSeedMeta(db, table);
  const complete = copied >= sourceCount && sourceCount >= 0;
  upsertSeedProgress(db, table, {
    highWaterId: meta.highWaterId,
    copied,
    sourceCount,
    complete,
  });
  return complete;
}

export function isTableReady(db: EngineDb, table: MirrorTable): boolean {
  const meta = getSeedMeta(db, table);
  if (meta.complete !== 1) return false;
  // Defensive: complete flag must be backed by an actual row count that is not
  // short of the recorded source count.
  return meta.copied >= meta.sourceCount;
}

export function isEngineReady(db: EngineDb): boolean {
  return MIRROR_TABLES.every((t) => isTableReady(db, t));
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

export function countTable(db: EngineDb, table: MirrorTable): number {
  return selectScalar(db, `SELECT COUNT(*) AS v FROM ${table}`);
}

export function maxId(db: EngineDb, table: MirrorTable): number {
  return selectScalar(db, `SELECT COALESCE(MAX(id), 0) AS v FROM ${table}`);
}

/**
 * Freshness fingerprint for the `records` table: total row count, the max id,
 * and the max updatedAt. Callers compare this against the live Dexie source to
 * decide whether the mirror is current. Any create bumps count + maxId; any
 * delete lowers count; any edit bumps updatedAt — so a mismatch in any of the
 * three means the mirror is stale and the read must fall back to Dexie.
 */
export interface RecordsFingerprint {
  count: number;
  maxId: number;
  maxUpdatedAt: number;
}

export function getRecordsFingerprint(db: EngineDb): RecordsFingerprint {
  const rows = selectRows<{ count: number; maxId: number; maxUpdatedAt: number }>(
    db,
    `SELECT COUNT(*) AS count,
            COALESCE(MAX(id), 0) AS maxId,
            COALESCE(MAX(updatedAt), 0) AS maxUpdatedAt
       FROM records`,
  );
  const r = rows[0];
  return {
    count: Number(r?.count ?? 0),
    maxId: Number(r?.maxId ?? 0),
    maxUpdatedAt: Number(r?.maxUpdatedAt ?? 0),
  };
}

/**
 * Freshness fingerprint for the `blockchainTransactions` table. Owned-UTXO reads
 * JOIN this table (and filter `blockTime > 0`), so the mirror is only safe to
 * read when it matches the live source. `count` + `maxId` detect inserts/deletes;
 * `maxBlockTime` detects an unconfirmed tx confirming in place (blockTime 0 → a
 * recent timestamp that becomes the new max), which inserts/deletes alone miss.
 */
export interface TransactionsFingerprint {
  count: number;
  maxId: number;
  maxBlockTime: number;
}

export function getTransactionsFingerprint(db: EngineDb): TransactionsFingerprint {
  const rows = selectRows<{ count: number; maxId: number; maxBlockTime: number }>(
    db,
    `SELECT COUNT(*) AS count,
            COALESCE(MAX(id), 0) AS maxId,
            COALESCE(MAX(blockTime), 0) AS maxBlockTime
       FROM blockchainTransactions`,
  );
  const r = rows[0];
  return {
    count: Number(r?.count ?? 0),
    maxId: Number(r?.maxId ?? 0),
    maxBlockTime: Number(r?.maxBlockTime ?? 0),
  };
}

/**
 * Freshness fingerprint for the `transactionParticipants` table. The owned-UTXO
 * anti-join detects spends via input rows' (prevTxid, prevVout), which prevout
 * backfill fills IN PLACE on existing rows — so `count` + `maxId` alone cannot
 * see it. `resolvedPrevoutCount` (rows with both prevTxid and prevVout set) moves
 * whenever backfill resolves more inputs, catching that drift. It matches the
 * Dexie `[prevTxid+prevVout]` compound-index count (only rows with both keys
 * defined are indexed), keeping the gate index-only on both sides.
 */
export interface ParticipantsFingerprint {
  count: number;
  maxId: number;
  resolvedPrevoutCount: number;
}

export function getParticipantsFingerprint(db: EngineDb): ParticipantsFingerprint {
  const base = selectRows<{ count: number; maxId: number }>(
    db,
    `SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS maxId FROM transactionParticipants`,
  );
  const resolved = selectScalar(
    db,
    `SELECT COUNT(*) AS v FROM transactionParticipants
       WHERE prevTxid IS NOT NULL AND prevVout IS NOT NULL`,
  );
  const r = base[0];
  return {
    count: Number(r?.count ?? 0),
    maxId: Number(r?.maxId ?? 0),
    resolvedPrevoutCount: Number(resolved ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Idempotent batched inserts
// ---------------------------------------------------------------------------

export function insertRecords(db: EngineDb, rows: RecordRow[]): void {
  if (rows.length === 0) return;
  db.insertMany(
    `INSERT INTO records
        (id, type, inputString, inputStringLower, label, notes, owner, walletName,
         seedName, walletSoftware, addressImportance, chainType, syncDepth,
         firstSeenBlockTime, cachedBalanceSats, cachedTxCount, cachedUtxoCount,
         statsComputedAt, createdAt, updatedAt, tags, categories,
         derivationPath, discoveredInTxid, vaultIsVaultXpub, vaultM, vaultN,
         vaultName, vaultNotes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    rows.map((r) => [
      r.id,
      r.type ?? null,
      r.inputString ?? null,
      r.inputStringLower ?? null,
      r.label ?? null,
      r.notes ?? null,
      r.owner ?? null,
      r.walletName ?? null,
      r.seedName ?? null,
      r.walletSoftware ?? null,
      r.addressImportance ?? null,
      r.chainType ?? null,
      r.syncDepth ?? null,
      r.firstSeenBlockTime ?? null,
      r.cachedBalanceSats ?? null,
      r.cachedTxCount ?? null,
      r.cachedUtxoCount ?? null,
      r.statsComputedAt ?? null,
      r.createdAt ?? null,
      r.updatedAt ?? null,
      r.tags ?? null,
      r.categories ?? null,
      r.derivationPath ?? null,
      r.discoveredInTxid ?? null,
      r.vaultIsVaultXpub ?? null,
      r.vaultM ?? null,
      r.vaultN ?? null,
      r.vaultName ?? null,
      r.vaultNotes ?? null,
    ]),
  );
}

export function insertTransactions(db: EngineDb, rows: TransactionRow[]): void {
  if (rows.length === 0) return;
  db.insertMany(
    `INSERT INTO blockchainTransactions
        (id, txid, blockHeight, blockTime, fee, feeRate, vsize, hasOpReturn)
      VALUES (?,?,?,?,?,?,?,?)`,
    rows.map((r) => [
      r.id,
      r.txid,
      r.blockHeight ?? null,
      r.blockTime ?? null,
      r.fee ?? null,
      r.feeRate ?? null,
      r.vsize ?? null,
      r.hasOpReturn ?? null,
    ]),
  );
}

export function insertParticipants(db: EngineDb, rows: ParticipantRow[]): void {
  if (rows.length === 0) return;
  db.insertMany(
    `INSERT INTO transactionParticipants
        (id, txid, role, address, amount, vout, prevTxid, prevVout, recordId, scriptType)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
    rows.map((r) => [
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
    ]),
  );
}

// ---------------------------------------------------------------------------
// Query: record page / count / search
// ---------------------------------------------------------------------------

export interface RecordQueryOptions {
  /** When false, blockchain-discovered + pending-review rows are excluded. */
  includeBlockchainDiscovered?: boolean;
  /** Case-insensitive substring across label/inputString/owner/walletName/notes. */
  search?: string;
  /** Restrict to a record type (e.g. 'address'). */
  type?: string;
  /**
   * Inclusive lower bound on createdAt (ms) — the Records page's "Recently
   * added" window. Implies createdAt IS NOT NULL.
   */
  addedSince?: number;
  /**
   * Exclude rows with NULL createdAt, matching the Dexie createdAt-index walk
   * (IndexedDB never indexes missing keys). Set by the date-added count path
   * even when no addedSince window is active so counts agree across paths.
   */
  requireCreatedAt?: boolean;
}

/**
 * Escape LIKE metacharacters (%, _) and the escape char itself so a bound
 * search term matches literally, mirroring the Dexie path's String.includes.
 * Every LIKE clause using this MUST carry `ESCAPE '\'`.
 */
function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function buildRecordWhere(opts: RecordQueryOptions): { sql: string; bind: unknown[] } {
  const clauses: string[] = [];
  const bind: unknown[] = [];
  if (opts.type) {
    clauses.push('type = ?');
    bind.push(opts.type);
  }
  if (opts.addedSince != null) {
    clauses.push('createdAt >= ?');
    bind.push(opts.addedSince);
  } else if (opts.requireCreatedAt) {
    clauses.push('createdAt IS NOT NULL');
  }
  if (!opts.includeBlockchainDiscovered) {
    clauses.push("(addressImportance IS NULL OR addressImportance NOT IN ('blockchain-discovered','pending-review'))");
  }
  const search = opts.search?.trim().toLowerCase();
  if (search) {
    const like = `%${escapeLikeTerm(search)}%`;
    clauses.push(
      "(inputStringLower LIKE ? ESCAPE '\\' OR lower(label) LIKE ? ESCAPE '\\' OR lower(owner) LIKE ? ESCAPE '\\' OR lower(walletName) LIKE ? ESCAPE '\\' OR lower(notes) LIKE ? ESCAPE '\\')",
    );
    bind.push(like, like, like, like, like);
  }
  const sql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return { sql, bind };
}

export function countRecords(db: EngineDb, opts: RecordQueryOptions = {}): number {
  const { sql, bind } = buildRecordWhere(opts);
  return selectScalar(db, `SELECT COUNT(*) AS v FROM records ${sql}`, bind);
}

/** Keyset cursor for the createdAt-ordered page: the last row of the prior page. */
export interface CreatedAtEngineCursor {
  createdAt: number;
  id: number;
}

export interface RecordPageOptions extends RecordQueryOptions {
  /** Keyset cursor: return rows with id < beforeId (for id-descending order). */
  beforeId?: number;
  /**
   * When set, order by (createdAt, id) instead of id — 'newest' = both DESC,
   * 'oldest' = both ASC — matching the Dexie createdAt-index iteration order.
   * Rows with NULL createdAt are excluded (IndexedDB parity). `beforeId` is
   * ignored in this mode; use `createdAtCursor`.
   */
  createdAtSort?: 'newest' | 'oldest';
  /** Exclusive (createdAt, id) boundary from the previous createdAt-sorted page. */
  createdAtCursor?: CreatedAtEngineCursor;
  limit: number;
}

/**
 * Keyset-paginated records. Default order is id-descending (newest first),
 * matching the Records page ordering; with `createdAtSort` set it is
 * (createdAt, id) asc/desc for the Date Added sort. Both use a seek predicate
 * so paging never re-scans skipped rows the way OFFSET does.
 */
export function getRecordPage(db: EngineDb, opts: RecordPageOptions): RecordRow[] {
  const where = buildRecordWhere(opts);
  const clauses: string[] = [];
  const bind: unknown[] = [];
  if (where.sql) {
    clauses.push(where.sql.replace(/^WHERE /, ''));
    bind.push(...where.bind);
  }

  if (opts.createdAtSort) {
    // Dexie's createdAt-index walk never yields rows missing the key; exclude
    // NULLs so both read paths agree. (buildRecordWhere already added a
    // createdAt bound when addedSince/requireCreatedAt is set — the extra
    // clause is redundant then, but harmless and keeps this branch safe.)
    clauses.push('createdAt IS NOT NULL');
    const desc = opts.createdAtSort === 'newest';
    if (opts.createdAtCursor) {
      const cmp = desc ? '<' : '>';
      clauses.push(
        `(createdAt ${cmp} ? OR (createdAt = ? AND id ${cmp} ?))`,
      );
      bind.push(opts.createdAtCursor.createdAt, opts.createdAtCursor.createdAt, opts.createdAtCursor.id);
    }
    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const dir = desc ? 'DESC' : 'ASC';
    bind.push(opts.limit);
    return selectRows<RecordRow>(
      db,
      `SELECT * FROM records ${whereSql} ORDER BY createdAt ${dir}, id ${dir} LIMIT ?`,
      bind,
    );
  }

  if (opts.beforeId != null) {
    clauses.push('id < ?');
    bind.push(opts.beforeId);
  }
  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  bind.push(opts.limit);
  return selectRows<RecordRow>(
    db,
    `SELECT * FROM records ${whereSql} ORDER BY id DESC LIMIT ?`,
    bind,
  );
}

export interface RecordPageByUpdatedAtOptions extends RecordQueryOptions {
  /** Rows to skip (offset pagination, matching the Dashboard read). */
  offset?: number;
  limit: number;
}

/**
 * Offset-paginated records ordered by updatedAt DESC, id DESC — the order the
 * Dashboard presents (most-recently-edited first). Mirrors Dexie's
 * `orderBy('updatedAt').reverse()`, which breaks updatedAt ties by id DESC and
 * EXCLUDES rows with no updatedAt key (IndexedDB never indexes null/undefined),
 * hence the `updatedAt IS NOT NULL` clause. There is no updatedAt index, so this
 * is a native full scan + sort; still orders of magnitude faster than Dexie's
 * per-row JS `.filter()` cursor walk, which can visit millions of
 * blockchain-discovered rows just to fill one page of non-blockchain rows.
 */
export function getRecordPageByUpdatedAt(
  db: EngineDb,
  opts: RecordPageByUpdatedAtOptions,
): RecordRow[] {
  const where = buildRecordWhere(opts);
  const clauses: string[] = ['updatedAt IS NOT NULL'];
  const bind: unknown[] = [];
  if (where.sql) {
    clauses.push(where.sql.replace(/^WHERE /, ''));
    bind.push(...where.bind);
  }
  bind.push(opts.limit, opts.offset ?? 0);
  return selectRows<RecordRow>(
    db,
    `SELECT * FROM records WHERE ${clauses.join(' AND ')} ORDER BY updatedAt DESC, id DESC LIMIT ? OFFSET ?`,
    bind,
  );
}

// ---------------------------------------------------------------------------
// Query: per-address aggregates
// ---------------------------------------------------------------------------

export interface AddressAggregate {
  address: string;
  balanceSats: number;
  txCount: number;
  lastActivityTime: number;
  utxoCount: number;
}

/**
 * Per-address balance / tx-count / last-activity / exact-UTXO-count, computed in
 * SQL for a set of address strings. Mirrors computeStatsForAddresses but pushes
 * the aggregation into the database. UTXO counting uses the exact prevout
 * anti-join (an owned output is unspent unless some input references its
 * outpoint). Heuristic (no-prevout) mode is intentionally not replicated here;
 * synced data carries prevout data.
 */
export function getAddressAggregates(db: EngineDb, addresses: string[]): Map<string, AddressAggregate> {
  const out = new Map<string, AddressAggregate>();
  if (addresses.length === 0) return out;

  for (const batch of chunk(addresses, PARAM_BATCH_SIZE)) {
    const placeholders = batch.map(() => '?').join(',');

    const aggRows = selectRows<{
      address: string;
      txCount: number;
      lastTime: number | null;
    }>(
      db,
      `
      SELECT p.address AS address,
             COUNT(DISTINCT p.txid) AS txCount,
             MAX(t.blockTime) AS lastTime
      FROM transactionParticipants p
      LEFT JOIN blockchainTransactions t ON t.txid = p.txid
      WHERE p.address IN (${placeholders})
      GROUP BY p.address
      `,
      batch,
    );

    for (const r of aggRows) {
      out.set(r.address, {
        address: r.address,
        balanceSats: 0,
        txCount: r.txCount ?? 0,
        lastActivityTime: r.lastTime ?? 0,
        utxoCount: 0,
      });
    }

    // Compute balance as sum of unspent output amounts (never negative) and
    // UTXO count in a single anti-join pass. This matches computeUtxoStatsForAddress
    // in address-stats.ts (exact-prevout mode only; synced data carries prevouts).
    const utxoRows = selectRows<{ address: string; utxoCount: number; balanceSats: number }>(
      db,
      `
      SELECT o.address AS address,
             COUNT(*) AS utxoCount,
             COALESCE(SUM(o.amount), 0) AS balanceSats
      FROM transactionParticipants o
      JOIN blockchainTransactions t ON t.txid = o.txid
      WHERE o.role = 'output'
        AND o.vout IS NOT NULL
        AND o.address IN (${placeholders})
        AND COALESCE(t.blockTime, 0) > 0
        AND NOT EXISTS (
          SELECT 1 FROM transactionParticipants i
          WHERE i.role = 'input' AND i.prevTxid = o.txid AND i.prevVout = o.vout
        )
      GROUP BY o.address
      `,
      batch,
    );

    for (const r of utxoRows) {
      const existing = out.get(r.address);
      if (existing) {
        existing.utxoCount = r.utxoCount ?? 0;
        existing.balanceSats = r.balanceSats ?? 0;
      } else {
        out.set(r.address, {
          address: r.address,
          balanceSats: r.balanceSats ?? 0,
          txCount: 0,
          lastActivityTime: 0,
          utxoCount: r.utxoCount ?? 0,
        });
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Query: transactions page / count (Transactions screen)
// ---------------------------------------------------------------------------

export interface TransactionQueryOptions {
  /** Restrict to transactions carrying an OP_RETURN output. */
  opReturnOnly?: boolean;
}

/** Keyset cursor for the Transactions page; `blockTime` is the COALESCE(.,0) key. */
export interface TransactionPageCursor {
  blockTime: number;
  id: number;
}

export interface TransactionPageOptions extends TransactionQueryOptions {
  /** Return rows AFTER this cursor in (blockTime DESC, id DESC) order. */
  cursor?: TransactionPageCursor;
  limit: number;
}

/** A transaction row enriched with the per-tx aggregates the page renders. */
export interface TransactionPageRow extends TransactionRow {
  totalOutputValue: number;
  inputCount: number;
  outputCount: number;
}

export interface TransactionAggregate {
  totalOutputValue: number;
  inputCount: number;
  outputCount: number;
}

function buildTransactionWhere(opts: TransactionQueryOptions): { sql: string; bind: unknown[] } {
  const clauses: string[] = [];
  const bind: unknown[] = [];
  // hasOpReturn is mirrored as 0/1; Dexie filters on hasOpReturn === true.
  if (opts.opReturnOnly) clauses.push('hasOpReturn = 1');
  return { sql: clauses.length ? clauses.join(' AND ') : '', bind };
}

export function countTransactions(db: EngineDb, opts: TransactionQueryOptions = {}): number {
  const where = buildTransactionWhere(opts);
  const whereSql = where.sql ? `WHERE ${where.sql}` : '';
  return selectScalar(db, `SELECT COUNT(*) AS v FROM blockchainTransactions ${whereSql}`, where.bind);
}

/**
 * Per-transaction output total + input/output participant counts, keyed by txid.
 * Used as the companion aggregate for a single page of transactions (an indexed
 * IN() probe over `idx_tp_txid`), so the page never JOIN-then-GROUPs the whole
 * 10M-row participants table just to LIMIT a handful of rows.
 */
export function getTransactionAggregates(
  db: EngineDb,
  txids: string[],
): Map<string, TransactionAggregate> {
  const out = new Map<string, TransactionAggregate>();
  if (txids.length === 0) return out;
  for (const batch of chunk(txids, PARAM_BATCH_SIZE)) {
    const placeholders = batch.map(() => '?').join(',');
    const rows = selectRows<{
      txid: string;
      totalOutputValue: number;
      inputCount: number;
      outputCount: number;
    }>(
      db,
      `SELECT txid,
              COALESCE(SUM(CASE WHEN role='output' THEN amount ELSE 0 END), 0) AS totalOutputValue,
              SUM(CASE WHEN role='input'  THEN 1 ELSE 0 END) AS inputCount,
              SUM(CASE WHEN role='output' THEN 1 ELSE 0 END) AS outputCount
         FROM transactionParticipants
        WHERE txid IN (${placeholders})
        GROUP BY txid`,
      batch,
    );
    for (const r of rows) {
      out.set(r.txid, {
        totalOutputValue: r.totalOutputValue ?? 0,
        inputCount: r.inputCount ?? 0,
        outputCount: r.outputCount ?? 0,
      });
    }
  }
  return out;
}

/**
 * One keyset page of transactions in (COALESCE(blockTime,0) DESC, id DESC) order
 * — newest first, matching the Dexie read path. The page of tx rows is selected
 * first (indexed, bounded by LIMIT) and only THEN are participant aggregates
 * attached for exactly those txids, so cost is O(page) not O(all participants).
 */
export function getTransactionPage(db: EngineDb, opts: TransactionPageOptions): TransactionPageRow[] {
  const clauses: string[] = [];
  const bind: unknown[] = [];
  const where = buildTransactionWhere(opts);
  if (where.sql) {
    clauses.push(where.sql);
    bind.push(...where.bind);
  }
  if (opts.cursor) {
    clauses.push('(COALESCE(blockTime, 0) < ? OR (COALESCE(blockTime, 0) = ? AND id < ?))');
    bind.push(opts.cursor.blockTime, opts.cursor.blockTime, opts.cursor.id);
  }
  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  bind.push(opts.limit);
  const txRows = selectRows<TransactionRow>(
    db,
    `SELECT id, txid, blockHeight, blockTime, fee, feeRate, vsize, hasOpReturn
       FROM blockchainTransactions
       ${whereSql}
       ORDER BY COALESCE(blockTime, 0) DESC, id DESC
       LIMIT ?`,
    bind,
  );
  if (txRows.length === 0) return [];
  const aggs = getTransactionAggregates(db, txRows.map((r) => r.txid));
  return txRows.map((r) => {
    const a = aggs.get(r.txid);
    return {
      ...r,
      totalOutputValue: a?.totalOutputValue ?? 0,
      inputCount: a?.inputCount ?? 0,
      outputCount: a?.outputCount ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Query: balance / wallet / vault summaries (overview screens)
// ---------------------------------------------------------------------------

export type BalanceGroupBy = 'wallet' | 'seed' | 'owner' | 'tag' | 'category';

export interface BalanceGroupSummary {
  groupKey: string;
  totalSats: number;
  addressCount: number;
  utxoCount: number;
}

export interface BalanceSummariesResult {
  summaries: BalanceGroupSummary[];
  /** Grand totals are DEDUPED — each address counted once even when tag/category
   *  grouping expands it into several buckets. */
  totals: { totalSats: number; totalAddresses: number; totalUtxos: number };
  /** Count of address rows whose stats predate the `cachedUtxoCount` field
   *  (statsComputedAt set but cachedUtxoCount NULL). Mirrors BalanceOverview's
   *  `needsBackfill` probe. When > 0 the mirror cannot serve correct balances
   *  (those rows are silently excluded by `cachedUtxoCount > 0`), so the page
   *  must fall back to the Dexie path which triggers the one-time backfill. */
  staleAddressCount: number;
}

// Fixed column + empty-bucket per grouping dimension. Never interpolate caller
// input into SQL — groupBy is mapped to these literals.
const BALANCE_GROUP_COLUMN: Record<BalanceGroupBy, string> = {
  wallet: 'walletName',
  seed: 'seedName',
  owner: 'owner',
  tag: 'tags',
  category: 'categories',
};
const BALANCE_GROUP_EMPTY: Record<BalanceGroupBy, string> = {
  wallet: 'Unassigned',
  seed: 'Unassigned',
  owner: 'Unassigned',
  tag: 'Untagged',
  category: 'Uncategorized',
};

/**
 * Balance overview group summaries, computed in SQL. Mirrors getGroupKeys +
 * the page's aggregation pass exactly:
 *   - only type='address' rows with cachedUtxoCount > 0,
 *   - wallet/seed/owner: empty (NULL or '') maps to the dimension's empty bucket,
 *   - tag/category: JSON arrays are expanded via json_each (an address with two
 *     tags adds its full balance to BOTH buckets); rows with an empty/NULL/invalid
 *     array fall into the empty bucket, merged with any literal same-named tag,
 *   - grand totals are deduped (computed once over the filtered set).
 */
export function getBalanceGroupSummaries(
  db: EngineDb,
  opts: { groupBy: BalanceGroupBy },
): BalanceSummariesResult {
  const col = BALANCE_GROUP_COLUMN[opts.groupBy];
  const empty = BALANCE_GROUP_EMPTY[opts.groupBy];
  // Only user-curated addresses count toward balances: blockchain-discovered
  // counterparty records carry one-sided history (their "balance" is just sats
  // seen received), so including them would inflate every group. Mirrors the
  // Dexie aggregation in BalanceOverview.tsx.
  const baseFilter = `type = 'address' AND cachedUtxoCount > 0 AND ${CURATED_ADDRESS_SQL}`;

  let summaries: BalanceGroupSummary[];
  if (opts.groupBy === 'tag' || opts.groupBy === 'category') {
    summaries = selectRows<BalanceGroupSummary>(
      db,
      `SELECT groupKey,
              COALESCE(SUM(totalSats), 0) AS totalSats,
              SUM(addressCount) AS addressCount,
              COALESCE(SUM(utxoCount), 0) AS utxoCount
         FROM (
           SELECT je.value AS groupKey,
                  r.cachedBalanceSats AS totalSats,
                  1 AS addressCount,
                  r.cachedUtxoCount AS utxoCount
             FROM records r, json_each(r.${col}) je
            WHERE r.${baseFilter}
              AND r.${col} IS NOT NULL AND json_valid(r.${col}) AND json_array_length(r.${col}) > 0
           UNION ALL
           SELECT ? AS groupKey,
                  r.cachedBalanceSats,
                  1,
                  r.cachedUtxoCount
             FROM records r
            WHERE r.${baseFilter}
              AND (r.${col} IS NULL OR NOT json_valid(r.${col}) OR json_array_length(r.${col}) = 0)
         )
        GROUP BY groupKey
        ORDER BY totalSats DESC, groupKey`,
      [empty],
    );
  } else {
    summaries = selectRows<BalanceGroupSummary>(
      db,
      `SELECT COALESCE(NULLIF(${col}, ''), ?) AS groupKey,
              COALESCE(SUM(cachedBalanceSats), 0) AS totalSats,
              COUNT(*) AS addressCount,
              COALESCE(SUM(cachedUtxoCount), 0) AS utxoCount
         FROM records
        WHERE ${baseFilter}
        GROUP BY groupKey
        ORDER BY totalSats DESC, groupKey`,
      [empty],
    );
  }

  const totalsRow = selectRows<{ totalSats: number; totalAddresses: number; totalUtxos: number }>(
    db,
    `SELECT COALESCE(SUM(cachedBalanceSats), 0) AS totalSats,
            COUNT(*) AS totalAddresses,
            COALESCE(SUM(cachedUtxoCount), 0) AS totalUtxos
       FROM records
      WHERE ${baseFilter}`,
  )[0];

  // Detect rows the page would treat as "needs backfill": stats were computed
  // before cachedUtxoCount existed (statsComputedAt set, cachedUtxoCount NULL).
  // These are silently dropped by `cachedUtxoCount > 0`, so the page must fall
  // back to Dexie (which backfills) whenever any such row exists.
  const staleRow = selectRows<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n
       FROM records
      WHERE type = 'address' AND ${CURATED_ADDRESS_SQL}
        AND statsComputedAt IS NOT NULL AND cachedUtxoCount IS NULL`,
  )[0];

  return {
    summaries: summaries.map((s) => ({
      groupKey: s.groupKey,
      totalSats: s.totalSats ?? 0,
      addressCount: s.addressCount ?? 0,
      utxoCount: s.utxoCount ?? 0,
    })),
    totals: {
      totalSats: Number(totalsRow?.totalSats ?? 0),
      totalAddresses: Number(totalsRow?.totalAddresses ?? 0),
      totalUtxos: Number(totalsRow?.totalUtxos ?? 0),
    },
    staleAddressCount: Number(staleRow?.n ?? 0),
  };
}

export interface WalletUsageSummary {
  walletName: string;
  receiveTotal: number;
  receiveUsed: number;
  changeTotal: number;
  changeUsed: number;
  unknownTotal: number;
  unknownUsed: number;
}

/**
 * Wallet overview usage summaries grouped by walletName, computed in SQL.
 * Replicates parseChainType + the page's "used" rule exactly:
 *   - only type='address' rows with a non-empty walletName,
 *   - chainType 'receive'/'change' wins; else the SECOND-TO-LAST derivation-path
 *     component decides ('1' => change) when the path has >= 5 components; every
 *     other case falls back to 'receive' (so 'unknown' is never produced — the
 *     page's unknown buckets are always 0, kept here for shape compatibility),
 *   - "used" = a non-zero firstSeenBlockTime OR a non-empty discoveredInTxid.
 *
 * The derivation path is split in pure SQL by turning "a/b/c" into the JSON array
 * ["a","b","c"] (replace '/' with '","'), then reading element [length-2] — no
 * REVERSE()/UDF needed. Backslashes and double-quotes are JSON-escaped first (\\
 * then \") so a path containing those characters still produces valid JSON and is
 * parsed faithfully — exactly matching the JS split('/'). The json_valid guard is
 * kept as a belt-and-suspenders fall back to 'receive'.
 */
export function getWalletUsageSummaries(db: EngineDb): WalletUsageSummary[] {
  const rows = selectRows<{
    walletName: string;
    receiveTotal: number;
    receiveUsed: number;
    changeTotal: number;
    changeUsed: number;
  }>(
    db,
    `SELECT walletName,
            SUM(CASE WHEN kind = 'receive' THEN 1 ELSE 0 END) AS receiveTotal,
            SUM(CASE WHEN kind = 'receive' AND isUsed = 1 THEN 1 ELSE 0 END) AS receiveUsed,
            SUM(CASE WHEN kind = 'change' THEN 1 ELSE 0 END) AS changeTotal,
            SUM(CASE WHEN kind = 'change' AND isUsed = 1 THEN 1 ELSE 0 END) AS changeUsed
       FROM (
         SELECT walletName,
                CASE
                  WHEN chainType = 'receive' THEN 'receive'
                  WHEN chainType = 'change' THEN 'change'
                  WHEN n >= 5 AND json_extract(jp, '$[' || (n - 2) || ']') = '1' THEN 'change'
                  ELSE 'receive'
                END AS kind,
                CASE
                  WHEN (firstSeenBlockTime IS NOT NULL AND firstSeenBlockTime <> 0)
                    OR (discoveredInTxid IS NOT NULL AND discoveredInTxid <> '')
                  THEN 1 ELSE 0
                END AS isUsed
           FROM (
             SELECT walletName, chainType, firstSeenBlockTime, discoveredInTxid, jp,
                    CASE WHEN jp IS NOT NULL AND json_valid(jp) THEN json_array_length(jp) ELSE 0 END AS n
               FROM (
                 SELECT walletName, chainType, firstSeenBlockTime, discoveredInTxid,
                        ('["' || replace(replace(replace(derivationPath, '\\', '\\\\'), '"', '\\"'), '/', '","') || '"]') AS jp
                   FROM records
                  WHERE type = 'address' AND walletName IS NOT NULL AND walletName <> ''
               )
           )
       )
      GROUP BY walletName
      ORDER BY walletName`,
  );
  return rows.map((r) => ({
    walletName: r.walletName,
    receiveTotal: r.receiveTotal ?? 0,
    receiveUsed: r.receiveUsed ?? 0,
    changeTotal: r.changeTotal ?? 0,
    changeUsed: r.changeUsed ?? 0,
    unknownTotal: 0,
    unknownUsed: 0,
  }));
}

export interface VaultSummaryRow {
  vaultName: string | null;
  vaultM: number | null;
  vaultN: number | null;
  vaultNotes: string | null;
  addressCount: number;
  /** MIN(id) of the group — a stable representative record for the vault. */
  representativeId: number;
}

/**
 * Vault summaries grouped by flattened vault metadata. Mirrors the Dexie filter
 * (type='address', importance in xpub-derived/verified, isVaultXpub with truthy
 * m AND n) and groups by (vaultName, vaultM, vaultN, vaultNotes). Because the
 * vaultNotes JSON carries scriptType + cosigners, identical vaultNotes within a
 * real vault produces the SAME grouping as the page's generateVaultKey; the page
 * re-parses the representative's vaultNotes for display, so the rendered result
 * matches. The optional `search` is a coarse case-insensitive prefilter over
 * vaultName + the raw vaultNotes text (which contains cosigner names/scriptType/
 * userNotes); the page applies its exact parsed-field filter over the few groups.
 */
export function getVaultSummaries(db: EngineDb, opts: { search?: string } = {}): VaultSummaryRow[] {
  const clauses = [
    "type = 'address'",
    "addressImportance IN ('xpub-derived', 'verified')",
    'vaultIsVaultXpub = 1',
    'vaultM IS NOT NULL AND vaultM <> 0',
    'vaultN IS NOT NULL AND vaultN <> 0',
  ];
  const bind: unknown[] = [];
  const search = opts.search?.trim().toLowerCase();
  if (search) {
    const like = `%${escapeLikeTerm(search)}%`;
    clauses.push("(lower(COALESCE(vaultName, '')) LIKE ? ESCAPE '\\' OR lower(COALESCE(vaultNotes, '')) LIKE ? ESCAPE '\\')");
    bind.push(like, like);
  }
  return selectRows<VaultSummaryRow>(
    db,
    `SELECT vaultName, vaultM, vaultN, vaultNotes,
            COUNT(*) AS addressCount,
            MIN(id) AS representativeId
       FROM records
      WHERE ${clauses.join(' AND ')}
      GROUP BY vaultName, vaultM, vaultN, vaultNotes
      ORDER BY addressCount DESC, vaultName`,
    bind,
  );
}

// ---------------------------------------------------------------------------
// Query: owned UTXO set (exact anti-join)
// ---------------------------------------------------------------------------

export interface OwnedUtxo {
  id: number;
  txid: string;
  vout: number | null;
  address: string;
  amount: number;
  recordId: number | null;
}

function ownedTierPlaceholders(tiers: string[]): { sql: string; bind: string[] } {
  const t = tiers.length ? tiers : OWNED_TIERS;
  return { sql: t.map(() => '?').join(','), bind: t };
}

/** Stable signature for a tier set (order-independent) used to gate the cache. */
function tiersSignature(tiers: string[]): string {
  return JSON.stringify([...(tiers.length ? tiers : OWNED_TIERS)].sort());
}

/**
 * Build the shared WHERE clause (+ ordered bind params) for the LIVE owned-UTXO
 * anti-join used by both `countOwnedUtxos` and `getOwnedUtxos` whenever the
 * materialized fast path cannot serve the request (custom tiers, an "as of"
 * historical cutoff, or no build yet). Keeping the predicate in one place keeps
 * the count and the page query in lockstep.
 *
 * An owned output is included when: it is a real output (role='output', vout set)
 * of a confirmed tx (blockTime > 0); its address belongs to a record in one of
 * the requested tiers; and no input spends its outpoint. When `asOfBlockTime`
 * (unix seconds) is given, the output's tx must be confirmed at/before the cutoff
 * AND a spend only counts if the SPENDING input's tx was itself confirmed
 * at/before the cutoff — i.e. the set of UTXOs as the chain stood at that time.
 * This mirrors the in-browser exact computation's `blockTime > 0 && <= cutoff`
 * gating on both the output and the spending input.
 *
 * Params are pushed in the exact textual order the `?` placeholders appear:
 * output-cutoff, tier list, spend-cutoff.
 */
function buildLiveOwnedUtxosClause(
  tiers: string[],
  asOfBlockTime?: number,
): { whereSql: string; params: unknown[] } {
  const { sql: tierSql, bind: tierBind } = ownedTierPlaceholders(tiers);
  const params: unknown[] = [];

  let outTimeSql = 'AND COALESCE(t.blockTime, 0) > 0';
  if (asOfBlockTime != null) {
    outTimeSql += ' AND t.blockTime <= ?';
    params.push(asOfBlockTime);
  }

  params.push(...tierBind);

  let spendSql = `AND NOT EXISTS (
        SELECT 1 FROM transactionParticipants i
        WHERE i.role = 'input' AND i.prevTxid = o.txid AND i.prevVout = o.vout`;
  if (asOfBlockTime != null) {
    spendSql += `
          AND EXISTS (
            SELECT 1 FROM blockchainTransactions it
            WHERE it.txid = i.txid AND COALESCE(it.blockTime, 0) > 0 AND it.blockTime <= ?
          )`;
    params.push(asOfBlockTime);
  }
  spendSql += `
      )`;

  const whereSql = `
    WHERE o.role = 'output'
      AND o.vout IS NOT NULL
      ${outTimeSql}
      AND EXISTS (
        SELECT 1 FROM records r
        WHERE r.inputString = o.address AND r.type = 'address'
          AND r.addressImportance IN (${tierSql})
      )
      ${spendSql}`;

  return { whereSql, params };
}

function ownedUtxosTableExists(db: EngineDb): boolean {
  return (
    selectScalar(
      db,
      "SELECT COUNT(*) AS v FROM sqlite_master WHERE type = 'table' AND name = 'ownedUtxos'",
    ) > 0
  );
}

/**
 * True when the materialized `ownedUtxos` table is present AND was built for the
 * exact tier set requested. Reads fall back to the live anti-join otherwise, so
 * unit tests (which never build the table) and custom-tier callers stay correct.
 */
export function ownedUtxosReady(db: EngineDb, tiers: string[] = OWNED_TIERS): boolean {
  if (!ownedUtxosTableExists(db)) return false;
  const built = getEngineMeta(db, OWNED_UTXOS_TIERS_KEY);
  return built != null && built === tiersSignature(tiers);
}

/**
 * Materialize the owned-UTXO set into a dedicated `ownedUtxos` table so the two
 * hottest big-vault reads (`countOwnedUtxos`, first page of `getOwnedUtxos`)
 * become a cached-scalar read and a primary-key keyset scan instead of a full
 * per-output anti-join with two correlated subqueries (owned-tier EXISTS + the
 * blockTime JOIN) that costs multiple seconds at ~13M participants.
 *
 * This runs the expensive anti-join EXACTLY ONCE, at finalize time, which fits
 * the engine's full-rebuild replica model: the table is dropped on every
 * seedBegin/clear and rebuilt here after createIndexes. The participant id is
 * reused as the PRIMARY KEY so ordered keyset paging (`id > ? ORDER BY id`) is a
 * pure b-tree walk. Returns the materialized row count.
 */
export function buildOwnedUtxos(db: EngineDb, tiers: string[] = OWNED_TIERS): number {
  const { sql: tierSql, bind } = ownedTierPlaceholders(tiers);
  db.exec('DROP TABLE IF EXISTS ownedUtxos;');
  db.exec(`
    CREATE TABLE ownedUtxos (
      id       INTEGER PRIMARY KEY,
      txid     TEXT NOT NULL,
      vout     INTEGER,
      address  TEXT NOT NULL,
      amount   INTEGER NOT NULL,
      recordId INTEGER
    );
  `);
  db.run(
    `
    INSERT INTO ownedUtxos (id, txid, vout, address, amount, recordId)
    SELECT o.id, o.txid, o.vout, o.address, o.amount, o.recordId
    FROM transactionParticipants o
    JOIN blockchainTransactions t ON t.txid = o.txid
    WHERE o.role = 'output'
      AND o.vout IS NOT NULL
      AND COALESCE(t.blockTime, 0) > 0
      AND EXISTS (
        SELECT 1 FROM records r
        WHERE r.inputString = o.address AND r.type = 'address'
          AND r.addressImportance IN (${tierSql})
      )
      AND NOT EXISTS (
        SELECT 1 FROM transactionParticipants i
        WHERE i.role = 'input' AND i.prevTxid = o.txid AND i.prevVout = o.vout
      )
    `,
    bind,
  );
  const count = selectScalar(db, 'SELECT COUNT(*) AS v FROM ownedUtxos');
  // Set the count first, then the tiers signature LAST: ownedUtxosReady gates on
  // the signature, so it only flips to "ready" once the count is already stored.
  setEngineMeta(db, OWNED_UTXOS_COUNT_KEY, String(count));
  setEngineMeta(db, OWNED_UTXOS_TIERS_KEY, tiersSignature(tiers));
  return count;
}

export function countOwnedUtxos(
  db: EngineDb,
  opts: { tiers?: string[]; asOfBlockTime?: number } = {},
): number {
  const tiers = opts.tiers ?? OWNED_TIERS;
  // Fast path: serve the cached count from the materialized table. Only valid for
  // the default tier set with NO historical cutoff — the materialized table has
  // no time dimension, so an "as of" query must always use the live anti-join.
  if (opts.asOfBlockTime == null && ownedUtxosReady(db, tiers)) {
    const cached = getEngineMeta(db, OWNED_UTXOS_COUNT_KEY);
    if (cached != null) return Number(cached);
    return selectScalar(db, 'SELECT COUNT(*) AS v FROM ownedUtxos');
  }
  const { whereSql, params } = buildLiveOwnedUtxosClause(tiers, opts.asOfBlockTime);
  return selectScalar(
    db,
    `
    SELECT COUNT(*) AS v
    FROM transactionParticipants o
    JOIN blockchainTransactions t ON t.txid = o.txid
    ${whereSql}
    `,
    params,
  );
}

export function getOwnedUtxos(
  db: EngineDb,
  opts: { tiers?: string[]; afterId?: number; limit: number; asOfBlockTime?: number },
): OwnedUtxo[] {
  const tiers = opts.tiers ?? OWNED_TIERS;
  // Fast path: keyset-page the materialized table by its integer primary key.
  // Skipped for "as of" queries (the table has no time dimension) so a date
  // cutoff always falls through to the live anti-join below.
  if (opts.asOfBlockTime == null && ownedUtxosReady(db, tiers)) {
    const params: unknown[] = [];
    let cursor = '';
    if (opts.afterId != null) {
      cursor = 'WHERE id > ?';
      params.push(opts.afterId);
    }
    params.push(opts.limit);
    return selectRows<OwnedUtxo>(
      db,
      `SELECT id, txid, vout, address, amount, recordId FROM ownedUtxos ${cursor} ORDER BY id LIMIT ?`,
      params,
    );
  }
  const { whereSql, params } = buildLiveOwnedUtxosClause(tiers, opts.asOfBlockTime);
  let cursor = '';
  if (opts.afterId != null) {
    cursor = 'AND o.id > ?';
    params.push(opts.afterId);
  }
  params.push(opts.limit);
  return selectRows<OwnedUtxo>(
    db,
    `
    SELECT o.id AS id, o.txid AS txid, o.vout AS vout, o.address AS address,
           o.amount AS amount, o.recordId AS recordId
    FROM transactionParticipants o
    JOIN blockchainTransactions t ON t.txid = o.txid
    ${whereSql}
      ${cursor}
    ORDER BY o.id
    LIMIT ?
    `,
    params,
  );
}

// ---------------------------------------------------------------------------
// Query: heuristic ("estimated", no-prevout) owned-UTXO set
// ---------------------------------------------------------------------------
//
// The heuristic view never reads `prevTxid/prevVout`; it estimates which outputs
// are still unspent by FIFO amount-matching within each (owned address, amount)
// group. This mirrors the in-browser computation in UTXOs.tsx exactly:
//
//   - Candidate outputs: real outputs (role='output', vout set) of confirmed
//     txs (blockTime > 0, and <= cutoff for an "as of" read) whose address is an
//     owned record in one of the requested tiers.
//   - Candidate inputs: inputs at those same owned addresses, same confirmation
//     gating. (The page keys matches by `address:amount`; restricting inputs to
//     owned addresses is equivalent because a non-owned address is a different
//     key that owned outputs never consult — and it is also a big speedup.)
//   - Per (address, amount) group: walk outputs in (blockTime, vout) order and
//     greedily consume the earliest not-yet-used input whose tx confirmed
//     STRICTLY LATER than the output. A consumed output is "spent".
//
// That greedy is provably a maximum matching, and the spent set is always a
// downward-closed prefix of the outputs in (blockTime, vout, id) order. So the
// number of spends equals `matched = nIn + MIN(0, minRunningPrefix)` where the
// running prefix sums +1 per output / -1 per input over (blockTime, typeRank)
// with inputs (typeRank 0) ordered before outputs (typeRank 1) at the same
// time. An output is a UTXO iff its ascending rank within the group (by
// blockTime, vout, id — the id tiebreak matches the page's stable sort, which
// preserves Dexie primary-key order within a single address) exceeds `matched`.
//
// The id tiebreak in the page comes from `.where('address').anyOf(...).toArray()`
// returning rows in primary-key order within one address value, and the group's
// rows all share that address, so ordering the SQL by id reproduces it.

/**
 * Build the shared CTE chain (+ ordered bind params) that exposes a relation
 * `heuristic_utxos(id, txid, vout, address, amount, recordId)` of the estimated
 * unspent owned outputs. Both the count and the page query append their own
 * final SELECT after this prefix, so the count and the listing stay in lockstep.
 *
 * Params are pushed in the exact textual order the `?` placeholders appear:
 * output-cutoff, output tier list, input-cutoff, input tier list.
 */
function buildHeuristicCte(
  tiers: string[],
  asOfBlockTime?: number,
): { cteSql: string; params: unknown[] } {
  const { sql: tierSql, bind: tierBind } = ownedTierPlaceholders(tiers);
  const params: unknown[] = [];

  let outTimeSql = 'AND COALESCE(t.blockTime, 0) > 0';
  if (asOfBlockTime != null) {
    outTimeSql += ' AND t.blockTime <= ?';
    params.push(asOfBlockTime);
  }
  params.push(...tierBind);

  let inTimeSql = 'AND COALESCE(t.blockTime, 0) > 0';
  if (asOfBlockTime != null) {
    inTimeSql += ' AND t.blockTime <= ?';
    params.push(asOfBlockTime);
  }
  params.push(...tierBind);

  const cteSql = `
    WITH oo AS (
      SELECT o.id AS id, o.txid AS txid, o.vout AS vout, o.address AS address,
             o.amount AS amount, o.recordId AS recordId, t.blockTime AS bt
      FROM transactionParticipants o
      JOIN blockchainTransactions t ON t.txid = o.txid
      WHERE o.role = 'output'
        AND o.vout IS NOT NULL
        ${outTimeSql}
        AND EXISTS (
          SELECT 1 FROM records r
          WHERE r.inputString = o.address AND r.type = 'address'
            AND r.addressImportance IN (${tierSql})
        )
    ),
    ii AS (
      SELECT i.address AS address, i.amount AS amount, t.blockTime AS bt
      FROM transactionParticipants i
      JOIN blockchainTransactions t ON t.txid = i.txid
      WHERE i.role = 'input'
        ${inTimeSql}
        AND EXISTS (
          SELECT 1 FROM records r
          WHERE r.inputString = i.address AND r.type = 'address'
            AND r.addressImportance IN (${tierSql})
        )
    ),
    events AS (
      SELECT address, amount, bt, 1 AS typeRank, 1 AS delta FROM oo
      UNION ALL
      SELECT address, amount, bt, 0 AS typeRank, -1 AS delta FROM ii
    ),
    running AS (
      SELECT address, amount, delta,
        SUM(delta) OVER (
          PARTITION BY address, amount
          ORDER BY bt, typeRank
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS prefix
      FROM events
    ),
    grp AS (
      SELECT address, amount,
        SUM(CASE WHEN delta = -1 THEN 1 ELSE 0 END) AS nIn,
        MIN(prefix) AS minRun
      FROM running
      GROUP BY address, amount
    ),
    ranked AS (
      SELECT oo.id AS id, oo.txid AS txid, oo.vout AS vout, oo.address AS address,
             oo.amount AS amount, oo.recordId AS recordId,
        ROW_NUMBER() OVER (
          PARTITION BY oo.address, oo.amount
          ORDER BY oo.bt, oo.vout, oo.id
        ) AS rn
      FROM oo
    ),
    heuristic_utxos AS (
      SELECT r.id AS id, r.txid AS txid, r.vout AS vout, r.address AS address,
             r.amount AS amount, r.recordId AS recordId
      FROM ranked r
      JOIN grp g ON g.address = r.address AND g.amount = r.amount
      WHERE r.rn > (g.nIn + MIN(0, g.minRun))
    )`;

  return { cteSql, params };
}

function heuristicOwnedUtxosTableExists(db: EngineDb): boolean {
  return (
    selectScalar(
      db,
      "SELECT COUNT(*) AS v FROM sqlite_master WHERE type = 'table' AND name = 'heuristicOwnedUtxos'",
    ) > 0
  );
}

/**
 * True when the materialized `heuristicOwnedUtxos` table is present AND was built
 * for the exact tier set requested. Reads fall back to the live computation
 * otherwise, so unit tests (which never build the table) and custom-tier callers
 * stay correct.
 */
export function heuristicOwnedUtxosReady(db: EngineDb, tiers: string[] = OWNED_TIERS): boolean {
  if (!heuristicOwnedUtxosTableExists(db)) return false;
  const built = getEngineMeta(db, HEURISTIC_UTXOS_TIERS_KEY);
  return built != null && built === tiersSignature(tiers);
}

/**
 * Materialize the heuristic owned-UTXO set into a dedicated
 * `heuristicOwnedUtxos` table so the two hottest big-vault reads
 * (`countHeuristicOwnedUtxos`, first page of `getHeuristicOwnedUtxos`) become a
 * cached-scalar read and a primary-key keyset scan instead of the full
 * window-function computation. Runs the expensive computation EXACTLY ONCE, at
 * finalize time, matching the engine's full-rebuild replica model. The
 * participant id is reused as the PRIMARY KEY so ordered keyset paging is a pure
 * b-tree walk. Returns the materialized row count.
 */
export function buildHeuristicOwnedUtxos(db: EngineDb, tiers: string[] = OWNED_TIERS): number {
  const { cteSql, params } = buildHeuristicCte(tiers);
  db.exec('DROP TABLE IF EXISTS heuristicOwnedUtxos;');
  db.exec(`
    CREATE TABLE heuristicOwnedUtxos (
      id       INTEGER PRIMARY KEY,
      txid     TEXT NOT NULL,
      vout     INTEGER,
      address  TEXT NOT NULL,
      amount   INTEGER NOT NULL,
      recordId INTEGER
    );
  `);
  db.run(
    `${cteSql}
    INSERT INTO heuristicOwnedUtxos (id, txid, vout, address, amount, recordId)
    SELECT id, txid, vout, address, amount, recordId FROM heuristic_utxos`,
    params,
  );
  const count = selectScalar(db, 'SELECT COUNT(*) AS v FROM heuristicOwnedUtxos');
  // Set the count first, then the tiers signature LAST: heuristicOwnedUtxosReady
  // gates on the signature, so it only flips to "ready" once the count is stored.
  setEngineMeta(db, HEURISTIC_UTXOS_COUNT_KEY, String(count));
  setEngineMeta(db, HEURISTIC_UTXOS_TIERS_KEY, tiersSignature(tiers));
  return count;
}

export function countHeuristicOwnedUtxos(
  db: EngineDb,
  opts: { tiers?: string[]; asOfBlockTime?: number } = {},
): number {
  const tiers = opts.tiers ?? OWNED_TIERS;
  // Fast path: cached count from the materialized table. Only valid for the
  // default tier set with NO historical cutoff (the table has no time dimension).
  if (opts.asOfBlockTime == null && heuristicOwnedUtxosReady(db, tiers)) {
    const cached = getEngineMeta(db, HEURISTIC_UTXOS_COUNT_KEY);
    if (cached != null) return Number(cached);
    return selectScalar(db, 'SELECT COUNT(*) AS v FROM heuristicOwnedUtxos');
  }
  const { cteSql, params } = buildHeuristicCte(tiers, opts.asOfBlockTime);
  return selectScalar(db, `${cteSql} SELECT COUNT(*) AS v FROM heuristic_utxos`, params);
}

export function getHeuristicOwnedUtxos(
  db: EngineDb,
  opts: { tiers?: string[]; afterId?: number; limit: number; asOfBlockTime?: number },
): OwnedUtxo[] {
  const tiers = opts.tiers ?? OWNED_TIERS;
  // Fast path: keyset-page the materialized table by its integer primary key.
  // Skipped for "as of" queries (the table has no time dimension).
  if (opts.asOfBlockTime == null && heuristicOwnedUtxosReady(db, tiers)) {
    const params: unknown[] = [];
    let cursor = '';
    if (opts.afterId != null) {
      cursor = 'WHERE id > ?';
      params.push(opts.afterId);
    }
    params.push(opts.limit);
    return selectRows<OwnedUtxo>(
      db,
      `SELECT id, txid, vout, address, amount, recordId FROM heuristicOwnedUtxos ${cursor} ORDER BY id LIMIT ?`,
      params,
    );
  }
  const { cteSql, params } = buildHeuristicCte(tiers, opts.asOfBlockTime);
  let cursor = '';
  if (opts.afterId != null) {
    cursor = 'WHERE id > ?';
    params.push(opts.afterId);
  }
  params.push(opts.limit);
  return selectRows<OwnedUtxo>(
    db,
    `${cteSql}
    SELECT id, txid, vout, address, amount, recordId
    FROM heuristic_utxos
    ${cursor}
    ORDER BY id
    LIMIT ?`,
    params,
  );
}

// ---------------------------------------------------------------------------
// Query: participant lookups (compat with the prototype surface)
// ---------------------------------------------------------------------------

export function getParticipantsByTxids(db: EngineDb, txids: string[]): ParticipantRow[] {
  if (txids.length === 0) return [];
  const out: ParticipantRow[] = [];
  for (const batch of chunk(txids, PARAM_BATCH_SIZE)) {
    const placeholders = batch.map(() => '?').join(',');
    out.push(
      ...selectRows<ParticipantRow>(
        db,
        `SELECT * FROM transactionParticipants WHERE txid IN (${placeholders})`,
        batch,
      ),
    );
  }
  return out;
}

export function getParticipantsByAddresses(db: EngineDb, addresses: string[]): ParticipantRow[] {
  if (addresses.length === 0) return [];
  const out: ParticipantRow[] = [];
  for (const batch of chunk(addresses, PARAM_BATCH_SIZE)) {
    const placeholders = batch.map(() => '?').join(',');
    out.push(
      ...selectRows<ParticipantRow>(
        db,
        `SELECT * FROM transactionParticipants WHERE address IN (${placeholders})`,
        batch,
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// DB file statistics
// ---------------------------------------------------------------------------

export interface DbFileStats {
  pageCount: number;
  pageSize: number;
  freelistCount: number;
  sizeBytes: number;
}

export function getDbFileStats(db: EngineDb): DbFileStats {
  const pageCount = selectScalarPragma(db, 'PRAGMA page_count');
  const pageSize = selectScalarPragma(db, 'PRAGMA page_size');
  const freelistCount = selectScalarPragma(db, 'PRAGMA freelist_count');
  return {
    pageCount,
    pageSize,
    freelistCount,
    sizeBytes: pageCount * pageSize,
  };
}

function selectScalarPragma(db: EngineDb, pragma: string): number {
  const rows = db.selectRows<Record<string, unknown>>(pragma);
  const v = rows[0] ? Object.values(rows[0])[0] : undefined;
  return typeof v === 'number' ? v : Number(v ?? 0);
}

// ---------------------------------------------------------------------------
// Synthetic data generation (benchmarking only)
// ---------------------------------------------------------------------------

export interface SyntheticSpec {
  /** Number of address records (owned) to create. */
  addresses: number;
  /** Number of blockchain transactions to create. */
  transactions: number;
  /**
   * Average participants per transaction (split across inputs/outputs). Total
   * participant rows ≈ transactions * participantsPerTx.
   */
  participantsPerTx?: number;
  /** Fraction (0..1) of outputs that get spent by a later input. */
  spentFraction?: number;
  /** Insert batch size. */
  batchSize?: number;
}

/**
 * Populate the engine with synthetic, index-exercising data for at-scale
 * benchmarking. Generates owned address records, transactions, and participant
 * rows where a configurable fraction of outputs are later spent (so the UTXO
 * anti-join has real work to do). Returns the row counts created.
 */
export interface SeedProgress {
  phase: 'records' | 'transactions' | 'participants';
  done: number;
  total: number;
}

export function generateSyntheticData(
  db: EngineDb,
  spec: SyntheticSpec,
  onProgress?: (p: SeedProgress) => void,
): { records: number; transactions: number; participants: number } {
  const participantsPerTx = spec.participantsPerTx ?? 4;
  const spentFraction = spec.spentFraction ?? 0.5;
  const batchSize = spec.batchSize ?? 20000;
  const addressCount = Math.max(1, spec.addresses);
  const estParticipants = spec.transactions * participantsPerTx;

  // 1) Address records.
  {
    let id = 1;
    while (id <= addressCount) {
      const rows: RecordRow[] = [];
      const end = Math.min(addressCount, id + batchSize - 1);
      for (; id <= end; id++) {
        const addr = `bc1qsynth${id}`;
        rows.push({
          id,
          type: 'address',
          inputString: addr,
          inputStringLower: addr.toLowerCase(),
          label: `Synthetic Address ${id}`,
          notes: null,
          owner: `Owner${id % 50}`,
          walletName: `Wallet${id % 20}`,
          seedName: null,
          walletSoftware: null,
          addressImportance: 'manual',
          chainType: null,
          syncDepth: 0,
          firstSeenBlockTime: null,
          cachedBalanceSats: null,
          cachedTxCount: null,
          cachedUtxoCount: null,
          statsComputedAt: null,
          createdAt: id,
          updatedAt: id,
          tags: '[]',
          categories: '[]',
        });
      }
      insertRecords(db, rows);
      onProgress?.({ phase: 'records', done: id - 1, total: addressCount });
    }
  }

  // 2) Transactions.
  {
    let id = 1;
    while (id <= spec.transactions) {
      const rows: TransactionRow[] = [];
      const end = Math.min(spec.transactions, id + batchSize - 1);
      for (; id <= end; id++) {
        rows.push({
          id,
          txid: `tx${id}`,
          blockHeight: 700000 + (id % 100000),
          blockTime: 1600000000 + id * 60,
          fee: 1000 + (id % 5000),
          feeRate: 10,
          vsize: 200,
          hasOpReturn: id % 97 === 0 ? 1 : 0,
        });
      }
      insertTransactions(db, rows);
      onProgress?.({ phase: 'transactions', done: id - 1, total: spec.transactions });
    }
  }

  // 3) Participants. Each tx gets `participantsPerTx` rows: half outputs, half
  //    inputs. A `spentFraction` of outputs are referenced as prevout by a later
  //    tx's input so the anti-join is meaningful.
  let participantId = 1;
  const outputsPerTx = Math.max(1, Math.floor(participantsPerTx / 2));
  const inputsPerTx = Math.max(0, participantsPerTx - outputsPerTx);
  {
    let txid = 1;
    while (txid <= spec.transactions) {
      const rows: ParticipantRow[] = [];
      const end = Math.min(spec.transactions, txid + Math.ceil(batchSize / participantsPerTx) - 1);
      for (; txid <= end; txid++) {
        for (let v = 0; v < outputsPerTx; v++) {
          const addrIdx = ((txid * outputsPerTx + v) % addressCount) + 1;
          rows.push({
            id: participantId++,
            txid: `tx${txid}`,
            role: 'output',
            address: `bc1qsynth${addrIdx}`,
            amount: 100000 + (v + txid) * 13,
            vout: v,
            prevTxid: null,
            prevVout: null,
            recordId: addrIdx,
            scriptType: 'v0_p2wpkh',
          });
        }
        for (let k = 0; k < inputsPerTx; k++) {
          // Spend an output from an earlier transaction with probability
          // spentFraction; otherwise leave prevout null (won't spend anything).
          const spends = txid > 1 && (txid + k) % 100 < spentFraction * 100;
          const prevTx = spends ? ((txid - 1 - k + spec.transactions) % (txid - 1)) + 1 : 0;
          const prevVout = spends ? (txid + k) % outputsPerTx : 0;
          const addrIdx = ((txid * 7 + k) % addressCount) + 1;
          rows.push({
            id: participantId++,
            txid: `tx${txid}`,
            role: 'input',
            address: `bc1qsynth${addrIdx}`,
            amount: 90000 + (k + txid) * 11,
            vout: null,
            prevTxid: spends ? `tx${prevTx}` : null,
            prevVout: spends ? prevVout : null,
            recordId: addrIdx,
            scriptType: 'v0_p2wpkh',
          });
        }
        if (rows.length >= batchSize) {
          insertParticipants(db, rows);
          rows.length = 0;
          onProgress?.({ phase: 'participants', done: participantId - 1, total: estParticipants });
        }
      }
      if (rows.length > 0) insertParticipants(db, rows);
      onProgress?.({ phase: 'participants', done: participantId - 1, total: estParticipants });
    }
  }

  return {
    records: countTable(db, 'records'),
    transactions: countTable(db, 'blockchainTransactions'),
    participants: countTable(db, 'transactionParticipants'),
  };
}

// ---------------------------------------------------------------------------
// PRAGMA tuning (applied by the worker right after opening the DB).
// ---------------------------------------------------------------------------

export function applyTuningPragmas(db: EngineDb): void {
  // Larger page cache (negative = KiB). ~64 MiB of cache materially speeds up
  // the index-heavy anti-join on tens of millions of rows.
  db.exec('PRAGMA cache_size = -65536;');
  db.exec('PRAGMA temp_store = MEMORY;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = OFF;');
}

/**
 * Durable connection pragmas applied immediately after opening the native DB on
 * removable media. journal_mode=TRUNCATE (NOT WAL) keeps the database to a single
 * file that survives USB removal cleanly; temp_store=MEMORY keeps temp B-trees off
 * the slow stick; a large negative cache_size buys ~64 MiB of page cache.
 */
export function applyConnectionPragmas(db: EngineDb): void {
  db.exec('PRAGMA journal_mode = TRUNCATE;');
  db.exec('PRAGMA temp_store = MEMORY;');
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('PRAGMA cache_size = -65536;');
}

/**
 * Bulk-load pragmas: synchronous=OFF trades crash-durability for speed during the
 * full-rebuild seed. Safe here because the engine is a DERIVED replica — on any
 * interruption we drop and re-seed from Dexie, and we run integrity_check before
 * marking READY. Call applyReadPragmas once the load + index phase completes.
 */
export function applyBulkLoadPragmas(db: EngineDb): void {
  db.exec('PRAGMA synchronous = OFF;');
}

/**
 * Index-build pragmas: spill the large CREATE INDEX / materialize sort to the OS
 * temporary directory (on the fast local/system drive) instead of holding the
 * whole sort in RAM. This bounds peak memory on constrained machines and very
 * large USB vaults, where an all-in-memory sort could exhaust RAM. SQLite's
 * sorter temp files go to the OS temp dir — NOT next to the database on the slow
 * USB — so this does not write to the stick. Pair with applyReadPragmas
 * afterwards to restore the in-memory temp store for steady-state reads.
 */
export function applyIndexBuildPragmas(db: EngineDb): void {
  db.exec('PRAGMA temp_store = FILE;');
}

/**
 * Steady-state pragmas after seeding: restore NORMAL durability for reads and the
 * in-memory temp store (query-time temp B-trees are small and stay off the slow
 * USB), reverting the disk-spill temp store used during the index build.
 */
export function applyReadPragmas(db: EngineDb): void {
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA temp_store = MEMORY;');
}

/**
 * Run PRAGMA integrity_check and collapse the result to a single status string.
 * Returns 'ok' when the database is sound, otherwise a semicolon-joined list of
 * the problems SQLite reported. This is the gate the seed runs before marking READY.
 */
export function integrityCheck(db: EngineDb): string {
  const rows = db.selectRows<Record<string, unknown>>('PRAGMA integrity_check');
  const messages = rows
    .map((r) => String(Object.values(r)[0] ?? '').trim())
    .filter((m) => m.length > 0);
  if (messages.length === 1 && messages[0].toLowerCase() === 'ok') return 'ok';
  return messages.join('; ') || 'ok';
}

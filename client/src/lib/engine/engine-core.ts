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

// SQLite caps bound parameters per statement (default 32766 in modern builds,
// but historically 999). Stay well under the conservative ceiling for IN() lists.
const PARAM_BATCH_SIZE = 800;

// engineMeta keys for the materialized owned-UTXO set (see buildOwnedUtxos). The
// tiers signature records which owned tiers the materialized table was built for
// so reads only trust it when the requested tiers match; the count is cached so
// `countOwnedUtxos` is O(1) instead of scanning a multi-million-row table.
const OWNED_UTXOS_TIERS_KEY = 'owned_utxos_tiers';
const OWNED_UTXOS_COUNT_KEY = 'owned_utxos_count';

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
      categories         TEXT
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
 * Create every secondary index and run ANALYZE. Called once after a bulk load so
 * index maintenance does not slow the insert phase. Index definitions are the
 * single source of truth for the engine's read query plans.
 */
export function createIndexes(db: EngineDb): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_records_type_id          ON records(type, id);
    CREATE INDEX IF NOT EXISTS idx_records_importance_id    ON records(addressImportance, id);
    CREATE INDEX IF NOT EXISTS idx_records_inputlower       ON records(inputStringLower);
    CREATE INDEX IF NOT EXISTS idx_records_owner            ON records(owner);
    CREATE INDEX IF NOT EXISTS idx_records_walletName       ON records(walletName);
    CREATE INDEX IF NOT EXISTS idx_records_addr_owned       ON records(inputString, type, addressImportance);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_bt_txid     ON blockchainTransactions(txid);
    CREATE INDEX IF NOT EXISTS idx_bt_blockTime       ON blockchainTransactions(blockTime);

    CREATE INDEX IF NOT EXISTS idx_tp_txid_role ON transactionParticipants(txid, role);
    CREATE INDEX IF NOT EXISTS idx_tp_txid      ON transactionParticipants(txid);
    CREATE INDEX IF NOT EXISTS idx_tp_address   ON transactionParticipants(address);
    CREATE INDEX IF NOT EXISTS idx_tp_recordId  ON transactionParticipants(recordId);
    -- Spent-check correlation for the UTXO anti-join: probe by (prevTxid, prevVout)
    -- then confirm role='input'. Including role keeps the probe covering at scale.
    CREATE INDEX IF NOT EXISTS idx_tp_prev      ON transactionParticipants(prevTxid, prevVout, role);
    -- Owned-output scan + anti-join correlation (needs txid, vout) + keyset order (id).
    -- Covering index so the owned-UTXO sweep avoids row lookups at 20M scale.
    CREATE INDEX IF NOT EXISTS idx_tp_out       ON transactionParticipants(role, address, txid, vout, id);

    ANALYZE;
  `);
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
  `);
  // Invalidate the materialized owned-UTXO metadata so a partial/cleared state
  // never serves a stale count. engineMeta may not exist yet on the very first
  // drop (before createTablesOnly), so ensure it before clearing.
  db.exec('CREATE TABLE IF NOT EXISTS engineMeta (key TEXT PRIMARY KEY, value TEXT);');
  db.run('DELETE FROM engineMeta WHERE key IN (?, ?)', [OWNED_UTXOS_TIERS_KEY, OWNED_UTXOS_COUNT_KEY]);
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
         statsComputedAt, createdAt, updatedAt, tags, categories)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
}

function buildRecordWhere(opts: RecordQueryOptions): { sql: string; bind: unknown[] } {
  const clauses: string[] = [];
  const bind: unknown[] = [];
  if (opts.type) {
    clauses.push('type = ?');
    bind.push(opts.type);
  }
  if (!opts.includeBlockchainDiscovered) {
    clauses.push("(addressImportance IS NULL OR addressImportance NOT IN ('blockchain-discovered','pending-review'))");
  }
  const search = opts.search?.trim().toLowerCase();
  if (search) {
    const like = `%${search}%`;
    clauses.push(
      '(inputStringLower LIKE ? OR lower(label) LIKE ? OR lower(owner) LIKE ? OR lower(walletName) LIKE ? OR lower(notes) LIKE ?)',
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

export interface RecordPageOptions extends RecordQueryOptions {
  /** Keyset cursor: return rows with id < beforeId (for id-descending order). */
  beforeId?: number;
  limit: number;
}

/**
 * Keyset-paginated records in id-descending order (newest first), matching the
 * Records page ordering. Uses id < beforeId so paging never re-scans skipped
 * rows the way OFFSET does.
 */
export function getRecordPage(db: EngineDb, opts: RecordPageOptions): RecordRow[] {
  const where = buildRecordWhere(opts);
  const clauses: string[] = [];
  const bind: unknown[] = [];
  if (where.sql) {
    clauses.push(where.sql.replace(/^WHERE /, ''));
    bind.push(...where.bind);
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
      outSats: number;
      inSats: number;
      txCount: number;
      lastTime: number | null;
    }>(
      db,
      `
      SELECT p.address AS address,
             SUM(CASE WHEN p.role='output' THEN p.amount ELSE 0 END) AS outSats,
             SUM(CASE WHEN p.role='input'  THEN p.amount ELSE 0 END) AS inSats,
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
        balanceSats: (r.outSats ?? 0) - (r.inSats ?? 0),
        txCount: r.txCount ?? 0,
        lastActivityTime: r.lastTime ?? 0,
        utxoCount: 0,
      });
    }

    const utxoRows = selectRows<{ address: string; utxoCount: number }>(
      db,
      `
      SELECT o.address AS address, COUNT(*) AS utxoCount
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
      if (existing) existing.utxoCount = r.utxoCount ?? 0;
      else
        out.set(r.address, {
          address: r.address,
          balanceSats: 0,
          txCount: 0,
          lastActivityTime: 0,
          utxoCount: r.utxoCount ?? 0,
        });
    }
  }

  return out;
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

export function countOwnedUtxos(db: EngineDb, tiers: string[] = OWNED_TIERS): number {
  // Fast path: serve the cached count from the materialized table.
  if (ownedUtxosReady(db, tiers)) {
    const cached = getEngineMeta(db, OWNED_UTXOS_COUNT_KEY);
    if (cached != null) return Number(cached);
    return selectScalar(db, 'SELECT COUNT(*) AS v FROM ownedUtxos');
  }
  const { sql: tierSql, bind } = ownedTierPlaceholders(tiers);
  return selectScalar(
    db,
    `
    SELECT COUNT(*) AS v
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
}

export function getOwnedUtxos(
  db: EngineDb,
  opts: { tiers?: string[]; afterId?: number; limit: number },
): OwnedUtxo[] {
  const tiers = opts.tiers ?? OWNED_TIERS;
  // Fast path: keyset-page the materialized table by its integer primary key.
  if (ownedUtxosReady(db, tiers)) {
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
  const { sql: tierSql, bind } = ownedTierPlaceholders(tiers);
  const params: unknown[] = [...bind];
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
      ${cursor}
    ORDER BY o.id
    LIMIT ?
    `,
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

/** Steady-state pragmas after seeding: restore NORMAL durability for reads. */
export function applyReadPragmas(db: EngineDb): void {
  db.exec('PRAGMA synchronous = NORMAL;');
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

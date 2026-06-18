/**
 * KYUTXO SQLite read-engine — pure core (Task #271).
 *
 * This module contains ZERO browser/OPFS/Comlink dependencies. It operates on a
 * sqlite-wasm `Database` handle that the caller supplies, so the exact same SQL
 * logic can be:
 *   - driven by the off-main-thread worker against the OPFS-backed database, and
 *   - unit-tested in Node against an in-memory database.
 *
 * Responsibilities:
 *   - schema + indexes for the mirrored read tables,
 *   - idempotent, batched inserts (so re-seeding the same rows is a no-op),
 *   - a `seedMeta` high-water table that makes seeding resumable and lets the UI
 *     distinguish "fully mirrored" from "partially mirrored" (never show partial
 *     data as if it were complete),
 *   - the target read queries (record page / counts / search, per-address
 *     aggregates, owned-UTXO exact anti-join, participant lookups),
 *   - synthetic data generation for at-scale benchmarking.
 *
 * Source-of-truth remains Dexie/IndexedDB. This engine is a derived read replica.
 */
import type { Database } from '@sqlite.org/sqlite-wasm';

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

function selectRows<T>(db: Database, sql: string, bind: unknown[] = []): T[] {
  const rows: T[] = [];
  db.exec({
    sql,
    bind: bind as never,
    rowMode: 'object',
    resultRows: rows as unknown[],
  } as never);
  return rows;
}

function selectScalar(db: Database, sql: string, bind: unknown[] = []): number {
  const rows: Array<{ v: number }> = [];
  db.exec({
    sql,
    bind: bind as never,
    rowMode: 'object',
    resultRows: rows as unknown[],
  } as never);
  return rows[0]?.v ?? 0;
}

function runInTx(db: Database, fn: () => void): void {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore rollback failure */
    }
    throw err;
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export function createSchema(db: Database): void {
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
    CREATE INDEX IF NOT EXISTS idx_records_type_id          ON records(type, id);
    CREATE INDEX IF NOT EXISTS idx_records_importance_id    ON records(addressImportance, id);
    CREATE INDEX IF NOT EXISTS idx_records_inputlower       ON records(inputStringLower);
    CREATE INDEX IF NOT EXISTS idx_records_owner            ON records(owner);
    CREATE INDEX IF NOT EXISTS idx_records_walletName       ON records(walletName);
    CREATE INDEX IF NOT EXISTS idx_records_addr_owned       ON records(inputString, type, addressImportance);

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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bt_txid     ON blockchainTransactions(txid);
    CREATE INDEX IF NOT EXISTS idx_bt_blockTime       ON blockchainTransactions(blockTime);

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

    CREATE TABLE IF NOT EXISTS seedMeta (
      tableName    TEXT PRIMARY KEY,
      highWaterId  INTEGER NOT NULL DEFAULT 0,
      copied       INTEGER NOT NULL DEFAULT 0,
      sourceCount  INTEGER NOT NULL DEFAULT 0,
      complete     INTEGER NOT NULL DEFAULT 0,
      updatedAt    INTEGER NOT NULL DEFAULT 0
    );
  `);
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

export function getSeedMeta(db: Database, table: MirrorTable): SeedMeta {
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

export function getAllSeedMeta(db: Database): SeedMeta[] {
  return MIRROR_TABLES.map((t) => getSeedMeta(db, t));
}

/**
 * Persist seed progress for a table. `complete` is only ever set true when the
 * caller has copied at least as many rows as the source contains AND has reached
 * the end of the source keyset — see markSeedCompleteIfDone.
 */
export function upsertSeedProgress(
  db: Database,
  table: MirrorTable,
  fields: { highWaterId: number; copied: number; sourceCount: number; complete?: boolean },
): void {
  db.exec({
    sql: `
      INSERT INTO seedMeta (tableName, highWaterId, copied, sourceCount, complete, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(tableName) DO UPDATE SET
        highWaterId = excluded.highWaterId,
        copied      = excluded.copied,
        sourceCount = excluded.sourceCount,
        complete    = excluded.complete,
        updatedAt   = excluded.updatedAt
    `,
    bind: [
      table,
      fields.highWaterId,
      fields.copied,
      fields.sourceCount,
      fields.complete ? 1 : 0,
      Date.now(),
    ] as never,
  } as never);
}

/**
 * Mark a table complete only if the mirrored row count matches the source count.
 * Returns true when complete. This is the single gate that prevents partial data
 * from ever being presented as the full dataset.
 */
export function markSeedCompleteIfDone(
  db: Database,
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

export function isTableReady(db: Database, table: MirrorTable): boolean {
  const meta = getSeedMeta(db, table);
  if (meta.complete !== 1) return false;
  // Defensive: complete flag must be backed by an actual row count that is not
  // short of the recorded source count.
  return meta.copied >= meta.sourceCount;
}

export function isEngineReady(db: Database): boolean {
  return MIRROR_TABLES.every((t) => isTableReady(db, t));
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

export function countTable(db: Database, table: MirrorTable): number {
  return selectScalar(db, `SELECT COUNT(*) AS v FROM ${table}`);
}

export function maxId(db: Database, table: MirrorTable): number {
  return selectScalar(db, `SELECT COALESCE(MAX(id), 0) AS v FROM ${table}`);
}

// ---------------------------------------------------------------------------
// Idempotent batched inserts
// ---------------------------------------------------------------------------

export function insertRecords(db: Database, rows: RecordRow[]): void {
  if (rows.length === 0) return;
  runInTx(db, () => {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO records
        (id, type, inputString, inputStringLower, label, notes, owner, walletName,
         seedName, walletSoftware, addressImportance, chainType, syncDepth,
         firstSeenBlockTime, cachedBalanceSats, cachedTxCount, cachedUtxoCount,
         statsComputedAt, createdAt, updatedAt, tags, categories)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    try {
      for (const r of rows) {
        stmt.bind([
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
        ]);
        stmt.step();
        stmt.reset();
      }
    } finally {
      stmt.finalize();
    }
  });
}

export function insertTransactions(db: Database, rows: TransactionRow[]): void {
  if (rows.length === 0) return;
  runInTx(db, () => {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO blockchainTransactions
        (id, txid, blockHeight, blockTime, fee, feeRate, vsize, hasOpReturn)
      VALUES (?,?,?,?,?,?,?,?)
    `);
    try {
      for (const r of rows) {
        stmt.bind([
          r.id,
          r.txid,
          r.blockHeight ?? null,
          r.blockTime ?? null,
          r.fee ?? null,
          r.feeRate ?? null,
          r.vsize ?? null,
          r.hasOpReturn ?? null,
        ]);
        stmt.step();
        stmt.reset();
      }
    } finally {
      stmt.finalize();
    }
  });
}

export function insertParticipants(db: Database, rows: ParticipantRow[]): void {
  if (rows.length === 0) return;
  runInTx(db, () => {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO transactionParticipants
        (id, txid, role, address, amount, vout, prevTxid, prevVout, recordId, scriptType)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `);
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
  });
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

export function countRecords(db: Database, opts: RecordQueryOptions = {}): number {
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
export function getRecordPage(db: Database, opts: RecordPageOptions): RecordRow[] {
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
export function getAddressAggregates(db: Database, addresses: string[]): Map<string, AddressAggregate> {
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

export function countOwnedUtxos(db: Database, tiers: string[] = OWNED_TIERS): number {
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
  db: Database,
  opts: { tiers?: string[]; afterId?: number; limit: number },
): OwnedUtxo[] {
  const { sql: tierSql, bind } = ownedTierPlaceholders(opts.tiers ?? OWNED_TIERS);
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

export function getParticipantsByTxids(db: Database, txids: string[]): ParticipantRow[] {
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

export function getParticipantsByAddresses(db: Database, addresses: string[]): ParticipantRow[] {
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

export function getDbFileStats(db: Database): DbFileStats {
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

function selectScalarPragma(db: Database, pragma: string): number {
  const rows: Array<unknown[]> = [];
  db.exec({ sql: pragma, rowMode: 'array', resultRows: rows } as never);
  const v = rows[0]?.[0];
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
export function generateSyntheticData(
  db: Database,
  spec: SyntheticSpec,
): { records: number; transactions: number; participants: number } {
  const participantsPerTx = spec.participantsPerTx ?? 4;
  const spentFraction = spec.spentFraction ?? 0.5;
  const batchSize = spec.batchSize ?? 20000;
  const addressCount = Math.max(1, spec.addresses);

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
        }
      }
      if (rows.length > 0) insertParticipants(db, rows);
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

export function applyTuningPragmas(db: Database): void {
  // Larger page cache (negative = KiB). ~64 MiB of cache materially speeds up
  // the index-heavy anti-join on tens of millions of rows.
  db.exec('PRAGMA cache_size = -65536;');
  db.exec('PRAGMA temp_store = MEMORY;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = OFF;');
}

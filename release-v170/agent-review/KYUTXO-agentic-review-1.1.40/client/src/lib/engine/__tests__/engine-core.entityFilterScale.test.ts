// Scale + query-plan guards for the entity-filtered transaction queries.
//
// The Transactions page's entity filters (address/wallet/seed/owner/tag/
// category + curatedOnly) promise near-instant results on 1M+ transaction
// vaults. That only holds if the SQL derives the matching txid set from the
// SELECTIVE participant/record indexes and joins BACK to blockchainTransactions
// through its unique txid index — never the reverse shape (a per-transaction
// correlated EXISTS), which walks the entire transaction table probing
// participants for every row.
//
// Two layers of protection:
//   1. EXPLAIN QUERY PLAN guards — assert the count and page statements never
//      contain a full `SCAN blockchainTransactions` step when an entity filter
//      is active. This catches the asymptotic regression deterministically,
//      independent of machine load.
//   2. A 1M-transaction latency benchmark — seeds 1M txs / 2M participants /
//      100k address records (representative of the large-vault requirement)
//      and asserts selective filters answer count + first page well under a
//      generous wall-clock bound. Bounds are deliberately loose (CI machines
//      are shared); the plan guards are the precise regression tripwire.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createInMemoryEngineDb, type BetterSqlite3EngineDb } from "../better-sqlite3-adapter";
import {
  createSchema,
  generateSyntheticData,
  insertRecords,
  insertParticipants,
  countTransactions,
  getTransactionPage,
  type EngineDb,
  type RecordRow,
  type ParticipantRow,
  type TransactionQueryOptions,
} from "../engine-core";

// ---------------------------------------------------------------------------
// SQL capture: wrap the EngineDb so we can EXPLAIN the exact statements the
// production query functions emit, without duplicating their SQL in the test.
// ---------------------------------------------------------------------------

interface CapturedStatement {
  sql: string;
  bind: unknown[];
}

function withCapture(db: BetterSqlite3EngineDb): { proxy: EngineDb; captured: CapturedStatement[] } {
  const captured: CapturedStatement[] = [];
  const proxy: EngineDb = {
    exec: (sql) => db.exec(sql),
    run: (sql, bind) => db.run(sql, bind),
    selectRows: <T>(sql: string, bind: unknown[] = []) => {
      captured.push({ sql, bind });
      return db.selectRows<T>(sql, bind);
    },
    selectScalar: (sql, bind = []) => {
      captured.push({ sql, bind });
      return db.selectScalar(sql, bind);
    },
  };
  return { proxy, captured };
}

function explainAll(db: BetterSqlite3EngineDb, stmt: CapturedStatement): string[] {
  const rows = db.raw
    .prepare(`EXPLAIN QUERY PLAN ${stmt.sql}`)
    .all(...(stmt.bind as never[])) as Array<{ detail: string }>;
  return rows.map((r) => r.detail);
}

/** Fails when any plan step walks the whole transaction table. */
function expectNoFullTransactionScan(details: string[], label: string): void {
  const offender = details.find((d) => /SCAN\s+(blockchainTransactions|bt)\b/i.test(d));
  expect(offender, `${label} plan walks all of blockchainTransactions:\n${details.join("\n")}`).toBeUndefined();
}

const SCALE = {
  addresses: 100_000,
  transactions: 1_000_000,
  participantsPerTx: 2, // 1 output + 1 input → 2M participant rows
  spentFraction: 0.5,
  batchSize: 100_000,
};

// A bespoke, highly selective record: unique wallet/seed/owner/tag/category,
// linked to a known handful of transactions spread across the whole range.
const BENCH_RECORD_ID = SCALE.addresses + 1;
const BENCH_TX_LINKS = 40;

let db: BetterSqlite3EngineDb;

function timed<T>(fn: () => T): { result: T; ms: number } {
  const t0 = performance.now();
  const result = fn();
  return { result, ms: performance.now() - t0 };
}

describe("entity-filtered transactions at 1M+ scale", () => {
  beforeAll(() => {
    db = createInMemoryEngineDb();
    createSchema(db);
    generateSyntheticData(db, SCALE);

    const benchRecord: RecordRow = {
      id: BENCH_RECORD_ID,
      type: "address",
      inputString: "bc1qbenchselective",
      inputStringLower: "bc1qbenchselective",
      label: "Bench selective",
      notes: null,
      owner: "BenchOwnerZ",
      walletName: "BenchWalletZ",
      seedName: "BenchSeedZ",
      walletSoftware: null,
      addressImportance: "verified",
      chainType: null,
      syncDepth: 0,
      firstSeenBlockTime: null,
      cachedBalanceSats: null,
      cachedTxCount: null,
      cachedUtxoCount: null,
      statsComputedAt: null,
      createdAt: 1,
      updatedAt: 1,
      tags: '["bench-tag-z"]',
      categories: '["bench-cat-z"]',
    };
    insertRecords(db, [benchRecord]);

    const parts: ParticipantRow[] = [];
    for (let i = 0; i < BENCH_TX_LINKS; i++) {
      const txNum = 1 + i * Math.floor(SCALE.transactions / BENCH_TX_LINKS);
      parts.push({
        id: 50_000_000 + i,
        txid: `tx${txNum}`,
        role: "output",
        address: "bc1qbenchselective",
        amount: 12345,
        vout: 9,
        prevTxid: null,
        prevVout: null,
        recordId: BENCH_RECORD_ID,
        scriptType: "v0_p2wpkh",
      });
    }
    insertParticipants(db, parts);
    db.raw.exec("ANALYZE");
  }, 300_000);

  afterAll(() => {
    db?.close();
  });

  // ── query-plan guards (deterministic asymptotic tripwire) ─────────────────

  const PLAN_CASES: Array<{ label: string; opts: TransactionQueryOptions }> = [
    { label: "address filter", opts: { address: "bc1qbenchselective" } },
    { label: "wallet filter", opts: { wallet: "BenchWalletZ" } },
    { label: "tag filter", opts: { tag: "bench-tag-z" } },
    { label: "composed wallet+owner+opReturn", opts: { wallet: "BenchWalletZ", owner: "BenchOwnerZ", opReturnOnly: true } },
    { label: "curatedOnly", opts: { curatedOnly: true } },
  ];

  for (const { label, opts } of PLAN_CASES) {
    it(`never scans the full transaction table: ${label}`, () => {
      const { proxy, captured } = withCapture(db);
      countTransactions(proxy, opts);
      getTransactionPage(proxy, { ...opts, limit: 50 });
      expect(captured.length).toBeGreaterThanOrEqual(2);
      for (const stmt of captured) {
        // Only guard statements that touch the tx table (the page's follow-up
        // participant-aggregate query never references it).
        if (!stmt.sql.includes("blockchainTransactions")) continue;
        expectNoFullTransactionScan(explainAll(db, stmt), `${label}: ${stmt.sql.slice(0, 80)}`);
      }
    });
  }

  // ── latency benchmarks (generous bounds; plan guards are the precise gate) ─

  it("selective address filter answers count + first page fast", () => {
    const count = timed(() => countTransactions(db, { address: "bc1qbenchselective" }));
    expect(count.result).toBe(BENCH_TX_LINKS);
    const page = timed(() => getTransactionPage(db, { address: "bc1qbenchselective", limit: 50 }));
    expect(page.result.length).toBe(BENCH_TX_LINKS);
    expect(count.ms + page.ms, `count=${count.ms.toFixed(1)}ms page=${page.ms.toFixed(1)}ms`).toBeLessThan(1_000);
  });

  it("selective linked-entity (wallet/seed/owner/tag/category) filters answer fast", () => {
    let total = 0;
    for (const opts of [
      { wallet: "BenchWalletZ" },
      { seed: "BenchSeedZ" },
      { owner: "BenchOwnerZ" },
      { tag: "bench-tag-z" },
      { category: "bench-cat-z" },
    ] satisfies TransactionQueryOptions[]) {
      const count = timed(() => countTransactions(db, opts));
      expect(count.result, JSON.stringify(opts)).toBe(BENCH_TX_LINKS);
      const page = timed(() => getTransactionPage(db, { ...opts, limit: 50 }));
      expect(page.result.length, JSON.stringify(opts)).toBe(BENCH_TX_LINKS);
      total += count.ms + page.ms;
    }
    // 5 dimensions × (count + first page) over 1M txs / 2M participants.
    expect(total, `total=${total.toFixed(1)}ms`).toBeLessThan(5_000);
  });

  it("broad wallet filter (~5% of vault) still pages in bounded time", () => {
    // Wallet7 owns 1/20 of the 100k synthetic addresses → ~large match set.
    const count = timed(() => countTransactions(db, { wallet: "Wallet7" }));
    expect(count.result).toBeGreaterThan(10_000);
    const page = timed(() => getTransactionPage(db, { wallet: "Wallet7", limit: 50 }));
    expect(page.result.length).toBe(50);
    expect(count.ms + page.ms, `count=${count.ms.toFixed(1)}ms page=${page.ms.toFixed(1)}ms`).toBeLessThan(10_000);
  });

  it("curatedOnly default view counts + pages in bounded time at 1M txs", () => {
    const count = timed(() => countTransactions(db, { curatedOnly: true }));
    expect(count.result).toBeGreaterThan(900_000);
    const page = timed(() => getTransactionPage(db, { curatedOnly: true, limit: 50 }));
    expect(page.result.length).toBe(50);
    expect(count.ms + page.ms, `count=${count.ms.toFixed(1)}ms page=${page.ms.toFixed(1)}ms`).toBeLessThan(30_000);
  });
});

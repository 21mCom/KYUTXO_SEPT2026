// @vitest-environment jsdom
//
// Regression pin for the browser-fallback OP_RETURN readers in
// transaction-crud.ts:
//
//   - countTransactionsWithOpReturn()
//   - getOpReturnTransactionPrimaryKeys()
//
// Background: hasOpReturn is stored as a boolean, and booleans are NOT valid
// IndexedDB keys — `where('hasOpReturn').equals(true)` throws DataError at
// query time. A browser check caught the Dexie fallback doing exactly that:
// the DataError was swallowed and the UI silently kept a stale OP_RETURN
// total. Both readers were fixed to use boolean-safe `.filter()` scans.
//
// These tests seed rows with boolean `hasOpReturn` into a table whose schema
// (like the real one) declares `hasOpReturn` as an index, so a future
// "optimization" back to an indexed boolean lookup fails here immediately —
// the tempting indexed path is present and would throw.
//
// Uses the real Dexie engine via fake-indexeddb, mirroring the data-layer
// pattern in transaction-crud.missing-source-txids.test.ts.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type { BlockchainTransaction } from "@/lib/db-types";

class TestDb extends Dexie {
  blockchainTransactions!: Table<BlockchainTransaction>;
  constructor(name: string) {
    super(name);
    // Mirrors the real schema, including the (unusable-for-booleans)
    // hasOpReturn index that made the indexed lookup tempting.
    this.version(1).stores({
      blockchainTransactions:
        "++id, &txid, blockHeight, blockTime, syncedAt, hasOpReturn, rawFingerprintCaptured",
    });
  }
}

let testDb: TestDb;

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return {
    ...actual,
    get db() {
      return testDb;
    },
    notifyDbChange: vi.fn(),
  };
});

const { countTransactionsWithOpReturn, getOpReturnTransactionPrimaryKeys } =
  await import("./transaction-crud");

// ---- Fixtures ---------------------------------------------------------------

function mkTx(
  txid: string,
  overrides: Partial<BlockchainTransaction> = {},
): BlockchainTransaction {
  return {
    txid,
    blockHeight: 800000,
    blockTime: 1700000000,
    fee: 1000,
    feeRate: 5,
    syncedAt: 1700000001,
    ...overrides,
  };
}

beforeEach(() => {
  testDb = new TestDb(`KYUTXO-opreturn-scan-${Date.now()}-${Math.random()}`);
});

afterEach(async () => {
  await testDb.delete();
});

describe("countTransactionsWithOpReturn", () => {
  it("returns 0 without throwing on an empty table", async () => {
    await expect(countTransactionsWithOpReturn()).resolves.toBe(0);
  });

  it("counts only rows with boolean hasOpReturn === true", async () => {
    await testDb.blockchainTransactions.bulkAdd([
      mkTx("tx-op-1", { hasOpReturn: true }),
      mkTx("tx-op-2", { hasOpReturn: true }),
      mkTx("tx-plain-false", { hasOpReturn: false }),
      mkTx("tx-plain-undefined"), // field absent, like older synced rows
    ]);

    await expect(countTransactionsWithOpReturn()).resolves.toBe(2);
  });

  it("does not throw DataError even though hasOpReturn is indexed", async () => {
    await testDb.blockchainTransactions.bulkAdd([
      mkTx("tx-op-only", { hasOpReturn: true }),
    ]);

    // Sanity: the indexed boolean lookup DOES throw in IndexedDB — this is
    // the exact failure mode the fixed readers must avoid.
    await expect(
      testDb.blockchainTransactions.where("hasOpReturn").equals(true as any)
        .count(),
    ).rejects.toThrow();

    await expect(countTransactionsWithOpReturn()).resolves.toBe(1);
  });
});

describe("getOpReturnTransactionPrimaryKeys", () => {
  it("returns an empty array without throwing on an empty table", async () => {
    await expect(getOpReturnTransactionPrimaryKeys()).resolves.toEqual([]);
  });

  it("returns exactly the primary keys of OP_RETURN rows", async () => {
    const opKeys = (await testDb.blockchainTransactions.bulkAdd(
      [
        mkTx("tx-op-a", { hasOpReturn: true }),
        mkTx("tx-op-b", { hasOpReturn: true }),
      ],
      { allKeys: true },
    )) as unknown as number[];
    await testDb.blockchainTransactions.bulkAdd([
      mkTx("tx-no-op-a", { hasOpReturn: false }),
      mkTx("tx-no-op-b"),
    ]);

    const result = await getOpReturnTransactionPrimaryKeys();

    expect(new Set(result as unknown as number[])).toEqual(new Set(opKeys));
    expect(result).toHaveLength(2);
  });

  it("keys round-trip back to the seeded OP_RETURN rows", async () => {
    await testDb.blockchainTransactions.bulkAdd([
      mkTx("tx-op-x", { hasOpReturn: true }),
      mkTx("tx-mixed", { hasOpReturn: false }),
    ]);

    const keys = await getOpReturnTransactionPrimaryKeys();
    const rows = await testDb.blockchainTransactions.bulkGet(
      keys as unknown as number[],
    );

    expect(rows.map((r) => r?.txid)).toEqual(["tx-op-x"]);
  });
});

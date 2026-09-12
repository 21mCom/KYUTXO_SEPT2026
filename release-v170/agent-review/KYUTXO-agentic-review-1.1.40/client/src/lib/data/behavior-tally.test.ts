// @vitest-environment jsdom
//
// Verifies the vault-wide behavior tally pass: it streams every address record,
// classifies each from its cached stats (reusing the same rules as the Records
// filter), and returns per-label totals plus the freshness fingerprint. Runs
// against the real Dexie engine via fake-indexeddb.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type { Record as DbRecord } from "@/lib/database";

class TestDb extends Dexie {
  records!: Table<DbRecord, number>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      records:
        "++id, type, inputString, inputStringLower, label, owner, walletName, " +
        "seedName, walletSoftware, *tags, *categories, createdAt, updatedAt, " +
        "chainType, syncDepth, addressImportance, [type+addressImportance], " +
        "[addressImportance+id], [type+id], [owner+id], [walletName+id], " +
        "flowType, discoveredFromRecordId",
    });
  }
}

const testDb = new TestDb(`KYUTXO-behavior-tally-${Date.now()}-${Math.random()}`);

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return { ...actual, db: testDb };
});

const { computeBehaviorTally } = await import("./address-stats");

const NOW = Math.floor(Date.now() / 1000);
const YEAR = 365.25 * 24 * 3600;

function addr(over: Partial<DbRecord>): DbRecord {
  return {
    type: "address",
    inputString: `addr-${Math.random()}`,
    inputStringLower: "x",
    label: "",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as DbRecord;
}

beforeAll(async () => {
  await testDb.records.bulkAdd([
    // Not synced (no statsComputedAt).
    addr({ inputString: "a1" }),
    // Synced but zero transactions → synced-no-activity.
    addr({ inputString: "a2", statsComputedAt: NOW, cachedTxCount: 0 }),
    // Dormant: last activity > 3 years ago.
    addr({
      inputString: "a3",
      statsComputedAt: NOW,
      cachedTxCount: 4,
      cachedLastActivityTime: NOW - 4 * YEAR,
    }),
    // High activity: >= 50 txs.
    addr({
      inputString: "a4",
      statsComputedAt: NOW,
      cachedTxCount: 80,
      cachedLastActivityTime: NOW - 1000,
    }),
    // Active: recent activity, no strong pattern.
    addr({
      inputString: "a5",
      statsComputedAt: NOW,
      cachedTxCount: 2,
      cachedUtxoCount: 1,
      cachedLastActivityTime: NOW - 1000,
    }),
    // A non-address record must be ignored entirely.
    addr({ type: "transaction", inputString: "tx1" }),
  ]);
});

afterAll(async () => {
  testDb.close();
});

describe("computeBehaviorTally", () => {
  it("classifies every address record from cached stats and reports the fingerprint", async () => {
    const { counts, addressCount, syncedCount, cancelled } =
      await computeBehaviorTally({ batchSize: 2 });

    expect(cancelled).toBe(false);
    // Five address rows; the transaction row is excluded.
    expect(addressCount).toBe(5);
    // a1 has no statsComputedAt; the other four do.
    expect(syncedCount).toBe(4);

    expect(counts["not-enough-data"]).toBe(1);      // a1 (not synced)
    expect(counts["synced-no-activity"]).toBe(1);   // a2 (synced, 0 txs)
    expect(counts["dormant"]).toBe(1);              // a3
    expect(counts["high-activity"]).toBe(1);        // a4
    expect(counts["active"]).toBe(1);               // a5

    const total = Object.values(counts).reduce((s, n) => s + n, 0);
    expect(total).toBe(addressCount);
  });

  it("stops early and reports cancelled when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await computeBehaviorTally({ signal: controller.signal });
    expect(result.cancelled).toBe(true);
    expect(result.addressCount).toBe(0);
  });
});

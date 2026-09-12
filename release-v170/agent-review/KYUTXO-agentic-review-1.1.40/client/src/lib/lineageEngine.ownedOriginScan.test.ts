// @vitest-environment jsdom
//
// Regression pin for scanOwnedLineageOrigins() in lineageEngine.ts.
//
// Background: createdOwned is stored as a boolean, and booleans are NOT valid
// IndexedDB keys. The original origin scan used
// `where('createdOwned').equals(1)` — a boolean value never equals the number
// 1 as an IDB key, so the query silently matched ZERO rows and
// buildAllCustodySegments never found any origins (stale/empty custody
// segments with no error surfaced). The scan was fixed to a boolean-safe
// `.filter()` paged by primary key.
//
// These tests seed rows with boolean createdOwned into a table whose schema
// (like the real one) declares createdOwned as an index, so a future
// "optimization" back to an indexed boolean lookup fails here immediately —
// the tempting indexed path is present and would throw (for `.equals(true)`)
// or silently return nothing (for `.equals(1)`).
//
// Mirrors the pattern in transaction-crud.opReturnBooleanScan.test.ts.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type { UtxoLineage } from "@/lib/db-types";

class TestDb extends Dexie {
  utxoLineage!: Table<UtxoLineage>;
  constructor(name: string) {
    super(name);
    // Mirrors the real utxoLineage schema, including the
    // (unusable-for-booleans) spentOwned/createdOwned/isChange indexes that
    // made the indexed lookup tempting.
    this.version(1).stores({
      utxoLineage:
        "++id, [spentTxid+spentVout], [createdTxid+createdVout], consumingTxid, spentAddress, createdAddress, segmentId, spentOwned, createdOwned, isChange, blockTime, isEncrypted",
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

const { scanOwnedLineageOrigins } = await import("./lineageEngine");

// ---- Fixtures ---------------------------------------------------------------

function mkLineage(
  createdTxid: string,
  createdVout: number,
  overrides: Partial<UtxoLineage> = {},
): UtxoLineage {
  return {
    spentTxid: "prev-" + createdTxid,
    spentVout: 0,
    spentAddress: "bc1q-spent",
    spentAmount: 100000,
    consumingTxid: createdTxid,
    createdTxid,
    createdVout,
    createdAddress: "bc1q-created-" + createdTxid,
    createdAmount: 90000,
    spentOwned: true,
    createdOwned: true,
    isChange: false,
    confidence: "high",
    blockTime: 1700000000,
    blockHeight: 800000,
    createdAt: 1700000001,
    ...overrides,
  } as UtxoLineage;
}

beforeEach(() => {
  testDb = new TestDb(`KYUTXO-owned-origin-scan-${Date.now()}-${Math.random()}`);
});

afterEach(async () => {
  await testDb.delete();
});

describe("scanOwnedLineageOrigins", () => {
  it("returns an empty map without throwing on an empty table", async () => {
    const origins = await scanOwnedLineageOrigins();
    expect(origins.size).toBe(0);
  });

  it("finds only owned-created origins despite createdOwned being a boolean", async () => {
    await testDb.utxoLineage.bulkAdd([
      mkLineage("tx-owned-1", 0),
      mkLineage("tx-owned-2", 1),
      mkLineage("tx-external", 0, { createdOwned: false }),
      // Older rows may lack the field entirely
      mkLineage("tx-legacy", 0, { createdOwned: undefined as any }),
    ]);

    const origins = await scanOwnedLineageOrigins();
    expect(Array.from(origins.keys()).sort()).toEqual([
      "tx-owned-1:0",
      "tx-owned-2:1",
    ]);
    expect(origins.get("tx-owned-1:0")).toEqual({
      createdAddress: "bc1q-created-tx-owned-1",
      createdTxid: "tx-owned-1",
      createdVout: 0,
    });
  });

  it("de-dupes repeated outpoints and survives the indexed-boolean trap", async () => {
    await testDb.utxoLineage.bulkAdd([
      mkLineage("tx-dup", 0),
      mkLineage("tx-dup", 0, { spentTxid: "another-input" }),
    ]);

    // Sanity: the tempting indexed lookups are exactly the failure modes the
    // fixed scan must avoid — `.equals(true)` throws DataError, and the old
    // `.equals(1)` silently matches nothing.
    await expect(
      testDb.utxoLineage.where("createdOwned").equals(true as any).count(),
    ).rejects.toThrow();
    await expect(
      testDb.utxoLineage.where("createdOwned").equals(1).count(),
    ).resolves.toBe(0);

    const origins = await scanOwnedLineageOrigins();
    expect(origins.size).toBe(1);
    expect(origins.has("tx-dup:0")).toBe(true);
  });

  it("pages past a full batch of non-matching rows without stopping early", async () => {
    // > one keyset batch (1000) of non-owned rows before the owned one; a
    // buggy pager that treats an empty filtered batch as end-of-table would
    // miss the trailing owned origin.
    const rows: UtxoLineage[] = [];
    for (let i = 0; i < 1005; i++) {
      rows.push(mkLineage(`tx-ext-${i}`, 0, { createdOwned: false }));
    }
    rows.push(mkLineage("tx-owned-tail", 2));
    await testDb.utxoLineage.bulkAdd(rows);

    const origins = await scanOwnedLineageOrigins();
    expect(origins.size).toBe(1);
    expect(origins.has("tx-owned-tail:2")).toBe(true);
  });

  it("stops immediately when the abort signal is already set", async () => {
    await testDb.utxoLineage.bulkAdd([mkLineage("tx-owned", 0)]);
    const controller = new AbortController();
    controller.abort();
    const origins = await scanOwnedLineageOrigins(controller.signal);
    expect(origins.size).toBe(0);
  });
});

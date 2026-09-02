// @vitest-environment jsdom
//
// Regression tests for the sync-protection-crud data layer, covering
// skipped-address recording, active-list reads, single-row dismiss, and
// dismiss-all.  This is the exact layer where a boolean/number mismatch on
// the `dismissed` field caused getActiveSkippedAddresses() to always return
// an empty array.
//
// Each test group also verifies that rows written with the legacy boolean
// `false` value (before the 0|1 numeric fix) still surface in the active
// list, so existing user databases aren't left with a permanently empty list.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type { SkippedAddress } from "@/lib/db-types";

class TestDb extends Dexie {
  skippedAddresses!: Table<SkippedAddress, number>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      skippedAddresses: "++id, address, reason, syncRunTimestamp, dismissed, createdAt",
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

const {
  addSkippedAddress,
  updateSkippedAddress,
  getActiveSkippedAddresses,
  getSkippedAddressesByRun,
  dismissAllSkippedAddresses,
} = await import("./sync-protection-crud");

function mkSkipped(
  overrides: Partial<Omit<SkippedAddress, "id">> = {},
): Omit<SkippedAddress, "id" | "createdAt"> {
  return {
    address: "bc1qtest",
    reason: "tx-count-exceeded",
    syncRunTimestamp: 1000,
    dismissed: 0,
    ...overrides,
  };
}

beforeEach(async () => {
  testDb = new TestDb(`KYUTXO-sync-protection-${Date.now()}-${Math.random()}`);
  await testDb.open();
});

afterEach(async () => {
  testDb.close();
  await Dexie.delete(testDb.name);
});

describe("addSkippedAddress", () => {
  it("returns a numeric id and the row is retrievable", async () => {
    const id = await addSkippedAddress(mkSkipped());
    expect(typeof id).toBe("number");
    const row = await testDb.skippedAddresses.get(id);
    expect(row).toBeTruthy();
    expect(row?.address).toBe("bc1qtest");
  });

  it("sets createdAt automatically when not provided", async () => {
    const before = Date.now();
    const id = await addSkippedAddress(mkSkipped());
    const after = Date.now();
    const row = await testDb.skippedAddresses.get(id);
    expect(row?.createdAt).toBeGreaterThanOrEqual(before);
    expect(row?.createdAt).toBeLessThanOrEqual(after);
  });
});

describe("getActiveSkippedAddresses", () => {
  it("returns rows with dismissed=0", async () => {
    await addSkippedAddress(mkSkipped({ address: "bc1qactive", dismissed: 0 }));
    const active = await getActiveSkippedAddresses();
    expect(active).toHaveLength(1);
    expect(active[0].address).toBe("bc1qactive");
  });

  it("excludes rows with dismissed=1", async () => {
    await addSkippedAddress(mkSkipped({ address: "bc1qdone", dismissed: 1 }));
    const active = await getActiveSkippedAddresses();
    expect(active).toHaveLength(0);
  });

  it("returns only undismissed rows when the table has a mix", async () => {
    await addSkippedAddress(mkSkipped({ address: "bc1qa", dismissed: 0 }));
    await addSkippedAddress(mkSkipped({ address: "bc1qb", dismissed: 1 }));
    await addSkippedAddress(mkSkipped({ address: "bc1qc", dismissed: 0 }));
    const active = await getActiveSkippedAddresses();
    expect(active).toHaveLength(2);
    const addrs = active.map((r) => r.address).sort();
    expect(addrs).toEqual(["bc1qa", "bc1qc"]);
  });

  it("handles rows saved with legacy boolean false (pre-fix data)", async () => {
    // Simulate rows written by old code that stored `dismissed: false` (boolean).
    await testDb.skippedAddresses.add({
      address: "bc1qlegacy",
      reason: "timeout",
      syncRunTimestamp: 999,
      dismissed: false as unknown as 0,
      createdAt: Date.now(),
    });
    const active = await getActiveSkippedAddresses();
    expect(active).toHaveLength(1);
    expect(active[0].address).toBe("bc1qlegacy");
  });

  it("returns empty array when all rows are dismissed", async () => {
    await addSkippedAddress(mkSkipped({ dismissed: 1 }));
    await addSkippedAddress(mkSkipped({ dismissed: 1 }));
    expect(await getActiveSkippedAddresses()).toHaveLength(0);
  });

  it("returns empty array when the table is empty", async () => {
    expect(await getActiveSkippedAddresses()).toHaveLength(0);
  });
});

describe("updateSkippedAddress (single-row dismiss)", () => {
  it("dismissed=1 removes the row from the active list", async () => {
    const id = await addSkippedAddress(mkSkipped({ address: "bc1qtarget" }));
    expect(await getActiveSkippedAddresses()).toHaveLength(1);

    await updateSkippedAddress(id, { dismissed: 1 });
    expect(await getActiveSkippedAddresses()).toHaveLength(0);
  });

  it("only removes the targeted row, leaving others active", async () => {
    const id = await addSkippedAddress(mkSkipped({ address: "bc1qtarget" }));
    await addSkippedAddress(mkSkipped({ address: "bc1qother" }));

    await updateSkippedAddress(id, { dismissed: 1 });

    const active = await getActiveSkippedAddresses();
    expect(active).toHaveLength(1);
    expect(active[0].address).toBe("bc1qother");
  });
});

describe("dismissAllSkippedAddresses", () => {
  it("empties the active list", async () => {
    await addSkippedAddress(mkSkipped({ address: "bc1qa" }));
    await addSkippedAddress(mkSkipped({ address: "bc1qb" }));
    await addSkippedAddress(mkSkipped({ address: "bc1qc" }));
    expect(await getActiveSkippedAddresses()).toHaveLength(3);

    await dismissAllSkippedAddresses();
    expect(await getActiveSkippedAddresses()).toHaveLength(0);
  });

  it("rows are still present in the DB (not deleted)", async () => {
    await addSkippedAddress(mkSkipped());
    await addSkippedAddress(mkSkipped());
    await dismissAllSkippedAddresses();

    const total = await testDb.skippedAddresses.count();
    expect(total).toBe(2);
  });

  it("also dismisses legacy-boolean-false rows", async () => {
    await testDb.skippedAddresses.add({
      address: "bc1qlegacy",
      reason: "error",
      syncRunTimestamp: 500,
      dismissed: false as unknown as 0,
      createdAt: Date.now(),
    });
    await dismissAllSkippedAddresses();
    expect(await getActiveSkippedAddresses()).toHaveLength(0);
  });

  it("is a no-op when the table is already empty", async () => {
    await expect(dismissAllSkippedAddresses()).resolves.toBeUndefined();
    expect(await getActiveSkippedAddresses()).toHaveLength(0);
  });
});

describe("getSkippedAddressesByRun", () => {
  it("returns only rows matching the syncRunTimestamp", async () => {
    await addSkippedAddress(mkSkipped({ address: "bc1qrun1a", syncRunTimestamp: 100 }));
    await addSkippedAddress(mkSkipped({ address: "bc1qrun1b", syncRunTimestamp: 100 }));
    await addSkippedAddress(mkSkipped({ address: "bc1qrun2", syncRunTimestamp: 200 }));

    const run1 = await getSkippedAddressesByRun(100);
    expect(run1).toHaveLength(2);
    const addrs = run1.map((r) => r.address).sort();
    expect(addrs).toEqual(["bc1qrun1a", "bc1qrun1b"]);
  });

  it("returns dismissed rows too (all rows for the run)", async () => {
    await addSkippedAddress(mkSkipped({ syncRunTimestamp: 100, dismissed: 0 }));
    await addSkippedAddress(mkSkipped({ syncRunTimestamp: 100, dismissed: 1 }));

    const rows = await getSkippedAddressesByRun(100);
    expect(rows).toHaveLength(2);
  });

  it("returns empty array for an unknown timestamp", async () => {
    expect(await getSkippedAddressesByRun(99999)).toHaveLength(0);
  });
});

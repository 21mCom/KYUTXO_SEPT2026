// @vitest-environment jsdom
//
// Unit tests for the privacy-history-crud module, which appends Privacy Audit
// snapshots and trims the table to the most recent PRIVACY_HISTORY_LIMIT (30)
// runs by timestamp. These lock in the ordering and retention behavior:
//   - adding an entry returns its numeric id
//   - getPrivacyAuditHistory returns rows oldest -> newest
//   - a limit returns the most-recent N, still oldest -> newest
//   - adding beyond the retention limit deletes the oldest entries first
//   - clear empties the table
//
// Uses the real Dexie engine (via fake-indexeddb), mirroring the data-layer
// test pattern in record-crud.keyset.test.ts.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type { PrivacyAuditHistoryEntry, Settings } from "@/lib/db-types";

class TestDb extends Dexie {
  privacyAuditHistory!: Table<PrivacyAuditHistoryEntry, number>;
  settings!: Table<Settings, string>;
  constructor(name: string) {
    super(name);
    // Mirrors the privacyAuditHistory + settings schemas in database.ts.
    this.version(1).stores({
      privacyAuditHistory: "++id, timestamp",
      settings: "id",
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
    // Re-read the live binding each time so beforeEach can swap the instance.
    get db() {
      return testDb;
    },
    notifyDbChange: vi.fn(),
  };
});

const {
  addPrivacyAuditHistoryEntry,
  getPrivacyAuditHistory,
  getPrivacyAuditHistoryCount,
  clearPrivacyAuditHistory,
  trimPrivacyAuditHistory,
  setPrivacyAuditHistoryAdversary,
  DEFAULT_PRIVACY_HISTORY_LIMIT,
} = await import("./privacy-history-crud");

// The retention limit resolves from settings.privacyHistoryLimit, falling back
// to DEFAULT_PRIVACY_HISTORY_LIMIT when unset. Helper to override it per test.
async function setRetentionLimit(limit: number | undefined): Promise<void> {
  await testDb.settings.put({ id: "default", privacyHistoryLimit: limit } as Settings);
}

// ---- Fixture ---------------------------------------------------------------

function mkEntry(
  timestamp: number,
  overrides: Partial<PrivacyAuditHistoryEntry> = {},
): Omit<PrivacyAuditHistoryEntry, "id"> {
  return {
    timestamp,
    score: 80,
    grade: "B",
    totalFindings: 0,
    transactionsAnalyzed: 0,
    addressesScanned: 0,
    severityCounts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
    findingTypeCounts: {},
    ...overrides,
  };
}

beforeEach(async () => {
  testDb = new TestDb(`KYUTXO-privacy-history-${Date.now()}-${Math.random()}`);
  await testDb.open();
  // Seed a default settings row so getPrivacyHistoryLimit falls back to the
  // default (no privacyHistoryLimit set). Individual tests override as needed.
  await setRetentionLimit(undefined);
});

afterEach(async () => {
  testDb.close();
  await Dexie.delete(testDb.name);
});

describe("addPrivacyAuditHistoryEntry", () => {
  it("returns a numeric id for the inserted entry", async () => {
    const id = await addPrivacyAuditHistoryEntry(mkEntry(1000));
    expect(typeof id).toBe("number");
    const row = await testDb.privacyAuditHistory.get(id);
    expect(row).toBeTruthy();
    expect(row?.timestamp).toBe(1000);
  });
});

describe("getPrivacyAuditHistory ordering", () => {
  it("returns entries oldest -> newest by timestamp", async () => {
    // Insert out of timestamp order to prove it sorts by timestamp, not id.
    await addPrivacyAuditHistoryEntry(mkEntry(3000));
    await addPrivacyAuditHistoryEntry(mkEntry(1000));
    await addPrivacyAuditHistoryEntry(mkEntry(2000));

    const all = await getPrivacyAuditHistory();
    expect(all.map((e) => e.timestamp)).toEqual([1000, 2000, 3000]);
  });

  it("limit returns the most-recent N, still oldest -> newest", async () => {
    for (let i = 1; i <= 5; i++) {
      await addPrivacyAuditHistoryEntry(mkEntry(i * 1000));
    }

    const recent = await getPrivacyAuditHistory(3);
    expect(recent.map((e) => e.timestamp)).toEqual([3000, 4000, 5000]);
  });

  it("limit larger than the table returns everything in order", async () => {
    await addPrivacyAuditHistoryEntry(mkEntry(1000));
    await addPrivacyAuditHistoryEntry(mkEntry(2000));

    const recent = await getPrivacyAuditHistory(10);
    expect(recent.map((e) => e.timestamp)).toEqual([1000, 2000]);
  });
});

describe("retention trimming", () => {
  it("keeps the table at the limit, deleting the oldest entries first", async () => {
    const overBy = 5;
    const total = DEFAULT_PRIVACY_HISTORY_LIMIT + overBy;
    for (let i = 1; i <= total; i++) {
      await addPrivacyAuditHistoryEntry(mkEntry(i * 1000));
    }

    const count = await testDb.privacyAuditHistory.count();
    expect(count).toBe(DEFAULT_PRIVACY_HISTORY_LIMIT);

    const all = await getPrivacyAuditHistory();
    // Oldest `overBy` timestamps (1000..5000) should have been trimmed away.
    expect(all[0].timestamp).toBe((overBy + 1) * 1000);
    expect(all[all.length - 1].timestamp).toBe(total * 1000);
    expect(all).toHaveLength(DEFAULT_PRIVACY_HISTORY_LIMIT);
  });

  it("does not trim while at or below the limit", async () => {
    for (let i = 1; i <= DEFAULT_PRIVACY_HISTORY_LIMIT; i++) {
      await addPrivacyAuditHistoryEntry(mkEntry(i * 1000));
    }
    expect(await testDb.privacyAuditHistory.count()).toBe(
      DEFAULT_PRIVACY_HISTORY_LIMIT,
    );

    const all = await getPrivacyAuditHistory();
    expect(all[0].timestamp).toBe(1000);
  });

  it("honors a custom settings.privacyHistoryLimit when adding entries", async () => {
    const customLimit = 5;
    await setRetentionLimit(customLimit);

    // Add well beyond the custom limit; each add should trim to it.
    const total = customLimit + 6;
    for (let i = 1; i <= total; i++) {
      await addPrivacyAuditHistoryEntry(mkEntry(i * 1000));
    }

    expect(await testDb.privacyAuditHistory.count()).toBe(customLimit);

    const all = await getPrivacyAuditHistory();
    // Only the most-recent `customLimit` runs survive; oldest removed first.
    expect(all.map((e) => e.timestamp)).toEqual([
      7000, 8000, 9000, 10000, 11000,
    ]);
  });
});

describe("retention limit fallback", () => {
  // An invalid (non-positive, non-finite, or non-numeric) stored limit must
  // fall back to DEFAULT_PRIVACY_HISTORY_LIMIT rather than disabling trimming
  // or trimming to a bogus size.
  const invalidLimits: Array<[string, unknown]> = [
    ["zero", 0],
    ["negative", -10],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a non-number", "30" as unknown],
    ["null", null],
  ];

  for (const [label, value] of invalidLimits) {
    it(`falls back to the default when the stored limit is ${label}`, async () => {
      await testDb.settings.put({
        id: "default",
        privacyHistoryLimit: value,
      } as Settings);

      const overBy = 3;
      const total = DEFAULT_PRIVACY_HISTORY_LIMIT + overBy;
      for (let i = 1; i <= total; i++) {
        await addPrivacyAuditHistoryEntry(mkEntry(i * 1000));
      }

      // Trimming applies the default, not the invalid value.
      expect(await testDb.privacyAuditHistory.count()).toBe(
        DEFAULT_PRIVACY_HISTORY_LIMIT,
      );

      const all = await getPrivacyAuditHistory();
      expect(all[0].timestamp).toBe((overBy + 1) * 1000);
      expect(all[all.length - 1].timestamp).toBe(total * 1000);
    });
  }

  it("falls back to the default when the settings row is missing entirely", async () => {
    // No settings row at all (getSettings returns undefined).
    await testDb.settings.clear();

    const overBy = 2;
    const total = DEFAULT_PRIVACY_HISTORY_LIMIT + overBy;
    for (let i = 1; i <= total; i++) {
      await addPrivacyAuditHistoryEntry(mkEntry(i * 1000));
    }

    expect(await testDb.privacyAuditHistory.count()).toBe(
      DEFAULT_PRIVACY_HISTORY_LIMIT,
    );
  });

  it("floors a fractional custom limit", async () => {
    // A fractional stored limit (e.g. 4.9) should floor to 4.
    await setRetentionLimit(4.9);

    for (let i = 1; i <= 10; i++) {
      await addPrivacyAuditHistoryEntry(mkEntry(i * 1000));
    }

    expect(await testDb.privacyAuditHistory.count()).toBe(4);
    const all = await getPrivacyAuditHistory();
    expect(all.map((e) => e.timestamp)).toEqual([7000, 8000, 9000, 10000]);
  });
});

describe("trimPrivacyAuditHistory", () => {
  it("immediately removes the oldest runs beyond an explicit lower limit", async () => {
    // 20 runs stored under the default (30) limit, so nothing is trimmed yet.
    for (let i = 1; i <= 20; i++) {
      await addPrivacyAuditHistoryEntry(mkEntry(i * 1000));
    }
    expect(await testDb.privacyAuditHistory.count()).toBe(20);

    // Lower the limit to 5 and trim right away.
    const removed = await trimPrivacyAuditHistory(5);
    expect(removed).toBe(15);

    const all = await getPrivacyAuditHistory();
    expect(all).toHaveLength(5);
    // The 5 most-recent runs survive (16000..20000); oldest first removed.
    expect(all.map((e) => e.timestamp)).toEqual([
      16000, 17000, 18000, 19000, 20000,
    ]);
  });

  it("resolves the configured limit from settings when none is passed", async () => {
    for (let i = 1; i <= 12; i++) {
      await addPrivacyAuditHistoryEntry(mkEntry(i * 1000));
    }
    await setRetentionLimit(4);

    const removed = await trimPrivacyAuditHistory();
    expect(removed).toBe(8);

    const all = await getPrivacyAuditHistory();
    expect(all.map((e) => e.timestamp)).toEqual([9000, 10000, 11000, 12000]);
  });

  it("makes no change when the limit is raised or unchanged", async () => {
    for (let i = 1; i <= 6; i++) {
      await addPrivacyAuditHistoryEntry(mkEntry(i * 1000));
    }

    // Raising the effective limit removes nothing.
    expect(await trimPrivacyAuditHistory(100)).toBe(0);
    expect(await testDb.privacyAuditHistory.count()).toBe(6);

    // A limit equal to the current count also removes nothing.
    expect(await trimPrivacyAuditHistory(6)).toBe(0);
    expect(await testDb.privacyAuditHistory.count()).toBe(6);
  });
});

describe("getPrivacyAuditHistoryCount", () => {
  it("returns the total number of stored runs", async () => {
    expect(await getPrivacyAuditHistoryCount()).toBe(0);

    for (let i = 1; i <= 7; i++) {
      await addPrivacyAuditHistoryEntry(mkEntry(i * 1000));
    }
    expect(await getPrivacyAuditHistoryCount()).toBe(7);

    await clearPrivacyAuditHistory();
    expect(await getPrivacyAuditHistoryCount()).toBe(0);
  });
});

describe("clearPrivacyAuditHistory", () => {
  it("empties the table", async () => {
    await addPrivacyAuditHistoryEntry(mkEntry(1000));
    await addPrivacyAuditHistoryEntry(mkEntry(2000));
    expect(await testDb.privacyAuditHistory.count()).toBe(2);

    await clearPrivacyAuditHistory();
    expect(await testDb.privacyAuditHistory.count()).toBe(0);
    expect(await getPrivacyAuditHistory()).toEqual([]);
  });
});

describe("setPrivacyAuditHistoryAdversary", () => {
  const adversary = {
    exposureCount: 3,
    addressesExposed: 7,
    separationCount: 2,
    confusionCount: 1,
    contextMergeCount: 4,
  };

  it("attaches the adversary summary to an existing entry and returns true", async () => {
    const id = await addPrivacyAuditHistoryEntry(mkEntry(1000));
    expect(await setPrivacyAuditHistoryAdversary(id, adversary)).toBe(true);

    const stored = await testDb.privacyAuditHistory.get(id);
    expect(stored?.adversary).toEqual(adversary);
    // Untouched fields survive the update.
    expect(stored?.timestamp).toBe(1000);
  });

  it("stores a cancelled marker so an aborted run is distinguishable from never-ran", async () => {
    const id = await addPrivacyAuditHistoryEntry(mkEntry(1000));
    expect(await setPrivacyAuditHistoryAdversary(id, { status: "cancelled" })).toBe(true);

    const stored = await testDb.privacyAuditHistory.get(id);
    expect(stored?.adversary).toEqual({ status: "cancelled" });
  });

  it("returns false without writing when the entry no longer exists (trimmed away)", async () => {
    const id = await addPrivacyAuditHistoryEntry(mkEntry(1000));
    await clearPrivacyAuditHistory();

    expect(await setPrivacyAuditHistoryAdversary(id, adversary)).toBe(false);
    expect(await testDb.privacyAuditHistory.count()).toBe(0);
  });
});

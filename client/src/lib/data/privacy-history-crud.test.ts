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
import type { PrivacyAuditHistoryEntry } from "@/lib/db-types";

class TestDb extends Dexie {
  privacyAuditHistory!: Table<PrivacyAuditHistoryEntry, number>;
  constructor(name: string) {
    super(name);
    // Mirrors the privacyAuditHistory schema in database.ts (v34).
    this.version(1).stores({
      privacyAuditHistory: "++id, timestamp",
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
  clearPrivacyAuditHistory,
  PRIVACY_HISTORY_LIMIT,
} = await import("./privacy-history-crud");

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
    const total = PRIVACY_HISTORY_LIMIT + overBy;
    for (let i = 1; i <= total; i++) {
      await addPrivacyAuditHistoryEntry(mkEntry(i * 1000));
    }

    const count = await testDb.privacyAuditHistory.count();
    expect(count).toBe(PRIVACY_HISTORY_LIMIT);

    const all = await getPrivacyAuditHistory();
    // Oldest `overBy` timestamps (1000..5000) should have been trimmed away.
    expect(all[0].timestamp).toBe((overBy + 1) * 1000);
    expect(all[all.length - 1].timestamp).toBe(total * 1000);
    expect(all).toHaveLength(PRIVACY_HISTORY_LIMIT);
  });

  it("does not trim while at or below the limit", async () => {
    for (let i = 1; i <= PRIVACY_HISTORY_LIMIT; i++) {
      await addPrivacyAuditHistoryEntry(mkEntry(i * 1000));
    }
    expect(await testDb.privacyAuditHistory.count()).toBe(PRIVACY_HISTORY_LIMIT);

    const all = await getPrivacyAuditHistory();
    expect(all[0].timestamp).toBe(1000);
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

import "fake-indexeddb/auto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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

const testDb = new TestDb(`KYUTXO-global-search-${Date.now()}-${Math.random()}`);

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>("@/lib/database");
  return { ...actual, db: testDb };
});

const {
  bulkCreateRecords,
  clearAllRecords,
  createRecord,
  searchVisibleRecordsBounded,
  updateRecord,
} = await import("./record-crud");

const CREATE_OPTIONS = { skipNotification: true, skipVocabularySync: true };

beforeEach(async () => {
  await clearAllRecords();
});

afterAll(async () => {
  testDb.close();
  await Dexie.delete(testDb.name);
});

describe("searchVisibleRecordsBounded", () => {
  it("stops the unindexed metadata fallback at the raw candidate limit", async () => {
    await bulkCreateRecords(
      Array.from({ length: 80 }, (_, index) => ({
        type: "other" as const,
        inputString: `bounded-search-${index}`,
        label: `Ordinary row ${index}`,
        notes: "no matching metadata here",
        tags: [],
        categories: [],
      })),
      CREATE_OPTIONS,
    );

    let inspected = 0;
    const rows = await searchVisibleRecordsBounded("needle-that-does-not-exist", {
      perIndexLimit: 5,
      recentScanLimit: 25,
      onRecentRecordInspected: () => {
        inspected += 1;
      },
    });

    expect(rows).toEqual([]);
    expect(inspected).toBe(25);
  });

  it("keeps missing-tier legacy rows visible and excludes discovery rows", async () => {
    const visibleId = await createRecord(
      {
        type: "address",
        inputString: "bc1qglobalsearchlegacyvisible",
        label: "Shared search label",
        tags: [],
        categories: [],
      },
      CREATE_OPTIONS,
    );
    await updateRecord(visibleId, { addressImportance: undefined });

    await createRecord(
      {
        type: "address",
        inputString: "bc1qglobalsearchhiddenrecord",
        label: "Shared search label",
        tags: [],
        categories: [],
        addressImportance: "pending-review",
        source: "blockchain-sync",
      },
      CREATE_OPTIONS,
    );

    const rows = await searchVisibleRecordsBounded("shared search", {
      perIndexLimit: 10,
      recentScanLimit: 20,
    });

    expect(rows.map((row) => row.id)).toEqual([visibleId]);
    expect(rows[0]?.addressImportance).toBeUndefined();
  });
});
import "fake-indexeddb/auto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type { Record as DbRecord } from "@/lib/database";

class TestDb extends Dexie {
  records!: Table<DbRecord, number>;
  recordSearchIndex!: Table<{
    id?: number;
    gram: string;
    kind: "notes" | "custom";
    recordId: number;
  }, number>;
  recordSearchIndexState!: Table<{
    id: "state";
    version: 1;
    status: "ready" | "building";
    recordCount: number;
    maxId: number;
    maxUpdatedAt: number;
  }, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      records:
        "++id, type, inputString, inputStringLower, label, owner, walletName, " +
        "seedName, walletSoftware, *tags, *categories, createdAt, updatedAt, " +
        "chainType, syncDepth, addressImportance, [type+addressImportance], " +
        "[addressImportance+id], [type+id], [owner+id], [walletName+id], " +
        "flowType, discoveredFromRecordId",
      recordSearchIndex: "++id, &[gram+kind+recordId], gram, kind, recordId",
      recordSearchIndexState: "id",
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
  it("finds old notes and custom fields beyond the bounded recent window", async () => {
    const noteId = await createRecord(
      {
        type: "other",
        inputString: "old-note-record",
        label: "Old note",
        notes: "archived sapphire invoice",
        tags: [],
        categories: [],
      },
      CREATE_OPTIONS,
    );
    const customId = await createRecord(
      {
        type: "other",
        inputString: "old-custom-record",
        label: "Old custom field",
        customFields: { reference: "warehouse marigold receipt" },
        tags: [],
        categories: [],
      },
      CREATE_OPTIONS,
    );
    await bulkCreateRecords(
      Array.from({ length: 80 }, (_, index) => ({
        type: "other" as const,
        inputString: `newer-row-${index}`,
        label: `Newer row ${index}`,
        tags: [],
        categories: [],
      })),
      CREATE_OPTIONS,
    );

    const noteRows = await searchVisibleRecordsBounded("sapphire", {
      perIndexLimit: 5,
      recentScanLimit: 5,
    });
    const customRows = await searchVisibleRecordsBounded("marigold", {
      perIndexLimit: 5,
      recentScanLimit: 5,
    });

    expect(noteRows.map((row) => row.id)).toContain(noteId);
    expect(customRows.map((row) => row.id)).toContain(customId);
  });

  it("uses the rarest gram so an old match survives more than 500 common postings", async () => {
    const oldId = await createRecord(
      {
        type: "other",
        inputString: "rare-old-record",
        label: "Rare old row",
        notes: "common sapphire ledger",
        tags: [],
        categories: [],
      },
      CREATE_OPTIONS,
    );
    await bulkCreateRecords(
      Array.from({ length: 550 }, (_, index) => ({
        type: "other" as const,
        inputString: `common-newer-${index}`,
        label: `Common newer ${index}`,
        notes: "common ordinary ledger",
        tags: [],
        categories: [],
      })),
      CREATE_OPTIONS,
    );

    const rows = await searchVisibleRecordsBounded("common sapphire", {
      perIndexLimit: 5,
      recentScanLimit: 5,
    });
    expect(rows.map((row) => row.id)).toContain(oldId);
  });

  it("repairs a stale derived index before searching restored metadata", async () => {
    const restoredId = await createRecord(
      {
        type: "other",
        inputString: "restored-search-row",
        label: "Restored row",
        notes: "original searchable value",
        tags: [],
        categories: [],
      },
      CREATE_OPTIONS,
    );

    // Simulate an interrupted/older restore that changed source rows without
    // updating the derived table. The records fingerprint must force a rebuild.
    await testDb.records.update(restoredId, {
      notes: "recovered heliotrope value",
      updatedAt: Date.now() + 10_000,
    });

    const rows = await searchVisibleRecordsBounded("heliotrope", {
      perIndexLimit: 5,
      recentScanLimit: 1,
    });
    expect(rows.map((row) => row.id)).toEqual([restoredId]);

    await vi.waitFor(async () => {
      const state = await testDb.recordSearchIndexState.get("state");
      expect(state?.status).toBe("ready");
      expect(state?.maxUpdatedAt).toBeGreaterThan(Date.now());
    });
  });

  it("rebuilds cleanly after a replace-restore-style clear and bulk load", async () => {
    await createRecord(
      {
        type: "other",
        inputString: "discarded-before-restore",
        label: "Discarded",
        notes: "discarded metadata",
        tags: [],
        categories: [],
      },
      CREATE_OPTIONS,
    );
    await clearAllRecords({ skipNotification: true });
    const [restoredId] = await bulkCreateRecords(
      [{
        type: "other",
        inputString: "restored-after-clear",
        label: "Restored",
        customFields: { archiveCode: "restored vermilion archive" },
        tags: [],
        categories: [],
      }],
      CREATE_OPTIONS,
    );

    const rows = await searchVisibleRecordsBounded("vermilion", {
      perIndexLimit: 5,
      recentScanLimit: 1,
    });
    expect(rows.map((row) => row.id)).toEqual([restoredId]);
    expect(await testDb.recordSearchIndexState.get("state")).toMatchObject({
      status: "ready",
      recordCount: 1,
    });
  });

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
    await createRecord(
      {
        type: "address",
        inputString: "bc1qglobalsearchhiddenmetadata",
        label: "Unrelated hidden row",
        notes: "shared search metadata",
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
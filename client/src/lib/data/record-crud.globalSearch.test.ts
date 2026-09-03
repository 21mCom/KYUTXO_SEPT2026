import "fake-indexeddb/auto";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type { Record as DbRecord } from "@/lib/database";
import type {
  RecordSearchIndexFingerprint,
  RecordSearchIndexState,
} from "./record-search-index";

class TestDb extends Dexie {
  records!: Table<DbRecord, number>;
  recordSearchIndex!: Table<{
    id?: number;
    gram: string;
    kind: "notes" | "custom";
    recordId: number;
  }, number>;
  recordSearchIndexState!: Table<RecordSearchIndexState, string>;

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
  bulkDeleteRecords,
  clearAllRecords,
  createRecord,
  searchVisibleRecordsBounded,
  updateRecord,
} = await import("./record-crud");
const {
  beginRecordSearchIndexMutation,
  beginRecordSearchIndexRebuild,
  buildRecordSearchIndexEntries,
  completeRecordSearchIndexMutation,
  persistRecordSearchIndexReadyState,
  resetRecordSearchIndexForRebuild,
  syncRecordSearchIndex,
} = await import("./record-search-index");

const CREATE_OPTIONS = { skipNotification: true, skipVocabularySync: true };

async function getSearchIndexFingerprint(): Promise<RecordSearchIndexFingerprint> {
  const [recordCount, newestById, newestByUpdatedAt] = await Promise.all([
    testDb.records.count(),
    testDb.records.orderBy("id").reverse().first(),
    testDb.records.orderBy("updatedAt").reverse().first(),
  ]);
  return {
    recordCount,
    maxId: newestById?.id ?? 0,
    maxUpdatedAt: newestByUpdatedAt?.updatedAt ?? 0,
  };
}

function postingSignature(entries: Array<{
  gram: string;
  kind: "notes" | "custom";
  recordId: number;
}>): string[] {
  return entries
    .map(({ gram, kind, recordId }) => `${kind}:${recordId}:${gram}`)
    .sort();
}

beforeEach(async () => {
  await clearAllRecords();
});

afterEach(() => {
  vi.restoreAllMocks();
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

  it("rejects a rebuild generation captured before a metadata update and retries", async () => {
    const recordId = await createRecord(
      {
        type: "other",
        inputString: "rebuild-generation-race",
        label: "Generation race",
        notes: "metadata before rebuild capture",
        tags: [],
        categories: [],
      },
      CREATE_OPTIONS,
    );
    const capturedFingerprint = await getSearchIndexFingerprint();
    const capturedGeneration = await beginRecordSearchIndexRebuild(capturedFingerprint);
    expect(capturedGeneration).toEqual(expect.any(Number));

    await updateRecord(recordId, { notes: "metadata after rebuild capture" }, CREATE_OPTIONS);

    // Model the paused rebuild resuming after the update. It must not certify
    // the now-cleared postings with the generation it captured earlier.
    await resetRecordSearchIndexForRebuild();
    const currentFingerprint = await getSearchIndexFingerprint();
    await expect(
      persistRecordSearchIndexReadyState(currentFingerprint, capturedGeneration),
    ).resolves.toBe(false);
    expect(await testDb.recordSearchIndexState.get("state")).toMatchObject({
      status: "building",
      pendingMutations: 0,
      generation: capturedGeneration! + 1,
    });

    // A search observes the rejected certification and starts the real retry.
    await searchVisibleRecordsBounded("after rebuild capture", {
      perIndexLimit: 5,
      recentScanLimit: 1,
    });
    await vi.waitFor(async () => {
      expect((await testDb.recordSearchIndexState.get("state"))?.status).toBe("ready");
    });
    const indexedEntries = await testDb.recordSearchIndex.where("recordId").equals(recordId).toArray();
    const currentRecord = (await testDb.records.get(recordId))!;
    expect(postingSignature(indexedEntries)).toEqual(
      postingSignature(buildRecordSearchIndexEntries(currentRecord)),
    );
  });

  it("does not capture a rebuild while a record metadata mutation is pending", async () => {
    const recordId = await createRecord(
      {
        type: "other",
        inputString: "pending-mutation-race",
        label: "Pending mutation",
        notes: "metadata before pending mutation",
        tags: [],
        categories: [],
      },
      CREATE_OPTIONS,
    );

    // Hold an outer mutation open while the normal CRUD update performs its
    // own mutation. The rebuild capture must see that outstanding mutation.
    await beginRecordSearchIndexMutation();
    await updateRecord(recordId, { notes: "metadata during pending mutation" }, CREATE_OPTIONS);
    const blockedCapture = await beginRecordSearchIndexRebuild(
      await getSearchIndexFingerprint(),
    );
    expect(blockedCapture).toBeUndefined();
    expect(await testDb.recordSearchIndexState.get("state")).toMatchObject({
      status: "building",
      pendingMutations: 1,
    });

    await completeRecordSearchIndexMutation(await getSearchIndexFingerprint());
    const retryGeneration = await beginRecordSearchIndexRebuild(
      await getSearchIndexFingerprint(),
    );
    expect(retryGeneration).toEqual(
      (await testDb.recordSearchIndexState.get("state"))?.generation,
    );
    await resetRecordSearchIndexForRebuild();
    await syncRecordSearchIndex((await testDb.records.get(recordId))!);
    await expect(
      persistRecordSearchIndexReadyState(await getSearchIndexFingerprint(), retryGeneration),
    ).resolves.toBe(true);
  });

  it("releases a failed per-record index update so the next search rebuilds", async () => {
    const recordId = await createRecord(
      {
        type: "other",
        inputString: "failed-per-record-index",
        label: "Failed per-record index",
        notes: "metadata before failure",
        tags: [],
        categories: [],
      },
      CREATE_OPTIONS,
    );
    await bulkCreateRecords(
      Array.from({ length: 80 }, (_, index) => ({
        type: "other" as const,
        inputString: `per-record-newer-${index}`,
        label: `Per-record newer ${index}`,
        tags: [],
        categories: [],
      })),
      CREATE_OPTIONS,
    );

    vi.spyOn(testDb.recordSearchIndex, "bulkAdd").mockRejectedValueOnce(
      new Error("injected per-record index failure"),
    );
    await updateRecord(recordId, { notes: "latest per-record metadata" }, CREATE_OPTIONS);

    expect(await testDb.recordSearchIndexState.get("state")).toMatchObject({
      status: "building",
      pendingMutations: 0,
      rebuilding: true,
    });

    await searchVisibleRecordsBounded("latest per-record metadata", {
      perIndexLimit: 5,
      recentScanLimit: 1,
    });
    await vi.waitFor(async () => {
      expect((await testDb.recordSearchIndexState.get("state"))?.status).toBe("ready");
    });
    expect(
      (await searchVisibleRecordsBounded("latest per-record metadata", {
        perIndexLimit: 5,
        recentScanLimit: 1,
      })).map((row) => row.id),
    ).toContain(recordId);
  });

  it("releases a failed batch index update without certifying stale postings", async () => {
    vi.spyOn(testDb.recordSearchIndex, "bulkAdd").mockRejectedValueOnce(
      new Error("injected batch index failure"),
    );
    const [recordId] = await bulkCreateRecords(
      [{
        type: "other",
        inputString: "failed-batch-index",
        label: "Failed batch index",
        notes: "latest batch metadata",
        tags: [],
        categories: [],
      }],
      CREATE_OPTIONS,
    );

    expect(recordId).toEqual(expect.any(Number));
    expect(await testDb.recordSearchIndexState.get("state")).toMatchObject({
      status: "building",
      pendingMutations: 0,
      rebuilding: true,
    });
    const capturedState = await testDb.recordSearchIndexState.get("state");
    expect(capturedState?.status).not.toBe("ready");
    expect(
      await testDb.recordSearchIndex.where("recordId").equals(recordId).count(),
    ).toBe(0);
  });

  it("releases a failed delete index update for a rebuild", async () => {
    const recordId = await createRecord(
      {
        type: "other",
        inputString: "failed-delete-index",
        label: "Failed delete index",
        notes: "delete metadata",
        tags: [],
        categories: [],
      },
      CREATE_OPTIONS,
    );

    vi.spyOn(testDb.recordSearchIndex, "where").mockImplementationOnce(() => {
      throw new Error("injected delete index failure");
    });
    await bulkDeleteRecords([recordId], CREATE_OPTIONS);

    expect(await testDb.records.get(recordId)).toBeUndefined();
    expect(await testDb.recordSearchIndexState.get("state")).toMatchObject({
      status: "building",
      pendingMutations: 0,
      rebuilding: true,
    });
  });

  it("leaves only the newest metadata postings after overlapping updates", async () => {
    const recordId = await createRecord(
      {
        type: "other",
        inputString: "overlapping-metadata-updates",
        label: "Overlapping updates",
        notes: "original overlapping metadata",
        tags: [],
        categories: [],
      },
      CREATE_OPTIONS,
    );

    const firstUpdate = updateRecord(
      recordId,
      { notes: "first overlapping metadata" },
      CREATE_OPTIONS,
    );
    await vi.waitFor(async () => {
      expect((await testDb.records.get(recordId))?.notes).toBe("first overlapping metadata");
    });
    const secondUpdate = updateRecord(
      recordId,
      { notes: "newest overlapping metadata" },
      CREATE_OPTIONS,
    );
    await Promise.all([firstUpdate, secondUpdate]);

    const newestRecord = (await testDb.records.get(recordId))!;
    expect(newestRecord.notes).toBe("newest overlapping metadata");
    const indexedEntries = await testDb.recordSearchIndex.where("recordId").equals(recordId).toArray();
    expect(postingSignature(indexedEntries)).toEqual(
      postingSignature(buildRecordSearchIndexEntries(newestRecord)),
    );
    expect(postingSignature(indexedEntries)).not.toContain(
      `notes:${recordId}:ori`,
    );
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
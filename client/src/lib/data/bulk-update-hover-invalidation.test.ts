// @vitest-environment jsdom
//
// End-to-end coverage for the bulk-write -> hover-metadata-cache invalidation
// wiring. bulkUpdateRecords and clearAllRecords were taught to drop the
// hover-metadata cache so the orange FileText note indicator on any visible
// AddressLink/TxidLink refreshes immediately (no hover required) after a Bulk
// Editor run or a full wipe. There is no automated test pinning that contract,
// so a future refactor of the cache helpers (invalidateHoverCacheMany /
// clearHoverCache, or invalidateCachedRecords / clearCachedRecords) could
// silently bring back stale icons.
//
// This suite runs the REAL Dexie engine (via fake-indexeddb) so record-crud's
// writes and metadata-hover's reads share one database, and the REAL
// metadata-hover module (record-crud dynamic-imports it, the test imports the
// same instance) so a subscribed identifier really re-resolves end-to-end.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
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

const testDb = new TestDb(`KYUTXO-bulk-hover-${Date.now()}-${Math.random()}`);

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return { ...actual, db: testDb };
});

const { bulkUpdateRecords, clearAllRecords } = await import("./record-crud");
const {
  subscribeCacheEntry,
  getCachedRecord,
  resolveIdentifier,
  invalidateCachedRecord,
} = await import("../metadata-hover");

// The invalidation hop is fire-and-forget: record-crud dynamic-imports
// metadata-hover, then the re-resolution issues an async DB read. Settle both
// the microtask queue and any pending fake-indexeddb work before asserting.
async function settle() {
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function seedRecord(overrides: Partial<DbRecord> = {}): Promise<number> {
  const id = await testDb.records.add({
    type: "address",
    inputString: "bc1qseed",
    inputStringLower: "bc1qseed",
    label: "Unlabeled",
    notes: "",
    tags: [],
    categories: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as DbRecord);
  return id as number;
}

beforeAll(async () => {
  await testDb.open();
});

afterAll(() => {
  testDb.close();
});

beforeEach(async () => {
  await testDb.records.clear();
});

describe("bulkUpdateRecords -> hover cache invalidation", () => {
  it("re-resolves a subscribed identifier (note change) without a hover", async () => {
    const identifier = "bc1qnotechange";
    const id = await seedRecord({
      inputString: identifier,
      inputStringLower: identifier.toLowerCase(),
      notes: "",
    });

    // Warm the cache the way a visible link does, then start fresh so the entry
    // reflects the seeded (empty-note) record.
    invalidateCachedRecord(identifier);
    await resolveIdentifier(identifier);
    expect(getCachedRecord(identifier)?.notes ?? "").toBe("");

    // A visible AddressLink/TxidLink subscribes for live updates.
    const cb = vi.fn();
    const unsub = subscribeCacheEntry(identifier, cb);

    await bulkUpdateRecords([{ id, changes: { notes: "now has a note" } }], {
      skipVocabularySync: true,
    });
    await settle();

    // The subscriber fired with the freshly re-resolved record (no hover), and
    // the cache now reflects the new note.
    expect(cb).toHaveBeenCalled();
    const last = cb.mock.calls[cb.mock.calls.length - 1][0] as DbRecord | null;
    expect(last?.notes).toBe("now has a note");
    expect(getCachedRecord(identifier)?.notes).toBe("now has a note");
    unsub();
  });

  it("re-resolves a subscribed identifier when the label changes", async () => {
    const identifier = "bc1qlabelchange";
    const id = await seedRecord({
      inputString: identifier,
      inputStringLower: identifier.toLowerCase(),
      label: "Unlabeled",
    });

    invalidateCachedRecord(identifier);
    await resolveIdentifier(identifier);

    const cb = vi.fn();
    const unsub = subscribeCacheEntry(identifier, cb);

    await bulkUpdateRecords([{ id, changes: { label: "Cold Storage" } }], {
      skipVocabularySync: true,
    });
    await settle();

    const last = cb.mock.calls[cb.mock.calls.length - 1][0] as DbRecord | null;
    expect(last?.label).toBe("Cold Storage");
    expect(getCachedRecord(identifier)?.label).toBe("Cold Storage");
    unsub();
  });

  it("invalidates BOTH the old and new identifier when inputString changes", async () => {
    const oldId = "bc1qoldaddr";
    const newId = "bc1qnewaddr";
    const id = await seedRecord({
      inputString: oldId,
      inputStringLower: oldId.toLowerCase(),
      label: "Renamed",
    });

    // Warm caches for both identifiers. The new identifier currently has no
    // record (resolves to null) until the rename lands.
    invalidateCachedRecord(oldId);
    invalidateCachedRecord(newId);
    await resolveIdentifier(oldId);
    await resolveIdentifier(newId);
    expect(getCachedRecord(oldId)?.inputString).toBe(oldId);
    expect(getCachedRecord(newId)).toBeNull();

    // Both links are visible / subscribed.
    const oldCb = vi.fn();
    const newCb = vi.fn();
    const unsubOld = subscribeCacheEntry(oldId, oldCb);
    const unsubNew = subscribeCacheEntry(newId, newCb);

    await bulkUpdateRecords(
      [{ id, changes: { inputString: newId } }],
      { skipVocabularySync: true },
    );
    await settle();

    // Old identifier re-resolved -> now no record points at it (null).
    expect(oldCb).toHaveBeenCalled();
    const oldLast = oldCb.mock.calls[oldCb.mock.calls.length - 1][0] as
      | DbRecord
      | null;
    expect(oldLast).toBeNull();
    expect(getCachedRecord(oldId)).toBeNull();

    // New identifier re-resolved -> now resolves to the renamed record.
    expect(newCb).toHaveBeenCalled();
    const newLast = newCb.mock.calls[newCb.mock.calls.length - 1][0] as
      | DbRecord
      | null;
    expect(newLast?.inputString).toBe(newId);
    expect(getCachedRecord(newId)?.inputString).toBe(newId);

    unsubOld();
    unsubNew();
  });
});

describe("clearAllRecords -> hover cache wipe", () => {
  it("drops the whole cache and notifies subscribers with null", async () => {
    const a = "bc1qwipea";
    const b = "bc1qwipeb";
    await seedRecord({ inputString: a, inputStringLower: a, label: "A" });
    await seedRecord({ inputString: b, inputStringLower: b, label: "B" });

    invalidateCachedRecord(a);
    invalidateCachedRecord(b);
    await resolveIdentifier(a);
    await resolveIdentifier(b);
    expect(getCachedRecord(a)?.inputString).toBe(a);
    expect(getCachedRecord(b)?.inputString).toBe(b);

    const cbA = vi.fn();
    const cbB = vi.fn();
    const unsubA = subscribeCacheEntry(a, cbA);
    const unsubB = subscribeCacheEntry(b, cbB);

    await clearAllRecords();
    await settle();

    // Both visible subscribers were told their identifier now resolves to null
    // so the indicator clears within a render.
    expect(cbA).toHaveBeenCalledWith(null);
    expect(cbB).toHaveBeenCalledWith(null);

    // The cache is fully wiped (entries gone, not just stale).
    expect(getCachedRecord(a)).toBeUndefined();
    expect(getCachedRecord(b)).toBeUndefined();

    unsubA();
    unsubB();
  });
});

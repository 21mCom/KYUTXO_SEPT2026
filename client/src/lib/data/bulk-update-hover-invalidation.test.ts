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

// Optional per-identifier override for getRecordsByInputString. When set, the
// wrapped read returns the override's promise instead of hitting testDb, letting
// a test take precise control of resolution timing to reproduce a slow
// in-flight hover resolve racing a bulkUpdateRecords invalidation. All other
// record-crud exports (bulkUpdateRecords, clearAllRecords, ...) stay REAL so the
// end-to-end write -> invalidate -> re-resolve wiring is exercised genuinely.
const queryOverrides = new Map<string, () => Promise<DbRecord[]>>();
// Optional per-batch override for getRecordsByInputStrings (the batch preload
// path, _runBatchFetch). Keyed by the sorted, joined list of identifiers a batch
// fetch requests, letting a test hold a slow in-flight batch read while a real
// bulkUpdateRecords write commits, to drive the batch generation guard
// end-to-end. All other record-crud exports stay REAL.
const batchQueryOverrides = new Map<string, () => Promise<DbRecord[]>>();
const batchKey = (values: string[]) => [...values].sort().join("|");
vi.mock("@/lib/data/record-crud", async () => {
  const actual = await vi.importActual<typeof import("@/lib/data/record-crud")>(
    "@/lib/data/record-crud",
  );
  return {
    ...actual,
    getRecordsByInputString: async (inputString: string) => {
      const override = queryOverrides.get(inputString);
      if (override) return override();
      return actual.getRecordsByInputString(inputString);
    },
    getRecordsByInputStrings: async (values: string[]) => {
      const override = batchQueryOverrides.get(batchKey(values));
      if (override) return override();
      return actual.getRecordsByInputStrings(values);
    },
  };
});

const { bulkUpdateRecords, clearAllRecords } = await import("./record-crud");
const {
  subscribeCacheEntry,
  getCachedRecord,
  resolveIdentifier,
  invalidateCachedRecord,
  batchPreloadIdentifiers,
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
  queryOverrides.clear();
  batchQueryOverrides.clear();
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

  // Generation-guard race, driven end-to-end through the REAL bulkUpdateRecords
  // invalidation path (invalidateHoverCacheMany -> invalidateCachedRecords).
  //
  // A visible link starts a hover resolve that reads the DB *before* a Bulk
  // Editor write commits, so it carries pre-write (stale) data. That read is
  // slow and finishes LAST — after bulkUpdateRecords commits and its
  // invalidation kicks off a fresh re-resolution that reads the post-write
  // value. The per-key generation counter must ensure the slow stale read
  // cannot re-pin the old note/label into the cache or notify a subscriber with
  // it. Without the guard a large bulk edit could silently leave a stale note
  // icon / tooltip until the next hover.
  it("a slow in-flight resolve finishing after a bulk run cannot re-pin stale data", async () => {
    const identifier = "bc1qbulkrace";
    const id = await seedRecord({
      inputString: identifier,
      inputStringLower: identifier.toLowerCase(),
      notes: "",
      label: "Unlabeled",
    });

    // The stale in-flight read reflects the seeded, pre-write record.
    const staleRecord = {
      id,
      type: "address",
      inputString: identifier,
      inputStringLower: identifier.toLowerCase(),
      notes: "",
      label: "Unlabeled",
      tags: [],
      categories: [],
      createdAt: 0,
      updatedAt: 0,
    } as DbRecord;

    // First getRecordsByInputString call (the slow hover resolve) is held until
    // we release it. We delete the override on first use so the SECOND call —
    // the fresh re-resolution that bulkUpdateRecords triggers — falls through to
    // the real testDb read and sees the committed post-write value.
    let releaseStale!: (rows: DbRecord[]) => void;
    const stalePromise = new Promise<DbRecord[]>((res) => {
      releaseStale = res;
    });
    queryOverrides.set(identifier, () => {
      queryOverrides.delete(identifier);
      return stalePromise;
    });

    // Start from a clean cache (no subscriber yet, so this just clears + bumps
    // the generation; it does not re-resolve).
    invalidateCachedRecord(identifier);

    // (1) A visible link's hover starts a resolve that reads the DB *before* the
    // write. It is held pending by the override above.
    const stalePending = resolveIdentifier(identifier);
    await Promise.resolve();

    // A visible AddressLink/TxidLink subscribes for live updates.
    const cb = vi.fn();
    const unsub = subscribeCacheEntry(identifier, cb);

    // (2) The Bulk Editor commits a note change mid-flight. Its
    // invalidateHoverCacheMany bumps the generation, drops the slow in-flight
    // read, and (because a subscriber is attached) kicks off a fresh
    // re-resolution that reads the post-write value.
    await bulkUpdateRecords([{ id, changes: { notes: "now has a note" } }], {
      skipVocabularySync: true,
    });
    await settle();

    // (3) The fresh re-resolution has already populated the cache + subscriber
    // with the NEW value.
    expect(getCachedRecord(identifier)?.notes).toBe("now has a note");
    const afterBulk = cb.mock.calls[cb.mock.calls.length - 1][0] as
      | DbRecord
      | null;
    expect(afterBulk?.notes).toBe("now has a note");

    // (4) The original (stale) resolve finishes LAST, carrying pre-write data.
    releaseStale([staleRecord]);
    const staleResult = await stalePending;
    await settle();

    // It really did carry the pre-write value...
    expect(staleResult?.notes).toBe("");
    // ...but the generation guard kept it from re-pinning stale data: the cache
    // and the subscriber still reflect the NEW post-write value.
    expect(getCachedRecord(identifier)?.notes).toBe("now has a note");
    const last = cb.mock.calls[cb.mock.calls.length - 1][0] as DbRecord | null;
    expect(last?.notes).toBe("now has a note");
    // The subscriber was never notified with the stale (empty-note) value.
    expect(
      cb.mock.calls.some(([rec]) => (rec as DbRecord | null)?.notes === ""),
    ).toBe(false);

    unsub();
  });

  // Same generation-guard race as above, but the stale read comes from the BATCH
  // preload path (batchPreloadIdentifiers -> _runBatchFetch via
  // getRecordsByInputStrings) instead of a single hover resolve — driven
  // end-to-end through the REAL bulkUpdateRecords invalidation path.
  //
  // During fast scrolling a batch preload can read the DB *before* a Bulk Editor
  // write commits, so it carries pre-write (stale) data. That batch read is slow
  // and finishes LAST — after bulkUpdateRecords commits and its invalidation
  // kicks off a fresh single re-resolution that reads the post-write value. The
  // per-key generation guard in _runBatchFetch must ensure the slow stale batch
  // result cannot re-pin the old note into the cache or notify a subscriber with
  // it. Without the guard a fast scroll across a just-bulk-edited range could
  // silently leave a stale note icon / tooltip until the next hover.
  it("a slow in-flight batch preload finishing after a bulk run cannot re-pin stale data", async () => {
    const identifier = "bc1qbatchbulkrace";
    const id = await seedRecord({
      inputString: identifier,
      inputStringLower: identifier.toLowerCase(),
      notes: "",
      label: "Unlabeled",
    });

    // The stale in-flight batch read reflects the seeded, pre-write record.
    const staleRecord = {
      id,
      type: "address",
      inputString: identifier,
      inputStringLower: identifier.toLowerCase(),
      notes: "",
      label: "Unlabeled",
      tags: [],
      categories: [],
      createdAt: 0,
      updatedAt: 0,
    } as DbRecord;

    // The batch fetch (getRecordsByInputStrings) is held until we release it. The
    // fresh re-resolution that bulkUpdateRecords triggers goes through the SINGLE
    // getRecordsByInputString path (no override set for it), so it falls through
    // to the real testDb read and sees the committed post-write value.
    let releaseStale!: (rows: DbRecord[]) => void;
    const stalePromise = new Promise<DbRecord[]>((res) => {
      releaseStale = res;
    });
    batchQueryOverrides.set(batchKey([identifier]), () => stalePromise);

    // Start from a clean cache (no subscriber yet, so this just clears + bumps
    // the generation; it does not re-resolve).
    invalidateCachedRecord(identifier);

    // A visible AddressLink/TxidLink subscribes for live updates.
    const cb = vi.fn();
    const unsub = subscribeCacheEntry(identifier, cb);

    // (1) A fast scroll fires a batch preload that reads the DB *before* the
    // write. Its batch fetch is held pending by the override above.
    batchPreloadIdentifiers([identifier]);
    await Promise.resolve();

    // (2) The Bulk Editor commits a note change mid-flight. Its
    // invalidateHoverCacheMany bumps the generation, drops the slow in-flight
    // batch read's slot, and (because a subscriber is attached) kicks off a fresh
    // single re-resolution that reads the post-write value.
    await bulkUpdateRecords([{ id, changes: { notes: "now has a note" } }], {
      skipVocabularySync: true,
    });
    await settle();

    // (3) The fresh re-resolution has already populated the cache + subscriber
    // with the NEW value.
    expect(getCachedRecord(identifier)?.notes).toBe("now has a note");
    const afterBulk = cb.mock.calls[cb.mock.calls.length - 1][0] as
      | DbRecord
      | null;
    expect(afterBulk?.notes).toBe("now has a note");

    // (4) The original (stale) batch fetch finishes LAST, carrying pre-write data.
    releaseStale([staleRecord]);
    await settle();

    // The generation guard in _runBatchFetch kept the stale batch result from
    // re-pinning stale data: the cache and the subscriber still reflect the NEW
    // post-write value.
    expect(getCachedRecord(identifier)?.notes).toBe("now has a note");
    const last = cb.mock.calls[cb.mock.calls.length - 1][0] as DbRecord | null;
    expect(last?.notes).toBe("now has a note");
    // The subscriber was never notified with the stale (empty-note) value.
    expect(
      cb.mock.calls.some(([rec]) => (rec as DbRecord | null)?.notes === ""),
    ).toBe(false);

    unsub();
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

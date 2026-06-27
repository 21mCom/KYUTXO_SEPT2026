// @vitest-environment node
//
// The no-hover metadata indicator depends on a preload pipeline added without
// automated coverage. When a large list mounts, the page fires
// batchPreloadIdentifiers() for the visible rows; that batch-fetches each row's
// record in ONE query, warms the TTL cache, and notifies any AddressLink /
// TxidLink subscribed via subscribeCacheEntry() so the orange FileText icon can
// appear WITHOUT the user ever hovering. A silent regression in any link of
// that chain (batch dedup, in-flight skip, subscriber notification, oversize
// eviction, or the subscribe/unsubscribe lifecycle) would defeat the feature.
//
// This suite pins the pure data-layer contract: the record-crud query path is
// mocked so we can count and shape exactly what each batch fetches, and assert
// the cache + subscriber behaviour deterministically.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Record as DbRecord } from "./database";

// metadata-hover imports both query helpers at module load. We replace them so
// every fetch is observable and synchronous (resolved promises), keeping the
// in-flight / dedup assertions deterministic.
const { getRecordsByInputString, getRecordsByInputStrings } = vi.hoisted(() => ({
  getRecordsByInputString: vi.fn(),
  getRecordsByInputStrings: vi.fn(),
}));
vi.mock("./data/record-crud", () => ({
  getRecordsByInputString,
  getRecordsByInputStrings,
}));

import {
  batchPreloadIdentifiers,
  subscribeCacheEntry,
  getCachedRecord,
  invalidateCachedRecord,
  resolveIdentifier,
} from "./metadata-hover";

function makeRecord(inputString: string, overrides: Partial<DbRecord> = {}): DbRecord {
  return {
    id: Math.floor(Math.random() * 1e9),
    type: "address",
    inputString,
    inputStringLower: inputString.toLowerCase(),
    label: "Cold Storage",
    notes: "a note",
    tags: [],
    categories: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as DbRecord;
}

// Flush microtasks so the (async) batch fetch settles before assertions.
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  getRecordsByInputString.mockReset();
  getRecordsByInputStrings.mockReset();
  // Default: echo back one record per requested identifier.
  getRecordsByInputStrings.mockImplementation(async (values: string[]) =>
    values.map((v) => makeRecord(v)),
  );
});

describe("batchPreloadIdentifiers - cache warming", () => {
  it("warms the cache for every identifier in one batch query", async () => {
    const ids = ["addr-warm-1", "addr-warm-2", "addr-warm-3"];
    ids.forEach(invalidateCachedRecord);

    batchPreloadIdentifiers(ids);
    await flush();

    expect(getRecordsByInputStrings).toHaveBeenCalledTimes(1);
    for (const id of ids) {
      expect(getCachedRecord(id)?.inputString).toBe(id);
    }
  });

  it("caches a null result for an identifier with no matching record", async () => {
    const id = "addr-no-match";
    invalidateCachedRecord(id);
    getRecordsByInputStrings.mockResolvedValueOnce([]); // batch returns nothing

    batchPreloadIdentifiers([id]);
    await flush();

    // A miss is cached as null (not left undefined), so re-hovering never
    // triggers a second query.
    expect(getCachedRecord(id)).toBeNull();
  });

  it("splits a large request into PRELOAD_BATCH_SIZE (50) chunks", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `addr-chunk-${i}`);
    ids.forEach(invalidateCachedRecord);

    batchPreloadIdentifiers(ids);
    await flush();

    // 120 ids -> 50 + 50 + 20 = three batch queries.
    expect(getRecordsByInputStrings).toHaveBeenCalledTimes(3);
    expect(getRecordsByInputStrings.mock.calls[0][0]).toHaveLength(50);
    expect(getRecordsByInputStrings.mock.calls[1][0]).toHaveLength(50);
    expect(getRecordsByInputStrings.mock.calls[2][0]).toHaveLength(20);
  });
});

describe("batchPreloadIdentifiers - dedup", () => {
  it("collapses duplicate / case-variant identifiers to a single fetch", async () => {
    invalidateCachedRecord("addr-dup");
    batchPreloadIdentifiers(["addr-dup", "addr-dup", "ADDR-DUP", ""]);
    await flush();

    expect(getRecordsByInputStrings).toHaveBeenCalledTimes(1);
    // Only the one unique (case-folded) identifier is queried; the empty
    // string is ignored entirely.
    expect(getRecordsByInputStrings.mock.calls[0][0]).toEqual(["addr-dup"]);
  });

  it("skips identifiers already present in the cache", async () => {
    const cached = "addr-already-cached";
    const fresh = "addr-fresh";
    [cached, fresh].forEach(invalidateCachedRecord);

    // Warm `cached` first.
    batchPreloadIdentifiers([cached]);
    await flush();
    getRecordsByInputStrings.mockClear();

    // A second batch containing the cached id only fetches the new one.
    batchPreloadIdentifiers([cached, fresh]);
    await flush();

    expect(getRecordsByInputStrings).toHaveBeenCalledTimes(1);
    expect(getRecordsByInputStrings.mock.calls[0][0]).toEqual([fresh]);
  });
});

describe("batchPreloadIdentifiers - in-flight skip", () => {
  it("does not start a second fetch while the first batch is still pending", async () => {
    const id = "addr-inflight";
    invalidateCachedRecord(id);

    // A never-resolving fetch keeps the identifier in-flight.
    let release!: (recs: DbRecord[]) => void;
    getRecordsByInputStrings.mockImplementationOnce(
      () => new Promise<DbRecord[]>((resolve) => { release = (r) => resolve(r); }),
    );

    batchPreloadIdentifiers([id]); // first batch -> sets in-flight
    batchPreloadIdentifiers([id]); // second batch -> must skip

    expect(getRecordsByInputStrings).toHaveBeenCalledTimes(1);

    // Let the first batch finish so the in-flight entry is cleared cleanly.
    release([makeRecord(id)]);
    await flush();
    expect(getCachedRecord(id)?.inputString).toBe(id);
  });

  it("skips an identifier already in-flight from resolveIdentifier()", async () => {
    const id = "addr-resolve-inflight";
    invalidateCachedRecord(id);

    let release!: () => void;
    getRecordsByInputString.mockImplementationOnce(
      () => new Promise<DbRecord[]>((resolve) => { release = () => resolve([makeRecord(id)]); }),
    );

    const pending = resolveIdentifier(id); // single-id path, now in-flight
    batchPreloadIdentifiers([id]); // batch must not double-fetch

    expect(getRecordsByInputStrings).not.toHaveBeenCalled();

    release();
    await pending;
    await flush();
    expect(getCachedRecord(id)?.inputString).toBe(id);
  });
});

describe("batchPreloadIdentifiers - oversize eviction", () => {
  it("keeps the cache bounded when preloading far more than the max", async () => {
    const MAX_CACHE_SIZE = 2000;
    const total = 2400;
    const ids = Array.from({ length: total }, (_, i) => `addr-evict-${i.toString().padStart(5, "0")}`);

    batchPreloadIdentifiers(ids);
    await flush();

    // Count how many of our ids are still resident.
    const resident = ids.filter((id) => getCachedRecord(id) !== undefined).length;
    expect(resident).toBeLessThanOrEqual(MAX_CACHE_SIZE);

    // The most-recently inserted entries survive; the earliest are swept out.
    expect(getCachedRecord(ids[total - 1])?.inputString).toBe(ids[total - 1]);
    expect(getCachedRecord(ids[0])).toBeUndefined();
  });
});

describe("subscribeCacheEntry - lifecycle", () => {
  it("notifies a subscriber once the entry is resolved by a preload", async () => {
    const id = "addr-sub-notify";
    invalidateCachedRecord(id);

    const cb = vi.fn();
    const unsub = subscribeCacheEntry(id, cb);

    batchPreloadIdentifiers([id]);
    await flush();

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]?.inputString).toBe(id);
    unsub();
  });

  it("notifies a subscriber when resolveIdentifier populates the entry", async () => {
    const id = "addr-sub-resolve";
    invalidateCachedRecord(id);
    getRecordsByInputString.mockResolvedValueOnce([makeRecord(id)]);

    const cb = vi.fn();
    const unsub = subscribeCacheEntry(id, cb);

    await resolveIdentifier(id);
    await flush();

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]?.inputString).toBe(id);
    unsub();
  });

  it("does not notify after unsubscribe", async () => {
    const id = "addr-sub-unsub";
    invalidateCachedRecord(id);

    const cb = vi.fn();
    const unsub = subscribeCacheEntry(id, cb);
    unsub();

    batchPreloadIdentifiers([id]);
    await flush();

    expect(cb).not.toHaveBeenCalled();
  });

  it("is case-insensitive: subscribing by upper-case still fires for a lower-case preload", async () => {
    const lower = "addr-sub-case";
    const upper = lower.toUpperCase();
    invalidateCachedRecord(lower);

    const cb = vi.fn();
    const unsub = subscribeCacheEntry(upper, cb);

    batchPreloadIdentifiers([lower]);
    await flush();

    expect(cb).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("supports multiple subscribers for the same identifier and unsubscribes them independently", async () => {
    const id = "addr-sub-multi";
    invalidateCachedRecord(id);

    const cbA = vi.fn();
    const cbB = vi.fn();
    const unsubA = subscribeCacheEntry(id, cbA);
    const unsubB = subscribeCacheEntry(id, cbB);

    // Drop only the first subscriber before the entry resolves.
    unsubA();

    batchPreloadIdentifiers([id]);
    await flush();

    expect(cbA).not.toHaveBeenCalled();
    expect(cbB).toHaveBeenCalledTimes(1);
    unsubB();
  });
});

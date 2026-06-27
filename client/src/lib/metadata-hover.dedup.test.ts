// @vitest-environment jsdom
//
// Performance / safety contract for the hover-metadata resolver.
//
// The hover tooltip (AddressLink / TxidLink) resolves a row's metadata by
// calling resolveIdentifier() the first time a row is hovered. Two mechanisms
// are supposed to keep this cheap when a vault is large (50,000+ records):
//   1. An in-flight map dedupes concurrent lookups for the same identifier.
//   2. A TTL cache means a resolved identifier is never queried again.
// Together these guarantee that sweeping the cursor across N rows can fire at
// most ONE query per *unique* identifier — never a per-row query storm.
//
// This suite runs resolveIdentifier against the REAL record-crud query path
// (the indexed inputString equals() lookup) backed by a fake-indexeddb
// vault seeded with 12,000 records, exactly as the production index would be
// hit — just at test scale. We count how many times the underlying CRUD query
// actually executes, and we time a single indexed lookup to confirm the index
// path does not degrade into a full-table scan at scale.

import "fake-indexeddb/auto";

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import Dexie, { type Table } from "dexie";
import type { Record as DbRecord } from "@/lib/database";

const RECORDS_SCHEMA =
  "++id, type, inputString, inputStringLower, label, owner, walletName, " +
  "seedName, walletSoftware, *tags, *categories, createdAt, updatedAt, " +
  "chainType, syncDepth, addressImportance, [type+addressImportance], " +
  "[addressImportance+id], [type+id], [owner+id], [walletName+id], " +
  "flowType, discoveredFromRecordId";

class TestDb extends Dexie {
  records!: Table<DbRecord, number>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({ records: RECORDS_SCHEMA });
  }
}

let testDb: TestDb;

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>("@/lib/database");
  return {
    ...actual,
    get db() {
      return testDb;
    },
  };
});

// Wrap the real getRecordsByInputString so it still queries testDb through the
// genuine index path, but we can count every actual DB hit. metadata-hover
// imports this binding, so the wrapper observes exactly the queries it fires.
const queryLog: string[] = [];
// Optional per-identifier query override. When set, getRecordsByInputString
// returns the override's promise instead of hitting testDb, letting a test take
// precise control of resolution timing to reproduce a write/hover race.
const queryOverrides = new Map<string, () => Promise<DbRecord[]>>();
vi.mock("@/lib/data/record-crud", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/data/record-crud")>("@/lib/data/record-crud");
  return {
    ...actual,
    getRecordsByInputString: async (inputString: string) => {
      queryLog.push(inputString);
      const override = queryOverrides.get(inputString);
      if (override) return override();
      return actual.getRecordsByInputString(inputString);
    },
  };
});

const { resolveIdentifier, getCachedRecord, invalidateCachedRecord, subscribeCacheEntry } =
  await import("./metadata-hover");

const VAULT_SIZE = 12_000;
const addrAt = (i: number) => `addr-${i.toString().padStart(6, "0")}`;

beforeAll(async () => {
  testDb = new TestDb(`KYUTXO-hover-${Date.now()}-${Math.random()}`);
  await testDb.open();

  const rows: DbRecord[] = [];
  for (let i = 0; i < VAULT_SIZE; i++) {
    const addr = addrAt(i);
    rows.push({
      type: "address",
      inputString: addr,
      inputStringLower: addr.toLowerCase(),
      label: i % 3 === 0 ? `Wallet ${i}` : "Unlabeled",
      walletName: i % 3 === 0 ? `Wallet ${i}` : undefined,
      owner: i % 5 === 0 ? `Owner ${i}` : undefined,
      tags: [],
      categories: [],
      addressImportance: "manual",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as DbRecord);
  }
  // Seed directly (read-only test) in chunks to keep memory flat.
  for (let i = 0; i < rows.length; i += 2000) {
    await testDb.records.bulkAdd(rows.slice(i, i + 2000));
  }
});

afterAll(async () => {
  testDb.close();
  await Dexie.delete(testDb.name);
});

beforeEach(() => {
  queryLog.length = 0;
  queryOverrides.clear();
});

describe("resolveIdentifier query-storm guard (12k-record vault)", () => {
  it("fires exactly one query when 20 hovers race on the same address", async () => {
    const addr = addrAt(101);
    invalidateCachedRecord(addr);

    // 20 rapid hovers, all started before the first resolves.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => resolveIdentifier(addr)),
    );

    expect(queryLog.length).toBe(1);
    // Every racer gets the same resolved record.
    expect(results.every((r) => r?.inputString === addr)).toBe(true);
    expect(results[0]?.id).toBe(results[19]?.id);
  });

  it("never re-queries an address once it is cached", async () => {
    const addr = addrAt(202);
    invalidateCachedRecord(addr);

    await resolveIdentifier(addr);
    expect(queryLog.length).toBe(1);
    expect(getCachedRecord(addr)?.inputString).toBe(addr);

    // Subsequent hovers (sync cache hits) fire zero further queries.
    queryLog.length = 0;
    for (let i = 0; i < 10; i++) {
      expect(getCachedRecord(addr)?.inputString).toBe(addr);
      await resolveIdentifier(addr);
    }
    expect(queryLog.length).toBe(0);
  });

  it("sweeping 20 distinct rows (3 hovers each) fires exactly 20 queries", async () => {
    const addrs = Array.from({ length: 20 }, (_, i) => addrAt(300 + i));
    addrs.forEach(invalidateCachedRecord);

    // Simulate a fast cursor sweep: each row hovered three times in quick
    // succession, all interleaved.
    const calls: Promise<unknown>[] = [];
    for (let pass = 0; pass < 3; pass++) {
      for (const addr of addrs) calls.push(resolveIdentifier(addr));
    }
    await Promise.all(calls);

    // 60 hover events, but only one query per unique address.
    expect(queryLog.length).toBe(20);
    expect(new Set(queryLog).size).toBe(20);
  });

  it("returns null (cached) for an unknown address without a second query", async () => {
    const missing = "addr-does-not-exist";
    invalidateCachedRecord(missing);

    const r1 = await resolveIdentifier(missing);
    expect(r1).toBeNull();
    expect(queryLog.length).toBe(1);

    // A negative result is cached too, so re-hovering never re-queries.
    queryLog.length = 0;
    const r2 = await resolveIdentifier(missing);
    expect(r2).toBeNull();
    expect(queryLog.length).toBe(0);
  });

  it("a single indexed lookup stays fast at 12k records (no full scan)", async () => {
    // Indexed equals() lookups should be near-constant regardless of which row
    // we ask for. Probe addresses spread across the whole keyspace and confirm
    // the worst case is comfortably sub-linear (a full scan of 12k rows would
    // be far slower than this generous bound).
    const probes = [0, 3000, 6000, 9000, VAULT_SIZE - 1].map(addrAt);

    let maxMs = 0;
    for (const addr of probes) {
      invalidateCachedRecord(addr);
      const start = performance.now();
      const rec = await resolveIdentifier(addr);
      const elapsed = performance.now() - start;
      maxMs = Math.max(maxMs, elapsed);
      expect(rec?.inputString).toBe(addr);
    }

    // Generous ceiling: catches a catastrophic O(n) degradation while staying
    // robust on slow CI. An indexed lookup over 12k rows is typically <10ms.
    expect(maxMs).toBeLessThan(250);
  });

  // Race: a resolution started just before a write commits reads pre-write data.
  // If it finishes AFTER invalidateCachedRecord's fresh re-resolution, it must
  // not overwrite the cache with stale data and leave the note icon wrong until
  // the next hover. A per-key generation guard prevents the stale write.
  it("a stale in-flight resolution cannot overwrite a fresh post-write one", async () => {
    const addr = addrAt(404);
    const staleRecord = { id: 1, inputString: addr, label: "Old" } as DbRecord;
    const freshRecord = { id: 1, inputString: addr, label: "New" } as DbRecord;

    // Manually-controlled deferreds so we can decide resolution order.
    let resolveStale!: (r: DbRecord[]) => void;
    const stalePromise = new Promise<DbRecord[]>((res) => {
      resolveStale = res;
    });
    let resolveFresh!: (r: DbRecord[]) => void;
    const freshPromise = new Promise<DbRecord[]>((res) => {
      resolveFresh = res;
    });

    let calls = 0;
    queryOverrides.set(addr, () => {
      calls += 1;
      return calls === 1 ? stalePromise : freshPromise;
    });

    // Start clean and keep a subscriber attached so invalidate re-resolves for a
    // "visible" link rather than just clearing.
    invalidateCachedRecord(addr);
    const unsub = subscribeCacheEntry(addr, () => {});

    // (1) Hover starts a resolution that reads the DB *before* the write commits.
    const stalePending = resolveIdentifier(addr);

    // (2) A record edit commits and invalidates the cache. Because a subscriber
    // is attached, this kicks off a fresh re-resolution (query #2).
    invalidateCachedRecord(addr);

    // (3) The fresh re-resolution completes first and populates the cache.
    resolveFresh([freshRecord]);
    await new Promise((r) => setTimeout(r, 0));
    expect(getCachedRecord(addr)?.label).toBe("New");

    // (4) The original (stale) resolution finishes LATE. It must NOT clobber the
    // fresh cache entry.
    resolveStale([staleRecord]);
    await stalePending;
    await new Promise((r) => setTimeout(r, 0));

    expect(getCachedRecord(addr)?.label).toBe("New");

    unsub();
    invalidateCachedRecord(addr);
  });
});

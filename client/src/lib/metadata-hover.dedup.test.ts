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
vi.mock("@/lib/data/record-crud", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/data/record-crud")>("@/lib/data/record-crud");
  return {
    ...actual,
    getRecordsByInputString: async (inputString: string) => {
      queryLog.push(inputString);
      return actual.getRecordsByInputString(inputString);
    },
  };
});

const { resolveIdentifier, getCachedRecord, invalidateCachedRecord } = await import(
  "./metadata-hover"
);

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
});

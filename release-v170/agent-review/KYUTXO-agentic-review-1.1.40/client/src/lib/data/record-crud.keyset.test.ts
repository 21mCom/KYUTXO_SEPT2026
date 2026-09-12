// @vitest-environment jsdom
//
// Keyset (cursor) pagination correctness tests for the Records page.
//
// These exercise the real Dexie engine (via fake-indexeddb) to verify that the
// id-exclusive boundary helpers in record-crud.ts return exactly the same rows
// as the legacy O(offset) helpers, page for page, across the simple Records
// branches (all, all+tier-exclude, single-type, single-type+tier-exclude).

import "fake-indexeddb/auto";

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type { Record as DbRecord } from "@/lib/database";

class TestDb extends Dexie {
  records!: Table<DbRecord, number>;
  constructor(name: string) {
    super(name);
    // Mirrors the records schema indexes used by the keyset helpers.
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

const testDb = new TestDb(`KYUTXO-keyset-${Date.now()}-${Math.random()}`);

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return { ...actual, db: testDb };
});

const {
  getRecordsPageByIdReverse,
  getRecordsPageByIdReverseKeyset,
  getAddressRecordsByImportanceTierLimited,
  getAddressRecordsByImportanceTierPage,
  getRecordsPageByTypeIdReverse,
  getRecordsPageByTypeIdReverseKeyset,
  getRecordsByTypeAndImportanceLimited,
  getRecordsPageByTypeAndImportanceTiersKeyset,
} = await import("./record-crud");

const USER_CURATED_TIERS = [
  "verified",
  "manual",
  "wallet-import",
  "xpub-derived",
] as const;

// ---- Fixture ---------------------------------------------------------------

const TIERS = [
  "verified",
  "manual",
  "wallet-import",
  "xpub-derived",
  "blockchain-discovered",
  "pending-review",
] as const;

function mkRecord(i: number): DbRecord {
  const inputString = `addr-${String(i).padStart(5, "0")}`;
  return {
    type: i % 3 === 0 ? "transaction" : "address",
    inputString,
    inputStringLower: inputString.toLowerCase(),
    label: `label-${i}`,
    notes: undefined,
    tags: [],
    categories: [],
    owner: undefined,
    walletName: undefined,
    seedName: undefined,
    walletSoftware: undefined,
    // Spread across all six tiers so both the include and exclude paths have
    // interleaved ids (the exclude path must skip blockchain/pending rows).
    addressImportance: TIERS[i % TIERS.length],
    createdAt: 1000 + i,
    updatedAt: 1000 + i,
  } as unknown as DbRecord;
}

const TOTAL = 230;
const PAGE_SIZE = 50;

beforeAll(async () => {
  const rows = Array.from({ length: TOTAL }, (_, idx) => mkRecord(idx + 1));
  await testDb.records.bulkAdd(rows);
});

afterAll(async () => {
  testDb.close();
  await Dexie.delete(testDb.name);
});

// Replicates the Records.tsx merge: flatten id-desc tier streams, dedupe by id,
// sort desc, take top `limit`.
function mergeTopRecordsById(groups: DbRecord[][], limit: number): DbRecord[] {
  const seen = new Set<number>();
  const merged: DbRecord[] = [];
  for (const group of groups) {
    for (const r of group) {
      const id = r.id as number;
      if (typeof id === "number" && !seen.has(id)) {
        seen.add(id);
        merged.push(r);
      }
    }
  }
  merged.sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
  return merged.slice(0, limit);
}

const ids = (rows: DbRecord[]) => rows.map((r) => r.id as number);

describe("keyset pagination: exclusive id bounds", () => {
  it("page 1 (no boundary) returns the highest ids, id-descending", async () => {
    const page = await getRecordsPageByIdReverseKeyset({ limit: PAGE_SIZE });
    expect(page).toHaveLength(PAGE_SIZE);
    expect(ids(page)[0]).toBe(TOTAL);
    expect(ids(page)).toEqual([...ids(page)].sort((a, b) => b - a));
  });

  it("beforeIdExclusive excludes the boundary id itself", async () => {
    const boundary = 100;
    const page = await getRecordsPageByIdReverseKeyset({
      limit: PAGE_SIZE,
      beforeIdExclusive: boundary,
    });
    expect(ids(page)).not.toContain(boundary);
    expect(Math.max(...ids(page))).toBe(boundary - 1);
  });
});

describe("keyset == offset, page for page", () => {
  it("all records (id-reverse)", async () => {
    let beforeId: number | undefined = undefined;
    for (let page = 1; page <= Math.ceil(TOTAL / PAGE_SIZE); page++) {
      const offsetRows = await getRecordsPageByIdReverse(
        (page - 1) * PAGE_SIZE,
        PAGE_SIZE,
      );
      const keysetRows =
        page === 1
          ? await getRecordsPageByIdReverseKeyset({ limit: PAGE_SIZE })
          : await getRecordsPageByIdReverseKeyset({
              limit: PAGE_SIZE,
              beforeIdExclusive: beforeId,
            });
      expect(ids(keysetRows)).toEqual(ids(offsetRows));
      if (keysetRows.length > 0) {
        beforeId = keysetRows[keysetRows.length - 1].id as number;
      }
    }
  });

  it("single type filter (id-reverse)", async () => {
    const type = "address";
    let beforeId: number | undefined = undefined;
    for (let page = 1; page <= 5; page++) {
      const offsetRows = await getRecordsPageByTypeIdReverse(
        type,
        (page - 1) * PAGE_SIZE,
        PAGE_SIZE,
      );
      const keysetRows =
        page === 1
          ? await getRecordsPageByTypeIdReverseKeyset(type, { limit: PAGE_SIZE })
          : await getRecordsPageByTypeIdReverseKeyset(type, {
              limit: PAGE_SIZE,
              beforeIdExclusive: beforeId,
            });
      expect(ids(keysetRows)).toEqual(ids(offsetRows));
      if (keysetRows.length === 0) break;
      beforeId = keysetRows[keysetRows.length - 1].id as number;
    }
  });

  it("all records, user-curated tiers only (merge)", async () => {
    let beforeId: number | undefined = undefined;
    for (let page = 1; page <= 5; page++) {
      // Legacy offset path: over-fetch offset+PAGE_SIZE per tier, merge, slice.
      const offsetGroups = await Promise.all(
        USER_CURATED_TIERS.map((tier) =>
          getAddressRecordsByImportanceTierLimited(
            tier,
            (page - 1) * PAGE_SIZE + PAGE_SIZE,
          ),
        ),
      );
      const offsetRows = offsetGroups
        .flat()
        .sort((a, b) => (b.id ?? 0) - (a.id ?? 0))
        .slice((page - 1) * PAGE_SIZE, (page - 1) * PAGE_SIZE + PAGE_SIZE);

      // Keyset path: PAGE_SIZE per tier below the boundary, merge top PAGE_SIZE.
      const keysetGroups = await Promise.all(
        USER_CURATED_TIERS.map((tier) =>
          getAddressRecordsByImportanceTierPage(tier, {
            limit: PAGE_SIZE,
            beforeIdExclusive: beforeId,
          }),
        ),
      );
      const keysetRows = mergeTopRecordsById(keysetGroups, PAGE_SIZE);

      expect(ids(keysetRows)).toEqual(ids(offsetRows));
      // Only user-curated tiers should appear.
      for (const r of keysetRows) {
        expect(USER_CURATED_TIERS).toContain(r.addressImportance);
      }
      if (keysetRows.length === 0) break;
      beforeId = keysetRows[keysetRows.length - 1].id as number;
    }
  });

  it("single type filter, user-curated tiers only", async () => {
    const type = "address";
    let beforeId: number | undefined = undefined;
    for (let page = 1; page <= 5; page++) {
      const offsetGroups = await Promise.all(
        USER_CURATED_TIERS.map((tier) =>
          getRecordsByTypeAndImportanceLimited(
            type,
            tier,
            (page - 1) * PAGE_SIZE + PAGE_SIZE,
          ),
        ),
      );
      const offsetRows = offsetGroups
        .flat()
        .sort((a, b) => (b.id ?? 0) - (a.id ?? 0))
        .slice((page - 1) * PAGE_SIZE, (page - 1) * PAGE_SIZE + PAGE_SIZE);

      const keysetRows = await getRecordsPageByTypeAndImportanceTiersKeyset(
        type,
        [...USER_CURATED_TIERS],
        page === 1
          ? { limit: PAGE_SIZE }
          : { limit: PAGE_SIZE, beforeIdExclusive: beforeId },
      );

      expect(ids(keysetRows)).toEqual(ids(offsetRows));
      for (const r of keysetRows) {
        expect(r.type).toBe(type);
        expect(USER_CURATED_TIERS).toContain(r.addressImportance);
      }
      if (keysetRows.length === 0) break;
      beforeId = keysetRows[keysetRows.length - 1].id as number;
    }
  });
});

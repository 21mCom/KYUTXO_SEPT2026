// @vitest-environment jsdom
//
// Records screen read-path equivalence (Task #280).
//
// The Records page has two interchangeable read paths for the same query:
//   1. the native SQLite read engine (engine-core, better-sqlite3), used when
//      the desktop mirror is READY + CURRENT, and
//   2. the always-correct Dexie path (record-crud keyset/tier helpers and the
//      records-query collection builder), used everywhere else.
//
// Records.tsx reconciles them so the user sees identical results regardless of
// which path served the page. This suite seeds ONE known dataset into both
// engines and asserts, for every engine-expressible query shape, that the two
// paths agree on:
//   - the page rows' ids AND order,
//   - the visible total (totalCount),
//   - the navigable count (navigableCount), and
//   - the hidden blockchain-discovered badge (totalBlockchainDiscovered).
//
// Query shapes covered (the ones the engine can express, per Records.tsx):
//   - default view (no filters), include + exclude blockchain-discovered,
//   - single type-equals filter, include + exclude, and
//   - cross-field substring search, include + exclude.
//
// fake-indexeddb/auto backs the real Dexie engine; @/lib/database is mocked to a
// throwaway TestDb so the record-crud / records-query helpers read from it.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type { Record as DbRecord } from "@/lib/database";

import {
  createSchema,
  insertRecords,
  getRecordPage,
  countRecords as engineCountRecords,
  type RecordRow,
} from "../engine-core";
import { createInMemoryEngineDb } from "../better-sqlite3-adapter";

// ---------------------------------------------------------------------------
// Dexie test database (mirror of the records schema indexes Records.tsx uses)
// ---------------------------------------------------------------------------

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

const testDb = new TestDb(`KYUTXO-read-equiv-${Date.now()}-${Math.random()}`);

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return { ...actual, db: testDb };
});

// Imported after the mock is registered so they bind to the TestDb.
const {
  countRecords,
  countBlockchainDiscovered,
  countRecordsByType,
  countRecordsByTypeAndImportanceTiers,
  getRecordsPageByIdReverseKeyset,
  getAddressRecordsByImportanceTierPage,
  getRecordsPageByTypeIdReverseKeyset,
  getRecordsPageByTypeAndImportanceTiersKeyset,
} = await import("../../data/record-crud");

const { buildRecordsCollection, fetchRecordsPage } = await import(
  "../../records-query"
);

// USER_CURATED_TIERS as Records.tsx uses it for the exclude paths.
const USER_CURATED_TIERS = [
  "verified",
  "manual",
  "wallet-import",
  "xpub-derived",
] as const;

const ALL_TIERS = [
  "verified",
  "manual",
  "wallet-import",
  "xpub-derived",
  "blockchain-discovered",
  "pending-review",
] as const;

const PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Fixture: a single source of truth, materialized into BOTH engines.
//
// Constraints that keep the two paths comparable:
//   - every row has a real id and one of the six known tiers (never null), so
//     the engine's "NOT IN (discovered, pending)" exclude is exactly the Dexie
//     "anyOf(USER_CURATED_TIERS)" exclude, and
//   - text fields are populated so the substring search hits across multiple
//     fields (label / inputString / owner / walletName / notes).
// ---------------------------------------------------------------------------

interface Fixture {
  id: number;
  type: string;
  inputString: string;
  label: string | null;
  owner: string | null;
  walletName: string | null;
  notes: string | null;
  addressImportance: string;
}

const TOTAL = 130;

function makeFixture(i: number): Fixture {
  const inputString = `addr-${String(i).padStart(5, "0")}`;
  return {
    id: i,
    type: i % 4 === 0 ? "transaction" : "address",
    inputString,
    label: i % 2 === 0 ? `Alpha label ${i}` : `Beta label ${i}`,
    owner: i % 5 === 0 ? "Satoshi" : null,
    // Two non-null variants that both contain "wallet", plus a null hole, so
    // the "wallet" search is broad (paging) but not literally everything.
    walletName: i % 7 === 0 ? null : i % 3 === 0 ? "ColdWallet" : "HotWallet",
    notes: i % 11 === 0 ? `note mentioning alpha ${i}` : null,
    addressImportance: ALL_TIERS[i % ALL_TIERS.length],
  };
}

const FIXTURES: Fixture[] = Array.from({ length: TOTAL }, (_, idx) =>
  makeFixture(idx + 1),
);

function toEngineRow(f: Fixture): RecordRow {
  return {
    id: f.id,
    type: f.type,
    inputString: f.inputString,
    inputStringLower: f.inputString.toLowerCase(),
    label: f.label,
    notes: f.notes,
    owner: f.owner,
    walletName: f.walletName,
    seedName: null,
    walletSoftware: null,
    addressImportance: f.addressImportance,
    chainType: null,
    syncDepth: null,
    firstSeenBlockTime: null,
    cachedBalanceSats: null,
    cachedTxCount: null,
    cachedUtxoCount: null,
    statsComputedAt: null,
    createdAt: 1000 + f.id,
    updatedAt: 1000 + f.id,
    tags: "[]",
    categories: "[]",
  };
}

function toDexieRow(f: Fixture): DbRecord {
  return {
    id: f.id,
    type: f.type,
    inputString: f.inputString,
    inputStringLower: f.inputString.toLowerCase(),
    label: f.label ?? undefined,
    notes: f.notes ?? undefined,
    owner: f.owner ?? undefined,
    walletName: f.walletName ?? undefined,
    seedName: undefined,
    walletSoftware: undefined,
    tags: [],
    categories: [],
    addressImportance: f.addressImportance,
    createdAt: 1000 + f.id,
    updatedAt: 1000 + f.id,
  } as unknown as DbRecord;
}

const engine = createInMemoryEngineDb();

beforeAll(async () => {
  createSchema(engine);
  insertRecords(engine, FIXTURES.map(toEngineRow));
  await testDb.records.bulkAdd(FIXTURES.map(toDexieRow));
});

afterAll(async () => {
  engine.close?.();
  testDb.close();
  await Dexie.delete(testDb.name);
});

// ---------------------------------------------------------------------------
// Reconciliation replicas: compute the four observable values for each path,
// mirroring Records.tsx exactly.
// ---------------------------------------------------------------------------

const ids = (rows: { id?: number | null }[]) => rows.map((r) => r.id as number);

// Records.tsx mergeTopRecordsById: flatten id-desc tier streams, dedupe, sort
// id-desc, take top `limit`.
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

// Residual predicate identical to Records.tsx filterFn (no column filters here;
// the type filter is expressed via the dedicated branch / engine option).
function makeFilterFn(search: string, includeBlockchainDiscovered: boolean) {
  const s = search.toLowerCase().trim();
  return (record: DbRecord): boolean => {
    if (!includeBlockchainDiscovered) {
      if (
        record.addressImportance === "blockchain-discovered" ||
        record.addressImportance === "pending-review"
      ) {
        return false;
      }
    }
    if (s) {
      if (
        !(
          record.label?.toLowerCase().includes(s) ||
          record.inputString?.toLowerCase().includes(s) ||
          record.owner?.toLowerCase().includes(s) ||
          record.walletName?.toLowerCase().includes(s) ||
          record.notes?.toLowerCase().includes(s)
        )
      ) {
        return false;
      }
    }
    return true;
  };
}

interface Observed {
  pageIds: number[];
  totalCount: number;
  navigableCount: number;
  hiddenBadge: number;
}

// --- Engine path (Records.tsx useEngine branch) ----------------------------

function engineObserved(opts: {
  includeBlockchainDiscovered: boolean;
  type?: string;
  search?: string;
  beforeId?: number;
}): Observed {
  const engineOpts = {
    includeBlockchainDiscovered: opts.includeBlockchainDiscovered,
    type: opts.type,
    search: opts.search,
  };
  const pageRows = getRecordPage(engine, {
    ...engineOpts,
    beforeId: opts.beforeId,
    limit: PAGE_SIZE,
  });
  const visible = engineCountRecords(engine, engineOpts);
  const all = engineCountRecords(engine, { includeBlockchainDiscovered: true });
  const nonDiscovered = engineCountRecords(engine, {
    includeBlockchainDiscovered: false,
  });
  return {
    pageIds: ids(pageRows),
    totalCount: visible,
    navigableCount: visible,
    hiddenBadge: Math.max(0, all - nonDiscovered),
  };
}

// --- Dexie path: default view (no filters) ---------------------------------

async function dexieDefaultObserved(
  includeBlockchainDiscovered: boolean,
  beforeIdExclusive?: number,
): Promise<Observed> {
  let pageRows: DbRecord[];
  if (includeBlockchainDiscovered) {
    pageRows = await getRecordsPageByIdReverseKeyset({
      limit: PAGE_SIZE,
      beforeIdExclusive,
    });
  } else {
    const pageGroups = await Promise.all(
      USER_CURATED_TIERS.map((tier) =>
        getAddressRecordsByImportanceTierPage(tier, {
          limit: PAGE_SIZE,
          beforeIdExclusive,
        }),
      ),
    );
    pageRows = mergeTopRecordsById(pageGroups, PAGE_SIZE);
  }

  const all = await countRecords();
  const blockchain = await countBlockchainDiscovered();
  const visible = includeBlockchainDiscovered ? all : Math.max(0, all - blockchain);
  return {
    pageIds: ids(pageRows),
    totalCount: visible,
    navigableCount: visible,
    hiddenBadge: blockchain,
  };
}

// --- Dexie path: single type-equals filter (no search) ---------------------

async function dexieTypeObserved(
  type: string,
  includeBlockchainDiscovered: boolean,
  beforeIdExclusive?: number,
): Promise<Observed> {
  let pageRows: DbRecord[];
  if (includeBlockchainDiscovered) {
    pageRows = await getRecordsPageByTypeIdReverseKeyset(type, {
      limit: PAGE_SIZE,
      beforeIdExclusive,
    });
  } else {
    pageRows = await getRecordsPageByTypeAndImportanceTiersKeyset(
      type,
      [...USER_CURATED_TIERS],
      { limit: PAGE_SIZE, beforeIdExclusive },
    );
  }

  const visible = includeBlockchainDiscovered
    ? await countRecordsByType(type)
    : await countRecordsByTypeAndImportanceTiers(type, [...USER_CURATED_TIERS]);
  const blockchain = await countBlockchainDiscovered();
  return {
    pageIds: ids(pageRows),
    totalCount: visible,
    navigableCount: visible,
    hiddenBadge: blockchain,
  };
}

// --- Dexie path: cross-field substring search (no column filters) -----------

async function dexieSearchObserved(
  search: string,
  includeBlockchainDiscovered: boolean,
  pgOffset: number,
): Promise<Observed> {
  const built = buildRecordsCollection(
    { search, columnFilters: [], includeBlockchainDiscovered },
    makeFilterFn(search, includeBlockchainDiscovered),
  );
  const page = await fetchRecordsPage(built, pgOffset, PAGE_SIZE, () => false);
  if (page === null) throw new Error("fetchRecordsPage returned null");
  const blockchain = await countBlockchainDiscovered();
  return {
    pageIds: ids(page.records),
    totalCount: page.total,
    navigableCount: page.effectiveTotal,
    hiddenBadge: blockchain,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Records read-path equivalence: engine vs Dexie", () => {
  it("fixture seeded into both engines with identical counts", async () => {
    expect(engineCountRecords(engine, { includeBlockchainDiscovered: true })).toBe(
      TOTAL,
    );
    expect(await countRecords()).toBe(TOTAL);
  });

  describe("default view (no filters)", () => {
    for (const include of [true, false]) {
      const label = include ? "include" : "exclude";
      it(`page 1 matches (${label} blockchain-discovered)`, async () => {
        const eng = engineObserved({ includeBlockchainDiscovered: include });
        const dex = await dexieDefaultObserved(include);
        expect(eng).toEqual(dex);
        // Sanity: page is full and strictly id-descending.
        expect(eng.pageIds).toHaveLength(PAGE_SIZE);
        expect(eng.pageIds).toEqual([...eng.pageIds].sort((a, b) => b - a));
      });

      it(`page 2 (keyset boundary) matches (${label})`, async () => {
        const p1 = await dexieDefaultObserved(include);
        const boundary = p1.pageIds[p1.pageIds.length - 1];
        const eng = engineObserved({
          includeBlockchainDiscovered: include,
          beforeId: boundary,
        });
        const dex = await dexieDefaultObserved(include, boundary);
        expect(eng.pageIds).toEqual(dex.pageIds);
        expect(Math.max(...eng.pageIds)).toBeLessThan(boundary);
      });
    }
  });

  describe("single type-equals filter", () => {
    for (const type of ["address", "transaction"]) {
      for (const include of [true, false]) {
        const label = include ? "include" : "exclude";
        it(`type=${type} page 1 matches (${label})`, async () => {
          const eng = engineObserved({
            type,
            includeBlockchainDiscovered: include,
          });
          const dex = await dexieTypeObserved(type, include);
          expect(eng).toEqual(dex);
          // Engine page must contain only the requested type.
          const rows = getRecordPage(engine, {
            type,
            includeBlockchainDiscovered: include,
            limit: PAGE_SIZE,
          });
          expect(rows.every((r) => r.type === type)).toBe(true);
        });

        it(`type=${type} page 2 (keyset boundary) matches (${label})`, async () => {
          const p1 = await dexieTypeObserved(type, include);
          if (p1.pageIds.length < PAGE_SIZE) return; // single page, nothing to compare
          const boundary = p1.pageIds[p1.pageIds.length - 1];
          const eng = engineObserved({
            type,
            includeBlockchainDiscovered: include,
            beforeId: boundary,
          });
          const dex = await dexieTypeObserved(type, include, boundary);
          expect(eng.pageIds).toEqual(dex.pageIds);
        });
      }
    }
  });

  describe("cross-field substring search", () => {
    // 'wallet' is broad (hits walletName across many rows) so paging matters;
    // 'satoshi' (owner) and 'alpha' (label + notes) are narrower cross-field
    // hits that still exceed/approach a page.
    for (const search of ["wallet", "satoshi", "alpha"]) {
      for (const include of [true, false]) {
        const label = include ? "include" : "exclude";
        it(`search="${search}" page 1 matches (${label})`, async () => {
          const eng = engineObserved({
            search,
            includeBlockchainDiscovered: include,
          });
          const dex = await dexieSearchObserved(search, include, 0);
          expect(eng).toEqual(dex);
        });

        it(`search="${search}" page 2 matches (${label})`, async () => {
          const dex1 = await dexieSearchObserved(search, include, 0);
          if (dex1.pageIds.length < PAGE_SIZE) return; // single page
          const boundary = dex1.pageIds[dex1.pageIds.length - 1];
          // Engine paginates page 2 via the keyset boundary (Records.tsx engine
          // branch); Dexie search paginates by offset. Both yield id-desc rows,
          // so the resulting id windows must be identical.
          const eng = engineObserved({
            search,
            includeBlockchainDiscovered: include,
            beforeId: boundary,
          });
          const dex2 = await dexieSearchObserved(search, include, PAGE_SIZE);
          expect(eng.pageIds).toEqual(dex2.pageIds);
        });
      }
    }
  });
});

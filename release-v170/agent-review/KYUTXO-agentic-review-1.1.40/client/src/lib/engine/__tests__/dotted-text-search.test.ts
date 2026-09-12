// @vitest-environment jsdom
//
// Dots in user text fields — search/filter regression guard.
//
// Users can type "." into every free-text field (label, wallet name, owner,
// notes, tags). Storage and search handle dots safely by design — the engine's
// SQL LIKE treats "." literally (only % and _ are wildcards) and the Dexie
// path uses plain String.includes — but nothing pinned that behavior. This
// suite seeds records whose text fields contain dots (including a trailing
// dot) into BOTH read paths and asserts:
//   - a dotted search term matches the dotted record on both paths,
//   - the dot does NOT behave as a single-character wildcard on either path
//     (a "v1.2" search must not match "v1x2"), and
//   - both paths agree on ids for every dotted query (equivalence).
// Tag search (Dexie-only surface: searchRecordsByQuery) is covered separately
// since the engine's cross-field search does not include tags.
//
// fake-indexeddb/auto backs the real Dexie engine; @/lib/database is mocked to
// a throwaway TestDb, mirroring records-read-equivalence.test.ts.

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

const testDb = new TestDb(`KYUTXO-dotted-search-${Date.now()}-${Math.random()}`);

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return { ...actual, db: testDb };
});

const { searchRecordsByQuery } = await import("../../data/record-crud");
const { buildRecordsCollection, fetchRecordsPage } = await import(
  "../../records-query"
);

// ---------------------------------------------------------------------------
// Fixture: dotted values in every searched field, plus near-miss decoys that
// would FALSELY match if the dot ever acted as a single-char wildcard.
// ---------------------------------------------------------------------------

interface Fixture {
  id: number;
  inputString: string;
  label: string | null;
  owner: string | null;
  walletName: string | null;
  notes: string | null;
  tags: string[];
}

const FIXTURES: Fixture[] = [
  // 1: dotted label (interior dots)
  { id: 1, inputString: "addr-00001", label: "Ledger v1.2", owner: null, walletName: null, notes: null, tags: [] },
  // 2: wildcard decoy for "v1.2" — matches only if "." acts like SQL "_" / regex "."
  { id: 2, inputString: "addr-00002", label: "Ledger v1x2", owner: null, walletName: null, notes: null, tags: [] },
  // 3: dotted wallet name
  { id: 3, inputString: "addr-00003", label: "plain", owner: null, walletName: "cold.storage", notes: null, tags: [] },
  // 4: wildcard decoy for "cold.storage"
  { id: 4, inputString: "addr-00004", label: "plain", owner: null, walletName: "coldXstorage", notes: null, tags: [] },
  // 5: dotted owner with a TRAILING dot
  { id: 5, inputString: "addr-00005", label: "plain", owner: "Alice.", walletName: null, notes: null, tags: [] },
  // 6: decoy owner without the trailing dot context ("AliceX" ≠ "Alice.")
  { id: 6, inputString: "addr-00006", label: "plain", owner: "AliceX", walletName: null, notes: null, tags: [] },
  // 7: dotted notes
  { id: 7, inputString: "addr-00007", label: "plain", owner: null, walletName: null, notes: "migrated from wallet.dat backup", tags: [] },
  // 8: dotted tag (Dexie searchRecordsByQuery surface)
  { id: 8, inputString: "addr-00008", label: "plain", owner: null, walletName: null, notes: null, tags: ["kyc.done"] },
  // 9: tag decoy
  { id: 9, inputString: "addr-00009", label: "plain", owner: null, walletName: null, notes: null, tags: ["kycXdone"] },
];

function toEngineRow(f: Fixture): RecordRow {
  return {
    id: f.id,
    type: "address",
    inputString: f.inputString,
    inputStringLower: f.inputString.toLowerCase(),
    label: f.label,
    notes: f.notes,
    owner: f.owner,
    walletName: f.walletName,
    seedName: null,
    walletSoftware: null,
    addressImportance: "manual",
    chainType: null,
    syncDepth: null,
    firstSeenBlockTime: null,
    cachedBalanceSats: null,
    cachedTxCount: null,
    cachedUtxoCount: null,
    statsComputedAt: null,
    createdAt: 1000 + f.id,
    updatedAt: 1000 + f.id,
    tags: JSON.stringify(f.tags),
    categories: "[]",
  };
}

function toDexieRow(f: Fixture): DbRecord {
  return {
    id: f.id,
    type: "address",
    inputString: f.inputString,
    inputStringLower: f.inputString.toLowerCase(),
    label: f.label ?? "",
    notes: f.notes ?? undefined,
    owner: f.owner ?? undefined,
    walletName: f.walletName ?? undefined,
    tags: f.tags,
    categories: [],
    addressImportance: "manual",
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
// Path replicas (mirroring Records.tsx / records-read-equivalence.test.ts)
// ---------------------------------------------------------------------------

const ids = (rows: { id?: number | null }[]) =>
  rows.map((r) => r.id as number).sort((a, b) => a - b);

function engineSearchIds(search: string): number[] {
  const rows = getRecordPage(engine, {
    search,
    includeBlockchainDiscovered: true,
    limit: 50,
  });
  return ids(rows);
}

function makeFilterFn(search: string) {
  const s = search.toLowerCase().trim();
  return (record: DbRecord): boolean =>
    !s ||
    Boolean(
      record.label?.toLowerCase().includes(s) ||
        record.inputString?.toLowerCase().includes(s) ||
        record.owner?.toLowerCase().includes(s) ||
        record.walletName?.toLowerCase().includes(s) ||
        record.notes?.toLowerCase().includes(s),
    );
}

async function dexieSearchIds(search: string): Promise<number[]> {
  const built = buildRecordsCollection(
    { search, columnFilters: [], includeBlockchainDiscovered: true },
    makeFilterFn(search),
  );
  const page = await fetchRecordsPage(built, 0, 50, () => false);
  if (page === null) throw new Error("fetchRecordsPage returned null");
  return ids(page.records);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dotted text fields: search matches literally on both read paths", () => {
  const CASES: Array<{ field: string; search: string; expected: number[] }> = [
    // Dot must match only the literal dotted value, never the "x" decoy.
    { field: "label", search: "v1.2", expected: [1] },
    { field: "walletName", search: "cold.storage", expected: [3] },
    { field: "owner (trailing dot)", search: "alice.", expected: [5] },
    { field: "notes", search: "wallet.dat", expected: [7] },
    // A bare-dot search matches every record containing a dot anywhere — and
    // nothing else (proves "." is not a match-anything wildcard on the SQL path).
    { field: "bare dot", search: ".", expected: [1, 3, 5, 7] },
  ];

  for (const { field, search, expected } of CASES) {
    it(`engine path: search "${search}" (${field}) matches literally`, () => {
      expect(engineSearchIds(search)).toEqual(expected);
      expect(
        engineCountRecords(engine, { search, includeBlockchainDiscovered: true }),
      ).toBe(expected.length);
    });

    it(`Dexie path: search "${search}" (${field}) matches literally`, async () => {
      expect(await dexieSearchIds(search)).toEqual(expected);
    });

    it(`paths agree for search "${search}" (${field})`, async () => {
      expect(engineSearchIds(search)).toEqual(await dexieSearchIds(search));
    });
  }

  it("dotted tag matches via searchRecordsByQuery without wildcarding (Dexie tag surface)", async () => {
    const hits = await searchRecordsByQuery("kyc.done");
    expect(hits.map((r) => r.id)).toEqual([8]);
  });

  it("dotted values round-trip storage unchanged on both paths", async () => {
    const dexieRow = await testDb.records.get(5);
    expect(dexieRow?.owner).toBe("Alice.");
    const engineRow = getRecordPage(engine, {
      search: "alice.",
      includeBlockchainDiscovered: true,
      limit: 1,
    })[0];
    expect(engineRow?.owner).toBe("Alice.");
  });
});

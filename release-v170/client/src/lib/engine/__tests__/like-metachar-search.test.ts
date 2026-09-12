// @vitest-environment jsdom
//
// LIKE metacharacters (% and _) in search — engine/Dexie equivalence guard.
//
// The engine's SQL read path builds its cross-field search as
// `LIKE '%'+term+'%'`. Without escaping, a user-typed "%" or "_" acts as a
// SQL wildcard on the engine path (large/desktop vaults) while the Dexie path
// (String.includes) matches it literally — the two read paths would return
// DIFFERENT results for the same query, and a bare "%" would secretly match
// everything. buildRecordWhere now escapes %, _ and the escape char and binds
// with `LIKE ? ESCAPE '\'`. This suite seeds records whose text fields contain
// % / _ / \ (plus decoys that would FALSELY match if the metacharacters were
// still live wildcards) into BOTH read paths and asserts:
//   - a %/_ search term matches only the literal record on both paths,
//   - "%" is NOT a match-anything wildcard and "_" is NOT a single-char
//     wildcard on the engine path, and
//   - both paths agree on ids for every query (equivalence).
//
// fake-indexeddb/auto backs the real Dexie engine; @/lib/database is mocked to
// a throwaway TestDb, mirroring dotted-text-search.test.ts.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type { Record as DbRecord } from "@/lib/database";

import {
  createSchema,
  insertRecords,
  getRecordPage,
  countRecords as engineCountRecords,
  getVaultSummaries,
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

const testDb = new TestDb(`KYUTXO-like-metachar-${Date.now()}-${Math.random()}`);

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return { ...actual, db: testDb };
});

const { buildRecordsCollection, fetchRecordsPage } = await import(
  "../../records-query"
);

// ---------------------------------------------------------------------------
// Fixture: %/_/\ values in searched fields, plus decoys that would FALSELY
// match if % or _ were still live LIKE wildcards.
// ---------------------------------------------------------------------------

interface Fixture {
  id: number;
  inputString: string;
  label: string | null;
  owner: string | null;
  walletName: string | null;
  notes: string | null;
}

const FIXTURES: Fixture[] = [
  // 1: literal percent in label
  { id: 1, inputString: "addr-00001", label: "fee 5% rebate", owner: null, walletName: null, notes: null },
  // 2: wildcard decoy for "5%" — matches only if % still wildcards ("5X" then "5%..." pattern "5%" would match "5X rebate")
  { id: 2, inputString: "addr-00002", label: "fee 5X rebate", owner: null, walletName: null, notes: null },
  // 3: literal underscore in wallet name
  { id: 3, inputString: "addr-00003", label: "plain", owner: null, walletName: "cold_storage", notes: null },
  // 4: single-char-wildcard decoy for "cold_storage"
  { id: 4, inputString: "addr-00004", label: "plain", owner: null, walletName: "coldXstorage", notes: null },
  // 5: literal backslash in owner (the escape char itself)
  { id: 5, inputString: "addr-00005", label: "plain", owner: "acct\\legacy", walletName: null, notes: null },
  // 6: decoy owner without the backslash
  { id: 6, inputString: "addr-00006", label: "plain", owner: "acctXlegacy", walletName: null, notes: null },
  // 7: literal "100%_done" in notes (both metachars adjacent)
  { id: 7, inputString: "addr-00007", label: "plain", owner: null, walletName: null, notes: "migration 100%_done today" },
  // 8: decoy for "100%_done" ("100XYdone" matches pattern %100%_done% if unescaped)
  { id: 8, inputString: "addr-00008", label: "plain", owner: null, walletName: null, notes: "migration 100abcXdone today" },
  // 9: plain record with NO metacharacters anywhere — the victim a bare "%"
  //    search would secretly match on an unescaped engine path
  { id: 9, inputString: "addr-00009", label: "totally plain", owner: "Bob", walletName: "hot", notes: "nothing special" },
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
    tags: "[]",
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
    tags: [],
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
// Path replicas (mirroring Records.tsx / dotted-text-search.test.ts)
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

describe("LIKE metacharacters in search match literally on both read paths", () => {
  const CASES: Array<{ field: string; search: string; expected: number[] }> = [
    // % must match only the literal-percent record, never the "5X" decoy.
    { field: "label with %", search: "5% rebate", expected: [1] },
    // _ must match only the literal-underscore record, never the single-char decoy.
    { field: "walletName with _", search: "cold_storage", expected: [3] },
    // The escape char itself must round-trip.
    { field: "owner with backslash", search: "acct\\legacy", expected: [5] },
    // Both metachars adjacent.
    { field: "notes with %_", search: "100%_done", expected: [7] },
    // A bare "%" matches only records literally containing "%" — NOT everything.
    { field: "bare percent", search: "%", expected: [1, 7] },
    // A bare "_" matches only records literally containing "_".
    { field: "bare underscore", search: "_", expected: [3, 7] },
    // A bare "\" matches only the literal-backslash record.
    { field: "bare backslash", search: "\\", expected: [5] },
    // "%%" would match everything if unescaped; literally it matches nothing.
    { field: "double percent", search: "%%", expected: [] },
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

  it("metachar values round-trip storage unchanged on both paths", async () => {
    const dexieRow = await testDb.records.get(5);
    expect(dexieRow?.owner).toBe("acct\\legacy");
    const engineRow = getRecordPage(engine, {
      search: "acct\\legacy",
      includeBlockchainDiscovered: true,
      limit: 1,
    })[0];
    expect(engineRow?.owner).toBe("acct\\legacy");
  });
});

describe("getVaultSummaries search escapes LIKE metacharacters", () => {
  const vaultEngine = createInMemoryEngineDb();

  beforeAll(() => {
    createSchema(vaultEngine);
    const base = (id: number, vaultName: string): RecordRow =>
      ({
        ...toEngineRow({
          id,
          inputString: `vault-addr-${id}`,
          label: null,
          owner: null,
          walletName: null,
          notes: null,
        }),
        addressImportance: "verified",
        vaultName,
        vaultM: 2,
        vaultN: 3,
        vaultNotes: null,
        vaultIsVaultXpub: 1,
      }) as unknown as RecordRow;
    insertRecords(vaultEngine, [
      base(1, "family 100%_vault"),
      base(2, "family 100abcXvault"), // decoy if % / _ were wildcards
      base(3, "plain vault"),
    ]);
  });

  afterAll(() => {
    vaultEngine.close?.();
  });

  it("bare % matches only the literal-percent vault, not all vaults", () => {
    const rows = getVaultSummaries(vaultEngine, { search: "%" });
    expect(rows.map((r) => r.vaultName)).toEqual(["family 100%_vault"]);
  });

  it("%_ term skips the wildcard decoy", () => {
    const rows = getVaultSummaries(vaultEngine, { search: "100%_vault" });
    expect(rows.map((r) => r.vaultName)).toEqual(["family 100%_vault"]);
  });
});

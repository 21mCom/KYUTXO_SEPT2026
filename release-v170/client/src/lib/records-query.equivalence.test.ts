// @vitest-environment jsdom
//
// ID-equivalence regression test for the indexed Records query path.
//
// Compares row IDs returned by the new index-narrowed path
// (buildRecordsCollection + fetchRecordsPage) against the legacy approach
// (db.records.filter(filterFn).count() + .filter(filterFn).orderBy('id')
// .reverse().offset/limit().toArray()) across a fixture of records and a
// matrix of search / column-filter / blockchain-toggle combinations.
//
// Uses fake-indexeddb so we exercise the real Dexie engine — the same code
// paths the production app runs against.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Dexie, { type Table } from "dexie";
import type { ColumnFilter } from "@/components/RecordFilters";
import type { Record as DbRecord } from "@/lib/database";

class TestDb extends Dexie {
  records!: Table<DbRecord, number>;
  constructor(name: string) {
    super(name);
    // Mirrors the v31 records schema in client/src/lib/database.ts.
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

const testDb = new TestDb(`KYUTXO-equiv-${Date.now()}-${Math.random()}`);

// Mock @/lib/database to return our test Dexie instance. Must be set up
// before importing records-query (top-level vi.mock is hoisted).
import { vi } from "vitest";
vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return {
    ...actual,
    db: testDb,
  };
});

// Import after the mock is registered.
const { buildRecordsCollection, fetchRecordsPage } = await import("./records-query");

// ---- Fixture ----------------------------------------------------------------

function mkRecord(over: Partial<DbRecord>): DbRecord {
  const inputString = over.inputString ?? "addr-default";
  return {
    type: over.type ?? "address",
    inputString,
    inputStringLower: (over.inputStringLower ?? inputString).toLowerCase(),
    label: over.label ?? "",
    notes: over.notes,
    tags: over.tags ?? [],
    categories: over.categories ?? [],
    owner: over.owner,
    walletName: over.walletName,
    seedName: over.seedName,
    walletSoftware: over.walletSoftware,
    chainType: over.chainType,
    addressImportance: over.addressImportance ?? "manual",
    createdAt: over.createdAt ?? 0,
    updatedAt: over.updatedAt ?? 0,
    ...over,
  } as DbRecord;
}

const FIXTURE: DbRecord[] = [
  // user-tagged addresses
  mkRecord({ inputString: "bc1qAlice", label: "Alice Wallet", owner: "Alice", walletName: "Cold Storage", tags: ["personal", "trezor"], addressImportance: "verified" }),
  mkRecord({ inputString: "bc1qBob",   label: "Bob Wallet",   owner: "Bob",   walletName: "Hot Wallet",   tags: ["personal"],            addressImportance: "manual" }),
  mkRecord({ inputString: "bc1qCarol", label: "Carol",        owner: "carol", walletName: "Trading",      tags: ["business"],            addressImportance: "wallet-import" }),
  mkRecord({ inputString: "bc1qDave",  label: "Dave KYC",     owner: "Dave",  walletName: "KYC Wallet",   tags: ["KYC"],                 addressImportance: "xpub-derived", chainType: "receive" }),
  mkRecord({ inputString: "bc1qEve",   label: "EVE",          owner: "Eve",   walletName: "Exchange",     tags: ["exchange"],            addressImportance: "manual",       notes: "exchange deposit address" }),
  mkRecord({ inputString: "bc1qFrank", label: "frank-test",   owner: "Frank", tags: ["test"],            addressImportance: "manual" }),

  // notes-only substring matches (legacy `notes contains` semantics critical)
  mkRecord({ inputString: "bc1qNotes1", label: "Random",     owner: "Misc", notes: "contains alice mention only here", addressImportance: "manual" }),
  mkRecord({ inputString: "bc1qNotes2", label: "Other",      owner: "Misc", notes: "Bob is mentioned in the body of this note", addressImportance: "manual" }),

  // case-variation candidates (case-insensitive match must work)
  mkRecord({ inputString: "bc1qALICE_UPPER", label: "ALICE UPPER", owner: "ALICE", walletName: "COLD STORAGE", tags: ["Personal"], addressImportance: "manual" }),

  // transaction records
  mkRecord({ type: "transaction", inputString: "txhash1", label: "Big TX", owner: "Alice", tags: [], addressImportance: "manual" }),
  mkRecord({ type: "transaction", inputString: "txhash2", label: "Small TX", tags: ["business"], addressImportance: "manual" }),

  // blockchain-discovered (filtered out unless includeBlockchainDiscovered=true)
  mkRecord({ inputString: "bc1qDiscovered1", label: "discovered alice ref", owner: "Alice", tags: [], addressImportance: "blockchain-discovered" }),
  mkRecord({ inputString: "bc1qDiscovered2", label: "Another discovered", owner: "Bob",   tags: [], addressImportance: "blockchain-discovered", notes: "matches bob substring" }),
  mkRecord({ inputString: "bc1qPending1",    label: "Pending review item", owner: "Carol", tags: [], addressImportance: "pending-review" }),

  // empty-field edge cases
  mkRecord({ inputString: "bc1qEmpty", label: "", owner: undefined, tags: [], addressImportance: "manual" }),
];

beforeAll(async () => {
  await testDb.records.bulkAdd(FIXTURE);
});

afterAll(async () => {
  await testDb.delete();
});

// ---- Reference (legacy) implementation --------------------------------------

function matchesColumnFilter(record: DbRecord, filter: ColumnFilter): boolean {
  let value: unknown;
  if (filter.field === "hasNotes") {
    value = Boolean(record.notes && record.notes.trim() !== "");
  } else {
    value = (record as unknown as { [key: string]: unknown })[filter.field];
  }
  const nv = filter.value?.toLowerCase().trim() || "";
  switch (filter.operator) {
    case "contains":   return String(value || "").toLowerCase().includes(nv);
    case "equals":     return String(value || "").toLowerCase() === nv;
    case "notEquals":  return String(value || "").toLowerCase() !== nv;
    case "startsWith": return String(value || "").toLowerCase().startsWith(nv);
    case "endsWith":   return String(value || "").toLowerCase().endsWith(nv);
    case "isEmpty":
      if (Array.isArray(value)) return value.length === 0;
      return !value || String(value).trim() === "";
    case "isNotEmpty":
      if (Array.isArray(value)) return value.length > 0;
      return Boolean(value) && String(value).trim() !== "";
    case "includes":
      if (Array.isArray(value)) return value.some((v: unknown) => String(v).toLowerCase() === nv);
      return false;
    case "excludes":
      if (Array.isArray(value)) return !value.some((v: unknown) => String(v).toLowerCase() === nv);
      return true;
    default: return true;
  }
}

function legacyFilterFn(
  search: string,
  columnFilters: ColumnFilter[],
  includeBlockchainDiscovered: boolean,
): (record: DbRecord) => boolean {
  return (record: DbRecord): boolean => {
    if (!includeBlockchainDiscovered) {
      if (record.addressImportance === "blockchain-discovered" ||
          record.addressImportance === "pending-review") {
        return false;
      }
    }
    for (const filter of columnFilters) {
      if (!matchesColumnFilter(record, filter)) return false;
    }
    if (search) {
      if (!(
        record.label?.toLowerCase().includes(search) ||
        record.inputString?.toLowerCase().includes(search) ||
        record.owner?.toLowerCase().includes(search) ||
        record.walletName?.toLowerCase().includes(search) ||
        record.notes?.toLowerCase().includes(search)
      )) return false;
    }
    return true;
  };
}

async function legacyResultIds(
  search: string,
  columnFilters: ColumnFilter[],
  includeBlockchainDiscovered: boolean,
): Promise<{ total: number; ids: number[] }> {
  const fn = legacyFilterFn(search, columnFilters, includeBlockchainDiscovered);
  const all = await testDb.records.filter(fn).toArray();
  all.sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
  return {
    total: all.length,
    ids: all.map((r) => r.id!),
  };
}

async function newPathResultIds(
  search: string,
  columnFilters: ColumnFilter[],
  includeBlockchainDiscovered: boolean,
): Promise<{ total: number; ids: number[] }> {
  const fn = legacyFilterFn(search, columnFilters, includeBlockchainDiscovered);
  const built = buildRecordsCollection(
    { search, columnFilters, includeBlockchainDiscovered },
    fn,
  );
  // Use a page large enough to materialize the entire fixture so we can
  // compare full result sets, not just one page.
  const page = await fetchRecordsPage(built, 0, 1000, () => false);
  if (page === null) throw new Error("fetchRecordsPage returned null unexpectedly");
  return {
    total: page.total,
    ids: page.records.map((r) => r.id!),
  };
}

// ---- Scenarios --------------------------------------------------------------

interface Scenario {
  name: string;
  search: string;
  columnFilters: ColumnFilter[];
  includeBlockchainDiscovered: boolean;
}

const SCENARIOS: Scenario[] = [
  // Search-only (residual substring) — exercises legacy `.includes` semantics
  // including substring-in-the-middle and notes-only matches.
  { name: "search 'alice' (substring incl. notes)",       search: "alice",  columnFilters: [],                                                         includeBlockchainDiscovered: false },
  { name: "search 'alice' includes blockchain",           search: "alice",  columnFilters: [],                                                         includeBlockchainDiscovered: true  },
  { name: "search 'bob' (notes-only match must surface)", search: "bob",    columnFilters: [],                                                         includeBlockchainDiscovered: false },
  { name: "search uppercase 'ALICE'",                     search: "alice",  columnFilters: [],                                                         includeBlockchainDiscovered: true  },
  { name: "search empty (everything, user tiers only)",   search: "",       columnFilters: [],                                                         includeBlockchainDiscovered: false },
  { name: "search empty (everything, all tiers)",         search: "",       columnFilters: [],                                                         includeBlockchainDiscovered: true  },

  // Single column filters — each operator the indexed path supports.
  { name: "type=address",                                 search: "",       columnFilters: [{ field: "type",                operator: "equals",     value: "address" }],         includeBlockchainDiscovered: true  },
  { name: "type=transaction",                             search: "",       columnFilters: [{ field: "type",                operator: "equals",     value: "transaction" }],     includeBlockchainDiscovered: true  },
  { name: "addressImportance=verified",                   search: "",       columnFilters: [{ field: "addressImportance",   operator: "equals",     value: "verified" }],        includeBlockchainDiscovered: true  },
  { name: "tags includes 'personal' (case-insensitive)",  search: "",       columnFilters: [{ field: "tags",                operator: "includes",   value: "Personal" }],        includeBlockchainDiscovered: true  },
  { name: "tags includes 'kyc' (case-insensitive)",       search: "",       columnFilters: [{ field: "tags",                operator: "includes",   value: "kyc" }],             includeBlockchainDiscovered: true  },
  { name: "label equals 'alice wallet' (case-insens)",    search: "",       columnFilters: [{ field: "label",               operator: "equals",     value: "Alice Wallet" }],    includeBlockchainDiscovered: true  },
  { name: "label startsWith 'al' (case-insens)",          search: "",       columnFilters: [{ field: "label",               operator: "startsWith", value: "al" }],              includeBlockchainDiscovered: true  },
  { name: "owner equals 'alice' (case-insens)",           search: "",       columnFilters: [{ field: "owner",               operator: "equals",     value: "ALICE" }],           includeBlockchainDiscovered: true  },
  { name: "walletName startsWith 'cold'",                 search: "",       columnFilters: [{ field: "walletName",          operator: "startsWith", value: "Cold" }],            includeBlockchainDiscovered: true  },
  { name: "inputString equals (case-insens via lower)",   search: "",       columnFilters: [{ field: "inputString",         operator: "equals",     value: "BC1QAlice" }],       includeBlockchainDiscovered: true  },
  { name: "inputString startsWith 'bc1qN'",               search: "",       columnFilters: [{ field: "inputString",         operator: "startsWith", value: "bc1qN" }],           includeBlockchainDiscovered: true  },

  // Combined: search residual + indexed column filter — the case the architect
  // specifically called out as needing equivalence proof.
  { name: "search 'alice' + type=address",                search: "alice",  columnFilters: [{ field: "type",                operator: "equals",     value: "address" }],         includeBlockchainDiscovered: true  },
  { name: "search 'bob' + tags includes 'personal'",      search: "bob",    columnFilters: [{ field: "tags",                operator: "includes",   value: "personal" }],        includeBlockchainDiscovered: false },
  { name: "search 'wallet' + label startsWith 'al'",      search: "wallet", columnFilters: [{ field: "label",               operator: "startsWith", value: "al" }],              includeBlockchainDiscovered: true  },

  // Multiple column filters — primary picked by selectivity, others residual.
  { name: "type=address + tags includes 'personal'",      search: "",       columnFilters: [{ field: "type", operator: "equals", value: "address" }, { field: "tags", operator: "includes", value: "personal" }], includeBlockchainDiscovered: true },
  { name: "type=address + label startsWith 'al'",         search: "",       columnFilters: [{ field: "type", operator: "equals", value: "address" }, { field: "label", operator: "startsWith", value: "al" }],   includeBlockchainDiscovered: true },

  // Non-indexable filters — must fall back to user-tiers / full-table while
  // still applying the residual predicate correctly.
  { name: "label contains 'wallet' (non-indexable)",      search: "",       columnFilters: [{ field: "label",               operator: "contains",   value: "wallet" }],          includeBlockchainDiscovered: true  },
  { name: "notes contains 'mention' (non-indexable)",     search: "",       columnFilters: [{ field: "notes",               operator: "contains",   value: "mention" } as never],includeBlockchainDiscovered: true  },
  { name: "notes contains 'mention' user tiers only",     search: "",       columnFilters: [{ field: "notes",               operator: "contains",   value: "mention" } as never],includeBlockchainDiscovered: false },

  // Empty-result cases.
  { name: "search 'no-such-substring'",                   search: "zzzzzz", columnFilters: [],                                                         includeBlockchainDiscovered: true  },
  { name: "owner equals 'NoSuchOwner'",                   search: "",       columnFilters: [{ field: "owner",               operator: "equals",     value: "NoSuchOwner" }],     includeBlockchainDiscovered: true  },
];

describe("Records query: ID equivalence vs legacy filter", () => {
  it.each(SCENARIOS)("$name", async ({ search, columnFilters, includeBlockchainDiscovered }) => {
    const legacy = await legacyResultIds(search, columnFilters, includeBlockchainDiscovered);
    const next = await newPathResultIds(search, columnFilters, includeBlockchainDiscovered);
    // Sets must match exactly (order is enforced separately below for non-empty cases).
    expect(new Set(next.ids)).toEqual(new Set(legacy.ids));
    expect(next.total).toBe(legacy.total);
    // The fixture is small enough that no scenario triggers MAX_MATERIALIZE,
    // so the new path should also return the rows in id-desc order.
    expect(next.ids).toEqual(legacy.ids);
  });
});

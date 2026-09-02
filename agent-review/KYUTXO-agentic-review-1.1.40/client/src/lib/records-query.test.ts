// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const whereSpy = vi.fn();
const equalsSpy = vi.fn();
const equalsIgnoreCaseSpy = vi.fn();
const startsWithIgnoreCaseSpy = vi.fn();
const startsWithSpy = vi.fn();
const orSpy = vi.fn();
const anyOfSpy = vi.fn();
const andSpy = vi.fn();
const toCollectionSpy = vi.fn();
const toArraySpy = vi.fn();

function makeCollection(label: string) {
  const collection: Record<string, unknown> = { __label: label };
  collection.and = (predicate: unknown) => {
    andSpy(label, predicate);
    return collection;
  };
  collection.or = (field: string) => {
    orSpy(field);
    return makeWhereChain(`${label}+or(${field})`);
  };
  collection.toArray = () => toArraySpy(label);
  collection.until = () => collection;
  collection.each = () => Promise.resolve();
  collection.count = () => Promise.resolve(0);
  return collection;
}

function makeWhereChain(label: string) {
  return {
    equals: (value: unknown) => {
      equalsSpy(label, value);
      return makeCollection(`${label}.equals(${JSON.stringify(value)})`);
    },
    equalsIgnoreCase: (value: unknown) => {
      equalsIgnoreCaseSpy(label, value);
      return makeCollection(`${label}.equalsIgnoreCase(${JSON.stringify(value)})`);
    },
    startsWithIgnoreCase: (value: string) => {
      startsWithIgnoreCaseSpy(label, value);
      return makeCollection(`${label}.startsWithIgnoreCase(${value})`);
    },
    startsWith: (value: string) => {
      startsWithSpy(label, value);
      return makeCollection(`${label}.startsWith(${value})`);
    },
    anyOf: (values: unknown[]) => {
      anyOfSpy(label, values);
      return makeCollection(`${label}.anyOf(${JSON.stringify(values)})`);
    },
  };
}

const orderBySpy = vi.fn();
// resolveVisibleTierValues reads the distinct addressImportance index keys;
// tests control the result (or make it throw) via these knobs.
let uniqueKeysResult: unknown[] = [];
let uniqueKeysError: Error | null = null;

vi.mock("@/lib/database", () => ({
  db: {
    records: {
      where: (field: string) => {
        whereSpy(field);
        return makeWhereChain(`where(${field})`);
      },
      toCollection: () => {
        toCollectionSpy();
        return makeCollection("toCollection()");
      },
      orderBy: (field: string) => {
        orderBySpy(field);
        return {
          uniqueKeys: () =>
            uniqueKeysError
              ? Promise.reject(uniqueKeysError)
              : Promise.resolve(uniqueKeysResult),
        };
      },
    },
  },
}));

import {
  buildRecordsCollection,
  buildIdentifierSearchCollection,
  looksLikeBitcoinIdentifier,
  pickPrimaryNarrowing,
  fetchRecordsPage,
  resolveVisibleTierValues,
  USER_TIERS,
} from "./records-query";

beforeEach(() => {
  vi.clearAllMocks();
  toArraySpy.mockResolvedValue([]);
});

describe("pickPrimaryNarrowing", () => {
  it("never picks search as primary — search alone falls back to user tiers when blockchain excluded", () => {
    const s = pickPrimaryNarrowing("foo", [], false);
    expect(s.source).toBe("address-importance-tiers");
  });

  it("never picks search as primary — search alone falls back to full-table when blockchain included", () => {
    const s = pickPrimaryNarrowing("foo", [], true);
    expect(s.source).toBe("full-table");
  });

  it("picks the most-selective indexable column filter even when search is also active", () => {
    const s = pickPrimaryNarrowing(
      "needle",
      [{ field: "tags", operator: "includes", value: "Trezor" }],
      true,
    );
    expect(s.source).toBe("column-filter");
    expect(s.narrowing).toEqual({ kind: "multiEntry", field: "tags", value: "Trezor" });
  });

  it("falls back to user-importance tiers when no filters and blockchain excluded", () => {
    const s = pickPrimaryNarrowing("", [], false);
    expect(s.source).toBe("address-importance-tiers");
    expect(s.narrowing).toEqual({
      kind: "anyOf",
      field: "addressImportance",
      values: USER_TIERS,
    });
  });

  it("falls back to full-table when no filters and blockchain included", () => {
    const s = pickPrimaryNarrowing("", [], true);
    expect(s.source).toBe("full-table");
  });

  it("prefers tags includes over type equals (more selective)", () => {
    const s = pickPrimaryNarrowing(
      "",
      [
        { field: "type", operator: "equals", value: "address" },
        { field: "tags", operator: "includes", value: "mywallet" },
      ],
      true,
    );
    expect(s.source).toBe("column-filter");
    expect(s.narrowing).toEqual({ kind: "multiEntry", field: "tags", value: "mywallet" });
  });

  it("prefers inputString equals over label startsWith", () => {
    const s = pickPrimaryNarrowing(
      "",
      [
        { field: "label", operator: "startsWith", value: "Bo" },
        { field: "inputString", operator: "equals", value: "bc1qXYZ" },
      ],
      true,
    );
    expect(s.source).toBe("column-filter");
    expect(s.narrowing).toEqual({
      kind: "equals",
      field: "inputStringLower",
      value: "bc1qxyz",
    });
  });

  it("ignores non-indexable filters (contains, notes)", () => {
    const s = pickPrimaryNarrowing(
      "",
      [{ field: "label", operator: "contains", value: "foo" }],
      false,
    );
    expect(s.source).toBe("address-importance-tiers");
  });

  it("ignores filters with empty values", () => {
    const s = pickPrimaryNarrowing(
      "",
      [{ field: "label", operator: "equals", value: "  " }],
      true,
    );
    expect(s.source).toBe("full-table");
  });
});

describe("buildRecordsCollection", () => {
  it("does NOT use indexed prefix-search OR-chain for search alone — search must remain a residual substring filter", () => {
    const noop = () => true;
    buildRecordsCollection(
      { search: "foo", columnFilters: [], includeBlockchainDiscovered: false },
      noop,
    );
    // Primary should be addressImportance.anyOf(USER_TIERS); search applied as residual via .and()
    expect(whereSpy).toHaveBeenCalledWith("addressImportance");
    expect(anyOfSpy).toHaveBeenCalledWith("where(addressImportance)", USER_TIERS);
    // CRITICAL: do NOT issue a startsWith on label/inputStringLower/owner/walletName
    // for the search term — that would silently regress substring semantics.
    expect(startsWithIgnoreCaseSpy).not.toHaveBeenCalledWith(expect.anything(), "foo");
    expect(startsWithSpy).not.toHaveBeenCalledWith(expect.anything(), "foo");
    expect(orSpy).not.toHaveBeenCalled();
    // residual predicate must be wired via .and()
    expect(andSpy).toHaveBeenCalled();
  });

  it("uses where('addressImportance').anyOf(USER_TIERS) when no search and no indexable filter", () => {
    const noop = () => true;
    buildRecordsCollection(
      { search: "", columnFilters: [], includeBlockchainDiscovered: false },
      noop,
    );
    expect(whereSpy).toHaveBeenCalledWith("addressImportance");
    expect(anyOfSpy).toHaveBeenCalledWith("where(addressImportance)", USER_TIERS);
    expect(toCollectionSpy).not.toHaveBeenCalled();
  });

  it("uses where('tags').equalsIgnoreCase(value) for tags includes filter (case-insensitive to match filterFn)", () => {
    const noop = () => true;
    buildRecordsCollection(
      {
        search: "",
        columnFilters: [{ field: "tags", operator: "includes", value: "Trezor" }],
        includeBlockchainDiscovered: true,
      },
      noop,
    );
    expect(whereSpy).toHaveBeenCalledWith("tags");
    expect(equalsIgnoreCaseSpy).toHaveBeenCalledWith("where(tags)", "Trezor");
  });

  it("uses equalsIgnoreCase for label equals to match case-insensitive filterFn", () => {
    const noop = () => true;
    buildRecordsCollection(
      {
        search: "",
        columnFilters: [{ field: "label", operator: "equals", value: "MyWallet" }],
        includeBlockchainDiscovered: true,
      },
      noop,
    );
    expect(whereSpy).toHaveBeenCalledWith("label");
    expect(equalsIgnoreCaseSpy).toHaveBeenCalledWith("where(label)", "MyWallet");
    // Must NOT use case-sensitive equals on text fields — that would silently drop
    // candidates whose label differs only in case from the filter value.
    expect(equalsSpy).not.toHaveBeenCalledWith("where(label)", "MyWallet");
  });

  it("uses case-sensitive equals for enum fields (type, addressImportance, chainType)", () => {
    const noop = () => true;
    buildRecordsCollection(
      {
        search: "",
        columnFilters: [{ field: "addressImportance", operator: "equals", value: "verified" }],
        includeBlockchainDiscovered: true,
      },
      noop,
    );
    expect(equalsSpy).toHaveBeenCalledWith("where(addressImportance)", "verified");
  });

  it("uses startsWithIgnoreCase on indexed field for label startsWith filter", () => {
    const noop = () => true;
    buildRecordsCollection(
      {
        search: "",
        columnFilters: [{ field: "label", operator: "startsWith", value: "Wal" }],
        includeBlockchainDiscovered: true,
      },
      noop,
    );
    expect(whereSpy).toHaveBeenCalledWith("label");
    expect(startsWithIgnoreCaseSpy).toHaveBeenCalledWith("where(label)", "Wal");
  });

  it("uses inputStringLower index for inputString equals (lowercased, case-sensitive equals on the lower index)", () => {
    const noop = () => true;
    buildRecordsCollection(
      {
        search: "",
        columnFilters: [{ field: "inputString", operator: "equals", value: "BC1qXYZ" }],
        includeBlockchainDiscovered: true,
      },
      noop,
    );
    expect(whereSpy).toHaveBeenCalledWith("inputStringLower");
    // inputStringLower stores already-lowered values, so case-sensitive equals
    // on the pre-lowered query value gives the correct match set.
    expect(equalsSpy).toHaveBeenCalledWith("where(inputStringLower)", "bc1qxyz");
  });

  it("falls back to toCollection() only when blockchain included and no indexable narrowing", () => {
    const noop = () => true;
    buildRecordsCollection(
      {
        search: "",
        columnFilters: [{ field: "notes", operator: "contains", value: "x" } as never],
        includeBlockchainDiscovered: true,
      },
      noop,
    );
    expect(toCollectionSpy).toHaveBeenCalled();
  });
});

function fakeCollection(rows: { id: number }[]) {
  let stopFn: (() => boolean) | null = null;
  const c = {
    until(stop: () => boolean) {
      stopFn = stop;
      return c;
    },
    async each(cb: (r: { id: number }) => void) {
      for (const row of rows) {
        if (stopFn && stopFn()) return;
        cb(row);
      }
    },
    count: async () => rows.length,
    toArray: async () => rows,
    and: () => c,
  };
  return c;
}

describe("fetchRecordsPage", () => {
  it("dedupes by id, sorts id desc, slices the requested page", async () => {
    const c = fakeCollection([
      { id: 5 },
      { id: 1 },
      { id: 5 }, // duplicate from OR-chain
      { id: 9 },
      { id: 3 },
    ]);
    const page = await fetchRecordsPage(
      { collection: c as never, strategy: { source: "column-filter" } },
      0,
      2,
      () => false,
    );
    expect(page).not.toBeNull();
    expect(page!.total).toBe(4);
    expect(page!.truncated).toBe(false);
    expect(page!.records.map((r) => r.id)).toEqual([9, 5]);
  });

  it("returns the second page slice correctly", async () => {
    const c = fakeCollection([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]);
    const page = await fetchRecordsPage(
      { collection: c as never, strategy: { source: "full-table" } },
      2,
      2,
      () => false,
    );
    expect(page!.records.map((r) => r.id)).toEqual([3, 2]);
    expect(page!.total).toBe(5);
  });

  it("caps materialization at MAX_MATERIALIZE, reports truncated=true, and does NOT call Collection.count() on the truncated path", async () => {
    const big = Array.from({ length: 12_000 }, (_, i) => ({ id: i + 1 }));
    let countCalls = 0;
    const c = (() => {
      const base = fakeCollection(big);
      return { ...base, count: async () => { countCalls++; return big.length; } };
    })();
    const page = await fetchRecordsPage(
      { collection: c as never, strategy: { source: "address-importance-tiers" } },
      0,
      50,
      () => false,
    );
    expect(page!.truncated).toBe(true);
    // total now equals the materialized cap — no full .count() walk on truncate.
    // The UI renders "10,000+" semantics from the truncated flag instead.
    expect(page!.total).toBe(10_000);
    expect(page!.effectiveTotal).toBe(10_000);
    expect(countCalls).toBe(0);
    // page is sliced from the cap-bounded materialized window
    expect(page!.records.length).toBe(50);
  });

  it("returns null when cancellation is signalled", async () => {
    const c = fakeCollection([{ id: 1 }]);
    const page = await fetchRecordsPage(
      { collection: c as never, strategy: { source: "full-table" } },
      0,
      10,
      () => true,
    );
    expect(page).toBeNull();
  });
});

describe("looksLikeBitcoinIdentifier", () => {
  it("detects a 64-hex transaction id (case-insensitive)", () => {
    const txid = "a".repeat(64);
    expect(looksLikeBitcoinIdentifier(txid)).toBe(txid);
    const mixed = "ABCDEF" + "0".repeat(58);
    expect(looksLikeBitcoinIdentifier(mixed)).toBe(mixed);
  });

  it("detects bech32 / bech32m addresses (mainnet, testnet, regtest)", () => {
    const bc1 = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
    const tb1 = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
    const taproot = "bc1p" + "0".repeat(58);
    expect(looksLikeBitcoinIdentifier(bc1)).toBe(bc1);
    expect(looksLikeBitcoinIdentifier(tb1)).toBe(tb1);
    expect(looksLikeBitcoinIdentifier(taproot)).toBe(taproot);
  });

  it("detects legacy base58 P2PKH / P2SH addresses", () => {
    const p2pkh = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
    const p2sh = "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy";
    expect(looksLikeBitcoinIdentifier(p2pkh)).toBe(p2pkh);
    expect(looksLikeBitcoinIdentifier(p2sh)).toBe(p2sh);
  });

  it("trims surrounding whitespace before matching", () => {
    const p2pkh = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
    expect(looksLikeBitcoinIdentifier(`  ${p2pkh}  `)).toBe(p2pkh);
  });

  it("returns null for ordinary search words and partial identifiers", () => {
    expect(looksLikeBitcoinIdentifier("alice")).toBeNull();
    expect(looksLikeBitcoinIdentifier("cold storage")).toBeNull();
    expect(looksLikeBitcoinIdentifier("")).toBeNull();
    expect(looksLikeBitcoinIdentifier("   ")).toBeNull();
    // 63 hex chars (one short of a txid) must NOT match
    expect(looksLikeBitcoinIdentifier("a".repeat(63))).toBeNull();
    // 65 hex chars (one over) must NOT match
    expect(looksLikeBitcoinIdentifier("a".repeat(65))).toBeNull();
  });
});

describe("buildIdentifierSearchCollection", () => {
  it("routes a pasted identifier to the inputStringLower equality index (lowercased)", () => {
    const noop = () => true;
    const addr = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
    buildIdentifierSearchCollection(
      addr,
      { search: addr.toLowerCase(), columnFilters: [], includeBlockchainDiscovered: false },
      noop,
    );
    // The synthetic inputString-equals filter is the most selective narrowing,
    // so it must drive a case-insensitive equality on the inputStringLower index.
    expect(whereSpy).toHaveBeenCalledWith("inputStringLower");
    expect(equalsSpy).toHaveBeenCalledWith("where(inputStringLower)", addr.toLowerCase());
    // It must NOT fall back to the user-tier / full-table scan.
    expect(anyOfSpy).not.toHaveBeenCalled();
    expect(toCollectionSpy).not.toHaveBeenCalled();
    // residual predicate wired via .and()
    expect(andSpy).toHaveBeenCalled();
  });

  it("keeps the identifier as the primary narrowing even alongside other column filters", () => {
    const noop = () => true;
    const addr = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
    buildIdentifierSearchCollection(
      addr,
      {
        search: addr,
        columnFilters: [{ field: "type", operator: "equals", value: "address" }],
        includeBlockchainDiscovered: true,
      },
      noop,
    );
    // inputStringLower equals (priority 1) wins over type equals (priority 10).
    expect(whereSpy).toHaveBeenCalledWith("inputStringLower");
    expect(equalsSpy).toHaveBeenCalledWith("where(inputStringLower)", addr);
  });
});

// ---------------------------------------------------------------------------
// Task #1877 — identifier canonicalization inside the query planner.
//
// Records store canonical identifiers (canonicalizeRecordIdentifier) and the
// inputStringLower index stores the lowercase of that canonical form. The
// static guard (scripts/check-input-string-canonicalization.js) cannot see
// dynamic-field narrows (a records `.where(n.field)` call), so these tests prove
// that identifier-shaped inputs entering records-query narrows are
// canonicalized: padded / uppercase / mixed-case bech32 and txid inputs must
// still resolve to their canonical (lowercased, trimmed) index keys.
// ---------------------------------------------------------------------------
describe("planner narrows canonicalize identifier keys", () => {
  const noop = () => true;
  const bech32Canonical = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
  const txidCanonical =
    "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b";

  it("padded + uppercase bech32 equals filter hits the canonical inputStringLower key", () => {
    buildRecordsCollection(
      {
        search: "",
        columnFilters: [
          {
            field: "inputString",
            operator: "equals",
            value: `  ${bech32Canonical.toUpperCase()}  `,
          },
        ],
        includeBlockchainDiscovered: false,
      },
      noop,
    );
    expect(whereSpy).toHaveBeenCalledWith("inputStringLower");
    expect(equalsSpy).toHaveBeenCalledWith("where(inputStringLower)", bech32Canonical);
  });

  it("uppercase txid equals filter hits the canonical lowercase txid key", () => {
    buildRecordsCollection(
      {
        search: "",
        columnFilters: [
          { field: "inputString", operator: "equals", value: txidCanonical.toUpperCase() },
        ],
        includeBlockchainDiscovered: true,
      },
      noop,
    );
    expect(whereSpy).toHaveBeenCalledWith("inputStringLower");
    expect(equalsSpy).toHaveBeenCalledWith("where(inputStringLower)", txidCanonical);
  });

  it("mixed-case bech32 prefix startsWith filter lowers the prefix for the lowered index", () => {
    buildRecordsCollection(
      {
        search: "",
        columnFilters: [
          { field: "inputString", operator: "startsWith", value: " Bc1QAr0sRRr7 " },
        ],
        includeBlockchainDiscovered: true,
      },
      noop,
    );
    expect(whereSpy).toHaveBeenCalledWith("inputStringLower");
    expect(startsWithIgnoreCaseSpy).toHaveBeenCalledWith(
      "where(inputStringLower)",
      "bc1qar0srrr7",
    );
  });

  it("base58 equals filter keeps the characters verbatim (only lowered for the index)", () => {
    // Base58 is case-sensitive; canonicalization must NOT alter the characters
    // beyond trimming. The value is lowered only because the inputStringLower
    // index stores lowered strings for case-insensitive matching.
    const base58 = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
    buildRecordsCollection(
      {
        search: "",
        columnFilters: [{ field: "inputString", operator: "equals", value: `  ${base58}` }],
        includeBlockchainDiscovered: true,
      },
      noop,
    );
    expect(equalsSpy).toHaveBeenCalledWith("where(inputStringLower)", base58.toLowerCase());
  });

  it("uppercase pasted identifier via the search fast path resolves to the canonical key", () => {
    buildIdentifierSearchCollection(
      bech32Canonical.toUpperCase(),
      {
        search: bech32Canonical.toUpperCase(),
        columnFilters: [],
        includeBlockchainDiscovered: false,
      },
      noop,
    );
    expect(whereSpy).toHaveBeenCalledWith("inputStringLower");
    expect(equalsSpy).toHaveBeenCalledWith("where(inputStringLower)", bech32Canonical);
    expect(anyOfSpy).not.toHaveBeenCalled();
    expect(toCollectionSpy).not.toHaveBeenCalled();
  });

  it("pickPrimaryNarrowing emits a canonicalized narrow descriptor for uppercase txid", () => {
    const s = pickPrimaryNarrowing(
      "",
      [{ field: "inputString", operator: "equals", value: ` ${txidCanonical.toUpperCase()} ` }],
      true,
    );
    expect(s.narrowing).toEqual({
      kind: "equals",
      field: "inputStringLower",
      value: txidCanonical,
    });
  });
});

// ---------------------------------------------------------------------------
// Task #1740 — dynamic visible-tier narrowing.
//
// The default-view (exclude blockchain-discovered) Dexie narrowing used to be
// a STATIC anyOf(USER_TIERS), which silently dropped rows carrying legacy /
// unrecognized tier strings from search while the browse path and the engine
// (exclusion semantics) still showed them. The page now resolves the visible
// tier list from the index's actual distinct keys and threads it through.
// ---------------------------------------------------------------------------

describe("dynamic visible tiers (resolveVisibleTierValues + visibleTierValues param)", () => {
  beforeEach(() => {
    uniqueKeysResult = [];
    uniqueKeysError = null;
  });

  it("resolveVisibleTierValues unions stored tiers with the standard tiers, minus hidden ones", async () => {
    uniqueKeysResult = [
      "blockchain-discovered", // hidden — excluded
      "pending-review", // hidden — excluded
      "important", // legacy value — kept
      "manual", // overlaps USER_TIERS — deduped
      42, // non-string index key — ignored
    ];
    const values = await resolveVisibleTierValues();
    expect(orderBySpy).toHaveBeenCalledWith("addressImportance");
    expect([...values].sort()).toEqual(
      [...new Set([...USER_TIERS, "important"])].sort(),
    );
  });

  it("resolveVisibleTierValues falls back to the standard tiers when the index read fails", async () => {
    uniqueKeysError = new Error("index unavailable");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const values = await resolveVisibleTierValues();
      expect([...values].sort()).toEqual([...USER_TIERS].sort());
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("pickPrimaryNarrowing narrows to the provided visible tiers when blockchain is excluded", () => {
    const dynamicTiers = [...USER_TIERS, "important", "auto-found"];
    const s = pickPrimaryNarrowing("stash", [], false, dynamicTiers);
    expect(s.source).toBe("address-importance-tiers");
    expect(s.narrowing).toEqual({
      kind: "anyOf",
      field: "addressImportance",
      values: dynamicTiers,
    });
  });

  it("pickPrimaryNarrowing ignores visibleTierValues when blockchain is included (full-table)", () => {
    const s = pickPrimaryNarrowing("stash", [], true, [...USER_TIERS, "important"]);
    expect(s.source).toBe("full-table");
  });

  it("buildRecordsCollection threads visibleTierValues into the anyOf tier narrowing", () => {
    const dynamicTiers = [...USER_TIERS, "important"];
    buildRecordsCollection(
      {
        search: "stash",
        columnFilters: [],
        includeBlockchainDiscovered: false,
        visibleTierValues: dynamicTiers,
      },
      () => true,
    );
    expect(anyOfSpy).toHaveBeenCalledWith("where(addressImportance)", dynamicTiers);
  });

  it("buildRecordsCollection still narrows to the static tiers when no dynamic list is provided", () => {
    buildRecordsCollection(
      { search: "stash", columnFilters: [], includeBlockchainDiscovered: false },
      () => true,
    );
    expect(anyOfSpy).toHaveBeenCalledWith("where(addressImportance)", USER_TIERS);
  });
});

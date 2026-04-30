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
    },
  },
}));

import {
  buildRecordsCollection,
  pickPrimaryNarrowing,
  fetchRecordsPage,
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

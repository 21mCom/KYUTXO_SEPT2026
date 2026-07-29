// @vitest-environment jsdom
//
// createdAt keyset pagination correctness (Recently Added view).
//
// Fixture createdAt values are deliberately NOT monotonic with id and include
// duplicate createdAt values, so these tests exercise the id tiebreaker and
// tie-continuation logic. The oracle is a full in-memory sort of the same
// fixture — the read-path-equivalence approach (compare orderings page by
// page against a known-total oracle).
//
// Engine parity note: date-added ordering/recency is ALSO expressible on the
// native engine fast path (createdAtSort keyset + addedSince); this Dexie path
// is the fallback per the freshness gate. Engine-vs-Dexie ordering parity is
// covered by client/src/lib/engine/__tests__/records-read-equivalence.test.ts.
import "fake-indexeddb/auto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Dexie from "dexie";

class TestDb extends Dexie {
  records!: Dexie.Table<any, number>;
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

const testDb = new TestDb(`KYUTXO-createdat-keyset-${Date.now()}-${Math.random()}`);

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return { ...actual, db: testDb };
});

const {
  getRecordsPageByCreatedAtKeyset,
  countRecordsByCreatedAtWindow,
} = await import("./record-crud");

const TOTAL = 137;
const BASE = 1_700_000_000_000;

function mkRecord(i: number) {
  // createdAt scrambled relative to id, with ties every 3rd record.
  const bucket = Math.floor(((i * 37) % TOTAL) / 3);
  return {
    id: i,
    type: i % 4 === 0 ? "transaction" : "address",
    inputString: `addr-${i}`,
    label: i % 5 === 0 ? `hot-${i}` : `label-${i}`,
    tags: [],
    categories: [],
    addressImportance: "normal",
    createdAt: BASE + bucket * 60_000,
    updatedAt: BASE + i,
  };
}

let all: any[] = [];

beforeAll(async () => {
  all = Array.from({ length: TOTAL }, (_, idx) => mkRecord(idx + 1));
  await testDb.records.bulkAdd(all);
});

afterAll(async () => {
  testDb.close();
  await Dexie.delete(testDb.name);
});

function sortOracle(rows: any[], direction: "newest" | "oldest") {
  const s = [...rows].sort((a, b) =>
    direction === "newest"
      ? b.createdAt - a.createdAt || b.id - a.id
      : a.createdAt - b.createdAt || a.id - b.id
  );
  return s;
}

const ids = (rows: any[]) => rows.map((r) => r.id);

async function paginateAll(opts: {
  direction: "newest" | "oldest";
  addedSince?: number;
  filter?: (r: any) => boolean;
  pageSize: number;
}) {
  const out: any[] = [];
  let cursor: { createdAt: number; id: number } | undefined = undefined;
  for (let guard = 0; guard < 500; guard++) {
    const page = await getRecordsPageByCreatedAtKeyset({
      limit: opts.pageSize,
      direction: opts.direction,
      addedSince: opts.addedSince,
      cursor,
      filter: opts.filter,
    });
    out.push(...page);
    if (page.length < opts.pageSize) break;
    const last = page[page.length - 1];
    cursor = { createdAt: last.createdAt, id: last.id };
  }
  return out;
}

describe("createdAt keyset pagination", () => {
  it("newest-first pages match the (createdAt desc, id desc) oracle exactly", async () => {
    const rows = await paginateAll({ direction: "newest", pageSize: 25 });
    expect(ids(rows)).toEqual(ids(sortOracle(all, "newest")));
    // Explicit newest is TRUE createdAt ordering, not the legacy id-desc
    // ordering: the fixture's createdAt is non-monotonic with id, so the two
    // orderings must differ (reviewer requirement: oldest→newest toggle must
    // not silently fall back to id order).
    const idDesc = [...all].map((r) => r.id).sort((a, b) => b - a);
    expect(ids(rows)).not.toEqual(idDesc);
  });

  it("oldest-first pages match the (createdAt asc, id asc) oracle exactly", async () => {
    const rows = await paginateAll({ direction: "oldest", pageSize: 25 });
    expect(ids(rows)).toEqual(ids(sortOracle(all, "oldest")));
  });

  it("page boundaries falling inside a createdAt tie do not skip or duplicate rows", async () => {
    // Small page size guarantees many boundaries land mid-tie (ties are 3 wide).
    const rows = await paginateAll({ direction: "newest", pageSize: 2 });
    expect(ids(rows)).toEqual(ids(sortOracle(all, "newest")));
    expect(new Set(ids(rows)).size).toBe(TOTAL);
  });

  it("addedSince is an inclusive lower bound", async () => {
    const since = BASE + 20 * 60_000;
    const expected = sortOracle(all.filter((r) => r.createdAt >= since), "newest");
    const rows = await paginateAll({ direction: "newest", addedSince: since, pageSize: 10 });
    expect(ids(rows)).toEqual(ids(expected));
    expect(rows.every((r) => r.createdAt >= since)).toBe(true);
  });

  it("addedSince composes with a residual type+search filter", async () => {
    const since = BASE + 10 * 60_000;
    const filter = (r: any) => r.type === "address" && r.label.startsWith("hot-");
    const expected = sortOracle(
      all.filter((r) => r.createdAt >= since && filter(r)),
      "oldest"
    );
    const rows = await paginateAll({ direction: "oldest", addedSince: since, filter, pageSize: 5 });
    expect(ids(rows)).toEqual(ids(expected));
  });

  it("cursor boundary row itself is excluded", async () => {
    const first = await getRecordsPageByCreatedAtKeyset({ limit: 10, direction: "newest" });
    const last = first[first.length - 1];
    const next = await getRecordsPageByCreatedAtKeyset({
      limit: 10,
      direction: "newest",
      cursor: { createdAt: last.createdAt, id: last.id },
    });
    expect(ids(next)).not.toContain(last.id);
    expect(ids([...first, ...next])).toEqual(ids(sortOracle(all, "newest")).slice(0, 20));
  });
});

describe("countRecordsByCreatedAtWindow", () => {
  it("counts the window with a residual filter", async () => {
    const since = BASE + 30 * 60_000;
    const filter = (r: any) => r.type === "address";
    const expected = all.filter((r) => r.createdAt >= since && filter(r)).length;
    const { count, truncated } = await countRecordsByCreatedAtWindow(since, filter, 10_000);
    expect(count).toBe(expected);
    expect(truncated).toBe(false);
  });

  it("stops early at the cap and reports truncation", async () => {
    const { count, truncated } = await countRecordsByCreatedAtWindow(undefined, undefined, 40);
    expect(count).toBe(40);
    expect(truncated).toBe(true);
  });

  it("counts everything when no window is set", async () => {
    const { count, truncated } = await countRecordsByCreatedAtWindow(undefined, undefined, 10_000);
    expect(count).toBe(TOTAL);
    expect(truncated).toBe(false);
  });
});

// @vitest-environment jsdom
//
// Unit coverage for the filter-aware custody-segment paging queries used by
// the Continuity Proof "All Custody Segments" list
// (getCustodySegmentsBeforeIdFiltered / countCustodySegmentsFiltered).
// Locks in: status narrowing, address substring against origin OR current
// address, origin-date range (Unix seconds), keyset continuity across pages
// (no gaps/dupes, descending id), and page/count parity.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";
import {
  bulkAddCustodySegments,
  clearAllLineageData,
  getCustodySegmentsBeforeIdFiltered,
  countCustodySegmentsFiltered,
  isCustodySegmentFilterActive,
} from "@/lib/data/lineage-crud";
import type { CustodySegment, CustodyStatus } from "@/lib/database";

const STATUSES: CustodyStatus[] = ["active", "spent", "split", "consolidated"];

function makeSegment(i: number, overrides: Partial<CustodySegment> = {}): CustodySegment {
  return {
    segmentId: `flt-${i.toString().padStart(4, "0")}`,
    originTxid: (i + 1).toString(16).padStart(64, "0"),
    originVout: 0,
    originAddress: `bc1qfltorigin${i.toString().padStart(6, "0")}`,
    originDate: 1_700_000_000 + i * 600, // seconds
    originAmount: 100_000 + i,
    currentAmount: 100_000 + i,
    status: STATUSES[i % STATUSES.length],
    hopCount: 0,
    evidenceTxids: [],
    narrative: `Filter segment ${i}`,
    createdAt: 1_700_000_000_000 + i,
    updatedAt: 1_700_000_000_000 + i,
    ...overrides,
  } as CustodySegment;
}

// Pages through the whole filtered result and returns every row, asserting
// keyset continuity (strictly descending ids, no duplicates).
async function collectAllPages(
  total: number,
  filter?: Parameters<typeof getCustodySegmentsBeforeIdFiltered>[2],
  pageSize = 7
): Promise<CustodySegment[]> {
  const out: CustodySegment[] = [];
  let beforeId = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const page = await getCustodySegmentsBeforeIdFiltered(beforeId, pageSize, filter);
    expect(page.length).toBeLessThanOrEqual(pageSize);
    out.push(...page);
    if (page.length < pageSize) break;
    const lastId = page[page.length - 1].id;
    expect(typeof lastId).toBe("number");
    beforeId = lastId!;
    if (out.length > total + pageSize) throw new Error("paging did not terminate");
  }
  const ids = out.map((s) => s.id!);
  expect(new Set(ids).size).toBe(ids.length);
  for (let i = 1; i < ids.length; i++) {
    expect(ids[i]).toBeLessThan(ids[i - 1]);
  }
  return out;
}

describe("filtered custody-segment paging", () => {
  beforeEach(async () => {
    await clearAllLineageData();
  });

  it("detects whether a filter actually narrows", () => {
    expect(isCustodySegmentFilterActive(undefined)).toBe(false);
    expect(isCustodySegmentFilterActive({})).toBe(false);
    expect(isCustodySegmentFilterActive({ statuses: [] })).toBe(false);
    expect(isCustodySegmentFilterActive({ addressQuery: "   " })).toBe(false);
    expect(isCustodySegmentFilterActive({ originDateFrom: Number.NaN })).toBe(false);
    expect(isCustodySegmentFilterActive({ statuses: ["active"] })).toBe(true);
    expect(isCustodySegmentFilterActive({ addressQuery: "bc1q" })).toBe(true);
    expect(isCustodySegmentFilterActive({ originDateFrom: 1_700_000_000 })).toBe(true);
    expect(isCustodySegmentFilterActive({ originDateTo: 1_800_000_000 })).toBe(true);
  });

  it("with no active filter behaves exactly like the unfiltered keyset page", async () => {
    await bulkAddCustodySegments(Array.from({ length: 20 }, (_, i) => makeSegment(i)));

    const page = await getCustodySegmentsBeforeIdFiltered(Number.MAX_SAFE_INTEGER, 5, {});
    expect(page).toHaveLength(5);
    // Newest first.
    expect(page[0].segmentId).toBe("flt-0019");
    expect(await countCustodySegmentsFiltered({})).toBe(20);
    expect(await countCustodySegmentsFiltered(undefined)).toBe(20);
  });

  it("narrows by status and keeps page/count in lockstep", async () => {
    await bulkAddCustodySegments(Array.from({ length: 40 }, (_, i) => makeSegment(i)));
    const filter = { statuses: ["spent"] as CustodyStatus[] };

    const all = await collectAllPages(40, filter);
    // i % 4 === 1 → spent → 10 rows (i = 1,5,...,37).
    expect(all).toHaveLength(10);
    expect(all.every((s) => s.status === "spent")).toBe(true);
    expect(all[0].segmentId).toBe("flt-0037"); // newest spent first
    expect(await countCustodySegmentsFiltered(filter)).toBe(10);

    const multi = { statuses: ["spent", "split"] as CustodyStatus[] };
    expect(await countCustodySegmentsFiltered(multi)).toBe(20);
    const allMulti = await collectAllPages(40, multi);
    expect(allMulti).toHaveLength(20);
    expect(allMulti.every((s) => s.status === "spent" || s.status === "split")).toBe(true);
  });

  it("matches an address substring against origin OR current address, case-insensitively", async () => {
    await bulkAddCustodySegments([
      makeSegment(0),
      makeSegment(1, { currentAddress: "BC1QMARKCURRENT0000000000000000001" }),
      makeSegment(2, { originAddress: "bc1qmarkorigin00000000000000000002" }),
      makeSegment(3),
    ]);

    // Matches current address of row 1 and origin address of row 2 only.
    const all = await collectAllPages(4, { addressQuery: "mark" });
    expect(all.map((s) => s.segmentId).sort()).toEqual(["flt-0001", "flt-0002"]);
    expect(await countCustodySegmentsFiltered({ addressQuery: "MARK" })).toBe(2);

    // Rows missing currentAddress must not throw and simply not match on it.
    await clearAllLineageData();
    const sparse = makeSegment(9);
    delete (sparse as Partial<CustodySegment>).currentAddress;
    await bulkAddCustodySegments([sparse]);
    const sparseHit = await collectAllPages(1, { addressQuery: "fltorigin" });
    expect(sparseHit).toHaveLength(1);
    const sparseMiss = await collectAllPages(1, { addressQuery: "current" });
    expect(sparseMiss).toHaveLength(0);
  });

  it("narrows by origin-date range in Unix seconds, inclusive bounds", async () => {
    await bulkAddCustodySegments(Array.from({ length: 10 }, (_, i) => makeSegment(i)));
    // Rows 2..5: originDate = 1_700_000_000 + i*600.
    const from = 1_700_000_000 + 2 * 600;
    const to = 1_700_000_000 + 5 * 600;
    const all = await collectAllPages(10, { originDateFrom: from, originDateTo: to }, 2);
    expect(all.map((s) => s.segmentId)).toEqual(["flt-0005", "flt-0004", "flt-0003", "flt-0002"]);
    expect(await countCustodySegmentsFiltered({ originDateFrom: from, originDateTo: to })).toBe(4);

    // Open-ended ranges work on their own.
    expect(await countCustodySegmentsFiltered({ originDateFrom: 1_700_000_000 + 8 * 600 })).toBe(2);
    expect(await countCustodySegmentsFiltered({ originDateTo: 1_700_000_000 + 1 * 600 })).toBe(2);

    // A row with unknown origin date (0 = unconfirmed block time) is excluded
    // by any range rather than guessed into it.
    const unknown = makeSegment(99, { originDate: 0 });
    await bulkAddCustodySegments([unknown]);
    expect(await countCustodySegmentsFiltered({ originDateFrom: 0, originDateTo: Number.MAX_SAFE_INTEGER })).toBe(10);
  });

  it("combines all dimensions with AND", async () => {
    await bulkAddCustodySegments(Array.from({ length: 40 }, (_, i) => makeSegment(i)));
    const filter = {
      statuses: ["active"] as CustodyStatus[], // i % 4 === 0
      addressQuery: "fltorigin00000", // single-digit index: i < 10
      originDateFrom: 1_700_000_000 + 4 * 600,
    };
    const all = await collectAllPages(40, filter, 3);
    // i in {4, 8}: active, origin index < 10, originDate >= row 4's.
    expect(all.map((s) => s.segmentId)).toEqual(["flt-0008", "flt-0004"]);
    expect(await countCustodySegmentsFiltered(filter)).toBe(2);
  });
});

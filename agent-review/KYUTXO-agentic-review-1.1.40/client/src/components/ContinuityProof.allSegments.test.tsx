// @vitest-environment jsdom
//
// Regression coverage for the Continuity Proof "All Custody Segments" list.
// Previously the list only populated when an address was selected, so an
// unselected view showed "No custody segments built yet" directly under a stat
// card counting thousands of segments. These tests lock in that:
//   1. the unselected view pages the custodySegments table (first page only,
//      never a full-table mount) with a "Showing X of Y" indicator and a
//      Load-more control — including the reported regression where Load more
//      "did nothing" because a sparse restored segment (missing evidenceTxids
//      with hopCount > 0) crashed the whole render the moment a later page
//      pulled it onto the screen,
//   2. the empty-state copy only claims "no segments built yet" when the
//      segment count really is zero, and only shows the build guidance when
//      BOTH counts are zero,
//   3. a build (buildAllLineage + buildAllCustodySegments) refreshes the
//      unselected list afterwards,
//   4. the per-address view is unchanged (unpaged, no progress indicator),
//   5. the status/address/date filters narrow the paged query itself (with a
//      filtered "Showing X of Y" total), and changing filters resets the
//      paged list instead of appending stale pages.
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

// The lineage engine is heavy (full table scans); stub the build/address
// entry points. CRUD reads (counts + paged segment reads) stay real against
// fake-indexeddb so pagination is genuinely exercised.
const buildAllLineageMock = vi.fn();
const buildAllCustodySegmentsMock = vi.fn();
const getSegmentsForAddressMock = vi.fn();
vi.mock("@/lib/lineageEngine", () => ({
  buildAllLineage: (...args: unknown[]) => buildAllLineageMock(...args),
  buildAllCustodySegments: (...args: unknown[]) => buildAllCustodySegmentsMock(...args),
  getSegmentsForAddress: (...args: unknown[]) => getSegmentsForAddressMock(...args),
  getLineageChainForAddress: async () => ({ chain: [], truncated: false }),
  getCustodyDuration: () => ({ totalDays: 0 }),
}));

import { renderWithProviders } from "@/test/testProviders";
import {
  bulkAddCustodySegments,
  addUtxoLineage,
  clearAllLineageData,
} from "@/lib/data/lineage-crud";
import type { CustodySegment } from "@/lib/database";
import { ContinuityProof } from "./ContinuityProof";

function makeSegment(i: number, overrides: Partial<CustodySegment> = {}): CustodySegment {
  return {
    segmentId: `seg-${i.toString().padStart(4, "0")}`,
    originTxid: i.toString(16).padStart(64, "0"),
    originVout: 0,
    originAddress: `bc1qorigin${i.toString().padStart(6, "0")}`,
    originDate: 1_700_000_000 + i,
    originAmount: 100_000 + i,
    currentAmount: 100_000 + i,
    status: "active",
    hopCount: 0,
    evidenceTxids: [],
    narrative: `Segment ${i}`,
    createdAt: 1_700_000_000 + i,
    updatedAt: 1_700_000_000 + i,
    ...overrides,
  } as CustodySegment;
}

beforeEach(async () => {
  localStorage.clear();
  buildAllLineageMock.mockReset();
  buildAllCustodySegmentsMock.mockReset();
  getSegmentsForAddressMock.mockReset();
  buildAllLineageMock.mockResolvedValue({ processed: 0, created: 0 });
  buildAllCustodySegmentsMock.mockResolvedValue({ processed: 0, created: 0 });
  getSegmentsForAddressMock.mockResolvedValue([]);
  await clearAllLineageData();
});

afterEach(() => {
  cleanup();
});

// The filtered count query runs after each page lands, so Load more stays
// disabled for a tick after the indicator updates. Clicking a disabled button
// is swallowed by React — always wait for the enabled state first.
async function clickLoadMoreWhenReady() {
  const button = await screen.findByTestId("button-load-more-segments");
  await waitFor(() => {
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
  fireEvent.click(button);
}

describe("ContinuityProof all-segments list", () => {
  it("pages the full segment table when no address is selected", async () => {
    // 60 segments > 50-page size: only the first page may mount.
    await bulkAddCustodySegments(Array.from({ length: 60 }, (_, i) => makeSegment(i)));

    renderWithProviders(<ContinuityProof />);

    await waitFor(() => {
      expect(screen.getByTestId("text-segments-showing").textContent).toContain("Showing 50 of 60 segments");
    });
    expect(screen.getByTestId("text-segment-count").textContent).toBe("60");
    // Newest-first ordering: segment 59 heads the list.
    expect(screen.getByText("Segment 59")).toBeTruthy();
    // No full-table mount: exactly one page of narrative cards rendered.
    expect(screen.getAllByText(/^Segment \d+$/)).toHaveLength(50);
    // The stale "not built yet" copy must never show while the count is non-zero.
    expect(screen.queryByText(/No custody segments built yet/)).toBeNull();

    await clickLoadMoreWhenReady();

    await waitFor(() => {
      expect(screen.getByTestId("text-segments-showing").textContent).toContain("Showing 60 of 60 segments");
    });
    expect(screen.getAllByText(/^Segment \d+$/)).toHaveLength(60);
    expect(screen.queryByTestId("button-load-more-segments")).toBeNull();
  });

  it("shows build guidance only when both counts are zero", async () => {
    renderWithProviders(<ContinuityProof />);

    await waitFor(() => {
      expect(screen.getByText(/Click "Build Lineage" to analyze/)).toBeTruthy();
    });
  });

  it("shows the not-built-yet copy when lineage exists but segments do not", async () => {
    await addUtxoLineage({
      spentTxid: "a".repeat(64),
      spentVout: 0,
      spentAddress: "bc1qspent",
      spentAmount: 50_000,
      consumingTxid: "b".repeat(64),
      createdTxid: "b".repeat(64),
      createdVout: 0,
      createdAddress: "bc1qcreated",
      createdAmount: 49_000,
      spentOwned: true,
      createdOwned: true,
      isChange: false,
      confidence: "high",
      blockTime: 1_700_000_000,
      blockHeight: 800_000,
      createdAt: 1_700_000_000,
    });

    renderWithProviders(<ContinuityProof />);

    await waitFor(() => {
      expect(screen.getByText(/No custody segments built yet/)).toBeTruthy();
    });
    expect(screen.queryByText(/Click "Build Lineage"/)).toBeNull();
  });

  it("refreshes the unselected list after a build completes", async () => {
    buildAllCustodySegmentsMock.mockImplementation(async () => {
      await bulkAddCustodySegments([makeSegment(1), makeSegment(2), makeSegment(3)]);
      return { processed: 3, created: 3 };
    });

    renderWithProviders(<ContinuityProof />);

    await waitFor(() => {
      expect(screen.getByText(/Click "Build Lineage" to analyze/)).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("button-build-lineage"));

    await waitFor(() => {
      expect(screen.getByTestId("text-segments-showing").textContent).toContain("Showing 3 of 3 segments");
    });
    expect(screen.getByText("Segment 3")).toBeTruthy();
    expect(buildAllLineageMock).toHaveBeenCalledOnce();
    expect(buildAllCustodySegmentsMock).toHaveBeenCalledOnce();
  });

  it("pages beyond the second page with Load more", async () => {
    // 110 segments: 50 -> 100 -> 110 across two Load-more clicks.
    await bulkAddCustodySegments(Array.from({ length: 110 }, (_, i) => makeSegment(i)));

    renderWithProviders(<ContinuityProof />);

    await waitFor(() => {
      expect(screen.getByTestId("text-segments-showing").textContent).toContain("Showing 50 of 110 segments");
    });

    await clickLoadMoreWhenReady();
    await waitFor(() => {
      expect(screen.getByTestId("text-segments-showing").textContent).toContain("Showing 100 of 110 segments");
    });
    expect(screen.getAllByText(/^Segment \d+$/)).toHaveLength(100);

    await clickLoadMoreWhenReady();
    await waitFor(() => {
      expect(screen.getByTestId("text-segments-showing").textContent).toContain("Showing 110 of 110 segments");
    });
    expect(screen.getAllByText(/^Segment \d+$/)).toHaveLength(110);
    expect(screen.queryByTestId("button-load-more-segments")).toBeNull();
  });

  it("Load more survives sparse restored segments on a later page (render-crash regression)", async () => {
    // The reported "Load more does nothing" regression: rows restored from an
    // older backup can be sparse — evidenceTxids typed required but absent in
    // the stored row. The moment a paged append pulled such a row onto the
    // screen, `segment.evidenceTxids.map` threw during render and, with no
    // error boundary, tore down the whole list. Sparse rows get the LOWEST
    // ids here so they land exactly on the second page.
    const sparse = Array.from({ length: 5 }, (_, i) => {
      const s = makeSegment(i, { hopCount: 2 });
      delete (s as Partial<CustodySegment>).evidenceTxids;
      return s;
    });
    const normal = Array.from({ length: 55 }, (_, i) => makeSegment(i + 5));
    await bulkAddCustodySegments([...sparse, ...normal]);

    renderWithProviders(<ContinuityProof />);

    await waitFor(() => {
      expect(screen.getByTestId("text-segments-showing").textContent).toContain("Showing 50 of 60 segments");
    });

    await clickLoadMoreWhenReady();

    // Pre-fix this click crashed the render and the list disappeared.
    await waitFor(() => {
      expect(screen.getByTestId("text-segments-showing").textContent).toContain("Showing 60 of 60 segments");
    });
    expect(screen.getAllByText(/^Segment \d+$/)).toHaveLength(60);
    // The sparse rows render (their Transfer History section is tolerated).
    expect(screen.getByText("Segment 0")).toBeTruthy();
    expect(screen.queryByTestId("button-load-more-segments")).toBeNull();
  });

  it("filters segments by status with a filtered total and filtered paging", async () => {
    // 120 segments, alternating spent (even i) / active (odd i) -> 60 spent.
    await bulkAddCustodySegments(
      Array.from({ length: 120 }, (_, i) =>
        makeSegment(i, { status: i % 2 === 0 ? "spent" : "active" })
      )
    );

    renderWithProviders(<ContinuityProof />);

    await waitFor(() => {
      expect(screen.getByTestId("text-segments-showing").textContent).toContain("Showing 50 of 120 segments");
    });
    // Newest odd segment is visible unfiltered.
    expect(screen.getByText("Segment 119")).toBeTruthy();

    // Solo the Spent chip: the query itself narrows (server-side), and the
    // indicator switches to the filtered total.
    fireEvent.click(screen.getByTestId("filter-status-spent"));

    await waitFor(() => {
      expect(screen.getByTestId("text-segments-showing").textContent).toContain("Showing 50 of 60 segments (filtered)");
    });
    // The stale unfiltered page must be replaced, not appended to.
    expect(screen.getAllByText(/^Segment \d+$/)).toHaveLength(50);
    expect(screen.queryByText("Segment 119")).toBeNull();
    expect(screen.getByText("Segment 118")).toBeTruthy();

    await clickLoadMoreWhenReady();
    await waitFor(() => {
      expect(screen.getByTestId("text-segments-showing").textContent).toContain("Showing 60 of 60 segments (filtered)");
    });
    expect(screen.getAllByText(/^Segment \d+$/)).toHaveLength(60);
    expect(screen.queryByTestId("button-load-more-segments")).toBeNull();

    // Clearing restores the unfiltered paged list at page one.
    fireEvent.click(screen.getByTestId("button-clear-segment-filters"));
    await waitFor(() => {
      expect(screen.getByTestId("text-segments-showing").textContent).toContain("Showing 50 of 120 segments");
    });
    expect(screen.getByText("Segment 119")).toBeTruthy();
  });

  it("filters segments by an address substring (debounced) against origin address", async () => {
    await bulkAddCustodySegments(Array.from({ length: 60 }, (_, i) => makeSegment(i)));

    renderWithProviders(<ContinuityProof />);

    await waitFor(() => {
      expect(screen.getByTestId("text-segments-showing").textContent).toContain("Showing 50 of 60 segments");
    });

    // "origin00005" matches origins of i = 50..59 -> 10 rows.
    fireEvent.change(screen.getByTestId("input-filter-address"), { target: { value: "origin00005" } });

    await waitFor(
      () => {
        expect(screen.getByTestId("text-segments-showing").textContent).toContain("Showing 10 of 10 segments (filtered)");
      },
      { timeout: 3000 }
    );
    expect(screen.getAllByText(/^Segment \d+$/)).toHaveLength(10);
    expect(screen.queryByTestId("button-load-more-segments")).toBeNull();

    // A query with no matches shows the filtered empty state, not "not built".
    fireEvent.change(screen.getByTestId("input-filter-address"), { target: { value: "zzno-such-address" } });
    await waitFor(
      () => {
        expect(screen.getByText(/No custody segments match the current filters/)).toBeTruthy();
      },
      { timeout: 3000 }
    );
    expect(screen.queryByText(/No custody segments built yet/)).toBeNull();

    // Clearing the input returns the full paged list.
    fireEvent.change(screen.getByTestId("input-filter-address"), { target: { value: "" } });
    await waitFor(
      () => {
        expect(screen.getByTestId("text-segments-showing").textContent).toContain("Showing 50 of 60 segments");
      },
      { timeout: 3000 }
    );
  });

  it("filters segments by an origin-date range", async () => {
    // One segment per day so a date range picks a contiguous block.
    const day = 86_400;
    await bulkAddCustodySegments(
      Array.from({ length: 60 }, (_, i) => makeSegment(i, { originDate: 1_700_000_000 + i * day }))
    );

    renderWithProviders(<ContinuityProof />);

    await waitFor(() => {
      expect(screen.getByTestId("text-segments-showing").textContent).toContain("Showing 50 of 60 segments");
    });

    const toDateInput = (unixSeconds: number) =>
      new Date(unixSeconds * 1000).toISOString().slice(0, 10);
    // Rows 20..29 inclusive -> 10 rows.
    fireEvent.change(screen.getByTestId("input-filter-origin-from"), {
      target: { value: toDateInput(1_700_000_000 + 20 * day) },
    });
    fireEvent.change(screen.getByTestId("input-filter-origin-to"), {
      target: { value: toDateInput(1_700_000_000 + 29 * day) },
    });

    await waitFor(() => {
      expect(screen.getByTestId("text-segments-showing").textContent).toContain("Showing 10 of 10 segments (filtered)");
    });
    expect(screen.getAllByText(/^Segment \d+$/)).toHaveLength(10);
    expect(screen.getByText("Segment 29")).toBeTruthy();
    expect(screen.getByText("Segment 20")).toBeTruthy();
    expect(screen.queryByText("Segment 30")).toBeNull();
  });

  it("keeps filters hidden in the per-address view", async () => {
    await bulkAddCustodySegments([makeSegment(1)]);
    getSegmentsForAddressMock.mockResolvedValue([makeSegment(1)]);

    renderWithProviders(<ContinuityProof selectedAddress="bc1qorigin000001" />);

    await waitFor(() => {
      expect(screen.getByText("Segment 1")).toBeTruthy();
    });
    expect(screen.queryByTestId("segment-filters")).toBeNull();
  });

  it("keeps the per-address view unpaged with no progress indicator", async () => {
    await bulkAddCustodySegments([makeSegment(1), makeSegment(2)]);
    getSegmentsForAddressMock.mockResolvedValue([makeSegment(1)]);

    renderWithProviders(<ContinuityProof selectedAddress="bc1qorigin000001" />);

    await waitFor(() => {
      expect(screen.getByText("Segment 1")).toBeTruthy();
    });
    expect(screen.queryByText("Segment 2")).toBeNull();
    expect(screen.queryByTestId("text-segments-showing")).toBeNull();
    expect(screen.queryByTestId("button-load-more-segments")).toBeNull();
  });

  it("shows the address-specific empty message for a selected address with no segments", async () => {
    await bulkAddCustodySegments([makeSegment(1)]);

    renderWithProviders(<ContinuityProof selectedAddress="bc1qunknown" />);

    await waitFor(() => {
      expect(screen.getByText(/No custody segments found for this address/)).toBeTruthy();
    });
  });
});

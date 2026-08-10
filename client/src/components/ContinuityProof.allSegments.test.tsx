// @vitest-environment jsdom
//
// Regression coverage for the Continuity Proof "All Custody Segments" list.
// Previously the list only populated when an address was selected, so an
// unselected view showed "No custody segments built yet" directly under a stat
// card counting thousands of segments. These tests lock in that:
//   1. the unselected view pages the custodySegments table (first page only,
//      never a full-table mount) with a "Showing X of Y" indicator and a
//      Load-more control,
//   2. the empty-state copy only claims "no segments built yet" when the
//      segment count really is zero, and only shows the build guidance when
//      BOTH counts are zero,
//   3. a build (buildAllLineage + buildAllCustodySegments) refreshes the
//      unselected list afterwards,
//   4. the per-address view is unchanged (unpaged, no progress indicator).
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

function makeSegment(i: number): CustodySegment {
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

    fireEvent.click(screen.getByTestId("button-load-more-segments"));

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

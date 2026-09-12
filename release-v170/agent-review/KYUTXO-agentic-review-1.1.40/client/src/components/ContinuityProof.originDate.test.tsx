// @vitest-environment jsdom
//
// Regression coverage for the Continuity Proof origin-date rendering.
// CustodySegment.originDate is stored as Unix SECONDS (from
// blockchainTransactions.blockTime), but the page previously fed the raw
// number straight into date-fns / new Date(), which treat it as
// milliseconds — rendering "Jan 20, 1970" and "over 56 years ago" for coins
// acquired in 2025. These tests lock in that:
//   1. the Origin "Date:" row, the card-header relative-time badge, and the
//      "Custody from <date>" fallback description all render the real
//      calendar date from a known Unix-seconds value,
//   2. the per-segment JSON export writes a correct ISO origin.date,
//   3. a segment whose origin transaction has no block time (originDate 0)
//      renders "Unknown" instead of the 1970 epoch, and exports a null date.
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { format, formatDistanceToNow } from "date-fns";

// Same partial-stub pattern as ContinuityProof.allSegments.test.tsx: stub the
// heavy build/address entry points, keep CRUD reads real against
// fake-indexeddb.
vi.mock("@/lib/lineageEngine", () => ({
  buildAllLineage: vi.fn(async () => ({ processed: 0, created: 0 })),
  buildAllCustodySegments: vi.fn(async () => ({ processed: 0, created: 0 })),
  getSegmentsForAddress: vi.fn(async () => []),
  getLineageChainForAddress: async () => ({ chain: [], truncated: false }),
  getCustodyDuration: () => ({ totalDays: 0 }),
}));

import { renderWithProviders } from "@/test/testProviders";
import {
  bulkAddCustodySegments,
  clearAllLineageData,
} from "@/lib/data/lineage-crud";
import type { CustodySegment } from "@/lib/database";
import { ContinuityProof } from "./ContinuityProof";

// 2025-01-25T14:30:00Z — a known Unix-seconds acquisition time. Mid-day UTC so
// date-only assertions are timezone-stable.
const ORIGIN_UNIX_SECONDS = 1_737_815_400;

function makeSegment(overrides: Partial<CustodySegment> = {}): CustodySegment {
  return {
    segmentId: "seg-date-0001",
    originTxid: "a".repeat(64),
    originVout: 0,
    originAddress: "bc1qorigin000001",
    originDate: ORIGIN_UNIX_SECONDS,
    originAmount: 100_000,
    currentAmount: 100_000,
    status: "active",
    hopCount: 0,
    evidenceTxids: [],
    narrative: "Acquired from exchange",
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    ...overrides,
  } as CustodySegment;
}

async function expandSegmentCard() {
  // The segment card body (Origin date row, export button) only mounts once
  // the collapsible is opened.
  const cardHeader = screen
    .getByText(/BTC/)
    .closest("[data-state]");
  expect(cardHeader).toBeTruthy();
  fireEvent.click(cardHeader!);
}

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

beforeEach(async () => {
  localStorage.clear();
  await clearAllLineageData();
  // jsdom does not implement object URLs; stub them so the export path runs.
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = vi.fn(
    () => "blob:mock-url"
  );
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
});

describe("ContinuityProof origin-date rendering", () => {
  it("renders the real acquisition date from Unix seconds, not the 1970 epoch", async () => {
    // No narrative → the "Custody from <date>" fallback description renders.
    await bulkAddCustodySegments([makeSegment({ narrative: undefined })]);

    renderWithProviders(<ContinuityProof />);

    const expectedDate = format(new Date(ORIGIN_UNIX_SECONDS * 1000), "MMM d, yyyy");
    await waitFor(() => {
      expect(screen.getByText(`Custody from ${expectedDate}`)).toBeTruthy();
    });
    expect(expectedDate).toBe("Jan 25, 2025");

    // Header relative-time badge: must match the real elapsed time, not
    // "over 56 years ago".
    const expectedDistance = formatDistanceToNow(new Date(ORIGIN_UNIX_SECONDS * 1000), {
      addSuffix: true,
    });
    expect(screen.getByText(expectedDistance)).toBeTruthy();
    expect(screen.queryByText(/56 years/)).toBeNull();

    // Expanded Origin "Date:" row shows the full date+time.
    await expandSegmentCard();
    const expectedDateTime = format(
      new Date(ORIGIN_UNIX_SECONDS * 1000),
      "MMM d, yyyy HH:mm"
    );
    await waitFor(() => {
      expect(screen.getByText(expectedDateTime)).toBeTruthy();
    });
  });

  it("exports a correct ISO origin.date in the per-segment JSON", async () => {
    await bulkAddCustodySegments([makeSegment()]);

    renderWithProviders(<ContinuityProof />);

    await waitFor(() => {
      expect(screen.getByText(/Acquired from exchange/)).toBeTruthy();
    });
    await expandSegmentCard();

    fireEvent.click(screen.getByTestId("button-export-segment-seg-date-0001"));

    const createObjectURL = URL.createObjectURL as unknown as ReturnType<typeof vi.fn>;
    expect(createObjectURL).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    const exported = JSON.parse(await readBlob(blob));
    expect(exported.origin.date).toBe(new Date(ORIGIN_UNIX_SECONDS * 1000).toISOString());
    expect(exported.origin.date.startsWith("2025-01-25")).toBe(true);
    expect(exported.origin.date.startsWith("1970-")).toBe(false);
  });

  it("renders Unknown for a segment with no origin block time", async () => {
    await bulkAddCustodySegments([
      makeSegment({ segmentId: "seg-date-zero", originDate: 0, narrative: undefined }),
    ]);

    renderWithProviders(<ContinuityProof />);

    // Fallback description and header badge both degrade to "Unknown".
    await waitFor(() => {
      expect(screen.getByText("Custody from Unknown")).toBeTruthy();
    });
    expect(screen.queryByText(/1970/)).toBeNull();

    await expandSegmentCard();
    await waitFor(() => {
      expect(screen.getAllByText("Unknown").length).toBeGreaterThanOrEqual(2);
    });
    expect(screen.queryByText(/Jan 1, 1970/)).toBeNull();

    // Export omits the date (null) rather than the epoch ISO string.
    fireEvent.click(screen.getByTestId("button-export-segment-seg-date-zero"));
    const createObjectURL = URL.createObjectURL as unknown as ReturnType<typeof vi.fn>;
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    const exported = JSON.parse(await readBlob(blob));
    expect(exported.origin.date).toBeNull();
  });
});

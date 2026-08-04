// @vitest-environment jsdom
//
// Covers the per-transaction detail list in the "Last rebuild result" panel
// (maintenance-tools-section.tsx): after a rebuild, each affected txid must be
// listed with a human-readable outcome, a copy button for the FULL txid, and a
// link that opens the corresponding transaction record. Large result sets are
// capped behind a "Show all N transactions" expand affordance. The completion
// toast names the (truncated) txid when exactly one orphan was processed.
//
// detectAndBackfill is stubbed (no provider/network here); the rendering logic
// (formatDetailOutcome, TxidLink wiring, the cap/expand behaviour) is real.
// useRecordPreview is overridden with spies so the record-link click is
// observable without driving the whole global preview flow.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-toast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-toast")>();
  return {
    ...actual,
    useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
  };
});

vi.mock("@/hooks/use-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-settings")>();
  const { DEFAULT_HOVER_TOOLTIP_PREFS } = await import("@/lib/metadata-hover");
  return {
    ...actual,
    useSettings: () => ({
      disableOrphanCheck: false,
      isLoading: false,
      hoverTooltipPrefs: DEFAULT_HOVER_TOOLTIP_PREFS,
    }),
    updateDisableOrphanCheck: vi.fn(),
  };
});

const detectAndBackfillMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/txid-backfill", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/txid-backfill")>();
  return {
    ...actual,
    detectAndBackfill: detectAndBackfillMock,
  };
});

// TxidLink resolves the record-open action through useRecordPreview; spy on it
// so a click on a listed txid observably opens the right record.
//
// Full module mock, deliberately WITHOUT importOriginal: the actual
// RecordPreviewContext imports RecordDetailPanel which imports TxidLink which
// imports RecordPreviewContext again — under that circular load, an
// importOriginal-based partial mock makes TxidLink bind to the REAL hook and
// the spy never fires. The passthrough provider keeps renderWithProviders
// working.
const openRecordPreviewSpy = vi.hoisted(() => vi.fn());
vi.mock("@/contexts/RecordPreviewContext", () => ({
  RecordPreviewProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useRecordPreview: () => ({
    openRecordPreview: openRecordPreviewSpy,
    openRecordPreviewByAddress: vi.fn(),
    openRecordEdit: vi.fn(),
  }),
}));

import type { BackfillResult, BackfillTxDetail } from "@/lib/txid-backfill";

const { renderWithProviders } = await import("@/test/testProviders");
const { MaintenanceToolsSection } = await import("./maintenance-tools-section");

const TXID_A = "a1b2c3d4".padEnd(64, "0");
const TXID_B = "b2c3d4e5".padEnd(64, "1");
const TXID_C = "c3d4e5f6".padEnd(64, "2");

function makeResult(over: Partial<BackfillResult> = {}): BackfillResult {
  return {
    orphansFound: 3,
    rebuilt: 1,
    skipped: 1,
    skippedReasons: { "not-found": 1 },
    failed: 1,
    prevoutsResolved: 0,
    deferred: false,
    errors: [],
    details: [
      { txid: TXID_A, outcome: "rebuilt", recordId: 11 },
      { txid: TXID_B, outcome: "skipped", reason: "not-found", recordId: 22 },
      { txid: TXID_C, outcome: "failed", reason: "fetch failed", recordId: 33 },
    ],
    ...over,
  };
}

const writeTextSpy = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  sessionStorage.clear();
  toastSpy.mockReset();
  detectAndBackfillMock.mockReset();
  openRecordPreviewSpy.mockReset();
  writeTextSpy.mockClear();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: writeTextSpy },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
});

async function runRebuild(result: BackfillResult) {
  detectAndBackfillMock.mockResolvedValue(result);
  renderWithProviders(<MaintenanceToolsSection />);
  fireEvent.click(screen.getByTestId("button-rebuild-transactions"));
  await waitFor(() => {
    expect(screen.getByTestId("rebuild-result-summary")).toBeTruthy();
  });
}

describe("Last rebuild result — per-transaction details", () => {
  it("lists each affected txid with its outcome label", async () => {
    await runRebuild(makeResult());

    const detailsBlock = screen.getByTestId("rebuild-result-details");
    expect(detailsBlock.textContent).toContain("Affected transactions");

    expect(
      screen.getByTestId(`rebuild-detail-outcome-${TXID_A.slice(0, 8)}`).textContent,
    ).toBe("Rebuilt");
    expect(
      screen.getByTestId(`rebuild-detail-outcome-${TXID_B.slice(0, 8)}`).textContent,
    ).toBe("Skipped — not found on your connected provider");
    expect(
      screen.getByTestId(`rebuild-detail-outcome-${TXID_C.slice(0, 8)}`).textContent,
    ).toBe("Failed — fetch failed");

    // Displayed txid is truncated, not the full 64 chars.
    const link = screen.getByTestId(`link-txid-${TXID_A.slice(0, 8)}`);
    expect(link.textContent).toContain(`${TXID_A.slice(0, 8)}…${TXID_A.slice(-6)}`);
    expect(link.textContent).not.toContain(TXID_A);
  });

  it("copy button copies the FULL txid, not the truncated display", async () => {
    await runRebuild(makeResult());

    fireEvent.click(screen.getByTestId(`button-copy-txid-${TXID_B.slice(0, 8)}`));

    await waitFor(() => {
      expect(writeTextSpy).toHaveBeenCalledWith(TXID_B);
    });
  });

  it("clicking a listed txid opens its transaction record", async () => {
    await runRebuild(makeResult());

    fireEvent.click(screen.getByTestId(`link-txid-${TXID_C.slice(0, 8)}`));

    await waitFor(() => {
      expect(openRecordPreviewSpy).toHaveBeenCalledWith(33);
    });
  });

  it("caps large lists and expands them via 'Show all'", async () => {
    const details: BackfillTxDetail[] = Array.from({ length: 25 }, (_, i) => ({
      txid: i.toString(16).padStart(8, "f").padEnd(64, "0"),
      outcome: "skipped",
      reason: "not-found",
      recordId: i + 1,
    }));
    await runRebuild(
      makeResult({
        orphansFound: 25,
        rebuilt: 0,
        skipped: 25,
        failed: 0,
        skippedReasons: { "not-found": 25 },
        details,
      }),
    );

    const list = screen.getByTestId("rebuild-result-details");
    expect(list.querySelectorAll("li")).toHaveLength(10);

    const showAll = screen.getByTestId("button-show-all-rebuild-details");
    expect(showAll.textContent).toContain("Show all 25 transactions");
    fireEvent.click(showAll);

    await waitFor(() => {
      expect(list.querySelectorAll("li")).toHaveLength(25);
    });
    expect(screen.queryByTestId("button-show-all-rebuild-details")).toBeNull();
  });

  it("renders no details block when the result has an empty detail list", async () => {
    await runRebuild(
      makeResult({
        orphansFound: 2,
        rebuilt: 0,
        skipped: 2,
        failed: 0,
        skippedReasons: { "not-found": 2 },
        details: [],
      }),
    );

    expect(screen.queryByTestId("rebuild-result-details")).toBeNull();
  });

  it("Dismiss button removes the rebuild result panel", async () => {
    await runRebuild(makeResult());

    fireEvent.click(screen.getByTestId("button-dismiss-rebuild-result"));

    await waitFor(() => {
      expect(screen.queryByTestId("rebuild-result-summary")).toBeNull();
    });
  });

  it("names the truncated txid in the completion toast when exactly one orphan was processed", async () => {
    await runRebuild(
      makeResult({
        orphansFound: 1,
        rebuilt: 1,
        skipped: 0,
        failed: 0,
        skippedReasons: {},
        details: [{ txid: TXID_A, outcome: "rebuilt", recordId: 11 }],
      }),
    );

    const call = toastSpy.mock.calls.find(
      (c) => c[0]?.title === "Transaction Rebuild Complete",
    );
    expect(call).toBeTruthy();
    expect(call![0].description).toContain(`${TXID_A.slice(0, 8)}…${TXID_A.slice(-6)}`);
  });

  it("does not name a txid in the toast when several orphans were processed", async () => {
    await runRebuild(makeResult());

    const call = toastSpy.mock.calls.find(
      (c) => c[0]?.title === "Transaction Rebuild Complete",
    );
    expect(call).toBeTruthy();
    expect(call![0].description).not.toContain(TXID_A.slice(0, 8));
  });
});

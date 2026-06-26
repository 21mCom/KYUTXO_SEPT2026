// @vitest-environment jsdom
//
// Coverage for the Privacy History card's export selection wiring (Task: "Test
// that the privacy history export honors the run selection").
//
// The card lets users hand-pick which stored audit runs (via per-run
// checkboxes) and an optional date range feed the CSV/PDF exports, defaulting to
// ALL runs when nothing is picked. Nothing covered that the selection actually
// reaches the export builders, so a regression could silently make exports
// ignore the user's choice. These tests render the real component, mock the two
// export builders, and assert exactly which runs are handed to them.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

// The card reads its runs through useLiveQuery; feed it a fixed fixture so the
// test never touches IndexedDB.
let mockHistory: unknown = undefined;
vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockHistory,
}));

// Spy on the export builders — this is the seam the test asserts against. CSV is
// synchronous and PDF is async, mirroring the real signatures.
vi.mock("@/lib/privacy-history-export", () => ({
  buildPrivacyHistoryCsv: vi.fn(() => "csv,data"),
  buildPrivacyHistoryPdf: vi.fn(async () => new Blob(["pdf"], { type: "application/pdf" })),
}));

// Clearing history is irrelevant here but is imported by the module.
vi.mock("@/lib/data/privacy-history-crud", () => ({
  addPrivacyAuditHistoryEntry: vi.fn(),
  clearPrivacyAuditHistory: vi.fn(),
}));

import { buildPrivacyHistoryCsv, buildPrivacyHistoryPdf } from "@/lib/privacy-history-export";
import type { PrivacyAuditHistoryEntry } from "@/lib/database";
import { PrivacyHistoryCard } from "./PrivacyAudit";

const mockedCsv = vi.mocked(buildPrivacyHistoryCsv);
const mockedPdf = vi.mocked(buildPrivacyHistoryPdf);

// Three runs with distinct ids and timestamps spread across 2026 so the date
// range filter has something to bite on.
const TS_JAN = new Date("2026-01-10T12:00:00").getTime();
const TS_MAR = new Date("2026-03-15T12:00:00").getTime();
const TS_JUN = new Date("2026-06-20T12:00:00").getTime();

function makeRun(id: number, timestamp: number, score: number): PrivacyAuditHistoryEntry {
  return {
    id,
    timestamp,
    score,
    grade: "B",
    totalFindings: 2,
    transactionsAnalyzed: 10,
    addressesScanned: 5,
    severityCounts: { CRITICAL: 0, HIGH: 1, MEDIUM: 1, LOW: 0 },
    findingTypeCounts: { ADDRESS_REUSE: 2 },
  };
}

// db.privacyAuditHistory stores oldest → newest; the card relies on that order.
const RUN_JAN = makeRun(1, TS_JAN, 70);
const RUN_MAR = makeRun(2, TS_MAR, 80);
const RUN_JUN = makeRun(3, TS_JUN, 90);

function renderCard(runs: PrivacyAuditHistoryEntry[]) {
  mockHistory = runs;
  return render(<PrivacyHistoryCard />);
}

/** ids of the entries passed to the most recent CSV export call. */
function lastCsvExportedIds(): number[] {
  const arg = mockedCsv.mock.calls[mockedCsv.mock.calls.length - 1][0];
  return arg.map((e) => e.id!);
}

// Stub the DOM download plumbing the export handlers use; jsdom has neither
// URL.createObjectURL nor a real navigation. recharts' ResponsiveContainer also
// needs ResizeObserver, which jsdom doesn't provide.
beforeEach(() => {
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:fake"),
    revokeObjectURL: vi.fn(),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mockHistory = undefined;
});

describe("PrivacyHistoryCard export selection", () => {
  it("exports ALL runs when nothing is selected (the default)", () => {
    renderCard([RUN_JAN, RUN_MAR, RUN_JUN]);

    // The hint should reflect the all-runs default.
    expect(screen.getByTestId("text-history-export-hint").textContent).toContain(
      "all stored runs",
    );

    fireEvent.click(screen.getByTestId("button-export-history-csv"));

    expect(mockedCsv).toHaveBeenCalledTimes(1);
    expect(lastCsvExportedIds().sort()).toEqual([1, 2, 3]);
  });

  it("passes only the hand-picked subset to the CSV export builder", () => {
    renderCard([RUN_JAN, RUN_MAR, RUN_JUN]);

    // Pick the Jan and Jun runs, leaving March out.
    fireEvent.click(screen.getByTestId("checkbox-history-select-1"));
    fireEvent.click(screen.getByTestId("checkbox-history-select-3"));

    expect(screen.getByTestId("text-history-selected-count").textContent).toContain(
      "2 selected",
    );

    fireEvent.click(screen.getByTestId("button-export-history-csv"));

    expect(mockedCsv).toHaveBeenCalledTimes(1);
    expect(lastCsvExportedIds().sort()).toEqual([1, 3]);
  });

  it("passes the hand-picked subset to the async PDF export builder too", async () => {
    renderCard([RUN_JAN, RUN_MAR, RUN_JUN]);

    fireEvent.click(screen.getByTestId("checkbox-history-select-2"));

    fireEvent.click(screen.getByTestId("button-export-history-pdf"));

    await waitFor(() => expect(mockedPdf).toHaveBeenCalledTimes(1));
    const arg = mockedPdf.mock.calls[0][0];
    expect(arg.map((e) => e.id)).toEqual([2]);
  });

  it("'Select range' checks only the runs within the chosen date range", () => {
    renderCard([RUN_JAN, RUN_MAR, RUN_JUN]);

    // March 1 → June 30 should capture the March and June runs only.
    fireEvent.change(screen.getByTestId("input-history-from-date"), {
      target: { value: "2026-03-01" },
    });
    fireEvent.change(screen.getByTestId("input-history-to-date"), {
      target: { value: "2026-06-30" },
    });
    fireEvent.click(screen.getByTestId("button-history-select-range"));

    expect(screen.getByTestId("text-history-selected-count").textContent).toContain(
      "2 selected",
    );

    fireEvent.click(screen.getByTestId("button-export-history-csv"));

    expect(lastCsvExportedIds().sort()).toEqual([2, 3]);
  });

  it("'Select all' selects every run, then exports all of them", () => {
    renderCard([RUN_JAN, RUN_MAR, RUN_JUN]);

    fireEvent.click(screen.getByTestId("button-history-select-all"));
    expect(screen.getByTestId("text-history-selected-count").textContent).toContain(
      "3 selected",
    );

    fireEvent.click(screen.getByTestId("button-export-history-csv"));
    expect(lastCsvExportedIds().sort()).toEqual([1, 2, 3]);
  });

  it("'Clear selection' reverts to the all-runs default", () => {
    renderCard([RUN_JAN, RUN_MAR, RUN_JUN]);

    // Pick a subset, then clear it.
    fireEvent.click(screen.getByTestId("checkbox-history-select-1"));
    expect(screen.getByTestId("text-history-selected-count").textContent).toContain(
      "1 selected",
    );

    fireEvent.click(screen.getByTestId("button-history-clear-selection"));

    // Selection count badge is gone and the hint is back to the all-runs default.
    expect(screen.queryByTestId("text-history-selected-count")).toBeNull();
    expect(screen.getByTestId("text-history-export-hint").textContent).toContain(
      "all stored runs",
    );

    fireEvent.click(screen.getByTestId("button-export-history-csv"));
    expect(lastCsvExportedIds().sort()).toEqual([1, 2, 3]);
  });
});

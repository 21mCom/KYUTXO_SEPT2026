// @vitest-environment jsdom
//
// Coverage for the Privacy History card's empty-date-range guard (Task:
// "Confirm the empty-date-range warning never silently exports everything").
//
// "Select range" used to silently revert to the "export all runs" default when
// the chosen date range matched zero stored runs — an easy way to accidentally
// export the entire history. It now leaves the current selection untouched and
// surfaces an amber warning instead. These tests render the real component and
// assert that the selection is preserved, the warning appears, and that editing
// a date input clears it again.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

// The card reads its runs through useLiveQuery; feed it a fixed fixture so the
// test never touches IndexedDB.
let mockHistory: unknown = undefined;
vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockHistory,
}));

// Export builders are irrelevant here but are imported by the module.
vi.mock("@/lib/privacy-history-export", () => ({
  buildPrivacyHistoryCsv: vi.fn(() => "csv,data"),
  buildPrivacyHistoryPdf: vi.fn(async () => new Blob(["pdf"], { type: "application/pdf" })),
}));

// Clearing history is irrelevant here but is imported by the module.
vi.mock("@/lib/data/privacy-history-crud", () => ({
  addPrivacyAuditHistoryEntry: vi.fn(),
  clearPrivacyAuditHistory: vi.fn(),
}));

import type { PrivacyAuditHistoryEntry } from "@/lib/database";
import { PrivacyHistoryCard } from "./PrivacyAudit";

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

function setRange(from: string, to: string) {
  fireEvent.change(screen.getByTestId("input-history-from-date"), {
    target: { value: from },
  });
  fireEvent.change(screen.getByTestId("input-history-to-date"), {
    target: { value: to },
  });
}

function hintText(): string {
  return screen.getByTestId("text-history-export-hint").textContent ?? "";
}

// recharts' ResponsiveContainer needs ResizeObserver, which jsdom doesn't have.
beforeEach(() => {
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

describe("PrivacyHistoryCard empty-date-range guard", () => {
  it("warns and leaves the selection untouched when a range matches zero runs", () => {
    renderCard([RUN_JAN, RUN_MAR, RUN_JUN]);

    // Start from a known, non-default selection: hand-pick the March run.
    fireEvent.click(screen.getByTestId("checkbox-history-select-2"));
    expect(screen.getByTestId("text-history-selected-count").textContent).toContain(
      "1 selected",
    );

    // Pick a range entirely after every stored run — matches nothing.
    setRange("2026-09-01", "2026-12-31");
    fireEvent.click(screen.getByTestId("button-history-select-range"));

    // The selection is unchanged (still exactly the March run), so exports do
    // NOT silently fall back to "all runs".
    expect(screen.getByTestId("text-history-selected-count").textContent).toContain(
      "1 selected",
    );
    expect(screen.getByTestId("checkbox-history-select-2").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByTestId("checkbox-history-select-1").getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(screen.getByTestId("checkbox-history-select-3").getAttribute("aria-checked")).toBe(
      "false",
    );

    // The amber warning hint is shown.
    expect(hintText()).toContain("0 runs fall in that date range");
  });

  it("does not fall back to the all-runs default when an empty range is picked with nothing selected", () => {
    renderCard([RUN_JAN, RUN_MAR, RUN_JUN]);

    // No runs picked yet — the default hint is shown.
    expect(hintText()).toContain("all stored runs");

    // An empty range must surface the warning, not the silent all-runs default.
    setRange("2026-09-01", "2026-12-31");
    fireEvent.click(screen.getByTestId("button-history-select-range"));

    expect(hintText()).toContain("0 runs fall in that date range");
    expect(hintText()).not.toContain("all stored runs");
    // Still nothing actually selected.
    expect(screen.queryByTestId("text-history-selected-count")).toBeNull();
  });

  it("clears the warning back to the normal hint when a date input changes", () => {
    renderCard([RUN_JAN, RUN_MAR, RUN_JUN]);

    setRange("2026-09-01", "2026-12-31");
    fireEvent.click(screen.getByTestId("button-history-select-range"));
    expect(hintText()).toContain("0 runs fall in that date range");

    // Editing a date input should clear the warning.
    fireEvent.change(screen.getByTestId("input-history-from-date"), {
      target: { value: "2026-01-01" },
    });

    expect(hintText()).not.toContain("0 runs fall in that date range");
    expect(hintText()).toContain("all stored runs");
  });

  it("clears the warning when the To date input changes", () => {
    renderCard([RUN_JAN, RUN_MAR, RUN_JUN]);

    setRange("2026-09-01", "2026-12-31");
    fireEvent.click(screen.getByTestId("button-history-select-range"));
    expect(hintText()).toContain("0 runs fall in that date range");

    fireEvent.change(screen.getByTestId("input-history-to-date"), {
      target: { value: "2026-07-31" },
    });

    expect(hintText()).not.toContain("0 runs fall in that date range");
  });

  it("selects the matching runs and clears the warning when a range DOES match", () => {
    renderCard([RUN_JAN, RUN_MAR, RUN_JUN]);

    // First trigger the warning with an empty range.
    setRange("2026-09-01", "2026-12-31");
    fireEvent.click(screen.getByTestId("button-history-select-range"));
    expect(hintText()).toContain("0 runs fall in that date range");

    // Now narrow to a range that captures the March and June runs.
    setRange("2026-03-01", "2026-06-30");
    fireEvent.click(screen.getByTestId("button-history-select-range"));

    // The matching runs are selected and the warning is gone.
    expect(screen.getByTestId("text-history-selected-count").textContent).toContain(
      "2 selected",
    );
    expect(screen.getByTestId("checkbox-history-select-2").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByTestId("checkbox-history-select-3").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByTestId("checkbox-history-select-1").getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(hintText()).not.toContain("0 runs fall in that date range");
    expect(hintText()).toContain("2 selected run");
  });
});

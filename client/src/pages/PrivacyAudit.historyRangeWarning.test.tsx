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
  computePrivacyHistoryScopeLabel: vi.fn(() => null),
}));

// Clearing history is irrelevant here but is imported by the module.
vi.mock("@/lib/data/privacy-history-crud", () => ({
  addPrivacyAuditHistoryEntry: vi.fn(),
  clearPrivacyAuditHistory: vi.fn(),
  getPrivacyAuditHistory: vi.fn(async () => mockHistory ?? []),
}));

import type { PrivacyAuditHistoryEntry } from "@/lib/database";
import { buildPrivacyHistoryCsv, buildPrivacyHistoryPdf } from "@/lib/privacy-history-export";
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

async function renderCard(runs: PrivacyAuditHistoryEntry[]) {
  mockHistory = runs;
  const rendered = render(<PrivacyHistoryCard />);
  await screen.findByTestId("input-history-from-date");
  return rendered;
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
  it("warns and leaves the selection untouched when a range matches zero runs", async () => {
    await renderCard([RUN_JAN, RUN_MAR, RUN_JUN]);

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

  it("does not fall back to the all-runs default when an empty range is picked with nothing selected", async () => {
    await renderCard([RUN_JAN, RUN_MAR, RUN_JUN]);

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

  it("clears the warning back to the normal hint when a date input changes", async () => {
    await renderCard([RUN_JAN, RUN_MAR, RUN_JUN]);

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

  it("clears the warning when the To date input changes", async () => {
    await renderCard([RUN_JAN, RUN_MAR, RUN_JUN]);

    setRange("2026-09-01", "2026-12-31");
    fireEvent.click(screen.getByTestId("button-history-select-range"));
    expect(hintText()).toContain("0 runs fall in that date range");

    fireEvent.change(screen.getByTestId("input-history-to-date"), {
      target: { value: "2026-07-31" },
    });

    expect(hintText()).not.toContain("0 runs fall in that date range");
  });

  it("confirms before falling back to all runs when exporting after an empty range with nothing selected", async () => {
    await renderCard([RUN_JAN, RUN_MAR, RUN_JUN]);

    // Trigger the empty-range warning with nothing hand-picked.
    setRange("2026-09-01", "2026-12-31");
    fireEvent.click(screen.getByTestId("button-history-select-range"));
    expect(hintText()).toContain("0 runs fall in that date range");

    // Clicking export must NOT export immediately; it opens a confirmation
    // instead so the all-runs fallback is never a single accidental click.
    fireEvent.click(screen.getByTestId("button-export-history-csv"));
    expect(buildPrivacyHistoryCsv).not.toHaveBeenCalled();
    expect(screen.getByTestId("dialog-export-fallback-confirm")).toBeTruthy();

    // Confirming runs the all-runs export over the full history.
    fireEvent.click(screen.getByTestId("button-export-fallback-confirm"));
    expect(buildPrivacyHistoryCsv).toHaveBeenCalledTimes(1);
    expect(buildPrivacyHistoryCsv).toHaveBeenCalledWith([RUN_JAN, RUN_MAR, RUN_JUN]);
  });

  it("cancelling the fallback confirmation aborts the export", async () => {
    await renderCard([RUN_JAN, RUN_MAR, RUN_JUN]);

    setRange("2026-09-01", "2026-12-31");
    fireEvent.click(screen.getByTestId("button-history-select-range"));

    fireEvent.click(screen.getByTestId("button-export-history-pdf"));
    expect(screen.getByTestId("dialog-export-fallback-confirm")).toBeTruthy();

    fireEvent.click(screen.getByTestId("button-export-fallback-cancel"));
    expect(buildPrivacyHistoryPdf).not.toHaveBeenCalled();
    expect(screen.queryByTestId("dialog-export-fallback-confirm")).toBeNull();
  });

  it("exports directly without confirmation when runs are actually selected", async () => {
    await renderCard([RUN_JAN, RUN_MAR, RUN_JUN]);

    // Hand-pick a run, then trigger an empty range. selectedIds is non-empty so
    // the export targets the selection, not the all-runs fallback.
    fireEvent.click(screen.getByTestId("checkbox-history-select-2"));
    setRange("2026-09-01", "2026-12-31");
    fireEvent.click(screen.getByTestId("button-history-select-range"));
    expect(hintText()).toContain("0 runs fall in that date range");

    fireEvent.click(screen.getByTestId("button-export-history-csv"));
    expect(screen.queryByTestId("dialog-export-fallback-confirm")).toBeNull();
    expect(buildPrivacyHistoryCsv).toHaveBeenCalledTimes(1);
    expect(buildPrivacyHistoryCsv).toHaveBeenCalledWith([RUN_MAR]);
  });

  it("shows an amber cue beside the export buttons when an empty range is picked with nothing selected", async () => {
    await renderCard([RUN_JAN, RUN_MAR, RUN_JUN]);

    // No cue before the empty range is triggered.
    expect(screen.queryByTestId("warning-history-export-empty-range")).toBeNull();

    setRange("2026-09-01", "2026-12-31");
    fireEvent.click(screen.getByTestId("button-history-select-range"));

    // The cue now appears next to the export buttons.
    expect(screen.getByTestId("warning-history-export-empty-range")).toBeTruthy();
  });

  it("hides the export-button cue once a selection is made", async () => {
    await renderCard([RUN_JAN, RUN_MAR, RUN_JUN]);

    setRange("2026-09-01", "2026-12-31");
    fireEvent.click(screen.getByTestId("button-history-select-range"));
    expect(screen.getByTestId("warning-history-export-empty-range")).toBeTruthy();

    // Hand-picking a run clears the fallback condition, so the cue disappears.
    fireEvent.click(screen.getByTestId("checkbox-history-select-2"));
    expect(screen.queryByTestId("warning-history-export-empty-range")).toBeNull();
  });

  it("hides the export-button cue once the date range changes", async () => {
    await renderCard([RUN_JAN, RUN_MAR, RUN_JUN]);

    setRange("2026-09-01", "2026-12-31");
    fireEvent.click(screen.getByTestId("button-history-select-range"));
    expect(screen.getByTestId("warning-history-export-empty-range")).toBeTruthy();

    // Editing a date input clears the empty-range warning and the cue.
    fireEvent.change(screen.getByTestId("input-history-from-date"), {
      target: { value: "2026-01-01" },
    });
    expect(screen.queryByTestId("warning-history-export-empty-range")).toBeNull();
  });

  it("selects the matching runs and clears the warning when a range DOES match", async () => {
    await renderCard([RUN_JAN, RUN_MAR, RUN_JUN]);

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

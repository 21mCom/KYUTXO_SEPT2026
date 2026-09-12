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
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";

// Feed the card a fixed fixture through its CRUD read path so the test never
// touches IndexedDB.
let mockHistory: PrivacyAuditHistoryEntry[] | undefined = undefined;

// Spy on the export builders — this is the seam the test asserts against. CSV is
// synchronous and PDF is async, mirroring the real signatures. The scope-label
// helper is kept REAL (via importActual) so the on-screen badge is asserted
// against the same derivation the exporter uses, which is the whole point of the
// single-source-of-truth.
vi.mock("@/lib/privacy-history-export", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/privacy-history-export")
  >("@/lib/privacy-history-export");
  return {
    buildPrivacyHistoryCsv: vi.fn(() => "csv,data"),
    buildPrivacyHistoryPdf: vi.fn(async () => new Blob(["pdf"], { type: "application/pdf" })),
    computePrivacyHistoryScopeLabel: actual.computePrivacyHistoryScopeLabel,
  };
});

// Clearing history is irrelevant here but is imported by the module.
vi.mock("@/lib/data/privacy-history-crud", () => ({
  addPrivacyAuditHistoryEntry: vi.fn(),
  clearPrivacyAuditHistory: vi.fn(),
  setPrivacyAuditHistoryAdversary: vi.fn(async () => true),
  getPrivacyAuditHistory: vi.fn(() => ({
    then: (resolve: (entries: PrivacyAuditHistoryEntry[]) => void) => {
      resolve(mockHistory ?? []);
      return Promise.resolve();
    },
  })),
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

describe("PrivacyHistoryCard export download plumbing", () => {
  // Intercept the anchor the handlers build for the download so we can assert
  // the filename, that it was clicked, and that the object URL was cleaned up.
  // jsdom would otherwise log "Not implemented: navigation" on a real click and
  // mask any regression in this wiring.
  let createElementSpy: ReturnType<typeof vi.spyOn>;
  let capturedAnchor: HTMLAnchorElement | undefined;
  let anchorClickSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    capturedAnchor = undefined;
    anchorClickSpy = vi.fn();
    const realCreateElement = document.createElement.bind(document);
    createElementSpy = vi
      .spyOn(document, "createElement")
      .mockImplementation((tagName: string, options?: ElementCreationOptions) => {
        const el = realCreateElement(tagName, options);
        if (tagName.toLowerCase() === "a") {
          capturedAnchor = el as HTMLAnchorElement;
          // Stub click() so jsdom never attempts the (unimplemented) navigation.
          (el as HTMLAnchorElement).click = anchorClickSpy;
        }
        return el;
      });
  });

  afterEach(() => {
    createElementSpy.mockRestore();
  });

  it("offers a dated .csv file for download and revokes the object URL", () => {
    renderCard([RUN_JAN, RUN_MAR, RUN_JUN]);

    fireEvent.click(screen.getByTestId("button-export-history-csv"));

    // A real download was triggered: object URL created, anchor clicked once.
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(capturedAnchor).toBeDefined();
    expect(capturedAnchor!.download).toMatch(
      /^privacy-history-\d{4}-\d{2}-\d{2}\.csv$/,
    );
    expect(capturedAnchor!.href).toBe("blob:fake");
    expect(anchorClickSpy).toHaveBeenCalledTimes(1);

    // The object URL is cleaned up with the exact URL that was handed out.
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake");

    // The anchor is detached from the document after the click.
    expect(capturedAnchor!.isConnected).toBe(false);
  });

  it("offers a dated .pdf file for download and revokes the object URL", async () => {
    renderCard([RUN_JAN, RUN_MAR, RUN_JUN]);

    fireEvent.click(screen.getByTestId("button-export-history-pdf"));

    // PDF builder is async, so the anchor click happens after it resolves.
    await waitFor(() => expect(anchorClickSpy).toHaveBeenCalledTimes(1));

    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(capturedAnchor).toBeDefined();
    expect(capturedAnchor!.download).toMatch(
      /^privacy-history-\d{4}-\d{2}-\d{2}\.pdf$/,
    );
    expect(capturedAnchor!.href).toBe("blob:fake");

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake");
    expect(capturedAnchor!.isConnected).toBe(false);
  });
});

describe("PrivacyHistoryCard scope badges", () => {
  // Four runs covering every scope combination so each row's badge can be
  // asserted independently. A run is "scoped" when it carries an owner and/or a
  // walletName; an unscoped (full-vault) run carries neither and shows "All".
  const RUN_OWNER_ONLY: PrivacyAuditHistoryEntry = {
    ...makeRun(10, TS_JAN, 70),
    owner: "Alice",
  };
  const RUN_WALLET_ONLY: PrivacyAuditHistoryEntry = {
    ...makeRun(11, TS_MAR, 75),
    walletName: "Cold Storage",
  };
  const RUN_BOTH: PrivacyAuditHistoryEntry = {
    ...makeRun(12, TS_JUN, 80),
    owner: "Bob",
    walletName: "Hot Wallet",
  };
  const RUN_NEITHER: PrivacyAuditHistoryEntry = makeRun(13, TS_JUN + 1000, 85);

  /** Scope the badge queries to a single history row by entry id. */
  function row(id: number): ReturnType<typeof within> {
    return within(screen.getByTestId(`row-history-${id}`));
  }

  it("shows an Owner badge (and no wallet/all badges) for an owner-only run", () => {
    renderCard([RUN_OWNER_ONLY]);

    const r = row(10);
    expect(r.getByTestId("badge-history-scope-owner").textContent).toContain(
      "Owner: Alice",
    );
    expect(r.queryByTestId("badge-history-scope-wallet")).toBeNull();
    expect(r.queryByTestId("badge-history-scope-all")).toBeNull();
  });

  it("shows a Wallet badge (and no owner/all badges) for a wallet-only run", () => {
    renderCard([RUN_WALLET_ONLY]);

    const r = row(11);
    expect(r.getByTestId("badge-history-scope-wallet").textContent).toContain(
      "Wallet: Cold Storage",
    );
    expect(r.queryByTestId("badge-history-scope-owner")).toBeNull();
    expect(r.queryByTestId("badge-history-scope-all")).toBeNull();
  });

  it("shows both Owner and Wallet badges (and no all badge) when both are set", () => {
    renderCard([RUN_BOTH]);

    const r = row(12);
    expect(r.getByTestId("badge-history-scope-owner").textContent).toContain(
      "Owner: Bob",
    );
    expect(r.getByTestId("badge-history-scope-wallet").textContent).toContain(
      "Wallet: Hot Wallet",
    );
    expect(r.queryByTestId("badge-history-scope-all")).toBeNull();
  });

  it("shows the All badge (and no scope badges) for an unscoped full-vault run", () => {
    renderCard([RUN_NEITHER]);

    const r = row(13);
    expect(r.getByTestId("badge-history-scope-all").textContent).toContain("All");
    expect(r.queryByTestId("badge-history-scope-owner")).toBeNull();
    expect(r.queryByTestId("badge-history-scope-wallet")).toBeNull();
  });

  it("shows a report-wide export scope badge when every visible run shares one owner", () => {
    const RUN_ALICE_2 = { ...makeRun(14, TS_MAR, 72), owner: "Alice" };
    renderCard([RUN_OWNER_ONLY, RUN_ALICE_2]);

    expect(screen.getByTestId("badge-history-export-scope").textContent).toContain(
      "Scope: Owner = Alice",
    );
  });

  it("shows 'Scope: All addresses' when every visible run is full-vault", () => {
    const RUN_NEITHER_2 = makeRun(15, TS_MAR, 88);
    renderCard([RUN_NEITHER, RUN_NEITHER_2]);

    expect(screen.getByTestId("badge-history-export-scope").textContent).toContain(
      "Scope: All addresses",
    );
  });

  it("hides the report-wide export scope badge when runs span multiple scopes", () => {
    renderCard([RUN_OWNER_ONLY, RUN_WALLET_ONLY]);

    expect(screen.queryByTestId("badge-history-export-scope")).toBeNull();
  });

  it("tracks the selection: a mixed history narrowed to one scope shows the badge", () => {
    const RUN_ALICE_2 = { ...makeRun(14, TS_MAR, 72), owner: "Alice" };
    // History spans two owners, so with nothing selected the export covers both
    // and there is no single scope.
    renderCard([RUN_OWNER_ONLY, RUN_ALICE_2, RUN_BOTH]);
    expect(screen.queryByTestId("badge-history-export-scope")).toBeNull();

    // Pick only the two Alice-owned runs; now the export shares one scope.
    fireEvent.click(screen.getByTestId("checkbox-history-select-10"));
    fireEvent.click(screen.getByTestId("checkbox-history-select-14"));

    expect(screen.getByTestId("badge-history-export-scope").textContent).toContain(
      "Scope: Owner = Alice",
    );
  });

  it("labels each row independently when all scope kinds are present at once", () => {
    renderCard([RUN_OWNER_ONLY, RUN_WALLET_ONLY, RUN_BOTH, RUN_NEITHER]);

    // Owner-only row
    expect(row(10).getByTestId("badge-history-scope-owner").textContent).toContain(
      "Owner: Alice",
    );
    expect(row(10).queryByTestId("badge-history-scope-all")).toBeNull();

    // Wallet-only row
    expect(row(11).getByTestId("badge-history-scope-wallet").textContent).toContain(
      "Wallet: Cold Storage",
    );
    expect(row(11).queryByTestId("badge-history-scope-all")).toBeNull();

    // Both row
    expect(row(12).getByTestId("badge-history-scope-owner").textContent).toContain(
      "Owner: Bob",
    );
    expect(row(12).getByTestId("badge-history-scope-wallet").textContent).toContain(
      "Wallet: Hot Wallet",
    );

    // Unscoped row
    expect(row(13).getByTestId("badge-history-scope-all").textContent).toContain("All");
    expect(row(13).queryByTestId("badge-history-scope-owner")).toBeNull();
    expect(row(13).queryByTestId("badge-history-scope-wallet")).toBeNull();
  });
});

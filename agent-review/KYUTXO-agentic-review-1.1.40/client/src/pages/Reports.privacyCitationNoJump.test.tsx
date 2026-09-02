// @vitest-environment jsdom
//
// Guards the citation table's click isolation in the Privacy Audit panel.
//
// Each finding row in PrivacyAuditReportPanel (Reports.tsx) is itself a button:
// clicking it runs focusWaterfallByType, which highlights and scrolls the
// matching Score Breakdown (waterfall) row into view. The on-screen "Source
// Citations" table nested inside a finding stops click propagation so a user can
// click a source URL (or anywhere in the table) WITHOUT being yanked down to the
// Score Breakdown and losing their place.
//
// This test renders the REAL panel with an ENTITY_* finding that carries a
// citation sourceNote URL and asserts:
//   - clicking the finding row DOES trigger the focus-waterfall behavior
//     (positive control — proves the handler is wired up), but
//   - clicking inside the citations table, and clicking the source link itself,
//     do NOT trigger it (no highlight applied, no scrollIntoView).
// If a future refactor drops the stopPropagation, the citation clicks would
// start hijacking the report position and these assertions would fail.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";

import type { PrivacyAuditResult, PrivacyFinding } from "@/lib/privacy-audit";

vi.mock("@/hooks/use-owners", () => ({
  useOwners: () => ({ owners: [], isLoading: false }),
}));
vi.mock("@/hooks/use-wallet-names", () => ({
  useWalletNames: () => ({ walletNames: [], isLoading: false }),
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));
vi.mock("@/lib/data/record-crud", () => ({
  getRecordsPageByTypeIdReverseKeyset: vi.fn(async () => [
    { id: 1, inputString: "bc1qexampleaddress", owner: undefined, walletName: undefined },
  ]),
}));

const ENTITY_FINDING: PrivacyFinding = {
  type: "ENTITY_SCAM",
  severity: "CRITICAL",
  description: "A transaction interacts with known counterparties.",
  correction: "Avoid reusing funds linked to these counterparties.",
  txids: ["tx_scam"],
  addresses: ["134r8iHv69xdT6p5qVKTsHrcUEuBVZAYak"],
  scoreDelta: -28,
  details: {
    citations: [
      {
        name: "Lazarus Group (DPRK, OFAC-sanctioned)",
        address: "134r8iHv69xdT6p5qVKTsHrcUEuBVZAYak",
        categoryLabel: "Scam / Fraud",
        sourceNote:
          "OFAC / US Treasury — https://www.treasury.gov/resource-center/sanctions",
      },
    ],
  },
} as unknown as PrivacyFinding;

// A waterfall row for the SAME finding type must exist so that the focus
// behavior has a target to scroll into view (focusWaterfallByType only calls
// scrollIntoView when it finds a [data-waterfall-type] element).
const mockResult: PrivacyAuditResult = {
  findings: [ENTITY_FINDING],
  warnings: [],
  transactionsAnalyzed: 10,
  addressesScanned: 5,
  isClean: false,
  score: 72,
  grade: "C+",
  scoreWaterfall: [
    { label: "Base Score", findingType: "BASE", delta: 0, runningScore: 100, count: 0 },
    {
      label: "Known counterparties",
      findingType: "ENTITY_SCAM",
      delta: -28,
      runningScore: 72,
      count: 1,
    },
  ],
  needsResync: false,
  fingerprintCoverage: 1,
} as PrivacyAuditResult;

vi.mock("@/lib/privacy-audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/privacy-audit")>();
  return {
    ...actual,
    runPrivacyAudit: vi.fn(async () => mockResult),
  };
});

const { PrivacyAuditReportPanel } = await import("./Reports");

let scrollIntoViewSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollIntoViewSpy = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoViewSpy;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderWithResult() {
  const utils = render(<PrivacyAuditReportPanel />);
  fireEvent.click(utils.getByTestId("button-generate-privacy-report"));
  await waitFor(() => utils.getByTestId("container-privacy-report-findings"));
  return utils;
}

describe("PrivacyAuditReportPanel — citation clicks don't jump to Score Breakdown", () => {
  it("clicking the finding row DOES focus the matching Score Breakdown row (control)", async () => {
    const { getByTestId } = await renderWithResult();

    const row = getByTestId("row-privacy-finding-0");
    expect(row.className).not.toContain("bg-muted");

    fireEvent.click(row);

    // The finding's focus-waterfall handler ran: the row is highlighted and the
    // matching waterfall row is scrolled into view.
    expect(row.className).toContain("bg-muted");
    await waitFor(() => expect(scrollIntoViewSpy).toHaveBeenCalled());
  });

  it("clicking inside the citations table does NOT trigger the focus-waterfall behavior", async () => {
    const { getByTestId } = await renderWithResult();

    const row = getByTestId("row-privacy-finding-0");
    const table = getByTestId("table-privacy-citations-0");

    fireEvent.click(table);

    // stopPropagation kept the click from reaching the finding row: no highlight,
    // no scroll — the user keeps their place in the report.
    expect(row.className).not.toContain("bg-muted");
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
  });

  it("clicking the citation source link does NOT trigger the focus-waterfall behavior", async () => {
    const { getByTestId } = await renderWithResult();

    const row = getByTestId("row-privacy-finding-0");
    const citationRow = getByTestId("row-privacy-citation-0-0");
    const anchor = citationRow.querySelector("a");
    expect(anchor).not.toBeNull();

    fireEvent.click(anchor!);

    expect(row.className).not.toContain("bg-muted");
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
  });
});

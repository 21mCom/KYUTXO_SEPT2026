// @vitest-environment jsdom
//
// Guards the reverse direction of the Privacy Audit panel's two-way link.
//
// The Score Breakdown (waterfall) table in PrivacyAuditReportPanel (Reports.tsx)
// lets a user click a category row to jump UP to its matching finding. Only rows
// that actually have findings (non-BASE, count > 0) are clickable: clicking one
// runs focusFindingsByType, which highlights the matching finding row (bg-muted)
// and scrolls it into view. Base / zero-count rows are inert — no role=button,
// no click handler — so there's nothing to navigate to.
//
// The forward direction (finding row -> Score Breakdown row) is covered by
// Reports.privacyCitationNoJump.test.tsx. This test covers the reverse so a
// refactor can't silently break "click a score line to see its findings".
//
// It renders the REAL panel and asserts:
//   - clicking the ENTITY_SCAM waterfall row (count > 0) highlights the matching
//     finding row and calls scrollIntoView, and
//   - the Base Score waterfall row (count 0) is NOT a button and has no handler.

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
  details: {},
} as unknown as PrivacyFinding;

// The waterfall carries a BASE row (count 0 — inert) and an ENTITY_SCAM row
// (count 1) whose findingType matches the finding above, so clicking it has a
// finding to highlight and scroll to.
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

describe("PrivacyAuditReportPanel — clicking a Score Breakdown row jumps to its finding", () => {
  it("clicking a waterfall row with findings highlights the matching finding row and scrolls to it", async () => {
    const { getByTestId } = await renderWithResult();

    const findingRow = getByTestId("row-privacy-finding-0");
    expect(findingRow.className).not.toContain("bg-muted");

    // The ENTITY_SCAM waterfall row (index 1) has count > 0, so it's clickable.
    const waterfallRow = getByTestId("row-privacy-waterfall-1");
    expect(waterfallRow.getAttribute("role")).toBe("button");

    fireEvent.click(waterfallRow);

    // focusFindingsByType ran: the matching finding row is highlighted and
    // scrolled into view.
    expect(findingRow.className).toContain("bg-muted");
    await waitFor(() => expect(scrollIntoViewSpy).toHaveBeenCalled());
  });

  it("the base / zero-count waterfall row is not clickable (no role=button, no handler)", async () => {
    const { getByTestId } = await renderWithResult();

    // The Base Score row (index 0) has count 0 and findingType BASE — inert.
    const baseRow = getByTestId("row-privacy-waterfall-0");
    expect(baseRow.getAttribute("role")).toBeNull();
    expect(baseRow.getAttribute("tabindex")).toBeNull();

    const findingRow = getByTestId("row-privacy-finding-0");
    fireEvent.click(baseRow);

    // No handler fired: nothing highlighted, nothing scrolled.
    expect(findingRow.className).not.toContain("bg-muted");
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
  });
});

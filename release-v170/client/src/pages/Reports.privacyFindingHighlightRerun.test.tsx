// @vitest-environment jsdom
//
// Re-run safety for the Privacy Audit highlight (Reports.tsx). The
// single-highlight invariant across click/keyboard selections is covered by
// Reports.privacyFindingHighlightSync.test.tsx. This file guards a different
// property: regenerating the report (a fresh generate()) must clear any
// previously highlighted finding/breakdown row, so a stale highlight pointing
// at a finding type that no longer exists in the new result is never left
// behind after a fresh audit.
//
// We render the real PrivacyAuditReportPanel but stub the data-fetching chain
// (owners/wallets hooks, the address page query, toast) and replace
// runPrivacyAudit with one that returns a *different* mock PrivacyAuditResult
// on each call, so the test exercises only the UI wiring across a re-run.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";

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

// First audit: includes an ADDRESS_REUSE finding the user will highlight.
const firstResult = {
  findings: [
    {
      type: "ADDRESS_REUSE",
      severity: "HIGH",
      description: "Address reused across multiple transactions.",
      details: {},
      correction: "Use a fresh address for each receive.",
      txids: ["tx1"],
      addresses: ["bc1qreused"],
      scoreDelta: -12.4,
    },
    {
      type: "DUST",
      severity: "LOW",
      description: "Dust outputs detected.",
      details: {},
      correction: "Avoid spending dust.",
      txids: [],
      addresses: ["bc1qdust"],
      scoreDelta: -2.6,
    },
  ],
  warnings: [],
  transactionsAnalyzed: 5,
  addressesScanned: 3,
  isClean: false,
  score: 85,
  grade: "B",
  scoreWaterfall: [
    { label: "Base Score", findingType: "BASE", delta: 0, runningScore: 100, count: 0 },
    { label: "Address Reuse", findingType: "ADDRESS_REUSE", delta: -12, runningScore: 88, count: 1 },
    { label: "Dust", findingType: "DUST", delta: -3, runningScore: 85, count: 1 },
  ],
  needsResync: false,
  fingerprintCoverage: 1,
};

// Second audit: a completely different result that NO LONGER contains
// ADDRESS_REUSE (or DUST). If generate() failed to reset highlightedType, the
// stale highlight would point at a finding type absent from this result.
const secondResult = {
  findings: [
    {
      type: "ROUND_NUMBER",
      severity: "MEDIUM",
      description: "Round-number amount detected.",
      details: {},
      correction: "Avoid round amounts.",
      txids: ["tx9"],
      addresses: ["bc1qround"],
      scoreDelta: -5.1,
    },
  ],
  warnings: [],
  transactionsAnalyzed: 2,
  addressesScanned: 1,
  isClean: false,
  score: 95,
  grade: "A",
  scoreWaterfall: [
    { label: "Base Score", findingType: "BASE", delta: 0, runningScore: 100, count: 0 },
    { label: "Round Number", findingType: "ROUND_NUMBER", delta: -5, runningScore: 95, count: 1 },
  ],
  needsResync: false,
  fingerprintCoverage: 1,
};

const runPrivacyAuditMock = vi.fn();

vi.mock("@/lib/privacy-audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/privacy-audit")>();
  return {
    ...actual,
    runPrivacyAudit: (...args: unknown[]) => runPrivacyAuditMock(...args),
  };
});

const { PrivacyAuditReportPanel } = await import("./Reports");

beforeEach(() => {
  // jsdom doesn't implement scrollIntoView; the focus helpers call it.
  Element.prototype.scrollIntoView = vi.fn();
  // The panel scrolls via requestAnimationFrame — run callbacks synchronously.
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0);
    return 0;
  });
  runPrivacyAuditMock.mockReset();
  runPrivacyAuditMock
    .mockResolvedValueOnce(firstResult)
    .mockResolvedValueOnce(secondResult);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Count how many rows across both tables currently appear highlighted. The
// highlight uses the bare `bg-muted` class (the header uses `bg-muted/50`, so
// we match the exact token to avoid false positives).
function highlightedRows(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      "[data-finding-type], [data-waterfall-type]",
    ),
  ).filter((el) => el.className.split(/\s+/).includes("bg-muted"));
}

describe("PrivacyAuditReportPanel re-running the audit clears stale highlights", () => {
  it("regenerating clears a highlight pointing at a finding type absent from the new result", async () => {
    const { getByTestId, container } = render(<PrivacyAuditReportPanel />);

    // First audit.
    fireEvent.click(getByTestId("button-generate-privacy-report"));
    await waitFor(() => getByTestId("card-privacy-report-waterfall"));

    // Highlight the ADDRESS_REUSE finding.
    fireEvent.click(getByTestId("row-privacy-finding-0"));
    expect(getByTestId("row-privacy-finding-0").className).toContain("bg-muted");
    expect(
      container.querySelector('[data-waterfall-type="ADDRESS_REUSE"]')!.className,
    ).toContain("bg-muted");
    expect(highlightedRows(container)).toHaveLength(2);

    // Re-run the audit; the second result no longer contains ADDRESS_REUSE.
    fireEvent.click(getByTestId("button-generate-privacy-report"));
    await waitFor(() => {
      // Wait for the new result (ROUND_NUMBER) to render.
      expect(container.querySelector('[data-finding-type="ROUND_NUMBER"]')).not.toBeNull();
    });

    // The stale ADDRESS_REUSE finding type is gone entirely...
    expect(container.querySelector('[data-finding-type="ADDRESS_REUSE"]')).toBeNull();
    expect(container.querySelector('[data-waterfall-type="ADDRESS_REUSE"]')).toBeNull();

    // ...and absolutely no row remains highlighted after the fresh audit.
    expect(highlightedRows(container)).toHaveLength(0);
  });
});

// @vitest-environment jsdom
//
// Re-run safety for the Privacy Audit *keyboard focus pointer* (Reports.tsx).
// The sibling Reports.privacyFindingHighlightRerun.test.tsx already covers that
// regenerating clears a stale `highlightedType` (the bg-muted highlight). This
// file guards the other half of generate()'s reset: `focusedFindingIndex`.
//
// generate() resets BOTH highlightedType and focusedFindingIndex at the start of
// every run. focusedFindingIndex tracks which finding (by flat index) the
// keyboard navigation is currently parked on within a type, and it drives the
// "current / total" position counter (text-waterfall-position-*). If it were not
// reset, two regressions appear after a re-run that returns FEWER findings:
//   1. A leftover DOM focus ring could stay stuck on a finding row index that no
//      longer exists in the new (shorter) result.
//   2. The next keyboard step within a type would resume from the stale index
//      instead of starting fresh.
//
// We render the real PrivacyAuditReportPanel but stub the data-fetching chain
// (owners/wallets hooks, the address page query, toast) and replace
// runPrivacyAudit with one that returns a *different* result on each call.

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

function reuseFinding(tag: string) {
  return {
    type: "ADDRESS_REUSE",
    severity: "HIGH",
    description: `Address reused (${tag}).`,
    details: {},
    correction: "Use a fresh address for each receive.",
    txids: [`tx-${tag}`],
    addresses: [`bc1qreused-${tag}`],
    scoreDelta: -12.4,
  };
}

// First audit: 4 findings total — three ADDRESS_REUSE (flat indices 0,1,2) the
// user will navigate, plus one DUST (flat index 3) the user will DOM-focus.
const firstResult = {
  findings: [
    reuseFinding("a"),
    reuseFinding("b"),
    reuseFinding("c"),
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
  score: 80,
  grade: "B",
  scoreWaterfall: [
    { label: "Base Score", findingType: "BASE", delta: 0, runningScore: 100, count: 0 },
    { label: "Address Reuse", findingType: "ADDRESS_REUSE", delta: -17, runningScore: 83, count: 3 },
    { label: "Dust", findingType: "DUST", delta: -3, runningScore: 80, count: 1 },
  ],
  needsResync: false,
  fingerprintCoverage: 1,
};

// Second audit: FEWER findings (3 vs 4) — the DUST finding at flat index 3 is
// gone, so any DOM focus parked on row index 3 must not survive. ADDRESS_REUSE
// still has 3 findings so we can prove the navigation pointer starts fresh.
const secondResult = {
  findings: [reuseFinding("x"), reuseFinding("y"), reuseFinding("z")],
  warnings: [],
  transactionsAnalyzed: 2,
  addressesScanned: 1,
  isClean: false,
  score: 83,
  grade: "B",
  scoreWaterfall: [
    { label: "Base Score", findingType: "BASE", delta: 0, runningScore: 100, count: 0 },
    { label: "Address Reuse", findingType: "ADDRESS_REUSE", delta: -17, runningScore: 83, count: 3 },
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

describe("PrivacyAuditReportPanel re-running clears the keyboard focus pointer", () => {
  it("does not leave a DOM focus ring stuck on a finding row that no longer exists", async () => {
    const { getByTestId, queryByTestId, container } = render(<PrivacyAuditReportPanel />);

    // First audit.
    fireEvent.click(getByTestId("button-generate-privacy-report"));
    await waitFor(() => getByTestId("card-privacy-report-waterfall"));

    // Put real keyboard focus on the DUST finding row (flat index 3). It carries
    // the focus-visible ring, so a stuck focus here would be a visible outline.
    const dustRow = getByTestId("row-privacy-finding-3");
    expect(dustRow.className).toContain("focus-visible:ring");
    dustRow.focus();
    expect(document.activeElement).toBe(dustRow);

    // Re-run; the second result has fewer findings and no row at index 3.
    fireEvent.click(getByTestId("button-generate-privacy-report"));
    await waitFor(() => {
      getByTestId("row-privacy-finding-0");
      expect(queryByTestId("row-privacy-finding-3")).toBeNull();
    });

    // The previously focused row is gone, and focus is not stuck on any finding
    // row — it has fallen back to the document body (no phantom focus ring).
    expect(queryByTestId("row-privacy-finding-3")).toBeNull();
    expect(document.activeElement).toBe(document.body);
    const focusedFindingRow = container.querySelector(
      '[data-testid^="row-privacy-finding-"]:focus',
    );
    expect(focusedFindingRow).toBeNull();
  });

  it("resets focusedFindingIndex so the next keyboard step starts from the first finding", async () => {
    const { getByTestId, queryByTestId } = render(<PrivacyAuditReportPanel />);

    // First audit.
    fireEvent.click(getByTestId("button-generate-privacy-report"));
    await waitFor(() => getByTestId("card-privacy-report-waterfall"));

    // Step the keyboard pointer to the SECOND ADDRESS_REUSE finding (index 1):
    // first ArrowRight parks on "1 / 3", the second advances to "2 / 3".
    const reuseWaterfallRow = getByTestId("row-privacy-waterfall-1");
    fireEvent.keyDown(reuseWaterfallRow, { key: "ArrowRight" });
    fireEvent.keyDown(reuseWaterfallRow, { key: "ArrowRight" });
    expect(getByTestId("text-waterfall-position-1").textContent).toBe("2 / 3");

    // Re-run; ADDRESS_REUSE still has 3 findings but generate() must clear the
    // pointer (and the highlight), so no live position counter is shown.
    fireEvent.click(getByTestId("button-generate-privacy-report"));
    await waitFor(() => {
      getByTestId("row-privacy-finding-0");
      expect(queryByTestId("row-privacy-finding-3")).toBeNull();
    });
    expect(getByTestId("text-waterfall-position-1").textContent).toBe("3");

    // A single ArrowRight now must land on the FIRST finding ("1 / 3"). If the
    // stale index 1 had survived, it would instead jump to "3 / 3".
    fireEvent.keyDown(getByTestId("row-privacy-waterfall-1"), { key: "ArrowRight" });
    expect(getByTestId("text-waterfall-position-1").textContent).toBe("1 / 3");
  });
});

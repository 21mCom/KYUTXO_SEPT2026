// @vitest-environment jsdom
//
// Regression coverage for the "current / total" finding position counter
// (text-waterfall-position-*) in the Privacy Audit Score Breakdown. When a
// waterfall row aggregates several findings of the same type, keyboard users
// step through them with ArrowRight / ArrowLeft and the counter reflects which
// finding (1-based) is currently the navigation anchor.
//
// The wrap-around math lives in stepFindingWithinType (Reports.tsx). This file
// pins the modulo behaviour at the boundaries: stepping ArrowRight past the
// LAST finding must wrap "3 / 3" -> "1 / 3", and stepping ArrowLeft before the
// FIRST must wrap "1 / 3" -> "3 / 3". A regression in the modulo would silently
// show the wrong position.
//
// We render the real PrivacyAuditReportPanel but stub the data-fetching chain
// (owners/wallets hooks, the address page query, toast) and replace
// runPrivacyAudit with one that returns a fixed result containing THREE
// findings of one type, so the test exercises only the UI wiring.

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

// Three ADDRESS_REUSE findings (indices 0,1,2) aggregated under a single
// waterfall row with count 3, plus one unrelated finding so the list isn't
// homogeneous.
const mockResult = {
  findings: [
    {
      type: "ADDRESS_REUSE",
      severity: "HIGH",
      description: "Address reused — occurrence 1.",
      details: {},
      correction: "Use a fresh address.",
      txids: ["tx1"],
      addresses: ["bc1qreuse1"],
      scoreDelta: -4,
    },
    {
      type: "ADDRESS_REUSE",
      severity: "HIGH",
      description: "Address reused — occurrence 2.",
      details: {},
      correction: "Use a fresh address.",
      txids: ["tx2"],
      addresses: ["bc1qreuse2"],
      scoreDelta: -4,
    },
    {
      type: "ADDRESS_REUSE",
      severity: "HIGH",
      description: "Address reused — occurrence 3.",
      details: {},
      correction: "Use a fresh address.",
      txids: ["tx3"],
      addresses: ["bc1qreuse3"],
      scoreDelta: -4,
    },
    {
      type: "DUST",
      severity: "LOW",
      description: "Dust outputs detected.",
      details: {},
      correction: "Avoid spending dust.",
      txids: [],
      addresses: ["bc1qdust"],
      scoreDelta: -2,
    },
  ],
  warnings: [],
  transactionsAnalyzed: 5,
  addressesScanned: 4,
  isClean: false,
  score: 86,
  grade: "B",
  scoreWaterfall: [
    { label: "Base Score", findingType: "BASE", delta: 0, runningScore: 100, count: 0 },
    { label: "Address Reuse", findingType: "ADDRESS_REUSE", delta: -12, runningScore: 88, count: 3 },
    { label: "Dust", findingType: "DUST", delta: -2, runningScore: 86, count: 1 },
  ],
  needsResync: false,
  fingerprintCoverage: 1,
};

vi.mock("@/lib/privacy-audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/privacy-audit")>();
  return {
    ...actual,
    runPrivacyAudit: vi.fn(async () => mockResult),
  };
});

const { PrivacyAuditReportPanel } = await import("./Reports");

beforeEach(() => {
  // jsdom doesn't implement scrollIntoView; the focus helpers call it.
  Element.prototype.scrollIntoView = vi.fn();
  // The panel scrolls via requestAnimationFrame — run callbacks synchronously
  // so the finding-row lookup in scrollToFindingIndex resolves during the test.
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0);
    return 0;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderWithResult() {
  const utils = render(<PrivacyAuditReportPanel />);
  fireEvent.click(utils.getByTestId("button-generate-privacy-report"));
  await waitFor(() => utils.getByTestId("card-privacy-report-waterfall"));
  return utils;
}

describe("PrivacyAuditReportPanel finding position counter wrap-around", () => {
  it("ArrowRight past the last finding wraps 3/3 -> 1/3, ArrowLeft before the first wraps 1/3 -> 3/3", async () => {
    const { getByTestId, container } = await renderWithResult();

    // The ADDRESS_REUSE waterfall row is index 1 (base=0). Give each finding
    // row its own scrollIntoView spy so we can assert the counter and the
    // scrolled-to finding stay in lockstep.
    const waterfallRow = getByTestId("row-privacy-waterfall-1");
    const counter = getByTestId("text-waterfall-position-1");
    const findingSpies = [0, 1, 2].map((idx) => {
      const el = container.querySelector<HTMLElement>(`[data-finding-index="${idx}"]`)!;
      expect(el).not.toBeNull();
      const spy = vi.fn();
      el.scrollIntoView = spy;
      return spy;
    });

    // Before any interaction the counter shows just the total (no anchor).
    expect(counter.textContent).toBe("3");

    // Walk forward to the last finding: 1/3 -> 2/3 -> 3/3, asserting at each
    // step that the focused finding row is the one scrolled into view.
    const expectStep = (display: string, focusedIdx: number) => {
      expect(getByTestId("text-waterfall-position-1").textContent).toBe(display);
      expect(findingSpies[focusedIdx]).toHaveBeenCalled();
    };

    findingSpies.forEach((s) => s.mockClear());
    fireEvent.keyDown(waterfallRow, { key: "ArrowRight" });
    expectStep("1 / 3", 0);

    findingSpies.forEach((s) => s.mockClear());
    fireEvent.keyDown(waterfallRow, { key: "ArrowRight" });
    expectStep("2 / 3", 1);

    findingSpies.forEach((s) => s.mockClear());
    fireEvent.keyDown(waterfallRow, { key: "ArrowRight" });
    expectStep("3 / 3", 2);

    // ArrowRight past the last finding wraps back to the first.
    findingSpies.forEach((s) => s.mockClear());
    fireEvent.keyDown(waterfallRow, { key: "ArrowRight" });
    expectStep("1 / 3", 0);

    // ArrowLeft before the first finding wraps to the last.
    findingSpies.forEach((s) => s.mockClear());
    fireEvent.keyDown(waterfallRow, { key: "ArrowLeft" });
    expectStep("3 / 3", 2);
  });
});

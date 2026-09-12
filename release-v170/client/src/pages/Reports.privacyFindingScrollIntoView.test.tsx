// @vitest-environment jsdom
//
// Focused coverage for the *scroll* half of the bidirectional finding <->
// score-breakdown navigation in the Privacy Audit report panel (Reports.tsx).
//
// The existing jump tests (Reports.privacyFindingJump / KeyboardJump) assert
// that scrollIntoView "was called", but they (a) stub requestAnimationFrame to
// run synchronously and (b) share a single Element.prototype.scrollIntoView
// spy, so they cannot tell *which* element scrolled or *with what options*.
// That leaves three regressions uncaught:
//   1. dropping the requestAnimationFrame wrapper (scrolling before layout),
//   2. scrolling the wrong element (e.g. the source row the user clicked
//      instead of the matching target row), and
//   3. passing wrong/no scroll options.
//
// This file pins all three down: it records every scrollIntoView call together
// with its receiver element and options, and it leaves requestAnimationFrame
// deferred so the test can prove the scroll only happens once the rAF callback
// runs.
//
// We render the real PrivacyAuditReportPanel but stub the data-fetching chain
// (owners/wallets hooks, the address page query, toast) and replace
// runPrivacyAudit with one that returns a fixed mock PrivacyAuditResult, so the
// test exercises only the UI wiring.

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

const mockResult = {
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

vi.mock("@/lib/privacy-audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/privacy-audit")>();
  return {
    ...actual,
    runPrivacyAudit: vi.fn(async () => mockResult),
  };
});

const { PrivacyAuditReportPanel } = await import("./Reports");

// Records each scrollIntoView call: which element received it and the options
// it was given. Because scrollIntoView is defined on Element.prototype, `this`
// is the receiving element — this is how we distinguish the target row from the
// source row even though they share one prototype method.
type ScrollCall = { el: Element; options: unknown };
let scrollCalls: ScrollCall[];
// Captured but *not yet run* requestAnimationFrame callbacks, so a test can
// prove the scroll is wrapped in rAF (nothing scrolls until we flush them).
let rafCallbacks: FrameRequestCallback[];

function flushRaf() {
  const pending = rafCallbacks;
  rafCallbacks = [];
  for (const cb of pending) cb(0);
}

beforeEach(() => {
  scrollCalls = [];
  rafCallbacks = [];
  // jsdom doesn't implement scrollIntoView; capture the receiver + options.
  Element.prototype.scrollIntoView = vi.fn(function (this: Element, options?: unknown) {
    scrollCalls.push({ el: this, options });
  });
  // Defer rAF callbacks instead of running them synchronously, so we can assert
  // the scroll only fires after the frame callback runs.
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
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

const EXPECTED_OPTIONS = { behavior: "smooth", block: "center" };

describe("PrivacyAuditReportPanel scrolls the matching row into view", () => {
  it("finding -> waterfall: scrolls the matching waterfall row (not the clicked finding) with smooth/center options", async () => {
    const { getByTestId, container } = await renderWithResult();

    const sourceFinding = getByTestId("row-privacy-finding-0"); // ADDRESS_REUSE
    const targetWaterfall = container.querySelector<HTMLElement>(
      '[data-waterfall-type="ADDRESS_REUSE"]',
    )!;
    expect(targetWaterfall).not.toBeNull();

    fireEvent.click(sourceFinding);

    // The scroll is wrapped in requestAnimationFrame: nothing scrolls yet.
    expect(scrollCalls).toHaveLength(0);
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);

    // Once the frame callback runs, exactly the target row scrolls.
    flushRaf();

    expect(scrollCalls).toHaveLength(1);
    expect(scrollCalls[0].el).toBe(targetWaterfall);
    expect(scrollCalls[0].options).toEqual(EXPECTED_OPTIONS);

    // The source row the user interacted with must NOT be scrolled.
    expect(scrollCalls.some((c) => c.el === sourceFinding)).toBe(false);
  });

  it("waterfall -> finding: scrolls the matching finding row (not the clicked waterfall row) with smooth/center options", async () => {
    const { getByTestId, container } = await renderWithResult();

    const sourceWaterfall = getByTestId("row-privacy-waterfall-2"); // DUST
    const targetFinding = container.querySelector<HTMLElement>(
      '[data-finding-type="DUST"]',
    )!;
    expect(targetFinding).not.toBeNull();

    fireEvent.click(sourceWaterfall);

    expect(scrollCalls).toHaveLength(0);
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);

    flushRaf();

    expect(scrollCalls).toHaveLength(1);
    expect(scrollCalls[0].el).toBe(targetFinding);
    expect(scrollCalls[0].options).toEqual(EXPECTED_OPTIONS);

    expect(scrollCalls.some((c) => c.el === sourceWaterfall)).toBe(false);
  });
});

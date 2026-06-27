// @vitest-environment jsdom
//
// Coverage for the bidirectional finding <-> score-breakdown navigation in the
// Privacy Audit report panel (Reports.tsx) *when several findings share the
// same type*.
//
// The score-breakdown waterfall is aggregated per finding type (exactly one row
// per type, with `count` = number of findings of that type), while
// `result.findings` is a flat list that can hold MANY findings of the same type
// (e.g. several ADDRESS_REUSE addresses each produce their own finding row).
//
// The jump helpers (focusFindingsByType / focusWaterfallByType) locate their
// target with querySelector('[data-finding-type="..."]') /
// '[data-waterfall-type="..."]', which only ever returns the FIRST matching
// element. The other jump tests only mock one finding per type, so the collision
// case is untested. This file pins the intended behavior down:
//
//   - finding -> waterfall: clicking ANY finding of a type (first, middle, or
//     last) scrolls to that type's single, unambiguous waterfall row — never to
//     a different finding and never to the clicked source row.
//   - waterfall -> finding: clicking a type's waterfall row scrolls to the
//     FIRST finding of that type (the natural anchor for the whole group, since
//     the waterfall row represents every finding of that type), never to a
//     later same-type finding and never to the clicked source row.
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

// Three ADDRESS_REUSE findings (indices 0, 1, 3) interleaved with one DUST
// finding (index 2), so a "land on the first of this type" jump is clearly
// distinguishable from "land on the clicked / a later one".
const mockResult = {
  findings: [
    {
      type: "ADDRESS_REUSE",
      severity: "HIGH",
      description: "Address bc1qreuseA reused across multiple transactions.",
      details: {},
      correction: "Use a fresh address for each receive.",
      txids: ["tx1"],
      addresses: ["bc1qreuseA"],
      scoreDelta: -12.4,
    },
    {
      type: "ADDRESS_REUSE",
      severity: "HIGH",
      description: "Address bc1qreuseB reused across multiple transactions.",
      details: {},
      correction: "Use a fresh address for each receive.",
      txids: ["tx2"],
      addresses: ["bc1qreuseB"],
      scoreDelta: -9.1,
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
    {
      type: "ADDRESS_REUSE",
      severity: "HIGH",
      description: "Address bc1qreuseC reused across multiple transactions.",
      details: {},
      correction: "Use a fresh address for each receive.",
      txids: ["tx3"],
      addresses: ["bc1qreuseC"],
      scoreDelta: -7.0,
    },
  ],
  warnings: [],
  transactionsAnalyzed: 9,
  addressesScanned: 4,
  isClean: false,
  score: 70,
  grade: "C",
  // Waterfall is aggregated per type: ADDRESS_REUSE has count 3.
  scoreWaterfall: [
    { label: "Base Score", findingType: "BASE", delta: 0, runningScore: 100, count: 0 },
    { label: "Address Reuse", findingType: "ADDRESS_REUSE", delta: -28, runningScore: 72, count: 3 },
    { label: "Dust", findingType: "DUST", delta: -2, runningScore: 70, count: 1 },
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

// Records each scrollIntoView call: which element received it and the options it
// was given. scrollIntoView lives on Element.prototype, so `this` is the
// receiving element — that is how we distinguish *which* row scrolled.
type ScrollCall = { el: Element; options: unknown };
let scrollCalls: ScrollCall[];
let rafCallbacks: FrameRequestCallback[];

function flushRaf() {
  const pending = rafCallbacks;
  rafCallbacks = [];
  for (const cb of pending) cb(0);
}

beforeEach(() => {
  scrollCalls = [];
  rafCallbacks = [];
  Element.prototype.scrollIntoView = vi.fn(function (this: Element, options?: unknown) {
    scrollCalls.push({ el: this, options });
  });
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

describe("PrivacyAuditReportPanel jumps land on the right row when findings share a type", () => {
  it("renders one row per same-type finding but a single aggregated waterfall row", async () => {
    const { getByTestId, container } = await renderWithResult();

    // All four findings render their own row.
    expect(getByTestId("row-privacy-finding-0")).toBeTruthy(); // ADDRESS_REUSE A
    expect(getByTestId("row-privacy-finding-1")).toBeTruthy(); // ADDRESS_REUSE B
    expect(getByTestId("row-privacy-finding-2")).toBeTruthy(); // DUST
    expect(getByTestId("row-privacy-finding-3")).toBeTruthy(); // ADDRESS_REUSE C

    // ...but the waterfall has exactly one ADDRESS_REUSE row (aggregated).
    const reuseWaterfallRows = container.querySelectorAll(
      '[data-waterfall-type="ADDRESS_REUSE"]',
    );
    expect(reuseWaterfallRows).toHaveLength(1);
  });

  it("finding -> waterfall: clicking the SECOND same-type finding scrolls to that type's single waterfall row", async () => {
    const { getByTestId, container } = await renderWithResult();

    const sourceFinding = getByTestId("row-privacy-finding-1"); // 2nd ADDRESS_REUSE
    const targetWaterfall = container.querySelector<HTMLElement>(
      '[data-waterfall-type="ADDRESS_REUSE"]',
    )!;
    expect(targetWaterfall).not.toBeNull();

    fireEvent.click(sourceFinding);

    // Scroll is wrapped in requestAnimationFrame.
    expect(scrollCalls).toHaveLength(0);
    flushRaf();

    expect(scrollCalls).toHaveLength(1);
    expect(scrollCalls[0].el).toBe(targetWaterfall);
    expect(scrollCalls[0].options).toEqual(EXPECTED_OPTIONS);
    // The clicked source finding must not scroll.
    expect(scrollCalls.some((c) => c.el === sourceFinding)).toBe(false);
  });

  it("finding -> waterfall: clicking the THIRD same-type finding lands on the same single waterfall row", async () => {
    const { getByTestId, container } = await renderWithResult();

    const sourceFinding = getByTestId("row-privacy-finding-3"); // 3rd ADDRESS_REUSE
    const targetWaterfall = container.querySelector<HTMLElement>(
      '[data-waterfall-type="ADDRESS_REUSE"]',
    )!;

    fireEvent.click(sourceFinding);
    flushRaf();

    expect(scrollCalls).toHaveLength(1);
    expect(scrollCalls[0].el).toBe(targetWaterfall);
    expect(scrollCalls.some((c) => c.el === sourceFinding)).toBe(false);
  });

  it("waterfall -> finding: clicking the aggregated waterfall row scrolls to the FIRST finding of that type", async () => {
    const { getByTestId, container } = await renderWithResult();

    const sourceWaterfall = getByTestId("row-privacy-waterfall-1"); // ADDRESS_REUSE (count 3)

    // The first ADDRESS_REUSE finding is finding-0; the later same-type findings
    // are finding-1 and finding-3.
    const firstReuseFinding = getByTestId("row-privacy-finding-0");
    const secondReuseFinding = getByTestId("row-privacy-finding-1");
    const thirdReuseFinding = getByTestId("row-privacy-finding-3");

    // Sanity: querySelector (first match) resolves to finding-0.
    const firstByType = container.querySelector<HTMLElement>(
      '[data-finding-type="ADDRESS_REUSE"]',
    );
    expect(firstByType).toBe(firstReuseFinding);

    fireEvent.click(sourceWaterfall);
    flushRaf();

    expect(scrollCalls).toHaveLength(1);
    expect(scrollCalls[0].el).toBe(firstReuseFinding);
    expect(scrollCalls[0].options).toEqual(EXPECTED_OPTIONS);
    // It must not land on a later same-type finding or on the clicked row.
    expect(scrollCalls.some((c) => c.el === secondReuseFinding)).toBe(false);
    expect(scrollCalls.some((c) => c.el === thirdReuseFinding)).toBe(false);
    expect(scrollCalls.some((c) => c.el === sourceWaterfall)).toBe(false);
  });

  it("highlights every finding of the clicked type together (highlight is type-based)", async () => {
    const { getByTestId } = await renderWithResult();

    // Click the second ADDRESS_REUSE finding.
    fireEvent.click(getByTestId("row-privacy-finding-1"));
    flushRaf();

    // All ADDRESS_REUSE findings share the highlight; the DUST one does not.
    expect(getByTestId("row-privacy-finding-0").className).toContain("bg-muted");
    expect(getByTestId("row-privacy-finding-1").className).toContain("bg-muted");
    expect(getByTestId("row-privacy-finding-3").className).toContain("bg-muted");
    expect(getByTestId("row-privacy-finding-2").className).not.toContain("bg-muted");
  });
});

// @vitest-environment jsdom
//
// Coverage for stepping through several same-type findings from a single
// aggregated Score Breakdown (waterfall) row in the Privacy Audit report panel
// (Reports.tsx).
//
// The waterfall aggregates findings by type (exactly one row per type, with
// `count` = number of findings of that type). When a type has more than one
// finding, the aggregated row exposes prev/next controls (and Arrow-key
// handling on the row itself) so the user can walk to each finding of that type
// in turn, instead of only ever landing on the first one.
//
// This file pins down:
//   - count > 1 rows render a prev/next navigator + a position indicator,
//     count == 1 rows do not.
//   - Next walks forward through the same-type findings (and wraps); Prev walks
//     backward (and wraps).
//   - The position indicator tracks which same-type finding is focused.
//   - Arrow keys on the row step the same way as the buttons.
//   - Clicking a prev/next button does not also fire the row's "jump to first"
//     click handler.
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
// finding (index 2). The waterfall aggregates the reuse findings into one row
// with count 3; DUST stays a single-count row.
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
  // Waterfall is aggregated per type: ADDRESS_REUSE has count 3, DUST count 1.
  // Row indices: 0=base, 1=ADDRESS_REUSE, 2=DUST.
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

describe("PrivacyAuditReportPanel stepping through same-type findings from the waterfall", () => {
  it("renders a prev/next navigator only for aggregated rows (count > 1)", async () => {
    const { getByTestId, queryByTestId } = await renderWithResult();

    // ADDRESS_REUSE is waterfall row 1 (count 3) -> navigator present.
    expect(getByTestId("button-waterfall-prev-1")).toBeTruthy();
    expect(getByTestId("button-waterfall-next-1")).toBeTruthy();
    expect(getByTestId("text-waterfall-position-1").textContent).toContain("3");

    // DUST is waterfall row 2 (count 1) -> no navigator.
    expect(queryByTestId("button-waterfall-prev-2")).toBeNull();
    expect(queryByTestId("button-waterfall-next-2")).toBeNull();
  });

  it("Next walks forward through each same-type finding and wraps around", async () => {
    const { getByTestId } = await renderWithResult();

    const firstReuse = getByTestId("row-privacy-finding-0");
    const secondReuse = getByTestId("row-privacy-finding-1");
    const thirdReuse = getByTestId("row-privacy-finding-3");
    const next = getByTestId("button-waterfall-next-1");
    const position = getByTestId("text-waterfall-position-1");

    // First Next -> first reuse finding (position 1 / 3).
    fireEvent.click(next);
    flushRaf();
    expect(scrollCalls.at(-1)!.el).toBe(firstReuse);
    expect(position.textContent).toContain("1 / 3");

    // Second Next -> second reuse finding.
    fireEvent.click(next);
    flushRaf();
    expect(scrollCalls.at(-1)!.el).toBe(secondReuse);
    expect(position.textContent).toContain("2 / 3");

    // Third Next -> third reuse finding.
    fireEvent.click(next);
    flushRaf();
    expect(scrollCalls.at(-1)!.el).toBe(thirdReuse);
    expect(position.textContent).toContain("3 / 3");

    // Fourth Next wraps back to the first reuse finding.
    fireEvent.click(next);
    flushRaf();
    expect(scrollCalls.at(-1)!.el).toBe(firstReuse);
    expect(position.textContent).toContain("1 / 3");
  });

  it("Prev walks backward and wraps to the last same-type finding", async () => {
    const { getByTestId } = await renderWithResult();

    const firstReuse = getByTestId("row-privacy-finding-0");
    const thirdReuse = getByTestId("row-privacy-finding-3");
    const prev = getByTestId("button-waterfall-prev-1");
    const position = getByTestId("text-waterfall-position-1");

    // From no selection, Prev wraps to the last same-type finding.
    fireEvent.click(prev);
    flushRaf();
    expect(scrollCalls.at(-1)!.el).toBe(thirdReuse);
    expect(position.textContent).toContain("3 / 3");

    // Prev again -> second reuse finding.
    fireEvent.click(prev);
    flushRaf();
    expect(getByTestId("text-waterfall-position-1").textContent).toContain("2 / 3");

    // Prev again -> first reuse finding.
    fireEvent.click(prev);
    flushRaf();
    expect(scrollCalls.at(-1)!.el).toBe(firstReuse);
    expect(getByTestId("text-waterfall-position-1").textContent).toContain("1 / 3");
  });

  it("Arrow keys on the aggregated row step the same way as the buttons", async () => {
    const { getByTestId } = await renderWithResult();

    const row = getByTestId("row-privacy-waterfall-1");
    const firstReuse = getByTestId("row-privacy-finding-0");
    const secondReuse = getByTestId("row-privacy-finding-1");

    fireEvent.keyDown(row, { key: "ArrowRight" });
    flushRaf();
    expect(scrollCalls.at(-1)!.el).toBe(firstReuse);
    expect(getByTestId("text-waterfall-position-1").textContent).toContain("1 / 3");

    fireEvent.keyDown(row, { key: "ArrowDown" });
    flushRaf();
    expect(scrollCalls.at(-1)!.el).toBe(secondReuse);
    expect(getByTestId("text-waterfall-position-1").textContent).toContain("2 / 3");

    fireEvent.keyDown(row, { key: "ArrowLeft" });
    flushRaf();
    expect(scrollCalls.at(-1)!.el).toBe(firstReuse);
    expect(getByTestId("text-waterfall-position-1").textContent).toContain("1 / 3");
  });

  it("clicking a navigator button does not also fire the row's jump-to-first handler", async () => {
    const { getByTestId } = await renderWithResult();

    const next = getByTestId("button-waterfall-next-1");
    const secondReuse = getByTestId("row-privacy-finding-1");

    // Advance to the second finding...
    fireEvent.click(next);
    flushRaf();
    fireEvent.click(next);
    flushRaf();

    // ...the last scroll must be to the second finding, NOT reset to the first
    // by a bubbled row click.
    expect(scrollCalls.at(-1)!.el).toBe(secondReuse);
    expect(getByTestId("text-waterfall-position-1").textContent).toContain("2 / 3");
  });

  it("clicking the aggregated row body still jumps to the first finding (unchanged)", async () => {
    const { getByTestId } = await renderWithResult();

    const firstReuse = getByTestId("row-privacy-finding-0");
    fireEvent.click(getByTestId("row-privacy-waterfall-1"));
    flushRaf();

    expect(scrollCalls.at(-1)!.el).toBe(firstReuse);
    expect(getByTestId("text-waterfall-position-1").textContent).toContain("1 / 3");
  });
});

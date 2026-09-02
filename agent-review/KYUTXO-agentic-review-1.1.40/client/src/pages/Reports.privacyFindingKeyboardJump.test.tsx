// @vitest-environment jsdom
//
// Keyboard coverage for the bidirectional finding <-> score-breakdown
// navigation in the Privacy Audit report panel (Reports.tsx). The click path
// is covered in Reports.privacyFindingJump.test.tsx; this file exercises the
// onKeyDown handlers wired separately on the finding rows and the waterfall
// (Score Breakdown) rows. Both are focusable (tabIndex=0) and respond to
// Enter / Space:
//   - Enter/Space on a finding row highlights + scrolls to its matching
//     waterfall row (data-waterfall-type), and
//   - Enter/Space on a waterfall row highlights + scrolls to its matching
//     finding row (data-finding-type).
// The handlers call preventDefault so Space does not scroll the page.
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

beforeEach(() => {
  // jsdom doesn't implement scrollIntoView; the focus helpers call it.
  Element.prototype.scrollIntoView = vi.fn();
  // The panel scrolls via requestAnimationFrame — run callbacks synchronously.
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
  // Wait for the async generate() -> mock runPrivacyAudit -> result to render.
  await waitFor(() => utils.getByTestId("card-privacy-report-waterfall"));
  return utils;
}

describe("PrivacyAuditReportPanel keyboard finding <-> breakdown navigation", () => {
  it("pressing Enter on a finding row highlights its matching waterfall row", async () => {
    const { getByTestId, container } = await renderWithResult();

    // Nothing highlighted before any interaction.
    expect(container.querySelector(".bg-muted")).toBeNull();

    // fireEvent returns false when a handler called preventDefault.
    const notCancelled = fireEvent.keyDown(getByTestId("row-privacy-finding-0"), { key: "Enter" });
    expect(notCancelled).toBe(false);

    // The matching waterfall row (by data-waterfall-type) becomes highlighted.
    const waterfallRow = container.querySelector<HTMLElement>(
      '[data-waterfall-type="ADDRESS_REUSE"]',
    );
    expect(waterfallRow).not.toBeNull();
    expect(waterfallRow!.className).toContain("bg-muted");

    // The non-matching waterfall row is not highlighted.
    const otherRow = container.querySelector<HTMLElement>(
      '[data-waterfall-type="DUST"]',
    );
    expect(otherRow!.className).not.toContain("bg-muted");

    // The matching finding row is also highlighted, and scrollIntoView fired.
    expect(getByTestId("row-privacy-finding-0").className).toContain("bg-muted");
    expect(waterfallRow!.scrollIntoView).toHaveBeenCalled();
  });

  it("pressing Space on a finding row highlights its matching waterfall row", async () => {
    const { getByTestId, container } = await renderWithResult();

    const notCancelled = fireEvent.keyDown(getByTestId("row-privacy-finding-1"), { key: " " });
    // preventDefault is called so the page doesn't scroll on Space.
    expect(notCancelled).toBe(false);

    const waterfallRow = container.querySelector<HTMLElement>(
      '[data-waterfall-type="DUST"]',
    );
    expect(waterfallRow).not.toBeNull();
    expect(waterfallRow!.className).toContain("bg-muted");
    expect(waterfallRow!.scrollIntoView).toHaveBeenCalled();
  });

  it("pressing Enter on a waterfall row highlights its matching finding row (reverse)", async () => {
    const { getByTestId, container } = await renderWithResult();

    // Waterfall rows are indexed 0=base,1=ADDRESS_REUSE,2=DUST.
    const notCancelled = fireEvent.keyDown(getByTestId("row-privacy-waterfall-2"), { key: "Enter" });
    expect(notCancelled).toBe(false);

    // The matching finding row (DUST) is highlighted, the other is not.
    const dustFinding = container.querySelector<HTMLElement>('[data-finding-type="DUST"]');
    expect(dustFinding).not.toBeNull();
    expect(dustFinding!.className).toContain("bg-muted");

    const reuseFinding = container.querySelector<HTMLElement>(
      '[data-finding-type="ADDRESS_REUSE"]',
    );
    expect(reuseFinding!.className).not.toContain("bg-muted");

    expect(dustFinding!.scrollIntoView).toHaveBeenCalled();
  });

  it("pressing Space on a waterfall row highlights its matching finding row (reverse)", async () => {
    const { getByTestId, container } = await renderWithResult();

    const notCancelled = fireEvent.keyDown(getByTestId("row-privacy-waterfall-1"), { key: " " });
    expect(notCancelled).toBe(false);

    const reuseFinding = container.querySelector<HTMLElement>(
      '[data-finding-type="ADDRESS_REUSE"]',
    );
    expect(reuseFinding).not.toBeNull();
    expect(reuseFinding!.className).toContain("bg-muted");
    expect(reuseFinding!.scrollIntoView).toHaveBeenCalled();
  });

  it("ignores other keys (no highlight, no preventDefault)", async () => {
    const { getByTestId, container } = await renderWithResult();

    const notCancelled = fireEvent.keyDown(getByTestId("row-privacy-finding-0"), { key: "a" });
    // No handler cancelled the event for an unrelated key.
    expect(notCancelled).toBe(true);
    expect(container.querySelector(".bg-muted")).toBeNull();
  });
});

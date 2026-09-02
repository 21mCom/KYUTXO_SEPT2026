// @vitest-environment jsdom
//
// Regression guard for tiny (sub-1-point) score penalties on the in-app finding
// rows. A finding whose scoreDelta is between -1 and 0 (e.g. -0.4) is a *real*
// penalty, but naive rounding renders it as "0 pts" and hides it. Both in-app
// surfaces now route their per-finding score impact through formatScoreDelta(),
// which renders "<-1 pts" for sub-1-point penalties:
//   - the Reports.tsx "Findings & Warnings" rows, and
//   - the Privacy Audit FindingCard (PrivacyAudit.tsx).
//
// This file asserts both surfaces stay in sync with formatScoreDelta() so a
// future change can't silently re-hide tiny penalties.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { formatScoreDelta } from "@/lib/privacy-report-export";

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

// One finding with a sub-1-point penalty (-0.4), one with a normal penalty
// (-3.2), and one with no penalty (0) so we cover the "<-1 pts" / "-3 pts" /
// "0 pts" branches in a single render.
const mockResult = {
  findings: [
    {
      type: "ADDRESS_REUSE",
      severity: "LOW",
      description: "Tiny reuse penalty.",
      details: {},
      correction: "Use a fresh address.",
      txids: [],
      addresses: ["bc1qtiny"],
      scoreDelta: -0.4,
    },
    {
      type: "DUST",
      severity: "LOW",
      description: "Normal dust penalty.",
      details: {},
      correction: "Avoid spending dust.",
      txids: [],
      addresses: ["bc1qdust"],
      scoreDelta: -3.2,
    },
    {
      type: "ROUND_NUMBER",
      severity: "LOW",
      description: "No penalty finding.",
      details: {},
      correction: "Nothing to fix.",
      txids: [],
      addresses: ["bc1qround"],
      scoreDelta: 0,
    },
  ],
  warnings: [],
  transactionsAnalyzed: 5,
  addressesScanned: 3,
  isClean: false,
  score: 96,
  grade: "A",
  scoreWaterfall: [
    { label: "Base Score", findingType: "BASE", delta: 0, runningScore: 100, count: 0 },
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
const { FindingCard } = await import("./PrivacyAudit");

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0);
    return 0;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderReportWithResult() {
  const utils = render(<PrivacyAuditReportPanel />);
  fireEvent.click(utils.getByTestId("button-generate-privacy-report"));
  await waitFor(() => utils.getByTestId("card-privacy-report-waterfall"));
  return utils;
}

describe("in-app finding rows show tiny (sub-1-point) score penalties", () => {
  it("formatScoreDelta renders '<-1 pts' for a delta between -1 and 0", () => {
    // Sanity-check the shared source of truth the surfaces both call.
    expect(formatScoreDelta(-0.4)).toBe("<-1 pts");
    expect(formatScoreDelta(-3.2)).toBe("-3 pts");
    expect(formatScoreDelta(0)).toBeNull();
    expect(formatScoreDelta(undefined)).toBeNull();
  });

  it("Reports.tsx Findings & Warnings rows show '<-1 pts' for a sub-1-point penalty", async () => {
    const { getByTestId } = await renderReportWithResult();

    // -0.4 must surface as the tiny-penalty label, not "0 pts".
    expect(getByTestId("text-privacy-finding-impact-0").textContent).toContain("<-1 pts");
    // -3.2 rounds to -3 pts.
    expect(getByTestId("text-privacy-finding-impact-1").textContent).toContain("-3 pts");
    // A non-negative delta has no penalty, so the row falls back to "0 pts".
    const noPenalty = getByTestId("text-privacy-finding-impact-2").textContent ?? "";
    expect(noPenalty).toContain("0 pts");
    expect(noPenalty).not.toContain("<-1");
  });

  it("PrivacyAudit FindingCard shows '<-1 pts' for a sub-1-point penalty", () => {
    const { getByTestId } = render(
      <FindingCard
        finding={mockResult.findings[0] as any}
        coinjoinTxids={new Set<string>()}
      />,
    );
    expect(getByTestId("text-score-delta").textContent).toContain("<-1 pts");
  });

  it("PrivacyAudit FindingCard shows the rounded penalty for a normal delta", () => {
    const { getByTestId } = render(
      <FindingCard
        finding={mockResult.findings[1] as any}
        coinjoinTxids={new Set<string>()}
      />,
    );
    expect(getByTestId("text-score-delta").textContent).toContain("-3 pts");
  });

  it("PrivacyAudit FindingCard renders no penalty for a non-negative delta", () => {
    const { queryByTestId } = render(
      <FindingCard
        finding={mockResult.findings[2] as any}
        coinjoinTxids={new Set<string>()}
      />,
    );
    // No scoreDelta penalty → the score-delta span is omitted entirely.
    expect(queryByTestId("text-score-delta")).toBeNull();
  });
});

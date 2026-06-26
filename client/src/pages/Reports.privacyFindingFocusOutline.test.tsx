// @vitest-environment jsdom
//
// Accessibility coverage for the focus indicator on the Privacy Audit report
// panel's keyboard-operable rows (Reports.tsx). The finding rows and the
// Score Breakdown (waterfall) rows are focusable (role="button"/tabIndex=0)
// and respond to Enter/Space (covered separately in
// Reports.privacyFindingKeyboardJump.test.tsx). This file asserts those rows
// carry a visible focus-visible indicator (focus-visible:ring/outline classes)
// so keyboard users can see which row is focused before activating it. A
// silent regression that removed the ring would not break the jump logic but
// would hurt accessibility — that's what these tests guard against.
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

// A focus-visible indicator is "perceivable" if the element opts out of the
// default outline-none-only state and applies a focus-visible ring/outline.
function hasFocusVisibleIndicator(className: string): boolean {
  return /focus-visible:(ring|outline)/.test(className);
}

describe("PrivacyAuditReportPanel focus outline on keyboard-operable rows", () => {
  it("each focusable finding row (role=button, tabIndex=0) has a focus-visible indicator", async () => {
    const { getByTestId } = await renderWithResult();

    for (const i of [0, 1]) {
      const row = getByTestId(`row-privacy-finding-${i}`);
      // Confirm the row really is the keyboard-operable element under test.
      expect(row.getAttribute("role")).toBe("button");
      expect(row.getAttribute("tabindex")).toBe("0");
      expect(hasFocusVisibleIndicator(row.className)).toBe(true);
    }
  });

  it("each focusable waterfall row (with findings) has a focus-visible indicator", async () => {
    const { getByTestId } = await renderWithResult();

    // Rows are indexed 0=base, 1=ADDRESS_REUSE, 2=DUST. Only the
    // finding-bearing rows (1 and 2) are focusable.
    for (const i of [1, 2]) {
      const row = getByTestId(`row-privacy-waterfall-${i}`);
      expect(row.getAttribute("role")).toBe("button");
      expect(row.getAttribute("tabindex")).toBe("0");
      expect(hasFocusVisibleIndicator(row.className)).toBe(true);
    }
  });

  it("the non-focusable base waterfall row does not advertise a focus indicator", async () => {
    const { getByTestId } = await renderWithResult();

    // The Base Score row has no findings, so it is not focusable and should
    // not carry the focus-visible ring meant for interactive rows.
    const baseRow = getByTestId("row-privacy-waterfall-0");
    expect(baseRow.getAttribute("tabindex")).toBeNull();
    expect(hasFocusVisibleIndicator(baseRow.className)).toBe(false);
  });
});

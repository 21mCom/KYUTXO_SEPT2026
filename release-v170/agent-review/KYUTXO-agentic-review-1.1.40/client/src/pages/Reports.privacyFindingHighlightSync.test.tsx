// @vitest-environment jsdom
//
// Single-highlight invariant for the bidirectional finding <-> score-breakdown
// navigation in the Privacy Audit report panel (Reports.tsx). The keyboard path
// (Reports.privacyFindingKeyboardJump.test.tsx), the click path
// (Reports.privacyFindingJump.test.tsx), and the focus outline
// (Reports.privacyFindingFocusOutline.test.tsx) are each covered separately.
//
// This file guards a different property: at most ONE row may appear highlighted
// at any time. After jumping to one finding, selecting a *different* finding
// must clear the previous highlight so the user is never shown two "active"
// rows at once. We exercise both directions (finding->waterfall and
// waterfall->finding) and both input methods (click and keyboard), since the
// highlight is driven by a single shared `highlightedType` state.
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

describe("PrivacyAuditReportPanel only one row highlighted at a time", () => {
  it("selecting a second finding (click) clears the first finding's highlight", async () => {
    const { getByTestId, container } = await renderWithResult();

    // Nothing highlighted before any interaction.
    expect(highlightedRows(container)).toHaveLength(0);

    // Select the first finding (ADDRESS_REUSE).
    fireEvent.click(getByTestId("row-privacy-finding-0"));
    expect(
      container.querySelector('[data-waterfall-type="ADDRESS_REUSE"]')!.className,
    ).toContain("bg-muted");

    // Now select a different finding (DUST).
    fireEvent.click(getByTestId("row-privacy-finding-1"));

    // The first finding's match must no longer be highlighted...
    expect(
      container.querySelector('[data-waterfall-type="ADDRESS_REUSE"]')!.className,
    ).not.toContain("bg-muted");
    expect(getByTestId("row-privacy-finding-0").className).not.toContain("bg-muted");

    // ...only the second finding and its match are highlighted.
    expect(getByTestId("row-privacy-finding-1").className).toContain("bg-muted");
    expect(
      container.querySelector('[data-waterfall-type="DUST"]')!.className,
    ).toContain("bg-muted");

    // Exactly two rows highlighted: the DUST finding and its DUST waterfall row.
    expect(highlightedRows(container)).toHaveLength(2);
  });

  it("selecting a second finding (keyboard) clears the first finding's highlight", async () => {
    const { getByTestId, container } = await renderWithResult();

    // Select the first finding via Enter.
    fireEvent.keyDown(getByTestId("row-privacy-finding-0"), { key: "Enter" });
    expect(getByTestId("row-privacy-finding-0").className).toContain("bg-muted");

    // Select a different finding via Space.
    fireEvent.keyDown(getByTestId("row-privacy-finding-1"), { key: " " });

    expect(getByTestId("row-privacy-finding-0").className).not.toContain("bg-muted");
    expect(
      container.querySelector('[data-waterfall-type="ADDRESS_REUSE"]')!.className,
    ).not.toContain("bg-muted");
    expect(getByTestId("row-privacy-finding-1").className).toContain("bg-muted");
    expect(highlightedRows(container)).toHaveLength(2);
  });

  it("selecting a second waterfall row (click) clears the first waterfall row's highlight", async () => {
    const { getByTestId, container } = await renderWithResult();

    // Waterfall rows are indexed 0=base, 1=ADDRESS_REUSE, 2=DUST.
    fireEvent.click(getByTestId("row-privacy-waterfall-1"));
    expect(
      container.querySelector('[data-finding-type="ADDRESS_REUSE"]')!.className,
    ).toContain("bg-muted");

    // Select a different waterfall row.
    fireEvent.click(getByTestId("row-privacy-waterfall-2"));

    // The first waterfall row and its matching finding clear...
    expect(getByTestId("row-privacy-waterfall-1").className).not.toContain("bg-muted");
    expect(
      container.querySelector('[data-finding-type="ADDRESS_REUSE"]')!.className,
    ).not.toContain("bg-muted");

    // ...only the second waterfall row and its DUST finding remain.
    expect(getByTestId("row-privacy-waterfall-2").className).toContain("bg-muted");
    expect(
      container.querySelector('[data-finding-type="DUST"]')!.className,
    ).toContain("bg-muted");
    expect(highlightedRows(container)).toHaveLength(2);
  });

  it("switching directions (waterfall then finding) leaves only the latest selection highlighted", async () => {
    const { getByTestId, container } = await renderWithResult();

    // First jump from a waterfall row (ADDRESS_REUSE).
    fireEvent.keyDown(getByTestId("row-privacy-waterfall-1"), { key: "Enter" });
    expect(
      container.querySelector('[data-finding-type="ADDRESS_REUSE"]')!.className,
    ).toContain("bg-muted");

    // Then jump from a different finding row (DUST).
    fireEvent.click(getByTestId("row-privacy-finding-1"));

    // The ADDRESS_REUSE pair is fully cleared.
    expect(
      container.querySelector('[data-finding-type="ADDRESS_REUSE"]')!.className,
    ).not.toContain("bg-muted");
    expect(
      container.querySelector('[data-waterfall-type="ADDRESS_REUSE"]')!.className,
    ).not.toContain("bg-muted");

    // Only the DUST pair is highlighted.
    expect(getByTestId("row-privacy-finding-1").className).toContain("bg-muted");
    expect(
      container.querySelector('[data-waterfall-type="DUST"]')!.className,
    ).toContain("bg-muted");
    expect(highlightedRows(container)).toHaveLength(2);
  });
});

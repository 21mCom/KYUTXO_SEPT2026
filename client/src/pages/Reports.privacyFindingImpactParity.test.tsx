// @vitest-environment jsdom
//
// Parity coverage for the per-finding "score impact" label (formatScoreDelta).
// The same impact is rendered in three places and must never drift apart:
//   - the in-app report panel (PrivacyAuditReportPanel in Reports.tsx,
//     text-privacy-finding-impact-*),
//   - the Print/PDF HTML export (finding-score span in buildPrintableReport), and
//   - the plain-text export ("Score Impact:" line in buildPrivacyTextReport).
//
// This test renders the real panel and, for each finding, asserts that the
// displayed impact label matches what each exporter produces for the SAME audit
// result. The exporters are left REAL so the comparison is against production
// output; only the data-fetching chain (owners/wallets hooks, the address page
// query, toast) and runPrivacyAudit are stubbed.
//
// The fixture deliberately exercises the formatScoreDelta edge cases shared
// across all surfaces:
//   - a sub-1-point penalty renders "<-1 pts",
//   - a normal penalty rounds (e.g. -12.4 → "-12 pts"), and
//   - findings with no penalty (no/non-negative scoreDelta) omit the impact in
//     HTML/text while showing "0 pts" in-app.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";

import {
  buildPrivacyTextReport,
  formatScoreDelta,
  type ExportScope,
} from "@/lib/privacy-report-export";
import { buildPrintableReport } from "@/lib/privacy-report-html";

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

// Findings fixture covering every shared formatScoreDelta branch. The in-app
// panel, HTML export, and text export all iterate [...findings, ...warnings] in
// this exact order, so the rows line up index-for-index across surfaces.
//   0. ADDRESS_REUSE   delta -12.4 → rounds to "-12 pts"
//   1. DUST            delta -0.4  → sub-1-point penalty "<-1 pts"
//   2. ROUND_AMOUNT    delta  0    → no penalty (omit in HTML/text, "0 pts" in-app)
//   3. HIGH_ACTIVITY   delta undef → no penalty (omit in HTML/text, "0 pts" in-app)
function makeFinding(overrides: Record<string, unknown>) {
  return {
    severity: "MEDIUM",
    description: "desc",
    details: {},
    correction: "",
    txids: [],
    addresses: [],
    ...overrides,
  };
}

const mockResult = {
  findings: [
    makeFinding({ type: "ADDRESS_REUSE", severity: "HIGH", scoreDelta: -12.4 }),
    makeFinding({ type: "DUST", severity: "LOW", scoreDelta: -0.4 }),
    makeFinding({ type: "ROUND_AMOUNT", severity: "LOW", scoreDelta: 0 }),
  ],
  warnings: [
    makeFinding({ type: "HIGH_ACTIVITY", severity: "MEDIUM" }),
  ],
  warningsList: [],
  transactionsAnalyzed: 5,
  addressesScanned: 3,
  isClean: false,
  score: 75,
  grade: "C",
  scoreWaterfall: [],
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

// The in-app panel defaults to the All / All scope; the exporters are invoked
// with the matching scope so every surface describes the same audit.
const SCOPE: ExportScope = { owner: null, wallet: null };

const orderedFindings = [...mockResult.findings, ...mockResult.warnings];

/** Pull the impact label out of each rendered in-app finding row. */
function readInAppImpacts(container: HTMLElement): string[] {
  return orderedFindings.map((_, i) => {
    const el = container.querySelector<HTMLElement>(
      `[data-testid="text-privacy-finding-impact-${i}"]`,
    );
    expect(el, `in-app impact row ${i} should render`).not.toBeNull();
    return el!.textContent!.trim();
  });
}

/**
 * Pull the impact label out of each finding block in the printable HTML export.
 * Findings with no penalty omit the `.finding-score` span entirely, which maps
 * to `null` so the array lines up index-for-index with the other surfaces.
 */
function readHtmlImpacts(html: string): (string | null)[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const findings = Array.from(doc.querySelectorAll<HTMLElement>(".finding"));
  return findings.map((f) => {
    const score = f.querySelector<HTMLElement>(".finding-score");
    return score ? score.textContent!.trim() : null;
  });
}

/**
 * Pull the impact label out of each finding block in the plain-text export.
 * Each finding starts with a numbered "N. [Severity] Label" line; the optional
 * "Score Impact:" line follows within that block (before the next numbered
 * finding). Missing → `null` so the array lines up with the other surfaces.
 */
function readTextImpacts(text: string, count: number): (string | null)[] {
  const lines = text.split("\n");
  const starts: number[] = [];
  lines.forEach((line, idx) => {
    if (/^\d+\.\s+\[/.test(line)) starts.push(idx);
  });
  expect(starts).toHaveLength(count);
  return starts.map((start, i) => {
    const end = starts[i + 1] ?? lines.length;
    for (let j = start; j < end; j++) {
      const m = lines[j].match(/Score Impact:\s*(.+)/);
      if (m) return m[1].trim();
    }
    return null;
  });
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderWithResult() {
  const utils = render(<PrivacyAuditReportPanel />);
  fireEvent.click(utils.getByTestId("button-generate-privacy-report"));
  await waitFor(() => utils.getByTestId("container-privacy-report-findings"));
  return utils;
}

describe("PrivacyAuditReportPanel — per-finding score impact parity across surfaces", () => {
  it("in-app impact labels match the HTML and text exports for each finding", async () => {
    const { container } = await renderWithResult();

    const count = orderedFindings.length;
    const inApp = readInAppImpacts(container);
    const html = readHtmlImpacts(buildPrintableReport(mockResult as never, SCOPE));
    const text = readTextImpacts(
      buildPrivacyTextReport(mockResult as never, SCOPE, "fixed"),
      count,
    );

    // Every surface produced one entry per finding.
    expect(inApp).toHaveLength(count);
    expect(html).toHaveLength(count);
    expect(text).toHaveLength(count);

    // For each finding, derive the canonical label from formatScoreDelta (the
    // single source of truth) and assert all three surfaces agree:
    //   - penalty findings: HTML/text show the exact label; in-app shows it too.
    //   - no-penalty findings: HTML/text omit it (null); in-app shows "0 pts".
    orderedFindings.forEach((f, i) => {
      const canonical = formatScoreDelta(f.scoreDelta as number | undefined);
      expect(html[i]).toBe(canonical);
      expect(text[i]).toBe(canonical);
      expect(inApp[i]).toBe(canonical ?? "0 pts");
    });
  });

  it("shares the rounding, sub-1-point, and no-penalty formatting edge cases", async () => {
    const { container } = await renderWithResult();

    const inApp = readInAppImpacts(container);
    const html = readHtmlImpacts(buildPrintableReport(mockResult as never, SCOPE));
    const text = readTextImpacts(
      buildPrivacyTextReport(mockResult as never, SCOPE, "fixed"),
      orderedFindings.length,
    );

    // 0. ADDRESS_REUSE: a fractional penalty (-12.4) rounds to "-12 pts".
    expect(inApp[0]).toBe("-12 pts");
    expect(html[0]).toBe("-12 pts");
    expect(text[0]).toBe("-12 pts");

    // 1. DUST: a sub-1-point penalty (-0.4) renders "<-1 pts".
    expect(inApp[1]).toBe("<-1 pts");
    expect(html[1]).toBe("<-1 pts");
    expect(text[1]).toBe("<-1 pts");

    // 2. ROUND_AMOUNT: an explicit zero delta is no penalty — HTML/text omit the
    //    impact, the in-app panel shows "0 pts".
    expect(inApp[2]).toBe("0 pts");
    expect(html[2]).toBeNull();
    expect(text[2]).toBeNull();

    // 3. HIGH_ACTIVITY: an undefined delta is likewise no penalty.
    expect(inApp[3]).toBe("0 pts");
    expect(html[3]).toBeNull();
    expect(text[3]).toBeNull();
  });
});

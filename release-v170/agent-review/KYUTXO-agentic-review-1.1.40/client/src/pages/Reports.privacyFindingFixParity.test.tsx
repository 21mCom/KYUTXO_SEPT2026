// @vitest-environment jsdom
//
// Parity coverage for the per-finding "Fix:" remediation text (f.correction).
// The same correction is rendered in three places and must never drift apart:
//   - the in-app report panel (PrivacyAuditReportPanel in Reports.tsx, the
//     italic "Fix: ..." div, text-privacy-finding-fix-*),
//   - the Print/PDF HTML export (.finding-fix block in buildPrintableReport), and
//   - the plain-text export ("   Fix: ..." line in buildPrivacyTextReport).
//
// This test renders the real panel and, for each finding, asserts that the
// displayed correction text matches what each exporter produces for the SAME
// audit result. The exporters are left REAL so the comparison is against
// production output; only the data-fetching chain (owners/wallets hooks, the
// address page query, toast) and runPrivacyAudit are stubbed.
//
// The fixture deliberately includes a finding with NO correction to confirm the
// fix line is omitted consistently on every surface, and the ordering across
// [...findings, ...warnings] is identical on every surface.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";

import {
  buildPrivacyTextReport,
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

// Findings fixture. The in-app panel, HTML export, and text export all iterate
// [...findings, ...warnings] in this exact order, so the rows line up
// index-for-index across surfaces:
//   0. ADDRESS_REUSE  has a plain correction
//   1. DUST           has NO correction  (fix line must be omitted everywhere)
//   2. ROUND_AMOUNT   correction with a URL (renderSourceNote linkifies it, but
//                     the displayed text must still equal the raw correction)
//   3. HIGH_ACTIVITY  (warning) correction with HTML-special chars
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
    makeFinding({
      type: "ADDRESS_REUSE",
      severity: "CRITICAL",
      scoreDelta: -20,
      correction: "Stop reusing this address; generate a fresh one per payment.",
    }),
    makeFinding({ type: "DUST", severity: "HIGH", scoreDelta: -10, correction: "" }),
    makeFinding({
      type: "ROUND_AMOUNT",
      severity: "MEDIUM",
      scoreDelta: -5,
      correction: "Vary amounts. See https://example.com/privacy for guidance.",
    }),
  ],
  warnings: [
    makeFinding({
      type: "HIGH_ACTIVITY",
      severity: "LOW",
      scoreDelta: -1,
      correction: 'Avoid bursts of <activity> & "batching" too tightly.',
    }),
  ],
  warningsList: [],
  transactionsAnalyzed: 5,
  addressesScanned: 3,
  isClean: false,
  score: 64,
  grade: "D",
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

/** Strip the shared "Fix:" prefix so only the correction text remains. */
function stripFixPrefix(s: string): string {
  return s.replace(/^Fix:\s?/, "").trim();
}

/**
 * Pull the correction text out of each rendered in-app finding row. Returns
 * `null` for any finding whose fix div is absent (no correction).
 */
function readInAppFixes(container: HTMLElement): (string | null)[] {
  return orderedFindings.map((_, i) => {
    const el = container.querySelector<HTMLElement>(
      `[data-testid="text-privacy-finding-fix-${i}"]`,
    );
    return el ? stripFixPrefix(el.textContent ?? "") : null;
  });
}

/**
 * Pull the correction text out of each finding block in the printable HTML
 * export. Every `.finding` block lines up index-for-index with the other
 * surfaces; `.finding-fix` is absent when the finding has no correction.
 */
function readHtmlFixes(html: string): (string | null)[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const findings = Array.from(doc.querySelectorAll<HTMLElement>(".finding"));
  return findings.map((f) => {
    const fix = f.querySelector<HTMLElement>(".finding-fix");
    return fix ? stripFixPrefix(fix.textContent ?? "") : null;
  });
}

/**
 * Pull the correction text out of each finding block in the plain-text export.
 * Within the "FINDINGS & WARNINGS" section, each finding starts with a numbered
 * "N. [Severity] Label" line; a "   Fix: ..." line (when present) follows. The
 * returned array is indexed by finding (null when the fix line is omitted).
 */
function readTextFixes(text: string, count: number): (string | null)[] {
  const lines = text.split("\n");
  const startIdx = lines.findIndex((l) => /^FINDINGS & WARNINGS/.test(l));
  const section = startIdx >= 0 ? lines.slice(startIdx) : lines;
  const fixes: (string | null)[] = new Array(count).fill(null);
  let current = -1;
  for (const line of section) {
    const head = line.match(/^(\d+)\.\s+\[/);
    if (head) {
      current = parseInt(head[1], 10) - 1;
      continue;
    }
    const fix = line.match(/^\s+Fix:\s?(.*)$/);
    if (fix && current >= 0 && current < count) {
      fixes[current] = fix[1];
    }
  }
  return fixes;
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

describe("PrivacyAuditReportPanel — per-finding fix/correction parity across surfaces", () => {
  it("in-app correction text matches the HTML and text exports for each finding", async () => {
    const { container } = await renderWithResult();

    const count = orderedFindings.length;
    const inApp = readInAppFixes(container);
    const html = readHtmlFixes(buildPrintableReport(mockResult as never, SCOPE));
    const text = readTextFixes(
      buildPrivacyTextReport(mockResult as never, SCOPE, "fixed"),
      count,
    );

    // Every surface produced one slot per finding.
    expect(inApp).toHaveLength(count);
    expect(html).toHaveLength(count);
    expect(text).toHaveLength(count);

    // For each finding, the canonical correction (f.correction) is the single
    // source of truth: a non-empty correction must surface identically on all
    // three, and an empty correction must be omitted on all three.
    orderedFindings.forEach((f, i) => {
      const canonical = f.correction ? f.correction : null;
      expect(inApp[i], `in-app fix ${i}`).toBe(canonical);
      expect(html[i], `html fix ${i}`).toBe(canonical);
      expect(text[i], `text fix ${i}`).toBe(canonical);
    });
  });

  it("omits the fix line consistently for a finding with no correction", async () => {
    const { container } = await renderWithResult();

    // Index 1 (DUST) has correction: "" — confirm none of the surfaces emit a
    // fix line for it while its neighbors do.
    const inApp = readInAppFixes(container);
    const html = readHtmlFixes(buildPrintableReport(mockResult as never, SCOPE));
    const text = readTextFixes(
      buildPrivacyTextReport(mockResult as never, SCOPE, "fixed"),
      orderedFindings.length,
    );

    expect(inApp[1]).toBeNull();
    expect(html[1]).toBeNull();
    expect(text[1]).toBeNull();

    // Sanity: a neighbor with a correction still surfaces it everywhere, so the
    // omission above is meaningful and not a parser miss.
    expect(inApp[0]).not.toBeNull();
    expect(html[0]).not.toBeNull();
    expect(text[0]).not.toBeNull();
  });
});

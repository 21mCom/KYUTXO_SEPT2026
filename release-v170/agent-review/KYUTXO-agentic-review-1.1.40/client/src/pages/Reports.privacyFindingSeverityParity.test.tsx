// @vitest-environment jsdom
//
// Parity coverage for the per-finding "severity" label (severityLabel).
// The same severity is rendered in three places and must never drift apart:
//   - the in-app report panel (PrivacyAuditReportPanel in Reports.tsx, the
//     severity Badge, text-privacy-finding-severity-*),
//   - the Print/PDF HTML export (.sev-badge span in buildPrintableReport), and
//   - the plain-text export ("[Severity]" prefix in buildPrivacyTextReport).
//
// This test renders the real panel and, for each finding, asserts that the
// displayed severity label matches what each exporter produces for the SAME
// audit result. The exporters are left REAL so the comparison is against
// production output; only the data-fetching chain (owners/wallets hooks, the
// address page query, toast) and runPrivacyAudit are stubbed.
//
// The fixture covers all four severities (CRITICAL/HIGH/MEDIUM/LOW) and that
// the ordering across [...findings, ...warnings] is identical on every surface.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";

import {
  buildPrivacyTextReport,
  severityLabel,
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

// Findings fixture covering every severity. The in-app panel, HTML export, and
// text export all iterate [...findings, ...warnings] in this exact order, so the
// rows line up index-for-index across surfaces:
//   0. ADDRESS_REUSE  CRITICAL
//   1. DUST           HIGH
//   2. ROUND_AMOUNT   MEDIUM
//   3. HIGH_ACTIVITY  LOW       (warning, so it follows the findings)
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
    makeFinding({ type: "ADDRESS_REUSE", severity: "CRITICAL", scoreDelta: -20 }),
    makeFinding({ type: "DUST", severity: "HIGH", scoreDelta: -10 }),
    makeFinding({ type: "ROUND_AMOUNT", severity: "MEDIUM", scoreDelta: -5 }),
  ],
  warnings: [
    makeFinding({ type: "HIGH_ACTIVITY", severity: "LOW", scoreDelta: -1 }),
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

/** Pull the severity label out of each rendered in-app finding row. */
function readInAppSeverities(container: HTMLElement): string[] {
  return orderedFindings.map((_, i) => {
    const el = container.querySelector<HTMLElement>(
      `[data-testid="text-privacy-finding-severity-${i}"]`,
    );
    expect(el, `in-app severity badge ${i} should render`).not.toBeNull();
    return el!.textContent!.trim();
  });
}

/**
 * Pull the severity label out of each finding block in the printable HTML
 * export. Every finding renders exactly one `.sev-badge` span, so the array
 * lines up index-for-index with the other surfaces.
 */
function readHtmlSeverities(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const findings = Array.from(doc.querySelectorAll<HTMLElement>(".finding"));
  return findings.map((f) => {
    const badge = f.querySelector<HTMLElement>(".sev-badge");
    expect(badge, "each HTML finding should have a .sev-badge").not.toBeNull();
    return badge!.textContent!.trim();
  });
}

/**
 * Pull the severity label out of each finding block in the plain-text export.
 * Each finding starts with a numbered "N. [Severity] Label" line; the bracketed
 * token is the severity label.
 */
function readTextSeverities(text: string, count: number): string[] {
  const lines = text.split("\n");
  const severities: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\d+\.\s+\[([^\]]+)\]/);
    if (m) severities.push(m[1].trim());
  }
  expect(severities).toHaveLength(count);
  return severities;
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

describe("PrivacyAuditReportPanel — per-finding severity label parity across surfaces", () => {
  it("in-app severity labels match the HTML and text exports for each finding", async () => {
    const { container } = await renderWithResult();

    const count = orderedFindings.length;
    const inApp = readInAppSeverities(container);
    const html = readHtmlSeverities(buildPrintableReport(mockResult as never, SCOPE));
    const text = readTextSeverities(
      buildPrivacyTextReport(mockResult as never, SCOPE, "fixed"),
      count,
    );

    // Every surface produced one entry per finding.
    expect(inApp).toHaveLength(count);
    expect(html).toHaveLength(count);
    expect(text).toHaveLength(count);

    // For each finding, derive the canonical label from severityLabel (the
    // single source of truth) and assert all three surfaces agree.
    orderedFindings.forEach((f, i) => {
      const canonical = severityLabel(f.severity as never);
      expect(inApp[i]).toBe(canonical);
      expect(html[i]).toBe(canonical);
      expect(text[i]).toBe(canonical);
    });
  });

  it("renders all four severities in the same order on every surface", async () => {
    const { container } = await renderWithResult();

    const inApp = readInAppSeverities(container);
    const html = readHtmlSeverities(buildPrintableReport(mockResult as never, SCOPE));
    const text = readTextSeverities(
      buildPrivacyTextReport(mockResult as never, SCOPE, "fixed"),
      orderedFindings.length,
    );

    // The exact ordered sequence across [...findings, ...warnings]: a CRITICAL
    // and HIGH and MEDIUM finding, then the LOW warning trailing.
    const expected = ["Critical", "High", "Medium", "Low"];
    expect(inApp).toEqual(expected);
    expect(html).toEqual(expected);
    expect(text).toEqual(expected);
  });
});

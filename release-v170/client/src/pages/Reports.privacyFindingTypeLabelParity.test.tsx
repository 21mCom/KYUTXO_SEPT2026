// @vitest-environment jsdom
//
// Parity coverage for the per-finding "type" label (FINDING_TYPE_LABELS[f.type]).
// The same human-readable type label is rendered in three places and must never
// drift apart:
//   - the in-app report panel (PrivacyAuditReportPanel in Reports.tsx, the
//     finding title div, text-privacy-finding-type-*),
//   - the Print/PDF HTML export (.finding-title span in buildPrintableReport), and
//   - the plain-text export ("N. [Severity] Label" line in buildPrivacyTextReport).
//
// This test renders the real panel and, for each finding, asserts that the
// displayed type label matches what each exporter produces for the SAME audit
// result. The exporters are left REAL so the comparison is against production
// output; only the data-fetching chain (owners/wallets hooks, the address page
// query, toast) and runPrivacyAudit are stubbed.
//
// The fixture includes a finding whose type is NOT in FINDING_TYPE_LABELS so the
// raw-type fallback (FINDING_TYPE_LABELS[f.type] ?? f.type) is exercised on every
// surface, and confirms the ordering across [...findings, ...warnings] is
// identical everywhere.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";

import {
  buildPrivacyTextReport,
  type ExportScope,
} from "@/lib/privacy-report-export";
import { buildPrintableReport } from "@/lib/privacy-report-html";
import { FINDING_TYPE_LABELS } from "@/lib/privacy-audit";

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

// Findings fixture covering several known type labels plus one UNKNOWN type. The
// in-app panel, HTML export, and text export all iterate [...findings,
// ...warnings] in this exact order, so the rows line up index-for-index across
// surfaces:
//   0. ADDRESS_REUSE   -> "Address Reuse"            (known)
//   1. DUST            -> "Dust UTXO"                (known)
//   2. TOTALLY_UNKNOWN -> "TOTALLY_UNKNOWN"          (raw-type fallback)
//   3. HIGH_ACTIVITY   -> "High Activity Address"    (warning, trails findings)
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

const UNKNOWN_TYPE = "TOTALLY_UNKNOWN";

const mockResult = {
  findings: [
    makeFinding({ type: "ADDRESS_REUSE", severity: "CRITICAL", scoreDelta: -20 }),
    makeFinding({ type: "DUST", severity: "HIGH", scoreDelta: -10 }),
    makeFinding({ type: UNKNOWN_TYPE, severity: "MEDIUM", scoreDelta: -5 }),
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

/** Pull the type label out of each rendered in-app finding row. */
function readInAppTypeLabels(container: HTMLElement): string[] {
  return orderedFindings.map((_, i) => {
    const el = container.querySelector<HTMLElement>(
      `[data-testid="text-privacy-finding-type-${i}"]`,
    );
    expect(el, `in-app type label ${i} should render`).not.toBeNull();
    return el!.textContent!.trim();
  });
}

/**
 * Pull the type label out of each finding block in the printable HTML export.
 * Every finding renders exactly one `.finding-title` span, so the array lines up
 * index-for-index with the other surfaces.
 */
function readHtmlTypeLabels(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const findings = Array.from(doc.querySelectorAll<HTMLElement>(".finding"));
  return findings.map((f) => {
    const title = f.querySelector<HTMLElement>(".finding-title");
    expect(title, "each HTML finding should have a .finding-title").not.toBeNull();
    return title!.textContent!.trim();
  });
}

/**
 * Pull the type label out of each finding block in the plain-text export. Each
 * finding starts with a numbered "N. [Severity] Label" line; everything after
 * the bracketed severity token is the type label.
 */
function readTextTypeLabels(text: string, count: number): string[] {
  const lines = text.split("\n");
  const labels: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\d+\.\s+\[[^\]]+\]\s+(.+)$/);
    if (m) labels.push(m[1].trim());
  }
  expect(labels).toHaveLength(count);
  return labels;
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

describe("PrivacyAuditReportPanel — per-finding type label parity across surfaces", () => {
  it("in-app type labels match the HTML and text exports for each finding", async () => {
    const { container } = await renderWithResult();

    const count = orderedFindings.length;
    const inApp = readInAppTypeLabels(container);
    const html = readHtmlTypeLabels(buildPrintableReport(mockResult as never, SCOPE));
    const text = readTextTypeLabels(
      buildPrivacyTextReport(mockResult as never, SCOPE, "fixed"),
      count,
    );

    // Every surface produced one entry per finding.
    expect(inApp).toHaveLength(count);
    expect(html).toHaveLength(count);
    expect(text).toHaveLength(count);

    // For each finding, derive the canonical label the same way every surface
    // does (FINDING_TYPE_LABELS[f.type] ?? f.type) and assert all three agree.
    orderedFindings.forEach((f, i) => {
      const canonical =
        (FINDING_TYPE_LABELS as Record<string, string>)[f.type] ?? f.type;
      expect(inApp[i]).toBe(canonical);
      expect(html[i]).toBe(canonical);
      expect(text[i]).toBe(canonical);
    });
  });

  it("renders the known labels and the raw-type fallback in the same order on every surface", async () => {
    const { container } = await renderWithResult();

    const inApp = readInAppTypeLabels(container);
    const html = readHtmlTypeLabels(buildPrintableReport(mockResult as never, SCOPE));
    const text = readTextTypeLabels(
      buildPrivacyTextReport(mockResult as never, SCOPE, "fixed"),
      orderedFindings.length,
    );

    // The exact ordered sequence across [...findings, ...warnings]: two known
    // labels, the raw-type fallback for the unknown type, then the warning's
    // known label trailing.
    const expected = [
      "Address Reuse",
      "Dust UTXO",
      UNKNOWN_TYPE,
      "High Activity Address",
    ];
    expect(inApp).toEqual(expected);
    expect(html).toEqual(expected);
    expect(text).toEqual(expected);
  });

  it("surfaces the raw type verbatim when it is missing from FINDING_TYPE_LABELS", async () => {
    const { container } = await renderWithResult();

    // The unknown-type finding sits at index 2 across all surfaces.
    const idx = orderedFindings.findIndex((f) => f.type === UNKNOWN_TYPE);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect((FINDING_TYPE_LABELS as Record<string, string>)[UNKNOWN_TYPE]).toBeUndefined();

    const inApp = readInAppTypeLabels(container);
    const html = readHtmlTypeLabels(buildPrintableReport(mockResult as never, SCOPE));
    const text = readTextTypeLabels(
      buildPrivacyTextReport(mockResult as never, SCOPE, "fixed"),
      orderedFindings.length,
    );

    expect(inApp[idx]).toBe(UNKNOWN_TYPE);
    expect(html[idx]).toBe(UNKNOWN_TYPE);
    expect(text[idx]).toBe(UNKNOWN_TYPE);
  });
});

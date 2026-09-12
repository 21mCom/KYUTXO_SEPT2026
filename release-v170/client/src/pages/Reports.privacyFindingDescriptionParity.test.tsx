// @vitest-environment jsdom
//
// Parity coverage for the per-finding description text (f.description).
// The same description is rendered in three places and must never drift apart:
//   - the in-app report panel (PrivacyAuditReportPanel in Reports.tsx, the
//     description div via renderSourceNote, text-privacy-finding-desc-*),
//   - the Print/PDF HTML export (.finding-desc in buildPrintableReport, escaped
//     via escapeHtml), and
//   - the plain-text export (the description line in buildPrivacyTextReport,
//     emitted raw).
//
// Each surface formats/escapes the description differently (renderSourceNote
// turns URLs into anchors, escapeHtml HTML-escapes, the text export is raw), so
// the only way they cannot drift is if the *displayed* text — the textContent a
// user actually reads — is identical across all three. This test renders the
// real panel and, for each finding, asserts the displayed description matches
// what each exporter produces for the SAME audit result. The exporters are left
// REAL so the comparison is against production output; only the data-fetching
// chain (owners/wallets hooks, the address page query, toast) and
// runPrivacyAudit are stubbed.
//
// The fixture deliberately includes a description with characters affected by
// escaping (`<`, `&`, `>`, quotes) and one carrying a URL so the test would fail
// if any surface's escaping/linkifying dropped or altered the visible text.

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

// Findings fixture covering descriptions that exercise each surface's
// formatting. The in-app panel, HTML export, and text export all iterate
// [...findings, ...warnings] in this exact order, so the rows line up
// index-for-index across surfaces:
//   0. ADDRESS_REUSE  — plain text
//   1. DUST           — contains <, &, >, quotes (escaping-sensitive)
//   2. ROUND_AMOUNT   — contains a URL (linkify-sensitive)
//   3. HIGH_ACTIVITY  — URL embedded mid-sentence (warning, trails findings)
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
      description: "This address was reused across multiple transactions.",
    }),
    makeFinding({
      type: "DUST",
      severity: "HIGH",
      scoreDelta: -10,
      description: 'Dust < 1000 sats & "tainted" outputs > threshold detected.',
    }),
    makeFinding({
      type: "ROUND_AMOUNT",
      severity: "MEDIUM",
      scoreDelta: -5,
      description: "Round amount heuristic — see https://example.com/privacy for details.",
    }),
  ],
  warnings: [
    makeFinding({
      type: "HIGH_ACTIVITY",
      severity: "LOW",
      scoreDelta: -1,
      description: "High activity; review https://example.org/guide?a=1&b=2 before sharing.",
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

/** Pull the displayed description text out of each rendered in-app finding row. */
function readInAppDescriptions(container: HTMLElement): string[] {
  return orderedFindings.map((_, i) => {
    const el = container.querySelector<HTMLElement>(
      `[data-testid="text-privacy-finding-desc-${i}"]`,
    );
    expect(el, `in-app description ${i} should render`).not.toBeNull();
    return el!.textContent!;
  });
}

/**
 * Pull the displayed description text out of each finding block in the printable
 * HTML export. Every finding renders exactly one `.finding-desc` div, so the
 * array lines up index-for-index with the other surfaces. Reading textContent
 * (rather than innerHTML) unescapes the entities so we compare the text a reader
 * actually sees, matching the in-app and text surfaces.
 */
function readHtmlDescriptions(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const findings = Array.from(doc.querySelectorAll<HTMLElement>(".finding"));
  return findings.map((f) => {
    const desc = f.querySelector<HTMLElement>(".finding-desc");
    expect(desc, "each HTML finding should have a .finding-desc").not.toBeNull();
    return desc!.textContent!;
  });
}

/**
 * Pull the displayed description out of each finding block in the plain-text
 * export. Each finding is a numbered "N. [Severity] Label" line immediately
 * followed by an indented description line; we capture that description line.
 */
function readTextDescriptions(text: string, count: number): string[] {
  const lines = text.split("\n");
  const descriptions: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\d+\.\s+\[[^\]]+\]/.test(lines[i])) {
      const next = lines[i + 1] ?? "";
      descriptions.push(next.replace(/^\s+/, ""));
    }
  }
  expect(descriptions).toHaveLength(count);
  return descriptions;
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

describe("PrivacyAuditReportPanel — per-finding description parity across surfaces", () => {
  it("in-app descriptions match the HTML and text exports for each finding", async () => {
    const { container } = await renderWithResult();

    const count = orderedFindings.length;
    const inApp = readInAppDescriptions(container);
    const html = readHtmlDescriptions(buildPrintableReport(mockResult as never, SCOPE));
    const text = readTextDescriptions(
      buildPrivacyTextReport(mockResult as never, SCOPE, "fixed"),
      count,
    );

    // Every surface produced one entry per finding.
    expect(inApp).toHaveLength(count);
    expect(html).toHaveLength(count);
    expect(text).toHaveLength(count);

    // For each finding, the canonical text is the raw f.description; assert all
    // three surfaces display exactly that, in identical [...findings, ...warnings]
    // order, regardless of how each surface escapes/linkifies it internally.
    orderedFindings.forEach((f, i) => {
      const canonical = f.description;
      expect(inApp[i]).toBe(canonical);
      expect(html[i]).toBe(canonical);
      expect(text[i]).toBe(canonical);
    });
  });

  it("preserves escaping-sensitive and URL-bearing descriptions on every surface", async () => {
    const { container } = await renderWithResult();

    const inApp = readInAppDescriptions(container);
    const html = readHtmlDescriptions(buildPrintableReport(mockResult as never, SCOPE));
    const text = readTextDescriptions(
      buildPrivacyTextReport(mockResult as never, SCOPE, "fixed"),
      orderedFindings.length,
    );

    // The DUST finding's <, &, > and quotes must survive intact on all surfaces.
    const dustIndex = 1;
    const dust = orderedFindings[dustIndex].description;
    expect(dust).toContain("<");
    expect(dust).toContain("&");
    expect(inApp[dustIndex]).toBe(dust);
    expect(html[dustIndex]).toBe(dust);
    expect(text[dustIndex]).toBe(dust);

    // The URL-bearing descriptions must keep the full URL visible everywhere.
    const urlIndex = 2;
    const url = orderedFindings[urlIndex].description;
    expect(url).toContain("https://example.com/privacy");
    expect(inApp[urlIndex]).toBe(url);
    expect(html[urlIndex]).toBe(url);
    expect(text[urlIndex]).toBe(url);
  });
});

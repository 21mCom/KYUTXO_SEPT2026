// @vitest-environment jsdom
//
// Parity coverage for the per-finding "locator" line (formatFindingLocator).
// The Score Breakdown section enumerates each finding under its category with a
// one-line locator — e.g. "addr bc1q… (+2 more)  ·  tx abcd… (+1 more)", or "—"
// when the finding carries neither an address nor a txid. That locator is
// rendered in TWO independent exporters that must never drift apart:
//   - the plain-text export (buildPrivacyTextReport, the indented member lines
//     under each SCORE BREAKDOWN category), and
//   - the print/PDF HTML export (buildPrintableReport, the .waterfall-finding-row
//     cells, locator in the .mono span).
//
// Each path formats the locator independently, so a change to the "(+N more)"
// suffix, the addr/tx ordering, or the "—" fallback in one exporter could
// silently diverge from the other. This test builds both exports from ONE shared
// audit result and asserts the same locator string appears for the same finding
// in both surfaces. The exporters are left REAL so the comparison is against
// production output.
//
// The fixture deliberately exercises every formatFindingLocator branch:
//   - ADDRESS_REUSE: multiple addresses AND multiple txids → "(+N more)" on both
//   - DUST:          a single address only → no suffix, no tx segment
//   - ROUND_AMOUNT:  multiple txids only → "(+N more)" on tx, no addr segment
//   - HIGH_ACTIVITY: neither address nor txid → the "—" fallback

import { describe, it, expect } from "vitest";

import {
  buildPrivacyTextReport,
  formatFindingLocator,
  type ExportScope,
} from "@/lib/privacy-report-export";
import { buildPrintableReport } from "@/lib/privacy-report-html";

// Findings fixture. The text and HTML exports both iterate `scoreWaterfall` and,
// within each entry, `findingsOfType` (which scans [...findings, ...warnings]
// filtered by type), so the locator lists line up entry-for-entry across both
// surfaces. Each finding type below appears in exactly one waterfall entry.
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

const ADDRS = [
  "bc1qaddressreuseone0000000000000000000000",
  "bc1qaddressreusetwo0000000000000000000000",
  "bc1qaddressreusethree000000000000000000000",
];
const TXIDS = [
  "aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888",
  "1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777aaaa8888bbbb",
];

const mockResult = {
  findings: [
    // addr (+2 more)  ·  tx (+1 more)
    makeFinding({
      type: "ADDRESS_REUSE",
      severity: "HIGH",
      scoreDelta: -28.4,
      addresses: ADDRS,
      txids: TXIDS,
    }),
    // single address only — no "(+N more)", no tx segment
    makeFinding({
      type: "DUST",
      severity: "LOW",
      scoreDelta: -0.4,
      addresses: [ADDRS[0]],
      txids: [],
    }),
    // tx (+1 more) only — no addr segment
    makeFinding({
      type: "ROUND_AMOUNT",
      severity: "LOW",
      scoreDelta: 0,
      addresses: [],
      txids: TXIDS,
    }),
  ],
  warnings: [
    // neither address nor txid — the "—" fallback
    makeFinding({ type: "HIGH_ACTIVITY", severity: "MEDIUM", addresses: [], txids: [] }),
  ],
  warningsList: [],
  transactionsAnalyzed: 5,
  addressesScanned: 3,
  isClean: false,
  score: 75,
  grade: "C",
  // One waterfall entry per finding type, in the order the findings appear, so
  // the flattened locator list is deterministic across both exporters.
  scoreWaterfall: [
    { label: "Address Reuse", findingType: "ADDRESS_REUSE", delta: -28, runningScore: 72, count: 1 },
    { label: "Dust", findingType: "DUST", delta: -1, runningScore: 71, count: 1 },
    { label: "Round Amounts", findingType: "ROUND_AMOUNT", delta: 0, runningScore: 71, count: 1 },
    { label: "High Activity", findingType: "HIGH_ACTIVITY", delta: 0, runningScore: 71, count: 1 },
  ],
  needsResync: false,
  fingerprintCoverage: 1,
};

// The exporters iterate scoreWaterfall, and within each entry the matching
// findings, in this exact flattened order.
const orderedFindings = [...mockResult.findings, ...mockResult.warnings];

const SCOPE: ExportScope = { owner: null, wallet: null };

/**
 * Pull each Score Breakdown member-line locator out of the plain-text export.
 * Member lines live between the "SCORE BREAKDOWN" header and the
 * "FINDINGS & WARNINGS" header, indented and prefixed with "N. ". Each line is
 * `      N. <locator>   —  <impact>` (the impact suffix is optional), so we strip
 * the leading index and split off the optional impact suffix on its exact
 * "   —  " delimiter (distinct from the locator's "  ·  " separator).
 */
function readTextLocators(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === "SCORE BREAKDOWN");
  expect(start, "text export should contain a SCORE BREAKDOWN section").toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && /^FINDINGS & WARNINGS/.test(l));
  const region = lines.slice(start, end === -1 ? undefined : end);
  return region
    .filter((l) => /^\s+\d+\.\s/.test(l))
    .map((l) => l.replace(/^\s*\d+\.\s+/, "").split("   —  ")[0]);
}

/**
 * Pull each Score Breakdown locator out of the printable HTML export — the
 * `.mono` span inside every `.waterfall-finding-row`.
 */
function readHtmlLocators(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return Array.from(
    doc.querySelectorAll<HTMLElement>(".waterfall-finding-row .mono"),
  ).map((el) => el.textContent!.trim());
}

describe("Privacy report — per-finding locator parity across text and HTML exports", () => {
  it("renders the same locator string for each finding in both exports", () => {
    const text = readTextLocators(buildPrivacyTextReport(mockResult as never, SCOPE, "fixed"));
    const html = readHtmlLocators(buildPrintableReport(mockResult as never, SCOPE));

    // Both exporters produced one locator per finding, in the same order.
    expect(text).toHaveLength(orderedFindings.length);
    expect(html).toHaveLength(orderedFindings.length);

    // Each surface matches the single source of truth (formatFindingLocator) and,
    // by extension, each other — so the two exporters cannot drift.
    orderedFindings.forEach((f, i) => {
      const canonical = formatFindingLocator(f as never);
      expect(text[i]).toBe(canonical);
      expect(html[i]).toBe(canonical);
    });

    // Cross-check text against HTML directly too.
    expect(text).toEqual(html);
  });

  it("shares the (+N more) suffix, the single-item, and the '—' fallback cases", () => {
    const text = readTextLocators(buildPrivacyTextReport(mockResult as never, SCOPE, "fixed"));
    const html = readHtmlLocators(buildPrintableReport(mockResult as never, SCOPE));

    // 0. ADDRESS_REUSE: multiple addresses AND multiple txids → "(+N more)" on both.
    const expected0 = `addr ${ADDRS[0]} (+2 more)  ·  tx ${TXIDS[0]} (+1 more)`;
    expect(text[0]).toBe(expected0);
    expect(html[0]).toBe(expected0);

    // 1. DUST: a single address only — no "(+N more)" suffix, no tx segment.
    const expected1 = `addr ${ADDRS[0]}`;
    expect(text[1]).toBe(expected1);
    expect(html[1]).toBe(expected1);

    // 2. ROUND_AMOUNT: multiple txids only — "(+N more)" on tx, no addr segment.
    const expected2 = `tx ${TXIDS[0]} (+1 more)`;
    expect(text[2]).toBe(expected2);
    expect(html[2]).toBe(expected2);

    // 3. HIGH_ACTIVITY: neither address nor txid — the "—" fallback.
    expect(text[3]).toBe("—");
    expect(html[3]).toBe("—");
  });
});

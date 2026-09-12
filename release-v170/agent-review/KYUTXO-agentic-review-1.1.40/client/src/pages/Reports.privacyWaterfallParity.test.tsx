// @vitest-environment jsdom
//
// Parity coverage for the Privacy Audit "Score Breakdown" waterfall. The same
// breakdown is rendered in four places and must never drift apart:
//   - the in-app report panel (PrivacyAuditReportPanel in Reports.tsx),
//   - the JSON export (buildPrivacyReport),
//   - the Print/PDF HTML export (buildPrintableReport), and
//   - the plain-text export (buildPrivacyTextReport).
//
// This test renders the real panel and, for each waterfall row, asserts that the
// displayed Category/Count/Delta/Score matches what each exporter produces for
// the SAME audit result. The exporters are left REAL so the comparison is
// against production output; only the data-fetching chain (owners/wallets hooks,
// the address page query, toast) and runPrivacyAudit are stubbed.
//
// The fixture deliberately exercises the formatting edge cases shared across all
// surfaces: a zero count and a zero delta both render as "—", a positive delta
// shows a leading "+", and large counts are grouped via toLocaleString.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";

import {
  buildPrivacyReport,
  buildPrivacyTextReport,
  formatFindingLocator,
  formatScoreDelta,
  type ExportScope,
} from "@/lib/privacy-report-export";
import { buildPrintableReport } from "@/lib/privacy-report-html";
import type { PrivacyFinding } from "@/lib/privacy-audit";

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

// Waterfall fixture covering every shared formatting branch:
//   - Base Score:    count 0  + delta 0   → "—" / "—"
//   - Address Reuse: count 1  + delta -12  → "1" / "-12"
//   - Dust:          count 0  + delta 0   → "—" / "—" (non-base, zero both)
//   - Round Amounts: count 1234 + delta +5 → "1,234" / "+5" (grouping + plus)
const mockResult = {
  findings: [],
  warnings: [],
  transactionsAnalyzed: 5,
  addressesScanned: 3,
  isClean: false,
  score: 81,
  grade: "B",
  scoreWaterfall: [
    { label: "Base Score", findingType: "BASE", delta: 0, runningScore: 100, count: 0 },
    { label: "Address Reuse", findingType: "ADDRESS_REUSE", delta: -12, runningScore: 88, count: 1 },
    { label: "Dust", findingType: "DUST", delta: 0, runningScore: 88, count: 0 },
    { label: "Round Amounts", findingType: "ROUND_AMOUNT", delta: 5, runningScore: 93, count: 1234 },
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

// The in-app panel defaults to the All / All scope; the exporters are invoked
// with the matching scope so every surface describes the same audit.
const SCOPE: ExportScope = { owner: null, wallet: null };

interface WaterfallRow {
  category: string;
  count: string;
  delta: string;
  score: string;
}

/** Expected displayed strings derived from the raw JSON waterfall entries. */
function expectedRowsFromJson(): WaterfallRow[] {
  return buildPrivacyReport(mockResult as never, SCOPE).scoreWaterfall.map((e) => ({
    category: e.label,
    count: e.count > 0 ? e.count.toLocaleString() : "—",
    delta: e.delta === 0 ? "—" : `${e.delta > 0 ? "+" : ""}${e.delta}`,
    score: String(e.runningScore),
  }));
}

/** Pull the four waterfall cells out of each rendered in-app table row. */
function readInAppRows(container: HTMLElement): WaterfallRow[] {
  const card = container.querySelector('[data-testid="card-privacy-report-waterfall"]')!;
  const rows = Array.from(
    card.querySelectorAll<HTMLElement>('[data-testid^="row-privacy-waterfall-"]'),
  );
  return rows.map((tr) => {
    const cells = Array.from(tr.querySelectorAll("td"));
    // The category cell also hosts the same-type finding navigator (chevrons +
    // an "n / total" badge) for entries with more than one finding, so read the
    // label from its dedicated span rather than the whole cell's textContent.
    const labelSpan = cells[0].querySelector("span");
    return {
      category: (labelSpan?.textContent ?? cells[0].textContent!).trim(),
      count: cells[1].textContent!.trim(),
      delta: cells[2].textContent!.trim(),
      score: cells[3].textContent!.trim(),
    };
  });
}

/** Parse the aggregated waterfall category rows out of the printable HTML export.
 * The per-finding enumeration rows (`.waterfall-finding-row`) are excluded so
 * this reads one row per category, matching the in-app and JSON surfaces. */
function readHtmlRows(html: string): WaterfallRow[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const rows = Array.from(
    doc.querySelectorAll<HTMLElement>(
      ".waterfall-table tbody tr:not(.waterfall-finding-row)",
    ),
  );
  return rows.map((tr) => {
    const cells = Array.from(tr.querySelectorAll("td"));
    return {
      category: cells[0].textContent!.trim(),
      count: cells[1].textContent!.trim(),
      delta: cells[2].textContent!.trim(),
      score: cells[3].textContent!.trim(),
    };
  });
}

/** Parse the "SCORE BREAKDOWN" block out of the plain-text export. */
function readTextRows(text: string): WaterfallRow[] {
  const lines = text.split("\n");
  const start = lines.indexOf("SCORE BREAKDOWN");
  expect(start).toBeGreaterThanOrEqual(0);
  const rows: WaterfallRow[] = [];
  // The block is: a "----" separator, then per category a (label line, stats
  // line) pair optionally followed by indented per-finding enumeration lines
  // ("      1. addr … — -N pts"), ending at the blank line before the next
  // section. A category label line is a stats line's predecessor; the enumerated
  // finding lines are skipped here (they're covered by the per-surface tests).
  const isFindingLine = (s: string) => /^\s+\d+\.\s/.test(s);
  for (let i = start + 2; i < lines.length; i++) {
    const labelLine = lines[i];
    if (labelLine.trim() === "") break;
    if (isFindingLine(labelLine)) continue; // skip per-finding enumeration lines
    const statsLine = lines[i + 1] ?? "";
    const m = statsLine.match(/Count:\s*(.+?)\s*·\s*Delta:\s*(.+?)\s*·\s*Score:\s*(.+)/);
    expect(m).not.toBeNull();
    rows.push({
      category: labelLine.trim(),
      count: m![1].trim(),
      delta: m![2].trim(),
      score: m![3].trim(),
    });
    i++; // consumed the stats line too
  }
  return rows;
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
  await waitFor(() => utils.getByTestId("card-privacy-report-waterfall"));
  return utils;
}

describe("PrivacyAuditReportPanel — Score Breakdown parity across surfaces", () => {
  it("in-app waterfall rows match the JSON, HTML, and text exports cell-for-cell", async () => {
    const { container } = await renderWithResult();

    const expected = expectedRowsFromJson();
    const inApp = readInAppRows(container);
    const html = readHtmlRows(buildPrintableReport(mockResult as never, SCOPE));
    const text = readTextRows(buildPrivacyTextReport(mockResult as never, SCOPE, "fixed"));

    // Every surface produced one row per waterfall entry.
    expect(expected).toHaveLength(mockResult.scoreWaterfall.length);
    expect(inApp).toHaveLength(expected.length);
    expect(html).toHaveLength(expected.length);
    expect(text).toHaveLength(expected.length);

    // The in-app render is the source of truth users see; assert it equals the
    // JSON-derived values and that both export renderings match it exactly.
    expect(inApp).toEqual(expected);
    expect(html).toEqual(expected);
    expect(text).toEqual(expected);
  });

  it("shares the zero-count, zero-delta, and positive-delta formatting edge cases", async () => {
    const { container } = await renderWithResult();
    const inApp = readInAppRows(container);
    const html = readHtmlRows(buildPrintableReport(mockResult as never, SCOPE));
    const text = readTextRows(buildPrivacyTextReport(mockResult as never, SCOPE, "fixed"));

    // Base Score: zero count and zero delta both collapse to an em dash.
    for (const rows of [inApp, html, text]) {
      expect(rows[0]).toMatchObject({ category: "Base Score", count: "—", delta: "—" });
      // Dust: a NON-base entry with zero count and zero delta also shows "—".
      expect(rows[2]).toMatchObject({ category: "Dust", count: "—", delta: "—" });
      // Round Amounts: positive delta carries a leading "+", count is grouped.
      expect(rows[3]).toMatchObject({
        category: "Round Amounts",
        count: "1,234",
        delta: "+5",
      });
      // Address Reuse: a plain negative delta with a single count.
      expect(rows[1]).toMatchObject({
        category: "Address Reuse",
        count: "1",
        delta: "-12",
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Per-finding (same-type) sub-row parity.
//
// The category-level parity above uses a fixture with empty findings/warnings,
// so it never exercises the individual same-type findings enumerated UNDER each
// aggregated category (the address/tx locator + per-finding score impact added
// to all three exports). This block uses a fixture with real findings so those
// nested sub-rows are actually compared across the text, HTML/PDF, and JSON
// surfaces. It fails if any one surface drops, reorders, or reformats a finding
// relative to the others.
// ---------------------------------------------------------------------------

// The em-dash impact separator used by the plain-text export's finding lines:
// three spaces, an em dash, two spaces (matches buildPrivacyTextReport).
const TEXT_IMPACT_SEP = "   —  ";

function mkFinding(partial: Partial<PrivacyFinding>): PrivacyFinding {
  return {
    type: "ADDRESS_REUSE",
    severity: "MEDIUM",
    description: "desc",
    details: {},
    correction: "fix",
    txids: [],
    addresses: [],
    ...partial,
  };
}

// Two aggregated categories, each with multiple same-type findings carrying
// BOTH addresses and txids, mixing every per-finding format branch:
//   - multiple addresses/txids   → "(+N more)" suffixes in the locator
//   - a sub-1-point penalty      → "<-1 pts" impact
//   - a finding with no penalty  → "—" impact
//   - findings AND warnings of the same type → exercises the findings-first
//     ordering shared by findingsOfType across all surfaces.
const reuseA = mkFinding({
  type: "ADDRESS_REUSE",
  addresses: ["bc1qaddr1a", "bc1qaddr1b"],
  txids: ["txid1"],
  scoreDelta: -8,
});
const reuseB = mkFinding({
  type: "ADDRESS_REUSE",
  addresses: ["bc1qaddr2"],
  txids: ["txid2a", "txid2b", "txid2c"],
  scoreDelta: -0.5,
});
const reuseWarn = mkFinding({
  type: "ADDRESS_REUSE",
  severity: "LOW",
  addresses: ["bc1qaddr3"],
  txids: ["txid3"],
  // no scoreDelta → no penalty → "—" impact everywhere
});
const roundA = mkFinding({
  type: "ROUND_AMOUNT",
  addresses: ["bc1qround1"],
  txids: ["txidR1"],
  scoreDelta: -3,
});
const roundWarn = mkFinding({
  type: "ROUND_AMOUNT",
  severity: "LOW",
  addresses: ["bc1qround2"],
  txids: ["txidR2a", "txidR2b"],
  scoreDelta: -2,
});

const findingsResult = {
  findings: [reuseA, reuseB, roundA],
  warnings: [reuseWarn, roundWarn],
  transactionsAnalyzed: 9,
  addressesScanned: 6,
  isClean: false,
  score: 85,
  grade: "B",
  scoreWaterfall: [
    { label: "Base Score", findingType: "BASE", delta: 0, runningScore: 100, count: 0 },
    { label: "Address Reuse", findingType: "ADDRESS_REUSE", delta: -10, runningScore: 90, count: 3 },
    { label: "Round Amount", findingType: "ROUND_AMOUNT", delta: -5, runningScore: 85, count: 2 },
  ],
  needsResync: false,
  fingerprintCoverage: 1,
};

/** A per-finding sub-row flattened into `category :: locator :: impact`, in the
 * exact category/finding order each surface emits. Used to compare surfaces for
 * any dropped, reordered, or reformatted finding. */
type FindingRow = string;

/** Derive the per-finding rows from the JSON export. The JSON carries the raw
 * per-finding fields (addresses/txids/scoreDelta), so the locator/impact are
 * reconstructed with the SAME shared helpers the text/HTML exports use. */
function findingRowsFromJson(): FindingRow[] {
  const report = buildPrivacyReport(findingsResult as never, SCOPE);
  const out: FindingRow[] = [];
  for (const entry of report.scoreWaterfall) {
    for (const f of entry.findings) {
      const locator = formatFindingLocator(f as unknown as PrivacyFinding);
      const impact = formatScoreDelta(f.scoreDelta) ?? "—";
      out.push(`${entry.label} :: ${locator} :: ${impact}`);
    }
  }
  return out;
}

/** Parse the per-finding enumeration lines out of the plain-text export. */
function findingRowsFromText(text: string): FindingRow[] {
  const lines = text.split("\n");
  const start = lines.indexOf("SCORE BREAKDOWN");
  expect(start).toBeGreaterThanOrEqual(0);
  const out: FindingRow[] = [];
  let category = "";
  for (let i = start + 2; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") break;
    if (/^\s+\d+\.\s/.test(line)) {
      const rest = line.replace(/^\s+\d+\.\s/, "");
      const parts = rest.split(TEXT_IMPACT_SEP);
      const locator = parts[0];
      const impact = parts.length > 1 ? parts[1] : "—";
      out.push(`${category} :: ${locator} :: ${impact}`);
    } else if (/Count:/.test(line)) {
      // stats line — skip
    } else {
      category = line.trim();
    }
  }
  return out;
}

/** Parse the per-finding `.waterfall-finding-row` rows out of the HTML export. */
function findingRowsFromHtml(html: string): FindingRow[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const rows = Array.from(
    doc.querySelectorAll<HTMLElement>(".waterfall-table tbody tr"),
  );
  const out: FindingRow[] = [];
  let category = "";
  for (const tr of rows) {
    if (tr.classList.contains("waterfall-finding-row")) {
      const locator = tr.querySelector(".mono")!.textContent!.trim();
      const impact = tr.querySelector(".wf-finding-impact")!.textContent!.trim();
      out.push(`${category} :: ${locator} :: ${impact}`);
    } else {
      const cells = Array.from(tr.querySelectorAll("td"));
      category = cells[0].textContent!.trim();
    }
  }
  return out;
}

describe("Privacy Audit — per-finding sub-row parity across surfaces", () => {
  it("enumerates the same locators and score impacts, in the same order, on every surface", () => {
    const json = findingRowsFromJson();
    const text = findingRowsFromText(
      buildPrivacyTextReport(findingsResult as never, SCOPE, "fixed"),
    );
    const html = findingRowsFromHtml(
      buildPrintableReport(findingsResult as never, SCOPE),
    );

    // The fixture must actually exercise nested sub-rows (otherwise this test
    // would pass vacuously, the very gap it exists to close): more than one
    // category with findings, and at least one category with multiple findings.
    const expected: FindingRow[] = [
      "Address Reuse :: addr bc1qaddr1a (+1 more)  ·  tx txid1 :: -8 pts",
      "Address Reuse :: addr bc1qaddr2  ·  tx txid2a (+2 more) :: <-1 pts",
      "Address Reuse :: addr bc1qaddr3  ·  tx txid3 :: —",
      "Round Amount :: addr bc1qround1  ·  tx txidR1 :: -3 pts",
      "Round Amount :: addr bc1qround2  ·  tx txidR2a (+1 more) :: -2 pts",
    ];
    expect(json).toEqual(expected);

    // Parity: every surface must produce the identical ordered list. Any drop,
    // reorder, or reformat on one surface breaks equality with the others.
    expect(text).toEqual(json);
    expect(html).toEqual(json);
  });
});

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
    return {
      category: cells[0].textContent!.trim(),
      count: cells[1].textContent!.trim(),
      delta: cells[2].textContent!.trim(),
      score: cells[3].textContent!.trim(),
    };
  });
}

/** Parse the waterfall table rows out of the printable HTML export. */
function readHtmlRows(html: string): WaterfallRow[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const rows = Array.from(
    doc.querySelectorAll<HTMLElement>(".waterfall-table tbody tr"),
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
  // The block is: a "----" separator, then pairs of (label line, stats line),
  // ending at the blank line before the next section.
  for (let i = start + 2; i < lines.length; i++) {
    const labelLine = lines[i];
    if (labelLine.trim() === "") break;
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

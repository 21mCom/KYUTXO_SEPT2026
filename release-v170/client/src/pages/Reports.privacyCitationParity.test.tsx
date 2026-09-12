// @vitest-environment jsdom
//
// Parity coverage for ENTITY_* source citations across THREE surfaces:
//   - the in-app report panel (PrivacyAuditReportPanel in Reports.tsx),
//   - the Print/PDF HTML export (buildPrintableReport renderCitations), and
//   - the plain-text export (buildPrivacyTextReport "Source Citations:" block).
//
// Task #671 added export-only parity (HTML vs. text) in
// lib/__tests__/privacy-report-citation-parity.test.ts. This test extends that
// guarantee to the on-screen rows the user actually sees: it renders the REAL
// panel with an ENTITY_* finding and asserts the displayed citation rows
// (name/category/address/source) match what both exporters emit for the SAME
// finding. Only the data-fetching chain (owners/wallets hooks, the address page
// query, toast) and runPrivacyAudit are stubbed; the exporters and the panel's
// citation rendering are left REAL so the comparison is against production output.
//
// The fixture deliberately covers both branches: a citation WITH a sourceNote
// (whose note embeds a URL — passed through as plain text, never linked) and one
// WITHOUT a sourceNote (the missing-source branch: "—" on the visual surfaces,
// an omitted line in the text export).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";

import { buildPrivacyTextReport, type ExportScope } from "@/lib/privacy-report-export";
import { buildPrintableReport } from "@/lib/privacy-report-html";
import type { PrivacyAuditResult, PrivacyFinding } from "@/lib/privacy-audit";

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

// One ENTITY_* finding carrying two citations:
//   - the first has a sourceNote that embeds a URL,
//   - the second has NO sourceNote (the "—" / omitted-Source branch).
const ENTITY_FINDING: PrivacyFinding = {
  type: "ENTITY_SCAM",
  severity: "CRITICAL",
  description: "A transaction interacts with known counterparties.",
  correction: "Avoid reusing funds linked to these counterparties.",
  txids: ["tx_scam"],
  addresses: ["134r8iHv69xdT6p5qVKTsHrcUEuBVZAYak"],
  scoreDelta: -28,
  details: {
    citations: [
      {
        name: "Lazarus Group (DPRK, OFAC-sanctioned)",
        address: "134r8iHv69xdT6p5qVKTsHrcUEuBVZAYak",
        categoryLabel: "Scam / Fraud",
        sourceNote:
          "OFAC / US Treasury — https://www.treasury.gov/resource-center/sanctions",
      },
      {
        name: "WalletExplorer cluster (no public source note)",
        address: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
        categoryLabel: "Exchange",
        // No sourceNote on purpose — exercises the missing-source branch.
      },
    ],
  },
} as unknown as PrivacyFinding;

const mockResult: PrivacyAuditResult = {
  findings: [ENTITY_FINDING],
  warnings: [],
  transactionsAnalyzed: 10,
  addressesScanned: 5,
  isClean: false,
  score: 72,
  grade: "C+",
  scoreWaterfall: [],
  needsResync: false,
  fingerprintCoverage: 1,
} as PrivacyAuditResult;

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
const FIXED_NOW = new Date("2026-06-26T12:00:00Z");
const FIXED_TEXT_NOW = "Jun 26, 2026, 12:00:00 PM";

interface CitationRow {
  name: string;
  category: string;
  address: string;
  // null means the surface emitted no source value at all (text omits the line);
  // the em-dash placeholder (visual surfaces) is normalised to null too so all
  // three surfaces compare equal.
  source: string | null;
}

/** Pull the citation rows out of the in-app panel's rendered table. */
function readInAppCitations(container: HTMLElement): CitationRow[] {
  const rows = Array.from(
    container.querySelectorAll<HTMLElement>('[data-testid^="row-privacy-citation-"]'),
  );
  return rows.map((tr) => {
    const cells = Array.from(tr.querySelectorAll("td"));
    const source = cells[3].textContent!.trim();
    return {
      name: cells[0].textContent!.trim(),
      category: cells[1].textContent!.trim(),
      address: cells[2].textContent!.trim(),
      source: source === "—" ? null : source,
    };
  });
}

/** Pull citation rows out of the printable HTML export's citations table. */
function readHtmlCitations(html: string): CitationRow[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const rows = Array.from(
    doc.querySelectorAll<HTMLElement>(".citations-table tbody tr"),
  );
  return rows.map((tr) => {
    const cells = Array.from(tr.querySelectorAll("td"));
    const source = cells[3].textContent!.trim();
    return {
      name: cells[0].textContent!.trim(),
      category: cells[1].textContent!.trim(),
      address: cells[2].textContent!.trim(),
      source: source === "—" ? null : source,
    };
  });
}

/** Parse the "Source Citations:" block out of the plain-text export. */
function readTextCitations(text: string): CitationRow[] {
  const lines = text.split("\n");
  const start = lines.indexOf("   Source Citations:");
  expect(start).toBeGreaterThanOrEqual(0);
  const rows: CitationRow[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    const head = line.match(/^ {5}- (.+) \((.+)\)$/);
    if (!head) {
      if (line.trim() === "") break;
      continue;
    }
    const addressLine = lines[i + 1] ?? "";
    const addrMatch = addressLine.match(/^ {7}Address: (.+)$/);
    expect(addrMatch).not.toBeNull();
    const maybeSourceLine = lines[i + 2] ?? "";
    const sourceMatch = maybeSourceLine.match(/^ {7}Source: (.+)$/);
    rows.push({
      name: head[1],
      category: head[2],
      address: addrMatch![1],
      source: sourceMatch ? sourceMatch[1] : null,
    });
    i += sourceMatch ? 2 : 1;
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
  await waitFor(() => utils.getByTestId("container-privacy-report-findings"));
  return utils;
}

describe("PrivacyAuditReportPanel — ENTITY_* citation parity (on-screen vs. downloads)", () => {
  it("on-screen citation rows match the HTML and text exports cell-for-cell", async () => {
    const { container } = await renderWithResult();

    const inApp = readInAppCitations(container);
    const html = readHtmlCitations(buildPrintableReport(mockResult, SCOPE, FIXED_NOW));
    const text = readTextCitations(
      buildPrivacyTextReport(mockResult, SCOPE, FIXED_TEXT_NOW),
    );

    // Every surface produced one row per citation in the finding.
    expect(inApp).toHaveLength(2);
    expect(html).toHaveLength(2);
    expect(text).toHaveLength(2);

    // The on-screen render is the source of truth users see; assert it equals
    // both downloads exactly.
    expect(inApp).toEqual(html);
    expect(inApp).toEqual(text);

    // And the on-screen rows match the citations exactly as authored.
    expect(inApp).toEqual([
      {
        name: "Lazarus Group (DPRK, OFAC-sanctioned)",
        category: "Scam / Fraud",
        address: "134r8iHv69xdT6p5qVKTsHrcUEuBVZAYak",
        source:
          "OFAC / US Treasury — https://www.treasury.gov/resource-center/sanctions",
      },
      {
        name: "WalletExplorer cluster (no public source note)",
        category: "Exchange",
        address: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
        source: null,
      },
    ]);
  });

  it("represents a missing sourceNote as an em dash on screen and an omitted text line", async () => {
    const { container } = await renderWithResult();

    const inApp = readInAppCitations(container);
    // The second citation has no sourceNote: the on-screen cell is the em-dash
    // placeholder (normalised to null) — matching the HTML export.
    expect(inApp[1].source).toBeNull();
    const citationCells = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid^="row-privacy-citation-"] td',
      ),
    );
    expect(citationCells.some((td) => td.textContent!.trim() === "—")).toBe(true);

    // The text export emits exactly one "Source:" line — only the cited entity
    // with a sourceNote gets one.
    const textStr = buildPrivacyTextReport(mockResult, SCOPE, FIXED_TEXT_NOW);
    expect(textStr.match(/^ {7}Source: /gm) ?? []).toHaveLength(1);
  });

  it("passes a citation sourceNote URL through as plain text on screen (never fetched)", async () => {
    const { container } = await renderWithResult();
    const url = "https://www.treasury.gov/resource-center/sanctions";

    // The URL is visible verbatim in the on-screen citation row.
    const sourceCell = container.querySelector<HTMLElement>(
      '[data-testid="row-privacy-citation-0-0"] td:nth-child(4)',
    );
    expect(sourceCell).not.toBeNull();
    expect(sourceCell!.textContent).toContain(url);

    // renderSourceNote turns the URL into an anchor that only opens on an
    // explicit click — it carries no href that a crawler/preview could fetch.
    const anchor = sourceCell!.querySelector("a");
    expect(anchor).not.toBeNull();
    expect(anchor!.getAttribute("href")).toBe(url);
    // The same URL appears verbatim in both downloads too.
    expect(buildPrintableReport(mockResult, SCOPE, FIXED_NOW)).toContain(url);
    expect(buildPrivacyTextReport(mockResult, SCOPE, FIXED_TEXT_NOW)).toContain(url);
  });
});

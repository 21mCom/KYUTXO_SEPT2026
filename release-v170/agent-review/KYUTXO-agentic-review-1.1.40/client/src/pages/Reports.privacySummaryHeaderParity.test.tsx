// @vitest-environment jsdom
//
// Parity coverage for the *report header summary block* — the four top-of-report
// stats (Grade, Score /100, Transactions Analyzed, Addresses Scanned). This is
// distinct from Reports.privacySeverityCountParity.test.tsx (the issues-by-
// severity count rollup) and the per-finding label/score-impact parity tests.
//
// Each report surface builds this header independently and could silently drift
// apart — either in the formatting (e.g. dropping `toLocaleString()` thousands
// separators) or in which value maps to which label:
//   - the in-app panel (PrivacyAuditReportPanel in Reports.tsx, the
//     container-privacy-report-summary grid: text-privacy-report-grade/-score/
//     -txs/-addrs),
//   - the Print/PDF HTML export (.summary-box boxes in buildPrintableReport),
//     and
//   - the plain-text export ("Grade:/Score:/Transactions Analyzed:/Addresses
//     Scanned:" lines in buildPrivacyTextReport).
//
// All three must show the same grade, the same "<score>/100", and the same
// thousands-separated tx/address counts. The exporters are left REAL so the
// comparison is against production output; only the data-fetching chain and
// runPrivacyAudit are stubbed. The fixture uses large counts (12,345 txs /
// 67,890 addresses) so any `toLocaleString()` drift surfaces here.

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

function makeResult(overrides: Record<string, unknown>) {
  return {
    findings: [],
    warnings: [],
    warningsList: [],
    transactionsAnalyzed: 12345,
    addressesScanned: 67890,
    isClean: false,
    score: 64,
    grade: "D",
    scoreWaterfall: [],
    needsResync: false,
    fingerprintCoverage: 1,
    ...overrides,
  };
}

// Large counts so a dropped `toLocaleString()` (12345 vs "12,345") is caught.
const largeCountResult = makeResult({});

const mockResultRef: { current: ReturnType<typeof makeResult> } = { current: largeCountResult };

vi.mock("@/lib/privacy-audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/privacy-audit")>();
  return {
    ...actual,
    runPrivacyAudit: vi.fn(async () => mockResultRef.current),
  };
});

const { PrivacyAuditReportPanel } = await import("./Reports");

const SCOPE: ExportScope = { owner: null, wallet: null };

type HeaderSummary = {
  grade: string;
  score: string;
  txs: string;
  addrs: string;
};

/**
 * The canonical header the way every surface is supposed to render it: raw
 * grade, "<score>/100", and thousands-separated tx/address counts. This is the
 * source of truth the three surfaces are compared against.
 */
function canonicalHeader(result: ReturnType<typeof makeResult>): HeaderSummary {
  return {
    grade: result.grade,
    score: `${result.score}/100`,
    txs: result.transactionsAnalyzed.toLocaleString(),
    addrs: result.addressesScanned.toLocaleString(),
  };
}

/** Read the in-app summary grid (container-privacy-report-summary). */
function readInAppHeader(container: HTMLElement): HeaderSummary {
  const txt = (testid: string) => {
    const el = container.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
    expect(el, `missing ${testid}`).not.toBeNull();
    return el!.textContent!.trim();
  };
  return {
    grade: txt("text-privacy-report-grade"),
    score: txt("text-privacy-report-score"),
    txs: txt("text-privacy-report-txs"),
    addrs: txt("text-privacy-report-addrs"),
  };
}

/** Read the HTML export's `.summary-box` boxes (label → value). */
function readHtmlHeader(html: string): HeaderSummary {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const boxes = Array.from(doc.querySelectorAll<HTMLElement>(".summary-box"));
  const byLabel = new Map<string, string>();
  for (const box of boxes) {
    const label = box.querySelector<HTMLElement>(".label")?.textContent?.trim() ?? "";
    const value = box.querySelector<HTMLElement>(".value")?.textContent?.trim() ?? "";
    byLabel.set(label, value);
  }
  return {
    grade: byLabel.get("Grade") ?? "",
    score: byLabel.get("Score") ?? "",
    txs: byLabel.get("Txs Analyzed") ?? "",
    addrs: byLabel.get("Addresses") ?? "",
  };
}

/** Read the text export's "Grade:/Score:/Transactions Analyzed:/..." lines. */
function readTextHeader(text: string): HeaderSummary {
  const lines = text.split("\n");
  const grab = (prefix: string) => {
    const line = lines.find((l) => l.startsWith(prefix));
    expect(line, `text export should have a "${prefix}" line`).toBeDefined();
    return line!.slice(prefix.length).trim();
  };
  return {
    grade: grab("Grade:"),
    score: grab("Score:"),
    txs: grab("Transactions Analyzed:"),
    addrs: grab("Addresses Scanned:"),
  };
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderWithResult(result: ReturnType<typeof makeResult>) {
  mockResultRef.current = result;
  const utils = render(<PrivacyAuditReportPanel />);
  fireEvent.click(utils.getByTestId("button-generate-privacy-report"));
  await waitFor(() => utils.getByTestId("container-privacy-report-summary"));
  return utils;
}

describe("PrivacyAuditReportPanel — report header summary parity across surfaces", () => {
  it("renders identical grade/score/tx/address header values (with thousands separators) on every surface", async () => {
    const { container } = await renderWithResult(largeCountResult);

    const canonical = canonicalHeader(largeCountResult);
    // Sanity-check the fixture: large counts must be thousands-separated, and
    // score must carry its "/100" suffix.
    expect(canonical).toEqual({
      grade: "D",
      score: "64/100",
      txs: "12,345",
      addrs: "67,890",
    });

    const inApp = readInAppHeader(container);
    const html = readHtmlHeader(buildPrintableReport(largeCountResult as never, SCOPE));
    const text = readTextHeader(buildPrivacyTextReport(largeCountResult as never, SCOPE, "fixed"));

    // Every surface matches the canonical header — same grade, same "<score>/100",
    // same thousands-separated tx/address counts.
    expect(inApp).toEqual(canonical);
    expect(html).toEqual(canonical);
    expect(text).toEqual(canonical);
  });
});

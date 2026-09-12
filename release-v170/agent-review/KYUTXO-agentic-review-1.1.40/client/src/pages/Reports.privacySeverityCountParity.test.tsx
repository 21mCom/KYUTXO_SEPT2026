// @vitest-environment jsdom
//
// Parity coverage for the aggregated *issues-by-severity count* summary. This
// is distinct from Reports.privacyFindingSeverityParity.test.tsx, which guards
// each finding's individual severity *label*. Here we guard the per-severity
// *count* rollup that every report surface renders independently and could
// silently drift apart:
//   - the in-app panel (PrivacyAuditReportPanel in Reports.tsx, the "Issues:"
//     count Badges, badge-severity-count-*),
//   - the Print/PDF HTML export (.sev-chip "Issues:" chips in
//     buildPrintableReport), and
//   - the plain-text export ("SEVERITY BREAKDOWN" section in
//     buildPrivacyTextReport).
//
// All three build the same rollup: filter [...findings, ...warnings] over
// CRITICAL/HIGH/MEDIUM/LOW, drop zero-count severities, and keep that order.
// A change to the ordering, the zero-drop rule, or the count math on one
// surface must show up as a mismatch here. The exporters are left REAL so the
// comparison is against production output; only the data-fetching chain and
// runPrivacyAudit are stubbed.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";

import {
  buildPrivacyTextReport,
  severityLabel,
  type ExportScope,
} from "@/lib/privacy-report-export";
import { buildPrintableReport } from "@/lib/privacy-report-html";
import type { PrivacySeverity } from "@/lib/privacy-audit";

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

function makeFinding(overrides: Record<string, unknown>) {
  return {
    type: "ROUND_AMOUNT",
    severity: "MEDIUM",
    description: "desc",
    details: {},
    correction: "",
    txids: [],
    addresses: [],
    ...overrides,
  };
}

function makeResult(overrides: Record<string, unknown>) {
  return {
    findings: [],
    warnings: [],
    warningsList: [],
    transactionsAnalyzed: 5,
    addressesScanned: 3,
    isClean: false,
    score: 64,
    grade: "D",
    scoreWaterfall: [],
    needsResync: false,
    fingerprintCoverage: 1,
    ...overrides,
  };
}

// A mix of severities. CRITICAL=2, HIGH=0 (must be omitted everywhere),
// MEDIUM=3, LOW=1. Findings precede warnings; the LOW lives in warnings.
const mixedResult = makeResult({
  findings: [
    makeFinding({ type: "ADDRESS_REUSE", severity: "CRITICAL", scoreDelta: -20 }),
    makeFinding({ type: "ADDRESS_REUSE", severity: "CRITICAL", scoreDelta: -20 }),
    makeFinding({ type: "ROUND_AMOUNT", severity: "MEDIUM", scoreDelta: -5 }),
    makeFinding({ type: "ROUND_AMOUNT", severity: "MEDIUM", scoreDelta: -5 }),
    makeFinding({ type: "ROUND_AMOUNT", severity: "MEDIUM", scoreDelta: -5 }),
  ],
  warnings: [makeFinding({ type: "HIGH_ACTIVITY", severity: "LOW", scoreDelta: -1 })],
});

// No findings at all — the clean / no-findings case.
const cleanResult = makeResult({
  findings: [],
  warnings: [],
  isClean: true,
  score: 100,
  grade: "A",
});

// The mock reads the current fixture lazily (when the panel calls it), so each
// test can choose which result the panel renders before rendering. The name
// must start with `mock` to satisfy vitest's hoisted-factory rule.
const mockResultRef: { current: ReturnType<typeof makeResult> } = { current: cleanResult };

vi.mock("@/lib/privacy-audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/privacy-audit")>();
  return {
    ...actual,
    runPrivacyAudit: vi.fn(async () => mockResultRef.current),
  };
});

const { PrivacyAuditReportPanel } = await import("./Reports");

const SCOPE: ExportScope = { owner: null, wallet: null };
const SEVERITIES: PrivacySeverity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

type SeverityCount = { label: string; count: number };

/**
 * The canonical rollup straight from the fixture, derived the same way every
 * surface is supposed to: ordered CRITICAL→HIGH→MEDIUM→LOW, zero-count
 * severities dropped. This is the source of truth the three surfaces are
 * compared against.
 */
function canonicalCounts(result: ReturnType<typeof makeResult>): SeverityCount[] {
  const all = [...result.findings, ...result.warnings];
  return SEVERITIES.map((sev) => ({
    sev,
    count: all.filter((f) => f.severity === sev).length,
  }))
    .filter((x) => x.count > 0)
    .map((x) => ({ label: severityLabel(x.sev), count: x.count }));
}

/** Read the in-app "Issues:" count badges in CRITICAL→LOW order. */
function readInAppCounts(container: HTMLElement): SeverityCount[] {
  const out: SeverityCount[] = [];
  for (const sev of SEVERITIES) {
    const el = container.querySelector<HTMLElement>(
      `[data-testid="badge-severity-count-${sev}"]`,
    );
    if (!el) continue;
    const m = el.textContent!.trim().match(/^(\d+)\s+(.+)$/);
    expect(m, `badge "${el.textContent}" should read "<count> <label>"`).not.toBeNull();
    out.push({ count: Number(m![1]), label: m![2].trim() });
  }
  return out;
}

/**
 * Read the HTML export's `.sev-chip` "Issues:" chips. Returns the parsed
 * per-severity counts plus whether a standalone "Clean" chip was rendered.
 */
function readHtmlCounts(html: string): { entries: SeverityCount[]; clean: boolean } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const chips = Array.from(doc.querySelectorAll<HTMLElement>(".sev-chip"));
  const entries: SeverityCount[] = [];
  let clean = false;
  for (const chip of chips) {
    const text = chip.textContent!.trim();
    const m = text.match(/^(\d+)\s+(.+)$/);
    if (m) entries.push({ count: Number(m[1]), label: m[2].trim() });
    else if (text === "Clean") clean = true;
  }
  return { entries, clean };
}

/**
 * Read the text export's "SEVERITY BREAKDOWN" section. Returns the parsed
 * per-severity counts plus whether the "Clean — no privacy findings." line was
 * emitted.
 */
function readTextCounts(text: string): { entries: SeverityCount[]; clean: boolean } {
  const lines = text.split("\n");
  const start = lines.indexOf("SEVERITY BREAKDOWN");
  expect(start, "text export should have a SEVERITY BREAKDOWN section").toBeGreaterThan(-1);
  const entries: SeverityCount[] = [];
  let clean = false;
  // Skip the section heading and the sub separator beneath it; read until blank.
  for (let i = start + 2; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") break;
    if (line.includes("Clean — no privacy findings.")) {
      clean = true;
      continue;
    }
    const m = line.match(/^\s+(\w+):\s+(\d+)$/);
    if (m) entries.push({ label: m[1], count: Number(m[2]) });
  }
  return { entries, clean };
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

describe("PrivacyAuditReportPanel — issues-by-severity count summary parity across surfaces", () => {
  it("renders identical per-severity counts (and omits zero-count severities) on every surface", async () => {
    const { container } = await renderWithResult(mixedResult);

    const canonical = canonicalCounts(mixedResult);
    // Sanity-check the fixture: CRITICAL/MEDIUM/LOW present, HIGH dropped.
    expect(canonical).toEqual([
      { label: "Critical", count: 2 },
      { label: "Medium", count: 3 },
      { label: "Low", count: 1 },
    ]);

    const inApp = readInAppCounts(container);
    const html = readHtmlCounts(buildPrintableReport(mixedResult as never, SCOPE));
    const text = readTextCounts(buildPrivacyTextReport(mixedResult as never, SCOPE, "fixed"));

    // Every surface matches the canonical rollup — same labels, same counts,
    // same order, and the zero-count HIGH omitted everywhere.
    expect(inApp).toEqual(canonical);
    expect(html.entries).toEqual(canonical);
    expect(text.entries).toEqual(canonical);

    // No surface should treat a result with findings as "clean".
    expect(html.clean).toBe(false);
    expect(text.clean).toBe(false);

    // HIGH is the omitted severity: assert its absence explicitly on each surface.
    expect(container.querySelector('[data-testid="badge-severity-count-HIGH"]')).toBeNull();
    expect(html.entries.some((e) => e.label === "High")).toBe(false);
    expect(text.entries.some((e) => e.label === "High")).toBe(false);
  });

  it("shows no per-severity counts on any surface for a clean result", async () => {
    const { container } = await renderWithResult(cleanResult);

    expect(canonicalCounts(cleanResult)).toEqual([]);

    const inApp = readInAppCounts(container);
    const html = readHtmlCounts(buildPrintableReport(cleanResult as never, SCOPE));
    const text = readTextCounts(buildPrivacyTextReport(cleanResult as never, SCOPE, "fixed"));

    // No count badges/chips/lines on any surface...
    expect(inApp).toEqual([]);
    expect(html.entries).toEqual([]);
    expect(text.entries).toEqual([]);

    // ...and the HTML/text exports surface their dedicated clean indicator.
    expect(html.clean).toBe(true);
    expect(text.clean).toBe(true);
  });
});

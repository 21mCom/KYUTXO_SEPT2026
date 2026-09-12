// Regression guard for the date-bearing outputs of the Privacy Audit report
// exports. The Statement Report (#772/#816) and the Source of Funds report
// (#898, fund-trail-export.dates.test.ts) already pin the format of their
// date-bearing surfaces; the Privacy Audit exporters build the analogous
// strings with no test guarding them, so a locale/format swap, a raw epoch, or
// a full ISO-with-time string could silently regress any of:
//   - the plain-text report footer `Generated: ${new Date().toLocaleString()}`,
//   - the JSON report's `generatedAt` (a full ISO timestamp, on purpose),
//   - the printable/PDF HTML title `… — ${now.toISOString().slice(0,10)}` and
//     its subtitle `Generated ${now.toLocaleString()}`,
//   - the history CSV's per-row "Timestamp (ISO)" and locale "Date" columns,
//   - the history PDF's per-row locale Date column and `Generated:` footer, and
//   - the text-report download filename `…-${date.toISOString().slice(0,10)}.txt`.
//
// All live in pure exported functions (or take an injectable clock), so we test
// them directly. Where the surface reads `new Date()` with no injectable clock
// (the text footer's default, the history PDF footer) we freeze it with fake
// timers, and the PDF text is recovered from jspdf's content stream with the
// same minimal reader the sibling export tests use. Each assertion explicitly
// rejects the raw-epoch and wrong-format forms.

import { describe, it, expect, afterEach, vi } from "vitest";

import type { PrivacyAuditResult } from "@/lib/privacy-audit";
import type { PrivacyAuditHistoryEntry } from "@/lib/db-types";
import {
  buildPrivacyReport,
  buildPrivacyTextReport,
  privacyTextReportFilename,
  type ExportScope,
} from "./privacy-report-export";
import { buildPrintableReport } from "./privacy-report-html";
import { buildPrivacyHistoryCsv, buildPrivacyHistoryPdf } from "./privacy-history-export";

// 2023-11-14T22:13:20Z — a fixed ms epoch so locale/ISO renderings are
// deterministic within a single environment/timezone.
const TIMESTAMP = 1_700_000_000_000;

const SCOPE: ExportScope = { owner: null, wallet: null };

function result(): PrivacyAuditResult {
  return {
    findings: [],
    warnings: [],
    transactionsAnalyzed: 5,
    addressesScanned: 3,
    isClean: true,
    score: 100,
    grade: "A+",
    scoreWaterfall: [
      { label: "Base Score", findingType: "BASE", delta: 0, runningScore: 100, count: 0 },
    ],
    needsResync: false,
    fingerprintCoverage: 1,
  };
}

function historyEntry(): PrivacyAuditHistoryEntry {
  return {
    timestamp: TIMESTAMP,
    score: 88,
    grade: "B+",
    totalFindings: 1,
    transactionsAnalyzed: 5,
    addressesScanned: 3,
    severityCounts: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0 },
    findingTypeCounts: { ADDRESS_REUSE: 1 },
  };
}

// --- Minimal jspdf content-stream reader (mirrors fund-trail-export tests) ---
function unescapePdfLiteral(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) break;
    if (next >= "0" && next <= "7") {
      let oct = next;
      i++;
      for (let k = 0; k < 2; k++) {
        const d = raw[i + 1];
        if (d >= "0" && d <= "7") {
          oct += d;
          i++;
        } else {
          break;
        }
      }
      out += String.fromCharCode(parseInt(oct, 8));
    } else {
      const escapes: Record<string, string> = {
        n: "\n",
        r: "\r",
        t: "\t",
        b: "\b",
        f: "\f",
      };
      out += escapes[next] ?? next;
      i++;
    }
  }
  return out;
}

function decodePdfBytes(bytes: string): string {
  if (!bytes.includes("\u0000")) return bytes;
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1));
  }
  return out;
}

async function extractPdfText(blob: Blob): Promise<string> {
  const latin1 = Buffer.from(await blob.arrayBuffer()).toString("latin1");
  const literals = latin1.match(/\((?:[^()\\]|\\.)*\)/g) ?? [];
  return literals
    .map((lit) => decodePdfBytes(unescapePdfLiteral(lit.slice(1, -1))))
    .join("\n");
}

// Parse one RFC-4180 CSV line into its cells (handles quoted fields whose
// values contain commas — the locale Date column does).
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Privacy Audit report export date formatting", () => {
  it("stamps the text-report footer via toLocaleString(), not a raw epoch or ISO string", () => {
    // The default generatedAt reads `new Date()` with no injectable clock, so
    // freeze it and call the builder without the optional 3rd argument.
    const fixed = new Date("2026-06-27T15:30:45Z");
    vi.useFakeTimers();
    vi.setSystemTime(fixed);

    const expectedFooter = `Generated: ${new Date().toLocaleString()}`;

    const text = buildPrivacyTextReport(result(), SCOPE);
    const footer = text.split("\n").find((s) => s.startsWith("Generated:"));

    expect(footer).toBeDefined();
    expect(footer).toBe(expectedFooter);

    // Reject the regression forms: raw epoch (ms + seconds) and any ISO string.
    const fixedMs = fixed.getTime();
    expect(footer).not.toContain(String(fixedMs));
    expect(footer).not.toContain(String(Math.floor(fixedMs / 1000)));
    expect(footer).not.toContain(fixed.toISOString());
    expect(footer).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("stamps the JSON report's generatedAt as a full ISO timestamp, not a raw epoch or locale form", () => {
    const fixed = new Date("2026-06-27T15:30:45Z");
    vi.useFakeTimers();
    vi.setSystemTime(fixed);

    // generatedAt defaults to new Date().toISOString() — a full ISO timestamp.
    const report = buildPrivacyReport(result(), SCOPE);

    expect(report.generatedAt).toBe(fixed.toISOString());
    expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    // Reject the regression forms: a raw epoch (ms + seconds) and the slashed
    // locale rendering.
    const fixedMs = fixed.getTime();
    expect(report.generatedAt).not.toBe(String(fixedMs));
    expect(report.generatedAt).not.toBe(String(Math.floor(fixedMs / 1000)));
    expect(report.generatedAt).not.toContain("/");
    expect(report.generatedAt).not.toBe(fixed.toLocaleString());
  });

  it("stamps the printable HTML title as an ISO YYYY-MM-DD and the subtitle via toLocaleString()", () => {
    const fixed = new Date("2026-06-27T15:30:45Z");
    const expectedDate = fixed.toISOString().slice(0, 10);
    const expectedSubtitle = `Generated ${fixed.toLocaleString()}`;

    const html = buildPrintableReport(result(), SCOPE, fixed);

    // Title carries the ISO date stamp.
    expect(html).toContain(`Privacy Audit Report — ${expectedDate}`);
    // Subtitle carries the locale-formatted generated timestamp.
    expect(html).toContain(expectedSubtitle);

    // Reject the regression forms for the title's date stamp: raw epoch and a
    // full ISO string carrying the time portion.
    const fixedMs = fixed.getTime();
    expect(html).not.toContain(`Privacy Audit Report — ${fixedMs}`);
    expect(html).not.toContain(`Privacy Audit Report — ${fixed.toISOString()}`);
    expect(html).not.toMatch(/Privacy Audit Report — \d{4}-\d{2}-\d{2}T/);
  });

  it("stamps the text-report download filename with an ISO YYYY-MM-DD, not a raw epoch or locale form", () => {
    const fixed = new Date("2026-06-27T15:30:45Z");
    const expectedStamp = fixed.toISOString().slice(0, 10);

    const filename = privacyTextReportFilename(fixed);

    expect(filename).toBe(`privacy-audit-report-${expectedStamp}.txt`);
    expect(filename).toMatch(/^privacy-audit-report-\d{4}-\d{2}-\d{2}\.txt$/);

    // Reject the regression forms: raw epoch (ms + seconds), a full ISO string
    // with the time portion, and a slashed locale date.
    const fixedMs = fixed.getTime();
    expect(filename).not.toContain(String(fixedMs));
    expect(filename).not.toContain(String(Math.floor(fixedMs / 1000)));
    expect(filename).not.toContain("T");
    expect(filename).not.toContain(":");
    expect(filename).not.toContain("/");
    expect(filename).not.toContain(fixed.toLocaleDateString());
  });

  it("renders the history CSV per-row Timestamp (ISO) and locale Date columns, not raw epochs", () => {
    const csv = buildPrivacyHistoryCsv([historyEntry()]);

    // A single-scope export prepends a scope preamble line; the header row and
    // the one data row follow it.
    const lines = csv.split("\r\n");
    const headers = parseCsvLine(lines[lines.length - 2]);
    const cells = parseCsvLine(lines[lines.length - 1]);

    expect(headers[0]).toBe("Timestamp (ISO)");
    expect(headers[1]).toBe("Date");

    const expectedIso = new Date(TIMESTAMP).toISOString();
    const expectedLocale = new Date(TIMESTAMP).toLocaleString();

    // Column 0 is a full ISO timestamp; column 1 is the locale rendering.
    expect(cells[0]).toBe(expectedIso);
    expect(cells[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(cells[1]).toBe(expectedLocale);

    // Reject the regression forms: neither date column may be a raw epoch
    // (ms or seconds), and the two columns must not be identical (a locale →
    // ISO swap would collapse them).
    for (const cell of [cells[0], cells[1]]) {
      expect(cell).not.toBe(String(TIMESTAMP));
      expect(cell).not.toBe(String(Math.floor(TIMESTAMP / 1000)));
    }
    expect(cells[1]).not.toBe(expectedIso);
    expect(cells[1]).not.toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z?$/);
  });

  it("stamps the history PDF per-row Date column and footer via toLocaleString(), not a raw epoch", async () => {
    // The footer reads `new Date()` with no injectable clock, so freeze it.
    const fixed = new Date("2026-06-27T15:30:45Z");
    vi.useFakeTimers();
    vi.setSystemTime(fixed);

    const text = await extractPdfText(await buildPrivacyHistoryPdf([historyEntry()]));

    const expectedRowDate = new Date(TIMESTAMP).toLocaleString();
    const expectedFooter = `Generated: ${new Date().toLocaleString()}`;

    expect(text).toContain(expectedRowDate);
    expect(text).toContain(expectedFooter);

    // Reject the regression forms: the per-row date and footer must not surface
    // a raw epoch (ms or seconds) or an ISO timestamp.
    expect(text).not.toContain(String(TIMESTAMP));
    expect(text).not.toContain(String(Math.floor(TIMESTAMP / 1000)));
    expect(text).not.toContain(new Date(TIMESTAMP).toISOString());
    expect(text).not.toContain(fixed.toISOString());
  });
});

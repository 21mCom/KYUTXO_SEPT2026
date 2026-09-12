// Regression guard for the date-bearing outputs of the Source of Funds report
// (the Fund Trail export, built in fund-trail-export.ts). The sibling Statement
// Report pinned its date surfaces (StatementReport.exportDates / .pdfDates
// tests); the Fund Trail exporter builds the analogous strings and a locale or
// format swap, a raw epoch, or a full ISO-with-time string could silently
// regress any of them:
//   - the PDF footer stamp `Generated: ${new Date().toLocaleString()}`,
//   - the per-row Date column (CSV + detailed PDF), rendered as an ISO
//     `YYYY-MM-DD` via isoDate(blockTime), and
//   - the download filename's date stamp `...-${date.toISOString().slice(0,10)}`.
//
// All three live in pure exported functions, so we test them directly. `new
// Date()` (used by the footer, which takes no injectable clock) is frozen with
// fake timers, and the PDF text is recovered from jspdf's content stream with
// the same minimal reader the main export test uses. Each assertion explicitly
// rejects the raw-epoch and wrong-format forms.

import { describe, it, expect, afterEach, vi } from "vitest";

import type { GroupFlow, GroupFlowDetail, TrailHop } from "./fund-trail-engine";
import {
  buildFundTrailSnapshot,
  buildFundTrailCsv,
  buildFundTrailPdf,
  fundTrailFilename,
  flowPath,
} from "./fund-trail-export";

// 2023-11-14T22:13:20Z — fixed Unix seconds so the row date is deterministic.
const BLOCK_TIME = 1_700_000_000;

function detail(overrides: Partial<GroupFlowDetail> = {}): GroupFlowDetail {
  return {
    address: "bc1qsource",
    txid: "aaaa",
    amount: 100_000_000,
    blockTime: BLOCK_TIME,
    ...overrides,
  };
}

function flow(overrides: Partial<GroupFlow> = {}): GroupFlow {
  return {
    groupLabel: "Alice",
    dimension: "walletName",
    totalSats: 100_000_000,
    details: [detail()],
    isUnknown: false,
    ...overrides,
  };
}

// --- Minimal jspdf content-stream reader (mirrors fund-trail-export.test.ts) --
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

function richSnapshot() {
  const center: TrailHop = {
    sources: [
      flow({
        groupLabel: "Alice",
        details: [detail({ address: "bc1qalice", txid: "src1" })],
      }),
    ],
    destinations: [],
  };
  const expandedHop: TrailHop = {
    sources: [
      flow({
        groupLabel: "Carol",
        details: [detail({ address: "bc1qcarol", txid: "hop1" })],
      }),
    ],
    destinations: [],
  };
  const registry = new Map<string, TrailHop>();
  registry.set(flowPath("", "source", "Alice"), expandedHop);
  return buildFundTrailSnapshot("Center", "walletName", center, registry);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Fund Trail export date formatting", () => {
  it("stamps the PDF footer via toLocaleString(), not a raw epoch or ISO string", async () => {
    // The footer reads `new Date()` with no injectable clock, so freeze it.
    const fixed = new Date("2026-06-27T15:30:45Z");
    vi.useFakeTimers();
    vi.setSystemTime(fixed);

    const expectedFooter = `Generated: ${new Date().toLocaleString()}`;

    const text = await extractPdfText(await buildFundTrailPdf(richSnapshot()));

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

  it("renders the per-row Date column as an ISO YYYY-MM-DD, not a raw epoch or locale form", () => {
    const center: TrailHop = {
      sources: [flow({ details: [detail({ address: "bc1qdated" })] })],
      destinations: [],
    };
    const snapshot = buildFundTrailSnapshot("Alice", "walletName", center, new Map());
    const rows = buildFundTrailCsv(snapshot)
      .split("\r\n")
      .slice(1)
      .map((line) => line.split(","));

    const dateCell = rows[0][5];
    const expectedDate = new Date(BLOCK_TIME * 1000).toISOString().slice(0, 10);
    expect(dateCell).toBe(expectedDate);
    expect(dateCell).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Reject raw epoch (seconds + ms), a slashed locale date, and a full ISO
    // string carrying the time portion.
    expect(dateCell).not.toBe(String(BLOCK_TIME));
    expect(dateCell).not.toBe(String(BLOCK_TIME * 1000));
    expect(dateCell).not.toContain("/");
    expect(dateCell).not.toContain("T");
    expect(dateCell).not.toContain(":");
    expect(dateCell).not.toBe(new Date(BLOCK_TIME * 1000).toLocaleDateString());

    // The detailed PDF table must carry the same ISO date and none of the
    // regression forms.
    return buildFundTrailPdf(snapshot, { detailed: true })
      .then(extractPdfText)
      .then((text) => {
        expect(text).toContain(expectedDate);
        expect(text).not.toContain(String(BLOCK_TIME * 1000));
      });
  });

  it("stamps the download filename with an ISO YYYY-MM-DD date, not a raw epoch or locale form", () => {
    const fixed = new Date("2026-06-27T15:30:45Z");
    const expectedStamp = fixed.toISOString().slice(0, 10);

    for (const ext of ["csv", "pdf"] as const) {
      const filename = fundTrailFilename("Alice", ext, fixed);

      expect(filename).toBe(`fund-trail-Alice-${expectedStamp}.${ext}`);
      expect(filename).toMatch(
        new RegExp(`^fund-trail-Alice-\\d{4}-\\d{2}-\\d{2}\\.${ext}$`),
      );

      // Reject the regression forms: raw epoch (ms + seconds), a full ISO
      // string with the time portion, and a slashed locale date.
      const fixedMs = fixed.getTime();
      expect(filename).not.toContain(String(fixedMs));
      expect(filename).not.toContain(String(Math.floor(fixedMs / 1000)));
      expect(filename).not.toContain("T");
      expect(filename).not.toContain(":");
      expect(filename).not.toContain("/");
      expect(filename).not.toContain(fixed.toLocaleDateString());
    }
  });
});

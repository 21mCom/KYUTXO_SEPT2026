import { describe, it, expect } from "vitest";

import type {
  GroupFlow,
  GroupFlowDetail,
  TrailHop,
} from "./fund-trail-engine";
import { formatBtc } from "./fund-trail-engine";
import {
  buildFundTrailSnapshot,
  buildFundTrailCsv,
  buildFundTrailPdf,
  fundTrailFilename,
  flowPath,
  flattenNodes,
  sumTopLevel,
  type ExportFlowNode,
} from "./fund-trail-export";

// ---------------------------------------------------------------------------
// Test fixtures — small, hand-built hops that mirror what the engine produces.
// ---------------------------------------------------------------------------

function detail(
  overrides: Partial<GroupFlowDetail> = {},
): GroupFlowDetail {
  return {
    address: "bc1qsource",
    txid: "aaaa",
    amount: 100_000_000, // 1 BTC in sats
    blockTime: 1_700_000_000, // 2023-11-14
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

function parseCsv(csv: string): string[][] {
  // Minimal RFC-4180 parser sufficient for assertions in these tests.
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (inQuotes) {
      if (c === '"') {
        if (csv[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r" && csv[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else if (c === "\n" || c === "\r") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += c;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// PDF text extraction — a minimal reader for jspdf's (uncompressed) content
// streams. jspdf stores most text as Latin1 literal strings `(text)`, but runs
// containing non-Latin1 glyphs (e.g. the "↳" indent marker on expanded hops)
// are emitted as UTF-16BE. This recovers the rendered text from both forms so
// tests can assert on what the PDF actually says, not just that bytes exist.
// ---------------------------------------------------------------------------

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
  // A run carrying any NUL byte is a UTF-16BE string; decode it as pairs.
  if (!bytes.includes("\u0000")) return bytes;
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode(
      (bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1),
    );
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

describe("buildFundTrailCsv", () => {
  it("emits the exact header columns", () => {
    const center: TrailHop = { sources: [], destinations: [] };
    const snapshot = buildFundTrailSnapshot(
      "Alice",
      "walletName",
      center,
      new Map(),
    );
    const csv = buildFundTrailCsv(snapshot);
    const firstLine = csv.split("\r\n")[0];
    expect(firstLine).toBe("direction,group,amount_btc,address,txid,date");
  });

  it("uses CRLF line endings between rows", () => {
    const center: TrailHop = {
      sources: [flow()],
      destinations: [],
    };
    const snapshot = buildFundTrailSnapshot(
      "Alice",
      "walletName",
      center,
      new Map(),
    );
    const csv = buildFundTrailCsv(snapshot);
    expect(csv).toContain("\r\n");
    // Header + one data row → exactly two lines.
    expect(csv.split("\r\n")).toHaveLength(2);
  });

  it("includes center sources and destinations as rows", () => {
    const center: TrailHop = {
      sources: [
        flow({
          groupLabel: "Alice",
          details: [detail({ address: "bc1qalice", txid: "src1" })],
        }),
      ],
      destinations: [
        flow({
          groupLabel: "Bob",
          totalSats: 50_000_000,
          details: [
            detail({
              address: "bc1qbob",
              txid: "dst1",
              amount: 50_000_000,
            }),
          ],
        }),
      ],
    };
    const snapshot = buildFundTrailSnapshot(
      "Center",
      "walletName",
      center,
      new Map(),
    );
    const rows = parseCsv(buildFundTrailCsv(snapshot)).slice(1);

    const source = rows.find((r) => r[3] === "bc1qalice");
    expect(source).toBeDefined();
    expect(source![0]).toBe("source");
    expect(source![1]).toBe("Alice");
    expect(source![4]).toBe("src1");

    const dest = rows.find((r) => r[3] === "bc1qbob");
    expect(dest).toBeDefined();
    expect(dest![0]).toBe("destination");
    expect(dest![1]).toBe("Bob");
    expect(dest![4]).toBe("dst1");
  });

  it("includes at least one expanded hop as rows", () => {
    // Center has a source group "Alice" the user expanded; its expansion
    // (next hop sources) is registered under the path the FlowCard tree uses.
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

    const snapshot = buildFundTrailSnapshot(
      "Center",
      "walletName",
      center,
      registry,
    );
    const rows = parseCsv(buildFundTrailCsv(snapshot)).slice(1);

    const hopRow = rows.find((r) => r[3] === "bc1qcarol");
    expect(hopRow).toBeDefined();
    expect(hopRow![0]).toBe("source");
    expect(hopRow![1]).toBe("Carol");
    expect(hopRow![4]).toBe("hop1");
  });

  it("formats BTC amounts with 8 decimals", () => {
    const center: TrailHop = {
      sources: [
        flow({
          totalSats: 123_456_789,
          details: [detail({ amount: 123_456_789 })],
        }),
      ],
      destinations: [],
    };
    const snapshot = buildFundTrailSnapshot(
      "Alice",
      "walletName",
      center,
      new Map(),
    );
    const rows = parseCsv(buildFundTrailCsv(snapshot)).slice(1);
    expect(rows[0][2]).toBe("1.23456789");
  });

  it("renders block times as ISO dates and blanks unknown times", () => {
    const center: TrailHop = {
      sources: [
        flow({
          details: [
            detail({ address: "bc1qdated", blockTime: 1_700_000_000 }),
            detail({
              address: "bc1qundated",
              txid: "bbbb",
              blockTime: 0,
            }),
          ],
        }),
      ],
      destinations: [],
    };
    const snapshot = buildFundTrailSnapshot(
      "Alice",
      "walletName",
      center,
      new Map(),
    );
    const rows = parseCsv(buildFundTrailCsv(snapshot)).slice(1);
    const dated = rows.find((r) => r[3] === "bc1qdated");
    const undated = rows.find((r) => r[3] === "bc1qundated");
    expect(dated![5]).toBe(
      new Date(1_700_000_000 * 1000).toISOString().slice(0, 10),
    );
    expect(undated![5]).toBe("");
  });

  it("escapes commas and quotes per RFC 4180", () => {
    const center: TrailHop = {
      sources: [
        flow({
          groupLabel: 'Acme, "Inc"',
          details: [detail({ address: "bc1qescape" })],
        }),
      ],
      destinations: [],
    };
    const snapshot = buildFundTrailSnapshot(
      "Alice",
      "walletName",
      center,
      new Map(),
    );
    const csv = buildFundTrailCsv(snapshot);
    // Raw CSV must wrap the field in quotes and double the inner quotes.
    expect(csv).toContain('"Acme, ""Inc"""');
    // And a tolerant parser must recover the original value.
    const rows = parseCsv(csv).slice(1);
    expect(rows[0][1]).toBe('Acme, "Inc"');
  });

  it("includes unknown groups", () => {
    const center: TrailHop = {
      sources: [
        flow({
          groupLabel: "Unknown",
          isUnknown: true,
          details: [detail({ address: "bc1qunknown", txid: "unk1" })],
        }),
      ],
      destinations: [],
    };
    const snapshot = buildFundTrailSnapshot(
      "Alice",
      "walletName",
      center,
      new Map(),
    );
    const rows = parseCsv(buildFundTrailCsv(snapshot)).slice(1);
    const unknownRow = rows.find((r) => r[3] === "bc1qunknown");
    expect(unknownRow).toBeDefined();
    expect(unknownRow![1]).toBe("Unknown");
  });

  it("deduplicates details by address+txid", () => {
    const center: TrailHop = {
      sources: [
        flow({
          details: [
            detail({ address: "bc1qdup", txid: "same" }),
            detail({ address: "bc1qdup", txid: "same" }),
          ],
        }),
      ],
      destinations: [],
    };
    const snapshot = buildFundTrailSnapshot(
      "Alice",
      "walletName",
      center,
      new Map(),
    );
    const rows = parseCsv(buildFundTrailCsv(snapshot)).slice(1);
    expect(rows.filter((r) => r[3] === "bc1qdup")).toHaveLength(1);
  });

  it("prepends a cap warning comment line when a hop is capped", () => {
    const center: TrailHop = {
      sources: [flow()],
      destinations: [],
      isCapped: true,
      shownTxCount: 1000,
      totalTxCount: 8500,
    };
    const snapshot = buildFundTrailSnapshot(
      "Alice",
      "walletName",
      center,
      new Map(),
    );
    const csv = buildFundTrailCsv(snapshot);
    const firstLine = csv.split("\r\n")[0];
    expect(firstLine.startsWith("#")).toBe(true);
    expect(firstLine).toContain("incomplete");
    expect(firstLine).toContain("1,000");
    expect(firstLine).toContain("8,500");
    // The header still follows the comment so the columns are intact.
    expect(csv.split("\r\n")[1]).toBe(
      "direction,group,amount_btc,address,txid,date",
    );
  });

  it("omits the cap warning when nothing was capped", () => {
    const center: TrailHop = {
      sources: [flow()],
      destinations: [],
      isCapped: false,
      shownTxCount: 5,
      totalTxCount: 5,
    };
    const snapshot = buildFundTrailSnapshot(
      "Alice",
      "walletName",
      center,
      new Map(),
    );
    const csv = buildFundTrailCsv(snapshot);
    expect(csv).not.toContain("#");
    expect(csv).not.toContain("incomplete");
    expect(csv.split("\r\n")[0]).toBe(
      "direction,group,amount_btc,address,txid,date",
    );
  });

  it("warns when only a deeper expanded hop is capped", () => {
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
      sources: [flow({ groupLabel: "Carol" })],
      destinations: [],
      isCapped: true,
      shownTxCount: 250,
      totalTxCount: 4000,
    };
    const registry = new Map<string, TrailHop>();
    registry.set(flowPath("", "source", "Alice"), expandedHop);
    const snapshot = buildFundTrailSnapshot(
      "Center",
      "walletName",
      center,
      registry,
    );
    const csv = buildFundTrailCsv(snapshot);
    expect(csv.split("\r\n")[0]).toContain("250");
    expect(csv.split("\r\n")[0]).toContain("4,000");
  });
});

describe("fundTrailFilename", () => {
  const date = new Date("2026-06-27T12:00:00Z");

  it("sanitizes unsafe characters and is dated", () => {
    const name = fundTrailFilename('Alice & Bob / "Wallet"', "csv", date);
    expect(name).toBe("fund-trail-Alice-Bob-Wallet-2026-06-27.csv");
    expect(name).not.toMatch(/[&/"\s]/);
  });

  it("falls back to a default label when nothing is left", () => {
    const name = fundTrailFilename("///", "pdf", date);
    expect(name).toBe("fund-trail-fund-trail-2026-06-27.pdf");
  });

  it("respects the requested extension", () => {
    expect(fundTrailFilename("Alice", "csv", date)).toMatch(/\.csv$/);
    expect(fundTrailFilename("Alice", "pdf", date)).toMatch(/\.pdf$/);
  });
});

// ---------------------------------------------------------------------------
// PDF helpers — the row-building math that feeds the rendered table.
// ---------------------------------------------------------------------------

function node(overrides: Partial<ExportFlowNode> = {}): ExportFlowNode {
  return {
    groupLabel: "Alice",
    totalSats: 100_000_000,
    isUnknown: false,
    details: [detail()],
    children: [],
    ...overrides,
  };
}

describe("sumTopLevel", () => {
  it("returns 0 for an empty side", () => {
    expect(sumTopLevel([])).toBe(0);
  });

  it("sums only the top-level totals, ignoring children", () => {
    const nodes = [
      node({ totalSats: 50_000_000, children: [node({ totalSats: 999 })] }),
      node({ totalSats: 25_000_000 }),
    ];
    expect(sumTopLevel(nodes)).toBe(75_000_000);
  });
});

describe("flattenNodes", () => {
  it("flattens a flat list at depth 0 in order", () => {
    const out: { depth: number; node: ExportFlowNode }[] = [];
    flattenNodes(
      [node({ groupLabel: "A" }), node({ groupLabel: "B" })],
      0,
      out,
    );
    expect(out.map((o) => o.depth)).toEqual([0, 0]);
    expect(out.map((o) => o.node.groupLabel)).toEqual(["A", "B"]);
  });

  it("assigns increasing depth to expanded hops (depth-first)", () => {
    const tree = [
      node({
        groupLabel: "A",
        children: [
          node({
            groupLabel: "A1",
            children: [node({ groupLabel: "A1a" })],
          }),
        ],
      }),
      node({ groupLabel: "B" }),
    ];
    const out: { depth: number; node: ExportFlowNode }[] = [];
    flattenNodes(tree, 0, out);
    expect(out.map((o) => [o.node.groupLabel, o.depth])).toEqual([
      ["A", 0],
      ["A1", 1],
      ["A1a", 2],
      ["B", 0],
    ]);
  });
});

// ---------------------------------------------------------------------------
// PDF builder — must resolve to a non-empty Blob without throwing, offline.
// ---------------------------------------------------------------------------

describe("buildFundTrailPdf", () => {
  function richSnapshot() {
    const center: TrailHop = {
      sources: [
        flow({
          groupLabel: "Alice",
          details: [detail({ address: "bc1qalice", txid: "src1" })],
        }),
      ],
      destinations: [
        flow({
          groupLabel: "Bob",
          totalSats: 50_000_000,
          details: [
            detail({ address: "bc1qbob", txid: "dst1", amount: 50_000_000 }),
          ],
        }),
      ],
    };
    // One expanded hop off the "Alice" source so the table exercises indent depth.
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

  it("resolves to a non-empty PDF Blob without throwing", async () => {
    const snapshot = richSnapshot();
    const blob = await buildFundTrailPdf(snapshot);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBeGreaterThan(0);
    expect(blob.type).toBe("application/pdf");
    // Sanity-check the header bytes are a real PDF.
    const header = await blob.slice(0, 5).text();
    expect(header).toBe("%PDF-");
  });

  it("produces a valid PDF even when both sides are empty", async () => {
    const center: TrailHop = { sources: [], destinations: [] };
    const snapshot = buildFundTrailSnapshot(
      "Alice",
      "walletName",
      center,
      new Map(),
    );
    const blob = await buildFundTrailPdf(snapshot);
    expect(blob.size).toBeGreaterThan(0);
    expect(await blob.slice(0, 5).text()).toBe("%PDF-");
  });

  it("renders the section headings, center label, and in/out totals as PDF text", async () => {
    const snapshot = richSnapshot();
    const text = await extractPdfText(await buildFundTrailPdf(snapshot));

    // Center node identity.
    expect(text).toContain(snapshot.centerLabel);
    // Both section headings must survive into the rendered document.
    expect(text).toContain("Sources");
    expect(text).toContain("Destinations");
    // The in/out totals must be labeled and formatted, not transposed.
    const totalIn = formatBtc(sumTopLevel(snapshot.sources));
    const totalOut = formatBtc(sumTopLevel(snapshot.destinations));
    expect(totalIn).toBe("1.00 BTC");
    expect(totalOut).toBe("0.50 BTC");
    expect(text).toContain(`${totalIn} in`);
    expect(text).toContain(`${totalOut} out`);
  });

  it("renders top-level and expanded-hop group labels in the table body", async () => {
    const snapshot = richSnapshot();
    const text = await extractPdfText(await buildFundTrailPdf(snapshot));

    // Top-level source and destination groups.
    expect(text).toContain("Alice");
    expect(text).toContain("Bob");
    // The expanded "Carol" hop is indented (with "↳"), forcing jspdf to emit a
    // UTF-16 run — it must still appear in the rendered table body.
    expect(text).toContain("Carol");
  });

  it("renders the per-group detail sub-tables when detailed", async () => {
    const snapshot = richSnapshot();
    const text = await extractPdfText(
      await buildFundTrailPdf(snapshot, { detailed: true }),
    );

    // The detailed title distinguishes the document from the summary export.
    expect(text).toContain("Fund Trail (detailed)");

    // Each group gets a "label — amount" detail heading line. jspdf renders the
    // em-dash separator as a single WinAnsi byte, so match the label and amount
    // across the separator rather than the literal dash (one line, no newline).
    expect(text).toMatch(
      new RegExp(`Alice.*${formatBtc(100_000_000).replace(".", "\\.")}`),
    );

    // The detail sub-table carries the same data the CSV does: address, txid,
    // an 8-decimal BTC amount (only the detail rows use this form), and ISO date.
    expect(text).toContain("bc1qalice");
    expect(text).toContain("src1");
    expect(text).toContain("1.00000000");
    expect(text).toContain(
      new Date(1_700_000_000 * 1000).toISOString().slice(0, 10),
    );

    // The expanded "Carol" hop's detail rows must also be present.
    expect(text).toContain("bc1qcarol");
    expect(text).toContain("hop1");
  });

  it("renders the cap warning banner when a hop is capped", async () => {
    const center: TrailHop = {
      sources: [flow({ groupLabel: "Alice" })],
      destinations: [],
      isCapped: true,
      shownTxCount: 1000,
      totalTxCount: 8500,
    };
    const snapshot = buildFundTrailSnapshot(
      "Alice",
      "walletName",
      center,
      new Map(),
    );
    const text = await extractPdfText(await buildFundTrailPdf(snapshot));
    expect(text).toContain("incomplete");
    expect(text).toContain("1,000");
    expect(text).toContain("8,500");
  });

  it("omits the cap warning banner when nothing was capped", async () => {
    const snapshot = richSnapshot();
    const text = await extractPdfText(await buildFundTrailPdf(snapshot));
    expect(text).not.toContain("incomplete");
  });

  it("flattens the snapshot into the rows the table will render", () => {
    const snapshot = richSnapshot();

    // Sources: "Alice" at depth 0 with its expanded "Carol" hop at depth 1.
    const sourceRows: { depth: number; node: ExportFlowNode }[] = [];
    flattenNodes(snapshot.sources, 0, sourceRows);
    expect(sourceRows.map((r) => [r.node.groupLabel, r.depth])).toEqual([
      ["Alice", 0],
      ["Carol", 1],
    ]);

    // Destinations: a single top-level "Bob" group.
    const destRows: { depth: number; node: ExportFlowNode }[] = [];
    flattenNodes(snapshot.destinations, 0, destRows);
    expect(destRows.map((r) => [r.node.groupLabel, r.depth])).toEqual([
      ["Bob", 0],
    ]);

    // In/out totals reflect only the center hop's top-level groups.
    expect(sumTopLevel(snapshot.sources)).toBe(100_000_000);
    expect(sumTopLevel(snapshot.destinations)).toBe(50_000_000);
  });
});

// ---------------------------------------------------------------------------
// PDF builder at scale — the detailed export must paginate across many pages
// rather than overflow one page or emit a corrupt/blank document.
// ---------------------------------------------------------------------------

/**
 * Count the pages in a (jsPDF, uncompressed) PDF blob's raw text. jsPDF records
 * the total in the pages tree (`/Type /Pages … /Count N`) and emits one
 * `/MediaBox` per page object; we use the tree count and fall back to the
 * per-page boxes so the assertion stays robust if jsPDF reorders objects.
 */
function pdfPageCount(pdfText: string): number {
  const countMatch = pdfText.match(/\/Type\s*\/Pages\b[\s\S]*?\/Count\s+(\d+)/);
  if (countMatch) return Number(countMatch[1]);
  return (pdfText.match(/\/MediaBox/g) || []).length;
}

/**
 * Build a snapshot with `groups` top-level source groups, each carrying
 * `detailsPerGroup` unique (address, txid) detail rows — i.e. thousands of
 * deduplicated addresses overall — so the detailed PDF must span many pages.
 */
function largeSnapshot(groups: number, detailsPerGroup: number) {
  const sources: GroupFlow[] = [];
  for (let g = 0; g < groups; g++) {
    const details: GroupFlowDetail[] = [];
    for (let d = 0; d < detailsPerGroup; d++) {
      details.push(
        detail({
          address: `bc1qgroup${g}addr${d}`,
          txid: `txid-${g}-${d}`,
          amount: 1_000_000 + d,
          blockTime: 1_700_000_000 + g * 1000 + d,
        }),
      );
    }
    sources.push(
      flow({
        groupLabel: `Group ${g}`,
        totalSats: details.reduce((s, x) => s + x.amount, 0),
        details,
      }),
    );
  }
  const center: TrailHop = { sources, destinations: [] };
  return buildFundTrailSnapshot("Big Wallet", "walletName", center, new Map());
}

describe("buildFundTrailPdf at scale", () => {
  it("paginates a large detailed snapshot into a valid multi-page Blob", async () => {
    // 60 groups × 40 rows = 2,400 deduplicated detail rows (thousands of
    // addresses) — far more than fits on a single page.
    const snapshot = largeSnapshot(60, 40);

    const blob = await buildFundTrailPdf(snapshot, { detailed: true });

    // A real, non-trivial PDF (not blank/corrupt).
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("application/pdf");
    expect(blob.size).toBeGreaterThan(100_000);

    const text = await blob.text();
    expect(text.slice(0, 5)).toBe("%PDF-");
    // It must end cleanly with the EOF marker, proving the document closed.
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);

    // The whole point: it spans many pages instead of overflowing one.
    expect(pdfPageCount(text)).toBeGreaterThan(5);
  });

  it("detailed: false yields the original summary-only layout", async () => {
    const snapshot = largeSnapshot(60, 40);

    const summary = await buildFundTrailPdf(snapshot, { detailed: false });
    const detailed = await buildFundTrailPdf(snapshot, { detailed: true });

    expect(summary.type).toBe("application/pdf");
    const summaryText = await summary.text();
    expect(summaryText.slice(0, 5)).toBe("%PDF-");
    expect(summaryText.trimEnd().endsWith("%%EOF")).toBe(true);

    // Summary-only omits every per-detail sub-table, so for the same data it is
    // dramatically smaller and uses far fewer pages than the detailed export.
    const summaryPages = pdfPageCount(summaryText);
    const detailedPages = pdfPageCount(await detailed.text());
    expect(summaryPages).toBeLessThan(detailedPages);
    expect(summary.size).toBeLessThan(detailed.size);
  });

  it("omitting options defaults to the summary-only layout", async () => {
    const snapshot = largeSnapshot(60, 40);

    const noOptions = await buildFundTrailPdf(snapshot);
    const explicitSummary = await buildFundTrailPdf(snapshot, {
      detailed: false,
    });

    // No options must match the explicit summary layout in page count, proving
    // `detailed` defaults to false rather than embedding detail rows.
    expect(pdfPageCount(await noOptions.text())).toBe(
      pdfPageCount(await explicitSummary.text()),
    );
  });
});

// ---------------------------------------------------------------------------
// PDF builder with maximally long values — full-length txids, over-long
// taproot/descriptor-style addresses, and a long group label must wrap into the
// fixed-width detail columns (overflow: "linebreak") rather than being clipped
// or pushed off the page edge.
// ---------------------------------------------------------------------------

describe("buildFundTrailPdf with very long values", () => {
  // A 90-char bech32m-style address (longer than any real taproot address) and
  // a full 64-hex-char txid — the worst case for the fixed-width detail columns.
  const longAddress = "bc1p" + "q".repeat(86);
  const longTxid = "a".repeat(64);
  const longGroupLabel =
    "Very Long Wallet Name That Could Plausibly Come From A Descriptor " +
    "Or An Imported Third Party Label " +
    "x".repeat(60);

  /**
   * One "known" group carrying a single detail with the maximally long
   * address/txid (so we can assert it round-trips), plus many bulk groups whose
   * details are also maximally long so the detailed PDF must span many pages.
   */
  function longValueSnapshot() {
    const knownGroup = flow({
      groupLabel: longGroupLabel,
      totalSats: 123_456_789,
      details: [
        detail({ address: longAddress, txid: longTxid, amount: 123_456_789 }),
      ],
    });
    const sources: GroupFlow[] = [knownGroup];
    for (let g = 0; g < 40; g++) {
      const details: GroupFlowDetail[] = [];
      for (let d = 0; d < 20; d++) {
        details.push(
          detail({
            // Unique prefix kept within the 90/64 cap so dedup never collapses rows.
            address: (`bc1p${g}-${d}-` + "q".repeat(90)).slice(0, 90),
            txid: (`${g}-${d}-` + "a".repeat(64)).slice(0, 64),
            amount: 1_000_000 + d,
            blockTime: 1_700_000_000 + g * 1000 + d,
          }),
        );
      }
      sources.push(
        flow({
          groupLabel: `${longGroupLabel} #${g}`,
          totalSats: details.reduce((s, x) => s + x.amount, 0),
          details,
        }),
      );
    }
    const center: TrailHop = { sources, destinations: [] };
    return buildFundTrailSnapshot(
      "Big Wallet",
      "walletName",
      center,
      new Map(),
    );
  }

  it("paginates long addresses/txids/labels into a valid multi-page Blob without throwing", async () => {
    const snapshot = longValueSnapshot();

    const blob = await buildFundTrailPdf(snapshot, { detailed: true });

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("application/pdf");
    expect(blob.size).toBeGreaterThan(0);

    const text = await blob.text();
    // Real, cleanly-closed PDF (not blank/corrupt).
    expect(text.slice(0, 5)).toBe("%PDF-");
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    // The long values force wrapping, which uses extra vertical space and must
    // flow across multiple pages rather than overflowing a single one.
    expect(pdfPageCount(text)).toBeGreaterThan(1);
  });

  it("wraps long addresses and full-length txids instead of clipping them", async () => {
    const snapshot = longValueSnapshot();

    const text = await extractPdfText(
      await buildFundTrailPdf(snapshot, { detailed: true }),
    );
    // autotable's linebreak wrapping splits a long no-space value across several
    // rendered lines; once whitespace/newlines are removed those chunks rejoin
    // into the original string. If the value were truncated/clipped, the full
    // address and txid would no longer be recoverable.
    const normalized = text.replace(/\s+/g, "");
    expect(normalized).toContain(longAddress);
    expect(normalized).toContain(longTxid);
  });

  // A long group label could overflow the right page edge if its detail-section
  // heading were drawn as one unwrapped run. The heading is now wrapped via
  // doc.splitTextToSize, so it must render across multiple lines. We measure the
  // heading's rendered line count straight from the (uncompressed) PDF content
  // stream: the detail heading is the only run drawn at font size 9 (`/F1 9
  // Tf`), and jspdf emits one `Tj` text-show operator per rendered line. Reading
  // the operators (not the decoded text) makes the count immune to the em-dash
  // separator being dropped by the font and to the "↳ " indent marker being
  // emitted as a UTF-16 string on expanded hops.
  async function headingLineCount(
    blob: Blob,
    labelMarker: string,
  ): Promise<number> {
    const latin1 = Buffer.from(await blob.arrayBuffer()).toString("latin1");
    // Operators are newline-delimited, so a BT…ET block never contains a stray
    // "\nET" inside its literals — the non-greedy match lands on the real end.
    const blocks = latin1.match(/BT\n[\s\S]*?\nET/g) ?? [];
    const heading = blocks.find(
      (b) => b.includes("/F1 9 Tf") && b.includes(labelMarker),
    );
    if (!heading) return 0;
    return (heading.match(/Tj\b/g) ?? []).length;
  }

  // A distinctive Latin1 chunk of the long label that lands on a wrapped line
  // (so it identifies the heading block whether or not it was wrapped).
  const labelMarker = "xxxxxxxxxx";

  it("wraps a long top-level group-label heading across multiple lines", async () => {
    const center: TrailHop = {
      sources: [
        flow({
          groupLabel: longGroupLabel,
          totalSats: 123_456_789,
          // Short address/txid so only the heading (not the columns) wraps.
          details: [detail({ address: "bc1qshort", txid: "short1" })],
        }),
      ],
      destinations: [],
    };
    const snapshot = buildFundTrailSnapshot(
      "Center",
      "walletName",
      center,
      new Map(),
    );

    const blob = await buildFundTrailPdf(snapshot, { detailed: true });

    // The long heading must render on more than one line; an unwrapped run that
    // overflowed the page edge would render as exactly one line.
    expect(await headingLineCount(blob, labelMarker)).toBeGreaterThan(1);
  });

  it("wraps a long expanded-hop heading too (robust to the ↳ indent marker)", async () => {
    const center: TrailHop = {
      sources: [
        flow({
          groupLabel: "Root",
          details: [detail({ address: "bc1qroot", txid: "root1" })],
        }),
      ],
      destinations: [],
    };
    // The long label lives on an expanded child hop, so its heading is drawn
    // with the "↳ " indent prefix — a non-Latin1 glyph jspdf emits as UTF-16.
    const expandedHop: TrailHop = {
      sources: [
        flow({
          groupLabel: longGroupLabel,
          totalSats: 123_456_789,
          details: [detail({ address: "bc1qchild", txid: "child1" })],
        }),
      ],
      destinations: [],
    };
    const registry = new Map<string, TrailHop>();
    registry.set(flowPath("", "source", "Root"), expandedHop);
    const snapshot = buildFundTrailSnapshot(
      "Center",
      "walletName",
      center,
      registry,
    );

    const blob = await buildFundTrailPdf(snapshot, { detailed: true });

    // Despite the UTF-16 "↳ " indent run on its first line, the indented heading
    // must still wrap onto multiple lines rather than overflow the page edge.
    expect(await headingLineCount(blob, labelMarker)).toBeGreaterThan(1);

    // Guard the measurement itself: a short, unwrapped heading ("Root") renders
    // as exactly one line, proving the >1 assertion reflects real wrapping.
    expect(await headingLineCount(blob, "Root")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// PDF builder at depth — beyond many top-level groups, the detailed export also
// recurses through expanded hops (children) and indents each level. A user who
// expands many hops deep produces deeply nested detail sub-tables whose indent
// (`"    ".repeat(depth)`) and left margins grow with depth. The document must
// still paginate cleanly and not overflow horizontally as depth increases.
// ---------------------------------------------------------------------------

/**
 * Build a snapshot whose single top-level source group expands into a straight
 * chain of `depth` further hops (Level 0 → Level 1 → … → Level depth), each
 * carrying `detailsPerNode` unique detail rows, by registering each hop under
 * the path the FlowCard tree would use. This drives `buildNode`'s recursion and
 * forces `flattenNodes` to assign one increasing depth per level.
 */
function deepChainSnapshot(depth: number, detailsPerNode: number) {
  const makeDetails = (level: number): GroupFlowDetail[] => {
    const details: GroupFlowDetail[] = [];
    for (let d = 0; d < detailsPerNode; d++) {
      details.push(
        detail({
          address: `bc1qlevel${level}addr${d}`,
          txid: `txid-${level}-${d}`,
          amount: 1_000_000 + d,
          blockTime: 1_700_000_000 + level * 1000 + d,
        }),
      );
    }
    return details;
  };

  const center: TrailHop = {
    sources: [
      flow({ groupLabel: "Level 0", details: makeDetails(0) }),
    ],
    destinations: [],
  };

  // Walk the path the FlowCard tree registers expanded hops under, hanging one
  // deeper single-group hop off each level so the chain is `depth` levels deep.
  const registry = new Map<string, TrailHop>();
  let path = flowPath("", "source", "Level 0");
  for (let level = 1; level <= depth; level++) {
    const label = `Level ${level}`;
    registry.set(path, {
      sources: [flow({ groupLabel: label, details: makeDetails(level) })],
      destinations: [],
    });
    path = flowPath(path, "source", label);
  }

  return buildFundTrailSnapshot("Deep Wallet", "walletName", center, registry);
}

// ---------------------------------------------------------------------------
// PDF builder at fan-out — distinct from a deep chain, a single hop can expand
// into *many sibling children at the same level* (buildNode maps over every
// childFlow). A user who expands one busy hop into dozens of branches — each
// with its own detail sub-table — is a wide fan-out rather than a deep chain.
// The detailed export must still paginate cleanly and reach every branch.
// ---------------------------------------------------------------------------

/**
 * Build a snapshot whose single top-level source group ("Root") expands into a
 * hop with `branches` sibling child flows ("Branch 0" … "Branch N-1") all at
 * the same depth, each carrying `detailsPerBranch` unique detail rows. The hop
 * is registered under the path the FlowCard tree uses, driving buildNode's
 * fan-out over childFlows so flattenNodes emits Root at depth 0 followed by
 * every branch at depth 1 in order.
 */
function wideFanOutSnapshot(branches: number, detailsPerBranch: number) {
  const makeDetails = (branch: number): GroupFlowDetail[] => {
    const details: GroupFlowDetail[] = [];
    for (let d = 0; d < detailsPerBranch; d++) {
      details.push(
        detail({
          address: `bc1qbranch${branch}addr${d}`,
          txid: `txid-${branch}-${d}`,
          amount: 1_000_000 + d,
          blockTime: 1_700_000_000 + branch * 1000 + d,
        }),
      );
    }
    return details;
  };

  const center: TrailHop = {
    sources: [
      flow({ groupLabel: "Root", details: makeDetails(-1) }),
    ],
    destinations: [],
  };

  // The "Root" group expands into one hop holding many sibling source flows.
  const branchFlows: GroupFlow[] = [];
  for (let b = 0; b < branches; b++) {
    const branchDetails = makeDetails(b);
    branchFlows.push(
      flow({
        groupLabel: `Branch ${b}`,
        totalSats: branchDetails.reduce((s, x) => s + x.amount, 0),
        details: branchDetails,
      }),
    );
  }
  const registry = new Map<string, TrailHop>();
  registry.set(flowPath("", "source", "Root"), {
    sources: branchFlows,
    destinations: [],
  });

  return buildFundTrailSnapshot("Fan Wallet", "walletName", center, registry);
}

/**
 * Mirror of `wideFanOutSnapshot` for the *destinations* (outgoing) side: a
 * single top-level destination group ("Root") expands into a hop holding
 * `branches` sibling child flows ("Branch 0" … "Branch N-1") all at the same
 * depth, each carrying `detailsPerBranch` unique detail rows. The hop is
 * registered under the path the FlowCard tree uses with direction "dest",
 * driving buildNode's "dest" recursion (hop.destinations) so flattenNodes over
 * snapshot.destinations emits Root at depth 0 followed by every branch at
 * depth 1 in depth-first sibling order.
 */
function wideFanOutDestSnapshot(branches: number, detailsPerBranch: number) {
  const makeDetails = (branch: number): GroupFlowDetail[] => {
    const details: GroupFlowDetail[] = [];
    for (let d = 0; d < detailsPerBranch; d++) {
      details.push(
        detail({
          address: `bc1qdestbranch${branch}addr${d}`,
          txid: `dtxid-${branch}-${d}`,
          amount: 1_000_000 + d,
          blockTime: 1_700_000_000 + branch * 1000 + d,
        }),
      );
    }
    return details;
  };

  const center: TrailHop = {
    sources: [],
    destinations: [
      flow({ groupLabel: "Root", details: makeDetails(-1) }),
    ],
  };

  // The "Root" destination group expands into one hop holding many sibling
  // destination flows — the outgoing-side fan-out.
  const branchFlows: GroupFlow[] = [];
  for (let b = 0; b < branches; b++) {
    const branchDetails = makeDetails(b);
    branchFlows.push(
      flow({
        groupLabel: `Branch ${b}`,
        totalSats: branchDetails.reduce((s, x) => s + x.amount, 0),
        details: branchDetails,
      }),
    );
  }
  const registry = new Map<string, TrailHop>();
  registry.set(flowPath("", "dest", "Root"), {
    sources: [],
    destinations: branchFlows,
  });

  return buildFundTrailSnapshot("Fan Wallet", "walletName", center, registry);
}

describe("buildFundTrailPdf at fan-out", () => {
  it("paginates a wide fan-out detailed snapshot into a valid multi-page Blob", async () => {
    // 30 sibling branches off one hop, each with detail rows, so the detailed
    // export renders dozens of same-level sub-tables that must paginate.
    const branches = 30;
    const snapshot = wideFanOutSnapshot(branches, 12);

    // The flattened tree must be "Root" at depth 0 followed by every branch at
    // depth 1, in depth-first sibling order, before anything reaches the PDF.
    const flat: { depth: number; node: ExportFlowNode }[] = [];
    flattenNodes(snapshot.sources, 0, flat);
    expect(flat.map((r) => [r.node.groupLabel, r.depth])).toEqual([
      ["Root", 0],
      ...Array.from({ length: branches }, (_, b) => [`Branch ${b}`, 1]),
    ]);

    const blob = await buildFundTrailPdf(snapshot, { detailed: true });

    // A real, non-trivial PDF (not blank/corrupt) produced without throwing.
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("application/pdf");
    expect(blob.size).toBeGreaterThan(0);

    const text = await blob.text();
    expect(text.slice(0, 5)).toBe("%PDF-");
    // It must end cleanly with the EOF marker, proving the document closed.
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);

    // The many same-level sub-tables must span more than a single page.
    expect(pdfPageCount(text)).toBeGreaterThan(1);

    // Every branch label (each indented with "↳", forcing a UTF-16 run) must
    // survive into the rendered document — none silently dropped at fan-out.
    const rendered = await extractPdfText(blob);
    expect(rendered).toContain("Root");
    for (let b = 0; b < branches; b++) {
      expect(rendered).toContain(`Branch ${b}`);
    }
  });

  it("paginates a wide fan-out on the destinations side into a valid multi-page Blob", async () => {
    // The symmetric outgoing-side case: one spending hop fans out into dozens of
    // sibling outputs, exercising buildNode's "dest" recursion (hop.destinations)
    // and renderSection over snapshot.destinations.
    const branches = 30;
    const snapshot = wideFanOutDestSnapshot(branches, 12);

    // flattenNodes over the DESTINATIONS side must be "Root" at depth 0 followed
    // by every branch at depth 1, in depth-first sibling order, before anything
    // reaches the PDF. (Sources is empty in this snapshot.)
    expect(snapshot.sources).toEqual([]);
    const flat: { depth: number; node: ExportFlowNode }[] = [];
    flattenNodes(snapshot.destinations, 0, flat);
    expect(flat.map((r) => [r.node.groupLabel, r.depth])).toEqual([
      ["Root", 0],
      ...Array.from({ length: branches }, (_, b) => [`Branch ${b}`, 1]),
    ]);

    const blob = await buildFundTrailPdf(snapshot, { detailed: true });

    // A real, non-trivial PDF (not blank/corrupt) produced without throwing.
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("application/pdf");
    expect(blob.size).toBeGreaterThan(0);

    const text = await blob.text();
    expect(text.slice(0, 5)).toBe("%PDF-");
    // It must end cleanly with the EOF marker, proving the document closed.
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);

    // The many same-level sub-tables must span more than a single page.
    expect(pdfPageCount(text)).toBeGreaterThan(1);

    // Every branch label (each indented with "↳", forcing a UTF-16 run) must
    // survive into the rendered document — none silently dropped at fan-out.
    const rendered = await extractPdfText(blob);
    expect(rendered).toContain("Root");
    for (let b = 0; b < branches; b++) {
      expect(rendered).toContain(`Branch ${b}`);
    }
  });
});

describe("buildFundTrailPdf at depth", () => {
  it("paginates a deeply nested detailed snapshot into a valid multi-page Blob", async () => {
    // A 12-level-deep chain (Level 0 → … → Level 12), each with detail rows, so
    // the detailed export recurses through deep indentation and many sub-tables.
    const depth = 12;
    const snapshot = deepChainSnapshot(depth, 20);

    // The flattened tree must assign one strictly increasing depth per level,
    // proving the deep nodes are reached in order before they reach the PDF.
    const flat: { depth: number; node: ExportFlowNode }[] = [];
    flattenNodes(snapshot.sources, 0, flat);
    expect(flat.map((r) => [r.node.groupLabel, r.depth])).toEqual(
      Array.from({ length: depth + 1 }, (_, level) => [`Level ${level}`, level]),
    );

    const blob = await buildFundTrailPdf(snapshot, { detailed: true });

    // A real, non-trivial PDF (not blank/corrupt) produced without throwing.
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("application/pdf");
    expect(blob.size).toBeGreaterThan(0);

    const text = await blob.text();
    expect(text.slice(0, 5)).toBe("%PDF-");
    // It must end cleanly with the EOF marker, proving the document closed.
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);

    // The deep detail tables must span more than a single page.
    expect(pdfPageCount(text)).toBeGreaterThan(1);

    // The deepest level must survive into the rendered document — its label is
    // indented (with "↳"), forcing jspdf to emit a UTF-16 run.
    const rendered = await extractPdfText(blob);
    expect(rendered).toContain(`Level ${depth}`);
    expect(rendered).toContain("Level 0");
  });

  it("keeps deep indented detail rows from overflowing the page horizontally", async () => {
    // Long addresses/txids at deep indentation are the horizontal-overflow risk;
    // the detail sub-tables wrap (overflow: linebreak) and stay within margins.
    const snapshot = deepChainSnapshot(15, 5);

    const blob = await buildFundTrailPdf(snapshot, { detailed: true });
    expect(blob.type).toBe("application/pdf");

    const text = await blob.text();
    expect(text.slice(0, 5)).toBe("%PDF-");
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    // Multiple pages, never a single overflowing page.
    expect(pdfPageCount(text)).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Detail-vs-summary consistency — the summary table claims an "Addresses" count
// per group, and the detailed mode renders one detail row per deduplicated
// address beneath that group. These two must never drift: a regression that
// drops some detail rows while leaving the count unchanged (or vice versa)
// would silently understate the document. This asserts every address (and its
// txid) the count claims is actually rendered, and that the count equals the
// number of detail rows actually rendered for the group.
// ---------------------------------------------------------------------------

describe("buildFundTrailPdf detail/summary address consistency", () => {
  it("renders every address and txid the group's Addresses count claims", async () => {
    // Several distinct, easily-recognizable addresses in a single group.
    const knownDetails = Array.from({ length: 5 }, (_, i) =>
      detail({
        address: `bc1qknownaddr${i}`,
        txid: `knowntxid${i}`,
        amount: 11_000_000 + i,
        blockTime: 1_700_000_000 + i * 86_400,
      }),
    );
    const center: TrailHop = {
      sources: [
        flow({
          groupLabel: "KnownGroup",
          totalSats: knownDetails.reduce((s, d) => s + d.amount, 0),
          details: knownDetails,
        }),
      ],
      destinations: [],
    };
    const snapshot = buildFundTrailSnapshot(
      "Center",
      "walletName",
      center,
      new Map(),
    );

    const text = await extractPdfText(
      await buildFundTrailPdf(snapshot, { detailed: true }),
    );
    const normalized = text.replace(/\s+/g, "");

    // Every address (and its txid) the count claims must appear in the detail
    // sub-table — none may be silently dropped.
    for (const d of knownDetails) {
      expect(normalized).toContain(d.address);
      expect(normalized).toContain(d.txid);
    }

    // Count the detail rows the PDF *actually* rendered for the group, derived
    // from the rendered text (not the fixture) so it would also catch a row
    // rendered more than once. The detail addresses are short, unique, and only
    // appear in the detail sub-table, so one match == one rendered detail row.
    const renderedRows = (text.match(/bc1qknownaddr\d+/g) || []).length;
    expect(renderedRows).toBe(knownDetails.length);

    // Read the group's own "Addresses" summary cell from the rendered summary
    // table: the summary row emits its cells (label, amount, count) as adjacent
    // literals, so the first pure-integer line right after the exact "KnownGroup"
    // label cell is that group's Addresses count.
    const lines = text.split("\n");
    const summaryIdx = lines.indexOf("KnownGroup");
    expect(summaryIdx).toBeGreaterThanOrEqual(0);
    const summaryCountCell = lines
      .slice(summaryIdx + 1, summaryIdx + 4)
      .find((l) => /^\d+$/.test(l));
    expect(summaryCountCell).toBeDefined();

    // The summary count the group claims must equal the detail rows it renders.
    expect(Number(summaryCountCell)).toBe(renderedRows);
  });
});

// ---------------------------------------------------------------------------
// CSV-vs-detailed-PDF parity — the CSV and the detailed PDF are meant to carry
// identical data (address/txid for every deduplicated flow), but they derive
// their rows independently and can drift: one could include an expanded hop or
// unknown group the other omits. This builds a single snapshot covering all the
// interesting cases (center sources, destinations, an expanded hop, and an
// unknown group) and cross-checks the two outputs against that one snapshot.
// ---------------------------------------------------------------------------

describe("buildFundTrailCsv vs detailed buildFundTrailPdf parity", () => {
  // Addresses/txids use distinctive, exact-match patterns that only ever appear
  // in a CSV address/txid cell or a PDF detail row — never inside a group label,
  // amount, date, header, or any other chrome — so they can be set-compared
  // between the two outputs without false positives.
  const ADDR_RE = /^bc1qx[a-z]+$/;
  const TXID_RE = /^txx[a-z]+$/;

  function paritySnapshot() {
    const center: TrailHop = {
      sources: [
        flow({
          groupLabel: "Alice",
          details: [detail({ address: "bc1qxalice", txid: "txxalice" })],
        }),
        flow({
          groupLabel: "Unknown",
          isUnknown: true,
          details: [detail({ address: "bc1qxunknown", txid: "txxunknown" })],
        }),
      ],
      destinations: [
        flow({
          groupLabel: "Bob",
          totalSats: 50_000_000,
          details: [
            detail({
              address: "bc1qxbob",
              txid: "txxbob",
              amount: 50_000_000,
            }),
          ],
        }),
      ],
    };
    // One expanded hop off the "Alice" source so an extra deduplicated flow
    // exists that lives only in the expanded tree.
    const expandedHop: TrailHop = {
      sources: [
        flow({
          groupLabel: "Carol",
          details: [detail({ address: "bc1qxcarol", txid: "txxcarol" })],
        }),
      ],
      destinations: [],
    };
    const registry = new Map<string, TrailHop>();
    registry.set(flowPath("", "source", "Alice"), expandedHop);
    return buildFundTrailSnapshot("Center", "walletName", center, registry);
  }

  it("renders exactly the same addresses and txids in both exports", async () => {
    const snapshot = paritySnapshot();

    // CSV: address is column 3, txid is column 4 (skip the header row).
    const csvRows = parseCsv(buildFundTrailCsv(snapshot)).slice(1);
    const csvAddresses = new Set(csvRows.map((r) => r[3]));
    const csvTxids = new Set(csvRows.map((r) => r[4]));

    // The snapshot covers every interesting case, so the CSV must carry all of
    // them — guards against a fixture that accidentally collapses a flow.
    expect(csvAddresses).toEqual(
      new Set(["bc1qxalice", "bc1qxunknown", "bc1qxbob", "bc1qxcarol"]),
    );
    expect(csvTxids).toEqual(
      new Set(["txxalice", "txxunknown", "txxbob", "txxcarol"]),
    );

    // Detailed PDF: collect the address/txid tokens it actually rendered. The
    // detail sub-tables emit each cell as its own literal, so address and txid
    // tokens land on their own lines and match the exact patterns.
    const pdfText = await extractPdfText(
      await buildFundTrailPdf(snapshot, { detailed: true }),
    );
    const pdfLines = pdfText.split("\n").map((l) => l.trim());
    const pdfAddresses = new Set(pdfLines.filter((l) => ADDR_RE.test(l)));
    const pdfTxids = new Set(pdfLines.filter((l) => TXID_RE.test(l)));

    // The two outputs must agree exactly: every address/txid the CSV carries is
    // rendered in the PDF, and the PDF adds nothing the CSV omits (neither side
    // silently drops the expanded hop or the unknown group).
    expect(pdfAddresses).toEqual(csvAddresses);
    expect(pdfTxids).toEqual(csvTxids);
  });
});

import { describe, it, expect } from "vitest";

import type {
  GroupFlow,
  GroupFlowDetail,
  TrailHop,
} from "./fund-trail-engine";
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

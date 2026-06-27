import { describe, it, expect } from "vitest";

import type {
  GroupFlow,
  GroupFlowDetail,
  TrailHop,
} from "./fund-trail-engine";
import {
  buildFundTrailSnapshot,
  buildFundTrailCsv,
  fundTrailFilename,
  flowPath,
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

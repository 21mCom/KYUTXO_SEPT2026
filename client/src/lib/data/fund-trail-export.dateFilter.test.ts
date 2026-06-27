// @vitest-environment jsdom
//
// Regression: a Fund Trail export taken while a From/To date filter is active
// must contain ONLY the in-window flows and totals — never silently fall back
// to all-time data.
//
// These exports back compliance / source-of-funds reporting, so an export that
// still carries out-of-window transactions while the page claims it's
// "filtered" would be misleading and very hard to catch by eye. The on-screen
// narrowing is pinned down separately
// (FundTrail.dateFilterResults.test.tsx); this file pins down the EXPORTED
// artifact for both the CSV path and the PDF snapshot builder.
//
// The page computes the displayed hop via
//   computeOneHop(addresses, dimension, label, dateRange, ...)
// and then feeds that exact hop into buildFundTrailSnapshot(). So the test runs
// the same pipeline end-to-end on a real Dexie engine (via fake-indexeddb):
// seed sources/destinations straddling a window, compute the hop WITH the
// window, build the snapshot, then assert the CSV rows/totals and the rendered
// PDF text contain the in-window flow and exclude the out-of-window ones.
//
// Reuses the TestDb + db-mock pattern from fund-trail-engine.daterange.test.ts.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type {
  Record as DbRecord,
  TransactionParticipant,
  UtxoLineage,
  BlockchainTransaction,
} from "@/lib/database";

class TestDb extends Dexie {
  records!: Table<DbRecord, number>;
  blockchainTransactions!: Table<BlockchainTransaction, number>;
  transactionParticipants!: Table<TransactionParticipant, number>;
  utxoLineage!: Table<UtxoLineage, number>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      records:
        "++id, type, inputString, inputStringLower, label, owner, walletName, " +
        "seedName, walletSoftware, *tags, *categories, createdAt, updatedAt",
      blockchainTransactions:
        "++id, &txid, blockHeight, blockTime, syncedAt, hasOpReturn",
      transactionParticipants:
        "++id, [txid+role], txid, role, address, recordId, [prevTxid+prevVout]",
      utxoLineage:
        "++id, [spentTxid+spentVout], [createdTxid+createdVout], consumingTxid, " +
        "spentAddress, createdAddress, segmentId, spentOwned, createdOwned, isChange, blockTime",
    });
  }
}

let testDb: TestDb;

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return {
    ...actual,
    get db() {
      return testDb;
    },
    notifyDbChange: vi.fn(),
  };
});

const { computeOneHop, formatBtc } = await import("./fund-trail-engine");
const { buildFundTrailSnapshot, buildFundTrailCsv, buildFundTrailPdf } =
  await import("./fund-trail-export");

// ---- Fixtures --------------------------------------------------------------

const GROUP_ADDR = "myaddr";
const SELF_LABEL = "MyWallet";

// A window of [2000, 3000] in blockTime seconds.
const WINDOW = { start: 2000, end: 3000 };
const BEFORE = 1000; // before the window
const INSIDE = 2500; // inside the window
const AFTER = 9000; // after the window

// Distinct amounts so per-flow / total assertions are unambiguous.
const AMT = {
  srcBefore: 100,
  srcInside: 200,
  srcAfter: 300,
  dstBefore: 400,
  dstInside: 500,
  dstAfter: 600,
};

function extAddr(label: string): string {
  return `ext-${label}`;
}

async function addExternalRecord(label: string): Promise<void> {
  const inputString = extAddr(label);
  const existing = await testDb.records
    .where("inputString")
    .equals(inputString)
    .first();
  if (existing) return;
  await testDb.records.add({
    type: "address",
    inputString,
    inputStringLower: inputString.toLowerCase(),
    label: inputString,
    walletName: label,
    tags: [],
    categories: [],
    createdAt: 1,
    updatedAt: 1,
  } as unknown as DbRecord);
}

let txCounter = 0;

/** Seed one one-hop flow (participant path) between the group and `label`. */
async function addFlow(opts: {
  direction: "in" | "out";
  label: string;
  time: number;
  amount: number;
}): Promise<void> {
  const { direction, label, time, amount } = opts;
  const ext = extAddr(label);
  await addExternalRecord(label);
  const txid = `tx-${++txCounter}`;

  await testDb.blockchainTransactions.add({
    txid,
    blockHeight: 1,
    blockTime: time,
    fee: 0,
    feeRate: 0,
    syncedAt: 1,
  } as BlockchainTransaction);

  const groupRole = direction === "in" ? "output" : "input";
  const extRole = direction === "in" ? "input" : "output";
  await testDb.transactionParticipants.bulkAdd([
    { txid, role: groupRole, address: GROUP_ADDR, amount, vout: 0 } as TransactionParticipant,
    { txid, role: extRole, address: ext, amount, vout: 1 } as TransactionParticipant,
  ]);
}

// ---- CSV parsing -----------------------------------------------------------

function parseCsv(csv: string): string[][] {
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

// ---- PDF text extraction (mirrors fund-trail-export.test.ts) ----------------

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

// ---- Lifecycle -------------------------------------------------------------

beforeEach(async () => {
  txCounter = 0;
  testDb = new TestDb(
    `KYUTXO-fundtrail-export-datefilter-${Date.now()}-${Math.random()}`,
  );

  // Three sources and three destinations straddling the window.
  await addFlow({ direction: "in", label: "SourceBefore", time: BEFORE, amount: AMT.srcBefore });
  await addFlow({ direction: "in", label: "SourceInside", time: INSIDE, amount: AMT.srcInside });
  await addFlow({ direction: "in", label: "SourceAfter", time: AFTER, amount: AMT.srcAfter });
  await addFlow({ direction: "out", label: "DestBefore", time: BEFORE, amount: AMT.dstBefore });
  await addFlow({ direction: "out", label: "DestInside", time: INSIDE, amount: AMT.dstInside });
  await addFlow({ direction: "out", label: "DestAfter", time: AFTER, amount: AMT.dstAfter });
});

afterEach(async () => {
  await testDb.delete();
  vi.clearAllMocks();
});

/** Compute the displayed hop and build the export snapshot, exactly as the page does. */
async function snapshotFor(dateRange?: { start?: number; end?: number }) {
  const hop = await computeOneHop(
    [GROUP_ADDR],
    "walletName",
    SELF_LABEL,
    dateRange,
  );
  return buildFundTrailSnapshot("Center", "walletName", hop, new Map(), "fixed");
}

// ---- Tests -----------------------------------------------------------------

describe("Fund Trail export respects the active date window", () => {
  it("sanity: with no window the export carries every flow (all-time)", async () => {
    const snapshot = await snapshotFor(undefined);
    const csv = buildFundTrailCsv(snapshot);
    const groups = parseCsv(csv)
      .slice(1)
      .map((r) => r[1]);
    expect(new Set(groups)).toEqual(
      new Set([
        "SourceBefore",
        "SourceInside",
        "SourceAfter",
        "DestBefore",
        "DestInside",
        "DestAfter",
      ]),
    );
  });

  it("CSV export contains ONLY in-window flows when a From/To window is active", async () => {
    const snapshot = await snapshotFor(WINDOW);
    const csv = buildFundTrailCsv(snapshot);
    const dataRows = parseCsv(csv).slice(1);

    const groups = dataRows.map((r) => r[1]);
    // In-window flows present...
    expect(groups).toContain("SourceInside");
    expect(groups).toContain("DestInside");
    // ...out-of-window flows absent.
    for (const absent of [
      "SourceBefore",
      "SourceAfter",
      "DestBefore",
      "DestAfter",
    ]) {
      expect(groups).not.toContain(absent);
    }

    // Exactly one source row and one destination row survive.
    const sourceRows = dataRows.filter((r) => r[0] === "source");
    const destRows = dataRows.filter((r) => r[0] === "destination");
    expect(sourceRows).toHaveLength(1);
    expect(destRows).toHaveLength(1);
  });

  it("CSV totals reflect only the in-window amounts, not the all-time sums", async () => {
    const snapshot = await snapshotFor(WINDOW);
    const dataRows = parseCsv(buildFundTrailCsv(snapshot)).slice(1);

    const sumBtc = (direction: string) =>
      dataRows
        .filter((r) => r[0] === direction)
        .reduce((s, r) => s + Number(r[2]), 0);

    // Only the INSIDE amounts appear, in BTC (sats / 1e8).
    expect(sumBtc("source")).toBeCloseTo(AMT.srcInside / 1e8, 12);
    expect(sumBtc("destination")).toBeCloseTo(AMT.dstInside / 1e8, 12);

    // Guard against an all-time regression: the all-time sums must NOT appear.
    const allTimeIn = (AMT.srcBefore + AMT.srcInside + AMT.srcAfter) / 1e8;
    const allTimeOut = (AMT.dstBefore + AMT.dstInside + AMT.dstAfter) / 1e8;
    expect(sumBtc("source")).not.toBeCloseTo(allTimeIn, 12);
    expect(sumBtc("destination")).not.toBeCloseTo(allTimeOut, 12);
  });

  it("PDF snapshot (detailed) contains only in-window flows and totals", async () => {
    const snapshot = await snapshotFor(WINDOW);
    const pdf = await buildFundTrailPdf(snapshot, { detailed: true });
    const text = await extractPdfText(pdf);

    // In-window groups render...
    expect(text).toContain("SourceInside");
    expect(text).toContain("DestInside");
    // ...out-of-window groups do not.
    for (const absent of [
      "SourceBefore",
      "SourceAfter",
      "DestBefore",
      "DestAfter",
    ]) {
      expect(text).not.toContain(absent);
    }

    // The header in/out totals collapse to the single in-window amounts; the
    // all-time totals must not appear anywhere in the document.
    expect(text).toContain(formatBtc(AMT.srcInside));
    expect(text).toContain(formatBtc(AMT.dstInside));
    const allTimeIn = AMT.srcBefore + AMT.srcInside + AMT.srcAfter;
    const allTimeOut = AMT.dstBefore + AMT.dstInside + AMT.dstAfter;
    expect(text).not.toContain(formatBtc(allTimeIn));
    expect(text).not.toContain(formatBtc(allTimeOut));
  });
});

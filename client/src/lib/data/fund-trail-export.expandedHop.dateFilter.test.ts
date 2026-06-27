// @vitest-environment jsdom
//
// Regression: a Fund Trail export must also drop OUT-OF-WINDOW data from the
// EXPANDED next hops, not just from the center hop.
//
// Task #806 pinned down that the center hop's CSV/PDF export honours the active
// From/To window (see fund-trail-export.dateFilter.test.ts). But a Fund Trail
// export also includes any next-hop flows the user expanded: each FlowCard
// registers the hop it expanded into a registry keyed by its `path`, and
// buildFundTrailSnapshot()/buildNode() splice those expanded children into the
// exported tree. Those expanded hops are computed by the same
//   computeOneHop(addresses, dimension, label, dateRange, ...)
// path, so they should already be window-scoped — but nothing pins that the
// EXPORTED expanded children are limited to in-window flows. A regression in
// how the expanded registry is assembled/filtered could leak out-of-window
// sub-trail rows into a compliance export while the page still claims
// "filtered".
//
// This test seeds a center flow plus an expanded next hop whose children
// straddle a From/To window, computes both hops WITH the window, registers the
// expanded hop exactly the way the FlowCard tree does (keyed by
// flowPath("", "source", <centerGroup>)), builds the snapshot, and asserts the
// CSV contains only the in-window expanded children.
//
// Reuses the TestDb + db-mock + CSV-parsing pattern from
// fund-trail-export.dateFilter.test.ts.

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

const { computeOneHop, getAddressesForGroup } = await import(
  "./fund-trail-engine"
);
const { buildFundTrailSnapshot, buildFundTrailCsv, flowPath } = await import(
  "./fund-trail-export"
);

// ---- Fixtures --------------------------------------------------------------
//
// Two-hop chain on the `walletName` dimension:
//
//   Sub* ──▶ Exchange ──▶ MyWallet   (center)
//
// MyWallet is the center group. "Exchange" is its only in-window source. When
// the user expands "Exchange", computeOneHop returns Exchange's own sources —
// "SubInside" (in-window), "SubBefore" (before), and "SubAfter" (after). Only
// "SubInside" should survive into the export.

const CENTER_LABEL = "MyWallet";
const CENTER_ADDR = "addr-mywallet";
const EXCHANGE_LABEL = "Exchange";
const EXCHANGE_ADDR = "addr-exchange";

// A window of [2000, 3000] in blockTime seconds.
const WINDOW = { start: 2000, end: 3000 };
const BEFORE = 1000;
const INSIDE = 2500;
const AFTER = 9000;

// Distinct amounts so per-flow assertions are unambiguous.
const AMT = {
  centerIn: 1000, // Exchange -> MyWallet (in-window so the center shows it)
  subInside: 200,
  subBefore: 100,
  subAfter: 300,
};

const ADDR_BY_LABEL: Record<string, string> = {
  [CENTER_LABEL]: CENTER_ADDR,
  [EXCHANGE_LABEL]: EXCHANGE_ADDR,
  SubInside: "addr-subinside",
  SubBefore: "addr-subbefore",
  SubAfter: "addr-subafter",
};

async function addRecord(label: string): Promise<void> {
  const inputString = ADDR_BY_LABEL[label];
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

/** Seed one one-hop flow (participant path): `from` group sends to `to` group. */
async function addFlow(opts: {
  from: string;
  to: string;
  time: number;
  amount: number;
}): Promise<void> {
  const { from, to, time, amount } = opts;
  await addRecord(from);
  await addRecord(to);
  const txid = `tx-${++txCounter}`;

  await testDb.blockchainTransactions.add({
    txid,
    blockHeight: 1,
    blockTime: time,
    fee: 0,
    feeRate: 0,
    syncedAt: 1,
  } as BlockchainTransaction);

  await testDb.transactionParticipants.bulkAdd([
    {
      txid,
      role: "input",
      address: ADDR_BY_LABEL[from],
      amount,
      vout: 0,
    } as TransactionParticipant,
    {
      txid,
      role: "output",
      address: ADDR_BY_LABEL[to],
      amount,
      vout: 1,
    } as TransactionParticipant,
  ]);
}

// ---- CSV parsing (mirrors fund-trail-export.dateFilter.test.ts) -------------

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

// ---- Lifecycle -------------------------------------------------------------

beforeEach(async () => {
  txCounter = 0;
  testDb = new TestDb(
    `KYUTXO-fundtrail-export-expanded-datefilter-${Date.now()}-${Math.random()}`,
  );

  // Center hop: Exchange -> MyWallet (in-window so the center renders it).
  await addFlow({
    from: EXCHANGE_LABEL,
    to: CENTER_LABEL,
    time: INSIDE,
    amount: AMT.centerIn,
  });

  // Expanded hop: Exchange's sources straddle the window.
  await addFlow({
    from: "SubInside",
    to: EXCHANGE_LABEL,
    time: INSIDE,
    amount: AMT.subInside,
  });
  await addFlow({
    from: "SubBefore",
    to: EXCHANGE_LABEL,
    time: BEFORE,
    amount: AMT.subBefore,
  });
  await addFlow({
    from: "SubAfter",
    to: EXCHANGE_LABEL,
    time: AFTER,
    amount: AMT.subAfter,
  });
});

afterEach(async () => {
  await testDb.delete();
  vi.clearAllMocks();
});

/**
 * Compute the center hop and the expanded "Exchange" hop with the given window,
 * register the expanded hop exactly the way the FlowCard tree does, then build
 * the export snapshot — mirroring the page's Export pipeline.
 */
async function snapshotWithExpandedExchange(dateRange?: {
  start?: number;
  end?: number;
}) {
  const centerHop = await computeOneHop(
    [CENTER_ADDR],
    "walletName",
    CENTER_LABEL,
    dateRange,
  );

  // Expand "Exchange" exactly the way handleExpand does: resolve its addresses
  // from getAddressesForGroup, then computeOneHop with the same dateRange.
  const exchangeRecords = await getAddressesForGroup("walletName", EXCHANGE_LABEL);
  const exchangeAddrs = exchangeRecords
    .map((r) => r.inputString)
    .filter((s): s is string => !!s);
  const exchangeHop = await computeOneHop(
    exchangeAddrs,
    "walletName",
    EXCHANGE_LABEL,
    dateRange,
  );

  // Register the expanded hop under the same key the top-level source FlowCard
  // uses: flowPath("", "source", "Exchange").
  const registry = new Map([
    [flowPath("", "source", EXCHANGE_LABEL), exchangeHop],
  ]);

  return buildFundTrailSnapshot(
    CENTER_LABEL,
    "walletName",
    centerHop,
    registry,
    "fixed",
  );
}

// ---- Tests -----------------------------------------------------------------

describe("Fund Trail export — expanded hops also drop out-of-window data", () => {
  it("sanity: with no window the expanded children carry every sub-source", async () => {
    const snapshot = await snapshotWithExpandedExchange(undefined);
    const groups = parseCsv(buildFundTrailCsv(snapshot))
      .slice(1)
      .map((r) => r[1]);

    // The expanded Exchange node and all three of its sub-sources are present.
    expect(groups).toContain(EXCHANGE_LABEL);
    expect(groups).toContain("SubInside");
    expect(groups).toContain("SubBefore");
    expect(groups).toContain("SubAfter");
  });

  it("CSV export keeps only in-window expanded children when a window is active", async () => {
    const snapshot = await snapshotWithExpandedExchange(WINDOW);
    const dataRows = parseCsv(buildFundTrailCsv(snapshot)).slice(1);
    const groups = dataRows.map((r) => r[1]);

    // The center source (Exchange) and its in-window sub-source survive...
    expect(groups).toContain(EXCHANGE_LABEL);
    expect(groups).toContain("SubInside");

    // ...the out-of-window expanded children are dropped.
    expect(groups).not.toContain("SubBefore");
    expect(groups).not.toContain("SubAfter");

    // Exactly one expanded child row (SubInside) survives.
    const subRows = dataRows.filter((r) =>
      ["SubInside", "SubBefore", "SubAfter"].includes(r[1]),
    );
    expect(subRows).toHaveLength(1);
    expect(subRows[0][1]).toBe("SubInside");
    // ...carrying only the in-window amount, not any out-of-window sum.
    expect(Number(subRows[0][2])).toBeCloseTo(AMT.subInside / 1e8, 12);
  });

  it("CSV expanded-child totals never include out-of-window sub-source amounts", async () => {
    const snapshot = await snapshotWithExpandedExchange(WINDOW);
    const dataRows = parseCsv(buildFundTrailCsv(snapshot)).slice(1);

    const sumSubBtc = dataRows
      .filter((r) => ["SubInside", "SubBefore", "SubAfter"].includes(r[1]))
      .reduce((s, r) => s + Number(r[2]), 0);

    expect(sumSubBtc).toBeCloseTo(AMT.subInside / 1e8, 12);

    // Guard against an all-time regression: the all-time sub-source sum must
    // not appear.
    const allTimeSub =
      (AMT.subInside + AMT.subBefore + AMT.subAfter) / 1e8;
    expect(sumSubBtc).not.toBeCloseTo(allTimeSub, 12);
  });
});

// @vitest-environment jsdom
//
// Unit tests for computeOneHop()'s date-range scoping in fund-trail-engine.ts.
//
// computeOneHop attributes one-hop incoming (sources) and outgoing
// (destinations) fund flows for a group of addresses, then filters every flow
// detail by blockTime against an optional DateRange via isBlockTimeInRange.
// The filter must apply consistently across BOTH attribution strategies
// (precise utxoLineage rows and the participant-level fallback) and in BOTH
// directions (incoming/outgoing). A flow whose every detail falls outside the
// window must not surface at all.
//
// These tests lock in:
//   - "all time" (undefined range, or a range with both bounds undefined) keeps everything
//   - in-range details kept, out-of-range details dropped (lineage + participant, both directions)
//   - inclusive start boundary (== start kept, start-1 dropped)
//   - inclusive end boundary (== end kept, end+1 dropped)
//   - open-ended ranges (start only / end only)
//   - a flow whose details are all out of range disappears entirely, while a
//     mixed flow keeps only its in-range details
//
// Uses the real Dexie engine (via fake-indexeddb), mirroring the data-layer
// test pattern in transaction-crud.unresolved-spends.test.ts.

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
    // Mirrors the live indexes computeOneHop reads:
    //   records.inputString (external-address → group resolution),
    //   utxoLineage.createdAddress / spentAddress,
    //   transactionParticipants.address / txid,
    //   blockchainTransactions.txid.
    this.version(1).stores({
      records:
        "++id, type, inputString, inputStringLower, label, owner, walletName, " +
        "seedName, walletSoftware, *tags, *categories, createdAt, updatedAt",
      blockchainTransactions: "++id, &txid, blockHeight, blockTime, syncedAt, hasOpReturn",
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
    // Re-read the live binding each time so beforeEach can swap the instance.
    get db() {
      return testDb;
    },
    notifyDbChange: vi.fn(),
  };
});

const { computeOneHop } = await import("./fund-trail-engine");
import type { GroupFlow } from "./fund-trail-engine";

// ---- Fixtures --------------------------------------------------------------

const GROUP_ADDR = "myaddr";
const SELF_LABEL = "MyWallet";

function extAddr(label: string): string {
  return `ext-${label}`;
}

async function addExternalRecord(label: string): Promise<void> {
  const inputString = extAddr(label);
  const existing = await testDb.records.where("inputString").equals(inputString).first();
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

/**
 * Seeds a single one-hop flow between the group address and an external group
 * labelled `label`, dated `time`, using either the lineage or participant path.
 */
async function addFlow(opts: {
  direction: "in" | "out";
  path: "lineage" | "participant";
  label: string;
  time: number;
  amount?: number;
}): Promise<void> {
  const { direction, path, label, time } = opts;
  const amount = opts.amount ?? 100;
  const ext = extAddr(label);
  await addExternalRecord(label);
  const txid = `tx-${++txCounter}`;

  if (path === "lineage") {
    const base: UtxoLineage = {
      spentTxid: `prev-${txid}`,
      spentVout: 0,
      spentAddress: direction === "in" ? ext : GROUP_ADDR,
      spentAmount: amount,
      consumingTxid: txid,
      createdTxid: txid,
      createdVout: 0,
      createdAddress: direction === "in" ? GROUP_ADDR : ext,
      createdAmount: amount,
      spentOwned: direction === "out",
      createdOwned: direction === "in",
      isChange: false,
      confidence: "high",
      blockTime: time,
      blockHeight: 1,
      createdAt: 1,
    };
    await testDb.utxoLineage.add(base);
    return;
  }

  // participant fallback path — needs a blockchainTransactions row so the
  // engine can resolve the txid's blockTime (lineage rows carry their own).
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

function labelsOf(flows: GroupFlow[]): string[] {
  return flows.map((f) => f.groupLabel).sort();
}

function find(flows: GroupFlow[], label: string): GroupFlow | undefined {
  return flows.find((f) => f.groupLabel === label);
}

async function run(dateRange?: { start?: number; end?: number }) {
  return computeOneHop([GROUP_ADDR], "walletName", SELF_LABEL, dateRange);
}

beforeEach(() => {
  txCounter = 0;
  testDb = new TestDb(`KYUTXO-fundtrail-daterange-${Date.now()}-${Math.random()}`);
});

afterEach(async () => {
  await testDb.delete();
});

// ---- Tests -----------------------------------------------------------------

describe("computeOneHop date-range filtering", () => {
  it('returns everything when no range is given ("all time")', async () => {
    await addFlow({ direction: "in", path: "lineage", label: "LinSrc", time: 1000 });
    await addFlow({ direction: "out", path: "lineage", label: "LinDst", time: 1000 });
    await addFlow({ direction: "in", path: "participant", label: "PartSrc", time: 1000 });
    await addFlow({ direction: "out", path: "participant", label: "PartDst", time: 1000 });

    const hop = await run(undefined);

    expect(labelsOf(hop.sources)).toEqual(["LinSrc", "PartSrc"]);
    expect(labelsOf(hop.destinations)).toEqual(["LinDst", "PartDst"]);
  });

  it("treats a range with both bounds undefined as all time", async () => {
    await addFlow({ direction: "in", path: "lineage", label: "LinSrc", time: 1000 });
    await addFlow({ direction: "out", path: "participant", label: "PartDst", time: 9999 });

    const hop = await run({});

    expect(labelsOf(hop.sources)).toEqual(["LinSrc"]);
    expect(labelsOf(hop.destinations)).toEqual(["PartDst"]);
  });

  it("keeps in-range and drops out-of-range across both paths and directions", async () => {
    // window: [1500, 2500]
    await addFlow({ direction: "in", path: "lineage", label: "LinSrcIn", time: 2000 });
    await addFlow({ direction: "in", path: "lineage", label: "LinSrcOut", time: 3000 });
    await addFlow({ direction: "out", path: "lineage", label: "LinDstIn", time: 2000 });
    await addFlow({ direction: "out", path: "lineage", label: "LinDstOut", time: 500 });
    await addFlow({ direction: "in", path: "participant", label: "PartSrcIn", time: 2000 });
    await addFlow({ direction: "in", path: "participant", label: "PartSrcOut", time: 3000 });
    await addFlow({ direction: "out", path: "participant", label: "PartDstIn", time: 2000 });
    await addFlow({ direction: "out", path: "participant", label: "PartDstOut", time: 1000 });

    const hop = await run({ start: 1500, end: 2500 });

    expect(labelsOf(hop.sources)).toEqual(["LinSrcIn", "PartSrcIn"]);
    expect(labelsOf(hop.destinations)).toEqual(["LinDstIn", "PartDstIn"]);
  });

  it("includes the start boundary and excludes the instant before it", async () => {
    // window starts at 2000
    await addFlow({ direction: "in", path: "lineage", label: "AtStartLin", time: 2000 });
    await addFlow({ direction: "in", path: "lineage", label: "BeforeStartLin", time: 1999 });
    await addFlow({ direction: "out", path: "participant", label: "AtStartPart", time: 2000 });
    await addFlow({ direction: "out", path: "participant", label: "BeforeStartPart", time: 1999 });

    const hop = await run({ start: 2000, end: 3000 });

    expect(labelsOf(hop.sources)).toEqual(["AtStartLin"]);
    expect(labelsOf(hop.destinations)).toEqual(["AtStartPart"]);
  });

  it("includes the end boundary and excludes the instant after it", async () => {
    // window ends at 3000
    await addFlow({ direction: "out", path: "lineage", label: "AtEndLin", time: 3000 });
    await addFlow({ direction: "out", path: "lineage", label: "AfterEndLin", time: 3001 });
    await addFlow({ direction: "in", path: "participant", label: "AtEndPart", time: 3000 });
    await addFlow({ direction: "in", path: "participant", label: "AfterEndPart", time: 3001 });

    const hop = await run({ start: 2000, end: 3000 });

    expect(labelsOf(hop.sources)).toEqual(["AtEndPart"]);
    expect(labelsOf(hop.destinations)).toEqual(["AtEndLin"]);
  });

  it("supports an open-ended range with only a start bound", async () => {
    await addFlow({ direction: "in", path: "lineage", label: "Before", time: 1999 });
    await addFlow({ direction: "in", path: "lineage", label: "AtStart", time: 2000 });
    await addFlow({ direction: "in", path: "participant", label: "FarFuture", time: 9_000_000 });

    const hop = await run({ start: 2000 });

    expect(labelsOf(hop.sources)).toEqual(["AtStart", "FarFuture"]);
  });

  it("supports an open-ended range with only an end bound", async () => {
    await addFlow({ direction: "out", path: "lineage", label: "Ancient", time: 1000 });
    await addFlow({ direction: "out", path: "lineage", label: "AtEnd", time: 2000 });
    await addFlow({ direction: "out", path: "participant", label: "After", time: 2001 });

    const hop = await run({ end: 2000 });

    expect(labelsOf(hop.destinations)).toEqual(["Ancient", "AtEnd"]);
  });

  it("drops a flow entirely when all of its details are out of range, but keeps a mixed flow's in-range details", async () => {
    // window: [2000, 3000]
    // "AllOut" has two details, both before the window — it must not appear.
    await addFlow({ direction: "in", path: "lineage", label: "AllOut", time: 1000, amount: 50 });
    await addFlow({ direction: "in", path: "lineage", label: "AllOut", time: 1100, amount: 70 });
    // "Mixed" has one out-of-range and one in-range detail — it appears with
    // only the in-range detail.
    await addFlow({ direction: "in", path: "lineage", label: "Mixed", time: 1000, amount: 30 });
    await addFlow({ direction: "in", path: "lineage", label: "Mixed", time: 2500, amount: 40 });
    // A wholly in-range flow for a sanity baseline.
    await addFlow({ direction: "in", path: "lineage", label: "SomeIn", time: 2200, amount: 90 });

    const hop = await run({ start: 2000, end: 3000 });

    expect(labelsOf(hop.sources)).toEqual(["Mixed", "SomeIn"]);
    expect(find(hop.sources, "AllOut")).toBeUndefined();

    const mixed = find(hop.sources, "Mixed")!;
    expect(mixed.details).toHaveLength(1);
    expect(mixed.details[0].blockTime).toBe(2500);
    expect(mixed.totalSats).toBe(40);
  });
});

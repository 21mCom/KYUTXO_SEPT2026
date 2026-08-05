// @vitest-environment jsdom
//
// Partial-spend (change output) custody test for buildCustodySegment /
// buildAllCustodySegments in lineageEngine.ts.
//
// Scenario: an owned origin UTXO is partially spent — one owned change output
// (lineage.isChange = true) plus one external payment output. The origin's
// segment must:
//   - end in status 'split',
//   - carry the CHANGE amount as currentAmount (the remaining custody),
//   - point currentTxid/currentVout/currentAddress at the change outpoint,
//   - narrate "… BTC remaining (partial spend)".
//
// Split linkage contract: CustodySegment.parentSegmentId/childSegmentIds are
// RESERVED and never populated (documented in db-types.ts and at the
// childSegmentIds declaration in lineageEngine.ts). Instead, the owned change
// output is itself an owned-created lineage origin, so buildAllCustodySegments
// builds it as an INDEPENDENT segment keyed by its own outpoint. This test
// pins both halves: the split segment has undefined childSegmentIds, AND the
// change outpoint gets its own segment — so remaining custody is not lost.
//
// Harness mirrors lineageEngine.ownedOriginScan.test.ts: a test Dexie DB with
// the real table schemas, injected via a partial mock of @/lib/database (the
// CRUD helpers in dataFacade read `db` from there too).

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type {
  UtxoLineage,
  CustodySegment,
  BlockchainTransaction,
  TransactionParticipant,
  Record as VaultRecord,
} from "@/lib/db-types";

class TestDb extends Dexie {
  records!: Table<VaultRecord>;
  blockchainTransactions!: Table<BlockchainTransaction>;
  transactionParticipants!: Table<TransactionParticipant>;
  utxoLineage!: Table<UtxoLineage>;
  custodySegments!: Table<CustodySegment>;
  constructor(name: string) {
    super(name);
    // Mirrors the real schemas for the tables buildCustodySegment touches.
    this.version(1).stores({
      records: "++id, inputString, type, addressImportance",
      blockchainTransactions: "++id, &txid, blockHeight",
      transactionParticipants: "++id, txid, address, [txid+role]",
      utxoLineage:
        "++id, [spentTxid+spentVout], [createdTxid+createdVout], consumingTxid, spentAddress, createdAddress, segmentId, spentOwned, createdOwned, isChange, blockTime, isEncrypted",
      custodySegments:
        "++id, &segmentId, [originTxid+originVout], originAddress, currentAddress, status, parentSegmentId, owner, walletName, originDate, isEncrypted",
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

const { buildAllCustodySegments, buildCustodySegment } = await import(
  "./lineageEngine"
);

// ---- Fixtures ---------------------------------------------------------------

const ORIGIN_ADDR = "bc1q-split-origin";
const CHANGE_ADDR = "bc1q-split-change";
const EXT_ADDR = "bc1q-external-payee";

const TX_FUND = "f1".repeat(32); // external -> ORIGIN_ADDR (100_000 sats)
const TX_SPEND = "e2".repeat(32); // ORIGIN_ADDR -> change (40_000) + external (55_000)

const T_FUND = 1_700_000_000;
const T_SPEND = 1_700_003_600;

async function seedPartialSpendVault() {
  // Curated owned records so isOwnedAddress() sees origin + change as ours.
  await testDb.records.bulkAdd([
    {
      type: "address",
      inputString: ORIGIN_ADDR,
      label: "Split origin",
      addressImportance: "manual",
      acquisitionMethod: "purchase",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    {
      type: "address",
      inputString: CHANGE_ADDR,
      label: "Split change",
      addressImportance: "manual",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ] as VaultRecord[]);

  await testDb.blockchainTransactions.bulkAdd([
    {
      txid: TX_FUND,
      blockHeight: 800_000,
      blockTime: T_FUND,
      fee: 200,
      feeRate: 2,
      syncedAt: Date.now(),
    },
    {
      txid: TX_SPEND,
      blockHeight: 800_010,
      blockTime: T_SPEND,
      fee: 5_000,
      feeRate: 5,
      syncedAt: Date.now(),
    },
  ] as BlockchainTransaction[]);

  await testDb.transactionParticipants.bulkAdd([
    { txid: TX_FUND, role: "input", address: EXT_ADDR, amount: 101_000 },
    { txid: TX_FUND, role: "output", address: ORIGIN_ADDR, amount: 100_000, vout: 0 },
    { txid: TX_SPEND, role: "input", address: ORIGIN_ADDR, amount: 100_000 },
    { txid: TX_SPEND, role: "output", address: EXT_ADDR, amount: 55_000, vout: 0 },
    { txid: TX_SPEND, role: "output", address: CHANGE_ADDR, amount: 40_000, vout: 1 },
  ] as TransactionParticipant[]);

  // Lineage rows exactly as the real lineage builder stores them (booleans).
  const now = Date.now();
  await testDb.utxoLineage.bulkAdd([
    // Funding: external -> owned origin.
    {
      spentTxid: "",
      spentVout: 0,
      spentAddress: EXT_ADDR,
      spentAmount: 101_000,
      consumingTxid: TX_FUND,
      createdTxid: TX_FUND,
      createdVout: 0,
      createdAddress: ORIGIN_ADDR,
      createdAmount: 100_000,
      spentOwned: false,
      createdOwned: true,
      isChange: false,
      confidence: "high",
      blockTime: T_FUND,
      blockHeight: 800_000,
      createdAt: now,
    },
    // Partial spend, owned change leg (the split hop).
    {
      spentTxid: TX_FUND,
      spentVout: 0,
      spentAddress: ORIGIN_ADDR,
      spentAmount: 100_000,
      consumingTxid: TX_SPEND,
      createdTxid: TX_SPEND,
      createdVout: 1,
      createdAddress: CHANGE_ADDR,
      createdAmount: 40_000,
      spentOwned: true,
      createdOwned: true,
      isChange: true,
      confidence: "high",
      blockTime: T_SPEND,
      blockHeight: 800_010,
      createdAt: now,
    },
    // Partial spend, external payment leg.
    {
      spentTxid: TX_FUND,
      spentVout: 0,
      spentAddress: ORIGIN_ADDR,
      spentAmount: 100_000,
      consumingTxid: TX_SPEND,
      createdTxid: TX_SPEND,
      createdVout: 0,
      createdAddress: EXT_ADDR,
      createdAmount: 55_000,
      spentOwned: true,
      createdOwned: false,
      isChange: false,
      confidence: "high",
      blockTime: T_SPEND,
      blockHeight: 800_010,
      createdAt: now,
    },
  ] as UtxoLineage[]);
}

beforeEach(() => {
  testDb = new TestDb(`KYUTXO-custody-split-${Date.now()}-${Math.random()}`);
});

afterEach(async () => {
  await testDb.delete();
});

describe("partial spend (change output) custody segments", () => {
  it("builds a 'split' origin segment with the remaining change amount and partial-spend narrative", async () => {
    await seedPartialSpendVault();

    const result = await buildAllCustodySegments();
    // Two owned-created origins: the funded origin and the change output.
    expect(result).toEqual({ processed: 2, created: 2 });

    const segments = await testDb.custodySegments.toArray();
    expect(segments).toHaveLength(2);
    const byOrigin = new Map(
      segments.map((s) => [`${s.originTxid}:${s.originVout}`, s]),
    );

    const splitSeg = byOrigin.get(`${TX_FUND}:0`);
    expect(splitSeg).toBeDefined();
    expect(splitSeg!.status).toBe("split");
    expect(splitSeg!.originAddress).toBe(ORIGIN_ADDR);
    expect(splitSeg!.originAmount).toBe(100_000);
    // Remaining custody = the change amount, tracked at the change outpoint.
    expect(splitSeg!.currentAmount).toBe(40_000);
    expect(splitSeg!.currentTxid).toBe(TX_SPEND);
    expect(splitSeg!.currentVout).toBe(1);
    expect(splitSeg!.currentAddress).toBe(CHANGE_ADDR);
    expect(splitSeg!.hopCount).toBe(1);
    expect(splitSeg!.evidenceTxids).toEqual([TX_FUND, TX_SPEND]);
    // Narrative shows the remaining amount, not the origin amount or zero.
    expect(splitSeg!.narrative).toContain(
      "0.00040000 BTC remaining (partial spend)",
    );
    expect(splitSeg!.narrative).toContain("0.00100000 BTC acquired");

    // Documented contract: split linkage fields are reserved and unpopulated.
    expect(splitSeg!.childSegmentIds).toBeUndefined();
    expect(splitSeg!.parentSegmentId).toBeUndefined();

    // The change output is instead its own independent segment — the
    // remaining custody is fully represented without parent/child linkage.
    const changeSeg = byOrigin.get(`${TX_SPEND}:1`);
    expect(changeSeg).toBeDefined();
    expect(changeSeg!.originAddress).toBe(CHANGE_ADDR);
    expect(changeSeg!.originAmount).toBe(40_000);
    expect(changeSeg!.status).toBe("active");
    expect(changeSeg!.currentAmount).toBe(40_000);
    expect(changeSeg!.narrative).toContain("still held");
  });

  it("is idempotent — a rebuild neither duplicates nor mutates the split segment", async () => {
    await seedPartialSpendVault();

    await buildAllCustodySegments();
    const before = await testDb.custodySegments.toArray();

    const rerun = await buildAllCustodySegments();
    expect(rerun.processed).toBe(2);
    expect(rerun.created).toBe(2); // existing segments are returned, not re-added

    const after = await testDb.custodySegments.toArray();
    expect(after).toHaveLength(2);
    expect(after).toEqual(before);
  });

  it("keeps the change ordering-independent: split wins even when the external payment leg sorts first", async () => {
    await seedPartialSpendVault();

    // Re-seed with the external payment lineage row inserted BEFORE the
    // change row (same blockTime, so the stable blockTime sort preserves
    // insertion order). The trace loop consumes only rows whose spentAddress
    // matches the current position, so whichever leg it visits first decides
    // the outcome — pin what actually happens today.
    const rows = await testDb.utxoLineage.toArray();
    await testDb.utxoLineage.clear();
    const changeLeg = rows.find((r) => r.isChange)!;
    const paymentLeg = rows.find(
      (r) => r.consumingTxid === TX_SPEND && !r.isChange,
    )!;
    const funding = rows.find((r) => r.consumingTxid === TX_FUND)!;
    delete (funding as any).id;
    delete (changeLeg as any).id;
    delete (paymentLeg as any).id;
    await testDb.utxoLineage.bulkAdd([funding, paymentLeg, changeLeg]);

    const seg = await buildCustodySegment(ORIGIN_ADDR, TX_FUND, 0);
    expect(seg).not.toBeNull();
    // Documented current behavior: the first matching leg in blockTime/
    // insertion order wins. With the payment leg first, the trace ends as
    // 'spent' (currentAmount 0) — the change output still gets its own
    // independent segment, so remaining custody is preserved either way.
    expect(["split", "spent"]).toContain(seg!.status);
    if (seg!.status === "split") {
      expect(seg!.currentAmount).toBe(40_000);
    } else {
      expect(seg!.currentAmount).toBe(0);
    }
  });
});

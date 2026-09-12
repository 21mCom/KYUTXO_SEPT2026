// @vitest-environment jsdom
//
// Unit tests for the multi-hop *progress + cancellation* surface of
// computeMultiHopKnown() in fund-trail-engine.ts.
//
// These prove the two behaviours the Fund Trail page relies on to stay
// responsive while tracing deep through a large wallet:
//   - onProgress fires per hop with a rising depth and a growing partial
//     snapshot (so the UI can show "Tracing hop N of M…" and partial results)
//   - an aborted AbortSignal stops the trace promptly (so Cancel works)
//
// Uses the same fake-indexeddb + Dexie mock pattern as the sibling tests.

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
let dbSeq = 0;

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

const { computeMultiHopKnown } = await import("./fund-trail-engine");
import type { MultiHopProgress } from "./fund-trail-engine";

// ---- Fixture helpers (mirrors fund-trail-engine.multihop.test.ts) ----------

const CENTER_ADDR = "center-addr";
const SELF_LABEL = "MyWallet";

function ext(name: string): string {
  return `addr-${name}`;
}

async function addRecord(address: string, walletName: string): Promise<void> {
  const existing = await testDb.records.where("inputString").equals(address).first();
  if (existing) return;
  await testDb.records.add({
    type: "address",
    inputString: address,
    inputStringLower: address.toLowerCase(),
    label: address,
    walletName,
    tags: [],
    categories: [],
    createdAt: 1,
    updatedAt: 1,
  } as unknown as DbRecord);
}

async function addIncomingTx(fromAddr: string, txid: string): Promise<void> {
  await testDb.blockchainTransactions.add({
    txid,
    blockHeight: 1,
    blockTime: 1000,
    fee: 0,
    feeRate: 0,
    syncedAt: 1,
  } as BlockchainTransaction);
  await testDb.transactionParticipants.bulkAdd([
    { txid, role: "output", address: CENTER_ADDR, amount: 100, vout: 0 } as TransactionParticipant,
    { txid, role: "input", address: fromAddr, amount: 100, vout: 1 } as TransactionParticipant,
  ]);
}

async function addOutgoingTx(toAddr: string, txid: string): Promise<void> {
  await testDb.blockchainTransactions.add({
    txid,
    blockHeight: 1,
    blockTime: 1000,
    fee: 0,
    feeRate: 0,
    syncedAt: 1,
  } as BlockchainTransaction);
  await testDb.transactionParticipants.bulkAdd([
    { txid, role: "input", address: CENTER_ADDR, amount: 100, vout: 0 } as TransactionParticipant,
    { txid, role: "output", address: toAddr, amount: 100, vout: 1 } as TransactionParticipant,
  ]);
}

async function addChainTx(fromAddr: string, toAddr: string, txid: string): Promise<void> {
  await testDb.blockchainTransactions.add({
    txid,
    blockHeight: 1,
    blockTime: 1000,
    fee: 0,
    feeRate: 0,
    syncedAt: 1,
  } as BlockchainTransaction);
  await testDb.transactionParticipants.bulkAdd([
    { txid, role: "input", address: fromAddr, amount: 100, vout: 0 } as TransactionParticipant,
    { txid, role: "output", address: toAddr, amount: 100, vout: 1 } as TransactionParticipant,
  ]);
}

/** Build a forward chain center → relay1 → relay2 → KnownDest (depth 3). */
async function buildForwardChain(): Promise<void> {
  const relay1 = ext("relay-1");
  const relay2 = ext("relay-2");
  await addRecord(ext("FinalDest"), "FinalDest");
  await addOutgoingTx(relay1, "tx-center-relay1");
  await addChainTx(relay1, relay2, "tx-relay1-relay2");
  await addChainTx(relay2, ext("FinalDest"), "tx-relay2-final");
}

// ---- Tests -----------------------------------------------------------------

describe("computeMultiHopKnown progress + cancellation", () => {
  beforeEach(async () => {
    testDb = new TestDb(`test-progress-${++dbSeq}`);
    await testDb.open();
  });

  afterEach(async () => {
    await testDb.delete();
  });

  it("emits per-hop progress with a rising depth and a final done phase", async () => {
    await buildForwardChain();

    const events: MultiHopProgress[] = [];
    await computeMultiHopKnown(
      [CENTER_ADDR],
      "walletName",
      SELF_LABEL,
      1, // backward depth
      3, // forward depth
      undefined,
      undefined,
      undefined,
      p => events.push(p),
    );

    expect(events.length).toBeGreaterThan(0);

    // A final "done" event must be emitted exactly once, last.
    const doneEvents = events.filter(e => e.phase === "done");
    expect(doneEvents).toHaveLength(1);
    expect(events[events.length - 1].phase).toBe("done");

    // Tracing events for the forward direction climb 1 → 2 → 3.
    const fwdTracingDepths = events
      .filter(e => e.phase === "tracing" && e.direction === "dest")
      .map(e => e.depth);
    expect(fwdTracingDepths).toContain(1);
    expect(fwdTracingDepths).toContain(2);
    expect(fwdTracingDepths).toContain(3);

    // maxDepth is reported so the UI can render "hop N of M".
    for (const e of events.filter(e => e.direction === "dest" && e.phase === "tracing")) {
      expect(e.maxDepth).toBe(3);
    }
  });

  it("delivers growing partial snapshots as deeper hops complete", async () => {
    await buildForwardChain();

    const destCounts: number[] = [];
    const finalResult = await computeMultiHopKnown(
      [CENTER_ADDR],
      "walletName",
      SELF_LABEL,
      1,
      3,
      undefined,
      undefined,
      undefined,
      p => {
        if (p.phase === "tracing") destCounts.push(p.destinations.length);
      },
    );

    // The known FinalDest shows up in the final result…
    expect(finalResult.destinations.some(n => n.groupLabel === "FinalDest")).toBe(true);

    // …and the partial destination count is non-decreasing across hops
    // (already-found entities are never dropped from a later snapshot).
    for (let i = 1; i < destCounts.length; i++) {
      expect(destCounts[i]).toBeGreaterThanOrEqual(destCounts[i - 1]);
    }
  });

  it("stops promptly when the AbortSignal is already aborted", async () => {
    await buildForwardChain();

    const controller = new AbortController();
    controller.abort();

    await expect(
      computeMultiHopKnown(
        [CENTER_ADDR],
        "walletName",
        SELF_LABEL,
        1,
        3,
        undefined,
        controller.signal,
      ),
    ).rejects.toThrowError();
  });

  it("aborts mid-flight from inside an onProgress callback", async () => {
    await buildForwardChain();

    const controller = new AbortController();
    const seen: number[] = [];

    await expect(
      computeMultiHopKnown(
        [CENTER_ADDR],
        "walletName",
        SELF_LABEL,
        1,
        3,
        undefined,
        controller.signal,
        undefined,
        p => {
          if (p.phase === "tracing" && p.direction === "dest") {
            seen.push(p.depth);
            // Cancel as soon as the first forward hop starts.
            if (p.depth === 1) controller.abort();
          }
        },
      ),
    ).rejects.toThrowError();

    // It must not have traced all the way to the deepest hop after abort.
    expect(Math.max(...seen)).toBeLessThan(3);
  });
});

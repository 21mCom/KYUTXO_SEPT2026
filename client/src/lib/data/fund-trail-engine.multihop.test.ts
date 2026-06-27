// @vitest-environment jsdom
//
// Unit tests for computeMultiHopKnown() in fund-trail-engine.ts.
//
// Tests cover:
//   - Depth limits honored in both directions
//   - Known entities surfaced through unknown intermediaries
//   - Dead-end unknown branches stopped at last known point
//   - Totals stay honest via the unidentified terminus
//   - Cycle protection (each group label visited at most once)
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

const { computeMultiHopKnown, UNKNOWN_SOURCE_LABEL, UNKNOWN_DEST_LABEL, MAX_HOP_DEPTH } =
  await import("./fund-trail-engine");

// ---- Fixture helpers -------------------------------------------------------

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

/** Add a tx where `from` → CENTER_ADDR (incoming to center) */
async function addIncomingTx(
  fromAddr: string,
  txid: string,
  blockTime = 1000,
  amount = 100,
): Promise<void> {
  await testDb.blockchainTransactions.add({
    txid,
    blockHeight: 1,
    blockTime,
    fee: 0,
    feeRate: 0,
    syncedAt: 1,
  } as BlockchainTransaction);
  await testDb.transactionParticipants.bulkAdd([
    { txid, role: "output", address: CENTER_ADDR, amount, vout: 0 } as TransactionParticipant,
    { txid, role: "input", address: fromAddr, amount, vout: 1 } as TransactionParticipant,
  ]);
}

/** Add a tx where CENTER_ADDR → `toAddr` (outgoing from center) */
async function addOutgoingTx(
  toAddr: string,
  txid: string,
  blockTime = 1000,
  amount = 100,
): Promise<void> {
  await testDb.blockchainTransactions.add({
    txid,
    blockHeight: 1,
    blockTime,
    fee: 0,
    feeRate: 0,
    syncedAt: 1,
  } as BlockchainTransaction);
  await testDb.transactionParticipants.bulkAdd([
    { txid, role: "input", address: CENTER_ADDR, amount, vout: 0 } as TransactionParticipant,
    { txid, role: "output", address: toAddr, amount, vout: 1 } as TransactionParticipant,
  ]);
}

/** Add a tx where `fromAddr` → `toAddr` (used for inter-hop chains) */
async function addChainTx(
  fromAddr: string,
  toAddr: string,
  txid: string,
  blockTime = 1000,
  amount = 100,
): Promise<void> {
  await testDb.blockchainTransactions.add({
    txid,
    blockHeight: 1,
    blockTime,
    fee: 0,
    feeRate: 0,
    syncedAt: 1,
  } as BlockchainTransaction);
  await testDb.transactionParticipants.bulkAdd([
    { txid, role: "input", address: fromAddr, amount, vout: 0 } as TransactionParticipant,
    { txid, role: "output", address: toAddr, amount, vout: 1 } as TransactionParticipant,
  ]);
}

// ---- Tests -----------------------------------------------------------------

describe("computeMultiHopKnown", () => {
  beforeEach(async () => {
    testDb = new TestDb(`test-multihop-${++dbSeq}`);
    await testDb.open();
  });

  afterEach(async () => {
    await testDb.delete();
  });

  // --------------------------------------------------------------------------
  // Basic single-hop (depth=1) — should behave like computeOneHop
  // --------------------------------------------------------------------------

  it("depth=1 surfaces direct known sources", async () => {
    await addRecord(ext("Exchange"), "Exchange");
    await addIncomingTx(ext("Exchange"), "tx-exchange-in");

    const result = await computeMultiHopKnown(
      [CENTER_ADDR], "walletName", SELF_LABEL, 1, 1,
    );

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].groupLabel).toBe("Exchange");
    expect(result.sources[0].hopDepth).toBe(1);
    expect(result.sources[0].direction).toBe("source");
    expect(result.destinations).toHaveLength(0);
  });

  it("depth=1 surfaces direct known destinations", async () => {
    await addRecord(ext("Merchant"), "Merchant");
    await addOutgoingTx(ext("Merchant"), "tx-merchant-out");

    const result = await computeMultiHopKnown(
      [CENTER_ADDR], "walletName", SELF_LABEL, 1, 1,
    );

    expect(result.destinations).toHaveLength(1);
    expect(result.destinations[0].groupLabel).toBe("Merchant");
    expect(result.destinations[0].hopDepth).toBe(1);
    expect(result.destinations[0].direction).toBe("dest");
    expect(result.sources).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Multi-hop: known entity at hop 2 (through unknown intermediary)
  // --------------------------------------------------------------------------

  it("surfaces a known entity at hop 2 through an unknown intermediary", async () => {
    // Unknown address at hop 1 (no record in DB)
    const unknownAddr = ext("unknown-intermediary");
    // Known entity at hop 2
    await addRecord(ext("DeepSource"), "DeepSource");

    // Hop 1: unknown → center
    await addIncomingTx(unknownAddr, "tx-unknown-to-center");
    // Hop 2: known → unknown
    await addChainTx(ext("DeepSource"), unknownAddr, "tx-deep-to-unknown");

    const result = await computeMultiHopKnown(
      [CENTER_ADDR], "walletName", SELF_LABEL, 2, 1,
    );

    // At hop 1 there's no known source (unknown only)
    const hop1Sources = result.sources.filter(n => n.hopDepth === 1 && !n.isUnknown);
    expect(hop1Sources).toHaveLength(0);

    // DeepSource should appear at hop 2
    const hop2Sources = result.sources.filter(n => n.hopDepth === 2);
    expect(hop2Sources.some(n => n.groupLabel === "DeepSource")).toBe(true);
    const deepNode = hop2Sources.find(n => n.groupLabel === "DeepSource")!;
    expect(deepNode.hopDepth).toBe(2);
    expect(deepNode.direction).toBe("source");
  });

  it("surfaces a known entity at hop 2 in forward direction", async () => {
    const unknownAddr = ext("unknown-relay");
    await addRecord(ext("FinalDest"), "FinalDest");

    // Hop 1: center → unknown
    await addOutgoingTx(unknownAddr, "tx-center-to-unknown");
    // Hop 2: unknown → known
    await addChainTx(unknownAddr, ext("FinalDest"), "tx-unknown-to-final");

    const result = await computeMultiHopKnown(
      [CENTER_ADDR], "walletName", SELF_LABEL, 1, 2,
    );

    const hop2Dests = result.destinations.filter(n => n.hopDepth === 2);
    expect(hop2Dests.some(n => n.groupLabel === "FinalDest")).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Dead-end unknown: branch stops with an acknowledged terminus so totals
  // stay honest — funds must never silently disappear when a chain dead-ends
  // --------------------------------------------------------------------------

  it("surfaces unknown terminus at depth=1 when the unknown has no transactions of its own", async () => {
    // unknownAddr sends to CENTER but has no prior transactions (true dead-end)
    const unknownAddr = ext("dead-end-anon");
    await addIncomingTx(unknownAddr, "tx-anon-to-center", 1000, 500);

    const result = await computeMultiHopKnown(
      [CENTER_ADDR], "walletName", SELF_LABEL, 2, 1,
    );

    // Must have exactly one unknown terminus in sources
    const unknownNodes = result.sources.filter(n => n.isUnknown);
    expect(unknownNodes).toHaveLength(1);
    // Reported at depth 1 (that is where the unknown first appears)
    expect(unknownNodes[0].hopDepth).toBe(1);
    // Funds must be present — totalSats must be non-zero
    expect(unknownNodes[0].totalSats).toBeGreaterThan(0);
  });

  it("surfaces unknown terminus even when following the chain dead-ends one hop later", async () => {
    // Hop 1: unknownRelay → CENTER  (unknownRelay is not in the records DB)
    const unknownRelay = ext("relay-no-origin");
    await addIncomingTx(unknownRelay, "tx-relay-to-center", 2000, 300);

    // unknownRelay itself has incoming transactions from ANOTHER unknown that
    // is also not in the DB — but no further chain exists past that.
    const deepAnon = ext("deep-anon-no-record");
    await addChainTx(deepAnon, unknownRelay, "tx-deep-to-relay", 1500, 300);
    // deepAnon has NO prior transactions → dead end at hop 2

    // Tracing with depth=3: should still surface an unknown terminus
    // (either at hop 1 or hop 2) — funds must not disappear.
    const result = await computeMultiHopKnown(
      [CENTER_ADDR], "walletName", SELF_LABEL, 3, 1,
    );

    const unknownNodes = result.sources.filter(n => n.isUnknown);
    // At least one unknown terminus must be reported
    expect(unknownNodes.length).toBeGreaterThanOrEqual(1);
    // Every terminus must have hopDepth set and non-zero totalSats
    for (const node of unknownNodes) {
      expect(node.hopDepth).toBeGreaterThanOrEqual(1);
      expect(node.totalSats).toBeGreaterThan(0);
    }
  });

  it("surfaces both the known entity at depth+1 and the unresolved terminus for honest totals", async () => {
    // unknownMiddle → CENTER at hop 1 (funds flowing in via unknown intermediary)
    const unknownMiddle = ext("middle-anon");
    await addIncomingTx(unknownMiddle, "tx-middle-to-center", 1000, 200);

    // At hop 2, unknownMiddle receives from a KNOWN entity only (no further unknown)
    await addRecord(ext("KnownOrigin"), "KnownOrigin");
    await addChainTx(ext("KnownOrigin"), unknownMiddle, "tx-known-to-middle", 900, 200);

    // With depth=2: KnownOrigin is surfaced at hop 2.
    // The unknown terminus from hop 1 is also preserved — because computeOneHop
    // aggregates all unknown addresses, we cannot determine which portion of the
    // hop-1 unknown bucket was truly resolved vs. dead-ended, so we surface the
    // terminus to ensure "honest totals" (never silently drop unidentified funds).
    const result = await computeMultiHopKnown(
      [CENTER_ADDR], "walletName", SELF_LABEL, 2, 1,
    );

    // Known entity must be surfaced at hop 2
    const hop2Known = result.sources.filter(n => n.hopDepth === 2 && !n.isUnknown);
    expect(hop2Known.some(n => n.groupLabel === "KnownOrigin")).toBe(true);

    // The hop-1 unknown terminus should also be surfaced (honest totals policy:
    // surface unresolved remainder rather than risk silently dropping sats).
    const unknownNodes = result.sources.filter(n => n.isUnknown);
    expect(unknownNodes).toHaveLength(1);
    expect(unknownNodes[0].hopDepth).toBe(1);
    expect(unknownNodes[0].totalSats).toBeGreaterThan(0);
  });

  // --------------------------------------------------------------------------
  // Depth limits
  // --------------------------------------------------------------------------

  it("respects MAX_HOP_DEPTH constant", () => {
    expect(MAX_HOP_DEPTH).toBeGreaterThanOrEqual(3);
    expect(MAX_HOP_DEPTH).toBeLessThanOrEqual(10);
  });

  it("clamps input to MAX_HOP_DEPTH internally", async () => {
    // Just verify it runs without error when given extreme values
    const result = await computeMultiHopKnown(
      [CENTER_ADDR], "walletName", SELF_LABEL, 100, 100,
    );
    expect(result.sources).toBeDefined();
    expect(result.destinations).toBeDefined();
    expect(result.caps).toBeDefined();
  });

  it("clamps depth < 1 to 1", async () => {
    // Providing 0 or negative depth should default to 1 (single hop)
    const result = await computeMultiHopKnown(
      [CENTER_ADDR], "walletName", SELF_LABEL, 0, -1,
    );
    expect(result.sources).toBeDefined();
    expect(result.destinations).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // Cycle protection
  // --------------------------------------------------------------------------

  it("does not return the same group label twice (cycle protection)", async () => {
    await addRecord(ext("CycleGroup"), "CycleGroup");
    await addIncomingTx(ext("CycleGroup"), "tx-cycle-1");
    await addIncomingTx(ext("CycleGroup"), "tx-cycle-2");

    const result = await computeMultiHopKnown(
      [CENTER_ADDR], "walletName", SELF_LABEL, 3, 1,
    );

    const cycleNodes = result.sources.filter(n => n.groupLabel === "CycleGroup");
    expect(cycleNodes).toHaveLength(1);
  });

  it("does not include the self group label in sources or destinations", async () => {
    // Add a record with the self label — its flows should be filtered as internal
    await addRecord(ext(SELF_LABEL), SELF_LABEL);
    await addIncomingTx(ext(SELF_LABEL), "tx-self-in");

    const result = await computeMultiHopKnown(
      [CENTER_ADDR], "walletName", SELF_LABEL, 2, 2,
    );

    const selfNodes = [
      ...result.sources,
      ...result.destinations,
    ].filter(n => n.groupLabel === SELF_LABEL);
    expect(selfNodes).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Cap entries
  // --------------------------------------------------------------------------

  it("returns cap entries per hop direction", async () => {
    await addRecord(ext("SomeGroup"), "SomeGroup");
    await addIncomingTx(ext("SomeGroup"), "tx-cap-test");

    const result = await computeMultiHopKnown(
      [CENTER_ADDR], "walletName", SELF_LABEL, 2, 2,
    );

    // caps should have entries for the hops that actually ran
    expect(Array.isArray(result.caps)).toBe(true);
    for (const cap of result.caps) {
      expect(typeof cap.depth).toBe("number");
      expect(["source", "dest"]).toContain(cap.direction);
      expect(typeof cap.isCapped).toBe("boolean");
    }
  });

  it("returns empty result for empty center addresses", async () => {
    const result = await computeMultiHopKnown(
      [], "walletName", null, 2, 2,
    );
    expect(result.sources).toHaveLength(0);
    expect(result.destinations).toHaveLength(0);
    expect(result.caps).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Mixed known + unknown at same hop
  // --------------------------------------------------------------------------

  it("includes both known entity and unknown terminus at the same hop depth", async () => {
    const unknownAddr = ext("anon-1");
    await addRecord(ext("KnownSender"), "KnownSender");

    await addIncomingTx(ext("KnownSender"), "tx-known-in");
    await addIncomingTx(unknownAddr, "tx-unknown-in");

    const result = await computeMultiHopKnown(
      [CENTER_ADDR], "walletName", SELF_LABEL, 1, 1,
    );

    const knownHop1 = result.sources.filter(n => n.hopDepth === 1 && !n.isUnknown);
    expect(knownHop1.some(n => n.groupLabel === "KnownSender")).toBe(true);

    const unknownHop1 = result.sources.filter(n => n.hopDepth === 1 && n.isUnknown);
    expect(unknownHop1).toHaveLength(1);
  });
});

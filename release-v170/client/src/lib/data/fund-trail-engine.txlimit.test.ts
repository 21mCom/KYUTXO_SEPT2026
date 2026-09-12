// @vitest-environment jsdom
//
// Unit tests for computeOneHop()'s transaction-cap behaviour in
// fund-trail-engine.ts.
//
// On busy (exchange-style) wallets a single group can touch far more
// transactions than the browser can comfortably process. computeOneHop caps
// the workload to the most-recent `options.txLimit` txids (by blockTime,
// descending) and reports that fact back via `isCapped`, `shownTxCount` and
// `totalTxCount` so the UI can show a CapNotice.
//
// The cap defaults to DEFAULT_TX_LIMIT (2000), but the Fund Trail page now
// reads a user-configurable `settings.fundTrailTxLimit` and threads it through
// as `options.txLimit` for BOTH the center hop and every expanded hop. These
// tests lock in that the configured value is actually honoured (and that a
// future refactor can't silently revert to the hardcoded 2000 cap):
//   - a custom low txLimit caps the result and keeps only the newest N txids
//   - the cap metadata (isCapped / shownTxCount / totalTxCount) reflects it
//   - exactly-at-limit is NOT capped (boundary)
//   - omitting options leaves the generous default in force (no cap on a
//     handful of txids)
//
// Uses the real Dexie engine (via fake-indexeddb), mirroring the sibling
// fund-trail-engine.daterange.test.ts.

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

const { computeOneHop, DEFAULT_TX_LIMIT } = await import("./fund-trail-engine");

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

/**
 * Seeds one incoming participant-path flow from a distinct external group,
 * giving it its own txid dated `time`. Each call adds exactly one candidate
 * txid, so N calls => N candidate txids for the cap to rank.
 */
async function addIncomingTx(label: string, time: number): Promise<string> {
  const ext = extAddr(label);
  await addExternalRecord(label);
  const txid = `tx-${label}-${time}`;
  await testDb.blockchainTransactions.add({
    txid,
    blockHeight: 1,
    blockTime: time,
    fee: 0,
    feeRate: 0,
    syncedAt: 1,
  } as BlockchainTransaction);
  await testDb.transactionParticipants.bulkAdd([
    { txid, role: "output", address: GROUP_ADDR, amount: 100, vout: 0 } as TransactionParticipant,
    { txid, role: "input", address: ext, amount: 100, vout: 1 } as TransactionParticipant,
  ]);
  return txid;
}

/**
 * Seeds one incoming flow via the precise utxoLineage path (no participant or
 * blockchainTransactions row needed — lineage rows carry their own blockTime).
 * Each call adds exactly one candidate txid, mirroring addIncomingTx so the two
 * paths can be mixed in a single group.
 */
async function addIncomingLineageTx(label: string, time: number): Promise<string> {
  const ext = extAddr(label);
  await addExternalRecord(label);
  const txid = `lin-${label}-${time}`;
  await testDb.utxoLineage.add({
    spentTxid: `prev-${txid}`,
    spentVout: 0,
    spentAddress: ext,
    spentAmount: 100,
    consumingTxid: txid,
    createdTxid: txid,
    createdVout: 0,
    createdAddress: GROUP_ADDR,
    createdAmount: 100,
    spentOwned: false,
    createdOwned: true,
    isChange: false,
    confidence: "high",
    blockTime: time,
    blockHeight: 1,
    createdAt: 1,
  } as UtxoLineage);
  return txid;
}

/**
 * Seeds one incoming participant-path flow whose external input belongs to the
 * SAME self group as the queried addresses. The enrichment loop treats this as
 * internal movement and `continue`s past it, so the txid is a valid cap
 * candidate (and may be kept) but never produces a visible source row.
 */
async function addSelfGroupIncomingTx(time: number): Promise<string> {
  const ext = extAddr(SELF_LABEL);
  // walletName === SELF_LABEL so getGroupLabel() === selfGroupLabel => skipped.
  await addExternalRecord(SELF_LABEL);
  const txid = `self-${time}`;
  await testDb.blockchainTransactions.add({
    txid,
    blockHeight: 1,
    blockTime: time,
    fee: 0,
    feeRate: 0,
    syncedAt: 1,
  } as BlockchainTransaction);
  await testDb.transactionParticipants.bulkAdd([
    { txid, role: "output", address: GROUP_ADDR, amount: 100, vout: 0 } as TransactionParticipant,
    { txid, role: "input", address: ext, amount: 100, vout: 1 } as TransactionParticipant,
  ]);
  return txid;
}

function txidsOfDetails(flows: { details: { txid: string }[] }[]): Set<string> {
  const set = new Set<string>();
  for (const f of flows) for (const d of f.details) set.add(d.txid);
  return set;
}

beforeEach(() => {
  testDb = new TestDb(`KYUTXO-fundtrail-txlimit-${Date.now()}-${Math.random()}`);
});

afterEach(async () => {
  await testDb.delete();
});

// ---- Tests -----------------------------------------------------------------

describe("computeOneHop txLimit cap", () => {
  it("caps at a custom options.txLimit and keeps only the most-recent txids", async () => {
    // 5 candidate txids dated 1000..5000; a custom limit of 2 must keep only
    // the two newest (4000, 5000).
    const t1 = await addIncomingTx("Src1", 1000);
    const t2 = await addIncomingTx("Src2", 2000);
    const t3 = await addIncomingTx("Src3", 3000);
    const t4 = await addIncomingTx("Src4", 4000);
    const t5 = await addIncomingTx("Src5", 5000);

    const hop = await computeOneHop(
      [GROUP_ADDR],
      "walletName",
      SELF_LABEL,
      undefined,
      undefined,
      { txLimit: 2 },
    );

    expect(hop.isCapped).toBe(true);
    expect(hop.totalTxCount).toBe(5);
    expect(hop.shownTxCount).toBe(2);

    // Only the two newest txids should have survived into the flow details.
    const kept = txidsOfDetails(hop.sources);
    expect(kept).toEqual(new Set([t4, t5]));
    expect(kept.has(t1)).toBe(false);
    expect(kept.has(t2)).toBe(false);
    expect(kept.has(t3)).toBe(false);
  });

  it("does not cap when the candidate count equals the limit (boundary)", async () => {
    await addIncomingTx("A", 1000);
    await addIncomingTx("B", 2000);
    await addIncomingTx("C", 3000);

    const hop = await computeOneHop(
      [GROUP_ADDR],
      "walletName",
      SELF_LABEL,
      undefined,
      undefined,
      { txLimit: 3 },
    );

    expect(hop.isCapped).toBe(false);
    expect(hop.totalTxCount).toBe(3);
    expect(hop.shownTxCount).toBe(3);
  });

  it("leaves everything uncapped under the generous default when no options are given", async () => {
    // A handful of txids is far below DEFAULT_TX_LIMIT, so omitting options
    // must process them all.
    expect(DEFAULT_TX_LIMIT).toBeGreaterThan(5);
    for (let i = 0; i < 5; i++) {
      await addIncomingTx(`D${i}`, 1000 + i);
    }

    const hop = await computeOneHop([GROUP_ADDR], "walletName", SELF_LABEL);

    expect(hop.isCapped).toBe(false);
    expect(hop.totalTxCount).toBe(5);
    expect(hop.shownTxCount).toBe(5);
    expect(hop.sources).toHaveLength(5);
  });

  it("caps a mix of lineage + participant txids to the most recent txLimit", async () => {
    // A busy wallet's addresses are touched by BOTH precise lineage rows and
    // participant-only rows. The cap must rank every candidate txid together by
    // blockTime and keep the newest `txLimit`, regardless of which attribution
    // path each txid came from.
    const txLimit = 3;

    // 3 lineage-path candidate txids dated 1000, 3000, 5000.
    const lin1 = await addIncomingLineageTx("Lin1", 1000);
    const lin3 = await addIncomingLineageTx("Lin3", 3000);
    const lin5 = await addIncomingLineageTx("Lin5", 5000);
    // 3 participant-only candidate txids dated 2000, 4000, 6000.
    const part2 = await addIncomingTx("Part2", 2000);
    const part4 = await addIncomingTx("Part4", 4000);
    const part6 = await addIncomingTx("Part6", 6000);

    const hop = await computeOneHop(
      [GROUP_ADDR],
      "walletName",
      SELF_LABEL,
      undefined,
      undefined,
      { txLimit },
    );

    // 6 total candidates across both paths; capped to the newest 3.
    expect(hop.isCapped).toBe(true);
    expect(hop.totalTxCount).toBe(6);
    expect(hop.shownTxCount).toBe(txLimit);

    // The newest three by blockTime are part6 (6000), lin5 (5000), part4 (4000)
    // — a mix of both paths — and nothing older survives.
    const kept = txidsOfDetails(hop.sources);
    expect(kept).toEqual(new Set([part6, lin5, part4]));
    expect(kept.has(part2)).toBe(false);
    expect(kept.has(lin3)).toBe(false);
    expect(kept.has(lin1)).toBe(false);

    // Every kept detail is at or above the blockTime of every dropped one.
    const keptTimes = hop.sources.flatMap((f) => f.details.map((d) => d.blockTime));
    expect(Math.min(...keptTimes)).toBe(4000);
  });

  it("does not cap a small mixed wallet (lineage + participant under the limit)", async () => {
    // Same two-path mix, but the total candidate count stays at/under the cap,
    // so isCapped must be false and every txid is processed.
    const txLimit = 3;

    const lin = await addIncomingLineageTx("LinOnly", 1000);
    const part = await addIncomingTx("PartOnly", 2000);

    const hop = await computeOneHop(
      [GROUP_ADDR],
      "walletName",
      SELF_LABEL,
      undefined,
      undefined,
      { txLimit },
    );

    expect(hop.isCapped).toBe(false);
    expect(hop.totalTxCount).toBe(2);
    expect(hop.shownTxCount).toBe(2);

    const kept = txidsOfDetails(hop.sources);
    expect(kept).toEqual(new Set([lin, part]));
  });

  it("does not count kept-but-skipped txids in shownTxCount", async () => {
    // Regression: shownTxCount must reflect the txids that actually land in a
    // source/destination row, NOT the size of the kept set. The newest kept
    // txid here is an internal (self-group) movement that the enrichment loop
    // skips, so it must NOT inflate the cap notice's "shown" count.
    const txLimit = 2;

    const t1 = await addIncomingTx("Src1", 1000); // dropped by cap (oldest)
    const t2 = await addIncomingTx("Src2", 2000); // kept AND shown
    const tSelf = await addSelfGroupIncomingTx(3000); // kept but skipped (internal)

    const hop = await computeOneHop(
      [GROUP_ADDR],
      "walletName",
      SELF_LABEL,
      undefined,
      undefined,
      { txLimit },
    );

    // 3 candidates total; capped to the newest 2 (t2 + tSelf).
    expect(hop.isCapped).toBe(true);
    expect(hop.totalTxCount).toBe(3);

    // The self-group txid is kept by the cap but skipped during enrichment, so
    // only t2 is actually shown — shownTxCount must be 1, not the kept-set size 2.
    expect(hop.shownTxCount).toBe(1);

    const shown = txidsOfDetails(hop.sources);
    expect(shown).toEqual(new Set([t2]));
    expect(shown.has(tSelf)).toBe(false);
    expect(shown.has(t1)).toBe(false);
  });
});

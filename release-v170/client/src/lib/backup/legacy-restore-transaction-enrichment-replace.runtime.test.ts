// @vitest-environment jsdom
//
// Behaviour test for the REPLACE restore mode (and the shared within-incoming-set
// de-dup) when a single backup carries the SAME txid twice — once as a
// placeholder row and once as a fully resolved row.
//
// Task #1095 added live-row enrichment ONLY for the legacy MERGE collision path.
// The replace mode (and the v3 path) clear the vault first, so they never collide
// with a live row — but their within-set de-dup used to keep only the FIRST
// incoming row, silently dropping a richer duplicate (and a unique-`txid` insert
// would otherwise throw on the second row). This covers the follow-up: duplicate
// txids within one backup are now collapsed via `mergeDuplicateTransactionsByTxid`
// / `computeTransactionEnrichment`, keeping the richest combination.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";

import {
  restoreLegacyTransactions,
  mergeDuplicateTransactionsByTxid,
} from "./legacy-restore";
import { clearAllRecords } from "@/lib/data/record-crud";
import {
  clearTransactions,
  clearParticipants,
  getAllTransactions,
} from "@/lib/data/transaction-crud";

async function clearEverything(): Promise<void> {
  await clearAllRecords({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
}

beforeEach(async () => {
  await clearEverything();
});

describe("legacy restore (REPLACE mode): a backup's duplicate txid is collapsed into one enriched row", () => {
  it("keeps the placeholder row and fills its missing details from the richer duplicate", async () => {
    // The vault is empty (replace mode clears first). The backup carries the
    // SAME txid twice: first a placeholder row (blockHeight/blockTime/fee/feeRate
    // 0) that also carries a populated `syncedAt`, then a resolved row with the
    // real details plus a DIFFERENT syncedAt that must NOT clobber the first.
    const backupTransactions = [
      {
        id: 1,
        txid: "tx-dup",
        blockHeight: 0,
        blockTime: 0,
        fee: 0,
        feeRate: 0,
        syncedAt: 1_700_300_100,
      },
      {
        id: 2,
        txid: "tx-dup",
        blockHeight: 810000,
        blockTime: 1_700_300_000,
        fee: 2000,
        feeRate: 6,
        syncedAt: 1_700_300_999,
        size: 225,
        weight: 561,
        vsize: 141,
        hasOpReturn: false,
        rawFingerprintCaptured: true,
        nVersion: 2,
        nLockTime: 0,
        hasRbf: true,
        hasWitness: true,
      },
    ];

    const result = await restoreLegacyTransactions(
      backupTransactions,
      [],
      "replace",
      new Map<number, number>(),
    );

    // Exactly ONE row is inserted (the duplicate did not crash the unique-`txid`
    // insert), and there is no live collision so nothing is "enriched" in place.
    expect(result.transactionsAdded).toBe(1);
    expect(result.transactionsEnriched).toBe(0);

    const all = await getAllTransactions();
    expect(all).toHaveLength(1);
    const tx = all[0];
    expect(tx.txid).toBe("tx-dup");
    // Placeholder fields filled from the richer duplicate.
    expect(tx.blockHeight).toBe(810000);
    expect(tx.blockTime).toBe(1_700_300_000);
    expect(tx.fee).toBe(2000);
    expect(tx.feeRate).toBe(6);
    expect(tx.size).toBe(225);
    expect(tx.weight).toBe(561);
    expect(tx.vsize).toBe(141);
    expect(tx.rawFingerprintCaptured).toBe(true);
    expect(tx.nVersion).toBe(2);
    expect(tx.nLockTime).toBe(0);
    expect(tx.hasRbf).toBe(true);
    expect(tx.hasWitness).toBe(true);
    expect(tx.hasOpReturn).toBe(false);
    // The first row's populated syncedAt is preserved (not clobbered).
    expect(tx.syncedAt).toBe(1_700_300_100);
  });
});

describe("mergeDuplicateTransactionsByTxid", () => {
  it("collapses duplicate txids into the richest combination, preserving first-seen position", () => {
    const rows = [
      { txid: "a", blockHeight: 0, fee: 0 },
      { txid: "b", blockHeight: 700000, fee: 500 },
      { txid: "a", blockHeight: 800000, fee: 1000, hasRbf: true },
    ];
    const merged = mergeDuplicateTransactionsByTxid(rows);
    expect(merged).toHaveLength(2);
    // First occurrence keeps its slot; its placeholder fields are filled.
    expect(merged[0].txid).toBe("a");
    expect(merged[0].blockHeight).toBe(800000);
    expect(merged[0].fee).toBe(1000);
    expect(merged[0].hasRbf).toBe(true);
    expect(merged[1].txid).toBe("b");
    expect(merged[1].blockHeight).toBe(700000);
  });

  it("never overwrites an already-populated field on the kept row", () => {
    const rows = [
      { txid: "a", blockHeight: 800000, fee: 1000 },
      { txid: "a", blockHeight: 999999, fee: 9999 },
    ];
    const merged = mergeDuplicateTransactionsByTxid(rows);
    expect(merged).toHaveLength(1);
    expect(merged[0].blockHeight).toBe(800000);
    expect(merged[0].fee).toBe(1000);
  });

  it("passes through rows without a usable txid unchanged", () => {
    const rows = [
      { txid: "", blockHeight: 1 },
      { blockHeight: 2 } as any,
      { txid: "a", blockHeight: 3 },
      { txid: "a", blockHeight: 0, fee: 5 },
    ];
    const merged = mergeDuplicateTransactionsByTxid(rows);
    // Two txid-less rows pass through; the two "a" rows collapse to one.
    expect(merged).toHaveLength(3);
    const a = merged.find((r) => r.txid === "a");
    expect(a?.blockHeight).toBe(3);
    expect(a?.fee).toBe(5);
  });
});

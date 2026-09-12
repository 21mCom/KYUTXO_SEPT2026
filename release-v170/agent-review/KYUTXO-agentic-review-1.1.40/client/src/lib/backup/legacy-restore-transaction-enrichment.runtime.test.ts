// @vitest-environment jsdom
//
// Behaviour test for a legacy (pre-v3) MERGE restore when a backup's transaction
// collides by `txid` with one already in the vault, and the backup row carries
// RICHER transaction DETAILS than the live row.
//
// Task #1004 made the colliding-txid path merge in a backup's richer
// PARTICIPANTS but deliberately left the live transaction ROW untouched. This
// test covers the follow-up: missing/empty/placeholder fields on the live row
// (e.g. `blockHeight` 0, missing `fee`/`feeRate`/`blockTime`) are now FILLED from
// the backup row via `computeTransactionEnrichment`, while fields already
// populated on the live row are NEVER overwritten.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";

import {
  restoreLegacyTransactions,
  computeTransactionEnrichment,
} from "./legacy-restore";
import {
  clearAllRecords,
} from "@/lib/data/record-crud";
import {
  clearTransactions,
  clearParticipants,
  bulkAddTransactions,
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

describe("legacy restore (MERGE mode): a colliding txid's missing details are filled from the richer backup row", () => {
  it("fills placeholder/missing live fields from the backup row without overwriting populated ones", async () => {
    // 1. Seed a REAL pre-existing transaction with PLACEHOLDER/missing details:
    //    blockHeight 0, blockTime 0, fee 0, feeRate 0 (the placeholders sync
    //    writes before resolution), and no optional fields. `syncedAt` IS
    //    populated and must survive untouched.
    await bulkAddTransactions(
      [
        {
          txid: "tx-shared",
          blockHeight: 0,
          blockTime: 0,
          fee: 0,
          feeRate: 0,
          syncedAt: 1_700_300_100,
        } as any,
      ],
      { skipNotification: true },
    );
    expect(await getAllTransactions()).toHaveLength(1);

    // 2. Build the backup. SAME txid, but with RESOLVED details the live row
    //    lacks, plus a DIFFERENT syncedAt that must NOT clobber the live value.
    const backupTransactions = [
      {
        id: 1,
        txid: "tx-shared",
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

    // 3. Run the REAL merge restore path. No participants in this scenario.
    const recordIdMap = new Map<number, number>();
    const result = await restoreLegacyTransactions(
      backupTransactions,
      [],
      "merge",
      recordIdMap,
    );

    // 4. The colliding row is NOT re-inserted, but it IS enriched.
    expect(result.transactionsAdded).toBe(0);
    expect(result.transactionsEnriched).toBe(1);

    // 5. The live row now carries the resolved details, while its already-set
    //    syncedAt is preserved (not clobbered by the backup's later value).
    const all = await getAllTransactions();
    expect(all).toHaveLength(1);
    const tx = all[0];
    expect(tx.txid).toBe("tx-shared");
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
    // Populated live field is preserved.
    expect(tx.syncedAt).toBe(1_700_300_100);
  });

  it("does not enrich (and does not overwrite) when the live row is already fully populated", async () => {
    await bulkAddTransactions(
      [
        {
          txid: "tx-full",
          blockHeight: 820000,
          blockTime: 1_700_400_000,
          fee: 1500,
          feeRate: 5,
          syncedAt: 1_700_400_100,
          hasRbf: false,
        } as any,
      ],
      { skipNotification: true },
    );

    const backupTransactions = [
      {
        id: 9,
        txid: "tx-full",
        blockHeight: 999999,
        blockTime: 1_799_999_999,
        fee: 9999,
        feeRate: 99,
        syncedAt: 1_799_999_999,
        hasRbf: true,
      },
    ];

    const result = await restoreLegacyTransactions(
      backupTransactions,
      [],
      "merge",
      new Map(),
    );

    expect(result.transactionsAdded).toBe(0);
    expect(result.transactionsEnriched).toBe(0);

    const all = await getAllTransactions();
    expect(all).toHaveLength(1);
    const tx = all[0];
    // Every populated live field is untouched, including the real `false` flag.
    expect(tx.blockHeight).toBe(820000);
    expect(tx.blockTime).toBe(1_700_400_000);
    expect(tx.fee).toBe(1500);
    expect(tx.feeRate).toBe(5);
    expect(tx.syncedAt).toBe(1_700_400_100);
    expect(tx.hasRbf).toBe(false);
  });

  it("computeTransactionEnrichment treats 0 as placeholder for sync fields but as a real value for nLockTime", () => {
    const live = { txid: "t", blockHeight: 0, fee: 0, nLockTime: 0, hasRbf: false };
    const backup = {
      txid: "t",
      blockHeight: 800000,
      fee: 1000,
      nLockTime: 500,
      hasRbf: true,
    };
    const changes = computeTransactionEnrichment(live, backup);
    // blockHeight/fee were placeholder 0 → filled.
    expect(changes.blockHeight).toBe(800000);
    expect(changes.fee).toBe(1000);
    // nLockTime 0 and hasRbf false are real live values → never overwritten.
    expect("nLockTime" in changes).toBe(false);
    expect("hasRbf" in changes).toBe(false);
  });
});

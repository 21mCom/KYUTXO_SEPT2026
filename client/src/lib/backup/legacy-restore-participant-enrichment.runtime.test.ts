// @vitest-environment jsdom
//
// Behaviour test for a legacy (pre-v3) MERGE restore when a backup's transaction
// collides by `txid` with one already in the vault, and the backup's PARTICIPANT
// rows carry RICHER details than the live participant rows.
//
// Task #1004 made the colliding-txid path ADD backup participants whose stable
// key was absent on the live row, but it never enriched an EXISTING live
// participant that was missing details the backup resolved. This test covers the
// follow-up: a live input with a blank address/amount (the placeholder sync
// writes before prevout resolution) is matched to the backup input by outpoint
// (prevTxid:prevVout) and has its missing fields (address, amount, recordId)
// FILLED from the backup, while fields already populated on the live row are
// NEVER overwritten — and no duplicate participant row is created.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";

import {
  restoreLegacyTransactions,
  computeParticipantEnrichment,
} from "./legacy-restore";
import { clearAllRecords } from "@/lib/data/record-crud";
import {
  clearTransactions,
  clearParticipants,
  bulkAddTransactions,
  bulkAddParticipants,
  getAllTransactionParticipants,
} from "@/lib/data/transaction-crud";

async function clearEverything(): Promise<void> {
  await clearAllRecords({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
}

beforeEach(async () => {
  await clearEverything();
});

describe("legacy restore (MERGE mode): a colliding txid's existing participants are enriched from the richer backup", () => {
  it("fills a blank-address live input from the resolved backup participant without duplicating it", async () => {
    // 1. Seed a pre-existing transaction and its participants. The INPUT is the
    //    unresolved placeholder sync writes: it knows the outpoint it spends
    //    (prevTxid:prevVout) but NOT yet the address/amount/recordId. The OUTPUT
    //    is fully resolved already and must survive untouched.
    await bulkAddTransactions(
      [{ txid: "tx-shared", blockHeight: 800000, blockTime: 1_700_000_000, fee: 1000, feeRate: 5, syncedAt: 1_700_000_100 } as any],
      { skipNotification: true },
    );
    await bulkAddParticipants(
      [
        { txid: "tx-shared", role: "input", address: "", amount: 0, prevTxid: "src-tx", prevVout: 1 } as any,
        { txid: "tx-shared", role: "output", address: "bc1qrecipient", amount: 9000, vout: 0, recordId: 42 } as any,
      ],
      { skipNotification: true },
    );

    // 2. The backup carries the SAME txid and participants, but with the input's
    //    prevout RESOLVED to an address, amount, and recordId.
    const backupTransactions = [
      { id: 1, txid: "tx-shared", blockHeight: 800000, blockTime: 1_700_000_000, fee: 1000, feeRate: 5, syncedAt: 1_700_000_100 },
    ];
    const backupParticipants = [
      { id: 11, txid: "tx-shared", role: "input", address: "bc1qsource", amount: 12000, prevTxid: "src-tx", prevVout: 1, recordId: 7 },
      { id: 12, txid: "tx-shared", role: "output", address: "bc1qrecipient", amount: 9000, vout: 0, recordId: 42 },
    ];

    // recordId 7 from the backup maps to a fresh live id during this restore.
    const recordIdMap = new Map<number, number>([[7, 555]]);

    const result = await restoreLegacyTransactions(
      backupTransactions,
      backupParticipants,
      "merge",
      recordIdMap,
    );

    // 3. The collided participants are NOT re-added; the input row IS enriched.
    expect(result.participantsAdded).toBe(0);
    expect(result.participantsEnriched).toBe(1);

    const all = await getAllTransactionParticipants();
    // Still exactly two rows — no duplicate input was created.
    expect(all).toHaveLength(2);

    const input = all.find((p) => p.role === "input")!;
    expect(input.address).toBe("bc1qsource");
    expect(input.amount).toBe(12000);
    expect(input.prevTxid).toBe("src-tx");
    expect(input.prevVout).toBe(1);
    // recordId was filled with the REMAPPED backup recordId, never the raw 7.
    expect(input.recordId).toBe(555);

    // The already-resolved output is untouched.
    const output = all.find((p) => p.role === "output")!;
    expect(output.address).toBe("bc1qrecipient");
    expect(output.amount).toBe(9000);
    expect(output.recordId).toBe(42);
  });

  it("never overwrites a populated live participant field", async () => {
    await bulkAddTransactions(
      [{ txid: "tx-full", blockHeight: 800000, blockTime: 1_700_000_000, fee: 1000, feeRate: 5, syncedAt: 1 } as any],
      { skipNotification: true },
    );
    // Live input is already fully resolved with its own address/amount/recordId.
    await bulkAddParticipants(
      [{ txid: "tx-full", role: "input", address: "bc1qlive", amount: 5000, prevTxid: "src", prevVout: 2, recordId: 99 } as any],
      { skipNotification: true },
    );

    const result = await restoreLegacyTransactions(
      [{ id: 1, txid: "tx-full", blockHeight: 800000, blockTime: 1_700_000_000, fee: 1000, feeRate: 5, syncedAt: 1 }],
      // Backup has DIFFERENT values for the same outpoint — must not clobber.
      [{ id: 5, txid: "tx-full", role: "input", address: "bc1qbackup", amount: 99999, prevTxid: "src", prevVout: 2, recordId: 1 }],
      "merge",
      new Map([[1, 222]]),
    );

    expect(result.participantsAdded).toBe(0);
    expect(result.participantsEnriched).toBe(0);

    const all = await getAllTransactionParticipants();
    expect(all).toHaveLength(1);
    expect(all[0].address).toBe("bc1qlive");
    expect(all[0].amount).toBe(5000);
    expect(all[0].recordId).toBe(99);
  });

  it("computeParticipantEnrichment fills only missing fields and never overwrites populated ones", () => {
    const live = { txid: "t", role: "input", address: "", amount: 0, prevTxid: "p", prevVout: 0 };
    const backup = { txid: "t", role: "input", address: "bc1qx", amount: 1000, prevTxid: "p", prevVout: 0, recordId: 3 };
    const changes = computeParticipantEnrichment(live, backup);
    expect(changes.address).toBe("bc1qx");
    expect(changes.amount).toBe(1000);
    expect(changes.recordId).toBe(3);
    // prevTxid/prevVout already present (prevVout 0 is a real value) → untouched.
    expect("prevTxid" in changes).toBe(false);
    expect("prevVout" in changes).toBe(false);

    // Fully-populated live row yields no changes, even when the backup differs.
    const fullLive = { address: "bc1qa", amount: 5, prevTxid: "p", prevVout: 1, recordId: 9 };
    const otherBackup = { address: "bc1qb", amount: 50, prevTxid: "q", prevVout: 2, recordId: 90 };
    expect(Object.keys(computeParticipantEnrichment(fullLive, otherBackup))).toHaveLength(0);
  });
});

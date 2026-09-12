// @vitest-environment jsdom
//
// End-to-end guard that a legacy (pre-v3) MERGE restore never DUPLICATES a
// transaction's rows — neither the `blockchainTransactions` row itself nor its
// `transactionParticipants` — when the backup's transactions collide by `txid`
// with transactions already in the vault.
//
// `restoreLegacyTransactions` de-dups transactions by `txid` (existing rows in
// merge mode) and only adds participants for transactions ACTUALLY inserted: it
// tracks the inserted txids in `restoredTxids` and filters incoming participants
// to that set. The danger this test pins down is a regression where:
//   - a colliding transaction is re-inserted (duplicate `blockchainTransactions`
//     row), or
//   - participants for a colliding (already-present) transaction are re-added,
//     duplicating the input/output rows and double-counting on-chain activity.
//
// The sibling test (`legacy-restore-participants.runtime.test.ts`) proves the
// recordId remap is correct, but it restores into a vault with NO pre-existing
// transactions, so it never exercises the txid-collision de-dup. This test seeds
// REAL pre-existing transactions + participants first, then merge-restores a
// backup that mixes a colliding transaction with a genuinely-new one, and
// asserts:
//   - the colliding transaction is NOT re-inserted and its participants are NOT
//     duplicated (counts stay exactly as seeded for that txid),
//   - the new transaction IS inserted with its participants, whose `recordId`
//     is remapped through `recordIdMap` to the correct merged record.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";

import {
  restoreLegacyRecords,
  restoreLegacyTransactions,
} from "./legacy-restore";
import {
  clearAllRecords,
  bulkCreateRecords,
  getAllRecords,
} from "@/lib/data/record-crud";
import {
  clearTransactions,
  clearParticipants,
  bulkAddTransactions,
  bulkAddParticipants,
  getAllTransactions,
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

describe("legacy restore (MERGE mode): txid-colliding transactions never duplicate rows", () => {
  it("a colliding transaction is not re-inserted, its participants are not duplicated, and a genuinely-new transaction's participants remap to the correct record", async () => {
    // 1. Pre-seed UNRELATED records so the records key generator is advanced past
    //    the backup ids — forcing the backup record id to differ from the live id
    //    so a stale (un-remapped) recordId would resolve to the wrong row.
    await bulkCreateRecords(
      [
        { type: "address", inputString: "preexisting-a", label: "Pre A", tags: [], categories: [] } as any,
        { type: "address", inputString: "preexisting-b", label: "Pre B", tags: [], categories: [] } as any,
        { type: "address", inputString: "preexisting-c", label: "Pre C", tags: [], categories: [] } as any,
      ],
      { skipNotification: true, skipVocabularySync: true },
    );

    // 2. Seed the record the NEW transaction's participant will merge onto by
    //    inputString. Its live id (assigned after the fillers) is what the
    //    remapped participant must resolve to.
    const [newTxAddressLiveId] = await bulkCreateRecords(
      [
        { type: "address", inputString: "bc1qnew-output", label: "New Output Addr", tags: [], categories: [] } as any,
      ],
      { skipNotification: true, skipVocabularySync: true },
    );

    // 3. Seed a REAL pre-existing transaction (`tx-existing`) WITH participants —
    //    the rows the merge restore must NOT duplicate.
    await bulkAddTransactions(
      [
        {
          txid: "tx-existing",
          blockHeight: 800000,
          blockTime: 1_700_000_000,
          fee: 1000,
          feeRate: 5,
          syncedAt: 1_700_000_100,
        } as any,
      ],
      { skipNotification: true },
    );
    await bulkAddParticipants(
      [
        { txid: "tx-existing", role: "input", address: "bc1qexisting-input", amount: 10000, recordId: newTxAddressLiveId } as any,
        { txid: "tx-existing", role: "output", address: "bc1qexisting-output", amount: 9000 } as any,
      ],
      { skipNotification: true },
    );

    const seededTxCount = (await getAllTransactions()).length;
    const seededParticipantCount = (await getAllTransactionParticipants()).length;
    expect(seededTxCount).toBe(1);
    expect(seededParticipantCount).toBe(2);

    // 4. Build the legacy backup. It carries:
    //    - a record (backup id 1) that merges by inputString onto the pre-seeded
    //      `bc1qnew-output` record,
    //    - `tx-existing` which COLLIDES by txid with the seeded transaction
    //      (plus its own participants that must NOT be re-added),
    //    - `tx-new` which is genuinely new (its participant references backup
    //      record id 1 and must remap to the merged live record).
    const backupRecords = [
      { id: 1, type: "address", inputString: "bc1qnew-output", label: "From Backup", tags: [], categories: [] },
    ];

    const backupTransactions = [
      // Collides by txid with the seeded transaction — must be skipped.
      { id: 1, txid: "tx-existing", blockHeight: 800000, blockTime: 1_700_000_000, fee: 1000, feeRate: 5, syncedAt: 1_700_000_999 },
      // Genuinely new — must be inserted.
      { id: 2, txid: "tx-new", blockHeight: 800500, blockTime: 1_700_050_000, fee: 1500, feeRate: 7, syncedAt: 1_700_050_100 },
    ];

    const backupParticipants = [
      // Participants for the COLLIDING transaction — must NOT be added.
      { id: 10, txid: "tx-existing", role: "input", address: "bc1qexisting-input", amount: 10000, recordId: 1 },
      { id: 11, txid: "tx-existing", role: "output", address: "bc1qexisting-output", amount: 9000 },
      // Participant for the NEW transaction — must be added with recordId
      // remapped through recordIdMap to the merged live record.
      { id: 12, txid: "tx-new", role: "output", address: "bc1qnew-output", amount: 4200, recordId: 1 },
    ];

    // 5. Run the REAL merge restore path.
    const recordIdMap = new Map<number, number>();
    const recResult = await restoreLegacyRecords(backupRecords, "merge", recordIdMap);
    // The backup record merged onto the pre-existing one — no new record created.
    expect(recResult.recordsAdded).toBe(0);
    expect(recResult.recordsSkipped).toBe(1);
    expect(recordIdMap.get(1)).toBe(newTxAddressLiveId);

    const { transactionsAdded, participantsAdded } = await restoreLegacyTransactions(
      backupTransactions,
      backupParticipants,
      "merge",
      recordIdMap,
    );

    // Only the new transaction is inserted; only its single participant is added.
    expect(transactionsAdded).toBe(1);
    expect(participantsAdded).toBe(1);

    // 6. No duplicate transaction rows: exactly the seeded + the one new tx.
    const allTransactions = await getAllTransactions();
    expect(allTransactions).toHaveLength(2);
    const txByTxid = allTransactions.filter((t) => t.txid === "tx-existing");
    expect(txByTxid).toHaveLength(1);
    // The surviving colliding row is the SEEDED one (untouched), not the backup's.
    expect(txByTxid[0].syncedAt).toBe(1_700_000_100);

    // 7. No duplicate participant rows. The colliding transaction keeps exactly
    //    its two seeded participants; the new transaction adds exactly one.
    const allParticipants = await getAllTransactionParticipants();
    expect(allParticipants).toHaveLength(seededParticipantCount + 1);

    const existingTxParticipants = allParticipants.filter((p) => p.txid === "tx-existing");
    expect(existingTxParticipants).toHaveLength(2);

    const newTxParticipants = allParticipants.filter((p) => p.txid === "tx-new");
    expect(newTxParticipants).toHaveLength(1);

    // 8. The new transaction's participant remaps to the correct merged record.
    const allRecords = await getAllRecords();
    const inputStringById = new Map(allRecords.map((r) => [r.id!, r.inputString]));
    expect(newTxParticipants[0].recordId).toBe(newTxAddressLiveId);
    expect(inputStringById.get(newTxParticipants[0].recordId!)).toBe("bc1qnew-output");
    // And the backup id never leaked through unmapped.
    expect(newTxParticipants[0].recordId).not.toBe(1);
  });

  it("re-running the SAME merge restore adds nothing (idempotent: no duplicate tx or participant rows)", async () => {
    // A backup whose transactions are entirely new on the first merge, then
    // collide by txid with themselves on a second merge of the same payload.
    await bulkCreateRecords(
      [{ type: "address", inputString: "bc1qidem-addr", label: "Idem Addr", tags: [], categories: [] } as any],
      { skipNotification: true, skipVocabularySync: true },
    );

    const backupRecords = [
      { id: 5, type: "address", inputString: "bc1qidem-addr", label: "Idem", tags: [], categories: [] },
    ];
    const backupTransactions = [
      { id: 1, txid: "tx-idem", blockHeight: 805000, blockTime: 1_700_200_000, fee: 900, feeRate: 4, syncedAt: 1_700_200_100 },
    ];
    const backupParticipants = [
      { id: 20, txid: "tx-idem", role: "output", address: "bc1qidem-addr", amount: 7777, recordId: 5 },
    ];

    // First merge: transaction + participant are genuinely new.
    const map1 = new Map<number, number>();
    await restoreLegacyRecords(backupRecords, "merge", map1);
    const first = await restoreLegacyTransactions(backupTransactions, backupParticipants, "merge", map1);
    expect(first.transactionsAdded).toBe(1);
    expect(first.participantsAdded).toBe(1);
    expect(await getAllTransactions()).toHaveLength(1);
    expect(await getAllTransactionParticipants()).toHaveLength(1);

    // Second merge of the SAME backup: the transaction now collides by txid, so
    // nothing is added — no duplicate transaction or participant rows.
    const map2 = new Map<number, number>();
    await restoreLegacyRecords(backupRecords, "merge", map2);
    const second = await restoreLegacyTransactions(backupTransactions, backupParticipants, "merge", map2);
    expect(second.transactionsAdded).toBe(0);
    expect(second.participantsAdded).toBe(0);

    expect(await getAllTransactions()).toHaveLength(1);
    expect(await getAllTransactionParticipants()).toHaveLength(1);
  });
});

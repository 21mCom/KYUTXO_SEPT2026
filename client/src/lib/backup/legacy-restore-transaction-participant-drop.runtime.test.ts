// @vitest-environment jsdom
//
// CHARACTERIZATION test pinning the CURRENT behaviour of a legacy (pre-v3) MERGE
// restore when a backup's transaction collides by `txid` with one already in the
// vault, but the backup carries RICHER participant data than the live row.
//
// `restoreLegacyTransactions` (legacy-restore.ts) de-dups transactions by `txid`
// and only adds participants for transactions ACTUALLY inserted (it filters the
// incoming participants to `restoredTxids`). A colliding txid is therefore
// skipped wholesale — and with it, EVERY participant the backup held for that
// txid is dropped, even when those participants contain detail the live row is
// missing (resolved prevout addresses, amounts, or recordId links).
//
// This test documents that gap on purpose: it seeds a pre-existing transaction
// with only PARTIAL participants, then merge-restores a backup whose same-txid
// transaction carries ADDITIONAL/richer participants, and asserts that the extra
// backup participants are SILENTLY DROPPED (the live participants stay exactly as
// seeded). Pinning this makes any future move to "merge in the missing
// participants" a deliberate, tested change rather than a silent regression.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";

import {
  restoreLegacyRecords,
  restoreLegacyTransactions,
} from "./legacy-restore";
import {
  clearAllRecords,
  bulkCreateRecords,
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

describe("legacy restore (MERGE mode): richer backup participants for a colliding txid are dropped", () => {
  it("a backup's ADDITIONAL participants for an already-present txid are silently dropped; the live row keeps only its seeded participants", async () => {
    // 1. Seed the record the backup's richer participants would link to, so a
    //    "merge in missing participants" implementation would have a valid live
    //    record to remap onto. Filler records first advance the key generator so
    //    the backup record id (1) differs from the live id.
    await bulkCreateRecords(
      [
        { type: "address", inputString: "filler-1", label: "Filler 1", tags: [], categories: [] } as any,
        { type: "address", inputString: "filler-2", label: "Filler 2", tags: [], categories: [] } as any,
      ],
      { skipNotification: true, skipVocabularySync: true },
    );
    const [richAddressLiveId] = await bulkCreateRecords(
      [
        { type: "address", inputString: "bc1qresolved-prevout", label: "Resolved Prevout", tags: [], categories: [] } as any,
      ],
      { skipNotification: true, skipVocabularySync: true },
    );

    // 2. Seed a REAL pre-existing transaction with only PARTIAL participants: a
    //    single output, NO inputs and NO recordId links. This mirrors a live row
    //    that was created before prevouts were resolved.
    await bulkAddTransactions(
      [
        {
          txid: "tx-shared",
          blockHeight: 810000,
          blockTime: 1_700_300_000,
          fee: 2000,
          feeRate: 6,
          syncedAt: 1_700_300_100,
        } as any,
      ],
      { skipNotification: true },
    );
    await bulkAddParticipants(
      [
        // The ONLY seeded participant: an output with no recordId link.
        { txid: "tx-shared", role: "output", address: "bc1qshared-output", amount: 5000 } as any,
      ],
      { skipNotification: true },
    );

    const seededParticipants = await getAllTransactionParticipants();
    expect(await getAllTransactions()).toHaveLength(1);
    expect(seededParticipants).toHaveLength(1);

    // 3. Build the backup. It carries the SAME txid (`tx-shared`) but with RICHER
    //    participant data the live row lacks:
    //    - a resolved INPUT prevout (address + amount + recordId link),
    //    - the same output but now WITH a recordId link.
    const backupRecords = [
      { id: 1, type: "address", inputString: "bc1qresolved-prevout", label: "From Backup", tags: [], categories: [] },
    ];
    const backupTransactions = [
      { id: 1, txid: "tx-shared", blockHeight: 810000, blockTime: 1_700_300_000, fee: 2000, feeRate: 6, syncedAt: 1_700_300_999 },
    ];
    const backupParticipants = [
      // Resolved input prevout the live row is MISSING — links to backup record 1.
      { id: 30, txid: "tx-shared", role: "input", address: "bc1qresolved-prevout", amount: 5500, recordId: 1 },
      // The output, now enriched with a recordId link the live row lacks.
      { id: 31, txid: "tx-shared", role: "output", address: "bc1qshared-output", amount: 5000, recordId: 1 },
    ];

    // 4. Run the REAL merge restore path.
    const recordIdMap = new Map<number, number>();
    const recResult = await restoreLegacyRecords(backupRecords, "merge", recordIdMap);
    expect(recResult.recordsSkipped).toBe(1);
    expect(recordIdMap.get(1)).toBe(richAddressLiveId);

    const { transactionsAdded, participantsAdded } = await restoreLegacyTransactions(
      backupTransactions,
      backupParticipants,
      "merge",
      recordIdMap,
    );

    // 5. The colliding transaction is skipped, so NO participants are added —
    //    including the backup's richer input prevout and the recordId-linked
    //    output. This is the documented gap.
    expect(transactionsAdded).toBe(0);
    expect(participantsAdded).toBe(0);

    // 6. The live transaction keeps EXACTLY its single seeded participant. The
    //    backup's extra input prevout and recordId links were dropped.
    const allParticipants = await getAllTransactionParticipants();
    expect(allParticipants).toHaveLength(1);
    expect(allParticipants[0].role).toBe("output");
    expect(allParticipants[0].address).toBe("bc1qshared-output");
    // No input prevout was merged in.
    expect(allParticipants.some((p) => p.role === "input")).toBe(false);
    // The surviving output never gained the backup's recordId link.
    expect(allParticipants[0].recordId).toBeFalsy();

    // 7. The seeded transaction row itself is untouched (backup's later syncedAt
    //    did not overwrite it).
    const allTransactions = await getAllTransactions();
    expect(allTransactions).toHaveLength(1);
    expect(allTransactions[0].syncedAt).toBe(1_700_300_100);
  });
});

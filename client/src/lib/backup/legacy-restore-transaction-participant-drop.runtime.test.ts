// @vitest-environment jsdom
//
// Behaviour test for a legacy (pre-v3) MERGE restore when a backup's transaction
// collides by `txid` with one already in the vault, but the backup carries
// RICHER participant data than the live row.
//
// `restoreLegacyTransactions` (legacy-restore.ts) de-dups transactions by `txid`
// (a colliding txid keeps the live transaction row as-is), but in merge mode it
// MERGES IN any participants the backup holds for that txid that the live row is
// missing — resolved input prevouts, addresses, amounts, or recordId links —
// keyed by a stable `txid+role+address+vout` key so existing live participants
// are never duplicated. Backup participant recordIds are remapped through
// `recordIdMap` so they link to the restored (existing) record.
//
// This test seeds a pre-existing transaction with only PARTIAL participants, then
// merge-restores a backup whose same-txid transaction carries ADDITIONAL/richer
// participants, and asserts that the missing backup participants are merged in
// (the seeded live participant is kept, the new input prevout is added, and the
// already-present output is NOT duplicated).

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

describe("legacy restore (MERGE mode): richer backup participants for a colliding txid are merged in", () => {
  it("a backup's ADDITIONAL participants for an already-present txid are merged in; the live row keeps its seeded participant and is not duplicated", async () => {
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

    // 5. The colliding transaction row itself is NOT re-inserted, but the
    //    backup's MISSING participant (the input prevout) IS merged in. The
    //    backup's output collides with the seeded one (same txid+role+address+
    //    vout) and is therefore NOT duplicated — so exactly ONE participant is
    //    added.
    expect(transactionsAdded).toBe(0);
    expect(participantsAdded).toBe(1);

    // 6. The live transaction now holds BOTH the seeded output and the merged-in
    //    input prevout. The seeded output is kept (not duplicated), and the new
    //    input carries its resolved address/amount plus a recordId remapped to
    //    the existing live record.
    const allParticipants = await getAllTransactionParticipants();
    expect(allParticipants).toHaveLength(2);

    const outputs = allParticipants.filter((p) => p.role === "output");
    expect(outputs).toHaveLength(1);
    expect(outputs[0].address).toBe("bc1qshared-output");

    const inputs = allParticipants.filter((p) => p.role === "input");
    expect(inputs).toHaveLength(1);
    expect(inputs[0].address).toBe("bc1qresolved-prevout");
    expect(inputs[0].amount).toBe(5500);
    // The backup participant's recordId (1) was remapped to the live record id.
    expect(inputs[0].recordId).toBe(richAddressLiveId);

    // 7. The seeded transaction row itself is untouched (backup's later syncedAt
    //    did not overwrite it).
    const allTransactions = await getAllTransactions();
    expect(allTransactions).toHaveLength(1);
    expect(allTransactions[0].syncedAt).toBe(1_700_300_100);
  });
});

// @vitest-environment jsdom
//
// End-to-end guard that a legacy (pre-v3) backup's transaction PARTICIPANT links
// resolve to the CORRECT live record after restore — not just that the recordId
// remap runs.
//
// `legacy-restore.runtime.test.ts` already proves the participant `recordId` is
// rewritten through `recordIdMap` over fake-indexeddb. But that test restores
// into a clean DB, so it never forces record ids to SHIFT: the backup id and the
// live id can coincide, and a stale (un-remapped) recordId would still happen to
// point at the right row. The parallel record-file test (#615) closes this gap
// for ATTACHMENTS by pre-seeding unrelated rows so the key generator advances and
// the backup ids collide with pre-existing records. This test does the same for
// PARTICIPANTS.
//
// The methodology mirrors #615:
//   - pre-seed UNRELATED records so the records table's autoincrement key
//     generator is advanced past the backup ids (1/2/3),
//   - restore a legacy backup containing records + transactions + participants
//     through the REAL `restoreLegacyRecords` + `restoreLegacyTransactions`
//     helpers over fake-indexeddb,
//   - assert each restored participant's `recordId` resolves to the SAME record
//     (by inputString — the address it spent from / received at) it referenced in
//     the backup, never a pre-existing collision row.
// A broken recordId remap (participant left on a stale backup id) would resolve
// to the wrong record here and fail; the on-chain activity would otherwise be
// silently attributed to the wrong address.

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

describe("legacy restore: participant links resolve to the correct record after ids shift", () => {
  it("each restored participant's recordId resolves to the SAME record (by inputString) it referenced, never a collision row", async () => {
    // 1. Pre-seed UNRELATED records so the table's autoincrement key generator is
    //    advanced. After this the backup ids 1/2/3 collide with these pre-existing
    //    live ids — a broken recordId remap would silently link a restored
    //    participant to one of these instead of to its real record.
    await bulkCreateRecords(
      [
        { type: "address", inputString: "preexisting-a", label: "Pre A", tags: [], categories: [] } as any,
        { type: "address", inputString: "preexisting-b", label: "Pre B", tags: [], categories: [] } as any,
        { type: "address", inputString: "preexisting-c", label: "Pre C", tags: [], categories: [] } as any,
      ],
      { skipNotification: true, skipVocabularySync: true },
    );

    // 2. Build the legacy backup payload. Records carry backup ids 1/2/3 (which
    //    now collide with the pre-seeded rows). Each record is the address a
    //    participant references; resolving the participant by recordId must land
    //    back on the record with the SAME inputString.
    const plan = [
      { backupId: 1, inputString: "bc1qspender-input", label: "Spender Input", txid: "tx-spend", role: "input" as const },
      { backupId: 2, inputString: "bc1qrecipient-output", label: "Recipient Output", txid: "tx-spend", role: "output" as const },
      { backupId: 3, inputString: "bc1qchange-output", label: "Change Output", txid: "tx-change", role: "output" as const },
    ];

    const backupRecords = plan.map((p) => ({
      id: p.backupId,
      type: "address",
      inputString: p.inputString,
      label: p.label,
      tags: [],
      categories: [],
    }));

    const backupTransactions = [
      { id: 1, txid: "tx-spend", blockHeight: 800000, blockTime: 1_700_000_000, fee: 1000, feeRate: 5, syncedAt: 1_700_000_100 },
      { id: 2, txid: "tx-change", blockHeight: 800001, blockTime: 1_700_000_200, fee: 1200, feeRate: 6, syncedAt: 1_700_000_300 },
    ];

    // One participant per record, each referencing its backup recordId.
    const backupParticipants = plan.map((p, i) => ({
      id: (i + 1) * 100,
      txid: p.txid,
      role: p.role,
      address: p.inputString,
      amount: 5000 + i,
      recordId: p.backupId,
    }));

    // 3. Run the REAL legacy restore path: records first (builds the id map),
    //    then transactions + participants (remap recordId through it).
    const recordIdMap = new Map<number, number>();
    const recResult = await restoreLegacyRecords(backupRecords, "replace", recordIdMap);
    expect(recResult.recordsAdded).toBe(3);

    const { transactionsAdded, participantsAdded } = await restoreLegacyTransactions(
      backupTransactions,
      backupParticipants,
      "replace",
      recordIdMap,
    );
    expect(transactionsAdded).toBe(2);
    expect(participantsAdded).toBe(3);

    // 4. The restored records must have ids DIFFERENT from the backup ids
    //    (proving ids shifted — the remap scenario is actually exercised).
    const allRecords = await getAllRecords();
    const restored = allRecords.filter((r) =>
      plan.some((p) => p.inputString === r.inputString),
    );
    expect(restored).toHaveLength(3);
    for (const rec of restored) {
      expect([1, 2, 3]).not.toContain(rec.id);
    }

    // 5. The end-to-end assertion: for EACH restored participant, resolve its
    //    recordId to a live record and confirm that record's inputString is the
    //    address the participant references. A stale (un-remapped) recordId would
    //    resolve to a pre-existing collision row whose inputString is "preexisting-*".
    const inputStringById = new Map(allRecords.map((r) => [r.id!, r.inputString]));
    const expectedInputStringByTxidRole = new Map(
      plan.map((p) => [`${p.txid}:${p.role}:${p.inputString}`, p.inputString]),
    );

    const restoredParticipants = await getAllTransactionParticipants();
    expect(restoredParticipants).toHaveLength(3);

    for (const part of restoredParticipants) {
      const key = `${part.txid}:${part.role}:${part.address}`;
      expect(expectedInputStringByTxidRole.has(key)).toBe(true);

      // recordId must resolve to a live record (defined, present in the table).
      expect(part.recordId).toBeDefined();
      const resolvedInputString = inputStringById.get(part.recordId!);
      expect(resolvedInputString).toBeDefined();

      // And that record must be the participant's OWN address — never a
      // pre-existing collision row.
      expect(resolvedInputString).toBe(expectedInputStringByTxidRole.get(key));
      expect(resolvedInputString!.startsWith("preexisting-")).toBe(false);
    }
  });

  it("merge mode: a participant whose record merged onto a PRE-EXISTING row links to that existing record, not a fresh duplicate", async () => {
    // Seed an existing record that the backup will collide with on inputString.
    const [existingId] = await bulkCreateRecords(
      [
        { type: "address", inputString: "bc1qshared-address", label: "Already Here", tags: [], categories: [] } as any,
      ],
      { skipNotification: true, skipVocabularySync: true },
    );

    // Pre-seed extra unrelated rows so the backup id (1) is far from the live id.
    await bulkCreateRecords(
      [
        { type: "address", inputString: "filler-1", label: "F1", tags: [], categories: [] } as any,
        { type: "address", inputString: "filler-2", label: "F2", tags: [], categories: [] } as any,
      ],
      { skipNotification: true, skipVocabularySync: true },
    );

    const recordIdMap = new Map<number, number>();
    await restoreLegacyRecords(
      [{ id: 1, type: "address", inputString: "bc1qshared-address", label: "From Backup", tags: [], categories: [] }],
      "merge",
      recordIdMap,
    );

    // No duplicate record was created for the shared address.
    const records = await getAllRecords();
    expect(records.filter((r) => r.inputString === "bc1qshared-address")).toHaveLength(1);

    const { participantsAdded } = await restoreLegacyTransactions(
      [{ id: 1, txid: "tx-merge", blockHeight: 810000, blockTime: 1_700_100_000, fee: 800, feeRate: 4, syncedAt: 1_700_100_100 }],
      [{ id: 50, txid: "tx-merge", role: "output", address: "bc1qshared-address", amount: 9000, recordId: 1 }],
      "merge",
      recordIdMap,
    );
    expect(participantsAdded).toBe(1);

    // The participant must link to the PRE-EXISTING record id, so its on-chain
    // activity attributes to the record that was already in the vault.
    const parts = await getAllTransactionParticipants();
    expect(parts).toHaveLength(1);
    expect(parts[0].recordId).toBe(existingId);
    expect(await getAllTransactions()).toHaveLength(1);
  });
});

// @vitest-environment jsdom
//
// End-to-end guard that a legacy (pre-v3) backup's per-address SYNC STATE links
// resolve to the CORRECT live record after restore — not just that the recordId
// remap runs.
//
// `legacy-restore.runtime.test.ts` already proves the addressSyncState
// `recordId` is rewritten through `recordIdMap` over fake-indexeddb. But that
// test restores into a clean DB, so it never forces record ids to SHIFT: the
// backup id and the live id can coincide, and a stale (un-remapped) recordId
// would still happen to point at the right row. The parallel participant test
// (#680) closes this gap for transaction PARTICIPANTS by pre-seeding unrelated
// rows so the key generator advances and the backup ids collide with
// pre-existing records. This test does the same for addressSyncState.
//
// The methodology mirrors #680:
//   - pre-seed UNRELATED records so the records table's autoincrement key
//     generator is advanced past the backup ids (1/2/3),
//   - restore a legacy backup containing records + addressSyncState through the
//     REAL `restoreLegacyRecords` + `restoreLegacyAddressSyncState` helpers over
//     fake-indexeddb,
//   - assert each restored sync-state row's `recordId` resolves to the SAME
//     record (by inputString — the address whose sync progress/height it tracks)
//     it referenced in the backup, never a pre-existing collision row.
// A broken recordId remap (sync-state left on a stale backup id) would resolve
// to the wrong record here and fail; the sync progress/height would otherwise be
// silently attributed to the wrong address.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";

import {
  restoreLegacyRecords,
  restoreLegacyAddressSyncState,
} from "./legacy-restore";
import {
  clearAllRecords,
  bulkCreateRecords,
  getAllRecords,
} from "@/lib/data/record-crud";
import {
  clearAddressSyncState,
  getAllAddressSyncState,
} from "@/lib/data/address-sync-crud";

async function clearEverything(): Promise<void> {
  await clearAllRecords({ skipNotification: true });
  await clearAddressSyncState({ skipNotification: true });
}

beforeEach(async () => {
  await clearEverything();
});

describe("legacy restore: address-sync state links resolve to the correct record after ids shift", () => {
  it("each restored sync-state row's recordId resolves to the SAME record (by inputString) it referenced, never a collision row", async () => {
    // 1. Pre-seed UNRELATED records so the table's autoincrement key generator is
    //    advanced. After this the backup ids 1/2/3 collide with these pre-existing
    //    live ids — a broken recordId remap would silently link a restored
    //    sync-state row to one of these instead of to its real record.
    await bulkCreateRecords(
      [
        { type: "address", inputString: "preexisting-a", label: "Pre A", tags: [], categories: [] } as any,
        { type: "address", inputString: "preexisting-b", label: "Pre B", tags: [], categories: [] } as any,
        { type: "address", inputString: "preexisting-c", label: "Pre C", tags: [], categories: [] } as any,
      ],
      { skipNotification: true, skipVocabularySync: true },
    );

    // 2. Build the legacy backup payload. Records carry backup ids 1/2/3 (which
    //    now collide with the pre-seeded rows). Each record is the address whose
    //    sync state a row tracks; resolving that row by recordId must land back
    //    on the record with the SAME inputString.
    const plan = [
      { backupId: 1, inputString: "bc1qwatched-one", label: "Watched One", height: 800000 },
      { backupId: 2, inputString: "bc1qwatched-two", label: "Watched Two", height: 810000 },
      { backupId: 3, inputString: "bc1qwatched-three", label: "Watched Three", height: 820000 },
    ];

    const backupRecords = plan.map((p) => ({
      id: p.backupId,
      type: "address",
      inputString: p.inputString,
      label: p.label,
      tags: [],
      categories: [],
    }));

    // One sync-state row per record, each referencing its backup recordId and
    // tracking the same address.
    const backupSyncState = plan.map((p, i) => ({
      id: (i + 1) * 100,
      address: p.inputString,
      recordId: p.backupId,
      lastSyncedHeight: p.height,
      lastSyncedAt: 1_700_000_000 + i,
      txCount: 3 + i,
    }));

    // 3. Run the REAL legacy restore path: records first (builds the id map),
    //    then address sync state (remaps recordId through it).
    const recordIdMap = new Map<number, number>();
    const recResult = await restoreLegacyRecords(backupRecords, "replace", recordIdMap);
    expect(recResult.recordsAdded).toBe(3);

    const syncAdded = await restoreLegacyAddressSyncState(
      backupSyncState,
      "replace",
      recordIdMap,
    );
    expect(syncAdded).toBe(3);

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

    // 5. The end-to-end assertion: for EACH restored sync-state row, resolve its
    //    recordId to a live record and confirm that record's inputString is the
    //    address the row tracks. A stale (un-remapped) recordId would resolve to
    //    a pre-existing collision row whose inputString is "preexisting-*".
    const inputStringById = new Map(allRecords.map((r) => [r.id!, r.inputString]));
    const expectedHeightByAddress = new Map(plan.map((p) => [p.inputString, p.height]));

    const restoredSyncState = await getAllAddressSyncState();
    expect(restoredSyncState).toHaveLength(3);

    for (const row of restoredSyncState) {
      // The row tracks one of the backup addresses.
      expect(expectedHeightByAddress.has(row.address)).toBe(true);
      // Its synced height survived the round-trip unchanged.
      expect(row.lastSyncedHeight).toBe(expectedHeightByAddress.get(row.address));

      // recordId must resolve to a live record (defined, present in the table).
      expect(row.recordId).toBeDefined();
      const resolvedInputString = inputStringById.get(row.recordId!);
      expect(resolvedInputString).toBeDefined();

      // And that record must be the row's OWN address — never a pre-existing
      // collision row. A broken remap would attribute this sync progress/height
      // to the wrong address.
      expect(resolvedInputString).toBe(row.address);
      expect(resolvedInputString!.startsWith("preexisting-")).toBe(false);
    }
  });

  it("merge mode: a sync-state row whose record merged onto a PRE-EXISTING row links to that existing record, not a fresh duplicate", async () => {
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

    const syncAdded = await restoreLegacyAddressSyncState(
      [{ id: 50, address: "bc1qshared-address", recordId: 1, lastSyncedHeight: 830000, lastSyncedAt: 1_700_100_000, txCount: 7 }],
      "merge",
      recordIdMap,
    );
    expect(syncAdded).toBe(1);

    // The sync-state row must link to the PRE-EXISTING record id, so its sync
    // progress/height attributes to the record that was already in the vault.
    const rows = await getAllAddressSyncState();
    expect(rows).toHaveLength(1);
    expect(rows[0].recordId).toBe(existingId);
    expect(rows[0].lastSyncedHeight).toBe(830000);
  });
});

// @vitest-environment jsdom
//
// Regression guard for the LEGACY (pre-v3) backup restore path's handling of
// the high-risk, id-remapping tables: records, attachments, blockchain
// transactions + participants, and address sync state. This logic used to live
// inline inside SettingsPage's ~1000-line `handleRestore` and was exercised by
// no automated test, so a regression in the merge-vs-replace de-duplication or
// the recordId remapping (wrong de-dup, dropped/orphaned dependent rows,
// duplicate-key errors on the unique `address` index) would have gone
// unnoticed.
//
// The inline branches are now shared helpers in `./legacy-restore`. These tests
// drive those helpers over the REAL `@/lib/database` schema through
// fake-indexeddb (mirroring the v3 round-trip tests) and assert the invariants
// the legacy path depended on:
//   - records: merge de-dups by `inputString`; backup id -> live id is recorded
//     in `recordIdMap` for BOTH newly created and merge-skipped records.
//   - attachments: de-dup by `objectStoragePath`; recordId remapped through the
//     map; orphans (owning record absent) are dropped, not left dangling.
//   - transactions: de-dup by `txid`; participants are only added for
//     transactions actually inserted, with recordId remapped.
//   - addressSyncState: de-dup against the unique `address` index (existing rows
//     in merge mode + within the incoming set in both modes); recordId remapped.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";

import {
  restoreLegacyRecords,
  restoreLegacyAttachments,
  restoreLegacyTransactions,
  restoreLegacyAddressSyncState,
  remapRecordId,
} from "./legacy-restore";
import {
  clearAllRecords,
  bulkCreateRecords,
  getAllRecords,
} from "@/lib/data/record-crud";
import { clearAttachments, getAllAttachments } from "@/lib/data/attachments-crud";
import {
  clearTransactions,
  clearParticipants,
  getAllTransactions,
  getAllTransactionParticipants,
} from "@/lib/data/transaction-crud";
import {
  clearAddressSyncState,
  getAllAddressSyncState,
} from "@/lib/data/address-sync-crud";

async function clearEverything(): Promise<void> {
  await clearAllRecords({ skipNotification: true });
  await clearAttachments({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
  await clearAddressSyncState({ skipNotification: true });
}

// A minimal valid backup record. `id` is the BACKUP id (stripped on restore).
function backupRecord(id: number, inputString: string, extra: any = {}) {
  return {
    id,
    type: "address",
    inputString,
    label: `Label ${inputString}`,
    tags: [],
    categories: [],
    ...extra,
  };
}

beforeEach(async () => {
  await clearEverything();
});

describe("legacy restore: records", () => {
  it("replace mode creates every record with fresh ids and maps backup id -> live id", async () => {
    const recordIdMap = new Map<number, number>();
    const records = [
      backupRecord(101, "addr-a"),
      backupRecord(102, "addr-b"),
    ];

    const { recordsAdded, recordsSkipped } = await restoreLegacyRecords(
      records,
      "replace",
      recordIdMap,
    );

    expect(recordsAdded).toBe(2);
    expect(recordsSkipped).toBe(0);

    const live = await getAllRecords();
    expect(live).toHaveLength(2);
    expect(new Set(live.map((r) => r.inputString))).toEqual(
      new Set(["addr-a", "addr-b"]),
    );

    // Every backup id maps to a real live id (fresh autoincrement, not reused).
    const liveIds = new Set(live.map((r) => r.id));
    expect(recordIdMap.size).toBe(2);
    for (const backupId of [101, 102]) {
      const mapped = recordIdMap.get(backupId);
      expect(mapped).toBeDefined();
      expect(liveIds.has(mapped!)).toBe(true);
    }
  });

  it("merge mode skips records whose inputString already exists and maps to the existing live id", async () => {
    // Seed an existing record so the incoming backup collides on inputString.
    const [existingId] = await bulkCreateRecords(
      [
        {
          type: "address",
          inputString: "addr-existing",
          label: "Existing",
          tags: [],
          categories: [],
        } as any,
      ],
      { skipNotification: true, skipVocabularySync: true },
    );

    const recordIdMap = new Map<number, number>();
    const records = [
      backupRecord(201, "addr-existing"), // collides -> skipped, mapped
      backupRecord(202, "addr-new"), // new -> created
    ];

    const { recordsAdded, recordsSkipped } = await restoreLegacyRecords(
      records,
      "merge",
      recordIdMap,
    );

    expect(recordsAdded).toBe(1);
    expect(recordsSkipped).toBe(1);

    // No duplicate of the existing record.
    const live = await getAllRecords();
    expect(live).toHaveLength(2);
    expect(live.filter((r) => r.inputString === "addr-existing")).toHaveLength(1);

    // The skipped backup id maps to the PRE-EXISTING live id (so dependent rows
    // link to the record that was already there).
    expect(recordIdMap.get(201)).toBe(existingId);
    // The created backup id maps to its new live id.
    const newRec = live.find((r) => r.inputString === "addr-new")!;
    expect(recordIdMap.get(202)).toBe(newRec.id);
  });

  it("no-ops cleanly on an empty/undefined records array", async () => {
    const map = new Map<number, number>();
    await expect(restoreLegacyRecords([], "replace", map)).resolves.toEqual({
      recordsAdded: 0,
      recordsSkipped: 0,
    });
    await expect(
      restoreLegacyRecords(undefined, "merge", map),
    ).resolves.toEqual({ recordsAdded: 0, recordsSkipped: 0 });
    expect(await getAllRecords()).toHaveLength(0);
  });
});

describe("legacy restore: attachments", () => {
  it("remaps recordId, routes orphans to review, and de-dups by objectStoragePath in merge mode", async () => {
    // Restore two records so attachments have live records to bind to.
    const recordIdMap = new Map<number, number>();
    await restoreLegacyRecords(
      [backupRecord(301, "addr-x"), backupRecord(302, "addr-y")],
      "replace",
      recordIdMap,
    );
    const liveX = recordIdMap.get(301)!;
    const liveY = recordIdMap.get(302)!;

    const attachments = [
      // bound to record 301 -> liveX
      { id: 1, recordId: 301, filename: "a.pdf", mimeType: "application/pdf", size: 10, objectStoragePath: "hash-a" },
      // bound to record 302 -> liveY
      { id: 2, recordId: 302, filename: "b.pdf", mimeType: "application/pdf", size: 20, objectStoragePath: "hash-b" },
      // ORPHAN: backup recordId 999 was never restored -> routed to review, NOT linked
      { id: 3, recordId: 999, filename: "orphan.pdf", mimeType: "application/pdf", size: 30, objectStoragePath: "hash-orphan" },
    ];

    const result = await restoreLegacyAttachments(attachments, "replace", recordIdMap);
    expect(result.attachmentsAdded).toBe(2);

    // Orphan is reported in the returned map so callers can route its bytes.
    expect(result.orphanedRelPaths.size).toBe(1);
    expect(result.orphanedRelPaths.get("hash-orphan")).toBe("orphan.pdf");

    const live = await getAllAttachments();
    expect(live).toHaveLength(2);
    // recordId was rewritten to the live ids, not the backup ids.
    expect(live.find((a) => a.objectStoragePath === "hash-a")!.recordId).toBe(liveX);
    expect(live.find((a) => a.objectStoragePath === "hash-b")!.recordId).toBe(liveY);
    // The orphan is NOT in the DB (no spurious link to any record).
    expect(live.some((a) => a.objectStoragePath === "hash-orphan")).toBe(false);

    // Merge again with the SAME objectStoragePaths: nothing new is added.
    const mergeResult = await restoreLegacyAttachments(attachments, "merge", recordIdMap);
    expect(mergeResult.attachmentsAdded).toBe(0);
    expect(await getAllAttachments()).toHaveLength(2);
  });

  it("keeps multiple distinct attachments on one record (sharing a filename) via objectStoragePath identity", async () => {
    const recordIdMap = new Map<number, number>();
    await restoreLegacyRecords([backupRecord(401, "addr-multi")], "replace", recordIdMap);
    const live = recordIdMap.get(401)!;

    const attachments = [
      { id: 1, recordId: 401, filename: "scan.pdf", mimeType: "application/pdf", size: 10, objectStoragePath: "hash-1" },
      { id: 2, recordId: 401, filename: "scan.pdf", mimeType: "application/pdf", size: 11, objectStoragePath: "hash-2" },
      { id: 3, recordId: 401, filename: "scan.pdf", mimeType: "application/pdf", size: 12, objectStoragePath: "hash-3" },
    ];

    const result = await restoreLegacyAttachments(attachments, "merge", recordIdMap);
    expect(result.attachmentsAdded).toBe(3);
    const stored = await getAllAttachments();
    expect(stored).toHaveLength(3);
    expect(stored.every((a) => a.recordId === live)).toBe(true);
  });
});

describe("legacy restore: transactions and participants", () => {
  function tx(txid: string) {
    return {
      id: 1,
      txid,
      blockHeight: 800000,
      blockTime: 1_700_000_000,
      fee: 1000,
      feeRate: 5,
      syncedAt: 1_700_000_100,
    };
  }
  function participant(txid: string, role: "input" | "output", address: string, recordId?: number) {
    return { id: 1, txid, role, address, amount: 5000, recordId };
  }

  it("inserts transactions, adds participants only for inserted txs, and remaps participant recordId", async () => {
    const recordIdMap = new Map<number, number>();
    await restoreLegacyRecords([backupRecord(501, "addr-p")], "replace", recordIdMap);
    const liveP = recordIdMap.get(501)!;

    const txs = [tx("tx-1"), tx("tx-2")];
    const participants = [
      participant("tx-1", "output", "addr-p", 501), // recordId remapped
      participant("tx-2", "input", "addr-q"), // no recordId
      participant("tx-unknown", "output", "addr-z", 501), // tx not restored -> dropped
    ];

    const { transactionsAdded, participantsAdded } = await restoreLegacyTransactions(
      txs,
      participants,
      "replace",
      recordIdMap,
    );

    expect(transactionsAdded).toBe(2);
    expect(participantsAdded).toBe(2);

    const liveParts = await getAllTransactionParticipants();
    expect(liveParts).toHaveLength(2);
    const part1 = liveParts.find((p) => p.txid === "tx-1")!;
    expect(part1.recordId).toBe(liveP); // remapped to live id
    expect(liveParts.some((p) => p.txid === "tx-unknown")).toBe(false);
  });

  it("merge mode de-dups transactions by txid and does not re-add participants for existing txs", async () => {
    const recordIdMap = new Map<number, number>();

    // First restore seeds tx-1 + its participant.
    await restoreLegacyTransactions(
      [tx("tx-1")],
      [participant("tx-1", "output", "addr-a")],
      "replace",
      recordIdMap,
    );
    expect(await getAllTransactions()).toHaveLength(1);
    expect(await getAllTransactionParticipants()).toHaveLength(1);

    // Second restore in merge mode brings tx-1 (duplicate) + tx-2 (new).
    const { transactionsAdded, participantsAdded } = await restoreLegacyTransactions(
      [tx("tx-1"), tx("tx-2")],
      [
        participant("tx-1", "output", "addr-a"), // belongs to existing tx -> skipped
        participant("tx-2", "output", "addr-b"), // belongs to new tx -> added
      ],
      "merge",
      recordIdMap,
    );

    expect(transactionsAdded).toBe(1); // only tx-2
    expect(participantsAdded).toBe(1); // only tx-2's participant

    expect(await getAllTransactions()).toHaveLength(2);
    // tx-1 participant not duplicated.
    const parts = await getAllTransactionParticipants();
    expect(parts.filter((p) => p.txid === "tx-1")).toHaveLength(1);
    expect(parts.filter((p) => p.txid === "tx-2")).toHaveLength(1);
  });

  it("de-dups duplicate txids within a single incoming set (both modes)", async () => {
    const recordIdMap = new Map<number, number>();
    const { transactionsAdded } = await restoreLegacyTransactions(
      [tx("dup"), tx("dup"), tx("unique")],
      [],
      "replace",
      recordIdMap,
    );
    expect(transactionsAdded).toBe(2);
    expect(await getAllTransactions()).toHaveLength(2);
  });
});

describe("legacy restore: address sync state", () => {
  function syncRow(address: string, recordId?: number) {
    return {
      id: 1,
      address,
      recordId,
      lastSyncedHeight: 800000,
      lastSyncedAt: 1_700_000_000,
      txCount: 3,
    };
  }

  it("remaps recordId and de-dups within the incoming set on the unique address index", async () => {
    const recordIdMap = new Map<number, number>();
    await restoreLegacyRecords([backupRecord(601, "addr-s")], "replace", recordIdMap);
    const liveS = recordIdMap.get(601)!;

    const added = await restoreLegacyAddressSyncState(
      [
        syncRow("addr-s", 601), // recordId remapped
        syncRow("addr-s", 601), // duplicate address within incoming set -> dropped
        syncRow("addr-t"), // distinct
      ],
      "replace",
      recordIdMap,
    );

    expect(added).toBe(2);
    const live = await getAllAddressSyncState();
    expect(live).toHaveLength(2);
    expect(live.find((s) => s.address === "addr-s")!.recordId).toBe(liveS);
    // No duplicate-key error on the unique `address` index.
    expect(live.filter((s) => s.address === "addr-s")).toHaveLength(1);
  });

  it("merge mode skips addresses that already exist", async () => {
    const recordIdMap = new Map<number, number>();
    await restoreLegacyAddressSyncState([syncRow("addr-keep")], "replace", recordIdMap);
    expect(await getAllAddressSyncState()).toHaveLength(1);

    const added = await restoreLegacyAddressSyncState(
      [syncRow("addr-keep"), syncRow("addr-fresh")],
      "merge",
      recordIdMap,
    );
    expect(added).toBe(1); // only addr-fresh
    const live = await getAllAddressSyncState();
    expect(live).toHaveLength(2);
    expect(live.filter((s) => s.address === "addr-keep")).toHaveLength(1);
  });
});

describe("remapRecordId", () => {
  it("returns undefined for null/undefined/unmapped ids and the mapped id otherwise", () => {
    const map = new Map<number, number>([[5, 50]]);
    expect(remapRecordId(map, 5)).toBe(50);
    expect(remapRecordId(map, 999)).toBeUndefined();
    expect(remapRecordId(map, undefined)).toBeUndefined();
    expect(remapRecordId(map, null)).toBeUndefined();
  });
});

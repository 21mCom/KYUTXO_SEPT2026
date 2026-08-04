// @vitest-environment jsdom
//
// Runtime guard for the two-backup comparison pipeline (compare.ts) driving
// REAL v3 backup zips end to end over the REAL `@/lib/database` schema on
// fake-indexeddb:
//
//   1. full vs COMPACT backup of the same vault: rows pruned by the compact
//      filter (discovery-only record + its transaction/participant/sync-state
//      history) are NOT reported as removed — they are counted as suppressed.
//   2. vault A -> mutate -> encrypted vault B: the diff reports exactly the
//      added/removed/changed records (with the label field delta) and the new
//      vocabulary tag; the ENCRYPTED backup decrypts with its password.
//   3. a wrong password on the encrypted side rejects with the same error the
//      restore pre-flight produces, prefixed by which file failed — BEFORE any
//      comparison output is produced.
//   4. an encrypted backup with no password rejects as "Password required".
//   5. comparing a backup against itself yields zero differences.
//
// compare.test.ts pins the pure diff-engine classification contract on
// synthetic snapshots; this suite proves the streaming reader, the encrypted
// manifest handling, and the compact markers against real archives.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeAll } from "vitest";

import { db } from "@/lib/database";
import { exportBackup, type AttachmentFileIO } from "./export";
import { computeCompactPlan } from "./compact";
import { compareBackups } from "./compare";
import { MemorySink } from "./sink";
import { blobChunks } from "./zip-stream";

import {
  bulkCreateRecords,
  clearAllRecords,
  createRecord,
  updateRecord,
  deleteRecord,
  type CreateRecordData,
} from "@/lib/data/record-crud";
import {
  bulkAddTransactions,
  bulkAddParticipants,
  clearTransactions,
  clearParticipants,
  type CreateTransactionData,
} from "@/lib/data/transaction-crud";
import {
  bulkAddAddressSyncState,
  clearAddressSyncState,
  type CreateAddressSyncStateData,
} from "@/lib/data/address-sync-crud";
import { clearAttachments } from "@/lib/data/attachments-crud";
import { restoreTag } from "@/lib/data/vocabulary-crud";
import type { TransactionParticipant } from "@/lib/db-types";

const PASSWORD = "compare-check-123";

const ADDR_KEEP = "bc1qcomparekeep0000000000000000000000000";
const ADDR_EDIT = "bc1qcompareedit0000000000000000000000000";
const ADDR_GONE = "bc1qcomparegone0000000000000000000000000";
const ADDR_DISC = "bc1qcomparedisc0000000000000000000000000";
const ADDR_ADDED = "bc1qcompareadded00000000000000000000000";
const TXID_KEEP = "a".repeat(64);
const TXID_DISC = "b".repeat(64);

// No attachment files in this vault.
const attachmentIO: AttachmentFileIO = {
  async listAll() {
    return [];
  },
  async read() {
    return null;
  },
};

let editId = 0;
let goneId = 0;
let backupA: Blob; // full, unencrypted, pre-mutation

async function exportToBlob(opts: { encrypted?: boolean; password?: string; compact?: boolean } = {}): Promise<Blob> {
  const sink = new MemorySink();
  const compactPlan = opts.compact ? await computeCompactPlan() : undefined;
  await exportBackup({
    sink,
    encrypted: opts.encrypted ?? false,
    password: opts.password,
    compactPlan,
    attachmentIO,
  });
  if (!sink.blob) throw new Error("export produced no blob");
  return sink.blob;
}

function table(result: Awaited<ReturnType<typeof compareBackups>>, name: string) {
  const t = result.tables.find((x) => x.table === name);
  if (!t) throw new Error(`missing table diff: ${name}`);
  return t;
}

beforeAll(async () => {
  await clearAllRecords({ skipNotification: true });
  await clearAttachments({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearAddressSyncState({ skipNotification: true });
  await db.tags.clear();

  const rec = (inputString: string, extra: Record<string, unknown>): CreateRecordData =>
    ({
      type: "address",
      inputString,
      inputStringLower: inputString,
      tags: [],
      categories: [],
      ...extra,
    }) as unknown as CreateRecordData;

  const ids = await bulkCreateRecords(
    [
      rec(ADDR_KEEP, { label: "Keep", source: "manual", addressImportance: "manual" }),
      rec(ADDR_EDIT, { label: "Before", source: "manual", addressImportance: "manual" }),
      rec(ADDR_GONE, { label: "Gone", source: "manual", addressImportance: "manual" }),
      // Bare blockchain-discovered record: prunable by the compact filter.
      rec(ADDR_DISC, {
        label: "",
        owner: "Pending Review",
        source: "blockchain-sync",
        syncDepth: 2,
        addressImportance: "blockchain-discovered",
      }),
    ],
    { skipNotification: true, skipVocabularySync: true },
  );
  const [keepId, eId, gId, discId] = ids;
  editId = eId;
  goneId = gId;

  await bulkAddTransactions(
    [
      { txid: TXID_KEEP, blockHeight: 100, blockTime: 1_700_000_000, syncedAt: 1 },
      { txid: TXID_DISC, blockHeight: 101, blockTime: 1_700_000_600, syncedAt: 1 },
    ] as unknown as CreateTransactionData[],
    { skipNotification: true },
  );
  await bulkAddParticipants(
    [
      { txid: TXID_KEEP, role: "output", address: ADDR_KEEP, recordId: keepId, vout: 0 },
      { txid: TXID_DISC, role: "output", address: ADDR_DISC, recordId: discId, vout: 0 },
    ] as unknown as TransactionParticipant[],
    { skipNotification: true },
  );
  await bulkAddAddressSyncState(
    [
      { address: ADDR_KEEP, syncDepth: 1 },
      { address: ADDR_DISC, syncDepth: 2 },
    ] as unknown as CreateAddressSyncStateData[],
    { skipNotification: true },
  );
  await restoreTag({ name: "alpha", createdAt: Date.now() });

  backupA = await exportToBlob();
}, 120_000);

describe("compareBackups — full vs compact backup of the same vault", () => {
  it("does not report compact-pruned discovery rows as removed", async () => {
    const backupC = await exportToBlob({ compact: true });
    const result = await compareBackups({
      older: { source: blobChunks(backupA) },
      newer: { source: blobChunks(backupC) },
    });

    // The discovery record + its history were pruned by the compact filter —
    // suppressed, not reported as user deletions. Everything else is identical.
    const records = table(result, "records");
    expect(records.removed).toBe(0);
    expect(records.added).toBe(0);
    expect(records.changed).toBe(0);
    expect(records.suppressed).toBe(1);

    expect(table(result, "blockchainTransactions").suppressed).toBe(1);
    expect(table(result, "blockchainTransactions").removed).toBe(0);
    expect(table(result, "transactionParticipants").suppressed).toBe(1);
    expect(table(result, "addressSyncState").suppressed).toBe(1);

    // Nothing else differs — and nothing suppressed leaks into the CSV.
    expect(result.csv.rowCount).toBe(0);
  }, 120_000);

  it("comparing a backup against itself yields zero differences", async () => {
    const result = await compareBackups({
      older: { source: blobChunks(backupA) },
      newer: { source: blobChunks(backupA) },
    });
    for (const t of result.tables) {
      expect(t.added + t.removed + t.changed, `table ${t.table}`).toBe(0);
    }
    expect(result.csv.rowCount).toBe(0);
  }, 120_000);
});

describe("compareBackups — mutated vault, encrypted newer backup", () => {
  it("reports exactly the added/removed/changed rows with field deltas", async () => {
    // Mutate the vault: edit a label, delete one record, add one, add a tag.
    await updateRecord(editId, { label: "After" }, { skipNotification: true, skipVocabularySync: true });
    await deleteRecord(goneId, { skipNotification: true });
    await createRecord(
      {
        type: "address",
        inputString: ADDR_ADDED,
        label: "Added",
        tags: [],
        categories: [],
      } as unknown as CreateRecordData,
      { skipNotification: true, skipVocabularySync: true },
    );
    await restoreTag({ name: "beta", createdAt: Date.now() });

    const backupB = await exportToBlob({ encrypted: true, password: PASSWORD });
    const result = await compareBackups({
      older: { source: blobChunks(backupA) },
      newer: { source: blobChunks(backupB), password: PASSWORD },
    });

    const records = table(result, "records");
    expect(records.added).toBe(1);
    expect(records.removed).toBe(1);
    expect(records.changed).toBe(1);
    expect(records.suppressed).toBe(0);
    expect(records.entries.find((e) => e.change === "added")?.key).toBe(ADDR_ADDED);
    expect(records.entries.find((e) => e.change === "removed")?.key).toBe(ADDR_GONE);
    const changed = records.entries.find((e) => e.change === "changed");
    expect(changed?.key).toBe(ADDR_EDIT);
    expect(changed?.deltas).toEqual([{ field: "label", oldValue: "Before", newValue: "After" }]);

    // Vocabulary diff: the new tag shows up.
    const tags = table(result, "tags");
    expect(tags.added).toBe(1);
    expect(tags.entries[0].key).toBe("beta");

    // The CSV carries every entry (3 record rows + 1 tag row).
    expect(result.csv.rowCount).toBe(4);
    const csv = result.csv.parts.join("");
    expect(csv).toContain(ADDR_ADDED);
    expect(csv).toContain("Before");
    expect(csv).toContain("After");

    expect(result.newer.encrypted).toBe(true);
    expect(result.older.encrypted).toBe(false);
  }, 180_000);

  it("rejects a wrong password on the encrypted side before comparing", async () => {
    const backupB = await exportToBlob({ encrypted: true, password: PASSWORD });
    await expect(
      compareBackups({
        older: { source: blobChunks(backupA) },
        newer: { source: blobChunks(backupB), password: "definitely-wrong" },
      }),
    ).rejects.toThrow(/Newer backup: Invalid password or corrupted backup/);
  }, 180_000);

  it("rejects an encrypted backup when no password is supplied", async () => {
    const backupB = await exportToBlob({ encrypted: true, password: PASSWORD });
    await expect(
      compareBackups({
        older: { source: blobChunks(backupA) },
        newer: { source: blobChunks(backupB) },
      }),
    ).rejects.toThrow(/Password required/);
  }, 180_000);
});

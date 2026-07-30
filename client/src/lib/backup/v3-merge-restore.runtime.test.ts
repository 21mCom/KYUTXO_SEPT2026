// @vitest-environment jsdom
//
// Merge-mode regression guard for the v3 streaming restore. `restoreV3Backup`
// historically was replace-only (always cleared the vault); the merge mode this
// file guards must:
//   1. NEVER clear existing data — local-only rows (a record, a transaction,
//      its sync state) survive the merge untouched.
//   2. De-dupe every streamed table by its natural key when the backup overlaps
//      the live vault: records by `inputString`, blockchainTransactions by
//      `txid`, addressSyncState by `address`, attachments by
//      `objectStoragePath`, utxoLineage by its edge identity, custodySegments
//      by `segmentId`, lineageSnapshots by `snapshotId` (the last three carry
//      UNIQUE indexes, so without the skip a merge would abort mid-way).
//   3. ENRICH a live placeholder transaction (blockHeight/fee 0) and its
//      participants from the richer backup row instead of duplicating or
//      overwriting it.
//   4. Be idempotent: merging the identical backup twice changes nothing.
//
// A real backup zip produced by `exportBackup` is fed back through
// `restoreV3Backup({ restoreMode: "merge" })` — the exact production path the
// restore dialog now drives. The backup is UNENCRYPTED so no WebCrypto subtle
// support is required.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";

import { exportBackup, type AttachmentFileIO } from "./export";
import {
  restoreV3Backup,
  AttachmentWriteError,
  RestoreInterruptedError,
  type AttachmentFileWriter,
} from "./restore";
import { BackupCancelledError, MemorySink, type BackupSink } from "./sink";
import { blobChunks } from "./zip-stream";

import { db } from "@/lib/database";
import {
  bulkCreateRecords,
  getAllRecords,
  clearAllRecords,
  type CreateRecordData,
} from "@/lib/data/record-crud";
import {
  addAttachment,
  getAllAttachments,
  clearAttachments,
} from "@/lib/data/attachments-crud";
import {
  bulkAddTransactions,
  bulkAddParticipants,
  getTransactionsByTxids,
  getParticipantsByTxids,
  clearParticipants,
  clearTransactions,
} from "@/lib/data/transaction-crud";
import {
  bulkAddAddressSyncState,
  getAllAddressSyncState,
  clearAddressSyncState,
} from "@/lib/data/address-sync-crud";
import {
  addUtxoLineage,
  addCustodySegment,
  addLineageSnapshot,
  getAllUtxoLineage,
  getAllCustodySegments,
  getAllLineageSnapshots,
  clearUtxoLineage,
  clearCustodySegments,
  clearLineageSnapshots,
} from "@/lib/data/lineage-crud";
import { clearNodeSettings } from "@/lib/data/node-settings-crud";
import {
  addCustomField,
  getAllCustomFields,
  clearCustomFields,
} from "@/lib/data/custom-fields-crud";
import {
  addDerivationTemplate,
  getAllDerivationTemplates,
  clearDerivationTemplates,
} from "@/lib/data/derivation-templates-crud";
import { getTags, getOwners, restoreTag, restoreOwner } from "@/lib/data/vocabulary-crud";

const attachmentIO: AttachmentFileIO = {
  async listAll() {
    return [];
  },
  async read() {
    return null;
  },
};
const attachmentWriter: AttachmentFileWriter = {
  async write() {},
};

const TXID_SHARED = "a".repeat(64);
const TXID_LOCAL = "b".repeat(64);
const SPENT_TXID = "c".repeat(64);

const RECORD_SHARED: CreateRecordData = {
  type: "address",
  inputString: "bc1qshared0000000000000000000000000000000000",
  label: "Shared address",
  tags: [],
  categories: [],
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
} as CreateRecordData;

const RECORD_LOCAL: CreateRecordData = {
  type: "address",
  inputString: "bc1qlocalonly000000000000000000000000000000",
  label: "Local only address",
  tags: [],
  categories: [],
  createdAt: 1_700_000_100_000,
  updatedAt: 1_700_000_100_000,
} as CreateRecordData;

async function clearEverything(): Promise<void> {
  await clearAllRecords({ skipNotification: true });
  await clearAttachments({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearAddressSyncState({ skipNotification: true });
  await clearUtxoLineage({ skipNotification: true });
  await clearCustodySegments({ skipNotification: true });
  await clearLineageSnapshots({ skipNotification: true });
  await clearNodeSettings({ skipNotification: true });
  await clearCustomFields({ skipNotification: true });
  await clearDerivationTemplates({ skipNotification: true });
  await db.tags.clear();
  await db.categories.clear();
  await db.owners.clear();
  await db.walletNames.clear();
  await db.seedNames.clear();
  await db.walletSoftware.clear();
}

// Seed the "rich" vault whose contents get exported.
async function seedExportedVault(): Promise<number> {
  const [recordId] = await bulkCreateRecords([RECORD_SHARED], {
    skipNotification: true,
    skipVocabularySync: true,
  });
  await addAttachment(
    {
      recordId,
      filename: "receipt.pdf",
      mimeType: "application/pdf",
      size: 1234,
      objectStoragePath: "ab/receipt-hash.bin",
      createdAt: 1_700_000_000_000,
    },
    { skipNotification: true },
  );
  await bulkAddTransactions(
    [
      {
        txid: TXID_SHARED,
        blockHeight: 800_000,
        blockTime: 1_700_000_000,
        fee: 210,
        feeRate: 1.5,
        syncedAt: 1_700_000_500_000,
      },
    ],
    { skipNotification: true },
  );
  await bulkAddParticipants(
    [
      {
        txid: TXID_SHARED,
        role: "output",
        address: RECORD_SHARED.inputString,
        amount: 50_000,
        vout: 0,
        recordId,
      },
    ],
    { skipNotification: true },
  );
  await bulkAddAddressSyncState(
    [
      {
        address: RECORD_SHARED.inputString,
        recordId,
        lastSyncedHeight: 800_000,
        lastSyncedAt: 1_700_000_500_000,
        txCount: 1,
      },
    ],
    { skipNotification: true },
  );
  await addUtxoLineage(
    {
      spentTxid: SPENT_TXID,
      spentVout: 0,
      spentAddress: "bc1qorigin000000000000000000000000000000000",
      spentAmount: 60_000,
      consumingTxid: TXID_SHARED,
      createdTxid: TXID_SHARED,
      createdVout: 0,
      createdAddress: RECORD_SHARED.inputString,
      createdAmount: 50_000,
      spentOwned: false,
      createdOwned: true,
      isChange: false,
      confidence: "confirmed" as any,
      blockTime: 1_700_000_000,
      blockHeight: 800_000,
      segmentId: "seg-1",
      createdAt: 1_700_000_500_000,
    } as any,
    { skipNotification: true },
  );
  await addCustodySegment(
    {
      segmentId: "seg-1",
      originTxid: TXID_SHARED,
      originVout: 0,
      originAddress: RECORD_SHARED.inputString,
      originDate: 1_700_000_000,
      originAmount: 50_000,
      currentAmount: 50_000,
      status: "active",
      hopCount: 1,
      evidenceTxids: [TXID_SHARED],
      createdAt: 1_700_000_500_000,
      updatedAt: 1_700_000_500_000,
    } as any,
    { skipNotification: true },
  );
  await addLineageSnapshot(
    {
      snapshotId: "snap-1",
      targetType: "address",
      targetAddress: RECORD_SHARED.inputString,
      segments: ["seg-1"],
      evidenceTxids: [TXID_SHARED],
      totalAmount: 50_000,
      earliestDate: 1_700_000_000,
      latestDate: 1_700_000_000,
      hopCount: 1,
      narrative: "test snapshot",
      disclosureLevel: "full",
      generatedAt: 1_700_000_500_000,
    } as any,
    { skipNotification: true },
  );
  // Vocabulary rows ride inline with NO uniqueness constraint — merge must
  // de-dupe them by name or every re-merge visibly duplicates tags/owners.
  await restoreTag({ name: "kyc", color: "#ff0000", createdAt: 1_700_000_000_000 });
  await restoreOwner({ name: "Alice", createdAt: 1_700_000_000_000 });
  // Inline-table definitions that ride in the manifest: both have caused real
  // merge duplication (no unique index guards derivation templates; custom
  // fields de-dupe by slug), so the idempotence assertions must cover them.
  await addCustomField(
    { name: "KYC Ref", slug: "kyc-ref", enabled: true, createdAt: 1_700_000_000_000 },
    { skipNotification: true },
  );
  await addDerivationTemplate(
    {
      fingerprint: "deadbeef",
      scriptType: "P2WPKH",
      derivationPath: "m/84'/0'/0'",
      gapLimit: 20,
      network: "mainnet",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    } as any,
    { skipNotification: true },
  );
  return recordId;
}

async function exportToBlob(): Promise<Blob> {
  const sink = new MemorySink();
  await exportBackup({
    sink: sink as BackupSink,
    encrypted: false,
    batchSize: 25,
    attachmentIO,
  });
  const blob = sink.blob as Blob;
  expect(blob).toBeInstanceOf(Blob);
  return blob;
}

// Add local-only rows the backup does not contain, plus a PLACEHOLDER version
// of the shared transaction (blockHeight/fee 0, blank-address participant) so
// the merge has something to enrich.
async function seedLocalVaultForMerge(): Promise<void> {
  const [localRecordId] = await bulkCreateRecords([RECORD_LOCAL], {
    skipNotification: true,
    skipVocabularySync: true,
  });
  await bulkAddTransactions(
    [
      // Placeholder version of the SHARED tx: same txid, unresolved fields.
      {
        txid: TXID_SHARED,
        blockHeight: 0,
        blockTime: 0,
        fee: 0,
        feeRate: 0,
        syncedAt: 0,
      },
      // Local-only tx the backup does not carry.
      {
        txid: TXID_LOCAL,
        blockHeight: 810_000,
        blockTime: 1_701_000_000,
        fee: 100,
        feeRate: 1,
        syncedAt: 1_701_000_500_000,
      },
    ],
    { skipNotification: true },
  );
  await bulkAddParticipants(
    [
      // Placeholder participant for the shared tx: same vout, blank address.
      {
        txid: TXID_SHARED,
        role: "output",
        address: "",
        amount: 0,
        vout: 0,
      },
      {
        txid: TXID_LOCAL,
        role: "output",
        address: RECORD_LOCAL.inputString,
        amount: 10_000,
        vout: 0,
        recordId: localRecordId,
      },
    ],
    { skipNotification: true },
  );
  await bulkAddAddressSyncState(
    [
      {
        address: RECORD_LOCAL.inputString,
        recordId: localRecordId,
        lastSyncedHeight: 810_000,
        lastSyncedAt: 1_701_000_500_000,
        txCount: 1,
      },
    ],
    { skipNotification: true },
  );
}

async function snapshotVault() {
  return {
    records: (await getAllRecords()).map((r) => r.inputString).sort(),
    attachments: (await getAllAttachments()).map((a) => a.objectStoragePath).sort(),
    txs: await getTransactionsByTxids([TXID_SHARED, TXID_LOCAL]),
    participants: await getParticipantsByTxids([TXID_SHARED, TXID_LOCAL]),
    syncState: (await getAllAddressSyncState()).map((s) => s.address).sort(),
    lineage: await getAllUtxoLineage(),
    segments: await getAllCustodySegments(),
    snapshots: await getAllLineageSnapshots(),
    customFields: (await getAllCustomFields()).map((f) => f.slug).sort(),
    derivationTemplates: await getAllDerivationTemplates(),
    tags: (await getTags()).map((t) => t.name).sort(),
    owners: (await getOwners()).map((o) => o.name).sort(),
  };
}

describe("v3 merge restore", () => {
  beforeEach(async () => {
    await clearEverything();
  });

  it("merges a real backup zip: de-dupes by natural keys, enriches placeholders, keeps local-only data, and is idempotent", async () => {
    await seedExportedVault();
    const blob = await exportToBlob();

    // Rebuild the live vault as: shared record + attachment + lineage KEPT,
    // shared tx downgraded to a placeholder, plus local-only rows.
    await clearTransactions({ skipNotification: true });
    await clearParticipants({ skipNotification: true });
    await seedLocalVaultForMerge();

    const result = await restoreV3Backup({
      source: blobChunks(blob),
      attachmentWriter,
      restoreMode: "merge",
    });

    // Records: the shared record collided by inputString (skipped), so only
    // the two pre-existing records remain — nothing doubled, local-only kept.
    const after = await snapshotVault();
    expect(after.records).toEqual(
      [RECORD_LOCAL.inputString, RECORD_SHARED.inputString].sort(),
    );
    expect(result.counts.records).toBe(0);

    // Attachments: the backup row collided by objectStoragePath — not doubled.
    expect(after.attachments).toEqual(["ab/receipt-hash.bin"]);

    // Transactions: exactly one row per txid; the shared placeholder was
    // ENRICHED from the backup (blockHeight/fee filled in), the local-only tx
    // survived untouched.
    expect(after.txs).toHaveLength(2);
    const shared = after.txs.find((t) => t.txid === TXID_SHARED)!;
    expect(shared.blockHeight).toBe(800_000);
    expect(shared.fee).toBe(210);
    expect(shared.feeRate).toBe(1.5);
    const local = after.txs.find((t) => t.txid === TXID_LOCAL)!;
    expect(local.blockHeight).toBe(810_000);

    // Participants: the placeholder output (vout 0) was matched and enriched —
    // address/amount/recordId filled in, no duplicate row added.
    const sharedParts = after.participants.filter((p) => p.txid === TXID_SHARED);
    expect(sharedParts).toHaveLength(1);
    expect(sharedParts[0].address).toBe(RECORD_SHARED.inputString);
    expect(sharedParts[0].amount).toBe(50_000);
    expect(typeof sharedParts[0].recordId).toBe("number");
    expect(after.participants.filter((p) => p.txid === TXID_LOCAL)).toHaveLength(1);

    // addressSyncState: unique `address` index respected — the shared address
    // was skipped, local-only kept, and the backup's shared-address row did not
    // abort the restore.
    expect(after.syncState).toEqual(
      [RECORD_LOCAL.inputString, RECORD_SHARED.inputString].sort(),
    );

    // Lineage tables: unique/natural keys respected — nothing doubled.
    expect(after.lineage).toHaveLength(1);
    expect(after.segments).toHaveLength(1);
    expect(after.snapshots).toHaveLength(1);

    // Inline definitions: custom fields de-dupe by slug, derivation templates
    // by fingerprint+scriptType+path+network — the live vault kept its copies
    // and the overlapping backup copies were skipped, not duplicated.
    expect(after.customFields).toEqual(["kyc-ref"]);
    expect(after.derivationTemplates).toHaveLength(1);
    // Vocabulary de-dupes by name — the live copies survive, backup copies skip.
    expect(after.tags).toEqual(["kyc"]);
    expect(after.owners).toEqual(["Alice"]);

    // Idempotence: merging the identical backup again changes nothing.
    await restoreV3Backup({
      source: blobChunks(blob),
      attachmentWriter,
      restoreMode: "merge",
    });
    const again = await snapshotVault();
    expect(again.records).toEqual(after.records);
    expect(again.attachments).toEqual(after.attachments);
    expect(again.txs).toHaveLength(2);
    expect(again.participants).toHaveLength(after.participants.length);
    expect(again.syncState).toEqual(after.syncState);
    expect(again.lineage).toHaveLength(1);
    expect(again.segments).toHaveLength(1);
    expect(again.snapshots).toHaveLength(1);
    expect(again.customFields).toEqual(["kyc-ref"]);
    expect(again.derivationTemplates).toHaveLength(1);
    expect(again.tags).toEqual(["kyc"]);
    expect(again.owners).toEqual(["Alice"]);
  });

  it("mid-merge failure NEVER clears existing data: local-only rows survive, already-merged rows remain, and re-running the merge recovers cleanly", async () => {
    // Export a backup that carries a real attachment FILE entry (streamed
    // AFTER all NDJSON tables), so a writer that throws fails the merge only
    // after streamed rows were already merged — the worst case the merge
    // failure contract must handle.
    await seedExportedVault();
    const fileIO: AttachmentFileIO = {
      async listAll() {
        return ["ab/receipt-hash.bin"];
      },
      async read() {
        return new Uint8Array([1, 2, 3, 4]).buffer;
      },
    };
    const sink = new MemorySink();
    await exportBackup({
      sink: sink as BackupSink,
      encrypted: false,
      batchSize: 25,
      attachmentIO: fileIO,
    });
    const blob = sink.blob as Blob;

    // Local vault: keep the shared record + attachment row, downgrade the
    // shared tx to a placeholder, add local-only rows — same setup as the
    // happy-path merge, but drop the attachment DB row's collision by removing
    // it so the merge actually has a file+row to add... keep it simple: keep
    // everything (row collides, file write still attempted).
    await clearTransactions({ skipNotification: true });
    await clearParticipants({ skipNotification: true });
    await seedLocalVaultForMerge();
    const before = await snapshotVault();

    const failingWriter: AttachmentFileWriter = {
      async write() {
        throw new Error("disk full");
      },
    };
    let thrown: unknown = null;
    try {
      await restoreV3Backup({
        source: blobChunks(blob),
        attachmentWriter: failingWriter,
        restoreMode: "merge",
      });
    } catch (err) {
      thrown = err;
    }

    // Contract: the failure propagates as the RAW AttachmentWriteError (merge
    // never crossed a destructive clear), NEVER as RestoreInterruptedError —
    // that type means "the vault was cleared", which must be impossible here.
    expect(thrown).toBeInstanceOf(AttachmentWriteError);
    expect(thrown).not.toBeInstanceOf(RestoreInterruptedError);

    // Existing data fully intact; streamed rows merged before the failure
    // remain (additive, not atomic): the placeholder tx was already enriched.
    const after = await snapshotVault();
    expect(after.records).toEqual(before.records);
    expect(after.syncState).toEqual(before.syncState);
    expect(after.txs).toHaveLength(2);
    const shared = after.txs.find((t) => t.txid === TXID_SHARED)!;
    expect(shared.blockHeight).toBe(800_000);
    expect(after.txs.find((t) => t.txid === TXID_LOCAL)!.blockHeight).toBe(810_000);

    // Recovery: re-running the same merge with a working writer completes and
    // de-dupes everything already merged — no doubles anywhere.
    await restoreV3Backup({
      source: blobChunks(blob),
      attachmentWriter,
      restoreMode: "merge",
    });
    const recovered = await snapshotVault();
    expect(recovered.records).toEqual(before.records);
    expect(recovered.attachments).toEqual(["ab/receipt-hash.bin"]);
    expect(recovered.txs).toHaveLength(2);
    expect(recovered.participants).toHaveLength(2);
    expect(recovered.syncState).toEqual(before.syncState);
    expect(recovered.lineage).toHaveLength(1);
    expect(recovered.segments).toHaveLength(1);
    expect(recovered.snapshots).toHaveLength(1);
  });

  it("de-dupes duplicate record identities both WITHIN a batch and ACROSS streamed batches, linking dependent rows to the single surviving record", async () => {
    // Four records exported with batchSize=2 stream as [A, D] then [B, C]:
    // D repeats A's inputString IN THE SAME batch (records.inputString is
    // indexed but not unique, so only in-batch collapsing prevents a double
    // insert), and C repeats it in a LATER batch (per-batch-only DB lookups
    // would miss it — A wasn't in the DB when batch 1 was checked). D owns an
    // attachment and C a sync-state row; both must remap to the ONE surviving
    // record.
    const DUP = "bc1qdupacrossbatches000000000000000000000000";
    const mk = (label: string, inputString: string): CreateRecordData =>
      ({
        type: "address",
        inputString,
        label,
        tags: [],
        categories: [],
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      }) as CreateRecordData;
    const [, idD, , idC] = await bulkCreateRecords(
      [
        mk("A", DUP),
        mk("D", DUP),
        mk("B", "bc1qother0000000000000000000000000000000000"),
        mk("C", DUP),
      ],
      { skipNotification: true, skipVocabularySync: true },
    );
    await addAttachment(
      {
        recordId: idD,
        filename: "c.pdf",
        mimeType: "application/pdf",
        size: 10,
        objectStoragePath: "cd/c-hash.bin",
        createdAt: 1_700_000_000_000,
      },
      { skipNotification: true },
    );
    await bulkAddAddressSyncState(
      [
        {
          address: "bc1qsyncforc00000000000000000000000000000000",
          recordId: idC,
          lastSyncedHeight: 1,
          lastSyncedAt: 1,
          txCount: 0,
        },
      ],
      { skipNotification: true },
    );

    const sink = new MemorySink();
    await exportBackup({
      sink: sink as BackupSink,
      encrypted: false,
      batchSize: 2,
      attachmentIO,
    });
    const blob = sink.blob as Blob;
    await clearEverything();

    await restoreV3Backup({
      source: blobChunks(blob),
      attachmentWriter,
      restoreMode: "merge",
    });

    // Exactly ONE record per inputString survives, even though the duplicate
    // arrived in a later batch than the original.
    const records = await getAllRecords();
    const dups = records.filter((r) => r.inputString === DUP);
    expect(dups).toHaveLength(1);
    expect(records).toHaveLength(2);

    // C's dependent rows remapped onto the single surviving duplicate record.
    const atts = await getAllAttachments();
    expect(atts).toHaveLength(1);
    expect(atts[0].recordId).toBe(dups[0].id);
    const sync = await getAllAddressSyncState();
    expect(sync).toHaveLength(1);
    expect(sync[0].recordId).toBe(dups[0].id);
  });

  it("cancelling a merge mid-stream UNDOES everything the merge added: inserted rows removed, enriched rows reverted, vault byte-identical to before", async () => {
    // Backup with a real attachment FILE entry so the ZIP stream ends with a
    // file-bytes entry — aborting there guarantees every NDJSON table (records,
    // participants, sync state, transactions incl. enrichment, lineage) was
    // already merged before the cancel, the worst case the undo must handle.
    const exportedRecordId = await seedExportedVault();
    // A SECOND attachment row/file so the abort (fired on the progress report
    // AFTER file 1 is written) is caught by file 2's abort check — aborting on
    // the last entry's report would let the stream finish successfully.
    await addAttachment(
      {
        recordId: exportedRecordId,
        filename: "invoice.pdf",
        mimeType: "application/pdf",
        size: 99,
        objectStoragePath: "cd/invoice-hash.bin",
        createdAt: 1_700_000_000_000,
      },
      { skipNotification: true },
    );
    // An ORPHAN attachment row (recordId that exists in no exported record) so
    // the restore routes its file bytes to the Needs Review folder via
    // writeReview() — a cancelled merge must sweep that file too. Its export
    // position (2nd of 3, listAll order) also guarantees a later entry exists
    // whose abort check fires after we cancel inside writeReview.
    await addAttachment(
      {
        recordId: 999_999,
        filename: "stray-deed.pdf",
        mimeType: "application/pdf",
        size: 55,
        objectStoragePath: "ef/orphan-hash.bin",
        createdAt: 1_700_000_000_000,
      },
      { skipNotification: true },
    );
    const fileIO: AttachmentFileIO = {
      async listAll() {
        return ["ab/receipt-hash.bin", "ef/orphan-hash.bin", "cd/invoice-hash.bin"];
      },
      async read() {
        return new Uint8Array([1, 2, 3, 4]).buffer;
      },
    };
    const sink = new MemorySink();
    await exportBackup({
      sink: sink as BackupSink,
      encrypted: false,
      batchSize: 25,
      attachmentIO: fileIO,
    });
    const blob = sink.blob as Blob;

    // Live vault: DIFFERENT from the backup — local-only record/tx/sync rows
    // plus a placeholder copy of the shared tx the merge will ENRICH. All the
    // backup-only rows (shared record's lineage etc. were kept; clear them so
    // the merge really inserts rows to undo).
    await clearEverything();
    await seedLocalVaultForMerge();
    const before = await snapshotVault();

    const deletedFiles: string[] = [];
    const deletedReviewFiles: string[] = [];
    const controller = new AbortController();
    const trackingWriter: AttachmentFileWriter = {
      async write() {},
      async delete(relPath: string) {
        deletedFiles.push(relPath);
      },
      // The orphan's bytes land here (2nd file entry). Abort NOW: file 1 was
      // written normally, every NDJSON table is merged, and file 3's abort
      // check turns the abort into the cancellation. Return the de-duped
      // final filename the Needs Review folder would use.
      async writeReview(originalFilename: string) {
        controller.abort();
        return `${originalFilename}`;
      },
      async deleteReview(name: string) {
        deletedReviewFiles.push(name);
      },
    };

    let thrown: unknown = null;
    try {
      await restoreV3Backup({
        source: blobChunks(blob),
        attachmentWriter: trackingWriter,
        restoreMode: "merge",
        signal: controller.signal,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(BackupCancelledError);
    const cancelErr = thrown as BackupCancelledError;
    expect(cancelErr.clearedBeforeCancel).toBe(false);
    expect(cancelErr.mergeUndone).toBe(true);
    expect(cancelErr.mergeUndoFailed).toBeUndefined();
    // At least: shared record + 2 attachment rows + sync state + lineage +
    // segment + snapshot were inserted then removed (the shared tx and its
    // participant were ENRICHED, not inserted).
    expect(cancelErr.mergeUndoRowsRemoved ?? 0).toBeGreaterThanOrEqual(7);

    // The vault is EXACTLY as it was before the merge: inserted rows gone,
    // the placeholder tx's enriched fields reverted, the enriched participant
    // restored verbatim, local-only rows untouched.
    const after = await snapshotVault();
    expect(after.records).toEqual(before.records);
    expect(after.attachments).toEqual(before.attachments);
    expect(after.syncState).toEqual(before.syncState);
    expect(after.lineage).toHaveLength(before.lineage.length);
    expect(after.segments).toHaveLength(before.segments.length);
    expect(after.snapshots).toHaveLength(before.snapshots.length);
    expect(after.txs).toHaveLength(2);
    const shared = after.txs.find((t) => t.txid === TXID_SHARED)!;
    expect(shared.blockHeight).toBe(0); // enrichment reverted
    expect(shared.fee).toBe(0);
    const sharedParts = after.participants.filter((p) => p.txid === TXID_SHARED);
    expect(sharedParts).toHaveLength(1);
    expect(sharedParts[0].address).toBe(""); // enrichment reverted
    expect(sharedParts[0].amount).toBe(0);
    expect(after.txs.find((t) => t.txid === TXID_LOCAL)!.blockHeight).toBe(810_000);

    // Exactly ONE normal attachment file had been written before the abort
    // (files stream in listAll order); it backed a row this merge inserted, so
    // the undo swept it from disk. The orphan's Needs Review file was swept
    // too, via the exact filename writeReview reported.
    expect(deletedFiles).toEqual(["ab/receipt-hash.bin"]);
    expect(deletedReviewFiles).toEqual(["stray-deed.pdf"]);

    // And re-running the merge to completion afterwards works normally.
    const result = await restoreV3Backup({
      source: blobChunks(blob),
      attachmentWriter: trackingWriter,
      restoreMode: "merge",
    });
    expect(result.counts.records).toBe(1);
    const recovered = await snapshotVault();
    expect(recovered.records).toEqual(
      [RECORD_LOCAL.inputString, RECORD_SHARED.inputString].sort(),
    );
  });

  it("cancelling a merge also undoes lineage/segments/snapshots restored from INLINE compatibility data (older v3 backups)", async () => {
    // Older v3 backups carried utxoLineage/custodySegments/lineageSnapshots
    // INLINE in the manifest instead of streamed. Those rows are inserted by
    // restoreInlineTables BEFORE any streamed row, so the undo log must pick
    // up their ids from its return value or a cancelled merge of an old
    // backup leaves them behind. Simulate the old shape by wrapping the REAL
    // restoreInlineTables and injecting inline lineage rows.
    await seedExportedVault();
    const blob = await exportToBlob();
    await clearEverything();
    await seedLocalVaultForMerge();
    // Purge lineage tables so any post-cancel row is provably merge-added.
    const before = await snapshotVault();
    expect(before.lineage).toHaveLength(0);
    expect(before.segments).toHaveLength(0);
    expect(before.snapshots).toHaveLength(0);

    const { restoreInlineTables } = await import("./inline-tables");
    const INLINE_EXTRA = {
      utxoLineage: [
        {
          id: 999,
          spentTxid: "d".repeat(64),
          spentVout: 1,
          spentAddress: "bc1qinlineorigin0000000000000000000000000000",
          spentAmount: 10_000,
          consumingTxid: "e".repeat(64),
          createdTxid: "e".repeat(64),
          createdVout: 0,
          createdAddress: RECORD_LOCAL.inputString,
          createdAmount: 9_000,
          spentOwned: false,
          createdOwned: true,
          isChange: false,
          confidence: "confirmed",
          blockTime: 1_700_100_000,
          blockHeight: 800_100,
          segmentId: "seg-inline-1",
          createdAt: 1_700_100_000_000,
        },
      ],
      custodySegments: [
        {
          id: 998,
          segmentId: "seg-inline-1",
          originTxid: "e".repeat(64),
          originVout: 0,
          originAddress: RECORD_LOCAL.inputString,
          originDate: 1_700_100_000,
          originAmount: 9_000,
          currentAmount: 9_000,
          status: "active",
          hopCount: 1,
          evidenceTxids: ["e".repeat(64)],
          createdAt: 1_700_100_000_000,
          updatedAt: 1_700_100_000_000,
        },
      ],
      lineageSnapshots: [
        {
          id: 997,
          snapshotId: "snap-inline-1",
          targetType: "address",
          targetAddress: RECORD_LOCAL.inputString,
          segments: ["seg-inline-1"],
          evidenceTxids: ["e".repeat(64)],
          totalAmount: 9_000,
          earliestDate: 1_700_100_000,
          latestDate: 1_700_100_000,
          hopCount: 1,
          narrative: "inline snapshot",
          disclosureLevel: "full",
          generatedAt: 1_700_100_000_000,
        },
      ],
    };

    const controller = new AbortController();
    let thrown: unknown = null;
    try {
      await restoreV3Backup({
        source: blobChunks(blob),
        attachmentWriter,
        restoreMode: "merge",
        signal: controller.signal,
        restoreInline: (data, mode) =>
          restoreInlineTables({ ...data, ...INLINE_EXTRA }, mode),
        onProgress: (p) => {
          // Cancel while the streamed tables are still being merged — the
          // inline rows above were already inserted by then.
          if (p.phase.startsWith("Restoring records")) controller.abort();
        },
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(BackupCancelledError);
    const cancelErr = thrown as BackupCancelledError;
    expect(cancelErr.mergeUndone).toBe(true);

    // The inline-restored lineage rows were removed along with everything else.
    const after = await snapshotVault();
    expect(after.lineage).toHaveLength(0);
    expect(after.segments).toHaveLength(0);
    expect(after.snapshots).toHaveLength(0);
    expect(after.records).toEqual(before.records);
    expect(after.txs).toHaveLength(before.txs.length);
  });

  it("merge into an EMPTY vault restores everything the backup carries (no clear needed)", async () => {
    await seedExportedVault();
    const blob = await exportToBlob();
    await clearEverything();

    const result = await restoreV3Backup({
      source: blobChunks(blob),
      attachmentWriter,
      restoreMode: "merge",
    });

    expect(result.counts.records).toBe(1);
    expect(result.counts.blockchainTransactions).toBe(1);
    expect(result.counts.transactionParticipants).toBe(1);
    expect(result.counts.addressSyncState).toBe(1);
    expect(result.counts.utxoLineage).toBe(1);
    expect(result.counts.custodySegments).toBe(1);
    expect(result.counts.lineageSnapshots).toBe(1);
    const after = await snapshotVault();
    expect(after.records).toEqual([RECORD_SHARED.inputString]);
    expect(after.attachments).toEqual(["ab/receipt-hash.bin"]);
  });
});

// @vitest-environment jsdom
//
// Guards the read-only merge analysis (analyzeV3Backup). The analysis must:
//   1. PREDICT a real merge: per-table "added" counts equal what
//      restoreV3Backup({ restoreMode: "merge" }) actually inserts when the same
//      backup is merged into the same live vault (records: added +
//      discoveryOnlySkipped — merge inserts discovery-only rows too).
//   2. Exclude blockchain-discovery-only records (compact prunable shape) from
//      the addable set and the CSV report, counting them as their own skipped
//      bucket — while records with ANY user metadata are always kept.
//   3. Never write to the vault: every table is byte-identical before/after.
//   4. Formula-injection-escape hostile cell values in the CSV report.
//   5. Honor cancellation and reject wrong-password/corrupt backups
//      non-destructively.
//
// A real backup zip produced by `exportBackup` is fed through both
// `analyzeV3Backup` and `restoreV3Backup` — the exact production paths.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";

import { exportBackup, type AttachmentFileIO } from "./export";
import { restoreV3Backup, type AttachmentFileWriter } from "./restore";
import { analyzeV3Backup } from "./analyze";
import { BackupCancelledError, MemorySink, type BackupSink } from "./sink";
import { blobChunks } from "./zip-stream";
import { CSV_EXPORT_HEADER } from "@/lib/csv-export";

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
  getAllTransactions,
  getAllTransactionParticipants,
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
import {
  addRecordOrigin,
  getAllRecordOrigins,
  clearRecordOrigins,
} from "@/lib/data/record-origins-crud";
import { createTag, createOwner, getTags, getOwners } from "@/lib/data/vocabulary-crud";
import { addCustomField, getAllCustomFields } from "@/lib/data/custom-fields-crud";
import {
  addDerivationTemplate,
  getAllDerivationTemplates,
} from "@/lib/data/derivation-templates-crud";
import { clearNodeSettings } from "@/lib/data/node-settings-crud";
import { clearCustomFields } from "@/lib/data/custom-fields-crud";
import { clearDerivationTemplates } from "@/lib/data/derivation-templates-crud";
import {
  clearEvidence,
  clearEvidenceAttachments,
  addEvidence,
  addEvidenceAttachment,
  getAllEvidence,
} from "@/lib/data/evidence-crud";
import { addPriceData, getAllPriceData, clearPriceData } from "@/lib/data/price-data-crud";
import {
  markOutpointsAsDust,
  getAllDustFlags,
  clearDustFlags,
} from "@/lib/data/dust-flags-crud";
import { savePsbt, getAllSavedPsbts, clearSavedPsbts } from "@/lib/data/saved-psbts-crud";

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

// Base fields for saved-PSBT fixtures; individual tests override name/base64.
const psbtBase = {
  destinationAddress: "bc1qshared0000000000000000000000000000000000",
  feeRateSatsPerVb: 1,
  feeSats: 100,
  estimatedVbytes: 100,
  totalInputSats: 10_000,
  sendAmountSats: 9_900,
  changeSats: 0,
  inputs: [],
  outputs: [],
};

const PASSWORD = "correct horse battery staple";

const TXID_SHARED = "a".repeat(64);
const TXID_BACKUP = "d".repeat(64);
const TXID_LOCAL = "b".repeat(64);

const ADDR_SHARED = "bc1qshared0000000000000000000000000000000000";
const ADDR_BACKUP = "bc1qbackuponly00000000000000000000000000000";
const ADDR_DISCOVERY = "bc1qdiscoveryonly00000000000000000000000000";
const ADDR_META = "bc1qdiscoverywithmeta0000000000000000000000";
const ADDR_LOCAL = "bc1qlocalonly000000000000000000000000000000";

const HOSTILE_LABEL = '=HYPERLINK("http://evil.example","x")';
const HOSTILE_NOTES = 'note with "quotes", commas\nand a newline';
const HOSTILE_OWNER = "+cmd-injection";

function sharedRecord(): CreateRecordData {
  return {
    type: "address",
    inputString: ADDR_SHARED,
    label: "Shared address",
    tags: [],
    categories: [],
    addressImportance: "manual",
    source: "manual",
  } as unknown as CreateRecordData;
}

// A bare blockchain-discovered record: exact prunable shape (no user
// metadata), so the analysis must exclude it from addable/CSV but count it as
// discoveryOnlySkipped. A merge WOULD insert it.
function discoveryOnlyRecord(): CreateRecordData {
  return {
    type: "address",
    inputString: ADDR_DISCOVERY,
    inputStringLower: ADDR_DISCOVERY,
    label: "",
    tags: [],
    categories: [],
    owner: "Pending Review",
    source: "blockchain-sync",
    syncDepth: 1,
    maxSyncedDepth: 0,
    discoveredInTxid: TXID_SHARED,
    addressImportance: "blockchain-discovered",
    firstSeenBlockTime: 1_700_000_000,
    walletName: "Main Wallet", // inherited from the discovering record — machine
    cachedBalanceSats: 1_000,
    cachedTxCount: 1,
    statsComputedAt: 1_700_000_002_000,
  } as unknown as CreateRecordData;
}

// A blockchain-discovered-tier record carrying USER metadata (hostile values
// on purpose): the tier must NOT exclude it — user metadata always wins — and
// the CSV report must formula-escape it.
function discoveryTierRecordWithMetadata(): CreateRecordData {
  return {
    type: "address",
    inputString: ADDR_META,
    inputStringLower: ADDR_META,
    label: HOSTILE_LABEL,
    notes: HOSTILE_NOTES,
    tags: ["=evil-tag"],
    categories: [],
    owner: HOSTILE_OWNER,
    source: "blockchain-sync",
    syncDepth: 1,
    maxSyncedDepth: 0,
    addressImportance: "blockchain-discovered",
  } as unknown as CreateRecordData;
}

async function clearEverything(): Promise<void> {
  await clearAllRecords({ skipNotification: true });
  await clearAttachments({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearAddressSyncState({ skipNotification: true });
  await clearUtxoLineage({ skipNotification: true });
  await clearCustodySegments({ skipNotification: true });
  await clearLineageSnapshots({ skipNotification: true });
  await clearRecordOrigins({ skipNotification: true });
  await clearNodeSettings({ skipNotification: true });
  await clearCustomFields({ skipNotification: true });
  await clearDerivationTemplates({ skipNotification: true });
  await clearEvidence({ skipNotification: true });
  await clearEvidenceAttachments({ skipNotification: true });
  await clearPriceData({ skipNotification: true });
  await clearDustFlags({ skipNotification: true });
  await clearSavedPsbts({ skipNotification: true });
  await db.tags.clear();
  await db.categories.clear();
  await db.owners.clear();
  await db.walletNames.clear();
  await db.seedNames.clear();
  await db.walletSoftware.clear();
}

// Seed the vault that gets exported to a backup: shared rows (which the live
// vault will also have) + backup-only rows (which it will not).
async function seedExportedVault(): Promise<number> {
  const [sharedId, backupId] = await bulkCreateRecords(
    [
      sharedRecord(),
      {
        type: "address",
        inputString: ADDR_BACKUP,
        label: "Backup only address",
        tags: ["backup"],
        categories: [],
        addressImportance: "manual",
        source: "manual",
      } as unknown as CreateRecordData,
      discoveryOnlyRecord(),
      discoveryTierRecordWithMetadata(),
    ],
    { skipNotification: true, skipVocabularySync: true },
  );
  await addAttachment(
    {
      recordId: sharedId,
      filename: "receipt.pdf",
      mimeType: "application/pdf",
      size: 1234,
      objectStoragePath: "ab/receipt-hash.bin",
      createdAt: 1_700_000_000_000,
    },
    { skipNotification: true },
  );
  await addAttachment(
    {
      recordId: backupId,
      filename: "new-doc.pdf",
      mimeType: "application/pdf",
      size: 4321,
      objectStoragePath: "cd/new-doc-hash.bin",
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
      {
        txid: TXID_BACKUP,
        blockHeight: 805_000,
        blockTime: 1_700_500_000,
        fee: 300,
        feeRate: 2,
        syncedAt: 1_700_500_500_000,
      },
    ],
    { skipNotification: true },
  );
  await bulkAddParticipants(
    [
      {
        txid: TXID_SHARED,
        role: "output",
        address: ADDR_SHARED,
        amount: 50_000,
        vout: 0,
        recordId: sharedId,
      },
      {
        txid: TXID_BACKUP,
        role: "output",
        address: ADDR_BACKUP,
        amount: 25_000,
        vout: 0,
        recordId: backupId,
      },
    ],
    { skipNotification: true },
  );
  await bulkAddAddressSyncState(
    [
      {
        address: ADDR_SHARED,
        recordId: sharedId,
        lastSyncedHeight: 800_000,
        lastSyncedAt: 1_700_000_500_000,
        txCount: 1,
      },
      {
        address: ADDR_BACKUP,
        recordId: backupId,
        lastSyncedHeight: 805_000,
        lastSyncedAt: 1_700_500_500_000,
        txCount: 1,
      },
    ],
    { skipNotification: true },
  );
  await addUtxoLineage(
    {
      spentTxid: TXID_SHARED,
      spentVout: 0,
      spentAddress: ADDR_SHARED,
      spentAmount: 50_000,
      consumingTxid: TXID_BACKUP,
      createdTxid: TXID_BACKUP,
      createdVout: 0,
      createdAddress: ADDR_BACKUP,
      createdAmount: 25_000,
      spentOwned: true,
      createdOwned: true,
      isChange: false,
      confidence: "confirmed" as any,
      blockTime: 1_700_500_000,
      blockHeight: 805_000,
      segmentId: "seg-shared",
      createdAt: 1_700_500_500_000,
    } as any,
    { skipNotification: true },
  );
  await addUtxoLineage(
    {
      spentTxid: TXID_BACKUP,
      spentVout: 0,
      spentAddress: ADDR_BACKUP,
      spentAmount: 25_000,
      consumingTxid: TXID_SHARED,
      createdTxid: TXID_SHARED,
      createdVout: 1,
      createdAddress: ADDR_SHARED,
      createdAmount: 10_000,
      spentOwned: true,
      createdOwned: true,
      isChange: false,
      confidence: "confirmed" as any,
      blockTime: 1_700_000_000,
      blockHeight: 800_000,
      segmentId: "seg-backup",
      createdAt: 1_700_000_500_000,
    } as any,
    { skipNotification: true },
  );
  await addCustodySegment(
    {
      segmentId: "seg-shared",
      originTxid: TXID_SHARED,
      originVout: 0,
      originAddress: ADDR_SHARED,
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
  await addCustodySegment(
    {
      segmentId: "seg-backup",
      originTxid: TXID_BACKUP,
      originVout: 0,
      originAddress: ADDR_BACKUP,
      originDate: 1_700_500_000,
      originAmount: 25_000,
      currentAmount: 25_000,
      status: "active",
      hopCount: 1,
      evidenceTxids: [TXID_BACKUP],
      createdAt: 1_700_500_500_000,
      updatedAt: 1_700_500_500_000,
    } as any,
    { skipNotification: true },
  );
  await addLineageSnapshot(
    {
      snapshotId: "snap-shared",
      targetType: "address",
      targetAddress: ADDR_SHARED,
      segments: ["seg-shared"],
      evidenceTxids: [TXID_SHARED],
      totalAmount: 50_000,
      earliestDate: 1_700_000_000,
      latestDate: 1_700_000_000,
      hopCount: 1,
      narrative: "shared snapshot",
      disclosureLevel: "full",
      generatedAt: 1_700_000_500_000,
    } as any,
    { skipNotification: true },
  );
  await addLineageSnapshot(
    {
      snapshotId: "snap-backup",
      targetType: "address",
      targetAddress: ADDR_BACKUP,
      segments: ["seg-backup"],
      evidenceTxids: [TXID_BACKUP],
      totalAmount: 25_000,
      earliestDate: 1_700_500_000,
      latestDate: 1_700_500_000,
      hopCount: 1,
      narrative: "backup snapshot",
      disclosureLevel: "full",
      generatedAt: 1_700_500_500_000,
    } as any,
    { skipNotification: true },
  );
  return sharedId;
}

// Seed the live vault the analysis/merge runs against: the SAME shared rows
// (matched by natural key) plus local-only rows the backup does not carry.
async function seedLiveVault(): Promise<void> {
  const [sharedId, localId] = await bulkCreateRecords(
    [
      sharedRecord(),
      {
        type: "address",
        inputString: ADDR_LOCAL,
        label: "Local only address",
        tags: [],
        categories: [],
        addressImportance: "manual",
        source: "manual",
      } as unknown as CreateRecordData,
    ],
    { skipNotification: true, skipVocabularySync: true },
  );
  await addAttachment(
    {
      recordId: sharedId,
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
      {
        txid: TXID_SHARED,
        role: "output",
        address: ADDR_SHARED,
        amount: 50_000,
        vout: 0,
        recordId: sharedId,
      },
      {
        txid: TXID_LOCAL,
        role: "output",
        address: ADDR_LOCAL,
        amount: 10_000,
        vout: 0,
        recordId: localId,
      },
    ],
    { skipNotification: true },
  );
  await bulkAddAddressSyncState(
    [
      {
        address: ADDR_SHARED,
        recordId: sharedId,
        lastSyncedHeight: 800_000,
        lastSyncedAt: 1_700_000_500_000,
        txCount: 1,
      },
    ],
    { skipNotification: true },
  );
  await addUtxoLineage(
    {
      spentTxid: TXID_SHARED,
      spentVout: 0,
      spentAddress: ADDR_SHARED,
      spentAmount: 50_000,
      consumingTxid: TXID_BACKUP,
      createdTxid: TXID_BACKUP,
      createdVout: 0,
      createdAddress: ADDR_BACKUP,
      createdAmount: 25_000,
      spentOwned: true,
      createdOwned: true,
      isChange: false,
      confidence: "confirmed" as any,
      blockTime: 1_700_500_000,
      blockHeight: 805_000,
      segmentId: "seg-shared",
      createdAt: 1_700_500_500_000,
    } as any,
    { skipNotification: true },
  );
  await addCustodySegment(
    {
      segmentId: "seg-shared",
      originTxid: TXID_SHARED,
      originVout: 0,
      originAddress: ADDR_SHARED,
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
      snapshotId: "snap-shared",
      targetType: "address",
      targetAddress: ADDR_SHARED,
      segments: ["seg-shared"],
      evidenceTxids: [TXID_SHARED],
      totalAmount: 50_000,
      earliestDate: 1_700_000_000,
      latestDate: 1_700_000_000,
      hopCount: 1,
      narrative: "shared snapshot",
      disclosureLevel: "full",
      generatedAt: 1_700_000_500_000,
    } as any,
    { skipNotification: true },
  );
}

async function exportToBlob(encrypted = false, password?: string): Promise<Blob> {
  const sink = new MemorySink();
  await exportBackup({
    sink: sink as BackupSink,
    encrypted,
    password,
    batchSize: 25,
    attachmentIO,
  });
  const blob = sink.blob as Blob;
  expect(blob).toBeInstanceOf(Blob);
  return blob;
}

// JSON snapshot of every streamed table PLUS the inline-metadata tables the
// analysis reads (vocabulary, custom fields, derivation templates,
// recordOrigins), for the read-only guarantee.
async function snapshotVaultTables(): Promise<string> {
  return JSON.stringify({
    records: await getAllRecords(),
    attachments: await getAllAttachments(),
    transactions: await getAllTransactions(),
    participants: await getAllTransactionParticipants(),
    syncState: await getAllAddressSyncState(),
    lineage: await getAllUtxoLineage(),
    segments: await getAllCustodySegments(),
    snapshots: await getAllLineageSnapshots(),
    tags: await db.tags.toArray(),
    categories: await db.categories.toArray(),
    owners: await db.owners.toArray(),
    walletNames: await db.walletNames.toArray(),
    seedNames: await db.seedNames.toArray(),
    walletSoftware: await db.walletSoftware.toArray(),
    customFields: await getAllCustomFields(),
    derivationTemplates: await getAllDerivationTemplates(),
    recordOrigins: await getAllRecordOrigins(),
  });
}

// Seed the inline-metadata tables in the LIVE vault so the read-only /
// cancellation snapshots would catch a regression that writes to them during
// inline classification (not just when they start empty).
async function seedLiveInlineMetadata(): Promise<void> {
  await createTag("live-tag");
  await createOwner("Live Owner");
  await db.categories.add({ name: "live-category", createdAt: 1_700_000_000_000 } as any);
  await db.walletNames.add({ name: "Live Wallet", createdAt: 1_700_000_000_000 } as any);
  await db.seedNames.add({ name: "Live Seed", createdAt: 1_700_000_000_000 } as any);
  await db.walletSoftware.add({ name: "Live Software", createdAt: 1_700_000_000_000 } as any);
  await addCustomField(
    { name: "Live Field", slug: "live-field", createdAt: 1_700_000_000_000 } as any,
    { skipNotification: true },
  );
  await addDerivationTemplate(
    {
      fingerprint: "cafebabe",
      scriptType: "P2WPKH",
      derivationPath: "m/84'/0'/1'",
      gapLimit: 20,
      network: "mainnet",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    } as any,
    { skipNotification: true },
  );
  const liveRecords = await getAllRecords();
  const liveSharedId = liveRecords.find((r) => r.inputString === ADDR_SHARED)!.id!;
  await addRecordOrigin(
    { recordId: liveSharedId, originType: "manual", source: "manual entry", createdAt: 1_700_000_001_000 },
    { skipNotification: true },
  );
}

describe("analyzeV3Backup (read-only merge analysis)", () => {
  beforeEach(async () => {
    await clearEverything();
  });

  it("predicts merge insert counts per table (analyze → merge parity)", async () => {
    await seedExportedVault();
    const blob = await exportToBlob(true, PASSWORD);
    await clearEverything();
    await seedLiveVault();

    const analysis = await analyzeV3Backup({ source: blobChunks(blob), password: PASSWORD });

    // Records: shared (present), backup-only (added), discovery-only (skipped),
    // discovery-tier-with-metadata (added — user metadata always wins).
    expect(analysis.tables.records).toEqual({
      total: 4,
      added: 2,
      alreadyPresent: 1,
      discoveryOnlySkipped: 1,
    });
    expect(analysis.tables.blockchainTransactions).toEqual({
      total: 2,
      added: 1,
      alreadyPresent: 1,
    });
    expect(analysis.tables.transactionParticipants).toEqual({
      total: 2,
      added: 1,
      alreadyPresent: 1,
    });
    expect(analysis.tables.addressSyncState).toEqual({
      total: 2,
      added: 1,
      alreadyPresent: 1,
    });
    expect(analysis.tables.attachments).toEqual({
      total: 2,
      added: 1,
      alreadyPresent: 1,
      orphanedSkipped: 0,
    });
    expect(analysis.tables.utxoLineage).toEqual({
      total: 2,
      added: 1,
      alreadyPresent: 1,
    });
    expect(analysis.tables.custodySegments).toEqual({
      total: 2,
      added: 1,
      alreadyPresent: 1,
    });
    expect(analysis.tables.lineageSnapshots).toEqual({
      total: 2,
      added: 1,
      alreadyPresent: 1,
    });

    // Now run the REAL merge on the same vault and compare insert counts.
    const merged = await restoreV3Backup({
      source: blobChunks(blob),
      attachmentWriter,
      restoreMode: "merge",
      password: PASSWORD,
    });
    // Merge inserts discovery-only records too — added + skipped predicts it.
    expect(merged.counts.records).toBe(
      analysis.tables.records.added + analysis.tables.records.discoveryOnlySkipped,
    );
    expect(merged.counts.blockchainTransactions).toBe(
      analysis.tables.blockchainTransactions.added,
    );
    expect(merged.counts.transactionParticipants).toBe(
      analysis.tables.transactionParticipants.added,
    );
    expect(merged.counts.addressSyncState).toBe(analysis.tables.addressSyncState.added);
    expect(merged.counts.attachments).toBe(analysis.tables.attachments.added);
    expect(merged.counts.utxoLineage).toBe(analysis.tables.utxoLineage.added);
    expect(merged.counts.custodySegments).toBe(analysis.tables.custodySegments.added);
    expect(merged.counts.lineageSnapshots).toBe(analysis.tables.lineageSnapshots.added);
  });

  it("predicts inline-metadata insert counts (vocabulary, custom fields, templates, recordOrigins, evidence, price history, dust flags, saved PSBTs)", async () => {
    // Exported vault: shared + backup-only vocabulary, a custom field, a
    // derivation template, and recordOrigins on both the shared and the
    // backup-only record (one origin duplicated in the live vault).
    const sharedId = await seedExportedVault();
    await createTag("shared-tag");
    await createTag("backup-only-tag");
    await createOwner("Backup Owner");
    await addCustomField(
      { name: "Case Number", slug: "case-number", createdAt: 1_700_000_000_000 } as any,
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
    const backupRecords = await getAllRecords();
    const backupOnlyId = backupRecords.find((r) => r.inputString === ADDR_BACKUP)!.id!;

    // recordOrigins in the backup: one on the shared record (duplicated in the
    // live vault → alreadyPresent) and two more that are backup-only → added.
    await addRecordOrigin(
      { recordId: sharedId, originType: "manual", source: "manual entry", createdAt: 1_700_000_001_000 },
      { skipNotification: true },
    );
    await addRecordOrigin(
      { recordId: sharedId, originType: "import", source: "wallet import", createdAt: 1_700_000_002_000 },
      { skipNotification: true },
    );
    await addRecordOrigin(
      { recordId: backupOnlyId, originType: "manual", source: "bulk import", createdAt: 1_700_000_003_000 },
      { skipNotification: true },
    );

    // Inline data rows: a "shared" one (duplicated in the live vault →
    // alreadyPresent) and a backup-only one (→ added) per table.
    await addEvidence(
      { title: "Shared Doc", documentType: "receipt", originalDate: "2024-01-01", tags: [], partiesInvolved: [] } as any,
      { skipNotification: true },
    );
    await addEvidence(
      { title: "Backup Doc", documentType: "invoice", originalDate: "2024-02-02", tags: [], partiesInvolved: [] } as any,
      { skipNotification: true },
    );
    await addPriceData({ date: "2024-01-01", currency: "USD", asset: "BTC", price: 42000 } as any, { skipNotification: true });
    await addPriceData({ date: "2024-02-02", currency: "USD", asset: "BTC", price: 43000 } as any, { skipNotification: true });
    await markOutpointsAsDust([
      { txid: TXID_SHARED, vout: 0, address: ADDR_SHARED, amountSats: 500 },
      { txid: TXID_BACKUP, vout: 0, address: ADDR_BACKUP, amountSats: 600 },
    ]);
    await savePsbt({ ...psbtBase, name: "Shared PSBT", psbtBase64: "cHNidP-shared" } as any);
    await savePsbt({ ...psbtBase, name: "Backup PSBT", psbtBase64: "cHNidP-backup" } as any);

    const blob = await exportToBlob(true, PASSWORD);
    await clearEverything();
    await seedLiveVault();
    await createTag("shared-tag");
    const liveRecords = await getAllRecords();
    const liveSharedId = liveRecords.find((r) => r.inputString === ADDR_SHARED)!.id!;
    await addRecordOrigin(
      { recordId: liveSharedId, originType: "manual", source: "manual entry", createdAt: 1_700_000_001_000 },
      { skipNotification: true },
    );

    // Live duplicates of the "shared" inline data rows → alreadyPresent.
    await addEvidence(
      { title: "Shared Doc", documentType: "receipt", originalDate: "2024-01-01", tags: [], partiesInvolved: [] } as any,
      { skipNotification: true },
    );
    await addPriceData({ date: "2024-01-01", currency: "USD", asset: "BTC", price: 42000 } as any, { skipNotification: true });
    await markOutpointsAsDust([
      { txid: TXID_SHARED, vout: 0, address: ADDR_SHARED, amountSats: 500 },
    ]);
    await savePsbt({ ...psbtBase, name: "Shared PSBT", psbtBase64: "cHNidP-shared" } as any);

    const analysis = await analyzeV3Backup({ source: blobChunks(blob), password: PASSWORD });
    expect(analysis.inline.tags).toEqual({ total: 2, added: 1, alreadyPresent: 1 });
    expect(analysis.inline.owners).toEqual({ total: 1, added: 1, alreadyPresent: 0 });
    expect(analysis.inline.customFields).toEqual({ total: 1, added: 1, alreadyPresent: 0 });
    expect(analysis.inline.derivationTemplates).toEqual({
      total: 1,
      added: 1,
      alreadyPresent: 0,
    });
    expect(analysis.inline.recordOrigins).toEqual({
      total: 3,
      added: 2,
      alreadyPresent: 1,
      orphanedSkipped: 0,
    });
    expect(analysis.inline.evidence).toEqual({ total: 2, added: 1, alreadyPresent: 1 });
    expect(analysis.inline.priceData).toEqual({ total: 2, added: 1, alreadyPresent: 1 });
    expect(analysis.inline.dustFlags).toEqual({ total: 2, added: 1, alreadyPresent: 1 });
    expect(analysis.inline.savedPsbts).toEqual({ total: 2, added: 1, alreadyPresent: 1 });

    // Parity with a REAL merge: exactly the predicted rows are inserted.
    const tagsBefore = (await getTags()).length;
    const ownersBefore = (await getOwners()).length;
    const fieldsBefore = (await getAllCustomFields()).length;
    const templatesBefore = (await getAllDerivationTemplates()).length;
    const originsBefore = (await getAllRecordOrigins()).length;
    const evidenceBefore = (await getAllEvidence()).length;
    const priceBefore = (await getAllPriceData()).length;
    const dustBefore = (await getAllDustFlags()).length;
    const psbtsBefore = (await getAllSavedPsbts()).length;

    await restoreV3Backup({
      source: blobChunks(blob),
      attachmentWriter,
      restoreMode: "merge",
      password: PASSWORD,
    });

    expect((await getTags()).length).toBe(tagsBefore + analysis.inline.tags.added);
    expect((await getOwners()).length).toBe(ownersBefore + analysis.inline.owners.added);
    expect((await getAllCustomFields()).length).toBe(
      fieldsBefore + analysis.inline.customFields.added,
    );
    expect((await getAllDerivationTemplates()).length).toBe(
      templatesBefore + analysis.inline.derivationTemplates.added,
    );
    expect((await getAllRecordOrigins()).length).toBe(
      originsBefore + analysis.inline.recordOrigins.added,
    );
    expect((await getAllEvidence()).length).toBe(
      evidenceBefore + analysis.inline.evidence.added,
    );
    expect((await getAllPriceData()).length).toBe(
      priceBefore + analysis.inline.priceData.added,
    );
    expect((await getAllDustFlags()).length).toBe(
      dustBefore + analysis.inline.dustFlags.added,
    );
    expect((await getAllSavedPsbts()).length).toBe(
      psbtsBefore + analysis.inline.savedPsbts.added,
    );
  });

  it("excludes discovery-only records from the CSV but keeps metadata-bearing ones, escaped", async () => {
    await seedExportedVault();
    const blob = await exportToBlob(true, PASSWORD);
    await clearEverything();
    await seedLiveVault();

    const analysis = await analyzeV3Backup({ source: blobChunks(blob), password: PASSWORD });
    expect(analysis.report.rowCount).toBe(2);

    const csv = analysis.report.parts.join("");
    expect(csv.startsWith(CSV_EXPORT_HEADER.join(",") + "\r\n")).toBe(true);

    // The addable records are listed; the discovery-only one is NOT.
    expect(csv).toContain(ADDR_BACKUP);
    expect(csv).toContain(ADDR_META);
    expect(csv).not.toContain(ADDR_DISCOVERY);
    expect(csv).not.toContain(ADDR_SHARED); // already present — not addable

    // Formula-injection safety: hostile sigils are apostrophe-prefixed BEFORE
    // RFC 4180 quoting, so no cell can reach a spreadsheet executable.
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'+cmd-injection");
    expect(csv).toContain("'=evil-tag");
    expect(csv).not.toContain(",=HYPERLINK");
    // RFC 4180: embedded quotes doubled, multi-line/quoted values wrapped.
    expect(csv).toContain('""http://evil.example""');
    expect(csv).toContain('"note with ""quotes"", commas\nand a newline"');
  });

  it("cancels mid-analysis without touching the vault", async () => {
    await seedExportedVault();
    const blob = await exportToBlob(true, PASSWORD);
    await clearEverything();
    await seedLiveVault();

    const before = await snapshotVaultTables();
    const controller = new AbortController();

    let sawProgress = false;
    await expect(
      analyzeV3Backup({
        source: blobChunks(blob),
        password: PASSWORD,
        signal: controller.signal,
        onProgress: () => {
          sawProgress = true;
          controller.abort();
        },
      }),
    ).rejects.toBeInstanceOf(BackupCancelledError);
    expect(sawProgress).toBe(true);
    expect(await snapshotVaultTables()).toBe(before);
  });

  it("rejects a wrong password non-destructively, then accepts the right one", async () => {
    await seedExportedVault();
    const blob = await exportToBlob(true, PASSWORD);
    await clearEverything();
    await seedLiveVault();

    const before = await snapshotVaultTables();
    await expect(
      analyzeV3Backup({ source: blobChunks(blob), password: "definitely-wrong" }),
    ).rejects.toThrow(/Invalid password or corrupted backup/);
    // Missing password on an encrypted backup also fails before any data read.
    await expect(analyzeV3Backup({ source: blobChunks(blob) })).rejects.toThrow(
      /Password required/,
    );
    expect(await snapshotVaultTables()).toBe(before);

    // The same backup analyzes fine with the correct password.
    const analysis = await analyzeV3Backup({ source: blobChunks(blob), password: PASSWORD });
    expect(analysis.tables.records.added).toBe(2);
    expect(analysis.tables.records.discoveryOnlySkipped).toBe(1);
  });

  it("rejects a corrupt (non-backup) file without touching the vault", async () => {
    await seedLiveVault();
    const before = await snapshotVaultTables();
    async function* garbage(): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode("this is not a zip file at all".repeat(100));
    }
    await expect(analyzeV3Backup({ source: garbage() })).rejects.toThrow();
    expect(await snapshotVaultTables()).toBe(before);
  });
});

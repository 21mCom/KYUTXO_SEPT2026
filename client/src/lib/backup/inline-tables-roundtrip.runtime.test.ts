// @vitest-environment jsdom
//
// Regression guard for the SMALL "inline" tables that ride inside the v3 backup
// manifest but have no dedicated round-trip coverage of their own. Task #347
// added a focused test for nodeSettings; this file does the same for the other
// inline tables that carry real user configuration / data:
//   - customFields
//   - derivationTemplates
//   - evidence
//   - evidenceAttachments
//   - priceData
// Each is seeded fully populated, exported, wiped, and restored through the REAL
// `@/lib/database` schema over fake-indexeddb. After restore we assert every
// field survives by deep equality (not just row counts), so a future change to
// the inline restore path that drops or coerces a field is caught.
//
// The auto-increment `id` is intentionally excluded from the comparison: restore
// re-`add`s these rows, so they receive fresh ids (matching legacy behaviour).
// For evidenceAttachments we additionally assert the attachment still resolves
// to the SAME evidence row it was attached to (by the evidence's unique title),
// since the link is what would silently break if id handling regressed.
//
// The backup is UNENCRYPTED so no WebCrypto subtle support is required.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";

import {
  db,
  type CustomField,
  type DerivationTemplate,
  type Evidence,
  type EvidenceAttachment,
  type PriceData,
} from "@/lib/database";
import { exportBackup, type AttachmentFileIO } from "./export";
import { restoreV3Backup, type AttachmentFileWriter } from "./restore";
import { MemorySink, type BackupSink } from "./sink";
import { blobChunks } from "./zip-stream";

import { clearAllRecords } from "@/lib/data/record-crud";
import { clearAttachments } from "@/lib/data/attachments-crud";
import {
  clearParticipants,
  clearTransactions,
} from "@/lib/data/transaction-crud";
import { clearAddressSyncState } from "@/lib/data/address-sync-crud";
import {
  clearUtxoLineage,
  clearCustodySegments,
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
import {
  bulkAddEvidence,
  addEvidenceAttachment,
  getAllEvidence,
  getAllEvidenceAttachments,
  clearEvidence,
  clearEvidenceAttachments,
} from "@/lib/data/evidence-crud";
import {
  addPriceData,
  getAllPriceData,
  clearPriceData,
} from "@/lib/data/price-data-crud";

// ---- fully-populated seed rows (every optional + required field set) --------

const CUSTOM_FIELDS: Omit<CustomField, "id">[] = [
  { name: "Exchange", slug: "exchange", enabled: true, createdAt: 1_700_000_001_000 },
  { name: "Risk Level", slug: "risk-level", enabled: false, createdAt: 1_700_000_002_000 },
];

const DERIVATION_TEMPLATES: Omit<DerivationTemplate, "id">[] = [
  {
    fingerprint: "abcd1234",
    scriptType: "P2WPKH",
    derivationPath: "m/84'/0'/0'",
    xpub: "zpub6jftahH18ngZxLmXaKw3GSZzZsszmt9WqedkyZdezFtWRFBZqsQH5hyUmb4pCEeZGmVfQuP5bedXTB8is6fTv19U1GQRyQUKQGUTzyHACMF",
    gapLimit: 20,
    network: "mainnet",
    owner: "Alice",
    walletName: "Cold Storage",
    seedName: "Steel Plate #1",
    notes: "Primary savings wallet",
    createdAt: 1_700_000_003_000,
    updatedAt: 1_700_000_004_000,
  },
  {
    fingerprint: "ef567890",
    scriptType: "P2TR",
    derivationPath: "m/86'/1'/0'",
    xpub: "tpubDDtdVYwGAjmcvBwznmaSvAvFCvSXNn5QcRPiPVptCk9XGyBnQ5J6dgQ4PpD3WC3FwxkW2Y4f7n4nM9PnxQqXz3a8mP4n5wQqXz3a8mP4n5",
    gapLimit: 50,
    network: "testnet",
    owner: "Bob",
    walletName: "Test Hot Wallet",
    seedName: "Mnemonic B",
    notes: "Taproot testnet template",
    createdAt: 1_700_000_005_000,
    updatedAt: 1_700_000_006_000,
  },
];

const EVIDENCE: Omit<Evidence, "id">[] = [
  {
    title: "Coinbase Purchase Receipt 2021",
    documentType: "receipt",
    originalDate: 1_609_459_200,
    notes: "Bought 0.5 BTC on 2021-01-01",
    tags: ["purchase", "exchange"],
    partiesInvolved: ["Coinbase", "Alice"],
    source: "email",
    importance: "high",
    createdAt: 1_700_000_007_000,
    updatedAt: 1_700_000_008_000,
  },
  {
    title: "Bank Wire Confirmation",
    documentType: "statement",
    originalDate: 1_612_137_600,
    notes: "Wire transfer to fund exchange account",
    tags: ["bank", "wire"],
    partiesInvolved: ["Chase Bank"],
    source: "pdf",
    importance: "medium",
    createdAt: 1_700_000_009_000,
    updatedAt: 1_700_000_010_000,
  },
];

const PRICE_DATA: Omit<PriceData, "id">[] = [
  {
    date: "2021-01-01",
    currency: "USD",
    asset: "BTC",
    open: 28994.01,
    high: 29600.63,
    low: 28803.59,
    close: 29374.15,
    volume: 40730301359,
    source: "cryptodatadownload",
    importedAt: 1_700_000_011_000,
  },
  {
    date: "2021-02-01",
    currency: "EUR",
    asset: "BTC",
    open: 27000.5,
    high: 28500.75,
    low: 26900.25,
    close: 28100.0,
    volume: 35000000000,
    source: "coingecko",
    importedAt: 1_700_000_012_000,
  },
];

// In-memory attachment store (no record files needed for these tests).
const attachmentIO: AttachmentFileIO = {
  async listAll() {
    return [];
  },
  async read() {
    return null;
  },
};
const attachmentWriter: AttachmentFileWriter = {
  async write() {
    /* no-op */
  },
};

async function clearEverything(): Promise<void> {
  await clearAllRecords({ skipNotification: true });
  await clearAttachments({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearAddressSyncState({ skipNotification: true });
  await clearUtxoLineage({ skipNotification: true });
  await clearCustodySegments({ skipNotification: true });
  await clearNodeSettings({ skipNotification: true });
  await clearCustomFields({ skipNotification: true });
  await clearDerivationTemplates({ skipNotification: true });
  await clearEvidence({ skipNotification: true });
  await clearEvidenceAttachments({ skipNotification: true });
  await clearPriceData({ skipNotification: true });
  await db.tags.clear();
  await db.categories.clear();
  await db.owners.clear();
  await db.walletNames.clear();
  await db.seedNames.clear();
  await db.walletSoftware.clear();
}

// Export -> wipe inline tables -> restore. Mirrors the node-settings test's
// roundTrip but clears the inline tables this test cares about so restore has to
// repopulate them from the backup.
async function roundTrip(): Promise<void> {
  const sink = new MemorySink();
  await exportBackup({
    sink: sink as BackupSink,
    encrypted: false,
    batchSize: 25,
    attachmentIO,
  });
  const blob = sink.blob as Blob;
  expect(blob).toBeInstanceOf(Blob);

  await clearCustomFields({ skipNotification: true });
  await clearDerivationTemplates({ skipNotification: true });
  await clearEvidence({ skipNotification: true });
  await clearEvidenceAttachments({ skipNotification: true });
  await clearPriceData({ skipNotification: true });

  await restoreV3Backup({
    source: blobChunks(blob),
    attachmentWriter,
  });
}

// Strip the auto-increment id so deep equality compares only persisted fields.
function stripId<T extends { id?: number }>(rows: T[]): Omit<T, "id">[] {
  return rows.map(({ id, ...rest }) => rest as Omit<T, "id">);
}

// Stable sort key for order-independent comparison.
function sortBy<T>(rows: T[], key: (r: T) => string): T[] {
  return [...rows].sort((a, b) => key(a).localeCompare(key(b)));
}

describe("inline tables backup round-trip", () => {
  beforeEach(async () => {
    await clearEverything();
  });

  it("preserves every field of customFields", async () => {
    for (const f of CUSTOM_FIELDS) {
      await addCustomField({ ...f }, { skipNotification: true });
    }

    await roundTrip();

    const restored = sortBy(stripId(await getAllCustomFields()), (r) => r.slug);
    const expected = sortBy(CUSTOM_FIELDS, (r) => r.slug);
    expect(restored).toEqual(expected);
  });

  it("preserves every field of derivationTemplates", async () => {
    for (const t of DERIVATION_TEMPLATES) {
      await addDerivationTemplate({ ...t }, { skipNotification: true });
    }

    await roundTrip();

    const restored = sortBy(
      stripId(await getAllDerivationTemplates()),
      (r) => r.fingerprint,
    );
    const expected = sortBy(DERIVATION_TEMPLATES, (r) => r.fingerprint);
    expect(restored).toEqual(expected);
  });

  it("preserves every field of priceData", async () => {
    for (const p of PRICE_DATA) {
      await addPriceData({ ...p }, { skipNotification: true });
    }

    await roundTrip();

    const restored = sortBy(
      stripId(await getAllPriceData()),
      (r) => `${r.date}-${r.currency}`,
    );
    const expected = sortBy(PRICE_DATA, (r) => `${r.date}-${r.currency}`);
    expect(restored).toEqual(expected);
  });

  it("preserves every field of evidence", async () => {
    await bulkAddEvidence(
      EVIDENCE.map((ev) => ({ ...ev })) as Evidence[],
      { skipNotification: true },
    );

    await roundTrip();

    const restored = sortBy(stripId(await getAllEvidence()), (r) => r.title);
    const expected = sortBy(EVIDENCE, (r) => r.title);
    expect(restored).toEqual(expected);
  });

  it("preserves evidenceAttachments and keeps each linked to its evidence", async () => {
    // bulkAddEvidence returns void, so read the rows back to learn the assigned
    // ids and map each id to the (unique) evidence title.
    await bulkAddEvidence(
      EVIDENCE.map((ev) => ({ ...ev })) as Evidence[],
      { skipNotification: true },
    );
    const seededEvidence = await getAllEvidence();
    const idByTitle = new Map<string, number>();
    for (const ev of seededEvidence) {
      idByTitle.set(ev.title, ev.id as number);
    }
    // Title of the evidence each attachment belongs to, so we can verify the
    // link survives even though ids are reassigned on restore.
    const titleByOriginalEvidenceId = new Map<number, string>();
    for (const ev of seededEvidence) {
      titleByOriginalEvidenceId.set(ev.id as number, ev.title);
    }

    const attachments: Omit<EvidenceAttachment, "id">[] = [
      {
        evidenceId: idByTitle.get("Coinbase Purchase Receipt 2021")!,
        filename: "coinbase-receipt.pdf",
        mimeType: "application/pdf",
        size: 24576,
        objectStoragePath: "ev/aa/bb/coinbase.pdf",
        createdAt: 1_700_000_013_000,
      },
      {
        evidenceId: idByTitle.get("Bank Wire Confirmation")!,
        filename: "wire-confirmation.png",
        mimeType: "image/png",
        size: 102400,
        objectStoragePath: "ev/cc/dd/wire.png",
        createdAt: 1_700_000_014_000,
      },
    ];
    for (const a of attachments) {
      await addEvidenceAttachment({ ...a }, { skipNotification: true });
    }

    await roundTrip();

    const restoredEvidence = await getAllEvidence();
    const restoredAttachments = await getAllEvidenceAttachments();
    expect(restoredAttachments).toHaveLength(attachments.length);

    // Map each restored attachment back to the evidence title it now points to.
    const titleByRestoredEvidenceId = new Map<number, string>();
    for (const ev of restoredEvidence) {
      titleByRestoredEvidenceId.set(ev.id as number, ev.title);
    }

    // Field-level deep equality (ignoring the reassigned id and evidenceId, which
    // is checked structurally below).
    const restoredFields = sortBy(
      restoredAttachments.map(({ id, evidenceId, ...rest }) => rest),
      (r) => r.filename,
    );
    const expectedFields = sortBy(
      attachments.map(({ evidenceId, ...rest }) => rest),
      (r) => r.filename,
    );
    expect(restoredFields).toEqual(expectedFields);

    // Each restored attachment still resolves to the SAME evidence (by title).
    for (const att of restoredAttachments) {
      const restoredTitle = titleByRestoredEvidenceId.get(att.evidenceId);
      expect(restoredTitle).toBeDefined();
      const original = attachments.find((a) => a.filename === att.filename)!;
      const expectedTitle = titleByOriginalEvidenceId.get(original.evidenceId);
      expect(restoredTitle).toBe(expectedTitle);
    }
  });

  it("restores a backup that has no inline-table rows without error", async () => {
    expect(await getAllCustomFields()).toHaveLength(0);
    expect(await getAllDerivationTemplates()).toHaveLength(0);
    expect(await getAllEvidence()).toHaveLength(0);
    expect(await getAllEvidenceAttachments()).toHaveLength(0);
    expect(await getAllPriceData()).toHaveLength(0);

    await expect(roundTrip()).resolves.toBeUndefined();

    expect(await getAllCustomFields()).toHaveLength(0);
    expect(await getAllDerivationTemplates()).toHaveLength(0);
    expect(await getAllEvidence()).toHaveLength(0);
    expect(await getAllEvidenceAttachments()).toHaveLength(0);
    expect(await getAllPriceData()).toHaveLength(0);
  });
});

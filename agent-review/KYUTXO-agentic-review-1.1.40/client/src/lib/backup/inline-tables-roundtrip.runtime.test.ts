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
import { restoreInlineTables } from "./inline-tables";
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
  bulkAddUtxoLineage,
  bulkAddCustodySegments,
  getAllUtxoLineage,
  getAllCustodySegments,
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
import {
  markOutpointsAsDust,
  getAllDustFlags,
  clearDustFlags,
} from "@/lib/data/dust-flags-crud";

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
  await clearDustFlags({ skipNotification: true });
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
  await clearDustFlags({ skipNotification: true });

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

  it("preserves every field of dustFlags", async () => {
    const flags = [
      {
        txid: "a".repeat(64),
        vout: 0,
        address: "bc1qdust0000000000000000000000000000000001",
        amountSats: 546,
      },
      {
        txid: "b".repeat(64),
        vout: 3,
        address: "bc1qdust0000000000000000000000000000000002",
        amountSats: 1000,
      },
    ];
    await markOutpointsAsDust(flags);
    const seeded = sortBy(stripId(await getAllDustFlags()), (r) => r.outpoint);
    expect(seeded).toHaveLength(2);

    await roundTrip();

    const restored = sortBy(stripId(await getAllDustFlags()), (r) => r.outpoint);
    expect(restored).toEqual(seeded);
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

// ---- inline lineage / custody-segment merge de-dup ------------------------
//
// OLDER v3 backups stored utxoLineage and custodySegments INLINE inside the
// manifest (new backups stream them as NDJSON). The merge-restore fix for the
// unique custody `segmentId` index was mirrored into `restoreInlineTables` so
// the inline branch also skips a segment whose `segmentId` (or a lineage edge
// whose identity) is already present, instead of letting the unique index abort
// the whole restore mid-way. The legacy helper has direct coverage
// (legacy-restore-extra.runtime.test.ts); these tests drive the INLINE merge
// branch directly over a vault that already contains a custody segment.

// A minimal valid backup custody segment. `id` is the BACKUP id (stripped on
// restore); `segmentId` is unique in the schema.
function inlineSegment(id: number, segmentId: string, extra: any = {}) {
  return {
    id,
    segmentId,
    originTxid: `origin-${segmentId}`,
    originVout: 0,
    originAddress: "addr-origin",
    originDate: 1_700_000_000,
    originAmount: 100000,
    currentAmount: 100000,
    status: "active",
    hopCount: 0,
    evidenceTxids: [],
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    ...extra,
  };
}

// A minimal valid backup utxoLineage row. `id` is the BACKUP id (stripped).
function inlineLineage(id: number, consumingTxid: string, extra: any = {}) {
  return {
    id,
    spentTxid: `spent-${consumingTxid}`,
    spentVout: 0,
    spentAddress: "addr-spent",
    spentAmount: 100000,
    consumingTxid,
    createdTxid: consumingTxid,
    createdVout: 1,
    createdAddress: "addr-created",
    createdAmount: 99000,
    spentOwned: true,
    createdOwned: false,
    isChange: false,
    confidence: "high",
    blockTime: 1_700_000_000,
    blockHeight: 800000,
    createdAt: 1_700_000_000,
    ...extra,
  };
}

describe("restoreInlineTables merge mode (inline lineage / custody segments)", () => {
  beforeEach(async () => {
    await clearEverything();
  });

  it("skips an already-present custody segment and adds the new one without throwing", async () => {
    // Seed the vault with an existing segment (as a prior restore/merge would).
    await bulkAddCustodySegments(
      [inlineSegment(800, "seg-existing")] as any,
      { skipNotification: true },
    );
    expect(await getAllCustodySegments()).toHaveLength(1);

    // A merge whose inline backup re-includes that segmentId (plus a brand-new
    // one) must complete WITHOUT throwing on the unique index: the already-
    // present segment is skipped and only the new one is added.
    await expect(
      restoreInlineTables(
        {
          custodySegments: [
            inlineSegment(801, "seg-existing", { currentAmount: 555 }),
            inlineSegment(802, "seg-new"),
          ],
        },
        "merge",
      ),
    ).resolves.toMatchObject({
      insertedUtxoLineageIds: [],
      // Only the NEW segment was inserted; the duplicate was skipped.
      insertedCustodySegmentIds: [expect.any(Number)],
      insertedLineageSnapshotIds: [],
      pendingRecordOrigins: [],
    });

    const liveSegments = await getAllCustodySegments();
    expect(liveSegments).toHaveLength(2);
    expect(new Set(liveSegments.map((s) => s.segmentId))).toEqual(
      new Set(["seg-existing", "seg-new"]),
    );
    // The pre-existing segment is untouched — the overlapping backup row was
    // skipped, not applied (its original currentAmount survives).
    expect(
      liveSegments.find((s) => s.segmentId === "seg-existing")!.currentAmount,
    ).toBe(100000);
  });

  it("skips a lineage edge that already exists and adds the new one", async () => {
    // Seed an existing lineage edge.
    await bulkAddUtxoLineage(
      [inlineLineage(900, "tx-dup")] as any,
      { skipNotification: true },
    );
    expect(await getAllUtxoLineage()).toHaveLength(1);

    await restoreInlineTables(
      {
        utxoLineage: [
          inlineLineage(901, "tx-dup"),
          inlineLineage(902, "tx-fresh"),
        ],
      },
      "merge",
    );

    const liveLineage = await getAllUtxoLineage();
    expect(liveLineage).toHaveLength(2);
    expect(new Set(liveLineage.map((l) => l.consumingTxid))).toEqual(
      new Set(["tx-dup", "tx-fresh"]),
    );
  });

  it("dedups custody segments and lineage edges duplicated WITHIN one backup", async () => {
    await restoreInlineTables(
      {
        custodySegments: [
          inlineSegment(810, "dup-merge"),
          inlineSegment(811, "dup-merge"),
        ],
        utxoLineage: [
          inlineLineage(820, "tx-int-dup"),
          inlineLineage(821, "tx-int-dup"),
        ],
      },
      "merge",
    );

    expect(await getAllCustodySegments()).toHaveLength(1);
    expect(await getAllUtxoLineage()).toHaveLength(1);
  });

  it("preserves pre-existing lineage / custody segments absent from a merge backup", async () => {
    // The inline merge branch deliberately does NOT clear these tables. Seed the
    // vault with lineage edges + custody segments that the backup does NOT carry,
    // then merge a DISJOINT set of inline rows. Both the pre-existing rows AND
    // the new rows must survive — a regression that cleared/overwrote existing
    // lineage on merge would silently drop user provenance data.
    await bulkAddCustodySegments(
      [
        inlineSegment(700, "seg-vault-1", { currentAmount: 11111 }),
        inlineSegment(701, "seg-vault-2", { currentAmount: 22222 }),
      ] as any,
      { skipNotification: true },
    );
    await bulkAddUtxoLineage(
      [
        inlineLineage(710, "tx-vault-1", { spentAmount: 33333 }),
        inlineLineage(711, "tx-vault-2", { spentAmount: 44444 }),
      ] as any,
      { skipNotification: true },
    );
    expect(await getAllCustodySegments()).toHaveLength(2);
    expect(await getAllUtxoLineage()).toHaveLength(2);

    // Merge a backup whose rows are entirely disjoint from what's in the vault.
    await restoreInlineTables(
      {
        custodySegments: [
          inlineSegment(720, "seg-backup-1"),
          inlineSegment(721, "seg-backup-2"),
        ],
        utxoLineage: [
          inlineLineage(730, "tx-backup-1"),
          inlineLineage(731, "tx-backup-2"),
        ],
      },
      "merge",
    );

    // Pre-existing rows are still present (not cleared) alongside the new ones.
    const liveSegments = await getAllCustodySegments();
    expect(liveSegments).toHaveLength(4);
    expect(new Set(liveSegments.map((s) => s.segmentId))).toEqual(
      new Set(["seg-vault-1", "seg-vault-2", "seg-backup-1", "seg-backup-2"]),
    );
    // The pre-existing segments are untouched — their identifying fields survive.
    expect(
      liveSegments.find((s) => s.segmentId === "seg-vault-1")!.currentAmount,
    ).toBe(11111);
    expect(
      liveSegments.find((s) => s.segmentId === "seg-vault-2")!.currentAmount,
    ).toBe(22222);

    const liveLineage = await getAllUtxoLineage();
    expect(liveLineage).toHaveLength(4);
    expect(new Set(liveLineage.map((l) => l.consumingTxid))).toEqual(
      new Set(["tx-vault-1", "tx-vault-2", "tx-backup-1", "tx-backup-2"]),
    );
    // The pre-existing lineage edges are untouched — their fields survive.
    expect(
      liveLineage.find((l) => l.consumingTxid === "tx-vault-1")!.spentAmount,
    ).toBe(33333);
    expect(
      liveLineage.find((l) => l.consumingTxid === "tx-vault-2")!.spentAmount,
    ).toBe(44444);
  });

  it("skips an already-flagged dust outpoint on merge and dedups within one backup", async () => {
    // Seed the vault with an existing flag.
    await markOutpointsAsDust([
      { txid: "c".repeat(64), vout: 1, address: "addr-existing", amountSats: 546 },
    ]);
    expect(await getAllDustFlags()).toHaveLength(1);

    // Merge a backup that re-includes the same outpoint (with different field
    // values), a brand-new one, and an internal duplicate of the new one. The
    // unique &outpoint index must not abort the restore; the existing flag wins.
    await expect(
      restoreInlineTables(
        {
          dustFlags: [
            {
              id: 900,
              outpoint: `${"c".repeat(64)}:1`,
              txid: "c".repeat(64),
              vout: 1,
              address: "addr-from-backup",
              amountSats: 999,
              markedAt: 1_700_000_020_000,
            },
            {
              id: 901,
              outpoint: `${"d".repeat(64)}:0`,
              txid: "d".repeat(64),
              vout: 0,
              address: "addr-new",
              amountSats: 546,
              markedAt: 1_700_000_021_000,
            },
            {
              id: 902,
              outpoint: `${"d".repeat(64)}:0`,
              txid: "d".repeat(64),
              vout: 0,
              address: "addr-new-dup",
              amountSats: 546,
              markedAt: 1_700_000_022_000,
            },
          ],
        },
        "merge",
      ),
    ).resolves.toMatchObject({
      insertedUtxoLineageIds: [],
      insertedCustodySegmentIds: [],
      insertedLineageSnapshotIds: [],
      pendingRecordOrigins: [],
    });

    const live = await getAllDustFlags();
    expect(live).toHaveLength(2);
    // Pre-existing flag untouched (backup's overlapping row was skipped).
    expect(live.find((f) => f.outpoint === `${"c".repeat(64)}:1`)!.address).toBe(
      "addr-existing",
    );
    expect(live.find((f) => f.outpoint === `${"d".repeat(64)}:0`)!.address).toBe(
      "addr-new",
    );
  });

  it("replace mode (default) appends inline rows as-is into a cleared vault", async () => {
    // Mirrors production: the v3 orchestrator clears these tables first, so
    // replace mode adds every distinct row without de-dup against the vault.
    await restoreInlineTables({
      custodySegments: [
        inlineSegment(830, "seg-a"),
        inlineSegment(831, "seg-b"),
      ],
      utxoLineage: [
        inlineLineage(840, "tx-a"),
        inlineLineage(841, "tx-b"),
      ],
    });

    const liveSegments = await getAllCustodySegments();
    expect(new Set(liveSegments.map((s) => s.segmentId))).toEqual(
      new Set(["seg-a", "seg-b"]),
    );
    // Backup ids are stripped — every row gets a fresh autoincrement id.
    expect(liveSegments.every((s) => s.id !== 830 && s.id !== 831)).toBe(true);

    const liveLineage = await getAllUtxoLineage();
    expect(new Set(liveLineage.map((l) => l.consumingTxid))).toEqual(
      new Set(["tx-a", "tx-b"]),
    );
    expect(liveLineage.every((l) => l.id !== 840 && l.id !== 841)).toBe(true);
  });
});

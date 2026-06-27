// @vitest-environment jsdom
//
// Regression guard for the `lineageSnapshots` (`db.lineageSnapshots`, schema
// table `ns`) table on the merge-restore path. Task #846 closed an
// evidence-document doubling bug on merge-restore (following the same fix for
// price history); this file audits `lineageSnapshots` for the SAME unguarded
// append-on-merge behaviour.
//
// FINDING (locked in by these tests): `lineageSnapshots` is NOT part of the
// backup at all — it is not a streamed NDJSON table (see STREAMED_TABLES), it is
// not read into the inline manifest (see readInlineTables), and it is neither
// cleared nor restored by the v3 restore orchestrator or the legacy path. The
// table holds regenerable selective-disclosure proof artifacts, so a backup
// neither carries nor rebuilds them. Because nothing is ever restored INTO this
// table, repeatedly restoring/merging a backup can never accumulate duplicate
// snapshot rows — the bug that hit evidence/price does not exist here.
//
// These tests pin that invariant two ways so it cannot silently regress:
//   1. A v3 backup's manifest does not list `lineageSnapshots` as a streamed
//      table and its inline payload does not carry the snapshots.
//   2. A snapshot already present in the vault survives repeated full restores
//      WITHOUT being duplicated (the restore never clears it and the backup
//      never re-adds it). If a future change starts exporting + restoring
//      snapshots without de-duping on the unique `snapshotId`, the count would
//      grow past 1 (or the unique index would throw) and this test would fail —
//      forcing whoever wires that up to add the de-dup guard.
//
// The backup is UNENCRYPTED so no WebCrypto subtle support is required.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";

import { db, type LineageSnapshot } from "@/lib/database";
import { exportBackup, type AttachmentFileIO } from "./export";
import { restoreV3Backup, peekManifest, type AttachmentFileWriter } from "./restore";
import { MemorySink, type BackupSink } from "./sink";
import { blobChunks } from "./zip-stream";
import { isV3Manifest } from "./format";

import { clearAllRecords } from "@/lib/data/record-crud";
import { clearAttachments } from "@/lib/data/attachments-crud";
import { clearParticipants, clearTransactions } from "@/lib/data/transaction-crud";
import { clearAddressSyncState } from "@/lib/data/address-sync-crud";
import {
  clearUtxoLineage,
  clearCustodySegments,
  clearLineageSnapshots,
  addLineageSnapshot,
  countLineageSnapshots,
  getAllLineageSnapshots,
} from "@/lib/data/lineage-crud";
import { clearNodeSettings } from "@/lib/data/node-settings-crud";
import { clearCustomFields } from "@/lib/data/custom-fields-crud";
import { clearDerivationTemplates } from "@/lib/data/derivation-templates-crud";
import { clearEvidence, clearEvidenceAttachments } from "@/lib/data/evidence-crud";
import { clearPriceData } from "@/lib/data/price-data-crud";

// A fully-populated snapshot (every required field set, optionals included) so a
// regression that started round-tripping snapshots would have real data to
// double up.
const SNAPSHOT: Omit<LineageSnapshot, "id"> = {
  snapshotId: "snap-uuid-0001",
  targetType: "address",
  targetAddress: "bc1qexampleexampleexampleexampleexampleexx",
  targetTxid: "a".repeat(64),
  targetVout: 0,
  targetSegmentId: "seg-0001",
  segments: ["seg-0001", "seg-0002"],
  evidenceTxids: ["a".repeat(64), "b".repeat(64)],
  totalAmount: 150000,
  earliestDate: 1_600_000_000,
  latestDate: 1_700_000_000,
  hopCount: 3,
  narrative: "Funds traced from an exchange withdrawal through two hops.",
  redactedAddresses: ["bc1qhiddenhiddenhiddenhiddenhiddenhiddenx"],
  disclosureLevel: "full",
  generatedAt: 1_700_000_100_000,
  expiresAt: 1_800_000_000_000,
};

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
  await clearLineageSnapshots({ skipNotification: true });
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

describe("lineageSnapshots merge-restore de-dup audit", () => {
  beforeEach(async () => {
    await clearEverything();
  });

  it("does not carry lineageSnapshots in a v3 backup manifest", async () => {
    await addLineageSnapshot({ ...SNAPSHOT }, { skipNotification: true });
    expect(await countLineageSnapshots()).toBe(1);

    const blob = await exportToBlob();
    const manifest = await peekManifest(blobChunks(blob));
    expect(isV3Manifest(manifest)).toBe(true);

    // Not a streamed NDJSON table.
    expect((manifest as any).streamedTables).not.toContain("lineageSnapshots");
    // Not present in the inline payload (under either its table name or the
    // raw Dexie store name `ns`).
    const inline = ((manifest as any).inline ?? {}) as Record<string, unknown>;
    expect(inline.lineageSnapshots).toBeUndefined();
    expect(inline.ns).toBeUndefined();
  });

  it("never duplicates a pre-existing snapshot across repeated full restores", async () => {
    await addLineageSnapshot({ ...SNAPSHOT }, { skipNotification: true });
    expect(await countLineageSnapshots()).toBe(1);

    const blob = await exportToBlob();

    // Restoring twice mimics a user importing the same backup more than once.
    // Because the restore never clears OR re-adds snapshots, the single
    // pre-existing row must survive untouched and never be doubled.
    for (let i = 0; i < 2; i++) {
      await expect(
        restoreV3Backup({ source: blobChunks(blob), attachmentWriter }),
      ).resolves.toBeDefined();
      const rows = await getAllLineageSnapshots();
      expect(rows).toHaveLength(1);
      expect(rows[0].snapshotId).toBe(SNAPSHOT.snapshotId);
    }
  });

  it("does not resurrect snapshots from a backup taken with snapshots present", async () => {
    // Export a backup while a snapshot exists, then wipe the table and restore.
    // Since the backup never carried the snapshot, the restore must NOT recreate
    // it — and must certainly not create more than the (zero) it knows about.
    await addLineageSnapshot({ ...SNAPSHOT }, { skipNotification: true });
    const blob = await exportToBlob();

    await clearLineageSnapshots({ skipNotification: true });
    expect(await countLineageSnapshots()).toBe(0);

    await restoreV3Backup({ source: blobChunks(blob), attachmentWriter });
    expect(await countLineageSnapshots()).toBe(0);
  });
});

// @vitest-environment jsdom
//
// Round-trip + merge-restore de-dup coverage for the `lineageSnapshots`
// (`db.lineageSnapshots`, schema store `ns`) table. These proof artifacts
// (selective-disclosure / Continuity Certificate snapshots) are now part of the
// backup as a STREAMED NDJSON table (alongside its siblings `utxoLineage` and
// `custodySegments`), so a restored vault keeps its generated snapshots instead
// of silently losing them.
//
// The table carries a UNIQUE `snapshotId` index, so a naive append-on-merge
// would either double existing snapshots or throw on the unique index and abort
// the whole restore. These tests pin the contract three ways:
//   1. A v3 backup's manifest lists `lineageSnapshots` as a streamed table and a
//      full (replace) restore round-trips the rows back into the vault.
//   2. The legacy/inline merge path skips snapshots whose `snapshotId` already
//      exists (no doubling, no unique-index abort) while still adding genuinely
//      new ones, and replace mode appends as-is over a cleared table.
//   3. Repeatedly merging the same backup never accumulates duplicate rows.
//
// The backup is UNENCRYPTED so no WebCrypto subtle support is required.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";

import { db, type LineageSnapshot } from "@/lib/database";
import { exportBackup, type AttachmentFileIO } from "./export";
import { restoreV3Backup, peekManifest, type AttachmentFileWriter } from "./restore";
import { restoreInlineTables } from "./inline-tables";
import { restoreLegacySnapshots } from "./legacy-restore-misc";
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
// regression in the round-trip would surface as real data loss.
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

const SNAPSHOT_2: Omit<LineageSnapshot, "id"> = {
  ...SNAPSHOT,
  snapshotId: "snap-uuid-0002",
  narrative: "A second, distinct disclosure snapshot.",
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

describe("lineageSnapshots backup round-trip + merge de-dup", () => {
  beforeEach(async () => {
    await clearEverything();
  });

  it("lists lineageSnapshots as a streamed table in the v3 manifest", async () => {
    await addLineageSnapshot({ ...SNAPSHOT }, { skipNotification: true });
    expect(await countLineageSnapshots()).toBe(1);

    const blob = await exportToBlob();
    const manifest = await peekManifest(blobChunks(blob));
    expect(isV3Manifest(manifest)).toBe(true);

    // Now a streamed NDJSON table (NOT inline).
    expect((manifest as any).streamedTables).toContain("lineageSnapshots");
    expect((manifest as any).counts?.lineageSnapshots).toBe(1);
    const inline = ((manifest as any).inline ?? {}) as Record<string, unknown>;
    expect(inline.lineageSnapshots).toBeUndefined();
    expect(inline.ns).toBeUndefined();
  });

  it("round-trips snapshots through a full (replace) v3 restore", async () => {
    await addLineageSnapshot({ ...SNAPSHOT }, { skipNotification: true });
    await addLineageSnapshot({ ...SNAPSHOT_2 }, { skipNotification: true });
    expect(await countLineageSnapshots()).toBe(2);

    const blob = await exportToBlob();

    // Wipe the table, restore, and confirm both snapshots come back intact.
    await clearLineageSnapshots({ skipNotification: true });
    expect(await countLineageSnapshots()).toBe(0);

    await restoreV3Backup({ source: blobChunks(blob), attachmentWriter });

    const rows = await getAllLineageSnapshots();
    expect(rows).toHaveLength(2);
    const restored = rows.find((r) => r.snapshotId === SNAPSHOT.snapshotId);
    expect(restored).toBeDefined();
    expect(restored!.narrative).toBe(SNAPSHOT.narrative);
    expect(restored!.segments).toEqual(SNAPSHOT.segments);
    expect(restored!.totalAmount).toBe(SNAPSHOT.totalAmount);
    expect(rows.some((r) => r.snapshotId === SNAPSHOT_2.snapshotId)).toBe(true);
  });

  it("does not duplicate a pre-existing snapshot across repeated v3 (replace) restores", async () => {
    await addLineageSnapshot({ ...SNAPSHOT }, { skipNotification: true });
    const blob = await exportToBlob();

    // restoreV3Backup always replaces (clears the table first), so importing the
    // same backup twice leaves exactly one row, not two.
    for (let i = 0; i < 2; i++) {
      await restoreV3Backup({ source: blobChunks(blob), attachmentWriter });
      const rows = await getAllLineageSnapshots();
      expect(rows).toHaveLength(1);
      expect(rows[0].snapshotId).toBe(SNAPSHOT.snapshotId);
    }
  });

  it("legacy merge restore skips snapshots whose snapshotId already exists and adds new ones", async () => {
    await addLineageSnapshot({ ...SNAPSHOT }, { skipNotification: true });
    expect(await countLineageSnapshots()).toBe(1);

    // A backup payload carrying the already-present snapshot plus a new one.
    const result = await restoreLegacySnapshots(
      [
        { id: 999, ...SNAPSHOT },
        { id: 1000, ...SNAPSHOT_2 },
      ],
      "merge",
    );

    // Only the new snapshot is written; the duplicate is skipped (not throwing
    // on the unique index, not doubling).
    expect(result.snapshotsAdded).toBe(1);
    const rows = await getAllLineageSnapshots();
    expect(rows).toHaveLength(2);
    const ids = rows.map((r) => r.snapshotId).sort();
    expect(ids).toEqual([SNAPSHOT.snapshotId, SNAPSHOT_2.snapshotId].sort());
  });

  it("legacy merge restore is idempotent: re-merging the same backup never doubles rows", async () => {
    const payload = [
      { id: 1, ...SNAPSHOT },
      { id: 2, ...SNAPSHOT_2 },
    ];

    const first = await restoreLegacySnapshots(payload, "merge");
    expect(first.snapshotsAdded).toBe(2);
    expect(await countLineageSnapshots()).toBe(2);

    const second = await restoreLegacySnapshots(payload, "merge");
    expect(second.snapshotsAdded).toBe(0);
    expect(await countLineageSnapshots()).toBe(2);
  });

  it("legacy replace restore appends every snapshot as-is (caller clears first)", async () => {
    const result = await restoreLegacySnapshots(
      [
        { id: 1, ...SNAPSHOT },
        { id: 2, ...SNAPSHOT_2 },
      ],
      "replace",
    );
    expect(result.snapshotsAdded).toBe(2);
    expect(await countLineageSnapshots()).toBe(2);
  });

  it("inline merge path de-dups snapshots on snapshotId", async () => {
    await addLineageSnapshot({ ...SNAPSHOT }, { skipNotification: true });
    expect(await countLineageSnapshots()).toBe(1);

    // An older-style inline payload that still carries snapshots inline must be
    // merged without doubling the already-present row.
    await restoreInlineTables(
      {
        lineageSnapshots: [
          { id: 50, ...SNAPSHOT },
          { id: 51, ...SNAPSHOT_2 },
        ],
      },
      "merge",
    );

    const rows = await getAllLineageSnapshots();
    expect(rows).toHaveLength(2);
    const ids = rows.map((r) => r.snapshotId).sort();
    expect(ids).toEqual([SNAPSHOT.snapshotId, SNAPSHOT_2.snapshotId].sort());
  });
});

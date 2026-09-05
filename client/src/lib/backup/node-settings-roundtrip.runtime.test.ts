// @vitest-environment jsdom
//
// Regression guard for the nodeSettings backup round-trip. The nodeSettings
// table is a singleton (id always "default") that rides inline inside the v3
// manifest. A past bug stripped its `id` and/or used `add` instead of `put`,
// which broke restore (duplicate-key error or wrong id). These tests drive the
// REAL `@/lib/database` schema over fake-indexeddb through the full
// export -> restore pipeline and assert that:
//   1. a configured nodeSettings row survives with its id and every field, and
//   2. restoring a backup that has NO nodeSettings completes without error.
// The backup is UNENCRYPTED so no WebCrypto subtle support is required.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";

import { db, type NodeSettings } from "@/lib/database";
import { exportBackup, type AttachmentFileIO } from "./export";
import { restoreV3Backup, type AttachmentFileWriter } from "./restore";
import { MemorySink, type BackupSink } from "./sink";
import { blobChunks } from "./zip-stream";

import {
  getNodeSettings,
  getAllNodeSettings,
  putNodeSettings,
  clearNodeSettings,
} from "@/lib/data/node-settings-crud";
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

// A fully-populated nodeSettings row: every optional and required field set to a
// non-default value so a dropped/coerced field is caught.
const FULL_NODE_SETTINGS: NodeSettings = {
  id: "default",
  providerType: "custom-electrs",
  customUrl: "http://192.168.1.100:3002",
  useTor: true,
  torProxyUrl: "socks5h://127.0.0.1:9050",
  requestTimeout: 60000,
  network: "testnet",
  allowLocalNetwork: true,
  trustedLocalHosts: ["192.168.4.118", "myhost.local"],
  useElectrum: true,
  electrumHost: "192.168.4.118",
  electrumPort: 50001,
  electrumSSL: true,
  electrumServerType: "fulcrum",
  lastConnectedAt: 1_750_000_000_000,
  lastConnectionStatus: "Connected",
  networkPrivacyMode: "own-node",
  networkAccessEnabled: false,
  networkOnboardingStage: "complete",
  networkPrivacyChosenAt: 1_750_000_000_100,
  firstSyncConfirmedAt: 1_750_000_000_200,
};

// In-memory attachment store (no files needed for these tests).
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
  await db.tags.clear();
  await db.categories.clear();
  await db.owners.clear();
  await db.walletNames.clear();
  await db.seedNames.clear();
  await db.walletSoftware.clear();
}

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

  // Wipe the live table so restore has to repopulate it from the backup.
  await clearNodeSettings({ skipNotification: true });

  await restoreV3Backup({
    source: blobChunks(blob),
    attachmentWriter,
  });
}

describe("nodeSettings backup round-trip", () => {
  beforeEach(async () => {
    await clearEverything();
  });

  it("preserves the id and every field of a configured nodeSettings row", async () => {
    await putNodeSettings(FULL_NODE_SETTINGS, { skipNotification: true });

    await roundTrip();

    const all = await getAllNodeSettings();
    expect(all).toHaveLength(1);

    const restored = await getNodeSettings("default");
    expect(restored).toBeDefined();
    expect(restored!.id).toBe("default");
    // Deep equality catches a dropped/coerced field in either direction.
    expect(restored).toEqual(FULL_NODE_SETTINGS);
  });

  it("restores a backup that has no nodeSettings without error", async () => {
    // No nodeSettings seeded — the table is empty.
    expect(await getAllNodeSettings()).toHaveLength(0);

    await expect(roundTrip()).resolves.toBeUndefined();

    // The table stays empty; nothing spurious is created.
    expect(await getAllNodeSettings()).toHaveLength(0);
  });

  it("preserves an intentionally unconfigured offline vault", async () => {
    const offlineSettings: NodeSettings = {
      id: "default",
      providerType: "mempool-space",
      useTor: false,
      requestTimeout: 30_000,
      network: "mainnet",
      allowLocalNetwork: false,
      trustedLocalHosts: [],
      networkAccessEnabled: false,
      networkOnboardingStage: "complete",
      networkPrivacyChosenAt: 1_750_000_000_300,
    };
    await putNodeSettings(offlineSettings, { skipNotification: true });

    await roundTrip();

    expect(await getNodeSettings("default")).toEqual(offlineSettings);
  });

  it("does not duplicate the singleton row when restored twice", async () => {
    await putNodeSettings(FULL_NODE_SETTINGS, { skipNotification: true });

    // First export captures the configured row.
    const sink = new MemorySink();
    await exportBackup({
      sink: sink as BackupSink,
      encrypted: false,
      batchSize: 25,
      attachmentIO,
    });
    const blob = sink.blob as Blob;

    // Restore twice over a non-empty table: `put` must overwrite by id, not
    // throw a duplicate-key error or append a second row.
    await restoreV3Backup({ source: blobChunks(blob), attachmentWriter });
    await restoreV3Backup({ source: blobChunks(blob), attachmentWriter });

    expect(await getAllNodeSettings()).toHaveLength(1);
    expect(await getNodeSettings("default")).toEqual(FULL_NODE_SETTINGS);
  });
});

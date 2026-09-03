// @vitest-environment jsdom
//
// Regression guard for the portable settings-preferences backup round-trip.
// The `settings` table is intentionally not cleared or wholesale restored so
// device-local preferences survive a restore, but a small allow-list of
// PORTABLE preferences (currently `disableOrphanCheck`) must follow the user
// across devices/backups. These tests drive the REAL `@/lib/database` schema
// over fake-indexeddb through the full export -> restore pipeline and assert:
//   1. a non-default `disableOrphanCheck` survives an export/restore, and
//   2. restoring an older backup that lacks the field leaves the current value
//      (the default) untouched.
// The backup is UNENCRYPTED so no WebCrypto subtle support is required.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";

import { db } from "@/lib/database";
import { exportBackup, type AttachmentFileIO } from "./export";
import { restoreV3Backup, type AttachmentFileWriter } from "./restore";
import { restoreSettingsPreferences } from "./inline-tables";
import { MemorySink, type BackupSink } from "./sink";
import { blobChunks } from "./zip-stream";

import { getSettings, putSettings, updateSettings, clearSettings } from "@/lib/data/settings-crud";
import { clearAllRecords } from "@/lib/data/record-crud";
import { clearAttachments } from "@/lib/data/attachments-crud";
import {
  bulkAddTransactions,
  clearParticipants,
  clearTransactions,
  getTransactionByTxid,
} from "@/lib/data/transaction-crud";
import { clearAddressSyncState } from "@/lib/data/address-sync-crud";
import {
  clearUtxoLineage,
  clearCustodySegments,
} from "@/lib/data/lineage-crud";
import { clearNodeSettings } from "@/lib/data/node-settings-crud";

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

const BASE_SETTINGS = {
  id: "default",
  fieldVisibility: {
    seedName: true,
    walletSoftware: true,
    privateKeyStatus: false,
    owner: true,
    walletName: true,
    source: true,
  },
  tableColumns: {},
  customFieldColumns: {},
  theme: "light",
  defaultView: "table",
  cancelConfirmThreshold: 75,
  privacyHistoryLimit: 30,
  fundTrailTxLimit: 2000,
  disableOrphanCheck: false,
} as any;

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
  await clearSettings({ skipNotification: true });
}

describe("settings preferences backup round-trip", () => {
  beforeEach(async () => {
    await clearEverything();
  });

  it("restores a non-default disableOrphanCheck preference", async () => {
    await putSettings({ ...BASE_SETTINGS, disableOrphanCheck: true }, { skipNotification: true });

    // Export captures disableOrphanCheck=true.
    const sink = new MemorySink();
    await exportBackup({
      sink: sink as BackupSink,
      encrypted: false,
      batchSize: 25,
      attachmentIO,
    });
    const blob = sink.blob as Blob;

    // Flip the live value to false so restore has to re-apply the backed-up
    // preference rather than just leaving the existing value in place.
    await updateSettings("default", { disableOrphanCheck: false }, { skipNotification: true });

    await restoreV3Backup({ source: blobChunks(blob), attachmentWriter });

    const restored = await getSettings("default");
    expect(restored?.disableOrphanCheck).toBe(true);
  });

  it("leaves the current value untouched when the backup lacks the field", async () => {
    // Current device has the reminder enabled (default: not disabled).
    await putSettings({ ...BASE_SETTINGS, disableOrphanCheck: false }, { skipNotification: true });

    // Simulate an OLDER backup whose settings row predates the field entirely.
    const olderRow = { ...BASE_SETTINGS };
    delete (olderRow as any).disableOrphanCheck;
    await restoreSettingsPreferences([olderRow]);

    const after = await getSettings("default");
    // Still at its default (reminder enabled) — restore did not flip it.
    expect(after?.disableOrphanCheck).toBe(false);
  });

  it("does nothing when there is no settings row to merge into", async () => {
    // No default settings row exists.
    expect(await getSettings("default")).toBeUndefined();

    await expect(
      restoreSettingsPreferences([{ id: "default", disableOrphanCheck: true }]),
    ).resolves.toBeUndefined();

    expect(await getSettings("default")).toBeUndefined();
  });

  it("restores non-default numeric preferences", async () => {
    await putSettings(
      { ...BASE_SETTINGS, cancelConfirmThreshold: 90, privacyHistoryLimit: 100, fundTrailTxLimit: 5000 },
      { skipNotification: true },
    );

    // Export captures the non-default numeric preferences.
    const sink = new MemorySink();
    await exportBackup({
      sink: sink as BackupSink,
      encrypted: false,
      batchSize: 25,
      attachmentIO,
    });
    const blob = sink.blob as Blob;

    // Flip the live values so restore has to re-apply the backed-up ones.
    await updateSettings(
      "default",
      { cancelConfirmThreshold: 50, privacyHistoryLimit: 30, fundTrailTxLimit: 2000 },
      { skipNotification: true },
    );

    await restoreV3Backup({ source: blobChunks(blob), attachmentWriter });

    const restored = await getSettings("default");
    expect(restored?.cancelConfirmThreshold).toBe(90);
    expect(restored?.privacyHistoryLimit).toBe(100);
    expect((restored as any)?.fundTrailTxLimit).toBe(5000);
  });

  it("leaves current numeric preferences untouched when the backup lacks them", async () => {
    await putSettings(
      { ...BASE_SETTINGS, cancelConfirmThreshold: 80, privacyHistoryLimit: 45, fundTrailTxLimit: 10000 },
      { skipNotification: true },
    );

    // Simulate an OLDER backup whose settings row predates these fields, and
    // a malformed (NaN) value which must also be ignored.
    const olderRow = { ...BASE_SETTINGS };
    delete (olderRow as any).cancelConfirmThreshold;
    delete (olderRow as any).privacyHistoryLimit;
    delete (olderRow as any).fundTrailTxLimit;
    (olderRow as any).privacyHistoryLimit = Number.NaN;
    await restoreSettingsPreferences([olderRow]);

    const after = await getSettings("default");
    expect(after?.cancelConfirmThreshold).toBe(80);
    expect(after?.privacyHistoryLimit).toBe(45);
    expect((after as any)?.fundTrailTxLimit).toBe(10000);
  });

  it("restores updated named Transaction Inbox views without resurrecting deleted views", async () => {
    const updatedView = {
      id: "view-1",
      name: "High-value incoming",
      tab: "new" as const,
      search: "invoice",
      filters: {
        dateMode: "range" as const,
        dateStart: "2026-01-01T00:00:00.000Z",
        amountMode: "range" as const,
        amountMinBtc: 1,
      },
      createdAt: 1,
    };
    const unrelatedTxid = "a".repeat(64);
    await putSettings({ ...BASE_SETTINGS, savedInboxViews: [updatedView] }, { skipNotification: true });
    await bulkAddTransactions([{
      txid: unrelatedTxid,
      blockHeight: 900_001,
      blockTime: 1_735_689_600,
      fee: 100,
      feeRate: 1,
      syncedAt: 1_735_689_600_000,
      curationState: "new",
    }], { skipNotification: true });

    const sink = new MemorySink();
    await exportBackup({
      sink: sink as BackupSink,
      encrypted: false,
      batchSize: 25,
      attachmentIO,
    });
    const blob = sink.blob as Blob;
    await updateSettings(
      "default",
      {
        savedInboxViews: [
          {
            ...updatedView,
            search: "stale",
            filters: { dateMode: "any", amountMode: "any" },
          },
          {
            id: "deleted-view",
            name: "Deleted before backup",
            tab: "ignored",
            search: "stale",
            filters: { dateMode: "any", amountMode: "any" },
            createdAt: 2,
          },
        ],
      },
      { skipNotification: true },
    );

    await restoreV3Backup({ source: blobChunks(blob), attachmentWriter });

    expect((await getSettings("default"))?.savedInboxViews).toEqual([updatedView]);
    expect(await getTransactionByTxid(unrelatedTxid)).toMatchObject({
      txid: unrelatedTxid,
      blockHeight: 900_001,
      curationState: "new",
    });
  });
});

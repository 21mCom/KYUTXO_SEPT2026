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
  clearParticipants,
  clearTransactions,
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
});

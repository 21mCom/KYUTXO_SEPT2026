// @vitest-environment jsdom
//
// Regression guard for the Privacy Audit entity-list snapshot surviving a full
// vault backup -> restore round-trip.
//
// The user's custom entity list is persisted on the singleton `settings` record
// (field `entityListSnapshot`). The `settings` table is intentionally NOT
// cleared or wholesale restored (device-local prefs survive), so the snapshot
// must ride across a backup via the portable allow-list in
// `restoreSettingsPreferences`. A regression that drops it from that allow-list
// (or a settings-restore regression generally) would silently lose a user's
// curated entity list. These tests drive the REAL `@/lib/database` schema over
// fake-indexeddb through the full export -> restore pipeline and assert:
//   1. a REPLACE-mode snapshot round-trips with its exact entries + mode, and
//   2. a MERGE-mode snapshot round-trips storing only the user entries + mode,
// and that after restore + loadEntitySnapshotFromStorage the active list
// re-applies correctly (exact for replace, merged-onto-bundled for merge).
// The backup is UNENCRYPTED so no WebCrypto subtle support is required.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { db } from "@/lib/database";
import type { Settings } from "@/lib/db-types";
import { exportBackup, type AttachmentFileIO } from "./export";
import { restoreV3Backup, type AttachmentFileWriter } from "./restore";
import { MemorySink, type BackupSink } from "./sink";
import { blobChunks } from "./zip-stream";

import {
  getSettings,
  putSettings,
  updateSettings,
  clearSettings,
} from "@/lib/data/settings-crud";
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
  importEntitySnapshot,
  loadEntitySnapshotFromStorage,
} from "@/lib/data/entity-list-store";
import {
  resetActiveEntityList,
  getActiveEntityList,
  getActiveEntitySource,
  getBundledEntityCount,
} from "@/lib/privacy-entity-list";

// Real, known-valid mainnet addresses. `binance`/`gambling1` are drawn from the
// bundled list; `notBundled` is a valid mainnet address that is NOT bundled, so
// a merge that includes it grows the active list by exactly one.
const ADDR = {
  binance: "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo",
  gambling1: "18WsHUKZ3D6DPTjWcDGS99E1uL2xYaxDaW",
  notBundled: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
} as const;

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
  await clearSettings({ skipNotification: true });
}

// A Dexie settings update is a no-op when the row is absent, so the real app
// always has a 'default' settings record. Seed a minimal one before each test.
async function seedDefaultSettings(): Promise<void> {
  await putSettings({ id: "default" } as Settings, { skipNotification: true });
}

/**
 * Export the current vault, then simulate the snapshot being gone before
 * restore (a fresh device, or a settings-restore regression that wiped it), so
 * restore has to actually re-apply it from the backup rather than the value
 * simply surviving because `settings` is never cleared. Finally restore.
 */
async function exportWipeRestore(): Promise<void> {
  const sink = new MemorySink();
  await exportBackup({
    sink: sink as BackupSink,
    encrypted: false,
    batchSize: 25,
    attachmentIO,
  });
  const blob = sink.blob as Blob;
  expect(blob).toBeInstanceOf(Blob);

  // Wipe the live snapshot + active list so restore must repopulate from backup.
  await updateSettings(
    "default",
    { entityListSnapshot: undefined },
    { skipNotification: true },
  );
  resetActiveEntityList();
  expect((await getSettings("default"))?.entityListSnapshot).toBeUndefined();

  await restoreV3Backup({ source: blobChunks(blob), attachmentWriter });
}

beforeEach(async () => {
  await clearEverything();
  await seedDefaultSettings();
  resetActiveEntityList();
});

afterEach(() => {
  // Never leak an imported active list into other suites.
  resetActiveEntityList();
});

describe("entity-list snapshot backup round-trip", () => {
  it("restores a replace-mode snapshot with its exact entries and mode", async () => {
    const raw = [
      { address: ADDR.binance, name: "Binance", category: "exchange" },
      { address: ADDR.gambling1, name: "Casino", category: "gambling" },
    ];
    const imported = await importEntitySnapshot(raw, "replace.json", "replace");
    expect(imported.valid).toBe(true);

    await exportWipeRestore();

    // The restored settings record carries the snapshot with mode + entries.
    const restored = await getSettings("default");
    expect(restored?.entityListSnapshot).toBeDefined();
    expect(restored!.entityListSnapshot!.mode).toBe("replace");
    expect(restored!.entityListSnapshot!.sourceLabel).toBe("replace.json");
    const persisted = new Set(
      restored!.entityListSnapshot!.entries.map((e) => e.address),
    );
    expect(persisted).toEqual(new Set([ADDR.binance, ADDR.gambling1]));

    // Re-applying at startup yields exactly the imported entries (no bundled).
    const status = await loadEntitySnapshotFromStorage();
    expect(status.source).toBe("imported");
    expect(getActiveEntitySource()).toBe("imported");
    const active = new Set(getActiveEntityList().map((e) => e.address));
    expect(active).toEqual(new Set([ADDR.binance, ADDR.gambling1]));
  });

  it("restores a merge-mode snapshot storing only the user entries + mode", async () => {
    const raw = [
      { address: ADDR.notBundled, name: "New Market", category: "darknet" },
    ];
    const imported = await importEntitySnapshot(raw, "merge.json", "merge");
    expect(imported.valid).toBe(true);

    await exportWipeRestore();

    // Only the single user entry is persisted (not the merged result), with
    // mode='merge' so startup re-merges onto the (possibly updated) bundled list.
    const restored = await getSettings("default");
    expect(restored?.entityListSnapshot).toBeDefined();
    expect(restored!.entityListSnapshot!.mode).toBe("merge");
    expect(restored!.entityListSnapshot!.entries).toHaveLength(1);
    expect(restored!.entityListSnapshot!.entries[0].address).toBe(ADDR.notBundled);

    // Re-applying at startup re-merges: bundled list plus the one user entry.
    const status = await loadEntitySnapshotFromStorage();
    expect(status.source).toBe("imported");
    expect(getActiveEntityList()).toHaveLength(getBundledEntityCount() + 1);
    const active = new Set(getActiveEntityList().map((e) => e.address));
    expect(active.has(ADDR.notBundled)).toBe(true);
  });

  it("leaves a device snapshot untouched when the backup has none", async () => {
    // This device has a custom replace-mode snapshot...
    await importEntitySnapshot(
      [{ address: ADDR.binance, name: "Binance", category: "exchange" }],
      "device.json",
      "replace",
    );

    // ...but we restore an OLDER backup whose settings row predates the feature.
    const olderRow = { id: "default" };
    const { restoreSettingsPreferences } = await import("./inline-tables");
    await restoreSettingsPreferences([olderRow]);

    // The device snapshot is preserved (an absent field never clobbers).
    const after = await getSettings("default");
    expect(after?.entityListSnapshot).toBeDefined();
    expect(after!.entityListSnapshot!.entries[0].address).toBe(ADDR.binance);
  });
});

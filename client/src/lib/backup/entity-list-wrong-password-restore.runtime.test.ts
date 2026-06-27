// @vitest-environment jsdom
//
// Regression guard proving a custom Privacy Audit entity-list snapshot survives
// a wrong-then-right password restore of an ENCRYPTED backup.
//
// The sibling test (entity-list-roundtrip-encrypted.runtime.test.ts) proves the
// snapshot round-trips through a SUCCESSFUL encrypted export -> restore. This
// suite covers the failure-then-recovery path instead: the encrypted restore
// verifies the password BEFORE the destructive clear, so a wrong (or missing)
// password must reject WITHOUT touching the device's live vault or its already
// imported entityListSnapshot. A regression that cleared early — or that decoded
// the inline manifest before verifying the password — could silently wipe a
// user's custom entity list on a bad-password attempt.
//
// These tests drive the REAL `@/lib/database` schema over fake-indexeddb through
// the full encrypted export -> restore pipeline (real WebCrypto subtle) and
// assert:
//   1. a WRONG password rejects and leaves the live snapshot + vault intact,
//   2. a MISSING password rejects and likewise leaves them intact, and
//   3. a follow-up CORRECT password restore re-applies the snapshot from backup.

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
import {
  bulkCreateRecords,
  clearAllRecords,
  countRecords,
  type CreateRecordData,
} from "@/lib/data/record-crud";
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
} from "@/lib/privacy-entity-list";

// Real, known-valid mainnet addresses drawn from the bundled list.
const ADDR = {
  binance: "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo",
  gambling1: "18WsHUKZ3D6DPTjWcDGS99E1uL2xYaxDaW",
} as const;

const PASSWORD = "correct horse battery staple";
const WRONG_PASSWORD = "definitely-the-wrong-password";

const N_REC = 4;

const attachmentIO: AttachmentFileIO = {
  async listAll() {
    return [];
  },
  async read() {
    return null;
  },
};

// Track every attachment write so we can prove a failed restore wrote nothing.
let restoredFiles: Map<string, Uint8Array>;
const attachmentWriter: AttachmentFileWriter = {
  async write(relPath, data) {
    restoredFiles.set(relPath, new Uint8Array(data));
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

// Seed a handful of records so we can prove a failed restore never cleared the
// live vault (the encrypted clear runs AFTER password verification).
async function seedRecords(): Promise<void> {
  const rows: CreateRecordData[] = [];
  for (let i = 1; i <= N_REC; i++) {
    const inputString = `addr-${String(i).padStart(5, "0")}`;
    rows.push({
      type: "address",
      inputString,
      inputStringLower: inputString,
      label: `r${i}`,
      tags: [],
      categories: [],
      addressImportance: "manual",
    } as unknown as CreateRecordData);
  }
  await bulkCreateRecords(rows, {
    skipNotification: true,
    skipVocabularySync: true,
  });
}

async function exportEncrypted(): Promise<Blob> {
  const sink = new MemorySink();
  await exportBackup({
    sink: sink as BackupSink,
    encrypted: true,
    password: PASSWORD,
    batchSize: 25,
    attachmentIO,
  });
  const blob = sink.blob as Blob;
  expect(blob).toBeInstanceOf(Blob);
  return blob;
}

beforeEach(async () => {
  restoredFiles = new Map();
  await clearEverything();
  await seedDefaultSettings();
  resetActiveEntityList();
});

afterEach(() => {
  // Never leak an imported active list into other suites.
  resetActiveEntityList();
});

describe("entity-list snapshot survives a wrong-then-right password restore", () => {
  it("a wrong/missing password leaves the live snapshot intact, then the right password re-applies it", async () => {
    // 1. Import a replace-mode snapshot and keep it LIVE on the device.
    const raw = [
      { address: ADDR.binance, name: "Binance", category: "exchange" },
      { address: ADDR.gambling1, name: "Casino", category: "gambling" },
    ];
    const imported = await importEntitySnapshot(raw, "custom.json", "replace");
    expect(imported.valid).toBe(true);
    await seedRecords();
    expect(await countRecords()).toBe(N_REC);

    // The live snapshot + active list reflect the import.
    const liveSnap = (await getSettings("default"))?.entityListSnapshot;
    expect(liveSnap).toBeDefined();
    expect(liveSnap!.mode).toBe("replace");
    const liveAddrs = new Set(liveSnap!.entries.map((e) => e.address));
    expect(liveAddrs).toEqual(new Set([ADDR.binance, ADDR.gambling1]));
    expect(getActiveEntitySource()).toBe("imported");
    expect(new Set(getActiveEntityList().map((e) => e.address))).toEqual(
      new Set([ADDR.binance, ADDR.gambling1]),
    );

    // 2. Export an encrypted backup of the current vault.
    const blob = await exportEncrypted();

    // 3. A WRONG password must reject BEFORE the destructive clear, leaving the
    //    live snapshot, the vault records, and the active list fully intact.
    await expect(
      restoreV3Backup({
        source: blobChunks(blob),
        password: WRONG_PASSWORD,
        attachmentWriter,
      }),
    ).rejects.toThrow(/invalid password|corrupted/i);

    expect(await countRecords()).toBe(N_REC);
    expect(restoredFiles.size).toBe(0);
    const afterWrong = (await getSettings("default"))?.entityListSnapshot;
    expect(afterWrong).toBeDefined();
    expect(afterWrong!.mode).toBe("replace");
    expect(new Set(afterWrong!.entries.map((e) => e.address))).toEqual(
      new Set([ADDR.binance, ADDR.gambling1]),
    );
    expect(getActiveEntitySource()).toBe("imported");

    // 4. A MISSING password on an encrypted backup also rejects before clearing.
    await expect(
      restoreV3Backup({
        source: blobChunks(blob),
        // no password
        attachmentWriter,
      }),
    ).rejects.toThrow(/password required/i);

    expect(await countRecords()).toBe(N_REC);
    expect(restoredFiles.size).toBe(0);
    const afterMissing = (await getSettings("default"))?.entityListSnapshot;
    expect(afterMissing).toBeDefined();
    expect(new Set(afterMissing!.entries.map((e) => e.address))).toEqual(
      new Set([ADDR.binance, ADDR.gambling1]),
    );
    expect(getActiveEntitySource()).toBe("imported");

    // 5. Simulate the snapshot being gone (fresh device or a settings-restore
    //    regression that wiped it) so the CORRECT-password restore must actually
    //    re-apply it from the encrypted backup rather than rely on it surviving.
    await updateSettings(
      "default",
      { entityListSnapshot: undefined },
      { skipNotification: true },
    );
    resetActiveEntityList();
    expect((await getSettings("default"))?.entityListSnapshot).toBeUndefined();

    // 6. A CORRECT-password restore succeeds and re-applies the snapshot.
    const result = await restoreV3Backup({
      source: blobChunks(blob),
      password: PASSWORD,
      attachmentWriter,
    });
    expect(result.manifest.encrypted).toBe(true);
    expect(await countRecords()).toBe(N_REC);

    const restored = (await getSettings("default"))?.entityListSnapshot;
    expect(restored).toBeDefined();
    expect(restored!.mode).toBe("replace");
    expect(restored!.sourceLabel).toBe("custom.json");
    expect(new Set(restored!.entries.map((e) => e.address))).toEqual(
      new Set([ADDR.binance, ADDR.gambling1]),
    );

    // Re-applying at startup yields exactly the imported entries (no bundled).
    const status = await loadEntitySnapshotFromStorage();
    expect(status.source).toBe("imported");
    expect(getActiveEntitySource()).toBe("imported");
    expect(new Set(getActiveEntityList().map((e) => e.address))).toEqual(
      new Set([ADDR.binance, ADDR.gambling1]),
    );
  });
});

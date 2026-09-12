// @vitest-environment jsdom
//
// Regression guard proving a MERGE-mode Privacy Audit entity-list snapshot
// survives an aborted/failed restore of a PLAIN (UNENCRYPTED) backup, then is
// re-merged correctly by a follow-up successful restore.
//
// The sibling test (entity-list-merge-wrong-password-restore.runtime.test.ts)
// covers the same failure-then-recovery path for an ENCRYPTED backup, where a
// wrong/missing password rejects BEFORE the destructive clear. An unencrypted
// backup takes a DIFFERENT restore path: there is no password gate, so the only
// thing standing between the archive and the destructive clear is the abort
// check at the point-of-no-return boundary. If a restore is cancelled before
// that boundary, `cleared` stays false and the live vault + the already imported
// entityListSnapshot must be left fully intact.
//
// Merge mode takes a different code path than replace mode on restore: only the
// user-supplied entries are persisted, and they are re-merged onto the bundled
// list at startup (loadEntitySnapshotFromStorage). A regression could drop or
// double-apply the merge-mode user entries on the recovery restore without the
// replace-mode round-trip test noticing.
//
// This suite drives the REAL `@/lib/database` schema over fake-indexeddb through
// the full UNENCRYPTED export -> restore pipeline and asserts:
//   1. an ABORTED restore (already-aborted AbortSignal) rejects BEFORE the
//      destructive clear, leaving the live merge snapshot + vault intact, and
//   2. a follow-up successful restore re-applies the merge (bundled list plus
//      the one non-bundled user entry).

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { db } from "@/lib/database";
import type { Settings } from "@/lib/db-types";
import { exportBackup, type AttachmentFileIO } from "./export";
import { restoreV3Backup, type AttachmentFileWriter } from "./restore";
import { MemorySink, BackupCancelledError, type BackupSink } from "./sink";
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
  getBundledEntityCount,
} from "@/lib/privacy-entity-list";

// Real, known-valid mainnet addresses. `binance` is drawn from the bundled list
// (so a merge overrides it rather than adds it); `notBundled` is a valid mainnet
// address that is NOT bundled, so the merge grows the active list by exactly one.
const ADDR = {
  binance: "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo",
  notBundled: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
} as const;

const N_REC = 4;

const attachmentIO: AttachmentFileIO = {
  async listAll() {
    return [];
  },
  async read() {
    return null;
  },
};

// Track every attachment write so we can prove an aborted restore wrote nothing.
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

// Seed a handful of records so we can prove an aborted restore never cleared the
// live vault (the destructive clear runs only AFTER the abort boundary passes).
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

async function exportPlain(): Promise<Blob> {
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

describe("merge-mode entity-list snapshot survives an aborted plain restore", () => {
  it("an aborted restore leaves the live merge snapshot intact, then a successful restore re-applies it", async () => {
    // 1. Import a MERGE-mode snapshot (one bundled override + one brand-new
    //    non-bundled entry) and keep it LIVE on the device.
    const raw = [
      { address: ADDR.binance, name: "Binance HOT", category: "exchange" },
      { address: ADDR.notBundled, name: "New Market", category: "darknet" },
    ];
    const imported = await importEntitySnapshot(raw, "merge.json", "merge");
    expect(imported.valid).toBe(true);
    await seedRecords();
    expect(await countRecords()).toBe(N_REC);

    // The live snapshot persists ONLY the user entries (with mode='merge'), and
    // the active list is the bundled list re-merged plus the one new address.
    const bundledCount = getBundledEntityCount();
    const liveSnap = (await getSettings("default"))?.entityListSnapshot;
    expect(liveSnap).toBeDefined();
    expect(liveSnap!.mode).toBe("merge");
    expect(new Set(liveSnap!.entries.map((e) => e.address))).toEqual(
      new Set([ADDR.binance, ADDR.notBundled]),
    );
    expect(getActiveEntitySource()).toBe("imported");
    expect(getActiveEntityList()).toHaveLength(bundledCount + 1);
    expect(
      new Set(getActiveEntityList().map((e) => e.address)).has(ADDR.notBundled),
    ).toBe(true);

    // 2. Export an UNENCRYPTED backup of the current vault.
    const blob = await exportPlain();

    // 3. An ABORTED restore (already-aborted signal) must reject BEFORE the
    //    destructive clear. With no password gate, the abort check at the
    //    point-of-no-return boundary is the only thing protecting the live
    //    vault, snapshot, and active list — all must be left fully intact.
    const controller = new AbortController();
    controller.abort();
    await expect(
      restoreV3Backup({
        source: blobChunks(blob),
        attachmentWriter,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      name: "BackupCancelledError",
      // Cancelled before the clear: the existing vault was never touched.
      clearedBeforeCancel: false,
    });

    expect(await countRecords()).toBe(N_REC);
    expect(restoredFiles.size).toBe(0);
    const afterAbort = (await getSettings("default"))?.entityListSnapshot;
    expect(afterAbort).toBeDefined();
    expect(afterAbort!.mode).toBe("merge");
    expect(new Set(afterAbort!.entries.map((e) => e.address))).toEqual(
      new Set([ADDR.binance, ADDR.notBundled]),
    );
    expect(getActiveEntitySource()).toBe("imported");
    expect(getActiveEntityList()).toHaveLength(bundledCount + 1);
    expect(
      new Set(getActiveEntityList().map((e) => e.address)).has(ADDR.notBundled),
    ).toBe(true);

    // 4. Simulate the snapshot being gone (fresh device or a settings-restore
    //    regression that wiped it) so the successful restore must actually
    //    re-apply it from the backup rather than rely on it surviving.
    await updateSettings(
      "default",
      { entityListSnapshot: undefined },
      { skipNotification: true },
    );
    resetActiveEntityList();
    expect((await getSettings("default"))?.entityListSnapshot).toBeUndefined();

    // 5. A clean (non-aborted) restore succeeds and re-applies the snapshot,
    //    persisting only the user entries with mode='merge'.
    const result = await restoreV3Backup({
      source: blobChunks(blob),
      attachmentWriter,
    });
    expect(result.manifest.encrypted).toBe(false);
    expect(await countRecords()).toBe(N_REC);

    const restored = (await getSettings("default"))?.entityListSnapshot;
    expect(restored).toBeDefined();
    expect(restored!.mode).toBe("merge");
    expect(restored!.sourceLabel).toBe("merge.json");
    expect(new Set(restored!.entries.map((e) => e.address))).toEqual(
      new Set([ADDR.binance, ADDR.notBundled]),
    );

    // Re-applying at startup re-merges onto the bundled list: bundled count plus
    // the single non-bundled user entry (the bundled override does not grow it).
    const status = await loadEntitySnapshotFromStorage();
    expect(status.source).toBe("imported");
    expect(getActiveEntitySource()).toBe("imported");
    expect(getActiveEntityList()).toHaveLength(bundledCount + 1);
    expect(
      new Set(getActiveEntityList().map((e) => e.address)).has(ADDR.notBundled),
    ).toBe(true);
  });
});

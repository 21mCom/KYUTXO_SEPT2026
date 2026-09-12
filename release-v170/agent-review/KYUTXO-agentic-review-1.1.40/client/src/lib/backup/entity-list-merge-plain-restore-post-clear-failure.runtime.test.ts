// @vitest-environment jsdom
//
// Regression guard proving a MERGE-mode Privacy Audit entity-list snapshot is
// NOT silently lost when a PLAIN (UNENCRYPTED) restore fails AFTER the
// destructive clear, and is re-merged cleanly by a follow-up successful restore.
//
// The sibling test (entity-list-merge-plain-restore-abort.runtime.test.ts)
// covers the LESS dangerous case: a restore aborted BEFORE the destructive
// clear, where `cleared` stays false and the live vault + snapshot are left
// fully intact. This suite covers the OTHER, far more dangerous case: a restore
// that gets PAST the point-of-no-return — the old vault is already wiped and the
// inline tables (including the entityListSnapshot, merged via
// restoreSettingsPreferences) are already restored — and THEN a later step
// throws (here: an attachment file write that fails for a real-world reason like
// a full disk). At that point the restore cannot return to the prior state, so
// it mirrors the cancel-after-clear contract: it resets the data tables to a
// known-empty state and surfaces a distinct RestoreInterruptedError (raw error
// preserved as `cause`), never a half-restored, unusable vault.
//
// A regression here could leave the user with a confusing partial entity list,
// or a persisted snapshot that no longer matches the (now empty) vault, or an
// entity list that re-running the restore fails to re-merge. This suite drives
// the REAL `@/lib/database` schema over fake-indexeddb through the full
// UNENCRYPTED export -> failing-restore -> recovery-restore pipeline and asserts:
//   1. the post-clear failure rejects with RestoreInterruptedError (the write
//      error preserved as `cause`), the data tables are reset to verified-empty,
//      and the persisted merge snapshot is left whole — NOT torn into a
//      half-applied subset — so nothing dishonest is presented as live, and
//   2. a follow-up successful restore + loadEntitySnapshotFromStorage re-applies
//      the merge (bundled list plus the one non-bundled user entry).

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { db } from "@/lib/database";
import type { Settings } from "@/lib/db-types";
import { exportBackup, type AttachmentFileIO } from "./export";
import {
  restoreV3Backup,
  RestoreInterruptedError,
  type AttachmentFileWriter,
} from "./restore";
import { MemorySink, type BackupSink } from "./sink";
import { blobChunks } from "./zip-stream";

import {
  getSettings,
  putSettings,
  updateSettings,
  clearSettings,
} from "@/lib/data/settings-crud";
import {
  createRecord,
  clearAllRecords,
  countRecords,
} from "@/lib/data/record-crud";
import {
  addAttachment,
  clearAttachments,
  countAttachments,
} from "@/lib/data/attachments-crud";
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

// The single attachment file carried in the backup. Its bytes are how the
// failing writer recognises (and rejects) exactly this one file.
const ATTACH_REL_PATH = "ab/cdef0123456789";
const ATTACH_BYTES = "TXPROOF-BYTES-FOR-POST-CLEAR-FAILURE";

// In-memory attachment IO for export: surface the one seeded attachment file so
// the backup zip actually CONTAINS a file whose restore write can be made to
// fail after the destructive clear.
const attachmentIO: AttachmentFileIO = {
  async listAll() {
    return [ATTACH_REL_PATH];
  },
  async read(relPath) {
    return relPath === ATTACH_REL_PATH
      ? new TextEncoder().encode(ATTACH_BYTES).buffer
      : null;
  },
};

// A writer that records every successful write and supports delete (so the
// post-failure sweep of already-written files runs). Used for the recovery
// restore.
let restoredFiles: Map<string, Uint8Array>;
const recordingWriter: AttachmentFileWriter = {
  async write(relPath, data) {
    restoredFiles.set(relPath, new Uint8Array(data));
  },
  async delete(relPath) {
    restoredFiles.delete(relPath);
  },
};

// A writer that throws when asked to write the one seeded attachment file,
// simulating a disk-full/permission failure AFTER the destructive clear (the
// inline DB tables, including the entityListSnapshot, are already restored by
// the time the file write phase runs). Delegates delete to the recording writer
// so the post-failure sweep can reclaim anything already written.
const WRITE_ERROR = "simulated disk-full: attachment write rejected";
let attemptedFailingWrite: boolean;
const failingWriter: AttachmentFileWriter = {
  async write(relPath, data) {
    const text = new TextDecoder().decode(new Uint8Array(data));
    if (text === ATTACH_BYTES) {
      attemptedFailingWrite = true;
      throw new Error(WRITE_ERROR);
    }
    restoredFiles.set(relPath, new Uint8Array(data));
  },
  async delete(relPath) {
    restoredFiles.delete(relPath);
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

// Seed one record that OWNS the single attachment, so the attachment is NOT an
// orphan on restore — its file bytes go through write() (which the failing
// writer rejects) rather than writeReview().
async function seedRecordWithAttachment(): Promise<void> {
  const recordId = await createRecord(
    {
      type: "transaction",
      inputString: "txid-post-clear-0001",
      label: "owner of the failing attachment",
      tags: [],
      categories: [],
    } as any,
    { skipNotification: true, skipVocabularySync: true },
  );
  await addAttachment(
    {
      recordId,
      filename: "txproof.txt",
      mimeType: "text/plain",
      size: ATTACH_BYTES.length,
      objectStoragePath: ATTACH_REL_PATH,
    },
    { skipNotification: true },
  );
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
  attemptedFailingWrite = false;
  await clearEverything();
  await seedDefaultSettings();
  resetActiveEntityList();
});

afterEach(() => {
  // Never leak an imported active list into other suites.
  resetActiveEntityList();
});

describe("merge-mode entity-list snapshot survives a post-clear failure of a plain restore", () => {
  it("a post-clear failure resets the vault, keeps the merge snapshot whole, then a successful restore re-applies it", async () => {
    // 1. Import a MERGE-mode snapshot (one bundled override + one brand-new
    //    non-bundled entry) and keep it LIVE on the device.
    const raw = [
      { address: ADDR.binance, name: "Binance HOT", category: "exchange" },
      { address: ADDR.notBundled, name: "New Market", category: "darknet" },
    ];
    const imported = await importEntitySnapshot(raw, "merge.json", "merge");
    expect(imported.valid).toBe(true);

    // Seed the record + the one attachment whose file write will later fail.
    await seedRecordWithAttachment();
    expect(await countRecords()).toBe(1);
    expect(await countAttachments()).toBe(1);

    const bundledCount = getBundledEntityCount();
    const liveSnap = (await getSettings("default"))?.entityListSnapshot;
    expect(liveSnap).toBeDefined();
    expect(liveSnap!.mode).toBe("merge");
    expect(new Set(liveSnap!.entries.map((e) => e.address))).toEqual(
      new Set([ADDR.binance, ADDR.notBundled]),
    );
    expect(getActiveEntitySource()).toBe("imported");
    expect(getActiveEntityList()).toHaveLength(bundledCount + 1);

    // 2. Export an UNENCRYPTED backup of the current vault (carries the one
    //    attachment file inside the zip).
    const blob = await exportPlain();

    // 3. Restore with a writer that throws when it reaches the attachment file.
    //    This failure happens AFTER the destructive clear and AFTER the inline
    //    tables (entityListSnapshot included) were restored, so the restore must
    //    NOT rethrow the raw write error and leave a half-restored vault. It
    //    mirrors the cancel-after-clear contract: reset the data tables to empty
    //    and surface a distinct RestoreInterruptedError with the write error
    //    preserved as its `cause`.
    let caught: unknown;
    try {
      await restoreV3Backup({
        source: blobChunks(blob),
        attachmentWriter: failingWriter,
      });
      throw new Error("restore should have rejected");
    } catch (err) {
      caught = err;
    }
    expect(attemptedFailingWrite).toBe(true);
    expect(caught).toBeInstanceOf(RestoreInterruptedError);
    expect((caught as Error).message).toMatch(/partially restored|restore again/i);
    expect((caught as { cause?: Error }).cause?.message).toBe(WRITE_ERROR);

    // The data tables must be reset to verified-empty — no phantom record or
    // attachment row left pointing at a file that was never written.
    expect(await countRecords()).toBe(0);
    expect(await countAttachments()).toBe(0);
    // The one file that WAS written before the failing one is swept off disk.
    expect(restoredFiles.size).toBe(0);

    // The persisted merge snapshot must be left WHOLE — not torn into a
    // half-applied subset and not silently lost. Re-merging it onto the bundled
    // list (exactly what startup does) yields a coherent, honest active list
    // even though the vault is now empty: bundled count plus the one non-bundled
    // user entry. This is the proof there is no half-applied snapshot lingering.
    const afterFailure = (await getSettings("default"))?.entityListSnapshot;
    expect(afterFailure).toBeDefined();
    expect(afterFailure!.mode).toBe("merge");
    expect(new Set(afterFailure!.entries.map((e) => e.address))).toEqual(
      new Set([ADDR.binance, ADDR.notBundled]),
    );
    const honest = await loadEntitySnapshotFromStorage();
    expect(honest.source).toBe("imported");
    expect(getActiveEntitySource()).toBe("imported");
    expect(getActiveEntityList()).toHaveLength(bundledCount + 1);
    expect(
      new Set(getActiveEntityList().map((e) => e.address)).has(ADDR.notBundled),
    ).toBe(true);

    // 4. Simulate the snapshot being gone (fresh device / a settings regression
    //    that wiped it) so the recovery restore must actually re-apply it from
    //    the backup rather than rely on it surviving the failure above.
    await updateSettings(
      "default",
      { entityListSnapshot: undefined },
      { skipNotification: true },
    );
    resetActiveEntityList();
    expect((await getSettings("default"))?.entityListSnapshot).toBeUndefined();

    // 5. A clean (non-failing) restore succeeds: the vault is restored AND the
    //    snapshot is re-applied, persisting only the user entries with
    //    mode='merge'.
    const result = await restoreV3Backup({
      source: blobChunks(blob),
      attachmentWriter: recordingWriter,
    });
    expect(result.manifest.encrypted).toBe(false);
    expect(await countRecords()).toBe(1);
    expect(await countAttachments()).toBe(1);
    expect(result.counts.attachmentFiles).toBe(1);
    expect(restoredFiles.has(ATTACH_REL_PATH)).toBe(true);

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

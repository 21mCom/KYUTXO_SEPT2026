// @vitest-environment jsdom
//
// Contract test for restore cancellation semantics (Task: "Define restore
// cancellation semantics at scale"). A v3 restore is destructive: it clears the
// whole vault before streaming the backup back in. The contract is:
//   - Cancel BEFORE the destructive clear -> existing vault is left fully intact
//     and BackupCancelledError.clearedBeforeCancel is false.
//   - Cancel AFTER the clear has begun -> the vault is reset to a known-EMPTY
//     state (never left half-restored) and clearedBeforeCancel is true.
//
// We build a real (unencrypted) v3 backup with exportBackup, then drive
// restoreV3Backup with an AbortSignal tripped at each side of the clear.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeAll } from "vitest";

import { db } from "@/lib/database";
import { exportBackup, type AttachmentFileIO } from "./export";
import {
  restoreV3Backup,
  RestoreInterruptedError,
  type AttachmentFileWriter,
} from "./restore";
import { MemorySink, type BackupSink, BackupCancelledError } from "./sink";
import { blobChunks } from "./zip-stream";

import {
  bulkCreateRecords,
  clearAllRecords,
  countRecords,
  type CreateRecordData,
} from "@/lib/data/record-crud";
import { clearAttachments } from "@/lib/data/attachments-crud";
import { clearParticipants, clearTransactions } from "@/lib/data/transaction-crud";
import { clearAddressSyncState } from "@/lib/data/address-sync-crud";

const noopFiles: AttachmentFileIO = {
  async listAll() {
    return [];
  },
  async read() {
    return null;
  },
};

const noopWriter: AttachmentFileWriter = {
  async write() {
    /* no attachment files in this fixture */
  },
};

async function clearVault(): Promise<void> {
  await clearAllRecords({ skipNotification: true });
  await clearAttachments({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearAddressSyncState({ skipNotification: true });
}

async function seedRecords(n: number, prefix: string): Promise<void> {
  const rows: CreateRecordData[] = [];
  for (let i = 1; i <= n; i++) {
    const inputString = `${prefix}-${String(i).padStart(5, "0")}`;
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
  await bulkCreateRecords(rows, { skipNotification: true, skipVocabularySync: true });
}

// A valid unencrypted v3 backup containing N_BACKUP records, built once.
const N_BACKUP = 40;
let backupBlob: Blob;

beforeAll(async () => {
  await clearVault();
  await seedRecords(N_BACKUP, "backup");

  const sink = new MemorySink();
  await exportBackup({
    sink: sink as BackupSink,
    encrypted: false,
    batchSize: 10,
    attachmentIO: noopFiles,
  });
  backupBlob = sink.blob as Blob;
  expect(backupBlob).toBeInstanceOf(Blob);
});

describe("restore cancellation contract", () => {
  it("cancel before the clear leaves the existing vault intact", async () => {
    // Replace the vault with DIFFERENT existing data we expect to survive.
    await clearVault();
    await seedRecords(7, "existing");
    expect(await countRecords()).toBe(7);

    const controller = new AbortController();
    controller.abort(); // already aborted -> trips before the destructive clear

    let err: unknown;
    try {
      await restoreV3Backup({
        source: blobChunks(backupBlob),
        attachmentWriter: noopWriter,
        signal: controller.signal,
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(BackupCancelledError);
    expect((err as BackupCancelledError).clearedBeforeCancel).toBe(false);
    // Existing data untouched: same 7 records, none of the backup's records.
    expect(await countRecords()).toBe(7);
  });

  it("cancel after the clear resets the vault to a known-empty state", async () => {
    await clearVault();
    await seedRecords(7, "existing");
    expect(await countRecords()).toBe(7);

    // Abort the moment the clearing phase is reported (the point of no return).
    const controller = new AbortController();
    let err: unknown;
    try {
      await restoreV3Backup({
        source: blobChunks(backupBlob),
        attachmentWriter: noopWriter,
        signal: controller.signal,
        onProgress: (p) => {
          if (p.percent >= 8 && !controller.signal.aborted) controller.abort();
        },
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(BackupCancelledError);
    expect((err as BackupCancelledError).clearedBeforeCancel).toBe(true);
    // Vault is neither the old data nor a partial restore — it is empty.
    expect(await countRecords()).toBe(0);
  });

  it("cancel after the clear that fails cleanup fails closed (no clean-cancel claim)", async () => {
    // If the post-clear reset itself throws, the vault may be in an unknown
    // partial state. We must NOT report a clean cancel; instead a distinct hard
    // error is thrown so the UI never falsely claims a known-empty vault.
    await clearVault();
    await seedRecords(7, "existing");

    let clearInlineCalls = 0;
    const controller = new AbortController();
    let err: unknown;
    try {
      await restoreV3Backup({
        source: blobChunks(backupBlob),
        attachmentWriter: noopWriter,
        signal: controller.signal,
        // Succeed during the initial clear (call 1), fail during the post-cancel
        // cleanup clear (call 2) to simulate a cleanup failure.
        clearInline: async () => {
          clearInlineCalls += 1;
          if (clearInlineCalls >= 2) throw new Error("simulated cleanup failure");
        },
        // No-op inline restore so we get past the initial clear cleanly.
        restoreInline: async () => {},
        onProgress: (p) => {
          if (p.percent >= 8 && !controller.signal.aborted) controller.abort();
        },
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(RestoreInterruptedError);
    expect(err).not.toBeInstanceOf(BackupCancelledError);
    expect(clearInlineCalls).toBeGreaterThanOrEqual(2);
  });

  it("a normal restore (no signal) still replaces the vault", async () => {
    await clearVault();
    await seedRecords(7, "existing");

    const result = await restoreV3Backup({
      source: blobChunks(backupBlob),
      attachmentWriter: noopWriter,
    });

    expect(result.counts.records).toBe(N_BACKUP);
    expect(await countRecords()).toBe(N_BACKUP);
  });
});

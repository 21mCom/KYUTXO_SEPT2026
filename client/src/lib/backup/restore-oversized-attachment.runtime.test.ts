// One OVERSIZED attachment file must never fail an entire backup restore.
// Two ways a file can be over the cap are covered:
//   1. STREAMING cap: the ZIP entry itself exceeds the per-file byte cap
//      (e.g. a backup exported by the desktop app or an older build without
//      the cap). The entry is skipped in-stream — buffered bytes discarded —
//      and the rest of the archive restores normally.
//   2. WRITE-endpoint cap: the platform writer rejects the file with a typed
//      AttachmentTooLargeError (HTTP 413 from /api/attachments/write in web).
//      The restore skips that one file instead of aborting.
// In both cases the skipped file is counted and NAMED on the result so the UI
// can tell the user exactly which file was not restored, and a genuine
// (non-size) write failure still fails the restore as before.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";

import { db } from "@/lib/database";
import { exportBackup, type AttachmentFileIO } from "./export";
import {
  restoreV3Backup,
  AttachmentTooLargeError,
  AttachmentWriteError,
  RestoreInterruptedError,
  type AttachmentFileWriter,
} from "./restore";
import { MemorySink, type BackupSink } from "./sink";
import { blobChunks } from "./zip-stream";

import {
  bulkCreateRecords,
  clearAllRecords,
  countRecords,
  type CreateRecordData,
} from "@/lib/data/record-crud";
import {
  bulkAddAttachments,
  clearAttachments,
  getAllAttachments,
  type CreateAttachmentData,
} from "@/lib/data/attachments-crud";

const PASSWORD = "correct horse battery staple";
const CAP = 64; // tiny test cap so no real 100 MiB entries are needed

let sourceFiles: Map<string, Uint8Array>;
let restoredFiles: Map<string, Uint8Array>;

const attachmentIO: AttachmentFileIO = {
  async listAll() {
    return [...sourceFiles.keys()];
  },
  async read(relPath) {
    const v = sourceFiles.get(relPath);
    return v
      ? (v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer)
      : null;
  },
};

const collectingWriter: AttachmentFileWriter = {
  async write(relPath, data) {
    restoredFiles.set(relPath, new Uint8Array(data));
  },
};

async function clearEverything(): Promise<void> {
  await clearAllRecords({ skipNotification: true });
  await clearAttachments({ skipNotification: true });
}

// Seeds 3 records, each with an attachment row + file; file index 1 is
// oversized (> CAP), the other two are small.
async function seedVault(): Promise<string[]> {
  const recRows: CreateRecordData[] = [];
  for (let i = 1; i <= 3; i++) {
    const inputString = `addr-${String(i).padStart(5, "0")}`;
    recRows.push({
      type: "address",
      inputString,
      inputStringLower: inputString,
      label: `r${i}`,
      tags: [],
      categories: [],
      addressImportance: "manual",
    } as unknown as CreateRecordData);
  }
  const recordIds = await bulkCreateRecords(recRows, {
    skipNotification: true,
    skipVocabularySync: true,
  });

  const paths: string[] = [];
  const attRows: CreateAttachmentData[] = [];
  for (let i = 0; i < 3; i++) {
    const relPath = `ab/cd/file-${i}.bin`;
    paths.push(relPath);
    const size = i === 1 ? CAP * 4 : 8;
    sourceFiles.set(relPath, new Uint8Array(size).fill(i + 1));
    attRows.push({
      recordId: recordIds[i],
      filename: `doc-${i}.pdf`,
      mimeType: "application/pdf",
      size,
      objectStoragePath: relPath,
    } as unknown as CreateAttachmentData);
  }
  await bulkAddAttachments(attRows, { skipNotification: true });
  return paths;
}

async function exportPlain(): Promise<Blob> {
  const sink = new MemorySink();
  await exportBackup({
    sink: sink as BackupSink,
    encrypted: false,
    batchSize: 2,
    attachmentIO,
  });
  return sink.blob as Blob;
}

beforeEach(async () => {
  sourceFiles = new Map();
  restoredFiles = new Map();
  await clearEverything();
});

describe("oversized attachment files are skipped, never fail the restore", () => {
  it("an archive entry over the streaming cap is skipped with a named warning; the rest restores", async () => {
    const paths = await seedVault();
    const blob = await exportPlain();
    await clearEverything();

    const result = await restoreV3Backup({
      source: blobChunks(blob),
      attachmentWriter: collectingWriter,
      maxAttachmentFileBytes: CAP,
    });

    // Vault data restored intact.
    expect(result.counts.records).toBe(3);
    expect(await countRecords()).toBe(3);

    // The two small files restored; the oversized one skipped and NAMED.
    expect(result.counts.attachmentFiles).toBe(2);
    expect(result.counts.skippedOversizedAttachmentFiles).toBe(1);
    expect(result.skippedOversizedAttachments).toEqual([paths[1]]);
    expect(restoredFiles.has(paths[0])).toBe(true);
    expect(restoredFiles.has(paths[1])).toBe(false);
    expect(restoredFiles.has(paths[2])).toBe(true);

    // The dangling attachment ROW for the skipped file was removed too, so no
    // restored record points at bytes that don't exist on disk.
    expect(result.counts.droppedOversizedAttachmentRows).toBe(1);
    expect(result.counts.attachments).toBe(2);
    const rows = await getAllAttachments();
    expect(rows.map((r) => r.objectStoragePath).sort()).toEqual(
      [paths[0], paths[2]].sort(),
    );
  });

  it("a write endpoint rejecting one file as too large (413) skips that file only", async () => {
    const paths = await seedVault();
    const blob = await exportPlain();
    await clearEverything();

    // Writer mimics the web writer: a specific file gets the server's 413.
    const writer413: AttachmentFileWriter = {
      async write(relPath, data) {
        if (relPath === paths[1]) {
          throw new AttachmentTooLargeError(
            relPath,
            "Attachment exceeds the maximum size of 104857600 bytes",
          );
        }
        restoredFiles.set(relPath, new Uint8Array(data));
      },
    };

    const result = await restoreV3Backup({
      source: blobChunks(blob),
      attachmentWriter: writer413,
    });

    expect(result.counts.records).toBe(3);
    expect(result.counts.attachmentFiles).toBe(2);
    expect(result.counts.skippedOversizedAttachmentFiles).toBe(1);
    expect(result.skippedOversizedAttachments).toEqual([paths[1]]);
    expect(restoredFiles.has(paths[1])).toBe(false);
    expect(restoredFiles.has(paths[0])).toBe(true);
    expect(restoredFiles.has(paths[2])).toBe(true);

    // Row for the 413-rejected file dropped as well.
    expect(result.counts.droppedOversizedAttachmentRows).toBe(1);
    expect(result.counts.attachments).toBe(2);
    const rows = await getAllAttachments();
    expect(rows.some((r) => r.objectStoragePath === paths[1])).toBe(false);
    expect(rows).toHaveLength(2);
  });

  it("no skips: result reports zero skipped files and an empty list", async () => {
    await seedVault();
    // Remove the oversized file so everything fits under the default cap.
    const blob = await exportPlain();
    await clearEverything();

    const result = await restoreV3Backup({
      source: blobChunks(blob),
      attachmentWriter: collectingWriter,
    });

    expect(result.counts.skippedOversizedAttachmentFiles).toBe(0);
    expect(result.skippedOversizedAttachments).toEqual([]);
    expect(result.counts.attachmentFiles).toBe(3);
    expect(result.counts.droppedOversizedAttachmentRows).toBe(0);
    expect(result.counts.attachments).toBe(3);
  });

  it("a genuine (non-size) write failure still fails the restore as before", async () => {
    const paths = await seedVault();
    const blob = await exportPlain();
    await clearEverything();

    const failingWriter: AttachmentFileWriter = {
      async write(relPath) {
        if (relPath === paths[1]) throw new Error("ENOSPC: disk full");
      },
    };

    // Post-clear write failure surfaces as RestoreInterruptedError whose cause
    // is the tagged AttachmentWriteError (unchanged contract).
    await expect(
      restoreV3Backup({
        source: blobChunks(blob),
        attachmentWriter: failingWriter,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof RestoreInterruptedError)) return false;
      const cause = (err as { cause?: unknown }).cause;
      return cause instanceof AttachmentWriteError && cause.relPath === paths[1];
    });
  });
});

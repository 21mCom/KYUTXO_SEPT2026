// Proves the DESKTOP (Electron) branch of createRestoreAttachmentWriter skips
// an oversized attachment instead of failing the whole restore — against the
// REAL write-attachment IPC handler, not a writer double. The real
// electron/file-handlers.cjs registers on a FakeIpcMain (same pattern as
// electron/attachments-security.test.ts) with a tiny size cap; @/lib/electron
// is mocked so the writer takes its Electron branch and its writeAttachment
// calls invoke that real handler. The handler's genuine size-cap rejection
// (code: "ATTACHMENT_TOO_LARGE") must surface as the typed
// AttachmentTooLargeError, and a full restoreV3Backup through the writer must
// skip the oversized file, name it, and complete — with the small files really
// written to disk by the handler.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { createRestoreAttachmentWriter } from "./restore-attachment-writer";
import { restoreV3Backup, AttachmentTooLargeError } from "./restore";
import { exportBackup, type AttachmentFileIO } from "./export";
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
  type CreateAttachmentData,
} from "@/lib/data/attachments-crud";

const CAP = 64; // bytes — tiny real handler cap so no 100 MiB writes are needed

type Handler = (event: unknown, arg: unknown) => unknown;
class FakeIpcMain {
  private handlers = new Map<string, Handler>();
  handle(channel: string, fn: Handler) {
    this.handlers.set(channel, fn);
  }
  invoke(channel: string, arg?: unknown): Promise<any> {
    const fn = this.handlers.get(channel);
    if (!fn) throw new Error(`No handler registered for ${channel}`);
    return Promise.resolve(fn({}, arg));
  }
}

let baseDir: string;
let attachmentsDir: string;
let needsReviewDir: string;
let ipc: FakeIpcMain;

// The writer's Electron branch is driven by @/lib/electron; route it to the
// REAL IPC handler registered on the FakeIpcMain.
vi.mock("@/lib/electron", () => ({
  isElectron: () => true,
  getElectronAPI: () => ({
    writeAttachment: (relativePath: string, data: ArrayBuffer) =>
      ipc.invoke("write-attachment", { relativePath, data: new Uint8Array(data) }),
    listAllAttachments: () => ipc.invoke("list-all-attachments"),
    writeNeedsReview: (filename: string, data: ArrayBuffer) =>
      ipc.invoke("write-needs-review", { filename, data: new Uint8Array(data) }),
    deleteNeedsReview: (name: string) => ipc.invoke("delete-needs-review", name),
  }),
}));

beforeAll(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "kyutxo-restore-writer-electron-"));
  attachmentsDir = path.join(baseDir, "attachments");
  fs.mkdirSync(attachmentsDir, { recursive: true });
  needsReviewDir = path.join(baseDir, "needs-review");
  fs.mkdirSync(needsReviewDir, { recursive: true });

  const requireCjs = createRequire(import.meta.url);
  const { registerFileHandlers } = requireCjs("../../../../electron/file-handlers.cjs");
  ipc = new FakeIpcMain();
  registerFileHandlers(ipc, {
    dataDir: baseDir,
    attachmentsDir,
    needsReviewDir,
    portableMode: false,
    maxAttachmentBytes: CAP,
  });
});

afterAll(() => {
  fs.rmSync(baseDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await clearAllRecords({ skipNotification: true });
  await clearAttachments({ skipNotification: true });
  fs.rmSync(attachmentsDir, { recursive: true, force: true });
  fs.mkdirSync(attachmentsDir, { recursive: true });
  fs.rmSync(needsReviewDir, { recursive: true, force: true });
  fs.mkdirSync(needsReviewDir, { recursive: true });
});

describe("createRestoreAttachmentWriter against the real Electron write-attachment handler", () => {
  it("surfaces the handler's real size-cap rejection as a typed AttachmentTooLargeError", async () => {
    const writer = createRestoreAttachmentWriter();
    const oversized = new Uint8Array(CAP + 1).fill(7);

    await expect(
      writer.write("ab/cd/too-big.bin", oversized.buffer),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof AttachmentTooLargeError)) return false;
      // The message must be the handler's real error text, proving the coded
      // IPC result shape is what the writer maps.
      return (
        err.relPath === "ab/cd/too-big.bin" &&
        err.message.includes(`maximum size of ${CAP} bytes`)
      );
    });
    // The oversized write must leave nothing behind on disk.
    expect(fs.existsSync(path.join(attachmentsDir, "ab", "cd", "too-big.bin"))).toBe(false);
  });

  it("writes an under-cap file for real via the handler", async () => {
    const writer = createRestoreAttachmentWriter();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await writer.write("ab/cd/small.bin", bytes.buffer);
    const onDisk = fs.readFileSync(path.join(attachmentsDir, "ab", "cd", "small.bin"));
    expect(new Uint8Array(onDisk)).toEqual(bytes);
  });

  it("a non-size handler failure still throws a plain (restore-fatal) error", async () => {
    const writer = createRestoreAttachmentWriter();
    await expect(
      writer.write("../escape.bin", new Uint8Array([1]).buffer),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof Error && !(err instanceof AttachmentTooLargeError),
    );
  });

  it("a full desktop restore skips the oversized file and completes", async () => {
    // Seed 3 records with attachment rows; file index 1 exceeds the cap.
    const sourceFiles = new Map<string, Uint8Array>();
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
    const sink = new MemorySink();
    await exportBackup({
      sink: sink as BackupSink,
      encrypted: false,
      batchSize: 2,
      attachmentIO,
    });
    const blob = sink.blob as Blob;
    await clearAllRecords({ skipNotification: true });
    await clearAttachments({ skipNotification: true });

    const result = await restoreV3Backup({
      source: blobChunks(blob),
      attachmentWriter: createRestoreAttachmentWriter(),
    });

    // Vault data restored intact; oversized file skipped and NAMED.
    expect(result.counts.records).toBe(3);
    expect(await countRecords()).toBe(3);
    expect(result.counts.attachmentFiles).toBe(2);
    expect(result.counts.skippedOversizedAttachmentFiles).toBe(1);
    expect(result.skippedOversizedAttachments).toEqual([paths[1]]);

    // The two small files were REALLY written by the handler; the oversized
    // one never landed on disk.
    for (const i of [0, 2]) {
      const onDisk = fs.readFileSync(path.join(attachmentsDir, ...paths[i].split("/")));
      expect(new Uint8Array(onDisk)).toEqual(sourceFiles.get(paths[i]));
    }
    expect(fs.existsSync(path.join(attachmentsDir, ...paths[1].split("/")))).toBe(false);
  });

  it("writeReview surfaces the real write-needs-review size-cap rejection as a typed AttachmentTooLargeError", async () => {
    const writer = createRestoreAttachmentWriter();
    const oversized = new Uint8Array(CAP + 1).fill(9);

    await expect(
      writer.writeReview!("orphan-doc.pdf", oversized.buffer),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof AttachmentTooLargeError)) return false;
      return (
        err.relPath === "orphan-doc.pdf" &&
        err.message.includes(`maximum size of ${CAP} bytes`)
      );
    });
    // Nothing may land in the Needs Review folder.
    expect(fs.readdirSync(needsReviewDir)).toEqual([]);
  });

  it("an under-cap writeReview really lands in the Needs Review folder", async () => {
    const writer = createRestoreAttachmentWriter();
    const bytes = new Uint8Array([5, 6, 7]);
    const savedName = await writer.writeReview!("kept.bin", bytes.buffer);
    expect(savedName).toBe("kept.bin");
    const onDisk = fs.readFileSync(path.join(needsReviewDir, "kept.bin"));
    expect(new Uint8Array(onDisk)).toEqual(bytes);
  });

  it("a restore with an oversized ORPHANED file skips it, names it, and completes", async () => {
    // One real record with an under-cap attachment, plus TWO orphan rows
    // (recordId points at a record absent from the backup): one under-cap
    // (routes to Needs Review) and one oversized (must be skipped + named,
    // not counted as a generic loss, and must not abort the restore).
    const inputString = "addr-orphan-00001";
    const [recordId] = await bulkCreateRecords(
      [
        {
          type: "address",
          inputString,
          inputStringLower: inputString,
          label: "r-owner",
          tags: [],
          categories: [],
          addressImportance: "manual",
        } as unknown as CreateRecordData,
      ],
      { skipNotification: true, skipVocabularySync: true },
    );

    const ownedPath = "ab/cd/owned.bin";
    const orphanSmallPath = "ab/cd/orphan-small.bin";
    const orphanBigPath = "ab/cd/orphan-big.bin";
    const sourceFiles = new Map<string, Uint8Array>([
      [ownedPath, new Uint8Array(8).fill(1)],
      [orphanSmallPath, new Uint8Array(8).fill(2)],
      [orphanBigPath, new Uint8Array(CAP * 4).fill(3)],
    ]);

    await bulkAddAttachments(
      [
        {
          recordId,
          filename: "owned.pdf",
          mimeType: "application/pdf",
          size: 8,
          objectStoragePath: ownedPath,
        },
        {
          recordId: 999_999, // absent from the backup → orphan on restore
          filename: "orphan-small.pdf",
          mimeType: "application/pdf",
          size: 8,
          objectStoragePath: orphanSmallPath,
        },
        {
          recordId: 999_999,
          filename: "orphan-big.pdf",
          mimeType: "application/pdf",
          size: CAP * 4,
          objectStoragePath: orphanBigPath,
        },
      ] as unknown as CreateAttachmentData[],
      { skipNotification: true },
    );

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
    const sink = new MemorySink();
    await exportBackup({
      sink: sink as BackupSink,
      encrypted: false,
      batchSize: 2,
      attachmentIO,
    });
    const blob = sink.blob as Blob;
    await clearAllRecords({ skipNotification: true });
    await clearAttachments({ skipNotification: true });

    const result = await restoreV3Backup({
      source: blobChunks(blob),
      attachmentWriter: createRestoreAttachmentWriter(),
    });

    // Restore completed with the record intact.
    expect(result.counts.records).toBe(1);
    expect(await countRecords()).toBe(1);
    expect(result.counts.attachmentFiles).toBe(1);

    // Both orphans were encountered; the oversized one is an oversized SKIP
    // (named), not a generic best-effort loss.
    expect(result.counts.orphanedAttachmentFiles).toBe(2);
    expect(result.counts.orphanedAttachmentFilesLost).toBe(0);
    expect(result.counts.skippedOversizedAttachmentFiles).toBe(1);
    expect(result.skippedOversizedAttachments).toEqual([orphanBigPath]);

    // The under-cap orphan really landed in Needs Review under its original
    // filename; the oversized one landed nowhere.
    expect(fs.readdirSync(needsReviewDir)).toEqual(["orphan-small.pdf"]);
    expect(fs.existsSync(path.join(attachmentsDir, ...orphanBigPath.split("/")))).toBe(false);

    // The owned file was really written by the handler.
    const onDisk = fs.readFileSync(path.join(attachmentsDir, ...ownedPath.split("/")));
    expect(new Uint8Array(onDisk)).toEqual(sourceFiles.get(ownedPath));
  });
});

// Proves the oversized-attachment skip works against the REAL
// /api/attachments/write endpoint — not a writer double. The real Express
// router (multer diskStorage + limits.fileSize via KYUTXO_MAX_ATTACHMENT_BYTES
// override) runs on an ephemeral HTTP server; createRestoreAttachmentWriter's
// web branch posts real multipart bodies to it. The server's genuine 413
// response shape must surface as the typed AttachmentTooLargeError, and a full
// restoreV3Backup through that writer must skip the oversized file, name it,
// and complete — with the small files really written to disk by the server.
//
// server/attachments.ts reads KYUTXO_DATA_DIR / KYUTXO_MAX_ATTACHMENT_BYTES at
// import time, so both are set BEFORE a dynamic import in beforeAll (a static
// import would hoist above the env assignment).

import "fake-indexeddb/auto";

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { Express } from "express";
import type { Server } from "node:http";

import { createRestoreAttachmentWriter } from "./restore-attachment-writer";
import {
  restoreV3Backup,
  AttachmentTooLargeError,
} from "./restore";
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

const CAP = 64; // bytes — tiny real multer cap so no 100 MiB uploads are needed

let server: Server;
let baseUrl: string;
let dataDir: string;
let attachmentsDir: string;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kyutxo-restore-writer-e2e-"));
  attachmentsDir = path.join(dataDir, "attachments");
  process.env.KYUTXO_DATA_DIR = dataDir;
  process.env.KYUTXO_MAX_ATTACHMENT_BYTES = String(CAP);

  const { default: express } = await import("express");
  const { default: attachmentsRouter } = await import("../../../../server/attachments");
  const app: Express = express();
  app.use(express.json());
  app.use("/api/attachments", attachmentsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  // The writer's web branch fetches app-relative URLs ("/api/attachments/...");
  // resolve those against the ephemeral server so the REAL route handles them.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === "string" && input.startsWith("/")) {
      return realFetch(`${baseUrl}${input}`, init);
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  delete process.env.KYUTXO_DATA_DIR;
  delete process.env.KYUTXO_MAX_ATTACHMENT_BYTES;
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await clearAllRecords({ skipNotification: true });
  await clearAttachments({ skipNotification: true });
  fs.rmSync(attachmentsDir, { recursive: true, force: true });
});

describe("createRestoreAttachmentWriter against the real /write endpoint", () => {
  it("surfaces the server's real 413 as a typed AttachmentTooLargeError", async () => {
    const writer = createRestoreAttachmentWriter();
    const oversized = new Uint8Array(CAP + 1).fill(7);

    await expect(
      writer.write("ab/cd/too-big.bin", oversized.buffer),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof AttachmentTooLargeError)) return false;
      // The message must be the server's real response body message, proving
      // the JSON 413 shape (error field) is what the writer parses.
      return (
        err.relPath === "ab/cd/too-big.bin" &&
        err.message.includes(`maximum size of ${CAP} bytes`)
      );
    });
    // The oversized upload must leave nothing behind on disk.
    expect(fs.existsSync(path.join(attachmentsDir, "ab", "cd", "too-big.bin"))).toBe(false);
  });

  it("writes an under-cap file for real via the endpoint", async () => {
    const writer = createRestoreAttachmentWriter();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await writer.write("ab/cd/small.bin", bytes.buffer);
    const onDisk = fs.readFileSync(path.join(attachmentsDir, "ab", "cd", "small.bin"));
    expect(new Uint8Array(onDisk)).toEqual(bytes);
  });

  it("a full restore through the real endpoint skips the oversized file and completes", async () => {
    // Seed 3 records with attachment rows; file index 1 exceeds the multer cap.
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

    // The two small files were REALLY written by the server; the oversized
    // one never landed on disk.
    for (const i of [0, 2]) {
      const onDisk = fs.readFileSync(path.join(attachmentsDir, ...paths[i].split("/")));
      expect(new Uint8Array(onDisk)).toEqual(sourceFiles.get(paths[i]));
    }
    expect(fs.existsSync(path.join(attachmentsDir, ...paths[1].split("/")))).toBe(false);

    // The rejected upload's temp file was cleaned from the staging dir.
    const tmpDir = path.join(dataDir, "attachments-tmp");
    if (fs.existsSync(tmpDir)) {
      expect(fs.readdirSync(tmpDir)).toEqual([]);
    }
  });
});

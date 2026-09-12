// @vitest-environment jsdom
//
// T005: attachment audit (read-only reconciliation) and root-file recovery in
// migrateAttachmentPaths. Uses fake-indexeddb for the DB and an in-memory
// Electron file layer so the copy-then-verify-no-delete behaviour can be
// asserted without a real filesystem.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type { Record as DbRecord, Attachment, EvidenceAttachment } from "@/lib/db-types";

// ---- In-memory Electron file layer ----------------------------------------

const fileStore = new Map<string, ArrayBuffer>();

function stripPrefix(p: string): string {
  const fwd = p.replace(/\\/g, "/");
  return fwd.startsWith("attachments/") ? fwd.slice("attachments/".length) : fwd;
}

const fakeApi = {
  readAttachment: async (relPath: string) => {
    const key = stripPrefix(relPath);
    if (!fileStore.has(key)) return { success: false, error: "not found" };
    return { success: true, data: fileStore.get(key)! };
  },
  writeAttachment: async (relPath: string, data: ArrayBuffer) => {
    fileStore.set(stripPrefix(relPath), data);
    return { success: true };
  },
  renameAttachment: async (oldPath: string, newPath: string) => {
    const oldKey = stripPrefix(oldPath);
    const newKey = stripPrefix(newPath);
    if (!fileStore.has(oldKey)) return { success: false, error: "not found" };
    fileStore.set(newKey, fileStore.get(oldKey)!);
    fileStore.delete(oldKey);
    return { success: true };
  },
  listAllAttachments: async () => {
    return { success: true, files: Array.from(fileStore.keys()) };
  },
};

vi.mock("@/lib/electron", () => ({
  isElectron: () => true,
  getElectronAPI: () => fakeApi,
  getElectronAPISafe: () => null,
}));

// ---- In-memory DB ----------------------------------------------------------

class TestDb extends Dexie {
  records!: Table<DbRecord, number>;
  attachments!: Table<Attachment, number>;
  evidenceAttachments!: Table<EvidenceAttachment, number>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      records: "++id, type, inputString, inputStringLower",
      attachments: "++id, recordId, createdAt",
      evidenceAttachments: "++id, evidenceId, createdAt",
    });
  }
}

let testDb: TestDb;

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return {
    ...actual,
    get db() {
      return testDb;
    },
  };
});

const { auditAttachments, migrateAttachmentPaths } = await import("./attachments");

function bytes(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer;
}

const isHashedDir = (d: string) => /^[0-9a-f]{64}$/.test(d);
const isOpaque = (f: string) => /^[0-9a-f]{32}(\.[a-z0-9]+)?$/.test(f);

beforeEach(async () => {
  fileStore.clear();
  if (!testDb) {
    testDb = new TestDb(`KYUTXO-audit-${Date.now()}-${Math.random()}`);
  } else {
    await Promise.all(testDb.tables.map((table) => table.clear()));
  }
});

afterEach(async () => {
  fileStore.clear();
});

afterAll(async () => {
  testDb.close();
  await Dexie.delete(testDb.name);
});

describe("auditAttachments (read-only)", () => {
  it("classifies matched, missing-file and orphaned-file correctly", async () => {
    // matched: DB row + file on disk
    fileStore.set("abc/def.bin", bytes("ok"));
    await testDb.attachments.add({
      recordId: 1,
      filename: "a",
      mimeType: "x",
      size: 2,
      objectStoragePath: "abc/def.bin",
      createdAt: 1,
    } as Attachment);

    // matched via prefixed DB path resolving to same on-disk relative file
    fileStore.set("ghi/jkl.bin", bytes("ok2"));
    await testDb.evidenceAttachments.add({
      evidenceId: 1,
      filename: "b",
      mimeType: "x",
      size: 3,
      objectStoragePath: "attachments/ghi/jkl.bin",
      createdAt: 1,
    } as EvidenceAttachment);

    // missing-file: DB row, no file
    await testDb.attachments.add({
      recordId: 2,
      filename: "c",
      mimeType: "x",
      size: 1,
      objectStoragePath: "missing/file.bin",
      createdAt: 1,
    } as Attachment);

    // orphaned-file: file on disk, no DB row
    fileStore.set("orphan.pdf", bytes("orphan"));

    const result = await auditAttachments();

    expect(result.totalDbRows).toBe(3);
    expect(result.totalDiskFiles).toBe(3);
    expect(result.matched).toBe(2);
    expect(result.missingFiles).toHaveLength(1);
    expect(result.missingFiles[0].objectStoragePath).toBe("missing/file.bin");
    expect(result.orphanedFiles).toEqual(["orphan.pdf"]);
  });

  it("does not modify the filesystem or DB", async () => {
    fileStore.set("root.bin", bytes("data"));
    await testDb.attachments.add({
      recordId: 1,
      filename: "a",
      mimeType: "x",
      size: 4,
      objectStoragePath: "root.bin",
      createdAt: 1,
    } as Attachment);

    const before = Array.from(fileStore.keys()).sort();
    const rowsBefore = await testDb.attachments.toArray();
    await auditAttachments();
    expect(Array.from(fileStore.keys()).sort()).toEqual(before);
    expect(await testDb.attachments.toArray()).toEqual(rowsBefore);
  });
});

describe("migrateAttachmentPaths root-file recovery", () => {
  it("recovers a single-segment record attachment via copy-verify, keeping the original", async () => {
    const recordId = await testDb.records.add({
      type: "address",
      inputString: "bc1qexampleaddress",
      inputStringLower: "bc1qexampleaddress",
    } as DbRecord);

    fileStore.set("legacy.pdf", bytes("PDF-CONTENT"));
    const attId = await testDb.attachments.add({
      recordId: recordId as number,
      filename: "legacy.pdf",
      mimeType: "application/pdf",
      size: 11,
      objectStoragePath: "legacy.pdf",
      createdAt: 1,
    } as Attachment);

    const result = await migrateAttachmentPaths();
    expect(result.migrated).toBe(1);
    expect(result.failed).toBe(0);

    const row = await testDb.attachments.get(attId as number);
    const [dir, file] = row!.objectStoragePath.split("/");
    expect(isHashedDir(dir)).toBe(true);
    expect(isOpaque(file)).toBe(true);

    // Original root file is NOT deleted.
    expect(fileStore.has("legacy.pdf")).toBe(true);
    // New file exists with identical bytes.
    expect(fileStore.has(row!.objectStoragePath)).toBe(true);
    expect(new TextDecoder().decode(fileStore.get(row!.objectStoragePath)!)).toBe(
      "PDF-CONTENT",
    );
  });

  it("is idempotent — re-running migrates nothing further", async () => {
    const recordId = await testDb.records.add({
      type: "address",
      inputString: "addr",
      inputStringLower: "addr",
    } as DbRecord);
    fileStore.set("doc.txt", bytes("hello"));
    await testDb.attachments.add({
      recordId: recordId as number,
      filename: "doc.txt",
      mimeType: "text/plain",
      size: 5,
      objectStoragePath: "doc.txt",
      createdAt: 1,
    } as Attachment);

    const first = await migrateAttachmentPaths();
    expect(first.migrated).toBe(1);

    const second = await migrateAttachmentPaths();
    expect(second.migrated).toBe(0);
    expect(second.failed).toBe(0);
  });

  it("recovers an evidence root file with a freshly-minted hashed dir", async () => {
    fileStore.set("evidence-root.jpg", bytes("IMG"));
    const evId = await testDb.evidenceAttachments.add({
      evidenceId: 1,
      filename: "evidence-root.jpg",
      mimeType: "image/jpeg",
      size: 3,
      objectStoragePath: "evidence-root.jpg",
      createdAt: 1,
    } as EvidenceAttachment);

    const result = await migrateAttachmentPaths();
    expect(result.migrated).toBe(1);

    const row = await testDb.evidenceAttachments.get(evId as number);
    const [dir, file] = row!.objectStoragePath.split("/");
    expect(isHashedDir(dir)).toBe(true);
    expect(isOpaque(file)).toBe(true);
    expect(fileStore.has("evidence-root.jpg")).toBe(true);
    expect(new TextDecoder().decode(fileStore.get(row!.objectStoragePath)!)).toBe("IMG");
  });

  it("counts a failed copy without deleting the original", async () => {
    const recordId = await testDb.records.add({
      type: "address",
      inputString: "addr2",
      inputStringLower: "addr2",
    } as DbRecord);
    // DB row points at a root path with NO file on disk -> read fails.
    await testDb.attachments.add({
      recordId: recordId as number,
      filename: "ghost.bin",
      mimeType: "x",
      size: 1,
      objectStoragePath: "ghost.bin",
      createdAt: 1,
    } as Attachment);

    const result = await migrateAttachmentPaths();
    expect(result.migrated).toBe(0);
    expect(result.failed).toBe(1);
  });
});

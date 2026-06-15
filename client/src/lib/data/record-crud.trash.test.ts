// @vitest-environment jsdom
//
// #247: deleting a record (or an attachment) must NOT destroy its file. Instead
// the attachment metadata is archived into the recoverable `trashedAttachments`
// table while the file is left on disk, so it can be downloaded back or purged
// explicitly from Settings. Uses fake-indexeddb + an in-memory Electron file
// layer (mirroring attachments.audit.test.ts) so we can assert that no physical
// delete happens on record deletion.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type {
  Record as DbRecord,
  Attachment,
  EvidenceAttachment,
  TrashedAttachment,
} from "@/lib/db-types";

// ---- In-memory Electron file layer ----------------------------------------

const fileStore = new Map<string, ArrayBuffer>();
const deleteSpy = vi.fn();

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
  deleteAttachment: async (relPath: string) => {
    deleteSpy(relPath);
    fileStore.delete(stripPrefix(relPath));
    return { success: true };
  },
  listAllAttachments: async () => {
    return { success: true, files: Array.from(fileStore.keys()) };
  },
};

vi.mock("@/lib/electron", () => ({
  isElectron: () => true,
  getElectronAPI: () => fakeApi,
}));

// ---- In-memory DB ----------------------------------------------------------

class TestDb extends Dexie {
  records!: Table<DbRecord, number>;
  attachments!: Table<Attachment, number>;
  evidenceAttachments!: Table<EvidenceAttachment, number>;
  trashedAttachments!: Table<TrashedAttachment, number>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      records: "++id, type, inputString, inputStringLower",
      attachments: "++id, recordId, createdAt",
      evidenceAttachments: "++id, evidenceId, createdAt",
      trashedAttachments: "++id, recordId, objectStoragePath, deletedAt",
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

const { deleteRecord } = await import("./record-crud");
const { getTrashedAttachments, deleteTrashedAttachment } = await import("./trash-crud");
const { auditAttachments, deleteFile, trashAttachment } = await import("@/lib/attachments");

function bytes(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer;
}

beforeEach(() => {
  fileStore.clear();
  deleteSpy.mockClear();
  testDb = new TestDb(`KYUTXO-trash-${Date.now()}-${Math.random()}`);
  // The old deleteRecord hit a /api/attachments DELETE route; assert it never runs.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("fetch should not be called during deleteRecord");
    }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  testDb.close();
  await Dexie.delete(testDb.name);
});

describe("deleteRecord protects attachment files", () => {
  it("archives attachment metadata and leaves the file on disk (no physical delete)", async () => {
    const recordId = (await testDb.records.add({
      type: "address",
      inputString: "bc1qabc",
      inputStringLower: "bc1qabc",
    } as DbRecord)) as number;

    fileStore.set("hash/op.pdf", bytes("PDF-CONTENT"));
    await testDb.attachments.add({
      recordId,
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      size: 11,
      objectStoragePath: "hash/op.pdf",
      createdAt: 1,
    } as Attachment);

    await deleteRecord(recordId);

    // The file bytes stay on disk and nothing physical was deleted.
    expect(fileStore.has("hash/op.pdf")).toBe(true);
    expect(deleteSpy).not.toHaveBeenCalled();

    // The attachment row and the record are gone.
    expect(await testDb.attachments.where("recordId").equals(recordId).count()).toBe(0);
    expect(await testDb.records.get(recordId)).toBeUndefined();

    // The recoverable trash row preserves filename + mimeType + path verbatim.
    const trash = await getTrashedAttachments();
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatchObject({
      recordId,
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      objectStoragePath: "hash/op.pdf",
      source: "record-delete",
    });
  });

  it("audit reports the archived file as recoverable, then gone after an explicit purge", async () => {
    const recordId = (await testDb.records.add({
      type: "address",
      inputString: "x",
      inputStringLower: "x",
    } as DbRecord)) as number;

    fileStore.set("h/a.jpg", bytes("IMG"));
    await testDb.attachments.add({
      recordId,
      filename: "photo.jpg",
      mimeType: "image/jpeg",
      size: 3,
      objectStoragePath: "h/a.jpg",
      createdAt: 1,
    } as Attachment);

    await deleteRecord(recordId);

    // The audit (read-only) sees the kept file as an unreferenced/recoverable file.
    let audit = await auditAttachments();
    expect(audit.orphanedFiles).toContain("h/a.jpg");

    // Explicit purge: physically delete the file, then drop the trash row.
    const [item] = await getTrashedAttachments();
    await deleteFile(item.objectStoragePath);
    await deleteTrashedAttachment(item.id!);

    expect(deleteSpy).toHaveBeenCalledWith("h/a.jpg");
    expect(fileStore.has("h/a.jpg")).toBe(false);
    expect(await getTrashedAttachments()).toHaveLength(0);

    audit = await auditAttachments();
    expect(audit.orphanedFiles).not.toContain("h/a.jpg");
  });

  it("deleting a record with no attachments archives nothing", async () => {
    const recordId = (await testDb.records.add({
      type: "address",
      inputString: "empty",
      inputStringLower: "empty",
    } as DbRecord)) as number;

    await deleteRecord(recordId);

    expect(await testDb.records.get(recordId)).toBeUndefined();
    expect(await getTrashedAttachments()).toHaveLength(0);
    expect(deleteSpy).not.toHaveBeenCalled();
  });
});

describe("trashAttachment protects the file too", () => {
  it("archives metadata and keeps the file (no physical delete)", async () => {
    const recordId = (await testDb.records.add({
      type: "address",
      inputString: "y",
      inputStringLower: "y",
    } as DbRecord)) as number;

    fileStore.set("k/b.png", bytes("PNG"));
    const attId = (await testDb.attachments.add({
      recordId,
      filename: "receipt.png",
      mimeType: "image/png",
      size: 3,
      objectStoragePath: "k/b.png",
      createdAt: 1,
    } as Attachment)) as number;

    await trashAttachment(attId);

    expect(fileStore.has("k/b.png")).toBe(true);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(await testDb.attachments.get(attId)).toBeUndefined();

    const trash = await getTrashedAttachments();
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatchObject({
      filename: "receipt.png",
      objectStoragePath: "k/b.png",
      source: "attachment-delete",
    });
  });
});

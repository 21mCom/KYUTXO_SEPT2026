// @vitest-environment jsdom
//
// Task #2130: Dashboard.tsx's handleBulkDelete used to call deleteRecord()
// once per selected record (one IndexedDB round-trip per record). This tests
// the batched replacement, bulkDeleteRecordsWithArchiving(), which must
// preserve deleteRecord's attachment-archiving cascade (Task #247: deleting a
// record must archive its attachments' metadata, not destroy the files) while
// writing in bulk. Mirrors the fixture/mocking approach in
// record-crud.trash.test.ts.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type {
  Record as DbRecord,
  Attachment,
  EvidenceAttachment,
  TrashedAttachment,
} from "@/lib/db-types";

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
  getElectronAPISafe: () => undefined,
}));

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
      recordOrigins: "++id, recordId, originType, createdAt, isEncrypted",
      evidenceAttachments: "++id, evidenceId, createdAt",
      trashedAttachments: "++id, recordId, objectStoragePath, deletedAt",
    });
  }
}

let testDb: TestDb;
let dbChangeEvents: Array<{ tables: string[] }> = [];

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return {
    ...actual,
    get db() {
      return testDb;
    },
    notifyDbChange: (tables: string | string[], meta?: unknown) => {
      dbChangeEvents.push({ tables: Array.isArray(tables) ? tables : [tables] });
      return (actual as any).notifyDbChange?.(tables, meta);
    },
  };
});

const { deleteRecord, bulkDeleteRecordsWithArchiving } = await import("./record-crud");
const { getTrashedAttachments } = await import("./trash-crud");

function bytes(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer;
}

beforeEach(() => {
  fileStore.clear();
  deleteSpy.mockClear();
  dbChangeEvents = [];
  testDb = new TestDb(`KYUTXO-bulk-delete-${Date.now()}-${Math.random()}`);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("fetch should not be called during bulkDeleteRecordsWithArchiving");
    }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  testDb.close();
  await Dexie.delete(testDb.name);
});

describe("bulkDeleteRecordsWithArchiving", () => {
  it("archives every selected record's attachments, leaves files on disk, and removes all rows in bulk", async () => {
    const recordIds: number[] = [];
    for (let i = 0; i < 5; i++) {
      const id = (await testDb.records.add({
        type: "address",
        inputString: `bc1qbulk${i}`,
        inputStringLower: `bc1qbulk${i}`,
      } as DbRecord)) as number;
      recordIds.push(id);
    }

    // Give three of the five records an attachment each; two have none.
    for (const i of [0, 2, 4]) {
      fileStore.set(`hash/${i}.pdf`, bytes(`PDF-${i}`));
      await testDb.attachments.add({
        recordId: recordIds[i],
        filename: `invoice-${i}.pdf`,
        mimeType: "application/pdf",
        size: 5,
        objectStoragePath: `hash/${i}.pdf`,
        createdAt: 1,
      } as Attachment);
    }

    await bulkDeleteRecordsWithArchiving(recordIds);

    // No file bytes were ever touched — only metadata is archived.
    for (const i of [0, 2, 4]) {
      expect(fileStore.has(`hash/${i}.pdf`)).toBe(true);
    }
    expect(deleteSpy).not.toHaveBeenCalled();

    // Every record and every attachment row is gone.
    expect(await testDb.records.count()).toBe(0);
    expect(await testDb.attachments.count()).toBe(0);

    // Exactly the three attachments archived, one per originating record.
    const trash = await getTrashedAttachments();
    expect(trash).toHaveLength(3);
    const trashedRecordIds = trash.map((t) => t.recordId).sort((a, b) => a - b);
    expect(trashedRecordIds).toEqual([recordIds[0], recordIds[2], recordIds[4]].sort((a, b) => a - b));
    for (const t of trash) {
      expect(t.source).toBe("record-delete");
    }

    // Exactly one notifyDbChange('records') + one notifyDbChange('trashedAttachments')
    // fired for the whole batch, not once per record.
    const recordsNotifications = dbChangeEvents.filter((e) => e.tables.includes("records"));
    const trashNotifications = dbChangeEvents.filter((e) => e.tables.includes("trashedAttachments"));
    expect(recordsNotifications).toHaveLength(1);
    expect(trashNotifications).toHaveLength(1);
  });

  it("deleting a batch with no attachments archives nothing and skips the trash notification", async () => {
    const recordIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const id = (await testDb.records.add({
        type: "address",
        inputString: `bc1qempty${i}`,
        inputStringLower: `bc1qempty${i}`,
      } as DbRecord)) as number;
      recordIds.push(id);
    }

    await bulkDeleteRecordsWithArchiving(recordIds);

    expect(await testDb.records.count()).toBe(0);
    expect(await getTrashedAttachments()).toHaveLength(0);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(dbChangeEvents.some((e) => e.tables.includes("trashedAttachments"))).toBe(false);
  });

  it("is a no-op for an empty id list", async () => {
    await bulkDeleteRecordsWithArchiving([]);
    expect(dbChangeEvents).toHaveLength(0);
  });

  it("produces the same end state as calling deleteRecord() once per record", async () => {
    // Batch A: deleted via the new batched helper.
    const batchAIds: number[] = [];
    for (let i = 0; i < 4; i++) {
      const id = (await testDb.records.add({
        type: "address",
        inputString: `bc1qa${i}`,
        inputStringLower: `bc1qa${i}`,
      } as DbRecord)) as number;
      batchAIds.push(id);
      fileStore.set(`a/${i}.jpg`, bytes(`A${i}`));
      await testDb.attachments.add({
        recordId: id,
        filename: `photo-a-${i}.jpg`,
        mimeType: "image/jpeg",
        size: 2,
        objectStoragePath: `a/${i}.jpg`,
        createdAt: 1,
      } as Attachment);
    }
    await bulkDeleteRecordsWithArchiving(batchAIds);

    // Batch B: deleted via the original per-record deleteRecord() loop.
    const batchBIds: number[] = [];
    for (let i = 0; i < 4; i++) {
      const id = (await testDb.records.add({
        type: "address",
        inputString: `bc1qb${i}`,
        inputStringLower: `bc1qb${i}`,
      } as DbRecord)) as number;
      batchBIds.push(id);
      fileStore.set(`b/${i}.jpg`, bytes(`B${i}`));
      await testDb.attachments.add({
        recordId: id,
        filename: `photo-b-${i}.jpg`,
        mimeType: "image/jpeg",
        size: 2,
        objectStoragePath: `b/${i}.jpg`,
        createdAt: 1,
      } as Attachment);
    }
    for (const id of batchBIds) {
      await deleteRecord(id);
    }

    expect(await testDb.records.count()).toBe(0);
    expect(await testDb.attachments.count()).toBe(0);
    const trash = await getTrashedAttachments();
    expect(trash).toHaveLength(8);
    // Every original file is still on disk under both paths.
    for (let i = 0; i < 4; i++) {
      expect(fileStore.has(`a/${i}.jpg`)).toBe(true);
      expect(fileStore.has(`b/${i}.jpg`)).toBe(true);
    }
  });
});

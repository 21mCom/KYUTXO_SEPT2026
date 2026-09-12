// @vitest-environment jsdom
//
// T005: reconcileAttachmentPaths (relink-only repair) and migration
// convergence. A privacy migration moved attachment files into the
// hashed/opaque scheme but a DB row's stored path drifted out of sync, so the
// literal path no longer resolves. The repair re-links the row to the real
// file WITHOUT ever moving, copying, or deleting bytes; ambiguous cases are
// reported, never guessed. Uses fake-indexeddb for the DB and an in-memory
// Electron file layer (mirrors attachments.audit.test.ts).

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  getElectronAPISafe: () => ({ ...fakeApi, isElectron: true }),
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

const { reconcileAttachmentPaths, migrateAttachmentPaths } = await import("./attachments");

function bytes(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer;
}

// 64-hex dir + 32-hex (+ext) filename = the migrated hashed/opaque scheme.
const HASHDIR = "a".repeat(64);
const OPAQUE_REAL = "c".repeat(32);
const OPAQUE_STALE = "b".repeat(32);
const OPAQUE_ALT = "d".repeat(32);

beforeEach(() => {
  fileStore.clear();
  testDb = new TestDb(`KYUTXO-reconcile-${Date.now()}-${Math.random()}`);
});

afterEach(async () => {
  testDb.close();
  await Dexie.delete(testDb.name);
});

describe("reconcileAttachmentPaths (relink-only repair)", () => {
  it("re-links a drifted row to the existing hashed/opaque file in its dir", async () => {
    // Real file lives under the hashed dir with an opaque name; the DB row
    // still points at a different (now-missing) opaque name in the same dir.
    fileStore.set(`${HASHDIR}/${OPAQUE_REAL}.jpg`, bytes("REAL-IMAGE"));
    const attId = (await testDb.attachments.add({
      recordId: 1,
      filename: "photo.jpg",
      mimeType: "image/jpeg",
      size: 10,
      objectStoragePath: `${HASHDIR}/${OPAQUE_STALE}.jpg`,
      createdAt: 1,
    } as Attachment)) as number;

    const filesBefore = Array.from(fileStore.keys()).sort();

    const result = await reconcileAttachmentPaths();
    expect(result.repaired).toBe(1);
    expect(result.unresolved).toBe(0);

    const row = await testDb.attachments.get(attId);
    expect(row!.objectStoragePath).toBe(`${HASHDIR}/${OPAQUE_REAL}.jpg`);

    // Relink-only: not a single file was moved, written, or deleted.
    expect(Array.from(fileStore.keys()).sort()).toEqual(filesBefore);
  });

  it("re-links a drifted evidence row too, preserving the attachments/ prefix", async () => {
    fileStore.set(`${HASHDIR}/${OPAQUE_REAL}.pdf`, bytes("EVIDENCE"));
    const evId = (await testDb.evidenceAttachments.add({
      evidenceId: 1,
      filename: "proof.pdf",
      mimeType: "application/pdf",
      size: 8,
      objectStoragePath: `attachments/${HASHDIR}/${OPAQUE_STALE}.pdf`,
      createdAt: 1,
    } as EvidenceAttachment)) as number;

    const result = await reconcileAttachmentPaths();
    expect(result.repaired).toBe(1);
    expect(result.unresolved).toBe(0);

    const row = await testDb.evidenceAttachments.get(evId);
    // The web-style `attachments/` prefix is re-applied to the resolved target.
    expect(row!.objectStoragePath).toBe(`attachments/${HASHDIR}/${OPAQUE_REAL}.pdf`);
  });

  it("reports an ambiguous row as unresolved instead of guessing", async () => {
    // Two orphan files share the dir and extension and BOTH match the row's
    // size, so the tie cannot be broken — the row must be left untouched.
    fileStore.set(`${HASHDIR}/${OPAQUE_REAL}.jpg`, bytes("XX"));
    fileStore.set(`${HASHDIR}/${OPAQUE_ALT}.jpg`, bytes("YY"));
    const stalePath = `${HASHDIR}/${OPAQUE_STALE}.jpg`;
    const attId = (await testDb.attachments.add({
      recordId: 1,
      filename: "x.jpg",
      mimeType: "image/jpeg",
      size: 2,
      objectStoragePath: stalePath,
      createdAt: 1,
    } as Attachment)) as number;

    const filesBefore = Array.from(fileStore.keys()).sort();

    const result = await reconcileAttachmentPaths();
    expect(result.repaired).toBe(0);
    expect(result.unresolved).toBe(1);

    // Row pointer is unchanged and nothing on disk was touched.
    const row = await testDb.attachments.get(attId);
    expect(row!.objectStoragePath).toBe(stalePath);
    expect(Array.from(fileStore.keys()).sort()).toEqual(filesBefore);
  });

  it("leaves rows that already resolve completely untouched", async () => {
    const goodPath = `${HASHDIR}/${OPAQUE_REAL}.png`;
    fileStore.set(goodPath, bytes("OK"));
    const attId = (await testDb.attachments.add({
      recordId: 1,
      filename: "ok.png",
      mimeType: "image/png",
      size: 2,
      objectStoragePath: goodPath,
      createdAt: 1,
    } as Attachment)) as number;

    const result = await reconcileAttachmentPaths();
    expect(result.repaired).toBe(0);
    expect(result.unresolved).toBe(0);

    const row = await testDb.attachments.get(attId);
    expect(row!.objectStoragePath).toBe(goodPath);
  });

  it("does not claim the same file for two drifted rows (no double-link)", async () => {
    // Only one real file, but two drifted rows want it. The first claims it;
    // the second has no remaining candidate and is reported unresolved.
    fileStore.set(`${HASHDIR}/${OPAQUE_REAL}.jpg`, bytes("ONLY-ONE"));
    const a1 = (await testDb.attachments.add({
      recordId: 1,
      filename: "one.jpg",
      mimeType: "image/jpeg",
      size: 8,
      objectStoragePath: `${HASHDIR}/${OPAQUE_STALE}.jpg`,
      createdAt: 1,
    } as Attachment)) as number;
    const a2 = (await testDb.attachments.add({
      recordId: 1,
      filename: "two.jpg",
      mimeType: "image/jpeg",
      size: 8,
      objectStoragePath: `${HASHDIR}/${OPAQUE_ALT}.jpg`,
      createdAt: 1,
    } as Attachment)) as number;

    const result = await reconcileAttachmentPaths();
    expect(result.repaired).toBe(1);
    expect(result.unresolved).toBe(1);

    const rows = [await testDb.attachments.get(a1), await testDb.attachments.get(a2)];
    const linked = rows.filter(r => r!.objectStoragePath === `${HASHDIR}/${OPAQUE_REAL}.jpg`);
    expect(linked).toHaveLength(1);
  });
});

describe("migrateAttachmentPaths convergence", () => {
  it("re-links a 'rename' row whose source file already moved instead of failing", async () => {
    // The dir is already hashed but the DB filename is still plaintext, so the
    // row classifies as a legacy 'rename'. Its source file is gone (a prior
    // partial migration already renamed it to the opaque name on disk).
    const recordId = (await testDb.records.add({
      type: "address",
      inputString: "bc1qexampleaddress",
      inputStringLower: "bc1qexampleaddress",
    } as DbRecord)) as number;

    fileStore.set(`${HASHDIR}/${OPAQUE_REAL}.jpg`, bytes("MOVED-ALREADY"));
    const attId = (await testDb.attachments.add({
      recordId,
      filename: "photo.jpg",
      mimeType: "image/jpeg",
      size: 13,
      objectStoragePath: `${HASHDIR}/photo.jpg`, // source no longer on disk
      createdAt: 1,
    } as Attachment)) as number;

    const filesBefore = Array.from(fileStore.keys()).sort();

    const result = await migrateAttachmentPaths();
    expect(result.migrated).toBe(1);
    expect(result.failed).toBe(0);

    const row = await testDb.attachments.get(attId);
    expect(row!.objectStoragePath).toBe(`${HASHDIR}/${OPAQUE_REAL}.jpg`);

    // Convergence is relink-only on this path: no rename/copy/delete happened.
    expect(Array.from(fileStore.keys()).sort()).toEqual(filesBefore);
  });
});

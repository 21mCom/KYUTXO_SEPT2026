// @vitest-environment jsdom
//
// Startup-migration SCALE + RESUME guards. The startup repair jobs that froze
// large vaults were migrateAttachmentPaths() and decryptLegacyAttachmentFiles():
// both loaded an entire attachment table into memory before doing any work. These
// tests prove (a) each now walks the tables in bounded id-keyset batches — never
// materialising more than one batch per toArray — and (b) the file-decrypt job is
// durably resumable: its checkpoint advances over clean batches and FREEZES at the
// last clean batch on the first hard failure, so a retry never advances past an
// unresolved failure and never permanently skips it.
//
// Design note (intentional): on a hard failure the job FREEZES the checkpoint but
// KEEPS processing the rest of the run. Breaking instead would let a single
// permanently-unreadable file block every later file forever. Because login fires
// the migration in the background (never awaited), and already-decrypted files are
// benign decrypt-fail skips when re-scanned, repeated runs stay bounded and never
// corrupt or strand data.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type { Record as DbRecord, Attachment, EvidenceAttachment } from "@/lib/db-types";

// ---- In-memory Electron file layer ----------------------------------------

const fileStore = new Map<string, ArrayBuffer>();
// Paths whose read should hard-fail (simulates a stuck/unreadable file → counts
// as a failure, which is what freezes the resume checkpoint).
const failReads = new Set<string>();

function stripPrefix(p: string): string {
  const fwd = p.replace(/\\/g, "/");
  return fwd.startsWith("attachments/") ? fwd.slice("attachments/".length) : fwd;
}

const fakeApi = {
  readAttachment: async (relPath: string) => {
    const key = stripPrefix(relPath);
    if (failReads.has(key)) return { success: false, error: "simulated read failure" };
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
  listAllAttachments: async () => ({ success: true, files: Array.from(fileStore.keys()) }),
};

vi.mock("@/lib/electron", () => ({
  isElectron: () => true,
  getElectronAPI: () => fakeApi,
}));

// A realistic decryptBinary stand-in: it only "decrypts" buffers that still carry
// the ciphertext marker and THROWS on anything else (exactly how real AES-GCM
// decryption rejects a plaintext input). This lets the tests prove that
// re-scanning an already-decrypted file is a benign skip — never a re-decrypt and
// never a hard failure. (Literal marker is inlined because vi.mock is hoisted
// above any top-level const.)
vi.mock("@/lib/crypto", async () => {
  const actual = await vi.importActual<typeof import("@/lib/crypto")>("@/lib/crypto");
  return {
    ...actual,
    decryptBinary: async (data: ArrayBuffer) => {
      const s = new TextDecoder().decode(data);
      if (!s.startsWith("ENC:")) throw new Error("not encrypted");
      return new TextEncoder().encode(s.slice("ENC:".length)).buffer;
    },
  };
});

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
  const actual = await vi.importActual<typeof import("@/lib/database")>("@/lib/database");
  return {
    ...actual,
    get db() {
      return testDb;
    },
  };
});

const { migrateAttachmentPaths } = await import("./attachments");
const { decryptLegacyAttachmentFiles } = await import("./legacy-decrypt-files");

function bytes(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer;
}

// A ciphertext body comfortably over the 28-byte "too small to be encrypted"
// floor (the "ENC:" marker plus a long payload). Decrypting strips the marker, so
// the resulting plaintext no longer matches and a re-scan skips it benignly.
function cipher(suffix: string | number): ArrayBuffer {
  return bytes(`ENC:0123456789abcdef0123456789abcdef${suffix}`);
}

// ---- max-rows-per-SINGLE-toArray instrument --------------------------------
// A full-scan migration touches every row, so TOTAL rows materialised is always
// O(N) and useless as a bound. What matters is the PEAK pulled by any single
// toArray call: a keyset batch pulls ≤ batchSize; an unbounded load pulls N.

let maxRowsPerToArray = 0;
let tableProto: any;
let collProto: any;
let origTableToArray: any;
let origCollToArray: any;

function installInstrument() {
  tableProto = Object.getPrototypeOf(testDb.attachments);
  collProto = Object.getPrototypeOf(testDb.attachments.toCollection());
  origTableToArray = tableProto.toArray;
  origCollToArray = collProto.toArray;
  tableProto.toArray = async function (...args: any[]) {
    const r = await origTableToArray.apply(this, args);
    if (Array.isArray(r)) maxRowsPerToArray = Math.max(maxRowsPerToArray, r.length);
    return r;
  };
  collProto.toArray = async function (...args: any[]) {
    const r = await origCollToArray.apply(this, args);
    if (Array.isArray(r)) maxRowsPerToArray = Math.max(maxRowsPerToArray, r.length);
    return r;
  };
}

function removeInstrument() {
  if (tableProto) tableProto.toArray = origTableToArray;
  if (collProto) collProto.toArray = origCollToArray;
  tableProto = undefined;
  collProto = undefined;
}

beforeEach(() => {
  fileStore.clear();
  failReads.clear();
  maxRowsPerToArray = 0;
  testDb = new TestDb(`KYUTXO-startup-${Date.now()}-${Math.random()}`);
});

afterEach(async () => {
  removeInstrument();
  testDb.close();
  await Dexie.delete(testDb.name);
});

// ---- checkpoint store (mirrors vault.ts get/set, in memory) -----------------

function makeCheckpointStore(initial: { tableIndex: number; lastId: number } | null = null) {
  let cp = initial;
  const saved: Array<{ tableIndex: number; lastId: number }> = [];
  return {
    options: {
      getCheckpoint: async () => cp,
      saveCheckpoint: async (c: { tableIndex: number; lastId: number }) => {
        cp = c;
        saved.push(c);
      },
    },
    get current() {
      return cp;
    },
    saved,
  };
}

describe("migrateAttachmentPaths stays bounded by batch size", () => {
  it("never materialises more than one batch, regardless of table size", async () => {
    const N = 550; // > the 500 internal batch size, so multiple batches are forced
    await testDb.records.bulkAdd(
      Array.from({ length: 50 }, (_, i) => ({
        type: "address",
        inputString: `addr-${i}`,
        inputStringLower: `addr-${i}`,
      })) as DbRecord[],
    );

    const attRows: Attachment[] = [];
    for (let i = 0; i < N; i++) {
      const path = `att-${i}.bin`;
      fileStore.set(path, bytes(`a${i}`));
      attRows.push({
        recordId: (i % 50) + 1,
        filename: `att-${i}.bin`,
        mimeType: "application/octet-stream",
        size: 2,
        objectStoragePath: path, // single-segment "root" path → needs migration
        createdAt: i,
      } as Attachment);
    }
    await testDb.attachments.bulkAdd(attRows);

    const evRows: EvidenceAttachment[] = [];
    for (let i = 0; i < N; i++) {
      const path = `ev-${i}.bin`;
      fileStore.set(path, bytes(`e${i}`));
      evRows.push({
        evidenceId: 1,
        filename: `ev-${i}.bin`,
        mimeType: "application/octet-stream",
        size: 2,
        objectStoragePath: path,
        createdAt: i,
      } as EvidenceAttachment);
    }
    await testDb.evidenceAttachments.bulkAdd(evRows);

    installInstrument();
    const result = await migrateAttachmentPaths();

    expect(result.migrated).toBe(N * 2);
    expect(result.failed).toBe(0);
    // Peak rows from any single toArray must be a batch, never the whole table.
    expect(maxRowsPerToArray).toBeGreaterThan(0); // instrument actually fired
    expect(maxRowsPerToArray).toBeLessThanOrEqual(500);
    expect(maxRowsPerToArray).toBeLessThan(N);
  });

  it("instrument self-check: a deliberate full toArray pulls the whole table", async () => {
    const N = 120;
    await testDb.attachments.bulkAdd(
      Array.from({ length: N }, (_, i) => ({
        recordId: 1,
        filename: `f${i}`,
        mimeType: "x",
        size: 1,
        objectStoragePath: `ab/cd${i}.bin`,
        createdAt: i,
      })) as Attachment[],
    );

    installInstrument();
    maxRowsPerToArray = 0;
    const all = await testDb.attachments.toArray();
    expect(all).toHaveLength(N);
    // Proves the bound above is meaningful: an unbounded load IS detected.
    expect(maxRowsPerToArray).toBeGreaterThanOrEqual(N);
  });
});

describe("decryptLegacyAttachmentFiles stays bounded by batch size", () => {
  it("never materialises more than one batch", async () => {
    const N = 250; // > the 200 internal batch size
    const attRows: Attachment[] = [];
    for (let i = 0; i < N; i++) {
      const path = `dec-att-${i}.bin`;
      fileStore.set(path, cipher(i));
      attRows.push({
        recordId: 1,
        filename: `f${i}`,
        mimeType: "x",
        size: 64,
        objectStoragePath: path,
        createdAt: i,
      } as Attachment);
    }
    await testDb.attachments.bulkAdd(attRows);

    const evRows: EvidenceAttachment[] = [];
    for (let i = 0; i < N; i++) {
      const path = `dec-ev-${i}.bin`;
      fileStore.set(path, cipher(i));
      evRows.push({
        evidenceId: 1,
        filename: `e${i}`,
        mimeType: "x",
        size: 64,
        objectStoragePath: path,
        createdAt: i,
      } as EvidenceAttachment);
    }
    await testDb.evidenceAttachments.bulkAdd(evRows);

    const store = makeCheckpointStore();
    installInstrument();
    const result = await decryptLegacyAttachmentFiles({} as CryptoKey, undefined, store.options);

    expect(result.totalDecrypted).toBe(N * 2);
    expect(result.totalFailed).toBe(0);
    expect(maxRowsPerToArray).toBeGreaterThan(0);
    expect(maxRowsPerToArray).toBeLessThanOrEqual(200);
    expect(maxRowsPerToArray).toBeLessThan(N);
  });
});

describe("decryptLegacyAttachmentFiles is durably resumable", () => {
  it("advances the checkpoint over clean batches and finishes past every table", async () => {
    const N = 450; // batches of 200, 200, 50
    const rows: Attachment[] = [];
    for (let i = 0; i < N; i++) {
      const path = `clean-${i}.bin`;
      fileStore.set(path, cipher(i));
      rows.push({
        recordId: 1,
        filename: `f${i}`,
        mimeType: "x",
        size: 64,
        objectStoragePath: path,
        createdAt: i,
      } as Attachment);
    }
    await testDb.attachments.bulkAdd(rows);

    const store = makeCheckpointStore();
    const result = await decryptLegacyAttachmentFiles({} as CryptoKey, undefined, store.options);

    expect(result.totalFailed).toBe(0);
    expect(result.totalDecrypted).toBe(N);
    // Final checkpoint is past BOTH tables, so a future login re-scans nothing.
    expect(store.current).toEqual({ tableIndex: 2, lastId: 0 });
    // Checkpoint moved forward in steps rather than jumping straight to the end.
    expect(store.saved.length).toBeGreaterThan(1);
  });

  it("freezes at the last clean batch on failure in the FINAL batch, and resume re-decrypts only the failed file", async () => {
    const N = 300; // ids 1..300; batches of 200 then 100 (the failing batch is last)
    const rows: Attachment[] = [];
    for (let i = 0; i < N; i++) {
      const path = `r-${i}.bin`; // the i-th row (0-based) gets primary key i+1
      fileStore.set(path, cipher(i));
      rows.push({
        recordId: 1,
        filename: `f${i}`,
        mimeType: "x",
        size: 64,
        objectStoragePath: path,
        createdAt: i,
      } as Attachment);
    }
    await testDb.attachments.bulkAdd(rows);

    // Fail one file in the SECOND (final) batch: i=250 → id 251.
    failReads.add("r-250.bin");

    const store = makeCheckpointStore();
    const first = await decryptLegacyAttachmentFiles({} as CryptoKey, undefined, store.options);

    expect(first.totalFailed).toBe(1);
    // First clean batch (ids 1..200) is saved; the failing batch is NOT advanced.
    expect(store.current).toEqual({ tableIndex: 0, lastId: 200 });

    // Heal the failure and resume with the same checkpoint store.
    failReads.delete("r-250.bin");
    const second = await decryptLegacyAttachmentFiles({} as CryptoKey, undefined, store.options);

    expect(second.totalFailed).toBe(0);
    // Resume reprocessed ids 201..300 only (never re-scanned 1..200). Of those, the
    // 99 already-decrypted files are now plaintext → benign skips; only the
    // previously-failed file (id 251) actually decrypts. Proves the failure was
    // never permanently skipped and finished rows are never re-corrupted.
    expect(second.totalDecrypted).toBe(1);
    expect(second.totalSkipped).toBe(99);
    expect(store.current).toEqual({ tableIndex: 2, lastId: 0 });
  });

  it("on failure in an EARLY batch, keeps processing but freezes; resume retries the whole suffix without skipping the failure", async () => {
    const N = 450; // ids 1..450; batches of 200, 200, 50 — failure is in batch 2
    const rows: Attachment[] = [];
    for (let i = 0; i < N; i++) {
      const path = `e-${i}.bin`;
      fileStore.set(path, cipher(i));
      rows.push({
        recordId: 1,
        filename: `f${i}`,
        mimeType: "x",
        size: 64,
        objectStoragePath: path,
        createdAt: i,
      } as Attachment);
    }
    await testDb.attachments.bulkAdd(rows);

    // Fail a file in batch 2 (ids 201..400): i=250 → id 251.
    failReads.add("e-250.bin");

    const store = makeCheckpointStore();
    const first = await decryptLegacyAttachmentFiles({} as CryptoKey, undefined, store.options);

    expect(first.totalFailed).toBe(1);
    // Intentional: it kept going after the failure and decrypted batch 3 too
    // (449 = 200 + 199 + 50), maximising progress so one bad file can't strand
    // the rest of the vault.
    expect(first.totalDecrypted).toBe(449);
    // But the checkpoint is frozen at the last fully-clean batch (end of batch 1),
    // NOT advanced past the failure.
    expect(store.current).toEqual({ tableIndex: 0, lastId: 200 });

    // Heal and resume.
    failReads.delete("e-250.bin");
    const second = await decryptLegacyAttachmentFiles({} as CryptoKey, undefined, store.options);

    expect(second.totalFailed).toBe(0);
    // Resume retries the ENTIRE suffix after the frozen checkpoint (ids 201..450 =
    // 250 rows), never re-scanning ids 1..200. Only the previously-failed file
    // re-decrypts; the 249 already-done rows are benign skips.
    expect(second.totalDecrypted).toBe(1);
    expect(second.totalSkipped).toBe(249);
    // Now everything is clean, so the checkpoint finally completes past all tables.
    expect(store.current).toEqual({ tableIndex: 2, lastId: 0 });
  });
});

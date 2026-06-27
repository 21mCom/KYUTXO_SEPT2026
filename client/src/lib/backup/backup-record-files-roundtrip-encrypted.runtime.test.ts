// Full-pipeline guard that GENERAL (non-evidence) record/transaction attachment
// FILE BYTES survive a real v3 ENCRYPTED backup: export (encrypted + password)
// -> zip -> wipe (DB + on-disk files) -> restore (same password) -> open.
//
// Task #720 added `backup-evidence-files-roundtrip-encrypted.runtime.test.ts`,
// which proves this for EVIDENCE attachments (`db.evidence` /
// `db.evidenceAttachments`, restored inline via the encrypted manifest). The
// general record/transaction attachments stored in `db.attachments` take the
// SAME encrypted inline-manifest path (their metadata rides as NDJSON inside the
// encrypted envelope, their FILE BYTES ride uncompressed in the zip) but were
// not covered by an analogous encrypted full-pipeline test. A regression in the
// encrypted manifest round-trip for those rows could leave their DB links broken
// while the files are present on disk — the exact "files present, can't open
// them" failure this task family guards against, untested for non-evidence
// attachments in encrypted mode until now.
//
// Unlike evidence attachments (which relink to evidence ids restored inline),
// `db.attachments` rows relink to their owning RECORD via `recordId`, which is
// remapped through the records id map during restore. So the id-shift case here
// is driven by RECORD id collisions: unrelated records are pre-seeded before
// restore so the backup record ids collide with live ids, forcing the restore to
// reassign record ids and relink every attachment through the remap.
//
// This test mirrors the encrypted evidence harness with the REAL pieces:
//   - the REAL Express attachments backend (`server/attachments.ts`) serving
//     REAL files from a temp `KYUTXO_DATA_DIR` on disk,
//   - the REAL web-mode client file layer (`uploadFile` / `getFileBlob`),
//   - the REAL `exportBackup` ENCRYPTED with a password, and
//   - the REAL `restoreV3Backup` decrypting with the same password.
//
// It asserts three things:
//   1. An encrypted backup round-trips record/transaction attachment files and
//      they open via their restored `objectStoragePath` with the original bytes,
//   2. the record id-shift remap still resolves each restored attachment to the
//      SAME record it was linked to (collisions pre-seeded before restore), AND
//   3. a WRONG-password restore is rejected BEFORE any destructive clear, so the
//      existing vault (DB rows AND on-disk files) is left fully intact.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import "fake-indexeddb/auto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import http from "http";
import express from "express";

// The client file layer must run in WEB mode so it talks to the Express backend
// (the real disk-backed serving path) instead of an Electron IPC stub.
vi.mock("@/lib/electron", () => ({
  isElectron: () => false,
  getElectronAPI: () => {
    throw new Error("electron API must not be used in web-mode test");
  },
  getElectronAPISafe: () => null,
}));

const PASSWORD = "correct horse battery staple";
const WRONG_PASSWORD = "Tr0ub4dor&3";

let tmpDataDir: string;
let server: http.Server;
let serverBase: string;
let originalFetch: typeof global.fetch;

// Loaded after KYUTXO_DATA_DIR is set (server/attachments reads it at import).
let uploadFile: typeof import("@/lib/attachments").uploadFile;
let getFileBlob: typeof import("@/lib/attachments").getFileBlob;
let exportBackup: typeof import("./export").exportBackup;
let restoreV3Backup: typeof import("./restore").restoreV3Backup;
let MemorySink: typeof import("./sink").MemorySink;
let blobChunks: typeof import("./zip-stream").blobChunks;
let recordCrud: typeof import("@/lib/data/record-crud");
let attachmentsCrud: typeof import("@/lib/data/attachments-crud");

// Clears used to fully wipe the DB side before restore (restoreV3Backup also
// clears internally, but we assert a verified-empty starting point first).
let clearAllRecords: typeof import("@/lib/data/record-crud").clearAllRecords;
let clearAttachments: typeof import("@/lib/data/attachments-crud").clearAttachments;
let clearParticipants: typeof import("@/lib/data/transaction-crud").clearParticipants;
let clearTransactions: typeof import("@/lib/data/transaction-crud").clearTransactions;
let clearAddressSyncState: typeof import("@/lib/data/address-sync-crud").clearAddressSyncState;
let clearUtxoLineage: typeof import("@/lib/data/lineage-crud").clearUtxoLineage;
let clearCustodySegments: typeof import("@/lib/data/lineage-crud").clearCustodySegments;

beforeAll(async () => {
  tmpDataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "kyutxo-backup-record-enc-"),
  );
  process.env.KYUTXO_DATA_DIR = tmpDataDir;

  const attachmentsRouter = (
    await import(path.resolve(process.cwd(), "server/attachments.ts"))
  ).default;
  const app = express();
  app.use("/api/attachments", attachmentsRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  serverBase = `http://127.0.0.1:${(server.address() as any).port}`;

  // The web-mode client uses relative URLs ("/api/attachments/..."); resolve
  // them against the test server so the real upload/download/write path runs.
  originalFetch = global.fetch;
  global.fetch = ((input: any, init?: any) =>
    originalFetch(
      typeof input === "string" && input.startsWith("/")
        ? serverBase + input
        : input,
      init,
    )) as typeof global.fetch;

  const attachments = await import("@/lib/attachments");
  uploadFile = attachments.uploadFile;
  getFileBlob = attachments.getFileBlob;
  exportBackup = (await import("./export")).exportBackup;
  restoreV3Backup = (await import("./restore")).restoreV3Backup;
  MemorySink = (await import("./sink")).MemorySink;
  blobChunks = (await import("./zip-stream")).blobChunks;
  recordCrud = await import("@/lib/data/record-crud");
  attachmentsCrud = await import("@/lib/data/attachments-crud");

  clearAllRecords = recordCrud.clearAllRecords;
  clearAttachments = attachmentsCrud.clearAttachments;
  const txCrud = await import("@/lib/data/transaction-crud");
  clearParticipants = txCrud.clearParticipants;
  clearTransactions = txCrud.clearTransactions;
  clearAddressSyncState = (await import("@/lib/data/address-sync-crud")).clearAddressSyncState;
  const lineageCrud = await import("@/lib/data/lineage-crud");
  clearUtxoLineage = lineageCrud.clearUtxoLineage;
  clearCustodySegments = lineageCrud.clearCustodySegments;
});

afterAll(async () => {
  global.fetch = originalFetch;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (tmpDataDir) await fs.rm(tmpDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await clearAttachments({ skipNotification: true });
  await clearAllRecords({ skipNotification: true });
});

// Production-shaped attachment IO for export: list every file on disk and read
// its bytes through the same endpoints the real ExportPage uses.
const attachmentIO = {
  async listAll(): Promise<string[]> {
    const res = await fetch("/api/attachments/list-all");
    if (!res.ok) throw new Error(`list-all failed: ${res.status}`);
    const data = await res.json();
    return data.files ?? [];
  },
  async read(relPath: string): Promise<ArrayBuffer | null> {
    const res = await fetch(`/api/attachments/download/attachments/${relPath}`);
    if (res.ok) return await res.arrayBuffer();
    return null;
  },
};

// Production-shaped attachment writer for restore: write bytes back to disk
// through the same endpoint the real SettingsPage restore uses.
const attachmentWriter = {
  async write(relativePath: string, fileData: ArrayBuffer): Promise<void> {
    const formData = new FormData();
    formData.append("file", new Blob([fileData]));
    formData.append("relativePath", relativePath);
    const res = await fetch("/api/attachments/write", {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || res.statusText);
    }
  },
};

function fileWithBytes(name: string, mime: string, text: string): File {
  return new File([new TextEncoder().encode(text)], name, { type: mime });
}

async function fetchBytesViaPath(
  objectStoragePath: string,
  mime: string,
): Promise<string> {
  const blob = await getFileBlob(objectStoragePath, mime);
  return new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()));
}

async function clearDbVault(): Promise<void> {
  await clearAllRecords({ skipNotification: true });
  await clearAttachments({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearAddressSyncState({ skipNotification: true });
  await clearUtxoLineage({ skipNotification: true });
  await clearCustodySegments({ skipNotification: true });
}

// Wipe ALL on-disk attachment files (simulating a fresh machine / cleared data
// dir). Restore must re-materialise the bytes from inside the backup zip.
async function wipeDiskFiles(): Promise<void> {
  await fs.rm(path.join(tmpDataDir, "attachments"), {
    recursive: true,
    force: true,
  });
}

// Each plan entry models one record (address or transaction) that owns ONE
// attachment whose bytes are distinct + identifiable by the owning record's
// inputString.
type Plan = {
  type: "address" | "transaction";
  inputString: string;
  filename: string;
  bytes: string;
};

async function seedRecordsWithAttachments(plan: Plan[]): Promise<void> {
  for (const p of plan) {
    const recordId = await recordCrud.createRecord(
      {
        type: p.type,
        inputString: p.inputString,
        label: `Label for ${p.inputString}`,
        tags: [],
        categories: [],
      } as any,
      { skipNotification: true, skipVocabularySync: true },
    );
    const storagePath = await uploadFile(
      fileWithBytes(p.filename, "text/plain", p.bytes),
    );
    await attachmentsCrud.addAttachment(
      {
        recordId,
        filename: p.filename,
        mimeType: "text/plain",
        size: p.bytes.length,
        objectStoragePath: storagePath,
      },
      { skipNotification: true },
    );
  }
}

describe("v3 ENCRYPTED backup full pipeline: record/transaction attachment files survive export -> wipe -> restore", () => {
  it("re-materialises record attachment bytes from an encrypted zip and they open via their restored path (record ids shift)", async () => {
    // 1. Pre-seed UNRELATED records so the table's autoincrement key generator
    //    is advanced past the backup ids. After restore the backup record ids
    //    collide with these pre-existing live ids — a broken remap would link a
    //    restored attachment to one of these instead of to its real record.
    await recordCrud.bulkCreateRecords(
      [
        { type: "other", inputString: "pre-existing-A", label: "A", tags: [], categories: [] },
        { type: "other", inputString: "pre-existing-B", label: "B", tags: [], categories: [] },
        { type: "other", inputString: "pre-existing-C", label: "C", tags: [], categories: [] },
      ] as any,
      { skipNotification: true, skipVocabularySync: true },
    );

    // 2. Seed the records + their attachments (files written to disk via the
    //    real upload endpoint), each with distinct, inputString-identifiable
    //    bytes. A mix of address + transaction records exercises both kinds.
    const plan: Plan[] = [
      { type: "address", inputString: "bc1qaddressone", filename: "receipt.txt", bytes: "RECEIPT-BYTES-ADDR-ONE" },
      { type: "transaction", inputString: "txid-aaaa-1111", filename: "txproof.txt", bytes: "TXPROOF-BYTES-TX-AAAA" },
      { type: "address", inputString: "bc1qaddresstwo", filename: "photo.txt", bytes: "PHOTO-BYTES-ADDR-TWO" },
    ];
    await seedRecordsWithAttachments(plan);

    // 3. Export a real, full v3 ENCRYPTED backup to a Blob. The attachmentIO
    //    reads the files OFF DISK through the download endpoint, so their bytes
    //    must land inside the zip for restore to recover them. The attachment
    //    METADATA rides inline as NDJSON inside the encrypted envelope.
    const sink = new MemorySink();
    await exportBackup({
      sink: sink as any,
      encrypted: true,
      password: PASSWORD,
      batchSize: 50,
      attachmentIO,
    });
    const blob = sink.blob as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBeGreaterThan(0);

    // 4. WIPE everything: DB tables AND the on-disk files. Confirm the files are
    //    truly gone so a passing restore can only be sourcing bytes from the zip.
    const expectedBytesByInput = new Map(plan.map((p) => [p.inputString, p.bytes]));
    const seededBefore = await attachmentsCrud.getAllAttachments();
    const pathsBefore = seededBefore.map((a) => ({ path: a.objectStoragePath }));
    await clearDbVault();
    await wipeDiskFiles();
    for (const { path: storagePath } of pathsBefore) {
      await expect(
        fetchBytesViaPath(storagePath, "text/plain"),
      ).rejects.toThrow();
    }
    expect(await recordCrud.getAllRecords()).toHaveLength(0);
    expect(await attachmentsCrud.getAllAttachments()).toHaveLength(0);

    // 5. Pre-seed UNRELATED records AGAIN (clearDbVault reset the table) to
    //    force the id-shift: restore re-adds the backup records and must
    //    reassign ids + relink attachments through the records id map.
    await recordCrud.bulkCreateRecords(
      [
        { type: "other", inputString: "collision-X", label: "X", tags: [], categories: [] },
        { type: "other", inputString: "collision-Y", label: "Y", tags: [], categories: [] },
        { type: "other", inputString: "collision-Z", label: "Z", tags: [], categories: [] },
        { type: "other", inputString: "collision-W", label: "W", tags: [], categories: [] },
      ] as any,
      { skipNotification: true, skipVocabularySync: true },
    );

    // 6. Restore the ENCRYPTED zip through the REAL orchestrator with the SAME
    //    password. The AttachmentFileWriter writes file bytes back to disk via
    //    the write endpoint.
    const result = await restoreV3Backup({
      source: blobChunks(blob),
      password: PASSWORD,
      attachmentWriter,
    });
    // Sanity-check the round-trip really went through the encrypted path.
    expect(result.manifest.encrypted).toBe(true);
    expect(result.counts.attachmentFiles).toBe(plan.length);
    expect(result.counts.attachments).toBe(plan.length);

    // 7. The restored records must coexist with the collision rows; pull the
    //    full record set and index by inputString.
    const allRecords = await recordCrud.getAllRecords();
    const recordByInput = new Map(allRecords.map((r) => [r.inputString, r]));
    for (const p of plan) {
      expect(recordByInput.has(p.inputString)).toBe(true);
    }
    const idToInput = new Map(allRecords.map((r) => [r.id!, r.inputString]));

    // 8. End-to-end assertion: open EACH restored attachment via its
    //    objectStoragePath and confirm the bytes belong to the SAME record it is
    //    linked to. A dropped-file export would fail to open; a broken encrypted
    //    manifest remap would resolve to the wrong record (or an orphan).
    const restoredAttachments = await attachmentsCrud.getAllAttachments();
    expect(restoredAttachments).toHaveLength(plan.length);

    for (const att of restoredAttachments) {
      const linkedInput = idToInput.get(att.recordId);
      // The attachment must point at one of the RESTORED plan records, never a
      // pre-existing collision row.
      expect(expectedBytesByInput.has(linkedInput ?? "")).toBe(true);

      const actualBytes = await fetchBytesViaPath(att.objectStoragePath, att.mimeType);
      expect(actualBytes).toBe(expectedBytesByInput.get(linkedInput!));
    }
  });

  it("rejects a wrong-password restore BEFORE any destructive clear (vault left intact)", async () => {
    // 1. Seed real records + on-disk files and export an ENCRYPTED backup.
    const plan: Plan[] = [
      { type: "address", inputString: "bc1qkeepone", filename: "r.txt", bytes: "RECEIPT-BYTES" },
      { type: "transaction", inputString: "txid-keep-two", filename: "w.txt", bytes: "TXPROOF-BYTES" },
    ];
    await seedRecordsWithAttachments(plan);

    const sink = new MemorySink();
    await exportBackup({
      sink: sink as any,
      encrypted: true,
      password: PASSWORD,
      batchSize: 50,
      attachmentIO,
    });
    const blob = sink.blob as Blob;
    expect(blob.size).toBeGreaterThan(0);

    // 2. Attempt a restore with the WRONG password. Password verification runs
    //    against the sentinel BEFORE the vault is cleared, so this must reject.
    await expect(
      restoreV3Backup({
        source: blobChunks(blob),
        password: WRONG_PASSWORD,
        attachmentWriter,
      }),
    ).rejects.toThrow();

    // 3. The existing vault must be fully intact — no destructive clear happened.
    //    DB records + attachment rows are unchanged...
    const recordsAfter = await recordCrud.getAllRecords();
    expect(new Set(recordsAfter.map((r) => r.inputString))).toEqual(
      new Set(plan.map((p) => p.inputString)),
    );
    const attachmentsAfter = await attachmentsCrud.getAllAttachments();
    expect(attachmentsAfter).toHaveLength(plan.length);

    // ...and the on-disk files still open via their original paths with the
    //    bytes that belong to the record each is linked to.
    const idToInput = new Map(recordsAfter.map((r) => [r.id!, r.inputString]));
    const expectedBytesByInput = new Map(plan.map((p) => [p.inputString, p.bytes]));
    for (const att of attachmentsAfter) {
      const linkedInput = idToInput.get(att.recordId);
      const bytes = await fetchBytesViaPath(att.objectStoragePath, att.mimeType);
      expect(bytes).toBe(expectedBytesByInput.get(linkedInput!));
    }
  });

  // Companion to the encrypted happy path above: a single record attachment
  // file's write can fail for real-world reasons (disk full, permission denied,
  // a path the backend rejects). When that happens during an ENCRYPTED restore,
  // restore MUST surface the failure — never finish as if every file landed —
  // because the inline DB tables (records + attachments) are already restored
  // from the decrypted manifest, so a swallowed write error would leave the user
  // with a record whose attachment looks present but cannot be opened. This
  // mirrors the unencrypted per-file failure guard in
  // `backup-record-files-roundtrip.runtime.test.ts`, but through the encrypted
  // export/restore path (with password).
  //
  // `restoreV3Backup` now FAILS CLOSED on any post-clear failure: it resets the
  // vault to a known-empty state and rejects with a distinct hard error
  // (RestoreInterruptedError) that carries the underlying write failure as its
  // `cause`, rather than re-throwing the raw error or finishing as if every file
  // landed. So this test asserts (a) the restore REJECTS, (b) the per-file write
  // failure is genuinely propagated up the error's cause chain (not swallowed),
  // and (c) the affected attachment is genuinely unreadable afterwards via its
  // `objectStoragePath` (its bytes were never written to disk).
  it("propagates a per-file record attachment write failure instead of silently skipping it (encrypted)", async () => {
    // 1. Seed records + attachments (files written to disk) so a real export
    //    walks them, each with distinct, inputString-identifiable bytes.
    const plan: Plan[] = [
      { type: "address", inputString: "bc1qaddressone", filename: "receipt.txt", bytes: "RECEIPT-BYTES-ADDR-ONE" },
      { type: "transaction", inputString: "txid-aaaa-1111", filename: "txproof.txt", bytes: "TXPROOF-BYTES-TX-AAAA" },
      { type: "address", inputString: "bc1qaddresstwo", filename: "photo.txt", bytes: "PHOTO-BYTES-ADDR-TWO" },
    ];
    await seedRecordsWithAttachments(plan);

    // Capture the failing record's attachment storage path BEFORE the wipe. The
    // backup preserves objectStoragePath, so restore writes the failing file to
    // this exact path — letting us prove afterwards that its bytes never landed.
    const failingInput = "txid-aaaa-1111";
    const failingBytes = "TXPROOF-BYTES-TX-AAAA";
    const seededRecords = await recordCrud.getAllRecords();
    const failingSeedRecord = seededRecords.find((r) => r.inputString === failingInput);
    expect(failingSeedRecord).toBeTruthy();
    const seededAttachments = await attachmentsCrud.getAllAttachments();
    const failingSeedAttachment = seededAttachments.find(
      (a) => a.recordId === failingSeedRecord!.id,
    );
    expect(failingSeedAttachment).toBeTruthy();
    const failingStoragePath = failingSeedAttachment!.objectStoragePath;

    // 2. Export a real, full v3 ENCRYPTED backup to a Blob.
    const sink = new MemorySink();
    await exportBackup({
      sink: sink as any,
      encrypted: true,
      password: PASSWORD,
      batchSize: 50,
      attachmentIO,
    });
    const blob = sink.blob as Blob;
    expect(blob.size).toBeGreaterThan(0);

    // 3. WIPE everything: DB tables AND on-disk files.
    await clearDbVault();
    await wipeDiskFiles();

    // 4. Restore (with the correct password) using a writer that fails on
    //    exactly ONE record's attachment file (the transaction proof),
    //    identified by its distinct bytes, and otherwise writes for real.
    const writeError = "simulated disk-full: attachment write rejected";
    let attemptedFailingWrite = false;
    const flakyWriter = {
      async write(relativePath: string, fileData: ArrayBuffer): Promise<void> {
        const text = new TextDecoder().decode(new Uint8Array(fileData));
        if (text === failingBytes) {
          attemptedFailingWrite = true;
          throw new Error(writeError);
        }
        return attachmentWriter.write(relativePath, fileData);
      },
    };

    // 5. The restore must REJECT — the write failure is propagated, not swallowed.
    let caught: unknown;
    try {
      await restoreV3Backup({
        source: blobChunks(blob),
        password: PASSWORD,
        attachmentWriter: flakyWriter,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(attemptedFailingWrite).toBe(true);

    // The per-file failure must genuinely propagate: walk the error's cause chain
    // and confirm the original write error message is present somewhere in it. A
    // swallowed error would leave the chain free of this message (or not reject
    // at all).
    const messages: string[] = [];
    let cursor: unknown = caught;
    while (cursor instanceof Error) {
      messages.push(cursor.message);
      cursor = (cursor as { cause?: unknown }).cause;
    }
    expect(messages.some((m) => m.includes(writeError))).toBe(true);

    // 6. Confirm the affected attachment is genuinely unreadable afterwards: its
    //    bytes were never written to disk, so opening it via its (preserved)
    //    objectStoragePath must fail. This proves the failure was not misreported
    //    as a successful restore that silently dropped the file.
    await expect(
      fetchBytesViaPath(failingStoragePath, "text/plain"),
    ).rejects.toThrow();
  });
});

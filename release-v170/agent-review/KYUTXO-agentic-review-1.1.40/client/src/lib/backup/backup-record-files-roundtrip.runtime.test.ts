// Full-pipeline guard that GENERAL (non-evidence) record/transaction attachment
// FILE BYTES survive a real v3 UNENCRYPTED backup: export (no password) -> zip
// -> wipe (DB + on-disk files) -> restore -> open.
//
// Task #753 added `backup-record-files-roundtrip-encrypted.runtime.test.ts`,
// which proves this for the ENCRYPTED path (metadata rides as NDJSON inside the
// encrypted envelope). The unencrypted evidence equivalent has its own dedicated
// test (`backup-evidence-files-roundtrip.runtime.test.ts`), but the general
// record/transaction attachments stored in `db.attachments` were only covered
// indirectly in the unencrypted v3 path. A regression in the unencrypted
// manifest/NDJSON round-trip for those rows could leave their DB links broken
// while the files are present on disk — the exact "files present, can't open
// them" failure this task family guards against, untested for non-evidence
// attachments in unencrypted mode until now.
//
// Unlike evidence attachments (which relink to evidence ids restored inline),
// `db.attachments` rows relink to their owning RECORD via `recordId`, which is
// remapped through the records id map during restore. So the id-shift case here
// is driven by RECORD id collisions: unrelated records are pre-seeded before
// restore so the backup record ids collide with live ids, forcing the restore to
// reassign record ids and relink every attachment through the remap.
//
// This test mirrors the encrypted record harness with the REAL pieces:
//   - the REAL Express attachments backend (`server/attachments.ts`) serving
//     REAL files from a temp `KYUTXO_DATA_DIR` on disk,
//   - the REAL web-mode client file layer (`uploadFile` / `getFileBlob`),
//   - the REAL `exportBackup` UNENCRYPTED (no password), and
//   - the REAL `restoreV3Backup` reading the plaintext manifest.
//
// It asserts that an unencrypted backup round-trips record/transaction
// attachment files and they open via their restored `objectStoragePath` with the
// original bytes, AND that the record id-shift remap still resolves each restored
// attachment to the SAME record it was linked to (collisions pre-seeded before
// restore).

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

let tmpDataDir: string;
let server: http.Server;
let serverBase: string;
let originalFetch: typeof global.fetch;

// Loaded after KYUTXO_DATA_DIR is set (server/attachments reads it at import).
let uploadFile: typeof import("@/lib/attachments").uploadFile;
let getFileBlob: typeof import("@/lib/attachments").getFileBlob;
let exportBackup: typeof import("./export").exportBackup;
let restoreV3Backup: typeof import("./restore").restoreV3Backup;
let peekManifest: typeof import("./restore").peekManifest;
let RestoreInterruptedError: typeof import("./restore").RestoreInterruptedError;
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
    path.join(os.tmpdir(), "kyutxo-backup-record-plain-"),
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
  peekManifest = (await import("./restore")).peekManifest;
  RestoreInterruptedError = (await import("./restore")).RestoreInterruptedError;
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
  // Exact on-disk total (stat sum) the real ExportPage records in the manifest.
  async totalBytes(): Promise<number | null> {
    const res = await fetch("/api/attachments/list-all");
    if (!res.ok) throw new Error(`list-all failed: ${res.status}`);
    const data = await res.json();
    return typeof data.totalBytes === "number" ? data.totalBytes : null;
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
  async delete(relativePath: string): Promise<void> {
    const encoded = `attachments/${relativePath}`
      .split("/")
      .map((s) => encodeURIComponent(s))
      .join("/");
    const res = await fetch(`/api/attachments/${encoded}`, { method: "DELETE" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || res.statusText);
    }
  },
};

// Count every attachment file currently on disk under the data dir, so a test
// can assert whether a failed restore left orphaned bytes behind.
async function countDiskFiles(): Promise<number> {
  const root = path.join(tmpDataDir, "attachments");
  let n = 0;
  async function walk(dir: string): Promise<void> {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // dir absent (fully wiped) — zero files
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else n += 1;
    }
  }
  await walk(root);
  return n;
}

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

describe("v3 UNENCRYPTED backup full pipeline: record/transaction attachment files survive export -> wipe -> restore", () => {
  it("re-materialises record attachment bytes from an unencrypted zip and they open via their restored path (record ids shift)", async () => {
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

    // 3. Export a real, full v3 UNENCRYPTED backup to a Blob. The attachmentIO
    //    reads the files OFF DISK through the download endpoint, so their bytes
    //    must land inside the zip for restore to recover them. The attachment
    //    METADATA rides inline as plaintext NDJSON in the manifest.
    const sink = new MemorySink();
    await exportBackup({
      sink: sink as any,
      encrypted: false,
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

    // 6. Restore the UNENCRYPTED zip through the REAL orchestrator (no password).
    //    The AttachmentFileWriter writes file bytes back to disk via the write
    //    endpoint.
    const result = await restoreV3Backup({
      source: blobChunks(blob),
      attachmentWriter,
    });
    // Sanity-check the round-trip really went through the unencrypted path.
    expect(result.manifest.encrypted).toBe(false);
    expect(result.counts.attachmentFiles).toBe(plan.length);
    expect(result.counts.attachments).toBe(plan.length);

    // The v3 manifest records the EXACT total attachment bytes — the on-disk
    // size of every attachment FILE the export wrote into the zip — which the
    // restore pre-flight uses as a precise disk-space estimate instead of the
    // compression-inflated backup file size. With one file per attachment and
    // text bodies, the on-disk total equals the summed plan byte lengths.
    const expectedTotalBytes = plan.reduce((sum, p) => sum + p.bytes.length, 0);
    expect(result.manifest.totalAttachmentBytes).toBe(expectedTotalBytes);

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
    //    linked to. A dropped-file export would fail to open; a broken manifest
    //    remap would resolve to the wrong record (or an orphan).
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

  // Guards the EXACT-estimate guarantee against the DB-metadata blind spot the
  // code review flagged: the manifest's totalAttachmentBytes must equal the
  // bytes of the FILES actually written into the zip, NOT the sum of the
  // `db.attachments` metadata `size`. Those two diverge whenever a file lives on
  // disk with no matching DB row — e.g. a legacy root-level attachment that the
  // export's list-all walk still bundles. Here we plant exactly such an orphan
  // file (no DB row) and assert the manifest total includes its bytes, so the
  // restore pre-flight does not UNDER-estimate disk space and fail mid-restore.
  it("records the on-disk file total (not the DB metadata sum) when a file has no DB row", async () => {
    // Clean disk so list-all reflects only this test's files.
    await wipeDiskFiles();

    const plan: Plan[] = [
      { type: "address", inputString: "bc1qaddressone", filename: "receipt.txt", bytes: "RECEIPT-BYTES-ADDR-ONE" },
      { type: "transaction", inputString: "txid-aaaa-1111", filename: "txproof.txt", bytes: "TXPROOF-BYTES-TX-AAAA" },
    ];
    await seedRecordsWithAttachments(plan);

    // Plant a legacy root-level file directly on disk with NO db.attachments row.
    // The export's list-all walk bundles it into the zip, but a metadata-based
    // sum would miss it entirely — the exact under-estimate this test guards.
    const orphanBytes = "ORPHAN-LEGACY-FILE-BYTES-NO-DB-ROW";
    const attachmentsDir = path.join(tmpDataDir, "attachments");
    await fs.mkdir(attachmentsDir, { recursive: true });
    await fs.writeFile(path.join(attachmentsDir, "legacy-orphan.txt"), orphanBytes);

    const dbMetadataSum = await attachmentsCrud.sumAttachmentSizes();
    const planBytes = plan.reduce((sum, p) => sum + p.bytes.length, 0);
    const onDiskTotal = planBytes + orphanBytes.length;
    // Sanity: the on-disk total must genuinely exceed the DB metadata sum, or the
    // test would pass even if the export fell back to the metadata sum.
    expect(dbMetadataSum).toBe(planBytes);
    expect(onDiskTotal).toBeGreaterThan(dbMetadataSum);

    const sink = new MemorySink();
    await exportBackup({
      sink: sink as any,
      encrypted: false,
      batchSize: 50,
      attachmentIO,
    });
    const blob = sink.blob as Blob;

    // Read the manifest (first zip entry) straight from the produced backup —
    // the same path the restore pre-flight uses to size disk space.
    const manifest = await peekManifest(blobChunks(blob));
    expect(manifest.totalAttachmentBytes).toBe(onDiskTotal);
    expect(manifest.totalAttachmentBytes).not.toBe(dbMetadataSum);
  });

  // Companion to the happy path above: a single record attachment file's write
  // can fail for real-world reasons (disk full, permission denied, a path the
  // backend rejects). When that happens AFTER the destructive clear, the inline
  // DB tables (records + attachments) are already restored, so the vault is left
  // half-restored: some files on disk, some missing, and DB links pointing at
  // files that were never written. Restore MUST NOT silently rethrow the raw
  // error and leave that broken state behind. Instead it mirrors the
  // cancel-after-clear contract: it resets the vault to a known-empty state and
  // surfaces a distinct RestoreInterruptedError (the raw write error preserved
  // as its `cause`) telling the user the vault is only partially restored and to
  // restore again. This mirrors the evidence per-file failure guard in
  // `backup-evidence-files-roundtrip.runtime.test.ts`, but for the general
  // `db.attachments` (record/transaction) attachments. It asserts (a) the
  // distinct error + preserved cause, (b) the vault was actually reset (no
  // lingering record/attachment rows), and (c) — mirroring Task #827 — no record
  // attachment files were stranded on disk by the failed restore.
  it("resets the vault and raises a distinct error when a record attachment file write fails after the clear", async () => {
    // Start from a clean disk so countDiskFiles() reflects only THIS test's
    // files (the prior test leaves its restored files on disk, and export's
    // list-all walks the whole data dir).
    await wipeDiskFiles();

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

    // 2. Export a real, full v3 UNENCRYPTED backup to a Blob.
    const sink = new MemorySink();
    await exportBackup({
      sink: sink as any,
      encrypted: false,
      batchSize: 50,
      attachmentIO,
    });
    const blob = sink.blob as Blob;
    expect(blob.size).toBeGreaterThan(0);

    // 3. WIPE everything: DB tables AND on-disk files.
    await clearDbVault();
    await wipeDiskFiles();

    // 4. Restore with a writer that fails on exactly ONE record's attachment file
    //    (the transaction proof), identified by its distinct bytes, and otherwise
    //    writes for real. The flakyWriter delegates `delete` to the real writer so
    //    the post-failure sweep of already-written files can be exercised.
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
      delete: attachmentWriter.delete,
    };

    // 5. The restore must REJECT with the DISTINCT RestoreInterruptedError (not
    //    the raw write error), signalling the vault is only partially restored
    //    and the user must restore again. The original write error is preserved
    //    as the `cause` so the underlying reason is not lost.
    let caught: unknown;
    try {
      await restoreV3Backup({ source: blobChunks(blob), attachmentWriter: flakyWriter });
      throw new Error("restore should have rejected");
    } catch (err) {
      caught = err;
    }
    expect(attemptedFailingWrite).toBe(true);
    expect(caught).toBeInstanceOf(RestoreInterruptedError);
    expect((caught as Error).message).toMatch(/partially restored|restore again/i);
    expect((caught as { cause?: Error }).cause?.message).toBe(writeError);

    // 6. The failure path must RESET the vault, not leave silently broken DB
    //    links behind. Even though the inline tables had been restored before the
    //    file write phase, the post-failure cleanup wipes them so there are no
    //    phantom records pointing at files that were never written.
    expect(await recordCrud.getAllRecords()).toHaveLength(0);
    expect(await attachmentsCrud.getAllAttachments()).toHaveLength(0);

    // 7. Task #827: clearVault only wipes the DB/inline tables — the files this
    //    restore had ALREADY written to disk before the failing write would be
    //    stranded as orphans without the post-failure sweep. The flakyWriter
    //    delegates `delete` to the real writer, so assert NOTHING is left on disk:
    //    a write failure must not leak record attachment files.
    expect(await countDiskFiles()).toBe(0);

    // 8. Confirm the affected attachment is genuinely unreadable afterwards: its
    //    bytes were never written to disk, so opening it via its (preserved)
    //    objectStoragePath must fail. This proves the failure was not misreported
    //    as a successful restore that silently dropped the file.
    await expect(
      fetchBytesViaPath(failingStoragePath, "text/plain"),
    ).rejects.toThrow();
  });
});

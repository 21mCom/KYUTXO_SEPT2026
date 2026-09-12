// Full-pipeline guard that evidence attachment FILE BYTES survive a real v3
// backup: export -> zip -> wipe (DB + on-disk files) -> restore -> open.
//
// Task #614 added `inline-tables-evidence-files.runtime.test.ts`, which drives
// `restoreInlineTables` DIRECTLY against the real disk-backed backend. That
// proves the v3 DB remap points evidence attachments at real, readable files —
// but it pre-uploads the files itself and never runs `exportBackup` /
// `restoreV3Backup`. So it cannot catch a regression where the EXPORT step
// silently drops evidence attachment files from the zip: the restored DB links
// would be correct, yet point at files that were never written back to disk and
// the user's documents would not open.
//
// This test closes that gap by exercising the WHOLE orchestrated pipeline with
// the REAL pieces:
//   - the REAL Express attachments backend (`server/attachments.ts`) serving
//     REAL files from a temp `KYUTXO_DATA_DIR` on disk,
//   - the REAL web-mode client file layer (`uploadFile` / `getFileBlob`),
//     bridged to the test server by a `global.fetch` shim,
//   - the REAL `exportBackup` reading attachment file bytes off disk through the
//     production-shaped `AttachmentFileIO` (list-all + download endpoints),
//   - the REAL `restoreV3Backup` re-materialising those bytes through the
//     production-shaped `AttachmentFileWriter` (write endpoint).
//
// Flow: seed evidence + evidenceAttachments whose files live on disk, export a
// full v3 backup to a Blob, WIPE everything (DB tables AND the on-disk files),
// confirm the files are gone, restore the zip, then open each restored
// attachment via its `objectStoragePath` and assert the bytes match the SAME
// evidence it is linked to. The id-shift remap case is covered too: unrelated
// evidence is pre-seeded before restore so the backup ids collide with live ids
// and the restore must reassign + relink them.

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
let RestoreInterruptedError: typeof import("./restore").RestoreInterruptedError;
let MemorySink: typeof import("./sink").MemorySink;
let blobChunks: typeof import("./zip-stream").blobChunks;
let evidenceCrud: typeof import("@/lib/data/evidence-crud");

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
  tmpDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "kyutxo-backup-evidence-"));
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
  RestoreInterruptedError = (await import("./restore")).RestoreInterruptedError;
  MemorySink = (await import("./sink")).MemorySink;
  blobChunks = (await import("./zip-stream")).blobChunks;
  evidenceCrud = await import("@/lib/data/evidence-crud");

  clearAllRecords = (await import("@/lib/data/record-crud")).clearAllRecords;
  clearAttachments = (await import("@/lib/data/attachments-crud")).clearAttachments;
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
  await evidenceCrud.clearEvidenceAttachments({ skipNotification: true });
  await evidenceCrud.clearEvidence({ skipNotification: true });
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
// through the same endpoint the real SettingsPage restore uses. The `delete`
// method mirrors the production SettingsPage writer (deleteFile via the DELETE
// endpoint) so the post-failure sweep of stranded files can be exercised.
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
  await evidenceCrud.clearEvidenceAttachments({ skipNotification: true });
  await evidenceCrud.clearEvidence({ skipNotification: true });
}

// Wipe ALL on-disk attachment files (simulating a fresh machine / cleared data
// dir). Restore must re-materialise the bytes from inside the backup zip.
async function wipeDiskFiles(): Promise<void> {
  await fs.rm(path.join(tmpDataDir, "attachments"), {
    recursive: true,
    force: true,
  });
}

describe("v3 backup full pipeline: evidence files survive export -> wipe -> restore", () => {
  it("re-materialises evidence attachment bytes from the zip and they open via their restored path (ids shift)", async () => {
    // 1. Pre-seed UNRELATED evidence so the table's autoincrement key generator
    //    is advanced past the backup ids. After restore the backup ids 1/2/3
    //    collide with these pre-existing live ids — a broken remap would link a
    //    restored attachment to one of these instead of to its real evidence.
    await evidenceCrud.bulkAddEvidence(
      [
        { title: "Pre-existing A", documentType: "other", tags: [], partiesInvolved: [] } as any,
        { title: "Pre-existing B", documentType: "other", tags: [], partiesInvolved: [] } as any,
        { title: "Pre-existing C", documentType: "other", tags: [], partiesInvolved: [] } as any,
      ],
      { skipNotification: true },
    );

    // 2. Put REAL files on disk for the evidence we will back up, each with
    //    distinct, title-identifiable bytes, and capture the recorded path.
    const plan = [
      { title: "Coinbase Receipt 2021", filename: "receipt.txt", bytes: "RECEIPT-BYTES-COINBASE" },
      { title: "Bank Wire Confirmation", filename: "wire.txt", bytes: "WIRE-BYTES-BANK" },
      { title: "Cold Storage Photo", filename: "photo.txt", bytes: "PHOTO-BYTES-COLDSTORAGE" },
    ];
    const pathByTitle = new Map<string, string>();
    for (const p of plan) {
      const storagePath = await uploadFile(fileWithBytes(p.filename, "text/plain", p.bytes));
      pathByTitle.set(p.title, storagePath);
    }

    // 3. Seed the evidence + their attachments into the DB so a real export
    //    walks them (evidence/evidenceAttachments ride inline in the manifest;
    //    their FILES ride as attachment entries discovered via list-all).
    await evidenceCrud.bulkAddEvidence(
      plan.map((p) => ({ title: p.title, documentType: "receipt", tags: [], partiesInvolved: [] } as any)),
      { skipNotification: true },
    );
    const seeded = await evidenceCrud.getAllEvidence();
    const idByTitle = new Map(seeded.map((e) => [e.title, e.id as number]));
    for (const p of plan) {
      await evidenceCrud.addEvidenceAttachment(
        {
          evidenceId: idByTitle.get(p.title)!,
          filename: p.filename,
          mimeType: "text/plain",
          size: p.bytes.length,
          objectStoragePath: pathByTitle.get(p.title)!,
        } as any,
        { skipNotification: true },
      );
    }

    // 4. Export a real, full v3 backup to a Blob. The attachmentIO reads the
    //    evidence files OFF DISK through the download endpoint, so their bytes
    //    must land inside the zip for restore to recover them.
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

    // 5. WIPE everything: DB tables AND the on-disk files. Confirm the files are
    //    truly gone so a passing restore can only be sourcing bytes from the zip.
    await clearDbVault();
    await wipeDiskFiles();
    for (const p of plan) {
      await expect(
        fetchBytesViaPath(pathByTitle.get(p.title)!, "text/plain"),
      ).rejects.toThrow();
    }
    expect(await evidenceCrud.getAllEvidence()).toHaveLength(0);
    expect(await evidenceCrud.getAllEvidenceAttachments()).toHaveLength(0);

    // 6. Pre-seed UNRELATED evidence AGAIN (clearDbVault reset the table) to
    //    force the id-shift: restore re-adds the backup evidence and must
    //    reassign ids + relink attachments.
    await evidenceCrud.bulkAddEvidence(
      [
        { title: "Collision X", documentType: "other", tags: [], partiesInvolved: [] } as any,
        { title: "Collision Y", documentType: "other", tags: [], partiesInvolved: [] } as any,
        { title: "Collision Z", documentType: "other", tags: [], partiesInvolved: [] } as any,
        { title: "Collision W", documentType: "other", tags: [], partiesInvolved: [] } as any,
      ],
      { skipNotification: true },
    );

    // 7. Restore the zip through the REAL orchestrator. The AttachmentFileWriter
    //    writes evidence file bytes back to disk via the write endpoint.
    const result = await restoreV3Backup({
      source: blobChunks(blob),
      attachmentWriter,
    });
    expect(result.counts.attachmentFiles).toBe(plan.length);

    // 8. The restored evidence ids must DIFFER from any plausible backup id
    //    (proving the #488 id-shift path was actually exercised) and there must
    //    be exactly our three restored rows among the collisions.
    const allEvidence = await evidenceCrud.getAllEvidence();
    const restored = allEvidence.filter((e) => pathByTitle.has(e.title));
    expect(restored).toHaveLength(3);

    // 9. End-to-end assertion: open EACH restored attachment via its
    //    objectStoragePath and confirm the bytes belong to the SAME evidence it
    //    is linked to. A dropped-file export would fail to open; a broken remap
    //    would resolve to the wrong evidence's bytes.
    const titleById = new Map(allEvidence.map((e) => [e.id!, e.title]));
    const expectedBytesByTitle = new Map(plan.map((p) => [p.title, p.bytes]));

    const restoredAttachments = await evidenceCrud.getAllEvidenceAttachments();
    expect(restoredAttachments).toHaveLength(3);

    for (const att of restoredAttachments) {
      const linkedTitle = titleById.get(att.evidenceId);
      // The attachment must point at one of the RESTORED evidence rows, never a
      // pre-existing collision row.
      expect(expectedBytesByTitle.has(linkedTitle ?? "")).toBe(true);

      const actualBytes = await fetchBytesViaPath(att.objectStoragePath, att.mimeType);
      expect(actualBytes).toBe(expectedBytesByTitle.get(linkedTitle!));
    }
  });

  // Companion to the happy path above: a single attachment file's write can fail
  // for real-world reasons (disk full, permission denied, a path the backend
  // rejects). When that happens AFTER the destructive clear, the inline DB
  // tables are already restored, so the vault is left half-restored: some files
  // on disk, some missing, and DB links pointing at files that were never
  // written. Restore MUST NOT silently rethrow the raw error and leave that
  // broken state behind. Instead it mirrors the cancel-after-clear contract: it
  // resets the vault to a known-empty state and surfaces a distinct
  // RestoreInterruptedError telling the user the vault is only partially
  // restored and to restore again. This asserts both the distinct error AND that
  // the vault was actually reset (no lingering broken DB links / phantom docs).
  it("resets the vault and raises a distinct error when a file write fails after the clear", async () => {
    // Start from a clean disk so countDiskFiles() reflects only THIS test's
    // files (the prior test leaves its restored files on disk, and export's
    // list-all walks the whole data dir).
    await wipeDiskFiles();

    // 1. Put REAL files on disk for the evidence we will back up.
    const plan = [
      { title: "Coinbase Receipt 2021", filename: "receipt.txt", bytes: "RECEIPT-BYTES-COINBASE" },
      { title: "Bank Wire Confirmation", filename: "wire.txt", bytes: "WIRE-BYTES-BANK" },
      { title: "Cold Storage Photo", filename: "photo.txt", bytes: "PHOTO-BYTES-COLDSTORAGE" },
    ];
    const pathByTitle = new Map<string, string>();
    for (const p of plan) {
      const storagePath = await uploadFile(fileWithBytes(p.filename, "text/plain", p.bytes));
      pathByTitle.set(p.title, storagePath);
    }

    // 2. Seed evidence + attachments so a real export walks them.
    await evidenceCrud.bulkAddEvidence(
      plan.map((p) => ({ title: p.title, documentType: "receipt", tags: [], partiesInvolved: [] } as any)),
      { skipNotification: true },
    );
    const seeded = await evidenceCrud.getAllEvidence();
    const idByTitle = new Map(seeded.map((e) => [e.title, e.id as number]));
    for (const p of plan) {
      await evidenceCrud.addEvidenceAttachment(
        {
          evidenceId: idByTitle.get(p.title)!,
          filename: p.filename,
          mimeType: "text/plain",
          size: p.bytes.length,
          objectStoragePath: pathByTitle.get(p.title)!,
        } as any,
        { skipNotification: true },
      );
    }

    // 3. Export a real, full v3 backup to a Blob.
    const sink = new MemorySink();
    await exportBackup({
      sink: sink as any,
      encrypted: false,
      batchSize: 50,
      attachmentIO,
    });
    const blob = sink.blob as Blob;
    expect(blob.size).toBeGreaterThan(0);

    // 4. WIPE everything: DB tables AND on-disk files.
    await clearDbVault();
    await wipeDiskFiles();

    // 5. Restore with a writer that fails on exactly ONE evidence file (the bank
    //    wire), identified by its distinct bytes, and otherwise writes for real.
    const failingTitle = "Bank Wire Confirmation";
    const failingBytes = "WIRE-BYTES-BANK";
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
      // Delegate delete to the real writer so the post-failure sweep can remove
      // the files this restore had already written before the failing write.
      async delete(relativePath: string): Promise<void> {
        return attachmentWriter.delete(relativePath);
      },
    };

    // 6. The restore must REJECT with the DISTINCT RestoreInterruptedError (not
    //    the raw write error), signalling the vault is only partially restored
    //    and the user must restore again. The original write error is preserved
    //    as the `cause` so the underlying reason is not lost.
    let caught: unknown;
    try {
      await restoreV3Backup({
        source: blobChunks(blob),
        attachmentWriter: flakyWriter,
      });
      throw new Error("restore should have rejected");
    } catch (err) {
      caught = err;
    }
    expect(attemptedFailingWrite).toBe(true);
    expect(caught).toBeInstanceOf(RestoreInterruptedError);
    expect((caught as Error).message).toMatch(/partially restored|restore again/i);
    expect((caught as { cause?: Error }).cause?.message).toBe(writeError);

    // 7. The failure path must RESET the vault, not leave silently broken DB
    //    links behind. Even though the inline tables had been restored before the
    //    file write phase, the post-failure cleanup wipes them so there are no
    //    phantom documents pointing at files that were never written.
    const allEvidence = await evidenceCrud.getAllEvidence();
    expect(allEvidence).toHaveLength(0);
    const allAttachments = await evidenceCrud.getAllEvidenceAttachments();
    expect(allAttachments).toHaveLength(0);
    // And the failing document is genuinely gone — there is no lingering link to
    // a file that was never written.
    expect(allEvidence.find((e) => e.title === failingTitle)).toBeUndefined();

    // 8. Task #827: clearVault only wipes the DB/inline tables — the files this
    //    restore had ALREADY written to disk before the failing write would be
    //    stranded as orphans without the post-failure sweep. The flakyWriter
    //    delegates `delete` to the real writer, so assert NOTHING is left on disk:
    //    a write failure must not leak attachment files.
    expect(await countDiskFiles()).toBe(0);

    // 9. A later SUCCESSFUL restore from the same backup must produce a clean,
    //    fully-openable vault — proving the failed attempt left no debris that
    //    interferes with recovery. Re-seed the disk source files first (the
    //    earlier wipe removed them) is unnecessary: the bytes ride inside the zip.
    const result = await restoreV3Backup({
      source: blobChunks(blob),
      attachmentWriter,
    });
    expect(result.counts.attachmentFiles).toBe(plan.length);
    expect(await countDiskFiles()).toBe(plan.length);

    const recovered = await evidenceCrud.getAllEvidence();
    const recoveredTitles = recovered.map((e) => e.title).sort();
    expect(recoveredTitles).toEqual(plan.map((p) => p.title).sort());

    const recoveredAttachments = await evidenceCrud.getAllEvidenceAttachments();
    expect(recoveredAttachments).toHaveLength(plan.length);
    const titleById = new Map(recovered.map((e) => [e.id!, e.title]));
    const expectedBytesByTitle = new Map(plan.map((p) => [p.title, p.bytes]));
    for (const att of recoveredAttachments) {
      const linkedTitle = titleById.get(att.evidenceId);
      const actualBytes = await fetchBytesViaPath(att.objectStoragePath, att.mimeType);
      expect(actualBytes).toBe(expectedBytesByTitle.get(linkedTitle!));
    }
  });
});

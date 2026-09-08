// Full-pipeline guard that a SUCCESSFUL v3 restore over a POPULATED data dir
// does not strand the PRIOR vault's attachment files on disk (Task #913).
//
// A v3 restore wipes the DB via clearVault(), which is DB/inline-only — it never
// deletes attachment FILES on disk. On a successful restore, only files whose
// relative paths collide with a backup entry get overwritten; any file from the
// OLD vault whose path is absent from the new backup would otherwise linger
// forever as an orphan (wasting space, polluting attachment audits). Task #827
// fixed the failure/cancel-after-clear leak by sweeping the files THAT restore
// wrote; this test covers the broader OLD-vault leak on a NORMAL successful
// restore.
//
// It uses the REAL pieces (mirroring backup-record-files-roundtrip.runtime.test):
//   - the REAL Express attachments backend serving REAL files from a temp
//     KYUTXO_DATA_DIR on disk,
//   - the REAL web-mode client file layer (uploadFile / getFileBlob),
//   - the REAL exportBackup (unencrypted), and
//   - the REAL restoreV3Backup with a production-shaped AttachmentFileWriter that
//     implements write + delete + listPage (so the bounded post-restore sweep is active).
//
// The contract asserted on disk:
//   - prior-vault files NOT referenced by the restored DB are gone afterwards,
//   - every file the restored DB DOES reference survives and opens with its
//     original bytes,
//   - the final on-disk file set equals EXACTLY the restored DB's referenced
//     paths (no orphans, nothing over-deleted).

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

let uploadFile: typeof import("@/lib/attachments").uploadFile;
let getFileBlob: typeof import("@/lib/attachments").getFileBlob;
let exportBackup: typeof import("./export").exportBackup;
let restoreV3Backup: typeof import("./restore").restoreV3Backup;
let MemorySink: typeof import("./sink").MemorySink;
let blobChunks: typeof import("./zip-stream").blobChunks;
let recordCrud: typeof import("@/lib/data/record-crud");
let attachmentsCrud: typeof import("@/lib/data/attachments-crud");

let clearAllRecords: typeof import("@/lib/data/record-crud").clearAllRecords;
let clearAttachments: typeof import("@/lib/data/attachments-crud").clearAttachments;
let clearParticipants: typeof import("@/lib/data/transaction-crud").clearParticipants;
let clearTransactions: typeof import("@/lib/data/transaction-crud").clearTransactions;
let clearAddressSyncState: typeof import("@/lib/data/address-sync-crud").clearAddressSyncState;
let clearUtxoLineage: typeof import("@/lib/data/lineage-crud").clearUtxoLineage;
let clearCustodySegments: typeof import("@/lib/data/lineage-crud").clearCustodySegments;

beforeAll(async () => {
  tmpDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "kyutxo-old-files-sweep-"));
  process.env.KYUTXO_DATA_DIR = tmpDataDir;

  const attachmentsRouter = (
    await import(path.resolve(process.cwd(), "server/attachments.ts"))
  ).default;
  const app = express();
  app.use("/api/attachments", attachmentsRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  serverBase = `http://127.0.0.1:${(server.address() as any).port}`;

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
  await clearDbVault();
  await wipeDiskFiles();
});

// Production-shaped attachment IO for export.
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

// Production-shaped attachment writer for restore. Crucially this implements
// write + delete + listPage, so restoreV3Backup's post-restore old-vault sweep is
// active (the same trio the real SettingsPage restore wires up).
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
  async listPage(cursor: string | null, limit: number): Promise<{ files: string[]; cursor: string | null; total?: number }> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    const res = await fetch(`/api/attachments/list-all?${query}`);
    if (!res.ok) throw new Error(`list-all failed: ${res.status}`);
    const data = await res.json();
    return { files: data.files ?? [], cursor: data.cursor ?? null, total: data.total };
  },
  async closeListing(cursor: string): Promise<void> {
    await fetch(`/api/attachments/list-all?closeCursor=${encodeURIComponent(cursor)}`);
  },
};

function fileWithBytes(name: string, mime: string, text: string): File {
  return new File([new TextEncoder().encode(text)], name, { type: mime });
}

async function fetchBytesViaPath(objectStoragePath: string, mime: string): Promise<string> {
  const blob = await getFileBlob(objectStoragePath, mime);
  return new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()));
}

async function listDiskFiles(): Promise<string[]> {
  const res = await fetch("/api/attachments/list-all");
  const data = await res.json();
  return (data.files ?? []).map((f: string) => f.replace(/\\/g, "/")).sort();
}

function normalizeStored(p: string): string {
  const fwd = p.replace(/\\/g, "/");
  return fwd.startsWith("attachments/") ? fwd.slice("attachments/".length) : fwd;
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

async function wipeDiskFiles(): Promise<void> {
  await fs.rm(path.join(tmpDataDir, "attachments"), { recursive: true, force: true });
}

type Plan = { inputString: string; filename: string; bytes: string };

async function seedRecordsWithAttachments(plan: Plan[]): Promise<void> {
  for (const p of plan) {
    const recordId = await recordCrud.createRecord(
      {
        type: "address",
        inputString: p.inputString,
        label: `Label for ${p.inputString}`,
        tags: [],
        categories: [],
      } as any,
      { skipNotification: true, skipVocabularySync: true },
    );
    const storagePath = await uploadFile(fileWithBytes(p.filename, "text/plain", p.bytes));
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

describe("v3 restore over a populated data dir sweeps the prior vault's stranded files", () => {
  it("leaves only files referenced by the restored DB on disk", async () => {
    // 1. Build the backup from the NEW vault (vault B) — a single record with
    //    one attachment. Its file lands on disk during seeding; exportBackup
    //    reads it OFF DISK into the zip.
    const newVaultPlan: Plan[] = [
      { inputString: "bc1qnewvault", filename: "newproof.txt", bytes: "NEW-VAULT-BYTES-B1" },
    ];
    await seedRecordsWithAttachments(newVaultPlan);
    const sink = new MemorySink();
    await exportBackup({ sink: sink as any, encrypted: false, batchSize: 50, attachmentIO });
    const backupBlob = sink.blob as Blob;
    expect(backupBlob.size).toBeGreaterThan(0);

    // 2. Replace everything with the OLD vault (vault A): two records, each with
    //    its own attachment file. These files use opaque names distinct from the
    //    new vault's, so NONE of them collide with the backup's single file —
    //    after restore they would all be stranded if not swept.
    await clearDbVault();
    await wipeDiskFiles();
    const oldVaultPlan: Plan[] = [
      { inputString: "bc1qoldone", filename: "oldreceipt.txt", bytes: "OLD-VAULT-BYTES-A1" },
      { inputString: "bc1qoldtwo", filename: "oldphoto.txt", bytes: "OLD-VAULT-BYTES-A2" },
    ];
    await seedRecordsWithAttachments(oldVaultPlan);

    // Capture the OLD vault's on-disk files; confirm they are really present.
    const oldAttachments = await attachmentsCrud.getAllAttachments();
    const oldDiskPaths = oldAttachments.map((a) => normalizeStored(a.objectStoragePath));
    expect(oldDiskPaths).toHaveLength(2);
    const diskBeforeRestore = await listDiskFiles();
    for (const p of oldDiskPaths) expect(diskBeforeRestore).toContain(p);

    // 3. Restore the NEW vault's backup OVER the populated OLD vault. The writer
    //    implements write + delete + listPage, so the post-restore sweep runs.
    const result = await restoreV3Backup({
      source: blobChunks(backupBlob),
      attachmentWriter,
    });
    expect(result.manifest.encrypted).toBe(false);
    expect(result.counts.attachmentFiles).toBe(1);
    expect(result.counts.attachments).toBe(1);

    // 4. The restored DB references exactly the new vault's single file.
    const restoredAttachments = await attachmentsCrud.getAllAttachments();
    expect(restoredAttachments).toHaveLength(1);
    const referenced = restoredAttachments
      .map((a) => normalizeStored(a.objectStoragePath))
      .sort();

    // 5. ON-DISK STATE CONTRACT: the disk now contains EXACTLY the files the
    //    restored DB references — no prior-vault orphans, nothing over-deleted.
    const diskAfterRestore = await listDiskFiles();
    expect(diskAfterRestore).toEqual(referenced);

    // The OLD vault's stranded files are gone.
    for (const p of oldDiskPaths) expect(diskAfterRestore).not.toContain(p);

    // The file the restored vault DOES reference survives and opens with its
    // original bytes (never deleted by the sweep).
    const restored = restoredAttachments[0];
    expect(await fetchBytesViaPath(restored.objectStoragePath, "text/plain")).toBe(
      "NEW-VAULT-BYTES-B1",
    );
  });

  it("keeps a prior file whose path COLLIDES with a restored file (overwritten, not deleted)", async () => {
    // A prior-vault file whose relative path matches a backup entry is
    // overwritten in place by the write phase. It must NOT then be deleted by
    // the sweep (it is part of the restored vault), and its bytes must be the
    // RESTORED bytes, not the stale prior ones.
    const plan: Plan[] = [
      { inputString: "bc1qcollide", filename: "shared.txt", bytes: "RESTORED-COLLIDING-BYTES" },
    ];
    await seedRecordsWithAttachments(plan);
    const restoredAttachment = (await attachmentsCrud.getAllAttachments())[0];
    const collidingPath = restoredAttachment.objectStoragePath;

    const sink = new MemorySink();
    await exportBackup({ sink: sink as any, encrypted: false, batchSize: 50, attachmentIO });
    const backupBlob = sink.blob as Blob;

    // Recreate the SAME on-disk file path but with STALE prior bytes, plus an
    // unrelated stranded file. Keep the DB cleared so restore re-adds the row.
    await clearDbVault();
    await attachmentWriter.write(normalizeStored(collidingPath), new TextEncoder().encode("STALE-PRIOR-BYTES").buffer as ArrayBuffer);
    const strandedPath = "bc1qstranded/strandedfile.txt";
    await attachmentWriter.write(strandedPath, new TextEncoder().encode("STRANDED-BYTES").buffer as ArrayBuffer);

    const diskBefore = await listDiskFiles();
    expect(diskBefore).toContain(normalizeStored(collidingPath));
    expect(diskBefore).toContain(strandedPath);

    await restoreV3Backup({ source: blobChunks(backupBlob), attachmentWriter });

    const diskAfter = await listDiskFiles();
    // The colliding (now-restored) file survives; the unrelated stranded file is gone.
    expect(diskAfter).toContain(normalizeStored(collidingPath));
    expect(diskAfter).not.toContain(strandedPath);
    // Its bytes are the RESTORED bytes, not the stale prior ones.
    expect(await fetchBytesViaPath(collidingPath, "text/plain")).toBe(
      "RESTORED-COLLIDING-BYTES",
    );
  });

  it("enumerates cleanup through bounded pages instead of one full filename array", async () => {
    const sink = new MemorySink();
    await exportBackup({ sink: sink as any, encrypted: false, batchSize: 50, attachmentIO });
    const backupBlob = sink.blob as Blob;

    const oldCount = 1_205;
    for (let i = 0; i < oldCount; i += 1) {
      await attachmentWriter.write(
        `old/${String(i).padStart(4, "0")}.txt`,
        new Uint8Array([i % 251]).buffer,
      );
    }

    const requestedLimits: number[] = [];
    const cleanupProgress: Array<{ percent: number; phase: string }> = [];
    const pagedWriter = {
      ...attachmentWriter,
      async listPage(cursor: string | null, limit: number) {
        requestedLimits.push(limit);
        expect(limit).toBeLessThanOrEqual(500);
        return attachmentWriter.listPage(cursor, limit);
      },
    };

    await restoreV3Backup({
      source: blobChunks(backupBlob),
      attachmentWriter: pagedWriter,
      onProgress(progress) {
        if (progress.phase.startsWith("Cleaning up old attachment files")) {
          cleanupProgress.push(progress);
        }
      },
    });

    expect(requestedLimits.length).toBeGreaterThan(2);
    expect(Math.max(...requestedLimits)).toBeLessThan(oldCount);
    expect(cleanupProgress.map((progress) => progress.phase)).toEqual([
      "Cleaning up old attachment files...",
      "Cleaning up old attachment files... 500 of 1205",
      "Cleaning up old attachment files... 1000 of 1205",
      "Cleaning up old attachment files... 1205 of 1205",
    ]);
    expect(cleanupProgress.map((progress) => progress.percent)).toEqual([95, 96, 98, 99]);
    expect(await listDiskFiles()).toEqual([]);
  });
});

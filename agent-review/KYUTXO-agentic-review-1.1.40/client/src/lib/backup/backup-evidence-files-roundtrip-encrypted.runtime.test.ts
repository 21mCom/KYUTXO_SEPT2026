// Full-pipeline guard that evidence attachment FILE BYTES survive a real v3
// ENCRYPTED backup: export (encrypted + password) -> zip -> wipe (DB + on-disk
// files) -> restore (same password) -> open.
//
// The sibling test (`backup-evidence-files-roundtrip.runtime.test.ts`) proves
// this for an UNENCRYPTED v3 backup. Encrypted backups take a DIFFERENT export
// path: a key is derived from the password, the password-check sentinel is
// written + verified, and the inline manifest (which carries `evidence` +
// `evidenceAttachments`) is run through the WebCrypto PBKDF2/AES-GCM envelope.
// Attachment FILE BYTES themselves ride uncompressed/unencrypted in the zip in
// both modes, but a regression in the encrypted manifest round-trip could leave
// the evidence DB links broken (or dropped) while the files are present on disk
// — the exact "files present, can't open them" failure this task family guards
// against, untested for encrypted backups until now.
//
// This test mirrors the unencrypted harness with the REAL pieces:
//   - the REAL Express attachments backend (`server/attachments.ts`) serving
//     REAL files from a temp `KYUTXO_DATA_DIR` on disk,
//   - the REAL web-mode client file layer (`uploadFile` / `getFileBlob`),
//   - the REAL `exportBackup` ENCRYPTED with a password, and
//   - the REAL `restoreV3Backup` decrypting with the same password.
//
// It asserts three things:
//   1. An encrypted backup round-trips evidence files and they open via their
//      restored `objectStoragePath` with the original bytes, AND
//   2. the #488 id-shift remap still resolves each restored attachment to the
//      SAME evidence it was linked to (collisions pre-seeded before restore), AND
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
  tmpDataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "kyutxo-backup-evidence-enc-"),
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

describe("v3 ENCRYPTED backup full pipeline: evidence files survive export -> wipe -> restore", () => {
  it("re-materialises evidence attachment bytes from an encrypted zip and they open via their restored path (ids shift)", async () => {
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
    //    walks them (evidence/evidenceAttachments ride inline in the ENCRYPTED
    //    manifest; their FILES ride as attachment entries discovered via
    //    list-all).
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

    // 4. Export a real, full v3 ENCRYPTED backup to a Blob. The attachmentIO
    //    reads the evidence files OFF DISK through the download endpoint, so
    //    their bytes must land inside the zip for restore to recover them.
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

    // 7. Restore the ENCRYPTED zip through the REAL orchestrator with the SAME
    //    password. The AttachmentFileWriter writes evidence file bytes back to
    //    disk via the write endpoint.
    const result = await restoreV3Backup({
      source: blobChunks(blob),
      password: PASSWORD,
      attachmentWriter,
    });
    // Sanity-check the round-trip really went through the encrypted path.
    expect(result.manifest.encrypted).toBe(true);
    expect(result.counts.attachmentFiles).toBe(plan.length);

    // 8. The restored evidence ids must DIFFER from any plausible backup id
    //    (proving the #488 id-shift path was actually exercised) and there must
    //    be exactly our three restored rows among the collisions.
    const allEvidence = await evidenceCrud.getAllEvidence();
    const restored = allEvidence.filter((e) => pathByTitle.has(e.title));
    expect(restored).toHaveLength(3);

    // 9. End-to-end assertion: open EACH restored attachment via its
    //    objectStoragePath and confirm the bytes belong to the SAME evidence it
    //    is linked to. A dropped-file export would fail to open; a broken
    //    encrypted manifest remap would resolve to the wrong evidence's bytes.
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

  it("rejects a wrong-password restore BEFORE any destructive clear (vault left intact)", async () => {
    // 1. Seed real evidence + on-disk files and export an ENCRYPTED backup.
    const plan = [
      { title: "Receipt", filename: "r.txt", bytes: "RECEIPT-BYTES" },
      { title: "Wire", filename: "w.txt", bytes: "WIRE-BYTES" },
    ];
    const pathByTitle = new Map<string, string>();
    for (const p of plan) {
      pathByTitle.set(
        p.title,
        await uploadFile(fileWithBytes(p.filename, "text/plain", p.bytes)),
      );
    }
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
    //    DB evidence + attachment rows are unchanged...
    const evidenceAfter = await evidenceCrud.getAllEvidence();
    expect(new Set(evidenceAfter.map((e) => e.title))).toEqual(
      new Set(plan.map((p) => p.title)),
    );
    const attachmentsAfter = await evidenceCrud.getAllEvidenceAttachments();
    expect(attachmentsAfter).toHaveLength(plan.length);

    // ...and the on-disk files still open via their original paths.
    for (const p of plan) {
      const bytes = await fetchBytesViaPath(pathByTitle.get(p.title)!, "text/plain");
      expect(bytes).toBe(p.bytes);
    }
  });
});

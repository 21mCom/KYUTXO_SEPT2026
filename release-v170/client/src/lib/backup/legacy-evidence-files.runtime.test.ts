// End-to-end guard that a legacy (pre-v3) backup's evidence FILES actually open
// after restore — not just that the database links are correct.
//
// Task #488 fixed the database link between restored evidence rows and their
// attachments: evidence rows get FRESH autoincrement ids on restore (clear()
// does NOT reset IndexedDB key generation), so every evidence attachment's
// `evidenceId` must be remapped to the new evidence id (see
// `restoreLegacyEvidence`). Its unit test, however, runs over fake-indexeddb
// only — it proves the DB pointer is right but NOT that the pointer resolves to
// a real, readable file on disk. A correct link that points at a missing or
// wrong file would still pass that test while the user sees a broken document.
//
// This test closes that gap. It wires up the REAL pieces:
//   - the REAL Express attachments backend (`server/attachments.ts`) serving
//     REAL files from a temp `KYUTXO_DATA_DIR` on disk,
//   - the REAL web-mode client file layer (`uploadFile` / `getFileBlob`, which
//     POST/GET `/api/attachments/...`), bridged to the test server by a
//     `global.fetch` shim that resolves the client's relative URLs,
//   - the REAL `restoreLegacyEvidence` restore path over fake-indexeddb.
// It then restores a legacy backup whose evidence ids SHIFT on restore (the
// exact #488 scenario, forced by pre-seeding the evidence table so the backup
// ids collide with unrelated pre-existing rows) and asserts that EACH restored
// attachment's `objectStoragePath` fetches the bytes belonging to the SAME
// evidence it is linked to. A broken remap (attachment left on a stale backup
// id) would resolve to the wrong evidence's file and fail here; a dangling
// pointer would fail to fetch at all (covered explicitly too).

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
let restoreLegacyEvidence: typeof import("./legacy-restore-misc").restoreLegacyEvidence;
let bulkAddEvidence: typeof import("@/lib/data/evidence-crud").bulkAddEvidence;
let addEvidenceAttachment: typeof import("@/lib/data/evidence-crud").addEvidenceAttachment;
let getAllEvidence: typeof import("@/lib/data/evidence-crud").getAllEvidence;
let getAllEvidenceAttachments: typeof import("@/lib/data/evidence-crud").getAllEvidenceAttachments;
let clearEvidence: typeof import("@/lib/data/evidence-crud").clearEvidence;
let clearEvidenceAttachments: typeof import("@/lib/data/evidence-crud").clearEvidenceAttachments;

beforeAll(async () => {
  tmpDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "kyutxo-evidence-"));
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
  // them against the test server so the real upload/download path is exercised.
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
  restoreLegacyEvidence = (await import("./legacy-restore-misc")).restoreLegacyEvidence;
  const evidenceCrud = await import("@/lib/data/evidence-crud");
  bulkAddEvidence = evidenceCrud.bulkAddEvidence;
  addEvidenceAttachment = evidenceCrud.addEvidenceAttachment;
  getAllEvidence = evidenceCrud.getAllEvidence;
  getAllEvidenceAttachments = evidenceCrud.getAllEvidenceAttachments;
  clearEvidence = evidenceCrud.clearEvidence;
  clearEvidenceAttachments = evidenceCrud.clearEvidenceAttachments;
});

afterAll(async () => {
  global.fetch = originalFetch;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (tmpDataDir) await fs.rm(tmpDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await clearEvidenceAttachments({ skipNotification: true });
  await clearEvidence({ skipNotification: true });
});

function fileWithBytes(name: string, mime: string, text: string): File {
  return new File([new TextEncoder().encode(text)], name, { type: mime });
}

async function fetchBytesViaPath(objectStoragePath: string, mime: string): Promise<string> {
  const blob = await getFileBlob(objectStoragePath, mime);
  return new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()));
}

describe("legacy restore: evidence files open via their restored path", () => {
  it("each restored attachment fetches the file belonging to the SAME evidence after ids shift", async () => {
    // 1. Pre-seed UNRELATED evidence so the table's autoincrement key generator
    //    is advanced. After this the backup ids 1/2/3 will collide with these
    //    pre-existing live ids — a broken remap would silently link a restored
    //    attachment to one of these instead of to its real evidence.
    await bulkAddEvidence(
      [
        { title: "Pre-existing A", documentType: "other", tags: [], partiesInvolved: [] } as any,
        { title: "Pre-existing B", documentType: "other", tags: [], partiesInvolved: [] } as any,
        { title: "Pre-existing C", documentType: "other", tags: [], partiesInvolved: [] } as any,
      ],
      { skipNotification: true },
    );

    // 2. Put REAL files on disk for the backup's evidence, each with distinct,
    //    title-identifiable bytes, and capture the path the backup row records.
    const plan = [
      { backupId: 1, title: "Coinbase Receipt 2021", filename: "receipt.txt", bytes: "RECEIPT-BYTES-COINBASE" },
      { backupId: 2, title: "Bank Wire Confirmation", filename: "wire.txt", bytes: "WIRE-BYTES-BANK" },
      { backupId: 3, title: "Cold Storage Photo", filename: "photo.txt", bytes: "PHOTO-BYTES-COLDSTORAGE" },
    ];
    const pathByBackupId = new Map<number, string>();
    for (const p of plan) {
      const storagePath = await uploadFile(fileWithBytes(p.filename, "text/plain", p.bytes));
      pathByBackupId.set(p.backupId, storagePath);
    }

    // 3. Build the legacy backup payload. Evidence carry backup ids 1/2/3;
    //    attachments reference those backup ids (one per evidence).
    const backupEvidence = plan.map((p) => ({
      id: p.backupId,
      title: p.title,
      documentType: "receipt",
      tags: [],
      partiesInvolved: [],
    }));
    const backupAttachments = plan.map((p) => ({
      id: p.backupId * 10,
      evidenceId: p.backupId,
      filename: p.filename,
      mimeType: "text/plain",
      size: p.bytes.length,
      objectStoragePath: pathByBackupId.get(p.backupId)!,
    }));

    // 4. Run the REAL legacy restore path.
    const result = await restoreLegacyEvidence(backupEvidence, backupAttachments);
    expect(result.evidenceAdded).toBe(3);
    expect(result.evidenceAttachmentsAdded).toBe(3);

    // 5. The restored evidence must have ids DIFFERENT from the backup ids
    //    (proving ids shifted — the #488 scenario is actually exercised).
    const allEvidence = await getAllEvidence();
    const restored = allEvidence.filter((e) => e.title.startsWith("Coinbase") || e.title.startsWith("Bank") || e.title.startsWith("Cold"));
    expect(restored).toHaveLength(3);
    for (const ev of restored) {
      expect([1, 2, 3]).not.toContain(ev.id);
    }

    // 6. The end-to-end assertion: for EACH restored attachment, open the file
    //    via its objectStoragePath and confirm the bytes belong to the SAME
    //    evidence the attachment is linked to. Build evidence id -> title and
    //    title -> expected bytes maps so a wrong link is caught by content.
    const titleById = new Map(allEvidence.map((e) => [e.id!, e.title]));
    const expectedBytesByTitle = new Map(plan.map((p) => [p.title, p.bytes]));

    const restoredAttachments = await getAllEvidenceAttachments();
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

  it("a restored attachment whose file is missing on disk fails to open (dangling pointer is caught)", async () => {
    // Restore a single evidence + attachment, then DELETE the underlying file so
    // the DB pointer is correct but the bytes are gone. The methodology above
    // would catch this in production (the document won't open).
    const storagePath = await uploadFile(
      fileWithBytes("doomed.txt", "text/plain", "WILL-BE-DELETED"),
    );

    await restoreLegacyEvidence(
      [{ id: 7, title: "Doomed Evidence", documentType: "other", tags: [], partiesInvolved: [] }],
      [
        {
          id: 70,
          evidenceId: 7,
          filename: "doomed.txt",
          mimeType: "text/plain",
          size: 15,
          objectStoragePath: storagePath,
        },
      ],
    );

    // Remove the file from disk (stored path is "attachments/<dir>/<file>" and
    // the data dir holds it under <dataDir>/attachments/<dir>/<file>).
    const onDisk = path.join(tmpDataDir, storagePath);
    await fs.rm(onDisk, { force: true });

    const atts = await getAllEvidenceAttachments();
    expect(atts).toHaveLength(1);
    await expect(
      fetchBytesViaPath(atts[0].objectStoragePath, atts[0].mimeType),
    ).rejects.toThrow();
  });
});

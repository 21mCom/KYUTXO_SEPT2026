// End-to-end guard that a legacy (pre-v3) backup's RECORD attachment FILES
// actually open after restore — not just that the database links are correct.
//
// `legacy-restore.runtime.test.ts` already proves the DB linkage for record
// attachments over fake-indexeddb: records get FRESH autoincrement ids on
// restore (clear() does NOT reset IndexedDB key generation), so every
// attachment's backup `recordId` must be remapped to the new live record id
// (see `restoreLegacyRecords` / `restoreLegacyAttachments`). That test, however,
// only checks the pointer — it does NOT prove the pointer resolves to a real,
// readable file on disk. An attachment whose link is correct but points at a
// missing or wrong file would still pass that test while the user sees a broken
// document.
//
// This test closes that gap for RECORDS (the parallel of #541's evidence
// coverage). It wires up the REAL pieces:
//   - the REAL Express attachments backend (`server/attachments.ts`) serving
//     REAL files from a temp `KYUTXO_DATA_DIR` on disk,
//   - the REAL web-mode client file layer (`uploadFile` / `getFileBlob`, which
//     POST/GET `/api/attachments/...`), bridged to the test server by a
//     `global.fetch` shim that resolves the client's relative URLs,
//   - the REAL `restoreLegacyRecords` + `restoreLegacyAttachments` restore path
//     over fake-indexeddb.
// It then restores a legacy backup whose record ids SHIFT on restore (forced by
// pre-seeding the records table so the backup ids collide with unrelated
// pre-existing rows) and asserts that EACH restored attachment's
// `objectStoragePath` fetches the bytes belonging to the SAME record it is
// linked to. A broken recordId remap (attachment left on a stale backup id)
// would resolve to the wrong record's file and fail here; a dangling pointer
// would fail to fetch at all (covered explicitly too).

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
let restoreLegacyRecords: typeof import("./legacy-restore").restoreLegacyRecords;
let restoreLegacyAttachments: typeof import("./legacy-restore").restoreLegacyAttachments;
let bulkCreateRecords: typeof import("@/lib/data/record-crud").bulkCreateRecords;
let getAllRecords: typeof import("@/lib/data/record-crud").getAllRecords;
let clearAllRecords: typeof import("@/lib/data/record-crud").clearAllRecords;
let getAllAttachments: typeof import("@/lib/data/attachments-crud").getAllAttachments;
let clearAttachments: typeof import("@/lib/data/attachments-crud").clearAttachments;
let getRecordsByInputStrings: typeof import("@/lib/data/record-crud").getRecordsByInputStrings;

beforeAll(async () => {
  tmpDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "kyutxo-record-att-"));
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
  const legacyRestore = await import("./legacy-restore");
  restoreLegacyRecords = legacyRestore.restoreLegacyRecords;
  restoreLegacyAttachments = legacyRestore.restoreLegacyAttachments;
  const recordCrud = await import("@/lib/data/record-crud");
  bulkCreateRecords = recordCrud.bulkCreateRecords;
  getAllRecords = recordCrud.getAllRecords;
  clearAllRecords = recordCrud.clearAllRecords;
  getRecordsByInputStrings = recordCrud.getRecordsByInputStrings;
  const attCrud = await import("@/lib/data/attachments-crud");
  getAllAttachments = attCrud.getAllAttachments;
  clearAttachments = attCrud.clearAttachments;
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

function fileWithBytes(name: string, mime: string, text: string): File {
  return new File([new TextEncoder().encode(text)], name, { type: mime });
}

async function fetchBytesViaPath(objectStoragePath: string, mime: string): Promise<string> {
  const blob = await getFileBlob(objectStoragePath, mime);
  return new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()));
}

describe("legacy restore: record attachment files open via their restored path", () => {
  it("each restored attachment fetches the file belonging to the SAME record after ids shift", async () => {
    // 1. Pre-seed UNRELATED records so the table's autoincrement key generator
    //    is advanced. After this the backup ids 1/2/3 will collide with these
    //    pre-existing live ids — a broken recordId remap would silently link a
    //    restored attachment to one of these instead of to its real record.
    await bulkCreateRecords(
      [
        { type: "address", inputString: "preexisting-a", label: "Pre A", tags: [], categories: [] } as any,
        { type: "address", inputString: "preexisting-b", label: "Pre B", tags: [], categories: [] } as any,
        { type: "address", inputString: "preexisting-c", label: "Pre C", tags: [], categories: [] } as any,
      ],
      { skipNotification: true, skipVocabularySync: true },
    );

    // 2. Put REAL files on disk for the backup's record attachments, each with
    //    distinct, identifiable bytes, and capture the path the backup records.
    const plan = [
      { backupId: 1, inputString: "bc1qaddress-receipt", label: "Address Receipt", filename: "receipt.txt", bytes: "RECEIPT-BYTES-ADDRESS-1" },
      { backupId: 2, inputString: "txid-wire-confirm", label: "Tx Wire Confirm", filename: "wire.txt", bytes: "WIRE-BYTES-TX-2" },
      { backupId: 3, inputString: "bc1qaddress-coldstorage", label: "Cold Storage", filename: "photo.txt", bytes: "PHOTO-BYTES-ADDRESS-3" },
    ];
    const pathByBackupId = new Map<number, string>();
    for (const p of plan) {
      const storagePath = await uploadFile(fileWithBytes(p.filename, "text/plain", p.bytes));
      pathByBackupId.set(p.backupId, storagePath);
    }

    // 3. Build the legacy backup payload. Records carry backup ids 1/2/3;
    //    attachments reference those backup ids (one per record).
    const backupRecords = plan.map((p) => ({
      id: p.backupId,
      type: p.inputString.startsWith("txid") ? "transaction" : "address",
      inputString: p.inputString,
      label: p.label,
      tags: [],
      categories: [],
    }));
    const backupAttachments = plan.map((p) => ({
      id: p.backupId * 10,
      recordId: p.backupId,
      filename: p.filename,
      mimeType: "text/plain",
      size: p.bytes.length,
      objectStoragePath: pathByBackupId.get(p.backupId)!,
    }));

    // 4. Run the REAL legacy restore path (records first to build the id map,
    //    then attachments which remap their recordId through it).
    const recordIdMap = new Map<number, number>();
    const recResult = await restoreLegacyRecords(backupRecords, "replace", recordIdMap);
    expect(recResult.recordsAdded).toBe(3);
    const attAdded = await restoreLegacyAttachments(backupAttachments, "replace", recordIdMap);
    expect(attAdded).toBe(3);

    // 5. The restored records must have ids DIFFERENT from the backup ids
    //    (proving ids shifted — the remap scenario is actually exercised).
    const allRecords = await getAllRecords();
    const restored = allRecords.filter((r) =>
      plan.some((p) => p.inputString === r.inputString),
    );
    expect(restored).toHaveLength(3);
    for (const rec of restored) {
      expect([1, 2, 3]).not.toContain(rec.id);
    }

    // 6. The end-to-end assertion: for EACH restored attachment, open the file
    //    via its objectStoragePath and confirm the bytes belong to the SAME
    //    record the attachment is linked to. Build record id -> inputString and
    //    inputString -> expected bytes maps so a wrong link is caught by content.
    const inputStringById = new Map(allRecords.map((r) => [r.id!, r.inputString]));
    const expectedBytesByInputString = new Map(plan.map((p) => [p.inputString, p.bytes]));

    const restoredAttachments = await getAllAttachments();
    expect(restoredAttachments).toHaveLength(3);

    for (const att of restoredAttachments) {
      const linkedInputString = inputStringById.get(att.recordId);
      // The attachment must point at one of the RESTORED record rows, never a
      // pre-existing collision row.
      expect(expectedBytesByInputString.has(linkedInputString ?? "")).toBe(true);

      const actualBytes = await fetchBytesViaPath(att.objectStoragePath, att.mimeType);
      expect(actualBytes).toBe(expectedBytesByInputString.get(linkedInputString!));
    }
  });

  it("a restored attachment whose file is missing on disk fails to open (dangling pointer is caught)", async () => {
    // Restore a single record + attachment, then DELETE the underlying file so
    // the DB pointer is correct but the bytes are gone. The methodology above
    // would catch this in production (the document won't open).
    const storagePath = await uploadFile(
      fileWithBytes("doomed.txt", "text/plain", "WILL-BE-DELETED"),
    );

    const recordIdMap = new Map<number, number>();
    await restoreLegacyRecords(
      [{ id: 7, type: "address", inputString: "bc1qdoomed", label: "Doomed", tags: [], categories: [] }],
      "replace",
      recordIdMap,
    );
    await restoreLegacyAttachments(
      [
        {
          id: 70,
          recordId: 7,
          filename: "doomed.txt",
          mimeType: "text/plain",
          size: 15,
          objectStoragePath: storagePath,
        },
      ],
      "replace",
      recordIdMap,
    );

    // Remove the file from disk (stored path is "attachments/<dir>/<file>" and
    // the data dir holds it under <dataDir>/attachments/<dir>/<file>).
    const onDisk = path.join(tmpDataDir, storagePath);
    await fs.rm(onDisk, { force: true });

    const atts = await getAllAttachments();
    expect(atts).toHaveLength(1);
    await expect(
      fetchBytesViaPath(atts[0].objectStoragePath, atts[0].mimeType),
    ).rejects.toThrow();
  });
});

describe("legacy restore (MERGE mode): merged attachments bind to the right pre-existing record", () => {
  it("each merged attachment fetches the file of the SAME pre-existing record it links to (no same-id collision)", async () => {
    // The merge danger: a backup record carries id N, and a pre-existing live
    // record happens to ALSO have id N but a DIFFERENT inputString. Merge mode
    // must link the attachment to the record whose `inputString` MATCHES (which
    // here has a different live id), never to the same-id "decoy" record.
    //
    // We force that collision DETERMINISTICALLY: instead of assuming the backup
    // ids land on specific live ids (clearAllRecords() does NOT reset Dexie's
    // autoincrement, so seeded ids are unpredictable across tests), we read back
    // the actual live ids of the decoy records and USE THOSE as the backup ids.
    // The matching records have different live ids, so a same-id-link bug would
    // bind each attachment to a decoy.

    // 1. Seed decoy records whose inputStrings DO NOT appear in the backup.
    //    Their live ids become the backup record ids below, so each backup id
    //    collides with a decoy that must never receive a merged attachment.
    const decoyIds = await bulkCreateRecords(
      [
        { type: "address", inputString: "decoy-one", label: "Decoy 1", tags: [], categories: [] } as any,
        { type: "address", inputString: "decoy-two", label: "Decoy 2", tags: [], categories: [] } as any,
        { type: "address", inputString: "decoy-three", label: "Decoy 3", tags: [], categories: [] } as any,
      ],
      { skipNotification: true, skipVocabularySync: true },
    );
    expect(decoyIds).toHaveLength(3);

    // 2. Seed the REAL pre-existing records the backup will collide with by
    //    inputString. Their live ids are assigned AFTER the decoys, so they
    //    differ from the decoy (= backup) ids — the same-id collision is live.
    //    backupId is bound to the decoy id so the collision is guaranteed.
    const plan = [
      { backupId: decoyIds[0], inputString: "bc1qmerge-receipt", label: "Merge Receipt", filename: "receipt.txt", bytes: "MERGE-RECEIPT-BYTES-1" },
      { backupId: decoyIds[1], inputString: "txid-merge-wire", label: "Merge Wire", filename: "wire.txt", bytes: "MERGE-WIRE-BYTES-2" },
      { backupId: decoyIds[2], inputString: "bc1qmerge-cold", label: "Merge Cold", filename: "photo.txt", bytes: "MERGE-PHOTO-BYTES-3" },
    ];
    const matchIds = await bulkCreateRecords(
      plan.map((p) => ({
        type: p.inputString.startsWith("txid") ? "transaction" : "address",
        inputString: p.inputString,
        label: `Existing ${p.label}`,
        tags: [],
        categories: [],
      })) as any,
      { skipNotification: true, skipVocabularySync: true },
    );
    expect(matchIds).toHaveLength(3);

    const existingMatches = await getRecordsByInputStrings(plan.map((p) => p.inputString));
    expect(existingMatches).toHaveLength(3);
    const liveIdByInputString = new Map(existingMatches.map((r) => [r.inputString, r.id!]));

    // Assert the collision precondition is REAL and deterministic: for each
    // plan entry the backup id equals a decoy's live id, and that decoy's
    // inputString differs from the matching record's (so linking by id is wrong),
    // while the matching record's live id differs from the backup id.
    const decoyInputStringById = new Map([
      [decoyIds[0], "decoy-one"],
      [decoyIds[1], "decoy-two"],
      [decoyIds[2], "decoy-three"],
    ]);
    for (const p of plan) {
      expect(decoyInputStringById.has(p.backupId)).toBe(true);
      expect(decoyInputStringById.get(p.backupId)).not.toBe(p.inputString);
      expect(liveIdByInputString.get(p.inputString)).not.toBe(p.backupId);
    }

    // 3. Put REAL files on disk for each backup attachment, with distinct bytes.
    const pathByBackupId = new Map<number, string>();
    for (const p of plan) {
      const storagePath = await uploadFile(fileWithBytes(p.filename, "text/plain", p.bytes));
      pathByBackupId.set(p.backupId, storagePath);
    }

    // 4. Build the legacy backup payload: records keyed by backup ids 1/2/3,
    //    each with one attachment referencing that backup id.
    const backupRecords = plan.map((p) => ({
      id: p.backupId,
      type: p.inputString.startsWith("txid") ? "transaction" : "address",
      inputString: p.inputString,
      label: p.label,
      tags: [],
      categories: [],
    }));
    const backupAttachments = plan.map((p) => ({
      id: p.backupId * 10,
      recordId: p.backupId,
      filename: p.filename,
      mimeType: "text/plain",
      size: p.bytes.length,
      objectStoragePath: pathByBackupId.get(p.backupId)!,
    }));

    // 5. Run the REAL merge restore path. All three backup records collide by
    //    inputString, so NO new records are created — the backup ids are mapped
    //    to the pre-existing matching live ids.
    const recordIdMap = new Map<number, number>();
    const recResult = await restoreLegacyRecords(backupRecords, "merge", recordIdMap);
    expect(recResult.recordsAdded).toBe(0);
    expect(recResult.recordsSkipped).toBe(3);
    for (const p of plan) {
      expect(recordIdMap.get(p.backupId)).toBe(liveIdByInputString.get(p.inputString));
    }

    const attAdded = await restoreLegacyAttachments(backupAttachments, "merge", recordIdMap);
    expect(attAdded).toBe(3);

    // 6. No new records were created by the merge (decoys + matches only).
    const allRecords = await getAllRecords();
    expect(allRecords).toHaveLength(6);

    // 7. End-to-end assertion: for EACH merged attachment, open the file via its
    //    objectStoragePath and confirm the bytes belong to the SAME record it is
    //    linked to — and that record is a real match, never a decoy.
    const inputStringById = new Map(allRecords.map((r) => [r.id!, r.inputString]));
    const expectedBytesByInputString = new Map(plan.map((p) => [p.inputString, p.bytes]));
    const decoyInputStrings = new Set(["decoy-one", "decoy-two", "decoy-three"]);

    const restoredAttachments = await getAllAttachments();
    expect(restoredAttachments).toHaveLength(3);

    for (const att of restoredAttachments) {
      const linkedInputString = inputStringById.get(att.recordId);
      // Must link to a real matching record, never a same-id decoy.
      expect(decoyInputStrings.has(linkedInputString ?? "")).toBe(false);
      expect(expectedBytesByInputString.has(linkedInputString ?? "")).toBe(true);

      const actualBytes = await fetchBytesViaPath(att.objectStoragePath, att.mimeType);
      expect(actualBytes).toBe(expectedBytesByInputString.get(linkedInputString!));
    }
  });

  it("a repeated merge de-dups by objectStoragePath and never creates duplicate attachment rows", async () => {
    // Seed one pre-existing record the backup collides with by inputString.
    await bulkCreateRecords(
      [{ type: "address", inputString: "bc1qmerge-dedup", label: "Existing Dedup", tags: [], categories: [] } as any],
      { skipNotification: true, skipVocabularySync: true },
    );

    const storagePath = await uploadFile(
      fileWithBytes("dedup.txt", "text/plain", "MERGE-DEDUP-BYTES"),
    );

    const backupRecords = [
      { id: 99, type: "address", inputString: "bc1qmerge-dedup", label: "Dedup", tags: [], categories: [] },
    ];
    const backupAttachments = [
      {
        id: 990,
        recordId: 99,
        filename: "dedup.txt",
        mimeType: "text/plain",
        size: "MERGE-DEDUP-BYTES".length,
        objectStoragePath: storagePath,
      },
    ];

    // First merge: record skipped (already exists), attachment added once.
    const map1 = new Map<number, number>();
    const rec1 = await restoreLegacyRecords(backupRecords, "merge", map1);
    expect(rec1.recordsSkipped).toBe(1);
    expect(await restoreLegacyAttachments(backupAttachments, "merge", map1)).toBe(1);
    expect(await getAllAttachments()).toHaveLength(1);

    // Second merge of the SAME backup: attachment de-duped by objectStoragePath,
    // so no duplicate file row is created.
    const map2 = new Map<number, number>();
    await restoreLegacyRecords(backupRecords, "merge", map2);
    expect(await restoreLegacyAttachments(backupAttachments, "merge", map2)).toBe(0);

    const atts = await getAllAttachments();
    expect(atts).toHaveLength(1);

    // The single surviving attachment still opens and points at the correct
    // pre-existing record's file bytes.
    const allRecords = await getAllRecords();
    const linked = allRecords.find((r) => r.id === atts[0].recordId);
    expect(linked?.inputString).toBe("bc1qmerge-dedup");
    expect(await fetchBytesViaPath(atts[0].objectStoragePath, atts[0].mimeType)).toBe(
      "MERGE-DEDUP-BYTES",
    );
  });
});

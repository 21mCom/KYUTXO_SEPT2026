// @vitest-environment jsdom
//
// End-to-end regression guard for `runLegacyJsonRestore` — the legacy
// whole-file JSON restore ORCHESTRATION extracted out of the Settings restore
// component into `./legacy-restore-pipeline`. The individual helpers it calls
// (restoreLegacyRecords, restoreLegacyAttachments, …) are well tested on their
// own; these tests drive the pipeline function itself over a real in-memory
// legacy ZIP + the live `@/lib/database` schema (fake-indexeddb) and assert:
//   - replace mode: the destructive clear runs, `onCleared` fires exactly once,
//     AFTER the "Clearing existing data..." progress step and BEFORE any
//     restore step, pre-existing data is gone, and the returned baseMessage
//     reports the restored counts ("Restored N records, ...").
//   - merge mode: `onCleared` never fires, pre-existing rows survive, colliding
//     records are de-duped, and the baseMessage uses the "Added N records
//     (M skipped)" phrasing.
//   - encrypted backups: correct password restores; wrong/missing password
//     throws the user-presentable errors without touching the vault.
//   - attachment file routing (web mode): linked files go through the
//     /api/attachments/write endpoint and are counted in the baseMessage;
//     orphaned files (owning record absent) are ROUTED (counted in
//     orphanedFilesRouted), never posted to the attachment-write endpoint, and
//     their metadata rows are not linked to any record.
//   - a ZIP without backup.json throws "Invalid backup file".

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import JSZip from "jszip";

import { runLegacyJsonRestore } from "./legacy-restore-pipeline";
import {
  deriveKey,
  encrypt,
  generateSalt,
  bufferToBase64,
  LEGACY_PBKDF2_ITERATIONS,
} from "@/lib/crypto";
import {
  clearAllRecords,
  bulkCreateRecords,
  getAllRecords,
} from "@/lib/data/record-crud";
import { clearAttachments, getAllAttachments } from "@/lib/data/attachments-crud";
import {
  clearTransactions,
  clearParticipants,
  getAllTransactions,
  getAllTransactionParticipants,
} from "@/lib/data/transaction-crud";
import {
  clearAddressSyncState,
  getAllAddressSyncState,
} from "@/lib/data/address-sync-crud";
import {
  clearRecordOrigins,
  getAllRecordOrigins,
  addRecordOrigin,
} from "@/lib/data/record-origins-crud";
import { db } from "@/lib/database";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function backupRecord(id: number, inputString: string) {
  return {
    id,
    type: "address",
    inputString,
    label: `Label ${inputString}`,
    tags: [],
    categories: [],
  };
}

/** The backup `data` payload: 2 records, 1 tag, 1 category, attachments
 *  (one bound to each record + one orphan), 1 tx + participant, 1 sync row. */
function makeBackupData() {
  return {
    records: [backupRecord(101, "addr-a"), backupRecord(102, "addr-b")],
    tags: [{ id: 1, name: "tag-1", color: "#ff0000", createdAt: 1_700_000_000 }],
    categories: [{ id: 1, name: "cat-1", color: "#00ff00", createdAt: 1_700_000_000 }],
    attachments: [
      { id: 1, recordId: 101, filename: "a.pdf", mimeType: "application/pdf", size: 10, objectStoragePath: "hash-a" },
      { id: 2, recordId: 102, filename: "b.pdf", mimeType: "application/pdf", size: 20, objectStoragePath: "hash-b" },
      // ORPHAN: backup recordId 999 is never restored.
      { id: 3, recordId: 999, filename: "orphan.pdf", mimeType: "application/pdf", size: 30, objectStoragePath: "hash-orphan" },
    ],
    customFields: [],
    blockchainTransactions: [
      { id: 1, txid: "tx-1", blockHeight: 800000, blockTime: 1_700_000_000, fee: 1000, feeRate: 5, syncedAt: 1_700_000_100 },
    ],
    transactionParticipants: [
      { id: 1, txid: "tx-1", role: "output", address: "addr-a", amount: 5000, recordId: 101 },
    ],
    addressSyncState: [
      { id: 1, address: "addr-a", recordId: 101, lastSyncedHeight: 800000, lastSyncedAt: 1_700_000_000, txCount: 1 },
    ],
  };
}

/** Attachment file bytes stored under attachments/<objectStoragePath>. */
function addAttachmentFiles(zip: JSZip) {
  const folder = zip.folder("attachments")!;
  folder.file("hash-a", new Uint8Array([1, 2, 3]));
  folder.file("hash-b", new Uint8Array([4, 5, 6]));
  folder.file("hash-orphan", new Uint8Array([7, 8, 9]));
}

async function makePlainZip(data: unknown): Promise<File> {
  const zip = new JSZip();
  zip.file("backup.json", JSON.stringify({ encrypted: false, data }));
  addAttachmentFiles(zip);
  return zipToFile(zip);
}

async function makeEncryptedZip(data: unknown, password: string): Promise<File> {
  const salt = generateSalt();
  // Legacy backups were only ever written at the pre-strengthening count.
  const key = await deriveKey(password, salt, LEGACY_PBKDF2_ITERATIONS);
  const ciphertext = await encrypt(JSON.stringify(data), key);
  const zip = new JSZip();
  zip.file(
    "backup.json",
    JSON.stringify({ encrypted: true, salt: bufferToBase64(salt), data: ciphertext }),
  );
  addAttachmentFiles(zip);
  return zipToFile(zip);
}

async function zipToFile(zip: JSZip): Promise<File> {
  // runLegacyJsonRestore only passes the file to JSZip.loadAsync, which
  // accepts an ArrayBuffer directly (jsdom's File lacks the arrayBuffer
  // support JSZip needs in this environment).
  const buf = await zip.generateAsync({ type: "arraybuffer" });
  return buf as unknown as File;
}

// ---------------------------------------------------------------------------
// Test harness: progress/cleared event recorder + web attachment-write stub
// ---------------------------------------------------------------------------

type Ev = { kind: "progress"; percent: number; message: string } | { kind: "cleared" };

function makeCallbacks() {
  const events: Ev[] = [];
  return {
    events,
    cb: {
      onProgress: (percent: number, message: string) => {
        events.push({ kind: "progress", percent, message });
      },
      onCleared: () => {
        events.push({ kind: "cleared" });
      },
    },
  };
}

/** Paths posted to /api/attachments/write (web-mode non-orphan file writes). */
let writtenPaths: string[];

beforeEach(async () => {
  await clearAllRecords({ skipNotification: true });
  await db.tags.clear();
  await db.categories.clear();
  await clearAttachments({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
  await clearAddressSyncState({ skipNotification: true });
  await clearRecordOrigins({ skipNotification: true });

  writtenPaths = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url) === "/api/attachments/write") {
        const form = init?.body as FormData;
        writtenPaths.push(String(form.get("relativePath")));
        return { ok: true, json: async () => ({}) } as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runLegacyJsonRestore: replace mode (plaintext)", () => {
  it("clears pre-existing data, fires onCleared at the right time, restores every table, and reports counts", async () => {
    // Pre-existing vault content that a replace restore must wipe.
    await bulkCreateRecords(
      [{ type: "address", inputString: "pre-existing", label: "Old", tags: [], categories: [] } as any],
      { skipNotification: true, skipVocabularySync: true },
    );

    const file = await makePlainZip(makeBackupData());
    const { events, cb } = makeCallbacks();

    const summary = await runLegacyJsonRestore(file, "", "replace", cb);

    // onCleared fired exactly once, after the clearing progress step and
    // before any restore progress step.
    const clearedIdx = events.findIndex((e) => e.kind === "cleared");
    expect(events.filter((e) => e.kind === "cleared")).toHaveLength(1);
    const clearingIdx = events.findIndex(
      (e) => e.kind === "progress" && e.message.startsWith("Clearing"),
    );
    const restoringIdx = events.findIndex(
      (e) => e.kind === "progress" && e.message.startsWith("Restoring"),
    );
    expect(clearingIdx).toBeGreaterThanOrEqual(0);
    expect(clearedIdx).toBeGreaterThan(clearingIdx);
    expect(clearedIdx).toBeLessThan(restoringIdx);

    // Pre-existing record is gone; only the backup's records remain.
    const records = await getAllRecords();
    expect(records).toHaveLength(2);
    expect(new Set(records.map((r) => r.inputString))).toEqual(new Set(["addr-a", "addr-b"]));

    // Dependent tables restored with recordId remapped to live ids.
    const liveA = records.find((r) => r.inputString === "addr-a")!.id;
    const attachments = await getAllAttachments();
    expect(attachments).toHaveLength(2); // orphan metadata not linked
    expect(attachments.find((a) => a.objectStoragePath === "hash-a")!.recordId).toBe(liveA);
    expect(await getAllTransactions()).toHaveLength(1);
    const parts = await getAllTransactionParticipants();
    expect(parts).toHaveLength(1);
    expect(parts[0].recordId).toBe(liveA);
    const sync = await getAllAddressSyncState();
    expect(sync).toHaveLength(1);
    expect(sync[0].recordId).toBe(liveA);

    // Vocabulary restored.
    expect(await db.tags.count()).toBe(1);
    expect(await db.categories.count()).toBe(1);

    // Only the two LINKED files were posted to the attachment-write endpoint;
    // the orphan file was routed (web mode counts it routed), not written.
    expect(new Set(writtenPaths)).toEqual(new Set(["hash-a", "hash-b"]));
    expect(summary.orphanedFilesRouted).toBe(1);
    expect(summary.orphanedFilesLost).toBe(0);

    // Summary message reports the restored counts.
    expect(summary.baseMessage).toContain("Restored 2 records");
    expect(summary.baseMessage).toContain("1 tags");
    expect(summary.baseMessage).toContain("1 categories");
    expect(summary.baseMessage).toContain("2 attachment files");
    expect(summary.baseMessage).toContain("1 transactions");
    expect(summary.baseMessage).toContain("1 synced addresses");
    expect(summary.baseMessage).not.toContain("failed");
  });
});

describe("runLegacyJsonRestore: recordOrigins (source history)", () => {
  it("replace mode: remaps recordOrigin recordIds through the id map and re-inserts them; rows for absent records are dropped", async () => {
    const data = {
      ...makeBackupData(),
      recordOrigins: [
        { id: 1, recordId: 101, originType: "manual", source: "manual-entry", createdAt: 1_700_000_001 },
        { id: 2, recordId: 102, originType: "bulk-import", source: "csv-import", label: "B", createdAt: 1_700_000_002 },
        // Owning record 999 is never restored — must be dropped, not mislinked.
        { id: 3, recordId: 999, originType: "manual", source: "manual-entry", createdAt: 1_700_000_003 },
      ],
    };
    const file = await makePlainZip(data);
    const { cb } = makeCallbacks();

    await runLegacyJsonRestore(file, "", "replace", cb);

    const records = await getAllRecords();
    const liveA = records.find((r) => r.inputString === "addr-a")!.id;
    const liveB = records.find((r) => r.inputString === "addr-b")!.id;

    const origins = await getAllRecordOrigins();
    expect(origins).toHaveLength(2);
    const oA = origins.find((o) => o.source === "manual-entry")!;
    const oB = origins.find((o) => o.source === "csv-import")!;
    expect(oA.recordId).toBe(liveA);
    expect(oA.createdAt).toBe(1_700_000_001);
    expect(oB.recordId).toBe(liveB);
    expect(oB.label).toBe("B");
  });

  it("merge mode: de-dupes by recordId + originType + source + createdAt against live rows and within the backup", async () => {
    // Pre-existing record colliding with backup record "addr-a", carrying a
    // live origin identical (by natural key) to one in the backup.
    const [existingId] = await bulkCreateRecords(
      [{ type: "address", inputString: "addr-a", label: "Existing", tags: [], categories: [] } as any],
      { skipNotification: true, skipVocabularySync: true },
    );
    await addRecordOrigin(
      { recordId: existingId, originType: "manual", source: "manual-entry", createdAt: 1_700_000_001 },
      { skipNotification: true },
    );

    const data = {
      ...makeBackupData(),
      recordOrigins: [
        // Duplicate of the live origin (same natural key) — must be skipped.
        { id: 1, recordId: 101, originType: "manual", source: "manual-entry", createdAt: 1_700_000_001 },
        // New origin for the same record — must be added.
        { id: 2, recordId: 101, originType: "bulk-import", source: "csv-import", createdAt: 1_700_000_002 },
        // Same-batch duplicate of the row above — only one inserted.
        { id: 3, recordId: 101, originType: "bulk-import", source: "csv-import", createdAt: 1_700_000_002 },
      ],
    };
    const file = await makePlainZip(data);
    const { cb } = makeCallbacks();

    await runLegacyJsonRestore(file, "", "merge", cb);

    const origins = await getAllRecordOrigins();
    const forExisting = origins.filter((o) => o.recordId === existingId);
    expect(forExisting).toHaveLength(2);
    expect(forExisting.filter((o) => o.source === "manual-entry")).toHaveLength(1);
    expect(forExisting.filter((o) => o.source === "csv-import")).toHaveLength(1);
  });

  it("backups without a recordOrigins table restore cleanly with zero origins", async () => {
    const file = await makePlainZip(makeBackupData()); // no recordOrigins key
    const { cb } = makeCallbacks();
    const summary = await runLegacyJsonRestore(file, "", "replace", cb);
    expect(summary.baseMessage).toContain("Restored 2 records");
    expect(await getAllRecordOrigins()).toHaveLength(0);
  });
});

describe("runLegacyJsonRestore: merge mode (plaintext)", () => {
  it("never fires onCleared, keeps pre-existing rows, de-dups colliding records, and uses the Added phrasing", async () => {
    // Pre-existing record colliding with backup record "addr-a".
    const [existingId] = await bulkCreateRecords(
      [{ type: "address", inputString: "addr-a", label: "Existing", tags: [], categories: [] } as any],
      { skipNotification: true, skipVocabularySync: true },
    );

    const file = await makePlainZip(makeBackupData());
    const { events, cb } = makeCallbacks();

    const summary = await runLegacyJsonRestore(file, "", "merge", cb);

    expect(events.some((e) => e.kind === "cleared")).toBe(false);

    // addr-a de-duped against the existing record; addr-b added.
    const records = await getAllRecords();
    expect(records).toHaveLength(2);
    expect(records.filter((r) => r.inputString === "addr-a")).toHaveLength(1);
    expect(records.find((r) => r.inputString === "addr-a")!.id).toBe(existingId);

    // Dependent rows for the SKIPPED record link to the pre-existing live id.
    const parts = await getAllTransactionParticipants();
    expect(parts).toHaveLength(1);
    expect(parts[0].recordId).toBe(existingId);
    const attachments = await getAllAttachments();
    expect(attachments.find((a) => a.objectStoragePath === "hash-a")!.recordId).toBe(existingId);

    expect(summary.baseMessage).toContain("Added 1 records (1 skipped)");
    expect(summary.orphanedFilesRouted).toBe(1);
  });
});

describe("runLegacyJsonRestore: web-mode attachment write failures", () => {
  it("counts a non-ok /api/attachments/write response into the '(N failed)' summary while the other file restores", async () => {
    // Re-stub fetch so the write for hash-b fails with a non-ok response.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url) === "/api/attachments/write") {
          const form = init?.body as FormData;
          const relativePath = String(form.get("relativePath"));
          if (relativePath === "hash-b") {
            return {
              ok: false,
              statusText: "Internal Server Error",
              json: async () => ({ error: "disk full" }),
            } as Response;
          }
          writtenPaths.push(relativePath);
          return { ok: true, json: async () => ({}) } as Response;
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const file = await makePlainZip(makeBackupData());
    const { cb } = makeCallbacks();

    const summary = await runLegacyJsonRestore(file, "", "replace", cb);

    // The failed web write surfaces as "(1 failed)" alongside the one
    // successfully restored file.
    expect(summary.baseMessage).toContain("1 attachment files (1 failed)");

    // The other linked file was still written and the restore completed.
    expect(writtenPaths).toEqual(["hash-a"]);
    expect(await getAllRecords()).toHaveLength(2);

    // Orphan routing unaffected by the linked-file failure.
    expect(summary.orphanedFilesRouted).toBe(1);
    expect(summary.orphanedFilesLost).toBe(0);
  });
});

describe("runLegacyJsonRestore: encrypted backups", () => {
  it("decrypts with the correct password and restores", async () => {
    const file = await makeEncryptedZip(makeBackupData(), "hunter2");
    const { cb } = makeCallbacks();

    const summary = await runLegacyJsonRestore(file, "hunter2", "replace", cb);

    expect(summary.baseMessage).toContain("Restored 2 records");
    expect(await getAllRecords()).toHaveLength(2);
  });

  it("throws the wrong-password error before touching the vault", async () => {
    await bulkCreateRecords(
      [{ type: "address", inputString: "keep-me", label: "Keep", tags: [], categories: [] } as any],
      { skipNotification: true, skipVocabularySync: true },
    );

    const file = await makeEncryptedZip(makeBackupData(), "hunter2");
    const { events, cb } = makeCallbacks();

    await expect(runLegacyJsonRestore(file, "wrong", "replace", cb)).rejects.toThrow(
      "Invalid password or corrupted backup",
    );
    // Wrong password fails BEFORE the destructive clear: vault intact.
    expect(events.some((e) => e.kind === "cleared")).toBe(false);
    expect(await getAllRecords()).toHaveLength(1);
  });

  it("throws when the password is missing", async () => {
    const file = await makeEncryptedZip(makeBackupData(), "hunter2");
    const { cb } = makeCallbacks();
    await expect(runLegacyJsonRestore(file, "", "replace", cb)).rejects.toThrow(
      "Password required for encrypted backup",
    );
  });
});

describe("runLegacyJsonRestore: Electron attachment file routing", () => {
  // Stub window.electronAPI so isElectron() is true and the pipeline takes
  // the desktop branch: linked files via api.writeAttachment, orphans via
  // api.writeNeedsReview.
  let writeAttachment: ReturnType<typeof vi.fn>;
  let writeNeedsReview: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeAttachment = vi.fn(async (_path: string, _data: ArrayBuffer) => ({ success: true }));
    writeNeedsReview = vi.fn(async (_name: string, _data: ArrayBuffer) => ({ success: true }));
    (window as any).electronAPI = {
      isElectron: true,
      writeAttachment,
      writeNeedsReview,
    };
  });

  afterEach(() => {
    delete (window as any).electronAPI;
  });

  it("routes linked files through writeAttachment and orphans through writeNeedsReview, counting orphanedFilesRouted", async () => {
    const file = await makePlainZip(makeBackupData());
    const { cb } = makeCallbacks();

    const summary = await runLegacyJsonRestore(file, "", "replace", cb);

    // Linked files went through writeAttachment (never the web endpoint).
    expect(new Set(writeAttachment.mock.calls.map((c) => c[0]))).toEqual(
      new Set(["hash-a", "hash-b"]),
    );
    expect(writtenPaths).toHaveLength(0);

    // Orphan routed to Needs Review under its ORIGINAL filename.
    expect(writeNeedsReview).toHaveBeenCalledTimes(1);
    expect(writeNeedsReview.mock.calls[0][0]).toBe("orphan.pdf");

    expect(summary.orphanedFilesRouted).toBe(1);
    expect(summary.orphanedFilesLost).toBe(0);
    expect(summary.baseMessage).toContain("2 attachment files");
    expect(summary.baseMessage).not.toContain("failed");
  });

  it("counts a failing writeNeedsReview into orphanedFilesLost without throwing (rejection)", async () => {
    writeNeedsReview.mockRejectedValue(new Error("disk full"));
    const file = await makePlainZip(makeBackupData());
    const { cb } = makeCallbacks();

    const summary = await runLegacyJsonRestore(file, "", "replace", cb);

    expect(summary.orphanedFilesRouted).toBe(0);
    expect(summary.orphanedFilesLost).toBe(1);
    // The lost orphan must NOT bleed into the attachment-file error count.
    expect(summary.baseMessage).toContain("2 attachment files");
    expect(summary.baseMessage).not.toContain("failed");
    // The rest of the restore still completed.
    expect(await getAllRecords()).toHaveLength(2);
  });

  it("counts a { success: false } writeNeedsReview result into orphanedFilesLost", async () => {
    writeNeedsReview.mockResolvedValue({ success: false, error: "permission denied" });
    const file = await makePlainZip(makeBackupData());
    const { cb } = makeCallbacks();

    const summary = await runLegacyJsonRestore(file, "", "replace", cb);

    expect(summary.orphanedFilesRouted).toBe(0);
    expect(summary.orphanedFilesLost).toBe(1);
  });

  it("counts failed writeAttachment calls into the '(N failed)' summary message", async () => {
    writeAttachment.mockImplementation(async (path: string) =>
      path === "hash-b" ? { success: false, error: "nope" } : { success: true },
    );
    const file = await makePlainZip(makeBackupData());
    const { cb } = makeCallbacks();

    const summary = await runLegacyJsonRestore(file, "", "replace", cb);

    expect(summary.baseMessage).toContain("1 attachment files (1 failed)");
    // Orphan routing unaffected by the linked-file failure.
    expect(summary.orphanedFilesRouted).toBe(1);
    expect(summary.orphanedFilesLost).toBe(0);
  });

  it("counts a throwing writeAttachment into the failed-only message when every linked write fails", async () => {
    writeAttachment.mockRejectedValue(new Error("io error"));
    const file = await makePlainZip(makeBackupData());
    const { cb } = makeCallbacks();

    const summary = await runLegacyJsonRestore(file, "", "replace", cb);

    expect(summary.baseMessage).toContain("(2 attachment files failed)");
    expect(summary.orphanedFilesRouted).toBe(1);
  });
});

describe("runLegacyJsonRestore: invalid backups", () => {
  it("throws 'Invalid backup file' when the ZIP has no backup.json", async () => {
    const zip = new JSZip();
    zip.file("something-else.txt", "not a backup");
    const file = await zipToFile(zip);
    const { cb } = makeCallbacks();
    await expect(runLegacyJsonRestore(file, "", "replace", cb)).rejects.toThrow(
      "Invalid backup file",
    );
  });
});

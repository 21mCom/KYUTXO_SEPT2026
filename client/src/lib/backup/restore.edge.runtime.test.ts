// Edge-case coverage for the v3 streaming restore that the bounded round-trip
// guard (roundtrip.runtime.test.ts) does NOT exercise. These cover the riskiest
// restore branches:
//   1. ENCRYPTED v3 export -> restore round-trip, driving the PBKDF2/AES-GCM
//      per-line envelope (the bounded test stays unencrypted on purpose).
//   2. A WRONG (and a MISSING) password fails BEFORE the destructive clear, so
//      the existing vault is left fully intact.
//   3. A legacy pre-v3 backup is rejected by restoreV3Backup (so callers route
//      it to the untouched JSZip path) and likewise leaves the vault intact.
//
// Like the bounded test this runs over the REAL `@/lib/database` schema on
// fake-indexeddb so every CRUD bulk path, the inline reader/writer, and the
// crypto envelope are exercised end to end.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";
import JSZip from "jszip";

import { db } from "@/lib/database";
import { exportBackup, type AttachmentFileIO } from "./export";
import { restoreV3Backup, peekManifest, type AttachmentFileWriter } from "./restore";
import { MemorySink, type BackupSink } from "./sink";
import { blobChunks } from "./zip-stream";
import { isV3Manifest } from "./format";

import {
  bulkCreateRecords,
  clearAllRecords,
  countRecords,
  type CreateRecordData,
} from "@/lib/data/record-crud";
import {
  bulkAddAttachments,
  clearAttachments,
  countAttachments,
  type CreateAttachmentData,
} from "@/lib/data/attachments-crud";
import {
  bulkAddParticipants,
  bulkAddTransactions,
  clearParticipants,
  clearTransactions,
  countTransactions,
  countTransactionParticipants,
  type CreateTransactionData,
} from "@/lib/data/transaction-crud";
import {
  bulkAddAddressSyncState,
  clearAddressSyncState,
  countAddressSyncState,
  type CreateAddressSyncStateData,
} from "@/lib/data/address-sync-crud";
import { restoreTag } from "@/lib/data/vocabulary-crud";
import type { TransactionParticipant } from "@/lib/database";

const N_REC = 8;
const N_TX = 6;
const N_PART = 10;
const N_ATT = 5;
const N_SYNC = 4;
const N_TAGS = 3;
const N_FILES = 3;
const BATCH = 3; // < every big-table count, so multiple NDJSON lines per table

const PASSWORD = "correct horse battery staple";

// In-memory attachment store standing in for the file system.
let sourceFiles: Map<string, Uint8Array>;
let restoredFiles: Map<string, Uint8Array>;

const attachmentIO: AttachmentFileIO = {
  async listAll() {
    return [...sourceFiles.keys()];
  },
  async read(relPath) {
    const v = sourceFiles.get(relPath);
    return v
      ? (v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer)
      : null;
  },
};

const attachmentWriter: AttachmentFileWriter = {
  async write(relPath, data) {
    restoredFiles.set(relPath, new Uint8Array(data));
  },
};

async function clearEverything(): Promise<void> {
  await clearAllRecords({ skipNotification: true });
  await clearAttachments({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearAddressSyncState({ skipNotification: true });
  await db.tags.clear();
}

async function seedVault(): Promise<void> {
  const recRows: CreateRecordData[] = [];
  for (let i = 1; i <= N_REC; i++) {
    const inputString = `addr-${String(i).padStart(5, "0")}`;
    recRows.push({
      type: "address",
      inputString,
      inputStringLower: inputString,
      label: `r${i}`,
      tags: [],
      categories: [],
      addressImportance: "manual",
    } as unknown as CreateRecordData);
  }
  const recordIds = await bulkCreateRecords(recRows, {
    skipNotification: true,
    skipVocabularySync: true,
  });

  const txRows: CreateTransactionData[] = [];
  for (let i = 0; i < N_TX; i++) {
    txRows.push({
      txid: i.toString(16).padStart(64, "0"),
      blockHeight: i,
      blockTime: 1_231_006_505 + i * 600,
      syncedAt: 1,
      hasOpReturn: false,
    } as unknown as CreateTransactionData);
  }
  await bulkAddTransactions(txRows, { skipNotification: true });

  const partRows: TransactionParticipant[] = [];
  for (let i = 0; i < N_PART; i++) {
    partRows.push({
      txid: (i % N_TX).toString(16).padStart(64, "0"),
      role: i % 2 === 0 ? "input" : "output",
      address: `addr-${String((i % N_REC) + 1).padStart(5, "0")}`,
      recordId: recordIds[i % N_REC],
    } as unknown as TransactionParticipant);
  }
  await bulkAddParticipants(partRows, { skipNotification: true });

  const attRows: CreateAttachmentData[] = [];
  for (let i = 0; i < N_ATT; i++) {
    attRows.push({
      recordId: recordIds[i % N_REC],
      filename: `doc-${i}.pdf`,
      mimeType: "application/pdf",
      size: 1024,
      objectStoragePath: `ab/cd/${i}.pdf`,
    } as unknown as CreateAttachmentData);
  }
  await bulkAddAttachments(attRows, { skipNotification: true });

  const syncRows: CreateAddressSyncStateData[] = [];
  for (let i = 0; i < N_SYNC; i++) {
    syncRows.push({
      address: `addr-${String((i % N_REC) + 1).padStart(5, "0")}`,
      recordId: recordIds[i % N_REC],
      lastSyncedHeight: 100 + i,
      lastSyncedAt: 1000 + i,
      txCount: i,
    } as unknown as CreateAddressSyncStateData);
  }
  await bulkAddAddressSyncState(syncRows, { skipNotification: true });

  for (let i = 0; i < N_TAGS; i++) {
    await restoreTag({ name: `tag-${i}`, color: "#888888", createdAt: 1000 + i });
  }

  for (let i = 0; i < N_FILES; i++) {
    sourceFiles.set(`ab/cd/file-${i}.bin`, new Uint8Array([i, i + 1, i + 2, 0xff]));
  }
}

async function liveCounts() {
  return {
    records: await countRecords(),
    transactions: await countTransactions(),
    participants: await countTransactionParticipants(),
    attachments: await countAttachments(),
    sync: await countAddressSyncState(),
    tags: await db.tags.count(),
  };
}

async function exportEncrypted(password: string): Promise<Blob> {
  const sink = new MemorySink();
  await exportBackup({
    sink: sink as BackupSink,
    encrypted: true,
    password,
    batchSize: BATCH,
    attachmentIO,
  });
  return sink.blob as Blob;
}

beforeEach(async () => {
  sourceFiles = new Map();
  restoredFiles = new Map();
  await clearEverything();
});

describe("v3 encrypted restore round-trips", () => {
  it("restores every table + attachment bytes through the AES-GCM envelope", async () => {
    await seedVault();
    const blob = await exportEncrypted(PASSWORD);
    expect(blob).toBeInstanceOf(Blob);

    // The NDJSON payload must actually be encrypted: a base64 AES-GCM envelope,
    // never the plaintext JSON array a wrong-format regression would emit.
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const recordsNdjson = await zip.file("tables/records.ndjson")!.async("text");
    const firstLine = recordsNdjson.split("\n").find((l) => l.trim().length > 0)!;
    expect(firstLine.trim().startsWith("[")).toBe(false);
    expect(/^[A-Za-z0-9+/=]+$/.test(firstLine.trim())).toBe(true);

    // Wipe the live vault so restore truly rebuilds from the encrypted backup.
    await clearEverything();
    expect((await liveCounts()).records).toBe(0);

    const result = await restoreV3Backup({
      source: blobChunks(blob),
      password: PASSWORD,
      attachmentWriter,
    });

    expect(result.manifest.encrypted).toBe(true);
    expect(result.counts.records).toBe(N_REC);
    expect(result.counts.blockchainTransactions).toBe(N_TX);
    expect(result.counts.transactionParticipants).toBe(N_PART);
    expect(result.counts.attachments).toBe(N_ATT);
    expect(result.counts.addressSyncState).toBe(N_SYNC);
    expect(result.counts.attachmentFiles).toBe(N_FILES);

    const live = await liveCounts();
    expect(live.records).toBe(N_REC);
    expect(live.transactions).toBe(N_TX);
    expect(live.participants).toBe(N_PART);
    expect(live.attachments).toBe(N_ATT);
    expect(live.sync).toBe(N_SYNC);
    expect(live.tags).toBe(N_TAGS);

    expect(restoredFiles.size).toBe(N_FILES);
    for (const [path, bytes] of sourceFiles) {
      expect([...(restoredFiles.get(path) ?? [])]).toEqual([...bytes]);
    }
  });
});

describe("v3 encrypted restore rejects bad passwords before clearing", () => {
  it("a WRONG password fails and leaves the existing vault intact", async () => {
    await seedVault();
    const blob = await exportEncrypted(PASSWORD);

    // Re-seed a DIFFERENT live vault (clear + seed) so we can prove the failed
    // restore touched nothing. We reuse the same seed shape; the point is that
    // counts are non-zero before and identical after the failed attempt.
    const before = await liveCounts();
    expect(before.records).toBe(N_REC);

    await expect(
      restoreV3Backup({
        source: blobChunks(blob),
        password: "definitely-the-wrong-password",
        attachmentWriter,
      }),
    ).rejects.toThrow(/invalid password|corrupted/i);

    // Nothing was cleared and no attachment file was written.
    const after = await liveCounts();
    expect(after).toEqual(before);
    expect(restoredFiles.size).toBe(0);
  });

  it("a MISSING password on an encrypted backup also fails before clearing", async () => {
    await seedVault();
    const blob = await exportEncrypted(PASSWORD);

    const before = await liveCounts();
    expect(before.records).toBe(N_REC);

    await expect(
      restoreV3Backup({
        source: blobChunks(blob),
        // no password
        attachmentWriter,
      }),
    ).rejects.toThrow(/password required/i);

    const after = await liveCounts();
    expect(after).toEqual(before);
    expect(restoredFiles.size).toBe(0);
  });
});

describe("legacy pre-v3 backups route away from the v3 restore", () => {
  async function makeLegacyBackup(): Promise<Blob> {
    // Legacy shape: a single backup.json holding the whole vault under `.data`,
    // with NO formatVersion. This is what isV3Manifest must reject.
    const legacy = {
      app: "KYUTXO",
      exportDate: new Date("2024-01-01T00:00:00.000Z").toISOString(),
      encrypted: false,
      data: {
        records: [{ id: 1, inputString: "addr-legacy", type: "address" }],
        tags: [{ name: "legacy", color: "#888888" }],
      },
    };
    const zip = new JSZip();
    zip.file("backup.json", JSON.stringify(legacy));
    // Build as a uint8array and wrap in a Blob ourselves so we never depend on
    // JSZip's environment-specific Blob-output support (node vs browser).
    const u8 = await zip.generateAsync({ type: "uint8array" });
    return new Blob([u8]);
  }

  it("peekManifest reports a non-v3 manifest so callers use the JSZip path", async () => {
    const blob = await makeLegacyBackup();
    const peeked = await peekManifest(blobChunks(blob));
    expect(peeked).not.toBeNull();
    expect(isV3Manifest(peeked)).toBe(false);
    expect((peeked as { data?: unknown }).data).toBeDefined();
  });

  it("restoreV3Backup rejects a legacy backup before clearing the vault", async () => {
    await seedVault();
    const before = await liveCounts();
    expect(before.records).toBe(N_REC);

    const blob = await makeLegacyBackup();
    await expect(
      restoreV3Backup({
        source: blobChunks(blob),
        attachmentWriter,
      }),
    ).rejects.toThrow(/not a v3 backup/i);

    const after = await liveCounts();
    expect(after).toEqual(before);
    expect(restoredFiles.size).toBe(0);
  });
});

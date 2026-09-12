// @vitest-environment jsdom
//
// Runtime round-trip verification for the backup KDF parameter record: v3
// backup manifests record the KDF (algorithm + parameters) alongside the salt,
// and restore must re-derive keys for EVERY parameter era:
//
//   1. a freshly exported encrypted backup carries kdf = CURRENT (Argon2id) and
//      restores with its password (and rejects a wrong one non-destructively),
//   2. a hand-crafted PRE-STRENGTHENING backup (key derived at LEGACY 100k,
//      manifest with NO kdfIterations/kdf field — exactly what an old build
//      wrote) still restores,
//   3. a STRENGTHENING-ERA backup (PBKDF2 600k, kdfIterations only) still
//      restores,
//   4. getBackupKdfParams resolves absent → legacy PBKDF2, kdfIterations →
//      PBKDF2 at that count, explicit kdf → itself.
//
// Drives the REAL export -> zip -> restore pipeline over the REAL
// `@/lib/database` schema on fake-indexeddb, mirroring the compact-roundtrip
// harness.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";

import { exportBackup, type AttachmentFileIO } from "./export";
import { restoreV3Backup, type AttachmentFileWriter } from "./restore";
import { MemorySink } from "./sink";
import { blobChunks } from "./zip-stream";
import { ZipStreamWriter } from "./zip-stream";
import {
  BACKUP_FORMAT_VERSION,
  CHECK_SENTINEL,
  MANIFEST_FILENAME,
  STREAMED_TABLES,
  getBackupKdfIterations,
  getBackupKdfParams,
  serializeInline,
  type BackupManifest,
} from "./format";
import {
  deriveKey,
  encrypt,
  generateSalt,
  bufferToBase64,
  LEGACY_PBKDF2_ITERATIONS,
  CURRENT_PBKDF2_ITERATIONS,
  CURRENT_KDF_PARAMS,
} from "@/lib/crypto";
import { clearAllRecords } from "@/lib/data/record-crud";
import { clearAttachments } from "@/lib/data/attachments-crud";
import { clearParticipants, clearTransactions } from "@/lib/data/transaction-crud";
import { clearAddressSyncState } from "@/lib/data/address-sync-crud";
import {
  clearUtxoLineage,
  clearCustodySegments,
  clearLineageSnapshots,
} from "@/lib/data/lineage-crud";

const PASSWORD = "backup-encryption-password";

const attachmentIO: AttachmentFileIO = {
  async listAll() {
    return [];
  },
  async read() {
    return null;
  },
};

const attachmentWriter: AttachmentFileWriter = {
  async write() {
    /* no files in these fixtures */
  },
};

async function clearEverything(): Promise<void> {
  await clearAllRecords();
  await clearAttachments();
  await clearParticipants();
  await clearTransactions();
  await clearAddressSyncState();
  await clearUtxoLineage();
  await clearCustodySegments();
  await clearLineageSnapshots();
}

async function exportEncryptedZip(): Promise<Blob> {
  const sink = new MemorySink();
  await exportBackup({
    sink,
    encrypted: true,
    password: PASSWORD,
    attachmentIO,
  });
  return sink.blob as Blob;
}

// Builds a v3 zip byte-for-byte the way an older PBKDF2-era build did: key
// derived at the given iteration count, manifest carries salt + check and
// (for the strengthening era only) a kdfIterations field — never a kdf record.
async function buildPbkdf2EncryptedZip(iterations: number, recordIterations: boolean): Promise<Blob> {
  const salt = generateSalt();
  const key = await deriveKey(PASSWORD, salt, iterations);
  const manifest: BackupManifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    app: "KYUTXO",
    appVersion: "3.0.0-legacy",
    exportDate: new Date().toISOString(),
    encrypted: true,
    salt: bufferToBase64(salt),
    // Pre-strengthening builds never wrote kdfIterations; strengthening-era
    // builds wrote kdfIterations but never a kdf record.
    ...(recordIterations ? { kdfIterations: iterations } : {}),
    check: await encrypt(CHECK_SENTINEL, key),
    counts: {
      records: 0,
      blockchainTransactions: 0,
      transactionParticipants: 0,
      attachments: 0,
      addressSyncState: 0,
      utxoLineage: 0,
      custodySegments: 0,
      lineageSnapshots: 0,
      attachmentFiles: 0,
    },
    totalAttachmentBytes: 0,
    streamedTables: [...STREAMED_TABLES],
    ...(await serializeInline({}, key)),
  };

  const sink = new MemorySink();
  const writer = new ZipStreamWriter(sink);
  await writer.addBytes(
    MANIFEST_FILENAME,
    new TextEncoder().encode(JSON.stringify(manifest)),
  );
  await writer.finalize();
  return sink.blob as Blob;
}

beforeEach(clearEverything);

describe("getBackupKdfIterations", () => {
  it("maps an absent field to the legacy count and a recorded field to itself", () => {
    const base = { formatVersion: BACKUP_FORMAT_VERSION } as BackupManifest;
    expect(getBackupKdfIterations(base)).toBe(LEGACY_PBKDF2_ITERATIONS);
    expect(getBackupKdfIterations({ ...base, kdfIterations: 600000 })).toBe(600000);
  });
});

describe("getBackupKdfParams", () => {
  it("resolves each manifest era to its parameters", () => {
    const base = { formatVersion: BACKUP_FORMAT_VERSION } as BackupManifest;
    expect(getBackupKdfParams(base)).toEqual({
      algorithm: "pbkdf2-sha256",
      iterations: LEGACY_PBKDF2_ITERATIONS,
    });
    expect(getBackupKdfParams({ ...base, kdfIterations: 600000 })).toEqual({
      algorithm: "pbkdf2-sha256",
      iterations: 600000,
    });
    expect(getBackupKdfParams({ ...base, kdf: CURRENT_KDF_PARAMS })).toEqual(
      CURRENT_KDF_PARAMS,
    );
  });
});

describe("encrypted backup with current (Argon2id) parameters", () => {
  it("exports kdf = CURRENT (Argon2id) and round-trips through restore", async () => {
    const blob = await exportEncryptedZip();

    const result = await restoreV3Backup({
      source: blobChunks(blob),
      password: PASSWORD,
      attachmentWriter,
    });
    expect(result.manifest.kdf).toEqual(CURRENT_KDF_PARAMS);
    expect(result.manifest.kdf?.algorithm).toBe("argon2id");
    // Argon2id-era exports no longer write the PBKDF2-only field.
    expect(result.manifest.kdfIterations).toBeUndefined();
    expect(result.counts.records).toBe(0);
  });

  it("rejects a wrong password non-destructively", async () => {
    const blob = await exportEncryptedZip();
    await expect(
      restoreV3Backup({
        source: blobChunks(blob),
        password: "wrong-password",
        attachmentWriter,
      }),
    ).rejects.toThrow(/password|corrupt/i);
  });
});

describe("encrypted backup with strengthened (600k PBKDF2) parameters", () => {
  it("restores a strengthening-era manifest (kdfIterations only, no kdf)", async () => {
    const blob = await buildPbkdf2EncryptedZip(CURRENT_PBKDF2_ITERATIONS, true);

    const result = await restoreV3Backup({
      source: blobChunks(blob),
      password: PASSWORD,
      attachmentWriter,
    });
    expect(result.manifest.kdfIterations).toBe(CURRENT_PBKDF2_ITERATIONS);
    expect(result.manifest.kdf).toBeUndefined();
    expect(result.counts.records).toBe(0);
  });
});

describe("encrypted backup with legacy (pre-strengthening) parameters", () => {
  it("restores a manifest that records no kdfIterations", async () => {
    const blob = await buildPbkdf2EncryptedZip(LEGACY_PBKDF2_ITERATIONS, false);

    const result = await restoreV3Backup({
      source: blobChunks(blob),
      password: PASSWORD,
      attachmentWriter,
    });
    expect(result.manifest.kdfIterations).toBeUndefined();
    expect(result.counts.records).toBe(0);
  });

  it("rejects a wrong password on a legacy-parameters backup", async () => {
    const blob = await buildPbkdf2EncryptedZip(LEGACY_PBKDF2_ITERATIONS, false);
    await expect(
      restoreV3Backup({
        source: blobChunks(blob),
        password: "wrong-password",
        attachmentWriter,
      }),
    ).rejects.toThrow(/password|corrupt/i);
  });
});

import { describe, expect, it } from "vitest";
import {
  BACKUP_FORMAT_VERSION,
  classifyBackupManifest,
} from "./format";

const counts = {
  records: 0,
  blockchainTransactions: 0,
  transactionParticipants: 0,
  attachments: 0,
  addressSyncState: 0,
  utxoLineage: 0,
  custodySegments: 0,
  lineageSnapshots: 0,
  attachmentFiles: 0,
};

describe("backup format compatibility classification", () => {
  it("accepts stable pre-v3 plaintext and encrypted envelopes", () => {
    expect(classifyBackupManifest({ encrypted: false, data: { records: [] } })).toBe(false);
    expect(
      classifyBackupManifest({ encrypted: true, salt: "AA==", data: "authenticated-ciphertext" }),
    ).toBe(false);
  });

  it("accepts a complete v3 manifest", () => {
    expect(
      classifyBackupManifest({
        formatVersion: BACKUP_FORMAT_VERSION,
        app: "KYUTXO",
        appVersion: "1.1.69",
        exportDate: "2026-09-10T00:00:00.000Z",
        encrypted: false,
        counts,
        streamedTables: [],
        inline: {},
      }),
    ).toBe(true);
  });

  it.each([
    { formatVersion: BACKUP_FORMAT_VERSION, encrypted: false, data: { records: [] } },
    { streamedTables: [], encrypted: false, data: { records: [] } },
    { counts, encrypted: false, data: { records: [] } },
  ])("rejects damaged v3-looking manifests instead of legacy fallback", (manifest) => {
    expect(() => classifyBackupManifest(manifest)).toThrow("Invalid v3 backup manifest");
  });

  it("rejects unknown future backup versions explicitly", () => {
    expect(() =>
      classifyBackupManifest({
        formatVersion: BACKUP_FORMAT_VERSION + 1,
        app: "KYUTXO",
        appVersion: "future",
        exportDate: "2026-09-10T00:00:00.000Z",
        encrypted: false,
        counts,
        streamedTables: [],
      }),
    ).toThrow("Invalid v3 backup manifest");
  });
});
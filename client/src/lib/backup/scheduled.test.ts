import { describe, expect, it } from "vitest";
import {
  isBackupDue,
  normalizeBackupSchedule,
  selectBackupsForRotation,
  verifyScheduledBackup,
} from "./scheduled";
import { MemorySink } from "./sink";
import { ZipStreamWriter } from "./zip-stream";
import {
  MANIFEST_FILENAME,
  STREAMED_TABLES,
  ndjsonPath,
  type BackupManifest,
} from "./format";

function at(value: string): number {
  return new Date(`${value}T12:00:00.000Z`).getTime();
}

async function buildArchive(rows = 0, manifestCount = rows): Promise<Blob> {
  const sink = new MemorySink();
  const writer = new ZipStreamWriter(sink);
  const manifest: BackupManifest = {
    formatVersion: 3,
    app: "KYUTXO",
    appVersion: "test",
    exportDate: new Date(0).toISOString(),
    encrypted: false,
    counts: {
      records: manifestCount,
      attachments: 0,
      transactionParticipants: 0,
      addressSyncState: 0,
      blockchainTransactions: 0,
      utxoLineage: 0,
      custodySegments: 0,
      lineageSnapshots: 0,
      attachmentFiles: 0,
    },
    streamedTables: [...STREAMED_TABLES],
    inline: {},
  };
  await writer.addBytes(MANIFEST_FILENAME, new TextEncoder().encode(JSON.stringify(manifest)));
  for (const table of STREAMED_TABLES) {
    const parts = table === "records" && rows > 0
      ? (async function* () {
          const batchSize = 250;
          for (let offset = 0; offset < rows; offset += batchSize) {
            const batch = Array.from({ length: Math.min(batchSize, rows - offset) }, (_, i) => ({ id: offset + i + 1 }));
            yield `${JSON.stringify(batch)}\n`;
          }
        })()
      : (async function* () {})();
    await writer.addFile(ndjsonPath(table), parts);
  }
  await writer.finalize();
  return sink.blob!;
}

describe("scheduled backup policy", () => {
  it("normalizes unsafe settings and caps destinations", () => {
    const value = normalizeBackupSchedule({
      enabled: true,
      destinations: [
        { token: "a".repeat(32), label: "one", path: "/one" },
        { token: "b".repeat(32), label: "two", path: "/two" },
        { token: "c".repeat(32), label: "three", path: "/three" },
      ],
      cadenceDays: 7,
      retentionCount: -20,
      compact: false,
      encrypted: true,
      promptBehavior: "ask",
    });
    expect(value.destinations.map((destination) => destination.path)).toEqual(["/one", "/two"]);
    expect(value.retentionCount).toBe(1);
  });

  it("runs only after the configured cadence", () => {
    const now = at("2026-09-02");
    expect(isBackupDue(undefined, 7, now)).toBe(true);
    expect(isBackupDue(now - 6 * 86400000, 7, now)).toBe(false);
    expect(isBackupDue(now - 7 * 86400000, 7, now)).toBe(true);
  });

  it("keeps newest copies, one monthly checkpoint, and never the only copy", () => {
    const files = [
      { name: "sep-new.zip", modifiedAt: at("2026-09-20"), sizeBytes: 1 },
      { name: "sep-old.zip", modifiedAt: at("2026-09-01"), sizeBytes: 1 },
      { name: "aug-new.zip", modifiedAt: at("2026-08-25"), sizeBytes: 1 },
      { name: "aug-old.zip", modifiedAt: at("2026-08-02"), sizeBytes: 1 },
      { name: "jul.zip", modifiedAt: at("2026-07-10"), sizeBytes: 1 },
    ];
    expect(selectBackupsForRotation(files, 1).map((file) => file.name)).toEqual([
      "sep-old.zip",
      "aug-old.zip",
    ]);
    expect(selectBackupsForRotation(files.slice(0, 1), 0)).toEqual([]);
  });
});

describe("scheduled backup verification", () => {
  it("streams and verifies a large archive without restoring it", async () => {
    const blob = await buildArchive(5000);
    const result = await verifyScheduledBackup(() => (async function* () {
      for (let offset = 0; offset < blob.size; offset += 777) {
        yield new Uint8Array(await blob.slice(offset, offset + 777).arrayBuffer());
      }
    })());
    expect(result.counts.records).toBe(5000);
  });

  it("rejects a manifest count mismatch before promotion", async () => {
    const blob = await buildArchive(10, 11);
    await expect(verifyScheduledBackup(() => (async function* () {
      yield new Uint8Array(await blob.arrayBuffer());
    })())).rejects.toThrow(/count mismatch for records/i);
  });

  it("rejects a ZIP truncated after its local entries", async () => {
    const blob = await buildArchive(1);
    const truncated = blob.slice(0, blob.size - 8);
    await expect(verifyScheduledBackup(() => (async function* () {
      yield new Uint8Array(await truncated.arrayBuffer());
    })())).rejects.toThrow(/end record|central directory/i);
  });

  it("stops scheduled readback immediately when cancelled", async () => {
    const blob = await buildArchive(1);
    const controller = new AbortController();
    controller.abort();
    await expect(verifyScheduledBackup(() => (async function* () {
      yield new Uint8Array(await blob.arrayBuffer());
    })(), undefined, controller.signal)).rejects.toThrow(/cancelled/i);
  });
});
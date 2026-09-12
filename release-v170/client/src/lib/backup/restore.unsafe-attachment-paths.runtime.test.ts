// Crafted-archive adversarial tests for the v3 streaming restore: attachment
// entries whose names escape the attachments dir, and entries whose bytes
// exceed the per-file cap. Both must fail the restore with a CLEAR error and
// must never reach the platform attachment writer (which has its own
// containment as defense-in-depth — verified separately at the HTTP/IPC
// layers).

import "fake-indexeddb/auto";

import { describe, it, expect } from "vitest";

import {
  restoreV3Backup,
  isSafeAttachmentRelPath,
  type AttachmentFileWriter,
} from "./restore";
import { ZipStreamWriter, blobChunks } from "./zip-stream";
import { MemorySink } from "./sink";
import { BACKUP_FORMAT_VERSION, MANIFEST_FILENAME, ATTACHMENTS_DIR } from "./format";

async function craftedZip(
  attachmentEntries: Array<[string, Uint8Array]>,
): Promise<Blob> {
  const sink = new MemorySink();
  const writer = new ZipStreamWriter(sink);
  const manifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    app: "KYUTXO",
    appVersion: "test",
    exportDate: new Date(0).toISOString(),
    encrypted: false,
    counts: {
      records: 0,
      attachments: 0,
      transactionParticipants: 0,
      addressSyncState: 0,
      blockchainTransactions: 0,
      attachmentFiles: attachmentEntries.length,
    },
    streamedTables: [],
    inline: {},
  };
  await writer.addBytes(
    MANIFEST_FILENAME,
    new TextEncoder().encode(JSON.stringify(manifest)),
  );
  for (const [name, bytes] of attachmentEntries) {
    await writer.addBytes(name, bytes, { compress: false });
  }
  await writer.finalize();
  if (!sink.blob) throw new Error("zip was not finalized");
  return sink.blob;
}

// Collects the message of an error and every nested cause, so assertions work
// whether the restore surfaces the raw failure or wraps it (post-clear
// failures are wrapped in RestoreInterruptedError).
function chainMessages(err: unknown): string {
  const messages: string[] = [];
  let cur: unknown = err;
  while (cur) {
    if (typeof cur === "object") {
      const record = cur as { message?: unknown; cause?: unknown; error?: unknown };
      messages.push(
        String(
          record.message ??
            (record.error && typeof record.error === "object"
              ? (record.error as { message?: unknown }).message
              : record.error) ??
            JSON.stringify(cur),
        ),
      );
      cur = record.cause ?? record.error;
    } else {
      messages.push(String(cur));
      cur = undefined;
    }
  }
  return messages.join(" | ");
}

function recordingWriter(): {
  writer: AttachmentFileWriter;
  writes: Map<string, number>;
} {
  const writes = new Map<string, number>();
  return {
    writes,
    writer: {
      async write(relPath, data) {
        writes.set(relPath, data.byteLength);
      },
    },
  };
}

describe("isSafeAttachmentRelPath", () => {
  it("accepts normal attachment paths", () => {
    expect(isSafeAttachmentRelPath("hashdir/opaquefile.bin")).toBe(true);
    expect(isSafeAttachmentRelPath("legacy-root.pdf")).toBe(true);
    expect(isSafeAttachmentRelPath("dir/with spaces/file name.txt")).toBe(true);
  });

  it("rejects traversal, absolute, and malformed paths", () => {
    expect(isSafeAttachmentRelPath("../escape.txt")).toBe(false);
    expect(isSafeAttachmentRelPath("dir/../../escape.txt")).toBe(false);
    expect(isSafeAttachmentRelPath("dir\\..\\escape.txt")).toBe(false);
    expect(isSafeAttachmentRelPath("/etc/passwd")).toBe(false);
    expect(isSafeAttachmentRelPath("C:/windows/system32/x")).toBe(false);
    expect(isSafeAttachmentRelPath("C:\\windows\\x")).toBe(false);
    expect(isSafeAttachmentRelPath("")).toBe(false);
    expect(isSafeAttachmentRelPath("has\0nul")).toBe(false);
    expect(isSafeAttachmentRelPath(42)).toBe(false);
    expect(isSafeAttachmentRelPath(null)).toBe(false);
    expect(isSafeAttachmentRelPath(undefined)).toBe(false);
  });
});

describe("restoreV3Backup with a crafted archive", () => {
  it("rejects an archive whose attachment entry traverses out of the attachments dir", async () => {
    const { writer, writes } = recordingWriter();
    const blob = await craftedZip([
      [`${ATTACHMENTS_DIR}/../evil.txt`, new Uint8Array([1, 2, 3])],
    ]);
    const err = await restoreV3Backup({
      source: blobChunks(blob),
      attachmentWriter: writer,
    }).catch((e: unknown) => e);
    expect(chainMessages(err)).toMatch(/Unsafe attachment path in backup archive/);
    // The traversal path never reached the platform writer.
    expect(writes.size).toBe(0);
  });

  it("rejects an archive whose attachment entry is absolute", async () => {
    const { writer, writes } = recordingWriter();
    const blob = await craftedZip([
      [`${ATTACHMENTS_DIR}//etc/passwd`, new Uint8Array([1])],
    ]);
    const err = await restoreV3Backup({
      source: blobChunks(blob),
      attachmentWriter: writer,
    }).catch((e: unknown) => e);
    expect(chainMessages(err)).toMatch(/Unsafe attachment path in backup archive/);
    expect(writes.size).toBe(0);
  });

  it("skips an attachment entry above the byte cap before buffering it", async () => {
    const { writer, writes } = recordingWriter();
    const blob = await craftedZip([
      [`${ATTACHMENTS_DIR}/dir/big.bin`, new Uint8Array(100).fill(9)],
    ]);
    const err = await restoreV3Backup({
      source: blobChunks(blob, 10),
      attachmentWriter: writer,
      maxAttachmentFileBytes: 32,
    }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(Error);
    const oversizedResult = err as {
      counts: { skippedOversizedAttachmentFiles: number };
      skippedOversizedAttachments: string[];
    };
    expect(oversizedResult.counts.skippedOversizedAttachmentFiles).toBe(1);
    expect(oversizedResult.skippedOversizedAttachments).toEqual(["dir/big.bin"]);
    expect(writes.size).toBe(0);
  });

  it("restores a well-formed attachment entry", async () => {
    const { writer, writes } = recordingWriter();
    const payload = new Uint8Array([5, 6, 7]);
    const blob = await craftedZip([
      [`${ATTACHMENTS_DIR}/dir/file.bin`, payload],
    ]);
    const result = await restoreV3Backup({
      source: blobChunks(blob),
      attachmentWriter: writer,
      maxAttachmentFileBytes: 32,
    });
    expect(writes.get("dir/file.bin")).toBe(payload.length);
    expect(result.counts.attachmentFiles).toBe(1);
  });
});

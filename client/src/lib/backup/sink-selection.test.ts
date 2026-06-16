// @vitest-environment node
//
// Regression tests for export sink selection. These guard against the failure
// mode the code review flagged: when no streaming-to-disk path is available, an
// export must NOT silently buffer the entire archive in memory. Instead it
// either streams to disk (desktop / File System Access API) or, for the
// in-memory fallback, refuses datasets too large (or of unknown size) to hold
// in RAM. The size gate is the AGGREGATE of all streamed large tables, not just
// records — a vault with few records but millions of transactions must block.

import { describe, it, expect } from "vitest";
import { decideExportSinkKind, isMemoryFallbackSafe, ElectronFileSink } from "./sink";

const LIMITS = { memoryRowLimit: 50000, memoryAttachmentLimit: 5000 };
const KNOWN = { countsKnown: true };

describe("decideExportSinkKind", () => {
  it("uses the Electron streaming sink on desktop, even for huge datasets", () => {
    expect(
      decideExportSinkKind({
        isElectron: true,
        supportsElectronBackup: true,
        supportsFileSystemAccess: false,
        totalRowCount: 30_000_000,
        attachmentCount: 50_000,
        ...LIMITS,
        ...KNOWN,
      }),
    ).toBe("electron");
  });

  it("uses the File System Access sink in a capable browser, even for huge datasets", () => {
    expect(
      decideExportSinkKind({
        isElectron: false,
        supportsElectronBackup: false,
        supportsFileSystemAccess: true,
        totalRowCount: 30_000_000,
        attachmentCount: 50_000,
        ...LIMITS,
        ...KNOWN,
      }),
    ).toBe("filesystem");
  });

  it("BLOCKS a huge export when no streaming-to-disk path exists (no File System Access API)", () => {
    // Too many rows (records).
    expect(
      decideExportSinkKind({
        isElectron: false,
        supportsElectronBackup: false,
        supportsFileSystemAccess: false,
        totalRowCount: 100_000,
        attachmentCount: 0,
        ...LIMITS,
        ...KNOWN,
      }),
    ).toBe("blocked");
    // Attachments alone can also trip the guard.
    expect(
      decideExportSinkKind({
        isElectron: false,
        supportsElectronBackup: false,
        supportsFileSystemAccess: false,
        totalRowCount: 0,
        attachmentCount: 50_000,
        ...LIMITS,
        ...KNOWN,
      }),
    ).toBe("blocked");
  });

  it("BLOCKS when records are tiny but transactions/participants are huge (Task #254 scale)", () => {
    // Few records, but the aggregate of the big tables (transactions +
    // participants + addressSyncState) blows past the limit. The earlier guard
    // only looked at recordCount and would have wrongly allowed memory here.
    expect(
      decideExportSinkKind({
        isElectron: false,
        supportsElectronBackup: false,
        supportsFileSystemAccess: false,
        totalRowCount: 100 + 10_000_000 + 20_000_000, // records + tx + participants
        attachmentCount: 0,
        ...LIMITS,
        ...KNOWN,
      }),
    ).toBe("blocked");
  });

  it("BLOCKS when counts are unknown, even if the loaded counts look small (unsafe-by-default)", () => {
    expect(
      decideExportSinkKind({
        isElectron: false,
        supportsElectronBackup: false,
        supportsFileSystemAccess: false,
        totalRowCount: 0,
        attachmentCount: 0,
        ...LIMITS,
        countsKnown: false,
      }),
    ).toBe("blocked");
  });

  it("falls back to an in-memory download only for small datasets of known size without a disk path", () => {
    expect(
      decideExportSinkKind({
        isElectron: false,
        supportsElectronBackup: false,
        supportsFileSystemAccess: false,
        totalRowCount: 100,
        attachmentCount: 10,
        ...LIMITS,
        ...KNOWN,
      }),
    ).toBe("memory");
  });

  it("prefers the Electron sink over File System Access when both are present", () => {
    expect(
      decideExportSinkKind({
        isElectron: true,
        supportsElectronBackup: true,
        supportsFileSystemAccess: true,
        totalRowCount: 1,
        attachmentCount: 1,
        ...LIMITS,
        ...KNOWN,
      }),
    ).toBe("electron");
  });

  it("blocks an Electron build that lacks the backup bridge and has no other disk path", () => {
    expect(
      decideExportSinkKind({
        isElectron: true,
        supportsElectronBackup: false,
        supportsFileSystemAccess: false,
        totalRowCount: 100_000,
        attachmentCount: 0,
        ...LIMITS,
        ...KNOWN,
      }),
    ).toBe("blocked");
  });
});

describe("isMemoryFallbackSafe", () => {
  it("is true only for small, known-size datasets", () => {
    expect(
      isMemoryFallbackSafe({ totalRowCount: 100, attachmentCount: 10, ...LIMITS, ...KNOWN }),
    ).toBe(true);
  });

  it("is false at the unknown-counts and over-limit boundaries", () => {
    // Unknown size.
    expect(
      isMemoryFallbackSafe({ totalRowCount: 0, attachmentCount: 0, ...LIMITS, countsKnown: false }),
    ).toBe(false);
    // Rows over limit.
    expect(
      isMemoryFallbackSafe({ totalRowCount: 50_001, attachmentCount: 0, ...LIMITS, ...KNOWN }),
    ).toBe(false);
    // Attachments over limit.
    expect(
      isMemoryFallbackSafe({ totalRowCount: 0, attachmentCount: 5_001, ...LIMITS, ...KNOWN }),
    ).toBe(false);
    // Exactly at the limits is still safe (inclusive).
    expect(
      isMemoryFallbackSafe({ totalRowCount: 50_000, attachmentCount: 5_000, ...LIMITS, ...KNOWN }),
    ).toBe(true);
  });
});

describe("ElectronFileSink", () => {
  it("streams every chunk straight to disk without buffering the whole archive", async () => {
    // Fake "disk": record byte lengths as chunks arrive. The sink must retain
    // nothing beyond its in-flight tail promise.
    const written: number[] = [];
    let closed = false;
    const api = {
      backupWrite: async (_id: string, data: ArrayBuffer) => {
        written.push(data.byteLength);
        return { success: true };
      },
      backupClose: async (_id: string) => {
        closed = true;
        return { success: true };
      },
      backupAbort: async (_id: string) => ({ success: true }),
    };

    const sink = new ElectronFileSink("bk_test", api);

    const CHUNKS = 1000;
    const CHUNK_SIZE = 64;
    for (let i = 0; i < CHUNKS; i++) {
      sink.write(new Uint8Array(CHUNK_SIZE).fill(i % 256));
      // Apply backpressure periodically, like the export loop does between batches.
      if (i % 100 === 0) await sink.drain();
    }
    await sink.close();

    expect(written.length).toBe(CHUNKS);
    expect(written.every((n) => n === CHUNK_SIZE)).toBe(true);
    expect(closed).toBe(true);
    // Unlike MemorySink, ElectronFileSink keeps no array of chunks: its only
    // state is a tail promise. Assert it exposes no accumulated-bytes buffer.
    expect((sink as unknown as { chunks?: unknown }).chunks).toBeUndefined();
  });

  it("surfaces a write failure on drain and supports best-effort abort", async () => {
    const api = {
      backupWrite: async () => ({ success: false, error: "disk full" }),
      backupClose: async () => ({ success: true }),
      backupAbort: async () => ({ success: true }),
    };
    const sink = new ElectronFileSink("bk_fail", api);
    sink.write(new Uint8Array([1, 2, 3]));
    await expect(sink.drain()).rejects.toThrow(/disk full/);
    await expect(sink.abort()).resolves.toBeUndefined();
  });
});

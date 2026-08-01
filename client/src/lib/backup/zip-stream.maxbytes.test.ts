// Streaming size bound for ZIP entry consumers: a crafted archive must not be
// able to force an unbounded in-memory buffer before the entry completes.

import { describe, it, expect } from "vitest";
import {
  ZipStreamWriter,
  readZipStream,
  collectBytesConsumer,
  blobChunks,
  ZipEntryTooLargeError,
} from "./zip-stream";
import { MemorySink } from "./sink";

async function makeZip(entries: Array<[string, Uint8Array]>): Promise<Blob> {
  const sink = new MemorySink();
  const writer = new ZipStreamWriter(sink);
  for (const [name, bytes] of entries) {
    await writer.addBytes(name, bytes, { compress: false });
  }
  await writer.finalize();
  if (!sink.blob) throw new Error("zip was not finalized");
  return sink.blob;
}

describe("collectBytesConsumer maxBytes", () => {
  it("collects an entry under the cap", async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const blob = await makeZip([["small.bin", payload]]);
    let collected: Uint8Array | null = null;
    await readZipStream(blobChunks(blob, 2), {
      onEntry: () =>
        collectBytesConsumer((bytes) => {
          collected = bytes;
        }, { maxBytes: 8 }),
    });
    expect(collected).not.toBeNull();
    expect([...collected!]).toEqual([...payload]);
  });

  it("aborts an entry the moment it exceeds the cap, before onDone", async () => {
    const payload = new Uint8Array(100).fill(7);
    const blob = await makeZip([["big.bin", payload]]);
    let doneCalled = false;
    const err = await readZipStream(blobChunks(blob, 10), {
      onEntry: () =>
        collectBytesConsumer(() => {
          doneCalled = true;
        }, { maxBytes: 16 }),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZipEntryTooLargeError);
    expect((err as ZipEntryTooLargeError).maxBytes).toBe(16);
    expect(String((err as Error).message)).toMatch(/maximum size/);
    expect(doneCalled).toBe(false);
  });
});

// Thin streaming wrappers over fflate's Zip / Unzip so the rest of the backup
// code can think in terms of "add an async stream of chunks" and "handle each
// entry as its bytes arrive", with memory kept bounded throughout.

import {
  Zip,
  ZipDeflate,
  ZipPassThrough,
  Unzip,
  UnzipInflate,
} from "fflate";
import type { BackupSink } from "./sink";

type Chunk = Uint8Array | string;

const encoder = new TextEncoder();

function toBytes(c: Chunk): Uint8Array {
  return typeof c === "string" ? encoder.encode(c) : c;
}

// Writes a ZIP to a sink one entry at a time. For each entry the LAST chunk is
// pushed with fflate's `final` flag; between pushes we await sink.drain() so the
// producer never races far ahead of the (possibly slow) disk writer.
export class ZipStreamWriter {
  private readonly zip: Zip;
  private error: unknown = null;

  constructor(private readonly sink: BackupSink) {
    this.zip = new Zip((err, data, _final) => {
      if (err) {
        if (this.error == null) this.error = err;
        return;
      }
      if (data && data.length) this.sink.write(data);
    });
  }

  async addFile(
    name: string,
    chunks: AsyncIterable<Chunk>,
    opts: { compress?: boolean } = {},
  ): Promise<void> {
    const compress = opts.compress !== false;
    const file: ZipDeflate | ZipPassThrough = compress
      ? new ZipDeflate(name, { level: 6 })
      : new ZipPassThrough(name);
    this.zip.add(file);

    // Defer one chunk so the final chunk can carry fflate's `final` flag.
    let prev: Uint8Array | null = null;
    for await (const raw of chunks) {
      this.throwIfErrored();
      const bytes = toBytes(raw);
      if (prev !== null) {
        file.push(prev, false);
        await this.sink.drain();
      }
      prev = bytes;
    }
    file.push(prev ?? new Uint8Array(0), true);
    await this.sink.drain();
    this.throwIfErrored();
  }

  async addBytes(
    name: string,
    bytes: Uint8Array,
    opts: { compress?: boolean } = {},
  ): Promise<void> {
    async function* one(): AsyncIterable<Chunk> {
      yield bytes;
    }
    await this.addFile(name, one(), opts);
  }

  async finalize(): Promise<void> {
    this.throwIfErrored();
    this.zip.end();
    await this.sink.drain();
    this.throwIfErrored();
    await this.sink.close();
  }

  private throwIfErrored(): void {
    if (this.error != null) {
      const e = this.error;
      this.error = null;
      throw e;
    }
  }
}

export interface ZipEntryConsumer {
  onChunk(chunk: Uint8Array): Promise<void> | void;
  onEnd(): Promise<void> | void;
}

export interface ZipEntryHandlers {
  // Return a consumer to read the entry, or null to skip its data entirely.
  onEntry(name: string): ZipEntryConsumer | null;
}

// Reads a ZIP from an async source of byte chunks, dispatching each entry to a
// consumer. Entry processing is serialized on a single promise chain and we
// await it after every source push, which applies backpressure: fflate never
// runs more than one source chunk ahead of the (async) consumer work.
export async function readZipStream(
  source: AsyncIterable<Uint8Array>,
  handlers: ZipEntryHandlers,
): Promise<void> {
  const unzip = new Unzip();
  unzip.register(UnzipInflate);

  let pending: Promise<void> = Promise.resolve();
  let firstError: unknown = null;

  unzip.onfile = (file) => {
    const consumer = handlers.onEntry(file.name);
    if (!consumer) return; // not calling start() makes fflate skip the data
    file.ondata = (err, chunk, final) => {
      if (err) {
        if (firstError == null) firstError = err;
        return;
      }
      const copy = chunk && chunk.length ? chunk.slice() : null;
      pending = pending.then(async () => {
        if (firstError != null) return;
        try {
          if (copy) await consumer.onChunk(copy);
          if (final) await consumer.onEnd();
        } catch (e) {
          if (firstError == null) firstError = e;
        }
      });
    };
    file.start();
  };

  for await (const chunk of source) {
    if (firstError != null) break;
    unzip.push(chunk, false);
    await pending; // backpressure
    if (firstError != null) break;
  }
  if (firstError == null) {
    unzip.push(new Uint8Array(0), true);
    await pending;
  }
  if (firstError != null) throw firstError;
}

// Yields a Blob's bytes in chunks without materializing the whole thing. Uses
// the native stream when available, otherwise slices the blob.
export async function* blobChunks(
  blob: Blob,
  chunkSize = 1 << 20,
): AsyncIterable<Uint8Array> {
  const maybeStream = (blob as { stream?: () => ReadableStream<Uint8Array> }).stream;
  if (typeof maybeStream === "function") {
    const reader = maybeStream.call(blob).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
    return;
  }
  let offset = 0;
  while (offset < blob.size) {
    const slice = blob.slice(offset, offset + chunkSize);
    yield new Uint8Array(await slice.arrayBuffer());
    offset += chunkSize;
  }
}

// Consumer that buffers an entry's bytes into one Uint8Array (for small entries
// like the manifest, or a single attachment file).
export function collectBytesConsumer(onDone: (bytes: Uint8Array) => Promise<void> | void): ZipEntryConsumer {
  const parts: Uint8Array[] = [];
  return {
    onChunk(chunk) {
      parts.push(chunk);
    },
    async onEnd() {
      const total = parts.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of parts) {
        out.set(c, off);
        off += c.length;
      }
      await onDone(out);
    },
  };
}

// Consumer that decodes bytes as UTF-8 and emits complete '\n'-terminated lines,
// buffering partial lines across chunk boundaries. Lines are processed one at a
// time through `onLine` (awaited), keeping memory bounded to one line/batch.
export function lineConsumer(onLine: (line: string) => Promise<void> | void): ZipEntryConsumer {
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async onChunk(chunk) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.length) await onLine(line);
        nl = buffer.indexOf("\n");
      }
    },
    async onEnd() {
      buffer += decoder.decode();
      const line = buffer.trim();
      if (line.length) await onLine(line);
      buffer = "";
    },
  };
}

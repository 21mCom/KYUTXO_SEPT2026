// @vitest-environment node
//
// Round-trip unit test for the streaming zip writer/reader — the riskiest piece
// of the backup pipeline. Proves: multi-line NDJSON survives, binary (stored)
// entries survive byte-for-byte, skipped entries are not delivered, and reading
// works regardless of how the archive bytes are chunked across the source.

import { describe, it, expect } from "vitest";
import {
  ZipStreamWriter,
  readZipStream,
  collectBytesConsumer,
  lineConsumer,
} from "./zip-stream";
import { MemorySink } from "./sink";

async function* fromChunks(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield c;
}

function sliceEvery(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    out.push(bytes.slice(i, i + size));
  }
  return out;
}

const dec = new TextDecoder();

async function buildArchive(): Promise<Uint8Array> {
  const sink = new MemorySink();
  const writer = new ZipStreamWriter(sink);
  await writer.addBytes("backup.json", new TextEncoder().encode('{"formatVersion":3}'));
  await writer.addFile(
    "tables/records.ndjson",
    (async function* () {
      yield "[1,2]\n";
      yield "[3,4]\n";
      yield "[5]\n";
    })(),
  );
  await writer.addBytes("attachments/ab/cd.bin", new Uint8Array([0, 1, 2, 3, 250, 255]), {
    compress: false,
  });
  await writer.finalize();
  return sink.getBytes();
}

describe("streaming zip round-trip", () => {
  it("preserves manifest, NDJSON lines and binary bytes", async () => {
    const bytes = await buildArchive();

    let manifest = "";
    const lines: string[] = [];
    let bin: Uint8Array | null = null;

    await readZipStream(fromChunks(bytes), {
      onEntry(name) {
        if (name === "backup.json") {
          return collectBytesConsumer((b) => {
            manifest = dec.decode(b);
          });
        }
        if (name === "tables/records.ndjson") {
          return lineConsumer((line) => {
            lines.push(line);
          });
        }
        if (name === "attachments/ab/cd.bin") {
          return collectBytesConsumer((b) => {
            bin = b;
          });
        }
        return null;
      },
    });

    expect(JSON.parse(manifest)).toEqual({ formatVersion: 3 });
    expect(lines).toEqual(["[1,2]", "[3,4]", "[5]"]);
    expect(bin).not.toBeNull();
    expect(Array.from(bin!)).toEqual([0, 1, 2, 3, 250, 255]);
  });

  it("reassembles lines and bytes when the source is split into tiny chunks", async () => {
    const bytes = await buildArchive();

    const lines: string[] = [];
    let bin: Uint8Array | null = null;

    await readZipStream(fromChunks(...sliceEvery(bytes, 7)), {
      onEntry(name) {
        if (name === "tables/records.ndjson") {
          return lineConsumer((line) => {
            lines.push(line);
          });
        }
        if (name === "attachments/ab/cd.bin") {
          return collectBytesConsumer((b) => {
            bin = b;
          });
        }
        return null;
      },
    });

    expect(lines).toEqual(["[1,2]", "[3,4]", "[5]"]);
    expect(Array.from(bin!)).toEqual([0, 1, 2, 3, 250, 255]);
  });

  it("skips entries whose handler returns null", async () => {
    const bytes = await buildArchive();
    const seen: string[] = [];

    await readZipStream(fromChunks(bytes), {
      onEntry(name) {
        seen.push(name);
        return null; // skip everything
      },
    });

    // onfile still fires for every entry, but no data is delivered.
    expect(seen).toContain("backup.json");
    expect(seen).toContain("tables/records.ndjson");
    expect(seen).toContain("attachments/ab/cd.bin");
  });
});

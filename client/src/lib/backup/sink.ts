// Output sinks for a streaming backup.
//
// A sink receives ZIP byte-chunks from the streaming writer. Two implementations:
//   - FileSystemSink: streams straight to disk via the File System Access API,
//     so the full archive never lives in memory (the scale-safe path).
//   - MemorySink: buffers chunks then hands back one Blob to download. Works
//     everywhere but holds the whole archive in RAM — only a fallback.
//
// fflate may reuse its output buffers between callbacks, and FileSystem writes
// are async, so every chunk is COPIED before it is retained or queued.

export interface BackupSink {
  // Enqueue a chunk. Called synchronously from the zip writer callback.
  write(chunk: Uint8Array): void;
  // Resolves once everything enqueued so far has been flushed. Used for
  // backpressure between batches so memory stays bounded.
  drain(): Promise<void>;
  // Flush + finish successfully.
  close(): Promise<void>;
  // Discard without committing (best-effort).
  abort(): Promise<void>;
}

// User cancelled the native save dialog — distinct from "feature unsupported".
export class BackupCancelledError extends Error {
  constructor(message = "Backup cancelled") {
    super(message);
    this.name = "BackupCancelledError";
  }
}

export class MemorySink implements BackupSink {
  private chunks: Uint8Array[] = [];
  blob: Blob | null = null;

  write(chunk: Uint8Array): void {
    this.chunks.push(chunk.slice());
  }

  async drain(): Promise<void> {
    /* nothing async to wait for */
  }

  async close(): Promise<void> {
    this.blob = new Blob(this.chunks as BlobPart[], { type: "application/zip" });
    // Keep `chunks` so getBytes() stays valid after close; this is a fallback
    // path that already holds the whole archive in memory anyway.
  }

  async abort(): Promise<void> {
    this.chunks = [];
    this.blob = null;
  }

  // Test helper: the full archive as one buffer.
  getBytes(): Uint8Array {
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}

export class FileSystemSink implements BackupSink {
  private tail: Promise<void> = Promise.resolve();
  private failure: unknown = null;

  constructor(private readonly writable: { write: (d: Uint8Array) => Promise<void>; close: () => Promise<void>; abort?: () => Promise<void> }) {}

  write(chunk: Uint8Array): void {
    const copy = chunk.slice();
    this.tail = this.tail.then(() => this.writable.write(copy)).catch((e) => {
      if (this.failure == null) this.failure = e;
    });
  }

  async drain(): Promise<void> {
    await this.tail;
    if (this.failure != null) throw this.failure;
  }

  async close(): Promise<void> {
    await this.drain();
    await this.writable.close();
  }

  async abort(): Promise<void> {
    try {
      await this.writable.abort?.();
    } catch {
      /* best effort */
    }
  }
}

export function supportsFileSystemAccess(): boolean {
  return typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function";
}

// Opens the native save dialog and returns a FileSystemSink, or null when the
// API is unsupported (caller should fall back to MemorySink + download).
// Throws BackupCancelledError if the user dismisses the dialog.
export async function openFileSystemSink(suggestedName: string): Promise<FileSystemSink | null> {
  if (!supportsFileSystemAccess()) return null;
  const picker = (globalThis as unknown as {
    showSaveFilePicker: (opts: unknown) => Promise<{
      createWritable: () => Promise<{ write: (d: Uint8Array) => Promise<void>; close: () => Promise<void>; abort?: () => Promise<void> }>;
    }>;
  }).showSaveFilePicker;
  let handle;
  try {
    handle = await picker({
      suggestedName,
      types: [
        {
          description: "KYUTXO Backup",
          accept: { "application/zip": [".zip"] },
        },
      ],
    });
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") {
      throw new BackupCancelledError();
    }
    throw e;
  }
  const writable = await handle.createWritable();
  return new FileSystemSink(writable);
}

// Triggers a browser download of an in-memory blob (memory fallback path).
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke a tick later so the download has started.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

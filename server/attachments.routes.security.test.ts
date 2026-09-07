// Route-level adversarial tests for the attachment HTTP API: symlink escapes,
// oversized uploads, and filename entropy. Runs the REAL router on a real
// ephemeral HTTP server (fetch + FormData) against a temp data dir, so the
// multer limits and the realpath containment are exercised end to end.
//
// The module reads KYUTXO_DATA_DIR / KYUTXO_MAX_ATTACHMENT_BYTES at import
// time, so both are set BEFORE a dynamic import (static imports would hoist
// above the env assignment).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { Express } from "express";
import type { Server } from "node:http";

const CAP = 64; // bytes — tiny so oversized-upload tests stay fast

let server: Server;
let baseUrl: string;
let dataDir: string;
let attachmentsDir: string;
let outsideDir: string;
let resetAttachmentTraversalVisits: () => void;
let getAttachmentTraversalVisits: () => number;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kyutxo-attach-routes-"));
  attachmentsDir = path.join(dataDir, "attachments");
  outsideDir = path.join(dataDir, "outside");
  fs.mkdirSync(outsideDir, { recursive: true });
  process.env.KYUTXO_DATA_DIR = dataDir;
  process.env.KYUTXO_MAX_ATTACHMENT_BYTES = String(CAP);
  vi.resetModules();
  const { default: express } = await import("express");
  const attachmentsModule = await import("./attachments");
  const attachmentsRouter = attachmentsModule.default;
  resetAttachmentTraversalVisits = attachmentsModule.resetAttachmentTraversalVisitsForTest;
  getAttachmentTraversalVisits = attachmentsModule.getAttachmentTraversalVisitsForTest;
  const app: Express = express();
  app.use(express.json());
  app.use("/api/attachments", attachmentsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  delete process.env.KYUTXO_DATA_DIR;
  delete process.env.KYUTXO_MAX_ATTACHMENT_BYTES;
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function uploadRequest(
  urlPath: string,
  fields: Record<string, string>,
  fileName: string,
  bytes: Uint8Array,
): Promise<Response> {
  const form = new FormData();
  form.append("file", new Blob([bytes]), fileName);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return fetch(`${baseUrl}/api/attachments${urlPath}`, {
    method: "POST",
    body: form,
  });
}

const small = (seed = 1) => new Uint8Array([seed, 2, 3]);
const overCap = () => new Uint8Array(CAP + 1);

// Uploads stream to a staging dir inside the data root; every request must
// leave it empty afterwards (success moves the file, failure deletes it).
function tmpFilesLeft(): number {
  const tmpDir = path.join(dataDir, "attachments-tmp");
  if (!fs.existsSync(tmpDir)) return 0;
  return fs.readdirSync(tmpDir).length;
}

describe("upload size limits", () => {
  it("rejects an upload above the cap with 413 and writes nothing", async () => {
    const res = await uploadRequest("/upload", { identifier: "big" }, "big.bin", overCap());
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toMatch(/maximum size/);
    expect(fs.existsSync(path.join(attachmentsDir, "big"))).toBe(false);
    expect(tmpFilesLeft()).toBe(0);
  });

  it("rejects an oversized restore write with 413", async () => {
    const res = await uploadRequest(
      "/write",
      { relativePath: "restore/big.bin" },
      "big.bin",
      overCap(),
    );
    expect(res.status).toBe(413);
    expect(fs.existsSync(path.join(attachmentsDir, "restore"))).toBe(false);
    expect(tmpFilesLeft()).toBe(0);
  });

  it("leaves no staging temp files after successful upload/write or a rejected write", async () => {
    const up = await uploadRequest("/upload", { identifier: "tmpcheck" }, "a.bin", small(4));
    expect(up.status).toBe(200);
    const w = await uploadRequest("/write", { relativePath: "tmpcheck/b.bin" }, "b.bin", small(5));
    expect(w.status).toBe(200);
    // A rejected (path-escape) write must also clean up its staged bytes.
    const bad = await uploadRequest("/write", { relativePath: "../escape.bin" }, "e.bin", small(6));
    expect(bad.status).toBe(403);
    expect(tmpFilesLeft()).toBe(0);
  });
});

describe("upload filename entropy", () => {
  it("generates crypto-random unique filenames and never overwrites", async () => {
    const r1 = await uploadRequest("/upload", { identifier: "entropy" }, "note.bin", small(1));
    const r2 = await uploadRequest("/upload", { identifier: "entropy" }, "note.bin", small(2));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1 = await r1.json();
    const b2 = await r2.json();
    expect(b1.objectStoragePath).not.toBe(b2.objectStoragePath);
    // 8-hex-char crypto suffix (was: 3-char Math.random() suffix).
    expect(b1.objectStoragePath).toMatch(/_[0-9a-f]{8}\.bin$/);
    expect(b2.objectStoragePath).toMatch(/_[0-9a-f]{8}\.bin$/);
    // Both files exist with their own bytes — no overwrite.
    const p1 = path.join(dataDir, b1.objectStoragePath);
    const p2 = path.join(dataDir, b2.objectStoragePath);
    expect([...fs.readFileSync(p1)]).toEqual([...small(1)]);
    expect([...fs.readFileSync(p2)]).toEqual([...small(2)]);
  });
});

describe("symlink containment", () => {
  it("refuses to READ through a symlinked directory", async () => {
    fs.mkdirSync(attachmentsDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "TOP SECRET");
    fs.symlinkSync(outsideDir, path.join(attachmentsDir, "evil"), "dir");

    const res = await fetch(`${baseUrl}/api/attachments/download/evil/secret.txt`);
    expect(res.status).toBe(403);
  });

  it("refuses to READ a symlinked file pointing outside", async () => {
    fs.writeFileSync(path.join(outsideDir, "secret2.txt"), "TOP SECRET 2");
    fs.symlinkSync(path.join(outsideDir, "secret2.txt"), path.join(attachmentsDir, "link.txt"));

    const res = await fetch(`${baseUrl}/api/attachments/download/link.txt`);
    expect(res.status).toBe(403);
  });

  it("refuses to DELETE through a symlinked directory and leaves the outside file intact", async () => {
    const target = path.join(outsideDir, "secret.txt");
    expect(fs.existsSync(target)).toBe(true);
    const res = await fetch(`${baseUrl}/api/attachments/evil/secret.txt`, { method: "DELETE" });
    expect(res.status).toBe(403);
    expect(fs.readFileSync(target, "utf8")).toBe("TOP SECRET");
  });

  it("refuses a restore WRITE through a symlinked directory", async () => {
    const res = await uploadRequest(
      "/write",
      { relativePath: "evil/injected.txt" },
      "injected.txt",
      small(),
    );
    expect(res.status).toBe(403);
    expect(fs.existsSync(path.join(outsideDir, "injected.txt"))).toBe(false);
  });

  it("refuses a restore WRITE onto a dangling symlink", async () => {
    // Dangling: the link target does not exist yet. realpath reports ENOENT
    // for the link, and a naive writeFile would CREATE the outside target.
    fs.symlinkSync(path.join(outsideDir, "created-by-link.txt"), path.join(attachmentsDir, "dangle.txt"));
    const res = await uploadRequest(
      "/write",
      { relativePath: "dangle.txt" },
      "dangle.txt",
      small(),
    );
    expect(res.status).toBe(403);
    expect(fs.existsSync(path.join(outsideDir, "created-by-link.txt"))).toBe(false);
  });

  it("refuses to RENAME a file out through a symlinked directory", async () => {
    // Set up a legitimate in-root file via the write endpoint.
    const w = await uploadRequest(
      "/write",
      { relativePath: "legit/move-me.txt" },
      "move-me.txt",
      small(),
    );
    expect(w.status).toBe(200);

    const res = await fetch(`${baseUrl}/api/attachments/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldPath: "legit/move-me.txt", newPath: "evil/escaped.txt" }),
    });
    expect(res.status).toBe(403);
    // The source file is untouched and nothing landed outside the root.
    expect(fs.existsSync(path.join(attachmentsDir, "legit", "move-me.txt"))).toBe(true);
    expect(fs.existsSync(path.join(outsideDir, "escaped.txt"))).toBe(false);
  });

  it("refuses to RENAME a symlink as the source", async () => {
    const res = await fetch(`${baseUrl}/api/attachments/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldPath: "link.txt", newPath: "legit/renamed.txt" }),
    });
    expect(res.status).toBe(403);
  });

  it("keeps a legitimate rename working (and 404s a missing source)", async () => {
    const w = await uploadRequest(
      "/write",
      { relativePath: "legit/stays.txt" },
      "stays.txt",
      small(9),
    );
    expect(w.status).toBe(200);

    const ok = await fetch(`${baseUrl}/api/attachments/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldPath: "legit/stays.txt", newPath: "moved/stays.txt" }),
    });
    expect(ok.status).toBe(200);
    expect(fs.existsSync(path.join(attachmentsDir, "moved", "stays.txt"))).toBe(true);
    expect(fs.existsSync(path.join(attachmentsDir, "legit", "stays.txt"))).toBe(false);

    const missing = await fetch(`${baseUrl}/api/attachments/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldPath: "legit/never-existed.txt", newPath: "moved/x.txt" }),
    });
    expect(missing.status).toBe(404);
  });

  it("refuses to overwrite an existing rename destination", async () => {
    fs.mkdirSync(path.join(attachmentsDir, "collision"), { recursive: true });
    const source = path.join(attachmentsDir, "collision", "source.txt");
    const destination = path.join(attachmentsDir, "collision", "destination.txt");
    fs.writeFileSync(source, "SOURCE BYTES");
    fs.writeFileSync(destination, "DESTINATION BYTES");

    const res = await fetch(`${baseUrl}/api/attachments/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        oldPath: "collision/source.txt",
        newPath: "collision/destination.txt",
      }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Destination file already exists" });
    expect(fs.readFileSync(source, "utf8")).toBe("SOURCE BYTES");
    expect(fs.readFileSync(destination, "utf8")).toBe("DESTINATION BYTES");
  });

  it("falls back to an exclusive copy when hard links are unsupported", async () => {
    fs.mkdirSync(path.join(attachmentsDir, "portable"), { recursive: true });
    const source = path.join(attachmentsDir, "portable", "source.txt");
    const destination = path.join(attachmentsDir, "portable", "destination.txt");
    fs.writeFileSync(source, "PORTABLE BYTES");
    const linkSpy = vi
      .spyOn(fs.promises, "link")
      .mockRejectedValueOnce(Object.assign(new Error("cross-device link"), { code: "EXDEV" }));

    try {
      const res = await fetch(`${baseUrl}/api/attachments/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          oldPath: "portable/source.txt",
          newPath: "portable/destination.txt",
        }),
      });

      expect(res.status).toBe(200);
      expect(fs.existsSync(source)).toBe(false);
      expect(fs.readFileSync(destination, "utf8")).toBe("PORTABLE BYTES");
    } finally {
      linkSpy.mockRestore();
    }
  });
});

describe("in-root symlink never redirects operations onto its target", () => {
  // Even when a planted link resolves INSIDE the root, acting on the resolved
  // target would let one attachment's path read/delete/move ANOTHER
  // attachment's bytes — so the link itself must be rejected.
  function plantInRootLink() {
    fs.mkdirSync(path.join(attachmentsDir, "victim"), { recursive: true });
    fs.writeFileSync(path.join(attachmentsDir, "victim", "real.txt"), "VICTIM BYTES");
    fs.symlinkSync(
      path.join(attachmentsDir, "victim", "real.txt"),
      path.join(attachmentsDir, "alias.txt"),
    );
  }

  it("download of an in-root symlink is refused and the target is not disclosed", async () => {
    plantInRootLink();
    const res = await fetch(`${baseUrl}/api/attachments/download/alias.txt`);
    expect(res.status).toBe(403);
    expect(fs.readFileSync(path.join(attachmentsDir, "victim", "real.txt"), "utf8")).toBe("VICTIM BYTES");
  });

  it("delete of an in-root symlink removes NEITHER the link NOR the target", async () => {
    const res = await fetch(`${baseUrl}/api/attachments/alias.txt`, { method: "DELETE" });
    expect(res.status).toBe(403);
    expect(fs.readFileSync(path.join(attachmentsDir, "victim", "real.txt"), "utf8")).toBe("VICTIM BYTES");
    expect(fs.lstatSync(path.join(attachmentsDir, "alias.txt")).isSymbolicLink()).toBe(true);
  });

  it("rename of an in-root symlink does not move the target", async () => {
    const res = await fetch(`${baseUrl}/api/attachments/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldPath: "alias.txt", newPath: "moved-alias.txt" }),
    });
    expect(res.status).toBe(403);
    expect(fs.readFileSync(path.join(attachmentsDir, "victim", "real.txt"), "utf8")).toBe("VICTIM BYTES");
    expect(fs.existsSync(path.join(attachmentsDir, "moved-alias.txt"))).toBe(false);
  });

  it("a restore write onto an in-root symlink does not truncate the target", async () => {
    const res = await uploadRequest(
      "/write",
      { relativePath: "alias.txt" },
      "alias.txt",
      small(99),
    );
    expect(res.status).toBe(403);
    expect(fs.readFileSync(path.join(attachmentsDir, "victim", "real.txt"), "utf8")).toBe("VICTIM BYTES");
  });
});

describe("legitimate round-trip still works", () => {
  it("uploads, lists, downloads, and deletes a real attachment", async () => {
    const up = await uploadRequest("/upload", { identifier: "roundtrip" }, "doc.txt", small(7));
    expect(up.status).toBe(200);
    const { objectStoragePath } = await up.json();
    const rel = objectStoragePath.replace(/^attachments\//, "");

    const list = await fetch(`${baseUrl}/api/attachments/list-all`);
    const listBody = await list.json();
    expect(listBody.files).toContain(rel.split(path.sep).join("/"));

    const down = await fetch(`${baseUrl}/api/attachments/download/${objectStoragePath}`);
    expect(down.status).toBe(200);
    expect([...new Uint8Array(await down.arrayBuffer())]).toEqual([...small(7)]);

    const del = await fetch(`${baseUrl}/api/attachments/${objectStoragePath}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    const missingDownload = await fetch(
      `${baseUrl}/api/attachments/download/${objectStoragePath}`,
    );
    expect(missingDownload.status).toBe(404);
    expect(await missingDownload.json()).toEqual({ error: "Attachment not found" });

    const repeatedDelete = await fetch(
      `${baseUrl}/api/attachments/${objectStoragePath}`,
      { method: "DELETE" },
    );
    expect(repeatedDelete.status).toBe(200);
    expect(await repeatedDelete.json()).toEqual({
      success: true,
      alreadyDeleted: true,
    });
  });

  it("an aborted download closes the file descriptor (no fd leak)", async () => {
    // A file large enough that the stream cannot fit in socket buffers, so
    // aborting the client genuinely interrupts the transfer mid-stream.
    const bigDir = path.join(attachmentsDir, "bigdl");
    fs.mkdirSync(bigDir, { recursive: true });
    const bigPath = path.join(bigDir, "big.bin");
    fs.writeFileSync(bigPath, Buffer.alloc(16 * 1024 * 1024, 7));

    const fdsToFile = () => {
      // Server runs in-process, so its fds are visible in /proc/self/fd.
      const entries = fs.readdirSync("/proc/self/fd");
      let count = 0;
      for (const e of entries) {
        try {
          if (fs.readlinkSync(path.join("/proc/self/fd", e)) === bigPath) count++;
        } catch {
          // fd vanished between readdir and readlink
        }
      }
      return count;
    };

    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${baseUrl}/api/attachments/download/bigdl/big.bin`);
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      await reader.read(); // receive one chunk, then abort mid-stream
      await reader.cancel();
    }

    // The read streams (and their FileHandles) must be destroyed once the
    // response closes; poll briefly since teardown is asynchronous.
    const deadline = Date.now() + 5000;
    while (fdsToFile() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(fdsToFile()).toBe(0);
  });
});

describe("resumable attachment listing", () => {
  it("keeps browser traversal linear across many bounded pages", async () => {
    fs.rmSync(attachmentsDir, { recursive: true, force: true });
    const manyDir = path.join(attachmentsDir, "many");
    fs.mkdirSync(manyDir, { recursive: true });
    const fileCount = 1_005;
    for (let index = 0; index < fileCount; index++) {
      fs.writeFileSync(path.join(manyDir, `${index}.bin`), small(index & 0xff));
    }
    fs.writeFileSync(path.join(outsideDir, "listing-secret.bin"), new Uint8Array(500));
    fs.symlinkSync(
      path.join(outsideDir, "listing-secret.bin"),
      path.join(manyDir, "outside-link.bin"),
    );

    resetAttachmentTraversalVisits();
    {
      const names: string[] = [];
      let cursor: string | null = null;
      let page = 0;
      do {
        const query = new URLSearchParams({ limit: "10" });
        if (cursor) query.set("cursor", cursor);
        const response = await fetch(`${baseUrl}/api/attachments/list-all?${query}`);
        expect(response.status).toBe(200);
        const body = await response.json();
        names.push(...body.files);
        cursor = body.cursor ?? null;
        page += 1;
        if (page === 1) {
          expect(body.total).toBe(fileCount);
          expect(body.totalBytes).toBe(fileCount * small().length);
        } else {
          expect(body.total).toBeUndefined();
          expect(body.totalBytes).toBeUndefined();
        }
      } while (cursor);

      expect(page).toBe(Math.ceil(fileCount / 10));
      expect(new Set(names).size).toBe(fileCount);
      expect(names.some((name) => name.includes("outside-link"))).toBe(false);
      expect(getAttachmentTraversalVisits()).toBe(fileCount * 2);
    }

    const defaultPage = await fetch(`${baseUrl}/api/attachments/list-all`);
    const defaultBody = await defaultPage.json();
    expect(defaultBody.files).toHaveLength(1_000);
    expect(typeof defaultBody.cursor).toBe("string");
    const close = await fetch(
      `${baseUrl}/api/attachments/list-all?closeCursor=${encodeURIComponent(defaultBody.cursor)}`,
    );
    expect(close.status).toBe(200);
    const expired = await fetch(
      `${baseUrl}/api/attachments/list-all?cursor=${encodeURIComponent(defaultBody.cursor)}&limit=10`,
    );
    expect(expired.status).toBe(410);
  });
});

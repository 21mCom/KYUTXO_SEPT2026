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

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kyutxo-attach-routes-"));
  attachmentsDir = path.join(dataDir, "attachments");
  outsideDir = path.join(dataDir, "outside");
  fs.mkdirSync(outsideDir, { recursive: true });
  process.env.KYUTXO_DATA_DIR = dataDir;
  process.env.KYUTXO_MAX_ATTACHMENT_BYTES = String(CAP);
  vi.resetModules();
  const { default: express } = await import("express");
  const { default: attachmentsRouter } = await import("./attachments");
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

describe("upload size limits", () => {
  it("rejects an upload above the cap with 413 and writes nothing", async () => {
    const res = await uploadRequest("/upload", { identifier: "big" }, "big.bin", overCap());
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toMatch(/maximum size/);
    expect(fs.existsSync(path.join(attachmentsDir, "big"))).toBe(false);
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
  });
});

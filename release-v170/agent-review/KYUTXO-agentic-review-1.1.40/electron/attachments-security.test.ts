// Adversarial tests for the Electron attachment IPC handlers: symlink escapes,
// oversized writes, and filename entropy. Loads the REAL file-handlers.cjs
// with a FakeIpcMain (same pattern as needs-review.test.ts) against a temp
// directory tree with planted symlinks.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);

type Handler = (event: unknown, arg: unknown) => unknown;
class FakeIpcMain {
  private handlers = new Map<string, Handler>();
  handle(channel: string, fn: Handler) {
    this.handlers.set(channel, fn);
  }
  invoke(channel: string, arg?: unknown): Promise<any> {
    const fn = this.handlers.get(channel);
    if (!fn) throw new Error(`No handler registered for ${channel}`);
    return Promise.resolve(fn({}, arg));
  }
}

type FileHandlersModule = {
  registerFileHandlers: (
    ipcMain: FakeIpcMain,
    dirs: {
      dataDir: string;
      attachmentsDir: string;
      needsReviewDir: string;
      portableMode: boolean;
      maxAttachmentBytes?: number;
    },
  ) => void;
};

const CAP = 64; // bytes — tiny so oversize tests stay fast

let baseDir: string;
let attachmentsDir: string;
let needsReviewDir: string;
let outsideDir: string;
let ipc: FakeIpcMain;

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "kyutxo-attach-sec-"));
  attachmentsDir = path.join(baseDir, "attachments");
  needsReviewDir = path.join(baseDir, "needs-review");
  outsideDir = path.join(baseDir, "outside");
  fs.mkdirSync(attachmentsDir, { recursive: true });
  fs.mkdirSync(needsReviewDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  const { registerFileHandlers } = requireCjs("./file-handlers.cjs") as FileHandlersModule;
  ipc = new FakeIpcMain();
  registerFileHandlers(ipc, {
    dataDir: baseDir,
    attachmentsDir,
    needsReviewDir,
    portableMode: false,
    maxAttachmentBytes: CAP,
  });
});

afterEach(() => {
  fs.rmSync(baseDir, { recursive: true, force: true });
});

const small = (seed = 1) => new Uint8Array([seed, 2, 3]);

describe("save-attachment", () => {
  it("writes with an 8-hex-char crypto suffix and never overwrites", async () => {
    const r1 = await ipc.invoke("save-attachment", {
      identifier: "addr1",
      filename: "note.bin",
      data: small(1),
    });
    const r2 = await ipc.invoke("save-attachment", {
      identifier: "addr1",
      filename: "note.bin",
      data: small(2),
    });
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r1.path).not.toBe(r2.path);
    expect(r1.path).toMatch(/_[0-9a-f]{8}\.bin$/);
    expect(r2.path).toMatch(/_[0-9a-f]{8}\.bin$/);
    expect([...fs.readFileSync(path.join(attachmentsDir, r1.path))]).toEqual([...small(1)]);
    expect([...fs.readFileSync(path.join(attachmentsDir, r2.path))]).toEqual([...small(2)]);
  });

  it("rejects data above the size cap", async () => {
    const r = await ipc.invoke("save-attachment", {
      identifier: "addr1",
      filename: "big.bin",
      data: new Uint8Array(CAP + 1),
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/maximum size/);
    expect(fs.existsSync(path.join(attachmentsDir, "addr1"))).toBe(false);
  });

  it("refuses to write through a symlinked identifier directory", async () => {
    fs.symlinkSync(outsideDir, path.join(attachmentsDir, "evilid"), "dir");
    const r = await ipc.invoke("save-attachment", {
      identifier: "evilid",
      filename: "note.bin",
      data: small(),
    });
    expect(r.success).toBe(false);
    expect(fs.readdirSync(outsideDir)).toEqual([]);
  });
});

describe("read-attachment", () => {
  it("reads a real file", async () => {
    fs.mkdirSync(path.join(attachmentsDir, "d"), { recursive: true });
    fs.writeFileSync(path.join(attachmentsDir, "d", "f.bin"), small(5));
    const r = await ipc.invoke("read-attachment", "d/f.bin");
    expect(r.success).toBe(true);
    expect([...new Uint8Array(r.data)]).toEqual([...small(5)]);
  });

  it("refuses to read through a symlinked directory", async () => {
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "SECRET");
    fs.symlinkSync(outsideDir, path.join(attachmentsDir, "evil"), "dir");
    const r = await ipc.invoke("read-attachment", "evil/secret.txt");
    expect(r.success).toBe(false);
  });

  it("refuses to read a symlinked file pointing outside", async () => {
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "SECRET");
    fs.symlinkSync(path.join(outsideDir, "secret.txt"), path.join(attachmentsDir, "link.txt"));
    const r = await ipc.invoke("read-attachment", "link.txt");
    expect(r.success).toBe(false);
  });
});

describe("delete-attachment", () => {
  it("deletes a real file and stays idempotent for missing files", async () => {
    fs.writeFileSync(path.join(attachmentsDir, "f.bin"), small());
    const r = await ipc.invoke("delete-attachment", "f.bin");
    expect(r.success).toBe(true);
    expect(fs.existsSync(path.join(attachmentsDir, "f.bin"))).toBe(false);
    const missing = await ipc.invoke("delete-attachment", "never-existed.bin");
    expect(missing.success).toBe(true);
  });

  it("refuses to delete through a symlinked directory and leaves the outside file intact", async () => {
    const target = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(target, "SECRET");
    fs.symlinkSync(outsideDir, path.join(attachmentsDir, "evil"), "dir");
    const r = await ipc.invoke("delete-attachment", "evil/secret.txt");
    expect(r.success).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe("SECRET");
  });

  it("refuses to delete a dangling symlink (never follows it)", async () => {
    fs.symlinkSync(path.join(outsideDir, "nope.txt"), path.join(attachmentsDir, "dangle.txt"));
    const r = await ipc.invoke("delete-attachment", "dangle.txt");
    expect(r.success).toBe(false);
  });
});

describe("write-attachment (restore)", () => {
  it("writes a normal file", async () => {
    const r = await ipc.invoke("write-attachment", {
      relativePath: "restored/f.bin",
      data: small(3),
    });
    expect(r.success).toBe(true);
    expect([...fs.readFileSync(path.join(attachmentsDir, "restored", "f.bin"))]).toEqual([...small(3)]);
  });

  it("rejects data above the size cap", async () => {
    const r = await ipc.invoke("write-attachment", {
      relativePath: "restored/big.bin",
      data: new Uint8Array(CAP + 1),
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/maximum size/);
    // Distinct code: the restore writer maps this to AttachmentTooLargeError
    // so an oversized file is skipped instead of failing the whole restore.
    expect(r.code).toBe("ATTACHMENT_TOO_LARGE");
    expect(fs.existsSync(path.join(attachmentsDir, "restored"))).toBe(false);
  });

  it("refuses to write through a symlinked directory", async () => {
    fs.symlinkSync(outsideDir, path.join(attachmentsDir, "evil"), "dir");
    const r = await ipc.invoke("write-attachment", {
      relativePath: "evil/injected.txt",
      data: small(),
    });
    expect(r.success).toBe(false);
    expect(fs.readdirSync(outsideDir)).toEqual([]);
  });

  it("refuses to write onto a dangling symlink", async () => {
    fs.symlinkSync(path.join(outsideDir, "created.txt"), path.join(attachmentsDir, "dangle.txt"));
    const r = await ipc.invoke("write-attachment", {
      relativePath: "dangle.txt",
      data: small(),
    });
    expect(r.success).toBe(false);
    expect(fs.existsSync(path.join(outsideDir, "created.txt"))).toBe(false);
  });
});

describe("rename-attachment", () => {
  it("renames a real file and 404s-equivalents a missing source", async () => {
    fs.mkdirSync(path.join(attachmentsDir, "legit"), { recursive: true });
    fs.writeFileSync(path.join(attachmentsDir, "legit", "a.txt"), small());
    const ok = await ipc.invoke("rename-attachment", {
      oldPath: "legit/a.txt",
      newPath: "moved/a.txt",
    });
    expect(ok.success).toBe(true);
    expect(fs.existsSync(path.join(attachmentsDir, "moved", "a.txt"))).toBe(true);

    const missing = await ipc.invoke("rename-attachment", {
      oldPath: "legit/nope.txt",
      newPath: "moved/nope.txt",
    });
    expect(missing.success).toBe(false);
    expect(missing.error).toMatch(/not found/i);
  });

  it("refuses to rename out through a symlinked directory", async () => {
    fs.mkdirSync(path.join(attachmentsDir, "legit"), { recursive: true });
    fs.writeFileSync(path.join(attachmentsDir, "legit", "a.txt"), small());
    fs.symlinkSync(outsideDir, path.join(attachmentsDir, "evil"), "dir");
    const r = await ipc.invoke("rename-attachment", {
      oldPath: "legit/a.txt",
      newPath: "evil/escaped.txt",
    });
    expect(r.success).toBe(false);
    expect(fs.existsSync(path.join(attachmentsDir, "legit", "a.txt"))).toBe(true);
    expect(fs.existsSync(path.join(outsideDir, "escaped.txt"))).toBe(false);
  });

  it("refuses a symlink as the rename source", async () => {
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "SECRET");
    fs.symlinkSync(path.join(outsideDir, "secret.txt"), path.join(attachmentsDir, "link.txt"));
    const r = await ipc.invoke("rename-attachment", {
      oldPath: "link.txt",
      newPath: "legit/renamed.txt",
    });
    expect(r.success).toBe(false);
  });
});

describe("list-attachments", () => {
  it("lists regular files of a real identifier directory", async () => {
    fs.mkdirSync(path.join(attachmentsDir, "addr1"), { recursive: true });
    fs.writeFileSync(path.join(attachmentsDir, "addr1", "a.bin"), small());
    const r = await ipc.invoke("list-attachments", "addr1");
    expect(r.success).toBe(true);
    expect(r.files).toEqual(["a.bin"]);
  });

  it("refuses to enumerate a symlinked identifier directory", async () => {
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "SECRET");
    fs.symlinkSync(outsideDir, path.join(attachmentsDir, "evilid"), "dir");
    const r = await ipc.invoke("list-attachments", "evilid");
    expect(r.success).toBe(false);
  });

  it("skips symlinked files inside a real directory", async () => {
    fs.mkdirSync(path.join(attachmentsDir, "real"), { recursive: true });
    fs.writeFileSync(path.join(attachmentsDir, "real", "a.bin"), small());
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "SECRET");
    fs.symlinkSync(path.join(outsideDir, "secret.txt"), path.join(attachmentsDir, "real", "link.txt"));
    const r = await ipc.invoke("list-attachments", "real");
    expect(r.success).toBe(true);
    expect(r.files).toEqual(["a.bin"]);
  });
});

describe("in-root symlink never redirects operations onto its target", () => {
  // Even when a planted link resolves INSIDE the root, acting on the resolved
  // target would let one attachment's path read/delete/move ANOTHER
  // attachment's bytes — so the link itself must be rejected.
  beforeEach(() => {
    fs.mkdirSync(path.join(attachmentsDir, "victim"), { recursive: true });
    fs.writeFileSync(path.join(attachmentsDir, "victim", "real.txt"), "VICTIM BYTES");
    fs.symlinkSync(
      path.join(attachmentsDir, "victim", "real.txt"),
      path.join(attachmentsDir, "alias.txt"),
    );
  });

  it("read of an in-root symlink is refused and the target is not disclosed", async () => {
    const r = await ipc.invoke("read-attachment", "alias.txt");
    expect(r.success).toBe(false);
    expect(fs.readFileSync(path.join(attachmentsDir, "victim", "real.txt"), "utf8")).toBe("VICTIM BYTES");
  });

  it("delete of an in-root symlink removes NEITHER the link NOR the target", async () => {
    const r = await ipc.invoke("delete-attachment", "alias.txt");
    expect(r.success).toBe(false);
    expect(fs.readFileSync(path.join(attachmentsDir, "victim", "real.txt"), "utf8")).toBe("VICTIM BYTES");
    expect(fs.lstatSync(path.join(attachmentsDir, "alias.txt")).isSymbolicLink()).toBe(true);
  });

  it("rename of an in-root symlink does not move the target", async () => {
    const r = await ipc.invoke("rename-attachment", {
      oldPath: "alias.txt",
      newPath: "moved-alias.txt",
    });
    expect(r.success).toBe(false);
    expect(fs.readFileSync(path.join(attachmentsDir, "victim", "real.txt"), "utf8")).toBe("VICTIM BYTES");
    expect(fs.existsSync(path.join(attachmentsDir, "moved-alias.txt"))).toBe(false);
  });

  it("a restore write onto an in-root symlink does not truncate the target", async () => {
    const r = await ipc.invoke("write-attachment", {
      relativePath: "alias.txt",
      data: small(9),
    });
    expect(r.success).toBe(false);
    expect(fs.readFileSync(path.join(attachmentsDir, "victim", "real.txt"), "utf8")).toBe("VICTIM BYTES");
  });
});

describe("list-all-attachments", () => {
  it("skips planted symlinks instead of following them outside the root", async () => {
    fs.mkdirSync(path.join(attachmentsDir, "real"), { recursive: true });
    fs.writeFileSync(path.join(attachmentsDir, "real", "f.bin"), small());
    fs.writeFileSync(path.join(outsideDir, "secret.bin"), new Uint8Array(1000));
    // Symlinked FILE inside a real subdirectory.
    fs.symlinkSync(path.join(outsideDir, "secret.bin"), path.join(attachmentsDir, "real", "link.bin"));
    // Symlinked SUBDIRECTORY at the top level.
    fs.symlinkSync(outsideDir, path.join(attachmentsDir, "evil"), "dir");

    const r = await ipc.invoke("list-all-attachments");
    expect(r.success).toBe(true);
    const names = r.files.map((f: string) => f.split(path.sep).join("/"));
    expect(names).toEqual(["real/f.bin"]);
    // The outside file's 1000 bytes must not leak into the total.
    expect(r.totalBytes).toBe(small().length);
  });
});

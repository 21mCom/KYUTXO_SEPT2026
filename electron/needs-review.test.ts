import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createRequire, Module } from "node:module";

// file-handlers.cjs lazily `require('electron')` inside the
// open-needs-review-folder handler to reach `shell.openPath`. Intercept the
// runtime require at the Module level so the test can assert that call without a
// real Electron runtime (vi.mock does not catch a lazy require inside a CJS
// module loaded via Node's createRequire).
const openPath = vi.fn(async () => "");
const electronStub = {
  shell: { openPath },
  app: { getPath: () => os.tmpdir() },
};

const requireCjs = createRequire(import.meta.url);
const originalRequire = Module.prototype.require;
beforeAll(() => {
  (Module.prototype as any).require = function (id: string) {
    if (id === "electron") return electronStub;
    // eslint-disable-next-line prefer-rest-params
    return originalRequire.apply(this, arguments as any);
  };
});
afterAll(() => {
  Module.prototype.require = originalRequire;
});

// Load the REAL production modules (not reimplementations) so a regression in
// the path layout or the create-on-startup logic is actually caught here.
type FileHandlersModule = {
  registerFileHandlers: (ipcMain: FakeIpcMain, dirs: Dirs & { portableMode: boolean }) => void;
};
type PathsModule = {
  resolveDataDirs: (opts: { baseDir: string; portableMode: boolean }) => Dirs;
  ensureDirectories: (dirs: Dirs) => void;
};

type Dirs = { dataDir: string; attachmentsDir: string; needsReviewDir: string };

// Minimal stand-in for Electron's ipcMain that records handlers and lets the
// test invoke them exactly as the renderer would over IPC. (See FakeIpcMain.)
type Handler = (event: unknown, arg: unknown) => unknown;
class FakeIpcMain {
  private handlers = new Map<string, Handler>();
  handle(channel: string, fn: Handler) {
    this.handlers.set(channel, fn);
  }
  invoke(channel: string, arg?: unknown) {
    const fn = this.handlers.get(channel);
    if (!fn) throw new Error(`No handler registered for ${channel}`);
    return fn({}, arg);
  }
}

let registerFileHandlers: FileHandlersModule["registerFileHandlers"];
let resolveDataDirs: PathsModule["resolveDataDirs"];
let ensureDirectories: PathsModule["ensureDirectories"];

let baseDir: string;
let dirs: Dirs;

beforeEach(() => {
  ({ registerFileHandlers } = requireCjs("./file-handlers.cjs") as FileHandlersModule);
  ({ resolveDataDirs, ensureDirectories } = requireCjs("./paths.cjs") as PathsModule);
  openPath.mockClear();
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "kyutxo-needs-review-"));
  dirs = resolveDataDirs({ baseDir, portableMode: false });
});

afterEach(() => {
  fs.rmSync(baseDir, { recursive: true, force: true });
});

function registerHandlers(ipc: FakeIpcMain) {
  registerFileHandlers(ipc, { ...dirs, portableMode: false });
}

describe("Needs Review folder layout", () => {
  it("places the Needs Review folder alongside attachments under the data dir", () => {
    expect(dirs.dataDir).toBe(path.join(baseDir, "data"));
    expect(dirs.attachmentsDir).toBe(path.join(dirs.dataDir, "attachments"));
    expect(dirs.needsReviewDir).toBe(path.join(dirs.dataDir, "attachments-needs-review"));
  });

  it("derives the portable-mode layout from the portable dir", () => {
    const portable = resolveDataDirs({ baseDir: "/usb", portableMode: true });
    expect(portable.dataDir).toBe(path.join("/usb", "KYUTXO_Data"));
    expect(portable.needsReviewDir).toBe(
      path.join("/usb", "KYUTXO_Data", "attachments-needs-review"),
    );
  });
});

describe("startup directory creation", () => {
  it("creates the Needs Review folder at startup even when absent on disk", () => {
    expect(fs.existsSync(dirs.needsReviewDir)).toBe(false);

    ensureDirectories(dirs); // what createWindow() runs on every launch

    expect(fs.existsSync(dirs.dataDir)).toBe(true);
    expect(fs.existsSync(dirs.attachmentsDir)).toBe(true);
    expect(fs.existsSync(dirs.needsReviewDir)).toBe(true);
    expect(fs.statSync(dirs.needsReviewDir).isDirectory()).toBe(true);
  });

  it("leaves an existing Needs Review folder (and its files) untouched", () => {
    ensureDirectories(dirs);
    const keepme = path.join(dirs.needsReviewDir, "keepme.txt");
    fs.writeFileSync(keepme, "do not delete");

    ensureDirectories(dirs); // simulate a second launch

    expect(fs.existsSync(keepme)).toBe(true);
    expect(fs.readFileSync(keepme, "utf8")).toBe("do not delete");
  });
});

describe("write-needs-review IPC", () => {
  it("writes an orphaned file with the correct name and content", async () => {
    const ipc = new FakeIpcMain();
    registerHandlers(ipc);

    const content = new TextEncoder().encode("orphan attachment bytes");
    const result: any = await ipc.invoke("write-needs-review", {
      filename: "receipt.pdf",
      data: content,
    });

    expect(result.success).toBe(true);
    expect(result.savedName).toBe("receipt.pdf");
    expect(
      fs.readFileSync(path.join(dirs.needsReviewDir, result.savedName), "utf8"),
    ).toBe("orphan attachment bytes");
  });

  it("auto-creates the Needs Review folder if it was deleted before writing", async () => {
    const ipc = new FakeIpcMain();
    registerHandlers(ipc);
    expect(fs.existsSync(dirs.needsReviewDir)).toBe(false);

    const result: any = await ipc.invoke("write-needs-review", {
      filename: "note.txt",
      data: new TextEncoder().encode("hi"),
    });

    expect(result.success).toBe(true);
    expect(fs.existsSync(dirs.needsReviewDir)).toBe(true);
  });

  it("de-duplicates colliding filenames instead of overwriting", async () => {
    const ipc = new FakeIpcMain();
    registerHandlers(ipc);

    const a: any = await ipc.invoke("write-needs-review", {
      filename: "photo.png",
      data: new TextEncoder().encode("first"),
    });
    const b: any = await ipc.invoke("write-needs-review", {
      filename: "photo.png",
      data: new TextEncoder().encode("second"),
    });

    expect(a.savedName).toBe("photo.png");
    expect(b.savedName).toBe("photo_1.png");
    expect(fs.readFileSync(path.join(dirs.needsReviewDir, a.savedName), "utf8")).toBe(
      "first",
    );
    expect(fs.readFileSync(path.join(dirs.needsReviewDir, b.savedName), "utf8")).toBe(
      "second",
    );
  });

  it("strips path separators so callers cannot escape the folder", async () => {
    const ipc = new FakeIpcMain();
    registerHandlers(ipc);

    const result: any = await ipc.invoke("write-needs-review", {
      filename: "../../escape.txt",
      data: new TextEncoder().encode("x"),
    });

    expect(result.success).toBe(true);
    expect(result.savedName).toBe("escape.txt");
    expect(fs.existsSync(path.join(dirs.needsReviewDir, "escape.txt"))).toBe(true);
  });
});

describe("get/open Needs Review IPC", () => {
  it("open-needs-review-folder calls shell.openPath with the correct path", async () => {
    const ipc = new FakeIpcMain();
    registerHandlers(ipc);

    const result: any = await ipc.invoke("open-needs-review-folder");

    expect(result.success).toBe(true);
    expect(openPath).toHaveBeenCalledTimes(1);
    expect(openPath).toHaveBeenCalledWith(dirs.needsReviewDir);
    expect(fs.existsSync(dirs.needsReviewDir)).toBe(true);
  });
});

describe("read/delete Needs Review IPC hardening", () => {
  it("reads and idempotently deletes a real file", async () => {
    ensureDirectories(dirs);
    fs.writeFileSync(path.join(dirs.needsReviewDir, "orphan.bin"), "ORPHAN BYTES");
    const ipc = new FakeIpcMain();
    registerHandlers(ipc);

    const read: any = await ipc.invoke("read-needs-review", { name: "orphan.bin" });
    expect(read.success).toBe(true);
    expect(new TextDecoder().decode(new Uint8Array(read.data))).toBe("ORPHAN BYTES");

    expect(await ipc.invoke("delete-needs-review", { name: "orphan.bin" })).toEqual({
      success: true,
    });
    expect(await ipc.invoke("delete-needs-review", { name: "orphan.bin" })).toEqual({
      success: true,
    });
  });

  it("rejects path substitution instead of silently using the basename", async () => {
    ensureDirectories(dirs);
    fs.writeFileSync(path.join(dirs.needsReviewDir, "victim.txt"), "KEEP");
    const ipc = new FakeIpcMain();
    registerHandlers(ipc);

    const read: any = await ipc.invoke("read-needs-review", {
      name: "../victim.txt",
    });
    const del: any = await ipc.invoke("delete-needs-review", {
      name: "folder/victim.txt",
    });

    expect(read).toEqual({ success: false, error: "Invalid filename" });
    expect(del).toEqual({ success: false, error: "Invalid filename" });
    expect(fs.readFileSync(path.join(dirs.needsReviewDir, "victim.txt"), "utf8")).toBe(
      "KEEP",
    );
  });

  it("refuses read/delete through a symlink and preserves its target", async () => {
    ensureDirectories(dirs);
    const outside = path.join(dirs.dataDir, "outside.txt");
    fs.writeFileSync(outside, "OUTSIDE BYTES");
    fs.symlinkSync(outside, path.join(dirs.needsReviewDir, "alias.txt"));
    const ipc = new FakeIpcMain();
    registerHandlers(ipc);

    const read: any = await ipc.invoke("read-needs-review", { name: "alias.txt" });
    const del: any = await ipc.invoke("delete-needs-review", { name: "alias.txt" });

    expect(read).toEqual({ success: false, error: "Access denied" });
    expect(del).toEqual({ success: false, error: "Access denied" });
    expect(fs.readFileSync(outside, "utf8")).toBe("OUTSIDE BYTES");
    expect(
      fs.lstatSync(path.join(dirs.needsReviewDir, "alias.txt")).isSymbolicLink(),
    ).toBe(true);
  });
});

describe("persistence across an app restart", () => {
  it("keeps files written in a previous session after re-launch", async () => {
    // --- Session 1: app launches, routes an orphan into Needs Review ---
    ensureDirectories(dirs);
    const ipc1 = new FakeIpcMain();
    registerHandlers(ipc1);
    const written: any = await ipc1.invoke("write-needs-review", {
      filename: "orphan.dat",
      data: new TextEncoder().encode("survives restart"),
    });
    expect(written.success).toBe(true);

    // --- Restart: brand-new main process + handlers, SAME data dir on disk ---
    const relaunchDirs = resolveDataDirs({ baseDir, portableMode: false });
    ensureDirectories(relaunchDirs); // startup must NOT wipe existing files
    const ipc2 = new FakeIpcMain();
    registerFileHandlers(ipc2, { ...relaunchDirs, portableMode: false });

    // The file from the previous session is still on disk and intact.
    const survivor = path.join(relaunchDirs.needsReviewDir, "orphan.dat");
    expect(written.savedName).toBe("orphan.dat");
    expect(fs.existsSync(survivor)).toBe(true);
    expect(fs.readFileSync(survivor, "utf8")).toBe("survives restart");
  });
});

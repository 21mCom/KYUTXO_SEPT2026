import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { resolveAttachmentPath, containedRealPath, sweepStaleUploadTempFiles } from "./attachments";

const BASE = path.resolve(
  process.env.KYUTXO_DATA_DIR || path.join(process.cwd(), "data"),
  "attachments",
);

describe("resolveAttachmentPath", () => {
  it("resolves a normal two-segment path inside the attachments dir", () => {
    const r = resolveAttachmentPath("hashdir/opaquefile.bin");
    expect(r).toBe(path.join(BASE, "hashdir", "opaquefile.bin"));
  });

  it("resolves a single-segment (root) path inside the attachments dir", () => {
    const r = resolveAttachmentPath("legacy-root.pdf");
    expect(r).toBe(path.join(BASE, "legacy-root.pdf"));
  });

  it("strips a leading attachments/ prefix and resolves the same location", () => {
    expect(resolveAttachmentPath("attachments/hashdir/file.bin")).toBe(
      path.join(BASE, "hashdir", "file.bin"),
    );
  });

  it("rejects a sibling directory that shares the base as a string prefix", () => {
    // Without a path-separator boundary, '../attachments_evil/x' would resolve to
    // a sibling dir whose absolute path startsWith(BASE) — this must be rejected.
    expect(resolveAttachmentPath("../attachments_evil/secret")).toBeNull();
  });

  it("rejects traversal via .. segments", () => {
    expect(resolveAttachmentPath("../../etc/passwd")).toBeNull();
    expect(resolveAttachmentPath("hashdir/../../escape")).toBeNull();
    expect(resolveAttachmentPath("attachments/../../escape")).toBeNull();
  });

  it("rejects absolute paths", () => {
    expect(resolveAttachmentPath("/etc/passwd")).toBeNull();
  });

  it("rejects empty / non-string input", () => {
    expect(resolveAttachmentPath("")).toBeNull();
    expect(resolveAttachmentPath(undefined)).toBeNull();
    expect(resolveAttachmentPath(null)).toBeNull();
    expect(resolveAttachmentPath(42)).toBeNull();
  });

  it("rejects inputs that resolve to the attachments base directory itself", () => {
    expect(resolveAttachmentPath("attachments/")).toBeNull();
    expect(resolveAttachmentPath(".")).toBeNull();
  });
});

// containedRealPath: filesystem-level (realpath) containment that closes the
// symlink gap left by the lexical resolveAttachmentPath checks.
describe("containedRealPath", () => {
  let root: string;
  let base: string;
  let outside: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kyutxo-contained-"));
    base = path.join(root, "attachments");
    outside = path.join(root, "outside");
    fs.mkdirSync(base, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns the canonical path for a real file inside the root", async () => {
    const f = path.join(base, "dir", "file.bin");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "x");
    expect(await containedRealPath(base, f)).toBe(fs.realpathSync(f));
  });

  it("returns the would-be path for a missing write target under real dirs", async () => {
    const dir = path.join(base, "dir");
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, "new.bin");
    expect(await containedRealPath(base, target)).toBe(
      path.join(fs.realpathSync(dir), "new.bin"),
    );
  });

  it("returns the would-be path when SEVERAL directory levels are missing", async () => {
    // Guards the ancestor-walk join order: the reconstructed path must be
    // base/a/b/c.bin, not a reversal like base/c.bin/a/b.
    const target = path.join(base, "a", "b", "c.bin");
    expect(await containedRealPath(base, target)).toBe(
      path.join(fs.realpathSync(base), "a", "b", "c.bin"),
    );
  });

  it("rejects a symlinked FILE pointing outside the root", async () => {
    const secret = path.join(outside, "secret.txt");
    fs.writeFileSync(secret, "secret");
    const link = path.join(base, "link.txt");
    fs.symlinkSync(secret, link);
    expect(await containedRealPath(base, link)).toBeNull();
    // The outside file is untouched (nothing read/written through the link).
    expect(fs.readFileSync(secret, "utf8")).toBe("secret");
  });

  it("rejects a path nested under a symlinked DIRECTORY pointing outside", async () => {
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    fs.symlinkSync(outside, path.join(base, "evil"), "dir");
    expect(await containedRealPath(base, path.join(base, "evil", "secret.txt"))).toBeNull();
    // Also rejected for a write target that does not exist yet.
    expect(await containedRealPath(base, path.join(base, "evil", "new.txt"))).toBeNull();
  });

  it("rejects a DANGLING symlink at the write target", async () => {
    // realpath() reports ENOENT for dangling links; a following writeFile
    // would CREATE the outside target through the link.
    const link = path.join(base, "dangle.txt");
    fs.symlinkSync(path.join(outside, "created.txt"), link);
    expect(await containedRealPath(base, link)).toBeNull();
    expect(fs.existsSync(path.join(outside, "created.txt"))).toBe(false);
  });

  it("rejects an in-root symlink (read/delete/rename must never act on the link's target)", async () => {
    // Even though the link resolves INSIDE the root, acting on the resolved
    // target would let one attachment's path read/delete/move ANOTHER
    // attachment's bytes.
    const real = path.join(base, "real.txt");
    fs.writeFileSync(real, "x");
    const link = path.join(base, "inner-link.txt");
    fs.symlinkSync(real, link);
    expect(await containedRealPath(base, link)).toBeNull();
  });

  it("rejects a target in a sibling directory sharing the base prefix", async () => {
    const sibling = path.join(root, "attachments_evil");
    fs.mkdirSync(sibling);
    const f = path.join(sibling, "x.txt");
    fs.writeFileSync(f, "x");
    expect(await containedRealPath(base, f)).toBeNull();
  });
});

// sweepStaleUploadTempFiles: startup cleanup of upload temp files orphaned by
// a crash or power loss mid-upload. Must delete only stale plain files, never
// fresh (in-flight) files, and never throw.
describe("sweepStaleUploadTempFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kyutxo-tmp-sweep-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeFile(name: string, ageMs: number, now: number): string {
    const p = path.join(dir, name);
    fs.writeFileSync(p, "partial upload bytes");
    const t = new Date(now - ageMs);
    fs.utimesSync(p, t, t);
    return p;
  }

  it("removes files older than the threshold and keeps fresh ones", async () => {
    const now = Date.now();
    const stale = makeFile("upload_old.tmp", 2 * 60 * 60 * 1000, now);
    const fresh = makeFile("upload_new.tmp", 5 * 60 * 1000, now);
    const removed = await sweepStaleUploadTempFiles({ dir, now });
    expect(removed).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("keeps a file created long ago whose mtime is recent (still being written)", async () => {
    const now = Date.now();
    const p = path.join(dir, "upload_active.tmp");
    fs.writeFileSync(p, "streaming");
    // birthtime old is not simulatable portably, but a recent mtime alone must
    // protect the file regardless of any other timestamp.
    fs.utimesSync(p, new Date(now - 10_000), new Date(now - 10_000));
    expect(await sweepStaleUploadTempFiles({ dir, now })).toBe(0);
    expect(fs.existsSync(p)).toBe(true);
  });

  it("respects a custom maxAgeMs", async () => {
    const now = Date.now();
    const p = makeFile("upload_x.tmp", 30_000, now);
    expect(await sweepStaleUploadTempFiles({ dir, now, maxAgeMs: 10_000 })).toBe(1);
    expect(fs.existsSync(p)).toBe(false);
  });

  it("skips directories and symlinks even when stale", async () => {
    const now = Date.now();
    const old = new Date(now - 3 * 60 * 60 * 1000);
    const sub = path.join(dir, "subdir");
    fs.mkdirSync(sub);
    fs.utimesSync(sub, old, old);
    const outside = path.join(os.tmpdir(), `kyutxo-sweep-target-${process.pid}`);
    fs.writeFileSync(outside, "outside");
    fs.utimesSync(outside, old, old);
    const link = path.join(dir, "planted-link.tmp");
    fs.symlinkSync(outside, link);
    try {
      expect(await sweepStaleUploadTempFiles({ dir, now })).toBe(0);
      expect(fs.existsSync(sub)).toBe(true);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(outside)).toBe(true);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it("returns 0 without throwing when the staging dir does not exist", async () => {
    expect(
      await sweepStaleUploadTempFiles({ dir: path.join(dir, "missing"), now: Date.now() }),
    ).toBe(0);
  });
});

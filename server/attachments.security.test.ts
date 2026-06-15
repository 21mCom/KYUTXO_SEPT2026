import { describe, it, expect } from "vitest";
import * as path from "path";
import { resolveAttachmentPath } from "./attachments";

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

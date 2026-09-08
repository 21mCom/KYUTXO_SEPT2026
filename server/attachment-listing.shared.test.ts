import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAttachmentListing } from "../shared/attachment-listing.cjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "attachment-listing-contract-"));
  roots.push(root);
  const attachmentsDir = path.join(root, "attachments");
  const outsideDir = path.join(root, "outside");
  fs.mkdirSync(path.join(attachmentsDir, "nested"), { recursive: true });
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(path.join(attachmentsDir, "root.bin"), Buffer.alloc(2));
  fs.writeFileSync(path.join(attachmentsDir, "nested", "child.bin"), Buffer.alloc(3));
  fs.writeFileSync(path.join(outsideDir, "secret.bin"), Buffer.alloc(100));
  fs.symlinkSync(outsideDir, path.join(attachmentsDir, "linked-dir"), "dir");
  fs.symlinkSync(
    path.join(outsideDir, "secret.bin"),
    path.join(attachmentsDir, "nested", "linked-file.bin"),
  );
  return attachmentsDir;
}

describe("shared attachment listing contract", () => {
  it("applies paging, totals, close, expiry, caps, and symlink filtering", async () => {
    const attachmentsDir = fixture();
    let clock = 1_000;
    let id = 0;
    const listing = createAttachmentListing({
      attachmentsDir,
      now: () => clock,
      randomUUID: () => `cursor-${++id}`,
      sessionTtlMs: 10,
      maxSessions: 2,
    });

    expect(await listing.list({ summaryOnly: true })).toEqual({
      success: true,
      total: 2,
      totalBytes: 5,
    });
    const first = await listing.list({ limit: 1 });
    expect(first).toMatchObject({ total: 2, totalBytes: 5, cursor: "cursor-1" });
    expect(first.files).toHaveLength(1);
    expect(first.files?.some((name) => name.includes("linked"))).toBe(false);

    expect((await listing.list({ limit: 1 })).cursor).toBe("cursor-2");
    expect(await listing.list({ limit: 1 })).toEqual({
      success: false,
      code: "TOO_MANY",
      error: "Too many attachment listings",
    });
    expect(await listing.list({ closeCursor: "cursor-1" })).toEqual({ success: true });
    expect(await listing.list({ cursor: "cursor-1" })).toEqual({
      success: false,
      code: "EXPIRED",
      error: "Attachment listing expired",
    });

    clock += 11;
    expect(await listing.list({ cursor: "cursor-2" })).toEqual({
      success: false,
      code: "EXPIRED",
      error: "Attachment listing expired",
    });
  });

  it("uses one default and maximum page limit for both transports", async () => {
    const attachmentsDir = fixture();
    for (let index = 0; index < 10_010; index++) {
      fs.writeFileSync(path.join(attachmentsDir, `extra-${index}.bin`), "");
    }
    const listing = createAttachmentListing({ attachmentsDir });
    expect((await listing.list()).files).toHaveLength(1_000);
    expect((await listing.list({ limit: 50_000 })).files).toHaveLength(10_000);
  });
});
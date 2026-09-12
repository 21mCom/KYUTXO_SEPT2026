import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);
const { registerFileHandlers } = requireCjs("./file-handlers.cjs") as {
  registerFileHandlers: (ipcMain: FakeIpcMain, options: Record<string, unknown>) => void;
};

class FakeIpcMain {
  handlers = new Map<string, (...args: any[]) => any>();
  handle(name: string, handler: (...args: any[]) => any) {
    this.handlers.set(name, handler);
  }
  invoke(name: string, payload?: unknown) {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`Missing handler ${name}`);
    return handler({ sender: {} }, payload);
  }
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function harness(options: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kyutxo-scheduled-"));
  roots.push(root);
  const destination = path.join(root, "backups");
  const attachmentsDir = path.join(root, "attachments");
  const needsReviewDir = path.join(root, "review");
  fs.mkdirSync(destination);
  fs.mkdirSync(attachmentsDir);
  fs.mkdirSync(needsReviewDir);
  const ipc = new FakeIpcMain();
  const token = "a".repeat(32);
  fs.writeFileSync(path.join(root, "scheduled-backup-destinations.json"), JSON.stringify({ [token]: fs.realpathSync(destination) }));
  registerFileHandlers(ipc, { dataDir: root, attachmentsDir, needsReviewDir, portableMode: false, ...options });
  return { ipc, root, destination, token };
}

describe("scheduled backup main-process boundary", () => {
  it("denies arbitrary renderer paths instead of treating them as destinations", async () => {
    const { ipc, destination } = harness();
    const opened = await ipc.invoke("scheduled-backup-open", {
      destinationToken: destination,
      suggestedName: "kyutxo-scheduled-2026-09-02.zip",
    });
    expect(opened.success).toBe(false);
    expect(fs.readdirSync(destination)).toEqual([]);
  });

  it("keeps interrupted writes partial and abort removes them", async () => {
    const { ipc, destination, token } = harness();
    const opened = await ipc.invoke("scheduled-backup-open", { destinationToken: token, suggestedName: "kyutxo-scheduled-2026-09-02.zip" });
    expect(opened.success).toBe(true);
    await ipc.invoke("scheduled-backup-write", { id: opened.id, data: new Uint8Array([1, 2, 3]).buffer });
    expect(fs.readdirSync(destination).some((name) => name.includes(".partial-"))).toBe(true);
    await ipc.invoke("scheduled-backup-abort", { id: opened.id });
    expect(fs.readdirSync(destination)).toEqual([]);
  });

  it("cleans up a renamed archive when provenance persistence fails", async () => {
    const { ipc, destination, token } = harness({ scheduledPromotionFailure: true });
    const name = "kyutxo-scheduled-2026-09-02.zip";
    const opened = await ipc.invoke("scheduled-backup-open", { destinationToken: token, suggestedName: name });
    // Empty ZIP EOCD: structurally complete and enough for main validation.
    const eocd = new Uint8Array(22); eocd.set([0x50, 0x4b, 0x05, 0x06]);
    await ipc.invoke("scheduled-backup-write", { id: opened.id, data: eocd.buffer });
    const closed = await ipc.invoke("scheduled-backup-close", { id: opened.id });
    expect((await ipc.invoke("scheduled-backup-validate", { id: opened.id, rendererChecksum: closed.checksum })).success).toBe(true);
    expect((await ipc.invoke("scheduled-backup-promote", { id: opened.id, finalName: name, rendererVerified: true })).success).toBe(false);
    expect(fs.existsSync(path.join(destination, name))).toBe(false);
    expect(fs.existsSync(path.join(destination, `${name}.sha256`))).toBe(false);
  });

  it("excludes foreign ZIPs even when they carry a matching fake sidecar", async () => {
    const { ipc, destination, token } = harness();
    const name = "kyutxo-scheduled-2026-09-03.zip";
    const bytes = Buffer.from("foreign");
    fs.writeFileSync(path.join(destination, name), bytes);
    fs.writeFileSync(path.join(destination, `${name}.sha256`), require("node:crypto").createHash("sha256").update(bytes).digest("hex"));
    const listed = await ipc.invoke("scheduled-backup-list", { destinationToken: token });
    expect(listed.files).toEqual([]);
    expect(listed.invalidFiles.map((file: { name: string }) => file.name)).toEqual([name]);
  });

  it("probes capacity only through the opaque destination token", async () => {
    const { ipc, token } = harness();
    const checked = await ipc.invoke("scheduled-backup-disk-space", { destinationToken: token });
    expect(checked.success).toBe(true);
    expect(typeof checked.freeBytes).toBe("number");

    const denied = await ipc.invoke("scheduled-backup-disk-space", { destinationToken: "not-a-token" });
    expect(denied.success).toBe(false);
    expect(denied.error).toBe("Backup destination is unavailable");
  });

});

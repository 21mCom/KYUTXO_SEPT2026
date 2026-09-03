import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);
const { ProtectedStoreClient, MESSAGE_TYPES } = requireCjs("./protected-store.cjs");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeClient() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kyutxo-protected-"));
  roots.push(root);
  return { root, client: new ProtectedStoreClient({ dataDir: root }) };
}

describe("protected store", () => {
  it("encrypts rows and attachment chunks, locks closed, and re-wraps the VDK", async () => {
    const { root, client } = makeClient();
    const rowPlaintext = "recognizable-row-plaintext";
    const attachmentPlaintext = Buffer.from("recognizable-attachment-plaintext");
    try {
      await client.call(MESSAGE_TYPES.CREATE, { password: "correct horse battery staple" });
      await client.call(MESSAGE_TYPES.PUT_ROW, {
        table: "records",
        id: "42",
        row: { note: rowPlaintext },
      });
      const object = await client.call(MESSAGE_TYPES.WRITE_ATTACHMENT, {
        bytes: attachmentPlaintext,
        alias: "record/file.bin",
      });

      const dbBytes = fs.readFileSync(path.join(root, "protected-store.sqlite"));
      const objectBytes = fs.readFileSync(path.join(root, "protected-objects", object.name));
      expect(dbBytes.includes(rowPlaintext)).toBe(false);
      expect(objectBytes.includes(attachmentPlaintext)).toBe(false);
      expect(Buffer.from(await client.call(MESSAGE_TYPES.READ_ATTACHMENT, object))).toEqual(attachmentPlaintext);
      expect(
        Buffer.from(await client.call(MESSAGE_TYPES.READ_ATTACHMENT, { alias: "record/file.bin" })),
      ).toEqual(attachmentPlaintext);

      await client.call(MESSAGE_TYPES.CHANGE_PASSWORD, {
        oldPassword: "correct horse battery staple",
        newPassword: "a different strong password",
      });
      await client.call(MESSAGE_TYPES.LOCK);
      await expect(client.call(MESSAGE_TYPES.GET_ROW, { table: "records", id: "42" })).rejects.toThrow();
      await expect(client.call(MESSAGE_TYPES.UNLOCK, { password: "correct horse battery staple" })).rejects.toThrow();
      await client.call(MESSAGE_TYPES.UNLOCK, { password: "a different strong password" });
      expect(await client.call(MESSAGE_TYPES.GET_ROW, { table: "records", id: "42" })).toEqual({ note: rowPlaintext });
    } finally {
      await client.close();
    }
  }, 30_000);

  it("detects encrypted attachment tampering", async () => {
    const { root, client } = makeClient();
    try {
      await client.call(MESSAGE_TYPES.CREATE, { password: "test password" });
      const object = await client.call(MESSAGE_TYPES.WRITE_ATTACHMENT, {
        bytes: Buffer.from("authenticated bytes"),
      });
      const objectPath = path.join(root, "protected-objects", object.name);
      const bytes = fs.readFileSync(objectPath);
      bytes[bytes.length - 8] ^= 0xff;
      fs.writeFileSync(objectPath, bytes);
      await expect(client.call(MESSAGE_TYPES.READ_ATTACHMENT, object)).rejects.toThrow(
        "Protected store operation failed",
      );
    } finally {
      await client.close();
    }
  }, 30_000);
});
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);
const {
  ProtectedStoreClient,
  MESSAGE_TYPES,
  PROTECTED_TABLES,
} = requireCjs("./protected-store.cjs");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
      await client.call(MESSAGE_TYPES.CREATE, {
        password: "correct horse battery staple",
      });
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
      const objectBytes = fs.readFileSync(
        path.join(root, "protected-objects", object.name),
      );
      expect(dbBytes.includes(rowPlaintext)).toBe(false);
      expect(objectBytes.includes(attachmentPlaintext)).toBe(false);
      expect(
        Buffer.from(await client.call(MESSAGE_TYPES.READ_ATTACHMENT, object)),
      ).toEqual(attachmentPlaintext);
      expect(
        Buffer.from(
          await client.call(MESSAGE_TYPES.READ_ATTACHMENT, {
            alias: "record/file.bin",
          }),
        ),
      ).toEqual(attachmentPlaintext);

      await client.call(MESSAGE_TYPES.CHANGE_PASSWORD, {
        oldPassword: "correct horse battery staple",
        newPassword: "a different strong password",
      });
      await client.call(MESSAGE_TYPES.LOCK);
      await expect(
        client.call(MESSAGE_TYPES.GET_ROW, { table: "records", id: "42" }),
      ).rejects.toThrow();
      await expect(
        client.call(MESSAGE_TYPES.UNLOCK, {
          password: "correct horse battery staple",
        }),
      ).rejects.toThrow();
      await client.call(MESSAGE_TYPES.UNLOCK, {
        password: "a different strong password",
      });
      expect(
        await client.call(MESSAGE_TYPES.GET_ROW, {
          table: "records",
          id: "42",
        }),
      ).toEqual({ note: rowPlaintext });
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
      await expect(
        client.call(MESSAGE_TYPES.READ_ATTACHMENT, object),
      ).rejects.toThrow("Protected store operation failed");
    } finally {
      await client.close();
    }
  }, 30_000);

  it("enumerates every canonical table and preserves numeric keys and nulls", async () => {
    const { client } = makeClient();
    try {
      await client.call(MESSAGE_TYPES.CREATE, { password: "test password" });
      for (const table of PROTECTED_TABLES) {
        await client.call(MESSAGE_TYPES.PUT_ROW, {
          table,
          id: table === "transactionParticipants" ? 10 : `key-${table}`,
          row: { nullable: null, table },
        });
      }
      await client.call(MESSAGE_TYPES.PUT_ROW, {
        table: "transactionParticipants",
        id: 2,
        row: { nullable: null, ordinal: 2 },
      });
      for (const table of PROTECTED_TABLES) {
        const page = await client.call(MESSAGE_TYPES.LIST_ROWS, {
          table,
          after: null,
          limit: 100,
        });
        expect(page.length).toBeGreaterThan(0);
        expect(page[0].row.nullable).toBeNull();
      }
      const numeric = await client.call(MESSAGE_TYPES.LIST_ROWS, {
        table: "transactionParticipants",
        after: null,
        limit: 100,
      });
      expect(numeric.map((entry: { id: number }) => entry.id)).toEqual([2, 10]);
      expect(
        await client.call(MESSAGE_TYPES.GET_ROW, {
          table: "transactionParticipants",
          id: 10,
        }),
      ).toEqual({ nullable: null, table: "transactionParticipants" });
    } finally {
      await client.close();
    }
  }, 30_000);

  it("verifies large attachment cardinality through bounded pages", async () => {
    const { client } = makeClient();
    try {
      await client.call(MESSAGE_TYPES.CREATE, { password: "test password" });
      for (let index = 0; index < 125; index++) {
        await client.call(MESSAGE_TYPES.WRITE_ATTACHMENT, {
          alias: `attachment-${String(index).padStart(4, "0")}`,
          bytes: Buffer.from([index & 0xff]),
        });
      }
      const first = await client.call(MESSAGE_TYPES.VERIFY_ATTACHMENTS, {
        after: "",
        limit: 50,
      });
      const second = await client.call(MESSAGE_TYPES.VERIFY_ATTACHMENTS, {
        after: first.at(-1).id,
        limit: 50,
      });
      const third = await client.call(MESSAGE_TYPES.VERIFY_ATTACHMENTS, {
        after: second.at(-1).id,
        limit: 50,
      });
      expect(first).toHaveLength(50);
      expect(second).toHaveLength(50);
      expect(third).toHaveLength(25);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("keeps every v44 normalized record-model row encrypted across a protected reopen", async () => {
    const { root, client } = makeClient();
    const password = "v44 protected migration password";
    const rows = [
      [
        "entities",
        "entity-1",
        {
          naturalKey: "person:alice",
          name: "KYUTXO_V44_ENTITY_1f32a",
          kind: "person",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      [
        "wallets",
        "wallet-1",
        {
          naturalKey: "wallet:alice:cold",
          name: "KYUTXO_V44_WALLET_2d45b",
          entityId: 1,
          seedName: "KYUTXO_V44_SEED_3e56c",
          walletSoftware: "KYUTXO_V44_SOFTWARE_4f67d",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      [
        "addressOwnership",
        "ownership-1",
        {
          recordId: 42,
          state: "assigned",
          entityId: 1,
          walletId: 1,
          confidence: "manual",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      [
        "transactionMetadata",
        "metadata-1",
        {
          txid: "KYUTXO_V44_TXID_5a78e",
          flowType: "received",
          categories: ["KYUTXO_V44_CATEGORY_6b89f"],
          tags: ["KYUTXO_V44_TAG_7c90a"],
          notes: "KYUTXO_V44_NOTE_8d01b",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      [
        "transactionLegMetadata",
        "leg-1",
        {
          txid: "KYUTXO_V44_TXID_5a78e",
          legKey: "output:0",
          direction: "incoming",
          entityId: 1,
          walletId: 1,
          notes: "KYUTXO_V44_LEG_NOTE_9e12c",
          hasFlowOverride: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    ] as const;
    try {
      await client.call(MESSAGE_TYPES.CREATE, { password });
      for (const [table, id, row] of rows) {
        await client.call(MESSAGE_TYPES.PUT_ROW, { table, id, row });
      }

      const encryptedBytes = fs.readFileSync(
        path.join(root, "protected-store.sqlite"),
      );
      for (const token of [
        "KYUTXO_V44_ENTITY_1f32a",
        "KYUTXO_V44_WALLET_2d45b",
        "KYUTXO_V44_SEED_3e56c",
        "KYUTXO_V44_SOFTWARE_4f67d",
        "KYUTXO_V44_TXID_5a78e",
        "KYUTXO_V44_CATEGORY_6b89f",
        "KYUTXO_V44_TAG_7c90a",
        "KYUTXO_V44_NOTE_8d01b",
        "KYUTXO_V44_LEG_NOTE_9e12c",
      ]) {
        expect(encryptedBytes.includes(token)).toBe(false);
      }

      await client.close();
      const reopened = new ProtectedStoreClient({ dataDir: root });
      try {
        await reopened.call(MESSAGE_TYPES.UNLOCK, { password });
        for (const [table, id, row] of rows) {
          expect(
            await reopened.call(MESSAGE_TYPES.GET_ROW, { table, id }),
          ).toEqual(row);
        }
      } finally {
        await reopened.close();
      }
    } finally {
      await client.close();
    }
  }, 30_000);
});
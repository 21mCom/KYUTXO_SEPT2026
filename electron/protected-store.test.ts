import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
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

function makeFixtureClient() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kyutxo-protected-"));
  roots.push(root);
  return {
    root,
    client: new ProtectedStoreClient({ dataDir: root, enableTestFixtures: true }),
  };
}

describe("protected store", () => {
  it("keeps the preload delete/archive bridge on the typed command DTO", () => {
    const preload = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
    expect(preload).toContain("deleteOrArchiveRecords: (command) =>");
    expect(preload).toContain("repositoryCall('records', 'deleteOrArchiveRecords', command)");
  });

  it("keeps owner-book reports on fixed bounded protected-store vocabulary", () => {
    const preload = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
    const worker = fs.readFileSync(path.join(__dirname, "protected-store-worker.cjs"), "utf8");
    expect(preload).toContain("ownerCostBasisPage: (options) =>");
    expect(preload).toContain("repositoryCall('records', 'ownerCostBasisPage', { options })");
    expect(worker).toContain("'ownerCostBasisPage', 'ownerCostBasisProjection'");
    expect(worker).toContain("ownerBookCheckpoint = null");
    expect(worker).toContain("dataRevision++");
    expect(worker).not.toContain("message.sql");
  });

  it("reuses one prepared upsert throughout each protected repository batch", () => {
    const worker = fs.readFileSync(path.join(__dirname, "protected-store-worker.cjs"), "utf8");
    expect(worker).toContain("let saveStatement;");
    expect(worker).toContain("saveStatement ??= db.prepare(`");
    expect(worker).toContain("saveStatement.run(");
    expect(worker).not.toContain("`).run(idKey(saved.id)");
  });

  it("returns fixed mirror fingerprints without exposing renderer-defined queries", async () => {
    const { client } = makeClient();
    const call = (collection: string, operation: string, payload: object = {}) =>
      client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: collection === "blockchainTransactions" || collection === "transactionParticipants"
          ? "transactions" : "records",
        collection,
        operation,
        ...payload,
      });
    try {
      await client.call(MESSAGE_TYPES.CREATE, { password: "mirror fingerprint test password" });
      await call("records", "saveBatch", { rows: [
        { id: 2, type: "address", inputString: "a", updatedAt: 11 },
        { id: 7, type: "address", inputString: "b", updatedAt: 29 },
      ] });
      await call("blockchainTransactions", "save", {
        row: { id: 5, txid: "tx", blockTime: 123 },
      });
      await call("transactionParticipants", "saveBatch", { rows: [
        { id: 3, txid: "tx", role: "input", prevTxid: "prev", prevVout: 0 },
        { id: 8, txid: "tx", role: "output", vout: 0 },
      ] });
      await call("transactionMetadata", "save", {
        row: { id: 4, txid: "tx", updatedAt: 31 },
      });

      await expect(call("records", "fingerprint")).resolves.toEqual({
        count: 2, maxId: 7, maxUpdatedAt: 29,
      });
      await expect(call("blockchainTransactions", "fingerprint")).resolves.toEqual({
        count: 1, maxId: 5, maxBlockTime: 123,
      });
      await expect(call("transactionParticipants", "fingerprint")).resolves.toEqual({
        count: 2, maxId: 8, resolvedPrevoutCount: 1,
      });
      await expect(call("transactionMetadata", "fingerprint")).resolves.toEqual({
        count: 1, maxId: 4, maxUpdatedAt: 31,
      });
      await expect(call("owners", "fingerprint")).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

  it("pages curated record tiers through the fixed protected keyset query", async () => {
    const { client } = makeClient();
    const call = (collection: string, operation: string, payload: object = {}) =>
      client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: "records",
        collection,
        operation,
        ...payload,
      });
    try {
      await client.call(MESSAGE_TYPES.CREATE, { password: "curated record query test password" });
      await call("records", "saveBatch", { rows: [
        { id: 1, type: "address", inputString: "manual-a", addressImportance: "manual" },
        { id: 2, type: "address", inputString: "discovered", addressImportance: "blockchain-discovered" },
        { id: 3, type: "transaction", inputString: "tx", addressImportance: "manual" },
        { id: 4, type: "address", inputString: "manual-b", addressImportance: "critical" },
      ] });

      await expect(call("records", "query", {
        name: "records.byTypeAndImportanceTiersKeyset",
        value: { type: "address", tiers: ["manual", "critical"] },
        limit: 10,
      })).resolves.toEqual({ items: [
        { id: 4, type: "address", inputString: "manual-b", addressImportance: "critical" },
        { id: 1, type: "address", inputString: "manual-a", addressImportance: "manual" },
      ] });
      await expect(call("records", "query", {
        name: "records.byTypeAndImportanceTiersKeyset",
        value: { type: "address", tiers: ["manual", "critical"], beforeIdExclusive: 4 },
        limit: 10,
      })).resolves.toEqual({ items: [
        { id: 1, type: "address", inputString: "manual-a", addressImportance: "manual" },
      ] });
    } finally {
      await client.close();
    }
  });

  it("persists encrypted owner pages across unlock and rejects stale protected checkpoints", async () => {
    const { root, client } = makeClient();
    const call = (collection: string, operation: string, payload: object = {}) =>
      client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: collection === "blockchainTransactions" || collection === "transactionParticipants"
          ? "transactions" : "records",
        collection,
        operation,
        ...payload,
      });
    try {
      await client.call(MESSAGE_TYPES.CREATE, { password: "owner book test password" });
      await call("owners", "save", { row: { id: 1, name: "Alice", createdAt: 1 } });
      await call("records", "save", { row: {
        id: 1, type: "address", inputString: "owned", label: "", tags: [], categories: [],
        owner: "Alice", addressImportance: "manual",
      } });
      const requested = Number(process.env.KYUTXO_OWNER_BOOK_PROTECTED_SCALE_ROWS ?? 2_000);
      const count = Math.min(1_000_000, Math.max(2_000, Number.isSafeInteger(requested) ? requested : 2_000));
      for (let offset = 0; offset < count; offset += 1_000) {
        const size = Math.min(1_000, count - offset);
        await call("blockchainTransactions", "saveBatch", { rows: Array.from({ length: size }, (_, j) => {
          const i = offset + j;
          return { id: i + 1, txid: `scale-${i}`, blockHeight: i + 1,
            blockTime: 1_700_000_000 + i, fee: 0, feeRate: 0, syncedAt: 1 };
        }) });
        await call("transactionParticipants", "saveBatch", { rows: Array.from({ length: size }, (_, j) => {
          const i = offset + j;
          return { id: i + 1, txid: `scale-${i}`, role: "output", address: "owned", amount: 1, vout: 0 };
        }) });
      }
      const started = performance.now();
      const first = await call("records", "ownerCostBasisPage", { options: { limit: 25 } });
      const buildMs = performance.now() - started;
      const cachedStarted = performance.now();
      const second = await call("records", "ownerCostBasisPage", { options: { limit: 25 } });
      const cachedMs = performance.now() - cachedStarted;
      expect(first.openBatchesTotal).toBe(count);
      expect(first.openBatches).toHaveLength(25);
      expect(first.byOwner.length).toBeLessThanOrEqual(25);
      expect(first.disposals.length).toBeLessThanOrEqual(25);
      expect(JSON.stringify(first)).not.toContain('"allocations"');
      expect(second).toEqual(first);
      expect(cachedMs).toBeLessThan(buildMs * 0.25);
      expect(first.checkpointKey).toMatch(/owner-book:protected:v4:owner-cost-basis:v1:.*:[a-f0-9]{64}:[a-f0-9]{64}:/);
      const sqliteBytes = fs.readFileSync(path.join(root, "protected-store.sqlite"));
      expect(sqliteBytes.includes(Buffer.from("scale-1999"))).toBe(false);

      await client.call(MESSAGE_TYPES.LOCK);
      await client.call(MESSAGE_TYPES.UNLOCK, { password: "owner book test password" });
      const reopenedStarted = performance.now();
      const reopened = await call("records", "ownerCostBasisPage", { options: { limit: 25 } });
      const reopenedMs = performance.now() - reopenedStarted;
      expect(reopened).toEqual(first);
      expect(reopenedMs).toBeLessThan(buildMs);

      await call("transactionMetadata", "save", { row: { id: 1, txid: "scale-0", costBasisUsd: 2, updatedAt: 2 } });
      await expect(call("records", "ownerCostBasisPage", {
        options: { limit: 1, expectedCheckpointKey: first.checkpointKey },
      })).rejects.toThrow();
      const metadataCheckpoint = await call("records", "ownerCostBasisPage", { options: { limit: 1 } });
      // Same primary key and revision still changes the exact source hash.
      await call("transactionMetadata", "save", { row: { id: 1, txid: "scale-0", costBasisUsd: 3, updatedAt: 2 } });
      const replacedCheckpoint = await call("records", "ownerCostBasisPage", { options: { limit: 1 } });
      expect(replacedCheckpoint.checkpointKey).not.toBe(metadataCheckpoint.checkpointKey);

      // Policy-only content participates in both the source and policy hashes.
      await call("owners", "save", { row: { id: 1, name: "Alice", createdAt: 1, defaultMatchingMethod: "lifo" } });
      const policyCheckpoint = await call("records", "ownerCostBasisPage", { options: { limit: 1 } });
      expect(policyCheckpoint.checkpointKey).not.toBe(replacedCheckpoint.checkpointKey);

      await expect(client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: "vault", collection: "settings", operation: "restoreCommit",
        replaceExisting: true,
        rows: { records: [{ id: 2, label: "x".repeat(17 * 1024 * 1024) }] },
      })).rejects.toThrow("Protected store operation failed");
      await expect(call("records", "ownerCostBasisPage", {
        options: { limit: 1, expectedCheckpointKey: policyCheckpoint.checkpointKey },
      })).resolves.toMatchObject({ checkpointKey: policyCheckpoint.checkpointKey });

      await client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: "vault", collection: "settings", operation: "restoreCommit",
        replaceExisting: true, rows: { records: [] },
      });
      const restoredCheckpoint = await call("records", "ownerCostBasisPage", { options: { limit: 1 } });
      expect(restoredCheckpoint.checkpointKey).not.toBe(policyCheckpoint.checkpointKey);
      expect(restoredCheckpoint.openBatchesTotal).toBe(0);
      await client.call(MESSAGE_TYPES.LOCK);
      await expect(call("records", "ownerCostBasisPage", { options: { limit: 1 } })).rejects.toThrow();
    } finally {
      await client.close();
    }
  }, 30_000);

  it("rebuilds every malformed encrypted owner report section without changing vault sources or attachments", async () => {
    const { client } = makeFixtureClient();
    const password = "damaged owner report test password";
    const call = (collection: string, operation: string, payload: object = {}) =>
      client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: collection === "blockchainTransactions" || collection === "transactionParticipants"
          ? "transactions" : "records",
        collection,
        operation,
        ...payload,
      });
    const sourceRows = {
      owner: { id: 1, name: "Alice", createdAt: 1 },
      record: {
        id: 1, type: "address", inputString: "owned", label: "", tags: [], categories: [],
        owner: "Alice", addressImportance: "manual",
      },
      transaction: {
        id: 1, txid: "damaged-cache-source", blockHeight: 1,
        blockTime: 1_700_000_000, fee: 0, feeRate: 0, syncedAt: 1,
      },
      participant: {
        id: 1, txid: "damaged-cache-source", role: "output",
        address: "owned", amount: 25_000, vout: 0,
      },
    };
    const attachmentBytes = Buffer.from("owner-report-cache-attachment-sentinel");
    try {
      await client.call(MESSAGE_TYPES.CREATE, { password });
      await call("owners", "save", { row: sourceRows.owner });
      await call("records", "save", { row: sourceRows.record });
      await call("blockchainTransactions", "save", { row: sourceRows.transaction });
      await call("transactionParticipants", "save", { row: sourceRows.participant });
      const attachment = await client.call(MESSAGE_TYPES.WRITE_ATTACHMENT, {
        alias: "records/owner-report-proof.bin",
        bytes: attachmentBytes,
      });

      const valid = await call("records", "ownerCostBasisPage", { options: { limit: 25 } });
      expect(valid.openBatchesTotal).toBe(1);
      for (const section of [
        "batches", "disposals", "allocations", "warnings", "assumptions", "byOwner",
      ]) {
        await client.call("testDamageOwnerReportCache", { section });
        await client.call(MESSAGE_TYPES.LOCK);
        await client.call(MESSAGE_TYPES.UNLOCK, { password });
        const rebuilt = await call("records", "ownerCostBasisPage", { options: { limit: 25 } });
        expect(rebuilt, section).toEqual(valid);
      }
      await expect(call("owners", "find", { id: 1 })).resolves.toEqual(sourceRows.owner);
      await expect(call("records", "find", { id: 1 })).resolves.toEqual(sourceRows.record);
      await expect(call("blockchainTransactions", "find", { id: 1 }))
        .resolves.toEqual(sourceRows.transaction);
      await expect(call("transactionParticipants", "find", { id: 1 }))
        .resolves.toEqual(sourceRows.participant);
      expect(Buffer.from(await client.call(MESSAGE_TYPES.READ_ATTACHMENT, attachment)))
        .toEqual(attachmentBytes);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("encrypts rows and attachment chunks, locks closed, and re-wraps the VDK", async () => {
    const { root, client } = makeClient();
    const rowPlaintext = "recognizable-row-plaintext";
    const attachmentPlaintext = Buffer.from("recognizable-attachment-plaintext");
    try {
      await client.call(MESSAGE_TYPES.CREATE, { password: "correct horse battery staple" });
      await client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: "records",
        collection: "records",
        operation: "save",
        row: { id: 42, note: rowPlaintext, nullable: null },
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
      await expect(client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: "records", collection: "records", operation: "find", id: 42,
      })).rejects.toThrow();
      await expect(client.call(MESSAGE_TYPES.UNLOCK, { password: "correct horse battery staple" })).rejects.toThrow();
      await client.call(MESSAGE_TYPES.UNLOCK, { password: "a different strong password" });
      expect(await client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: "records", collection: "records", operation: "find", id: 42,
      })).toEqual({ id: 42, note: rowPlaintext, nullable: null });
    } finally {
      await client.close();
    }
  }, 30_000);

  it("uses bounded typed repository pages with numeric ID order", async () => {
    const { client } = makeClient();
    try {
      await client.call(MESSAGE_TYPES.CREATE, { password: "test password" });
      await client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: "records", collection: "records", operation: "saveBatch",
        rows: [{ id: 10, label: "ten" }, { id: 2, label: "two" }, { id: 30, label: "thirty" }],
      });
      const first = await client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: "records", collection: "records", operation: "page", limit: 2,
      });
      expect(first.items.map((row: { id: number }) => row.id)).toEqual([2, 10]);
      const second = await client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: "records", collection: "records", operation: "page", after: first.next, limit: 2,
      });
      expect(second.items.map((row: { id: number }) => row.id)).toEqual([30]);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("applies the bounded named records filter DTO without exposing a query builder", async () => {
    const { client } = makeClient();
    try {
      await client.call(MESSAGE_TYPES.CREATE, { password: "test password" });
      await client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: "records", collection: "records", operation: "saveBatch",
        rows: [
          { id: 1, type: "address", inputString: "bc1qfirst", label: "Cold wallet", tags: ["vault"], addressImportance: "verified", createdAt: 20 },
          { id: 2, type: "address", inputString: "bc1qsecond", label: "Discovered", tags: ["vault"], addressImportance: "blockchain-discovered", createdAt: 30 },
          { id: 3, type: "transaction", label: "Cold spend", tags: ["spend"], addressImportance: "manual", createdAt: 10 },
        ],
      });
      const result = await client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: "records", collection: "records", operation: "query",
        name: "records.filtered", limit: 100,
        value: {
          search: "cold",
          filters: [{ field: "tags", operator: "includes", value: "vault" }],
          includeBlockchainDiscovered: false,
          order: "created-desc",
        },
      });
      expect(result.items.map((row: { id: number }) => row.id)).toEqual([1]);
      const byIdentifiers = await client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: "records", collection: "records", operation: "query",
        name: "records.byInputStrings", limit: 2,
        value: ["bc1qfirst", "bc1qsecond"],
      });
      expect(byIdentifiers.items.map((row: { id: number }) => row.id)).toEqual([1, 2]);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("pages stats and dormant-scan named queries at bounded keyset boundaries", async () => {
    const { client } = makeClient();
    const request = (
      repository: string,
      collection: string,
      name: string,
      value: unknown,
      limit: number,
    ) => client.call(MESSAGE_TYPES.REPOSITORY, {
      repository, collection, operation: "query", name, value, limit,
    });
    try {
      await client.call(MESSAGE_TYPES.CREATE, { password: "test password" });
      await client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: "records", collection: "records", operation: "saveBatch",
        rows: [
          { id: 1, type: "address", inputString: "bc1first" },
          { id: 2, type: "transaction", inputString: "a".repeat(64) },
          { id: 3, type: "address", inputString: "bc1second" },
        ],
      });
      const addresses = await request(
        "records", "records", "records.byTypeIdForwardKeyset",
        { type: "address", afterIdExclusive: 1 }, 1,
      );
      expect(addresses.items.map((row: { id: number }) => row.id)).toEqual([3]);
      expect((await request("records", "records", "records.countByType", "address", 1)).items)
        .toEqual([{ count: 2 }]);

      await client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: "transactions", collection: "transactionParticipants", operation: "saveBatch",
        rows: Array.from({ length: 1000 }, (_, index) => ({
          id: index + 1, txid: `tx-${index}`, role: index % 2 ? "input" : "output",
          address: "busy-address", amount: index,
        })),
      });
      await expect(client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: "transactions", collection: "transactionParticipants", operation: "saveBatch",
        rows: Array.from({ length: 5001 }, (_, index) => ({
          id: index + 2000, txid: `oversized-${index}`, role: "output",
          address: "busy-address", amount: index,
        })),
      })).rejects.toThrow("Protected store operation failed");
      await client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: "transactions", collection: "transactionParticipants", operation: "save",
        row: { id: 1001, txid: "tx-1000", role: "output", address: "busy-address", amount: 1000 },
      });
      const firstPage = await request(
        "transactions", "transactionParticipants", "participants.afterId", 0, 1000,
      );
      expect(firstPage.items).toHaveLength(1000);
      expect(firstPage.items[0].id).toBe(1);
      const finalPage = await request(
        "transactions", "transactionParticipants", "participants.afterId", 999, 1000,
      );
      expect(finalPage.items.map((row: { id: number }) => row.id)).toEqual([1000, 1001]);
      const busyFirst = await request(
        "transactions", "transactionParticipants", "participants.byAddressesAfterId",
        { addresses: ["busy-address"], afterId: 0 }, 1000,
      );
      expect(busyFirst.items).toHaveLength(1000);
      const busySecond = await request(
        "transactions", "transactionParticipants", "participants.byAddressesAfterId",
        { addresses: ["busy-address"], afterId: busyFirst.items[999].id }, 1000,
      );
      expect(busySecond.items.map((row: { id: number }) => row.id)).toEqual([1001]);

      await client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: "lineage", collection: "utxoLineage", operation: "saveBatch",
        rows: [
          { id: 1, createdTxid: "fund-a", createdVout: 0, isChange: true },
          { id: 2, createdTxid: "fund-b", createdVout: 1, isChange: false },
        ],
      });
      const lineage = await request(
        "lineage", "utxoLineage", "lineage.byCreatedOutpoints",
        [["fund-b", 1], ["missing", 0]], 2,
      );
      expect(lineage.items.map((row: { id: number }) => row.id)).toEqual([2]);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("keeps string cursors opaque, allocates IDs, and atomically applies batches", async () => {
    const { client } = makeClient();
    const request = (operation: string, payload: Record<string, unknown> = {}) =>
      client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: "privacy", collection: "networkPrivacyActivity", operation, ...payload,
      });
    try {
      await client.call(MESSAGE_TYPES.CREATE, { password: "test password" });
      const saved = await request("save", { row: { label: "native allocated" } });
      expect(saved.id).toBe(1);
      await request("saveBatch", { rows: [{ id: "a", value: 1 }, { id: "z", value: 2 }] });
      const strings = await request("page", { after: "a", limit: 1 });
      expect(strings.next).toBe("z");
      expect(strings.items.map((row: { id: string | number }) => row.id)).toEqual(["z"]);
      const result = await request("batch", {
        operations: [
          { operation: "save", row: { id: "b", value: 3 } },
          { operation: "remove", id: "a" },
        ],
      });
      expect(result.results).toEqual([
        { operation: "save", id: "b" },
        { operation: "remove", deleted: true },
      ]);
      expect(await request("find", { id: "a" })).toBeNull();
      expect(await request("find", { id: "b" })).toEqual({ id: "b", value: 3 });
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

  it("rolls back native transaction and participant commits on a mid-command failure", async () => {
    const { client } = makeClient();
    try {
      await client.call(MESSAGE_TYPES.CREATE, { password: "test password" });
      const txid = "a".repeat(64);
      await expect(client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: "transactions",
        collection: "blockchainTransactions",
        operation: "saveTransactionWithParticipants",
        transaction: { id: 77, txid, blockTime: 1 },
        participants: [
          { id: 88, txid, role: "output", address: "ok", amount: 1, vout: 0 },
          { id: 89, txid, role: "output", address: "too-large", amount: 1, note: "x".repeat(17 * 1024 * 1024) },
        ],
      })).rejects.toThrow("Protected store operation failed");

      expect(await client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: "transactions", collection: "blockchainTransactions", operation: "find", id: 77,
      })).toBeNull();
      expect(await client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: "transactions", collection: "transactionParticipants", operation: "find", id: 88,
      })).toBeNull();
    } finally {
      await client.close();
    }
  }, 30_000);

  it("keyset-pages participants for bounded txid queries", async () => {
    const { client } = makeClient();
    try {
      await client.call(MESSAGE_TYPES.CREATE, { password: "test password" });
      const txid = "b".repeat(64);
      await client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: "transactions",
        collection: "blockchainTransactions",
        operation: "saveTransactionWithParticipants",
        transaction: { id: 7, txid, blockTime: 1 },
        participants: [0, 1, 2].map((vout) => ({
          txid, role: "output", address: `address-${vout}`, amount: 1, vout,
        })),
      });
      const first = await client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: "transactions", collection: "transactionParticipants",
        operation: "query", name: "participants.byTxidsAfterId",
        value: { txids: [txid], afterId: 0 }, limit: 2,
      });
      expect(first.items.map((row: { id: number }) => row.id)).toEqual([1, 2]);
      const second = await client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: "transactions", collection: "transactionParticipants",
        operation: "query", name: "participants.byTxidsAfterId",
        value: { txids: [txid], afterId: 2 }, limit: 2,
      });
      expect(second.items.map((row: { id: number }) => row.id)).toEqual([3]);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("rolls back a native replacement restore when any row cannot be saved", async () => {
    const { client } = makeClient();
    try {
      await client.call(MESSAGE_TYPES.CREATE, { password: "test password" });
      await client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: "records", collection: "records", operation: "save",
        row: { id: 1, label: "existing" },
      });
      await expect(client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: "vault",
        collection: "settings",
        operation: "restoreCommit",
        replaceExisting: true,
        rows: {
          records: [
            { id: 2, label: "replacement" },
            { id: 3, label: "x".repeat(17 * 1024 * 1024) },
          ],
        },
      })).rejects.toThrow("Protected store operation failed");

      expect(await client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: "records", collection: "records", operation: "find", id: 1,
      })).toEqual({ id: 1, label: "existing" });
      expect(await client.call(MESSAGE_TYPES.REPOSITORY, {
        repository: "records", collection: "records", operation: "find", id: 2,
      })).toBeNull();
    } finally {
      await client.close();
    }
  }, 30_000);

  it("keeps normalized record-model rows encrypted across a protected reopen", async () => {
    const { root, client } = makeClient();
    const password = "v44 protected migration password";
    const rows = [
      ["entities", { id: 1, naturalKey: "person:alice", name: "KYUTXO_V44_ENTITY_1f32a", kind: "person", createdAt: 1, updatedAt: 1 }],
      ["wallets", { id: 1, naturalKey: "wallet:alice:cold", name: "KYUTXO_V44_WALLET_2d45b", entityId: 1, createdAt: 1, updatedAt: 1 }],
      ["addressOwnership", { id: 1, recordId: 42, state: "assigned", entityId: 1, createdAt: 1, updatedAt: 1 }],
      ["transactionMetadata", { id: 1, txid: "KYUTXO_V44_TXID_5a78e", notes: "KYUTXO_V44_NOTE_8d01b", createdAt: 1, updatedAt: 1 }],
      ["transactionLegMetadata", { id: 1, txid: "KYUTXO_V44_TXID_5a78e", legKey: "output:0", direction: "incoming", notes: "KYUTXO_V44_LEG_NOTE_9e12c", createdAt: 1, updatedAt: 1 }],
    ] as const;
    try {
      await client.call(MESSAGE_TYPES.CREATE, { password });
      for (const [collection, row] of rows) {
        await client.call(MESSAGE_TYPES.REPOSITORY, {
          repository: "records", collection, operation: "save", row,
        });
      }
      const encryptedBytes = fs.readFileSync(path.join(root, "protected-store.sqlite"));
      for (const token of [
        "KYUTXO_V44_ENTITY_1f32a", "KYUTXO_V44_WALLET_2d45b",
        "KYUTXO_V44_TXID_5a78e", "KYUTXO_V44_NOTE_8d01b",
        "KYUTXO_V44_LEG_NOTE_9e12c",
      ]) expect(encryptedBytes.includes(token)).toBe(false);

      await client.close();
      const reopened = new ProtectedStoreClient({ dataDir: root });
      try {
        await reopened.call(MESSAGE_TYPES.UNLOCK, { password });
        for (const [collection, row] of rows) {
          expect(await reopened.call(MESSAGE_TYPES.REPOSITORY, {
            repository: "records", collection, operation: "find", id: row.id,
          })).toEqual(row);
        }
      } finally {
        await reopened.close();
      }
    } finally {
      await client.close();
    }
  }, 30_000);

  it("normalizes HKDF output before formatting the SQLCipher key", () => {
    const workerSource = fs.readFileSync(
      path.join(process.cwd(), "electron", "protected-store-worker.cjs"),
      "utf8",
    );
    expect(workerSource).toMatch(
      /return Buffer\.from\(\s*crypto\.hkdfSync\([\s\S]*?\)\s*,?\s*\);/,
    );
    expect(Buffer.from(crypto.hkdfSync(
      "sha256",
      Buffer.alloc(32, 1),
      Buffer.alloc(16, 2),
      Buffer.from("kyutxo/sqlcipher/v1"),
      32,
    )).toString("hex")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("limits native initialization diagnostics to fixed non-sensitive stages", () => {
    const workerSource = fs.readFileSync(
      path.join(process.cwd(), "electron", "protected-store-worker.cjs"),
      "utf8",
    );
    expect(workerSource).toContain(
      "console.error(`[ProtectedStore] database initialization failed during ${stage}`)",
    );
    expect(workerSource).toContain(
      "console.error(`[ProtectedStore] vault creation failed during ${stage}`)",
    );
    expect(workerSource).not.toMatch(/console\.error\([^)]*\b(?:error|err)\b/);
    const clientSource = fs.readFileSync(
      path.join(process.cwd(), "electron", "protected-store.cjs"),
      "utf8",
    );
    expect(clientSource).toContain("SAFE_DIAGNOSTIC_STAGE.test(message.diagnosticStage || '')");
    expect(clientSource).toContain(
      "pending.reject(new Error('Protected store operation failed'))",
    );
  });
});

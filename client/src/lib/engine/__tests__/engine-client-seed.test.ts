// @vitest-environment jsdom
//
// Renderer-side seed orchestration tests (Task #275).
//
// The pure SQL core is covered separately (engine-core.test.ts). This suite
// covers the RENDERER half of the vault-to-engine copy:
//   - the Dexie -> mirror row mappers (mapRecord / mapTransaction / mapParticipant)
//     across null / boolean / array fields, and
//   - the seedAll PUSH loop driven over real (fake) IndexedDB with the engine
//     IPC bridge MOCKED: keyset paging (batches + lastId) and the cancel-mid-seed
//     path that must drop the partial mirror via clear() and report a cancelled
//     result instead of finishing.
//
// jsdom gives us `window` (for window.electronAPI) and fake-indexeddb/auto gives
// us a real IndexedDB to read the source vault from.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mapRecord,
  mapTransaction,
  mapParticipant,
  mapTransactionMetadata,
  seedAll,
  cancelSeeding,
  __setSeedChunkSizeForTests,
  __setSeedYieldForTests,
  type SeedProgress,
} from "../engine-client";
import type { EngineEnvelope } from "../../electron";

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

describe("engine-client mappers", () => {
  describe("mapRecord", () => {
    it("fills sensible defaults for a sparse Dexie object", () => {
      const r = mapRecord({ id: 7, inputString: "BC1QFoo" });
      expect(r.id).toBe(7);
      // type defaults to 'other' when absent
      expect(r.type).toBe("other");
      // inputStringLower derived from inputString when absent
      expect(r.inputStringLower).toBe("bc1qfoo");
      // every optional text/int field becomes null (not undefined)
      expect(r.label).toBeNull();
      expect(r.notes).toBeNull();
      expect(r.owner).toBeNull();
      expect(r.syncDepth).toBeNull();
      expect(r.cachedBalanceSats).toBeNull();
      expect(r.createdAt).toBeNull();
      // array fields serialize to a JSON string, defaulting to "[]"
      expect(r.tags).toBe("[]");
      expect(r.categories).toBe("[]");
    });

    it("serializes array fields to JSON and coerces numbers via toInt", () => {
      const r = mapRecord({
        id: 1,
        inputString: "addr1",
        inputStringLower: "addr1",
        tags: ["cold", "exchange"],
        categories: ["personal"],
        // numeric-ish strings should coerce to numbers
        syncDepth: "5",
        cachedBalanceSats: "1000",
      });
      expect(r.tags).toBe(JSON.stringify(["cold", "exchange"]));
      expect(r.categories).toBe(JSON.stringify(["personal"]));
      expect(r.syncDepth).toBe(5);
      expect(r.cachedBalanceSats).toBe(1000);
    });

    it("treats non-array tag/category values as an empty JSON array", () => {
      const r = mapRecord({ id: 2, inputString: "a", tags: "not-an-array", categories: null });
      expect(r.tags).toBe("[]");
      expect(r.categories).toBe("[]");
    });

    it("derives inputStringLower from the canonical input string", () => {
      const r = mapRecord({ id: 3, inputString: "MixedCase", inputStringLower: "explicit" });
      expect(r.inputString).toBe("MixedCase");
      expect(r.inputStringLower).toBe("mixedcase");
    });
  });

  describe("mapTransaction", () => {
    it("maps a full transaction and keeps a numeric feeRate as-is", () => {
      const t = mapTransaction({
        id: 10,
        txid: "deadbeef",
        blockHeight: 800000,
        blockTime: 1700000000,
        fee: 250,
        feeRate: 12.5,
        vsize: 200,
        hasOpReturn: 1,
      });
      expect(t).toEqual({
        id: 10,
        txid: "deadbeef",
        blockHeight: 800000,
        blockTime: 1700000000,
        fee: 250,
        feeRate: 12.5, // preserved as a float, not truncated
        vsize: 200,
        hasOpReturn: 1,
      });
    });

    it("nulls out missing numeric fields and empties a missing txid", () => {
      const t = mapTransaction({ id: 11 });
      expect(t.id).toBe(11);
      expect(t.txid).toBe("");
      expect(t.blockHeight).toBeNull();
      expect(t.blockTime).toBeNull();
      expect(t.fee).toBeNull();
      expect(t.feeRate).toBeNull();
      expect(t.vsize).toBeNull();
      expect(t.hasOpReturn).toBeNull();
    });

    it("coerces a non-numeric feeRate through toInt", () => {
      const t = mapTransaction({ id: 12, txid: "x", feeRate: "3" });
      expect(t.feeRate).toBe(3);
    });

    it("maps a boolean hasOpReturn to 1/0", () => {
      expect(mapTransaction({ id: 1, hasOpReturn: true }).hasOpReturn).toBe(1);
      expect(mapTransaction({ id: 2, hasOpReturn: false }).hasOpReturn).toBe(0);
    });
  });

  describe("mapParticipant", () => {
    it("maps an output participant with all fields", () => {
      const p = mapParticipant({
        id: 20,
        txid: "tx1",
        role: "output",
        address: "addrA",
        amount: 5000,
        vout: 0,
        recordId: 99,
        scriptType: "v0_p2wpkh",
      });
      expect(p).toEqual({
        id: 20,
        txid: "tx1",
        role: "output",
        address: "addrA",
        amount: 5000,
        vout: 0,
        prevTxid: null,
        prevVout: null,
        recordId: 99,
        scriptType: "v0_p2wpkh",
      });
    });

    it("defaults role to output, address/txid to empty, amount to 0", () => {
      const p = mapParticipant({ id: 21 });
      expect(p.role).toBe("output");
      expect(p.txid).toBe("");
      expect(p.address).toBe("");
      expect(p.amount).toBe(0);
      expect(p.vout).toBeNull();
      expect(p.prevTxid).toBeNull();
      expect(p.prevVout).toBeNull();
      expect(p.recordId).toBeNull();
      expect(p.scriptType).toBeNull();
    });

    it("preserves an input participant's prevout linkage", () => {
      const p = mapParticipant({
        id: 22,
        txid: "tx2",
        role: "input",
        address: "addrB",
        amount: 300,
        prevTxid: "tx1",
        prevVout: 1,
      });
      expect(p.role).toBe("input");
      expect(p.prevTxid).toBe("tx1");
      expect(p.prevVout).toBe(1);
      // an input has no vout of its own
      expect(p.vout).toBeNull();
    });
  });

  describe("mapTransactionMetadata", () => {
    it("preserves finite cost-basis values and normalizes absent fields", () => {
      expect(mapTransactionMetadata({
        id: 31,
        txid: "tx31",
        acquisitionMethod: "purchase",
        costBasisUsd: 125.75,
        estimatedCostBasisUsd: 130.25,
        updatedAt: 1_700_000_031,
      })).toEqual({
        id: 31,
        txid: "tx31",
        acquisitionMethod: "purchase",
        costBasisUsd: 125.75,
        estimatedCostBasisUsd: 130.25,
        updatedAt: 1_700_000_031,
      });
      expect(mapTransactionMetadata({ id: 32, txid: "tx32" })).toEqual({
        id: 32,
        txid: "tx32",
        acquisitionMethod: null,
        costBasisUsd: null,
        estimatedCostBasisUsd: null,
        updatedAt: null,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// seedAll orchestration (fake IndexedDB source + mocked engine bridge)
// ---------------------------------------------------------------------------

const IDB_NAME = "KYUTXODatabase";
const STORES = ["records", "blockchainTransactions", "transactionParticipants", "transactionMetadata"] as const;
type Store = (typeof STORES)[number];

function deleteIdb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(IDB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

/** Create the source vault with the given rows per store (omit a store to skip it). */
function seedSourceIdb(data: Partial<Record<Store, Array<{ id: number } & Record<string, unknown>>>>): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store, { keyPath: "id" });
        }
      }
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(STORES as unknown as string[], "readwrite");
      for (const store of STORES) {
        const rows = data[store] ?? [];
        const os = tx.objectStore(store);
        for (const row of rows) os.put(row);
      }
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

interface MockEngine {
  init: ReturnType<typeof vi.fn>;
  seedBegin: ReturnType<typeof vi.fn>;
  seedBatch: ReturnType<typeof vi.fn>;
  seedFinish: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  benchmark: ReturnType<typeof vi.fn>;
  reopen: ReturnType<typeof vi.fn>;
  integrityCheck: ReturnType<typeof vi.fn>;
  generateSynthetic: ReturnType<typeof vi.fn>;
  dbInfo: ReturnType<typeof vi.fn>;
}

const ok = (result?: unknown): Promise<EngineEnvelope> => Promise.resolve({ ok: true, result });

function installMockEngine(overrides: Partial<MockEngine> = {}): MockEngine {
  const engine: MockEngine = {
    init: vi.fn(() => ok({ state: "EMPTY" })),
    seedBegin: vi.fn(() => ok()),
    seedBatch: vi.fn(() => ok()),
    seedFinish: vi.fn(() => ok()),
    clear: vi.fn(() => ok({ state: "EMPTY" })),
    status: vi.fn(() => ok({ state: "EMPTY" })),
    query: vi.fn(() => ok([])),
    benchmark: vi.fn(() => ok([])),
    reopen: vi.fn(() => ok()),
    integrityCheck: vi.fn(() => ok("ok")),
    generateSynthetic: vi.fn(() => ok()),
    dbInfo: vi.fn(() => ok({ dbPath: "/tmp/x", portableMode: false })),
    ...overrides,
  };
  (window as unknown as { electronAPI: { engine: MockEngine } }).electronAPI = { engine };
  return engine;
}

/** Collect all rows streamed to seedBatch for one table, in call order. */
function streamedRows(engine: MockEngine, table: Store): Array<{ id: number }> {
  return engine.seedBatch.mock.calls
    .filter((c) => c[0] === table)
    .flatMap((c) => c[1] as Array<{ id: number }>);
}

function batchSizes(engine: MockEngine, table: Store): number[] {
  return engine.seedBatch.mock.calls
    .filter((c) => c[0] === table)
    .map((c) => (c[1] as unknown[]).length);
}

describe("seedAll orchestration", () => {
  beforeEach(async () => {
    await deleteIdb();
    cancelSeeding(); // clear any leftover cancel flag from a prior test
    __setSeedChunkSizeForTests(3); // small batches so paging is exercised cheaply
  });

  afterEach(async () => {
    __setSeedChunkSizeForTests(); // restore production default
    __setSeedYieldForTests();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    await deleteIdb();
    vi.restoreAllMocks();
  });

  it("streams every table in keyset batches and finishes with the right source counts", async () => {
    await seedSourceIdb({
      records: [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id, inputString: `addr${id}` })),
      blockchainTransactions: [1, 2].map((id) => ({ id, txid: `tx${id}` })),
      transactionParticipants: [1, 2, 3, 4].map((id) => ({ id, txid: "tx1", role: "output", address: "a", amount: id })),
      transactionMetadata: [1, 2, 3, 4, 5].map((id) => ({ id, txid: `tx${id}`, acquisitionMethod: `method-${id}` })),
    });
    const engine = installMockEngine();
    const yieldedAfter: Array<{ table: Store; batches: number }> = [];
    __setSeedYieldForTests(async () => {
      const latest = engine.seedBatch.mock.calls.at(-1);
      yieldedAfter.push({
        table: latest?.[0] as Store,
        batches: engine.seedBatch.mock.calls.length,
      });
    });

    const progress: SeedProgress[] = [];
    const results = await seedAll((p) => progress.push(p));

    // Lifecycle: begin once, finish once, never cleared on success.
    expect(engine.seedBegin).toHaveBeenCalledTimes(1);
    expect(engine.seedFinish).toHaveBeenCalledTimes(1);
    expect(engine.clear).not.toHaveBeenCalled();
    expect(engine.seedFinish).toHaveBeenCalledWith({
      records: 7,
      blockchainTransactions: 2,
      transactionParticipants: 4,
      transactionMetadata: 5,
    });

    // records: chunk size 3 over 7 rows => batches of [3, 3, 1].
    expect(batchSizes(engine, "records")).toEqual([3, 3, 1]);
    // lastId paging must yield every row exactly once, in ascending id order.
    expect(streamedRows(engine, "records").map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    // a single full batch ends the loop (2 < chunkSize), one call.
    expect(batchSizes(engine, "blockchainTransactions")).toEqual([2]);
    // 4 rows over chunk 3 => [3, 1].
    expect(batchSizes(engine, "transactionParticipants")).toEqual([3, 1]);
    // metadata uses the same bounded cooperative stream, not a one-off path.
    expect(batchSizes(engine, "transactionMetadata")).toEqual([3, 2]);

    // A full batch always yields before the next source read/transfer. Short
    // terminal batches do not add an unnecessary delay before the next table.
    expect(yieldedAfter.map((entry) => entry.table)).toEqual([
      "records",
      "records",
      "transactionParticipants",
      "transactionMetadata",
    ]);

    // Result summary is correct per table.
    const byTable = Object.fromEntries(results.map((r) => [r.table, r]));
    expect(byTable.records.copied).toBe(7);
    expect(byTable.records.sourceCount).toBe(7);
    expect(byTable.records.complete).toBe(true);
    expect(byTable.records.cancelled).toBe(false);
    expect(results.every((r) => !r.cancelled)).toBe(true);

    // Progress was reported for the records table up to the full count.
    const recProgress = progress.filter((p) => p.table === "records");
    expect(recProgress.at(-1)).toMatchObject({ processed: 7 });

    // Aggregate view: a global total (7 + 2 + 4 + 5 = 18) is known from the very
    // first progress event, and tableIndex/tableCount frame the position.
    expect(progress[0]).toMatchObject({ overallTotal: 18, tableCount: 4, tableIndex: 1 });
    expect(progress.every((p) => p.overallTotal === 18 && p.tableCount === 4)).toBe(true);

    // overallProcessed never goes backwards and ends at the global total.
    let prev = -1;
    for (const p of progress) {
      expect(p.overallProcessed).toBeGreaterThanOrEqual(prev);
      prev = p.overallProcessed;
    }
    expect(progress.at(-1)?.overallProcessed).toBe(18);

    // Each table reports its own 1-based index in order.
    expect(progress.filter((p) => p.table === "records").every((p) => p.tableIndex === 1)).toBe(true);
    expect(progress.filter((p) => p.table === "blockchainTransactions").every((p) => p.tableIndex === 2)).toBe(true);
    expect(progress.filter((p) => p.table === "transactionParticipants").every((p) => p.tableIndex === 3)).toBe(true);
    expect(progress.filter((p) => p.table === "transactionMetadata").every((p) => p.tableIndex === 4)).toBe(true);
  });

  it("mapped rows are streamed (booleans/arrays normalized), not raw Dexie objects", async () => {
    await seedSourceIdb({
      records: [{ id: 1, inputString: "Foo", tags: ["x"], cachedTxCount: true }],
    });
    const engine = installMockEngine();
    await seedAll();

    const [row] = streamedRows(engine, "records") as Array<Record<string, unknown>>;
    expect(row.inputStringLower).toBe("foo"); // derived
    expect(row.tags).toBe(JSON.stringify(["x"])); // serialized
    expect(row.cachedTxCount).toBe(1); // boolean -> int
    expect(row.label).toBeNull(); // absent -> null
  });

  it("handles an empty vault: begins, finishes with zero counts, no batches", async () => {
    await seedSourceIdb({}); // stores exist but are empty
    const engine = installMockEngine();

    const results = await seedAll();

    expect(engine.seedBegin).toHaveBeenCalledTimes(1);
    expect(engine.seedBatch).not.toHaveBeenCalled();
    expect(engine.seedFinish).toHaveBeenCalledWith({
      records: 0,
      blockchainTransactions: 0,
      transactionParticipants: 0,
      transactionMetadata: 0,
    });
    expect(results.every((r) => r.copied === 0 && r.complete && !r.cancelled)).toBe(true);
  });

  it("on cancel mid-seed it drops the partial mirror via clear() and reports cancelled", async () => {
    await seedSourceIdb({
      records: [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id, inputString: `addr${id}` })),
      blockchainTransactions: [1, 2].map((id) => ({ id, txid: `tx${id}` })),
      transactionParticipants: [1, 2].map((id) => ({ id, txid: "tx1", role: "output", address: "a", amount: id })),
    });

    // Simulate the user hitting cancel after the first batch is streamed.
    const engine = installMockEngine({
      seedBatch: vi.fn(() => {
        cancelSeeding();
        return ok();
      }),
    });

    const results = await seedAll();

    // Exactly one batch made it out before the cancel was observed at the top
    // of the next loop iteration.
    expect(engine.seedBatch).toHaveBeenCalledTimes(1);
    expect(batchSizes(engine, "records")).toEqual([3]);

    // Cancel path: clear() drops the partial mirror; seedFinish is NEVER called.
    expect(engine.clear).toHaveBeenCalledTimes(1);
    expect(engine.seedFinish).not.toHaveBeenCalled();

    // It stops at the first table — later tables are not streamed at all.
    expect(streamedRows(engine, "blockchainTransactions")).toHaveLength(0);
    expect(streamedRows(engine, "transactionParticipants")).toHaveLength(0);

    // The records result is marked cancelled and incomplete.
    const rec = results.find((r) => r.table === "records")!;
    expect(rec.cancelled).toBe(true);
    expect(rec.complete).toBe(false);
    expect(rec.copied).toBe(3);
    expect(rec.sourceCount).toBe(7);
  });

  it("lets UI cancellation run at the cooperative boundary before reading another batch", async () => {
    await seedSourceIdb({
      records: [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id, inputString: `addr${id}` })),
    });
    const engine = installMockEngine();
    const yieldSpy = vi.fn(async () => {
      cancelSeeding();
    });
    __setSeedYieldForTests(yieldSpy);

    const results = await seedAll();

    expect(yieldSpy).toHaveBeenCalledTimes(1);
    expect(batchSizes(engine, "records")).toEqual([3]);
    expect(engine.clear).toHaveBeenCalledTimes(1);
    expect(engine.seedFinish).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({
      table: "records",
      copied: 3,
      sourceCount: 7,
      cancelled: true,
      complete: false,
    });
  });

  it("cancelling before any batch streams copies nothing and still clears", async () => {
    await seedSourceIdb({
      records: [1, 2, 3].map((id) => ({ id, inputString: `addr${id}` })),
    });
    const engine = installMockEngine();

    // seedBegin resolves, then we flip the cancel flag before the first read.
    engine.seedBegin = vi.fn(() => {
      cancelSeeding();
      return ok();
    });
    (window as unknown as { electronAPI: { engine: MockEngine } }).electronAPI = { engine };

    const results = await seedAll();

    expect(engine.seedBatch).not.toHaveBeenCalled();
    expect(engine.clear).toHaveBeenCalledTimes(1);
    expect(engine.seedFinish).not.toHaveBeenCalled();
    const rec = results.find((r) => r.table === "records")!;
    expect(rec.cancelled).toBe(true);
    expect(rec.copied).toBe(0);
  });

  it("propagates a seedBatch error envelope mid-stream and never finishes", async () => {
    await seedSourceIdb({
      // chunk size 3 over 7 rows => batches [3, 3, 1]; we fail the 2nd batch.
      records: [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id, inputString: `addr${id}` })),
    });

    let batchCalls = 0;
    const engine = installMockEngine({
      seedBatch: vi.fn(() => {
        batchCalls += 1;
        // The first batch lands; the engine bridge rejects the second with an
        // { ok: false } envelope (e.g. a transient worker failure).
        if (batchCalls === 2) {
          return Promise.resolve({ ok: false, error: "seedBatch boom" } as EngineEnvelope);
        }
        return ok();
      }),
    });

    // unwrap() turns the error envelope into a throw that propagates out of seedAll.
    await expect(seedAll()).rejects.toThrow("seedBatch boom");

    // One batch streamed before the rejection, then it stopped immediately.
    expect(engine.seedBatch).toHaveBeenCalledTimes(2);
    // The engine is NEVER marked READY with partial data...
    expect(engine.seedFinish).not.toHaveBeenCalled();
    // ...and the partial mirror is removed before the original transfer error
    // is rethrown to the caller.
    expect(engine.clear).toHaveBeenCalledTimes(1);
  });

  it("propagates an IndexedDB read failure mid-stream and never marks the mirror complete", async () => {
    await seedSourceIdb({
      records: [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id, inputString: `addr${id}` })),
    });
    const engine = installMockEngine();

    // Let the count + first batch read succeed, then throw on the next getAll so
    // the failure happens MID-stream (after a batch has already been streamed).
    const realGetAll = IDBObjectStore.prototype.getAll;
    let getAllCalls = 0;
    vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (
      this: IDBObjectStore,
      query?: IDBValidKey | IDBKeyRange | null,
      count?: number,
    ): IDBRequest<unknown[]> {
      getAllCalls += 1;
      if (getAllCalls === 2) throw new Error("IndexedDB read failed mid-stream");
      return realGetAll.call(this, query, count);
    });

    await expect(seedAll()).rejects.toThrow("IndexedDB read failed mid-stream");

    // The first batch was streamed before the read threw...
    expect(engine.seedBatch).toHaveBeenCalledTimes(1);
    // ...but the partial mirror is never finished and is removed before the
    // original IndexedDB error reaches the caller.
    expect(engine.seedFinish).not.toHaveBeenCalled();
    expect(engine.clear).toHaveBeenCalledTimes(1);
  });
});

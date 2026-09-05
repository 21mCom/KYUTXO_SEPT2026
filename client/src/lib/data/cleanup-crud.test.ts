// @vitest-environment jsdom
import "fake-indexeddb/auto";

import Dexie, { type Table } from "dexie";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Record, RecordOrigin } from "../database";

class TestDb extends Dexie {
  records!: Table<Record, number>;
  recordOrigins!: Table<RecordOrigin, number>;

  constructor() {
    super(`KYUTXO-cleanup-${Date.now()}-${Math.random()}`);
    this.version(1).stores({
      records: "++id",
      recordOrigins: "++id, recordId",
    });
  }
}

const testDb = new TestDb();
vi.mock("../database", async () => {
  const actual = await vi.importActual<typeof import("../database")>("../database");
  return { ...actual, db: testDb };
});

const { deleteCleanupRecordWithOrigins } = await import("./cleanup-crud");

beforeAll(async () => {
  await testDb.open();
});

afterAll(async () => {
  await testDb.delete();
});

describe("deleteCleanupRecordWithOrigins", () => {
  it("atomically removes the record and its complete origin ledger", async () => {
    const recordId = await testDb.records.add({ type: "address", inputString: "bc1candidate" } as Record);
    await testDb.recordOrigins.bulkAdd([
      { recordId, originType: "blockchain-sync", createdAt: 1 } as RecordOrigin,
      { recordId, originType: "blockchain-sync", createdAt: 2 } as RecordOrigin,
    ]);

    await expect(deleteCleanupRecordWithOrigins(recordId)).resolves.toBe(true);
    await expect(testDb.records.get(recordId)).resolves.toBeUndefined();
    await expect(testDb.recordOrigins.where("recordId").equals(recordId).count()).resolves.toBe(0);
  });
});
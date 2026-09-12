// @vitest-environment jsdom
//
// Canonical-identifier matching in sync find-or-create (Task #1861).
//
// The bug this guards against: a manually created address record typed padded
// or uppercase bech32 was invisible to TransactionSyncService's case-sensitive
// raw-inputString equality, so syncing that address created a duplicate
// "blockchain-discovered" record for the same address. Stored identifiers are
// now canonical (CRUD boundary + one-time repair) and the find-or-create
// lookup canonicalizes its key, so differently-cased/padded input reuses the
// existing record.
//
// Backed by an in-memory Dexie (fake-indexeddb) exactly like the
// resolvePrevouts suite: no provider call is needed because the match path
// returns before any network or write happens.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type { Record as DbRecord } from "@/lib/database";

class TestDb extends Dexie {
  records!: Table<DbRecord, number>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      records:
        "++id, type, inputString, inputStringLower, label, owner, walletName, " +
        "*tags, *categories, createdAt, updatedAt, [type+id], [type+addressImportance]",
    });
  }
}

const testDb = new TestDb(`KYUTXO-canonicalMatch-${Date.now()}-${Math.random()}`);

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return { ...actual, db: testDb };
});

const { TransactionSyncService } = await import("./transaction-sync");

const ADDR = "bc1qcanonicalsyncmatch00000000000000000000001";
const TXID = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

function storedRecord(type: string, inputString: string): DbRecord {
  const now = Date.now();
  return {
    type,
    inputString,
    inputStringLower: inputString.toLowerCase(),
    label: "",
    tags: [],
    categories: [],
    createdAt: now,
    updatedAt: now,
  } as unknown as DbRecord;
}

describe("TransactionSyncService find-or-create — canonical identifier matching", () => {
  beforeEach(async () => {
    await testDb.records.clear();
  });

  it("reuses a canonically stored address record for UPPERCASE bech32 input", async () => {
    const id = (await testDb.records.add(storedRecord("address", ADDR))) as number;
    const service = new TransactionSyncService();

    const result = await (service as any).findOrCreateAddressRecord(ADDR.toUpperCase());

    expect(result).toEqual({ recordId: id, isNew: false });
    // And crucially: no duplicate record was created.
    expect(await testDb.records.count()).toBe(1);
  });

  it("reuses a canonically stored address record for whitespace-padded input", async () => {
    const id = (await testDb.records.add(storedRecord("address", ADDR))) as number;
    const service = new TransactionSyncService();

    const result = await (service as any).findOrCreateAddressRecord(`  ${ADDR}  `);

    expect(result).toEqual({ recordId: id, isNew: false });
    expect(await testDb.records.count()).toBe(1);
  });

  it("reuses a canonically stored transaction record for uppercase-hex txid input", async () => {
    const id = (await testDb.records.add(storedRecord("transaction", TXID))) as number;
    const service = new TransactionSyncService();

    const result = await (service as any).findOrCreateTransactionRecord(
      TXID.toUpperCase(),
      1_700_000_000,
      0,
    );

    expect(result).toEqual({ recordId: id, isNew: false });
    expect(await testDb.records.count()).toBe(1);
  });
});

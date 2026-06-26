// @vitest-environment jsdom
//
// Unit tests for getUnresolvedSpendsByRecordId() in transaction-crud.ts.
//
// That query maps unresolved spend inputs (blank-address input participants that
// still carry prevTxid/prevVout) to the source address record they will debit
// once resolved. It resolves each input's prevout (prevTxid:prevVout) against the
// LOCAL output participants, preferring the output's own recordId and falling
// back to an inputString lookup on db.records when the output has only an address.
// Inputs whose prevout is not present locally (or maps to no tracked record) are
// omitted. The result is a Map<recordId, count of pending unresolved spends>.
//
// These tests cover:
//   - inputs whose prevout output already carries a recordId
//   - outputs with only an address (inputString fallback resolution)
//   - prevouts not present locally (omitted)
//   - a record receiving spends across multiple groups (counted per recordId key)
//   - the empty case returning an empty map without touching db.records
//
// Uses the real Dexie engine (via fake-indexeddb), mirroring the data-layer test
// pattern in record-crud.keyset.test.ts / privacy-history-crud.test.ts.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type { Record as DbRecord } from "@/lib/database";
import type { TransactionParticipant } from "@/lib/db-types";

class TestDb extends Dexie {
  records!: Table<DbRecord, number>;
  transactionParticipants!: Table<TransactionParticipant, number>;
  constructor(name: string) {
    super(name);
    // Mirrors the live schema indexes used by getUnresolvedSpendsByRecordId:
    // records.inputString (fallback lookup) and the participant indexes the
    // query reads (role, txid, [prevTxid+prevVout]).
    this.version(1).stores({
      records:
        "++id, type, inputString, inputStringLower, label, owner, walletName, " +
        "seedName, walletSoftware, *tags, *categories, createdAt, updatedAt, " +
        "chainType, syncDepth, addressImportance, [type+addressImportance], " +
        "[addressImportance+id], [type+id], [owner+id], [walletName+id], " +
        "flowType, discoveredFromRecordId",
      transactionParticipants:
        "++id, [txid+role], txid, role, address, recordId, [prevTxid+prevVout]",
    });
  }
}

let testDb: TestDb;

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return {
    ...actual,
    // Re-read the live binding each time so beforeEach can swap the instance.
    get db() {
      return testDb;
    },
    notifyDbChange: vi.fn(),
  };
});

const { getUnresolvedSpendsByRecordId } = await import("./transaction-crud");

// ---- Fixtures --------------------------------------------------------------

function mkRecord(inputString: string, overrides: Partial<DbRecord> = {}): DbRecord {
  return {
    type: "address",
    inputString,
    inputStringLower: inputString.toLowerCase(),
    label: inputString,
    notes: undefined,
    tags: [],
    categories: [],
    owner: undefined,
    walletName: undefined,
    seedName: undefined,
    walletSoftware: undefined,
    addressImportance: "verified",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  } as unknown as DbRecord;
}

function mkOutput(
  txid: string,
  vout: number,
  overrides: Partial<TransactionParticipant> = {},
): TransactionParticipant {
  return {
    txid,
    role: "output",
    address: `out-addr-${txid}-${vout}`,
    amount: 1000,
    vout,
    ...overrides,
  };
}

// An unresolved spend input: blank address but with prevTxid/prevVout set.
function mkUnresolvedInput(
  txid: string,
  prevTxid: string,
  prevVout: number,
  overrides: Partial<TransactionParticipant> = {},
): TransactionParticipant {
  return {
    txid,
    role: "input",
    address: "",
    amount: 1000,
    prevTxid,
    prevVout,
    ...overrides,
  };
}

beforeEach(() => {
  testDb = new TestDb(`KYUTXO-unresolved-${Date.now()}-${Math.random()}`);
});

afterEach(async () => {
  await testDb.delete();
});

describe("getUnresolvedSpendsByRecordId", () => {
  it("returns an empty map without querying records when there are no unresolved inputs", async () => {
    // Seed only resolved/output rows so the unresolved-input scan finds nothing.
    await testDb.transactionParticipants.bulkAdd([
      mkOutput("txA", 0, { recordId: 1 }),
      // A normal input WITH an address is not "unresolved".
      { txid: "txB", role: "input", address: "addr-known", amount: 500, prevTxid: "txA", prevVout: 0 },
    ]);

    const recordsSpy = vi.spyOn(testDb.records, "where");

    const result = await getUnresolvedSpendsByRecordId();

    expect(result.size).toBe(0);
    // Early-return short-circuits before any records lookup.
    expect(recordsSpy).not.toHaveBeenCalled();
  });

  it("attributes an unresolved input to the prevout output's recordId", async () => {
    await testDb.transactionParticipants.bulkAdd([
      mkOutput("txSrc", 0, { recordId: 42 }),
      mkUnresolvedInput("txSpend", "txSrc", 0),
    ]);

    const result = await getUnresolvedSpendsByRecordId();

    expect(Object.fromEntries(result)).toEqual({ 42: 1 });
  });

  it("falls back to inputString lookup when the prevout output has only an address", async () => {
    await testDb.records.add(mkRecord("bc1qsource", { id: 7 } as Partial<DbRecord>));
    await testDb.transactionParticipants.bulkAdd([
      // Output carries the address but no recordId (tracked after the fact).
      mkOutput("txSrc", 1, { recordId: undefined, address: "bc1qsource" }),
      mkUnresolvedInput("txSpend", "txSrc", 1),
    ]);

    const result = await getUnresolvedSpendsByRecordId();

    expect(Object.fromEntries(result)).toEqual({ 7: 1 });
  });

  it("omits unresolved inputs whose prevout is not present locally", async () => {
    await testDb.transactionParticipants.bulkAdd([
      // No matching output row for (txMissing, 3) exists locally.
      mkUnresolvedInput("txSpend", "txMissing", 3),
    ]);

    const result = await getUnresolvedSpendsByRecordId();

    expect(result.size).toBe(0);
  });

  it("omits inputs whose prevout output has neither recordId nor a resolvable address", async () => {
    await testDb.transactionParticipants.bulkAdd([
      // Output exists but no recordId, and its address is not a tracked record.
      mkOutput("txSrc", 0, { recordId: undefined, address: "unknown-addr" }),
      mkUnresolvedInput("txSpend", "txSrc", 0),
    ]);

    const result = await getUnresolvedSpendsByRecordId();

    expect(result.size).toBe(0);
  });

  it("counts multiple unresolved spends per record across both resolution paths", async () => {
    // Record 100: two prevouts resolved directly via recordId.
    // Record 200: one prevout via recordId, one via inputString fallback.
    await testDb.records.add(mkRecord("bc1qfallback", { id: 200 } as Partial<DbRecord>));
    await testDb.transactionParticipants.bulkAdd([
      mkOutput("txA", 0, { recordId: 100 }),
      mkOutput("txA", 1, { recordId: 100 }),
      mkOutput("txB", 0, { recordId: 200 }),
      mkOutput("txC", 0, { recordId: undefined, address: "bc1qfallback" }),

      mkUnresolvedInput("spend1", "txA", 0),
      mkUnresolvedInput("spend2", "txA", 1),
      mkUnresolvedInput("spend3", "txB", 0),
      mkUnresolvedInput("spend4", "txC", 0),
    ]);

    const result = await getUnresolvedSpendsByRecordId();

    expect(Object.fromEntries(result)).toEqual({ 100: 2, 200: 2 });
  });

  it("matches a prevout to the correct vout, not just the txid", async () => {
    // Same source txid, two outputs to different records; the input points at
    // vout 1, so only record 9 should be credited.
    await testDb.transactionParticipants.bulkAdd([
      mkOutput("txSrc", 0, { recordId: 8 }),
      mkOutput("txSrc", 1, { recordId: 9 }),
      mkUnresolvedInput("txSpend", "txSrc", 1),
    ]);

    const result = await getUnresolvedSpendsByRecordId();

    expect(Object.fromEntries(result)).toEqual({ 9: 1 });
  });
});

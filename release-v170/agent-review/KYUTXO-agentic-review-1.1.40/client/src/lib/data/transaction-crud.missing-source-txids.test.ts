// @vitest-environment jsdom
//
// Unit tests for getMissingSourceTxids() in transaction-crud.ts.
//
// That query underpins the Balance page's "Import missing history" action: it
// returns the distinct source transaction ids (prevTxids) behind unattributable
// spends whose prevout OUTPUT is NOT stored locally. Those are exactly the
// transactions that, once fetched and imported, make a spend's source address
// known and let balances self-correct.
//
// Crucially it must EXCLUDE source txids whose prevout output is already stored
// locally — even when that output maps to no tracked record — because importing
// more history can never help those (there is nothing to fetch).
//
// Uses the real Dexie engine (via fake-indexeddb), mirroring the data-layer test
// pattern in transaction-crud.unresolved-spends.test.ts.

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
    get db() {
      return testDb;
    },
    notifyDbChange: vi.fn(),
  };
});

const { getMissingSourceTxids } = await import("./transaction-crud");

// ---- Fixtures --------------------------------------------------------------

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
  testDb = new TestDb(`KYUTXO-missing-src-${Date.now()}-${Math.random()}`);
});

afterEach(async () => {
  await testDb.delete();
});

describe("getMissingSourceTxids", () => {
  it("returns an empty array when there are no unresolved inputs", async () => {
    await testDb.transactionParticipants.bulkAdd([
      mkOutput("txA", 0, { recordId: 1 }),
      // A normal input WITH an address is not "unresolved".
      { txid: "txB", role: "input", address: "addr-known", amount: 500, prevTxid: "txA", prevVout: 0 },
    ]);

    const result = await getMissingSourceTxids();

    expect(result).toEqual([]);
  });

  it("returns the prevTxid of an unresolved spend whose prevout is not stored locally", async () => {
    await testDb.transactionParticipants.bulkAdd([
      mkUnresolvedInput("spend1", "txMissing", 0),
    ]);

    const result = await getMissingSourceTxids();

    expect(result).toEqual(["txMissing"]);
  });

  it("excludes source txids whose prevout output is already stored locally", async () => {
    await testDb.transactionParticipants.bulkAdd([
      mkOutput("txLocal", 0, { recordId: 5 }),
      mkUnresolvedInput("spendLocal", "txLocal", 0),
    ]);

    const result = await getMissingSourceTxids();

    expect(result).toEqual([]);
  });

  it("excludes a locally-known-but-untracked output (importing more history can't help it)", async () => {
    await testDb.transactionParticipants.bulkAdd([
      // Output exists locally but carries no recordId and an untracked address.
      mkOutput("txUntracked", 0, { recordId: undefined, address: "unknown-addr" }),
      mkUnresolvedInput("spendUntracked", "txUntracked", 0),
    ]);

    const result = await getMissingSourceTxids();

    expect(result).toEqual([]);
  });

  it("matches the prevout by vout, not just the txid", async () => {
    await testDb.transactionParticipants.bulkAdd([
      // vout 0 of txSrc is local; vout 1 is missing.
      mkOutput("txSrc", 0, { recordId: 9 }),
      mkUnresolvedInput("spendKnown", "txSrc", 0),
      mkUnresolvedInput("spendUnknown", "txSrc", 1),
    ]);

    const result = await getMissingSourceTxids();

    expect(result).toEqual(["txSrc"]);
  });

  it("dedupes a source txid referenced by multiple spends", async () => {
    await testDb.transactionParticipants.bulkAdd([
      mkUnresolvedInput("spend1", "txMissing", 0),
      mkUnresolvedInput("spend2", "txMissing", 1),
      mkUnresolvedInput("spend3", "txMissing", 2),
    ]);

    const result = await getMissingSourceTxids();

    expect(result).toEqual(["txMissing"]);
  });

  it("returns only the missing source txids when local and missing prevouts are mixed", async () => {
    await testDb.transactionParticipants.bulkAdd([
      mkOutput("txLocal", 0, { recordId: 5 }),
      mkUnresolvedInput("spendLocal", "txLocal", 0),
      mkUnresolvedInput("spendMissingA", "txGoneA", 0),
      mkUnresolvedInput("spendMissingB", "txGoneB", 0),
    ]);

    const result = await getMissingSourceTxids();

    expect(new Set(result)).toEqual(new Set(["txGoneA", "txGoneB"]));
    expect(result).not.toContain("txLocal");
  });

  it("ignores inputs missing prevTxid/prevVout (cannot be backfilled)", async () => {
    await testDb.transactionParticipants.bulkAdd([
      // Blank address but no prevout reference — not actionable.
      { txid: "spendNoPrev", role: "input", address: "", amount: 1000 },
      mkUnresolvedInput("spendReal", "txMissing", 0),
    ]);

    const result = await getMissingSourceTxids();

    expect(result).toEqual(["txMissing"]);
  });
});

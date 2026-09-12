// @vitest-environment jsdom
//
// Integration tests for getHeuristicMatchedAddresses(): the exact list of
// tracked addresses still computed with the FIFO heuristic (spent, but with no
// prevout data on any of their input participants). This is the set the Balance
// page's heuristic-mode banner re-syncs. Runs against the real Dexie engine via
// fake-indexeddb so it exercises the same query paths as production.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type { TransactionParticipant } from "@/lib/database";

class TestDb extends Dexie {
  transactionParticipants!: Table<TransactionParticipant, number>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      transactionParticipants:
        "++id, [txid+role], txid, role, address, recordId, [prevTxid+prevVout]",
    });
  }
}

const testDb = new TestDb(`KYUTXO-heuristic-list-${Date.now()}-${Math.random()}`);

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return { ...actual, db: testDb };
});

const { getHeuristicMatchedAddresses } = await import("./address-stats");

function part(over: Partial<TransactionParticipant>): TransactionParticipant {
  return {
    txid: "tx",
    role: "output",
    address: "addr",
    amount: 1000,
    recordId: 1,
    ...over,
  } as TransactionParticipant;
}

beforeEach(async () => {
  await testDb.transactionParticipants.clear();
});

describe("getHeuristicMatchedAddresses", () => {
  it("returns an empty list when there are no input participants", async () => {
    await testDb.transactionParticipants.bulkAdd([
      part({ txid: "o1", role: "output", address: "A", vout: 0 }),
    ]);
    expect(await getHeuristicMatchedAddresses()).toEqual([]);
  });

  it("returns an address that spent with no prevout data", async () => {
    await testDb.transactionParticipants.bulkAdd([
      part({ txid: "o1", role: "output", address: "A", vout: 0 }),
      part({ txid: "spend1", role: "input", address: "A" }),
    ]);
    expect(await getHeuristicMatchedAddresses()).toEqual(["A"]);
  });

  it("excludes an address whose input carries prevout data (exact mode)", async () => {
    await testDb.transactionParticipants.bulkAdd([
      part({ txid: "spend1", role: "input", address: "A", prevTxid: "o1", prevVout: 0 }),
    ]);
    expect(await getHeuristicMatchedAddresses()).toEqual([]);
  });

  it("excludes an address if ANY of its inputs carries prevout data", async () => {
    await testDb.transactionParticipants.bulkAdd([
      part({ txid: "spend1", role: "input", address: "A" }),
      part({ txid: "spend2", role: "input", address: "A", prevTxid: "o1", prevVout: 0 }),
    ]);
    expect(await getHeuristicMatchedAddresses()).toEqual([]);
  });

  it("ignores blank-address inputs (unresolved spends are a separate warning)", async () => {
    await testDb.transactionParticipants.bulkAdd([
      part({ txid: "spend1", role: "input", address: "" }),
      part({ txid: "spend2", role: "input", address: "   " }),
    ]);
    expect(await getHeuristicMatchedAddresses()).toEqual([]);
  });

  it("returns each distinct heuristic address once and excludes exact ones", async () => {
    await testDb.transactionParticipants.bulkAdd([
      // A: heuristic (two no-prevout spends).
      part({ txid: "s1", role: "input", address: "A" }),
      part({ txid: "s2", role: "input", address: "A" }),
      // B: heuristic.
      part({ txid: "s3", role: "input", address: "B" }),
      // C: exact.
      part({ txid: "s4", role: "input", address: "C", prevTxid: "x", prevVout: 1 }),
      // D: receive-only (no inputs).
      part({ txid: "o9", role: "output", address: "D", vout: 0 }),
    ]);
    const result = await getHeuristicMatchedAddresses();
    expect(result.sort()).toEqual(["A", "B"]);
  });

  it("matches the set counted by countHeuristicMatchedAddresses", async () => {
    await testDb.transactionParticipants.bulkAdd([
      part({ txid: "s1", role: "input", address: "A" }),
      part({ txid: "s2", role: "input", address: "B" }),
      part({ txid: "s3", role: "input", address: "C", prevTxid: "x", prevVout: 1 }),
    ]);
    const { countHeuristicMatchedAddresses } = await import("./address-stats");
    const list = await getHeuristicMatchedAddresses();
    const count = await countHeuristicMatchedAddresses();
    expect(list.length).toBe(count);
  });
});

// @vitest-environment jsdom
//
// Coverage for TransactionSyncService.resolvePrevouts() recomputing the cached
// balance of a source address as soon as a spend is attributed to it.
//
// Scenario (the bug this guards against): address B is synced and its tx spends
// a coin from address A, but B's input row was written with a blank address
// (the raw tx lacked prevout data). prevout resolution later fills in A as the
// input owner. Resolution must drop A's cached balance in the SAME run, even
// though A was never part of the original sync set.
//
// We back the CRUD/stats layer with an in-memory Dexie (fake-indexeddb) and
// drive resolvePrevouts with everything it needs already present locally (the
// previous output rows), so no network provider call is required.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type {
  Record as DbRecord,
  BlockchainTransaction,
  TransactionParticipant,
  AddressSyncState,
} from "@/lib/database";

class TestDb extends Dexie {
  records!: Table<DbRecord, number>;
  blockchainTransactions!: Table<BlockchainTransaction, number>;
  transactionParticipants!: Table<TransactionParticipant, number>;
  addressSyncState!: Table<AddressSyncState, number>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      records:
        "++id, type, inputString, inputStringLower, label, owner, walletName, " +
        "*tags, *categories, createdAt, updatedAt, [type+id], [type+addressImportance]",
      blockchainTransactions:
        "++id, &txid, blockHeight, blockTime, syncedAt, hasOpReturn",
      transactionParticipants:
        "++id, [txid+role], txid, role, address, recordId, [prevTxid+prevVout]",
      addressSyncState: "++id, &address, recordId, lastSyncedAt",
    });
  }
}

const testDb = new TestDb(`KYUTXO-resolvePrevouts-${Date.now()}-${Math.random()}`);

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return { ...actual, db: testDb };
});

const { TransactionSyncService } = await import("./transaction-sync");

const ADDR_A = "bc1qsourceaddraaaaaaaaaaaaaaaaaaaaaaaaaaa0";
const ADDR_B = "bc1qdestaddrbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1";
const TX_FUND_A = "a".repeat(64); // funds A with 100000
const TX_SPEND = "b".repeat(64); // B's tx that spends A's coin

function addrRecord(inputString: string): DbRecord {
  const now = Date.now();
  return {
    type: "address",
    inputString,
    inputStringLower: inputString.toLowerCase(),
    label: "",
    tags: [],
    categories: [],
    createdAt: now,
    updatedAt: now,
  } as unknown as DbRecord;
}

describe("TransactionSyncService.resolvePrevouts → source balance recompute", () => {
  beforeEach(async () => {
    await testDb.records.clear();
    await testDb.blockchainTransactions.clear();
    await testDb.transactionParticipants.clear();
    await testDb.addressSyncState.clear();
  });

  it("drops the source address's cached balance when its spend is attributed", async () => {
    // Address records for A (the source) and B (the destination just synced).
    const aId = (await testDb.records.add(addrRecord(ADDR_A))) as number;
    await testDb.records.add(addrRecord(ADDR_B));

    // A is a synced address (so recompute treats its data as authoritative).
    await testDb.addressSyncState.add({
      address: ADDR_A,
      recordId: aId,
      lastSyncedHeight: 100,
      lastSyncedAt: Date.now(),
      txCount: 1,
    } as AddressSyncState);

    // Confirmed block times for both transactions.
    await testDb.blockchainTransactions.bulkAdd([
      { txid: TX_FUND_A, blockHeight: 100, blockTime: 1000, syncedAt: Date.now() } as BlockchainTransaction,
      { txid: TX_SPEND, blockHeight: 200, blockTime: 2000, syncedAt: Date.now() } as BlockchainTransaction,
    ]);

    // TX_FUND_A: an output paying 100000 to A (vout 0).
    await testDb.transactionParticipants.add({
      txid: TX_FUND_A,
      role: "output",
      vout: 0,
      address: ADDR_A,
      amount: 100000,
      recordId: aId,
    } as TransactionParticipant);

    // TX_SPEND: input that spends TX_FUND_A:0 but was written with a BLANK
    // address (prevout data not yet attributed), plus an output to B.
    await testDb.transactionParticipants.add({
      txid: TX_SPEND,
      role: "input",
      address: "",
      amount: 0,
      prevTxid: TX_FUND_A,
      prevVout: 0,
    } as TransactionParticipant);
    await testDb.transactionParticipants.add({
      txid: TX_SPEND,
      role: "output",
      vout: 0,
      address: ADDR_B,
      amount: 99000,
    } as TransactionParticipant);

    const service = new TransactionSyncService();
    const result = await service.resolvePrevouts();

    // The blank input was attributed to A from the locally-cached prevout.
    expect(result.resolved).toBe(1);
    expect(result.fetchedFromNode).toBe(0);
    expect(result.resolvedAddresses).toContain(ADDR_A);

    // A's input now carries its address + amount.
    const aInput = await testDb.transactionParticipants
      .where("[prevTxid+prevVout]")
      .equals([TX_FUND_A, 0])
      .first();
    expect(aInput?.address).toBe(ADDR_A);
    expect(aInput?.amount).toBe(100000);

    // And critically: A's cached balance dropped to 0 (100000 in - 100000 out)
    // in the same run, without any separate recompute call.
    const aAfter = await testDb.records.get(aId);
    expect(aAfter?.cachedBalanceSats).toBe(0);
    expect(aAfter?.statsComputedAt).toBeTruthy();
  });
});

// @vitest-environment jsdom
//
// Integration tests for the Balance Integrity check + recompute flow that backs
// the Database Doctor page. These exercise the real Dexie engine (via
// fake-indexeddb) so detectStaleCachedBalances() and recomputeAddressStats()
// run against the same query paths the production app uses.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type {
  Record as DbRecord,
  TransactionParticipant,
  BlockchainTransaction,
  AddressSyncState,
} from "@/lib/database";

class TestDb extends Dexie {
  records!: Table<DbRecord, number>;
  transactionParticipants!: Table<TransactionParticipant, number>;
  blockchainTransactions!: Table<BlockchainTransaction, number>;
  addressSyncState!: Table<AddressSyncState, number>;
  constructor(name: string) {
    super(name);
    // Mirrors the current records + sync schema in client/src/lib/database.ts.
    this.version(1).stores({
      records:
        "++id, type, inputString, inputStringLower, label, owner, walletName, " +
        "seedName, walletSoftware, *tags, *categories, createdAt, updatedAt, " +
        "chainType, syncDepth, addressImportance, [type+addressImportance], " +
        "[addressImportance+id], [type+id], [owner+id], [walletName+id], " +
        "flowType, discoveredFromRecordId",
      blockchainTransactions:
        "++id, &txid, blockHeight, blockTime, syncedAt, hasOpReturn",
      transactionParticipants:
        "++id, [txid+role], txid, role, address, recordId, [prevTxid+prevVout]",
      addressSyncState: "++id, &address, recordId, lastSyncedAt",
    });
  }
}

const testDb = new TestDb(`KYUTXO-balance-integrity-${Date.now()}-${Math.random()}`);

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return { ...actual, db: testDb };
});

const { detectStaleCachedBalances, recomputeAddressStats } = await import(
  "./address-stats"
);

// ---- Fixture helpers --------------------------------------------------------

function mkAddr(over: Partial<DbRecord> & { id: number; inputString: string }): DbRecord {
  return {
    type: "address",
    label: "",
    inputStringLower: over.inputString.toLowerCase(),
    tags: [],
    categories: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  } as unknown as DbRecord;
}

function mkOutput(
  address: string,
  txid: string,
  amount: number,
): TransactionParticipant {
  return {
    txid,
    role: "output",
    address,
    amount,
    recordId: 1,
    vout: 0,
  } as unknown as TransactionParticipant;
}

function mkTx(txid: string, blockTime: number): BlockchainTransaction {
  return {
    txid,
    blockHeight: 1,
    blockTime,
    syncedAt: 1,
    hasOpReturn: false,
  } as unknown as BlockchainTransaction;
}

async function resetDb() {
  await testDb.records.clear();
  await testDb.transactionParticipants.clear();
  await testDb.blockchainTransactions.clear();
  await testDb.addressSyncState.clear();
}

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
});

describe("detectStaleCachedBalances", () => {
  it("does not count an address whose cached balance matches the computed value", async () => {
    // Address has one 1000-sat output → computed balance 1000, cached 1000.
    await testDb.records.add(
      mkAddr({
        id: 1,
        inputString: "addr-match",
        statsComputedAt: 5000,
        cachedBalanceSats: 1000,
      }),
    );
    await testDb.transactionParticipants.add(mkOutput("addr-match", "tx-match", 1000));
    await testDb.blockchainTransactions.add(mkTx("tx-match", 111));

    const result = await detectStaleCachedBalances({});

    expect(result.sampled).toBe(1);
    expect(result.staleCount).toBe(0);
    expect(result.cancelled).toBe(false);
  });

  it("counts an address whose cached balance disagrees with the computed value", async () => {
    // Computed balance is 2000 but the cache says 999 → stale.
    await testDb.records.add(
      mkAddr({
        id: 1,
        inputString: "addr-stale",
        statsComputedAt: 5000,
        cachedBalanceSats: 999,
      }),
    );
    await testDb.transactionParticipants.add(mkOutput("addr-stale", "tx-stale", 2000));
    await testDb.blockchainTransactions.add(mkTx("tx-stale", 111));

    const result = await detectStaleCachedBalances({});

    expect(result.sampled).toBe(1);
    expect(result.staleCount).toBe(1);
    expect(result.cancelled).toBe(false);
  });

  it("skips unsynced addresses (no statsComputedAt)", async () => {
    // One synced (matching) address and one never-synced address.
    await testDb.records.bulkAdd([
      mkAddr({
        id: 1,
        inputString: "addr-synced",
        statsComputedAt: 5000,
        cachedBalanceSats: 1000,
      }),
      mkAddr({
        id: 2,
        inputString: "addr-unsynced",
        // no statsComputedAt → should be ignored entirely.
      }),
    ]);
    await testDb.transactionParticipants.bulkAdd([
      mkOutput("addr-synced", "tx-a", 1000),
      // The unsynced address even has data; it must still be skipped.
      mkOutput("addr-unsynced", "tx-b", 7777),
    ]);
    await testDb.blockchainTransactions.bulkAdd([mkTx("tx-a", 111), mkTx("tx-b", 222)]);

    const result = await detectStaleCachedBalances({});

    // Only the synced address is sampled, and it matches.
    expect(result.sampled).toBe(1);
    expect(result.staleCount).toBe(0);
    expect(result.cancelled).toBe(false);
  });

  it("stops sampling once the sampleLimit cap is reached", async () => {
    // Three synced, all-stale addresses; cap the sample at 2.
    await testDb.records.bulkAdd([
      mkAddr({ id: 1, inputString: "a1", statsComputedAt: 5000, cachedBalanceSats: 0 }),
      mkAddr({ id: 2, inputString: "a2", statsComputedAt: 5000, cachedBalanceSats: 0 }),
      mkAddr({ id: 3, inputString: "a3", statsComputedAt: 5000, cachedBalanceSats: 0 }),
    ]);
    await testDb.transactionParticipants.bulkAdd([
      mkOutput("a1", "t1", 100),
      mkOutput("a2", "t2", 100),
      mkOutput("a3", "t3", 100),
    ]);
    await testDb.blockchainTransactions.bulkAdd([
      mkTx("t1", 111),
      mkTx("t2", 222),
      mkTx("t3", 333),
    ]);

    const result = await detectStaleCachedBalances({ sampleLimit: 2 });

    expect(result.sampled).toBe(2);
    expect(result.staleCount).toBe(2);
  });

  it("collects details for each stale address with collectDetails:true", async () => {
    // Two stale addresses (cache disagrees with computed) and one matching one.
    await testDb.records.bulkAdd([
      mkAddr({ id: 1, inputString: "addr-1", statsComputedAt: 5000, cachedBalanceSats: 0 }),
      mkAddr({ id: 2, inputString: "addr-2", statsComputedAt: 5000, cachedBalanceSats: 50 }),
      mkAddr({ id: 3, inputString: "addr-3", statsComputedAt: 5000, cachedBalanceSats: 1000 }),
    ]);
    await testDb.transactionParticipants.bulkAdd([
      mkOutput("addr-1", "t1", 1000),
      mkOutput("addr-2", "t2", 2000),
      mkOutput("addr-3", "t3", 1000),
    ]);
    await testDb.blockchainTransactions.bulkAdd([
      mkTx("t1", 111),
      mkTx("t2", 222),
      mkTx("t3", 333),
    ]);

    const result = await detectStaleCachedBalances({ collectDetails: true });

    expect(result.sampled).toBe(3);
    expect(result.staleCount).toBe(2);
    expect(result.staleAddresses).toHaveLength(2);

    const byId = new Map(result.staleAddresses.map((d) => [d.recordId, d]));
    expect(byId.get(1)).toEqual({
      recordId: 1,
      address: "addr-1",
      cachedSats: 0,
      computedSats: 1000,
    });
    expect(byId.get(2)).toEqual({
      recordId: 2,
      address: "addr-2",
      cachedSats: 50,
      computedSats: 2000,
    });
    // The matching address (id 3) is never included in the detail list.
    expect(byId.has(3)).toBe(false);
  });

  it("caps staleAddresses at detailLimit but keeps staleCount exact", async () => {
    // Three stale addresses, but only collect details for the first one.
    await testDb.records.bulkAdd([
      mkAddr({ id: 1, inputString: "c1", statsComputedAt: 5000, cachedBalanceSats: 0 }),
      mkAddr({ id: 2, inputString: "c2", statsComputedAt: 5000, cachedBalanceSats: 0 }),
      mkAddr({ id: 3, inputString: "c3", statsComputedAt: 5000, cachedBalanceSats: 0 }),
    ]);
    await testDb.transactionParticipants.bulkAdd([
      mkOutput("c1", "t1", 100),
      mkOutput("c2", "t2", 200),
      mkOutput("c3", "t3", 300),
    ]);
    await testDb.blockchainTransactions.bulkAdd([
      mkTx("t1", 111),
      mkTx("t2", 222),
      mkTx("t3", 333),
    ]);

    const result = await detectStaleCachedBalances({
      collectDetails: true,
      detailLimit: 1,
    });

    // staleCount counts every mismatch; the detail list is capped at detailLimit.
    expect(result.sampled).toBe(3);
    expect(result.staleCount).toBe(3);
    expect(result.staleAddresses).toHaveLength(1);
  });

  it("collects no details when collectDetails is omitted", async () => {
    await testDb.records.add(
      mkAddr({
        id: 1,
        inputString: "addr-nodetails",
        statsComputedAt: 5000,
        cachedBalanceSats: 1,
      }),
    );
    await testDb.transactionParticipants.add(mkOutput("addr-nodetails", "tx-nd", 2000));
    await testDb.blockchainTransactions.add(mkTx("tx-nd", 111));

    const result = await detectStaleCachedBalances({});

    expect(result.staleCount).toBe(1);
    expect(result.staleAddresses).toEqual([]);
  });

  it("returns cancelled: true when the signal is already aborted", async () => {
    await testDb.records.add(
      mkAddr({
        id: 1,
        inputString: "addr-x",
        statsComputedAt: 5000,
        cachedBalanceSats: 0,
      }),
    );
    const controller = new AbortController();
    controller.abort();

    const result = await detectStaleCachedBalances({ signal: controller.signal });

    expect(result.cancelled).toBe(true);
    expect(result.sampled).toBe(0);
    expect(result.staleCount).toBe(0);
  });
});

describe("recomputeAddressStats then re-check", () => {
  it("corrects a stale cached balance so a follow-up check reports zero", async () => {
    // Record's cache is wrong (100) while the real balance is 5000.
    await testDb.records.add(
      mkAddr({
        id: 1,
        inputString: "addr-fix",
        statsComputedAt: 1000,
        cachedBalanceSats: 100,
      }),
    );
    await testDb.transactionParticipants.add(mkOutput("addr-fix", "tx-fix", 5000));
    await testDb.blockchainTransactions.add(mkTx("tx-fix", 444));
    await testDb.addressSyncState.add({
      address: "addr-fix",
      recordId: 1,
      lastSyncedAt: 1000,
    } as unknown as AddressSyncState);

    // Before recompute: the address is stale.
    const before = await detectStaleCachedBalances({});
    expect(before.sampled).toBe(1);
    expect(before.staleCount).toBe(1);

    // Recompute rebuilds the cache from local participant data.
    const recompute = await recomputeAddressStats({ addresses: ["addr-fix"] });
    expect(recompute.cancelled).toBe(false);
    expect(recompute.updated).toBe(1);

    const fixed = await testDb.records.get(1);
    expect(fixed?.cachedBalanceSats).toBe(5000);

    // After recompute: no stale balances remain.
    const after = await detectStaleCachedBalances({});
    expect(after.sampled).toBe(1);
    expect(after.staleCount).toBe(0);
  });
});

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

  it("scans every synced address (ignoring the sample cap) when checkAll is set", async () => {
    // Three synced, all-stale addresses. A normal run with sampleLimit 2 would
    // stop early; checkAll must keep going and count all three.
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

    // sampleLimit is ignored once checkAll is true.
    const result = await detectStaleCachedBalances({ checkAll: true, sampleLimit: 2 });

    expect(result.sampled).toBe(3);
    expect(result.staleCount).toBe(3);
    expect(result.checkedAll).toBe(true);
    expect(result.cancelled).toBe(false);
  });

  it("streams stale details via onStaleBatch instead of accumulating them", async () => {
    await testDb.records.bulkAdd([
      mkAddr({ id: 1, inputString: "s1", statsComputedAt: 5000, cachedBalanceSats: 0 }),
      mkAddr({ id: 2, inputString: "s2", statsComputedAt: 5000, cachedBalanceSats: 0 }),
    ]);
    await testDb.transactionParticipants.bulkAdd([
      mkOutput("s1", "u1", 500),
      mkOutput("s2", "u2", 700),
    ]);
    await testDb.blockchainTransactions.bulkAdd([mkTx("u1", 111), mkTx("u2", 222)]);

    const streamed: Array<{ recordId: number; address: string; computedSats: number }> = [];
    const result = await detectStaleCachedBalances({
      checkAll: true,
      collectDetails: true,
      onStaleBatch: (batch) => {
        for (const d of batch) {
          streamed.push({ recordId: d.recordId, address: d.address, computedSats: d.computedSats });
        }
      },
    });

    // Streaming means the returned array stays empty (caller owns the full set).
    expect(result.staleAddresses).toHaveLength(0);
    expect(result.staleCount).toBe(2);
    expect(streamed).toHaveLength(2);
    expect(streamed.map((d) => d.address).sort()).toEqual(["s1", "s2"]);
    expect(streamed.find((d) => d.address === "s2")?.computedSats).toBe(700);
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

describe("recomputeAddressStats mid-run cancellation", () => {
  it("returns cancelled with a partial count and persists batches written before the abort", async () => {
    // Four synced addresses, each with a wrong cached balance and a single
    // output that fixes the computed balance. With batchSize 2 the recompute
    // spans two batches; we abort partway through (after the first batch) via
    // the onProgress callback.
    const addresses = ["addr-0", "addr-1", "addr-2", "addr-3"];
    const computedByAddr: Record<string, number> = {
      "addr-0": 1000,
      "addr-1": 2000,
      "addr-2": 3000,
      "addr-3": 4000,
    };
    const staleCachedByAddr: Record<string, number> = {
      "addr-0": 1,
      "addr-1": 2,
      "addr-2": 3,
      "addr-3": 4,
    };

    await testDb.records.bulkAdd(
      addresses.map((addr, i) =>
        mkAddr({
          id: i + 1,
          inputString: addr,
          statsComputedAt: 1000,
          cachedBalanceSats: staleCachedByAddr[addr],
        }),
      ),
    );
    await testDb.transactionParticipants.bulkAdd(
      addresses.map((addr, i) => mkOutput(addr, `tx-${i}`, computedByAddr[addr])),
    );
    await testDb.blockchainTransactions.bulkAdd(
      addresses.map((_, i) => mkTx(`tx-${i}`, 100 + i)),
    );
    await testDb.addressSyncState.bulkAdd(
      addresses.map(
        (addr, i) =>
          ({
            address: addr,
            recordId: i + 1,
            lastSyncedAt: 1000,
          }) as unknown as AddressSyncState,
      ),
    );

    const controller = new AbortController();
    const progressEvents: number[] = [];
    // Abort the first time a batch reports completed work (processed > 0), which
    // happens after the first batch has been written. The initial onProgress
    // fires with processed: 0 and must NOT trigger the abort.
    const onProgress = vi.fn((p: { processed: number; total: number }) => {
      progressEvents.push(p.processed);
      if (p.processed > 0 && !controller.signal.aborted) {
        controller.abort();
      }
    });

    const result = await recomputeAddressStats({
      addresses,
      batchSize: 2,
      signal: controller.signal,
      onProgress,
    });

    // Cancelled partway through with only the first batch's records updated.
    expect(result.cancelled).toBe(true);
    expect(result.updated).toBe(2);

    // The initial processed: 0 event fired, then the first batch's processed: 2.
    expect(progressEvents[0]).toBe(0);
    expect(progressEvents).toContain(2);
    // The second batch never reported, so processed never reached 4.
    expect(progressEvents).not.toContain(4);

    // Records in the first batch kept their freshly recomputed cache values...
    const rec0 = await testDb.records.get(1);
    const rec1 = await testDb.records.get(2);
    expect(rec0?.cachedBalanceSats).toBe(1000);
    expect(rec1?.cachedBalanceSats).toBe(2000);
    expect(rec0?.statsComputedAt).toBeGreaterThan(1000);
    expect(rec1?.statsComputedAt).toBeGreaterThan(1000);

    // ...while records that were never reached keep their original stale cache.
    const rec2 = await testDb.records.get(3);
    const rec3 = await testDb.records.get(4);
    expect(rec2?.cachedBalanceSats).toBe(3);
    expect(rec3?.cachedBalanceSats).toBe(4);
    expect(rec2?.statsComputedAt).toBe(1000);
    expect(rec3?.statsComputedAt).toBe(1000);
  });
});

describe("recomputeAddressStats not-synced reset path", () => {
  it("strips the cache fields when an address has no participants AND no sync state", async () => {
    // Stale cache values linger on a record that has neither fetched
    // transaction data nor an addressSyncState entry → it must reset to
    // "not synced" (all cache fields removed).
    await testDb.records.add(
      mkAddr({
        id: 1,
        inputString: "addr-never-synced",
        statsComputedAt: 9000,
        cachedBalanceSats: 4242,
        cachedTxCount: 7,
        cachedLastActivityTime: 8888,
        cachedUtxoCount: 3,
      }),
    );

    const recompute = await recomputeAddressStats({ addresses: ["addr-never-synced"] });
    expect(recompute.cancelled).toBe(false);
    expect(recompute.updated).toBe(1);

    const reset = await testDb.records.get(1);
    expect(reset).toBeDefined();
    // Every cache field is stripped so the UI shows "never synced".
    expect(reset).not.toHaveProperty("cachedBalanceSats");
    expect(reset).not.toHaveProperty("cachedTxCount");
    expect(reset).not.toHaveProperty("cachedLastActivityTime");
    expect(reset).not.toHaveProperty("cachedUtxoCount");
    expect(reset).not.toHaveProperty("statsComputedAt");
  });

  it("sets a genuine zero balance when an address has no participants but DOES have sync state", async () => {
    // No participant rows at all, but the address has been synced (it has an
    // addressSyncState entry) → the cache should be a real zero balance, not
    // stripped.
    await testDb.records.add(
      mkAddr({
        id: 1,
        inputString: "addr-zero-synced",
        statsComputedAt: 9000,
        cachedBalanceSats: 4242,
        cachedTxCount: 7,
        cachedLastActivityTime: 8888,
        cachedUtxoCount: 3,
      }),
    );
    await testDb.addressSyncState.add({
      address: "addr-zero-synced",
      recordId: 1,
      lastSyncedAt: 1000,
    } as unknown as AddressSyncState);

    const recompute = await recomputeAddressStats({ addresses: ["addr-zero-synced"] });
    expect(recompute.cancelled).toBe(false);
    expect(recompute.updated).toBe(1);

    const zeroed = await testDb.records.get(1);
    expect(zeroed).toBeDefined();
    // Synced-but-empty → genuine zero balance, cache fields present and zeroed.
    expect(zeroed?.cachedBalanceSats).toBe(0);
    expect(zeroed?.cachedTxCount).toBe(0);
    expect(zeroed?.cachedLastActivityTime).toBe(0);
    expect(zeroed?.cachedUtxoCount).toBe(0);
    // statsComputedAt is refreshed (set to "now"), so it must remain present.
    expect(zeroed?.statsComputedAt).toBeTypeOf("number");
    expect(zeroed?.statsComputedAt).not.toBe(9000);
  });

  it("uses the computed balance (not zero) when an address has BOTH participants AND sync state", async () => {
    // The address has real participant data (computed balance 6000) AND an
    // addressSyncState entry, but its cache is stale (123). The hasData branch
    // must prefer the freshly computed stats over the syncedSet zero fallback,
    // so the cache becomes the computed non-zero value, never 0.
    await testDb.records.add(
      mkAddr({
        id: 1,
        inputString: "addr-both",
        statsComputedAt: 9000,
        cachedBalanceSats: 123,
        cachedTxCount: 0,
        cachedLastActivityTime: 0,
        cachedUtxoCount: 0,
      }),
    );
    await testDb.transactionParticipants.add(mkOutput("addr-both", "tx-both", 6000));
    await testDb.blockchainTransactions.add(mkTx("tx-both", 555));
    await testDb.addressSyncState.add({
      address: "addr-both",
      recordId: 1,
      lastSyncedAt: 1000,
    } as unknown as AddressSyncState);

    const recompute = await recomputeAddressStats({ addresses: ["addr-both"] });
    expect(recompute.cancelled).toBe(false);
    expect(recompute.updated).toBe(1);

    const fixed = await testDb.records.get(1);
    expect(fixed).toBeDefined();
    // Computed stats win over the syncedSet fallback: non-zero, never 0.
    expect(fixed?.cachedBalanceSats).toBe(6000);
    expect(fixed?.cachedTxCount).toBe(1);
    expect(fixed?.cachedLastActivityTime).toBe(555);
    expect(fixed?.cachedUtxoCount).toBe(1);
    expect(fixed?.statsComputedAt).toBeTypeOf("number");
    expect(fixed?.statsComputedAt).not.toBe(9000);
  });
});

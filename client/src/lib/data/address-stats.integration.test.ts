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
  settings!: Table<{ id: string } & Record<string, unknown>, string>;
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
      // A full-table recompute (no id/address filter) refreshes the vault-wide
      // behavior tally at the end, which reads/writes the default settings row.
      settings: "id",
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
type StaleAddressDetail = import("./address-stats").StaleAddressDetail;

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
  await testDb.settings.clear();
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

  it("returns cancelled with a partial sampled count when aborted between sampling batches", async () => {
    // Seed 250 synced, all-stale addresses so the scan spans more than one
    // 200-record sampling batch. The internal loop reads 200 records, reports
    // progress via onProgress(sampled), then re-checks the abort signal at the
    // top of the next iteration. We abort the first time progress is reported
    // (after the first batch), so the second batch is never sampled.
    const COUNT = 250;
    const records: DbRecord[] = [];
    const participants: TransactionParticipant[] = [];
    const txs: BlockchainTransaction[] = [];
    for (let i = 1; i <= COUNT; i++) {
      // Zero-pad so the id-ordered scan and the address strings line up.
      const addr = `batch-addr-${String(i).padStart(4, "0")}`;
      const txid = `batch-tx-${i}`;
      records.push(
        mkAddr({
          id: i,
          inputString: addr,
          statsComputedAt: 5000,
          // Cached 0 but computed 1000 → every address is stale.
          cachedBalanceSats: 0,
        }),
      );
      participants.push(mkOutput(addr, txid, 1000));
      txs.push(mkTx(txid, 100 + i));
    }
    await testDb.records.bulkAdd(records);
    await testDb.transactionParticipants.bulkAdd(participants);
    await testDb.blockchainTransactions.bulkAdd(txs);

    const controller = new AbortController();
    const sampledReports: number[] = [];
    // Abort the moment the first batch reports its progress. The scan checks
    // isAborted() at the top of the next while-loop iteration and bails out.
    const onProgress = vi.fn((sampled: number) => {
      sampledReports.push(sampled);
      if (!controller.signal.aborted) controller.abort();
    });

    const result = await detectStaleCachedBalances({
      signal: controller.signal,
      onProgress,
    });

    // Aborted between batches → cancelled, with only the first 200-record
    // batch examined (not all 250 records).
    expect(result.cancelled).toBe(true);
    expect(result.sampled).toBe(200);
    // staleCount reflects only the addresses examined before the abort. Every
    // one of those 200 was stale, so the count matches the sampled count.
    expect(result.staleCount).toBe(200);
    // Only the first batch ever reported progress; the second never ran.
    expect(sampledReports).toEqual([200]);
  });

  it("yields and reports progress once per 200-record batch across a multi-batch scan", async () => {
    // Seed 650 synced, all-stale addresses so the scan spans four sampling
    // batches: 200, 200, 200, then a final 50-record partial batch. The loop
    // reads at most BATCH (200) records, samples them, reports progress via
    // onProgress(sampled, total), then yields to the UI with setTimeout(0). A
    // regression that dropped the per-batch yield or batched differently would
    // change this progression and freeze the UI on large vaults.
    const COUNT = 650;
    const records: DbRecord[] = [];
    const participants: TransactionParticipant[] = [];
    const txs: BlockchainTransaction[] = [];
    for (let i = 1; i <= COUNT; i++) {
      // Zero-pad so the id-ordered scan and the address strings line up.
      const addr = `progress-addr-${String(i).padStart(4, "0")}`;
      const txid = `progress-tx-${i}`;
      records.push(
        mkAddr({
          id: i,
          inputString: addr,
          statsComputedAt: 5000,
          // Cached 0 but computed 1000 → every address is stale.
          cachedBalanceSats: 0,
        }),
      );
      participants.push(mkOutput(addr, txid, 1000));
      txs.push(mkTx(txid, 100 + i));
    }
    await testDb.records.bulkAdd(records);
    await testDb.transactionParticipants.bulkAdd(participants);
    await testDb.blockchainTransactions.bulkAdd(txs);

    const sampledReports: number[] = [];
    const totalReports: Array<number | undefined> = [];
    const onProgress = vi.fn((sampled: number, total?: number) => {
      sampledReports.push(sampled);
      totalReports.push(total);
    });

    const result = await detectStaleCachedBalances({
      checkAll: true,
      onProgress,
    });

    // Every synced address was scanned to completion.
    expect(result.cancelled).toBe(false);
    expect(result.sampled).toBe(COUNT);
    expect(result.staleCount).toBe(COUNT);
    expect(result.checkedAll).toBe(true);

    // onProgress fired exactly once per batch (4 batches: 200/200/200/50) with
    // a monotonically increasing running sampled count, the final call landing
    // on the full total.
    expect(onProgress).toHaveBeenCalledTimes(4);
    expect(sampledReports).toEqual([200, 400, 600, 650]);

    // In checkAll mode the denominator is reported alongside sampled on every
    // call, so the UI can show real "X of TOTAL" progress.
    expect(totalReports).toEqual([COUNT, COUNT, COUNT, COUNT]);
  });

  it("reports an undefined total for a capped (non-checkAll) sampling scan", async () => {
    // Seed enough synced, all-stale addresses to span two sampling batches.
    // Without checkAll the scan never counts the address table, so the total
    // denominator stays undefined even though progress is still reported.
    const COUNT = 250;
    const records: DbRecord[] = [];
    const participants: TransactionParticipant[] = [];
    const txs: BlockchainTransaction[] = [];
    for (let i = 1; i <= COUNT; i++) {
      const addr = `capped-addr-${String(i).padStart(4, "0")}`;
      const txid = `capped-tx-${i}`;
      records.push(
        mkAddr({
          id: i,
          inputString: addr,
          statsComputedAt: 5000,
          cachedBalanceSats: 0,
        }),
      );
      participants.push(mkOutput(addr, txid, 1000));
      txs.push(mkTx(txid, 100 + i));
    }
    await testDb.records.bulkAdd(records);
    await testDb.transactionParticipants.bulkAdd(participants);
    await testDb.blockchainTransactions.bulkAdd(txs);

    const sampledReports: number[] = [];
    const totalReports: Array<number | undefined> = [];
    const onProgress = vi.fn((sampled: number, total?: number) => {
      sampledReports.push(sampled);
      totalReports.push(total);
    });

    // sampleLimit larger than COUNT so the scan runs to completion across batches.
    const result = await detectStaleCachedBalances({
      sampleLimit: 1000,
      onProgress,
    });

    expect(result.cancelled).toBe(false);
    expect(result.checkedAll).toBe(false);
    expect(result.sampled).toBe(COUNT);
    // Two batches: 200 then the final 50.
    expect(sampledReports).toEqual([200, 250]);
    // No checkAll → no denominator is ever computed or reported.
    expect(totalReports).toEqual([undefined, undefined]);
  });

  it("delivers only the pre-abort batches via onStaleBatch when a streaming full-table scan is stopped early", async () => {
    // Seed 250 synced, all-stale addresses so a checkAll scan spans more than
    // one 200-record batch. In streaming mode each batch of found stale
    // addresses is handed to onStaleBatch (awaited) BEFORE onProgress fires and
    // before the abort signal is re-checked at the top of the next iteration.
    // We abort the moment the first batch is streamed, so the second batch is
    // never gathered or streamed — the caller keeps exactly the partial findings
    // it already spooled to durable storage.
    const COUNT = 250;
    const records: DbRecord[] = [];
    const participants: TransactionParticipant[] = [];
    const txs: BlockchainTransaction[] = [];
    for (let i = 1; i <= COUNT; i++) {
      // Zero-pad so the id-ordered scan and the address strings line up.
      const addr = `stream-addr-${String(i).padStart(4, "0")}`;
      const txid = `stream-tx-${i}`;
      records.push(
        mkAddr({
          id: i,
          inputString: addr,
          statsComputedAt: 5000,
          // Cached 0 but computed 1000 → every address is stale.
          cachedBalanceSats: 0,
        }),
      );
      participants.push(mkOutput(addr, txid, 1000));
      txs.push(mkTx(txid, 100 + i));
    }
    await testDb.records.bulkAdd(records);
    await testDb.transactionParticipants.bulkAdd(participants);
    await testDb.blockchainTransactions.bulkAdd(txs);

    const controller = new AbortController();
    // Each streamed batch is spooled here (the "durable storage" stand-in).
    const spooled: StaleAddressDetail[] = [];
    // Abort the first time a batch is streamed. The scan awaits this callback,
    // then reports progress, then re-checks isAborted() at the top of the next
    // while-loop iteration and bails out before reading the second batch.
    const onStaleBatch = vi.fn((batch: StaleAddressDetail[]) => {
      spooled.push(...batch);
      if (!controller.signal.aborted) controller.abort();
    });

    const result = await detectStaleCachedBalances({
      checkAll: true,
      collectDetails: true,
      signal: controller.signal,
      onStaleBatch,
    });

    // Aborted mid-scan → cancelled, with only the first 200-record batch
    // examined (not all 250 records).
    expect(result.cancelled).toBe(true);
    expect(result.sampled).toBe(200);
    expect(result.checkedAll).toBe(true);
    // Streaming mode never accumulates details in the result; the caller owns
    // the full (partial) set.
    expect(result.staleAddresses).toHaveLength(0);
    // staleCount reflects only the addresses examined before the abort. Every
    // one of those 200 was stale, so the count matches the sampled count.
    expect(result.staleCount).toBe(200);

    // Exactly one batch was streamed before the abort short-circuited the scan.
    expect(onStaleBatch).toHaveBeenCalledTimes(1);
    expect(spooled).toHaveLength(200);
    // The streamed batch is precisely the first 200 records by id — none of the
    // post-abort addresses leaked through.
    expect(spooled.map((d) => d.recordId)).toEqual(
      Array.from({ length: 200 }, (_, i) => i + 1),
    );
    const addresses = spooled.map((d) => d.address);
    expect(addresses[0]).toBe("stream-addr-0001");
    expect(addresses[199]).toBe("stream-addr-0200");
    expect(addresses).not.toContain("stream-addr-0201");
  });

  it("samples only the synced records when synced rows are sparse across pages, reporting progress once per synced-containing batch", async () => {
    // Real large vaults hold mostly unsynced addresses (no statsComputedAt).
    // Here every 50th record is synced (and stale) while the rest are unsynced,
    // so the synced rows are spread thinly across four DB pages. The scan must
    // page through all 650 records but only sample (and report progress for) the
    // 13 synced ones, never tripping over the unsynced majority.
    const COUNT = 650;
    const records: DbRecord[] = [];
    const participants: TransactionParticipant[] = [];
    const txs: BlockchainTransaction[] = [];
    const syncedIds: number[] = [];
    for (let i = 1; i <= COUNT; i++) {
      const addr = `sparse-addr-${String(i).padStart(4, "0")}`;
      const isSynced = i % 50 === 0;
      if (isSynced) {
        syncedIds.push(i);
        const txid = `sparse-tx-${i}`;
        participants.push(mkOutput(addr, txid, 1000));
        txs.push(mkTx(txid, 100 + i));
      }
      records.push(
        mkAddr({
          id: i,
          inputString: addr,
          // Only the every-50th rows are synced; the rest never were.
          ...(isSynced
            ? { statsComputedAt: 5000, cachedBalanceSats: 0 }
            : {}),
        }),
      );
    }
    await testDb.records.bulkAdd(records);
    await testDb.transactionParticipants.bulkAdd(participants);
    await testDb.blockchainTransactions.bulkAdd(txs);

    const sampledReports: number[] = [];
    const totalReports: Array<number | undefined> = [];
    const onProgress = vi.fn((sampled: number, total?: number) => {
      sampledReports.push(sampled);
      totalReports.push(total);
    });

    const result = await detectStaleCachedBalances({ checkAll: true, onProgress });

    // Every synced row was sampled (13 of them: ids 50,100,…,650); the 637
    // unsynced rows were paged over but never counted.
    expect(result.cancelled).toBe(false);
    expect(result.sampled).toBe(syncedIds.length);
    expect(result.sampled).toBe(13);
    expect(result.staleCount).toBe(13);
    expect(result.checkedAll).toBe(true);

    // Four DB pages (200/200/200/50) each carried four synced rows except the
    // last (one), so progress is reported once per page with a running count.
    expect(onProgress).toHaveBeenCalledTimes(4);
    expect(sampledReports).toEqual([4, 8, 12, 13]);
    // checkAll reports the full address-table denominator on every call.
    expect(totalReports).toEqual([COUNT, COUNT, COUNT, COUNT]);
  });

  it("skips fully-unsynced pages without reporting progress, then samples the lone synced page", async () => {
    // Many entire 200-record pages of unsynced records sit in front of a single
    // page that holds the synced rows, with more unsynced pages trailing behind.
    // The unsynced pages map to zero sampling work: the scan must page over them
    // WITHOUT firing onProgress (the running `sampled` count never moves there),
    // yet still run to completion and sample the synced page when it reaches it.
    //
    // This locks the current contract for a no-synced full page: it advances the
    // scan but reports NO progress. The matching yield (a setTimeout(0) macrotask
    // handed back to the event loop between pages, mirroring a sampled batch) is
    // exercised here across many empty pages so the scan can never starve the UI;
    // changing either half should be a deliberate decision that updates this test.
    const COUNT = 1400; // seven 200-record DB pages
    const SYNCED_FROM = 801; // synced rows live entirely on the fifth page
    const SYNCED_TO = 810;
    const records: DbRecord[] = [];
    const participants: TransactionParticipant[] = [];
    const txs: BlockchainTransaction[] = [];
    for (let i = 1; i <= COUNT; i++) {
      const addr = `gap-addr-${String(i).padStart(4, "0")}`;
      const isSynced = i >= SYNCED_FROM && i <= SYNCED_TO;
      if (isSynced) {
        const txid = `gap-tx-${i}`;
        participants.push(mkOutput(addr, txid, 1000));
        txs.push(mkTx(txid, 100 + i));
      }
      records.push(
        mkAddr({
          id: i,
          inputString: addr,
          // Synced rows are stale (cached 0 vs computed 1000); the rest were
          // never synced (no statsComputedAt) and must be skipped entirely.
          ...(isSynced
            ? { statsComputedAt: 5000, cachedBalanceSats: 0 }
            : {}),
        }),
      );
    }
    await testDb.records.bulkAdd(records);
    await testDb.transactionParticipants.bulkAdd(participants);
    await testDb.blockchainTransactions.bulkAdd(txs);

    const sampledReports: number[] = [];
    const totalReports: Array<number | undefined> = [];
    const onProgress = vi.fn((sampled: number, total?: number) => {
      sampledReports.push(sampled);
      totalReports.push(total);
    });

    const result = await detectStaleCachedBalances({ checkAll: true, onProgress });

    // The scan ran to completion across all seven pages and sampled only the 10
    // synced rows on the fifth page; the 1390 unsynced rows were paged over but
    // never counted.
    expect(result.cancelled).toBe(false);
    expect(result.sampled).toBe(SYNCED_TO - SYNCED_FROM + 1);
    expect(result.sampled).toBe(10);
    expect(result.staleCount).toBe(10);
    expect(result.checkedAll).toBe(true);

    // Progress is reported ONLY for the one page that actually sampled rows. The
    // four leading and two trailing fully-unsynced pages report nothing, so the
    // UI never sees a no-op progress tick for a page that skipped everything.
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(sampledReports).toEqual([10]);
    expect(totalReports).toEqual([COUNT]);
  });

  it("completes a page densely packed with synced rows, yielding within the page without disturbing the sampled/staleCount totals", async () => {
    // A single DB page (200 records) that is entirely synced and entirely
    // stale. This is the worst case the task targets: one page whose
    // participant/blocktime joins and per-row comparison loop could block the
    // event loop. The scan now hands control back to the UI after the heavy
    // participant fetch and periodically within the per-row loop; those extra
    // macrotask yields must not change the sampled/staleCount results or the
    // once-per-page progress contract.
    const COUNT = 200;
    const records: DbRecord[] = [];
    const participants: TransactionParticipant[] = [];
    const txs: BlockchainTransaction[] = [];
    for (let i = 1; i <= COUNT; i++) {
      const addr = `dense-addr-${String(i).padStart(4, "0")}`;
      const txid = `dense-tx-${i}`;
      records.push(
        mkAddr({
          id: i,
          inputString: addr,
          statsComputedAt: 5000,
          // Cached 0 but computed 1000 → every synced row is stale.
          cachedBalanceSats: 0,
        }),
      );
      participants.push(mkOutput(addr, txid, 1000));
      txs.push(mkTx(txid, 100 + i));
    }
    await testDb.records.bulkAdd(records);
    await testDb.transactionParticipants.bulkAdd(participants);
    await testDb.blockchainTransactions.bulkAdd(txs);

    const sampledReports: number[] = [];
    const onProgress = vi.fn((sampled: number) => {
      sampledReports.push(sampled);
    });

    const result = await detectStaleCachedBalances({ checkAll: true, onProgress });

    // The full dense page was scanned to completion with exact totals.
    expect(result.cancelled).toBe(false);
    expect(result.sampled).toBe(COUNT);
    expect(result.staleCount).toBe(COUNT);
    expect(result.checkedAll).toBe(true);

    // Despite the in-page yields, progress is still reported exactly once for
    // the single page, landing on the full count.
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(sampledReports).toEqual([COUNT]);
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
  it("leaves statsComputedAt undefined for a clean address without an addressSyncState entry", async () => {
    // A genuinely never-synced address: no cached stats and no addressSyncState
    // entry. A manual recompute (e.g. the Database Doctor "recompute" button)
    // must NOT accidentally stamp statsComputedAt on it, which would make the UI
    // report a "not synced" address as synced.
    await testDb.records.add(
      mkAddr({
        id: 1,
        inputString: "addr-clean-unsynced",
      }),
    );

    const recompute = await recomputeAddressStats({ addresses: ["addr-clean-unsynced"] });
    expect(recompute.cancelled).toBe(false);

    const after = await testDb.records.get(1);
    expect(after).toBeDefined();
    // Still never-synced: no stats stamp and no cache fields appeared.
    expect(after?.statsComputedAt).toBeUndefined();
    expect(after).not.toHaveProperty("cachedBalanceSats");
    expect(after).not.toHaveProperty("cachedTxCount");
    expect(after).not.toHaveProperty("cachedLastActivityTime");
    expect(after).not.toHaveProperty("cachedUtxoCount");
  });

  it("stamps statsComputedAt for a clean address WITH an addressSyncState entry even with zero txs", async () => {
    // A never-cached address that has, however, been synced (it has an
    // addressSyncState entry) but turned up zero transactions. A recompute must
    // stamp statsComputedAt so the UI distinguishes a genuine zero balance from
    // "not synced".
    await testDb.records.add(
      mkAddr({
        id: 1,
        inputString: "addr-clean-synced",
      }),
    );
    await testDb.addressSyncState.add({
      address: "addr-clean-synced",
      recordId: 1,
      lastSyncedAt: 1000,
    } as unknown as AddressSyncState);

    const recompute = await recomputeAddressStats({ addresses: ["addr-clean-synced"] });
    expect(recompute.cancelled).toBe(false);
    expect(recompute.updated).toBe(1);

    const after = await testDb.records.get(1);
    expect(after).toBeDefined();
    // Synced-but-empty → genuine zero balance with a fresh stats stamp.
    expect(after?.statsComputedAt).toBeTypeOf("number");
    expect(after?.cachedBalanceSats).toBe(0);
    expect(after?.cachedTxCount).toBe(0);
    expect(after?.cachedLastActivityTime).toBe(0);
    expect(after?.cachedUtxoCount).toBe(0);
  });

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

describe("recomputeAddressStats across a mostly-unsynced vault", () => {
  it("pages the whole table, resets the unsynced majority to 'not synced', and reports progress per batch", async () => {
    // Real large vaults are mostly unsynced: thousands of imported addresses
    // that were never fetched (no participants, no addressSyncState) sit between
    // the rare synced ones. A full-table recompute (no id/address filter) pages
    // the [type+id] index in batchSize chunks, yielding once per batch. This
    // locks that it pages over the unsynced majority without choking, recomputes
    // the sparse synced rows, RESETS every unsynced row back to "not synced"
    // (stripping any stale cache that lingered on it), and reports progress once
    // per batch with the real total.
    const COUNT = 650; // four batches at batchSize 200: 200/200/200/50
    const SYNC_EVERY = 50; // ids 50,100,…,650 → 13 synced rows, sparse across all four batches
    const records: DbRecord[] = [];
    const participants: TransactionParticipant[] = [];
    const txs: BlockchainTransaction[] = [];
    const syncStates: AddressSyncState[] = [];
    const syncedIds: number[] = [];
    const unsyncedIds: number[] = [];
    for (let i = 1; i <= COUNT; i++) {
      const addr = `mix-addr-${String(i).padStart(4, "0")}`;
      const isSynced = i % SYNC_EVERY === 0;
      if (isSynced) {
        syncedIds.push(i);
        const txid = `mix-tx-${i}`;
        participants.push(mkOutput(addr, txid, 1000));
        txs.push(mkTx(txid, 100 + i));
        syncStates.push({
          address: addr,
          recordId: i,
          lastSyncedAt: 1000,
        } as unknown as AddressSyncState);
        records.push(
          mkAddr({
            id: i,
            inputString: addr,
            // Stale cache that the recompute should refresh to the real 1000.
            statsComputedAt: 5000,
            cachedBalanceSats: 0,
          }),
        );
      } else {
        unsyncedIds.push(i);
        // No participants and no addressSyncState, but carrying leftover stale
        // cache fields that MUST be stripped (reset to "not synced").
        records.push(
          mkAddr({
            id: i,
            inputString: addr,
            statsComputedAt: 7000,
            cachedBalanceSats: 4242,
            cachedTxCount: 9,
            cachedLastActivityTime: 8888,
            cachedUtxoCount: 5,
          }),
        );
      }
    }
    await testDb.records.bulkAdd(records);
    await testDb.transactionParticipants.bulkAdd(participants);
    await testDb.blockchainTransactions.bulkAdd(txs);
    await testDb.addressSyncState.bulkAdd(syncStates);
    // The full-table path refreshes the behavior tally at the end, which needs
    // a default settings row to write onto.
    await testDb.settings.put({ id: "default" });

    const processedReports: number[] = [];
    const totalReports: number[] = [];
    const onProgress = vi.fn((p: { processed: number; total: number }) => {
      processedReports.push(p.processed);
      totalReports.push(p.total);
    });

    const result = await recomputeAddressStats({ batchSize: 200, onProgress });

    // Ran to completion; every one of the 650 rows was written (synced rows get
    // fresh stats, unsynced rows get reset — both count as updates).
    expect(result.cancelled).toBe(false);
    expect(result.updated).toBe(COUNT);

    // Progress fires once up front (processed 0) then once per batch with a
    // running, monotonically increasing count, always against the real total.
    expect(onProgress).toHaveBeenCalledTimes(5);
    expect(processedReports).toEqual([0, 200, 400, 600, 650]);
    expect(totalReports).toEqual([COUNT, COUNT, COUNT, COUNT, COUNT]);

    // Every synced row (sampled across all four batches) carries the freshly
    // computed 1000-sat balance with a refreshed statsComputedAt.
    for (const id of syncedIds) {
      const rec = await testDb.records.get(id);
      expect(rec?.cachedBalanceSats).toBe(1000);
      expect(rec?.cachedTxCount).toBe(1);
      expect(rec?.cachedUtxoCount).toBe(1);
      expect(rec?.statsComputedAt).toBeTypeOf("number");
      expect(rec?.statsComputedAt).not.toBe(5000);
    }

    // Every unsynced row was reset to "not synced": all cache fields stripped,
    // verified across rows landing in each of the four batches.
    for (const id of unsyncedIds) {
      const rec = await testDb.records.get(id);
      expect(rec).toBeDefined();
      expect(rec).not.toHaveProperty("cachedBalanceSats");
      expect(rec).not.toHaveProperty("cachedTxCount");
      expect(rec).not.toHaveProperty("cachedLastActivityTime");
      expect(rec).not.toHaveProperty("cachedUtxoCount");
      expect(rec).not.toHaveProperty("statsComputedAt");
    }
  });

  it("still pages and reports progress for an entirely-unsynced batch (unlike the sampling scan, which skips no-sample pages)", async () => {
    // Documents the recompute's contract when a WHOLE batch is unsynced. The
    // balance-integrity sampling scan (detectStaleCachedBalances) deliberately
    // skips firing onProgress for a page that sampled nothing. The recompute is
    // different on purpose: it must visit and RESET every unsynced row, so it
    // reports progress for EVERY batch — including a fully-unsynced one — and
    // the processed denominator advances over it like any other batch.
    const COUNT = 400; // two batches at batchSize 200
    const records: DbRecord[] = [];
    const participants: TransactionParticipant[] = [];
    const txs: BlockchainTransaction[] = [];
    const syncStates: AddressSyncState[] = [];
    for (let i = 1; i <= COUNT; i++) {
      const addr = `whole-addr-${String(i).padStart(4, "0")}`;
      // First batch (ids 1–200) is ENTIRELY unsynced; second batch (201–400) is
      // entirely synced. This isolates the all-unsynced-batch behavior.
      const isSynced = i > 200;
      if (isSynced) {
        const txid = `whole-tx-${i}`;
        participants.push(mkOutput(addr, txid, 2000));
        txs.push(mkTx(txid, 100 + i));
        syncStates.push({
          address: addr,
          recordId: i,
          lastSyncedAt: 1000,
        } as unknown as AddressSyncState);
        records.push(
          mkAddr({ id: i, inputString: addr, statsComputedAt: 5000, cachedBalanceSats: 0 }),
        );
      } else {
        records.push(
          mkAddr({
            id: i,
            inputString: addr,
            statsComputedAt: 7000,
            cachedBalanceSats: 999,
            cachedTxCount: 3,
            cachedLastActivityTime: 6000,
            cachedUtxoCount: 2,
          }),
        );
      }
    }
    await testDb.records.bulkAdd(records);
    await testDb.transactionParticipants.bulkAdd(participants);
    await testDb.blockchainTransactions.bulkAdd(txs);
    await testDb.addressSyncState.bulkAdd(syncStates);
    await testDb.settings.put({ id: "default" });

    const processedReports: number[] = [];
    const onProgress = vi.fn((p: { processed: number; total: number }) => {
      processedReports.push(p.processed);
    });

    const result = await recomputeAddressStats({ batchSize: 200, onProgress });

    expect(result.cancelled).toBe(false);
    expect(result.updated).toBe(COUNT);

    // Progress is reported for the all-unsynced first batch too, so the
    // denominator advances over it (0 → 200 → 400). The recompute never skips a
    // batch the way the sampling scan skips no-sample pages.
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(processedReports).toEqual([0, 200, 400]);

    // The entirely-unsynced first batch was reset row-by-row.
    const firstBatchSample = await testDb.records.get(1);
    expect(firstBatchSample).not.toHaveProperty("cachedBalanceSats");
    expect(firstBatchSample).not.toHaveProperty("statsComputedAt");
    const firstBatchLast = await testDb.records.get(200);
    expect(firstBatchLast).not.toHaveProperty("cachedBalanceSats");
    expect(firstBatchLast).not.toHaveProperty("statsComputedAt");

    // The synced second batch was recomputed to its real balance.
    const secondBatchSample = await testDb.records.get(201);
    expect(secondBatchSample?.cachedBalanceSats).toBe(2000);
    expect(secondBatchSample?.statsComputedAt).not.toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// New formula: balance = sum of UNSPENT outputs (never negative)
// ---------------------------------------------------------------------------

describe("recomputeAddressStats UTXO-balance formula: exact-mode spend reduces balance correctly", () => {
  it("balance equals sum of unspent output amounts after a spend", async () => {
    // addr receives 600 sats at tx-r:0 and 700 sats at tx-r:1, then spends
    // tx-r:0 via tx-s. After the spend only tx-r:1 (700 sats) is unspent.
    const addr = "exact-spend-addr";
    await testDb.records.add(
      mkAddr({ id: 1, inputString: addr, statsComputedAt: 0, cachedBalanceSats: 99999 }),
    );
    await testDb.blockchainTransactions.bulkAdd([mkTx("tx-r", 1000), mkTx("tx-s", 1001)]);
    await testDb.transactionParticipants.bulkAdd([
      { txid: "tx-r", address: addr, role: "output", amount: 600, vout: 0 } as unknown as TransactionParticipant,
      { txid: "tx-r", address: addr, role: "output", amount: 700, vout: 1 } as unknown as TransactionParticipant,
      // input spending outpoint tx-r:0
      { txid: "tx-s", address: addr, role: "input", amount: 600, prevTxid: "tx-r", prevVout: 0 } as unknown as TransactionParticipant,
    ]);
    await testDb.addressSyncState.add({ address: addr, recordId: 1, lastSyncedAt: 1000 } as unknown as AddressSyncState);

    const result = await recomputeAddressStats({ addresses: [addr] });
    expect(result.cancelled).toBe(false);

    const rec = await testDb.records.get(1);
    // Only tx-r:1 (700 sats) is unspent
    expect(rec?.cachedBalanceSats).toBe(700);
    expect(rec?.cachedUtxoCount).toBe(1);
  });
});

describe("recomputeAddressStats: Electrum blank-address spend inputs still reduce the balance", () => {
  it("counts a blank-address outpoint spend against the owning address (outpoint-first)", async () => {
    // Electrum-synced spends store the input with prevTxid/prevVout but a BLANK
    // address and 0 amount. An address-keyed participant load alone never sees
    // that input, so the address would fall back to heuristic mode with no
    // matchable inputs and its balance would inflate to "total received".
    const addr = "electrum-spend-addr";
    await testDb.records.add(
      mkAddr({ id: 1, inputString: addr, statsComputedAt: 0, cachedBalanceSats: 99999 }),
    );
    await testDb.blockchainTransactions.bulkAdd([mkTx("tx-er", 1000), mkTx("tx-es", 1001)]);
    await testDb.transactionParticipants.bulkAdd([
      { txid: "tx-er", address: addr, role: "output", amount: 600, vout: 0 } as unknown as TransactionParticipant,
      { txid: "tx-er", address: addr, role: "output", amount: 700, vout: 1 } as unknown as TransactionParticipant,
      // Electrum-style spend of tx-er:0 — blank address, zero amount, outpoint only.
      { txid: "tx-es", address: "", role: "input", amount: 0, prevTxid: "tx-er", prevVout: 0 } as unknown as TransactionParticipant,
    ]);
    await testDb.addressSyncState.add({ address: addr, recordId: 1, lastSyncedAt: 1000 } as unknown as AddressSyncState);

    const result = await recomputeAddressStats({ addresses: [addr] });
    expect(result.cancelled).toBe(false);

    const rec = await testDb.records.get(1);
    // Only tx-er:1 (700 sats) is unspent; without the outpoint-keyed follow-up
    // load this would be 1300 (total received).
    expect(rec?.cachedBalanceSats).toBe(700);
    expect(rec?.cachedUtxoCount).toBe(1);
    // The spend transaction counts as activity for the owning address, just as
    // it would if the input row had carried the resolved prevout address.
    expect(rec?.cachedTxCount).toBe(2);
  });

  it("does not attribute a blank-address input spending an outpoint we don't own", async () => {
    const addr = "electrum-foreign-spend-addr";
    await testDb.records.add(
      mkAddr({ id: 1, inputString: addr, statsComputedAt: 0, cachedBalanceSats: 0 }),
    );
    await testDb.blockchainTransactions.bulkAdd([mkTx("tx-fr", 1000), mkTx("tx-fs", 1001)]);
    await testDb.transactionParticipants.bulkAdd([
      { txid: "tx-fr", address: addr, role: "output", amount: 500, vout: 0 } as unknown as TransactionParticipant,
      // Blank-address input spending a FOREIGN outpoint — must not touch addr.
      { txid: "tx-fs", address: "", role: "input", amount: 0, prevTxid: "other-tx", prevVout: 0 } as unknown as TransactionParticipant,
    ]);
    await testDb.addressSyncState.add({ address: addr, recordId: 1, lastSyncedAt: 1000 } as unknown as AddressSyncState);

    const result = await recomputeAddressStats({ addresses: [addr] });
    expect(result.cancelled).toBe(false);

    const rec = await testDb.records.get(1);
    expect(rec?.cachedBalanceSats).toBe(500);
    expect(rec?.cachedUtxoCount).toBe(1);
    expect(rec?.cachedTxCount).toBe(1);
  });
});

describe("recomputeAddressStats UTXO-balance formula: balance is never negative", () => {
  it("returns 0 when the address spent more sats than it received (old formula would go negative)", async () => {
    // addr receives 1000 sats at tx-r:0. It then spends tx-r:0 AND also
    // references an external prevout (external-tx:0, 2000 sats) that is not in
    // local transaction data. The old received-minus-spent formula would give
    // 1000 − 3000 = −2000; the new unspent-output sum gives 0.
    const addr = "neg-balance-addr";
    await testDb.records.add(
      mkAddr({ id: 1, inputString: addr, statsComputedAt: 0, cachedBalanceSats: 0 }),
    );
    await testDb.blockchainTransactions.bulkAdd([mkTx("tx-r-neg", 2000), mkTx("tx-s-neg", 2001)]);
    await testDb.transactionParticipants.bulkAdd([
      mkOutput(addr, "tx-r-neg", 1000, 0),
      // Spends the local output
      { txid: "tx-s-neg", address: addr, role: "input", amount: 1000, prevTxid: "tx-r-neg", prevVout: 0 } as unknown as TransactionParticipant,
      // Also spends an external output (not in local data) — old formula subtracts this
      { txid: "tx-s-neg", address: addr, role: "input", amount: 2000, prevTxid: "external-tx", prevVout: 0 } as unknown as TransactionParticipant,
    ]);
    await testDb.addressSyncState.add({ address: addr, recordId: 1, lastSyncedAt: 1000 } as unknown as AddressSyncState);

    const result = await recomputeAddressStats({ addresses: [addr] });
    expect(result.cancelled).toBe(false);

    const rec = await testDb.records.get(1);
    // All locally-known outputs are spent → 0 unspent → balance = 0, never negative
    expect(rec?.cachedBalanceSats).toBe(0);
    expect(rec?.cachedUtxoCount).toBe(0);
  });
});

// ── Full-vault scan fast path (set-oriented recompute) ───────────────────────
//
// An unfiltered recomputeAddressStats() takes the streaming full-table scan
// path (computeStatsForAllAddressesByScan) instead of per-batch anyOf lookups.
// These tests pin its equivalence with the batched per-address path — the
// oracle every filtered recompute still uses — including blank-address prevout
// spends and multi-write-batch progress/cancellation.

describe("recomputeAddressStats full-vault scan fast path", () => {
  function mkBlankSpendInput(spendTxid: string, prevTxid: string): TransactionParticipant {
    // Electrum-shaped spend: blank address, outpoint only.
    return {
      txid: spendTxid,
      role: "input",
      address: "",
      amount: 0,
      recordId: 0,
      prevTxid,
      prevVout: 0,
    } as unknown as TransactionParticipant;
  }

  async function seedMixedVault(n: number) {
    // n addresses spanning multiple 500-record write batches:
    //  - i % 4 === 0: two outputs, one blank-address spend of the first → 1 UTXO
    //  - i % 4 === 1: one output, unspent → 1 UTXO
    //  - i % 4 === 2: synced but no participants → genuine zero balance
    //  - i % 4 === 3: unsynced, no participants → "not synced" reset
    const addrs: string[] = [];
    const recs: DbRecord[] = [];
    const parts: TransactionParticipant[] = [];
    const txs: BlockchainTransaction[] = [];
    const syncStates: AddressSyncState[] = [];
    for (let i = 0; i < n; i++) {
      const addr = `scan-addr-${i}`;
      addrs.push(addr);
      recs.push(mkAddr({ id: i + 1, inputString: addr, statsComputedAt: 1000, cachedBalanceSats: 1 }));
      if (i % 4 === 0) {
        // NOTE: the spend INPUT is inserted BEFORE the owner's outputs, so its
        // primary key is LOWER — the scan must attribute it after the pass.
        parts.push(mkBlankSpendInput(`scan-spend-${i}`, `scan-recv-${i}`));
        parts.push(mkOutput(addr, `scan-recv-${i}`, 5000 + i));
        parts.push({ ...mkOutput(addr, `scan-recv2-${i}`, 7000 + i), vout: 0 } as TransactionParticipant);
        txs.push(mkTx(`scan-recv-${i}`, 100 + i), mkTx(`scan-recv2-${i}`, 200 + i), mkTx(`scan-spend-${i}`, 300 + i));
        syncStates.push({ address: addr, recordId: i + 1, lastSyncedAt: 1 } as unknown as AddressSyncState);
      } else if (i % 4 === 1) {
        parts.push(mkOutput(addr, `scan-only-${i}`, 9000 + i));
        txs.push(mkTx(`scan-only-${i}`, 150 + i));
        syncStates.push({ address: addr, recordId: i + 1, lastSyncedAt: 1 } as unknown as AddressSyncState);
      } else if (i % 4 === 2) {
        syncStates.push({ address: addr, recordId: i + 1, lastSyncedAt: 1 } as unknown as AddressSyncState);
      }
      // i % 4 === 3: nothing — must be reset to "not synced".
    }
    for (let i = 0; i < recs.length; i += 500) await testDb.records.bulkAdd(recs.slice(i, i + 500));
    for (let i = 0; i < parts.length; i += 500) await testDb.transactionParticipants.bulkAdd(parts.slice(i, i + 500));
    for (let i = 0; i < txs.length; i += 500) await testDb.blockchainTransactions.bulkAdd(txs.slice(i, i + 500));
    await testDb.addressSyncState.bulkAdd(syncStates);
    return addrs;
  }

  function cacheSnapshot(recs: DbRecord[]) {
    return recs.map((r) => ({
      inputString: r.inputString,
      cachedBalanceSats: r.cachedBalanceSats,
      cachedUtxoCount: r.cachedUtxoCount,
      cachedTxCount: r.cachedTxCount,
      cachedLastActivityTime: r.cachedLastActivityTime,
      synced: r.statsComputedAt != null,
    }));
  }

  it("produces the same cached stats as the batched per-address path, including blank-address spends whose owner output has a higher primary key", async () => {
    const N = 1200; // spans multiple 500-record write batches
    const addrs = await seedMixedVault(N);

    // Full recompute → scan fast path.
    const progress: Array<{ processed: number; total: number }> = [];
    const full = await recomputeAddressStats({
      skipNotification: true,
      onProgress: (p) => progress.push({ ...p }),
    });
    expect(full.cancelled).toBe(false);
    expect(full.updated).toBe(N);
    const fullSnap = cacheSnapshot(await testDb.records.orderBy("id").toArray());

    // Progress must be monotonic and finish at the full address total.
    expect(progress[0]).toEqual({ processed: 0, total: N });
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i].processed).toBeGreaterThanOrEqual(progress[i - 1].processed);
    }
    expect(progress[progress.length - 1].processed).toBe(N);

    // Spot-check the semantics directly: spender addresses lost their first
    // output to the blank-address spend (1 UTXO left), unsynced rows reset.
    const spender = fullSnap.find((r) => r.inputString === "scan-addr-0")!;
    expect(spender.cachedUtxoCount).toBe(1);
    expect(spender.cachedBalanceSats).toBe(7000);
    expect(spender.cachedTxCount).toBe(3); // recv, recv2, spend tx
    const zero = fullSnap.find((r) => r.inputString === "scan-addr-2")!;
    expect(zero.synced).toBe(true);
    expect(zero.cachedBalanceSats).toBe(0);
    const unsynced = fullSnap.find((r) => r.inputString === "scan-addr-3")!;
    expect(unsynced.synced).toBe(false);

    // Scramble the cache, then run the BATCHED path (addresses filter) as the
    // oracle and require an identical end state.
    await testDb.records.toCollection().modify((r) => {
      if (r.type === "address") {
        r.cachedBalanceSats = 123456;
        r.cachedUtxoCount = 99;
        r.cachedTxCount = 99;
        r.cachedLastActivityTime = 1;
        r.statsComputedAt = 1;
      }
    });
    const batched = await recomputeAddressStats({ addresses: addrs, skipNotification: true });
    expect(batched.cancelled).toBe(false);
    const batchedSnap = cacheSnapshot(await testDb.records.orderBy("id").toArray());

    expect(fullSnap.length).toBe(batchedSnap.length);
    for (let i = 0; i < fullSnap.length; i++) {
      expect(batchedSnap[i]).toEqual(fullSnap[i]);
    }
  }, 120_000);

  it("cancels cleanly mid full recompute, persisting only pre-abort batches", async () => {
    await seedMixedVault(1200);
    const abort = new AbortController();
    const res = await recomputeAddressStats({
      skipNotification: true,
      batchSize: 100,
      signal: abort.signal,
      onProgress: (p) => {
        if (p.processed >= 100) abort.abort();
      },
    });
    expect(res.cancelled).toBe(true);
    expect(res.updated).toBeGreaterThan(0);
    expect(res.updated).toBeLessThan(1200);
    // Rows past the abort point keep their (stale) pre-run cache values.
    const untouched = await testDb.records.where("inputString").equals("scan-addr-1199").first();
    expect(untouched?.cachedBalanceSats).toBe(1);
  }, 60_000);

  it("returns cancelled with no writes when the signal is aborted before the scan starts", async () => {
    await seedMixedVault(40);
    const abort = new AbortController();
    abort.abort();
    const res = await recomputeAddressStats({ skipNotification: true, signal: abort.signal });
    expect(res.cancelled).toBe(true);
    expect(res.updated).toBe(0);
    const rec = await testDb.records.where("inputString").equals("scan-addr-0").first();
    expect(rec?.cachedBalanceSats).toBe(1);
  });
});

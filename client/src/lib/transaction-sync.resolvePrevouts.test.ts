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

// ---------------------------------------------------------------------------
// Cancellation contract (Task #642 follow-up): aborting resolvePrevouts via its
// signal mid-fetch must stop further network fetching cleanly and KEEP whatever
// was already resolved — no rollback. The unresolved count should reflect the
// partial progress (only the still-blank inputs remain), and stats.cancelled
// must be true so the caller can report the partial outcome.
//
// Setup: two inputs whose source outputs are already stored LOCALLY (resolved
// without any network call), plus six inputs whose source transactions must be
// fetched from the node. resolvePrevouts fetches in chunks of CONCURRENCY (4),
// checking the abort signal at the TOP of each chunk. We abort on the very first
// getTransaction call, so the first chunk (4 txs, already in flight) completes
// and is written, but the second chunk is skipped. End result: 2 local + 4
// fetched = 6 inputs resolved; the remaining 2 stay blank.
// ---------------------------------------------------------------------------

const LOCAL_SRC_1 = "c".repeat(64);
const LOCAL_SRC_2 = "d".repeat(64);
const FETCH_SRC = (n: number) => `${n}`.repeat(64).slice(0, 64);
const SPEND_TX = (n: number) => `e${n}`.padEnd(64, "f");

describe("TransactionSyncService.resolvePrevouts → cancellation keeps partial progress", () => {
  beforeEach(async () => {
    await testDb.records.clear();
    await testDb.blockchainTransactions.clear();
    await testDb.transactionParticipants.clear();
    await testDb.addressSyncState.clear();
  });

  it("aborts mid-fetch, keeps already-resolved inputs, flags cancelled, and leaves the rest blank", async () => {
    // Two source outputs that are already stored locally — resolvable WITHOUT
    // any network fetch. Their spending inputs must always be attributed,
    // regardless of when the abort lands.
    await testDb.transactionParticipants.bulkAdd([
      { txid: LOCAL_SRC_1, role: "output", vout: 0, address: "bc1qlocalsrc1", amount: 11000 } as TransactionParticipant,
      { txid: LOCAL_SRC_2, role: "output", vout: 0, address: "bc1qlocalsrc2", amount: 22000 } as TransactionParticipant,
    ]);

    // Two locally-resolvable spend inputs (blank address, prevout points at the
    // local outputs above). Inserted FIRST so they sort ahead of the fetch
    // inputs by primary key — keeps fetch ordering deterministic.
    await testDb.transactionParticipants.bulkAdd([
      { txid: SPEND_TX(1), role: "input", address: "", amount: 0, prevTxid: LOCAL_SRC_1, prevVout: 0 } as TransactionParticipant,
      { txid: SPEND_TX(2), role: "input", address: "", amount: 0, prevTxid: LOCAL_SRC_2, prevVout: 0 } as TransactionParticipant,
    ]);

    // Six spend inputs whose source transactions are NOT local and must be
    // fetched. Distinct prevTxids → six fetch txids → chunk0 = first 4,
    // chunk1 = last 2 at CONCURRENCY 4.
    const fetchInputs: TransactionParticipant[] = [];
    for (let i = 1; i <= 6; i++) {
      fetchInputs.push({
        txid: SPEND_TX(10 + i),
        role: "input",
        address: "",
        amount: 0,
        prevTxid: FETCH_SRC(i),
        prevVout: 0,
      } as TransactionParticipant);
    }
    await testDb.transactionParticipants.bulkAdd(fetchInputs);

    const controller = new AbortController();
    const fetchCalls: string[] = [];

    const service = new TransactionSyncService();
    // Mock provider: each fetch returns one output (vout 0) carrying an address.
    // The very first call trips the abort, so the in-flight first chunk still
    // settles and is written, but no further chunk is fetched.
    (service as any).provider = {
      getTransaction: vi.fn(async (txid: string) => {
        fetchCalls.push(txid);
        if (fetchCalls.length === 1) controller.abort();
        return {
          vout: [
            {
              n: 0,
              value: 30000,
              scriptpubkey_address: `bc1qfetched${txid.slice(0, 6)}`,
              scriptpubkey_type: "v0_p2wpkh",
            },
          ],
        };
      }),
    };

    const result = await service.resolvePrevouts(undefined, { signal: controller.signal });

    // Cancellation is flagged and only the first fetch chunk ran.
    expect(result.cancelled).toBe(true);
    expect(result.fetchedFromNode).toBe(4);
    // 2 locally-resolvable + 4 from the completed first chunk = 6 attributed.
    expect(result.resolved).toBe(6);

    // The two locally-resolvable inputs were written (no network needed).
    const local1 = await testDb.transactionParticipants
      .where("[prevTxid+prevVout]").equals([LOCAL_SRC_1, 0]).first();
    const local2 = await testDb.transactionParticipants
      .where("[prevTxid+prevVout]").equals([LOCAL_SRC_2, 0]).first();
    expect(local1?.address).toBe("bc1qlocalsrc1");
    expect(local2?.address).toBe("bc1qlocalsrc2");

    // Exactly six inputs now carry an address (no rollback of partial work),
    // and exactly two remain blank — the partial-progress contract.
    const allInputs = await testDb.transactionParticipants.where("role").equals("input").toArray();
    const resolvedInputs = allInputs.filter((p) => p.address && p.address !== "");
    const blankInputs = allInputs.filter((p) => !p.address || p.address === "");
    expect(resolvedInputs).toHaveLength(6);
    expect(blankInputs).toHaveLength(2);
  });
});

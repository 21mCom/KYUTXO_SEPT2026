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

// ---------------------------------------------------------------------------
// "Stop can't keep hammering the node" (Task #946): once the abort signal
// fires, resolvePrevouts must NOT launch any NEW fetch chunk. The abort is
// only checked at the TOP of each chunk, so the single in-flight chunk
// (CONCURRENCY = 4) still settles — but nothing beyond it may reach the node.
//
// This test directly COUNTS provider.getTransaction calls. With many more
// fetchable sources than one chunk holds, aborting on the very first call
// must cap the total call count at the first in-flight chunk size: any value
// above 4 would mean a post-stop chunk leaked through to the node.
// ---------------------------------------------------------------------------

const HAMMER_SPEND_TX = (n: number) => `a${n}`.padEnd(64, "9");
const HAMMER_SRC = (n: number) => `b${n}`.padEnd(64, "8");

describe("TransactionSyncService.resolvePrevouts → stop launches no new node fetch", () => {
  beforeEach(async () => {
    await testDb.records.clear();
    await testDb.blockchainTransactions.clear();
    await testDb.transactionParticipants.clear();
    await testDb.addressSyncState.clear();
  });

  it("never calls provider.getTransaction beyond the first in-flight chunk after abort", async () => {
    const CONCURRENCY = 4; // mirrors resolvePrevouts' fetch chunk size

    // Many more fetchable sources than a single chunk holds (5 chunks worth),
    // so if abort failed to stop the loop, the call count would blow past 4.
    const TOTAL_FETCH = CONCURRENCY * 5;
    const fetchInputs: TransactionParticipant[] = [];
    for (let i = 1; i <= TOTAL_FETCH; i++) {
      fetchInputs.push({
        txid: HAMMER_SPEND_TX(i),
        role: "input",
        address: "",
        amount: 0,
        prevTxid: HAMMER_SRC(i),
        prevVout: 0,
      } as TransactionParticipant);
    }
    await testDb.transactionParticipants.bulkAdd(fetchInputs);

    const controller = new AbortController();

    const service = new TransactionSyncService();
    const getTransaction = vi.fn(async (txid: string) => {
      // Trip the abort on the very first call — the rest of the first chunk
      // is already in flight, but no later chunk may start.
      if (getTransaction.mock.calls.length === 1) controller.abort();
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
    });
    (service as any).provider = { getTransaction };

    const result = await service.resolvePrevouts(undefined, { signal: controller.signal });

    // The node was hit for at most one in-flight chunk and never again.
    expect(getTransaction.mock.calls.length).toBeLessThanOrEqual(CONCURRENCY);
    expect(getTransaction.mock.calls.length).toBe(CONCURRENCY);
    expect(result.cancelled).toBe(true);
    expect(result.fetchedFromNode).toBe(CONCURRENCY);
  });
});

// ---------------------------------------------------------------------------
// Task #947: a STOPPED global resolve must still recompute the SOURCE wallet
// balances for the spends it did attribute. The recompute block runs over
// resolvedAddressSet inside `if (resolvedParticipants.length > 0)` — it is NOT
// gated on stats.cancelled — so the cached balance of an already-attributed
// source address must drop in the same run even when the fetch loop was
// aborted partway through. This guards against a regression that keeps the
// partial attribution but leaves the source balances stale.
//
// Setup: source address S has a synced state + a funding output and a blank
// spend input that is resolvable LOCALLY (no network). Plus enough fetch-only
// inputs to enter the fetch loop, where we abort on the first getTransaction
// call. S is resolved from the local cache regardless of the abort, so its
// balance recompute must still run despite stats.cancelled being true.
// ---------------------------------------------------------------------------

const ADDR_S = "bc1qsourcecancelaaaaaaaaaaaaaaaaaaaaaaaaa2";
const TX_FUND_S = "1".repeat(64); // funds S with 100000
const TX_SPEND_S = "2".repeat(64); // S's coin gets spent here
const CANCEL_FETCH_SRC = (n: number) => `9${n}`.padEnd(64, "a").slice(0, 64);
const CANCEL_SPEND_TX = (n: number) => `8${n}`.padEnd(64, "b").slice(0, 64);

describe("TransactionSyncService.resolvePrevouts → cancelled run still recomputes attributed source balances", () => {
  beforeEach(async () => {
    await testDb.records.clear();
    await testDb.blockchainTransactions.clear();
    await testDb.transactionParticipants.clear();
    await testDb.addressSyncState.clear();
  });

  it("drops the source balance for a locally-attributed spend even after aborting mid-fetch", async () => {
    // Source address S (synced + funded), plus a dummy record to keep the table
    // non-trivial.
    const sId = (await testDb.records.add(addrRecord(ADDR_S))) as number;

    // S is a synced address, so recompute treats a zero balance as authoritative
    // (a genuine spent-to-zero) rather than "not synced".
    await testDb.addressSyncState.add({
      address: ADDR_S,
      recordId: sId,
      lastSyncedHeight: 100,
      lastSyncedAt: Date.now(),
      txCount: 1,
    } as AddressSyncState);

    await testDb.blockchainTransactions.bulkAdd([
      { txid: TX_FUND_S, blockHeight: 100, blockTime: 1000, syncedAt: Date.now() } as BlockchainTransaction,
      { txid: TX_SPEND_S, blockHeight: 200, blockTime: 2000, syncedAt: Date.now() } as BlockchainTransaction,
    ]);

    // TX_FUND_S: output paying 100000 to S (vout 0). Stored locally so the spend
    // below resolves WITHOUT any network fetch.
    await testDb.transactionParticipants.add({
      txid: TX_FUND_S,
      role: "output",
      vout: 0,
      address: ADDR_S,
      amount: 100000,
      recordId: sId,
    } as TransactionParticipant);

    // TX_SPEND_S: blank input spending TX_FUND_S:0 (locally resolvable), plus an
    // output to some destination.
    await testDb.transactionParticipants.add({
      txid: TX_SPEND_S,
      role: "input",
      address: "",
      amount: 0,
      prevTxid: TX_FUND_S,
      prevVout: 0,
    } as TransactionParticipant);
    await testDb.transactionParticipants.add({
      txid: TX_SPEND_S,
      role: "output",
      vout: 0,
      address: "bc1qspenddestaaaaaaaaaaaaaaaaaaaaaaaaaaaa3",
      amount: 99000,
    } as TransactionParticipant);

    // Six fetch-only spend inputs to force the fetch loop, where we abort on the
    // first getTransaction call.
    const fetchInputs: TransactionParticipant[] = [];
    for (let i = 1; i <= 6; i++) {
      fetchInputs.push({
        txid: CANCEL_SPEND_TX(i),
        role: "input",
        address: "",
        amount: 0,
        prevTxid: CANCEL_FETCH_SRC(i),
        prevVout: 0,
      } as TransactionParticipant);
    }
    await testDb.transactionParticipants.bulkAdd(fetchInputs);

    const controller = new AbortController();
    const fetchCalls: string[] = [];

    const service = new TransactionSyncService();
    (service as any).provider = {
      getTransaction: vi.fn(async (txid: string) => {
        fetchCalls.push(txid);
        // Abort on the very first fetch so the run is cancelled mid-flight.
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

    // The run was cancelled mid-fetch...
    expect(result.cancelled).toBe(true);
    // ...but S's spend was attributed from the LOCAL cache (no fetch needed).
    expect(result.resolvedAddresses).toContain(ADDR_S);
    const sInput = await testDb.transactionParticipants
      .where("[prevTxid+prevVout]")
      .equals([TX_FUND_S, 0])
      .first();
    expect(sInput?.address).toBe(ADDR_S);
    expect(sInput?.amount).toBe(100000);

    // The critical assertion: despite stats.cancelled being true, S's cached
    // balance was recomputed in the same run and dropped to 0 (100000 in -
    // 100000 out). A regression that skips recompute on the cancelled path
    // would leave cachedBalanceSats stale/undefined.
    const sAfter = await testDb.records.get(sId);
    expect(sAfter?.cachedBalanceSats).toBe(0);
    expect(sAfter?.statsComputedAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Task #970: the full address-sync flow shares the same "cancel at a committed
// batch boundary, re-run resumes the remainder" contract that #871 proved for
// the scoped orphan rebuild (runTxidBackfill) and #695 for the whole-DB pass
// (resolveAllBlankInputAddresses). This is the missing end-to-end equivalent
// for resolvePrevouts — the prevout-resolution step the address sync drives.
//
// A regression here would silently leave input addresses blank after a
// paused/resumed sync. The test proves a cancel mid prevout-resolution (after
// at least one committed fetch chunk) followed by a fresh re-run:
//   - resolves exactly the inputs the first pass left blank,
//   - leaves the previously-committed inputs and blockchain rows untouched,
//   - sums resolved counts correctly across the two runs, and
//   - never duplicates a participant row.
// ---------------------------------------------------------------------------

const RESUME_SPEND = (n: number) => `7${n}`.padEnd(64, "c").slice(0, 64);
const RESUME_SRC = (n: number) => `6${n}`.padEnd(64, "d").slice(0, 64);
const RESUME_ADDR = (n: number) => `bc1qresumesrc${n}`;
const RESUME_VALUE = (n: number) => 50000 + n;

describe("TransactionSyncService.resolvePrevouts → cancel then re-run resumes the remainder", () => {
  beforeEach(async () => {
    await testDb.records.clear();
    await testDb.blockchainTransactions.clear();
    await testDb.transactionParticipants.clear();
    await testDb.addressSyncState.clear();
  });

  it("re-running after a mid-fetch cancel resolves only the leftover blank inputs, never re-touching committed rows or double-writing", async () => {
    const TOTAL = 8;
    const FIRST_CHUNK = 4; // mirrors resolvePrevouts' fetch CONCURRENCY

    // Source-tx → {address, value} lookup the fake provider serves, plus the
    // reverse prevTxid → index map used to verify per-row data on disk.
    const srcByTxid = new Map<string, { address: string; value: number }>();
    const indexBySrc = new Map<string, number>();
    for (let i = 1; i <= TOTAL; i++) {
      srcByTxid.set(RESUME_SRC(i), { address: RESUME_ADDR(i), value: RESUME_VALUE(i) });
      indexBySrc.set(RESUME_SRC(i), i);
    }

    // An address record per source so each resolved input links back to a
    // record id — lets us prove committed rows keep their full per-row data.
    const recordIdByAddr = new Map<string, number>();
    for (let i = 1; i <= TOTAL; i++) {
      const id = (await testDb.records.add(addrRecord(RESUME_ADDR(i)))) as number;
      recordIdByAddr.set(RESUME_ADDR(i), id);
    }

    // A blockchain row per spend tx — resolvePrevouts must never touch these.
    await testDb.blockchainTransactions.bulkAdd(
      Array.from({ length: TOTAL }, (_, k) => ({
        txid: RESUME_SPEND(k + 1),
        blockHeight: 100 + k,
        blockTime: 1000 + k,
        syncedAt: Date.now(),
      } as BlockchainTransaction)),
    );

    // Eight fetch-only spend inputs (blank address, distinct fetchable prevTxid)
    // each with one output, so the txids look realistic. Inputs are added before
    // outputs so they sort ahead by primary key, keeping fetch order
    // deterministic: fetch chunk 0 = sources 1-4, chunk 1 = sources 5-8.
    const inputs: TransactionParticipant[] = [];
    const outputs: TransactionParticipant[] = [];
    for (let i = 1; i <= TOTAL; i++) {
      inputs.push({
        txid: RESUME_SPEND(i),
        role: "input",
        address: "",
        amount: 0,
        prevTxid: RESUME_SRC(i),
        prevVout: 0,
      } as TransactionParticipant);
      outputs.push({
        txid: RESUME_SPEND(i),
        role: "output",
        vout: 0,
        address: `bc1qdest${i}`,
        amount: 10000,
      } as TransactionParticipant);
    }
    await testDb.transactionParticipants.bulkAdd(inputs);
    await testDb.transactionParticipants.bulkAdd(outputs);

    const makeProvider = (onFirstCall?: () => void) => {
      let calls = 0;
      return {
        getTransaction: vi.fn(async (txid: string) => {
          calls++;
          if (calls === 1) onFirstCall?.();
          const src = srcByTxid.get(txid);
          return {
            vout: [
              {
                n: 0,
                value: src?.value ?? 0,
                scriptpubkey_address: src?.address ?? "",
                scriptpubkey_type: "v0_p2wpkh",
              },
            ],
          };
        }),
      };
    };

    // ---- First pass: abort on the very first fetch. The in-flight first chunk
    // (4) still settles and is committed; the second chunk never starts. ----
    const controller = new AbortController();
    const service1 = new TransactionSyncService();
    (service1 as any).provider = makeProvider(() => controller.abort());

    const firstRun = await service1.resolvePrevouts(undefined, {
      signal: controller.signal,
    });

    expect(firstRun.cancelled).toBe(true);
    expect(firstRun.resolved).toBe(FIRST_CHUNK);
    expect(firstRun.fetchedFromNode).toBe(FIRST_CHUNK);

    const afterFirst = await testDb.transactionParticipants
      .where("role")
      .equals("input")
      .toArray();
    const committed = afterFirst.filter((p) => p.address);
    const blankAfterFirst = afterFirst.filter((p) => !p.address);
    expect(committed).toHaveLength(FIRST_CHUNK);
    expect(blankAfterFirst).toHaveLength(TOTAL - FIRST_CHUNK);

    // The committed inputs are exactly sources 1-4 and carry the right per-row
    // data (address + amount + record link), not a blanket fill.
    const resolvedIndices = new Set<number>();
    const committedSnap = new Map<
      number,
      { address: string; amount: number; recordId?: number }
    >();
    for (const p of committed) {
      const i = indexBySrc.get(p.prevTxid!)!;
      resolvedIndices.add(i);
      expect(p.address).toBe(RESUME_ADDR(i));
      expect(Number(p.amount)).toBe(RESUME_VALUE(i));
      expect(p.recordId).toBe(recordIdByAddr.get(RESUME_ADDR(i)));
      committedSnap.set(p.id as number, {
        address: p.address,
        amount: Number(p.amount),
        recordId: p.recordId,
      });
    }
    expect([...resolvedIndices].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);

    // ---- Second pass: a fresh, non-aborted signal + a provider that does not
    // cancel. Only the still-blank inputs (sources 5-8) should resolve. ----
    const service2 = new TransactionSyncService();
    (service2 as any).provider = makeProvider();

    const secondRun = await service2.resolvePrevouts(undefined, {
      signal: new AbortController().signal,
    });

    expect(secondRun.cancelled).toBe(false);
    // Exactly the leftover inputs resolved — no overlap with the first run.
    expect(secondRun.resolved).toBe(TOTAL - FIRST_CHUNK);
    expect(secondRun.fetchedFromNode).toBe(TOTAL - FIRST_CHUNK);
    // Resolved counts sum to the full set across the two runs.
    expect(firstRun.resolved + secondRun.resolved).toBe(TOTAL);

    // Every input is now attributed on disk — nothing left blank after resume —
    // and each carries the distinct data of the source output it spends.
    const afterSecond = await testDb.transactionParticipants
      .where("role")
      .equals("input")
      .toArray();
    expect(afterSecond).toHaveLength(TOTAL);
    expect(afterSecond.every((p) => p.address)).toBe(true);
    for (const p of afterSecond) {
      const i = indexBySrc.get(p.prevTxid!)!;
      expect(p.address).toBe(RESUME_ADDR(i));
      expect(Number(p.amount)).toBe(RESUME_VALUE(i));
      expect(p.recordId).toBe(recordIdByAddr.get(RESUME_ADDR(i)));
    }

    // The rows committed by the FIRST pass are byte-for-byte unchanged: the
    // re-run never re-wrote already-resolved work.
    for (const [id, snap] of committedSnap) {
      const row = await testDb.transactionParticipants.get(id);
      expect(row?.address).toBe(snap.address);
      expect(Number(row?.amount)).toBe(snap.amount);
      expect(row?.recordId).toBe(snap.recordId);
    }

    // No participant rows were duplicated: still exactly 8 inputs + 8 outputs.
    expect(await testDb.transactionParticipants.count()).toBe(TOTAL * 2);

    // Blockchain rows are untouched by prevout resolution across both passes.
    expect(await testDb.blockchainTransactions.count()).toBe(TOTAL);
    for (let i = 1; i <= TOTAL; i++) {
      const row = await testDb.blockchainTransactions
        .where("txid")
        .equals(RESUME_SPEND(i))
        .first();
      expect(row?.blockHeight).toBe(100 + (i - 1));
    }
  });
});

// ---------------------------------------------------------------------------
// Task #1032: a STOPPED PER-WALLET resolve must still recompute exactly the
// targeted wallet's source balances — and leave every other address alone.
//
// Task #947 (above) proved the GLOBAL path recomputes over resolvedAddressSet
// when cancelled. The per-wallet "Resolve" action (restrictToRecordIds set)
// takes the OTHER branch: it recomputes over writtenAddressSet — only the
// spends whose resolved source output maps to one of the targeted record ids.
// Per-wallet resolve is LOCAL-only (it never hits the network), so the abort
// signal is observed after the (skipped) fetch loop: cancelled must still be
// reported true, the local attribution + scoped recompute must still run, and a
// non-targeted source address's cached balance must be left byte-for-byte
// unchanged (it must NOT be swept into the recompute).
//
// Setup: a TARGETED source address T (synced + funded) whose blank spend input
// is resolvable locally, restrictToRecordIds = {T's record}. A NON-TARGETED
// source address O (synced + funded) whose blank spend input is ALSO resolvable
// locally, but O's record is NOT in the restrict set, so its spend is skipped
// and its pre-seeded cached balance must not move. We abort the signal so the
// run is flagged cancelled while still doing T's local recompute.
// ---------------------------------------------------------------------------

const ADDR_TARGET = "bc1qtargetwalletaaaaaaaaaaaaaaaaaaaaaaaa4";
const ADDR_OTHER = "bc1qotherwalletbbbbbbbbbbbbbbbbbbbbbbbbb5";
const TX_FUND_TARGET = "3".repeat(64); // funds T with 100000
const TX_SPEND_TARGET = "4".repeat(64); // T's coin gets spent here
const TX_FUND_OTHER = "5".repeat(64); // funds O with 50000
const TX_SPEND_OTHER = "6".repeat(64); // O's coin gets spent here
const OTHER_CACHED_BALANCE = 777777; // sentinel — must survive untouched
const OTHER_STATS_AT = 1234567890; // sentinel timestamp — must survive untouched

describe("TransactionSyncService.resolvePrevouts → stopped per-wallet resolve recomputes only the targeted wallet", () => {
  beforeEach(async () => {
    await testDb.records.clear();
    await testDb.blockchainTransactions.clear();
    await testDb.transactionParticipants.clear();
    await testDb.addressSyncState.clear();
  });

  it("recomputes the targeted wallet's source balance, leaves a non-targeted source untouched, and flags cancelled", async () => {
    // Targeted wallet T and non-targeted wallet O, both synced + funded.
    const targetId = (await testDb.records.add(addrRecord(ADDR_TARGET))) as number;
    const otherId = (await testDb.records.add(addrRecord(ADDR_OTHER))) as number;

    // Pre-seed O's cached balance so we can prove the run leaves it untouched.
    await testDb.records.update(otherId, {
      cachedBalanceSats: OTHER_CACHED_BALANCE,
      statsComputedAt: OTHER_STATS_AT,
    } as Partial<DbRecord>);

    // Both are synced addresses → recompute treats a zero balance as a genuine
    // spent-to-zero rather than "not synced".
    await testDb.addressSyncState.bulkAdd([
      {
        address: ADDR_TARGET,
        recordId: targetId,
        lastSyncedHeight: 100,
        lastSyncedAt: Date.now(),
        txCount: 1,
      } as AddressSyncState,
      {
        address: ADDR_OTHER,
        recordId: otherId,
        lastSyncedHeight: 100,
        lastSyncedAt: Date.now(),
        txCount: 1,
      } as AddressSyncState,
    ]);

    await testDb.blockchainTransactions.bulkAdd([
      { txid: TX_FUND_TARGET, blockHeight: 100, blockTime: 1000, syncedAt: Date.now() } as BlockchainTransaction,
      { txid: TX_SPEND_TARGET, blockHeight: 200, blockTime: 2000, syncedAt: Date.now() } as BlockchainTransaction,
      { txid: TX_FUND_OTHER, blockHeight: 100, blockTime: 1000, syncedAt: Date.now() } as BlockchainTransaction,
      { txid: TX_SPEND_OTHER, blockHeight: 200, blockTime: 2000, syncedAt: Date.now() } as BlockchainTransaction,
    ]);

    // Funding outputs for both, stored LOCALLY so the spends resolve with no
    // network fetch (per-wallet resolve never touches the node).
    await testDb.transactionParticipants.bulkAdd([
      { txid: TX_FUND_TARGET, role: "output", vout: 0, address: ADDR_TARGET, amount: 100000, recordId: targetId } as TransactionParticipant,
      { txid: TX_FUND_OTHER, role: "output", vout: 0, address: ADDR_OTHER, amount: 50000, recordId: otherId } as TransactionParticipant,
    ]);

    // Blank spend inputs (locally resolvable) for each wallet, plus their
    // destination outputs.
    await testDb.transactionParticipants.bulkAdd([
      { txid: TX_SPEND_TARGET, role: "input", address: "", amount: 0, prevTxid: TX_FUND_TARGET, prevVout: 0 } as TransactionParticipant,
      { txid: TX_SPEND_TARGET, role: "output", vout: 0, address: "bc1qtargetdestaaaaaaaaaaaaaaaaaaaaaaaaaa6", amount: 99000 } as TransactionParticipant,
      { txid: TX_SPEND_OTHER, role: "input", address: "", amount: 0, prevTxid: TX_FUND_OTHER, prevVout: 0 } as TransactionParticipant,
      { txid: TX_SPEND_OTHER, role: "output", vout: 0, address: "bc1qotherdestbbbbbbbbbbbbbbbbbbbbbbbbbb7", amount: 49000 } as TransactionParticipant,
    ]);

    // Abort the signal up front: the per-wallet resolve has no fetch loop to
    // interrupt, so the stop is observed after the (skipped) fetch phase. The
    // local attribution + scoped recompute must still run regardless.
    const controller = new AbortController();
    controller.abort();

    const service = new TransactionSyncService();
    // A provider that throws if touched — proves the per-wallet path is purely
    // local and never reaches the network even when scoped + aborted.
    (service as any).provider = {
      getTransaction: vi.fn(async () => {
        throw new Error("per-wallet resolve must never hit the network");
      }),
    };

    const result = await service.resolvePrevouts(undefined, {
      recomputeOrigin: "user",
      restrictToRecordIds: new Set([targetId]),
      signal: controller.signal,
    });

    // The stop is reported, the network was never touched, and exactly the one
    // targeted spend was attributed.
    expect(result.cancelled).toBe(true);
    expect(result.fetchedFromNode).toBe(0);
    expect(result.resolved).toBe(1);
    expect(result.resolvedAddresses).toEqual([ADDR_TARGET]);
    expect((service as any).provider.getTransaction).not.toHaveBeenCalled();

    // T's blank input now carries its source address + amount...
    const targetInput = await testDb.transactionParticipants
      .where("[prevTxid+prevVout]")
      .equals([TX_FUND_TARGET, 0])
      .first();
    expect(targetInput?.address).toBe(ADDR_TARGET);
    expect(targetInput?.amount).toBe(100000);

    // ...and its cached balance was recomputed to 0 (100000 in - 100000 out)
    // in the SAME (stopped) run.
    const targetAfter = await testDb.records.get(targetId);
    expect(targetAfter?.cachedBalanceSats).toBe(0);
    expect(targetAfter?.statsComputedAt).toBeTruthy();

    // The non-targeted wallet O is untouched: its spend was NOT attributed
    // (record id not in the restrict set) and its cached balance + timestamp
    // are exactly what we seeded — it was never swept into the recompute.
    const otherInput = await testDb.transactionParticipants
      .where("[prevTxid+prevVout]")
      .equals([TX_FUND_OTHER, 0])
      .first();
    expect(otherInput?.address).toBe("");
    const otherAfter = await testDb.records.get(otherId);
    expect(otherAfter?.cachedBalanceSats).toBe(OTHER_CACHED_BALANCE);
    expect(otherAfter?.statsComputedAt).toBe(OTHER_STATS_AT);
  });
});

// @vitest-environment jsdom
//
// Guards the FULL_SCAN_ROW_LIMIT gate in the full-vault stats recompute
// (task: "Confirm balance backfill still finishes on extreme vaults that
// exceed the streaming-scan limit").
//
// recomputeAddressStats({}) (the Balance page's one-time backfill shape) first
// tries the streaming fast path: computeStatsForAllAddressesByScan counts
// transactionParticipants + blockchainTransactions and — only while the sum
// stays <= FULL_SCAN_ROW_LIMIT — aggregates the whole vault in memory. Past
// the limit it returns null and the recompute silently falls back to the
// per-batch anyOf path (computeStatsForAddresses per batch). Nothing verified
// that fallback still completes with visible progress and correct balances at
// over-limit scale, nor that the gate itself can't break in either direction
// (a gate stuck "over" would silently disable the fast path for everyone; a
// gate stuck "under" would OOM the largest vaults).
//
// Driving a real >2M-row vault through fake-indexeddb is infeasible in a unit
// test, so the row counts the gate reads are mocked (Table.count on the two
// gated tables) while the actual row data stays small and real. That is an
// exact simulation of the gate's inputs: the gate consumes ONLY those two
// count() results.
//
// Path detection is code-level, not timing-based: the streaming scan and the
// per-batch fallback use distinct named repository queries.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
    // Mirrors the records + sync schema subset in client/src/lib/database.ts
    // (same subset as address-stats.filteredScanGate.test.ts).
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
      settings: "id",
    });
  }
}

const testDb = new TestDb(`KYUTXO-over-limit-fallback-${Date.now()}-${Math.random()}`);

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return { ...actual, db: testDb };
});

const { recomputeAddressStats, FULL_SCAN_ROW_LIMIT } = await import(
  "./address-stats"
);
const { DexieVaultRepository } = await import("../repository");

// ---- Fixtures ---------------------------------------------------------------

const addrOf = (i: number) => `over-limit-addr-${String(i).padStart(5, "0")}`;
const txidOf = (i: number) => `over-limit-tx-${i}`;

const TOTAL = 1_500; // address records
const WITH_DATA = 400; // of which own one confirmed output each
const BATCH_SIZE = 200; // recompute batch size -> ceil(1500/200) = 8 batches

/**
 * Seed TOTAL address records; the first WITH_DATA each own one confirmed
 * (1000+i)-sat output so both compute paths do real work and balances can be
 * spot-checked. The rest have no participant rows and must come out as
 * "not synced" (stats reset to null) on either path.
 */
async function seedVault() {
  const records: DbRecord[] = [];
  for (let i = 1; i <= TOTAL; i++) {
    records.push({
      id: i,
      type: "address",
      inputString: addrOf(i),
      inputStringLower: addrOf(i),
      label: "",
      tags: [],
      categories: [],
      createdAt: 1000,
      updatedAt: 1000,
    } as unknown as DbRecord);
  }
  await testDb.records.bulkAdd(records);

  const participants: TransactionParticipant[] = [];
  const txs: BlockchainTransaction[] = [];
  for (let i = 1; i <= WITH_DATA; i++) {
    participants.push({
      txid: txidOf(i),
      role: "output",
      address: addrOf(i),
      amount: 1000 + i,
      recordId: i,
      vout: 0,
    } as unknown as TransactionParticipant);
    txs.push({
      txid: txidOf(i),
      blockHeight: 800_000 + i,
      blockTime: 1_700_000_000 + i,
      syncedAt: 1,
      hasOpReturn: false,
    } as unknown as BlockchainTransaction);
  }
  await testDb.transactionParticipants.bulkAdd(participants);
  await testDb.blockchainTransactions.bulkAdd(txs);
}

// ---- Path probes -------------------------------------------------------------

/** Named participant queries issued through the shared repository. */
let querySpy: ReturnType<typeof vi.spyOn>;
let participantWhereKeys: string[] = [];
let whereSpy: ReturnType<typeof vi.spyOn>;

/** Streaming-scan signature: primary-key paging over participants. */
const scanPages = () =>
  participantWhereKeys.filter((name) => name === "id").length;
/** Per-batch fallback signature: address-index loads over participants. */
const addressLoads = () =>
  querySpy.mock.calls.filter(
    ([table, name]) =>
      table === "transactionParticipants" &&
      name === "participants.byAddressesAfterId",
  ).length;
/** The over-limit gate must prevent every whole-table participant scan page. */
const expectNoFullParticipantScan = () => {
  expect(scanPages()).toBe(0);
};

/**
 * Mock the ONLY inputs the row-limit gate consumes: the two Table.count()
 * results. Row data underneath stays real, so whichever path runs computes
 * from genuine rows.
 */
function mockGateCounts(participantCount: number, txCount: number) {
  const original = DexieVaultRepository.prototype.count;
  const count = vi
    .spyOn(DexieVaultRepository.prototype, "count")
    .mockImplementation(function (table) {
      if (table === "transactionParticipants") return Promise.resolve(participantCount);
      if (table === "blockchainTransactions") return Promise.resolve(txCount);
      return original.call(this, table);
    });
  return () => {
    count.mockRestore();
  };
}

beforeEach(async () => {
  await testDb.records.clear();
  await testDb.transactionParticipants.clear();
  await testDb.blockchainTransactions.clear();
  await testDb.addressSyncState.clear();
  await testDb.settings.clear();
  participantWhereKeys = [];
  querySpy = vi.spyOn(DexieVaultRepository.prototype, "query");
  whereSpy = vi
    .spyOn(testDb.transactionParticipants, "where")
    .mockImplementation(function (
      this: unknown,
      ...args: Parameters<Table<TransactionParticipant, number>["where"]>
    ) {
      const key = args[0];
      if (typeof key === "string") participantWhereKeys.push(key);
      const orig = Object.getPrototypeOf(testDb.transactionParticipants).where;
      return orig.apply(testDb.transactionParticipants, args);
    });
});

afterEach(() => {
  querySpy.mockRestore();
  whereSpy.mockRestore();
  vi.restoreAllMocks();
});

/** Run the exact full-vault backfill shape the Balance page issues. */
async function runFullRecompute() {
  const progress: Array<{ processed: number; total: number }> = [];
  const result = await recomputeAddressStats({
    skipNotification: true,
    batchSize: BATCH_SIZE,
    onProgress: (p) => progress.push({ ...p }),
  });
  return { result, progress };
}

function expectCorrectStats() {
  return Promise.all([
    testDb.records.get(1),
    testDb.records.get(WITH_DATA),
    testDb.records.get(WITH_DATA + 1),
    testDb.records.get(TOTAL),
  ]).then(([first, lastWithData, firstBare, lastBare]) => {
    expect(first?.cachedBalanceSats).toBe(1001);
    expect(first?.cachedUtxoCount).toBe(1);
    expect(first?.cachedTxCount).toBe(1);
    expect(first?.statsComputedAt).not.toBeNull();
    expect(lastWithData?.cachedBalanceSats).toBe(1000 + WITH_DATA);
    expect(lastWithData?.cachedUtxoCount).toBe(1);
    // No participants + never synced -> stats stay/reset to "not synced".
    expect(firstBare?.statsComputedAt ?? null).toBeNull();
    expect(lastBare?.statsComputedAt ?? null).toBeNull();
  });
}

function expectProgressAdvancedToTotal(
  progress: Array<{ processed: number; total: number }>,
) {
  // Initial 0-of-total tick plus one tick per batch, monotonically increasing.
  expect(progress.length).toBeGreaterThanOrEqual(
    1 + Math.ceil(TOTAL / BATCH_SIZE),
  );
  expect(progress[0]).toEqual({ processed: 0, total: TOTAL });
  for (let i = 1; i < progress.length; i++) {
    expect(progress[i].processed).toBeGreaterThan(progress[i - 1].processed);
    expect(progress[i].total).toBe(TOTAL);
  }
  expect(progress[progress.length - 1].processed).toBe(TOTAL);
}

// ---- Tests ------------------------------------------------------------------

describe(
  "recomputeAddressStats over-limit streaming-scan fallback",
  { timeout: 120_000 },
  () => {
    it("control: under the row limit the full recompute takes the streaming scan (gate not stuck closed)", async () => {
      await seedVault();
      // Real counts (400 + 400) are far under the limit; no mocking needed —
      // this also pins that FULL_SCAN_ROW_LIMIT hasn't collapsed to something
      // tiny that would disable the fast path for ordinary vaults.
      const { result, progress } = await runFullRecompute();

      expect(scanPages()).toBeGreaterThan(0);
      expect(addressLoads()).toBe(0);
      expect(result).toEqual({ updated: TOTAL, cancelled: false });
      expectProgressAdvancedToTotal(progress);
      await expectCorrectStats();
    });

    it("boundary: combined counts exactly AT the limit still take the streaming scan", async () => {
      await seedVault();
      const restore = mockGateCounts(FULL_SCAN_ROW_LIMIT - 5, 5);
      try {
        const { result } = await runFullRecompute();
        expect(scanPages()).toBeGreaterThan(0);
        expect(addressLoads()).toBe(0);
        expect(result).toEqual({ updated: TOTAL, cancelled: false });
      } finally {
        restore();
      }
    });

    it("over the limit: gate trips, batched fallback still completes with progress and correct stats", async () => {
      await seedVault();
      // One row past the gate: participants + txs = FULL_SCAN_ROW_LIMIT + 1.
      const restore = mockGateCounts(FULL_SCAN_ROW_LIMIT - 5, 6);
      try {
        const { result, progress } = await runFullRecompute();

        // Fallback decision: the per-batch path loaded participants through
        // the bounded address query once per batch, with no extra id pages
        // from the whole-table streaming path.
        expect(addressLoads()).toBe(Math.ceil(TOTAL / BATCH_SIZE));
        expectNoFullParticipantScan();

        // The fallback finishes the whole vault, reports advancing progress,
        // and writes the same correct stats the fast path would.
        expect(result).toEqual({ updated: TOTAL, cancelled: false });
        expectProgressAdvancedToTotal(progress);
        await expectCorrectStats();
      } finally {
        restore();
      }
    });

    it("far over the limit (5x): fallback result matches a fast-path run row-for-row", async () => {
      await seedVault();

      // Fast-path reference run first.
      const { result: fastResult } = await runFullRecompute();
      expect(fastResult).toEqual({ updated: TOTAL, cancelled: false });
      const fastRows = await testDb.records
        .where("type")
        .equals("address")
        .toArray();
      const fastByAddr = new Map(
        fastRows.map((r) => [
          r.inputString,
          {
            balance: r.cachedBalanceSats ?? null,
            utxos: r.cachedUtxoCount ?? null,
            txs: r.cachedTxCount ?? null,
            synced: r.statsComputedAt != null,
          },
        ]),
      );

      // Wipe cached stats so the fallback recomputes from scratch.
      await testDb.records.toCollection().modify((r) => {
        delete (r as Partial<DbRecord>).cachedBalanceSats;
        delete (r as Partial<DbRecord>).cachedUtxoCount;
        delete (r as Partial<DbRecord>).cachedTxCount;
        delete (r as Partial<DbRecord>).cachedLastActivityTime;
        delete (r as Partial<DbRecord>).statsComputedAt;
      });
      participantWhereKeys = [];
      querySpy.mockClear();

      const restore = mockGateCounts(FULL_SCAN_ROW_LIMIT * 4, FULL_SCAN_ROW_LIMIT);
      try {
        const { result } = await runFullRecompute();
        expect(addressLoads()).toBeGreaterThan(0);
        expectNoFullParticipantScan();
        expect(result).toEqual({ updated: TOTAL, cancelled: false });
      } finally {
        restore();
      }

      const slowRows = await testDb.records
        .where("type")
        .equals("address")
        .toArray();
      expect(slowRows.length).toBe(TOTAL);
      for (const r of slowRows) {
        const fast = fastByAddr.get(r.inputString);
        expect(fast).toBeDefined();
        expect({
          balance: r.cachedBalanceSats ?? null,
          utxos: r.cachedUtxoCount ?? null,
          txs: r.cachedTxCount ?? null,
          synced: r.statsComputedAt != null,
        }).toEqual(fast);
      }
    });

    it("cancel mid-fallback: aborting during the batched path stops cleanly with no stale progress", async () => {
      await seedVault();
      // Trip the gate so the run takes the per-batch fallback (same mock the
      // "over the limit" test above uses).
      const restore = mockGateCounts(FULL_SCAN_ROW_LIMIT - 5, 6);
      try {
        const controller = new AbortController();
        const progress: Array<{ processed: number; total: number }> = [];
        // Abort right after the FIRST batch (200 of 1500 records) — that
        // batch is entirely within the WITH_DATA range (id 1..200 <= 400),
        // so the still-unprocessed batch 2 (ids 201..400) also owns real
        // participant data. If the recompute kept running past the abort,
        // those addresses would come out with non-zero balances instead of
        // staying untouched.
        const abortAtProcessed = BATCH_SIZE;

        const result = await recomputeAddressStats({
          skipNotification: true,
          batchSize: BATCH_SIZE,
          signal: controller.signal,
          onProgress: (p) => {
            progress.push({ ...p });
            if (p.processed >= abortAtProcessed && !controller.signal.aborted) {
              controller.abort();
            }
          },
        });

        // Fallback path was taken (not the streaming scan), and only the one
        // batch before the abort point issued an address-index load.
        expect(addressLoads()).toBe(1);
        expectNoFullParticipantScan();

        expect(result).toEqual({ updated: abortAtProcessed, cancelled: true });

        // Progress stopped exactly at the abort point — no ticks past it.
        expect(progress).toEqual([
          { processed: 0, total: TOTAL },
          { processed: abortAtProcessed, total: TOTAL },
        ]);

        // The completed batch was written correctly...
        const completed = await testDb.records.get(1);
        expect(completed?.cachedBalanceSats).toBe(1001);
        expect(completed?.statsComputedAt).not.toBeNull();

        // ...but records in the next (never-started) batch keep their
        // pre-run "not synced" state, even though they own real participant
        // data that a completed run would have picked up.
        const untouchedWithData = await testDb.records.get(WITH_DATA - 20);
        expect(untouchedWithData?.id).toBeGreaterThan(abortAtProcessed);
        expect(untouchedWithData?.statsComputedAt ?? null).toBeNull();
        expect(untouchedWithData?.cachedBalanceSats).toBeUndefined();

        const untouchedBare = await testDb.records.get(TOTAL);
        expect(untouchedBare?.statsComputedAt ?? null).toBeNull();
      } finally {
        restore();
      }
    });
  },
);

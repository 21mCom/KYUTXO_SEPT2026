// @vitest-environment jsdom
//
// Guards the filtered-recompute scan gates in recomputeAddressStats():
// a filtered "recompute selected" (Database Doctor) reuses the streaming
// whole-vault scan (computeStatsForAllAddressesByScan) ONLY when BOTH gates
// hold:
//   - the selection is >= FILTERED_SCAN_MIN_REQUESTED (1000) rows, AND
//   - the selection covers >= FILTERED_SCAN_VAULT_FRACTION (50%) of the
//     vault's address records.
// A regression flipping either gate would make every small recompute pay a
// full-vault scan — turning an instant action into a multi-second stall on
// 20k-row vaults. The large-selection (scan) side is additionally pinned in a
// real browser by scripts/check-database-doctor-recompute-browser.mjs; this
// node test pins BOTH sides of each gate boundary.
//
// Scan-path detection: computeStatsForAllAddressesByScan always begins by
// counting the transactionParticipants table (its FULL_SCAN_ROW_LIMIT check). The
// targeted per-batch path (computeStatsForAddresses + anyOf lookups) never
// counts that table. Spying on Table.count is therefore an exact, code-level
// signal of which path ran — no timing heuristics.

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
    // Mirrors the records + sync schema in client/src/lib/database.ts (same
    // subset as address-stats.integration.test.ts).
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

const testDb = new TestDb(`KYUTXO-filtered-scan-gate-${Date.now()}-${Math.random()}`);

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return { ...actual, db: testDb };
});

const { recomputeAddressStats } = await import("./address-stats");

// ---- Fixtures ---------------------------------------------------------------

const addrOf = (i: number) => `gate-addr-${String(i).padStart(5, "0")}`;
const txidOf = (i: number) => `gate-tx-${i}`;

/**
 * Seed a vault of `total` address records (ids 1..total). The first
 * `withData` of them each own one confirmed 1000+i sat output, so both compute
 * paths have real work and correctness can be spot-checked; the rest carry no
 * participant rows (the gate itself only depends on record/selection counts).
 */
async function seedVault(total: number, withData = 10) {
  const records: DbRecord[] = [];
  for (let i = 1; i <= total; i++) {
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
  for (let i = 1; i <= withData; i++) {
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

const idsRange = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

/** Spy that fires only when the streaming scan's row-limit count runs. */
let participantCountSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await testDb.records.clear();
  await testDb.transactionParticipants.clear();
  await testDb.blockchainTransactions.clear();
  await testDb.addressSyncState.clear();
  await testDb.settings.clear();
  participantCountSpy = vi.spyOn(testDb.transactionParticipants, "count");
});

afterEach(() => {
  participantCountSpy.mockRestore();
});

const scanRan = () => participantCountSpy.mock.calls.length > 0;

// ---- Tests ------------------------------------------------------------------

describe("recomputeAddressStats filtered-scan gates", { timeout: 120_000 }, () => {
  it("a tiny selection (50 of 2400) takes the targeted path, never the full-vault scan", async () => {
    await seedVault(2400);

    const result = await recomputeAddressStats({
      recordIds: idsRange(50),
      skipNotification: true,
    });

    expect(scanRan()).toBe(false);
    expect(result.updated).toBe(50);
    expect(result.cancelled).toBe(false);

    // Targeted path still computes correct stats for the selected rows.
    const first = await testDb.records.get(1);
    expect(first?.cachedBalanceSats).toBe(1001);
    expect(first?.cachedUtxoCount).toBe(1);
    expect(first?.statsComputedAt).not.toBeNull();

    // Writes stay scoped to the selection: an unselected record is untouched.
    const untouched = await testDb.records.get(51);
    expect(untouched?.statsComputedAt ?? null).toBeNull();
  });

  it("fraction gate: 1199 of 2400 (just under 50%) stays targeted even though rows >= 1000", async () => {
    await seedVault(2400);

    const result = await recomputeAddressStats({
      recordIds: idsRange(1199),
      skipNotification: true,
    });

    expect(scanRan()).toBe(false);
    expect(result.updated).toBe(1199);
  });

  it("fraction gate boundary: 1200 of 2400 (exactly 50%) switches to the scan", async () => {
    await seedVault(2400);

    const result = await recomputeAddressStats({
      recordIds: idsRange(1200),
      skipNotification: true,
    });

    expect(scanRan()).toBe(true);
    expect(result.updated).toBe(1200);
    expect(result.cancelled).toBe(false);

    // Scan path computes the same correct stats ...
    const first = await testDb.records.get(1);
    expect(first?.cachedBalanceSats).toBe(1001);
    expect(first?.cachedUtxoCount).toBe(1);

    // ... and writes stay scoped to the requested subset.
    const untouched = await testDb.records.get(1201);
    expect(untouched?.statsComputedAt ?? null).toBeNull();
  });

  it("min-rows gate: 999 of 1900 (over the fraction, under 1000 rows) stays targeted", async () => {
    await seedVault(1900);

    // 999 >= 1900 * 0.5 is true (950), so ONLY the min-row gate blocks the scan.
    const result = await recomputeAddressStats({
      recordIds: idsRange(999),
      skipNotification: true,
    });

    expect(scanRan()).toBe(false);
    expect(result.updated).toBe(999);
  });

  it("min-rows gate boundary: 1000 of 1900 (both gates met) switches to the scan", async () => {
    await seedVault(1900);

    const result = await recomputeAddressStats({
      recordIds: idsRange(1000),
      skipNotification: true,
    });

    expect(scanRan()).toBe(true);
    expect(result.updated).toBe(1000);
  });
});

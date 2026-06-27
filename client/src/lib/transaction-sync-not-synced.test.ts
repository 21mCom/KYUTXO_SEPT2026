// @vitest-environment jsdom
//
// Regression tests for addresses stuck on "Not synced" after a successful sync.
//
// Three cases are covered:
//   1. A synced address with zero on-chain transactions is marked synced after
//      syncAddress completes (statsTouchedAddresses is widened).
//   2. A re-sync that skips all transactions (already at/below lastSyncedHeight)
//      keeps the address marked synced.
//   3. The backfillMissingSyncStats helper marks a pre-fix stuck address whose
//      sync state exists but whose statsComputedAt was never set.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type {
  Record as DbRecord,
  BlockchainTransaction,
  TransactionParticipant,
  AddressSyncState,
  RecordOrigin,
  NodeSettings,
} from "@/lib/database";
import type { ApiTransaction, BlockchainProvider } from "@/lib/blockchain-api";

// ---- In-memory DB ----------------------------------------------------------

class TestDb extends Dexie {
  records!: Table<DbRecord, number>;
  recordOrigins!: Table<RecordOrigin, number>;
  blockchainTransactions!: Table<BlockchainTransaction, number>;
  transactionParticipants!: Table<TransactionParticipant, number>;
  addressSyncState!: Table<AddressSyncState, number>;
  nodeSettings!: Table<NodeSettings, string>;
  settings!: Table<{ id: string } & Record<string, unknown>, string>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      records:
        "++id, type, inputString, inputStringLower, label, owner, walletName, " +
        "seedName, walletSoftware, *tags, *categories, createdAt, updatedAt, " +
        "syncDepth, addressImportance, [type+addressImportance], [type+id], discoveredFromRecordId",
      recordOrigins: "++id, recordId, originType, createdAt",
      blockchainTransactions:
        "++id, &txid, blockHeight, blockTime, syncedAt, hasOpReturn, rawFingerprintCaptured",
      transactionParticipants:
        "++id, [txid+role], txid, role, address, recordId, [prevTxid+prevVout]",
      addressSyncState: "++id, &address, recordId, lastSyncedAt",
      nodeSettings: "id",
      settings: "id",
    });
  }
}

const testDb = new TestDb(
  `KYUTXO-not-synced-${Date.now()}-${Math.random()}`,
);

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return { ...actual, db: testDb };
});

const { TransactionSyncService } = await import("./transaction-sync");
const { backfillMissingSyncStats } = await import("./data/address-stats");

// ---- Fixtures --------------------------------------------------------------

const ADDR = "bc1qtrackedaddr00000000000000000000000000";
const TXID_A = "a".repeat(64);
const PREV_TXID = "e".repeat(64);

const BLOCK_HEIGHT = 800000;
const BLOCK_TIME = 1700000000;

function makeAddressRecord(inputString: string): DbRecord {
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

/** A minimal confirmed API transaction. */
function makeApiTx(txid: string): ApiTransaction {
  return {
    txid,
    version: 2,
    locktime: 0,
    status: {
      confirmed: true,
      block_height: BLOCK_HEIGHT,
      block_time: BLOCK_TIME,
    },
    fee: 1000,
    size: 200,
    weight: 800,
    vin: [
      {
        txid: PREV_TXID,
        vout: 0,
        sequence: 0xfffffffd,
        prevout: {
          scriptpubkey_address: "bc1qinput0000000000000000000000000000000",
          scriptpubkey_type: "v0_p2wpkh",
          value: 100000,
        },
      },
    ],
    vout: [
      {
        scriptpubkey_address: ADDR,
        scriptpubkey_type: "v0_p2wpkh",
        value: 99000,
        n: 0,
      },
    ],
  };
}

function makeProvider(
  apiTxs: ApiTransaction[],
  blockHeight = 800100,
): BlockchainProvider {
  return {
    name: "fake",
    async getBlockHeight() {
      return blockHeight;
    },
    async getAddressTransactions() {
      return apiTxs;
    },
    async getTransaction() {
      return null;
    },
    async testConnection() {
      return { success: true };
    },
  };
}

async function runSyncAddress(
  apiTxs: ApiTransaction[],
  recordId: number,
  opts: { minConfirmedHeight?: number; currentHeight?: number } = {},
) {
  const { minConfirmedHeight = 800100, currentHeight = 800100 } = opts;
  const service = new TransactionSyncService();
  (service as unknown as { provider: BlockchainProvider }).provider =
    makeProvider(apiTxs, currentHeight);

  await (service as unknown as {
    syncAddress: (
      address: string,
      recordId: number,
      minConfirmedHeight: number,
      currentHeight: number,
    ) => Promise<unknown>;
  }).syncAddress(ADDR, recordId, minConfirmedHeight, currentHeight);

  // Return the touched-addresses set from the service instance so tests can
  // verify the address was included without needing to run the full recompute.
  return (service as unknown as { statsTouchedAddresses: Set<string> })
    .statsTouchedAddresses;
}

beforeEach(async () => {
  await testDb.records.clear();
  await testDb.recordOrigins.clear();
  await testDb.blockchainTransactions.clear();
  await testDb.transactionParticipants.clear();
  await testDb.addressSyncState.clear();
  await testDb.nodeSettings.clear();
  await testDb.settings.clear();
});

// ---- 1. Zero on-chain transactions -----------------------------------------

describe("syncAddress: zero on-chain transactions", () => {
  it("adds the address to statsTouchedAddresses even when no txs exist", async () => {
    const recordId = (await testDb.records.add(
      makeAddressRecord(ADDR),
    )) as number;

    // Provider returns empty list — address has no on-chain history.
    const touched = await runSyncAddress([], recordId);

    expect(touched.has(ADDR)).toBe(true);
  });

  it("writes an addressSyncState entry for the address", async () => {
    const recordId = (await testDb.records.add(
      makeAddressRecord(ADDR),
    )) as number;

    await runSyncAddress([], recordId);

    const syncState = await testDb.addressSyncState
      .where("address")
      .equals(ADDR)
      .first();
    expect(syncState).toBeDefined();
    expect(syncState!.lastSyncedHeight).toBeGreaterThan(0);
  });
});

// ---- 2. Re-sync with no new transactions -----------------------------------

describe("syncAddress: re-sync where all txs are already synced", () => {
  it("adds the address to statsTouchedAddresses when all txs are skipped as already synced", async () => {
    const recordId = (await testDb.records.add(
      makeAddressRecord(ADDR),
    )) as number;

    // First sync: imports one transaction.
    await runSyncAddress([makeApiTx(TXID_A)], recordId, {
      minConfirmedHeight: 800100,
      currentHeight: 800100,
    });

    // Second sync: the same tx is at/below lastSyncedHeight → skipped entirely.
    const touched = await runSyncAddress([makeApiTx(TXID_A)], recordId, {
      minConfirmedHeight: 800100,
      currentHeight: 800200,
    });

    expect(touched.has(ADDR)).toBe(true);
  });
});

// ---- 3. Backfill self-healing ----------------------------------------------

describe("backfillMissingSyncStats", () => {
  it("returns zero when no addresses have been synced", async () => {
    const result = await backfillMissingSyncStats();
    expect(result.backfilled).toBe(0);
  });

  it("marks a stuck address (sync state exists, statsComputedAt missing)", async () => {
    const recordId = (await testDb.records.add(
      makeAddressRecord(ADDR),
    )) as number;

    // Simulate a pre-fix sync: write an addressSyncState entry but leave
    // statsComputedAt absent from the record (mimicking the old behaviour where
    // zero-tx addresses were never added to statsTouchedAddresses).
    await testDb.addressSyncState.add({
      address: ADDR,
      recordId,
      lastSyncedHeight: 800100,
      lastSyncedAt: Date.now(),
      txCount: 0,
    } as AddressSyncState);

    // Record has no statsComputedAt yet.
    const before = await testDb.records.get(recordId);
    expect(before!.statsComputedAt).toBeUndefined();

    const result = await backfillMissingSyncStats();

    // The backfill should have recomputed stats for the stuck address.
    expect(result.backfilled).toBe(1);

    const after = await testDb.records.get(recordId);
    expect(after!.statsComputedAt).toBeDefined();
    expect(typeof after!.statsComputedAt).toBe("number");
  });

  it("does not re-backfill an address that already has statsComputedAt", async () => {
    const now = Date.now();
    const recordId = (await testDb.records.add({
      ...makeAddressRecord(ADDR),
      statsComputedAt: now - 1000,
      cachedBalanceSats: 0,
      cachedTxCount: 0,
      cachedLastActivityTime: 0,
      cachedUtxoCount: 0,
    } as unknown as DbRecord)) as number;

    await testDb.addressSyncState.add({
      address: ADDR,
      recordId,
      lastSyncedHeight: 800100,
      lastSyncedAt: now,
      txCount: 0,
    } as AddressSyncState);

    const result = await backfillMissingSyncStats();
    // Already stamped — nothing to backfill.
    expect(result.backfilled).toBe(0);
  });

  it("only backfills addresses that have a sync state entry", async () => {
    // An address with NO addressSyncState — not synced at all, must be left alone.
    const recordId = (await testDb.records.add(
      makeAddressRecord(ADDR),
    )) as number;

    const result = await backfillMissingSyncStats();
    expect(result.backfilled).toBe(0);

    const rec = await testDb.records.get(recordId);
    expect(rec!.statsComputedAt).toBeUndefined();
  });
});

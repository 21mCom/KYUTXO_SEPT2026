// @vitest-environment jsdom
//
// Unit coverage for wallet-fingerprint capture during transaction sync
// (transaction-sync.ts → syncAddress / backfillFingerprint).
//
// Two behaviours are at stake and are exercised here against an in-memory Dexie
// (fake-indexeddb) plus a hand-rolled fake BlockchainProvider — mirroring the
// harness in txid-backfill.test.ts:
//   1. New import path: a freshly synced confirmed tx must persist the
//      fingerprint fields with rawFingerprintCaptured=true.
//   2. Re-sync backfill path: a row synced before fingerprint capture existed
//      (rawFingerprintCaptured falsy) must get its fingerprint fields populated
//      on a later re-sync — via the already-synced height-skip branch — WITHOUT
//      re-importing the transaction. This is what keeps Privacy Audit from
//      regressing back to "re-sync needed".
//
// We mock @/lib/database with an isolated test DB so the CRUD layer (which sync
// writes through) operates on our fixture instead of the real vault. The
// provider is injected directly onto the service instance so no network/real
// provider is ever constructed.

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
    });
  }
}

const testDb = new TestDb(`KYUTXO-fingerprint-${Date.now()}-${Math.random()}`);

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return { ...actual, db: testDb };
});

const { TransactionSyncService } = await import("./transaction-sync");

// ---- Fixtures --------------------------------------------------------------

const TXID_A = "a".repeat(64);
const PREV_TXID = "e".repeat(64);

const ADDR_TRACKED = "bc1qtrackedaddrxxxxxxxxxxxxxxxxxxxxxxxxx0";
const ADDR_IN = "bc1qinputaddrxxxxxxxxxxxxxxxxxxxxxxxxxxx0";
const ADDR_OUT = "bc1qoutputaddrxxxxxxxxxxxxxxxxxxxxxxxxxxx1";

const TX_BLOCK_HEIGHT = 800000;
const TX_BLOCK_TIME = 1700000000;

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

/**
 * A confirmed tx that carries `version` and `locktime` — exactly the data that
 * makes parseTransaction set rawFingerprintCaptured=true. All inputs signal RBF
 * (sequence < 0xFFFFFFFE) so the parsed fingerprint also has hasRbf=true, giving
 * the assertions a derived boolean field to check.
 */
function makeFingerprintApiTx(txid: string): ApiTransaction {
  return {
    txid,
    version: 2,
    locktime: 0,
    status: {
      confirmed: true,
      block_height: TX_BLOCK_HEIGHT,
      block_time: TX_BLOCK_TIME,
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
          scriptpubkey_address: ADDR_IN,
          scriptpubkey_type: "v0_p2wpkh",
          value: 100000,
        },
      },
    ],
    vout: [
      {
        scriptpubkey_address: ADDR_OUT,
        scriptpubkey_type: "v0_p2wpkh",
        value: 99000,
        n: 0,
      },
    ],
  };
}

/**
 * Pre-fingerprint blockchainTransactions row: everything a normal sync writes
 * EXCEPT the wallet-fingerprint subset, so rawFingerprintCaptured is undefined —
 * i.e. a row imported before the feature existed.
 */
function makePreFingerprintTxRow(txid: string): Omit<BlockchainTransaction, "id"> {
  return {
    txid,
    blockHeight: TX_BLOCK_HEIGHT,
    blockTime: TX_BLOCK_TIME,
    fee: 1000,
    feeRate: 5,
    syncedAt: Date.now(),
    size: 200,
    weight: 800,
    vsize: 200,
    hasOpReturn: false,
  } as unknown as Omit<BlockchainTransaction, "id">;
}

/** Minimal fake provider returning a fixed tx list for getAddressTransactions. */
function makeProvider(apiTxs: ApiTransaction[], blockHeight = 800100): BlockchainProvider {
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

/**
 * Builds a sync service with the fake provider injected, and invokes the private
 * syncAddress entry point directly (the unit under test) with explicit
 * confirmed/current heights so we control which branch runs.
 */
async function runSyncAddress(
  apiTxs: ApiTransaction[],
  recordId: number,
  opts: { minConfirmedHeight?: number; currentHeight?: number } = {},
) {
  const { minConfirmedHeight = 800100, currentHeight = 800100 } = opts;
  const service = new TransactionSyncService();
  // Inject the fake provider so no real/network provider is used.
  (service as unknown as { provider: BlockchainProvider }).provider =
    makeProvider(apiTxs, currentHeight);
  return (service as unknown as {
    syncAddress: (
      address: string,
      recordId: number,
      minConfirmedHeight: number,
      currentHeight: number,
    ) => Promise<{
      imported: number;
      updated: number;
      newRecords: number;
      apiTxCount: number;
      skippedAlreadySynced: number;
      skippedUnconfirmed: number;
    }>;
  }).syncAddress(ADDR_TRACKED, recordId, minConfirmedHeight, currentHeight);
}

beforeEach(async () => {
  await testDb.records.clear();
  await testDb.recordOrigins.clear();
  await testDb.blockchainTransactions.clear();
  await testDb.transactionParticipants.clear();
  await testDb.addressSyncState.clear();
  await testDb.nodeSettings.clear();
});

// ---- New-import fingerprint capture ----------------------------------------

describe("syncAddress fingerprint capture (new import)", () => {
  it("persists fingerprint fields with rawFingerprintCaptured=true on a freshly synced tx", async () => {
    const trackedId = (await testDb.records.add(
      makeAddressRecord(ADDR_TRACKED),
    )) as number;

    const stats = await runSyncAddress([makeFingerprintApiTx(TXID_A)], trackedId);

    // The tx was imported fresh (no prior sync state, no existing row).
    expect(stats.imported).toBe(1);

    const row = await testDb.blockchainTransactions
      .where("txid")
      .equals(TXID_A)
      .first();
    expect(row).toBeDefined();
    expect(row!.rawFingerprintCaptured).toBe(true);
    expect(row!.nVersion).toBe(2);
    expect(row!.nLockTime).toBe(0);
    // Derived fingerprint signal: all inputs signalled RBF.
    expect(row!.hasRbf).toBe(true);
  });
});

// ---- Re-sync backfill via the height-skip branch ---------------------------

describe("syncAddress fingerprint backfill (re-sync)", () => {
  it("populates fingerprint fields on a pre-feature row at/below lastSyncedHeight without re-importing", async () => {
    const trackedId = (await testDb.records.add(
      makeAddressRecord(ADDR_TRACKED),
    )) as number;

    // A row synced before fingerprint capture existed: no fingerprint fields.
    await testDb.blockchainTransactions.add(
      makePreFingerprintTxRow(TXID_A) as BlockchainTransaction,
    );
    const before = await testDb.blockchainTransactions
      .where("txid")
      .equals(TXID_A)
      .first();
    expect(before!.rawFingerprintCaptured).toBeUndefined();

    // Address already synced up to (and including) the tx's block height, so the
    // re-sync hits the already-synced height-skip branch rather than re-import.
    await testDb.addressSyncState.add({
      address: ADDR_TRACKED,
      recordId: trackedId,
      lastSyncedHeight: TX_BLOCK_HEIGHT,
      lastSyncedAt: Date.now(),
      txCount: 1,
    } as AddressSyncState);

    const stats = await runSyncAddress([makeFingerprintApiTx(TXID_A)], trackedId, {
      currentHeight: 800100,
    });

    // Height-skip branch: counted as already-synced, not a fresh import...
    expect(stats.imported).toBe(0);
    expect(stats.skippedAlreadySynced).toBe(1);
    // ...but the backfill performed a write, so it tallies as updated.
    expect(stats.updated).toBe(1);

    // The existing row was updated in place — still exactly one row for the txid.
    const rows = await testDb.blockchainTransactions
      .where("txid")
      .equals(TXID_A)
      .toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].rawFingerprintCaptured).toBe(true);
    expect(rows[0].nVersion).toBe(2);
    expect(rows[0].nLockTime).toBe(0);
    expect(rows[0].hasRbf).toBe(true);

    // Backfill must not import the transaction: no participant rows are written.
    const participants = await testDb.transactionParticipants
      .where("txid")
      .equals(TXID_A)
      .toArray();
    expect(participants).toHaveLength(0);
  });

  it("backfills a pre-feature row first seen via another address (existingTx branch, above lastSyncedHeight)", async () => {
    const trackedId = (await testDb.records.add(
      makeAddressRecord(ADDR_TRACKED),
    )) as number;

    // The tx row was imported earlier through a *different* tracked address,
    // before fingerprint capture existed — so it carries no fingerprint fields.
    await testDb.blockchainTransactions.add(
      makePreFingerprintTxRow(TXID_A) as BlockchainTransaction,
    );
    const before = await testDb.blockchainTransactions
      .where("txid")
      .equals(TXID_A)
      .first();
    expect(before!.rawFingerprintCaptured).toBeUndefined();

    // This address has been synced, but only up to a height BELOW the tx's block
    // height. So the tx is *above* lastSyncedHeight and skips the height-skip
    // branch, landing in the existingTx branch (row exists, not re-imported).
    await testDb.addressSyncState.add({
      address: ADDR_TRACKED,
      recordId: trackedId,
      lastSyncedHeight: TX_BLOCK_HEIGHT - 100,
      lastSyncedAt: Date.now(),
      txCount: 0,
    } as AddressSyncState);

    const stats = await runSyncAddress([makeFingerprintApiTx(TXID_A)], trackedId, {
      currentHeight: 800100,
    });

    // existingTx branch: the row already existed, so nothing is imported...
    expect(stats.imported).toBe(0);
    expect(stats.skippedAlreadySynced).toBe(0);
    // ...but the backfill wrote the fingerprint fields, tallied as updated.
    expect(stats.updated).toBe(1);

    // The existing row was updated in place — still exactly one row for the txid.
    const rows = await testDb.blockchainTransactions
      .where("txid")
      .equals(TXID_A)
      .toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].rawFingerprintCaptured).toBe(true);
    expect(rows[0].nVersion).toBe(2);
    expect(rows[0].nLockTime).toBe(0);
    expect(rows[0].hasRbf).toBe(true);

    // Backfill must not import the transaction: no participant rows are written.
    const participants = await testDb.transactionParticipants
      .where("txid")
      .equals(TXID_A)
      .toArray();
    expect(participants).toHaveLength(0);
  });

  it("leaves a row already carrying fingerprint data untouched on re-sync", async () => {
    const trackedId = (await testDb.records.add(
      makeAddressRecord(ADDR_TRACKED),
    )) as number;

    // Row already has fingerprint data captured (rawFingerprintCaptured=true).
    await testDb.blockchainTransactions.add({
      ...makePreFingerprintTxRow(TXID_A),
      rawFingerprintCaptured: true,
      nVersion: 1,
      nLockTime: 0,
    } as BlockchainTransaction);

    await testDb.addressSyncState.add({
      address: ADDR_TRACKED,
      recordId: trackedId,
      lastSyncedHeight: TX_BLOCK_HEIGHT,
      lastSyncedAt: Date.now(),
      txCount: 1,
    } as AddressSyncState);

    const stats = await runSyncAddress([makeFingerprintApiTx(TXID_A)], trackedId);

    // No backfill write happened (guard short-circuits on captured rows).
    expect(stats.updated).toBe(0);
    expect(stats.skippedAlreadySynced).toBe(1);

    // The pre-existing nVersion is preserved, not overwritten by the API's v2.
    const row = await testDb.blockchainTransactions
      .where("txid")
      .equals(TXID_A)
      .first();
    expect(row!.nVersion).toBe(1);
  });
});

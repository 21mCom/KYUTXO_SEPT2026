// @vitest-environment jsdom
//
// Unit coverage for the txid-driven backfill engine (txid-backfill.ts).
//
// The engine is pure enough to test against an in-memory Dexie (fake-indexeddb)
// and a hand-rolled fake BlockchainProvider:
//   - detectOrphanedTxRecords: which transaction records are missing on-chain rows
//   - runTxidBackfill: rebuilt / skipped / failed accounting, idempotency, cancel
//   - detectAndBackfill: offline / unconfigured deferral
//
// We mock @/lib/database with an isolated test DB so the CRUD layer (which the
// engine writes through) operates on our fixture instead of the real vault, and
// we override createProviderFromSettings so detectAndBackfill picks up our fake
// provider while keeping the real parseTransaction / MINIMUM_CONFIRMATIONS.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type {
  Record as DbRecord,
  BlockchainTransaction,
  TransactionParticipant,
  NodeSettings,
} from "@/lib/database";
import type { ApiTransaction, BlockchainProvider } from "@/lib/blockchain-api";

// ---- In-memory DB ----------------------------------------------------------

class TestDb extends Dexie {
  records!: Table<DbRecord, number>;
  blockchainTransactions!: Table<BlockchainTransaction, number>;
  transactionParticipants!: Table<TransactionParticipant, number>;
  nodeSettings!: Table<NodeSettings, string>;
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
      nodeSettings: "id",
    });
  }
}

const testDb = new TestDb(`KYUTXO-backfill-${Date.now()}-${Math.random()}`);

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return { ...actual, db: testDb };
});

// createProviderFromSettings is overridden so detectAndBackfill resolves to the
// provider the test sets. parseTransaction / MINIMUM_CONFIRMATIONS stay real.
let nextProvider: BlockchainProvider | null = null;
vi.mock("@/lib/blockchain-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/blockchain-api")>(
    "@/lib/blockchain-api",
  );
  return {
    ...actual,
    createProviderFromSettings: () => {
      if (!nextProvider) throw new Error("no provider configured for test");
      return nextProvider;
    },
  };
});

const {
  detectOrphanedTxRecords,
  runTxidBackfill,
  detectAndBackfill,
} = await import("./txid-backfill");

// ---- Fixtures --------------------------------------------------------------

const TXID_A = "a".repeat(64);
const TXID_B = "b".repeat(64);
const TXID_C = "c".repeat(64);
const TXID_D = "d".repeat(64);
const PREV_TXID = "e".repeat(64);

const ADDR_IN = "bc1qinputaddrxxxxxxxxxxxxxxxxxxxxxxxxxxx0";
const ADDR_OUT = "bc1qoutputaddrxxxxxxxxxxxxxxxxxxxxxxxxxxx1";

function makeTxRecord(inputString: string): DbRecord {
  const now = Date.now();
  return {
    type: "transaction",
    inputString,
    inputStringLower: inputString.toLowerCase(),
    label: "",
    tags: [],
    categories: [],
    createdAt: now,
    updatedAt: now,
  } as unknown as DbRecord;
}

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

function makeExistingTxRow(txid: string): Omit<BlockchainTransaction, "id"> {
  return {
    txid,
    blockHeight: 700000,
    blockTime: 1690000000,
    fee: 500,
    feeRate: 2,
    syncedAt: Date.now(),
    size: 200,
    weight: 800,
    vsize: 200,
    hasOpReturn: false,
  } as unknown as Omit<BlockchainTransaction, "id">;
}

interface TxShape {
  confirmed?: boolean;
  blockHeight?: number;
  blockTime?: number;
  inputs?: Array<{ address: string; amount?: number; prevTxid?: string; prevVout?: number }>;
  outputs?: Array<{ address: string; amount?: number; n?: number }>;
}

function makeApiTx(txid: string, shape: TxShape = {}): ApiTransaction {
  const {
    confirmed = true,
    blockHeight = 800000,
    blockTime = 1700000000,
    inputs = [{ address: ADDR_IN, amount: 100000, prevTxid: PREV_TXID, prevVout: 0 }],
    outputs = [{ address: ADDR_OUT, amount: 99000, n: 0 }],
  } = shape;
  return {
    txid,
    status: {
      confirmed,
      block_height: confirmed ? blockHeight : undefined,
      block_time: confirmed ? blockTime : undefined,
    },
    fee: 1000,
    size: 200,
    weight: 800,
    vin: inputs.map((i) => ({
      txid: i.prevTxid ?? PREV_TXID,
      vout: i.prevVout ?? 0,
      prevout: {
        scriptpubkey_address: i.address,
        scriptpubkey_type: "v0_p2wpkh",
        value: i.amount ?? 100000,
      },
    })),
    vout: outputs.map((o, idx) => ({
      scriptpubkey_address: o.address,
      scriptpubkey_type: "v0_p2wpkh",
      value: o.amount ?? 99000,
      n: o.n ?? idx,
    })),
  };
}

/**
 * Minimal fake provider backed by a txid → ApiTransaction map. Per-txid errors
 * can be injected; getBlockHeight is configurable (and can throw to simulate
 * an offline node).
 */
function makeProvider(opts: {
  txs?: Map<string, ApiTransaction | null>;
  blockHeight?: number;
  blockHeightThrows?: boolean;
  errorTxids?: Set<string>;
  onGetTransaction?: (txid: string) => void;
} = {}): BlockchainProvider {
  const { txs = new Map(), blockHeight = 800010, blockHeightThrows = false, errorTxids = new Set(), onGetTransaction } = opts;
  return {
    name: "fake",
    async getBlockHeight() {
      if (blockHeightThrows) throw new Error("ECONNREFUSED");
      return blockHeight;
    },
    async getAddressTransactions() {
      return [];
    },
    async getTransaction(txid: string) {
      onGetTransaction?.(txid);
      if (errorTxids.has(txid)) throw new Error("fetch failed");
      return txs.has(txid) ? txs.get(txid)! : null;
    },
    async testConnection() {
      return { success: true };
    },
  };
}

beforeEach(async () => {
  nextProvider = null;
  await testDb.records.clear();
  await testDb.blockchainTransactions.clear();
  await testDb.transactionParticipants.clear();
  await testDb.nodeSettings.clear();
});

// ---- detectOrphanedTxRecords ----------------------------------------------

describe("detectOrphanedTxRecords", () => {
  it("detects transaction records with a valid txid but no blockchain row", async () => {
    await testDb.records.add(makeTxRecord(TXID_A));
    await testDb.records.add(makeTxRecord(TXID_B));

    const { txids, recordIds } = await detectOrphanedTxRecords();

    expect(txids.sort()).toEqual([TXID_A, TXID_B].sort());
    expect(recordIds.size).toBe(2);
    expect(recordIds.has(TXID_A)).toBe(true);
    expect(recordIds.has(TXID_B)).toBe(true);
  });

  it("does not flag records that already have a blockchain row", async () => {
    await testDb.records.add(makeTxRecord(TXID_A));
    await testDb.records.add(makeTxRecord(TXID_B));
    await testDb.blockchainTransactions.add(makeExistingTxRow(TXID_A) as BlockchainTransaction);

    const { txids } = await detectOrphanedTxRecords();

    expect(txids).toEqual([TXID_B]);
  });

  it("excludes address-type records even when inputString looks like a txid", async () => {
    await testDb.records.add(makeAddressRecord(TXID_C));
    await testDb.records.add(makeTxRecord(TXID_A));

    const { txids } = await detectOrphanedTxRecords();

    expect(txids).toEqual([TXID_A]);
    expect(txids).not.toContain(TXID_C);
  });

  it("ignores transaction records whose inputString is not a valid txid", async () => {
    await testDb.records.add(makeTxRecord("not-a-real-txid"));
    await testDb.records.add(makeTxRecord(TXID_A));

    const { txids } = await detectOrphanedTxRecords();

    expect(txids).toEqual([TXID_A]);
  });

  it("returns nothing when there are no transaction records", async () => {
    await testDb.records.add(makeAddressRecord(ADDR_IN));

    const { txids, recordIds } = await detectOrphanedTxRecords();

    expect(txids).toEqual([]);
    expect(recordIds.size).toBe(0);
  });
});

// ---- runTxidBackfill -------------------------------------------------------

describe("runTxidBackfill", () => {
  it("returns an empty result without touching the provider when no txids given", async () => {
    const getTx = vi.fn();
    const provider = makeProvider({ onGetTransaction: getTx });

    const result = await runTxidBackfill(provider, []);

    expect(result.orphansFound).toBe(0);
    expect(result.rebuilt).toBe(0);
    expect(getTx).not.toHaveBeenCalled();
  });

  it("rebuilds an orphan: writes the blockchain row and participants", async () => {
    const txs = new Map<string, ApiTransaction | null>([
      [TXID_A, makeApiTx(TXID_A)],
    ]);
    const provider = makeProvider({ txs });

    const result = await runTxidBackfill(provider, [TXID_A]);

    expect(result.rebuilt).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);

    const rows = await testDb.blockchainTransactions.where("txid").equals(TXID_A).toArray();
    expect(rows).toHaveLength(1);

    const participants = await testDb.transactionParticipants.where("txid").equals(TXID_A).toArray();
    // 1 input + 1 output
    expect(participants).toHaveLength(2);
    expect(participants.some((p) => p.role === "input" && p.address === ADDR_IN)).toBe(true);
    expect(participants.some((p) => p.role === "output" && p.address === ADDR_OUT)).toBe(true);
  });

  it("links participants to existing records by inputString", async () => {
    const outId = await testDb.records.add(makeAddressRecord(ADDR_OUT));
    const txs = new Map<string, ApiTransaction | null>([
      [TXID_A, makeApiTx(TXID_A)],
    ]);
    const provider = makeProvider({ txs });

    await runTxidBackfill(provider, [TXID_A]);

    const out = await testDb.transactionParticipants
      .where("txid")
      .equals(TXID_A)
      .and((p) => p.role === "output")
      .first();
    expect(out?.recordId).toBe(outId);
  });

  it("does not duplicate a txid that already has a blockchain row", async () => {
    await testDb.blockchainTransactions.add(makeExistingTxRow(TXID_A) as BlockchainTransaction);
    const getTx = vi.fn();
    const provider = makeProvider({
      txs: new Map([[TXID_A, makeApiTx(TXID_A)]]),
      onGetTransaction: getTx,
    });

    const result = await runTxidBackfill(provider, [TXID_A]);

    expect(result.skipped).toBe(1);
    expect(result.rebuilt).toBe(0);
    // Existing-row guard short-circuits before the provider is hit.
    expect(getTx).not.toHaveBeenCalled();

    const rows = await testDb.blockchainTransactions.where("txid").equals(TXID_A).toArray();
    expect(rows).toHaveLength(1);
  });

  it("skips a txid the provider cannot find", async () => {
    const provider = makeProvider({ txs: new Map([[TXID_A, null]]) });

    const result = await runTxidBackfill(provider, [TXID_A]);

    expect(result.skipped).toBe(1);
    expect(result.rebuilt).toBe(0);
    expect(await testDb.blockchainTransactions.count()).toBe(0);
  });

  it("skips an unconfirmed transaction", async () => {
    const provider = makeProvider({
      txs: new Map([[TXID_A, makeApiTx(TXID_A, { confirmed: false })]]),
    });

    const result = await runTxidBackfill(provider, [TXID_A]);

    expect(result.skipped).toBe(1);
    expect(result.rebuilt).toBe(0);
  });

  it("skips a transaction with insufficient confirmations", async () => {
    // tip is only 2 blocks above the tx → below MINIMUM_CONFIRMATIONS (5)
    const provider = makeProvider({
      blockHeight: 800002,
      txs: new Map([[TXID_A, makeApiTx(TXID_A, { blockHeight: 800000 })]]),
    });

    const result = await runTxidBackfill(provider, [TXID_A]);

    expect(result.skipped).toBe(1);
    expect(result.rebuilt).toBe(0);
  });

  it("counts a provider error as failed and records the message", async () => {
    const provider = makeProvider({ errorTxids: new Set([TXID_A]) });

    const result = await runTxidBackfill(provider, [TXID_A]);

    expect(result.failed).toBe(1);
    expect(result.rebuilt).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("fetch failed");
  });

  it("tallies a mix of rebuilt, skipped and failed across many txids", async () => {
    const txs = new Map<string, ApiTransaction | null>([
      [TXID_A, makeApiTx(TXID_A)], // rebuilt
      [TXID_B, null], // skipped (not found)
      [TXID_C, makeApiTx(TXID_C, { confirmed: false })], // skipped (unconfirmed)
    ]);
    const provider = makeProvider({ txs, errorTxids: new Set([TXID_D]) });

    const result = await runTxidBackfill(provider, [TXID_A, TXID_B, TXID_C, TXID_D], {
      concurrency: 2,
    });

    expect(result.orphansFound).toBe(4);
    expect(result.rebuilt).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.failed).toBe(1);
  });

  it("stops fetching once the AbortSignal fires", async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const txs = new Map<string, ApiTransaction | null>([
      [TXID_A, makeApiTx(TXID_A)],
      [TXID_B, makeApiTx(TXID_B)],
      [TXID_C, makeApiTx(TXID_C)],
    ]);
    const provider = makeProvider({
      txs,
      onGetTransaction: (txid) => {
        seen.push(txid);
        controller.abort(); // abort as soon as the first item is fetched
      },
    });

    const result = await runTxidBackfill(provider, [TXID_A, TXID_B, TXID_C], {
      concurrency: 1,
      signal: controller.signal,
    });

    // Only the first chunk runs; the loop breaks before the rest.
    expect(seen).toHaveLength(1);
    expect(result.rebuilt).toBe(1);
    expect(result.rebuilt + result.skipped + result.failed).toBe(1);
  });

  it("emits a final 'complete' progress event", async () => {
    const events: string[] = [];
    const provider = makeProvider({ txs: new Map([[TXID_A, makeApiTx(TXID_A)]]) });

    await runTxidBackfill(provider, [TXID_A], {
      onProgress: (p) => events.push(p.phase),
    });

    expect(events[events.length - 1]).toBe("complete");
  });
});

// ---- detectAndBackfill (offline / deferral) --------------------------------

describe("detectAndBackfill", () => {
  it("returns deferred=true when no node settings are configured", async () => {
    await testDb.records.add(makeTxRecord(TXID_A));

    const result = await detectAndBackfill();

    expect(result.deferred).toBe(true);
    expect(result.orphansFound).toBe(1);
    expect(result.rebuilt).toBe(0);
    expect(result.deferReason).toMatch(/node settings/i);
  });

  it("returns deferred=true when the provider cannot connect", async () => {
    await testDb.records.add(makeTxRecord(TXID_A));
    await testDb.nodeSettings.add({ id: "default" } as unknown as NodeSettings);
    nextProvider = makeProvider({ blockHeightThrows: true });

    const result = await detectAndBackfill();

    expect(result.deferred).toBe(true);
    expect(result.orphansFound).toBe(1);
    expect(result.deferReason).toMatch(/could not connect/i);
  });

  it("returns a non-deferred empty result when there are no orphans", async () => {
    const result = await detectAndBackfill();

    expect(result.deferred).toBe(false);
    expect(result.orphansFound).toBe(0);
  });

  it("runs the backfill end-to-end when a provider is reachable", async () => {
    await testDb.records.add(makeTxRecord(TXID_A));
    await testDb.nodeSettings.add({ id: "default" } as unknown as NodeSettings);
    nextProvider = makeProvider({ txs: new Map([[TXID_A, makeApiTx(TXID_A)]]) });

    const result = await detectAndBackfill();

    expect(result.deferred).toBe(false);
    expect(result.rebuilt).toBe(1);
    expect(await testDb.blockchainTransactions.where("txid").equals(TXID_A).count()).toBe(1);
  });
});

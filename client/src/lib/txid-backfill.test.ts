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
  addressSyncState!: Table<{ id?: number; address: string; recordId?: number; lastSyncedAt?: number }, number>;
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
      addressSyncState: "++id, &address, recordId, lastSyncedAt",
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
  resolveAllBlankInputAddresses,
} = await import("./txid-backfill");

// ---- Fixtures --------------------------------------------------------------

const TXID_A = "a".repeat(64);
const TXID_B = "b".repeat(64);
const TXID_C = "c".repeat(64);
const TXID_D = "d".repeat(64);
const PREV_TXID = "e".repeat(64);
const PREV_1 = "1".repeat(64);
const PREV_2 = "2".repeat(64);

const ADDR_IN = "bc1qinputaddrxxxxxxxxxxxxxxxxxxxxxxxxxxx0";
const ADDR_OUT = "bc1qoutputaddrxxxxxxxxxxxxxxxxxxxxxxxxxxx1";
const ADDR_PREV1 = "bc1qprevoneaddrxxxxxxxxxxxxxxxxxxxxxxxxxx2";
const ADDR_PREV2 = "bc1qprevtwoaddrxxxxxxxxxxxxxxxxxxxxxxxxxx3";
const PREV_ADDR = "bc1qprevoutaddrxxxxxxxxxxxxxxxxxxxxxxxxx2";

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
 * Builds an orphan ApiTransaction whose single input carries NO prevout data, so
 * parseTransaction yields an input with a blank address but a chaseable
 * prevTxid/prevVout reference — exactly the gap resolveBackfillPrevouts closes.
 */
function makeApiTxBlankInput(
  txid: string,
  prevTxid = PREV_TXID,
  prevVout = 0,
): ApiTransaction {
  return {
    txid,
    status: { confirmed: true, block_height: 800000, block_time: 1700000000 },
    fee: 1000,
    size: 200,
    weight: 800,
    // No `prevout` field → scriptpubkey_address is absent → blank input address.
    vin: [{ txid: prevTxid, vout: prevVout }],
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
  await testDb.addressSyncState.clear();
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

// ---- runTxidBackfill (concurrent races) ------------------------------------
//
// runTxidBackfill carries an in-flight idempotency guard: each chunk item
// re-checks getTransactionByTxid before fetching, and writeOnChainData
// re-checks again right before the insert. The actual reason that guard exists
// is two backfills racing on the same txids at once — e.g. an auto-backfill on
// startup overlapping a user-triggered "rebuild" from Settings. These tests
// launch two runs in parallel and assert no duplicate blockchainTransactions
// row is ever created, and that the combined rebuilt tally never overcounts the
// orphans.

describe("runTxidBackfill (concurrent races)", () => {
  it("two parallel runs for the same txid create exactly one blockchain row", async () => {
    const txs = new Map<string, ApiTransaction | null>([
      [TXID_A, makeApiTx(TXID_A)],
    ]);
    // Each run gets its own provider instance so a slow getTransaction in one
    // does not serialise the other; both back the same fixture data.
    const providerA = makeProvider({ txs });
    const providerB = makeProvider({ txs });

    const [resultA, resultB] = await Promise.all([
      runTxidBackfill(providerA, [TXID_A], { concurrency: 1 }),
      runTxidBackfill(providerB, [TXID_A], { concurrency: 1 }),
    ]);

    // Exactly one blockchain row for the txid, regardless of who won the race.
    const rows = await testDb.blockchainTransactions
      .where("txid")
      .equals(TXID_A)
      .toArray();
    expect(rows).toHaveLength(1);

    // The losing run never wrote a duplicate, so participants come from the one
    // winning writeOnChainData call (1 input + 1 output).
    const participants = await testDb.transactionParticipants
      .where("txid")
      .equals(TXID_A)
      .toArray();
    expect(participants).toHaveLength(2);

    // The orphan was rebuilt exactly once across both runs — never twice.
    expect(resultA.rebuilt + resultB.rebuilt).toBe(1);
    expect(resultA.rebuilt + resultB.rebuilt).toBeLessThanOrEqual(1);
    // The loser counts the txid as skipped (saw the row) or failed (lost the
    // unique-index insert race), but never as a second rebuild.
    expect(resultA.rebuilt + resultA.skipped + resultA.failed).toBe(1);
    expect(resultB.rebuilt + resultB.skipped + resultB.failed).toBe(1);
  });

  it("two parallel runs over a shared txid set never duplicate or overcount", async () => {
    const orphanTxids = [TXID_A, TXID_B, TXID_C, TXID_D];
    const txs = new Map<string, ApiTransaction | null>(
      orphanTxids.map((t) => [t, makeApiTx(t)]),
    );
    const providerA = makeProvider({ txs });
    const providerB = makeProvider({ txs });

    const [resultA, resultB] = await Promise.all([
      runTxidBackfill(providerA, orphanTxids, { concurrency: 2 }),
      runTxidBackfill(providerB, orphanTxids, { concurrency: 2 }),
    ]);

    // One blockchain row per txid — no duplicates anywhere.
    for (const txid of orphanTxids) {
      const rows = await testDb.blockchainTransactions
        .where("txid")
        .equals(txid)
        .toArray();
      expect(rows).toHaveLength(1);
    }
    expect(await testDb.blockchainTransactions.count()).toBe(orphanTxids.length);

    // No txid was rebuilt by both runs: the combined rebuilt tally must not
    // exceed the number of orphans.
    expect(resultA.rebuilt + resultB.rebuilt).toBeLessThanOrEqual(
      orphanTxids.length,
    );
    // Every orphan ended up rebuilt exactly once (by whichever run won it).
    expect(resultA.rebuilt + resultB.rebuilt).toBe(orphanTxids.length);

    // Participants are written only by the winning writeOnChainData, so each
    // txid has exactly its 1 input + 1 output — no doubled-up rows.
    expect(await testDb.transactionParticipants.count()).toBe(
      orphanTxids.length * 2,
    );
  });
});

// ---- writeOnChainData field mapping ----------------------------------------

describe("writeOnChainData field mapping", () => {
  it("persists fee/feeRate/size/weight/vsize/blockHeight/blockTime from the parsed tx", async () => {
    // makeApiTx defaults: fee=1000, size=200, weight=800, blockHeight=800000,
    // blockTime=1700000000. parseTransaction derives feeRate = round(fee/weight*4)
    // = round(1000/800*4) = 5 and vsize = ceil(weight/4) = 200.
    const provider = makeProvider({ txs: new Map([[TXID_A, makeApiTx(TXID_A)]]) });

    const result = await runTxidBackfill(provider, [TXID_A]);
    expect(result.rebuilt).toBe(1);

    const row = await testDb.blockchainTransactions.where("txid").equals(TXID_A).first();
    expect(row).toBeDefined();
    expect(row!.fee).toBe(1000);
    expect(row!.feeRate).toBe(5);
    expect(row!.size).toBe(200);
    expect(row!.weight).toBe(800);
    expect(row!.vsize).toBe(200);
    expect(row!.blockHeight).toBe(800000);
    expect(row!.blockTime).toBe(1700000000);
  });

  it("captures an OP_RETURN output into hasOpReturn/opReturnData, not a participant", async () => {
    // "48656c6c6f20576f726c64" is the hex for "Hello World".
    const opReturnAsm = "OP_RETURN OP_PUSHBYTES_11 48656c6c6f20576f726c64";
    const apiTx: ApiTransaction = {
      txid: TXID_A,
      status: { confirmed: true, block_height: 800000, block_time: 1700000000 },
      fee: 1000,
      size: 200,
      weight: 800,
      vin: [
        {
          txid: PREV_TXID,
          vout: 0,
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
        {
          scriptpubkey_type: "op_return",
          scriptpubkey_asm: opReturnAsm,
          value: 0,
          n: 1,
        },
      ],
    };
    const provider = makeProvider({ txs: new Map([[TXID_A, apiTx]]) });

    const result = await runTxidBackfill(provider, [TXID_A]);
    expect(result.rebuilt).toBe(1);

    const row = await testDb.blockchainTransactions.where("txid").equals(TXID_A).first();
    expect(row!.hasOpReturn).toBe(true);
    expect(row!.opReturnData).toEqual([
      {
        vout: 1,
        dataHex: "48656c6c6f20576f726c64",
        dataText: "Hello World",
        dataAsm: opReturnAsm,
      },
    ]);

    const participants = await testDb.transactionParticipants
      .where("txid")
      .equals(TXID_A)
      .toArray();
    // Only the real input + the spendable output; the OP_RETURN output is not a participant.
    expect(participants).toHaveLength(2);
    expect(participants.some((p) => p.role === "input" && p.address === ADDR_IN)).toBe(true);
    expect(participants.some((p) => p.role === "output" && p.address === ADDR_OUT)).toBe(true);
    expect(participants.some((p) => p.scriptType === "op_return")).toBe(false);
    expect(participants.some((p) => p.role === "output" && p.vout === 1)).toBe(false);
  });

  it("excludes a coinbase input (empty/zero prev txid) from input participants", async () => {
    const ZERO_TXID = "0".repeat(64);
    const apiTx: ApiTransaction = {
      txid: TXID_A,
      status: { confirmed: true, block_height: 800000, block_time: 1700000000 },
      fee: 1000,
      size: 200,
      weight: 800,
      vin: [
        // Coinbase input: zero prev txid, no prevout → must be skipped.
        { txid: ZERO_TXID, vout: 0 },
        // A normal input alongside it must still be captured.
        {
          txid: PREV_TXID,
          vout: 0,
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
    const provider = makeProvider({ txs: new Map([[TXID_A, apiTx]]) });

    const result = await runTxidBackfill(provider, [TXID_A]);
    expect(result.rebuilt).toBe(1);

    const inputs = await testDb.transactionParticipants
      .where("txid")
      .equals(TXID_A)
      .and((p) => p.role === "input")
      .toArray();
    // Only the non-coinbase input survives.
    expect(inputs).toHaveLength(1);
    expect(inputs[0].address).toBe(ADDR_IN);
    expect(inputs[0].prevTxid).toBe(PREV_TXID);
    expect(inputs.some((p) => p.prevTxid === ZERO_TXID)).toBe(false);
  });
});

// ---- runTxidBackfill (cancellation leaves a consistent DB) -----------------
//
// Cancelling mid-flight must never leave the database half-written. Two
// invariants are at stake:
//   1. Fetch/write phase: a txid is written atomically per writeOnChainData —
//      its blockchainTransactions row and its full participant set go in
//      together. An abort at a chunk boundary may skip the *rest* of the work,
//      but anything already persisted must be complete (never a row with no
//      participants, never a partial participant set), and result.rebuilt must
//      equal the number of complete txids actually persisted.
//   2. Prevout-resolution phase: each input participant is rewritten as a whole
//      row, so an abort must leave every input either fully resolved (address +
//      amount + scriptType filled in) or completely untouched (still blank) —
//      never partially updated.

describe("runTxidBackfill (cancellation leaves a consistent DB)", () => {
  it("aborting the fetch/write phase leaves only complete txids (row + full participants)", async () => {
    // Three orphans with distinct participant shapes so a complete write is
    // distinguishable from a half-write by participant count alone.
    const expectedParticipants = new Map<string, number>([
      [TXID_A, 2], // 1 input + 1 output
      [TXID_B, 5], // 2 inputs + 3 outputs
      [TXID_C, 3], // 1 input + 2 outputs
    ]);
    const txs = new Map<string, ApiTransaction | null>([
      [TXID_A, makeApiTx(TXID_A)],
      [
        TXID_B,
        makeApiTx(TXID_B, {
          inputs: [
            { address: ADDR_IN, amount: 100000, prevTxid: PREV_1, prevVout: 0 },
            { address: ADDR_OUT, amount: 50000, prevTxid: PREV_2, prevVout: 1 },
          ],
          outputs: [
            { address: ADDR_OUT, amount: 40000, n: 0 },
            { address: ADDR_PREV1, amount: 40000, n: 1 },
            { address: ADDR_PREV2, amount: 40000, n: 2 },
          ],
        }),
      ],
      [
        TXID_C,
        makeApiTx(TXID_C, {
          outputs: [
            { address: ADDR_OUT, amount: 40000, n: 0 },
            { address: ADDR_PREV1, amount: 50000, n: 1 },
          ],
        }),
      ],
    ]);
    const controller = new AbortController();
    const provider = makeProvider({
      txs,
      onGetTransaction: () => controller.abort(), // abort once the first fetch starts
    });

    const result = await runTxidBackfill(provider, [TXID_A, TXID_B, TXID_C], {
      concurrency: 1,
      signal: controller.signal,
    });

    // Every persisted blockchain row must carry its complete participant set.
    const rows = await testDb.blockchainTransactions.toArray();
    for (const row of rows) {
      const participants = await testDb.transactionParticipants
        .where("txid")
        .equals(row.txid)
        .toArray();
      expect(participants.length).toBeGreaterThan(0); // never an orphaned row
      expect(participants.length).toBe(expectedParticipants.get(row.txid));
    }

    // No participant rows exist for txids that never got a blockchain row.
    const writtenTxids = new Set(rows.map((r) => r.txid));
    const allParticipants = await testDb.transactionParticipants.toArray();
    for (const p of allParticipants) {
      expect(writtenTxids.has(p.txid)).toBe(true);
    }

    // result.rebuilt matches exactly the number of complete txids persisted.
    expect(result.rebuilt).toBe(rows.length);
    // The abort short-circuited before the whole set was processed.
    expect(result.rebuilt).toBeLessThan(expectedParticipants.size);
  });

  it("aborting prevout resolution leaves inputs fully resolved or untouched, never partial", async () => {
    // The resolution pass commits resolved inputs in 200-row batches and checks
    // the abort signal *between* batches: each committed batch leaves the DB
    // consistent, and a re-run resumes the still-unresolved rows. To exercise
    // that boundary deterministically we rebuild one orphan with 201 blank
    // inputs — all chasing the same previous transaction — so resolution
    // produces exactly two write batches (200 + 1). The abort is fired straight
    // from the write-progress callback the instant the first batch commits, so
    // it never races on fetch timing. The result must be: batch one's 200 inputs
    // fully resolved, the lone batch-two input completely untouched, and not a
    // single partially-written row.
    const INPUT_COUNT = 201;
    const FIRST_BATCH = 200;

    const orphan = makeApiTx(TXID_A, {
      inputs: Array.from({ length: INPUT_COUNT }, (_, k) => ({
        address: "",
        amount: 0,
        prevTxid: PREV_1,
        prevVout: k,
      })),
      outputs: [{ address: ADDR_OUT, amount: 80000, n: 0 }],
    });
    // A single previous transaction exposes one resolvable output per referenced
    // vout, so the whole orphan resolves from a single fetch — keeping the abort
    // strictly in the write phase rather than the fetch phase.
    const prev = makeApiTx(PREV_1, {
      outputs: Array.from({ length: INPUT_COUNT }, (_, k) => ({
        address: ADDR_PREV1,
        amount: 1000 + k,
        n: k,
      })),
    });

    const controller = new AbortController();
    const provider = makeProvider({
      txs: new Map<string, ApiTransaction | null>([
        [TXID_A, orphan],
        [PREV_1, prev],
      ]),
    });

    const result = await runTxidBackfill(provider, [TXID_A], {
      concurrency: 1,
      signal: controller.signal,
      // Abort deterministically the moment the first write batch is committed.
      onProgress: (p) => {
        if (p.phase === "resolving" && p.resolveProcessed === FIRST_BATCH) {
          controller.abort();
        }
      },
    });

    // The orphan itself was written before resolution ran.
    expect(result.rebuilt).toBe(1);
    expect(
      await testDb.blockchainTransactions.where("txid").equals(TXID_A).count(),
    ).toBe(1);

    const inputs = await testDb.transactionParticipants
      .where("txid")
      .equals(TXID_A)
      .and((p) => p.role === "input")
      .toArray();
    expect(inputs).toHaveLength(INPUT_COUNT);

    // Classify every input as fully resolved, fully untouched, or (illegally)
    // partial — an address with no amount/scriptType, or amount/scriptType with
    // no address. A blank input keeps its parsed scriptType, so "untouched" is
    // defined by a missing address *and* zero amount.
    let resolved = 0;
    let untouched = 0;
    let partial = 0;
    for (const p of inputs) {
      const hasAddress = !!p.address;
      const hasAmount = (p.amount ?? 0) > 0;
      const hasScriptType = !!p.scriptType;
      if (hasAddress && hasAmount && hasScriptType) {
        resolved++;
      } else if (!hasAddress && !hasAmount) {
        untouched++;
      } else {
        partial++;
      }
    }

    // No row is ever left half-written.
    expect(partial).toBe(0);
    // The committed first batch is fully resolved; the uncommitted remainder is
    // left exactly as it was first written.
    expect(resolved).toBe(FIRST_BATCH);
    expect(untouched).toBe(INPUT_COUNT - FIRST_BATCH);
    // The resolution count reflects only the inputs actually committed.
    expect(result.prevoutsResolved).toBe(FIRST_BATCH);
  });

  it("stops fetching previous transactions from the network once cancelled mid-resolution", async () => {
    // One orphan with three blank-address inputs, each pointing at a distinct
    // previous transaction that has to be fetched from the provider to resolve.
    // Cancelling while the first prevout is in flight must break the resolution
    // loop before any further previous transactions are pulled from the
    // network — the exact regression this guards against: the app continuing to
    // fetch prevouts after the user already stopped the rebuild.
    const PREV_3 = "3".repeat(64);
    const ADDR_PREV3 = "bc1qprevthreeaddrxxxxxxxxxxxxxxxxxxxxxx4";

    const orphan = makeApiTx(TXID_A, {
      inputs: [
        { address: "", amount: 0, prevTxid: PREV_1, prevVout: 0 },
        { address: "", amount: 0, prevTxid: PREV_2, prevVout: 0 },
        { address: "", amount: 0, prevTxid: PREV_3, prevVout: 0 },
      ],
      outputs: [{ address: ADDR_OUT, amount: 70000, n: 0 }],
    });
    const prev1 = makeApiTx(PREV_1, {
      outputs: [{ address: ADDR_PREV1, amount: 30000, n: 0 }],
    });
    const prev2 = makeApiTx(PREV_2, {
      outputs: [{ address: ADDR_PREV2, amount: 40000, n: 0 }],
    });
    const prev3 = makeApiTx(PREV_3, {
      outputs: [{ address: ADDR_PREV3, amount: 50000, n: 0 }],
    });

    const controller = new AbortController();
    const seen: string[] = [];

    // Deferred gates make the cancel land at an exact, controlled point instead
    // of racing the resolution loop: `prev1Requested` resolves the moment the
    // loop calls getTransaction(PREV_1); `prev1Release` is what lets that call
    // return. Holding the first fetch open lets the test abort *before* PREV_1
    // resolves, so the loop is guaranteed to observe the cancel before it could
    // advance to PREV_2/PREV_3.
    let signalPrev1Requested!: () => void;
    const prev1Requested = new Promise<void>((r) => {
      signalPrev1Requested = r;
    });
    let releasePrev1!: () => void;
    const prev1Release = new Promise<void>((r) => {
      releasePrev1 = r;
    });

    const txs = new Map<string, ApiTransaction | null>([
      [TXID_A, orphan],
      [PREV_1, prev1],
      [PREV_2, prev2],
      [PREV_3, prev3],
    ]);
    const provider: BlockchainProvider = {
      name: "fake",
      async getBlockHeight() {
        return 800010;
      },
      async getAddressTransactions() {
        return [];
      },
      async getTransaction(txid: string) {
        seen.push(txid);
        if (txid === PREV_1) {
          signalPrev1Requested();
          await prev1Release;
        }
        return txs.has(txid) ? txs.get(txid)! : null;
      },
      async testConnection() {
        return { success: true };
      },
    };

    const runPromise = runTxidBackfill(provider, [TXID_A], {
      concurrency: 1,
      signal: controller.signal,
    });

    // Once the loop is parked inside the first prevout fetch, cancel — then let
    // that fetch return. The loop must stop before requesting any further prevout.
    await prev1Requested;
    controller.abort();
    releasePrev1();

    const result = await runPromise;

    // The orphan itself was written before resolution began.
    expect(result.rebuilt).toBe(1);

    // The resolution pass stopped early: only the orphan and the first prevout
    // were ever requested. No further previous transactions were pulled from
    // the network after the cancel.
    expect(seen).toContain(TXID_A);
    expect(seen).toContain(PREV_1);
    expect(seen).not.toContain(PREV_2);
    expect(seen).not.toContain(PREV_3);

    // The interrupted write batch is discarded on cancel (each committed batch
    // is consistent; a re-run resumes the rest), so nothing was resolved...
    expect(result.prevoutsResolved).toBe(0);

    // ...and every input is left exactly as first written — never partial.
    const inputs = await testDb.transactionParticipants
      .where("txid")
      .equals(TXID_A)
      .and((p) => p.role === "input")
      .toArray();
    expect(inputs).toHaveLength(3);
    for (const p of inputs) {
      expect(p.address ?? "").toBe("");
      expect(p.amount ?? 0).toBe(0);
    }
  });
});

// ---- resolveBackfillPrevouts (input address resolution) --------------------
//
// runTxidBackfill runs a second pass (resolveBackfillPrevouts) after rebuilding
// that fills in blank input addresses by chasing each input's prevout reference
// — first from participant rows already in the DB, then by fetching the previous
// transaction from the provider. These tests drive that pass through the public
// runTxidBackfill entry point using orphans whose inputs lack prevout addresses.

describe("resolveBackfillPrevouts (input address resolution)", () => {
  it("fills a blank input address from a local participant cache without fetching the prevout", async () => {
    // The referenced previous output is already in the DB as a participant row.
    await testDb.transactionParticipants.add({
      txid: PREV_TXID,
      role: "output",
      vout: 0,
      address: PREV_ADDR,
      amount: 50000,
      scriptType: "v0_p2wpkh",
    } as unknown as TransactionParticipant);

    const seen: string[] = [];
    const provider = makeProvider({
      txs: new Map([[TXID_A, makeApiTxBlankInput(TXID_A)]]),
      onGetTransaction: (txid) => seen.push(txid),
    });

    const result = await runTxidBackfill(provider, [TXID_A]);

    expect(result.rebuilt).toBe(1);
    expect(result.prevoutsResolved).toBe(1);

    const input = await testDb.transactionParticipants
      .where("txid")
      .equals(TXID_A)
      .and((p) => p.role === "input")
      .first();
    expect(input?.address).toBe(PREV_ADDR);
    expect(input?.amount).toBe(50000);
    expect(input?.scriptType).toBe("v0_p2wpkh");

    // The prevout was already local, so the provider was only hit for the
    // orphan itself — never for the previous transaction.
    expect(seen).toContain(TXID_A);
    expect(seen).not.toContain(PREV_TXID);
  });

  it("fetches the previous transaction from the provider when the prevout is not local", async () => {
    const seen: string[] = [];
    const prevTx = makeApiTx(PREV_TXID, {
      outputs: [{ address: PREV_ADDR, amount: 50000, n: 0 }],
    });
    const provider = makeProvider({
      txs: new Map([
        [TXID_A, makeApiTxBlankInput(TXID_A)],
        [PREV_TXID, prevTx],
      ]),
      onGetTransaction: (txid) => seen.push(txid),
    });

    const result = await runTxidBackfill(provider, [TXID_A]);

    expect(result.rebuilt).toBe(1);
    expect(result.prevoutsResolved).toBe(1);
    // The prevout was missing locally, so it had to be fetched.
    expect(seen).toContain(PREV_TXID);

    const input = await testDb.transactionParticipants
      .where("txid")
      .equals(TXID_A)
      .and((p) => p.role === "input")
      .first();
    expect(input?.address).toBe(PREV_ADDR);
    expect(input?.amount).toBe(50000);
    expect(input?.scriptType).toBe("v0_p2wpkh");
  });

  it("links a resolved input address to an existing record by recordId", async () => {
    const recId = await testDb.records.add(makeAddressRecord(PREV_ADDR));
    const prevTx = makeApiTx(PREV_TXID, {
      outputs: [{ address: PREV_ADDR, amount: 50000, n: 0 }],
    });
    const provider = makeProvider({
      txs: new Map([
        [TXID_A, makeApiTxBlankInput(TXID_A)],
        [PREV_TXID, prevTx],
      ]),
    });

    const result = await runTxidBackfill(provider, [TXID_A]);
    expect(result.prevoutsResolved).toBe(1);

    const input = await testDb.transactionParticipants
      .where("txid")
      .equals(TXID_A)
      .and((p) => p.role === "input")
      .first();
    expect(input?.address).toBe(PREV_ADDR);
    expect(input?.recordId).toBe(recId);
  });
});

// ---- runTxidBackfill (prevout resolution error isolation) ------------------
//
// runTxidBackfill wraps the entire prevout-resolution pass in a try/catch so a
// failure while chasing previous transactions records an error message but
// never fails the overall rebuild — the transactions already rebuilt stay
// intact and the run still completes. A provider error that propagates out of
// the resolution pass (e.g. getTransaction throwing rather than rejecting an
// awaited promise inside the settled fetch loop) is the regression this guards.

describe("runTxidBackfill (prevout resolution error isolation)", () => {
  it("a provider error thrown while fetching a previous transaction never fails the rebuild", async () => {
    // The orphan has a blank-address input whose prevout must be fetched to be
    // resolved. The provider serves the orphan fine but throws when asked for
    // the previous transaction, simulating a network hiccup mid-resolution.
    const provider: BlockchainProvider = {
      name: "fake",
      async getBlockHeight() {
        return 800010;
      },
      async getAddressTransactions() {
        return [];
      },
      getTransaction(txid: string) {
        if (txid === PREV_TXID) {
          // Throw (not reject) so the failure escapes the resolution pass and
          // lands in runTxidBackfill's try/catch, exercising the isolation path.
          throw new Error("network hiccup");
        }
        return Promise.resolve(makeApiTxBlankInput(TXID_A, PREV_TXID, 0));
      },
      async testConnection() {
        return { success: true };
      },
    };

    const phases: string[] = [];
    const result = await runTxidBackfill(provider, [TXID_A], {
      onProgress: (p) => phases.push(p.phase),
    });

    // The rebuild that happened before resolution stands — count is unaffected.
    expect(result.rebuilt).toBe(1);
    expect(result.failed).toBe(0);
    expect(
      await testDb.blockchainTransactions.where("txid").equals(TXID_A).count(),
    ).toBe(1);

    // The run still completed cleanly despite the resolution failure.
    expect(phases[phases.length - 1]).toBe("complete");

    // Resolution blew up before filling anything in, but the error was caught
    // and recorded rather than thrown out of runTxidBackfill.
    expect(result.prevoutsResolved).toBe(0);
    expect(result.errors.some((e) => e.includes("prevout resolution"))).toBe(true);
    expect(result.errors.some((e) => e.includes("network hiccup"))).toBe(true);

    // The blank input is exactly as first written — no partial update.
    const input = await testDb.transactionParticipants
      .where("txid")
      .equals(TXID_A)
      .and((p) => p.role === "input")
      .first();
    expect(input?.address ?? "").toBe("");
  });
});

// ---- runTxidBackfill (per-fetch prevout resilience) ------------------------
//
// resolveBackfillPrevouts fetches the previous transactions in parallel batches
// with Promise.allSettled, which swallows individual fetch rejections so the
// remaining prevouts still get resolved. This per-fetch resilience is distinct
// from the whole-pass try/catch above: here the resolution pass itself does NOT
// throw — one provider fetch rejects while the others succeed, and the inputs
// backed by the successful fetches must still be filled in. A regression that
// let one failed provider fetch silently drop the other inputs is what this
// guards against.

describe("runTxidBackfill (per-fetch prevout resilience)", () => {
  it("one rejected prevout fetch does not block resolving the others", async () => {
    // A single orphan with two blank-address inputs pointing at two different
    // previous transactions. The provider serves the orphan and PREV_2 but
    // rejects the fetch for PREV_1.
    const orphan = makeApiTx(TXID_A, {
      inputs: [
        { address: "", amount: 0, prevTxid: PREV_1, prevVout: 0 },
        { address: "", amount: 0, prevTxid: PREV_2, prevVout: 0 },
      ],
      outputs: [{ address: ADDR_OUT, amount: 80000, n: 0 }],
    });
    const prev2 = makeApiTx(PREV_2, {
      outputs: [{ address: ADDR_PREV2, amount: 70000, n: 0 }],
    });

    const phases: string[] = [];
    const provider = makeProvider({
      txs: new Map<string, ApiTransaction | null>([
        [TXID_A, orphan],
        // PREV_1 has no entry and is in errorTxids → its fetch rejects.
        [PREV_2, prev2],
      ]),
      errorTxids: new Set([PREV_1]),
    });

    const result = await runTxidBackfill(provider, [TXID_A], {
      onProgress: (p) => phases.push(p.phase),
    });

    // The orphan was rebuilt and the run completed without aborting.
    expect(result.rebuilt).toBe(1);
    expect(result.failed).toBe(0);
    expect(phases[phases.length - 1]).toBe("complete");

    const inputs = await testDb.transactionParticipants
      .where("txid")
      .equals(TXID_A)
      .and((p) => p.role === "input")
      .toArray();
    expect(inputs).toHaveLength(2);
    const byPrev = new Map(inputs.map((p) => [p.prevTxid, p]));

    // PREV_2's fetch succeeded → its input is fully resolved.
    const resolved = byPrev.get(PREV_2)!;
    expect(resolved.address).toBe(ADDR_PREV2);
    expect(resolved.amount).toBe(70000);
    expect(resolved.scriptType).toBeDefined();

    // PREV_1's fetch rejected → its input is exactly as first written, not
    // dropped or partially updated.
    const failed = byPrev.get(PREV_1)!;
    expect(failed.address ?? "").toBe("");
    expect(failed.amount).toBe(0);

    // Only the successfully fetched prevout is counted as resolved.
    expect(result.prevoutsResolved).toBe(1);
  });

  it("with many inputs, a single failed prevout fetch only drops its own input", async () => {
    // Three blank-address inputs across three previous transactions; the
    // middle one's fetch rejects. The other two must still resolve.
    const PREV_3 = "3".repeat(64);
    const ADDR_PREV3 = "bc1qprevthreeaddrxxxxxxxxxxxxxxxxxxxxxx4";

    const orphan = makeApiTx(TXID_A, {
      inputs: [
        { address: "", amount: 0, prevTxid: PREV_1, prevVout: 0 },
        { address: "", amount: 0, prevTxid: PREV_2, prevVout: 0 },
        { address: "", amount: 0, prevTxid: PREV_3, prevVout: 0 },
      ],
      outputs: [{ address: ADDR_OUT, amount: 60000, n: 0 }],
    });
    const prev1 = makeApiTx(PREV_1, {
      outputs: [{ address: ADDR_PREV1, amount: 30000, n: 0 }],
    });
    const prev3 = makeApiTx(PREV_3, {
      outputs: [{ address: ADDR_PREV3, amount: 50000, n: 0 }],
    });

    const provider = makeProvider({
      txs: new Map<string, ApiTransaction | null>([
        [TXID_A, orphan],
        [PREV_1, prev1],
        // PREV_2 rejects.
        [PREV_3, prev3],
      ]),
      errorTxids: new Set([PREV_2]),
    });

    const result = await runTxidBackfill(provider, [TXID_A]);

    expect(result.rebuilt).toBe(1);
    expect(result.failed).toBe(0);

    const inputs = await testDb.transactionParticipants
      .where("txid")
      .equals(TXID_A)
      .and((p) => p.role === "input")
      .toArray();
    expect(inputs).toHaveLength(3);
    const byPrev = new Map(inputs.map((p) => [p.prevTxid, p]));

    // The two successful fetches resolved their inputs.
    expect(byPrev.get(PREV_1)!.address).toBe(ADDR_PREV1);
    expect(byPrev.get(PREV_3)!.address).toBe(ADDR_PREV3);

    // The rejected fetch left only its own input blank.
    expect(byPrev.get(PREV_2)!.address ?? "").toBe("");

    // prevoutsResolved counts only the two that succeeded.
    expect(result.prevoutsResolved).toBe(2);
  });
});

// ---- runTxidBackfill (source balance recompute after repair) ---------------
//
// Resolving a blank input attributes a spend to its source address. Without a
// follow-up stats recompute the source address's cached balance stays
// overstated — it still counts the output it received but not the spend just
// linked — until a manual recompute. resolveBackfillPrevouts now recomputes the
// affected source addresses (local-only, no network) in the same run, mirroring
// transaction-sync.ts's resolvePrevouts. These tests pin that behaviour.

describe("runTxidBackfill (source balance recompute after repair)", () => {
  it("drops the source address cached balance after a repaired blank input attributes its spend", async () => {
    // The source address received 50000 in PREV_TXID; its cached balance
    // currently reflects only that receipt (the spend is not yet attributed).
    const srcRecId = await testDb.records.add(makeAddressRecord(PREV_ADDR));
    await testDb.records.update(srcRecId, {
      cachedBalanceSats: 50000,
      cachedTxCount: 1,
      cachedUtxoCount: 1,
      statsComputedAt: Date.now(),
    });

    // PREV_TXID's output (PREV_ADDR receives 50000 at vout 0) is already held
    // locally, so resolution finds the prevout without fetching.
    await testDb.blockchainTransactions.add(
      makeExistingTxRow(PREV_TXID) as BlockchainTransaction,
    );
    await testDb.transactionParticipants.add({
      txid: PREV_TXID,
      role: "output",
      address: PREV_ADDR,
      amount: 50000,
      vout: 0,
      recordId: srcRecId,
      scriptType: "v0_p2wpkh",
    } as unknown as TransactionParticipant);

    // The orphan TXID_A spends PREV_TXID:0 but is written with a blank input.
    const provider = makeProvider({
      txs: new Map([[TXID_A, makeApiTxBlankInput(TXID_A, PREV_TXID, 0)]]),
    });

    const result = await runTxidBackfill(provider, [TXID_A]);
    expect(result.rebuilt).toBe(1);
    expect(result.prevoutsResolved).toBe(1);

    // The blank input is now attributed to the source address.
    const input = await testDb.transactionParticipants
      .where("txid")
      .equals(TXID_A)
      .and((p) => p.role === "input")
      .first();
    expect(input?.address).toBe(PREV_ADDR);

    // The recompute ran in the same backfill: 50000 received - 50000 spent = 0.
    const srcRec = await testDb.records.get(srcRecId);
    expect(srcRec?.cachedBalanceSats).toBe(0);
    expect(srcRec?.cachedUtxoCount).toBe(0);
  });

  it("does not recompute when no blank input gets attributed", async () => {
    // A source address with a cached balance but no spend to attribute. The
    // orphan's input already carries its address, so nothing is resolved and the
    // cached balance must be left untouched.
    const srcRecId = await testDb.records.add(makeAddressRecord(ADDR_IN));
    await testDb.records.update(srcRecId, {
      cachedBalanceSats: 123456,
      statsComputedAt: Date.now(),
    });

    // makeApiTx provides a fully-populated input (ADDR_IN) → no blank to resolve.
    const provider = makeProvider({ txs: new Map([[TXID_A, makeApiTx(TXID_A)]]) });

    const result = await runTxidBackfill(provider, [TXID_A]);
    expect(result.rebuilt).toBe(1);
    expect(result.prevoutsResolved).toBe(0);

    // Untouched: the recompute never ran for this address.
    const srcRec = await testDb.records.get(srcRecId);
    expect(srcRec?.cachedBalanceSats).toBe(123456);
  });
});

// ---- resolveAllBlankInputAddresses (whole-database resolution) -------------
//
// resolveAllBlankInputAddresses is the Settings "Resolve Input Addresses"
// entry point. Unlike resolveBackfillPrevouts (scoped to a freshly-rebuilt set
// of txids), it scans EVERY input participant in the database for rows that
// still have a blank address but carry a chaseable prevout reference, then
// resolves them through the shared core — first from local participant output
// rows, then by fetching the previous transaction from the provider. It builds
// its provider from stored node settings and defers (rather than throwing) when
// no node is configured or connectivity fails.
//
// These tests seed transactionParticipants directly (no blockchain rows or
// txid records needed) so the whole-database scan path is exercised in
// isolation from the orphan-rebuild pass.

/**
 * Adds a blank-address input participant carrying a prevout reference — exactly
 * the kind of row resolveAllBlankInputAddresses hunts for. Returns its id.
 */
function addBlankInput(
  txid: string,
  prevTxid: string,
  prevVout = 0,
): Promise<number> {
  return testDb.transactionParticipants.add({
    txid,
    role: "input",
    address: "",
    amount: 0,
    prevTxid,
    prevVout,
  } as unknown as TransactionParticipant);
}

/** Adds a local output participant row that the resolver can read from cache. */
function addOutputRow(
  txid: string,
  vout: number,
  address: string,
  amount: number,
  scriptType = "v0_p2wpkh",
): Promise<number> {
  return testDb.transactionParticipants.add({
    txid,
    role: "output",
    vout,
    address,
    amount,
    scriptType,
  } as unknown as TransactionParticipant);
}

describe("resolveAllBlankInputAddresses", () => {
  it("resolves a blank input from a local participant output row without fetching", async () => {
    const inputId = await addBlankInput(TXID_A, PREV_TXID, 0);
    // The referenced previous output is already in the DB as a participant row.
    await addOutputRow(PREV_TXID, 0, PREV_ADDR, 50000, "v0_p2wpkh");

    await testDb.nodeSettings.add({ id: "default" } as unknown as NodeSettings);
    const seen: string[] = [];
    nextProvider = makeProvider({ onGetTransaction: (t) => seen.push(t) });

    const result = await resolveAllBlankInputAddresses();

    expect(result.deferred).toBe(false);
    expect(result.unresolvedFound).toBe(1);
    expect(result.resolved).toBe(1);

    const input = await testDb.transactionParticipants.get(inputId);
    expect(input?.address).toBe(PREV_ADDR);
    expect(input?.amount).toBe(50000);
    expect(input?.scriptType).toBe("v0_p2wpkh");

    // The prevout was already local, so the provider was never asked for it.
    expect(seen).not.toContain(PREV_TXID);
  });

  it("resolves a blank input by fetching the previous transaction from the provider", async () => {
    const inputId = await addBlankInput(TXID_A, PREV_TXID, 0);
    // No local output row → the previous transaction must be fetched.
    await testDb.nodeSettings.add({ id: "default" } as unknown as NodeSettings);

    const seen: string[] = [];
    const prevTx = makeApiTx(PREV_TXID, {
      outputs: [{ address: PREV_ADDR, amount: 50000, n: 0 }],
    });
    nextProvider = makeProvider({
      txs: new Map([[PREV_TXID, prevTx]]),
      onGetTransaction: (t) => seen.push(t),
    });

    const result = await resolveAllBlankInputAddresses();

    expect(result.deferred).toBe(false);
    expect(result.unresolvedFound).toBe(1);
    expect(result.resolved).toBe(1);
    // The prevout was missing locally, so it had to be fetched.
    expect(seen).toContain(PREV_TXID);

    const input = await testDb.transactionParticipants.get(inputId);
    expect(input?.address).toBe(PREV_ADDR);
    expect(input?.amount).toBe(50000);
    expect(input?.scriptType).toBe("v0_p2wpkh");
  });

  it("links a resolved input address to an existing record by recordId", async () => {
    const recId = await testDb.records.add(makeAddressRecord(PREV_ADDR));
    const inputId = await addBlankInput(TXID_A, PREV_TXID, 0);
    await testDb.nodeSettings.add({ id: "default" } as unknown as NodeSettings);

    const prevTx = makeApiTx(PREV_TXID, {
      outputs: [{ address: PREV_ADDR, amount: 50000, n: 0 }],
    });
    nextProvider = makeProvider({ txs: new Map([[PREV_TXID, prevTx]]) });

    const result = await resolveAllBlankInputAddresses();
    expect(result.resolved).toBe(1);

    const input = await testDb.transactionParticipants.get(inputId);
    expect(input?.address).toBe(PREV_ADDR);
    expect(input?.recordId).toBe(recId);
  });

  it("leaves an already-resolved input untouched and never refetches its prevout", async () => {
    // An input that already carries an address must be ignored by the scan.
    const resolvedId = await testDb.transactionParticipants.add({
      txid: TXID_A,
      role: "input",
      address: ADDR_IN,
      amount: 12345,
      scriptType: "v0_p2wpkh",
      prevTxid: PREV_1,
      prevVout: 0,
    } as unknown as TransactionParticipant);
    // A genuinely blank input alongside it should still be resolved.
    const blankId = await addBlankInput(TXID_B, PREV_2, 0);
    await addOutputRow(PREV_2, 0, PREV_ADDR, 70000, "v0_p2wpkh");

    await testDb.nodeSettings.add({ id: "default" } as unknown as NodeSettings);
    const seen: string[] = [];
    nextProvider = makeProvider({ onGetTransaction: (t) => seen.push(t) });

    const result = await resolveAllBlankInputAddresses();

    // Only the blank input is counted and resolved.
    expect(result.unresolvedFound).toBe(1);
    expect(result.resolved).toBe(1);

    // The already-resolved input is byte-for-byte unchanged.
    const untouched = await testDb.transactionParticipants.get(resolvedId);
    expect(untouched?.address).toBe(ADDR_IN);
    expect(untouched?.amount).toBe(12345);

    // Its prevout was never chased.
    expect(seen).not.toContain(PREV_1);

    const blank = await testDb.transactionParticipants.get(blankId);
    expect(blank?.address).toBe(PREV_ADDR);
    expect(blank?.amount).toBe(70000);
  });

  it("resolves a mix of local-cache and provider-fetched inputs across the whole database", async () => {
    // One input resolvable from a local output row, one needing a fetch.
    const localId = await addBlankInput(TXID_A, PREV_1, 0);
    await addOutputRow(PREV_1, 0, ADDR_PREV1, 30000, "v0_p2wpkh");
    const fetchId = await addBlankInput(TXID_B, PREV_2, 0);

    await testDb.nodeSettings.add({ id: "default" } as unknown as NodeSettings);
    const seen: string[] = [];
    const prev2 = makeApiTx(PREV_2, {
      outputs: [{ address: ADDR_PREV2, amount: 40000, n: 0 }],
    });
    nextProvider = makeProvider({
      txs: new Map([[PREV_2, prev2]]),
      onGetTransaction: (t) => seen.push(t),
    });

    const result = await resolveAllBlankInputAddresses();

    expect(result.unresolvedFound).toBe(2);
    expect(result.resolved).toBe(2);

    // Only the non-local prevout was fetched.
    expect(seen).toContain(PREV_2);
    expect(seen).not.toContain(PREV_1);

    expect((await testDb.transactionParticipants.get(localId))?.address).toBe(ADDR_PREV1);
    expect((await testDb.transactionParticipants.get(fetchId))?.address).toBe(ADDR_PREV2);
  });

  it("returns deferred=true when no node settings are configured", async () => {
    // There is blank work to do, but with no provider configured it must defer.
    await addBlankInput(TXID_A, PREV_TXID, 0);

    const result = await resolveAllBlankInputAddresses();

    expect(result.deferred).toBe(true);
    expect(result.resolved).toBe(0);
    expect(result.deferReason).toMatch(/node settings/i);

    // The blank input is left exactly as it was — nothing was resolved.
    const input = await testDb.transactionParticipants
      .where("txid")
      .equals(TXID_A)
      .first();
    expect(input?.address ?? "").toBe("");
  });

  it("returns deferred=true when the provider cannot connect", async () => {
    await addBlankInput(TXID_A, PREV_TXID, 0);
    await testDb.nodeSettings.add({ id: "default" } as unknown as NodeSettings);
    nextProvider = makeProvider({ blockHeightThrows: true });

    const result = await resolveAllBlankInputAddresses();

    expect(result.deferred).toBe(true);
    expect(result.resolved).toBe(0);
    expect(result.deferReason).toMatch(/could not connect/i);
  });

  it("returns a non-deferred empty result when there are no blank inputs", async () => {
    // A fully-resolved input only — nothing for the scan to do.
    await testDb.transactionParticipants.add({
      txid: TXID_A,
      role: "input",
      address: ADDR_IN,
      amount: 100000,
      prevTxid: PREV_TXID,
      prevVout: 0,
    } as unknown as TransactionParticipant);
    await testDb.nodeSettings.add({ id: "default" } as unknown as NodeSettings);
    nextProvider = makeProvider();

    const result = await resolveAllBlankInputAddresses();

    expect(result.deferred).toBe(false);
    expect(result.unresolvedFound).toBe(0);
    expect(result.resolved).toBe(0);
  });

  it("recomputes and drops the source balance when the pass runs to completion", async () => {
    // The source address received two outputs (70000 sats total); its cached
    // balance currently counts both because the spend of the first is not yet
    // attributed (its spending input is still blank).
    const recId = await testDb.records.add(makeAddressRecord(PREV_ADDR));
    await testDb.records.update(recId, {
      cachedBalanceSats: 70000,
      cachedTxCount: 2,
      cachedUtxoCount: 2,
      statsComputedAt: Date.now(),
    });

    // Two local output rows the source received: PREV_1:0 (50000) will be spent,
    // PREV_2:0 (20000) stays unspent.
    await addOutputRow(PREV_1, 0, PREV_ADDR, 50000, "v0_p2wpkh");
    await addOutputRow(PREV_2, 0, PREV_ADDR, 20000, "v0_p2wpkh");

    // A blank input spending PREV_1:0 — resolvable from the local output row, so
    // no fetch is needed and the whole pass completes (never cancelled).
    const inputId = await addBlankInput(TXID_A, PREV_1, 0);

    await testDb.nodeSettings.add({ id: "default" } as unknown as NodeSettings);
    nextProvider = makeProvider();

    const result = await resolveAllBlankInputAddresses();

    // The pass ran to completion: nothing deferred, nothing cancelled.
    expect(result.deferred).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(result.unresolvedFound).toBe(1);
    expect(result.resolved).toBe(1);

    // The completion path recomputed the source address's cached stats.
    expect(result.recomputed).toBeGreaterThan(0);

    // The blank input is now attributed to the source address.
    const input = await testDb.transactionParticipants.get(inputId);
    expect(input?.address).toBe(PREV_ADDR);
    expect(input?.amount).toBe(50000);
    expect(input?.recordId).toBe(recId);

    // The recompute dropped the cached balance by exactly the newly-attributed
    // spend: 70000 received - 50000 spent = 20000.
    const rec = await testDb.records.get(recId);
    expect(rec?.cachedBalanceSats).toBe(20000);
  });

  it("recomputes balances for inputs committed before a cancelled pass", async () => {
    // More than one write-batch worth of blank inputs, all resolvable from local
    // participant output rows (no network fetch needed) and all attributing to
    // the same source address. We abort once the first 200-row batch has been
    // committed, so the write loop stops with 200 inputs persisted and 50 left
    // blank — the exact "cancelled after committing some work" case.
    const hex = (n: number) => n.toString(16).padStart(64, "0");

    const recId = await testDb.records.add(makeAddressRecord(PREV_ADDR));
    // Mark the source address as synced so the recompute writes a balance.
    await testDb.addressSyncState.add({ address: PREV_ADDR } as unknown as {
      address: string;
    });

    const TOTAL = 250;
    for (let i = 0; i < TOTAL; i++) {
      const prevTxid = hex(i + 1);
      await addBlankInput(hex(1000 + i), prevTxid, 0);
      await addOutputRow(prevTxid, 0, PREV_ADDR, 1000 + i, "v0_p2wpkh");
    }

    await testDb.nodeSettings.add({ id: "default" } as unknown as NodeSettings);
    nextProvider = makeProvider();

    const controller = new AbortController();
    let updates = 0;
    const onUpdate = () => {
      updates += 1;
      // Abort the moment the first full batch (200 rows) has been written so the
      // loop stops before committing the remaining rows.
      if (updates === 200) controller.abort();
      return undefined;
    };
    testDb.transactionParticipants.hook("updating", onUpdate);

    let result;
    try {
      result = await resolveAllBlankInputAddresses({ signal: controller.signal });
    } finally {
      testDb.transactionParticipants.hook("updating").unsubscribe(onUpdate);
    }

    // The pass reports cancellation and the partial work it actually committed.
    expect(result.cancelled).toBe(true);
    expect(result.resolved).toBe(200);

    // The committed source address had its cached stats recomputed despite the
    // cancel — this is the regression under test (recompute used to be skipped
    // entirely once the signal was aborted).
    expect(result.recomputed).toBe(1);
    const rec = await testDb.records.get(recId);
    expect(rec?.statsComputedAt).toBeTruthy();

    // Exactly the first batch of inputs was filled in; the rest stayed blank.
    const inputs = await testDb.transactionParticipants
      .where("role")
      .equals("input")
      .toArray();
    const resolvedCount = inputs.filter((p) => p.address === PREV_ADDR).length;
    expect(resolvedCount).toBe(200);
  });

  it("emits 'recomputing' progress for committed inputs after a cancel", async () => {
    // Same partial-cancel setup as above, but here we assert the progress
    // stream: after the abort, the post-cancel balance recompute must still
    // report 'recomputing' progress so the UI can show "Updating balances...".
    const hex = (n: number) => n.toString(16).padStart(64, "0");

    await testDb.records.add(makeAddressRecord(PREV_ADDR));
    await testDb.addressSyncState.add({ address: PREV_ADDR } as unknown as {
      address: string;
    });

    const TOTAL = 250;
    for (let i = 0; i < TOTAL; i++) {
      const prevTxid = hex(i + 1);
      await addBlankInput(hex(1000 + i), prevTxid, 0);
      await addOutputRow(prevTxid, 0, PREV_ADDR, 1000 + i, "v0_p2wpkh");
    }

    await testDb.nodeSettings.add({ id: "default" } as unknown as NodeSettings);
    nextProvider = makeProvider();

    const controller = new AbortController();
    let updates = 0;
    const onUpdate = () => {
      updates += 1;
      if (updates === 200) controller.abort();
      return undefined;
    };
    testDb.transactionParticipants.hook("updating", onUpdate);

    const phases: string[] = [];
    const recomputingEvents: Array<{ processed?: number; total?: number }> = [];
    let result;
    try {
      result = await resolveAllBlankInputAddresses({
        signal: controller.signal,
        onProgress: (p) => {
          phases.push(p.phase);
          if (p.phase === "recomputing") {
            recomputingEvents.push({
              processed: p.recomputeProcessed,
              total: p.recomputeTotal,
            });
          }
        },
      });
    } finally {
      testDb.transactionParticipants.hook("updating").unsubscribe(onUpdate);
    }

    // The pass reports cancellation and committed some inputs before stopping.
    // (The exact committed count depends on write-batch boundaries, so we only
    // require that real work landed — what matters here is the progress stream.)
    expect(result.cancelled).toBe(true);
    expect(result.resolved).toBeGreaterThan(0);

    // The post-cancel recompute reported progress: at least one 'recomputing'
    // event fired, carrying a known total so the UI can render "X of Y".
    expect(phases).toContain("recomputing");
    expect(recomputingEvents.length).toBeGreaterThan(0);
    expect(recomputingEvents.every((e) => (e.total ?? 0) > 0)).toBe(true);

    // The terminal 'complete' phase still fires after the recompute so the
    // cancel toast path is reached.
    expect(phases[phases.length - 1]).toBe("complete");
  });

  it("commits the already-fetched input and stops fetching when cancelled mid-fetch", async () => {
    // The whole-database pass shares the same resolution core as the scoped
    // orphan-rebuild path, whose contract is: a cancel halts further network
    // fetching, but every prevout already fetched is committed, not discarded.
    // Here two blank inputs each chase a DISTINCT previous transaction that has
    // to be fetched (no local output rows), so resolution must hit the network
    // once per input. With concurrency 1 the fetch loop pulls one prevout per
    // chunk and re-checks the abort signal between chunks. Aborting straight
    // from the provider's getTransaction the instant the FIRST prevout is
    // fetched means: the first input's prevout lands in the cache and is
    // committed, the loop breaks before the second prevout is ever requested,
    // and the second input is left exactly as it was first written (blank). A
    // regression that discarded fetched-but-uncommitted prevouts on cancel
    // would leave the first input blank and under-report the resolved count.
    const inputAId = await addBlankInput(TXID_A, PREV_1, 0);
    const inputBId = await addBlankInput(TXID_B, PREV_2, 0);

    await testDb.nodeSettings.add({ id: "default" } as unknown as NodeSettings);

    const controller = new AbortController();
    const seen: string[] = [];
    const prev1 = makeApiTx(PREV_1, {
      outputs: [{ address: ADDR_PREV1, amount: 30000, n: 0 }],
    });
    const prev2 = makeApiTx(PREV_2, {
      outputs: [{ address: ADDR_PREV2, amount: 40000, n: 0 }],
    });
    nextProvider = makeProvider({
      txs: new Map([
        [PREV_1, prev1],
        [PREV_2, prev2],
      ]),
      // Record every fetch and abort the moment the first prevout is pulled.
      onGetTransaction: (t) => {
        seen.push(t);
        controller.abort();
      },
    });

    // concurrency 1 → one prevout fetched per chunk, abort observed before the
    // next chunk so the second prevout is never requested.
    const result = await resolveAllBlankInputAddresses({
      signal: controller.signal,
      concurrency: 1,
    });

    // The pass reports cancellation, but the partial work it actually committed
    // is reflected in the count rather than thrown away.
    expect(result.cancelled).toBe(true);
    expect(result.deferred).toBe(false);
    // Both blank inputs were discovered during the scan…
    expect(result.unresolvedFound).toBe(2);
    // …but only the one whose prevout was fetched before the abort is resolved.
    expect(result.resolved).toBe(1);

    // The first input — whose prevout was fetched before the abort — is fully
    // written: address and amount filled in from PREV_1's output.
    const inputA = await testDb.transactionParticipants.get(inputAId);
    expect(inputA?.address).toBe(ADDR_PREV1);
    expect(inputA?.amount).toBe(30000);

    // The second input — whose prevout was never fetched — is left exactly as it
    // was first written: still blank, never partially filled in.
    const inputB = await testDb.transactionParticipants.get(inputBId);
    expect(inputB?.address ?? "").toBe("");
    expect(inputB?.amount ?? 0).toBe(0);

    // The cancel stopped further network fetching: PREV_1 was pulled, PREV_2
    // never was.
    expect(seen).toContain(PREV_1);
    expect(seen).not.toContain(PREV_2);
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

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
const PREV_1 = "1".repeat(64);
const PREV_2 = "2".repeat(64);

const ADDR_IN = "bc1qinputaddrxxxxxxxxxxxxxxxxxxxxxxxxxxx0";
const ADDR_OUT = "bc1qoutputaddrxxxxxxxxxxxxxxxxxxxxxxxxxxx1";
const ADDR_PREV1 = "bc1qprevoneaddrxxxxxxxxxxxxxxxxxxxxxxxxxx2";
const ADDR_PREV2 = "bc1qprevtwoaddrxxxxxxxxxxxxxxxxxxxxxxxxxx3";

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
    // One orphan with two blank-address inputs, each pointing at a different
    // previous transaction we must fetch to resolve. Aborting after the first
    // prevout fetch must resolve that input in full and leave the other exactly
    // as it was written — no partially-filled rows.
    const orphan = makeApiTx(TXID_A, {
      inputs: [
        { address: "", amount: 0, prevTxid: PREV_1, prevVout: 0 },
        { address: "", amount: 0, prevTxid: PREV_2, prevVout: 0 },
      ],
      outputs: [{ address: ADDR_OUT, amount: 80000, n: 0 }],
    });
    const prev1 = makeApiTx(PREV_1, {
      outputs: [{ address: ADDR_PREV1, amount: 60000, n: 0 }],
    });
    const prev2 = makeApiTx(PREV_2, {
      outputs: [{ address: ADDR_PREV2, amount: 70000, n: 0 }],
    });

    const controller = new AbortController();
    const provider = makeProvider({
      txs: new Map<string, ApiTransaction | null>([
        [TXID_A, orphan],
        [PREV_1, prev1],
        [PREV_2, prev2],
      ]),
      onGetTransaction: (txid) => {
        // Let the write phase and the first prevout fetch (PREV_1) through, then
        // abort so the resolution loop breaks before fetching PREV_2.
        if (txid === PREV_1) controller.abort();
      },
    });

    const result = await runTxidBackfill(provider, [TXID_A], {
      concurrency: 1,
      signal: controller.signal,
    });

    // The orphan itself was written before the abort (resolution is a later pass).
    expect(result.rebuilt).toBe(1);
    expect(
      await testDb.blockchainTransactions.where("txid").equals(TXID_A).count(),
    ).toBe(1);

    const inputs = await testDb.transactionParticipants
      .where("txid")
      .equals(TXID_A)
      .and((p) => p.role === "input")
      .toArray();
    expect(inputs).toHaveLength(2);

    const byPrev = new Map(inputs.map((p) => [p.prevTxid, p]));
    const resolved = byPrev.get(PREV_1)!;
    const untouched = byPrev.get(PREV_2)!;

    // PREV_1's input was fully resolved: address, amount and scriptType together.
    expect(resolved.address).toBe(ADDR_PREV1);
    expect(resolved.amount).toBe(60000);
    expect(resolved.scriptType).toBeDefined();

    // PREV_2's input is exactly as first written — not a partial update.
    expect(untouched.address ?? "").toBe("");
    expect(untouched.amount).toBe(0);

    // The resolution count reflects only the input that was actually completed.
    expect(result.prevoutsResolved).toBe(1);
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

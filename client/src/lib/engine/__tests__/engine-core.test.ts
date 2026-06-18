// Correctness tests for the SQLite read-engine pure core (Task #271).
//
// Runs sqlite-wasm in an in-memory database inside Node (vitest default env), so
// the exact SQL the worker runs against OPFS is exercised here without any
// browser. fake-indexeddb/auto is imported only so we can safely import the real
// computeUtxoCountForAddress (its module graph references indexedDB at import).

import "fake-indexeddb/auto";

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import sqlite3InitModule, { type Database, type Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import {
  createSchema,
  insertRecords,
  insertTransactions,
  insertParticipants,
  upsertSeedProgress,
  markSeedCompleteIfDone,
  isTableReady,
  isEngineReady,
  countTable,
  getRecordPage,
  countRecords,
  getAddressAggregates,
  getOwnedUtxos,
  countOwnedUtxos,
  getParticipantsByTxids,
  getParticipantsByAddresses,
  generateSyntheticData,
  type RecordRow,
  type TransactionRow,
  type ParticipantRow,
} from "../engine-core";
import { computeUtxoCountForAddress } from "@/lib/data/address-stats";
import type { TransactionParticipant } from "@/lib/database";

let sqlite3: Sqlite3Static;

async function freshDb(): Promise<Database> {
  if (!sqlite3) sqlite3 = await sqlite3InitModule();
  const db = new sqlite3.oo1.DB(":memory:", "c");
  createSchema(db);
  return db;
}

// ---- fixture builders -------------------------------------------------------

function rec(over: Partial<RecordRow> & { id: number }): RecordRow {
  const inputString = over.inputString ?? `addr${over.id}`;
  return {
    id: over.id,
    type: over.type ?? "address",
    inputString,
    inputStringLower: (over.inputStringLower ?? inputString).toLowerCase(),
    label: over.label ?? null,
    notes: over.notes ?? null,
    owner: over.owner ?? null,
    walletName: over.walletName ?? null,
    seedName: null,
    walletSoftware: null,
    addressImportance: over.addressImportance ?? "manual",
    chainType: null,
    syncDepth: null,
    firstSeenBlockTime: null,
    cachedBalanceSats: null,
    cachedTxCount: null,
    cachedUtxoCount: null,
    statsComputedAt: null,
    createdAt: over.createdAt ?? over.id,
    updatedAt: over.updatedAt ?? over.id,
    tags: over.tags ?? "[]",
    categories: over.categories ?? "[]",
  };
}

function tx(id: number, txid: string, blockTime: number): TransactionRow {
  return { id, txid, blockHeight: 700000 + id, blockTime, fee: 100, feeRate: 1, vsize: 200, hasOpReturn: 0 };
}

let pid = 1;
function out(txid: string, address: string, vout: number, amount: number): ParticipantRow {
  return { id: pid++, txid, role: "output", address, amount, vout, prevTxid: null, prevVout: null, recordId: null, scriptType: "v0_p2wpkh" };
}
function inp(txid: string, address: string, amount: number, prevTxid: string, prevVout: number): ParticipantRow {
  return { id: pid++, txid, role: "input", address, amount, vout: null, prevTxid, prevVout, recordId: null, scriptType: "v0_p2wpkh" };
}

function toTp(p: ParticipantRow): TransactionParticipant {
  return {
    id: p.id,
    txid: p.txid,
    role: p.role,
    address: p.address,
    amount: p.amount,
    vout: p.vout ?? undefined,
    prevTxid: p.prevTxid ?? undefined,
    prevVout: p.prevVout ?? undefined,
    recordId: p.recordId ?? undefined,
    scriptType: (p.scriptType ?? undefined) as TransactionParticipant["scriptType"],
  };
}

describe("engine-core: schema + idempotent inserts", () => {
  let db: Database;
  beforeAll(async () => {
    db = await freshDb();
  });

  it("inserts and counts; re-inserting the same rows is idempotent", () => {
    const rows = [rec({ id: 1 }), rec({ id: 2 }), rec({ id: 3 })];
    insertRecords(db, rows);
    expect(countTable(db, "records")).toBe(3);
    // INSERT OR REPLACE — same ids, no growth.
    insertRecords(db, rows);
    expect(countTable(db, "records")).toBe(3);
    // Re-insert with a changed field updates in place.
    insertRecords(db, [rec({ id: 2, label: "updated" })]);
    expect(countTable(db, "records")).toBe(3);
    const page = getRecordPage(db, { limit: 10, includeBlockchainDiscovered: true });
    expect(page.find((r) => r.id === 2)?.label).toBe("updated");
  });
});

describe("engine-core: seedMeta resumability + no-partial-complete", () => {
  let db: Database;
  beforeEach(async () => {
    db = await freshDb();
  });

  it("is not ready until copied >= sourceCount and complete is set", () => {
    // Partial copy: 2 of 5 rows.
    insertRecords(db, [rec({ id: 1 }), rec({ id: 2 })]);
    upsertSeedProgress(db, "records", { highWaterId: 2, copied: 2, sourceCount: 5, complete: false });
    expect(isTableReady(db, "records")).toBe(false);

    // Attempting to complete while short MUST refuse.
    expect(markSeedCompleteIfDone(db, "records", 5)).toBe(false);
    expect(isTableReady(db, "records")).toBe(false);

    // Finish the copy, then complete succeeds.
    insertRecords(db, [rec({ id: 3 }), rec({ id: 4 }), rec({ id: 5 })]);
    upsertSeedProgress(db, "records", { highWaterId: 5, copied: 5, sourceCount: 5, complete: false });
    expect(markSeedCompleteIfDone(db, "records", 5)).toBe(true);
    expect(isTableReady(db, "records")).toBe(true);
  });

  it("engine is ready only when all three tables are complete", () => {
    insertRecords(db, [rec({ id: 1 })]);
    insertTransactions(db, [tx(1, "tx1", 1000)]);
    insertParticipants(db, [out("tx1", "addr1", 0, 100)]);
    markSeedCompleteIfDone(db, "records", 1);
    markSeedCompleteIfDone(db, "blockchainTransactions", 1);
    expect(isEngineReady(db)).toBe(false);
    markSeedCompleteIfDone(db, "transactionParticipants", 1);
    expect(isEngineReady(db)).toBe(true);
  });

  it("resume from high-water mark does not lose or double rows (idempotent)", () => {
    // Simulate a crash: first half copied + progress persisted.
    insertRecords(db, [rec({ id: 1 }), rec({ id: 2 }), rec({ id: 3 })]);
    upsertSeedProgress(db, "records", { highWaterId: 3, copied: 3, sourceCount: 6, complete: false });
    // Resume re-copies an overlapping batch (idempotent) + the rest.
    insertRecords(db, [rec({ id: 3 }), rec({ id: 4 }), rec({ id: 5 }), rec({ id: 6 })]);
    expect(countTable(db, "records")).toBe(6);
    expect(markSeedCompleteIfDone(db, "records", 6)).toBe(true);
  });
});

describe("engine-core: record page / count / search", () => {
  let db: Database;
  beforeAll(async () => {
    db = await freshDb();
    insertRecords(db, [
      rec({ id: 1, inputString: "bc1qAlice", label: "Alice Wallet", owner: "Alice", walletName: "Cold", addressImportance: "verified" }),
      rec({ id: 2, inputString: "bc1qBob", label: "Bob", owner: "Bob", addressImportance: "manual", notes: "alice is mentioned here" }),
      rec({ id: 3, inputString: "bc1qCarol", label: "Carol", owner: "Carol", addressImportance: "wallet-import" }),
      rec({ id: 4, type: "transaction", inputString: "txhash1", label: "Big TX", addressImportance: "manual" }),
      rec({ id: 5, inputString: "bc1qDisc", label: "discovered", addressImportance: "blockchain-discovered" }),
      rec({ id: 6, inputString: "bc1qPend", label: "pending", addressImportance: "pending-review" }),
    ]);
  });

  it("excludes blockchain-discovered + pending-review by default", () => {
    expect(countRecords(db, { includeBlockchainDiscovered: false })).toBe(4);
    expect(countRecords(db, { includeBlockchainDiscovered: true })).toBe(6);
  });

  it("returns rows id-descending and pages by keyset", () => {
    const first = getRecordPage(db, { limit: 2, includeBlockchainDiscovered: true });
    expect(first.map((r) => r.id)).toEqual([6, 5]);
    const next = getRecordPage(db, { limit: 2, beforeId: 5, includeBlockchainDiscovered: true });
    expect(next.map((r) => r.id)).toEqual([4, 3]);
  });

  it("filters by type", () => {
    expect(countRecords(db, { type: "transaction", includeBlockchainDiscovered: true })).toBe(1);
    expect(countRecords(db, { type: "address", includeBlockchainDiscovered: true })).toBe(5);
  });

  it("case-insensitive search across label/inputString/owner/walletName/notes", () => {
    // 'alice' matches record 1 (label/owner/inputString) and record 2 (notes).
    const r = getRecordPage(db, { limit: 10, search: "ALICE", includeBlockchainDiscovered: true });
    expect(new Set(r.map((x) => x.id))).toEqual(new Set([1, 2]));
    expect(countRecords(db, { search: "alice", includeBlockchainDiscovered: true })).toBe(2);
    // wallet name search
    expect(countRecords(db, { search: "cold", includeBlockchainDiscovered: true })).toBe(1);
    // no match
    expect(countRecords(db, { search: "zzzzz", includeBlockchainDiscovered: true })).toBe(0);
  });
});

describe("engine-core: UTXO exact anti-join parity vs computeUtxoCountForAddress", () => {
  let db: Database;
  // Build a realistic exact-mode fixture:
  //   A: 3 outputs, spends one of its own outputs (1 spent, 2 unspent)
  //   B: 2 outputs, spends both (0 unspent)
  //   C: 2 outputs, never spends anything (2 unspent)
  //   D: 1 output with NO block time (ignored -> 0 unspent)
  const txs: TransactionRow[] = [
    tx(1, "txA1", 1000),
    tx(2, "txA2", 1100),
    tx(3, "txAspend", 1200),
    tx(4, "txB1", 1300),
    tx(5, "txBspend", 1400),
    tx(6, "txC1", 1500),
    tx(7, "txD1", 0), // no block time
  ];
  const parts: ParticipantRow[] = [
    // A outputs
    out("txA1", "A", 0, 500),
    out("txA1", "A", 1, 600),
    out("txA2", "A", 0, 700),
    // A spends txA1:0
    inp("txAspend", "A", 500, "txA1", 0),
    // B outputs
    out("txB1", "B", 0, 800),
    out("txB1", "B", 1, 900),
    // B spends both
    inp("txBspend", "B", 800, "txB1", 0),
    inp("txBspend", "B", 900, "txB1", 1),
    // C outputs (never spent)
    out("txC1", "C", 0, 1000),
    out("txC1", "C", 1, 1100),
    // D output with no block time
    out("txD1", "D", 0, 1200),
  ];

  beforeAll(async () => {
    db = await freshDb();
    insertTransactions(db, txs);
    insertParticipants(db, parts);
  });

  const blockTimeOf = (txid: string) => txs.find((t) => t.txid === txid)?.blockTime ?? 0;

  it.each(["A", "B", "C", "D"])("address %s matches the reference UTXO count", (addr) => {
    const outs = parts.filter((p) => p.address === addr && p.role === "output").map(toTp);
    const ins = parts.filter((p) => p.address === addr && p.role === "input").map(toTp);
    const expected = computeUtxoCountForAddress(outs, ins, blockTimeOf);
    const agg = getAddressAggregates(db, [addr]).get(addr);
    expect(agg?.utxoCount ?? 0).toBe(expected);
  });

  it("computes balance, txCount and lastActivity per address", () => {
    const a = getAddressAggregates(db, ["A"]).get("A")!;
    // balance = outputs(500+600+700) - inputs(500) = 1300
    expect(a.balanceSats).toBe(1300);
    // txids touching A: txA1, txA2, txAspend = 3
    expect(a.txCount).toBe(3);
    expect(a.lastActivityTime).toBe(1200);
  });
});

describe("engine-core: owned-UTXO set join (tiers)", () => {
  let db: Database;
  beforeAll(async () => {
    db = await freshDb();
    // Address records: A owned (manual), Z not owned (blockchain-discovered).
    insertRecords(db, [
      rec({ id: 1, inputString: "A", addressImportance: "manual" }),
      rec({ id: 2, inputString: "Z", addressImportance: "blockchain-discovered" }),
    ]);
    insertTransactions(db, [tx(1, "t1", 1000), tx(2, "t2", 1100)]);
    insertParticipants(db, [
      out("t1", "A", 0, 100), // owned, unspent
      out("t1", "A", 1, 200), // owned, spent below
      inp("t2", "A", 200, "t1", 1),
      out("t1", "Z", 2, 300), // not owned -> excluded
    ]);
  });

  it("counts only unspent outputs of owned-tier addresses", () => {
    expect(countOwnedUtxos(db)).toBe(1);
    const utxos = getOwnedUtxos(db, { limit: 100 });
    expect(utxos).toHaveLength(1);
    expect(utxos[0].address).toBe("A");
    expect(utxos[0].vout).toBe(0);
  });
});

describe("engine-core: owned-UTXO dedup when an address has multiple records", () => {
  let db: Database;
  beforeAll(async () => {
    db = await freshDb();
    // Two owned address records pointing at the SAME address. A naive JOIN would
    // multiply each matching output by the number of records and overcount.
    insertRecords(db, [
      rec({ id: 1, inputString: "A", addressImportance: "manual" }),
      rec({ id: 2, inputString: "A", addressImportance: "verified" }),
    ]);
    insertTransactions(db, [tx(1, "t1", 1000), tx(2, "t2", 1100)]);
    insertParticipants(db, [
      out("t1", "A", 0, 100), // unspent
      out("t1", "A", 1, 200), // spent below
      inp("t2", "A", 200, "t1", 1),
    ]);
  });

  it("counts each unspent output exactly once regardless of duplicate records", () => {
    expect(countOwnedUtxos(db)).toBe(1);
    const utxos = getOwnedUtxos(db, { limit: 100 });
    expect(utxos).toHaveLength(1);
    expect(utxos[0].address).toBe("A");
    expect(utxos[0].vout).toBe(0);
    // No duplicate ids in the returned page.
    const ids = utxos.map((u) => u.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("engine-core: participant lookups", () => {
  let db: Database;
  beforeAll(async () => {
    db = await freshDb();
    insertParticipants(db, [out("tx1", "A", 0, 100), out("tx1", "B", 1, 200), inp("tx2", "A", 50, "tx1", 0)]);
  });

  it("fetches by txids and by addresses", () => {
    expect(getParticipantsByTxids(db, ["tx1"]).length).toBe(2);
    expect(getParticipantsByAddresses(db, ["A"]).length).toBe(2);
    expect(getParticipantsByTxids(db, []).length).toBe(0);
  });
});

describe("engine-core: synthetic generator sanity", () => {
  it("generates the requested scale and the anti-join runs", async () => {
    const db = await freshDb();
    const res = generateSyntheticData(db, { addresses: 200, transactions: 500, participantsPerTx: 4, spentFraction: 0.5, batchSize: 1000 });
    expect(res.records).toBe(200);
    expect(res.transactions).toBe(500);
    expect(res.participants).toBeGreaterThan(0);
    // Owned UTXO count should be > 0 and <= total outputs.
    const owned = countOwnedUtxos(db);
    expect(owned).toBeGreaterThan(0);
  });
});

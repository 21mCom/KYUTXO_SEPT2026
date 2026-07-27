// Correctness tests for the SQLite read-engine pure core.
//
// Runs better-sqlite3 in an in-memory database inside Node (vitest default env),
// so the EXACT SQL the production Electron worker runs against the native DB on
// the USB is exercised here without any browser. fake-indexeddb/auto is imported
// only so we can safely import the real computeUtxoCountForAddress (its module
// graph references indexedDB at import).

import "fake-indexeddb/auto";

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { createInMemoryEngineDb, type BetterSqlite3EngineDb } from "../better-sqlite3-adapter";
import {
  createSchema,
  createTablesOnly,
  dropMirrorTables,
  resetSeedMeta,
  insertRecords,
  insertTransactions,
  insertParticipants,
  upsertSeedProgress,
  markSeedCompleteIfDone,
  isTableReady,
  isEngineReady,
  countTable,
  getRecordPage,
  getRecordPageByUpdatedAt,
  countRecords,
  getAddressAggregates,
  getOwnedUtxos,
  countOwnedUtxos,
  buildOwnedUtxos,
  ownedUtxosReady,
  getHeuristicOwnedUtxos,
  countHeuristicOwnedUtxos,
  buildHeuristicOwnedUtxos,
  heuristicOwnedUtxosReady,
  getParticipantsByTxids,
  getParticipantsByAddresses,
  countTransactions,
  getTransactionPage,
  getTransactionAggregates,
  getBalanceGroupSummaries,
  getWalletUsageSummaries,
  getVaultSummaries,
  generateSyntheticData,
  getEngineSchemaVersion,
  writeEngineSchemaVersion,
  ENGINE_SCHEMA_VERSION,
  type RecordRow,
  type TransactionRow,
  type ParticipantRow,
} from "../engine-core";
import { computeUtxoCountForAddress } from "@/lib/data/address-stats";
import type { TransactionParticipant } from "@/lib/database";

async function freshDb(): Promise<BetterSqlite3EngineDb> {
  const db = createInMemoryEngineDb();
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
    chainType: over.chainType ?? null,
    syncDepth: null,
    firstSeenBlockTime: over.firstSeenBlockTime ?? null,
    cachedBalanceSats: over.cachedBalanceSats ?? null,
    cachedTxCount: over.cachedTxCount ?? null,
    cachedUtxoCount: over.cachedUtxoCount ?? null,
    statsComputedAt: over.statsComputedAt ?? null,
    createdAt: over.createdAt ?? over.id,
    updatedAt: over.updatedAt ?? over.id,
    tags: over.tags ?? "[]",
    categories: over.categories ?? "[]",
    derivationPath: over.derivationPath ?? null,
    discoveredInTxid: over.discoveredInTxid ?? null,
    vaultIsVaultXpub: over.vaultIsVaultXpub ?? null,
    vaultM: over.vaultM ?? null,
    vaultN: over.vaultN ?? null,
    vaultName: over.vaultName ?? null,
    vaultNotes: over.vaultNotes ?? null,
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
  let db: BetterSqlite3EngineDb;
  beforeAll(async () => {
    db = await freshDb();
  });

  it("inserts and counts; a full rebuild drops then re-seeds fresh rows", () => {
    const rows = [rec({ id: 1 }), rec({ id: 2 }), rec({ id: 3 })];
    insertRecords(db, rows);
    expect(countTable(db, "records")).toBe(3);

    // Full-rebuild model: plain INSERT (no upsert), so re-inserting the same id
    // is a hard error rather than a silent replace.
    expect(() => insertRecords(db, [rec({ id: 2 })])).toThrow();

    // To change mirrored data we drop the tables and re-seed from scratch — an
    // interrupted seed never leaves half-mirrored rows and there is no dup risk.
    dropMirrorTables(db);
    createTablesOnly(db);
    insertRecords(db, [rec({ id: 1 }), rec({ id: 2, label: "updated" }), rec({ id: 3 })]);
    expect(countTable(db, "records")).toBe(3);
    const page = getRecordPage(db, { limit: 10, includeBlockchainDiscovered: true });
    expect(page.find((r) => r.id === 2)?.label).toBe("updated");
  });
});

describe("engine-core: schema version gate", () => {
  it("reports 0 for a freshly-created (un-stamped) mirror so the gate refuses it", async () => {
    const db = await freshDb();
    // A brand-new mirror has never finalized, so it must NOT advertise the current
    // shape — getEngineSchemaVersion returns 0 (!= ENGINE_SCHEMA_VERSION), which is
    // what makes evaluateEngineFreshness return reason:'schema-mismatch'.
    expect(getEngineSchemaVersion(db)).toBe(0);
    expect(getEngineSchemaVersion(db)).not.toBe(ENGINE_SCHEMA_VERSION);
  });

  it("reports ENGINE_SCHEMA_VERSION only after a finalize stamp", async () => {
    const db = await freshDb();
    writeEngineSchemaVersion(db);
    expect(getEngineSchemaVersion(db)).toBe(ENGINE_SCHEMA_VERSION);
  });

  it("simulates an OLDER on-disk mirror (stamped v1) being refused as a mismatch", async () => {
    const db = await freshDb();
    // Older builds stamped a lower number; emulate one directly in engineMeta.
    db.run(
      "INSERT INTO engineMeta (key, value) VALUES ('schemaVersion', '1') " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    expect(getEngineSchemaVersion(db)).toBe(1);
    expect(getEngineSchemaVersion(db)).not.toBe(ENGINE_SCHEMA_VERSION);
  });

  it("round-trips the v2 record columns (derivationPath, discoveredInTxid, vault*)", async () => {
    const db = await freshDb();
    insertRecords(db, [
      rec({
        id: 1,
        derivationPath: "m/84'/0'/0'/0/5",
        discoveredInTxid: "txid-abc",
        vaultIsVaultXpub: 1,
        vaultM: 2,
        vaultN: 3,
        vaultName: "Cold Vault",
        vaultNotes: "multisig",
      }),
    ]);
    const [row] = db.selectRows<{
      derivationPath: string | null;
      discoveredInTxid: string | null;
      vaultIsVaultXpub: number | null;
      vaultM: number | null;
      vaultN: number | null;
      vaultName: string | null;
      vaultNotes: string | null;
    }>(
      "SELECT derivationPath, discoveredInTxid, vaultIsVaultXpub, vaultM, vaultN, " +
        "vaultName, vaultNotes FROM records WHERE id = 1",
    );
    expect(row).toEqual({
      derivationPath: "m/84'/0'/0'/0/5",
      discoveredInTxid: "txid-abc",
      vaultIsVaultXpub: 1,
      vaultM: 2,
      vaultN: 3,
      vaultName: "Cold Vault",
      vaultNotes: "multisig",
    });
  });
});

describe("engine-core: seedMeta state-machine + no-partial-complete", () => {
  let db: BetterSqlite3EngineDb;
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

  it("a full rebuild on restart drops half-seeded rows and re-seeds clean (no resume)", () => {
    // Simulate an interrupted seed: first half copied + progress persisted.
    insertRecords(db, [rec({ id: 1 }), rec({ id: 2 }), rec({ id: 3 })]);
    upsertSeedProgress(db, "records", { highWaterId: 3, copied: 3, sourceCount: 6, complete: false });
    expect(isTableReady(db, "records")).toBe(false);

    // Restart = FULL REBUILD (no resume): drop the data tables, recreate them,
    // reset progress, then seed the entire source from scratch.
    dropMirrorTables(db);
    createTablesOnly(db);
    resetSeedMeta(db);
    insertRecords(db, [
      rec({ id: 1 }), rec({ id: 2 }), rec({ id: 3 }),
      rec({ id: 4 }), rec({ id: 5 }), rec({ id: 6 }),
    ]);
    upsertSeedProgress(db, "records", { highWaterId: 6, copied: 6, sourceCount: 6, complete: false });
    expect(countTable(db, "records")).toBe(6);
    expect(markSeedCompleteIfDone(db, "records", 6)).toBe(true);
    expect(isTableReady(db, "records")).toBe(true);
  });
});

describe("engine-core: record page / count / search", () => {
  let db: BetterSqlite3EngineDb;
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

describe("engine-core: record page by updatedAt (Dashboard order)", () => {
  let db: BetterSqlite3EngineDb;
  beforeAll(async () => {
    db = await freshDb();
    insertRecords(db, [
      rec({ id: 1, updatedAt: 100, addressImportance: "manual" }),
      rec({ id: 2, updatedAt: 300, addressImportance: "verified" }),
      rec({ id: 3, updatedAt: 200, addressImportance: "manual" }),
      // id 4 ties id 2 at updatedAt 300 → id DESC breaks the tie (4 before 2).
      rec({ id: 4, updatedAt: 300, addressImportance: "manual" }),
      rec({ id: 5, updatedAt: 500, addressImportance: "blockchain-discovered" }),
      rec({ id: 6, updatedAt: 400, addressImportance: "pending-review" }),
      // No updatedAt key — Dexie's updatedAt index excludes these, so must we.
      { ...rec({ id: 7, addressImportance: "manual" }), updatedAt: null },
    ]);
  });

  it("orders updatedAt DESC then id DESC, excludes blockchain tiers + null updatedAt", () => {
    const page = getRecordPageByUpdatedAt(db, { limit: 50, includeBlockchainDiscovered: false });
    expect(page.map((r) => r.id)).toEqual([4, 2, 3, 1]);
  });

  it("includes blockchain tiers when requested, still excludes null updatedAt", () => {
    const page = getRecordPageByUpdatedAt(db, { limit: 50, includeBlockchainDiscovered: true });
    expect(page.map((r) => r.id)).toEqual([5, 6, 4, 2, 3, 1]);
  });

  it("paginates by offset", () => {
    const page = getRecordPageByUpdatedAt(db, { limit: 2, offset: 2, includeBlockchainDiscovered: true });
    expect(page.map((r) => r.id)).toEqual([4, 2]);
  });
});

describe("engine-core: UTXO exact anti-join parity vs computeUtxoCountForAddress", () => {
  let db: BetterSqlite3EngineDb;
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

  it("computes balance as unspent-output sum, txCount and lastActivity per address", () => {
    const a = getAddressAggregates(db, ["A"]).get("A")!;
    // A outputs: txA1:0=500 (spent), txA1:1=600 (unspent), txA2:0=700 (unspent)
    // balance = sum of unspent outputs = 600 + 700 = 1300
    expect(a.balanceSats).toBe(1300);
    // txids touching A: txA1, txA2, txAspend = 3
    expect(a.txCount).toBe(3);
    expect(a.lastActivityTime).toBe(1200);
  });

  it("balance is sum of unspent outputs for all addresses, never negative", () => {
    // B: both outputs spent → 0 UTXOs, 0 balance (not negative)
    const b = getAddressAggregates(db, ["B"]).get("B")!;
    expect(b.utxoCount).toBe(0);
    expect(b.balanceSats).toBe(0);

    // C: 2 outputs, never spent → balance = 1000 + 1100 = 2100
    const c = getAddressAggregates(db, ["C"]).get("C")!;
    expect(c.utxoCount).toBe(2);
    expect(c.balanceSats).toBe(2100);

    // D: output with no block time → excluded → 0 UTXOs, 0 balance
    const d = getAddressAggregates(db, ["D"]).get("D")!;
    expect(d.utxoCount).toBe(0);
    expect(d.balanceSats).toBe(0);
  });

  it("balance never goes negative when an address has more attributed spends than receipts", () => {
    // Simulate an address that received one output but whose prevout data
    // references another external output not in local data. The old formula
    // (received − spent) would produce a negative number; the new formula
    // (sum of unspent outputs via anti-join) always returns 0 or more.
    const freshDb2 = createInMemoryEngineDb();
    createSchema(freshDb2);
    // address "E" receives 1000 sats in tx-e1:0
    insertTransactions(freshDb2, [tx(10, "tx-e1", 5000), tx(11, "tx-e-spend", 6000)]);
    insertParticipants(freshDb2, [
      out("tx-e1", "E", 0, 1000),
      // E spends tx-e1:0 (its own output)
      inp("tx-e-spend", "E", 1000, "tx-e1", 0),
      // E also has an input referencing an external txid NOT in local data.
      // This is what the old formula would subtract, producing a negative balance.
      inp("tx-e-spend", "E", 2000, "external-tx", 0),
    ]);
    const e = getAddressAggregates(freshDb2, ["E"]).get("E")!;
    // Both outputs of E are either spent or external → 0 unspent → balance = 0
    expect(e.balanceSats).toBe(0);
    expect(e.utxoCount).toBe(0);
  });
});

describe("engine-core: owned-UTXO set join (tiers)", () => {
  let db: BetterSqlite3EngineDb;
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
  let db: BetterSqlite3EngineDb;
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

describe("engine-core: materialized owned-UTXO table", () => {
  let db: BetterSqlite3EngineDb;
  beforeAll(async () => {
    db = await freshDb();
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

  it("is not ready before a build (falls back to the live anti-join)", () => {
    expect(ownedUtxosReady(db)).toBe(false);
    // Live path still returns correct results.
    expect(countOwnedUtxos(db)).toBe(1);
  });

  it("serves identical results from the materialized table after a build", () => {
    const built = buildOwnedUtxos(db);
    expect(built).toBe(1);
    expect(ownedUtxosReady(db)).toBe(true);
    expect(countOwnedUtxos(db)).toBe(1);
    const utxos = getOwnedUtxos(db, { limit: 100 });
    expect(utxos).toHaveLength(1);
    expect(utxos[0].address).toBe("A");
    expect(utxos[0].vout).toBe(0);
  });

  it("keyset-pages the materialized table by id", () => {
    insertRecords(db, [rec({ id: 3, inputString: "B", addressImportance: "verified" })]);
    insertTransactions(db, [tx(3, "t3", 1200)]);
    insertParticipants(db, [out("t3", "B", 0, 400)]); // second owned, unspent utxo
    buildOwnedUtxos(db);
    expect(countOwnedUtxos(db)).toBe(2);
    const first = getOwnedUtxos(db, { limit: 1 });
    expect(first).toHaveLength(1);
    const next = getOwnedUtxos(db, { limit: 10, afterId: first[0].id });
    expect(next).toHaveLength(1);
    expect(next[0].id).toBeGreaterThan(first[0].id);
  });

  it("falls back to the live query when requested tiers differ from the built set", () => {
    // Built for the default OWNED_TIERS; a custom tier set must not trust the cache.
    expect(ownedUtxosReady(db, ["verified"])).toBe(false);
    // 'verified' tier only matches address B -> exactly one owned utxo.
    expect(countOwnedUtxos(db, { tiers: ["verified"] })).toBe(1);
  });

  it("invalidates the materialized table on dropMirrorTables", () => {
    dropMirrorTables(db);
    expect(ownedUtxosReady(db)).toBe(false);
    // Recreate empty tables so the db is usable again (mirrors the rebuild path).
    createTablesOnly(db);
  });
});

describe("engine-core: owned-UTXO with widened tiers (include blockchain-discovered)", () => {
  let db: BetterSqlite3EngineDb;
  beforeAll(async () => {
    db = await freshDb();
    insertRecords(db, [
      rec({ id: 1, inputString: "A", addressImportance: "manual" }),
      rec({ id: 2, inputString: "Z", addressImportance: "blockchain-discovered" }),
      rec({ id: 3, inputString: "P", addressImportance: "pending-review" }),
    ]);
    insertTransactions(db, [tx(1, "t1", 1000)]);
    insertParticipants(db, [
      out("t1", "A", 0, 100), // user-curated, unspent
      out("t1", "Z", 1, 300), // blockchain-discovered, unspent
      out("t1", "P", 2, 400), // pending-review, unspent
    ]);
  });

  it("default tiers exclude blockchain-discovered / pending-review outputs", () => {
    expect(countOwnedUtxos(db)).toBe(1);
    const utxos = getOwnedUtxos(db, { limit: 100 });
    expect(utxos.map((u) => u.address)).toEqual(["A"]);
  });

  it("widened tier set includes blockchain-discovered and pending-review outputs", () => {
    const tiers = ["verified", "manual", "wallet-import", "xpub-derived", "blockchain-discovered", "pending-review"];
    expect(countOwnedUtxos(db, { tiers })).toBe(3);
    const utxos = getOwnedUtxos(db, { tiers, limit: 100 });
    expect(new Set(utxos.map((u) => u.address))).toEqual(new Set(["A", "Z", "P"]));
  });
});

describe("engine-core: owned-UTXO as-of a historical block-time cutoff", () => {
  let db: BetterSqlite3EngineDb;
  beforeAll(async () => {
    db = await freshDb();
    insertRecords(db, [rec({ id: 1, inputString: "A", addressImportance: "manual" })]);
    // t1 (time 1000) creates two owned outputs; t2 (time 2000) spends vout 1.
    insertTransactions(db, [tx(1, "t1", 1000), tx(2, "t2", 2000)]);
    insertParticipants(db, [
      out("t1", "A", 0, 100), // never spent
      out("t1", "A", 1, 200), // spent at time 2000
      inp("t2", "A", 200, "t1", 1),
    ]);
  });

  it("counts both outputs as of a time before the spend", () => {
    // As of 1500 the spend (time 2000) hasn't happened yet, so both are unspent.
    expect(countOwnedUtxos(db, { asOfBlockTime: 1500 })).toBe(2);
    const utxos = getOwnedUtxos(db, { asOfBlockTime: 1500, limit: 100 });
    expect(new Set(utxos.map((u) => u.vout))).toEqual(new Set([0, 1]));
  });

  it("counts only the unspent output as of a time after the spend", () => {
    // As of 2500 the spend has occurred, so vout 1 is gone.
    expect(countOwnedUtxos(db, { asOfBlockTime: 2500 })).toBe(1);
    const utxos = getOwnedUtxos(db, { asOfBlockTime: 2500, limit: 100 });
    expect(utxos.map((u) => u.vout)).toEqual([0]);
  });

  it("excludes outputs created after the cutoff", () => {
    // As of 500 neither output's creating tx (time 1000) has confirmed yet.
    expect(countOwnedUtxos(db, { asOfBlockTime: 500 })).toBe(0);
    expect(getOwnedUtxos(db, { asOfBlockTime: 500, limit: 100 })).toHaveLength(0);
  });
});

describe("engine-core: participant lookups", () => {
  let db: BetterSqlite3EngineDb;
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

// Reference implementation of the in-browser heuristic (no-prevout) owned-UTXO
// computation in UTXOs.tsx. Replicated here verbatim (FIFO amount-matching per
// `address:amount` group, only owned outputs returned) so the engine SQL is held
// to byte-for-byte parity against the exact algorithm the page runs. Returns the
// set of unspent outpoints (`txid:vout`).
function referenceHeuristic(
  parts: ParticipantRow[],
  blockTimeOf: (txid: string) => number,
  owned: Set<string>,
  cutoff: number = Infinity,
): Set<string> {
  const outputs = parts.filter((p) => p.role === "output");
  const inputs = parts.filter((p) => p.role === "input");

  const outputsWithTime = outputs
    .map((output) => ({ output, blockTime: blockTimeOf(output.txid) }))
    .filter((o) => o.blockTime > 0 && o.blockTime <= cutoff);
  outputsWithTime.sort((a, b) => {
    if (a.blockTime !== b.blockTime) return a.blockTime - b.blockTime;
    return (a.output.vout ?? 0) - (b.output.vout ?? 0);
  });

  const inputsWithTime = inputs
    .map((input) => ({ input, blockTime: blockTimeOf(input.txid) }))
    .filter((i) => i.blockTime > 0 && i.blockTime <= cutoff);
  inputsWithTime.sort((a, b) => a.blockTime - b.blockTime);

  const inputsByAddressAmount = new Map<string, { input: ParticipantRow; blockTime: number }[]>();
  for (const item of inputsWithTime) {
    const key = `${item.input.address}:${item.input.amount}`;
    const existing = inputsByAddressAmount.get(key) || [];
    existing.push(item);
    inputsByAddressAmount.set(key, existing);
  }

  const result = new Set<string>();
  const matchedInputIndices = new Map<string, number>();
  for (const { output, blockTime } of outputsWithTime) {
    const key = `${output.address}:${output.amount}`;
    const matchingInputs = inputsByAddressAmount.get(key) || [];
    const currentIndex = matchedInputIndices.get(key) || 0;
    const spendingInput = matchingInputs.find(
      (item, idx) => idx >= currentIndex && item.blockTime > blockTime,
    );
    if (spendingInput) {
      matchedInputIndices.set(key, matchingInputs.indexOf(spendingInput) + 1);
    } else if (owned.has(output.address)) {
      result.add(`${output.txid}:${output.vout ?? 0}`);
    }
  }
  return result;
}

const outpointsOf = (utxos: { txid: string; vout: number | null }[]): Set<string> =>
  new Set(utxos.map((u) => `${u.txid}:${u.vout ?? 0}`));

describe("engine-core: heuristic owned-UTXO parity vs in-browser computation", () => {
  let db: BetterSqlite3EngineDb;
  // A multi-group fixture exercising the FIFO amount-matching corners:
  //   A:500 — out@1000, out@1100, in@1200 -> one spend (prefix), later output unspent
  //   A:700 — single out@1050, no matching input -> unspent
  //   B:800 — out@1300, in@1250 (input BEFORE output, useless) -> output unspent
  //   B:900 — out@1300, out@1400, in@1500 -> one spend, later unspent
  //   C:100 — out (owned but no block time) -> excluded
  //   Z:300 — out@1600 but NOT owned -> excluded
  const txs: TransactionRow[] = [
    tx(1, "txA1", 1000),
    tx(2, "txA2", 1100),
    tx(3, "txAspend", 1200),
    tx(4, "txA3", 1050),
    tx(5, "txBin", 1250),
    tx(6, "txB1", 1300),
    tx(7, "txB2", 1400),
    tx(8, "txBspend", 1500),
    tx(9, "txC1", 0), // no block time
    tx(10, "txZ1", 1600),
  ];
  const parts: ParticipantRow[] = [
    out("txA1", "A", 0, 500),
    out("txA2", "A", 1, 500),
    inp("txAspend", "A", 500, "txA1", 0),
    out("txA3", "A", 0, 700),
    inp("txBin", "B", 800, "txBin0", 0),
    out("txB1", "B", 0, 800),
    out("txB1", "B", 1, 900),
    out("txB2", "B", 0, 900),
    inp("txBspend", "B", 900, "txB1", 1),
    out("txC1", "C", 0, 100),
    out("txZ1", "Z", 0, 300),
  ];
  const owned = new Set(["A", "B", "C"]);

  beforeAll(async () => {
    db = await freshDb();
    insertRecords(db, [
      rec({ id: 1, inputString: "A", addressImportance: "manual" }),
      rec({ id: 2, inputString: "B", addressImportance: "verified" }),
      rec({ id: 3, inputString: "C", addressImportance: "wallet-import" }),
      rec({ id: 4, inputString: "Z", addressImportance: "blockchain-discovered" }),
    ]);
    insertTransactions(db, txs);
    insertParticipants(db, parts);
  });

  const blockTimeOf = (txid: string) => txs.find((t) => t.txid === txid)?.blockTime ?? 0;

  it("the live engine set matches the reference set exactly", () => {
    const expected = referenceHeuristic(parts, blockTimeOf, owned);
    const got = outpointsOf(getHeuristicOwnedUtxos(db, { limit: 1000 }));
    expect(got).toEqual(expected);
    expect(countHeuristicOwnedUtxos(db)).toBe(expected.size);
  });

  it("the materialized table serves identical results after a build", () => {
    expect(heuristicOwnedUtxosReady(db)).toBe(false);
    const built = buildHeuristicOwnedUtxos(db);
    const expected = referenceHeuristic(parts, blockTimeOf, owned);
    expect(built).toBe(expected.size);
    expect(heuristicOwnedUtxosReady(db)).toBe(true);
    expect(countHeuristicOwnedUtxos(db)).toBe(expected.size);
    const got = outpointsOf(getHeuristicOwnedUtxos(db, { limit: 1000 }));
    expect(got).toEqual(expected);
  });

  it("keyset-pages the materialized table by id", () => {
    const all = getHeuristicOwnedUtxos(db, { limit: 1000 });
    expect(all.length).toBeGreaterThan(1);
    const first = getHeuristicOwnedUtxos(db, { limit: 1 });
    expect(first).toHaveLength(1);
    const rest = getHeuristicOwnedUtxos(db, { limit: 1000, afterId: first[0].id });
    expect(rest.every((u) => u.id > first[0].id)).toBe(true);
    // Union of the keyset pages equals the full set.
    expect(outpointsOf([...first, ...rest])).toEqual(outpointsOf(all));
  });

  it("falls back to the live query when requested tiers differ from the built set", () => {
    // Built for default OWNED_TIERS; a custom tier set must not trust the cache.
    expect(heuristicOwnedUtxosReady(db, ["verified"])).toBe(false);
    // 'verified' tier matches only address B; reference restricted to B.
    const expected = referenceHeuristic(parts, blockTimeOf, new Set(["B"]));
    expect(countHeuristicOwnedUtxos(db, { tiers: ["verified"] })).toBe(expected.size);
    const got = outpointsOf(getHeuristicOwnedUtxos(db, { tiers: ["verified"], limit: 1000 }));
    expect(got).toEqual(expected);
  });

  it("invalidates the materialized table on dropMirrorTables", () => {
    dropMirrorTables(db);
    expect(heuristicOwnedUtxosReady(db)).toBe(false);
    createTablesOnly(db);
  });
});

describe("engine-core: heuristic owned-UTXO widened tiers parity", () => {
  let db: BetterSqlite3EngineDb;
  const txs: TransactionRow[] = [tx(1, "t1", 1000)];
  const parts: ParticipantRow[] = [
    out("t1", "A", 0, 100), // user-curated, unspent
    out("t1", "Z", 1, 300), // blockchain-discovered
    out("t1", "P", 2, 400), // pending-review
  ];
  beforeAll(async () => {
    db = await freshDb();
    insertRecords(db, [
      rec({ id: 1, inputString: "A", addressImportance: "manual" }),
      rec({ id: 2, inputString: "Z", addressImportance: "blockchain-discovered" }),
      rec({ id: 3, inputString: "P", addressImportance: "pending-review" }),
    ]);
    insertTransactions(db, txs);
    insertParticipants(db, parts);
  });

  const blockTimeOf = (txid: string) => txs.find((t) => t.txid === txid)?.blockTime ?? 0;

  it("default tiers exclude blockchain-discovered / pending-review outputs", () => {
    const expected = referenceHeuristic(parts, blockTimeOf, new Set(["A"]));
    expect(outpointsOf(getHeuristicOwnedUtxos(db, { limit: 100 }))).toEqual(expected);
    expect(countHeuristicOwnedUtxos(db)).toBe(expected.size);
  });

  it("widened tier set includes blockchain-discovered and pending-review outputs", () => {
    const tiers = ["verified", "manual", "wallet-import", "xpub-derived", "blockchain-discovered", "pending-review"];
    const expected = referenceHeuristic(parts, blockTimeOf, new Set(["A", "Z", "P"]));
    expect(countHeuristicOwnedUtxos(db, { tiers })).toBe(expected.size);
    expect(outpointsOf(getHeuristicOwnedUtxos(db, { tiers, limit: 100 }))).toEqual(expected);
  });
});

describe("engine-core: heuristic owned-UTXO as-of cutoff parity", () => {
  let db: BetterSqlite3EngineDb;
  // A:500 created by two outputs (t1@1000, t2@1100) and spent once (t3@2000).
  const txs: TransactionRow[] = [tx(1, "t1", 1000), tx(2, "t2", 1100), tx(3, "t3", 2000)];
  const parts: ParticipantRow[] = [
    out("t1", "A", 0, 500),
    out("t2", "A", 1, 500),
    inp("t3", "A", 500, "t1", 0),
  ];
  const owned = new Set(["A"]);
  beforeAll(async () => {
    db = await freshDb();
    insertRecords(db, [rec({ id: 1, inputString: "A", addressImportance: "manual" })]);
    insertTransactions(db, txs);
    insertParticipants(db, parts);
  });

  const blockTimeOf = (txid: string) => txs.find((t) => t.txid === txid)?.blockTime ?? 0;

  it("before the spend both outputs are unspent", () => {
    const expected = referenceHeuristic(parts, blockTimeOf, owned, 1500);
    expect(countHeuristicOwnedUtxos(db, { asOfBlockTime: 1500 })).toBe(expected.size);
    expect(outpointsOf(getHeuristicOwnedUtxos(db, { asOfBlockTime: 1500, limit: 100 }))).toEqual(expected);
  });

  it("after the spend one output is consumed (prefix), the later one remains", () => {
    const expected = referenceHeuristic(parts, blockTimeOf, owned, 2500);
    expect(countHeuristicOwnedUtxos(db, { asOfBlockTime: 2500 })).toBe(expected.size);
    const got = outpointsOf(getHeuristicOwnedUtxos(db, { asOfBlockTime: 2500, limit: 100 }));
    expect(got).toEqual(expected);
  });

  it("before any output confirms the set is empty", () => {
    const expected = referenceHeuristic(parts, blockTimeOf, owned, 500);
    expect(expected.size).toBe(0);
    expect(countHeuristicOwnedUtxos(db, { asOfBlockTime: 500 })).toBe(0);
    expect(getHeuristicOwnedUtxos(db, { asOfBlockTime: 500, limit: 100 })).toHaveLength(0);
  });
});

describe("engine-core: heuristic owned-UTXO randomized parity", () => {
  it("matches the reference across many random vaults", async () => {
    // Deterministic PRNG so failures reproduce.
    let seed = 0x12345678;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = <T,>(arr: T[]) => arr[Math.floor(rnd() * arr.length)];

    for (let trial = 0; trial < 40; trial++) {
      pid = 1; // reset participant id sequence for stable per-trial ids
      const db = await freshDb();

      const addresses = ["A", "B", "C", "D"];
      const owned = new Set(addresses.filter(() => rnd() < 0.75));
      // Ensure at least one owned address so the test is meaningful.
      if (owned.size === 0) owned.add("A");

      insertRecords(
        db,
        addresses.map((a, i) =>
          rec({
            id: i + 1,
            inputString: a,
            addressImportance: owned.has(a) ? pick(["verified", "manual", "wallet-import"]) : "blockchain-discovered",
          }),
        ),
      );

      const txs: TransactionRow[] = [];
      const parts: ParticipantRow[] = [];
      const nTx = 3 + Math.floor(rnd() * 8);
      const amounts = [100, 200, 300];
      for (let t = 1; t <= nTx; t++) {
        const txid = `tx${t}`;
        // Some txs have no block time (excluded) to exercise that filter.
        const blockTime = rnd() < 0.1 ? 0 : 1000 + t * 50 + Math.floor(rnd() * 10);
        txs.push(tx(t, txid, blockTime));
        const nParts = 1 + Math.floor(rnd() * 4);
        for (let k = 0; k < nParts; k++) {
          const addr = pick(addresses);
          const amount = pick(amounts);
          if (rnd() < 0.5) {
            parts.push(out(txid, addr, k, amount));
          } else {
            parts.push(inp(txid, addr, amount, `prev${t}_${k}`, k));
          }
        }
      }
      insertTransactions(db, txs);
      insertParticipants(db, parts);

      const blockTimeOf = (txid: string) => txs.find((x) => x.txid === txid)?.blockTime ?? 0;
      const expected = referenceHeuristic(parts, blockTimeOf, owned);

      const live = outpointsOf(getHeuristicOwnedUtxos(db, { limit: 10000 }));
      expect(live, `trial ${trial} live`).toEqual(expected);
      expect(countHeuristicOwnedUtxos(db), `trial ${trial} live count`).toBe(expected.size);

      // Materialized path must agree too.
      buildHeuristicOwnedUtxos(db);
      const mat = outpointsOf(getHeuristicOwnedUtxos(db, { limit: 10000 }));
      expect(mat, `trial ${trial} materialized`).toEqual(expected);
      expect(countHeuristicOwnedUtxos(db), `trial ${trial} materialized count`).toBe(expected.size);
    }
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

describe("engine-core: transactions page / count / aggregates", () => {
  let db: BetterSqlite3EngineDb;

  beforeEach(() => {
    db = createInMemoryEngineDb();
    createSchema(db);
    // blockTime: a/c=300, b=100, d=0 (null-equivalent). b carries OP_RETURN.
    insertTransactions(db, [
      { id: 1, txid: "a", blockHeight: 1, blockTime: 300, fee: 1, feeRate: 1, vsize: 1, hasOpReturn: 0 },
      { id: 2, txid: "b", blockHeight: 2, blockTime: 100, fee: 1, feeRate: 1, vsize: 1, hasOpReturn: 1 },
      { id: 3, txid: "c", blockHeight: 3, blockTime: 300, fee: 1, feeRate: 1, vsize: 1, hasOpReturn: 0 },
      { id: 4, txid: "d", blockHeight: 4, blockTime: 0, fee: 1, feeRate: 1, vsize: 1, hasOpReturn: 0 },
    ]);
    // a: 2 outputs (100,50) + 1 input (30). b: 1 output (200). c,d: none.
    insertParticipants(db, [
      out("a", "x", 0, 100),
      out("a", "y", 1, 50),
      inp("a", "z", 30, "prev", 0),
      out("b", "x", 0, 200),
    ]);
  });

  it("counts all transactions and OP_RETURN-only", () => {
    expect(countTransactions(db)).toBe(4);
    expect(countTransactions(db, { opReturnOnly: true })).toBe(1);
  });

  it("getTransactionAggregates returns output total + role counts, omits no-participant txids", () => {
    const aggs = getTransactionAggregates(db, ["a", "b", "c"]);
    expect(aggs.get("a")).toEqual({ totalOutputValue: 150, inputCount: 1, outputCount: 2 });
    expect(aggs.get("b")).toEqual({ totalOutputValue: 200, inputCount: 0, outputCount: 1 });
    expect(aggs.has("c")).toBe(false);
  });

  it("orders newest-first (blockTime DESC, id DESC) and attaches aggregates", () => {
    const page = getTransactionPage(db, { limit: 10 });
    expect(page.map((r) => r.txid)).toEqual(["c", "a", "b", "d"]);
    const a = page.find((r) => r.txid === "a")!;
    expect(a.totalOutputValue).toBe(150);
    expect(a.inputCount).toBe(1);
    expect(a.outputCount).toBe(2);
    const d = page.find((r) => r.txid === "d")!;
    expect(d).toMatchObject({ totalOutputValue: 0, inputCount: 0, outputCount: 0 });
  });

  it("keyset cursor pages without gaps or overlaps", () => {
    const first = getTransactionPage(db, { limit: 2 });
    expect(first.map((r) => r.txid)).toEqual(["c", "a"]);
    const last = first[first.length - 1];
    const second = getTransactionPage(db, {
      limit: 2,
      cursor: { blockTime: last.blockTime ?? 0, id: last.id },
    });
    expect(second.map((r) => r.txid)).toEqual(["b", "d"]);
  });

  it("opReturnOnly filters the page", () => {
    const page = getTransactionPage(db, { limit: 10, opReturnOnly: true });
    expect(page.map((r) => r.txid)).toEqual(["b"]);
  });
});

describe("engine-core: balance group summaries", () => {
  let db: BetterSqlite3EngineDb;

  beforeEach(() => {
    db = createInMemoryEngineDb();
    createSchema(db);
    insertRecords(db, [
      rec({ id: 1, walletName: "W1", owner: "O1", tags: '["red","blue"]', cachedBalanceSats: 1000, cachedUtxoCount: 2 }),
      rec({ id: 2, walletName: "W1", owner: null, tags: '["red"]', cachedBalanceSats: 500, cachedUtxoCount: 1 }),
      rec({ id: 3, walletName: null, owner: "O2", tags: "[]", cachedBalanceSats: 200, cachedUtxoCount: 3 }),
      // Excluded: cachedUtxoCount 0.
      rec({ id: 4, walletName: "W1", owner: "O1", cachedBalanceSats: 9999, cachedUtxoCount: 0 }),
      // Excluded: not an address.
      rec({ id: 5, type: "descriptor", walletName: "W1", cachedBalanceSats: 7777, cachedUtxoCount: 5 }),
      // Excluded: blockchain-discovered counterparty rows (one-sided history —
      // their "balance" is just sats seen received). They inherit the parent's
      // wallet/owner/tags during sync, so a missing filter would silently
      // inflate the SAME groups the user's own addresses live in.
      rec({ id: 40, walletName: "W1", owner: "O1", tags: '["red"]', addressImportance: "blockchain-discovered", cachedBalanceSats: 123_456, cachedUtxoCount: 4 }),
      rec({ id: 41, walletName: "W1", owner: "O1", tags: '["red"]', addressImportance: "pending-review", cachedBalanceSats: 77_000, cachedUtxoCount: 2 }),
    ]);
  });

  it("groups by wallet with empty bucket + deduped grand totals", () => {
    const res = getBalanceGroupSummaries(db, { groupBy: "wallet" });
    const byKey = Object.fromEntries(res.summaries.map((s) => [s.groupKey, s]));
    expect(byKey["W1"]).toEqual({ groupKey: "W1", totalSats: 1500, addressCount: 2, utxoCount: 3 });
    expect(byKey["Unassigned"]).toEqual({ groupKey: "Unassigned", totalSats: 200, addressCount: 1, utxoCount: 3 });
    expect(res.totals).toEqual({ totalSats: 1700, totalAddresses: 3, totalUtxos: 6 });
  });

  it("groups by owner mapping NULL owner to Unassigned", () => {
    const byKey = Object.fromEntries(
      getBalanceGroupSummaries(db, { groupBy: "owner" }).summaries.map((s) => [s.groupKey, s]),
    );
    expect(byKey["O1"]).toMatchObject({ totalSats: 1000, addressCount: 1, utxoCount: 2 });
    expect(byKey["O2"]).toMatchObject({ totalSats: 200, addressCount: 1, utxoCount: 3 });
    expect(byKey["Unassigned"]).toMatchObject({ totalSats: 500, addressCount: 1, utxoCount: 1 });
  });

  it("expands tag arrays into multiple buckets; empty array -> Untagged; totals stay deduped", () => {
    const res = getBalanceGroupSummaries(db, { groupBy: "tag" });
    const byKey = Object.fromEntries(res.summaries.map((s) => [s.groupKey, s]));
    expect(byKey["red"]).toEqual({ groupKey: "red", totalSats: 1500, addressCount: 2, utxoCount: 3 });
    expect(byKey["blue"]).toEqual({ groupKey: "blue", totalSats: 1000, addressCount: 1, utxoCount: 2 });
    expect(byKey["Untagged"]).toEqual({ groupKey: "Untagged", totalSats: 200, addressCount: 1, utxoCount: 3 });
    expect(res.totals).toEqual({ totalSats: 1700, totalAddresses: 3, totalUtxos: 6 });
  });

  it("excludes discovered/pending-review rows while counting NULL importance as curated", () => {
    insertRecords(db, [
      // Legacy row with no importance tier at all -> counted (curated).
      { ...rec({ id: 42, walletName: "W1", cachedBalanceSats: 300, cachedUtxoCount: 1 }), addressImportance: null },
      // Unknown/future tier -> excluded: the predicate is an allowlist, so a
      // new tier stays out of balances on both engine and Dexie paths until
      // it is deliberately added to the curated set.
      rec({ id: 44, walletName: "W1", addressImportance: "some-future-tier", cachedBalanceSats: 40_000, cachedUtxoCount: 3 }),
    ]);
    const res = getBalanceGroupSummaries(db, { groupBy: "wallet" });
    const byKey = Object.fromEntries(res.summaries.map((s) => [s.groupKey, s]));
    // W1 = rec1 (1000/2) + rec2 (500/1) + legacy rec42 (300/1); the discovered
    // rows 40/41 (123456+77000 sats, 6 UTXOs) must not appear anywhere.
    expect(byKey["W1"]).toEqual({ groupKey: "W1", totalSats: 1800, addressCount: 3, utxoCount: 4 });
    expect(res.totals).toEqual({ totalSats: 2000, totalAddresses: 4, totalUtxos: 7 });
  });

  it("merges a literal 'Untagged' tag with the empty-array bucket", () => {
    insertRecords(db, [
      rec({ id: 6, tags: '["Untagged"]', cachedBalanceSats: 50, cachedUtxoCount: 1 }),
    ]);
    const byKey = Object.fromEntries(
      getBalanceGroupSummaries(db, { groupBy: "tag" }).summaries.map((s) => [s.groupKey, s]),
    );
    // rec3 (empty array) + rec6 (literal "Untagged") collapse into one bucket.
    expect(byKey["Untagged"]).toEqual({ groupKey: "Untagged", totalSats: 250, addressCount: 2, utxoCount: 4 });
  });

  it("reports staleAddressCount for address rows with stats but no cachedUtxoCount", () => {
    // The seeded fixtures are all fresh (cachedUtxoCount set or NULL without
    // statsComputedAt), so the baseline is 0.
    expect(getBalanceGroupSummaries(db, { groupBy: "wallet" }).staleAddressCount).toBe(0);
    insertRecords(db, [
      // statsComputedAt set but cachedUtxoCount NULL -> needs backfill.
      rec({ id: 7, walletName: "W1", statsComputedAt: 1234, cachedUtxoCount: null }),
      rec({ id: 8, walletName: "W2", statsComputedAt: 5678, cachedUtxoCount: null }),
      // Has both -> not stale.
      rec({ id: 9, walletName: "W1", statsComputedAt: 9999, cachedBalanceSats: 1, cachedUtxoCount: 1 }),
      // Stale-shaped but blockchain-discovered -> ignored: the balance view
      // never shows it, so it must not force the page off the engine fast path.
      rec({ id: 43, walletName: "W1", addressImportance: "blockchain-discovered", statsComputedAt: 4321, cachedUtxoCount: null }),
    ]);
    const res = getBalanceGroupSummaries(db, { groupBy: "wallet" });
    expect(res.staleAddressCount).toBe(2);
    // The stale rows (NULL cachedUtxoCount) are still excluded from summaries.
    const byKey = Object.fromEntries(res.summaries.map((s) => [s.groupKey, s]));
    expect(byKey["W2"]).toBeUndefined();
  });
});

describe("engine-core: wallet usage summaries", () => {
  let db: BetterSqlite3EngineDb;

  beforeEach(() => {
    db = createInMemoryEngineDb();
    createSchema(db);
    insertRecords(db, [
      // explicit chainType wins
      rec({ id: 1, walletName: "W", chainType: "receive", firstSeenBlockTime: 100 }), // receive, used
      rec({ id: 2, walletName: "W", chainType: "change" }), // change, not used
      // derivation-path classification (no chainType)
      rec({ id: 3, walletName: "W", derivationPath: "m/84'/0'/0'/0/5", discoveredInTxid: "tx" }), // receive, used
      rec({ id: 4, walletName: "W", derivationPath: "m/84'/0'/0'/1/7", firstSeenBlockTime: 0, discoveredInTxid: "" }), // change, NOT used (0 / "")
      rec({ id: 5, walletName: "W", derivationPath: "m/0", firstSeenBlockTime: 5 }), // <5 parts -> fallback receive, used
      // second wallet + excluded (no walletName)
      rec({ id: 6, walletName: "W2", chainType: "receive" }), // receive, not used
      rec({ id: 7, walletName: null, chainType: "change" }), // excluded
      rec({ id: 8, walletName: "", chainType: "change" }), // excluded
    ]);
  });

  it("classifies receive/change via chainType then derivation path; honours used rule", () => {
    const byWallet = Object.fromEntries(getWalletUsageSummaries(db).map((w) => [w.walletName, w]));
    expect(byWallet["W"]).toEqual({
      walletName: "W",
      receiveTotal: 3, // rec1 (chainType), rec3 (path 0), rec5 (fallback)
      receiveUsed: 3, // all three used (100, "tx", 5)
      changeTotal: 2, // rec2 (chainType), rec4 (path 1)
      changeUsed: 0, // rec2 not used, rec4 not used (0 / "")
      unknownTotal: 0,
      unknownUsed: 0,
    });
    expect(byWallet["W2"]).toEqual({
      walletName: "W2",
      receiveTotal: 1,
      receiveUsed: 0,
      changeTotal: 0,
      changeUsed: 0,
      unknownTotal: 0,
      unknownUsed: 0,
    });
    expect(Object.keys(byWallet)).toHaveLength(2);
  });

  it("JSON-escapes quotes/backslashes in derivation paths to match JS split('/')", () => {
    const edb = createInMemoryEngineDb();
    createSchema(edb);
    insertRecords(edb, [
      // Second-to-last path component is '1' (=> change) but the path contains a
      // double-quote / backslash that naive JSON construction would choke on,
      // making it wrongly fall back to 'receive'. JS split('/') still sees '1'.
      rec({ id: 1, walletName: "Q", derivationPath: `m/84"/0'/0'/1/5`, firstSeenBlockTime: 10 }),
      rec({ id: 2, walletName: "Q", derivationPath: `m/8\\4/0'/0'/1/7` }),
      // Control: a clean change path.
      rec({ id: 3, walletName: "Q", derivationPath: "m/84'/0'/0'/1/9" }),
    ]);
    const w = getWalletUsageSummaries(edb).find((x) => x.walletName === "Q")!;
    expect(w.changeTotal).toBe(3);
    expect(w.receiveTotal).toBe(0);
    expect(w.changeUsed).toBe(1); // only id 1 is "used" (firstSeenBlockTime 10)
  });
});

describe("engine-core: vault summaries", () => {
  let db: BetterSqlite3EngineDb;

  beforeEach(() => {
    db = createInMemoryEngineDb();
    createSchema(db);
    insertRecords(db, [
      rec({ id: 1, addressImportance: "xpub-derived", vaultIsVaultXpub: 1, vaultM: 2, vaultN: 3, vaultName: "Treasury", vaultNotes: '{"scriptType":"p2wsh"}' }),
      rec({ id: 2, addressImportance: "verified", vaultIsVaultXpub: 1, vaultM: 2, vaultN: 3, vaultName: "Treasury", vaultNotes: '{"scriptType":"p2wsh"}' }),
      rec({ id: 3, addressImportance: "xpub-derived", vaultIsVaultXpub: 1, vaultM: 2, vaultN: 2, vaultName: "Cold", vaultNotes: '{"scriptType":"p2sh"}' }),
      // Excluded: wrong importance tier.
      rec({ id: 4, addressImportance: "manual", vaultIsVaultXpub: 1, vaultM: 2, vaultN: 3, vaultName: "Nope" }),
      // Excluded: not a vault xpub.
      rec({ id: 5, addressImportance: "xpub-derived", vaultIsVaultXpub: null, vaultM: 2, vaultN: 3, vaultName: "Nope2" }),
      // Excluded: m is 0 (falsy).
      rec({ id: 6, addressImportance: "xpub-derived", vaultIsVaultXpub: 1, vaultM: 0, vaultN: 3, vaultName: "Nope3" }),
    ]);
  });

  it("groups vault addresses by flattened metadata with count + representative", () => {
    const vaults = getVaultSummaries(db);
    expect(vaults).toHaveLength(2);
    // Ordered by addressCount DESC -> Treasury (2) first.
    expect(vaults[0]).toMatchObject({ vaultName: "Treasury", vaultM: 2, vaultN: 3, addressCount: 2, representativeId: 1 });
    expect(vaults[1]).toMatchObject({ vaultName: "Cold", vaultM: 2, vaultN: 2, addressCount: 1, representativeId: 3 });
  });

  it("search prefilters over vaultName and raw vaultNotes (case-insensitive)", () => {
    expect(getVaultSummaries(db, { search: "cold" }).map((v) => v.vaultName)).toEqual(["Cold"]);
    expect(getVaultSummaries(db, { search: "p2wsh" }).map((v) => v.vaultName)).toEqual(["Treasury"]);
    expect(getVaultSummaries(db, { search: "treasury" }).map((v) => v.vaultName)).toEqual(["Treasury"]);
    expect(getVaultSummaries(db, { search: "nomatch" })).toHaveLength(0);
  });
});

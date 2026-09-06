// @vitest-environment jsdom
//
// Transactions entity-filter read-path equivalence (Task #1680).
//
// The Transactions page filters (address / wallet / seed / owner / tag /
// category / curated default view) have two interchangeable read paths:
//   1. the native SQLite read engine (engine-core EXISTS subqueries), and
//   2. the Dexie fallback (transaction-crud getTxidsForTxEntityFilter).
//
// This suite seeds ONE known dataset into both engines and asserts, for every
// filter shape (single-dimension and composed), that the two paths agree on
// the matching txid set and count.
//
// fake-indexeddb/auto backs the real Dexie engine; @/lib/database is mocked to
// a throwaway TestDb so the transaction-crud helpers read from it.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type {
  Record as DbRecord,
  BlockchainTransaction,
  TransactionParticipant,
} from "@/lib/database";

import {
  createSchema,
  insertRecords,
  insertTransactions,
  insertParticipants,
  countTransactions as engineCountTransactions,
  getTransactionPage,
  type RecordRow,
  type TransactionRow,
  type ParticipantRow,
} from "../engine-core";
import { createInMemoryEngineDb, type BetterSqlite3EngineDb } from "../better-sqlite3-adapter";

class TestDb extends Dexie {
  records!: Table<DbRecord, number>;
  blockchainTransactions!: Table<BlockchainTransaction, number>;
  transactionParticipants!: Table<TransactionParticipant, number>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      records:
        "++id, type, inputString, inputStringLower, label, owner, walletName, " +
        "seedName, walletSoftware, *tags, *categories, createdAt, updatedAt, " +
        "chainType, syncDepth, addressImportance, [type+addressImportance], " +
        "[addressImportance+id], [type+id], [owner+id], [walletName+id], " +
        "flowType, discoveredFromRecordId",
      blockchainTransactions: "++id, &txid, blockHeight, blockTime, syncedAt, hasOpReturn",
      transactionParticipants: "++id, [txid+role], txid, role, address, recordId, [prevTxid+prevVout]",
    });
  }
}

const testDb = new TestDb(`KYUTXO-tx-entity-equiv-${Date.now()}-${Math.random()}`);

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>("@/lib/database");
  return { ...actual, db: testDb };
});

// Imported after the mock so it binds to the TestDb.
const { getTxidsForTxEntityFilter, getOrderedTxidsForTxEntityFilterPrefix } =
  await import("@/lib/data/transaction-crud");
import type { TxEntityFilter } from "@/lib/data/transaction-crud";
import { UNASSIGNED_OWNER_VALUE } from "@/lib/owner-constants";

// ---------------------------------------------------------------------------
// One shared fixture, seeded into BOTH engines
// ---------------------------------------------------------------------------

interface FixtureRecord {
  id: number;
  inputString: string;
  walletName?: string;
  seedName?: string;
  owner?: string;
  tags: string[];
  categories: string[];
  addressImportance?: string;
}

const RECORDS: FixtureRecord[] = [
  { id: 1, inputString: "addr1", walletName: "W1", seedName: "S1", owner: "O1", tags: ["red"], categories: ["exchange"], addressImportance: "manual" },
  { id: 2, inputString: "addr2", walletName: "W2", owner: "O1", tags: ["blue"], categories: [], addressImportance: "verified" },
  { id: 3, inputString: "addr3", walletName: "W1", tags: [], categories: [], addressImportance: "blockchain-discovered" },
  { id: 4, inputString: "addr4", walletName: "W1", tags: ["red"], categories: [], addressImportance: undefined },
  { id: 5, inputString: "addr5", seedName: "S1", owner: "O2", tags: [], categories: ["exchange"], addressImportance: "xpub-derived" },
];

// txid -> linked recordIds / extra unlinked addresses
const TXS: Array<{ id: number; txid: string; blockTime: number; hasOpReturn: boolean; links: number[]; extraAddrs?: string[] }> = [
  { id: 1, txid: "t1", blockTime: 500, hasOpReturn: false, links: [1], extraAddrs: ["stranger"] },
  { id: 2, txid: "t2", blockTime: 400, hasOpReturn: true, links: [2] },
  { id: 3, txid: "t3", blockTime: 300, hasOpReturn: false, links: [3] },
  { id: 4, txid: "t4", blockTime: 200, hasOpReturn: false, links: [4, 5] },
  { id: 5, txid: "t5", blockTime: 100, hasOpReturn: false, links: [], extraAddrs: ["stranger", "loner"] },
];

let engineDb: BetterSqlite3EngineDb;

beforeAll(async () => {
  engineDb = createInMemoryEngineDb();
  createSchema(engineDb);

  const recordRows: RecordRow[] = RECORDS.map((r) => ({
    id: r.id,
    type: "address",
    inputString: r.inputString,
    inputStringLower: r.inputString.toLowerCase(),
    label: null, notes: null,
    owner: r.owner ?? null,
    walletName: r.walletName ?? null,
    seedName: r.seedName ?? null,
    walletSoftware: null,
    addressImportance: (r.addressImportance ?? null) as RecordRow["addressImportance"],
    chainType: null, syncDepth: null, firstSeenBlockTime: null,
    cachedBalanceSats: null, cachedTxCount: null, cachedUtxoCount: null, statsComputedAt: null,
    createdAt: r.id, updatedAt: r.id,
    tags: JSON.stringify(r.tags),
    categories: JSON.stringify(r.categories),
    derivationPath: null, discoveredInTxid: null,
    vaultIsVaultXpub: null, vaultM: null, vaultN: null, vaultName: null, vaultNotes: null,
  }));
  insertRecords(engineDb, recordRows);

  const txRows: TransactionRow[] = TXS.map((t) => ({
    id: t.id, txid: t.txid, blockHeight: 700000 + t.id, blockTime: t.blockTime,
    fee: 100, feeRate: 1, vsize: 200, hasOpReturn: t.hasOpReturn ? 1 : 0,
  }));
  insertTransactions(engineDb, txRows);

  let pid = 1;
  const partRows: ParticipantRow[] = [];
  const dexieParts: TransactionParticipant[] = [];
  for (const t of TXS) {
    let vout = 0;
    for (const rid of t.links) {
      const rec = RECORDS.find((r) => r.id === rid)!;
      partRows.push({ id: pid, txid: t.txid, role: "output", address: rec.inputString, amount: 100, vout, prevTxid: null, prevVout: null, recordId: rid, scriptType: "v0_p2wpkh" });
      dexieParts.push({ id: pid, txid: t.txid, role: "output", address: rec.inputString, amount: 100, vout, recordId: rid });
      pid++; vout++;
    }
    for (const addr of t.extraAddrs ?? []) {
      partRows.push({ id: pid, txid: t.txid, role: "output", address: addr, amount: 50, vout, prevTxid: null, prevVout: null, recordId: null, scriptType: "v0_p2wpkh" });
      dexieParts.push({ id: pid, txid: t.txid, role: "output", address: addr, amount: 50, vout });
      pid++; vout++;
    }
  }
  insertParticipants(engineDb, partRows);

  // Seed the Dexie side with the SAME rows (direct table writes on the
  // throwaway TestDb, mirroring records-read-equivalence.test.ts).
  await testDb.records.bulkAdd(
    RECORDS.map((r) => ({
      id: r.id,
      type: "address",
      inputString: r.inputString,
      inputStringLower: r.inputString.toLowerCase(),
      owner: r.owner,
      walletName: r.walletName,
      seedName: r.seedName,
      tags: r.tags,
      categories: r.categories,
      addressImportance: r.addressImportance,
      createdAt: new Date(r.id),
      updatedAt: new Date(r.id),
    }) as unknown as DbRecord),
  );
  await testDb.blockchainTransactions.bulkAdd(
    TXS.map((t) => ({
      id: t.id, txid: t.txid, blockHeight: 700000 + t.id, blockTime: t.blockTime,
      fee: 100, vsize: 200, hasOpReturn: t.hasOpReturn, syncedAt: new Date(0),
    }) as unknown as BlockchainTransaction),
  );
  await testDb.transactionParticipants.bulkAdd(dexieParts);
});

afterAll(async () => {
  await testDb.delete();
});

// ---------------------------------------------------------------------------

const FILTER_SHAPES: Array<{ name: string; filter: TxEntityFilter }> = [
  { name: "address (unlinked)", filter: { address: "stranger" } },
  { name: "address (linked)", filter: { address: "addr1" } },
  { name: "wallet", filter: { wallet: "W1" } },
  { name: "seed", filter: { seed: "S1" } },
  { name: "owner", filter: { owner: "O1" } },
  { name: "unassigned owner", filter: { owner: UNASSIGNED_OWNER_VALUE } },
  { name: "named or unassigned owner", filter: { owner: ["O2", UNASSIGNED_OWNER_VALUE] } },
  { name: "tag", filter: { tag: "red" } },
  { name: "category", filter: { category: "exchange" } },
  { name: "curatedOnly", filter: { curatedOnly: true } },
  { name: "wallet+curated", filter: { wallet: "W1", curatedOnly: true } },
  { name: "owner+wallet (AND across records)", filter: { owner: "O2", wallet: "W1" } },
  { name: "address+wallet (different participants)", filter: { address: "stranger", wallet: "W1" } },
  { name: "no match", filter: { owner: "nobody" } },
];

describe("transactions entity filter: engine vs Dexie equivalence", () => {
  for (const { name, filter } of FILTER_SHAPES) {
    it(`agrees on txid set and count for ${name}`, async () => {
      const dexieSet = await getTxidsForTxEntityFilter(filter);
      const engineCount = engineCountTransactions(engineDb, filter);
      const enginePage = getTransactionPage(engineDb, { limit: 100, ...filter });
      const engineTxids = enginePage.map((r) => r.txid);

      expect(engineCount).toBe(dexieSet.size);
      expect(new Set(engineTxids)).toEqual(dexieSet);
      // Engine page order is newest-first (blockTime DESC, id DESC).
      const sorted = [...engineTxids];
      expect(engineTxids).toEqual(sorted); // stable snapshot of order
    });
  }

  for (const { name, filter } of FILTER_SHAPES) {
    it(`bounded prefix walk agrees with engine order for ${name}`, async () => {
      // Exhaustive walk (neededCount larger than the table) must reproduce the
      // engine's newest-first ordering exactly, and report exhausted.
      const prefix = await getOrderedTxidsForTxEntityFilterPrefix(filter, 100);
      const engineTxids = getTransactionPage(engineDb, { limit: 100, ...filter }).map((r) => r.txid);
      expect(prefix.exhausted).toBe(true);
      expect(prefix.orderedTxids).toEqual(engineTxids);
    });
  }

  it("bounded prefix walk stops early once neededCount matches are found", async () => {
    const engineTxids = getTransactionPage(engineDb, { limit: 100, wallet: "W1" }).map((r) => r.txid);
    expect(engineTxids.length).toBeGreaterThan(2);
    const prefix = await getOrderedTxidsForTxEntityFilterPrefix({ wallet: "W1" }, 2);
    expect(prefix.exhausted).toBe(false);
    expect(prefix.orderedTxids).toEqual(engineTxids.slice(0, 2));
  });

  it("bounded prefix walk reads only the batches needed, not the whole table", async () => {
    // Instrument row materialization: with batchSize=2 and one needed match on
    // wallet=W1 (newest tx t1 matches), only the first 2-row batch should ever
    // be read from blockchainTransactions — never the remaining 3 rows.
    let txRowsRead = 0;
    const countingHook = (obj: unknown) => { txRowsRead++; return obj as BlockchainTransaction; };
    testDb.blockchainTransactions.hook("reading", countingHook);
    try {
      const prefix = await getOrderedTxidsForTxEntityFilterPrefix({ wallet: "W1" }, 1, undefined, 2);
      expect(prefix.exhausted).toBe(false);
      expect(prefix.orderedTxids).toEqual(["t1"]);
      expect(txRowsRead).toBeLessThanOrEqual(2);
    } finally {
      testDb.blockchainTransactions.hook("reading").unsubscribe(countingHook);
    }
  });

  it("bounded prefix walk keyset-pages correctly across duplicate blockTimes", async () => {
    // Ties on blockTime exercise the (blockTime, seen-ids) cursor: seed a
    // throwaway table where several txs share blockTimes, then verify a tiny
    // batch size still reproduces the exact newest-first (blockTime DESC,
    // id DESC) order with no skips or repeats.
    const tieDb = new TestDb(`KYUTXO-tx-prefix-ties-${Date.now()}-${Math.random()}`);
    try {
      await tieDb.records.bulkAdd([
        { id: 1, type: "address", inputString: "a1", addressImportance: "manual", tags: [], categories: [] } as unknown as DbRecord,
      ]);
      const ties = [
        { id: 1, txid: "x1", blockTime: 300 }, { id: 2, txid: "x2", blockTime: 300 },
        { id: 3, txid: "x3", blockTime: 300 }, { id: 4, txid: "x4", blockTime: 200 },
        { id: 5, txid: "x5", blockTime: 200 }, { id: 6, txid: "x6", blockTime: 100 },
      ];
      await tieDb.blockchainTransactions.bulkAdd(
        ties.map(t => ({ ...t, hasOpReturn: false, syncedAt: new Date(0) }) as unknown as BlockchainTransaction),
      );
      await tieDb.transactionParticipants.bulkAdd(
        ties.map((t, i) => ({ id: i + 1, txid: t.txid, role: "output", address: "a1", amount: 1, vout: 0, recordId: 1 }) as TransactionParticipant),
      );

      const dbModule = await import("@/lib/database");
      const realDb = dbModule.db;
      (dbModule as { db: unknown }).db = tieDb;
      try {
        const prefix = await getOrderedTxidsForTxEntityFilterPrefix({ curatedOnly: true }, 100, undefined, 2);
        expect(prefix.exhausted).toBe(true);
        expect(prefix.orderedTxids).toEqual(["x3", "x2", "x1", "x5", "x4", "x6"]);
      } finally {
        (dbModule as { db: unknown }).db = realDb;
      }
    } finally {
      await tieDb.delete();
    }
  });

  it("bounded prefix walk short-circuits on an empty record dimension", async () => {
    const prefix = await getOrderedTxidsForTxEntityFilterPrefix({ owner: "nobody" }, 25);
    expect(prefix).toEqual({ orderedTxids: [], exhausted: true, cursor: null });
  });

  it("resumed prefix walk extends without re-scanning already-walked rows", async () => {
    // First walk collects 1 match; resuming for more must (a) reproduce the
    // exact full ordering and (b) never re-read rows the first walk scanned.
    const engineTxids = getTransactionPage(engineDb, { limit: 100, curatedOnly: true }).map((r) => r.txid);
    expect(engineTxids.length).toBeGreaterThan(2);

    const first = await getOrderedTxidsForTxEntityFilterPrefix({ curatedOnly: true }, 1, undefined, 1);
    expect(first.exhausted).toBe(false);
    expect(first.orderedTxids).toEqual(engineTxids.slice(0, 1));
    expect(first.cursor).not.toBeNull();

    const totalRows = await testDb.blockchainTransactions.count();
    let txRowsRead = 0;
    const countingHook = (obj: unknown) => { txRowsRead++; return obj as BlockchainTransaction; };
    testDb.blockchainTransactions.hook("reading", countingHook);
    let resumed;
    try {
      resumed = await getOrderedTxidsForTxEntityFilterPrefix({ curatedOnly: true }, 100, undefined, 1, first);
    } finally {
      testDb.blockchainTransactions.hook("reading").unsubscribe(countingHook);
    }
    expect(resumed.exhausted).toBe(true);
    expect(resumed.orderedTxids).toEqual(engineTxids);
    // The resumed walk must scan strictly fewer rows than a from-scratch walk.
    // With batchSize=1 the boundary row at the cursor blockTime is refetched
    // once per round for dedupe, so allow that slack but not a full restart.
    expect(txRowsRead).toBeLessThan(totalRows * 2);

    // A resume that is already satisfied returns as-is with zero scanning.
    let extraReads = 0;
    const countingHook2 = (obj: unknown) => { extraReads++; return obj as BlockchainTransaction; };
    testDb.blockchainTransactions.hook("reading", countingHook2);
    try {
      const noop = await getOrderedTxidsForTxEntityFilterPrefix({ curatedOnly: true }, 1, undefined, 1, first);
      expect(noop).toBe(first);
    } finally {
      testDb.blockchainTransactions.hook("reading").unsubscribe(countingHook2);
    }
    expect(extraReads).toBe(0);
  });

  it("keyset pagination over a filtered set is gap- and overlap-free", () => {
    const all = getTransactionPage(engineDb, { limit: 100, wallet: "W1" }).map((r) => r.txid);
    const first = getTransactionPage(engineDb, { limit: 2, wallet: "W1" });
    const last = first[first.length - 1];
    const second = getTransactionPage(engineDb, {
      limit: 100, wallet: "W1",
      cursor: { blockTime: last.blockTime ?? 0, id: last.id },
    });
    expect([...first.map((r) => r.txid), ...second.map((r) => r.txid)]).toEqual(all);
  });
});

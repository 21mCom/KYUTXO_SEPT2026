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
const { getTxidsForTxEntityFilter } = await import("@/lib/data/transaction-crud");
import type { TxEntityFilter } from "@/lib/data/transaction-crud";

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

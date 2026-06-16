// @vitest-environment jsdom
//
// Runtime SCALE GUARD: proves the headline read helpers stay BOUNDED — they
// never materialise the whole table into memory regardless of how large the
// dataset grows. This is the regression that froze the real vault: helpers that
// loaded everything then sliced.
//
// How it works: after seeding N rows we wrap Dexie's Table/Collection `toArray`
// to count exactly how many rows each helper pulls into JS. A bounded helper
// pulls O(pageSize); an unbounded one pulls O(N). The `getAllTransactions`
// NEGATIVE CONTROL deliberately loads everything, proving the instrument can
// actually tell the two apart.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type {
  Record as DbRecord,
  BlockchainTransaction,
  TransactionParticipant,
} from "@/lib/database";

const RECORDS_SCHEMA =
  "++id, type, inputString, inputStringLower, label, owner, walletName, " +
  "seedName, walletSoftware, *tags, *categories, createdAt, updatedAt, " +
  "chainType, syncDepth, addressImportance, [type+addressImportance], " +
  "[addressImportance+id], [type+id], [owner+id], [walletName+id], " +
  "flowType, discoveredFromRecordId";

class TestDb extends Dexie {
  records!: Table<DbRecord, number>;
  blockchainTransactions!: Table<BlockchainTransaction, number>;
  transactionParticipants!: Table<TransactionParticipant, number>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      records: RECORDS_SCHEMA,
      blockchainTransactions: "++id, &txid, blockHeight, blockTime, syncedAt, hasOpReturn",
      transactionParticipants: "++id, [txid+role], txid, role, address, recordId, [prevTxid+prevVout]",
    });
  }
}

const testDb = new TestDb(`KYUTXO-scale-runtime-${Date.now()}-${Math.random()}`);

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>("@/lib/database");
  return { ...actual, db: testDb };
});

const {
  countTransactions,
  countTransactionParticipants,
  getTransactionsPageByBlockTime,
  getParticipantsByRecordIds,
  getAllTransactions,
} = await import("./data/transaction-crud");
const { getRecordsPageByIdReverseKeyset, countRecords } = await import("./data/record-crud");

// Dataset large enough that "load everything" is unmistakably different from a
// single page. Kept modest so the suite stays fast under fake-indexeddb.
const N_TX = 3000;
const N_PART = 3000;
const N_REC = 300;
const PAGE = 50;

// ---- toArray instrumentation ----------------------------------------------

let rowsMaterialized = 0;
let tableProto: any;
let collProto: any;
let origTableToArray: any;
let origCollToArray: any;

function measure<T>(fn: () => Promise<T>): Promise<T> {
  rowsMaterialized = 0;
  return fn();
}

beforeAll(async () => {
  const txRows: BlockchainTransaction[] = [];
  for (let i = 0; i < N_TX; i++) {
    txRows.push({
      txid: i.toString(16).padStart(64, "0"),
      blockHeight: Math.floor(i / 3),
      blockTime: 1_231_006_505 + i * 600,
      syncedAt: 1,
      hasOpReturn: false,
    } as unknown as BlockchainTransaction);
  }
  await testDb.blockchainTransactions.bulkAdd(txRows);

  const recRows: DbRecord[] = [];
  for (let i = 1; i <= N_REC; i++) {
    const inputString = `addr-${String(i).padStart(5, "0")}`;
    recRows.push({
      type: "address",
      inputString,
      inputStringLower: inputString,
      label: `r${i}`,
      tags: [],
      categories: [],
      addressImportance: "manual",
      createdAt: 1000 + i,
      updatedAt: 1000 + i,
    } as unknown as DbRecord);
  }
  await testDb.records.bulkAdd(recRows);

  const partRows: TransactionParticipant[] = [];
  for (let i = 0; i < N_PART; i++) {
    partRows.push({
      txid: (i % N_TX).toString(16).padStart(64, "0"),
      role: i % 2 === 0 ? "input" : "output",
      address: `addr-${String((i % N_REC) + 1).padStart(5, "0")}`,
      recordId: (i % N_REC) + 1,
    } as unknown as TransactionParticipant);
  }
  await testDb.transactionParticipants.bulkAdd(partRows);

  // Patch AFTER seeding so the bulk inserts don't pollute the counter. Both
  // prototypes are shared across all tables/collections of this Dexie instance.
  tableProto = Object.getPrototypeOf(testDb.blockchainTransactions);
  collProto = Object.getPrototypeOf(testDb.blockchainTransactions.toCollection());
  origTableToArray = tableProto.toArray;
  origCollToArray = collProto.toArray;
  tableProto.toArray = async function (...args: any[]) {
    const r = await origTableToArray.apply(this, args);
    if (Array.isArray(r)) rowsMaterialized += r.length;
    return r;
  };
  collProto.toArray = async function (...args: any[]) {
    const r = await origCollToArray.apply(this, args);
    if (Array.isArray(r)) rowsMaterialized += r.length;
    return r;
  };
});

afterAll(async () => {
  if (tableProto) tableProto.toArray = origTableToArray;
  if (collProto) collProto.toArray = origCollToArray;
  testDb.close();
  await Dexie.delete(testDb.name);
});

describe("paginated reads stay bounded by page size", () => {
  it("getTransactionsPageByBlockTime pulls one page, not the table", async () => {
    const page = await measure(() => getTransactionsPageByBlockTime(0, PAGE));
    expect(page).toHaveLength(PAGE);
    expect(rowsMaterialized).toBeLessThanOrEqual(PAGE * 2);
    expect(rowsMaterialized).toBeLessThan(N_TX);
  });

  it("getRecordsPageByIdReverseKeyset pulls one page, not the table", async () => {
    const page = await measure(() => getRecordsPageByIdReverseKeyset({ limit: PAGE }));
    expect(page).toHaveLength(PAGE);
    expect(rowsMaterialized).toBeLessThanOrEqual(PAGE * 2);
    expect(rowsMaterialized).toBeLessThan(N_REC);
  });

  it("getParticipantsByRecordIds uses an index, materialising only matches", async () => {
    const wanted = [1, 2, 3];
    const rows = await measure(() => getParticipantsByRecordIds(wanted));
    for (const r of rows) expect(wanted).toContain(r.recordId);
    // Only matching rows are pulled, far fewer than the whole participant table.
    expect(rowsMaterialized).toBe(rows.length);
    expect(rowsMaterialized).toBeLessThan(N_PART);
  });
});

describe("counts must not load rows", () => {
  it("countTransactions materialises zero rows", async () => {
    const n = await measure(() => countTransactions());
    expect(n).toBe(N_TX);
    expect(rowsMaterialized).toBe(0);
  });

  it("countTransactionParticipants materialises zero rows", async () => {
    const n = await measure(() => countTransactionParticipants());
    expect(n).toBe(N_PART);
    expect(rowsMaterialized).toBe(0);
  });

  it("countRecords materialises zero rows", async () => {
    const n = await measure(() => countRecords());
    expect(n).toBe(N_REC);
    expect(rowsMaterialized).toBe(0);
  });
});

describe("negative control proves the instrument detects unbounded loads", () => {
  it("getAllTransactions materialises the entire table", async () => {
    const all = await measure(() => getAllTransactions());
    expect(all).toHaveLength(N_TX);
    // The whole table is pulled into memory — exactly what the paginated helpers
    // above must never do.
    expect(rowsMaterialized).toBeGreaterThanOrEqual(N_TX);
  });
});

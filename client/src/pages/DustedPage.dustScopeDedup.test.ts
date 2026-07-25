// @vitest-environment jsdom
//
// Regression tests for the Dusted scan's scope filtering when the same address
// belongs to multiple wallet groups (multiple tags or multiple categories).
//
// The scan builds a per-address map keyed by the address string, so an address
// must appear at most ONCE in the results regardless of how many tags or
// categories it carries — and only when the selected scope value is actually
// one of its group keys.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type {
  Record as DbRecord,
  BlockchainTransaction,
  TransactionParticipant,
} from "@/lib/database";

// ---- In-memory DB ----------------------------------------------------------

class TestDb extends Dexie {
  records!: Table<DbRecord, number>;
  blockchainTransactions!: Table<BlockchainTransaction, number>;
  transactionParticipants!: Table<TransactionParticipant, number>;
  settings!: Table<{ id: string } & Record<string, unknown>, string>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      records:
        "++id, type, inputString, inputStringLower, label, owner, walletName, " +
        "seedName, walletSoftware, *tags, *categories, createdAt, updatedAt, " +
        "syncDepth, addressImportance, [type+addressImportance], [type+id], discoveredFromRecordId",
      blockchainTransactions:
        "++id, &txid, blockHeight, blockTime, syncedAt, hasOpReturn",
      transactionParticipants:
        "++id, [txid+role], txid, role, address, recordId, [prevTxid+prevVout]",
      settings: "id",
    });
  }
}

const testDb = new TestDb(`KYUTXO-dust-scope-${Date.now()}-${Math.random()}`);

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return { ...actual, db: testDb };
});

const { computeDustings } = await import("./DustedPage");

// ---- Fixtures --------------------------------------------------------------

const ADDR_MULTI = "bc1qmultitag0000000000000000000000000000";
const ADDR_OTHER = "bc1qothertag0000000000000000000000000000";
const TXID_DUST = "d".repeat(64);
const THRESHOLD = 1000;

function makeAddressRecord(
  inputString: string,
  extra: Partial<DbRecord> = {},
): DbRecord {
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
    ...extra,
  } as unknown as DbRecord;
}

/** Seed one unspent dust output paying `address`. */
async function seedDustOutput(address: string, vout: number) {
  await testDb.transactionParticipants.add({
    txid: TXID_DUST,
    role: "output",
    address,
    amount: 500, // below threshold → dust
    vout,
  } as TransactionParticipant);
}

function noSignal(): AbortSignal {
  return new AbortController().signal;
}

const noop = () => {};

beforeEach(async () => {
  await testDb.records.clear();
  await testDb.transactionParticipants.clear();
  await testDb.blockchainTransactions.clear();
});

// ---- Tests -----------------------------------------------------------------

describe("Dusted scan scope dedup", () => {
  it("counts an address with multiple tags exactly once when scoped to one of its tags", async () => {
    await testDb.records.add(
      makeAddressRecord(ADDR_MULTI, { tags: ["exchange", "personal", "cold"] }),
    );
    await seedDustOutput(ADDR_MULTI, 0);

    const outcome = await computeDustings(
      "tag",
      "personal",
      THRESHOLD,
      noSignal(),
      noop,
    );

    expect(outcome).not.toBeNull();
    const hits = outcome!.results.filter((r) => r.address === ADDR_MULTI);
    expect(hits).toHaveLength(1);
    expect(hits[0].totalCount).toBe(1);
    expect(hits[0].unspentCount).toBe(1);
    // scanned exactly once too
    expect(outcome!.scannedAddresses.has(ADDR_MULTI)).toBe(true);
    expect(outcome!.scannedAddresses.size).toBe(1);
  });

  it("excludes a multi-tag address when scoped to a tag it does not hold", async () => {
    await testDb.records.add(
      makeAddressRecord(ADDR_MULTI, { tags: ["exchange", "personal"] }),
    );
    await seedDustOutput(ADDR_MULTI, 0);

    const outcome = await computeDustings(
      "tag",
      "mining",
      THRESHOLD,
      noSignal(),
      noop,
    );

    expect(outcome).not.toBeNull();
    expect(outcome!.results).toHaveLength(0);
    expect(outcome!.scannedAddresses.size).toBe(0);
  });

  it("counts an address with multiple categories exactly once when scoped to one of its categories", async () => {
    await testDb.records.add(
      makeAddressRecord(ADDR_MULTI, {
        categories: ["savings", "trading", "donations"],
      }),
    );
    // A second address in only ONE of the same categories, as a control.
    await testDb.records.add(
      makeAddressRecord(ADDR_OTHER, { categories: ["trading"] }),
    );
    await seedDustOutput(ADDR_MULTI, 0);
    await seedDustOutput(ADDR_OTHER, 1);

    const outcome = await computeDustings(
      "category",
      "trading",
      THRESHOLD,
      noSignal(),
      noop,
    );

    expect(outcome).not.toBeNull();
    expect(outcome!.results).toHaveLength(2);
    const multiHits = outcome!.results.filter((r) => r.address === ADDR_MULTI);
    expect(multiHits).toHaveLength(1);
    expect(multiHits[0].totalCount).toBe(1);
    expect(outcome!.scannedAddresses.size).toBe(2);
  });

  it("does not leak a multi-category address into a different grouping dimension's scope", async () => {
    // Address has tag "trading" but NOT category "trading" — scoping by
    // category "trading" must not match it via its tag.
    await testDb.records.add(
      makeAddressRecord(ADDR_MULTI, {
        tags: ["trading"],
        categories: ["savings"],
      }),
    );
    await seedDustOutput(ADDR_MULTI, 0);

    const outcome = await computeDustings(
      "category",
      "trading",
      THRESHOLD,
      noSignal(),
      noop,
    );

    expect(outcome).not.toBeNull();
    expect(outcome!.results).toHaveLength(0);
    expect(outcome!.scannedAddresses.size).toBe(0);
  });

  it("counts multiple dust outputs to the same multi-tag address as one address row", async () => {
    await testDb.records.add(
      makeAddressRecord(ADDR_MULTI, { tags: ["a", "b"] }),
    );
    await seedDustOutput(ADDR_MULTI, 0);
    await seedDustOutput(ADDR_MULTI, 1);
    await seedDustOutput(ADDR_MULTI, 2);

    const outcome = await computeDustings(
      "tag",
      "b",
      THRESHOLD,
      noSignal(),
      noop,
    );

    expect(outcome).not.toBeNull();
    expect(outcome!.results).toHaveLength(1);
    expect(outcome!.results[0].totalCount).toBe(3);
    expect(outcome!.results[0].unspentCount).toBe(3);
  });
});

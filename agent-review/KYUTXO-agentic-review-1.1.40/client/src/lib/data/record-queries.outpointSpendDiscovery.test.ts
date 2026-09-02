// @vitest-environment jsdom
//
// Task: Electrum-synced spend transactions must not be missing from tx-set
// discovery. Electrum-synced spend inputs are stored with a BLANK address
// (only prevTxid/prevVout), so a pure address-keyed participant load never
// returns them, and a spend tx whose only link to an owned address is such
// an input becomes invisible.
//
// Covers:
//   1. getParticipantsByAddressesWithOutpointSpends() — the shared helper —
//      merges blank-address outpoint spend inputs into the address-keyed
//      participant set (deduped by id) and returns them.
//   2. runAmlScreening() (proof-of-funds AML screening) reaches a flagged
//      counterparty that is only connected via a blank-address spend input.
//   3. scanForLightningActivity() includes the blank-address spend tx in its
//      candidate set.
//
// Uses the real Dexie engine (via fake-indexeddb), mirroring the data-layer
// test pattern in transaction-crud.unresolved-spends.test.ts.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type { Record as DbRecord, BlockchainTransaction } from "@/lib/database";
import type { TransactionParticipant } from "@/lib/db-types";

class TestDb extends Dexie {
  records!: Table<DbRecord, number>;
  transactionParticipants!: Table<TransactionParticipant, number>;
  blockchainTransactions!: Table<BlockchainTransaction, number>;
  constructor(name: string) {
    super(name);
    // Mirrors the live schema indexes used by the queries under test.
    this.version(1).stores({
      records:
        "++id, type, inputString, inputStringLower, label, owner, walletName, " +
        "*tags, *categories, createdAt, updatedAt",
      transactionParticipants:
        "++id, [txid+role], txid, role, address, recordId, [prevTxid+prevVout]",
      blockchainTransactions:
        "++id, &txid, blockHeight, blockTime, syncedAt, hasOpReturn",
    });
  }
}

let testDb: TestDb;

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return {
    ...actual,
    get db() {
      return testDb;
    },
    notifyDbChange: vi.fn(),
  };
});

// AML screening pulls the entity list + settings snapshot; stub both so the
// test controls which counterparty address is "flagged" without touching
// the bundled list machinery.
const flaggedAddresses = new Set<string>();
vi.mock("@/lib/privacy-entity-list", () => ({
  lookupEntities: (addresses: string[]) => {
    const map = new Map<string, { name: string; category: string; sourceNote?: string }>();
    for (const a of addresses) {
      if (flaggedAddresses.has(a)) {
        map.set(a, { name: "Bad Exchange", category: "sanctioned" });
      }
    }
    return map;
  },
  getActiveEntityCount: () => flaggedAddresses.size,
  getActiveEntitySource: () => "bundled" as const,
  ENTITY_CATEGORY_LABELS: new Proxy({}, { get: (_t, k) => String(k) }),
}));

vi.mock("@/lib/data/settings-crud", () => ({
  getSettings: async () => ({}),
}));

const { getParticipantsByAddressesWithOutpointSpends } = await import(
  "./record-queries"
);
const { runAmlScreening } = await import(
  "@/pages/proof-of-funds/aml-screening"
);
const { scanForLightningActivity } = await import("@/lib/lightning-detection");

// ---- Fixtures --------------------------------------------------------------

const OWNED_ADDR = "bc1q-owned-electrum-addr";
const COUNTERPARTY_ADDR = "bc1q-counterparty-addr";
const FUND_TXID = "fund".padEnd(64, "0");
const SPEND_TXID = "spend".padEnd(64, "1");

/** Seed an Electrum-style vault:
 *  - FUND_TXID pays an output to OWNED_ADDR (vout 0)
 *  - SPEND_TXID spends that output via a BLANK-address input (only
 *    prevTxid/prevVout) and pays COUNTERPARTY_ADDR — the spend tx's only
 *    link to the owned address is the blank-address input.
 */
async function seedElectrumSpendFixture() {
  await testDb.transactionParticipants.bulkAdd([
    // Funding output to the owned address (address-keyed load finds this).
    { txid: FUND_TXID, role: "output", address: OWNED_ADDR, amount: 50_000, vout: 0 },
    // Electrum-synced blank-address spend input of that outpoint.
    {
      txid: SPEND_TXID,
      role: "input",
      address: "",
      amount: 50_000,
      prevTxid: FUND_TXID,
      prevVout: 0,
    },
    // Spend output to the counterparty.
    { txid: SPEND_TXID, role: "output", address: COUNTERPARTY_ADDR, amount: 49_000, vout: 0 },
  ]);
}

beforeEach(() => {
  testDb = new TestDb(`KYUTXO-outpoint-discovery-${Date.now()}-${Math.random()}`);
  flaggedAddresses.clear();
});

afterEach(async () => {
  await testDb.delete();
});

// ---- Helper ----------------------------------------------------------------

describe("getParticipantsByAddressesWithOutpointSpends", () => {
  it("includes blank-address spend inputs of owned outputs", async () => {
    await seedElectrumSpendFixture();

    const parts = await getParticipantsByAddressesWithOutpointSpends([OWNED_ADDR]);
    const txids = new Set(parts.map((p) => p.txid));
    expect(txids.has(FUND_TXID)).toBe(true);
    expect(txids.has(SPEND_TXID)).toBe(true);

    const spendInput = parts.find((p) => p.txid === SPEND_TXID);
    expect(spendInput?.role).toBe("input");
    expect(spendInput?.address).toBe("");
  });

  it("does not duplicate spend inputs already found by address", async () => {
    // A non-Electrum spend input that DOES carry the owned address.
    await testDb.transactionParticipants.bulkAdd([
      { txid: FUND_TXID, role: "output", address: OWNED_ADDR, amount: 1000, vout: 0 },
      {
        txid: SPEND_TXID,
        role: "input",
        address: OWNED_ADDR,
        amount: 1000,
        prevTxid: FUND_TXID,
        prevVout: 0,
      },
    ]);

    const parts = await getParticipantsByAddressesWithOutpointSpends([OWNED_ADDR]);
    const spendRows = parts.filter((p) => p.txid === SPEND_TXID);
    expect(spendRows).toHaveLength(1);
  });

  it("returns [] for empty input and skips foreign outpoints", async () => {
    await testDb.transactionParticipants.bulkAdd([
      // Spend of an outpoint we do NOT own — must not be pulled in.
      {
        txid: SPEND_TXID,
        role: "input",
        address: "",
        amount: 1,
        prevTxid: "other".padEnd(64, "2"),
        prevVout: 0,
      },
      { txid: FUND_TXID, role: "output", address: OWNED_ADDR, amount: 1000, vout: 0 },
    ]);

    expect(await getParticipantsByAddressesWithOutpointSpends([])).toEqual([]);
    const parts = await getParticipantsByAddressesWithOutpointSpends([OWNED_ADDR]);
    expect(parts.map((p) => p.txid)).toEqual([FUND_TXID]);
  });
});

// ---- AML screening ----------------------------------------------------------

describe("runAmlScreening with an Electrum blank-address spend", () => {
  it("finds a flagged counterparty reachable only via the blank-address input", async () => {
    await seedElectrumSpendFixture();
    flaggedAddresses.add(COUNTERPARTY_ADDR);

    const result = await runAmlScreening([OWNED_ADDR]);

    expect(result.hasGraphData).toBe(true);
    // The counterparty sits 1 hop away, but only through SPEND_TXID whose
    // sole link to OWNED_ADDR is a blank-address input.
    expect(result.nearestHopEntityName).toBe("Bad Exchange");
    expect(result.nearestHopDistance).toBe(1);
  });
});

// ---- Lightning detection ------------------------------------------------------

describe("scanForLightningActivity with an Electrum blank-address spend", () => {
  it("analyzes the spend tx even though its only owned link is a blank-address input", async () => {
    await seedElectrumSpendFixture();
    await testDb.records.add({
      type: "address",
      inputString: OWNED_ADDR,
      label: OWNED_ADDR,
      tags: [],
      categories: [],
      createdAt: 1000,
      updatedAt: 1000,
    } as unknown as DbRecord);
    await testDb.blockchainTransactions.bulkAdd([
      { txid: FUND_TXID, blockHeight: 100, blockTime: 1_700_000_000, syncedAt: 1 },
      { txid: SPEND_TXID, blockHeight: 101, blockTime: 1_700_000_600, syncedAt: 1 },
    ] as unknown as BlockchainTransaction[]);

    // minProbability 0 keeps every analyzed candidate in the result set, so
    // the assertion is purely about tx-set discovery, not signal strength.
    const results = await scanForLightningActivity({ minProbability: 0 });
    const txids = results.map((r) => r.txid);
    expect(txids).toContain(SPEND_TXID);
  });
});

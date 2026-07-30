// @vitest-environment jsdom
//
// Task: reports and privacy views must not miss Electrum-synced spend
// transactions. Electrum-synced spend inputs are stored with a BLANK address
// (only prevTxid/prevVout), so a pure address-keyed participant load never
// returns them, and a spend tx whose only link to an owned address is such an
// input becomes invisible.
//
// Covers the surfaces switched to outpoint-aware discovery:
//   1. runPrivacyAudit() (privacy-audit.ts) — the spend tx enters the audit
//      context and blank inputs are attributed to the owning address.
//   2. runAdversaryView() (adversary-view.ts) — blank co-spend inputs are
//      attributed, so CIO clustering exposes the co-spending owned addresses.
//   3. analyzeAddressReuse() (pages/AddressReuse.tsx) — a blank-input spend
//      with change back to the owned address counts as change-to-self reuse.
//   4. computeAddressFlowStats() (pages/BitcoinFlowVisualizer.tsx) — the spent
//      amount is subtracted from the owning address's balance.
//
// Fixture pattern mirrors record-queries.outpointSpendDiscovery.test.ts.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type { Record as DbRecord, BlockchainTransaction } from "@/lib/database";
import type { TransactionParticipant } from "@/lib/db-types";

interface DustFlagRow {
  id?: number;
  outpoint: string;
  txid: string;
  address: string;
  markedAt: number;
}

class TestDb extends Dexie {
  records!: Table<DbRecord, number>;
  transactionParticipants!: Table<TransactionParticipant, number>;
  blockchainTransactions!: Table<BlockchainTransaction, number>;
  dustFlags!: Table<DustFlagRow, number>;
  constructor(name: string) {
    super(name);
    // Mirrors the live schema indexes used by the queries under test.
    this.version(1).stores({
      records:
        "++id, type, inputString, inputStringLower, label, owner, walletName, " +
        "addressImportance, *tags, *categories, createdAt, updatedAt",
      transactionParticipants:
        "++id, [txid+role], txid, role, address, recordId, [prevTxid+prevVout]",
      blockchainTransactions:
        "++id, &txid, blockHeight, blockTime, syncedAt, hasOpReturn",
      dustFlags: "++id, &outpoint, txid, address, markedAt",
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

// privacy-audit pulls the entity list; stub it so no entity findings interfere.
vi.mock("@/lib/privacy-entity-list", () => ({
  lookupEntities: () => new Map(),
  getActiveEntityCount: () => 0,
  getActiveEntitySource: () => "bundled" as const,
  ENTITY_CATEGORY_TAG_NAMES: new Proxy({}, { get: (_t, k) => String(k) }),
  ENTITY_CATEGORY_LABELS: new Proxy({}, { get: (_t, k) => String(k) }),
  ENTITY_CATEGORY_COLORS: new Proxy({}, { get: (_t, k) => String(k) }),
}));

const { runPrivacyAudit } = await import("@/lib/privacy-audit");
const { runAdversaryView } = await import("@/lib/adversary-view");
const { analyzeAddressReuse } = await import("@/pages/AddressReuse");
const { computeAddressFlowStats } = await import(
  "@/pages/BitcoinFlowVisualizer"
);

// ---- Fixtures --------------------------------------------------------------

const OWNED_ADDR = "bc1q-owned-electrum-addr";
const OWNED_ADDR_2 = "bc1q-owned-electrum-addr2";
const COUNTERPARTY_ADDR = "bc1q-counterparty-addr";
const FUND_TXID = "fund".padEnd(64, "0");
const FUND_TXID_2 = "fund".padEnd(64, "3");
const SPEND_TXID = "spend".padEnd(64, "1");

/** Seed an Electrum-style vault:
 *  - FUND_TXID pays an output to OWNED_ADDR (vout 0)
 *  - SPEND_TXID spends that output via a BLANK-address input (only
 *    prevTxid/prevVout) and pays COUNTERPARTY_ADDR — the spend tx's only
 *    link to the owned address is the blank-address input.
 */
async function seedElectrumSpendFixture() {
  await testDb.transactionParticipants.bulkAdd([
    { txid: FUND_TXID, role: "output", address: OWNED_ADDR, amount: 50_000, vout: 0 },
    {
      txid: SPEND_TXID,
      role: "input",
      address: "",
      amount: 50_000,
      prevTxid: FUND_TXID,
      prevVout: 0,
    },
    { txid: SPEND_TXID, role: "output", address: COUNTERPARTY_ADDR, amount: 49_000, vout: 0 },
  ]);
  await testDb.blockchainTransactions.bulkAdd([
    { txid: FUND_TXID, blockHeight: 100, blockTime: 1_700_000_000, syncedAt: 1 },
    { txid: SPEND_TXID, blockHeight: 101, blockTime: 1_700_000_600, syncedAt: 1 },
  ] as unknown as BlockchainTransaction[]);
}

function addressRecord(inputString: string, extra: Partial<DbRecord> = {}): DbRecord {
  return {
    type: "address",
    inputString,
    label: inputString,
    tags: [],
    categories: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...extra,
  } as unknown as DbRecord;
}

beforeEach(() => {
  testDb = new TestDb(`KYUTXO-electrum-surfaces-${Date.now()}-${Math.random()}`);
});

afterEach(async () => {
  await testDb.delete();
});

// ---- Privacy audit -----------------------------------------------------------

describe("runPrivacyAudit with an Electrum blank-address spend", () => {
  it("analyzes the spend tx whose only owned link is a blank-address input", async () => {
    await seedElectrumSpendFixture();

    const result = await runPrivacyAudit([OWNED_ADDR]);

    // Without outpoint-aware discovery, only FUND_TXID is visible.
    expect(result.transactionsAnalyzed).toBe(2);
  });
});

// ---- Adversary view -----------------------------------------------------------

describe("runAdversaryView with Electrum blank-address co-spend inputs", () => {
  it("attributes blank inputs so CIO clustering exposes the co-spending owned addresses", async () => {
    // Two owned addresses funded separately, then co-spent in one tx whose
    // inputs are BOTH blank-address (Electrum) rows. A real chain adversary
    // sees the true prevout addresses, so the CIO heuristic must link them.
    await testDb.transactionParticipants.bulkAdd([
      { txid: FUND_TXID, role: "output", address: OWNED_ADDR, amount: 50_000, vout: 0 },
      { txid: FUND_TXID_2, role: "output", address: OWNED_ADDR_2, amount: 30_000, vout: 0 },
      { txid: SPEND_TXID, role: "input", address: "", amount: 50_000, prevTxid: FUND_TXID, prevVout: 0 },
      { txid: SPEND_TXID, role: "input", address: "", amount: 30_000, prevTxid: FUND_TXID_2, prevVout: 0 },
      { txid: SPEND_TXID, role: "output", address: COUNTERPARTY_ADDR, amount: 79_000, vout: 0 },
    ]);
    await testDb.records.bulkAdd([
      addressRecord(OWNED_ADDR, { walletName: "Wallet A" }),
      addressRecord(OWNED_ADDR_2, { walletName: "Wallet B" }),
    ]);

    const result = await runAdversaryView([OWNED_ADDR, OWNED_ADDR_2]);

    // Without discovery+attribution the adversary sees no co-spend at all.
    expect(result.summary.exposureCount).toBeGreaterThanOrEqual(1);
    expect(result.summary.addressesExposed).toBe(2);
  });
});

// ---- Address reuse page --------------------------------------------------------

describe("analyzeAddressReuse with an Electrum blank-address spend", () => {
  it("counts a blank-input spend with change back to the owner as change-to-self reuse", async () => {
    await testDb.records.add(addressRecord(OWNED_ADDR));
    await testDb.transactionParticipants.bulkAdd([
      { txid: FUND_TXID, role: "output", address: OWNED_ADDR, amount: 50_000, vout: 0 },
      // Blank-address Electrum spend input of the owned outpoint...
      { txid: SPEND_TXID, role: "input", address: "", amount: 50_000, prevTxid: FUND_TXID, prevVout: 0 },
      // ...with change going back to the SAME owned address.
      { txid: SPEND_TXID, role: "output", address: OWNED_ADDR, amount: 10_000, vout: 0 },
      { txid: SPEND_TXID, role: "output", address: COUNTERPARTY_ADDR, amount: 39_000, vout: 1 },
    ]);
    await testDb.blockchainTransactions.bulkAdd([
      { txid: FUND_TXID, blockHeight: 100, blockTime: 1_700_000_000, syncedAt: 1 },
      { txid: SPEND_TXID, blockHeight: 101, blockTime: 1_700_000_600, syncedAt: 1 },
    ] as unknown as BlockchainTransaction[]);

    const signal = new AbortController().signal;
    const { reusedAddresses } = await analyzeAddressReuse(false, signal);

    const entry = reusedAddresses.find((r) => r.address === OWNED_ADDR);
    expect(entry).toBeDefined();
    // Change-to-self is only detectable when the blank spend input is
    // attributed back to the owning address.
    expect(entry!.selfChangeTxids).toContain(SPEND_TXID);
    expect(entry!.reuseReason).toBe("both"); // multi-receive + change-to-self
  });
});

// ---- Flow visualizer address finder ---------------------------------------------

describe("computeAddressFlowStats with an Electrum blank-address spend", () => {
  it("subtracts the blank-input spend from the owning address's balance", async () => {
    await seedElectrumSpendFixture();

    const stats = await computeAddressFlowStats([OWNED_ADDR]);
    const owned = stats.get(OWNED_ADDR);
    expect(owned).toBeDefined();
    expect(owned!.outputSats).toBe(50_000);
    // Without attribution, inputSats stays 0 and the balance overstates funds.
    expect(owned!.inputSats).toBe(50_000);
    expect(owned!.txCount).toBe(2);
    expect(owned!.lastTxTime).toBe(1_700_000_600);
  });
});

// @vitest-environment jsdom
//
// Task: transaction nudges must not skip Electrum-synced spends. Electrum-
// synced spend inputs are stored with a BLANK address (only prevTxid/prevVout),
// so a pure address-keyed participant load never returns them, and a spend tx
// whose only link to an owned address is such an input would silently vanish
// from Nudgie's "unlabeled transactions" nudge list.
//
// Covers Nudgie's extracted loaders (pages/Nudgie.tsx):
//   1. loadNudgeParticipants() — outpoint-aware load returns the blank-address
//      spend input AND attributes it back to the owning address.
//   2. buildNudgeCandidates() — the spend tx passes the "involves one of your
//      addresses" filter and is offered as a nudge candidate.
//
// Fixture pattern mirrors record-queries.outpointSpendDiscovery.test.ts.

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
        "addressImportance, *tags, *categories, createdAt, updatedAt",
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

const { loadNudgeParticipants, buildNudgeCandidates } = await import(
  "@/pages/Nudgie"
);

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
  testDb = new TestDb(`KYUTXO-nudgie-outpoint-${Date.now()}-${Math.random()}`);
});

afterEach(async () => {
  await testDb.delete();
});

// ---- Participant load --------------------------------------------------------

describe("loadNudgeParticipants with an Electrum blank-address spend", () => {
  it("returns the spend tx and attributes its blank input to the owning address", async () => {
    await seedElectrumSpendFixture();

    const parts = await loadNudgeParticipants([OWNED_ADDR]);
    const txids = new Set(parts.map((p) => p.txid));
    expect(txids.has(FUND_TXID)).toBe(true);
    // Without outpoint-aware discovery the spend tx is invisible.
    expect(txids.has(SPEND_TXID)).toBe(true);

    const spendInput = parts.find((p) => p.txid === SPEND_TXID && p.role === "input");
    expect(spendInput).toBeDefined();
    // Attribution back to the owner is what lets the nudge candidate filter
    // ("involves one of your addresses") accept the spend tx.
    expect(spendInput!.address).toBe(OWNED_ADDR);
  });
});

// ---- Nudge candidates ---------------------------------------------------------

describe("buildNudgeCandidates with an Electrum blank-address spend", () => {
  it("offers the spend tx as an unlabeled-transaction nudge candidate", async () => {
    await seedElectrumSpendFixture();
    const ownedRecord = addressRecord(OWNED_ADDR);

    const participants = await loadNudgeParticipants([OWNED_ADDR]);
    const transactions = await testDb.blockchainTransactions.toArray();
    const addressToRecord = new Map<string, DbRecord>([[OWNED_ADDR, ownedRecord]]);

    const candidates = await buildNudgeCandidates(
      {
        transactions,
        participants,
        addressToRecord,
        txidToRecord: new Map(),
        sourceFilter: "all",
      },
      new AbortController().signal,
    );

    const spend = candidates.find((c) => c.txid === SPEND_TXID);
    expect(spend).toBeDefined();
    // The attributed blank input is "your address" spending 50k with 49k to
    // the counterparty, so the nudge shows a Sent tx with negative net flow.
    expect(spend!.yourAddresses).toEqual([
      expect.objectContaining({ address: OWNED_ADDR, role: "input", amount: 50_000 }),
    ]);
    expect(spend!.netFlow).toBe(-50_000);
    // The participant load is keyed to owned addresses (plus attributed spend
    // inputs), so the counterparty output row isn't part of the nudge context.
    expect(spend!.counterpartyAddresses).toEqual([]);
    // The funding tx is a candidate too (received to the owned address).
    expect(candidates.some((c) => c.txid === FUND_TXID)).toBe(true);
  });

  it("still excludes the spend tx once it has a labeled transaction record", async () => {
    await seedElectrumSpendFixture();
    const ownedRecord = addressRecord(OWNED_ADDR);

    const participants = await loadNudgeParticipants([OWNED_ADDR]);
    const transactions = await testDb.blockchainTransactions.toArray();

    const candidates = await buildNudgeCandidates(
      {
        transactions,
        participants,
        addressToRecord: new Map([[OWNED_ADDR, ownedRecord]]),
        txidToRecord: new Map([
          [SPEND_TXID, { type: "transaction", inputString: SPEND_TXID, label: "Paid rent" } as unknown as DbRecord],
        ]),
        sourceFilter: "all",
      },
      new AbortController().signal,
    );

    expect(candidates.some((c) => c.txid === SPEND_TXID)).toBe(false);
  });
});

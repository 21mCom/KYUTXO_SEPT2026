// @vitest-environment jsdom
//
// Task #1722 — Nudgie's update paths previously called updateRecord without
// recording the incoming metadata as an origin, so labels applied through
// nudges could never surface on the Conflict Resolution page. This mounts the
// real page over a seeded vault, saves a label onto a transaction that
// ALREADY has a record (existingRecordId branch of handleSaveTransaction),
// and proves the shared capture wrote the baseline + 'nudgie' origins.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import Dexie, { type Table } from "dexie";
import type { Record as DbRecord, BlockchainTransaction, RecordOrigin } from "@/lib/database";
import type { TransactionParticipant } from "@/lib/db-types";
import { TestProviders } from "@/test/testProviders";

// jsdom has no matchMedia; page components (ScrollPositionIndicator,
// use-mobile, etc.) query it at mount.
window.matchMedia =
  window.matchMedia ||
  ((query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList);

class TestDb extends Dexie {
  records!: Table<DbRecord, number>;
  recordOrigins!: Table<RecordOrigin, number>;
  transactionParticipants!: Table<TransactionParticipant, number>;
  blockchainTransactions!: Table<BlockchainTransaction, number>;
  tags!: Table<any, number>;
  categories!: Table<any, number>;
  owners!: Table<any, number>;
  walletNames!: Table<any, number>;
  seedNames!: Table<any, number>;
  walletSoftware!: Table<any, number>;
  customFields!: Table<any, number>;
  recordAttachments!: Table<any, number>;
  settings!: Table<any, string>;
  nodeSettings!: Table<any, string>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      records:
        "++id, type, inputString, inputStringLower, label, owner, walletName, " +
        "seedName, walletSoftware, *tags, *categories, createdAt, updatedAt, " +
        "chainType, syncDepth, addressImportance, [type+addressImportance], " +
        "[addressImportance+id], [type+id], [owner+id], [walletName+id], " +
        "flowType, discoveredFromRecordId",
      recordOrigins: "++id, recordId, originType, createdAt",
      transactionParticipants:
        "++id, [txid+role], txid, role, address, recordId, [prevTxid+prevVout]",
      blockchainTransactions:
        "++id, &txid, blockHeight, blockTime, syncedAt, hasOpReturn",
      tags: "++id, name, createdAt",
      categories: "++id, name, createdAt",
      owners: "++id, name, createdAt",
      walletNames: "++id, name, createdAt",
      seedNames: "++id, name, createdAt",
      walletSoftware: "++id, name, createdAt",
      customFields: "++id, slug, enabled, createdAt",
      recordAttachments: "++id, recordId, createdAt",
      settings: "id",
      nodeSettings: "id",
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
  };
});

testDb = new TestDb(`KYUTXO-nudgemerge-${Date.now()}-${Math.random()}`);

const { default: Nudgie } = await import("./Nudgie");
const { createRecord, getRecord } = await import("@/lib/data/record-crud");
const { getRecordOriginsByRecordId } = await import(
  "@/lib/data/record-origins-crud"
);

const OWNED_ADDR = "bc1q-owned-nudge-addr";
const COUNTERPARTY_ADDR = "bc1q-counterparty-nudge";
const TXID = "nudgemerge".padEnd(64, "2");

/** Owned verified address funds a spend to a counterparty; the spend tx has
 *  an UNLABELED transaction record → Nudgie offers it as a nudge and Save
 *  goes down the existingRecordId (merge) branch. */
async function seedNudgeFixture(): Promise<number> {
  await createRecord({
    type: "address",
    inputString: OWNED_ADDR,
    label: "My hot wallet",
    tags: [],
    categories: [],
    addressImportance: "verified",
    source: "manual",
  } as any);

  const txRecordId = (await createRecord({
    type: "transaction",
    inputString: TXID,
    label: "", // unlabeled → nudge candidate
    tags: [],
    categories: [],
    owner: "Alice",
    source: "manual",
  } as any)) as number;

  await testDb.transactionParticipants.bulkAdd([
    { txid: TXID, role: "input", address: OWNED_ADDR, amount: 50_000 },
    { txid: TXID, role: "output", address: COUNTERPARTY_ADDR, amount: 49_000, vout: 0 },
  ] as TransactionParticipant[]);
  await testDb.blockchainTransactions.add({
    txid: TXID,
    blockHeight: 100,
    blockTime: 1_700_000_000,
    syncedAt: 1,
  } as unknown as BlockchainTransaction);

  return txRecordId;
}

beforeEach(async () => {
  await Promise.all(testDb.tables.map((t) => t.clear()));
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await testDb.delete();
});

describe("Nudgie merge path — origin capture", () => {
  it("saving a label onto an existing transaction record writes baseline + nudgie origins", async () => {
    const txRecordId = await seedNudgeFixture();
    expect(await getRecordOriginsByRecordId(txRecordId)).toHaveLength(0);

    render(
      <TestProviders>
        <Nudgie />
      </TestProviders>,
    );

    // Wait for the nudge card's label input (async participant/candidate build).
    const labelInput = await screen.findByTestId(
      `input-label-${TXID}`,
      {},
      { timeout: 15000 },
    );
    fireEvent.change(labelInput, { target: { value: "Nudged label" } });
    fireEvent.click(screen.getByTestId(`button-save-${TXID}`));

    await waitFor(
      async () => {
        expect(await getRecordOriginsByRecordId(txRecordId)).toHaveLength(2);
      },
      { timeout: 10000 },
    );

    const origins = await getRecordOriginsByRecordId(txRecordId);
    const sorted = [...origins].sort((a, b) => a.createdAt - b.createdAt);
    const [baseline, incoming] = sorted;

    // Baseline snapshots the pre-merge record (owner Alice, no label).
    expect(baseline.originType).toBe("manual");
    expect(baseline.owner).toBe("Alice");
    expect(baseline.label).toBeUndefined();

    // Incoming records what the nudge applied.
    expect(incoming.source).toBe("nudgie");
    expect(incoming.label).toBe("Nudged label");

    // Merge outcome unchanged: the label was applied.
    const updated = (await getRecord(txRecordId))!;
    expect(updated.label).toBe("Nudged label");
  }, 40000);
});

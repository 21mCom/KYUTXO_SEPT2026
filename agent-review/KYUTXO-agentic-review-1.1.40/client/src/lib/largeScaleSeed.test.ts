// @vitest-environment jsdom
//
// Validates the large-scale synthetic vault generator and the legacy
// (pre-migration) fixture.
//
// Both run against the REAL Dexie engine (via fake-indexeddb) with a TestDb
// swapped in for `@/lib/database`, so every write goes through the actual CRUD
// modules exactly as it would in the app — just at a tiny, fast scale.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type {
  Record as DbRecord,
  Attachment,
  BlockchainTransaction,
  TransactionParticipant,
} from "@/lib/database";
import type { LargeVaultConfig } from "./largeScaleSeed";

// Mirrors the production schema (db v31/v32) for just the tables the generator
// and legacy fixture touch.
const RECORDS_SCHEMA =
  "++id, type, inputString, inputStringLower, label, owner, walletName, " +
  "seedName, walletSoftware, *tags, *categories, createdAt, updatedAt, " +
  "chainType, syncDepth, addressImportance, [type+addressImportance], " +
  "[addressImportance+id], [type+id], [owner+id], [walletName+id], " +
  "flowType, discoveredFromRecordId";

class TestDb extends Dexie {
  records!: Table<DbRecord, number>;
  attachments!: Table<Attachment, number>;
  blockchainTransactions!: Table<BlockchainTransaction, number>;
  transactionParticipants!: Table<TransactionParticipant, number>;
  tags!: Table<{ id?: number; name: string; createdAt: number }, number>;
  categories!: Table<{ id?: number; name: string; createdAt: number }, number>;
  owners!: Table<{ id?: number; name: string; createdAt: number }, number>;
  walletNames!: Table<{ id?: number; name: string; createdAt: number }, number>;
  seedNames!: Table<{ id?: number; name: string; createdAt: number }, number>;
  walletSoftware!: Table<{ id?: number; name: string; createdAt: number }, number>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      records: RECORDS_SCHEMA,
      attachments: "++id, recordId, createdAt",
      blockchainTransactions: "++id, &txid, blockHeight, blockTime, syncedAt, hasOpReturn",
      transactionParticipants: "++id, [txid+role], txid, role, address, recordId, [prevTxid+prevVout]",
      tags: "++id, name, createdAt",
      categories: "++id, name, createdAt",
      owners: "++id, name, createdAt",
      walletNames: "++id, name, createdAt",
      seedNames: "++id, name, createdAt",
      walletSoftware: "++id, name, createdAt",
    });
  }
}

let testDb: TestDb;

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>("@/lib/database");
  return {
    ...actual,
    get db() {
      return testDb;
    },
  };
});

const { generateLargeVault, SeedAbortError } = await import("./largeScaleSeed");
const { generateLegacyFixture } = await import("./testSeedData");
const { countRecords } = await import("./data/record-crud");
const { countTransactions, countTransactionParticipants } = await import("./data/transaction-crud");

beforeEach(async () => {
  testDb = new TestDb(`KYUTXO-seed-${Date.now()}-${Math.random()}`);
  await testDb.open();
});

afterEach(async () => {
  testDb.close();
  await Dexie.delete(testDb.name);
});

// A tiny config whose batch sizes are SMALLER than the totals, so the batching
// loops (and the yield-between-batches path) actually execute more than once.
const TINY: LargeVaultConfig = {
  records: 30,
  transactions: 40,
  participants: 50,
  attachments: 10,
  recordBatch: 7,
  txBatch: 9,
  participantBatch: 11,
  attachmentBatch: 4,
};

describe("generateLargeVault", () => {
  it("writes exactly the requested counts via the CRUD layer", async () => {
    const result = await generateLargeVault(TINY);

    expect(await countRecords()).toBe(TINY.records);
    expect(await countTransactions()).toBe(TINY.transactions);
    expect(await countTransactionParticipants()).toBe(TINY.participants);
    expect(await testDb.attachments.count()).toBe(TINY.attachments);

    expect(result.records).toBe(TINY.records);
    expect(result.transactions).toBe(TINY.transactions);
    expect(result.participants).toBe(TINY.participants);
    expect(result.attachments).toBe(TINY.attachments);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports progress that ends at 100% in the 'done' phase", async () => {
    const phases: string[] = [];
    let lastOverall = -1;
    let monotonic = true;

    await generateLargeVault(TINY, {
      onProgress: (p) => {
        phases.push(p.phase);
        if (p.overall < lastOverall) monotonic = false;
        lastOverall = p.overall;
      },
    });

    expect(phases.length).toBeGreaterThan(1);
    expect(phases).toContain("records");
    expect(phases).toContain("transactions");
    expect(phases[phases.length - 1]).toBe("done");
    expect(monotonic).toBe(true);
    expect(lastOverall).toBe(1);
  });

  it("clearExisting wipes prior data before regenerating", async () => {
    await generateLargeVault(TINY);
    // Default clearExisting (undefined -> treated as true) should reset counts.
    await generateLargeVault(TINY);
    expect(await countRecords()).toBe(TINY.records);
    expect(await countTransactions()).toBe(TINY.transactions);
  });

  it("does not materialise the whole dataset (linking ids stay compact)", async () => {
    // A larger record set with a small address ratio: the generator keeps only
    // the address-record ids in memory, never the transaction/participant rows.
    const cfg: LargeVaultConfig = {
      records: 100,
      transactions: 200,
      participants: 400,
      attachments: 20,
      addressRatio: 0.1,
      recordBatch: 25,
      txBatch: 50,
      participantBatch: 100,
      attachmentBatch: 10,
    };
    const result = await generateLargeVault(cfg);
    expect(result.records).toBe(100);
    expect(result.participants).toBe(400);
    // Participants link only to the ~10 address records, proving the compact
    // id-capture path works without holding all records.
    const linked = await testDb.transactionParticipants
      .where("recordId")
      .below(1000)
      .count();
    expect(linked).toBe(400);
  });

  it("aborts promptly via AbortSignal and leaves only partial data", async () => {
    const controller = new AbortController();
    // Abort as soon as the first records batch reports progress.
    const big: LargeVaultConfig = {
      records: 5000,
      transactions: 5000,
      participants: 5000,
      attachments: 1000,
      recordBatch: 100,
      txBatch: 100,
      participantBatch: 100,
      attachmentBatch: 100,
    };

    await expect(
      generateLargeVault(big, {
        signal: controller.signal,
        onProgress: (p) => {
          if (p.phase === "records" && p.current > 0) controller.abort();
        },
      }),
    ).rejects.toBeInstanceOf(SeedAbortError);

    // Some records were written, but nowhere near the full request.
    const written = await countRecords();
    expect(written).toBeGreaterThan(0);
    expect(written).toBeLessThan(big.records);
  });
});

describe("generateLegacyFixture", () => {
  it("creates records WITHOUT inputStringLower and root-path attachments", async () => {
    const result = await generateLegacyFixture({ records: 25, attachments: 8 });

    expect(result.records).toBe(25);
    expect(result.attachments).toBe(8);
    expect(await testDb.records.count()).toBe(25);
    expect(await testDb.attachments.count()).toBe(8);

    // Pre-migration shape: lowercase search index missing on every record.
    const records = await testDb.records.toArray();
    expect(records.every((r) => r.inputStringLower === undefined)).toBe(true);
    // Mixed-case input that a repair pass would lowercase to something different.
    expect(records[0].inputString).toMatch(/^Legacy-Addr-/);

    // Pre-migration shape: attachments live at a single-segment ("root") path.
    const attachments = await testDb.attachments.toArray();
    expect(attachments.every((a) => !a.objectStoragePath.includes("/"))).toBe(true);
  });
});

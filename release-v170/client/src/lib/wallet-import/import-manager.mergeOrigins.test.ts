// @vitest-environment jsdom
//
// Task #1722 — the wallet-file import merge path must capture merge origins
// via the shared helper: incoming metadata is recorded as a wallet-sync
// origin AND, when the existing record has no origin history (created via the
// raw facade, restored from backup, …), a baseline origin snapshotting the
// pre-merge record is backfilled first so the disagreement can surface on the
// Conflict Resolution page.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type { Record as DbRecord, RecordOrigin } from "@/lib/database";
import type { DuplicateInfo, ImportOptions } from "./types";

class TestDb extends Dexie {
  records!: Table<DbRecord, number>;
  recordOrigins!: Table<RecordOrigin, number>;
  tags!: Table<any, number>;
  categories!: Table<any, number>;
  owners!: Table<any, number>;
  walletNames!: Table<any, number>;
  seedNames!: Table<any, number>;
  walletSoftware!: Table<any, number>;
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
      tags: "++id, name, createdAt",
      categories: "++id, name, createdAt",
      owners: "++id, name, createdAt",
      walletNames: "++id, name, createdAt",
      seedNames: "++id, name, createdAt",
      walletSoftware: "++id, name, createdAt",
    });
  }
}

const testDb = new TestDb(`KYUTXO-wimerge-${Date.now()}-${Math.random()}`);

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return { ...actual, db: testDb };
});

const { executeImport } = await import("./import-manager");
const { createRecord, getRecord } = await import("@/lib/data/record-crud");
const { getRecordOriginsByRecordId } = await import(
  "@/lib/data/record-origins-crud"
);
const { detectSingularFieldConflicts } = await import(
  "@/lib/conflict-detection"
);

const ADDR = `bc1qwim1x${"q".repeat(30)}`;

const OPTIONS: ImportOptions = {
  sourceName: "walletImport-sparrow",
  owner: "Bob",
  walletName: "Sparrow Hot",
  defaultTags: ["sparrow"],
  defaultCategories: [],
  walletSoftware: "Sparrow",
};

function mergeInfoFor(existing: DbRecord): DuplicateInfo {
  return {
    parsedRecord: {
      type: "address",
      inputString: existing.inputString!,
      label: "Sparrow label",
      // wallet's own (user-controlled) address — merge applies default
      // tags/wallet metadata only to inputs
      isInputAddress: true,
    },
    existingRecord: existing,
    isNew: false,
    willMerge: true,
  };
}

beforeEach(async () => {
  await Promise.all(testDb.tables.map((t) => t.clear()));
});

afterAll(async () => {
  await testDb.delete();
});

describe("executeImport merge path — origin capture", () => {
  it("backfills a baseline for an origin-less record and records the incoming wallet-sync origin", async () => {
    const id = (await createRecord({
      type: "address",
      inputString: ADDR,
      label: "My cold key",
      tags: [],
      categories: [],
      owner: "Alice",
      source: "manual",
    } as any)) as number;
    const existing = (await getRecord(id))!;
    expect(await getRecordOriginsByRecordId(id)).toHaveLength(0);

    const result = await executeImport([mergeInfoFor(existing)], OPTIONS);
    expect(result.updatedRecords).toBe(1);
    expect(result.failedRecords).toBe(0);

    const origins = await getRecordOriginsByRecordId(id);
    expect(origins).toHaveLength(2);

    const sorted = [...origins].sort((a, b) => a.createdAt - b.createdAt);
    const [baseline, incoming] = sorted;

    // Baseline snapshots the pre-merge record.
    expect(baseline.originType).toBe("manual");
    expect(baseline.owner).toBe("Alice");
    expect(baseline.label).toBe("My cold key");

    // Incoming carries what the wallet file brought.
    expect(incoming.originType).toBe("wallet-sync");
    expect(incoming.owner).toBe("Bob");
    expect(incoming.walletName).toBe("Sparrow Hot");
    expect(incoming.source).toBe("walletImport-sparrow");

    // The merged record now surfaces its owner disagreement.
    const merged = (await getRecord(id))!;
    const conflicts = detectSingularFieldConflicts(merged, origins);
    expect(conflicts.map((c) => c.field.key)).toContain("owner");
  });

  it("does not duplicate the baseline when the record already has origins", async () => {
    const id = (await createRecord({
      type: "address",
      inputString: `bc1qwim2x${"q".repeat(30)}`,
      label: "Labeled",
      tags: [],
      categories: [],
      owner: "Alice",
      source: "manual",
    } as any)) as number;
    await testDb.recordOrigins.add({
      recordId: id,
      originType: "manual",
      owner: "Alice",
      createdAt: Date.now() - 5000,
    });
    const existing = (await getRecord(id))!;

    await executeImport([mergeInfoFor(existing)], OPTIONS);

    const origins = await getRecordOriginsByRecordId(id);
    expect(origins).toHaveLength(2);
    expect(origins.filter((o) => o.originType === "wallet-sync")).toHaveLength(1);
  });

  it("merge outcome values are unchanged by origin capture (keep-existing policy intact)", async () => {
    const id = (await createRecord({
      type: "address",
      inputString: `bc1qwim3x${"q".repeat(30)}`,
      label: "Keep me",
      tags: ["mine"],
      categories: [],
      owner: "Alice",
      source: "manual",
    } as any)) as number;
    const existing = (await getRecord(id))!;

    await executeImport([mergeInfoFor(existing)], OPTIONS);

    const merged = (await getRecord(id))!;
    // mergeRecordData keeps existing scalars (label/owner) and unions tags.
    expect(merged.label).toBe("Keep me");
    expect(merged.owner).toBe("Alice");
    expect(merged.tags).toContain("mine");
    expect(merged.tags).toContain("sparrow");
  });
});

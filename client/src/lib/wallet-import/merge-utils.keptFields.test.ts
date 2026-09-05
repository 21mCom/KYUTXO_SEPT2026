// @vitest-environment jsdom
//
// Task: Mobile Wallet Import must apply the same existing-record merge policy
// as Descriptor Import (tags/categories unioned, existing scalars kept) via
// the shared computeExistingRecordMerge util, and REPORT which user-entered
// fields were kept-as-existing vs applied so the completion screen can tell
// the user instead of silently dropping their input.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type { Record as DbRecord, RecordOrigin } from "@/lib/database";
import type { DuplicateInfo, ImportOptions, ParsedRecord } from "./types";

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

const testDb = new TestDb(`KYUTXO-wikept-${Date.now()}-${Math.random()}`);

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return { ...actual, db: testDb };
});

const { mergeRecordDataWithReport, mergeRecordData, checkForDuplicates } = await import(
  "./merge-utils"
);
const { executeImport } = await import("./import-manager");
const { createRecord, getRecord } = await import("@/lib/data/record-crud");

const baseExisting = (over: Partial<DbRecord> = {}): DbRecord =>
  ({
    id: 1,
    type: "address",
    inputString: `bc1qkept${"q".repeat(30)}`,
    label: "Existing label",
    tags: ["mine"],
    categories: ["cold"],
    owner: "Alice",
    source: "manual",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  }) as DbRecord;

const inputParsed = (inputString: string): ParsedRecord => ({
  type: "address",
  inputString,
  label: "Imported",
  isInputAddress: true,
});

const OPTIONS = {
  sourceName: "mobileImport-Phoenix",
  defaultTags: ["phoenix"],
  defaultCategories: ["lightning"],
  owner: "Bob",
  walletName: "Phoenix Hot",
  seedName: "Seed A",
  walletSoftware: "Phoenix Wallet",
};

beforeEach(async () => {
  await Promise.all(testDb.tables.map((t) => t.clear()));
});

afterAll(async () => {
  await testDb.delete();
});

describe("mergeRecordDataWithReport — shared merge policy + kept/applied report", () => {
  it("keeps existing scalars, unions tags/categories, and reports kept vs applied", () => {
    const existing = baseExisting({
      owner: "Alice",
      walletSoftware: undefined,
      seedName: undefined,
    });

    const { data, keptFields, appliedFields } = mergeRecordDataWithReport(
      existing,
      inputParsed(existing.inputString!),
      OPTIONS,
    );

    // Existing scalar kept, user told about it.
    expect(data.owner).toBe("Alice");
    expect(keptFields).toContain("owner");

    // Blank fields filled and reported as applied.
    expect(data.walletSoftware).toBe("Phoenix Wallet");
    expect(data.seedName).toBe("Seed A");
    expect(appliedFields).toEqual(
      expect.arrayContaining(["walletSoftware", "seedName"]),
    );
    expect(appliedFields).not.toContain("owner");

    // Tags/categories are unioned everywhere.
    expect(data.tags).toEqual(expect.arrayContaining(["mine", "phoenix"]));
    expect(data.categories).toEqual(
      expect.arrayContaining(["cold", "lightning"]),
    );
  });

  it("reports nothing kept when the entered value matches the existing one", () => {
    const existing = baseExisting({ owner: "Bob" });
    const { keptFields, appliedFields } = mergeRecordDataWithReport(
      existing,
      inputParsed(existing.inputString!),
      OPTIONS,
    );
    expect(keptFields).toEqual([]);
    expect(appliedFields).toEqual(
      expect.arrayContaining(["walletSoftware", "seedName"]),
    );
  });

  it("walletName stays authoritative (re-attribution) and is never in the report", () => {
    const existing = baseExisting({ walletName: "Old Wallet" });
    const { data, keptFields, appliedFields } = mergeRecordDataWithReport(
      existing,
      inputParsed(existing.inputString!),
      OPTIONS,
    );
    expect(data.walletName).toBe("Phoenix Hot");
    expect(keptFields).not.toContain("walletName");
    expect(appliedFields).not.toContain("walletName");
  });

  it("does not apply or report user metadata on non-input (third-party) records", () => {
    const existing = baseExisting({ owner: undefined, tags: [] });
    const parsed: ParsedRecord = {
      type: "address",
      inputString: existing.inputString!,
      label: "Counterparty",
      isInputAddress: false,
      direction: "outgoing",
    };
    const { data, keptFields, appliedFields } = mergeRecordDataWithReport(
      existing,
      parsed,
      OPTIONS,
    );
    expect(data.owner).toBeUndefined();
    expect(data.walletSoftware).toBeUndefined();
    expect(data.tags).toEqual([]);
    expect(keptFields).toEqual([]);
    expect(appliedFields).toEqual([]);
  });

  it("mergeRecordData wrapper returns identical merge data", () => {
    const existing = baseExisting();
    const parsed = inputParsed(existing.inputString!);
    expect(mergeRecordData(existing, parsed, OPTIONS)).toEqual(
      mergeRecordDataWithReport(existing, parsed, OPTIONS).data,
    );
  });
});

describe("checkForDuplicates — repository lookup", () => {
  it("uses the canonical indexed identity for case-insensitive existing records", async () => {
    const inputString = `bc1qduplicate${"q".repeat(30)}`;
    await createRecord({
      type: "address",
      inputString,
      label: "Existing",
      tags: [],
      categories: [],
      source: "manual",
    } as any);

    const [duplicate] = await checkForDuplicates([
      inputParsed(inputString.toUpperCase()),
    ]);

    expect(duplicate.isNew).toBe(false);
    expect(duplicate.willMerge).toBe(true);
    expect(duplicate.existingRecord?.inputString).toBe(inputString);
  });
});

describe("executeImport — kept/applied field counts aggregation", () => {
  const infoFor = (existing: DbRecord): DuplicateInfo => ({
    parsedRecord: inputParsed(existing.inputString!),
    existingRecord: existing,
    isNew: false,
    willMerge: true,
  });

  it("counts kept and applied fields across merged records", async () => {
    const opts: ImportOptions = { ...OPTIONS, defaultCategories: [] };

    const idA = (await createRecord({
      type: "address",
      inputString: `bc1qkepta${"q".repeat(30)}`,
      label: "A",
      tags: [],
      categories: [],
      owner: "Alice",
      source: "manual",
    } as any)) as number;
    const idB = (await createRecord({
      type: "address",
      inputString: `bc1qkeptb${"q".repeat(30)}`,
      label: "B",
      tags: [],
      categories: [],
      owner: "Carol",
      seedName: "Other Seed",
      source: "manual",
    } as any)) as number;

    const existingA = (await getRecord(idA))!;
    const existingB = (await getRecord(idB))!;

    const result = await executeImport(
      [infoFor(existingA), infoFor(existingB)],
      opts,
    );

    expect(result.updatedRecords).toBe(2);
    // Both records had an existing owner differing from the entered one.
    expect(result.keptFieldCounts.owner).toBe(2);
    // Only B had an existing seedName; A's blank seedName was filled.
    expect(result.keptFieldCounts.seedName).toBe(1);
    expect(result.appliedFieldCounts.seedName).toBe(1);
    // walletSoftware was blank on both.
    expect(result.appliedFieldCounts.walletSoftware).toBe(2);
    expect(result.keptFieldCounts.walletSoftware).toBeUndefined();

    // Merged records actually kept the existing scalars in the DB.
    const mergedA = (await getRecord(idA))!;
    expect(mergedA.owner).toBe("Alice");
    expect(mergedA.seedName).toBe("Seed A");
    const mergedB = (await getRecord(idB))!;
    expect(mergedB.owner).toBe("Carol");
    expect(mergedB.seedName).toBe("Other Seed");
  });

  it("new records report no kept/applied counts", async () => {
    const result = await executeImport(
      [
        {
          parsedRecord: inputParsed(`bc1qkeptc${"q".repeat(30)}`),
          existingRecord: null,
          isNew: true,
          willMerge: false,
        },
      ],
      { ...OPTIONS },
    );
    expect(result.newRecords).toBe(1);
    expect(result.keptFieldCounts).toEqual({});
    expect(result.appliedFieldCounts).toEqual({});
  });
});

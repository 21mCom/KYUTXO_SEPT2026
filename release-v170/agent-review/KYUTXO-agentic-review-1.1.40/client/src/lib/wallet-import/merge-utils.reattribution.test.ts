// @vitest-environment jsdom
//
// Wallet re-attribution on explicit import (Wallet Overview stuck-counts fix):
// an explicit import into a named wallet is the authoritative act, so a record
// that already exists under a DIFFERENT wallet name — e.g. auto-created by
// sync as blockchain-discovered (inheriting the parent wallet's name) or left
// over from an earlier import — must move to the imported wallet. Without an
// explicit walletName the existing attribution is preserved.
//
// mergeRecordData is exercised as a pure function; executeImport is exercised
// end-to-end against a real (fake-indexeddb) database to prove the
// re-attribution count surfaces in ImportResult.

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

const testDb = new TestDb(`KYUTXO-reattr-${Date.now()}-${Math.random()}`);

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return { ...actual, db: testDb };
});

const { mergeRecordData } = await import("./merge-utils");
const { executeImport } = await import("./import-manager");
const { createRecord, getRecord } = await import("@/lib/data/record-crud");

function existingRecord(over: Partial<DbRecord>): DbRecord {
  return {
    id: 1,
    type: "address",
    inputString: "bc1qreattributeexistingaddress0000",
    label: "Existing",
    tags: [],
    categories: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as DbRecord;
}

const INCOMING_INPUT = {
  type: "address" as const,
  inputString: "bc1qreattributeexistingaddress0000",
  label: "Incoming label",
  isInputAddress: true,
};

const BASE_OPTIONS = {
  defaultTags: [] as string[],
  defaultCategories: [] as string[],
  sourceName: "walletImport-test",
};

describe("mergeRecordData — wallet re-attribution", () => {
  it("explicit walletName wins over a discovery-stamped inherited walletName", () => {
    const merged = mergeRecordData(
      existingRecord({
        walletName: "WalletOne",
        addressImportance: "blockchain-discovered",
      }),
      INCOMING_INPUT,
      { ...BASE_OPTIONS, walletName: "WalletTwo", incomingImportance: "xpub-derived" },
    );
    expect(merged.walletName).toBe("WalletTwo");
    // Tier upgrades too (discovery -> curated), like the Bulk Import path.
    expect(merged.addressImportance).toBe("xpub-derived");
  });

  it("explicit walletName re-attributes a curated record from another wallet", () => {
    const merged = mergeRecordData(
      existingRecord({ walletName: "WalletOne", addressImportance: "manual" }),
      INCOMING_INPUT,
      { ...BASE_OPTIONS, walletName: "WalletTwo" },
    );
    expect(merged.walletName).toBe("WalletTwo");
  });

  it("stamps walletName onto a record that had none", () => {
    const merged = mergeRecordData(
      existingRecord({ walletName: undefined, addressImportance: "wallet-import" }),
      INCOMING_INPUT,
      { ...BASE_OPTIONS, walletName: "WalletTwo" },
    );
    expect(merged.walletName).toBe("WalletTwo");
  });

  it("preserves the existing walletName when no explicit walletName is supplied", () => {
    const merged = mergeRecordData(
      existingRecord({ walletName: "WalletOne", addressImportance: "manual" }),
      INCOMING_INPUT,
      BASE_OPTIONS,
    );
    expect(merged.walletName).toBe("WalletOne");
  });

  it("does NOT re-label an already-curated tier on a later wallet-file import", () => {
    // Vault summaries key off xpub-derived — a wallet-file import must not
    // silently re-tier such rows to wallet-import.
    const merged = mergeRecordData(
      existingRecord({ walletName: "WalletOne", addressImportance: "xpub-derived" }),
      INCOMING_INPUT,
      { ...BASE_OPTIONS, walletName: "WalletTwo", incomingImportance: "wallet-import" },
    );
    expect(merged.walletName).toBe("WalletTwo");
    expect(merged.addressImportance).toBeUndefined(); // no tier change
  });

  it("never upgrades the tier of third-party (output) addresses", () => {
    const merged = mergeRecordData(
      existingRecord({ addressImportance: "pending-review" }),
      { ...INCOMING_INPUT, isInputAddress: false, direction: "outgoing" as const },
      { ...BASE_OPTIONS, walletName: "WalletTwo", incomingImportance: "wallet-import" },
    );
    expect(merged.addressImportance).toBeUndefined();
  });

  it("never applies wallet metadata to third-party (output) addresses", () => {
    const merged = mergeRecordData(
      existingRecord({ walletName: "WalletOne", addressImportance: "pending-review" }),
      { ...INCOMING_INPUT, isInputAddress: false, direction: "outgoing" as const },
      { ...BASE_OPTIONS, walletName: "WalletTwo" },
    );
    expect(merged.walletName).toBe("WalletOne");
  });
});

describe("executeImport — re-attribution count in ImportResult", () => {
  beforeEach(async () => {
    await Promise.all(testDb.tables.map((t) => t.clear()));
  });

  afterAll(async () => {
    await testDb.delete();
  });

  const OPTIONS: ImportOptions = {
    sourceName: "walletImport-test",
    walletName: "WalletTwo",
    defaultTags: [],
    defaultCategories: [],
  };

  function mergeInfoFor(existing: DbRecord): DuplicateInfo {
    return {
      parsedRecord: {
        type: "address",
        inputString: existing.inputString!,
        label: "Reimported",
        isInputAddress: true,
      },
      existingRecord: existing,
      isNew: false,
      willMerge: true,
    };
  }

  it("counts records moved away from a different wallet name", async () => {
    // Discovery-tier row stamped with WalletOne (the sync inheritance case).
    const idA = (await createRecord({
      type: "address",
      inputString: "bc1qreattrdiscoveredaaaaaaaaaaaa",
      label: "",
      tags: [],
      categories: [],
      source: "blockchain-sync",
      walletName: "WalletOne",
      addressImportance: "blockchain-discovered",
    } as any)) as number;
    // Curated row already owned by WalletOne (the earlier-import leftover).
    const idB = (await createRecord({
      type: "address",
      inputString: "bc1qreattrcuratedbbbbbbbbbbbbbb",
      label: "Mine",
      tags: [],
      categories: [],
      source: "manual",
      walletName: "WalletOne",
      addressImportance: "manual",
    } as any)) as number;
    // Already under WalletTwo — merged but NOT re-attributed.
    const idC = (await createRecord({
      type: "address",
      inputString: "bc1qreattrsamewalletcccccccccc",
      label: "Already here",
      tags: [],
      categories: [],
      source: "manual",
      walletName: "WalletTwo",
      addressImportance: "manual",
    } as any)) as number;

    const existing = await Promise.all([idA, idB, idC].map(async (id) => (await getRecord(id))!));
    const result = await executeImport(existing.map(mergeInfoFor), OPTIONS);

    expect(result.failedRecords).toBe(0);
    expect(result.updatedRecords).toBe(3);
    expect(result.reattributedRecords).toBe(2);

    const [a, b, c] = await Promise.all([idA, idB, idC].map(async (id) => (await getRecord(id))!));
    expect(a.walletName).toBe("WalletTwo");
    expect(b.walletName).toBe("WalletTwo");
    expect(c.walletName).toBe("WalletTwo");
    // The discovery-tier row is promoted to the curated wallet-import tier so
    // it actually counts on the wallet surfaces; curated rows keep their tier.
    expect(a.addressImportance).toBe("wallet-import");
    expect(b.addressImportance).toBe("manual");
    expect(c.addressImportance).toBe("manual");
  });

  it("reports zero re-attributions when no walletName is supplied", async () => {
    const id = (await createRecord({
      type: "address",
      inputString: "bc1qreattrnoexplicitdddddddddd",
      label: "Keep mine",
      tags: [],
      categories: [],
      source: "manual",
      walletName: "WalletOne",
      addressImportance: "manual",
    } as any)) as number;
    const existing = (await getRecord(id))!;

    const result = await executeImport([mergeInfoFor(existing)], {
      ...OPTIONS,
      walletName: undefined,
    });

    expect(result.updatedRecords).toBe(1);
    expect(result.reattributedRecords).toBe(0);
    expect((await getRecord(id))!.walletName).toBe("WalletOne");
  });
});

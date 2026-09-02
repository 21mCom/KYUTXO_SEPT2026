// @vitest-environment jsdom
//
// Task: Transactions entity dropdowns must include values that exist only on
// records, not in the vocabulary tables. getRecordEntityValues() returns the
// distinct wallet/seed/owner/tag/category values found on records via the
// indexed uniqueKeys() path, filtering blank values.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/database";
import { createRecord, clearAllRecords } from "@/lib/data/record-crud";
import { getRecordEntityValues, createWalletName } from "@/lib/data/vocabulary-crud";

describe("getRecordEntityValues", () => {
  beforeEach(async () => {
    await clearAllRecords();
    await db.walletNames.clear();
  });

  it("returns distinct entity values present only on records", async () => {
    await createRecord({
      type: "address",
      inputString: "bc1qtest0000000000000000000000000000000001",
      label: "a",
      owner: "Alice",
      walletName: "Cold Wallet",
      seedName: "seed-1",
      tags: ["kyc-free", "hodl"],
      categories: ["savings"],
      notes: "",
    } as any);
    await createRecord({
      type: "address",
      inputString: "bc1qtest0000000000000000000000000000000002",
      label: "b",
      owner: "Bob",
      walletName: "Cold Wallet",
      seedName: "",
      tags: ["hodl"],
      categories: [],
      notes: "",
    } as any);

    const values = await getRecordEntityValues();
    expect(values.wallets).toEqual(["Cold Wallet"]);
    expect(values.owners.sort()).toEqual(["Alice", "Bob"]);
    expect(values.seeds).toEqual(["seed-1"]);
    expect(values.tags.sort()).toEqual(["hodl", "kyc-free"]);
    expect(values.categories).toEqual(["savings"]);
  });

  it("returns record values even when no vocabulary rows exist", async () => {
    // Simulate an old import whose vocab sync never happened by wiping the
    // vocabulary table after the record is created.
    await createRecord({
      type: "address",
      inputString: "bc1qtest0000000000000000000000000000000003",
      label: "c",
      owner: "",
      walletName: "Orphan Wallet",
      seedName: "",
      tags: [],
      categories: [],
      notes: "",
    } as any);

    await db.walletNames.clear();
    expect(await db.walletNames.count()).toBe(0);
    const values = await getRecordEntityValues();
    expect(values.wallets).toEqual(["Orphan Wallet"]);
  });

  it("coexists with vocabulary entries (dedupe happens at merge site)", async () => {
    await createWalletName("Vocab Wallet");
    await createRecord({
      type: "address",
      inputString: "bc1qtest0000000000000000000000000000000004",
      label: "d",
      owner: "",
      walletName: "Vocab Wallet",
      seedName: "",
      tags: [],
      categories: [],
      notes: "",
    } as any);

    const values = await getRecordEntityValues();
    expect(values.wallets).toEqual(["Vocab Wallet"]);
  });
});

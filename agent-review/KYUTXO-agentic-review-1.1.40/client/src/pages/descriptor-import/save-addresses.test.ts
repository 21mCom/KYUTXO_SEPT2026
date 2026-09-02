// @vitest-environment jsdom
//
// Regression tests for Task #1556 — the Descriptor Import save path.
//
// Root cause guarded here: the page's save used strict vocabulary creates
// (createWalletSoftware etc.) guarded only by stale hook state, while the save
// loop's own fire-and-forget vocabulary sync had already inserted the same
// names — so the final create threw "... already exists" AFTER all rows were
// written and the whole import surfaced as "Save failed". These tests run the
// extracted saveDescriptorAddresses() against the real Dexie facade
// (fake-indexeddb) and assert:
//   1. create branch: rows land with xpub-derived tier/tags/walletName and are
//      returned by the Records default (curated-tier) query and the
//      search/filter collection;
//   2. dedup-update branch: existing blockchain-discovered rows are promoted
//      to xpub-derived with merged tags;
//   3. pre-existing vocabulary (the original failure trigger) does NOT fail
//      the save;
//   4. a mid-loop write failure is reported per-address (failures list +
//      verified count) instead of aborting the loop or silently dropping rows.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type {
  Record as DbRecord,
  RecordOrigin,
} from "@/lib/database";

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

const testDb = new TestDb(`KYUTXO-descsave-${Date.now()}-${Math.random()}`);

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return { ...actual, db: testDb };
});

const { saveDescriptorAddresses } = await import("./save-addresses");
const {
  getAddressRecordsByImportanceTierLimited,
} = await import("@/lib/data/record-crud");
const { buildRecordsCollection } = await import("@/lib/records-query");
const { USER_CURATED_TIERS } = await import("@/lib/db-types");

const META = {
  isMultisig: false,
  isTaproot: true,
  threshold: 1,
  keysCount: 1,
  scriptType: "p2tr",
  tags: ["cold-storage"],
  categories: [] as string[],
  owner: "Alice",
  walletName: "Vault A",
  seedName: "seed-a",
  walletSoftware: "Sparrow",
  markAsVerified: false,
  sourceName: "descriptorImport-test",
};

const addr = (i: number, chainType = "receive") => ({
  // distinct first-8 prefixes to dodge testid/prefix collisions
  address: `bc1ptest${i}x${"q".repeat(30)}`,
  chainType,
  index: i,
});

beforeEach(async () => {
  await Promise.all(testDb.tables.map((t) => t.clear()));
});

afterAll(async () => {
  await testDb.delete();
});

describe("saveDescriptorAddresses", () => {
  it("create branch: rows land in Dexie with tier/tags/walletName and are returned by Records query paths", async () => {
    const addresses = [addr(1), addr(2), addr(3, "change")];
    const result = await saveDescriptorAddresses(addresses, META);

    expect(result.created).toBe(3);
    expect(result.updated).toBe(0);
    expect(result.failures).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.verifiedCount).toBe(3);

    const rows = await testDb.records.toArray();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.type).toBe("address");
      expect(row.addressImportance).toBe("xpub-derived");
      expect(row.tags).toContain("cold-storage");
      expect(row.walletName).toBe("Vault A");
      expect(row.owner).toBe("Alice");
      expect(row.inputStringLower).toBe(row.inputString.toLowerCase());
    }

    // Records default view: curated-tier query path must return them.
    const curated = (
      await Promise.all(
        USER_CURATED_TIERS.map((tier) =>
          getAddressRecordsByImportanceTierLimited(tier, 50),
        ),
      )
    ).flat();
    expect(curated.map((r) => r.inputString).sort()).toEqual(
      addresses.map((a) => a.address).sort(),
    );

    // Records search collection (page filterFn semantics): findable by wallet
    // name and owner via the cross-field substring search.
    for (const rawSearch of ["vault a", "alice"]) {
      const search = rawSearch; // Records lowercases the search input
      const filterFn = (record: DbRecord): boolean => {
        if (
          record.addressImportance === "blockchain-discovered" ||
          record.addressImportance === "pending-review"
        )
          return false;
        return !!(
          record.label?.toLowerCase().includes(search) ||
          record.inputString?.toLowerCase().includes(search) ||
          record.owner?.toLowerCase().includes(search) ||
          record.walletName?.toLowerCase().includes(search) ||
          record.notes?.toLowerCase().includes(search)
        );
      };
      const found = await buildRecordsCollection(
        { search, columnFilters: [], includeBlockchainDiscovered: false },
        filterFn,
      ).collection.filter(filterFn).toArray();
      expect(found.length, `search "${search}"`).toBe(3);
    }

    // Findable by tag via the multiEntry tags column filter.
    const tagFilterFn = (record: DbRecord): boolean =>
      record.addressImportance !== "blockchain-discovered" &&
      record.addressImportance !== "pending-review" &&
      !!record.tags?.some((t) => t.toLowerCase() === "cold-storage");
    const byTag = await buildRecordsCollection(
      {
        search: "",
        columnFilters: [
          { field: "tags", operator: "equals", value: "cold-storage" } as any,
        ],
        includeBlockchainDiscovered: false,
      },
      tagFilterFn,
    ).collection.filter(tagFilterFn).toArray();
    expect(byTag.length).toBe(3);

    // Origins written (createRecord auto-origin + explicit xpub-derived origin).
    expect(await testDb.recordOrigins.count()).toBeGreaterThanOrEqual(3);
  });

  it("dedup-update branch: promotes existing blockchain-discovered rows to xpub-derived with merged tags", async () => {
    const a = addr(4);
    await testDb.records.add({
      type: "address",
      inputString: a.address,
      inputStringLower: a.address.toLowerCase(),
      label: "discovered",
      tags: ["old-tag"],
      categories: [],
      addressImportance: "blockchain-discovered",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any);

    const result = await saveDescriptorAddresses([a, addr(5)], META);
    expect(result.updated).toBe(1);
    expect(result.created).toBe(1);
    expect(result.failures).toEqual([]);
    expect(result.verifiedCount).toBe(2);

    const promoted = await testDb.records
      .where("inputString")
      .equals(a.address)
      .first();
    expect(promoted?.addressImportance).toBe("xpub-derived");
    expect(promoted?.tags).toEqual(
      expect.arrayContaining(["old-tag", "cold-storage"]),
    );
    expect(promoted?.walletName).toBe("Vault A");

    // Promoted row now shows in the curated Records view.
    const curated = await getAddressRecordsByImportanceTierLimited(
      "xpub-derived",
      50,
    );
    expect(curated.map((r) => r.inputString)).toContain(a.address);
  });

  it("pre-existing vocabulary (owner/walletName/seedName/walletSoftware/tags) does NOT fail the save (original Task #1556 root cause)", async () => {
    const now = Date.now();
    await testDb.owners.add({ name: "Alice", createdAt: now });
    await testDb.walletNames.add({ name: "Vault A", createdAt: now });
    await testDb.seedNames.add({ name: "seed-a", createdAt: now });
    await testDb.walletSoftware.add({ name: "Sparrow", createdAt: now });
    await testDb.tags.add({ name: "cold-storage", createdAt: now });

    const result = await saveDescriptorAddresses([addr(6), addr(7)], META);
    expect(result.created).toBe(2);
    expect(result.failures).toEqual([]);
    expect(result.verifiedCount).toBe(2);
    // No duplicate vocabulary rows either.
    expect(await testDb.walletSoftware.count()).toBe(1);
    expect(await testDb.owners.count()).toBe(1);
  });

  it("a mid-loop write failure is reported per-address and does not abort later addresses", async () => {
    const bad = addr(8);
    const good = addr(9);
    const originalAdd = testDb.records.add.bind(testDb.records);
    const spy = vi
      .spyOn(testDb.records, "add")
      .mockImplementation(async (rec: any, ...rest: any[]) => {
        if (rec.inputString === bad.address) {
          throw new Error("simulated quota failure");
        }
        return originalAdd(rec, ...rest);
      });

    try {
      const result = await saveDescriptorAddresses([bad, good], META);
      expect(result.created).toBe(1);
      expect(result.failures).toEqual([
        { address: bad.address, reason: "simulated quota failure" },
      ]);
      // Verified count reflects actual DB state, not the attempted count.
      expect(result.verifiedCount).toBe(1);
      expect(result.missing).toEqual([]);
      const rows = await testDb.records.toArray();
      expect(rows.map((r) => r.inputString)).toEqual([good.address]);
    } finally {
      spy.mockRestore();
    }
  });
});

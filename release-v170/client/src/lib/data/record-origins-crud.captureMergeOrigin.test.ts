// @vitest-environment jsdom
//
// Tests for captureMergeOrigin (Task #1722) — the shared merge-origin capture
// used by every import flow that merges into an existing record.
//
// Guarantees proven here:
//   1. zero-origin records get a BASELINE origin backfilled (snapshotting the
//      record's pre-merge singular fields + tags/categories, origin type
//      inferred like the create hook) before the incoming origin is written,
//      so a first merge is enough to surface a conflict;
//   2. records that already have origin history only get the incoming row
//      appended (no duplicate baseline);
//   3. merges that bring no origin-trackable metadata write nothing;
//   4. origin bookkeeping is non-fatal — a failing write never throws into
//      the merge path;
//   5. end-to-end with detection: a merged import with a differing owner is
//      reported by detectSingularFieldConflicts even though the merge kept
//      the existing value active.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type { Record as DbRecord, RecordOrigin } from "@/lib/database";

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

const testDb = new TestDb(`KYUTXO-mergeorigin-${Date.now()}-${Math.random()}`);

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return { ...actual, db: testDb };
});

const {
  captureMergeOrigin,
  inferOriginTypeForRecord,
  getRecordOriginsByRecordId,
} = await import("./record-origins-crud");
const { createRecord, getRecord } = await import("./record-crud");
const { detectSingularFieldConflicts } = await import("../conflict-detection");

let addrCounter = 0;
function nextAddress(): string {
  addrCounter++;
  // distinct first-8 prefixes to dodge prefix collisions
  return `bc1qmo${addrCounter}x${"q".repeat(30)}`;
}

async function seedRecord(fields: Partial<DbRecord> = {}): Promise<DbRecord> {
  const id = await createRecord({
    type: "address",
    inputString: nextAddress(),
    label: "Existing label",
    tags: ["existing-tag"],
    categories: ["existing-cat"],
    owner: "Alice",
    source: "manual",
    ...fields,
  } as any);
  const record = await getRecord(id as number);
  if (!record) throw new Error("seed record not found");
  return record;
}

beforeEach(async () => {
  // Clear tables inside a single transaction so the clears are atomic and
  // deterministic — concurrent Promise.all clears on fake-indexeddb can race
  // with a previous test's still-settling writes, contaminating the next test.
  await testDb.transaction("rw", testDb.tables, async () => {
    for (const t of testDb.tables) {
      await t.clear();
    }
  });
});

afterAll(async () => {
  await testDb.delete();
});

describe("captureMergeOrigin — baseline backfill", () => {
  it("backfills a baseline origin snapshotting the pre-merge record, then appends the incoming origin", async () => {
    const record = await seedRecord({ owner: "Alice", walletName: "Vault A" });

    await captureMergeOrigin(record, {
      originType: "xpub-derived",
      source: "bulk-import-xpub",
      owner: "Bob",
      tags: ["incoming-tag"],
    });

    const origins = await getRecordOriginsByRecordId(record.id!);
    expect(origins).toHaveLength(2);

    const sorted = [...origins].sort((a, b) => a.createdAt - b.createdAt);
    const [baseline, incoming] = sorted;

    // Baseline snapshots the record's own pre-merge fields.
    expect(baseline.originType).toBe("manual");
    expect(baseline.label).toBe("Existing label");
    expect(baseline.owner).toBe("Alice");
    expect(baseline.walletName).toBe("Vault A");
    expect(baseline.tags).toEqual(["existing-tag"]);
    expect(baseline.categories).toEqual(["existing-cat"]);

    // Incoming carries exactly what the import brought.
    expect(incoming.originType).toBe("xpub-derived");
    expect(incoming.owner).toBe("Bob");
    expect(incoming.tags).toEqual(["incoming-tag"]);

    // Baseline sorts strictly before the incoming origin.
    expect(baseline.createdAt).toBeLessThan(incoming.createdAt);
  });

  it("does NOT backfill a baseline when the record already has origin history", async () => {
    const record = await seedRecord();
    await testDb.recordOrigins.add({
      recordId: record.id!,
      originType: "manual",
      owner: "Alice",
      createdAt: Date.now() - 5000,
    });

    await captureMergeOrigin(record, {
      originType: "wallet-sync",
      source: "walletImport-sparrow",
      owner: "Bob",
    });

    const origins = await getRecordOriginsByRecordId(record.id!);
    expect(origins).toHaveLength(2);
    const types = origins.map((o) => o.originType).sort();
    expect(types).toEqual(["manual", "wallet-sync"]);
  });

  it("skips entirely when the incoming merge carries no origin-trackable metadata", async () => {
    const record = await seedRecord();

    await captureMergeOrigin(record, {
      originType: "xpub-derived",
      label: "   ",
      tags: [],
      categories: [],
    });

    expect(await getRecordOriginsByRecordId(record.id!)).toHaveLength(0);
  });

  it("skips baseline fields that are empty on the pre-merge record", async () => {
    const record = await seedRecord({
      owner: "",
      walletName: undefined,
      tags: [],
      categories: [],
    });

    await captureMergeOrigin(record, {
      originType: "bulk-import",
      owner: "Bob",
    });

    const origins = await getRecordOriginsByRecordId(record.id!);
    const baseline = origins.find((o) => o.originType === "manual")!;
    expect(baseline.owner).toBeUndefined();
    expect(baseline.walletName).toBeUndefined();
    expect(baseline.tags).toBeUndefined();
    expect(baseline.categories).toBeUndefined();
    expect(baseline.label).toBe("Existing label");
  });

  it("is non-fatal: a failing origin write resolves without throwing", async () => {
    const record = await seedRecord();
    const spy = vi
      .spyOn(testDb.recordOrigins, "add")
      .mockRejectedValue(new Error("disk full"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        captureMergeOrigin(record, { originType: "manual", owner: "Bob" }),
      ).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(await getRecordOriginsByRecordId(record.id!)).toHaveLength(0);
  });

  it("ignores records without an id", async () => {
    const record = { ...(await seedRecord()), id: undefined };
    await captureMergeOrigin(record as DbRecord, {
      originType: "manual",
      owner: "Bob",
    });
    expect(await testDb.recordOrigins.count()).toBe(0);
  });
});

describe("captureMergeOrigin — duplicate-origin de-dup (Task: repeated imports)", () => {
  const incoming = {
    originType: "xpub-derived" as const,
    source: "bulk-import-xpub",
    owner: "Bob",
    tags: ["incoming-tag"],
  };

  it("re-running the identical import refreshes the timestamp instead of appending a row", async () => {
    const record = await seedRecord();

    await captureMergeOrigin(record, incoming);
    const afterFirst = await getRecordOriginsByRecordId(record.id!);
    expect(afterFirst).toHaveLength(2); // baseline + incoming

    const firstIncoming = afterFirst.find(
      (o) => o.originType === "xpub-derived",
    )!;

    // Re-import same values a bit later.
    await captureMergeOrigin(record, { ...incoming, createdAt: firstIncoming.createdAt + 5000 });

    const afterSecond = await getRecordOriginsByRecordId(record.id!);
    expect(afterSecond).toHaveLength(2); // no new row
    const updated = afterSecond.find((o) => o.id === firstIncoming.id)!;
    expect(updated.createdAt).toBe(firstIncoming.createdAt + 5000);
  });

  it("treats blank strings / empty arrays as equal to absent fields when comparing", async () => {
    const record = await seedRecord();
    await captureMergeOrigin(record, incoming);

    await captureMergeOrigin(record, {
      ...incoming,
      label: "   ",
      notes: "",
      categories: [],
      tags: ["incoming-tag"],
    });

    expect(await getRecordOriginsByRecordId(record.id!)).toHaveLength(2);
  });

  it("a re-import with CHANGED values still appends a new row", async () => {
    const record = await seedRecord();
    await captureMergeOrigin(record, incoming);

    await captureMergeOrigin(record, { ...incoming, owner: "Carol" });

    const origins = await getRecordOriginsByRecordId(record.id!);
    expect(origins).toHaveLength(3);
    const owners = origins
      .filter((o) => o.originType === "xpub-derived")
      .map((o) => o.owner)
      .sort();
    expect(owners).toEqual(["Bob", "Carol"]);
  });

  it("only de-dups against the same source/originType, not other sources", async () => {
    const record = await seedRecord();
    await captureMergeOrigin(record, incoming);

    // Same values but a different source: appends.
    await captureMergeOrigin(record, {
      ...incoming,
      source: "walletImport-sparrow",
      originType: "wallet-sync",
    });

    expect(await getRecordOriginsByRecordId(record.id!)).toHaveLength(3);
  });

  it("de-dups walletImport sources that differ only by the run timestamp", async () => {
    const record = await seedRecord();
    const run1 = {
      ...incoming,
      originType: "wallet-sync" as const,
      source: "walletImport-Sparrow Wallet_2026-08-02_161633",
    };
    await captureMergeOrigin(record, run1);
    const before = await getRecordOriginsByRecordId(record.id!);

    // Same import re-run later: only the embedded timestamp differs.
    await captureMergeOrigin(record, {
      ...run1,
      source: "walletImport-Sparrow Wallet_2026-08-03_090000",
    });

    const after = await getRecordOriginsByRecordId(record.id!);
    expect(after).toHaveLength(before.length);
    const refreshed = after.find((o) => o.originType === "wallet-sync");
    // Displayed source follows the latest run.
    expect(refreshed?.source).toBe("walletImport-Sparrow Wallet_2026-08-03_090000");
  });

  it("de-dups against the MOST RECENT same-source origin only", async () => {
    const record = await seedRecord();
    await captureMergeOrigin(record, incoming);
    // Changed value appends…
    await captureMergeOrigin(record, { ...incoming, owner: "Carol" });
    // …and re-asserting the OLD value appends again (it differs from the
    // most recent same-source origin, which now says Carol).
    await captureMergeOrigin(record, incoming);

    const sameSource = (await getRecordOriginsByRecordId(record.id!)).filter(
      (o) => o.originType === "xpub-derived",
    );
    expect(sameSource).toHaveLength(3);
  });
});

describe("inferOriginTypeForRecord — mirrors the create-hook inference", () => {
  it("classifies by source/importance/xpub the way use-records does", () => {
    expect(
      inferOriginTypeForRecord({ source: "blockchain-sync" } as DbRecord),
    ).toBe("blockchain-sync");
    expect(
      inferOriginTypeForRecord({
        addressImportance: "blockchain-discovered",
      } as DbRecord),
    ).toBe("blockchain-sync");
    expect(
      inferOriginTypeForRecord({ source: "walletImport-sparrow" } as DbRecord),
    ).toBe("wallet-sync");
    expect(
      inferOriginTypeForRecord({ addressImportance: "wallet-import" } as DbRecord),
    ).toBe("wallet-sync");
    expect(
      inferOriginTypeForRecord({ addressImportance: "xpub-derived" } as DbRecord),
    ).toBe("xpub-derived");
    expect(inferOriginTypeForRecord({ xpub: "zpub6..." } as DbRecord)).toBe(
      "xpub-derived",
    );
    expect(
      inferOriginTypeForRecord({ derivationPath: "m/84'/0'/0'/0/0" } as DbRecord),
    ).toBe("xpub-derived");
    expect(inferOriginTypeForRecord({ source: "bulk-import" } as DbRecord)).toBe(
      "bulk-import",
    );
    expect(
      inferOriginTypeForRecord({ source: "descriptorImport-x" } as DbRecord),
    ).toBe("bulk-import");
    expect(inferOriginTypeForRecord({ source: "manual" } as DbRecord)).toBe(
      "manual",
    );
    expect(inferOriginTypeForRecord({} as DbRecord)).toBe("manual");
  });

  it("uses the inferred type for the backfilled baseline", async () => {
    const record = await seedRecord({
      source: "walletImport-electrum",
      addressImportance: "wallet-import",
    });

    await captureMergeOrigin(record, {
      originType: "bulk-import",
      owner: "Bob",
    });

    const origins = await getRecordOriginsByRecordId(record.id!);
    const baseline = origins.find((o) => o.originType !== "bulk-import")!;
    expect(baseline.originType).toBe("wallet-sync");
  });
});

describe("captureMergeOrigin + detection end-to-end", () => {
  it("a first merge with a differing owner surfaces a conflict for an origin-less record", async () => {
    const record = await seedRecord({ owner: "Alice" });

    // Merge policy keeps the existing owner; the import brought "Bob".
    await captureMergeOrigin(record, {
      originType: "wallet-sync",
      source: "walletImport-sparrow",
      owner: "Bob",
    });

    const origins = await getRecordOriginsByRecordId(record.id!);
    const conflicts = detectSingularFieldConflicts(record, origins);

    expect(conflicts.map((c) => c.field.key)).toContain("owner");
    const ownerConflict = conflicts.find((c) => c.field.key === "owner")!;
    expect(ownerConflict.originValues.map((ov) => ov.value).sort()).toEqual([
      "Alice",
      "Bob",
    ]);
  });

  it("a merge whose values all match the record surfaces nothing", async () => {
    const record = await seedRecord({ owner: "Alice" });

    await captureMergeOrigin(record, {
      originType: "wallet-sync",
      source: "walletImport-sparrow",
      owner: "Alice",
      label: "Existing label",
    });

    const origins = await getRecordOriginsByRecordId(record.id!);
    expect(origins).toHaveLength(2);
    expect(detectSingularFieldConflicts(record, origins)).toHaveLength(0);
  });
});

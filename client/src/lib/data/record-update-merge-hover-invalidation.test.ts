// @vitest-environment jsdom
//
// End-to-end coverage for the OTHER bulk-write -> hover-metadata-cache
// invalidation paths beyond the Bulk Editor (bulkUpdateRecords) and full wipe
// (clearAllRecords), which are already pinned in
// bulk-update-hover-invalidation.test.ts.
//
// The Quick Tagger, the address/descriptor/BIP-329 importers, and the
// wallet-import duplicate merge all reach the database through the SAME
// per-record CRUD primitives:
//   - updateRecord(id, changes)  — apply-to-existing / merge-as-update
//   - deleteRecord(id)           — drop the losing record in a consolidation
// (Quick Tagger loops updateRecord over every touched entry; the importers and
// the wallet-import merge compute merged metadata and call updateRecord on the
// surviving record.) If any of those primitives stopped dropping the
// hover-metadata cache, the orange FileText note indicator on a visible
// AddressLink/TxidLink would stay stale for up to the cache TTL even though the
// record's notes/label changed. There was no automated test pinning that those
// primitives invalidate, so this suite locks the contract.
//
// Like the sibling suite, this runs the REAL Dexie engine (via fake-indexeddb)
// so record-crud's writes and metadata-hover's reads share one database, and the
// REAL metadata-hover module so a subscribed identifier really re-resolves
// end-to-end (no hover required).

import "fake-indexeddb/auto";

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type { Record as DbRecord, Attachment } from "@/lib/database";
import type { ParsedRecord } from "../wallet-import/types";

class TestDb extends Dexie {
  records!: Table<DbRecord, number>;
  attachments!: Table<Attachment, number>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      records:
        "++id, type, inputString, inputStringLower, label, owner, walletName, " +
        "seedName, walletSoftware, *tags, *categories, createdAt, updatedAt, " +
        "chainType, syncDepth, addressImportance, [type+addressImportance], " +
        "[addressImportance+id], [type+id], [owner+id], [walletName+id], " +
        "flowType, discoveredFromRecordId",
      attachments: "++id, recordId, identifier",
    });
  }
}

const testDb = new TestDb(`KYUTXO-merge-hover-${Date.now()}-${Math.random()}`);

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return { ...actual, db: testDb };
});

const { updateRecord, deleteRecord } = await import("./record-crud");
const { mergeRecordData } = await import("../wallet-import/merge-utils");
const {
  subscribeCacheEntry,
  getCachedRecord,
  resolveIdentifier,
  invalidateCachedRecord,
} = await import("../metadata-hover");

// The invalidation hop is fire-and-forget: record-crud dynamic-imports
// metadata-hover, then the re-resolution issues an async DB read. Settle both
// the microtask queue and any pending fake-indexeddb work before asserting.
async function settle() {
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function seedRecord(overrides: Partial<DbRecord> = {}): Promise<number> {
  const id = await testDb.records.add({
    type: "address",
    inputString: "bc1qseed",
    inputStringLower: "bc1qseed",
    label: "Unlabeled",
    notes: "",
    tags: [],
    categories: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as DbRecord);
  return id as number;
}

beforeAll(async () => {
  await testDb.open();
});

afterAll(() => {
  testDb.close();
});

beforeEach(async () => {
  await testDb.records.clear();
  await testDb.attachments.clear();
});

describe("Quick Tagger bulk-label write -> hover cache invalidation", () => {
  it("re-resolves EVERY touched identifier (no hover) when labels are applied", async () => {
    // Quick Tagger applies the chosen metadata to many matched entries by
    // looping updateRecord over each one. Seed several records, each rendered as
    // a visible (subscribed) link, then run the same per-record write loop.
    const identifiers = ["bc1qtagone", "bc1qtagtwo", "bc1qtagthree"];
    const ids: number[] = [];
    for (const identifier of identifiers) {
      ids.push(
        await seedRecord({
          inputString: identifier,
          inputStringLower: identifier.toLowerCase(),
          label: "Unlabeled",
        }),
      );
    }

    // Warm + subscribe each identifier the way a visible AddressLink/TxidLink
    // does.
    const cbs = identifiers.map(() => vi.fn());
    const unsubs: Array<() => void> = [];
    for (let i = 0; i < identifiers.length; i++) {
      invalidateCachedRecord(identifiers[i]);
      await resolveIdentifier(identifiers[i]);
      unsubs.push(subscribeCacheEntry(identifiers[i], cbs[i]));
    }

    // Quick Tagger's apply loop: one updateRecord per touched record.
    for (const id of ids) {
      await updateRecord(
        id,
        { label: "Exchange Deposit", tags: ["audited"] },
        { skipVocabularySync: true },
      );
    }
    await settle();

    // Every visible link re-resolved with the freshly written metadata — the
    // orange note/label indicator refreshes immediately, no hover needed.
    for (let i = 0; i < identifiers.length; i++) {
      expect(cbs[i]).toHaveBeenCalled();
      const last = cbs[i].mock.calls[cbs[i].mock.calls.length - 1][0] as
        | DbRecord
        | null;
      expect(last?.label).toBe("Exchange Deposit");
      expect(last?.tags).toContain("audited");
      expect(getCachedRecord(identifiers[i])?.label).toBe("Exchange Deposit");
      unsubs[i]();
    }
  });

  it("re-resolves a subscribed identifier when only the note changes", async () => {
    const identifier = "bc1qtaggernote";
    const id = await seedRecord({
      inputString: identifier,
      inputStringLower: identifier.toLowerCase(),
      notes: "",
    });

    invalidateCachedRecord(identifier);
    await resolveIdentifier(identifier);
    expect(getCachedRecord(identifier)?.notes ?? "").toBe("");

    const cb = vi.fn();
    const unsub = subscribeCacheEntry(identifier, cb);

    await updateRecord(
      id,
      { notes: "tagged via Quick Tagger" },
      { skipVocabularySync: true },
    );
    await settle();

    expect(cb).toHaveBeenCalled();
    const last = cb.mock.calls[cb.mock.calls.length - 1][0] as DbRecord | null;
    expect(last?.notes).toBe("tagged via Quick Tagger");
    expect(getCachedRecord(identifier)?.notes).toBe("tagged via Quick Tagger");
    unsub();
  });
});

describe("duplicate merge -> hover cache invalidation", () => {
  it("invalidates the surviving identifier after a merge-as-update", async () => {
    // The address/descriptor/BIP-329 + wallet importers merge an incoming
    // duplicate into the existing ("surviving") record by computing merged
    // metadata (mergeRecordData) and calling updateRecord on it — no inputString
    // change. The surviving link must refresh.
    const identifier = "bc1qsurvivor";
    const id = await seedRecord({
      inputString: identifier,
      inputStringLower: identifier.toLowerCase(),
      label: "From wallet",
      notes: "",
      tags: ["old"],
    });
    const existing = (await testDb.records.get(id))!;

    invalidateCachedRecord(identifier);
    await resolveIdentifier(identifier);
    expect(getCachedRecord(identifier)?.notes ?? "").toBe("");

    const cb = vi.fn();
    const unsub = subscribeCacheEntry(identifier, cb);

    const incoming: ParsedRecord = {
      type: "address",
      inputString: identifier,
      label: "Cold Storage",
      notes: "imported note",
      isInputAddress: true,
    };
    const mergedChanges = mergeRecordData(existing, incoming, {
      defaultTags: ["imported"],
      defaultCategories: [],
      sourceName: "Test Importer",
    });

    await updateRecord(id, mergedChanges, { skipVocabularySync: true });
    await settle();

    // Surviving link re-resolved with the merged label/notes/tags.
    expect(cb).toHaveBeenCalled();
    const last = cb.mock.calls[cb.mock.calls.length - 1][0] as DbRecord | null;
    expect(last?.label).toBe("Cold Storage");
    expect(last?.notes).toContain("imported note");
    expect(last?.tags).toEqual(expect.arrayContaining(["old", "imported"]));
    const cached = getCachedRecord(identifier);
    expect(cached?.label).toBe("Cold Storage");
    unsub();
  });

  it("invalidates BOTH the surviving and the dropped identifier on a consolidation", async () => {
    // A true duplicate consolidation keeps the canonical record (surviving),
    // folds the loser's metadata into it via updateRecord, and deletes the loser
    // (dropped) via deleteRecord. Both links are visible; both must refresh —
    // the surviving one with the merged note, the dropped one to "no record".
    const surviving = "bc1qcanonical";
    const dropped = "bc1qVARIANT"; // near-duplicate (different casing)
    const survivingId = await seedRecord({
      inputString: surviving,
      inputStringLower: surviving.toLowerCase(),
      label: "Canonical",
      notes: "",
      tags: ["a"],
    });
    const droppedId = await seedRecord({
      inputString: dropped,
      inputStringLower: dropped.toLowerCase(),
      label: "Variant",
      notes: "loser note",
      tags: ["b"],
    });

    invalidateCachedRecord(surviving);
    invalidateCachedRecord(dropped);
    await resolveIdentifier(surviving);
    await resolveIdentifier(dropped);
    expect(getCachedRecord(surviving)?.inputString).toBe(surviving);
    expect(getCachedRecord(dropped)?.inputString).toBe(dropped);

    const survivingCb = vi.fn();
    const droppedCb = vi.fn();
    const unsubSurviving = subscribeCacheEntry(surviving, survivingCb);
    const unsubDropped = subscribeCacheEntry(dropped, droppedCb);

    // Consolidate: merge loser metadata into the survivor, then delete loser.
    await updateRecord(
      survivingId,
      { notes: "loser note", tags: ["a", "b"] },
      { skipVocabularySync: true },
    );
    await deleteRecord(droppedId, { skipNotification: true });
    await settle();

    // Surviving link re-resolved -> now carries the merged note.
    expect(survivingCb).toHaveBeenCalled();
    const survivingLast = survivingCb.mock.calls[
      survivingCb.mock.calls.length - 1
    ][0] as DbRecord | null;
    expect(survivingLast?.notes).toBe("loser note");
    expect(getCachedRecord(surviving)?.notes).toBe("loser note");

    // Dropped link re-resolved -> the record is gone, so it now resolves to null
    // and its indicator clears.
    expect(droppedCb).toHaveBeenCalled();
    const droppedLast = droppedCb.mock.calls[
      droppedCb.mock.calls.length - 1
    ][0] as DbRecord | null;
    expect(droppedLast).toBeNull();
    expect(getCachedRecord(dropped)).toBeNull();

    unsubSurviving();
    unsubDropped();
  });
});

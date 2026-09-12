// @vitest-environment jsdom
//
// Regression guard for the LEGACY (pre-v3) backup restore path's APPEND-ONLY
// "additional data" tables: price data, UTXO lineage, and custody segments.
// This logic used to live inline inside SettingsPage's ~1000-line
// `handleRestore` and was exercised by no automated test, so a regression in
// how the backup id is stripped, how many rows are reported back, or whether the
// unique custody `segmentId` index is respected would have gone unnoticed.
//
// The inline branches are now shared helpers in `./legacy-restore-misc`. These
// tests drive those helpers over the REAL `@/lib/database` schema through
// fake-indexeddb (mirroring the other legacy/v3 round-trip tests) and assert the
// invariants the legacy path depended on:
//   - price data: every row added with a FRESH autoincrement id (backup id
//     stripped); the returned count matches the rows written. Replace mode (the
//     default) adds every row; merge mode skips any row whose
//     [date+currency+asset] already exists (both pre-existing in the vault and
//     duplicated within the same backup) so an overlapping merge can't double up
//     the daily price rows.
//   - utxo lineage: every row added with a fresh id; counted as "lineage".
//   - custody segments: every row added with a fresh id; restored but NOT
//     counted toward the user-facing "lineage" number; the unique `segmentId`
//     index is preserved (distinct segmentIds round-trip without collision).
//   - empty/undefined inputs no-op cleanly.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";

import {
  restoreLegacyPriceData,
  restoreLegacyLineage,
} from "./legacy-restore-misc";
import {
  clearPriceData,
  getAllPriceData,
} from "@/lib/data/price-data-crud";
import {
  clearUtxoLineage,
  clearCustodySegments,
  getAllUtxoLineage,
  getAllCustodySegments,
} from "@/lib/data/lineage-crud";

async function clearEverything(): Promise<void> {
  await clearPriceData({ skipNotification: true });
  await clearUtxoLineage({ skipNotification: true });
  await clearCustodySegments({ skipNotification: true });
}

// A minimal valid backup price row. `id` is the BACKUP id (stripped on restore).
function backupPrice(id: number, date: string, extra: any = {}) {
  return {
    id,
    date,
    currency: "USD",
    asset: "BTC",
    close: 50000,
    source: "investing",
    importedAt: 1_700_000_000,
    ...extra,
  };
}

// A minimal valid backup utxoLineage row.
function backupLineage(id: number, consumingTxid: string, extra: any = {}) {
  return {
    id,
    spentTxid: `spent-${consumingTxid}`,
    spentVout: 0,
    spentAddress: "addr-spent",
    spentAmount: 100000,
    consumingTxid,
    createdTxid: consumingTxid,
    createdVout: 1,
    createdAddress: "addr-created",
    createdAmount: 99000,
    spentOwned: true,
    createdOwned: false,
    isChange: false,
    confidence: "high",
    blockTime: 1_700_000_000,
    blockHeight: 800000,
    createdAt: 1_700_000_000,
    ...extra,
  };
}

// A minimal valid backup custody segment. `segmentId` is unique in the schema.
function backupSegment(id: number, segmentId: string, extra: any = {}) {
  return {
    id,
    segmentId,
    originTxid: `origin-${segmentId}`,
    originVout: 0,
    originAddress: "addr-origin",
    originDate: 1_700_000_000,
    originAmount: 100000,
    currentAmount: 100000,
    status: "active",
    hopCount: 0,
    evidenceTxids: [],
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    ...extra,
  };
}

beforeEach(async () => {
  await clearEverything();
});

describe("legacy restore: price data", () => {
  it("adds every row with a fresh id (backup id stripped) and returns the count", async () => {
    const added = await restoreLegacyPriceData([
      backupPrice(101, "2024-01-01", { close: 42000 }),
      backupPrice(102, "2024-01-02", { close: 43000 }),
    ]);

    expect(added).toBe(2);

    const live = await getAllPriceData();
    expect(live).toHaveLength(2);
    // Backup ids (101/102) are stripped — every row gets a fresh autoincrement
    // id, never the backup's.
    expect(live.every((p) => p.id !== 101 && p.id !== 102)).toBe(true);
    expect(live.every((p) => typeof p.id === "number")).toBe(true);
    const byDate = new Map(live.map((p) => [p.date, p]));
    expect(byDate.get("2024-01-01")!.close).toBe(42000);
    expect(byDate.get("2024-01-02")!.close).toBe(43000);
  });

  it("replace mode does NOT de-dup: the same date/currency/asset can be added twice", async () => {
    // The [date+currency+asset] index is not unique, and replace mode (the
    // default) relies on the table having been cleared first, so it adds every
    // row rather than skipping duplicates.
    const added = await restoreLegacyPriceData([
      backupPrice(201, "2024-02-01"),
      backupPrice(202, "2024-02-01"),
    ]);
    expect(added).toBe(2);
    const live = await getAllPriceData();
    expect(live.filter((p) => p.date === "2024-02-01")).toHaveLength(2);
  });

  it("merge mode skips rows whose date+currency+asset already exists in the vault", async () => {
    // Seed the vault with one day (as if a prior restore/import added it).
    await restoreLegacyPriceData([backupPrice(1, "2024-03-01", { close: 60000 })]);
    expect(await getAllPriceData()).toHaveLength(1);

    // Merging a backup whose 2024-03-01 overlaps the existing row must skip that
    // row (no doubling) and add only the genuinely new 2024-03-02.
    const added = await restoreLegacyPriceData(
      [
        backupPrice(2, "2024-03-01", { close: 99999 }),
        backupPrice(3, "2024-03-02", { close: 61000 }),
      ],
      "merge",
    );
    expect(added).toBe(1);

    const live = await getAllPriceData();
    expect(live).toHaveLength(2);
    // The pre-existing row is untouched (its original close survives; the
    // overlapping backup row was skipped, not applied).
    expect(live.filter((p) => p.date === "2024-03-01")).toHaveLength(1);
    expect(live.find((p) => p.date === "2024-03-01")!.close).toBe(60000);
    expect(live.filter((p) => p.date === "2024-03-02")).toHaveLength(1);
  });

  it("merge mode also de-dups duplicate days WITHIN one backup", async () => {
    // An internally-duplicated backup must not re-add the same day twice in a
    // single merge — the skip-set is extended as rows are added.
    const added = await restoreLegacyPriceData(
      [
        backupPrice(10, "2024-04-01"),
        backupPrice(11, "2024-04-01"),
        backupPrice(12, "2024-04-02"),
      ],
      "merge",
    );
    expect(added).toBe(2);
    const live = await getAllPriceData();
    expect(live).toHaveLength(2);
    expect(live.filter((p) => p.date === "2024-04-01")).toHaveLength(1);
  });

  it("merge mode distinguishes by currency and asset, not just date", async () => {
    await restoreLegacyPriceData([
      backupPrice(20, "2024-05-01", { currency: "USD", asset: "BTC" }),
    ]);
    // Same date but a different currency / asset is NOT a duplicate.
    const added = await restoreLegacyPriceData(
      [
        backupPrice(21, "2024-05-01", { currency: "EUR", asset: "BTC" }),
        backupPrice(22, "2024-05-01", { currency: "USD", asset: "ETH" }),
        backupPrice(23, "2024-05-01", { currency: "USD", asset: "BTC" }), // dup
      ],
      "merge",
    );
    expect(added).toBe(2);
    expect(await getAllPriceData()).toHaveLength(3);
  });

  it("no-ops cleanly on an empty/undefined array", async () => {
    await expect(restoreLegacyPriceData([])).resolves.toBe(0);
    await expect(restoreLegacyPriceData(undefined)).resolves.toBe(0);
    await expect(restoreLegacyPriceData([], "merge")).resolves.toBe(0);
    await expect(restoreLegacyPriceData(undefined, "merge")).resolves.toBe(0);
    expect(await getAllPriceData()).toHaveLength(0);
  });
});

describe("legacy restore: utxo lineage + custody segments", () => {
  it("adds lineage and segments with fresh ids and counts only lineage", async () => {
    const result = await restoreLegacyLineage(
      [backupLineage(301, "tx-a"), backupLineage(302, "tx-b")],
      [backupSegment(401, "seg-1"), backupSegment(402, "seg-2"), backupSegment(403, "seg-3")],
    );

    // Only utxoLineage rows are surfaced to the user as "lineage".
    expect(result.lineageAdded).toBe(2);
    expect(result.segmentsAdded).toBe(3);

    const liveLineage = await getAllUtxoLineage();
    expect(liveLineage).toHaveLength(2);
    // Backup ids stripped.
    expect(liveLineage.every((l) => l.id !== 301 && l.id !== 302)).toBe(true);
    expect(new Set(liveLineage.map((l) => l.consumingTxid))).toEqual(
      new Set(["tx-a", "tx-b"]),
    );

    const liveSegments = await getAllCustodySegments();
    expect(liveSegments).toHaveLength(3);
    expect(liveSegments.every((s) => s.id !== 401 && s.id !== 402 && s.id !== 403)).toBe(true);
    // Distinct segmentIds survive the unique `&segmentId` index without collision.
    expect(new Set(liveSegments.map((s) => s.segmentId))).toEqual(
      new Set(["seg-1", "seg-2", "seg-3"]),
    );
  });

  it("restores lineage when there are no custody segments", async () => {
    const result = await restoreLegacyLineage([backupLineage(501, "tx-solo")], []);
    expect(result.lineageAdded).toBe(1);
    expect(result.segmentsAdded).toBe(0);
    expect(await getAllUtxoLineage()).toHaveLength(1);
    expect(await getAllCustodySegments()).toHaveLength(0);
  });

  it("restores custody segments when there is no lineage", async () => {
    const result = await restoreLegacyLineage(undefined, [backupSegment(601, "seg-only")]);
    expect(result.lineageAdded).toBe(0);
    expect(result.segmentsAdded).toBe(1);
    expect(await getAllUtxoLineage()).toHaveLength(0);
    expect(await getAllCustodySegments()).toHaveLength(1);
  });

  it("rejects a backup with duplicate custody segmentIds in replace mode (unique index)", async () => {
    // In replace mode the caller has cleared first and rows are appended as-is;
    // two rows sharing a segmentId violate the unique index. This documents that
    // the unique constraint is genuinely enforced by the schema and that replace
    // mode behaviour is unchanged.
    await expect(
      restoreLegacyLineage(undefined, [
        backupSegment(701, "dup-seg"),
        backupSegment(702, "dup-seg"),
      ]),
    ).rejects.toBeTruthy();
  });

  it("merge mode skips a custody segment whose segmentId already exists (no throw)", async () => {
    // Seed the vault with an existing segment (as a prior restore/merge would).
    const seed = await restoreLegacyLineage(undefined, [backupSegment(800, "seg-existing")]);
    expect(seed.segmentsAdded).toBe(1);

    // A merge whose backup re-includes that segmentId (plus a brand-new one)
    // must complete WITHOUT throwing: the already-present segment is skipped and
    // only the new one is added — the whole restore no longer aborts mid-way.
    const result = await restoreLegacyLineage(
      undefined,
      [backupSegment(801, "seg-existing"), backupSegment(802, "seg-new")],
      "merge",
    );
    expect(result.segmentsAdded).toBe(1);

    const liveSegments = await getAllCustodySegments();
    expect(liveSegments).toHaveLength(2);
    expect(new Set(liveSegments.map((s) => s.segmentId))).toEqual(
      new Set(["seg-existing", "seg-new"]),
    );
  });

  it("merge mode dedups custody segments that share a segmentId WITHIN one backup", async () => {
    // Two backup rows sharing a segmentId would throw in replace mode; in merge
    // mode the second is skipped so the restore completes.
    const result = await restoreLegacyLineage(
      undefined,
      [backupSegment(810, "dup-merge"), backupSegment(811, "dup-merge")],
      "merge",
    );
    expect(result.segmentsAdded).toBe(1);
    expect(await getAllCustodySegments()).toHaveLength(1);
  });

  it("merge mode skips a lineage edge that already exists", async () => {
    // Seed an existing lineage edge.
    const seed = await restoreLegacyLineage([backupLineage(900, "tx-dup")], undefined);
    expect(seed.lineageAdded).toBe(1);

    // A merge re-including that same edge (same spent/created identity) plus a
    // new edge adds only the new one — no duplicate edge piles up.
    const result = await restoreLegacyLineage(
      [backupLineage(901, "tx-dup"), backupLineage(902, "tx-fresh")],
      undefined,
      "merge",
    );
    expect(result.lineageAdded).toBe(1);

    const liveLineage = await getAllUtxoLineage();
    expect(liveLineage).toHaveLength(2);
    expect(new Set(liveLineage.map((l) => l.consumingTxid))).toEqual(
      new Set(["tx-dup", "tx-fresh"]),
    );
  });

  it("merge mode adds new lineage and segments to a non-empty vault without de-duping distinct rows", async () => {
    await restoreLegacyLineage([backupLineage(950, "tx-seed")], [backupSegment(960, "seg-seed")]);

    const result = await restoreLegacyLineage(
      [backupLineage(951, "tx-a"), backupLineage(952, "tx-b")],
      [backupSegment(961, "seg-a"), backupSegment(962, "seg-b")],
      "merge",
    );
    expect(result.lineageAdded).toBe(2);
    expect(result.segmentsAdded).toBe(2);
    expect(await getAllUtxoLineage()).toHaveLength(3);
    expect(await getAllCustodySegments()).toHaveLength(3);
  });

  it("no-ops cleanly when both inputs are empty/undefined", async () => {
    await expect(restoreLegacyLineage([], [])).resolves.toEqual({
      lineageAdded: 0,
      segmentsAdded: 0,
    });
    await expect(restoreLegacyLineage(undefined, undefined)).resolves.toEqual({
      lineageAdded: 0,
      segmentsAdded: 0,
    });
    expect(await getAllUtxoLineage()).toHaveLength(0);
    expect(await getAllCustodySegments()).toHaveLength(0);
  });
});

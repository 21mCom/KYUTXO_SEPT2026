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
//     stripped); no de-dup; the returned count matches the rows written.
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

  it("does NOT de-dup: the same date/currency/asset can be added twice", async () => {
    // The [date+currency+asset] index is not unique, so the legacy append-only
    // path adds duplicates rather than skipping them.
    const added = await restoreLegacyPriceData([
      backupPrice(201, "2024-02-01"),
      backupPrice(202, "2024-02-01"),
    ]);
    expect(added).toBe(2);
    const live = await getAllPriceData();
    expect(live.filter((p) => p.date === "2024-02-01")).toHaveLength(2);
  });

  it("no-ops cleanly on an empty/undefined array", async () => {
    await expect(restoreLegacyPriceData([])).resolves.toBe(0);
    await expect(restoreLegacyPriceData(undefined)).resolves.toBe(0);
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

  it("rejects a backup with duplicate custody segmentIds (unique index)", async () => {
    // The legacy path never de-duped segments and relies on replace mode having
    // cleared first; two rows sharing a segmentId violate the unique index. This
    // documents that the unique constraint is genuinely enforced by the schema.
    await expect(
      restoreLegacyLineage(undefined, [
        backupSegment(701, "dup-seg"),
        backupSegment(702, "dup-seg"),
      ]),
    ).rejects.toBeTruthy();
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

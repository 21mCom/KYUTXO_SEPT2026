// @vitest-environment jsdom
//
// Regression guard: dust flags must not be silently lost when restoring a
// LEGACY (pre-v3, JSON) backup. KYUTXO's own legacy exports never wrote a
// `dustFlags` key (the table postdates the legacy format), but a hand-edited or
// third-party legacy JSON that DOES carry dustFlags must round-trip — and a
// replace-mode legacy restore must clear pre-existing flags (they point at
// transaction outputs the restore just wiped), exactly like the v3 path.
//
// SettingsPage's legacy `handleRestore` now destructures `dustFlags = []` from
// the backup data and routes it through the SAME shared helper the v3 inline
// path uses (`restoreDustFlagRows` in dust-flags-crud), clearing the table
// first in replace mode. These tests drive that exact sequence over the real
// `@/lib/database` schema via fake-indexeddb:
//   - replace: table cleared, every backup row added, stale flags gone.
//   - merge: rows whose unique `outpoint` already exists are skipped (no
//     unique-index abort), new outpoints added, existing flags kept.
//   - a legacy backup WITHOUT a dustFlags key restores cleanly (no-op) and, in
//     merge mode, leaves existing flags untouched.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";

import { db } from "@/lib/database";
import {
  markOutpointsAsDust,
  clearDustFlags,
  restoreDustFlagRows,
  getAllDustFlags,
  toOutpoint,
} from "@/lib/data/dust-flags-crud";

const TXID_A = "a".repeat(64);
const TXID_B = "b".repeat(64);
const TXID_C = "c".repeat(64);

function legacyBackupData(withDustFlags: boolean): Record<string, any> {
  const base: Record<string, any> = {
    records: [],
    tags: [],
    categories: [],
  };
  if (withDustFlags) {
    base.dustFlags = [
      {
        id: 42,
        outpoint: toOutpoint(TXID_A, 0),
        txid: TXID_A,
        vout: 0,
        address: "bc1qbackupaddr0",
        amountSats: 546,
        markedAt: 1700000000000,
      },
      {
        // No precomputed outpoint: helper must rebuild it from txid/vout.
        id: 43,
        txid: TXID_B,
        vout: 2,
        address: "bc1qbackupaddr1",
        amountSats: 800,
        markedAt: 1700000001000,
      },
    ];
  }
  return base;
}

// Mirrors the legacy handleRestore sequence for dust flags: replace mode
// clears the table first, then both modes route through restoreDustFlagRows.
async function legacyRestoreDustFlags(
  data: Record<string, any>,
  restoreMode: "merge" | "replace",
): Promise<number> {
  const { dustFlags = [] } = data;
  if (restoreMode === "replace") {
    await clearDustFlags({ skipNotification: true });
  }
  return restoreDustFlagRows(dustFlags, restoreMode, { skipNotification: true });
}

beforeEach(async () => {
  await clearDustFlags({ skipNotification: true });
});

describe("legacy JSON restore: dust flags", () => {
  it("replace mode: clears stale flags and restores every backup row", async () => {
    // Stale flag from the pre-restore vault (its tx is about to be wiped).
    await markOutpointsAsDust([
      { txid: TXID_C, vout: 1, address: "bc1qstale", amountSats: 600 },
    ]);
    expect((await getAllDustFlags()).length).toBe(1);

    const added = await legacyRestoreDustFlags(legacyBackupData(true), "replace");
    expect(added).toBe(2);

    const flags = await getAllDustFlags();
    expect(flags.length).toBe(2);
    const outpoints = new Set(flags.map((f) => f.outpoint));
    expect(outpoints.has(toOutpoint(TXID_A, 0))).toBe(true);
    expect(outpoints.has(toOutpoint(TXID_B, 2))).toBe(true);
    // Stale pre-restore flag must be gone.
    expect(outpoints.has(toOutpoint(TXID_C, 1))).toBe(false);

    // Field round-trip: backup id stripped, payload preserved.
    const a = flags.find((f) => f.outpoint === toOutpoint(TXID_A, 0))!;
    expect(a.id).not.toBe(42);
    expect(a.address).toBe("bc1qbackupaddr0");
    expect(a.amountSats).toBe(546);
    expect(a.markedAt).toBe(1700000000000);

    // Rebuilt-outpoint row round-trips too.
    const b = flags.find((f) => f.outpoint === toOutpoint(TXID_B, 2))!;
    expect(b.txid).toBe(TXID_B);
    expect(b.vout).toBe(2);
  });

  it("merge mode: keeps existing flags, skips colliding outpoints, adds new ones", async () => {
    // Existing flag that ALSO appears in the backup (same outpoint, different
    // payload) — must be kept as-is, not duplicated, not overwritten.
    await markOutpointsAsDust([
      { txid: TXID_A, vout: 0, address: "bc1qliveaddr", amountSats: 999 },
    ]);
    // Existing flag not in the backup — must survive the merge.
    await markOutpointsAsDust([
      { txid: TXID_C, vout: 1, address: "bc1qkeepme", amountSats: 700 },
    ]);

    const added = await legacyRestoreDustFlags(legacyBackupData(true), "merge");
    expect(added).toBe(1); // only the TXID_B row is new

    const flags = await getAllDustFlags();
    expect(flags.length).toBe(3);
    const live = flags.find((f) => f.outpoint === toOutpoint(TXID_A, 0))!;
    expect(live.address).toBe("bc1qliveaddr"); // live row untouched
    expect(live.amountSats).toBe(999);
    expect(flags.some((f) => f.outpoint === toOutpoint(TXID_C, 1))).toBe(true);
    expect(flags.some((f) => f.outpoint === toOutpoint(TXID_B, 2))).toBe(true);
  });

  it("legacy backup without a dustFlags key restores cleanly (merge keeps existing flags)", async () => {
    await markOutpointsAsDust([
      { txid: TXID_C, vout: 1, address: "bc1qkeepme", amountSats: 700 },
    ]);

    const added = await legacyRestoreDustFlags(legacyBackupData(false), "merge");
    expect(added).toBe(0);
    expect((await getAllDustFlags()).length).toBe(1);
  });

  it("replace mode with a flag-less legacy backup still clears stale flags", async () => {
    await markOutpointsAsDust([
      { txid: TXID_C, vout: 1, address: "bc1qstale", amountSats: 600 },
    ]);

    const added = await legacyRestoreDustFlags(legacyBackupData(false), "replace");
    expect(added).toBe(0);
    expect(await db.dustFlags.count()).toBe(0);
  });
});

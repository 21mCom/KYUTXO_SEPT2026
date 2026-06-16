// @vitest-environment jsdom
//
// One-time MIGRATION-PATH harness. The legacy fixture's whole point is to prove
// that opening an OLD vault still upgrades correctly — the exact scenario that
// kept silently dropping/!breaking data on real vaults. This test exercises the
// real, production upgrade chain end to end:
//
//   1. Seed a database AT AN OLD SCHEMA VERSION (v29: records have no
//      `inputStringLower` index and the rows lack the field).
//   2. Reopen the SAME database through the REAL `KYUTXODatabase` class, which
//      declares versions up to the current one. Dexie detects the old on-disk
//      version and runs the genuine v30 upgrade callback from database.ts.
//   3. Assert the upgrade actually backfilled `inputStringLower` AND that the
//      newly-added index is usable — i.e. the migration ran end to end, not a
//      reimplementation of it.
//
// NOTE: this file intentionally does NOT mock `@/lib/database` — it needs the
// real upgrade functions. It also never opens the module-level `db` singleton.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Dexie from "dexie";
import { KYUTXODatabase } from "@/lib/database";
import { buildLegacyRecordRows, buildLegacyAttachmentRows } from "@/lib/testSeedData";

const DB_NAME = "KYUTXODatabase";

// The records schema EXACTLY as declared at v29 in database.ts — note the
// absence of `inputStringLower`. This is what makes the seeded DB genuinely
// "pre-migration".
const V29_RECORDS =
  "++id, type, inputString, label, owner, walletName, seedName, walletSoftware, " +
  "*tags, *categories, createdAt, updatedAt, chainType, syncDepth, " +
  "addressImportance, [type+addressImportance], [addressImportance+id], " +
  "[type+id], [owner+id], [walletName+id], flowType, discoveredFromRecordId";

let upgraded: KYUTXODatabase | null = null;

async function freshDelete() {
  if (upgraded) {
    upgraded.close();
    upgraded = null;
  }
  await Dexie.delete(DB_NAME);
}

beforeEach(freshDelete);
afterEach(freshDelete);

describe("one-time migration path (legacy vault -> current schema)", () => {
  it("v30 upgrade backfills inputStringLower on a pre-migration vault", async () => {
    const RECORDS = 40;
    const ATTACHMENTS = 12;
    const now = Date.now();

    // --- 1. Seed at OLD version 29 -----------------------------------------
    const seed = new Dexie(DB_NAME);
    seed.version(29).stores({
      records: V29_RECORDS,
      attachments: "++id, recordId, createdAt",
    });
    await seed.open();
    expect(seed.verno).toBe(29);

    const recordRows = buildLegacyRecordRows(RECORDS, now);
    const recordIds = (await seed.table("records").bulkAdd(recordRows, {
      allKeys: true,
    })) as number[];
    await seed
      .table("attachments")
      .bulkAdd(buildLegacyAttachmentRows(ATTACHMENTS, recordIds, now));

    // Precondition: the seeded rows genuinely lack the field the migration adds.
    const beforeRows = await seed.table("records").toArray();
    expect(beforeRows).toHaveLength(RECORDS);
    expect(beforeRows.every((r) => r.inputStringLower === undefined)).toBe(true);
    seed.close();

    // --- 2. Reopen through the REAL class -> real upgraders run -------------
    upgraded = new KYUTXODatabase();
    await upgraded.open();
    // Current schema version is well past 29; opening forced the upgrade chain.
    expect(upgraded.verno).toBeGreaterThanOrEqual(30);

    // --- 3. Assert the genuine v30 upgrade did its work ---------------------
    const afterRows = await upgraded.records.toArray();
    expect(afterRows).toHaveLength(RECORDS);
    for (const r of afterRows) {
      expect(r.inputStringLower).toBe((r.inputString as string).toLowerCase());
    }

    // The newly-added index must be usable end to end (schema change applied,
    // not just the data callback): look a record up BY the migrated index.
    const hit = await upgraded.records
      .where("inputStringLower")
      .equals("legacy-addr-0")
      .toArray();
    expect(hit).toHaveLength(1);
    expect(hit[0].inputString).toBe("Legacy-Addr-0");

    // Attachments survived the upgrade intact (still at their legacy root path —
    // path normalisation is a separate runtime repair, not this schema upgrade).
    const attachments = await upgraded.attachments.toArray();
    expect(attachments).toHaveLength(ATTACHMENTS);
    expect(attachments.every((a) => !a.objectStoragePath.includes("/"))).toBe(true);
  });
});

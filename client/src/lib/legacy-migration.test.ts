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
import { KYUTXODatabase, CURRENT_SCHEMA_VERSION } from "@/lib/database";
import { buildLegacyRecordRows, buildLegacyAttachmentRows } from "@/lib/testSeedData";
import { buildLegacyVaultAtV25, ENCRYPTED_AT_REST } from "@/lib/legacy-vault-fixture";
import { subscribeDbUpgradeProgress, type DbUpgradeProgress } from "@/lib/db-upgrade-progress";
import { deriveKey, decrypt } from "@/lib/crypto";

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

  it("upgrades a full 1.1.24 vault (v25, encrypted at rest) through the whole chain with visible progress", async () => {
    // This is the EXACT first-launch scenario a 1.1.24 user hits today:
    // a v25 vault with field-level encryption at rest opens against the
    // current schema, running v26..v37 in one upgrade transaction. It must
    //   (a) end at CURRENT_SCHEMA_VERSION,
    //   (b) preserve every encrypted payload via v27's move to
    //       _legacyEncryptedPayload (so the login decrypt can restore data),
    //   (c) clean v29 placeholder debris,
    //   (d) backfill v30 inputStringLower,
    //   (e) report human-readable progress throughout — the fix for the
    //       "first launch looks frozen" hang report.
    const PASSWORD = "correct horse battery staple";
    const built = await buildLegacyVaultAtV25({
      password: PASSWORD,
      counts: {
        // >512 records and participants so the per-512-row progress reports
        // genuinely fire during the v27/v29/v30 walks.
        curatedRecords: 250,
        discoveredRecords: 350,
        transactions: 80,
        participants: 700,
        placeholderVocab: 2,
      },
    });
    const totalRecords = built.counts.curatedRecords + built.counts.discoveredRecords;

    const progressEvents: DbUpgradeProgress[] = [];
    const unsubscribe = subscribeDbUpgradeProgress((p) => {
      if (p) progressEvents.push(p);
    });

    try {
      // --- Reopen through the REAL class → v26..v37 upgrade chain runs -------
      upgraded = new KYUTXODatabase();
      await upgraded.open();
      expect(upgraded.verno).toBe(CURRENT_SCHEMA_VERSION);

      // --- (b) v27: payloads moved, encryption flags gone ---------------------
      const records = await upgraded.records.toArray();
      expect(records).toHaveLength(totalRecords);
      for (const r of records) {
        expect(typeof (r as { _legacyEncryptedPayload?: string })._legacyEncryptedPayload).toBe(
          "string",
        );
        expect((r as { isEncrypted?: boolean }).isEncrypted).toBeUndefined();
        expect((r as { encryptedPayload?: string }).encryptedPayload).toBeUndefined();
      }
      const participants = await upgraded.transactionParticipants.toArray();
      expect(participants).toHaveLength(built.counts.participants);
      for (const p of participants) {
        expect(typeof (p as { _legacyEncryptedPayload?: string })._legacyEncryptedPayload).toBe(
          "string",
        );
        expect((p as { isEncrypted?: boolean }).isEncrypted).toBeUndefined();
      }

      // --- (c) v29: placeholder vocab deleted, record fields blanked ----------
      const ownerNames = (await upgraded.owners.toArray()).map((o) => o.name);
      expect(ownerNames.some((n) => n.includes(ENCRYPTED_AT_REST))).toBe(false);
      expect(ownerNames).toContain("Owner 0");
      // label was '[encrypted]' at rest → cleaned to '' by v29. inputString is
      // deliberately NOT cleaned (it stays the locked sentinel until decrypt).
      for (const r of records) {
        expect(r.label).toBe("");
        expect(r.inputString).toBe(ENCRYPTED_AT_REST);
      }

      // --- (d) v30: inputStringLower backfilled from the sentinel -------------
      for (const r of records) {
        expect(r.inputStringLower).toBe(ENCRYPTED_AT_REST);
      }

      // --- (e) progress was visible while the chain ran -----------------------
      const steps = new Set(progressEvents.map((e) => e.step));
      expect(steps.has("Updating records")).toBe(true);
      expect(steps.has("Updating transactionParticipants")).toBe(true);
      expect(steps.has("Cleaning record fields")).toBe(true);
      expect(steps.has("Indexing search field")).toBe(true);
      // The per-row counters actually advanced (>512-row tables report rows).
      expect(progressEvents.some((e) => e.rowsProcessed >= 512)).toBe(true);

      // --- Sanity: the moved payload is still decryptable with the vault key --
      // (proves the upgrade preserved bytes AND the fixture matches the real
      // 1.1.24 key path — the login decrypt migration picks up from here).
      const salt = Uint8Array.from(atob(built.saltBase64), (c) => c.charCodeAt(0));
      const key = await deriveKey(PASSWORD, salt);
      const sample = built.samples[0];
      const sampleRow = records[sample.recordIndex];
      const payload = (sampleRow as { _legacyEncryptedPayload?: string })._legacyEncryptedPayload!;
      const plain = JSON.parse(await decrypt(payload, key));
      expect(plain.inputString).toBe(sample.inputString);
      expect(plain.label).toBe(sample.label);
    } finally {
      unsubscribe();
    }
    // Long timeout: this genuinely runs 600 WebCrypto encrypts + the whole
    // v26..v37 upgrade chain over fake-indexeddb (~10s).
  }, 60_000);
});

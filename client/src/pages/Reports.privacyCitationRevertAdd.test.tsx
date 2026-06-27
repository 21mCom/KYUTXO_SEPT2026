// @vitest-environment jsdom
//
// Regression coverage for REVERTING a merge-mode ADD of the Privacy Audit
// entity list back to the bundled list.
//
// Reports.privacyCitationRevertOverride.test.tsx proves the OVERRIDE revert: a
// user merge-imports an entry whose address ALSO exists in the bundled list,
// and "Revert to bundled" (resetEntitySnapshot) restores the ORIGINAL bundled
// flag reason for that address. This test proves the companion case — the ADD
// revert.
//
// In merge mode a user can also import a BRAND-NEW address that is NOT in the
// bundled list at all. mergeWithBundled() unions it on top of the bundled
// defaults, so the active count is bundled + 1 and the Privacy Audit flags the
// counterparty. When the user clicks "Revert to bundled" (resetEntitySnapshot),
// that added address should no longer be a known entity AT ALL — unlike the
// override case where a bundled value comes back, here there is nothing to come
// back, so the audit must stop flagging the counterparty entirely.
//
// Two things must happen for the add to be truly gone:
//   1. The active list must drop the user-added address so lookupEntity returns
//      undefined and the active count is back to exactly the bundled count, and
//      a fresh runPrivacyAudit() produces NO entity finding for that contact.
//   2. The persisted snapshot must be cleared so a simulated restart
//      (loadEntitySnapshotFromStorage) reports source 'bundled' and the added
//      entity does NOT silently re-apply.
//
// A bug in either half would leave a stale user-added entity silently flagging a
// contact after the user thought they had reverted.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { clearAllRecords } from "@/lib/data/record-crud";
import {
  addTransaction,
  addParticipant,
  clearTransactions,
  clearParticipants,
} from "@/lib/data/transaction-crud";
import { runPrivacyAudit } from "@/lib/privacy-audit";
import {
  resetActiveEntityList,
  lookupEntity,
  getActiveEntityCount,
  getBundledEntityCount,
} from "@/lib/privacy-entity-list";
import {
  importEntitySnapshot,
  resetEntitySnapshot,
  loadEntitySnapshotFromStorage,
} from "@/lib/data/entity-list-store";

// OWNED1 pays directly to ENTITY_ADDR in TX1 — a hop-1 (direct) contact that
// detectEntityContacts captures. ENTITY_ADDR is deliberately NOT in the bundled
// list, so it can only ever be flagged because the merged-in user entry added
// it. Both are real, checksum-valid mainnet addresses (the import path validates
// every address). Non-round amounts keep other heuristics from muddying the
// finding under test.
const OWNED1 = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const ENTITY_ADDR = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
const TX1 = "3333333333333333333333333333333333333333333333333333333333333333";

// A known BUNDLED address (Binance) — used to prove the revert leaves the rest
// of the bundled list intact and that the merge unioned (not replaced).
const BUNDLED_ADDR = "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo";

// The USER's brand-new add: a name, an exchange category, and a sourceNote that
// cites the SAME address (to avoid a mismatched-citation warning). These MUST be
// gone after the revert.
const ADD_URL = `https://www.walletexplorer.com/address/${ENTITY_ADDR}`;
const ADD_NOTE = `Discovered by analyst — ${ADD_URL}`;
const ADD_NAME = "Brand New Exchange";
const ADD_CATEGORY = "exchange";

// The exact bytes a user would have in their snapshot file: the `{ entries: [] }`
// envelope form, a single brand-new entry whose address is NOT in the bundled
// list, so a merge ADDS (not overrides) it.
const SNAPSHOT_JSON = JSON.stringify({
  entries: [
    {
      address: ENTITY_ADDR,
      name: ADD_NAME,
      category: ADD_CATEGORY,
      sourceNote: ADD_NOTE,
    },
  ],
});

async function seedDirectContact(): Promise<void> {
  await addTransaction(
    { txid: TX1, blockHeight: 800002, blockTime: 1_700_000_900, fee: 1_000, feeRate: 5, syncedAt: Date.now() },
    { skipNotification: true },
  );
  await addParticipant(
    { txid: TX1, role: "input", address: OWNED1, amount: 250_123, vout: 0 },
    { skipNotification: true },
  );
  await addParticipant(
    { txid: TX1, role: "output", address: ENTITY_ADDR, amount: 199_111, vout: 0 },
    { skipNotification: true },
  );
}

/**
 * Drive the user snapshot through the REAL MERGE import path. Because the entry
 * address is NOT in the bundled list, the merge ADDS it, so the active count is
 * bundled + 1.
 */
async function importAddSnapshot(): Promise<void> {
  const parsed = JSON.parse(SNAPSHOT_JSON) as unknown;
  const result = await importEntitySnapshot(parsed, "user-snapshot.json", "merge");
  expect(result.valid).toBe(true);
  expect(result.mode).toBe("merge");
  expect(result.count).toBe(1);
  expect(result.activeCount).toBe(getBundledEntityCount() + 1);
}

beforeEach(async () => {
  await clearAllRecords({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
  await seedDirectContact();
  await resetEntitySnapshot();
  resetActiveEntityList();

  // Start each test from the ADDED state: a merge-mode add is active AND
  // persisted, exactly as it would be after the user imported it.
  await importAddSnapshot();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetEntitySnapshot();
  resetActiveEntityList();
  await clearAllRecords({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
});

describe("Reverting a merge ADD removes the user-added entity from the audit", () => {
  it("sanity-checks the added entity is flagged before the revert", async () => {
    // Pre-condition: the merge unioned the add onto the bundled list.
    expect(getActiveEntityCount()).toBe(getBundledEntityCount() + 1);

    // The added address resolves to the user's attribution.
    expect(lookupEntity(ENTITY_ADDR)).toEqual({
      address: ENTITY_ADDR,
      name: ADD_NAME,
      category: ADD_CATEGORY,
      sourceNote: ADD_NOTE,
    });
    // A bundled entry is still present (the merge did not replace it).
    expect(lookupEntity(BUNDLED_ADDR)?.name).toBe("Binance");

    // The audit flags the contact because of the added entity.
    const result = await runPrivacyAudit([OWNED1]);
    const finding = result.findings.find(
      (f) => f.type === "ENTITY_EXCHANGE" && f.addresses.includes(ENTITY_ADDR),
    );
    expect(finding).toBeTruthy();
  });

  it("drops the added entity from the active list after resetEntitySnapshot()", async () => {
    await resetEntitySnapshot();

    // The active list is back to exactly the bundled list.
    expect(getActiveEntityCount()).toBe(getBundledEntityCount());

    // The previously-added address is no longer a known entity at all.
    expect(lookupEntity(ENTITY_ADDR)).toBeUndefined();

    // The rest of the bundled list is untouched by the revert.
    expect(lookupEntity(BUNDLED_ADDR)?.name).toBe("Binance");
  });

  it("produces NO entity finding for the contact on a fresh audit after the revert", async () => {
    await resetEntitySnapshot();

    const result = await runPrivacyAudit([OWNED1]);

    // No ENTITY_* finding mentions the reverted address on any surface.
    const stillFlagged = [...result.findings, ...result.warnings].some(
      (f) => f.type.startsWith("ENTITY_") && f.addresses.includes(ENTITY_ADDR),
    );
    expect(stillFlagged).toBe(false);
  });

  it("clears the persisted snapshot so a simulated restart stays bundled", async () => {
    await resetEntitySnapshot();

    // Simulate an app restart: wipe the in-memory active list, then re-hydrate
    // it solely from settings.entityListSnapshot, exactly as startup does.
    resetActiveEntityList();

    const status = await loadEntitySnapshotFromStorage();
    // The persisted snapshot was cleared, so startup reports bundled.
    expect(status.source).toBe("bundled");
    expect(status.activeCount).toBe(getBundledEntityCount());

    // The added entity does NOT come back after the restart.
    expect(lookupEntity(ENTITY_ADDR)).toBeUndefined();

    // And the audit on the re-hydrated bundled list no longer flags the contact.
    const result = await runPrivacyAudit([OWNED1]);
    const stillFlagged = [...result.findings, ...result.warnings].some(
      (f) => f.type.startsWith("ENTITY_") && f.addresses.includes(ENTITY_ADDR),
    );
    expect(stillFlagged).toBe(false);
  });
});

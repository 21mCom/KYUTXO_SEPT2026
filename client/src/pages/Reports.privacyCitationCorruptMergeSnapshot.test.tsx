// @vitest-environment jsdom
//
// Regression coverage for the MERGE re-apply branch in
// loadEntitySnapshotFromStorage() when the persisted snapshot is only PARTLY
// broken — i.e. a mode='merge' snapshot whose entries contain one perfectly
// valid user entry alongside one invalid-address entry.
//
// Reports.privacyCitationMergedList.test.tsx pins the happy merge re-apply path
// (all entries valid → bundled + user entries unioned). Reports.
// privacyCitationCorruptSnapshot.test.tsx pins the fully-corrupt fallback (a
// single invalid entry, no mode → bundled). But neither covers the subtler
// merge risk: loadEntitySnapshotFromStorage() validates the WHOLE entries array
// with validateEntitySnapshot(), so a single bad entry rejects the ENTIRE
// snapshot and the load must fall back to the bundled list. A regression could
// instead apply a half-built merged list — silently dropping the good bundled
// flags, or applying only the one valid user entry on top of an empty list —
// and no audit-level test would catch it.
//
// This test writes a mode='merge' snapshot DIRECTLY to
// settings.entityListSnapshot (bypassing the import path, which would have
// rejected it) containing ONE valid user entry plus ONE invalid-address entry,
// calls the REAL loadEntitySnapshotFromStorage(), and asserts:
//   - the status source is 'bundled' and the active list is the full bundled
//     list (the partly-broken snapshot was rejected whole, NOT half-applied),
//   - neither the valid user entry NOR the invalid entry is resolvable (the
//     snapshot did not partially apply), and
//   - a KNOWN bundled entity (Binance) still flags a seeded owned -> bundled
//     contact through the REAL runPrivacyAudit().

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  addTransaction,
  addParticipant,
  clearTransactions,
  clearParticipants,
} from "@/lib/data/transaction-crud";
import { clearAllRecords } from "@/lib/data/record-crud";
import { runPrivacyAudit, type EntityCitation } from "@/lib/privacy-audit";
import {
  resetActiveEntityList,
  lookupEntity,
  getActiveEntityCount,
  getActiveEntitySource,
  getBundledEntityCount,
} from "@/lib/privacy-entity-list";
import {
  loadEntitySnapshotFromStorage,
  resetEntitySnapshot,
  type EntityListStatus,
} from "@/lib/data/entity-list-store";
import { putSettings } from "@/lib/data/settings-crud";
import type { Settings } from "@/lib/db-types";

// OWNED1 pays directly to BUNDLED_ADDR in TX1 — a hop-1 (direct) contact that
// detectEntityContacts captures. OWNED1 is a REAL, checksum-valid mainnet
// address. BUNDLED_ADDR is Binance's address from the bundled list, so it can
// only flag because the partly-broken snapshot fell back to the bundled
// defaults.
const OWNED1 = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const BUNDLED_ADDR = "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo";
const TX1 = "3333333333333333333333333333333333333333333333333333333333333333";

// A perfectly VALID user entry that a correct merge WOULD have unioned onto the
// bundled list. Because it shares the snapshot with a broken sibling entry, the
// whole snapshot is rejected and this entry must NOT end up in the active list.
const VALID_USER_ADDR = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
// The invalid address embedded in the same merge snapshot. It must NOT resolve
// after the fallback (it was never applied).
const INVALID_ADDR = "not-a-valid-address";

const BUNDLED_ENTITY_NAME = "Binance";
const BUNDLED_ENTITY_CATEGORY_LABEL = "Exchange";

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
    { txid: TX1, role: "output", address: BUNDLED_ADDR, amount: 199_111, vout: 0 },
    { skipNotification: true },
  );
}

function getCitations(details: Record<string, unknown>): EntityCitation[] {
  return (details.citations as EntityCitation[]) ?? [];
}

/**
 * Write a PARTLY-BROKEN merge snapshot to settings.entityListSnapshot directly,
 * bypassing the import path that would have rejected it: mode='merge' with one
 * valid user entry plus one invalid-address entry. Seeds only the load path
 * under test.
 */
async function persistPartlyBrokenMergeSnapshot(): Promise<void> {
  await putSettings(
    {
      id: "default",
      entityListSnapshot: {
        importedAt: Date.now(),
        sourceLabel: "partly-broken-merge.json",
        mode: "merge",
        // One fully valid entry + one invalid address. Because the load path
        // validates the WHOLE array, this single bad entry rejects the entire
        // snapshot and exercises the silent-fallback branch.
        entries: [
          {
            address: VALID_USER_ADDR,
            name: "Merged Test Exchange",
            category: "exchange",
          },
          {
            address: INVALID_ADDR,
            name: "Bad Entry",
            category: "exchange",
          },
        ],
      },
    } as Settings,
    { skipNotification: true },
  );
}

let loadStatus: EntityListStatus;

beforeEach(async () => {
  await clearAllRecords({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
  await seedDirectContact();
  await resetEntitySnapshot();
  resetActiveEntityList();

  // Write the partly-broken merge snapshot, then re-hydrate solely from
  // storage, exactly as startup does.
  await persistPartlyBrokenMergeSnapshot();
  loadStatus = await loadEntitySnapshotFromStorage();
});

afterEach(async () => {
  await resetEntitySnapshot();
  resetActiveEntityList();
  await clearAllRecords({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
});

describe("a partly-broken merge snapshot is rejected whole and falls back to bundled", () => {
  it("reports the load source as 'bundled' and keeps the full bundled list (not half-merged)", () => {
    expect(loadStatus.source).toBe("bundled");
    expect(getActiveEntitySource()).toBe("bundled");

    // The whole snapshot was rejected: the active list is exactly the bundled
    // list — not bundled + 1 (valid user entry kept), and not 1 (valid entry
    // applied on top of an emptied list).
    expect(getActiveEntityCount()).toBe(getBundledEntityCount());
    expect(getActiveEntityCount()).toBeGreaterThan(0);

    // Neither snapshot entry made it into the active list — not the invalid
    // one, and crucially not the otherwise-valid user entry either.
    expect(lookupEntity(INVALID_ADDR)).toBeUndefined();
    expect(lookupEntity(VALID_USER_ADDR)).toBeUndefined();

    // A known bundled entry is present — proving the bundled fallback is live.
    expect(lookupEntity(BUNDLED_ADDR)?.name).toBe(BUNDLED_ENTITY_NAME);
  });

  it("still flags a seeded owned -> bundled-entity contact via the real audit", async () => {
    const result = await runPrivacyAudit([OWNED1]);

    const finding = result.findings.find((f) => f.type === "ENTITY_EXCHANGE");
    expect(finding).toBeTruthy();

    const citations = getCitations(finding!.details);
    expect(citations).toHaveLength(1);
    expect(citations[0].name).toBe(BUNDLED_ENTITY_NAME);
    expect(citations[0].address).toBe(BUNDLED_ADDR);
    expect(citations[0].categoryLabel).toBe(BUNDLED_ENTITY_CATEGORY_LABEL);
  });
});

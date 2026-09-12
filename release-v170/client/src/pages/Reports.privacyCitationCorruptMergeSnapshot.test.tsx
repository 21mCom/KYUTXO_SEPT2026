// @vitest-environment jsdom
//
// Regression coverage for the MERGE re-apply branch in
// loadEntitySnapshotFromStorage() when the persisted snapshot is only PARTLY
// broken — i.e. a mode='merge' snapshot whose entries contain one perfectly
// valid user entry alongside one invalid-address entry.
//
// Reports.privacyCitationMergedList.test.tsx pins the happy merge re-apply path
// (all entries valid → bundled + user entries unioned). Reports.
// privacyCitationCorruptSnapshot.test.tsx pins the fully-corrupt fallback (no
// valid entries at all → bundled). This test pins the subtler PARTIAL case:
// loadEntitySnapshotFromStorage() validates the WHOLE entries array with
// validateEntitySnapshot(), but when some entries are valid and some are not,
// it deliberately KEEPS the valid subset (re-applied under the persisted mode)
// rather than discarding all the user's correct entries because of one bad one.
// It surfaces a `partialWarning` in the returned status so the UI can advise the
// user that some entries were skipped. The full bundled fallback is reserved for
// the case where NO entries survive validation.
//
// This test writes a mode='merge' snapshot DIRECTLY to
// settings.entityListSnapshot (bypassing the import path, which would have
// rejected it) containing ONE valid user entry plus ONE invalid-address entry,
// calls the REAL loadEntitySnapshotFromStorage(), and asserts:
//   - the status source is 'imported' with a partialWarning of one kept / one
//     skipped (the valid subset was applied, NOT the whole-snapshot rejection),
//   - the valid user entry IS resolvable (merged on top of the bundled list)
//     while the invalid entry is NOT,
//   - the bundled defaults survive the merge (active count == bundled + 1), and
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

// A perfectly VALID user entry that the partial-keep merge unions onto the
// bundled list. Because it is the surviving valid entry, it MUST end up in the
// active list (merged on top of the bundled defaults).
const VALID_USER_ADDR = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
const VALID_USER_NAME = "Merged Test Exchange";
// The invalid address embedded in the same merge snapshot. It is skipped, so it
// must NOT resolve after the partial load.
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
        // One fully valid entry + one invalid address. The load path validates
        // the WHOLE array but keeps the valid subset, so the valid entry is
        // merged onto the bundled list and the invalid one is skipped (with a
        // partialWarning surfaced in the status).
        entries: [
          {
            address: VALID_USER_ADDR,
            name: VALID_USER_NAME,
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

describe("a partly-broken merge snapshot keeps the valid subset and warns", () => {
  it("reports the load source as 'imported' with a one-kept/one-skipped partialWarning", () => {
    expect(loadStatus.source).toBe("imported");
    expect(getActiveEntitySource()).toBe("imported");

    // The valid subset was applied (not the whole-snapshot rejection): exactly
    // one entry was kept and one invalid entry was skipped.
    expect(loadStatus.partialWarning).toEqual({ validCount: 1, skippedCount: 1 });

    // The merge unions the surviving valid entry on top of the full bundled
    // list — bundled defaults survive, plus the one user entry (it is not in
    // the bundled list, so the count grows by exactly one).
    expect(getActiveEntityCount()).toBe(getBundledEntityCount() + 1);
    expect(getBundledEntityCount()).toBeGreaterThan(0);

    // The valid user entry IS resolvable (it was merged in); the invalid entry
    // was skipped and never applied.
    expect(lookupEntity(VALID_USER_ADDR)?.name).toBe(VALID_USER_NAME);
    expect(lookupEntity(INVALID_ADDR)).toBeUndefined();

    // The bundled defaults are still live alongside the merged user entry.
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

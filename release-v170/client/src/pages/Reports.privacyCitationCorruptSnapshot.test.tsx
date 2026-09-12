// @vitest-environment jsdom
//
// Regression coverage for the CORRUPT-SNAPSHOT fallback branch in
// loadEntitySnapshotFromStorage(): if a persisted entityListSnapshot fails
// validation (e.g. an invalid Bitcoin address sneaks in, with no `mode`), the
// load must SILENTLY fall back to the bundled list so app startup is never
// disrupted.
//
// entity-list-store.persist.test.ts already pins the load-LEVEL fallback (it
// asserts the status source is 'bundled' and the active count equals the
// bundled count). But nothing proves it end to end through the Privacy Audit —
// i.e. that after a corrupt snapshot is rejected, the BUNDLED entities are what
// actually flag contacts in a real audit. A regression could leave the active
// list empty (no flags) while still reporting 'bundled', and no audit-level
// test would catch it.
//
// This test writes a corrupt snapshot (invalid address, NO mode field) DIRECTLY
// to settings.entityListSnapshot (so it exercises only the load path, not the
// import path that would have rejected it), calls the REAL
// loadEntitySnapshotFromStorage(), and asserts:
//   - the status source is 'bundled' and the active list is the full bundled
//     list (the corrupt entry was NOT applied and the list is NOT empty),
//   - the corrupt entry's address is NOT resolvable, and
//   - a KNOWN bundled entity (Binance) still flags a seeded owned -> bundled
//     contact through the REAL runPrivacyAudit().

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
// only flag because the corrupt snapshot fell back to the bundled defaults.
const OWNED1 = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const BUNDLED_ADDR = "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo";
const TX1 = "3333333333333333333333333333333333333333333333333333333333333333";

// The invalid address embedded in the corrupt snapshot. It must NOT resolve
// after the fallback (it was never applied).
const CORRUPT_ADDR = "not-a-valid-address";

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
 * Write a CORRUPT snapshot to settings.entityListSnapshot directly, bypassing
 * the import path that would have rejected it: an invalid Bitcoin address and
 * no `mode` field. Seeds only the load path under test.
 */
async function persistCorruptSnapshot(): Promise<void> {
  await putSettings(
    {
      id: "default",
      entityListSnapshot: {
        importedAt: Date.now(),
        sourceLabel: "corrupt-snapshot.json",
        // NOTE: invalid address + no `mode` field — this is what makes it
        // corrupt and exercises the silent-fallback branch.
        entries: [
          {
            address: CORRUPT_ADDR,
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

  // Write the corrupt snapshot, then re-hydrate solely from storage, exactly as
  // startup does.
  await persistCorruptSnapshot();
  loadStatus = await loadEntitySnapshotFromStorage();
});

afterEach(async () => {
  await resetEntitySnapshot();
  resetActiveEntityList();
  await clearAllRecords({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
});

describe("a corrupt persisted snapshot silently falls back to the bundled list", () => {
  it("reports the load source as 'bundled' and keeps the full bundled list (not empty)", () => {
    expect(loadStatus.source).toBe("bundled");
    expect(getActiveEntitySource()).toBe("bundled");

    // The corrupt entry was NOT applied: the active list is the full bundled
    // list, not an empty list (which would silently flag nothing).
    expect(getActiveEntityCount()).toBe(getBundledEntityCount());
    expect(getActiveEntityCount()).toBeGreaterThan(0);

    // The invalid address never made it into the active list.
    expect(lookupEntity(CORRUPT_ADDR)).toBeUndefined();
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

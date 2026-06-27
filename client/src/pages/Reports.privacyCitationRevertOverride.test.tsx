// @vitest-environment jsdom
//
// Regression coverage for REVERTING a merge-mode OVERRIDE of the Privacy Audit
// entity list back to the bundled flag reason.
//
// Reports.privacyCitationMergedOverride.test.tsx proves the OVERRIDE *wins*: a
// user imports (merge mode) an entry whose address ALSO exists in the bundled
// list, re-attributing it with a different name/category/sourceNote, and that
// override surfaces everywhere (panel, JSON export, printable PDF) and survives
// a restart. This test proves the natural opposite — the REVERT.
//
// When the user clicks "Revert to bundled" (resetEntitySnapshot), two things
// must happen for the override to be truly gone:
//   1. The active list must restore the ORIGINAL bundled name/category/
//      sourceNote for the previously-overridden address, so a fresh
//      runPrivacyAudit() flags it as the BUNDLED entity again (Binance /
//      Exchange / the bundled sourceNote), not the user's re-categorization.
//   2. The persisted snapshot must be cleared so a simulated restart
//      (loadEntitySnapshotFromStorage) reports source 'bundled' and the
//      override does NOT silently re-apply.
//
// A bug in either half would leave a stale override silently flagging a
// counterparty after the user thought they had reverted.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { clearAllRecords } from "@/lib/data/record-crud";
import {
  addTransaction,
  addParticipant,
  clearTransactions,
  clearParticipants,
} from "@/lib/data/transaction-crud";
import { runPrivacyAudit, type EntityCitation } from "@/lib/privacy-audit";
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
// detectEntityContacts captures. ENTITY_ADDR is a KNOWN BUNDLED address
// (Binance, category "exchange") so the merge import overrides it.
const OWNED1 = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
// A bundled address: { name: "Binance", category: "exchange", sourceNote: ... }.
const ENTITY_ADDR = "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo";
const TX1 = "3333333333333333333333333333333333333333333333333333333333333333";

// A second known BUNDLED address — used to prove the revert leaves the rest of
// the bundled list intact.
const OTHER_BUNDLED_ADDR = "1NDyJtNTjmwk5xPNhjgAMu4HDHigtobu1s";

// The values the BUNDLED list carries for ENTITY_ADDR — these MUST come BACK
// once the user reverts the override.
const BUNDLED_NAME = "Binance";
const BUNDLED_CATEGORY = "exchange";
const BUNDLED_CATEGORY_LABEL = "Exchange";
const BUNDLED_SOURCE_NOTE =
  "Widely published / tagged on public blockchain explorers (e.g., blockchain.com, OXT, BitInfoCharts)";

// The USER's re-attribution: a different name, a different category, and a
// different sourceNote (with a URL citing the SAME address to avoid a
// mismatched-citation warning). These MUST be gone after the revert.
const OVERRIDE_URL = `https://www.walletexplorer.com/address/${ENTITY_ADDR}`;
const OVERRIDE_NOTE = `Reclassified by analyst — ${OVERRIDE_URL}`;
const OVERRIDE_NAME = "Reclassified Darknet Cluster";
const OVERRIDE_CATEGORY = "darknet";
const OVERRIDE_CATEGORY_LABEL = "Darknet Market";

// The exact bytes a user would have in their snapshot file: the `{ entries: [] }`
// envelope form, a single entry whose address collides with a bundled one so a
// merge OVERRIDES (not adds) it.
const SNAPSHOT_JSON = JSON.stringify({
  entries: [
    {
      address: ENTITY_ADDR,
      name: OVERRIDE_NAME,
      category: OVERRIDE_CATEGORY,
      sourceNote: OVERRIDE_NOTE,
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

function getCitations(details: Record<string, unknown>): EntityCitation[] {
  return (details.citations as EntityCitation[]) ?? [];
}

/**
 * Drive the user snapshot through the REAL MERGE import path. Because the entry
 * address already exists in the bundled list, the merge OVERRIDES it rather than
 * adding, so the active count stays equal to the bundled count.
 */
async function importOverrideSnapshot(): Promise<void> {
  const parsed = JSON.parse(SNAPSHOT_JSON) as unknown;
  const result = await importEntitySnapshot(parsed, "user-snapshot.json", "merge");
  expect(result.valid).toBe(true);
  expect(result.mode).toBe("merge");
  expect(result.count).toBe(1);
  expect(result.activeCount).toBe(getBundledEntityCount());
}

beforeEach(async () => {
  await clearAllRecords({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
  await seedDirectContact();
  await resetEntitySnapshot();
  resetActiveEntityList();

  // Start each test from the OVERRIDDEN state: a merge-mode override is active
  // AND persisted, exactly as it would be after the user imported it.
  await importOverrideSnapshot();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetEntitySnapshot();
  resetActiveEntityList();
  await clearAllRecords({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
});

describe("Reverting a merge OVERRIDE restores the bundled flag reason", () => {
  it("sanity-checks the override is active before the revert", async () => {
    // Pre-condition: the override wins on the audit.
    const overridden = lookupEntity(ENTITY_ADDR);
    expect(overridden).toEqual({
      address: ENTITY_ADDR,
      name: OVERRIDE_NAME,
      category: OVERRIDE_CATEGORY,
      sourceNote: OVERRIDE_NOTE,
    });

    const result = await runPrivacyAudit([OWNED1]);
    expect(result.findings.some((f) => f.type === "ENTITY_DARKNET")).toBe(true);
    expect(result.findings.some((f) => f.type === "ENTITY_EXCHANGE")).toBe(false);
  });

  it("restores the BUNDLED entry in the active list after resetEntitySnapshot()", async () => {
    await resetEntitySnapshot();

    // The active list is back to exactly the bundled list.
    expect(getActiveEntityCount()).toBe(getBundledEntityCount());

    // The previously-overridden address resolves to the BUNDLED values again.
    const reverted = lookupEntity(ENTITY_ADDR);
    expect(reverted).toEqual({
      address: ENTITY_ADDR,
      name: BUNDLED_NAME,
      category: BUNDLED_CATEGORY,
      sourceNote: BUNDLED_SOURCE_NOTE,
    });
    // None of the user override values linger.
    expect(reverted!.name).not.toBe(OVERRIDE_NAME);
    expect(reverted!.category).not.toBe(OVERRIDE_CATEGORY);
    expect(reverted!.sourceNote).not.toBe(OVERRIDE_NOTE);

    // Other bundled entries are untouched by the revert.
    expect(lookupEntity(OTHER_BUNDLED_ADDR)?.name).toBe("Binance Cold Wallet");
  });

  it("re-flags the contact with the BUNDLED citation (not the override) on a fresh audit", async () => {
    await resetEntitySnapshot();

    const result = await runPrivacyAudit([OWNED1]);

    // The category is bundled again, so the finding type flips back to exchange.
    const finding = result.findings.find((f) => f.type === "ENTITY_EXCHANGE");
    expect(finding).toBeTruthy();
    // The override's darknet finding is gone.
    expect(result.findings.some((f) => f.type === "ENTITY_DARKNET")).toBe(false);

    const citations = getCitations(finding!.details);
    expect(citations).toEqual([
      {
        name: BUNDLED_NAME,
        address: ENTITY_ADDR,
        categoryLabel: BUNDLED_CATEGORY_LABEL,
        sourceNote: BUNDLED_SOURCE_NOTE,
      },
    ]);
    // The user override attribution must be gone entirely.
    expect(citations[0].name).not.toBe(OVERRIDE_NAME);
    expect(citations[0].categoryLabel).not.toBe(OVERRIDE_CATEGORY_LABEL);
    expect(citations[0].sourceNote).not.toContain(OVERRIDE_NOTE);
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

    // The override does NOT come back after the restart.
    expect(lookupEntity(ENTITY_ADDR)).toEqual({
      address: ENTITY_ADDR,
      name: BUNDLED_NAME,
      category: BUNDLED_CATEGORY,
      sourceNote: BUNDLED_SOURCE_NOTE,
    });

    // And the audit on the re-hydrated list flags the bundled exchange entity,
    // never the reverted darknet override.
    const result = await runPrivacyAudit([OWNED1]);
    expect(result.findings.some((f) => f.type === "ENTITY_DARKNET")).toBe(false);
    const finding = result.findings.find((f) => f.type === "ENTITY_EXCHANGE");
    expect(finding).toBeTruthy();
    expect(getCitations(finding!.details)).toEqual([
      {
        name: BUNDLED_NAME,
        address: ENTITY_ADDR,
        categoryLabel: BUNDLED_CATEGORY_LABEL,
        sourceNote: BUNDLED_SOURCE_NOTE,
      },
    ]);
  });
});

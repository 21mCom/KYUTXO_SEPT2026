// @vitest-environment jsdom
//
// Regression coverage for the BACKWARD-COMPATIBILITY branch in
// loadEntitySnapshotFromStorage(): a snapshot persisted to
// settings.entityListSnapshot BEFORE merge support existed has no `mode` field.
// Such legacy snapshots must re-hydrate as a plain REPLACE — the active list
// becomes exactly the persisted entries, with the bundled list NOT unioned in.
//
// Reports.privacyCitationImportedList.test.tsx proves the explicit
// mode='replace' path and Reports.privacyCitationMergedList.test.tsx proves the
// mode='merge' path. Neither pins the mode-DEFAULT branch (snap.mode ===
// undefined), so a future refactor of the mode handling could quietly start
// unioning legacy snapshots onto the bundled list — changing which entity flags
// appear after an app update for users who imported before merge shipped.
//
// This test writes a legacy snapshot (no `mode`) DIRECTLY to the settings
// record (so it exercises only the load path, not the import path that wrote
// it), calls the REAL loadEntitySnapshotFromStorage(), and asserts:
//   - it re-applied as a REPLACE: the active list equals just the persisted
//     entry and a known bundled address is NOT resolvable (not unioned in),
//   - the status source is 'imported',
//   - and a flagged entry's sourceNote citation still surfaces verbatim through
//     the REAL runPrivacyAudit() against a seeded owned -> entity contact.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { db } from "@/lib/database";
import { addTransaction, addParticipant } from "@/lib/data/transaction-crud";
import { runPrivacyAudit, type EntityCitation } from "@/lib/privacy-audit";
import {
  resetActiveEntityList,
  lookupEntity,
  getActiveEntityCount,
  getActiveEntityList,
  getBundledEntityCount,
} from "@/lib/privacy-entity-list";
import {
  loadEntitySnapshotFromStorage,
  resetEntitySnapshot,
  type EntityListStatus,
} from "@/lib/data/entity-list-store";
import { putSettings } from "@/lib/data/settings-crud";
import type { Settings } from "@/lib/db-types";

// OWNED1 pays directly to ENTITY_ADDR in TX1 — a hop-1 (direct) contact that
// detectEntityContacts captures. Both are REAL, checksum-valid mainnet
// addresses because the load path validates every address. ENTITY_ADDR is
// deliberately NOT in the bundled list so it can only be flagged because the
// persisted legacy entry surfaced it.
const OWNED1 = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const ENTITY_ADDR = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
const TX1 = "3333333333333333333333333333333333333333333333333333333333333333";

// A known BUNDLED address (Binance) — used to prove the legacy snapshot was
// applied as a REPLACE rather than unioned onto the bundled defaults.
const BUNDLED_ADDR = "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo";

// A sourceNote that embeds a real URL so we can prove the citation survives the
// persist/validate/re-hydrate round-trip and reaches the audit finding.
const SOURCE_URL = "https://www.walletexplorer.com/address/legacy-example";
const SOURCE_NOTE = `WalletExplorer.com service clustering — ${SOURCE_URL}`;

const ENTITY_NAME = "Legacy Test Exchange";
const ENTITY_CATEGORY_LABEL = "Exchange";

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
 * Write a snapshot to settings.entityListSnapshot the way a pre-merge build
 * did: WITHOUT a `mode` field. Seeds only the load path under test.
 */
async function persistLegacySnapshot(): Promise<void> {
  await putSettings(
    {
      id: "default",
      entityListSnapshot: {
        importedAt: Date.now(),
        sourceLabel: "legacy-snapshot.json",
        // NOTE: no `mode` field — this is the whole point of the test.
        entries: [
          {
            address: ENTITY_ADDR,
            name: ENTITY_NAME,
            category: "exchange",
            sourceNote: SOURCE_NOTE,
          },
        ],
      },
    } as Settings,
    { skipNotification: true },
  );
}

// Spy on fetch for the whole flow to prove the embedded sourceNote URL is never
// requested — load, audit, and lookups are all strictly offline.
let fetchSpy: ReturnType<typeof vi.fn>;
let loadStatus: EntityListStatus;

beforeEach(async () => {
  fetchSpy = vi.fn(() => Promise.reject(new Error("network access is forbidden")));
  vi.stubGlobal("fetch", fetchSpy);

  await db.records.clear();
  await db.blockchainTransactions.clear();
  await db.transactionParticipants.clear();
  await seedDirectContact();
  await resetEntitySnapshot();
  resetActiveEntityList();

  // Write the legacy (no-mode) snapshot, then re-hydrate solely from storage,
  // exactly as startup does.
  await persistLegacySnapshot();
  loadStatus = await loadEntitySnapshotFromStorage();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await resetEntitySnapshot();
  resetActiveEntityList();
  await db.records.clear();
  await db.blockchainTransactions.clear();
  await db.transactionParticipants.clear();
});

describe("a legacy (no-mode) persisted snapshot re-hydrates as a plain REPLACE", () => {
  it("re-applies as a REPLACE: just the persisted entry, bundled entries NOT unioned in", () => {
    // Replace, not merge: the active list is exactly the persisted entries, so
    // its count is 1 — NOT bundledCount + 1.
    expect(getActiveEntityCount()).toBe(1);
    expect(getActiveEntityList()).toEqual([
      {
        address: ENTITY_ADDR,
        name: ENTITY_NAME,
        category: "exchange",
        sourceNote: SOURCE_NOTE,
      },
    ]);

    // A known bundled entry is gone — proving the bundled list was NOT unioned
    // in (which is what a merge would have done).
    expect(lookupEntity(BUNDLED_ADDR)).toBeUndefined();
    expect(getActiveEntityCount()).toBeLessThan(getBundledEntityCount());
  });

  it("reports the load source as 'imported'", () => {
    expect(loadStatus.source).toBe("imported");
  });

  it("surfaces the flagged entry's sourceNote citation through the audit", async () => {
    const result = await runPrivacyAudit([OWNED1]);

    const finding = result.findings.find((f) => f.type === "ENTITY_EXCHANGE");
    expect(finding).toBeTruthy();
    expect(getCitations(finding!.details)).toEqual([
      {
        name: ENTITY_NAME,
        address: ENTITY_ADDR,
        categoryLabel: ENTITY_CATEGORY_LABEL,
        sourceNote: SOURCE_NOTE,
      },
    ]);
    // The attribution URL came through the legacy load path verbatim, untrimmed.
    expect(getCitations(finding!.details)[0].sourceNote).toContain(SOURCE_URL);
  });

  it("never fetches the embedded sourceNote URL across load and audit", async () => {
    await runPrivacyAudit([OWNED1]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

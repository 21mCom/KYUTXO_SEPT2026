// End-to-end coverage for direct entity-contact scoring (Task: "Confirm direct
// exchange/scam contacts also lower the privacy score end-to-end").
//
// privacy-audit.e2e-proximity.test.ts already proves the *indirect* proximity
// detector (detectEntityProximity → PROXIMITY_*) flows through runPrivacyAudit()
// into the score + waterfall. This test does the same for its sibling detector,
// detectEntityContacts(), which flags *direct* hop-1 contacts (an owned address
// transacting directly with a known entity → ENTITY_EXCHANGE / ENTITY_SCAM /
// ENTITY_DARKNET / etc.).
//
// We seed real Dexie records + transaction participants (fake-indexeddb) where an
// owned address pays directly to a known entity address, swap the active entity
// list with setActiveEntityList so the bundled list never interferes, run the
// full runPrivacyAudit() pipeline, and confirm the ENTITY_* finding actually
// reduces the score with the right waterfall delta.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { db } from "@/lib/database";
import { addTransaction, addParticipant } from "@/lib/data/transaction-crud";
import { runPrivacyAudit } from "./privacy-audit";
import {
  setActiveEntityList,
  resetActiveEntityList,
  type EntityEntry,
  type EntityCategory,
} from "./privacy-entity-list";

// OWNED1 pays directly to ENTITY_ADDR in a single transaction. That is a hop-1
// (direct) contact captured by detectEntityContacts — not detectEntityProximity,
// which only reports hops 2+.
//
// We deliberately keep this to ONE owned input and ONE entity output, with
// non-round amounts and each address appearing in exactly one transaction, so
// the seed trips no other heuristic (ADDRESS_REUSE / CONSOLIDATION / CIOH /
// ROUND_AMOUNT / proximity). That keeps the score delta attributable solely to
// the direct-contact finding under test.
const OWNED1 = "bc1qentityowned100000000000000000000000000aa";
const ENTITY_ADDR = "bc1qentitydirect00000000000000000000000000cc";

const TX1 = "1111111111111111111111111111111111111111111111111111111111111111";

async function seedDirectContact() {
  await addTransaction(
    { txid: TX1, blockHeight: 800000, blockTime: 1_700_000_000, fee: 1_000, feeRate: 5, syncedAt: Date.now() },
    { skipNotification: true },
  );
  // OWNED1 spends directly to the entity address.
  await addParticipant(
    { txid: TX1, role: "input", address: OWNED1, amount: 250_123, vout: 0 },
    { skipNotification: true },
  );
  await addParticipant(
    { txid: TX1, role: "output", address: ENTITY_ADDR, amount: 199_111, vout: 0 },
    { skipNotification: true },
  );
}

function entityEntry(category: EntityCategory): EntityEntry {
  return {
    address: ENTITY_ADDR,
    name: `Test ${category}`,
    category,
    sourceNote: "test fixture",
  };
}

beforeEach(async () => {
  await db.records.clear();
  await db.blockchainTransactions.clear();
  await db.transactionParticipants.clear();
  await seedDirectContact();
});

afterEach(async () => {
  resetActiveEntityList();
  await db.records.clear();
  await db.blockchainTransactions.clear();
  await db.transactionParticipants.clear();
});

describe("runPrivacyAudit end-to-end direct entity-contact scoring", () => {
  // category → expected finding type, severity, and first-penalty delta.
  const cases: Array<{
    category: EntityCategory;
    findingType: "ENTITY_EXCHANGE" | "ENTITY_SCAM" | "ENTITY_DARKNET";
    severity: "MEDIUM" | "CRITICAL";
    delta: number;
  }> = [
    { category: "exchange", findingType: "ENTITY_EXCHANGE", severity: "MEDIUM", delta: -8 },
    { category: "scam", findingType: "ENTITY_SCAM", severity: "CRITICAL", delta: -25 },
    { category: "darknet", findingType: "ENTITY_DARKNET", severity: "CRITICAL", delta: -25 },
  ];

  for (const { category, findingType, severity, delta } of cases) {
    it(`surfaces the ${category} contact (${findingType}) and lowers the score via the waterfall`, async () => {
      setActiveEntityList([entityEntry(category)]);

      const result = await runPrivacyAudit([OWNED1]);

      const finding = result.findings.find((f) => f.type === findingType);
      expect(finding).toBeTruthy();
      expect(finding!.severity).toBe(severity);
      expect(finding!.addresses).toContain(ENTITY_ADDR);
      expect(finding!.txids).toContain(TX1);

      // The direct-contact finding must actually move the score off 100.
      expect(result.score).toBeLessThan(100);

      // …and that movement must be attributable to this finding in the waterfall.
      const entry = result.scoreWaterfall.find((w) => w.findingType === findingType);
      expect(entry).toBeTruthy();
      expect(entry!.count).toBe(1);
      // First finding of its severity → first-penalty for that severity.
      expect(entry!.delta).toBe(delta);

      // No indirect-proximity finding should fire for a hop-1 contact.
      expect(
        result.findings.some((f) => f.type === "PROXIMITY_EXCHANGE" || f.type === "PROXIMITY_SCAM" || f.type === "PROXIMITY_DARKNET"),
      ).toBe(false);
    });
  }

  it("does not flag a direct entity-contact finding once the entity list is empty", async () => {
    setActiveEntityList([]);
    const result = await runPrivacyAudit([OWNED1]);

    expect(
      result.findings.some(
        (f) => f.type === "ENTITY_EXCHANGE" || f.type === "ENTITY_SCAM" || f.type === "ENTITY_DARKNET",
      ),
    ).toBe(false);
    expect(
      result.scoreWaterfall.some(
        (w) =>
          w.findingType === "ENTITY_EXCHANGE" ||
          w.findingType === "ENTITY_SCAM" ||
          w.findingType === "ENTITY_DARKNET",
      ),
    ).toBe(false);
  });
});

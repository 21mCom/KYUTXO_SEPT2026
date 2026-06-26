// End-to-end coverage for proximity scoring (Task: "Confirm proximity warnings
// actually lower the privacy score").
//
// privacy-audit.proximity.test.ts already drives the BFS engine
// (detectEntityProximity) in isolation. This test instead seeds real Dexie
// records + transaction participants forming an owned → intermediate → entity
// path, runs the full runPrivacyAudit() pipeline, and confirms the proximity
// finding actually flows through to the overall score and the score waterfall.
//
// We back the real Dexie database with fake-indexeddb and swap the active
// entity list with setActiveEntityList so the bundled list never interferes.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { db } from "@/lib/database";
import { addTransaction, addParticipant } from "@/lib/data/transaction-crud";
import { runPrivacyAudit } from "./privacy-audit";
import {
  setActiveEntityList,
  resetActiveEntityList,
  type EntityEntry,
} from "./privacy-entity-list";

// OWNED1 receives into BRIDGE (tx1); the same BRIDGE address later receives a
// deposit from a known exchange entity (tx2). That places OWNED1 two hops from
// the entity through BRIDGE.
//
// We deliberately keep BRIDGE *receive-only* in both transactions (never an
// input) so the seed does not also trip the ADDRESS_REUSE heuristic — that
// would add a second HIGH finding and muddy the proximity score delta.
const OWNED1 = "bc1qproxowned100000000000000000000000000000aa";
const BRIDGE = "bc1qproxbridge0000000000000000000000000000bb";
const ENTITY_ADDR = "bc1qproxexchange000000000000000000000000000cc";

// tx1 links OWNED1 → BRIDGE (both ours); tx2 is a deposit ENTITY → BRIDGE.
const TX1 = "1111111111111111111111111111111111111111111111111111111111111111";
const TX2 = "2222222222222222222222222222222222222222222222222222222222222222";

const EXCHANGE_ENTRY: EntityEntry = {
  address: ENTITY_ADDR,
  name: "Test Exchange",
  category: "exchange",
  sourceNote: "test fixture",
};

async function seedProximityGraph() {
  await addTransaction(
    { txid: TX1, blockHeight: 800000, blockTime: 1_700_000_000, fee: 1_000, feeRate: 5, syncedAt: Date.now() },
    { skipNotification: true },
  );
  await addParticipant(
    { txid: TX1, role: "input", address: OWNED1, amount: 250_123, vout: 0 },
    { skipNotification: true },
  );
  await addParticipant(
    { txid: TX1, role: "output", address: BRIDGE, amount: 199_111, vout: 0 },
    { skipNotification: true },
  );

  await addTransaction(
    { txid: TX2, blockHeight: 800001, blockTime: 1_700_000_100, fee: 1_000, feeRate: 5, syncedAt: Date.now() },
    { skipNotification: true },
  );
  await addParticipant(
    { txid: TX2, role: "input", address: ENTITY_ADDR, amount: 300_777, vout: 0 },
    { skipNotification: true },
  );
  await addParticipant(
    { txid: TX2, role: "output", address: BRIDGE, amount: 197_333, vout: 0 },
    { skipNotification: true },
  );
}

beforeEach(async () => {
  await db.records.clear();
  await db.blockchainTransactions.clear();
  await db.transactionParticipants.clear();
  setActiveEntityList([EXCHANGE_ENTRY]);
  await seedProximityGraph();
});

afterEach(async () => {
  resetActiveEntityList();
  await db.records.clear();
  await db.blockchainTransactions.clear();
  await db.transactionParticipants.clear();
});

describe("runPrivacyAudit end-to-end proximity scoring", () => {
  it("surfaces the proximity finding and lowers the score via the waterfall", async () => {
    const result = await runPrivacyAudit([OWNED1, BRIDGE]);

    const proximity = result.findings.find((f) => f.type === "PROXIMITY_EXCHANGE");
    expect(proximity).toBeTruthy();
    expect(proximity!.severity).toBe("HIGH");
    expect(proximity!.details.hopDistance).toBe(2);
    expect(proximity!.details.isProximity).toBe(true);
    expect(proximity!.addresses).toContain(OWNED1);

    // The proximity finding must actually move the score off 100.
    expect(result.score).toBeLessThan(100);

    // …and that movement must be attributable to the proximity entry in the
    // waterfall, not just some other finding.
    const proximityEntry = result.scoreWaterfall.find(
      (w) => w.findingType === "PROXIMITY_EXCHANGE",
    );
    expect(proximityEntry).toBeTruthy();
    expect(proximityEntry!.count).toBe(1);
    // HIGH severity, first of its severity → first-penalty (-15).
    expect(proximityEntry!.delta).toBe(-15);
  });

  it("does not flag a proximity finding once the entity list is empty", async () => {
    setActiveEntityList([]);
    const result = await runPrivacyAudit([OWNED1, BRIDGE]);

    expect(result.findings.some((f) => f.type === "PROXIMITY_EXCHANGE")).toBe(false);
    expect(
      result.scoreWaterfall.some((w) => w.findingType === "PROXIMITY_EXCHANGE"),
    ).toBe(false);
  });
});

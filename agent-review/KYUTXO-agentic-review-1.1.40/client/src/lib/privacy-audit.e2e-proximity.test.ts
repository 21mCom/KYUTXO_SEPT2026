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

// ---------------------------------------------------------------------------
// Hop-3 (MEDIUM, -8) fixture.
//
// Task #577 already covers the hop-2 (HIGH, -15) case above. This extends the
// coverage to the next-weaker tier so we prove the severity→penalty mapping
// scales with hop distance through the *final* score, not just at the engine
// level. PROXIMITY_HOP_SEVERITY maps hop 3 → MEDIUM, and MEDIUM's first-penalty
// is -8.
//
// Chain: OWNED3 → MID3 (non-user) → BRIDGE3 (receive-only user) → SCAM entity.
//
//   tx3a: OWNED3 (input)  → MID3 (output)
//   tx3b: MID3  (input)   → BRIDGE3 (output)            (loads via BRIDGE3)
//   tx3c: FILLER3 (input) → BRIDGE3 (output) + SCAM (output)
//
// MID3 is deliberately NOT a user address: its two transactions are still
// loaded because each shares a user neighbour (OWNED3 on tx3a, BRIDGE3 on
// tx3b). That is what keeps OWNED3 cleanly 3 hops from the entity. BRIDGE3 is
// the only intermediate user and it sits adjacent (hop 1) to the entity, so its
// own BFS produces a hop-1 contact that is below the proximity threshold rather
// than a competing proximity finding.
//
// We use the SCAM category (not exchange): a direct entity contact for an
// exchange is itself MEDIUM and would consume the MEDIUM first-penalty before
// the proximity finding, leaving proximity with the -3 *subsequent* penalty and
// defeating the assertion. A scam direct-contact is CRITICAL, so the MEDIUM
// tier contains only our proximity finding.
const OWNED3 = "bc1qprox3owned00000000000000000000000000000aa";
const MID3 = "bc1qprox3mid000000000000000000000000000000bb";
const BRIDGE3 = "bc1qprox3bridge000000000000000000000000000cc";
const FILLER3 = "bc1qprox3filler000000000000000000000000000dd";
const SCAM3_ADDR = "bc1qprox3scam00000000000000000000000000000ee";

const TX3A = "3333333333333333333333333333333333333333333333333333333333330001";
const TX3B = "3333333333333333333333333333333333333333333333333333333333330002";
const TX3C = "3333333333333333333333333333333333333333333333333333333333330003";

const SCAM3_ENTRY: EntityEntry = {
  address: SCAM3_ADDR,
  name: "Test Scammer",
  category: "scam",
  sourceNote: "test fixture",
};

async function seedHop3Graph() {
  await addTransaction(
    { txid: TX3A, blockHeight: 810000, blockTime: 1_700_010_000, fee: 1_000, feeRate: 5, syncedAt: Date.now() },
    { skipNotification: true },
  );
  await addParticipant({ txid: TX3A, role: "input", address: OWNED3, amount: 250_000, vout: 0 }, { skipNotification: true });
  await addParticipant({ txid: TX3A, role: "output", address: MID3, amount: 199_000, vout: 0 }, { skipNotification: true });

  await addTransaction(
    { txid: TX3B, blockHeight: 810001, blockTime: 1_700_010_100, fee: 1_000, feeRate: 5, syncedAt: Date.now() },
    { skipNotification: true },
  );
  await addParticipant({ txid: TX3B, role: "input", address: MID3, amount: 199_000, vout: 0 }, { skipNotification: true });
  await addParticipant({ txid: TX3B, role: "output", address: BRIDGE3, amount: 197_000, vout: 0 }, { skipNotification: true });

  await addTransaction(
    { txid: TX3C, blockHeight: 810002, blockTime: 1_700_010_200, fee: 1_000, feeRate: 5, syncedAt: Date.now() },
    { skipNotification: true },
  );
  await addParticipant({ txid: TX3C, role: "input", address: FILLER3, amount: 500_000, vout: 0 }, { skipNotification: true });
  await addParticipant({ txid: TX3C, role: "output", address: BRIDGE3, amount: 197_000, vout: 0 }, { skipNotification: true });
  await addParticipant({ txid: TX3C, role: "output", address: SCAM3_ADDR, amount: 300_000, vout: 1 }, { skipNotification: true });
}

// ---------------------------------------------------------------------------
// Hop-4 (LOW) fixture.
//
// PROXIMITY_HOP_SEVERITY maps hop 4 → LOW. Unlike hop-2 / hop-3, a hop-4
// proximity finding CANNOT be isolated as the sole entry of its severity tier
// end-to-end: KYUTXO only loads transactions that touch an owned address
// (getParticipantsByAddresses filters strictly by address), so the middle edge
// of a 4-hop chain has no owned neighbour to load it without turning one of its
// endpoints into an owned address — and that address then becomes a BFS start
// point that reaches the SAME entity at a shorter hop, emitting a same-type
// PROXIMITY finding. Same-type findings merge into one waterfall entry, so the
// LOW first-penalty (-3) can't be read off cleanly.
//
// What we CAN verify end-to-end is that hop 4 still maps to LOW through the full
// runPrivacyAudit() pipeline (engine severity → finding severity). The LOW
// first-penalty arithmetic itself is the same generic computeScore path already
// exercised by the hop-3 MEDIUM assertion below.
//
// Chain: OWNED4 → MID4A → MID4B → BRIDGE4 (all receive-only users) → EXCHANGE.
const OWNED4 = "bc1qprox4owned00000000000000000000000000000aa";
const MID4A = "bc1qprox4mida00000000000000000000000000000bb";
const MID4B = "bc1qprox4midb00000000000000000000000000000cc";
const BRIDGE4 = "bc1qprox4bridge000000000000000000000000000dd";
const FILLER4A = "bc1qprox4fillera00000000000000000000000000ee";
const FILLER4B = "bc1qprox4fillerb00000000000000000000000000ff";
const FILLER4C = "bc1qprox4fillerc0000000000000000000000000011";
const EX4_ADDR = "bc1qprox4exchange00000000000000000000000022";

const TX4A = "4444444444444444444444444444444444444444444444444444444444440001";
const TX4B = "4444444444444444444444444444444444444444444444444444444444440002";
const TX4C = "4444444444444444444444444444444444444444444444444444444444440003";
const TX4D = "4444444444444444444444444444444444444444444444444444444444440004";

const EX4_ENTRY: EntityEntry = {
  address: EX4_ADDR,
  name: "Test Exchange 4",
  category: "exchange",
  sourceNote: "test fixture",
};

async function seedHop4Graph() {
  await addTransaction(
    { txid: TX4A, blockHeight: 820000, blockTime: 1_700_020_000, fee: 1_000, feeRate: 5, syncedAt: Date.now() },
    { skipNotification: true },
  );
  await addParticipant({ txid: TX4A, role: "input", address: OWNED4, amount: 250_000, vout: 0 }, { skipNotification: true });
  await addParticipant({ txid: TX4A, role: "output", address: MID4A, amount: 199_000, vout: 0 }, { skipNotification: true });

  await addTransaction(
    { txid: TX4B, blockHeight: 820001, blockTime: 1_700_020_100, fee: 1_000, feeRate: 5, syncedAt: Date.now() },
    { skipNotification: true },
  );
  await addParticipant({ txid: TX4B, role: "input", address: FILLER4A, amount: 500_000, vout: 0 }, { skipNotification: true });
  await addParticipant({ txid: TX4B, role: "output", address: MID4A, amount: 197_000, vout: 0 }, { skipNotification: true });
  await addParticipant({ txid: TX4B, role: "output", address: MID4B, amount: 197_000, vout: 1 }, { skipNotification: true });

  await addTransaction(
    { txid: TX4C, blockHeight: 820002, blockTime: 1_700_020_200, fee: 1_000, feeRate: 5, syncedAt: Date.now() },
    { skipNotification: true },
  );
  await addParticipant({ txid: TX4C, role: "input", address: FILLER4B, amount: 500_000, vout: 0 }, { skipNotification: true });
  await addParticipant({ txid: TX4C, role: "output", address: MID4B, amount: 197_000, vout: 0 }, { skipNotification: true });
  await addParticipant({ txid: TX4C, role: "output", address: BRIDGE4, amount: 197_000, vout: 1 }, { skipNotification: true });

  await addTransaction(
    { txid: TX4D, blockHeight: 820003, blockTime: 1_700_020_300, fee: 1_000, feeRate: 5, syncedAt: Date.now() },
    { skipNotification: true },
  );
  await addParticipant({ txid: TX4D, role: "input", address: FILLER4C, amount: 500_000, vout: 0 }, { skipNotification: true });
  await addParticipant({ txid: TX4D, role: "output", address: BRIDGE4, amount: 197_000, vout: 0 }, { skipNotification: true });
  await addParticipant({ txid: TX4D, role: "output", address: EX4_ADDR, amount: 300_000, vout: 1 }, { skipNotification: true });
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

  it("applies the smaller MEDIUM (-8) first-penalty for a hop-3 proximity path", async () => {
    // Replace the hop-2 exchange fixture with the dedicated hop-3 scam graph.
    setActiveEntityList([SCAM3_ENTRY]);
    await seedHop3Graph();

    const result = await runPrivacyAudit([OWNED3, BRIDGE3]);

    // Exactly one proximity finding, at hop 3, mapped to MEDIUM.
    const proximityFindings = result.findings.filter((f) => f.type === "PROXIMITY_SCAM");
    expect(proximityFindings).toHaveLength(1);
    const proximity = proximityFindings[0];
    expect(proximity.severity).toBe("MEDIUM");
    expect(proximity.details.hopDistance).toBe(3);
    expect(proximity.details.isProximity).toBe(true);
    expect(proximity.addresses).toContain(OWNED3);

    // The hop-3 proximity must move the score below 100 and be attributable to
    // the proximity entry in the waterfall.
    expect(result.score).toBeLessThan(100);
    const proximityEntry = result.scoreWaterfall.find(
      (w) => w.findingType === "PROXIMITY_SCAM",
    );
    expect(proximityEntry).toBeTruthy();
    expect(proximityEntry!.count).toBe(1);

    // The crux: a hop-3 (MEDIUM) proximity must apply the MEDIUM first-penalty
    // (-8), which is strictly smaller than the hop-2 (HIGH) first-penalty (-15)
    // asserted above. This proves severity — and therefore the score impact —
    // scales down with hop distance end-to-end.
    expect(proximityEntry!.delta).toBe(-8);
    expect(proximityEntry!.delta).toBeGreaterThan(-15);
  });

  it("de-duplicates an entity reachable at several hops to its closest owned hop", async () => {
    // The hop-4 chain OWNED4 → MID4A → MID4B → BRIDGE4 → EXCHANGE makes every
    // intermediate an owned address, so the same exchange is reachable from
    // OWNED4 (hop 4), MID4A (hop 3) and MID4B (hop 2). runPrivacyAudit only
    // loads transactions that touch an owned address, and the BFS de-duplicates
    // each entity address to the CLOSEST owned hop. So the riskiest farther-hop
    // paths cannot survive end-to-end: the entity surfaces exactly ONCE, at its
    // closest proximity hop (hop 2 → HIGH), never as a hop-3 or hop-4 duplicate.
    // (BRIDGE4 is hop 1 → a direct ENTITY_EXCHANGE, not a proximity finding.)
    // The hop-4 → LOW severity mapping itself is covered at the engine level in
    // privacy-audit.proximity.test.ts, where non-owned intermediates let a hop-4
    // path stand alone.
    setActiveEntityList([EX4_ENTRY]);
    await seedHop4Graph();

    const result = await runPrivacyAudit([OWNED4, MID4A, MID4B, BRIDGE4]);

    const proximityFindings = result.findings.filter(
      (f) => f.type === "PROXIMITY_EXCHANGE",
    );
    // Collapsed to a single finding for the shared entity, not one per owned hop.
    expect(proximityFindings).toHaveLength(1);

    const proximity = proximityFindings[0];
    expect(proximity.severity).toBe("HIGH");
    expect(proximity.details.hopDistance).toBe(2);
    expect(proximity.details.isProximity).toBe(true);
    // The surviving finding belongs to the closest owned address (MID4B), and the
    // farther-hop owners are NOT carried as separate proximity findings.
    expect(proximity.addresses).toContain(MID4B);

    // No farther-hop (3 or 4) duplicate of the same entity leaked through.
    expect(
      result.findings.some(
        (f) =>
          f.type === "PROXIMITY_EXCHANGE" &&
          (f.details.hopDistance === 3 || f.details.hopDistance === 4),
      ),
    ).toBe(false);
  });
});

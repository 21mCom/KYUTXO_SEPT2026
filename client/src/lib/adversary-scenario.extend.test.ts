// @vitest-environment jsdom
//
// Dexie-backed coverage for the scenario context extension
// (extendAdversaryContextWithAssumed) and the end-to-end orchestration
// (runAdversaryScenario): real participant rows in fake-indexeddb, known
// addresses joining the owned set, and known txids being force-included into
// the adversary's transaction universe. The pure heuristic/delta logic is
// covered in adversary-scenario.test.ts.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";

import {
  buildAdversaryContext,
  extendAdversaryContextWithAssumed,
} from "@/lib/adversary-view";
import {
  runAdversaryScenario,
  resolveScenarioReferences,
} from "@/lib/adversary-scenario";
import { createRecord, clearAllRecords } from "@/lib/data/record-crud";
import {
  bulkAddParticipants,
  bulkAddTransactions,
  clearParticipants,
  clearTransactions,
} from "@/lib/data/transaction-crud";
import type { TransactionParticipant } from "@/lib/db-types";

const A = "bc1qscenaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bc1qscenbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "bc1qscenccccccccccccccccccccccccccccccccccccc";
const D = "bc1qscenddddddddddddddddddddddddddddddddddddd";
const E1 = "bc1qsceneeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee1";
const E2 = "bc1qsceneeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee2";

function input(txid: string, address: string, amount: number): TransactionParticipant {
  return { txid, role: "input", address, amount };
}

async function seedRecords(
  rows: Array<{ addr: string; xpub: string }>,
): Promise<void> {
  for (const r of rows) {
    await createRecord({
      type: "address",
      inputString: r.addr,
      label: "",
      chainType: "receive",
      xpub: r.xpub,
    });
  }
}

beforeEach(async () => {
  await clearAllRecords({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
});

describe("resolveScenarioReferences", () => {
  const TX1 = "a".repeat(64);
  const TX2 = "b".repeat(64);

  it("reports saved references that no longer match any record or synced transaction", async () => {
    await seedRecords([{ addr: A, xpub: "xpub1" }]);
    await bulkAddTransactions(
      [{ txid: TX1, blockHeight: 100, blockTime: 1_700_000_000, fee: 100, feeRate: 1, syncedAt: Date.now() }],
      { skipNotification: true },
    );

    const res = await resolveScenarioReferences({
      knownAddresses: [A, B],
      knownTxids: [TX1, TX2],
    });
    expect(res.unresolvedAddresses).toEqual([B]);
    expect(res.unresolvedTxids).toEqual([TX2]);
    expect(res.unresolvedCount).toBe(2);
  });

  it("resolves regardless of casing/whitespace (canonical lookup keys)", async () => {
    await seedRecords([{ addr: A, xpub: "xpub1" }]);
    await bulkAddTransactions(
      [{ txid: TX1, blockHeight: 100, blockTime: 1_700_000_000, fee: 100, feeRate: 1, syncedAt: Date.now() }],
      { skipNotification: true },
    );

    const res = await resolveScenarioReferences({
      knownAddresses: [` ${A.toUpperCase()} `],
      knownTxids: [TX1.toUpperCase()],
    });
    expect(res.unresolvedCount).toBe(0);
  });

  it("returns empty for a scenario with no references", async () => {
    const res = await resolveScenarioReferences({ knownAddresses: [], knownTxids: [] });
    expect(res.unresolvedCount).toBe(0);
    expect(res.unresolvedAddresses).toEqual([]);
    expect(res.unresolvedTxids).toEqual([]);
  });
});

describe("extendAdversaryContextWithAssumed", () => {
  it("force-includes known txids and known addresses without mutating the baseline context", async () => {
    await seedRecords([
      { addr: A, xpub: "xpub1" },
      { addr: B, xpub: "xpub1" },
      { addr: C, xpub: "xpub2" },
    ]);
    await bulkAddParticipants(
      [
        // T2: A and B co-spend (touches the audited set).
        input("t2", A, 40_000),
        input("t2", B, 30_000),
        // T5: touches nothing owned — invisible to the baseline entirely.
        input("t5", E1, 5_000),
        input("t5", E2, 7_000),
      ],
      { skipNotification: true },
    );

    const baseCtx = await buildAdversaryContext([A, B], () => {});
    expect(baseCtx.participantsByTxid.has("t2")).toBe(true);
    expect(baseCtx.participantsByTxid.has("t5")).toBe(false);
    expect(baseCtx.assumed).toBeUndefined();

    const scenarioCtx = await extendAdversaryContextWithAssumed(
      baseCtx,
      { knownAddresses: [C], knownTxids: ["t5"] },
      () => {},
    );

    // T5 is force-included even though nothing owned touches it.
    expect(scenarioCtx.participantsByTxid.has("t5")).toBe(true);
    // The known address joins the owned set for the comparison layer.
    expect(scenarioCtx.userAddresses.has(C)).toBe(true);
    expect(scenarioCtx.assumed?.knownAddresses.has(C)).toBe(true);
    expect(scenarioCtx.assumed?.knownTxids.has("t5")).toBe(true);

    // The baseline context object is never mutated.
    expect(baseCtx.participantsByTxid.has("t5")).toBe(false);
    expect(baseCtx.userAddresses.has(C)).toBe(false);
  });
});

describe("runAdversaryScenario (end to end, real DB)", () => {
  it("reports addresses the informed counterparty newly connects", async () => {
    await seedRecords([
      { addr: A, xpub: "xpub1" },
      { addr: B, xpub: "xpub1" },
      { addr: C, xpub: "xpub2" },
    ]);
    await bulkAddParticipants(
      [
        // T2: A and B co-spend — the baseline exposure.
        input("t2", A, 40_000),
        input("t2", B, 30_000),
        // T6: B and C co-spend. C is NOT in the audited address set, so the
        // blind baseline treats T6's co-input as external and exposes only
        // {A, B}. The assumed knowledge that C is the user's extends the
        // certain-tier cluster to C.
        input("t6", B, 20_000),
        input("t6", C, 10_000),
      ],
      { skipNotification: true },
    );

    const delta = await runAdversaryScenario(
      [A, B],
      { knownAddresses: [C], knownTxids: ["t6"] },
      { counterpartyName: "TestExchange" },
    );

    // Blind baseline: only A and B are linked (C looks external).
    expect(delta.baseline.summary.addressesExposed).toBe(2);
    // With the assumed knowledge, C joins the certain-tier cluster.
    expect(delta.scenario.summary.addressesExposed).toBe(3);
    expect(delta.summary.newlyExposedCount).toBe(1);
    expect(delta.newlyExposedAddresses).toEqual([
      { address: C, confidence: "certain" },
    ]);
    expect(delta.narrative).toContain(
      "lets TestExchange connect 1 more of your address",
    );
  });

  it("merges previously separate clusters and breaks verified separation", async () => {
    await seedRecords([
      { addr: A, xpub: "xpub1" },
      { addr: B, xpub: "xpub1" },
      { addr: C, xpub: "xpub2" },
      { addr: D, xpub: "xpub2" },
    ]);
    await bulkAddParticipants(
      [
        // T2: A and B co-spend (wallet xpub1).
        input("t2", A, 40_000),
        input("t2", B, 30_000),
        // T4: C and D co-spend (wallet xpub2). Nothing links the two clusters
        // on-chain, so a blind analyst preserves their separation.
        input("t4", C, 20_000),
        input("t4", D, 10_000),
      ],
      { skipNotification: true },
    );

    const delta = await runAdversaryScenario(
      [A, B, C, D],
      { knownAddresses: [B], knownTxids: ["t4"] },
      { counterpartyName: "Merchant" },
    );

    // Blind baseline: two separate certain clusters, one per wallet.
    expect(delta.baseline.summary.addressesExposed).toBe(4);
    expect(delta.baseline.summary.exposureCount).toBe(2);
    expect(delta.baseline.summary.separationCount).toBe(1);

    // Knowing B and T4 bridges {A,B} with {C,D}: one merged cluster, and the
    // xpub-verified separation is broken.
    expect(delta.summary.newlyExposedCount).toBe(0);
    expect(delta.summary.mergedClusterCount).toBe(1);
    expect(delta.mergedClusters[0].baselineClusterCount).toBe(2);
    expect(delta.mergedClusters[0].addresses.sort()).toEqual([A, B, C, D].sort());
    expect(delta.summary.brokenSeparationCount).toBe(1);
    expect(delta.scenario.summary.exposureCount).toBe(1);
    expect(delta.narrative).toContain("collapse");
    expect(delta.narrative).toContain("separation of 1 verified wallet pair");
  });
});

// @vitest-environment jsdom
//
// Synthetic-context coverage for the "what if they knew?" assumed-knowledge
// seam (runAdversaryViewFromContext with ctx.assumed) and the scenario delta
// computation (computeScenarioDelta). No Dexie: ground-truth record loads are
// mocked; contexts are hand-built. The Dexie-backed context-extension path is
// covered separately in adversary-scenario.extend.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { TransactionParticipant } from "@/lib/db-types";

// Ground-truth record fixture, keyed by inputString. Only the fields the
// adversary analysis reads (chainType, xpub) are populated.
const { recordFixtures } = vi.hoisted(() => ({
  recordFixtures: new Map<string, { inputString: string; chainType?: string; xpub?: string }>(),
}));

vi.mock("@/lib/data/record-crud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data/record-crud")>();
  return {
    ...actual,
    getRecordsByInputStrings: async (inputStrings: string[]) =>
      inputStrings
        .map((s) => recordFixtures.get(s))
        .filter((r): r is NonNullable<typeof r> => !!r),
  };
});

import {
  runAdversaryViewFromContext,
  type AdversaryContext,
  type AdversaryViewResult,
} from "@/lib/adversary-view";
import { computeScenarioDelta } from "@/lib/adversary-scenario";

function p(
  txid: string,
  role: "input" | "output",
  address: string,
  amount: number,
  vout?: number,
): TransactionParticipant {
  return role === "input"
    ? { txid, role, address, amount }
    : { txid, role, address, amount, vout };
}

function ctxOf(
  userAddresses: string[],
  txs: Record<string, TransactionParticipant[]>,
  assumed?: { knownAddresses: string[]; knownTxids: string[] },
): AdversaryContext {
  return {
    userAddresses: new Set(userAddresses),
    participantsByTxid: new Map(Object.entries(txs)),
    assumed: assumed
      ? {
          knownAddresses: new Set(assumed.knownAddresses),
          knownTxids: new Set(assumed.knownTxids),
        }
      : undefined,
  };
}

function setRecords(
  rows: Array<{ addr: string; chainType?: string; xpub?: string }>,
): void {
  recordFixtures.clear();
  for (const r of rows) {
    recordFixtures.set(r.addr, {
      inputString: r.addr,
      chainType: r.chainType,
      xpub: r.xpub,
    });
  }
}

const META = { counterpartyName: "TestExchange", knownAddressCount: 0, knownTxidCount: 0 };

beforeEach(() => {
  recordFixtures.clear();
});

describe("assumed-knowledge seam (runAdversaryViewFromContext)", () => {
  // T1: A1+A2 co-spent (certain CIO cluster). T2: B1 spends with a small
  // owned-looking output B2 (likely change-guess cluster).
  const TXS = {
    t1: [p("t1", "input", "A1", 50_000), p("t1", "input", "A2", 25_000)],
    t2: [
      p("t2", "input", "B1", 10_000),
      p("t2", "output", "EXT1", 9_000, 0),
      p("t2", "output", "B2", 1_000, 1),
    ],
  };
  const RECORDS = [
    { addr: "A1", chainType: "receive", xpub: "xpubA" },
    { addr: "A2", chainType: "receive", xpub: "xpubA" },
    { addr: "B1", chainType: "receive", xpub: "xpubB" },
    { addr: "B2", chainType: "change", xpub: "xpubB" },
  ];

  it("baseline path is unchanged when no assumed knowledge is supplied", async () => {
    setRecords(RECORDS);
    const result = await runAdversaryViewFromContext(
      ctxOf(["A1", "A2", "B1", "B2"], TXS),
    );

    expect(result.exposureFindings).toHaveLength(2);
    const certain = result.exposureFindings.find((f) => f.confidence === "certain")!;
    const likely = result.exposureFindings.find((f) => f.confidence === "likely")!;
    expect(certain.addresses.sort()).toEqual(["A1", "A2"]);
    expect(likely.addresses.sort()).toEqual(["B1", "B2"]);
    expect(result.summary.addressesExposed).toBe(4);
    // The two xpub-identified wallets stay unlinked for a blind analyst.
    expect(result.separationFindings).toHaveLength(1);
  });

  it("known addresses collapse previously separate clusters at certain tier", async () => {
    setRecords(RECORDS);
    const scenario = await runAdversaryViewFromContext(
      ctxOf(["A1", "A2", "B1", "B2"], TXS, {
        knownAddresses: ["A1", "B1"],
        knownTxids: [],
      }),
    );

    // All four owned addresses now sit in ONE scenario cluster.
    expect(scenario.exposureFindings).toHaveLength(1);
    const cluster = scenario.exposureFindings[0];
    expect(cluster.addresses.sort()).toEqual(["A1", "A2", "B1", "B2"]);
    // B2 only joins via the change-guess edge, so the cluster is "likely".
    expect(cluster.confidence).toBe("likely");

    const baseline = await runAdversaryViewFromContext(
      ctxOf(["A1", "A2", "B1", "B2"], TXS),
    );
    const delta = computeScenarioDelta(baseline, scenario, {
      ...META,
      knownAddressCount: 2,
    });

    // Every address was already exposed in the baseline — the delta is the
    // cluster merge and the broken separation, not new addresses.
    expect(delta.summary.newlyExposedCount).toBe(0);
    expect(delta.mergedClusters).toHaveLength(1);
    expect(delta.mergedClusters[0].baselineClusterCount).toBe(2);
    expect(delta.brokenSeparations).toHaveLength(1);
    expect(delta.narrative).toContain("collapse");
    expect(delta.narrative).toContain("separation of 1 verified wallet pair");
  });

  it("known addresses with no on-chain tie still link (knowledge-only cluster)", async () => {
    // A1 and B1 have NO transactions at all — nothing on-chain connects them
    // to anything. Only the assumed knowledge can link them.
    setRecords([
      { addr: "A1", chainType: "receive", xpub: "xpubA" },
      { addr: "B1", chainType: "receive", xpub: "xpubB" },
    ]);

    const baseline = await runAdversaryViewFromContext(ctxOf(["A1", "B1"], {}));
    expect(baseline.exposureFindings).toHaveLength(0);
    expect(baseline.separationFindings).toHaveLength(1);

    const scenario = await runAdversaryViewFromContext(
      ctxOf(["A1", "B1"], {}, { knownAddresses: ["A1", "B1"], knownTxids: [] }),
    );
    expect(scenario.exposureFindings).toHaveLength(1);
    const cluster = scenario.exposureFindings[0];
    expect(cluster.addresses.sort()).toEqual(["A1", "B1"]);
    expect(cluster.confidence).toBe("certain");
    // No transaction links them — the narrative says so.
    expect(cluster.txids).toHaveLength(0);
    expect(cluster.narrative).toContain("assumed counterparty knowledge alone");

    const delta = computeScenarioDelta(baseline, scenario, {
      ...META,
      knownAddressCount: 2,
    });
    expect(delta.newlyExposedAddresses).toEqual([
      { address: "A1", confidence: "certain" },
      { address: "B1", confidence: "certain" },
    ]);
    expect(delta.brokenSeparations).toHaveLength(1);
    expect(delta.narrative).toBe(
      "Knowing 2 addresses lets TestExchange connect 2 more of your addresses with certainty. " +
        "The on-chain separation of 1 verified wallet pair — invisible to a blind analyst — is now broken.",
    );
  });

  it("known transactions contribute their full participant graph (change by elimination)", async () => {
    // T9: A1 + an external co-input pay CP (small, external) and D1 (large,
    // OWNED). A blind analyst guesses CP is change and never links D1 to A1.
    // A counterparty who KNOWS T9 is the user's knows CP is their own payment
    // — so D1 is attributable to the user by elimination.
    const txs = {
      t9: [
        p("t9", "input", "A1", 10_000),
        p("t9", "input", "EXT1", 5_000),
        p("t9", "output", "CP", 1_000, 0),
        p("t9", "output", "D1", 9_000, 1),
      ],
    };
    setRecords([
      { addr: "A1", chainType: "receive", xpub: "xpubA" },
      { addr: "D1", chainType: "change", xpub: "xpubA" },
    ]);

    const baseline = await runAdversaryViewFromContext(ctxOf(["A1", "D1"], txs));
    expect(baseline.exposureFindings).toHaveLength(0);

    const scenario = await runAdversaryViewFromContext(
      ctxOf(["A1", "D1"], txs, { knownAddresses: [], knownTxids: ["t9"] }),
    );
    expect(scenario.exposureFindings).toHaveLength(1);
    const cluster = scenario.exposureFindings[0];
    expect(cluster.addresses.sort()).toEqual(["A1", "D1"]);
    expect(cluster.confidence).toBe("certain");
    expect(cluster.txids).toContain("t9");

    const delta = computeScenarioDelta(baseline, scenario, {
      ...META,
      knownTxidCount: 1,
    });
    expect(delta.newlyExposedAddresses).toEqual([
      { address: "A1", confidence: "certain" },
      { address: "D1", confidence: "certain" },
    ]);
    expect(delta.newExposureFindings).toHaveLength(1);
    expect(delta.narrative).toContain("Knowing 1 transaction lets TestExchange connect 2 more");
  });

  it("unknown txids and empty assumptions leave the result untouched", async () => {
    const txs = {
      t1: [p("t1", "input", "A1", 50_000), p("t1", "input", "A2", 25_000)],
    };
    setRecords([
      { addr: "A1", chainType: "receive" },
      { addr: "A2", chainType: "receive" },
    ]);
    const baseline = await runAdversaryViewFromContext(ctxOf(["A1", "A2"], txs));
    const scenario = await runAdversaryViewFromContext(
      ctxOf(["A1", "A2"], txs, {
        knownAddresses: [],
        knownTxids: ["f".repeat(64)],
      }),
    );
    expect(scenario.exposureFindings).toEqual(baseline.exposureFindings);

    const delta = computeScenarioDelta(baseline, scenario, {
      ...META,
      knownTxidCount: 1,
    });
    expect(delta.summary.newlyExposedCount).toBe(0);
    expect(delta.summary.mergedClusterCount).toBe(0);
    expect(delta.narrative).toContain("does not let TestExchange connect any more");
  });
});

describe("computeScenarioDelta (pure)", () => {
  const emptySummary = {
    exposureCount: 0,
    separationCount: 0,
    confusionCount: 0,
    contextMergeCount: 0,
    addressesExposed: 0,
    addressesSeparated: 0,
  };
  const res = (over: Partial<AdversaryViewResult>): AdversaryViewResult => ({
    exposureFindings: [],
    separationFindings: [],
    confusionFindings: [],
    contextMergeWarnings: [],
    summary: { ...emptySummary },
    degradation: null,
    chainTypeCoverage: 1,
    ...over,
  });

  it("reports context merges that only appear under the assumed knowledge", () => {
    const warning = (txid: string) => ({
      txid,
      narrative: `tx ${txid} merges contexts`,
      contexts: [],
      hasUnknownContext: false,
    });
    const baseline = res({ contextMergeWarnings: [warning("t1")] });
    const scenario = res({ contextMergeWarnings: [warning("t1"), warning("t2")] });

    const delta = computeScenarioDelta(baseline, scenario, {
      ...META,
      knownAddressCount: 1,
    });
    expect(delta.newContextMerges).toHaveLength(1);
    expect(delta.newContextMerges[0].txid).toBe("t2");
    expect(delta.summary.newContextMergeCount).toBe(1);
    expect(delta.narrative).toContain("1 transaction now publicly merges distinct acquisition contexts");
  });

  it("keeps the best (most certain) confidence per newly exposed address", () => {
    const finding = (addresses: string[], confidence: "certain" | "likely") => ({
      category: "exposure" as const,
      confidence,
      narrative: "",
      txids: [],
      addresses,
      groundTruthAvailable: true,
    });
    const baseline = res({ exposureFindings: [finding(["A", "B"], "certain")] });
    const scenario = res({
      exposureFindings: [
        finding(["A", "B", "C"], "likely"),
        finding(["C", "D"], "certain"),
      ],
    });
    const delta = computeScenarioDelta(baseline, scenario, META);
    // C appears in a likely and a certain cluster — reported as certain.
    expect(delta.newlyExposedAddresses).toEqual([
      { address: "C", confidence: "certain" },
      { address: "D", confidence: "certain" },
    ]);
  });
});

// ─── runAdversaryScenario abort handling ────────────────────────────────────
//
// The panel's Cancel button aborts an AbortController whose signal threads
// through runAdversaryScenario. These tests replace the adversary-view engine
// wholesale (full factory mock — no importOriginal, see vi-mock guidance) so
// the abort seam between the baseline and scenario phases can be driven
// deterministically.

describe("runAdversaryScenario abort", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/adversary-view");
    vi.resetModules();
  });

  it("rejects with AbortError when the signal fires between the baseline and scenario phases", async () => {
    vi.resetModules();
    const controller = new AbortController();
    const emptyResult = {
      exposureFindings: [],
      separationFindings: [],
      contextMergeWarnings: [],
    } as unknown as AdversaryViewResult;

    const buildSpy = vi.fn(async () => ({
      userAddresses: new Set<string>(),
      participantsByTxid: new Map(),
    }));
    const runViewSpy = vi.fn(async () => {
      // Baseline completes, then the user clicks Cancel before the scenario
      // phase starts.
      controller.abort();
      return emptyResult;
    });
    const extendSpy = vi.fn();

    vi.doMock("@/lib/adversary-view", () => ({
      buildAdversaryContext: buildSpy,
      runAdversaryViewFromContext: runViewSpy,
      extendAdversaryContextWithAssumed: extendSpy,
    }));

    const { runAdversaryScenario } = await import("@/lib/adversary-scenario");

    const messages: string[] = [];
    await expect(
      runAdversaryScenario(
        ["addr1"],
        { knownAddresses: ["kA"], knownTxids: [] },
        { counterpartyName: "TestExchange" },
        (m) => messages.push(m),
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    // Baseline ran exactly once; the scenario phase never started.
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(runViewSpy).toHaveBeenCalledTimes(1);
    expect(extendSpy).not.toHaveBeenCalled();
    // No progress messages after the abort (the "applying assumed…" phase
    // message must never fire).
    expect(messages.some((m) => m.includes("applying assumed"))).toBe(false);
  });

  it("rejects immediately when the signal is already aborted at entry", async () => {
    vi.resetModules();
    const controller = new AbortController();
    controller.abort();

    const buildSpy = vi.fn();
    vi.doMock("@/lib/adversary-view", () => ({
      buildAdversaryContext: buildSpy,
      runAdversaryViewFromContext: vi.fn(),
      extendAdversaryContextWithAssumed: vi.fn(),
    }));

    const { runAdversaryScenario } = await import("@/lib/adversary-scenario");

    await expect(
      runAdversaryScenario(
        ["addr1"],
        { knownAddresses: [], knownTxids: ["t1"] },
        { counterpartyName: "X" },
        undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(buildSpy).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
//
// Engine tests for the Dormant Coins scanner: exact outpoint spent detection
// (never FIFO), dust exclusion from results AND from last-activity dates,
// owned/unknown classification, co-spend clue clustering, suspected-change via
// lineage, cancel/yield behaviour, and scratch-store persistence + export.

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { createRecord, clearAllRecords } from "@/lib/data/record-crud";
import {
  addTransaction,
  bulkAddParticipants,
  clearAllTransactionData,
} from "@/lib/data/transaction-crud";
import { bulkAddUtxoLineage, clearAllLineageData } from "@/lib/data/lineage-crud";
import {
  runDormantScan,
  DORMANT_CLUE_LABELS,
  type DormantOutputRow,
  type DormantScanParams,
} from "@/lib/dormant-coins";
import { checkOutpointLive } from "@/lib/dormant-live-check";
import {
  appendDormantGroups,
  appendDormantRows,
  beginDormantRun,
  clearDormantReport,
  completeDormantRun,
  countDormantRows,
  exportDormantReport,
  getDormantRowWindow,
  getDormantRunMeta,
} from "@/lib/data/dormant-coins-report-store";

// Fixed "now" so age math is deterministic: 2027-01-15T06:40:00Z.
const NOW = 1_800_000_000;
const YEAR = 365.25 * 24 * 60 * 60;
const yearsAgo = (y: number) => Math.floor(NOW - y * YEAR);

const PARAMS: DormantScanParams = {
  minAgeYears: 3,
  minAmountSats: 10_000,
  dustThresholdSats: 1000,
  ignoreDust: false,
  nowSec: NOW,
};

const OWN1 = "bc1qdormantown1aaaaaaaaaaaaaaaaaaaaaaaaaa";
const OWN2 = "bc1qdormantown2bbbbbbbbbbbbbbbbbbbbbbbbbb";
const OWN3 = "bc1qdormantown3cccccccccccccccccccccccccc";
const OWN4 = "bc1qdormantown4dddddddddddddddddddddddddd";
const OWN5 = "bc1qdormantown5eeeeeeeeeeeeeeeeeeeeeeeeee";
const DISC1 = "bc1qdormantdiscffffffffffffffffffffffffff";
const U_A = "bc1qdormantunkagggggggggggggggggggggggggg";
const U_B = "bc1qdormantunkbhhhhhhhhhhhhhhhhhhhhhhhhhh";
const U_C = "bc1qdormantunkciiiiiiiiiiiiiiiiiiiiiiiiii";
const U_PAID = "bc1qdormantpaidjjjjjjjjjjjjjjjjjjjjjjjjj";
const U_CH = "bc1qdormantchgkkkkkkkkkkkkkkkkkkkkkkkkkk";

const TX_OLD_FUND = "aa".repeat(32); // 5y: OWN1 500k (unspent) + U_PAID 200k
const TX_COSPEND = "bb".repeat(32); // 6y: inputs OWN2 + U_A + U_B (co-spend)
const TX_PREV = "cc".repeat(32); // 8y: output OWN2 1M — spent by TX_COSPEND
const TX_UA_FUND = "dd".repeat(32); // 7y: outputs U_A 300k + U_C 150k
const TX_DUST_OLD = "ee".repeat(32); // 8y: output OWN3 100k
const TX_DUST_RECENT = "ff".repeat(32); // 1mo: dust 546 to OWN3 (must not count as activity)
const TX_OLD2 = "11".repeat(32); // 5y: output OWN2 400k — spent later (exact outpoint)
const TX_SPEND2 = "22".repeat(32); // 1mo: spends TX_OLD2:0 via outpoint
const TX_SPEND3 = "33".repeat(32); // 4y: input from OWN1 WITHOUT outpoint data (no FIFO!)
const TX_CHANGE = "44".repeat(32); // 5y: input OWN4, output U_CH 800k (lineage change)
const TX_PREV4 = "55".repeat(32); // 9y: output OWN4 — spent by TX_CHANGE
const TX_OLD3 = "66".repeat(32); // 6y: output OWN5 900k
const TX_RECENT_ACT = "77".repeat(32); // 1mo: non-dust 50k to OWN5 (kills dormancy)
const TX_DISC = "88".repeat(32); // 5y: output DISC1 250k (discovered-tier record = unknown, no clue)

async function seedVault() {
  await createRecord({ type: "address", inputString: OWN1, label: "Old savings", addressImportance: "manual" });
  await createRecord({ type: "address", inputString: OWN2, addressImportance: "wallet-import" });
  await createRecord({ type: "address", inputString: OWN3, addressImportance: "verified" });
  await createRecord({ type: "address", inputString: OWN4 }); // legacy: no tier → owned
  await createRecord({ type: "address", inputString: OWN5, addressImportance: "xpub-derived" });
  // A discovered-tier record exists but must NOT count as owned.
  await createRecord({ type: "address", inputString: DISC1, addressImportance: "blockchain-discovered" });

  const txs: Array<[string, number, number]> = [
    [TX_OLD_FUND, yearsAgo(5), 700_001],
    [TX_COSPEND, yearsAgo(6), 600_001],
    [TX_PREV, yearsAgo(8), 400_001],
    [TX_UA_FUND, yearsAgo(7), 500_001],
    [TX_DUST_OLD, yearsAgo(8), 400_002],
    [TX_DUST_RECENT, yearsAgo(1 / 12), 899_999],
    [TX_OLD2, yearsAgo(5), 700_002],
    [TX_SPEND2, yearsAgo(1 / 12), 899_998],
    [TX_SPEND3, yearsAgo(4), 650_001],
    [TX_CHANGE, yearsAgo(5), 700_003],
    [TX_PREV4, yearsAgo(9), 300_001],
    [TX_OLD3, yearsAgo(6), 600_002],
    [TX_RECENT_ACT, yearsAgo(1 / 12), 899_997],
    [TX_DISC, yearsAgo(5), 700_004],
  ];
  for (const [txid, blockTime, blockHeight] of txs) {
    await addTransaction({ txid, blockHeight, blockTime, fee: 500, feeRate: 2, syncedAt: Date.now() });
  }

  await bulkAddParticipants([
    // TX_OLD_FUND: unspent old outputs for OWN1 (own) and U_PAID (unknown, paid alongside).
    { txid: TX_OLD_FUND, role: "output", address: OWN1, amount: 500_000, vout: 0 },
    { txid: TX_OLD_FUND, role: "output", address: U_PAID, amount: 200_000, vout: 1 },
    { txid: TX_OLD_FUND, role: "input", address: "bc1qfunderoldfund000000000000000000000", amount: 710_000, prevTxid: "00".repeat(32), prevVout: 0 },
    // TX_PREV: old output to OWN2, later spent by TX_COSPEND via exact outpoint.
    { txid: TX_PREV, role: "output", address: OWN2, amount: 1_000_000, vout: 0 },
    // TX_COSPEND: owned + unknown inputs in one old tx → co-spend cluster {U_A, U_B}.
    { txid: TX_COSPEND, role: "input", address: OWN2, amount: 1_000_000, prevTxid: TX_PREV, prevVout: 0 },
    { txid: TX_COSPEND, role: "input", address: U_A, amount: 300_000, prevTxid: TX_UA_FUND, prevVout: 0 },
    { txid: TX_COSPEND, role: "input", address: U_B, amount: 50_000, prevTxid: "00".repeat(32), prevVout: 1 },
    { txid: TX_COSPEND, role: "output", address: "bc1qcospendext000000000000000000000000", amount: 1_340_000, vout: 0 },
    // TX_UA_FUND: U_A's output is spent by TX_COSPEND... make U_A's DORMANT output vout 1 instead.
    // (vout 0 here is spent via the outpoint above; vout 1 to U_C has no clue → excluded.)
    { txid: TX_UA_FUND, role: "output", address: U_A, amount: 300_000, vout: 0 },
    { txid: TX_UA_FUND, role: "output", address: U_A, amount: 300_001, vout: 1 },
    { txid: TX_UA_FUND, role: "output", address: U_C, amount: 150_000, vout: 2 },
    { txid: TX_UA_FUND, role: "input", address: "bc1qfunderuafund0000000000000000000000", amount: 800_000, prevTxid: "00".repeat(32), prevVout: 2 },
    // OWN3: old meaningful output + a RECENT dust deposit that must be ignored
    // when computing the address's last activity.
    { txid: TX_DUST_OLD, role: "output", address: OWN3, amount: 100_000, vout: 0 },
    { txid: TX_DUST_RECENT, role: "output", address: OWN3, amount: 546, vout: 0 },
    { txid: TX_DUST_RECENT, role: "input", address: "bc1qdustedattacker000000000000000000", amount: 1000, prevTxid: "00".repeat(32), prevVout: 3 },
    // TX_OLD2 spent later via exact outpoint → excluded even though address dormant.
    { txid: TX_OLD2, role: "output", address: OWN2, amount: 400_000, vout: 0 },
    { txid: TX_SPEND2, role: "input", address: OWN2, amount: 400_000, prevTxid: TX_OLD2, prevVout: 0 },
    // TX_SPEND3: outpoint-less input from OWN1 — must NOT FIFO-spend TX_OLD_FUND:0.
    { txid: TX_SPEND3, role: "input", address: OWN1, amount: 500_000 },
    { txid: TX_SPEND3, role: "output", address: "bc1qspend3dest000000000000000000000000", amount: 499_000, vout: 0 },
    // TX_CHANGE: owned input, unknown output flagged as change by lineage.
    { txid: TX_PREV4, role: "output", address: OWN4, amount: 900_000, vout: 0 },
    { txid: TX_CHANGE, role: "input", address: OWN4, amount: 900_000, prevTxid: TX_PREV4, prevVout: 0 },
    { txid: TX_CHANGE, role: "output", address: U_CH, amount: 800_000, vout: 1 },
    // OWN5: old unspent output but recent NON-dust activity → excluded (not dormant).
    { txid: TX_OLD3, role: "output", address: OWN5, amount: 900_000, vout: 0 },
    { txid: TX_RECENT_ACT, role: "output", address: OWN5, amount: 50_000, vout: 0 },
    { txid: TX_RECENT_ACT, role: "input", address: "bc1qrecentpayer0000000000000000000000", amount: 60_000, prevTxid: "00".repeat(32), prevVout: 4 },
    // DISC1: old unspent output on a discovered-tier record (unknown) with NO
    // clue connecting it to owned activity → excluded.
    { txid: TX_DISC, role: "output", address: DISC1, amount: 250_000, vout: 0 },
    { txid: TX_DISC, role: "input", address: "bc1qdiscpayer000000000000000000000000000", amount: 260_000, prevTxid: "00".repeat(32), prevVout: 5 },
  ]);

  // Lineage marks TX_CHANGE:vout1 as change (address itself stays unknown).
  await bulkAddUtxoLineage([
    {
      spentTxid: TX_PREV4,
      spentVout: 0,
      spentAddress: OWN4,
      spentAmount: 900_000,
      consumingTxid: TX_CHANGE,
      createdTxid: TX_CHANGE,
      createdVout: 1,
      createdAddress: U_CH,
      createdAmount: 800_000,
      spentOwned: true,
      createdOwned: false,
      isChange: true,
      confidence: "medium",
      blockTime: yearsAgo(5),
      blockHeight: 700_003,
      createdAt: Date.now(),
    },
  ]);
}

async function runScanCollect(params: DormantScanParams = PARAMS, signal = new AbortController().signal) {
  const rows: DormantOutputRow[] = [];
  const groups: import("@/lib/dormant-coins").DormantClueGroup[] = [];
  const summary = await runDormantScan(params, {
    signal,
    onBatch: async (b) => {
      rows.push(...b);
    },
    onGroupBatch: async (g) => {
      groups.push(...g);
    },
  });
  return { rows, groups, summary };
}

describe("dormant coins engine", () => {
  beforeEach(async () => {
    await clearAllRecords();
    await clearAllTransactionData();
    await clearAllLineageData();
    await seedVault();
  });

  afterEach(() => {
    cleanup();
  });

  it("finds dormant outputs with the expected clue types and exact totals", async () => {
    const { rows, groups, summary } = await runScanCollect();
    expect(summary).not.toBeNull();

    const byKey = new Map(rows.map((r) => [`${r.txid}:${r.vout}`, r]));

    // OWN1's old output: own dormant. TX_SPEND3 (4y ago, outpoint-less) is
    // its last meaningful activity — and must NOT have FIFO-spent the output.
    const own1 = byKey.get(`${TX_OLD_FUND}:0`);
    expect(own1).toBeDefined();
    expect(own1!.clueType).toBe("own-dormant");
    expect(own1!.owned).toBe(true);
    expect(own1!.amountSats).toBe(500_000);
    expect(own1!.lastActivity).toBe(yearsAgo(4));
    expect(own1!.blockHeight).toBe(700_001);
    expect(own1!.label).toBe("Old savings");

    // U_PAID: unknown output in a tx that also paid an owned address.
    const paid = byKey.get(`${TX_OLD_FUND}:1`);
    expect(paid!.clueType).toBe("paid-alongside");
    expect(paid!.owned).toBe(false);

    // U_A vout1: co-spent with owned keys (vout0 was spent via exact outpoint).
    expect(byKey.get(`${TX_UA_FUND}:0`)).toBeUndefined();
    const coSpent = byKey.get(`${TX_UA_FUND}:1`);
    expect(coSpent!.clueType).toBe("co-spent");
    expect(coSpent!.groupId).toBe(1);

    // U_CH: lineage change signal wins over everything else.
    const chg = byKey.get(`${TX_CHANGE}:1`);
    expect(chg!.clueType).toBe("suspected-change");

    // OWN3: recent DUST deposit must not count as last activity — the address
    // still surfaces, dormancy dated to its last meaningful (old) output.
    const dusted = byKey.get(`${TX_DUST_OLD}:0`);
    expect(dusted).toBeDefined();
    expect(dusted!.lastActivity).toBe(yearsAgo(8));
    // The dust deposit itself is excluded from results.
    expect(byKey.get(`${TX_DUST_RECENT}:0`)).toBeUndefined();

    // Exclusions.
    expect(byKey.get(`${TX_PREV}:0`)).toBeUndefined(); // spent (exact outpoint)
    expect(byKey.get(`${TX_OLD2}:0`)).toBeUndefined(); // spent (exact outpoint)
    expect(byKey.get(`${TX_OLD3}:0`)).toBeUndefined(); // address recently active (non-dust)
    expect(byKey.get(`${TX_UA_FUND}:2`)).toBeUndefined(); // unknown with no clue
    expect(byKey.get(`${TX_DISC}:0`)).toBeUndefined(); // discovered-tier, no clue

    expect(summary!.rowCount).toBe(5);
    expect(summary!.totalSats).toBe(500_000 + 200_000 + 300_001 + 100_000 + 800_000);
    expect(summary!.ownSats).toBe(500_000 + 100_000);
    expect(summary!.missingOutpointInputs).toBe(1); // TX_SPEND3's input
    expect(summary!.oldestBlockTime).toBe(yearsAgo(8));

    // Ranked oldest first.
    expect(rows[0].blockTime).toBe(yearsAgo(8));

    // One co-spend group with both unknown members (U_B has no dormant output
    // but is still a cluster member).
    expect(groups).toHaveLength(1);
    expect(groups[0].groupId).toBe(1);
    expect(groups[0].addresses).toEqual([...groups[0].addresses].sort());
    expect(groups[0].addresses).toContain(U_A);
    expect(groups[0].addresses).toContain(U_B);
    expect(groups[0].addressCount).toBe(2);
    expect(groups[0].coSpendTxCount).toBe(1);
    expect(groups[0].totalDormantSats).toBe(300_001);
    expect(groups[0].dormantOutputCount).toBe(1);
  });

  it("ignoreDust disables both dust rules", async () => {
    const { rows, summary } = await runScanCollect({ ...PARAMS, ignoreDust: true });
    const byKey = new Map(rows.map((r) => [`${r.txid}:${r.vout}`, r]));
    // The recent dust deposit now counts as activity → OWN3 is no longer
    // dormant, so its old output drops out; and dust outputs are eligible,
    // though still gated by minAmountSats (546 < 10_000 → excluded here).
    expect(byKey.get(`${TX_DUST_OLD}:0`)).toBeUndefined();
    expect(byKey.get(`${TX_DUST_RECENT}:0`)).toBeUndefined();
    expect(summary!.rowCount).toBe(4);
  });

  it("dust output surfaces when ignoreDust and minAmount allow it", async () => {
    const { rows } = await runScanCollect({ ...PARAMS, ignoreDust: true, minAmountSats: 100 });
    const dustRow = rows.find((r) => r.txid === TX_DUST_RECENT);
    // 546-sat output now eligible, but the address is recently active via that
    // same deposit... so the address gate excludes it. Prove the dust RESULT
    // rule independently: lower age so TX_DUST_RECENT is itself "old".
    expect(dustRow).toBeUndefined();
    const { rows: rows2 } = await runScanCollect({
      ...PARAMS,
      ignoreDust: true,
      minAmountSats: 100,
      minAgeYears: 0.02, // ~1 week: even the recent dust is "old"
    });
    const dustRow2 = rows2.find((r) => r.txid === TX_DUST_RECENT && r.vout === 0);
    expect(dustRow2).toBeDefined();
    expect(dustRow2!.amountSats).toBe(546);
    expect(dustRow2!.clueType).toBe("own-dormant");
  });

  it("minAmountSats filters outputs", async () => {
    const { summary } = await runScanCollect({ ...PARAMS, minAmountSats: 600_000 });
    // Only U_CH's 800k output survives the floor.
    expect(summary!.rowCount).toBe(1);
    expect(summary!.totalSats).toBe(800_000);
  });

  it("minAgeYears gates on creation AND last-activity dates", async () => {
    // Age 9 years: nothing is old enough.
    const { summary } = await runScanCollect({ ...PARAMS, minAgeYears: 9 });
    expect(summary!.rowCount).toBe(0);
    // Age 1 month: recent non-dust outputs now qualify too (OWN5 received 50k
    // 1mo ago → that output is old enough under a 0.02y cutoff... keep 1/12y
    // boundary: TX_RECENT_ACT is exactly 1/12y old — use a slightly smaller age).
    const { summary: s2 } = await runScanCollect({ ...PARAMS, minAgeYears: 1 / 13 });
    expect(s2!.rowCount).toBeGreaterThan(5);
  });

  it("cancels promptly when aborted mid-scan", async () => {
    const controller = new AbortController();
    const progressPhases: string[] = [];
    const promise = runDormantScan(PARAMS, {
      signal: controller.signal,
      onProgress: (p) => {
        progressPhases.push(p.phase);
        controller.abort(); // cancel after the very first progress callback
      },
    });
    const result = await promise;
    expect(result).toBeNull();
    expect(progressPhases.length).toBeGreaterThan(0);
  });

  it("yields cooperatively to the event loop during a run", async () => {
    const yields = vi.fn();
    const { summary } = await (async () => {
      const rows: DormantOutputRow[] = [];
      const summary = await runDormantScan(PARAMS, {
        signal: new AbortController().signal,
        onYield: yields,
        onBatch: async (b) => {
          rows.push(...b);
        },
      });
      return { rows, summary };
    })();
    expect(summary).not.toBeNull();
    // Between-batch yields (records/transactions/participants phases) fire even
    // on this small fixture; huge vaults additionally hit the 5000-iteration
    // in-loop yields.
    expect(yields.mock.calls.length).toBeGreaterThan(0);
  });

  it("returns null when aborted before start", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runDormantScan(PARAMS, { signal: controller.signal });
    expect(result).toBeNull();
  });
});

describe("dormant coins report store", () => {
  beforeEach(async () => {
    await clearDormantReport();
  });

  const sampleRow = (over: Partial<DormantOutputRow> = {}): DormantOutputRow => ({
    address: "bc1qstoretestaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    txid: "99".repeat(32),
    vout: 0,
    amountSats: 123_456,
    blockTime: yearsAgo(5),
    blockHeight: 700_000,
    owned: true,
    recordId: 7,
    clueType: "own-dormant",
    lastActivity: yearsAgo(4),
    ...over,
  });

  it("tracks run state: running (interrupted) → complete with summary", async () => {
    expect(await getDormantRunMeta()).toBeUndefined();
    await beginDormantRun(PARAMS);
    const running = await getDormantRunMeta();
    expect(running?.status).toBe("running");

    await completeDormantRun({
      rowCount: 2,
      groupCount: 1,
      totalSats: 300_000,
      ownSats: 100_000,
      clueSats: 200_000,
      scannedParticipants: 10,
      scannedTransactions: 5,
      missingOutpointInputs: 0,
      oldestBlockTime: yearsAgo(5),
      params: PARAMS,
    });
    const done = await getDormantRunMeta();
    expect(done?.status).toBe("complete");
    expect(done?.summary?.rowCount).toBe(2);
    expect(done?.finishedAt).toBeDefined();
  });

  it("stores rows in insertion order and serves bounded windows", async () => {
    const rows = Array.from({ length: 250 }, (_, i) =>
      sampleRow({ txid: String(i).padStart(4, "0") + "99".repeat(30), amountSats: i }),
    );
    await appendDormantRows(rows.slice(0, 100));
    await appendDormantRows(rows.slice(100));
    expect(await countDormantRows()).toBe(250);
    const window = await getDormantRowWindow(100, 50);
    expect(window).toHaveLength(50);
    expect(window[0].amountSats).toBe(100);
    expect(window[49].amountSats).toBe(149);
  });

  it("exports CSV exactly, sanitizing formula sigils", async () => {
    await beginDormantRun(PARAMS);
    await appendDormantRows([
      sampleRow({ address: "=HYPERLINK(\"http://evil\")", vout: 0 }),
      sampleRow({ address: "bc1qnormal000000000000000000000000000", vout: 1 }),
    ]);
    await appendDormantGroups([
      {
        groupId: 1,
        addresses: ["bc1qga000000000000000000000000000000000"],
        addressCount: 1,
        coSpendTxCount: 1,
        oldestBlockTime: yearsAgo(6),
        totalDormantSats: 50_000,
        dormantOutputCount: 1,
      },
    ]);
    const { blob, rowCount } = await exportDormantReport("csv");
    expect(rowCount).toBe(2);
    const text = await blob.text();
    const lines = text.trim().split("\r\n");
    expect(lines[0]).toBe(
      "Address,Clue,Ownership,Amount Sats,Created,Block,Age Years,Last Meaningful Activity,Txid,Vout,Record Id,Co-spend Group",
    );
    // Formula sigil neutralized with a leading apostrophe, then RFC4180-quoted.
    expect(lines[1]).toContain("'=HYPERLINK(\"\"http://evil\"\")");
    expect(lines[1]).toContain(DORMANT_CLUE_LABELS["own-dormant"]);
    expect(lines[1]).toContain("owned");
    expect(lines[2]).toContain("bc1qnormal000000000000000000000000000");
  });

  it("exports JSON with summary, groups and rows", async () => {
    await beginDormantRun(PARAMS);
    await completeDormantRun({
      rowCount: 1,
      groupCount: 0,
      totalSats: 123_456,
      ownSats: 123_456,
      clueSats: 0,
      scannedParticipants: 10,
      scannedTransactions: 5,
      missingOutpointInputs: 0,
      params: PARAMS,
    });
    await appendDormantRows([sampleRow()]);
    const { blob, rowCount } = await exportDormantReport("json");
    expect(rowCount).toBe(1);
    const parsed = JSON.parse(await blob.text());
    expect(parsed.summary.rowCount).toBe(1);
    expect(parsed.params.minAgeYears).toBe(3);
    expect(parsed.groups).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].amountSats).toBe(123_456);
    expect(parsed.rows[0].seq).toBeUndefined(); // internal sequence stripped
  });
});

describe("checkOutpointLive", () => {
  const target = { txid: "aa".repeat(32), vout: 1, address: "bc1qlivechecktarget0000000000000000000" };

  it("uses the Esplora outspend endpoint when available", async () => {
    const getTxOutspend = vi.fn().mockResolvedValue({ spent: false });
    const result = await checkOutpointLive({ name: "esplora", getTxOutspend } as never, target);
    expect(result).toEqual({ status: "unspent", spentTxid: undefined });
    expect(getTxOutspend).toHaveBeenCalledWith(target.txid, target.vout, undefined);

    getTxOutspend.mockResolvedValue({ spent: true, spentTxid: "bb".repeat(32) });
    const spent = await checkOutpointLive({ name: "esplora", getTxOutspend } as never, target);
    expect(spent).toEqual({ status: "spent", spentTxid: "bb".repeat(32) });
  });

  it("throws when the node does not know the output (Esplora null)", async () => {
    const getTxOutspend = vi.fn().mockResolvedValue(null);
    await expect(
      checkOutpointLive({ name: "esplora", getTxOutspend } as never, target),
    ).rejects.toThrow(/does not know/i);
  });

  it("falls back to Electrum listunspent outpoint matching", async () => {
    const getAddressUtxoOutpoints = vi.fn().mockResolvedValue([
      { txid: target.txid, vout: 1, valueSats: 5000 },
      { txid: "cc".repeat(32), vout: 0, valueSats: 100 },
    ]);
    const unspent = await checkOutpointLive(
      { name: "electrum", getAddressUtxoOutpoints } as never,
      target,
    );
    expect(unspent).toEqual({ status: "unspent" });
    expect(getAddressUtxoOutpoints).toHaveBeenCalledWith(target.address, undefined);

    // Same txid but different vout does NOT count — exact outpoint only.
    getAddressUtxoOutpoints.mockResolvedValue([{ txid: target.txid, vout: 0, valueSats: 5000 }]);
    const spent = await checkOutpointLive(
      { name: "electrum", getAddressUtxoOutpoints } as never,
      target,
    );
    expect(spent).toEqual({ status: "spent" });
  });

  it("throws for Electrum targets without an address", async () => {
    const getAddressUtxoOutpoints = vi.fn();
    await expect(
      checkOutpointLive(
        { name: "electrum", getAddressUtxoOutpoints } as never,
        { ...target, address: "" },
      ),
    ).rejects.toThrow(/no address/i);
    expect(getAddressUtxoOutpoints).not.toHaveBeenCalled();
  });

  it("throws for providers supporting neither strategy", async () => {
    await expect(checkOutpointLive({ name: "bare" } as never, target)).rejects.toThrow(
      /does not support/i,
    );
  });
});

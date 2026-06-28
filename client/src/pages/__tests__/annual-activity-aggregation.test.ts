// @vitest-environment jsdom
//
// Unit tests for computeAnnualActivity() — the pure aggregation core extracted
// from the Annual Activity Report's generate() flow.
//
// Focus: the edge case where a single pasted address appears as BOTH an input
// and an output of the same transaction (a self-transfer or consolidation).
// In that situation received and spent sats must be summed independently and the
// transaction must be counted exactly once per year, and the pasted address must
// never show up in its own "received from" / "sent to" counterparty lists.

import { describe, it, expect } from "vitest";
import type { BlockchainTransaction, TransactionParticipant } from "@/lib/database";
import { computeAnnualActivity } from "../AnnualActivityReport";

// ---- Fixtures --------------------------------------------------------------

// 64-char-ish hex-looking txids (any colon-free string works for the keying).
const SELF = "aaaa000000000000000000000000000000000000000000000000000000000001";
const CONSOL = "bbbb000000000000000000000000000000000000000000000000000000000002";
const SRC_A = "cccc000000000000000000000000000000000000000000000000000000000003";
const SRC_B = "dddd000000000000000000000000000000000000000000000000000000000004";

const MINE = "bc1qmine0000000000000000000000000000000000";
const MINE_A = "bc1qmineaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MINE_B = "bc1qminebbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MINE_C = "bc1qminecccccccccccccccccccccccccccccccccc";
const MINE_D = "bc1qminedddddddddddddddddddddddddddddddddd";
const EXT_Y = "bc1qexternalyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy";
const EXT_Z = "bc1qexternalzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";

// 2023-06-01T00:00:00Z and 2024-06-01T00:00:00Z
const TIME_2023 = Math.floor(Date.UTC(2023, 5, 1) / 1000);
const TIME_2024 = Math.floor(Date.UTC(2024, 5, 1) / 1000);

function mkTx(txid: string, blockTime: number): BlockchainTransaction {
  return {
    txid,
    blockHeight: 800000,
    blockTime,
    fee: 0,
    feeRate: 0,
    syncedAt: 0,
  } as BlockchainTransaction;
}

function mkInput(
  txid: string,
  address: string,
  amount: number,
  prevTxid: string,
  prevVout: number,
  id: number,
): TransactionParticipant {
  return { id, txid, role: "input", address, amount, prevTxid, prevVout };
}

function mkOutput(
  txid: string,
  address: string,
  amount: number,
  vout: number,
  id: number,
): TransactionParticipant {
  return { id, txid, role: "output", address, amount, vout };
}

function participantMap(parts: TransactionParticipant[]): Map<string, TransactionParticipant[]> {
  const map = new Map<string, TransactionParticipant[]>();
  for (const p of parts) {
    const list = map.get(p.txid) ?? [];
    list.push(p);
    map.set(p.txid, list);
  }
  return map;
}

describe("computeAnnualActivity — address both sends and receives in one tx", () => {
  it("counts received and spent independently and the tx once for a self-transfer", () => {
    // SELF: MINE spends one of its own UTXOs (100k) and receives change (90k);
    // 10k goes to fee. The pasted address is both an input and an output.
    const participants = [
      mkInput(SELF, MINE, 100_000, SRC_A, 0, 1),
      mkOutput(SELF, MINE, 90_000, 0, 2),
      mkOutput(SELF, EXT_Y, 0, 1, 3), // no real external payment here
    ];

    const result = computeAnnualActivity({
      addresses: [MINE],
      txids: [SELF],
      txMap: new Map([[SELF, mkTx(SELF, TIME_2023)]]),
      allTxParticipants: participantMap(participants),
      spendingTxids: new Set(),
      spentOutputAmounts: new Map(),
      outputAmountLookup: new Map(),
    });

    // Combined year rows: single 2023 row.
    expect(result.combinedYearRows).toHaveLength(1);
    const row = result.combinedYearRows[0];
    expect(row.year).toBe(2023);
    expect(row.receivedSats).toBe(90_000);
    expect(row.spentSats).toBe(100_000);
    // Counted ONCE despite the address being on both sides of the tx.
    expect(row.txCount).toBe(1);

    // Per-address breakdown matches the combined totals (single address).
    const mine = result.perAddress.find((a) => a.address === MINE)!;
    expect(mine.hasData).toBe(true);
    expect(mine.yearRows).toHaveLength(1);
    expect(mine.yearRows[0]).toMatchObject({
      year: 2023,
      txCount: 1,
      receivedSats: 90_000,
      spentSats: 100_000,
    });
  });

  it("does not list the pasted address among its own counterparties", () => {
    // SELF: a genuine self-transfer with real change back to MINE plus an actual
    // external payment to EXT_Y, so we can confirm EXT_Y shows up but MINE never
    // appears in receivedFrom or sentTo.
    const participants = [
      mkInput(SELF, MINE, 100_000, SRC_A, 0, 1),
      mkOutput(SELF, MINE, 60_000, 0, 2), // change back to self
      mkOutput(SELF, EXT_Y, 30_000, 1, 3), // real external payment
    ];

    const result = computeAnnualActivity({
      addresses: [MINE],
      txids: [SELF],
      txMap: new Map([[SELF, mkTx(SELF, TIME_2023)]]),
      allTxParticipants: participantMap(participants),
      spendingTxids: new Set(),
      spentOutputAmounts: new Map(),
      outputAmountLookup: new Map(),
    });

    const sentToAddrs = result.sentTo.map((e) => e.address);
    const receivedFromAddrs = result.receivedFrom.map((e) => e.address);

    // External counterparty present...
    expect(sentToAddrs).toContain(EXT_Y);
    // ...but the pasted address never lists itself as a counterparty.
    expect(sentToAddrs).not.toContain(MINE);
    expect(receivedFromAddrs).not.toContain(MINE);

    // Sanity: received = change (60k), spent = input (100k), one tx.
    expect(result.combinedYearRows[0].receivedSats).toBe(60_000);
    expect(result.combinedYearRows[0].spentSats).toBe(100_000);
    expect(result.combinedYearRows[0].txCount).toBe(1);
  });

  it("sums multiple self-owned inputs (consolidation) without double-counting the tx", () => {
    // CONSOL: MINE consolidates two of its own UTXOs (30k + 40k) into a single
    // output back to itself (65k), 5k fee. Two input rows for the SAME address.
    const participants = [
      mkInput(CONSOL, MINE, 30_000, SRC_A, 0, 1),
      mkInput(CONSOL, MINE, 40_000, SRC_B, 0, 2),
      mkOutput(CONSOL, MINE, 65_000, 0, 3),
    ];

    const result = computeAnnualActivity({
      addresses: [MINE],
      txids: [CONSOL],
      txMap: new Map([[CONSOL, mkTx(CONSOL, TIME_2024)]]),
      allTxParticipants: participantMap(participants),
      spendingTxids: new Set(),
      spentOutputAmounts: new Map(),
      outputAmountLookup: new Map(),
    });

    expect(result.combinedYearRows).toHaveLength(1);
    const row = result.combinedYearRows[0];
    expect(row.year).toBe(2024);
    expect(row.spentSats).toBe(70_000); // 30k + 40k
    expect(row.receivedSats).toBe(65_000);
    expect(row.txCount).toBe(1); // consolidation is still one transaction

    // The address must not appear as its own counterparty.
    expect(result.sentTo.map((e) => e.address)).not.toContain(MINE);
    expect(result.receivedFrom.map((e) => e.address)).not.toContain(MINE);
  });

  it("keeps per-year tx-count correct when a self-transfer spans multiple years", () => {
    // One self-transfer in 2023 and one consolidation in 2024 for the same addr.
    const parts2023 = [
      mkInput(SELF, MINE, 100_000, SRC_A, 0, 1),
      mkOutput(SELF, MINE, 95_000, 0, 2),
    ];
    const parts2024 = [
      mkInput(CONSOL, MINE, 50_000, SRC_B, 0, 3),
      mkOutput(CONSOL, MINE, 45_000, 0, 4),
    ];

    const result = computeAnnualActivity({
      addresses: [MINE],
      txids: [SELF, CONSOL],
      txMap: new Map([
        [SELF, mkTx(SELF, TIME_2023)],
        [CONSOL, mkTx(CONSOL, TIME_2024)],
      ]),
      allTxParticipants: participantMap([...parts2023, ...parts2024]),
      spendingTxids: new Set(),
      spentOutputAmounts: new Map(),
      outputAmountLookup: new Map(),
    });

    expect(result.combinedYearRows).toHaveLength(2);
    const byYear = Object.fromEntries(result.combinedYearRows.map((r) => [r.year, r]));
    expect(byYear[2023]).toMatchObject({ txCount: 1, receivedSats: 95_000, spentSats: 100_000 });
    expect(byYear[2024]).toMatchObject({ txCount: 1, receivedSats: 45_000, spentSats: 50_000 });
  });

  it("resolves an input amount stored as 0 via the prevout lookup (still counts spend)", () => {
    // The input row for MINE has amount=0 (unresolved prevout), but the prevout
    // amount is recoverable through outputAmountLookup. The spend must still be
    // attributed correctly even though the address is also an output here.
    const participants = [
      mkInput(SELF, MINE, 0, SRC_A, 2, 1),
      mkOutput(SELF, MINE, 70_000, 0, 2),
    ];

    const result = computeAnnualActivity({
      addresses: [MINE],
      txids: [SELF],
      txMap: new Map([[SELF, mkTx(SELF, TIME_2023)]]),
      allTxParticipants: participantMap(participants),
      spendingTxids: new Set(),
      spentOutputAmounts: new Map(),
      outputAmountLookup: new Map([[`${SRC_A}:2`, 80_000]]),
    });

    const row = result.combinedYearRows[0];
    expect(row.spentSats).toBe(80_000); // resolved from prevout, not 0
    expect(row.receivedSats).toBe(70_000);
    expect(row.txCount).toBe(1);
  });
});

describe("computeAnnualActivity — blank-address spend via the prevout fallback", () => {
  it("counts a blank-address spend recovered from spentOutputAmounts and adds change back to self", () => {
    // CONSOL spends a prior UTXO of MINE, but the input row's address is blank
    // (never resolved), so the address-index lookup misses it entirely. The
    // spend is recoverable only through spendingTxids + spentOutputAmounts.
    const participants = [
      mkInput(CONSOL, "", 0, SRC_A, 0, 1), // blank-address input
      mkOutput(CONSOL, MINE, 90_000, 0, 2), // change back to self
    ];

    const result = computeAnnualActivity({
      addresses: [MINE],
      txids: [CONSOL],
      txMap: new Map([[CONSOL, mkTx(CONSOL, TIME_2024)]]),
      allTxParticipants: participantMap(participants),
      spendingTxids: new Set([CONSOL]),
      spentOutputAmounts: new Map([
        [`${CONSOL}:${SRC_A}:0`, { amount: 100_000, address: MINE }],
      ]),
      outputAmountLookup: new Map(),
    });

    expect(result.combinedYearRows).toHaveLength(1);
    const row = result.combinedYearRows[0];
    expect(row.year).toBe(2024);
    // Spend recovered via the fallback even though the input address is blank.
    expect(row.spentSats).toBe(100_000);
    // Change-back-to-self output is still counted (exactly once).
    expect(row.receivedSats).toBe(90_000);
    expect(row.txCount).toBe(1);

    // Per-address breakdown mirrors the combined totals.
    const mine = result.perAddress.find((a) => a.address === MINE)!;
    expect(mine.hasData).toBe(true);
    expect(mine.yearRows[0]).toMatchObject({
      year: 2024,
      txCount: 1,
      receivedSats: 90_000,
      spentSats: 100_000,
    });

    // The blank input means the spend's source could not be resolved.
    expect(result.unresolvedSentToCount).toBe(1);
  });

  it("does not double-count a prevout already attributed to a resolved direct input", () => {
    // SELF has a resolved direct input for MINE (50k) AND the same prevout also
    // appears in spentOutputAmounts. seenPrevouts must stop the fallback from
    // adding the spend a second time.
    const participants = [
      mkInput(SELF, MINE, 50_000, SRC_A, 0, 1), // resolved direct input
      mkOutput(SELF, MINE, 45_000, 0, 2),
    ];

    const result = computeAnnualActivity({
      addresses: [MINE],
      txids: [SELF],
      txMap: new Map([[SELF, mkTx(SELF, TIME_2023)]]),
      allTxParticipants: participantMap(participants),
      spendingTxids: new Set([SELF]),
      spentOutputAmounts: new Map([
        [`${SELF}:${SRC_A}:0`, { amount: 50_000, address: MINE }],
      ]),
      outputAmountLookup: new Map(),
    });

    const row = result.combinedYearRows[0];
    // Counted ONCE (50k), not 100k.
    expect(row.spentSats).toBe(50_000);
    expect(row.receivedSats).toBe(45_000);
    expect(row.txCount).toBe(1);
    // A resolved direct input exists, so this is not an unresolved spend.
    expect(result.unresolvedSentToCount).toBe(0);
  });

  it("counts both a resolved input and a separate blank-address prevout in one tx", () => {
    // CONSOL spends two of MINE's prior UTXOs: one resolved directly (30k), one
    // whose input row is blank and only recoverable via the fallback (40k). The
    // resolved prevout must not be re-added; the blank one must be added.
    const participants = [
      mkInput(CONSOL, MINE, 30_000, SRC_A, 0, 1), // resolved direct input
      mkInput(CONSOL, "", 0, SRC_B, 0, 2), // blank input → fallback only
      mkOutput(CONSOL, MINE, 60_000, 0, 3),
    ];

    const result = computeAnnualActivity({
      addresses: [MINE],
      txids: [CONSOL],
      txMap: new Map([[CONSOL, mkTx(CONSOL, TIME_2024)]]),
      allTxParticipants: participantMap(participants),
      spendingTxids: new Set([CONSOL]),
      spentOutputAmounts: new Map([
        [`${CONSOL}:${SRC_A}:0`, { amount: 30_000, address: MINE }], // already resolved → skipped
        [`${CONSOL}:${SRC_B}:0`, { amount: 40_000, address: MINE }], // fallback adds this
      ]),
      outputAmountLookup: new Map(),
    });

    const row = result.combinedYearRows[0];
    // 30k (resolved, counted once) + 40k (fallback) = 70k.
    expect(row.spentSats).toBe(70_000);
    expect(row.receivedSats).toBe(60_000);
    expect(row.txCount).toBe(1);
  });

  it("flags unresolvedSentToCount and lists the real external recipient for a blank-input spend", () => {
    // SELF spends a UTXO of MINE via a blank input and pays an external address.
    const participants = [
      mkInput(SELF, "", 0, SRC_A, 0, 1), // blank input
      mkOutput(SELF, EXT_Y, 95_000, 0, 2), // real external payment
    ];

    const result = computeAnnualActivity({
      addresses: [MINE],
      txids: [SELF],
      txMap: new Map([[SELF, mkTx(SELF, TIME_2023)]]),
      allTxParticipants: participantMap(participants),
      spendingTxids: new Set([SELF]),
      spentOutputAmounts: new Map([
        [`${SELF}:${SRC_A}:0`, { amount: 100_000, address: MINE }],
      ]),
      outputAmountLookup: new Map(),
    });

    const row = result.combinedYearRows[0];
    expect(row.spentSats).toBe(100_000);
    expect(row.receivedSats).toBe(0);
    expect(row.txCount).toBe(1);

    // Blank input → the spend's source is unresolved.
    expect(result.unresolvedSentToCount).toBe(1);
    // The genuine external recipient is still recorded as a counterparty.
    expect(result.sentTo.map((e) => e.address)).toContain(EXT_Y);
  });
});

describe("computeAnnualActivity — two pasted addresses trade in one tx", () => {
  it("sums A's spend and B's receipt without listing either as the other's counterparty", () => {
    // SELF tx: pasted address MINE_A is an input (spends 100k) and pasted
    // address MINE_B is an output (receives 90k); 10k goes to fee. Because BOTH
    // addresses belong to the user's own set, the combined totals must add A's
    // spend and B's receipt, the per-address rows must split cleanly, and NEITHER
    // address may show up as the other's counterparty.
    const participants = [
      mkInput(SELF, MINE_A, 100_000, SRC_A, 0, 1),
      mkOutput(SELF, MINE_B, 90_000, 0, 2),
    ];

    const result = computeAnnualActivity({
      addresses: [MINE_A, MINE_B],
      txids: [SELF],
      txMap: new Map([[SELF, mkTx(SELF, TIME_2023)]]),
      allTxParticipants: participantMap(participants),
      spendingTxids: new Set(),
      spentOutputAmounts: new Map(),
      outputAmountLookup: new Map(),
    });

    // Combined: one 2023 row counted exactly once, totals add both sides.
    expect(result.combinedYearRows).toHaveLength(1);
    const row = result.combinedYearRows[0];
    expect(row.year).toBe(2023);
    expect(row.receivedSats).toBe(90_000); // B's receipt
    expect(row.spentSats).toBe(100_000); // A's spend
    expect(row.txCount).toBe(1);

    // Per-address split: A spent only, B received only.
    const a = result.perAddress.find((p) => p.address === MINE_A)!;
    const b = result.perAddress.find((p) => p.address === MINE_B)!;
    expect(a.hasData).toBe(true);
    expect(b.hasData).toBe(true);
    expect(a.yearRows).toHaveLength(1);
    expect(b.yearRows).toHaveLength(1);
    expect(a.yearRows[0]).toMatchObject({
      year: 2023,
      txCount: 1,
      receivedSats: 0,
      spentSats: 100_000,
    });
    expect(b.yearRows[0]).toMatchObject({
      year: 2023,
      txCount: 1,
      receivedSats: 90_000,
      spentSats: 0,
    });

    // Neither pasted address appears as the other's counterparty.
    const sentToAddrs = result.sentTo.map((e) => e.address);
    const receivedFromAddrs = result.receivedFrom.map((e) => e.address);
    expect(sentToAddrs).not.toContain(MINE_A);
    expect(sentToAddrs).not.toContain(MINE_B);
    expect(receivedFromAddrs).not.toContain(MINE_A);
    expect(receivedFromAddrs).not.toContain(MINE_B);
    // With only owned addresses on both sides, there are no counterparties.
    expect(result.sentTo).toHaveLength(0);
    expect(result.receivedFrom).toHaveLength(0);
  });

  it("still records genuine external counterparties alongside the A→B internal move", () => {
    // SELF tx: MINE_A spends 100k. Outputs: 90k to MINE_B (internal), 8k to an
    // external EXT_Z (a real payment). EXT_Y is an additional external co-input so
    // a "received from" entry exists for B's receipt. The internal owned addresses
    // must never appear, but the real external parties must.
    const participants = [
      mkInput(SELF, MINE_A, 100_000, SRC_A, 0, 1),
      mkInput(SELF, EXT_Y, 10_000, SRC_B, 0, 2), // external co-input
      mkOutput(SELF, MINE_B, 90_000, 0, 3), // internal move to owned addr
      mkOutput(SELF, EXT_Z, 8_000, 1, 4), // real external payment
    ];

    const result = computeAnnualActivity({
      addresses: [MINE_A, MINE_B],
      txids: [SELF],
      txMap: new Map([[SELF, mkTx(SELF, TIME_2023)]]),
      allTxParticipants: participantMap(participants),
      spendingTxids: new Set(),
      spentOutputAmounts: new Map(),
      outputAmountLookup: new Map(),
    });

    // Combined totals: only the pasted addresses' own legs are counted.
    const row = result.combinedYearRows[0];
    expect(row.receivedSats).toBe(90_000); // B received
    expect(row.spentSats).toBe(100_000); // A spent (EXT_Y's 10k is not ours)
    expect(row.txCount).toBe(1);

    const sentToAddrs = result.sentTo.map((e) => e.address);
    const receivedFromAddrs = result.receivedFrom.map((e) => e.address);

    // Real external counterparties are present...
    expect(sentToAddrs).toContain(EXT_Z); // B/A's tx sent to external
    expect(receivedFromAddrs).toContain(EXT_Y); // external funded B's receipt
    // ...but the owned addresses never list each other (or themselves).
    expect(sentToAddrs).not.toContain(MINE_A);
    expect(sentToAddrs).not.toContain(MINE_B);
    expect(receivedFromAddrs).not.toContain(MINE_A);
    expect(receivedFromAddrs).not.toContain(MINE_B);
  });

  it("sums all owned inputs and all owned outputs for a multi-input multi-output internal move", () => {
    // CONSOL tx: a batched/coinjoin-style internal move where TWO owned addresses
    // (MINE_A + MINE_B) are inputs and TWO different owned addresses (MINE_C +
    // MINE_D) are outputs, all in the same transaction. Inputs: A=100k, B=60k
    // (160k total spent). Outputs: C=90k, D=55k (145k total received); 15k fee.
    // Combined spent must sum BOTH owned inputs, combined received must sum BOTH
    // owned outputs, the tx counts exactly once, the per-address rows split
    // cleanly (each input addr spends only, each output addr receives only), and
    // no owned address may appear as another owned address's counterparty.
    const participants = [
      mkInput(CONSOL, MINE_A, 100_000, SRC_A, 0, 1),
      mkInput(CONSOL, MINE_B, 60_000, SRC_B, 0, 2),
      mkOutput(CONSOL, MINE_C, 90_000, 0, 3),
      mkOutput(CONSOL, MINE_D, 55_000, 1, 4),
    ];

    const result = computeAnnualActivity({
      addresses: [MINE_A, MINE_B, MINE_C, MINE_D],
      txids: [CONSOL],
      txMap: new Map([[CONSOL, mkTx(CONSOL, TIME_2024)]]),
      allTxParticipants: participantMap(participants),
      spendingTxids: new Set(),
      spentOutputAmounts: new Map(),
      outputAmountLookup: new Map(),
    });

    // Combined: one 2024 row counted exactly once, totals add ALL owned legs.
    expect(result.combinedYearRows).toHaveLength(1);
    const row = result.combinedYearRows[0];
    expect(row.year).toBe(2024);
    expect(row.spentSats).toBe(160_000); // 100k (A) + 60k (B)
    expect(row.receivedSats).toBe(145_000); // 90k (C) + 55k (D)
    expect(row.txCount).toBe(1);

    // Per-address split: inputs spend only, outputs receive only.
    const a = result.perAddress.find((p) => p.address === MINE_A)!;
    const b = result.perAddress.find((p) => p.address === MINE_B)!;
    const c = result.perAddress.find((p) => p.address === MINE_C)!;
    const d = result.perAddress.find((p) => p.address === MINE_D)!;
    expect(a.hasData).toBe(true);
    expect(b.hasData).toBe(true);
    expect(c.hasData).toBe(true);
    expect(d.hasData).toBe(true);
    expect(a.yearRows[0]).toMatchObject({
      year: 2024,
      txCount: 1,
      receivedSats: 0,
      spentSats: 100_000,
    });
    expect(b.yearRows[0]).toMatchObject({
      year: 2024,
      txCount: 1,
      receivedSats: 0,
      spentSats: 60_000,
    });
    expect(c.yearRows[0]).toMatchObject({
      year: 2024,
      txCount: 1,
      receivedSats: 90_000,
      spentSats: 0,
    });
    expect(d.yearRows[0]).toMatchObject({
      year: 2024,
      txCount: 1,
      receivedSats: 55_000,
      spentSats: 0,
    });

    // No owned address appears as any other owned address's counterparty: with
    // only owned addresses on both sides, both counterparty lists are empty.
    const sentToAddrs = result.sentTo.map((e) => e.address);
    const receivedFromAddrs = result.receivedFrom.map((e) => e.address);
    for (const owned of [MINE_A, MINE_B, MINE_C, MINE_D]) {
      expect(sentToAddrs).not.toContain(owned);
      expect(receivedFromAddrs).not.toContain(owned);
    }
    expect(result.sentTo).toHaveLength(0);
    expect(result.receivedFrom).toHaveLength(0);
  });
});

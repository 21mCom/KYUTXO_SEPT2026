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
const EXT_Y = "bc1qexternalyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy";

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

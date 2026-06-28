// @vitest-environment jsdom
//
// Step 6 backfill batching coverage for AnnualActivityReport's generate().
//
// generate() Step 6 resolves input amounts stored as 0 whose referenced prevout
// tx is OUTSIDE the main txid set. It collects those unresolved prevouts and
// paginates a second getParticipantsByTxids loop in chunks of 500:
//
//   for (let i = 0; i < prevTxids.length; i += 500)
//     getParticipantsByTxids(prevTxids.slice(i, i + 500))   // Step 6 backfill
//
// The companion large-wallet test (annual-activity-generate-batching.test.tsx)
// recovers spends via the prevout path (Step 3) using BLANK-address inputs, so
// its inputs never satisfy Step 6's `addressSet.has(p.address)` guard — the
// Step 6 loop never runs there. A batch off-by-one in Step 6 (e.g. a dropped
// final slice) would therefore stay green: a wallet with > 500 unresolved
// prevouts would silently under-count spent BTC.
//
// This test seeds > 500 PASTED-address inputs with amount=0 pointing to prevouts
// in transactions NOT in the main txid set, forcing the Step 6 loop to span
// multiple batches, and asserts:
//   (1) every Step 6 backfill batch is queried with the right prevTxid ranges
//       (the union covers ALL unresolved prevouts, including the final one);
//   (2) the amount resolved from the LAST Step 6 batch flows into the final
//       spent totals — a distinct marker amount on the very last entry proves
//       the tail survived end-to-end.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { screen, within, fireEvent, cleanup } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

const {
  N,
  LAST,
  MINE,
  EXT,
  spendTxid,
  prevTxid,
  getParticipantsByAddresses,
  getParticipantsByTxids,
  getParticipantsByPrevOutKeys,
  getTransactionsByTxids,
} = vi.hoisted(() => {
  // 1100 pasted-address spends → 1100 unresolved prevouts → 3 Step 6 backfill
  // batches (500/500/100). The spend txids themselves are 1100 txids → 3 Step 5
  // participant batches, so Step 6 batches are the LAST 3 getParticipantsByTxids
  // calls.
  const N = 1100;
  const LAST = N - 1;
  const MINE = "bc1qmine0000000000000000000000000000000000";
  const EXT = "bc1qexternalzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
  const FUND = "bc1qfundingsourceyyyyyyyyyyyyyyyyyyyyyyyyy";

  // Deterministic, unique, colon-free 64-hex txids. The prevout (funding) family
  // is offset far above the spend range so the two families never collide and
  // never share a txid with the main set.
  const spendTxid = (i: number) => i.toString(16).padStart(64, "0");
  const prevTxid = (i: number) => (i + 0x500000).toString(16).padStart(64, "0");

  const TIME_2024 = Math.floor(Date.UTC(2024, 5, 1) / 1000);
  // Marker year for the LAST entry — proves the tail (index 1099 / the 3rd Step 6
  // batch) flowed end-to-end with its own resolved amount.
  const TIME_2025 = Math.floor(Date.UTC(2025, 5, 1) / 1000);

  const BULK_SATS = 100_000_000; // 1 BTC per bulk spend
  const MARKER_SATS = 500_000_000; // 5 BTC, distinct, resolved only via last batch

  const spendInputs: any[] = []; // what the address index returns (Step 1)
  const participantsByTxid = new Map<string, any[]>();
  const txBlockTime = new Map<string, number>();

  let idSeq = 1;
  for (let i = 0; i < N; i++) {
    const spend = spendTxid(i);
    const prev = prevTxid(i);
    const isLast = i === LAST;

    // Spend input: the PASTED address (MINE) appears directly as the input, but
    // amount is unresolved (0) and the prevout lives in `prev`, a tx that is NOT
    // in the main txid set → only Step 6 can recover its amount.
    const spendInput = {
      id: idSeq++,
      txid: spend,
      role: "input" as const,
      address: MINE,
      amount: 0,
      prevTxid: prev,
      prevVout: 0,
    };
    const spendOutput = {
      id: idSeq++,
      txid: spend,
      role: "output" as const,
      vout: 0,
      address: EXT,
      amount: BULK_SATS,
    };
    // The funding tx (outside the main set): its output carries the real amount
    // that Step 6 must backfill into outputAmountLookup.
    const prevOutput = {
      id: idSeq++,
      txid: prev,
      role: "output" as const,
      vout: 0,
      address: FUND,
      amount: isLast ? MARKER_SATS : BULK_SATS,
    };

    spendInputs.push(spendInput);
    participantsByTxid.set(spend, [spendInput, spendOutput]);
    participantsByTxid.set(prev, [prevOutput]);
    txBlockTime.set(spend, isLast ? TIME_2025 : TIME_2024);
  }

  // Address index only ever sees the spend inputs (MINE as an input). It never
  // sees the funding txs, so those stay outside the main txid set.
  const getParticipantsByAddresses = vi.fn((addrs: string[]) =>
    Promise.resolve(spendInputs.filter((p) => addrs.includes(p.address))),
  );
  // Group lookups MUST filter by the requested txids — returning everything on
  // every batch would duplicate participants across batches and corrupt totals.
  const getParticipantsByTxids = vi.fn((txids: string[]) => {
    const out: any[] = [];
    for (const t of txids) {
      const list = participantsByTxid.get(t);
      if (list) out.push(...list);
    }
    return Promise.resolve(out);
  });
  // No "our outputs" exist (MINE only appears as an input), so Step 3 prevout
  // discovery never runs; this stays unused but is mocked for completeness.
  const getParticipantsByPrevOutKeys = vi.fn(() => Promise.resolve([]));
  const getTransactionsByTxids = vi.fn((txids: string[]) =>
    Promise.resolve(
      txids
        .map((t) => (txBlockTime.has(t) ? { txid: t, blockTime: txBlockTime.get(t) } : null))
        .filter(Boolean),
    ),
  );

  return {
    N,
    LAST,
    MINE,
    EXT,
    spendTxid,
    prevTxid,
    getParticipantsByAddresses,
    getParticipantsByTxids,
    getParticipantsByPrevOutKeys,
    getTransactionsByTxids,
  };
});

vi.mock("@/lib/dataFacade", () => ({
  getParticipantsByAddresses,
  getParticipantsByTxids,
}));

vi.mock("@/lib/data/transaction-crud", () => ({
  getTransactionsByTxids,
  getParticipantsByPrevOutKeys,
}));

// @tanstack/react-virtual (counterparty lists) needs ResizeObserver in jsdom.
beforeAll(() => {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const AnnualActivityReport = (await import("../AnnualActivityReport")).default;

beforeEach(() => {
  getParticipantsByAddresses.mockClear();
  getParticipantsByTxids.mockClear();
  getParticipantsByPrevOutKeys.mockClear();
  getTransactionsByTxids.mockClear();
});

afterEach(() => {
  cleanup();
});

async function generateReport() {
  renderWithProviders(<AnnualActivityReport />);
  fireEvent.change(screen.getByTestId("textarea-addresses"), {
    target: { value: MINE },
  });
  fireEvent.click(screen.getByTestId("button-generate"));
  await screen.findByTestId("table-combined");
}

function cellsOf(row: HTMLElement): string[] {
  return Array.from(row.querySelectorAll("td")).map((c) => c.textContent ?? "");
}

describe("AnnualActivityReport generate() — Step 6 prevout backfill batching", () => {
  it("queries every Step 6 backfill batch with the right prevTxid ranges (last batch not dropped)", async () => {
    await generateReport();

    // getParticipantsByTxids is called in BOTH Step 5 (spend txids) and Step 6
    // (prevout backfill). 1100 spend txids → 3 Step 5 batches; 1100 unresolved
    // prevouts → 3 Step 6 batches. Step 6 calls are the LAST three.
    expect(getParticipantsByTxids).toHaveBeenCalledTimes(6);
    const step6 = getParticipantsByTxids.mock.calls.slice(3).map((c) => c[0] as string[]);

    // 1100 prevTxids → 3 batches: 500, 500, 100.
    expect(step6[0]).toHaveLength(500);
    expect(step6[1]).toHaveLength(500);
    expect(step6[2]).toHaveLength(100);

    // Each batch starts at the right offset…
    expect(step6[0][0]).toBe(prevTxid(0));
    expect(step6[1][0]).toBe(prevTxid(500));
    expect(step6[2][0]).toBe(prevTxid(1000));
    // …and the final batch includes the very last unresolved prevout's tx.
    expect(step6[2][step6[2].length - 1]).toBe(prevTxid(LAST));

    // The union of all queried prevTxids covers every unresolved prevout exactly
    // once — no slice was skipped or double-queried.
    const allPrev = step6.flat();
    expect(allPrev).toHaveLength(N);
    expect(new Set(allPrev).size).toBe(N);
    // Every prevTxid in the union belongs to the funding family.
    const expectedPrev = new Set(Array.from({ length: N }, (_, i) => prevTxid(i)));
    expect(new Set(allPrev)).toEqual(expectedPrev);
  });

  it("flows amounts resolved from the last Step 6 batch into the final spent totals", async () => {
    await generateReport();

    const table = screen.getByTestId("table-combined");

    // Bulk year (indices 0..1098): 1099 spends of 1 BTC each, all backfilled via
    // Step 6 batches 1 & 2 (and part of batch 3).
    expect(cellsOf(within(table).getByTestId("row-year-2024"))).toEqual([
      "2024",
      "1,099",
      "0.00000000",
      "1099.00000000",
    ]);

    // Marker year — its 5 BTC spend amount lives in the funding tx prevTxid(1099),
    // which is ONLY recoverable via the LAST Step 6 backfill batch (1000..1099).
    // If that batch were dropped, resolveInputAmount would fall back to 0 and this
    // row's spent would be 0.00000000.
    expect(cellsOf(within(table).getByTestId("row-year-2025"))).toEqual([
      "2025",
      "1",
      "0.00000000",
      "5.00000000",
    ]);

    // All-Time sums every batch: 1100 spend txs, 0 received, 1099 + 5 = 1104 BTC
    // spent — the marker's 5 BTC is included, proving the tail survived.
    const allTime = within(table).getByText("All Time").closest("tr") as HTMLElement;
    expect(cellsOf(allTime)).toEqual([
      "All Time",
      "1,100",
      "0.00000000",
      "1104.00000000",
    ]);
  });
});

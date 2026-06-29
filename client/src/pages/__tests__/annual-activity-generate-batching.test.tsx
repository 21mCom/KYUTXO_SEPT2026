// @vitest-environment jsdom
//
// Large-wallet batching coverage for AnnualActivityReport's generate().
//
// generate() paginates several data-layer calls in chunks of 500:
//   Step 3: ourOutputs       → getParticipantsByPrevOutKeys (spend discovery)
//   Step 4: txids            → getTransactionsByTxids        (block times)
//   Step 5: txids            → getParticipantsByTxids        (all participants)
//
// The companion test (annual-activity-generate-assembly.test.tsx) covers a
// SMALL wallet that fits in a single batch — so a batch-boundary off-by-one or a
// missed final slice would stay green there while a large wallet silently lost
// the spends/receipts that live in the last batch.
//
// This test seeds the mocked data layer with > 500 of our outputs (and thus
// > 500 prevout keys and > 500 discovered spend txids), spanning multiple
// batches, and asserts:
//   (1) every prevout batch is queried with the right key ranges (the union
//       covers ALL outputs, including the final one), and the tx/participant
//       fetches are batched too;
//   (2) the recovered spends/receipts from the LAST batch land in the final
//       combined totals — a marker tx placed at the very end of every batched
//       collection (a distinct year) proves the tail survived end-to-end.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { screen, within, fireEvent, cleanup } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

const {
  N,
  LAST,
  MINE,
  EXT,
  recvTxid,
  spendTxid,
  getParticipantsByAddresses,
  getParticipantsByTxids,
  getParticipantsByPrevOutKeys,
  getTransactionsByTxids,
} = vi.hoisted(() => {
  // 1100 receives → 1100 outputs → 3 prevout batches (500/500/100);
  // 1100 receives + 1100 spends = 2200 txids → 5 tx/participant batches.
  const N = 1100;
  const LAST = N - 1;
  const MINE = "bc1qmine0000000000000000000000000000000000";
  const EXT = "bc1qexternalzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";

  // Deterministic, unique, colon-free 64-hex txids. Spends are offset far above
  // the receive range so the two families never collide.
  const recvTxid = (i: number) => i.toString(16).padStart(64, "0");
  const spendTxid = (i: number) => (i + 0x100000).toString(16).padStart(64, "0");

  const TIME_2023 = Math.floor(Date.UTC(2023, 5, 1) / 1000);
  const TIME_2024 = Math.floor(Date.UTC(2024, 5, 1) / 1000);
  // Marker year for the LAST entry of every batched collection — proves the tail
  // (index 1099 / the 3rd prevout batch / the 5th txid batch) flowed end-to-end.
  const TIME_2025 = Math.floor(Date.UTC(2025, 5, 1) / 1000);
  const TIME_2026 = Math.floor(Date.UTC(2026, 5, 1) / 1000);

  const recvOutputs: any[] = []; // what the address index returns (Step 1)
  const participantsByTxid = new Map<string, any[]>();
  const spendByPrevout = new Map<string, any>(); // "recvTxid:vout" → spend input
  const txBlockTime = new Map<string, number>();

  let idSeq = 1;
  for (let i = 0; i < N; i++) {
    const recv = recvTxid(i);
    const spend = spendTxid(i);
    const isLast = i === LAST;

    // Receive: external funds land in MINE (1 BTC). The address index sees only
    // this output (the spend's input is blank below).
    const recvOutput = {
      id: idSeq++,
      txid: recv,
      role: "output" as const,
      vout: 0,
      address: MINE,
      amount: 100_000_000,
    };
    // Spend: input that consumes recv:0 has a BLANK address, so it is reachable
    // ONLY through the prevout query (Step 3) — exactly the path under test.
    const spendInput = {
      id: idSeq++,
      txid: spend,
      role: "input" as const,
      address: "",
      amount: 0,
      prevTxid: recv,
      prevVout: 0,
    };
    const spendOutput = {
      id: idSeq++,
      txid: spend,
      role: "output" as const,
      vout: 0,
      address: EXT,
      amount: 100_000_000,
    };

    recvOutputs.push(recvOutput);
    participantsByTxid.set(recv, [recvOutput]);
    participantsByTxid.set(spend, [spendInput, spendOutput]);
    spendByPrevout.set(`${recv}:0`, spendInput);
    txBlockTime.set(recv, isLast ? TIME_2025 : TIME_2023);
    txBlockTime.set(spend, isLast ? TIME_2026 : TIME_2024);
  }

  // Address index only ever sees the receive outputs.
  const getParticipantsByAddresses = vi.fn((addrs: string[]) =>
    Promise.resolve(recvOutputs.filter((o) => addrs.includes(o.address))),
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
  // Prevout query: return the blank-input spend for each matching prevout key.
  const getParticipantsByPrevOutKeys = vi.fn((keys: [string, number][]) => {
    const out: any[] = [];
    for (const [txid, vout] of keys) {
      const inp = spendByPrevout.get(`${txid}:${vout}`);
      if (inp) out.push(inp);
    }
    return Promise.resolve(out);
  });
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
    recvTxid,
    spendTxid,
    getParticipantsByAddresses,
    getParticipantsByTxids,
    getParticipantsByPrevOutKeys,
    getTransactionsByTxids,
  };
});

vi.mock("@/lib/dataFacade", () => ({
  getParticipantsByAddresses,
  getParticipantsByTxids,
  getRecordsByIndexedFieldAnyOfFiltered: vi.fn(() => Promise.resolve([])),
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

describe("AnnualActivityReport generate() — large-wallet batching", () => {
  it("queries every prevout batch with the right key ranges (last batch not dropped)", async () => {
    await generateReport();

    // 1100 outputs → 3 batches: 500, 500, 100.
    expect(getParticipantsByPrevOutKeys).toHaveBeenCalledTimes(3);
    const calls = getParticipantsByPrevOutKeys.mock.calls;
    expect(calls[0][0]).toHaveLength(500);
    expect(calls[1][0]).toHaveLength(500);
    expect(calls[2][0]).toHaveLength(100);

    // Each batch starts at the right offset…
    expect(calls[0][0][0]).toEqual([recvTxid(0), 0]);
    expect(calls[1][0][0]).toEqual([recvTxid(500), 0]);
    expect(calls[2][0][0]).toEqual([recvTxid(1000), 0]);
    // …and the final batch includes the very last output's prevout key.
    const lastBatch = calls[2][0];
    expect(lastBatch[lastBatch.length - 1]).toEqual([recvTxid(LAST), 0]);

    // The union of all queried keys covers every output exactly once — no slice
    // was skipped or double-queried.
    const allKeys = calls.flatMap((c) => c[0] as [string, number][]);
    expect(allKeys).toHaveLength(N);
    expect(new Set(allKeys.map(([t]) => t)).size).toBe(N);
  });

  it("batches the tx and participant fetches and covers every txid", async () => {
    await generateReport();

    const totalTxids = 2 * N; // receives + discovered spends

    // 2200 txids → 5 batches each (500/500/500/500/200).
    expect(getTransactionsByTxids).toHaveBeenCalledTimes(5);
    // Step 5 only; the blank-input spends never satisfy the Step 6 backfill
    // (their address is not a pasted address), so no extra participant batches.
    expect(getParticipantsByTxids).toHaveBeenCalledTimes(5);

    const ptCalls = getParticipantsByTxids.mock.calls;
    const allTxids = ptCalls.flatMap((c) => c[0] as string[]);
    expect(new Set(allTxids).size).toBe(totalTxids);
    // The final spend lives in the last participant batch.
    expect(ptCalls[4][0]).toContain(spendTxid(LAST));
  });

  it("includes spends/receipts from the last batch in the combined totals", async () => {
    await generateReport();

    const table = screen.getByTestId("table-combined");

    // Bulk years (indices 0..1098): 1099 receipts in 2023, 1099 spends in 2024.
    expect(cellsOf(within(table).getByTestId("row-year-2023"))).toEqual([
      "2023",
      "1,099",
      "1099.00000000",
      "0.00000000",
    ]);
    expect(cellsOf(within(table).getByTestId("row-year-2024"))).toEqual([
      "2024",
      "1,099",
      "0.00000000",
      "1099.00000000",
    ]);

    // Marker year rows — these come ONLY from the final entry of each batched
    // collection. Their presence proves the tail survived prevout discovery,
    // tx fetch, and participant fetch.
    expect(cellsOf(within(table).getByTestId("row-year-2025"))).toEqual([
      "2025",
      "1",
      "1.00000000",
      "0.00000000",
    ]);
    expect(cellsOf(within(table).getByTestId("row-year-2026"))).toEqual([
      "2026",
      "1",
      "0.00000000",
      "1.00000000",
    ]);

    // All-Time sums every batch: 2200 txs, 1100 BTC received, 1100 BTC spent.
    const allTime = within(table).getByText("All Time").closest("tr") as HTMLElement;
    expect(cellsOf(allTime)).toEqual([
      "All Time",
      "2,200",
      "1100.00000000",
      "1100.00000000",
    ]);
  });
});

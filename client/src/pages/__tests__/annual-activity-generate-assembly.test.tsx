// @vitest-environment jsdom
//
// Integration coverage for the ORCHESTRATION inside AnnualActivityReport's
// generate() — Steps 2-6 that BUILD the inputs the pure aggregation core
// (computeAnnualActivity) consumes.
//
// computeAnnualActivity is unit-tested in annual-activity-aggregation.test.ts
// with hand-built inputs, so its math is locked in. But the fetch/assembly that
// produces those inputs — finding our outputs, querying
// getParticipantsByPrevOutKeys to discover spending txs, populating
// spendingTxids + spentOutputAmounts, and the outputAmountLookup backfill — has
// no test. If that wiring regresses (wrong prevout key format, a missed batch,
// or a getParticipantsByPrevOutKeys regression), the report would silently
// UNDER-COUNT spent BTC while the pure-core tests stay green.
//
// This test seeds the mocked data layer with a receive tx + a blank-input spend
// tx (the spend is recoverable ONLY via the prevout path), runs the real
// generate() through the rendered page, and asserts:
//   (1) getParticipantsByPrevOutKeys was queried with the right [txid, vout]
//       prevout keys derived from our outputs (proves Step 2/3 assembly), and
//   (2) the recovered spend lands in the final combined totals (proves
//       spentOutputAmounts/spendingTxids flowed correctly into ReportData).

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { screen, within, fireEvent, cleanup } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

const {
  MINE,
  EXT,
  RECV,
  SPEND,
  getParticipantsByAddresses,
  getParticipantsByTxids,
  getParticipantsByPrevOutKeys,
  getTransactionsByTxids,
} = vi.hoisted(() => {
  const MINE = "bc1qmine0000000000000000000000000000000000";
  const EXT = "bc1qexternalzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
  const RECV = "a".repeat(64); // receive tx (creates MINE's UTXO)
  const SPEND = "b".repeat(64); // later tx that spends MINE's UTXO via a blank input
  const TIME_2023 = Math.floor(Date.UTC(2023, 5, 1) / 1000);
  const TIME_2024 = Math.floor(Date.UTC(2024, 5, 1) / 1000);

  // RECV: external funds land in MINE (1 BTC). This is the only participant the
  // address index knows about.
  const RECV_OUTPUT = {
    id: 1,
    txid: RECV,
    role: "output" as const,
    vout: 0,
    address: MINE,
    amount: 100_000_000,
  };
  // SPEND: the input that spends RECV:0 has a BLANK address (never resolved), so
  // getParticipantsByAddresses misses this tx entirely. It is discoverable only
  // by querying the prevout (RECV, 0).
  const SPEND_INPUT = {
    id: 2,
    txid: SPEND,
    role: "input" as const,
    address: "",
    amount: 0,
    prevTxid: RECV,
    prevVout: 0,
  };
  const SPEND_OUTPUT = {
    id: 3,
    txid: SPEND,
    role: "output" as const,
    vout: 0,
    address: EXT,
    amount: 95_000_000,
  };

  // Address index only ever sees the receive output (the spend's input is blank).
  const getParticipantsByAddresses = vi.fn(() => Promise.resolve([RECV_OUTPUT]));
  // All participants for the supplied txids — the page groups these by txid.
  const getParticipantsByTxids = vi.fn(() =>
    Promise.resolve([RECV_OUTPUT, SPEND_INPUT, SPEND_OUTPUT]),
  );
  // The prevout query is the ONLY way to discover the blank-input spend.
  const getParticipantsByPrevOutKeys = vi.fn(() => Promise.resolve([SPEND_INPUT]));
  const getTransactionsByTxids = vi.fn((txids: string[]) =>
    Promise.resolve(
      txids
        .map((txid) =>
          txid === RECV
            ? { txid: RECV, blockTime: TIME_2023 }
            : txid === SPEND
              ? { txid: SPEND, blockTime: TIME_2024 }
              : null,
        )
        .filter(Boolean),
    ),
  );

  return {
    MINE,
    EXT,
    RECV,
    SPEND,
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

describe("AnnualActivityReport generate() — spend-recovery assembly wiring", () => {
  it("queries getParticipantsByPrevOutKeys with the [txid, vout] keys of our outputs", async () => {
    await generateReport();

    expect(getParticipantsByPrevOutKeys).toHaveBeenCalledTimes(1);
    // Step 2 collected our single output (RECV:0); Step 3 must query exactly that
    // prevout key so the spending tx can be discovered.
    expect(getParticipantsByPrevOutKeys).toHaveBeenCalledWith([[RECV, 0]]);
  });

  it("recovers the blank-input spend into the combined totals (would silently regress otherwise)", async () => {
    await generateReport();

    const table = screen.getByTestId("table-combined");

    // 2023: the 1 BTC receipt, nothing spent.
    const row2023 = within(table).getByTestId("row-year-2023");
    expect(cellsOf(row2023)).toEqual(["2023", "1", "1.00000000", "0.00000000"]);

    // 2024: the spend is reachable ONLY through the prevout recovery path. If the
    // assembly broke, spent here would silently fall back to 0.00000000.
    const row2024 = within(table).getByTestId("row-year-2024");
    expect(cellsOf(row2024)).toEqual(["2024", "1", "0.00000000", "1.00000000"]);

    // All-Time totals sum both years (2 txs, 1 BTC received, 1 BTC spent).
    const allTime = within(table).getByText("All Time").closest("tr") as HTMLElement;
    expect(cellsOf(allTime)).toEqual(["All Time", "2", "1.00000000", "1.00000000"]);
  });

  it("flags the recovered spend's blank input as an unresolved sent-to source", async () => {
    await generateReport();

    // The spend's only input was blank, so its source could not be resolved —
    // the page surfaces this as an "unresolved" note in the Sent To list (only
    // the sent-to side has an unresolved count here). Its presence confirms
    // spendingTxids carried the recovered tx through to the counterparty
    // assembly (it would be absent if the wiring regressed).
    const note = await screen.findByText(/could not be resolved to an address/i);
    expect(note.textContent).toMatch(/^1 transaction\b/);
  });
});

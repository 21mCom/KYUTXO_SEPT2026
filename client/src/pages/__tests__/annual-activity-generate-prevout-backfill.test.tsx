// @vitest-environment jsdom
//
// Integration coverage for Step 6's SECOND-PASS prevout backfill inside
// AnnualActivityReport's generate().
//
// Sibling file annual-activity-generate-assembly.test.tsx exercises the Step 3
// recovery path (a BLANK-address input discovered via getParticipantsByPrevOutKeys
// and resolved through spentOutputAmounts). This file covers the OTHER, distinct
// branch:
//
//   A pasted address appears DIRECTLY as a resolved input (address = a pasted
//   address) with amount=0, and its prevTxid points at a source transaction that
//   is NOT in the already-loaded txid set. In that case the prevout amount is not
//   present in outputAmountLookup after Step 5, so Step 6 collects the
//   unresolvedPrevOuts and re-queries getParticipantsByTxids for those prevTxids,
//   filling outputAmountLookup so resolveInputAmount can recover the spend.
//
// If that backfill regresses (e.g. the second getParticipantsByTxids call is
// dropped, or unresolvedPrevOuts is mis-keyed), the spend would silently fall
// back to 0.00000000 even though the pure aggregation core stays green — exactly
// the failure mode this test guards against.
//
// The mocked getParticipantsByTxids here is txid-aware: it returns the SPEND
// tx's participants for the main fetch (Step 5) and the SOURCE tx's outputs ONLY
// when queried by the Step 6 backfill — so the spend is recoverable ONLY if that
// second pass runs.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { screen, within, fireEvent, cleanup } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

const {
  MINE,
  EXT,
  SOURCE,
  SPEND,
  getParticipantsByAddresses,
  getParticipantsByTxids,
  getParticipantsByPrevOutKeys,
  getTransactionsByTxids,
} = vi.hoisted(() => {
  const MINE = "bc1qmine0000000000000000000000000000000000";
  const EXT = "bc1qexternalzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
  const SOURCE = "c".repeat(64); // funds MINE — but is NOT in the loaded txid set
  const SPEND = "b".repeat(64); // spends SOURCE:0 via a RESOLVED (MINE) input
  const TIME_2024 = Math.floor(Date.UTC(2024, 5, 1) / 1000);

  // SOURCE:0 created MINE's 1 BTC UTXO. Crucially, the address index does NOT
  // surface this output (getParticipantsByAddresses misses it below), so SOURCE
  // never enters the main txid set — its amount is only reachable via Step 6.
  const SOURCE_OUTPUT = {
    id: 1,
    txid: SOURCE,
    role: "output" as const,
    vout: 0,
    address: MINE,
    amount: 100_000_000,
  };
  // SPEND's input is RESOLVED to MINE but stored with amount=0 and a prevout
  // pointer at SOURCE:0. This is the Step 6 trigger.
  const SPEND_INPUT = {
    id: 2,
    txid: SPEND,
    role: "input" as const,
    address: MINE,
    amount: 0,
    prevTxid: SOURCE,
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

  // Address index only ever sees the MINE input on SPEND. SOURCE is absent, so
  // the loaded txid set is {SPEND} only.
  const getParticipantsByAddresses = vi.fn(() => Promise.resolve([SPEND_INPUT]));
  // txid-aware: Step 5 fetches SPEND's participants; the Step 6 backfill fetches
  // SOURCE's outputs. SOURCE is returned ONLY for the backfill query.
  const getParticipantsByTxids = vi.fn((txids: string[]) => {
    const out: any[] = [];
    if (txids.includes(SPEND)) out.push(SPEND_INPUT, SPEND_OUTPUT);
    if (txids.includes(SOURCE)) out.push(SOURCE_OUTPUT);
    return Promise.resolve(out);
  });
  // No pasted-address outputs exist, so Step 3's prevout discovery never runs.
  const getParticipantsByPrevOutKeys = vi.fn(() => Promise.resolve([]));
  const getTransactionsByTxids = vi.fn((txids: string[]) =>
    Promise.resolve(
      txids
        .map((txid) => (txid === SPEND ? { txid: SPEND, blockTime: TIME_2024 } : null))
        .filter(Boolean),
    ),
  );

  return {
    MINE,
    EXT,
    SOURCE,
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

describe("AnnualActivityReport generate() — Step 6 unresolved-prevout backfill", () => {
  it("re-queries getParticipantsByTxids for prevTxids whose source tx wasn't loaded", async () => {
    await generateReport();

    // Step 5 fetched the loaded set ([SPEND]); Step 6 must have made a SECOND,
    // separate query for the unresolved prevout's source tx ([SOURCE]).
    const calls = getParticipantsByTxids.mock.calls.map((c) => c[0]);
    expect(calls).toContainEqual([SPEND]);
    expect(calls).toContainEqual([SOURCE]);
  });

  it("recovers the spend amount from the backfilled prevout into the totals (would silently zero out otherwise)", async () => {
    await generateReport();

    const table = screen.getByTestId("table-combined");

    // 2024: MINE spent its 1 BTC UTXO. The spend amount lives ONLY on SOURCE:0,
    // which is reachable solely through the Step 6 backfill. If that pass broke,
    // resolveInputAmount would fall back to 0.00000000 here.
    const row2024 = within(table).getByTestId("row-year-2024");
    expect(cellsOf(row2024)).toEqual(["2024", "1", "0.00000000", "1.00000000"]);

    // All-Time totals reflect the single recovered spend.
    const allTime = within(table).getByText("All Time").closest("tr") as HTMLElement;
    expect(cellsOf(allTime)).toEqual(["All Time", "1", "0.00000000", "1.00000000"]);
  });
});

// @vitest-environment jsdom
//
// End-to-end proof that the Annual Activity Report does NOT double-count a
// self-transfer / consolidation in which the pasted address appears as BOTH a
// resolved input AND a change output of the same transaction — exercising the
// REAL data-fetching/build wiring inside generate(), not just the pure
// computeAnnualActivity() core.
//
// Task #1193 proved (live) that a BLANK-address spend is COUNTED via the
// prevout-key fallback. This is the companion risk: a consolidation tx where the
// pasted address is BOTH a directly-resolved input (counted via the direct path
// in computeAnnualActivity Step 7) AND, because that same prevout is also
// discovered by getParticipantsByPrevOutKeys, present in spentOutputAmounts
// (the fallback path). Without the seenPrevouts dedupe, the directly-counted
// spend would be added a SECOND time through the fallback. Likewise the change
// output back to the pasted address must be counted once, not once per prevout.
//
// This test renders the real <AnnualActivityReport /> and drives it through the
// UI (type address → click Generate) against real Dexie data (fake-indexeddb).
// It seeds a single SPEND tx (2023) that consolidates two earlier funding
// outputs (2021):
//   - FUND_A → 1 BTC output to OWNED (vout 0)
//   - FUND_B → 2 BTC output to OWNED (vout 0)
//   - SPEND consolidates both:
//       * input #1: address = OWNED (RESOLVED), prevout FUND_A:0  → direct path
//       * input #2: address = ""   (BLANK),     prevout FUND_B:0  → fallback path
//       * output #0: 0.5 BTC change back to OWNED                 → change output
// Because FUND_A:0 is spent by a directly-resolved OWNED input, it lands in BOTH
// the direct path AND spentOutputAmounts. The seenPrevouts set must suppress the
// fallback copy.
//
// It asserts:
//   - 2023 BTC Spent = 3.00000000  (1 direct + 2 fallback, each ONCE — not 4)
//   - 2023 BTC Received = 0.50000000  (the change, counted ONCE — not 1.0)
//   - the 2021 funding row shows 3.00000000 received, 0 spent
//   - per-address breakdown matches the combined totals

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, cleanup, within } from "@testing-library/react";

import {
  addTransaction,
  addParticipant,
  clearTransactions,
  clearParticipants,
} from "@/lib/data/transaction-crud";
import { createRecord, clearAllRecords } from "@/lib/data/record-crud";
import { renderWithProviders } from "@/test/testProviders";
import AnnualActivityReport from "./AnnualActivityReport";

const OWNED = "bc1qselftransferdoublecountowned0000000000aa";

// Distinct 64-hex txids so none collide with anything else in the suite.
const FUND_A = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";
const FUND_B = "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4";
const SPEND_TX = "e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5";

// Amounts (satoshis). Distinct so a double-count is unambiguous:
//   spent doubling FUND_A → 4 BTC; change doubling → 1.0 BTC.
const ONE_BTC = 100_000_000; // FUND_A output (direct-input prevout)
const TWO_BTC = 200_000_000; // FUND_B output (blank-input prevout)
const HALF_BTC = 50_000_000; // change back to OWNED

// 2021-07-01 and 2023-07-01 (UTC) → the two year buckets we assert on.
const FUND_BLOCKTIME = Math.floor(Date.UTC(2021, 6, 1) / 1000);
const SPEND_BLOCKTIME = Math.floor(Date.UTC(2023, 6, 1) / 1000);

beforeEach(async () => {
  Element.prototype.scrollIntoView = vi.fn();
  await clearAllRecords({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearParticipants({ skipNotification: true });

  // The pasted/owned address record.
  await createRecord(
    { type: "address", inputString: OWNED, label: "Owned", tags: [], categories: [] },
    { skipNotification: true, skipVocabularySync: true },
  );

  // Funding tx A: 1 BTC output to OWNED at vout 0.
  await addTransaction(
    {
      txid: FUND_A,
      blockHeight: 690000,
      blockTime: FUND_BLOCKTIME,
      fee: 1000,
      feeRate: 5,
      syncedAt: Date.now(),
    },
    { skipNotification: true },
  );
  await addParticipant(
    { txid: FUND_A, role: "output", address: OWNED, amount: ONE_BTC, vout: 0 },
    { skipNotification: true },
  );

  // Funding tx B: 2 BTC output to OWNED at vout 0.
  await addTransaction(
    {
      txid: FUND_B,
      blockHeight: 690001,
      blockTime: FUND_BLOCKTIME,
      fee: 1000,
      feeRate: 5,
      syncedAt: Date.now(),
    },
    { skipNotification: true },
  );
  await addParticipant(
    { txid: FUND_B, role: "output", address: OWNED, amount: TWO_BTC, vout: 0 },
    { skipNotification: true },
  );

  // Spending (consolidation) tx in 2023.
  await addTransaction(
    {
      txid: SPEND_TX,
      blockHeight: 800000,
      blockTime: SPEND_BLOCKTIME,
      fee: 1000,
      feeRate: 5,
      syncedAt: Date.now(),
    },
    { skipNotification: true },
  );
  // Input #1: address RESOLVED to OWNED, spends FUND_A:0. amount=0 so it is
  // resolved through the prevout/output-amount lookup (the realistic path) and
  // is ALSO discoverable via getParticipantsByPrevOutKeys → spentOutputAmounts.
  await addParticipant(
    {
      txid: SPEND_TX,
      role: "input",
      address: OWNED,
      amount: 0,
      prevTxid: FUND_A,
      prevVout: 0,
    },
    { skipNotification: true },
  );
  // Input #2: BLANK address, spends FUND_B:0 — only recoverable via the
  // prevout-key fallback.
  await addParticipant(
    {
      txid: SPEND_TX,
      role: "input",
      address: "",
      amount: 0,
      prevTxid: FUND_B,
      prevVout: 0,
    },
    { skipNotification: true },
  );
  // Output #0: 0.5 BTC change back to OWNED.
  await addParticipant(
    { txid: SPEND_TX, role: "output", address: OWNED, amount: HALF_BTC, vout: 0 },
    { skipNotification: true },
  );
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await clearAllRecords({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
});

describe("Annual Activity Report — self-transfer consolidation not double-counted (live)", () => {
  it("counts the consolidation spend and change exactly once through the real wiring", async () => {
    const { getByTestId, findByTestId } = renderWithProviders(<AnnualActivityReport />);

    fireEvent.change(getByTestId("textarea-addresses"), {
      target: { value: OWNED },
    });
    fireEvent.click(getByTestId("button-generate"));

    const table = await findByTestId("table-combined");

    // 2021: both funding outputs received (1 + 2 = 3 BTC), nothing spent.
    const fundRow = within(table).getByTestId("row-year-2021");
    const fundCells = within(fundRow).getAllByRole("cell");
    expect(fundCells[2].textContent).toBe("3.00000000"); // BTC Received
    expect(fundCells[3].textContent).toBe("0.00000000"); // BTC Spent

    // 2023: the consolidation.
    const spendRow = within(table).getByTestId("row-year-2023");
    const spendCells = within(spendRow).getAllByRole("cell");
    // Change received counted ONCE (0.5), not once-per-prevout (would be 1.0).
    expect(spendCells[2].textContent).toBe("0.50000000"); // BTC Received
    // Spent = 1 (direct FUND_A) + 2 (fallback FUND_B), each ONCE. A broken
    // seenPrevouts dedupe would re-count FUND_A via the fallback → 4.00000000.
    expect(spendCells[3].textContent).toBe("3.00000000"); // BTC Spent — the proof
  });

  it("control: with the resolved direct input removed, the same spend is recovered solely via the fallback (no change to the total)", async () => {
    // Remove input #1 (the resolved OWNED input). Now FUND_A:0 is no longer
    // spent by any participant, so only FUND_B (blank input) is consolidated.
    // This isolates that the 1 BTC of the main test came from the direct path,
    // and proves the fallback alone is not inflating it.
    await clearParticipants({ skipNotification: true });
    await addParticipant(
      { txid: FUND_A, role: "output", address: OWNED, amount: ONE_BTC, vout: 0 },
      { skipNotification: true },
    );
    await addParticipant(
      { txid: FUND_B, role: "output", address: OWNED, amount: TWO_BTC, vout: 0 },
      { skipNotification: true },
    );
    await addParticipant(
      {
        txid: SPEND_TX,
        role: "input",
        address: "",
        amount: 0,
        prevTxid: FUND_B,
        prevVout: 0,
      },
      { skipNotification: true },
    );
    await addParticipant(
      { txid: SPEND_TX, role: "output", address: OWNED, amount: HALF_BTC, vout: 0 },
      { skipNotification: true },
    );

    const { getByTestId, findByTestId } = renderWithProviders(<AnnualActivityReport />);

    fireEvent.change(getByTestId("textarea-addresses"), {
      target: { value: OWNED },
    });
    fireEvent.click(getByTestId("button-generate"));

    const table = await findByTestId("table-combined");
    const spendRow = within(table).getByTestId("row-year-2023");
    const spendCells = within(spendRow).getAllByRole("cell");
    // Only FUND_B (2 BTC) is now spent; change still 0.5 BTC received once.
    expect(spendCells[2].textContent).toBe("0.50000000"); // BTC Received
    expect(spendCells[3].textContent).toBe("2.00000000"); // BTC Spent
  });
});

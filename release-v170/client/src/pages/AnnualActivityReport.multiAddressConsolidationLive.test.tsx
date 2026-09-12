// @vitest-environment jsdom
//
// End-to-end proof that the Annual Activity Report's PER-ADDRESS BREAKDOWN
// correctly attributes a multi-address consolidation to the right owner —
// exercising the REAL data-fetching/build wiring inside generate(), not just
// the pure computeAnnualActivity() core.
//
// The companion single-address test
// (AnnualActivityReport.selfTransferDoubleCountLive.test.tsx) only pastes ONE
// owned address, so the Per-Address Breakdown card never renders (it is gated
// on reportData.perAddress.length > 1). That left per-address attribution of a
// consolidation untested end-to-end: when TWO pasted addresses each contribute
// an input AND a change output to the SAME transaction, each address's row must
// show only its OWN spend + change, while the combined table sums them once. A
// regression in computeAnnualActivity's perAddrSpent/perAddrReceived maps could
// mis-attribute amounts (e.g. credit B's spend to A) while the COMBINED total
// stays correct — invisible to the single-address test.
//
// This test renders the real <AnnualActivityReport /> and drives it through the
// UI (type two addresses → click Generate) against real Dexie data
// (fake-indexeddb). It seeds a single 2023 consolidation tx that spends a
// 2021 funding output from EACH owned address and returns change to EACH:
//   - FUND_A → 1 BTC output to OWNED_A (vout 0)
//   - FUND_B → 2 BTC output to OWNED_B (vout 0)
//   - SPEND consolidates both:
//       * input #0: address = OWNED_A (RESOLVED), prevout FUND_A:0
//       * input #1: address = OWNED_B (RESOLVED), prevout FUND_B:0
//       * output #0: 0.3 BTC change back to OWNED_A
//       * output #1: 0.4 BTC change back to OWNED_B
//
// Distinct amounts per address make a mis-attribution unambiguous: if A's row
// showed B's spend (or vice versa) the assertions below would fail even though
// the combined 3.0 spent / 0.7 received total would still look correct.
//
// It asserts:
//   - per-address OWNED_A 2023: Spent 1.0, Received 0.3 (only its own)
//   - per-address OWNED_B 2023: Spent 2.0, Received 0.4 (only its own)
//   - combined 2023: Spent 3.0, Received 0.7 (the sum, counted ONCE)
//   - per-address + combined 2021 funding rows match (A 1.0, B 2.0, combined 3.0)

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

// Two distinct owned addresses (first 8 chars differ so any id-slice testids
// never collide).
const OWNED_A = "bc1qmultiaddrconsolidationowneraaaa00000001";
const OWNED_B = "bc1qzmultiaddrconsolidationownerbbbb0000002";

// Distinct 64-hex txids so none collide with anything else in the suite.
const FUND_A = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const FUND_B = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
const SPEND_TX = "f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6";

// Amounts (satoshis). Distinct per address so a cross-attribution is obvious.
const ONE_BTC = 100_000_000; // FUND_A → OWNED_A
const TWO_BTC = 200_000_000; // FUND_B → OWNED_B
const CHANGE_A = 30_000_000; // 0.3 BTC change to OWNED_A
const CHANGE_B = 40_000_000; // 0.4 BTC change to OWNED_B

// 2021-07-01 and 2023-07-01 (UTC) → the two year buckets we assert on.
const FUND_BLOCKTIME = Math.floor(Date.UTC(2021, 6, 1) / 1000);
const SPEND_BLOCKTIME = Math.floor(Date.UTC(2023, 6, 1) / 1000);

beforeEach(async () => {
  Element.prototype.scrollIntoView = vi.fn();
  await clearAllRecords({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearParticipants({ skipNotification: true });

  // The two pasted/owned address records.
  await createRecord(
    { type: "address", inputString: OWNED_A, label: "Owned A", tags: [], categories: [] },
    { skipNotification: true, skipVocabularySync: true },
  );
  await createRecord(
    { type: "address", inputString: OWNED_B, label: "Owned B", tags: [], categories: [] },
    { skipNotification: true, skipVocabularySync: true },
  );

  // Funding tx A: 1 BTC output to OWNED_A at vout 0.
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
    { txid: FUND_A, role: "output", address: OWNED_A, amount: ONE_BTC, vout: 0 },
    { skipNotification: true },
  );

  // Funding tx B: 2 BTC output to OWNED_B at vout 0.
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
    { txid: FUND_B, role: "output", address: OWNED_B, amount: TWO_BTC, vout: 0 },
    { skipNotification: true },
  );

  // Spending (consolidation) tx in 2023: BOTH addresses are an input AND get
  // change back.
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
  // Input #0: OWNED_A spends FUND_A:0 (amount=0 → resolved via prevout lookup).
  await addParticipant(
    {
      txid: SPEND_TX,
      role: "input",
      address: OWNED_A,
      amount: 0,
      prevTxid: FUND_A,
      prevVout: 0,
    },
    { skipNotification: true },
  );
  // Input #1: OWNED_B spends FUND_B:0.
  await addParticipant(
    {
      txid: SPEND_TX,
      role: "input",
      address: OWNED_B,
      amount: 0,
      prevTxid: FUND_B,
      prevVout: 0,
    },
    { skipNotification: true },
  );
  // Output #0: 0.3 BTC change back to OWNED_A.
  await addParticipant(
    { txid: SPEND_TX, role: "output", address: OWNED_A, amount: CHANGE_A, vout: 0 },
    { skipNotification: true },
  );
  // Output #1: 0.4 BTC change back to OWNED_B.
  await addParticipant(
    { txid: SPEND_TX, role: "output", address: OWNED_B, amount: CHANGE_B, vout: 1 },
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

describe("Annual Activity Report — multi-address consolidation attributes spend/change to the right owner (live)", () => {
  it("splits each address's own spend + change in the per-address breakdown while the combined table sums once", async () => {
    const { getByTestId, findByTestId } = renderWithProviders(<AnnualActivityReport />);

    // Add BOTH owned addresses so the Per-Address Breakdown card renders
    // (gated on perAddress.length > 1).
    const addressInput = getByTestId("input-annual-activity-addresses");
    fireEvent.change(addressInput, { target: { value: OWNED_A } });
    fireEvent.keyDown(addressInput, { key: "Enter" });
    fireEvent.change(addressInput, { target: { value: OWNED_B } });
    fireEvent.keyDown(addressInput, { key: "Enter" });
    fireEvent.click(getByTestId("button-generate"));

    // ── Combined table: the sum, each amount counted ONCE ──────────────────
    const combined = await findByTestId("table-combined");

    const combinedFund = within(combined).getByTestId("row-year-2021");
    const combinedFundCells = within(combinedFund).getAllByRole("cell");
    expect(combinedFundCells[2].textContent).toBe("3.00000000"); // 1 + 2 received
    expect(combinedFundCells[3].textContent).toBe("0.00000000"); // nothing spent

    const combinedSpend = within(combined).getByTestId("row-year-2023");
    const combinedSpendCells = within(combinedSpend).getAllByRole("cell");
    expect(combinedSpendCells[2].textContent).toBe("0.70000000"); // 0.3 + 0.4 change
    expect(combinedSpendCells[3].textContent).toBe("3.00000000"); // 1 + 2 spent

    // ── Per-address breakdown: expand both rows ────────────────────────────
    fireEvent.click(getByTestId(`button-toggle-address-${OWNED_A}`));
    fireEvent.click(getByTestId(`button-toggle-address-${OWNED_B}`));

    // OWNED_A shows ONLY its own amounts (1 BTC spent, 0.3 BTC change).
    const tableA = await findByTestId(`table-address-${OWNED_A}`);
    const aFundCells = within(within(tableA).getByTestId("row-year-2021")).getAllByRole("cell");
    expect(aFundCells[2].textContent).toBe("1.00000000"); // received
    expect(aFundCells[3].textContent).toBe("0.00000000"); // spent
    const aSpendCells = within(within(tableA).getByTestId("row-year-2023")).getAllByRole("cell");
    expect(aSpendCells[2].textContent).toBe("0.30000000"); // change to A only
    expect(aSpendCells[3].textContent).toBe("1.00000000"); // A's spend only

    // OWNED_B shows ONLY its own amounts (2 BTC spent, 0.4 BTC change).
    const tableB = await findByTestId(`table-address-${OWNED_B}`);
    const bFundCells = within(within(tableB).getByTestId("row-year-2021")).getAllByRole("cell");
    expect(bFundCells[2].textContent).toBe("2.00000000"); // received
    expect(bFundCells[3].textContent).toBe("0.00000000"); // spent
    const bSpendCells = within(within(tableB).getByTestId("row-year-2023")).getAllByRole("cell");
    expect(bSpendCells[2].textContent).toBe("0.40000000"); // change to B only
    expect(bSpendCells[3].textContent).toBe("2.00000000"); // B's spend only
  });
});

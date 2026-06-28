// @vitest-environment jsdom
//
// End-to-end proof that the Annual Activity Report counts a spend whose input
// amount is stored as 0 and whose prevout points at a FUNDING tx that is NOT
// reachable from the pasted address's own participant rows — exercising the
// REAL Step 6 "unresolvedPrevOuts -> getParticipantsByTxids" recovery wiring
// inside generate(), not just the pure aggregation core.
//
// The sibling test (AnnualActivityReport.blankAddressSpendLive.test.tsx, #1193)
// seeds the funding output in the SAME pasted address's participant set, so it
// exercises the Step 3 spentOutputAmounts fallback — but the funding output is
// already in the loaded participant set, so outputAmountLookup resolves it
// WITHOUT the separate getParticipantsByTxids(prevTxids) fetch. That leaves the
// second recovery path untested.
//
// generate()'s Step 6 handles a different shape:
//   - an input whose address IS a pasted/tracked address (so it's found via the
//     address index and its spending tx lands in the txid set)
//   - but whose amount is 0, and whose prevTxid points at a funding output that
//     belongs to a DIFFERENT tracked context (a separate address the report is
//     not run against). Because the pasted address never appears in that funding
//     tx, the funding tx never enters the txid set, so its output amount is NOT
//     in outputAmountLookup after Steps 4-6's local build.
//   - generate() must then collect that prevout into `unresolvedPrevOuts` and
//     fetch it via getParticipantsByTxids(prevTxids) to recover the amount.
// A regression in that fetch/build layer would silently understate BTC spent
// whenever the source tx was discovered via a different address, while every
// computeAnnualActivity unit test stayed green.
//
// This test renders the real <AnnualActivityReport /> and drives it through the
// UI (type address → click Generate) against real Dexie data (fake-indexeddb).
// It seeds:
//   - one pasted/owned address record (OWNED)
//   - one separate tracked address record (OTHER) — a "different context"
//   - a FUNDING tx (2021) with a 1 BTC output that belongs to OTHER (vout 0).
//     OWNED never appears in this tx, so the pasted-address index can't reach it.
//   - a SPENDING tx (2023) with a single INPUT whose address is OWNED (resolved)
//     but whose amount is 0 and whose prevTxid/prevVout point at the OTHER
//     funding output.
// and asserts:
//   - the 2023 row shows BTC Spent = 1.00000000 (recovered via the Step 6
//     prevTxid lookup, not understated to 0)
//   - removing the funding-output prevout row understates the spend to 0
//     (control), proving the 1 BTC came specifically from that fetch.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, cleanup, within, waitFor } from "@testing-library/react";

import {
  addTransaction,
  addParticipant,
  clearTransactions,
  clearParticipants,
} from "@/lib/data/transaction-crud";
import { createRecord, clearAllRecords } from "@/lib/data/record-crud";
import { renderWithProviders } from "@/test/testProviders";
import AnnualActivityReport from "./AnnualActivityReport";

// Pasted/owned address the report is generated for.
const OWNED = "bc1qunresolvedprevoutowned000000000000000aa";
// A different tracked address that owns the funding output. The report is NOT
// run against this address, so OWNED's address-index scan never reaches FUND_TX.
const OTHER = "bc1qunresolvedprevoutother000000000000000bb";

// Distinct 64-hex txids so neither collides with anything else in the suite.
const FUND_TX = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";
const SPEND_TX = "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4";

// 1 BTC, in satoshis.
const ONE_BTC = 100_000_000;

// 2021-07-01 and 2023-07-01 (UTC) → the year buckets we assert on.
const FUND_BLOCKTIME = Math.floor(Date.UTC(2021, 6, 1) / 1000);
const SPEND_BLOCKTIME = Math.floor(Date.UTC(2023, 6, 1) / 1000);

beforeEach(async () => {
  Element.prototype.scrollIntoView = vi.fn();
  await clearAllRecords({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearParticipants({ skipNotification: true });

  // The pasted/owned address record (the report subject).
  await createRecord(
    { type: "address", inputString: OWNED, label: "Owned", tags: [], categories: [] },
    { skipNotification: true, skipVocabularySync: true },
  );
  // A separate tracked address (a different context). It owns the funding output
  // but is NOT pasted into the report.
  await createRecord(
    { type: "address", inputString: OTHER, label: "Other context", tags: [], categories: [] },
    { skipNotification: true, skipVocabularySync: true },
  );

  // Funding tx: creates a 1 BTC output that belongs to OTHER at vout 0. OWNED
  // does NOT participate, so getParticipantsByAddresses([OWNED]) can never see
  // this tx — it stays out of the txid set, and its output amount stays out of
  // outputAmountLookup until the Step 6 prevTxid lookup fetches it.
  await addTransaction(
    {
      txid: FUND_TX,
      blockHeight: 690000,
      blockTime: FUND_BLOCKTIME,
      fee: 1000,
      feeRate: 5,
      syncedAt: Date.now(),
    },
    { skipNotification: true },
  );
  await addParticipant(
    { txid: FUND_TX, role: "output", address: OTHER, amount: ONE_BTC, vout: 0 },
    { skipNotification: true },
  );

  // Spending tx: its only input has a RESOLVED address (OWNED) so it is found
  // via the address index and lands in the txid set. But its amount is 0 and it
  // references the OTHER funding output via prevTxid/prevVout. Only the Step 6
  // getParticipantsByTxids([FUND_TX]) lookup can recover the 1 BTC spent.
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
  await addParticipant(
    {
      txid: SPEND_TX,
      role: "input",
      address: OWNED,
      amount: 0,
      prevTxid: FUND_TX,
      prevVout: 0,
    },
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

describe("Annual Activity Report — unresolved prevout spend recovered live", () => {
  it("counts the amount=0 spend via the Step 6 getParticipantsByTxids fallback", async () => {
    const { getByTestId, findByTestId } = renderWithProviders(<AnnualActivityReport />);

    fireEvent.change(getByTestId("textarea-addresses"), {
      target: { value: OWNED },
    });
    fireEvent.click(getByTestId("button-generate"));

    // The combined table appears once generate() resolves against Dexie.
    const table = await findByTestId("table-combined");

    // 2023: the spend MUST be counted (1 BTC). Its amount was stored as 0 and
    // could only be recovered by fetching the OTHER funding output via the
    // Step 6 prevTxid lookup.
    const spendRow = within(table).getByTestId("row-year-2023");
    const spendCells = within(spendRow).getAllByRole("cell");
    expect(spendCells[2].textContent).toBe("0.00000000"); // BTC Received
    expect(spendCells[3].textContent).toBe("1.00000000"); // BTC Spent — the proof

    // All-Time totals row present and reflects the recovered spend.
    expect(table.textContent).toContain("All Time");
  });

  it("understates the spend to zero when the funding-output prevout is unfetchable (control)", async () => {
    // Control: drop the funding output so getParticipantsByTxids([FUND_TX])
    // returns nothing. The amount=0 input can no longer be resolved, so the
    // 2023 spend collapses to 0 — proving the 1 BTC in the main test came
    // specifically from the Step 6 prevTxid fetch.
    await clearParticipants({ skipNotification: true });
    await addParticipant(
      {
        txid: SPEND_TX,
        role: "input",
        address: OWNED,
        amount: 0,
        prevTxid: FUND_TX,
        prevVout: 0,
      },
      { skipNotification: true },
    );

    const { container, getByTestId, queryByTestId } = renderWithProviders(
      <AnnualActivityReport />,
    );

    fireEvent.change(getByTestId("textarea-addresses"), {
      target: { value: OWNED },
    });
    fireEvent.click(getByTestId("button-generate"));

    // With the funding output unfetchable, the only spend resolves to 0, so the
    // 2023 bucket is dropped entirely and the combined table never renders —
    // the empty-state message shows instead.
    await waitFor(() => {
      expect(container.textContent).toContain(
        "No synced transaction data for any of the provided addresses",
      );
    });
    expect(queryByTestId("table-combined")).toBeNull();
  });
});

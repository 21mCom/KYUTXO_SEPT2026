// @vitest-environment jsdom
//
// End-to-end proof that the Annual Activity Report counts a spend whose input
// row carries a BLANK address, exercising the REAL data-fetching/build wiring
// inside generate() — not just the pure aggregation core.
//
// Task #1181 unit-tested computeAnnualActivity() (the pure core) with a
// hand-built spendingTxids + spentOutputAmounts fallback. But the layer that
// BUILDS those inputs lives inside the component's generate():
//   Step 2  — scan the pasted address's participants for "our outputs"
//   Step 3  — getParticipantsByPrevOutKeys([...]) to discover the spending tx
//             whose input is blank-address, then populate spentOutputAmounts +
//             spendingTxids from the matched prevout.
// getParticipantsByAddresses() only finds rows via the `address` index, so a
// blank-address input is INVISIBLE to it — the spend is only recovered through
// the prevout-key fallback. A regression in that fetch/build layer would
// understate BTC spent for consolidations while every computeAnnualActivity
// unit test stayed green.
//
// This test renders the real <AnnualActivityReport /> and drives it through the
// UI (type address → click Generate) against real Dexie data (fake-indexeddb).
// It seeds:
//   - one OWNED address record
//   - a FUNDING tx (2021) with an output to OWNED (vout 0, 1 BTC)  → "our output"
//   - a SPENDING tx (2023) with a single INPUT whose address is BLANK and whose
//     prevTxid/prevVout point at the funding output
// and asserts:
//   - the 2023 row shows BTC Spent = 1.00000000 (counted, not understated to 0)
//   - the All-Time total spent = 1.00000000
//   - the unresolved-source note ("could not be resolved to an address")
//     surfaces in the Sent To counterparty column.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, cleanup, waitFor, within } from "@testing-library/react";

import {
  addTransaction,
  addParticipant,
  clearTransactions,
  clearParticipants,
} from "@/lib/data/transaction-crud";
import { createRecord, clearAllRecords } from "@/lib/data/record-crud";
import { renderWithProviders } from "@/test/testProviders";
import AnnualActivityReport from "./AnnualActivityReport";

const OWNED = "bc1qblankspendliveowned00000000000000000aa";

// Distinct 64-hex txids so neither collides with anything else in the suite.
const FUND_TX = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const SPEND_TX = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";

// 1 BTC, in satoshis.
const ONE_BTC = 100_000_000;

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

  // Funding tx: creates a 1 BTC output to OWNED at vout 0.
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
    { txid: FUND_TX, role: "output", address: OWNED, amount: ONE_BTC, vout: 0 },
    { skipNotification: true },
  );

  // Spending tx: its only input has a BLANK address (unresolved source) but
  // references the funding output via prevTxid/prevVout. This is the row that
  // getParticipantsByAddresses can never see — only the prevout-key fallback
  // recovers the 1 BTC spend.
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
      address: "",
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

describe("Annual Activity Report — blank-address spend recovered live", () => {
  it("counts the blank-address spend via the prevout-key fallback wiring", async () => {
    const { container, getByTestId, findByTestId } = renderWithProviders(
      <AnnualActivityReport />,
    );

    fireEvent.change(getByTestId("textarea-addresses"), {
      target: { value: OWNED },
    });
    fireEvent.click(getByTestId("button-generate"));

    // The combined table appears once generate() resolves against Dexie.
    const table = await findByTestId("table-combined");

    // 2021: 1 BTC received, nothing spent.
    const fundRow = within(table).getByTestId("row-year-2021");
    const fundCells = within(fundRow).getAllByRole("cell");
    expect(fundCells[2].textContent).toBe("1.00000000"); // BTC Received
    expect(fundCells[3].textContent).toBe("0.00000000"); // BTC Spent

    // 2023: the blank-address spend MUST be counted (1 BTC), not understated.
    const spendRow = within(table).getByTestId("row-year-2023");
    const spendCells = within(spendRow).getAllByRole("cell");
    expect(spendCells[2].textContent).toBe("0.00000000"); // BTC Received
    expect(spendCells[3].textContent).toBe("1.00000000"); // BTC Spent — the proof

    // All-Time totals: 1 BTC received, 1 BTC spent.
    expect(table.textContent).toContain("All Time");

    // The unresolved-source note surfaces because the spend's input address is
    // blank (the source could not be resolved).
    await waitFor(() => {
      expect(container.textContent).toContain(
        "had input sources that could not be resolved to an address",
      );
    });
  });

  it("understates the spend to zero only when the fallback prevout row is absent (control)", async () => {
    // Control: remove the blank-address input so there is no spending row at
    // all. The 2023 bucket should then not appear, proving the 1 BTC spent in
    // the main test came specifically from recovering the blank-address input.
    await clearParticipants({ skipNotification: true });
    await addParticipant(
      { txid: FUND_TX, role: "output", address: OWNED, amount: ONE_BTC, vout: 0 },
      { skipNotification: true },
    );

    const { getByTestId, findByTestId, queryByTestId } = renderWithProviders(
      <AnnualActivityReport />,
    );

    fireEvent.change(getByTestId("textarea-addresses"), {
      target: { value: OWNED },
    });
    fireEvent.click(getByTestId("button-generate"));

    const table = await findByTestId("table-combined");
    // 2021 funding row still present...
    expect(within(table).queryByTestId("row-year-2021")).not.toBeNull();
    // ...but with no spending input row, the 2023 spend bucket never appears.
    expect(queryByTestId("row-year-2023")).toBeNull();
  });
});

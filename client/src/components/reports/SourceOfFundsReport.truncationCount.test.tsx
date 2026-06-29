// @vitest-environment jsdom
//
// Regression guard for the Source of Funds truncation warning's "shown" count
// (SourceOfFundsReport.generateReport -> cap.shownTxCount). When a busy address
// is capped, the retained slice is chosen by selectFundingTxidsUnderCap, but the
// enrichment loop can still skip some of those kept txids: `if (!tx) continue`
// (no stored transaction) and `if (!myOutput) continue` (no matching output).
// The "shown" count must reflect the funding sources actually produced
// (`fundingSources.length`), NOT the pre-loop selected count (`inputTxids.length`),
// or the warning would overstate "X of Y" and claim more sources than are listed.
//
// This test seeds an address whose funding history is capped and where two of the
// kept txids hit the skip paths (one missing transaction, one missing matching
// output). It asserts the rendered warning's "shown" count equals the number of
// funding-source rows actually displayed (and never the larger selected count).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, fireEvent, act } from "@testing-library/react";

import { renderWithProviders } from "@/test/testProviders";

const ADDR = "bc1qsourceoffundstruncationtestaddr00000";

// Per-report cap. allInputTxids (6) > limit (4) => capped. selectFundingTxidsUnderCap
// keeps ceil(4/2)=2 oldest + 2 newest by block height => txA, txB, txE, txF.
const TX_LIMIT = 4;

const txA = "tx_height_0100"; // oldest, kept, MISSING transaction -> skipped
const txB = "tx_height_0200"; // oldest, kept, valid -> shown
const txC = "tx_height_0300"; // middle, dropped by the cap selection
const txD = "tx_height_0400"; // middle, dropped by the cap selection
const txE = "tx_height_0500"; // newest, kept, valid -> shown
const txF = "tx_height_0600"; // newest, kept, tx exists but no matching output -> skipped

const heights: Record<string, number> = {
  [txA]: 100,
  [txB]: 200,
  [txC]: 300,
  [txD]: 400,
  [txE]: 500,
  [txF]: 600,
};

const allTxids = [txA, txB, txC, txD, txE, txF];

// Address participants: one "output" role per funding txid (the funding history).
const addressParticipants = allTxids.map((txid, i) => ({
  id: i + 1,
  txid,
  address: ADDR,
  role: "output" as const,
  vout: 0,
  amount: 50_000,
}));

// Per-txid participants returned during the enrichment loop. txF deliberately has
// NO output for ADDR so the loop's `if (!myOutput) continue` skip path fires.
const participantsByTxid: Record<string, Array<Record<string, unknown>>> = {
  [txB]: [{ id: 101, txid: txB, address: ADDR, role: "output", vout: 0, amount: 50_000 }],
  [txE]: [{ id: 102, txid: txE, address: ADDR, role: "output", vout: 0, amount: 70_000 }],
  [txF]: [{ id: 103, txid: txF, address: "bc1qotheraddress", role: "output", vout: 0, amount: 90_000 }],
};

// Stored transactions. txA is intentionally absent so `if (!tx) continue` fires.
const transactionsByTxid: Record<string, Record<string, unknown>> = {
  [txB]: { txid: txB, blockHeight: 200, blockTime: 1_700_000_000 },
  [txE]: { txid: txE, blockHeight: 500, blockTime: 1_700_100_000 },
  [txF]: { txid: txF, blockHeight: 600, blockTime: 1_700_200_000 },
};

const ownedRecord = {
  id: 1,
  type: "address",
  inputString: ADDR,
  inputStringLower: ADDR.toLowerCase(),
  label: "Truncation Test Address",
  owner: "Alice",
  walletName: "Cold Wallet",
  addressImportance: "verified",
};

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({ sourceOfFundsTxLimit: TX_LIMIT }),
  useCustomFields: () => ({ customFields: [], enabledCustomFields: [], isLoading: false }),
}));

vi.mock("@/hooks/use-address-records", () => ({
  useAddressRecords: () => ({ records: [ownedRecord], isLoading: false }),
}));

vi.mock("@/lib/dataFacade", () => ({
  getParticipantsByAddress: vi.fn(async () => addressParticipants),
  getParticipantsByTxid: vi.fn(async (txid: string) => participantsByTxid[txid] ?? []),
  getTransactionByTxid: vi.fn(async (txid: string) => transactionsByTxid[txid]),
  getTransactionsByTxids: vi.fn(async (txids: string[]) =>
    txids.map((txid) => ({ txid, blockHeight: heights[txid] })),
  ),
}));

vi.mock("@/lib/data/price-data-crud", () => ({
  getPriceDataByKey: vi.fn(async () => undefined),
  getLatestPriceOnOrBefore: vi.fn(async () => undefined),
}));

const { SourceOfFundsReport } = await import("./SourceOfFundsReport");

async function waitForCondition(fn: () => boolean, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (fn()) return;
    await act(async () => {
      await Promise.resolve();
    });
  }
  throw new Error("waitForCondition: condition never became true");
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SourceOfFundsReport truncation count", () => {
  it("shows the funding-source count actually rendered, not the pre-skip selected count", async () => {
    const screen = renderWithProviders(<SourceOfFundsReport />);

    // Select the capped address through the search UI.
    fireEvent.change(screen.getByTestId("input-address-search"), {
      target: { value: "Truncation" },
    });
    fireEvent.click(screen.getByTestId(`button-select-address-${ownedRecord.id}`));

    fireEvent.click(screen.getByTestId("button-generate-report"));

    await waitForCondition(() => !!screen.queryByTestId("warning-report-capped"));

    // Two of the four kept txids were skipped (missing tx + missing output), so
    // exactly two funding-source rows should render.
    const rows = screen.queryAllByTestId(/^row-funding-source-/);
    expect(rows.length).toBe(2);

    const warningText = screen.getByTestId("warning-report-capped").textContent ?? "";

    // The "shown" count must equal the rows actually displayed (2 of 6) and must
    // NOT be the pre-loop selected count (4 of 6), which would overstate the
    // listed sources.
    expect(warningText).toContain(`${rows.length} of ${allTxids.length}`);
    expect(warningText).toContain("2 of 6");
    expect(warningText).not.toContain("4 of 6");
  });
});

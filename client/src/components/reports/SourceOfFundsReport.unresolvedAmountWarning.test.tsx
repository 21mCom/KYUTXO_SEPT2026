// @vitest-environment jsdom
//
// Coverage for SourceOfFundsReport's "unresolved input amounts" warning.
//
// generateReport()'s per-funding-tx prevout lookup reads the funding output's
// amount from synced participant data. When the funding transaction was never
// fully synced, that output stays at amount 0, so received totals silently
// under-count with no signal to the user — mirroring the Annual Activity
// Report's unresolved-input warning (Task #1229).
//
// This test seeds one fully-resolved funding tx and two funding txs whose
// outputs resolve to 0 (funding never synced), then asserts:
//   (1) a non-blocking warning surfaces to the user;
//   (2) the unresolved count in the notice is correct (2).

// renderWithProviders includes RecordPreviewProvider, which loads its custom
// field definitions from Dexie when it mounts.
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, fireEvent, act } from "@testing-library/react";

import { renderWithProviders } from "@/test/testProviders";

const ADDR = "bc1qsourceoffundsunresolvedtestaddr00000";

const txResolved = "tx_resolved_0001"; // funding output amount known
const txZeroA = "tx_unresolved_0001"; // funding output amount 0 (never synced)
const txZeroB = "tx_unresolved_0002"; // funding output amount 0 (never synced)

const allTxids = [txResolved, txZeroA, txZeroB];

// Address participants: one "output" role per funding txid (the funding history).
const addressParticipants = allTxids.map((txid, i) => ({
  id: i + 1,
  txid,
  address: ADDR,
  role: "output" as const,
  vout: 0,
  amount: txid === txResolved ? 50_000 : 0,
}));

// Per-txid participants returned during the enrichment loop. The two unresolved
// funding txs return their output for ADDR with amount 0 (funding tx unsynced).
const participantsByTxid: Record<string, Array<Record<string, unknown>>> = {
  [txResolved]: [{ id: 101, txid: txResolved, address: ADDR, role: "output", vout: 0, amount: 50_000 }],
  [txZeroA]: [{ id: 102, txid: txZeroA, address: ADDR, role: "output", vout: 0, amount: 0 }],
  [txZeroB]: [{ id: 103, txid: txZeroB, address: ADDR, role: "output", vout: 0, amount: 0 }],
};

const transactionsByTxid: Record<string, Record<string, unknown>> = {
  [txResolved]: { txid: txResolved, blockHeight: 200, blockTime: 1_700_000_000 },
  [txZeroA]: { txid: txZeroA, blockHeight: 300, blockTime: 1_700_100_000 },
  [txZeroB]: { txid: txZeroB, blockHeight: 400, blockTime: 1_700_200_000 },
};

const ownedRecord = {
  id: 1,
  type: "address",
  inputString: ADDR,
  inputStringLower: ADDR.toLowerCase(),
  label: "Unresolved Test Address",
  owner: "Alice",
  walletName: "Cold Wallet",
  addressImportance: "verified",
};

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({ sourceOfFundsTxLimit: 1000 }),
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
    txids.map((txid) => ({ txid, blockHeight: (transactionsByTxid[txid] as any)?.blockHeight })),
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

describe("SourceOfFundsReport unresolved amount warning", () => {
  it("warns when funding txs were never synced and reports the count", async () => {
    const screen = renderWithProviders(<SourceOfFundsReport />);

    fireEvent.change(screen.getByTestId("input-address-search"), {
      target: { value: "Unresolved" },
    });
    fireEvent.click(screen.getByTestId(`button-select-address-${ownedRecord.id}`));

    fireEvent.click(screen.getByTestId("button-generate-report"));

    await waitForCondition(() => !!screen.queryByTestId("warning-unresolved-input-amounts"));

    const warningText = screen.getByTestId("warning-unresolved-input-amounts").textContent ?? "";

    // Two of the three funding outputs resolved to 0 → the notice reports 2.
    expect(warningText).toContain("2 input amounts could not be resolved");
    expect(warningText).toContain("received totals may be understated");
  });
});

// @vitest-environment jsdom
//
// Page-level regression coverage for the UTXO Provenance report: drives the
// real page UI to lock in date, wallet, pattern, hop-depth, search, and dust
// filtering, plus the two distinct empty-state messages.

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";
import { createRecord, clearAllRecords } from "@/lib/data/record-crud";
import {
  addTransaction,
  bulkAddParticipants,
  clearAllTransactionData,
} from "@/lib/data/transaction-crud";
import { markOutpointsAsDust, clearDustFlags } from "@/lib/data/dust-flags-crud";
import UtxoProvenancePage from "./UtxoProvenance";

const OWN = "bc1qutxoprovownaaaaaaaaaaaaaaaaaaaaaaaaaa";

const TX_EARLY = "aa".repeat(32);
const TX_LATE = "bb".repeat(32);
const WALLET_A = "Wallet A";
const WALLET_B = "Wallet B";
const FILTER_ADDR_A = "bc1qprovfilteraaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FILTER_ADDR_B = "bc1qprovfilterbbbbbbbbbbbbbbbbbbbbbbbb";
const FILTER_MERCHANT = "bc1qprovfiltermerchantxxxxxxxxxxxxxxxxxxx";
const TX_FILTER_FUND = "cc".repeat(32);
const TX_FILTER_PARTIAL = "dd".repeat(32);
const TX_FILTER_COINBASE = "ee".repeat(32);
const TX_FILTER_DEEP_FUND = "ff".repeat(32);
const TX_FILTER_DEEP_REORG = "11".repeat(32);
const TX_FILTER_DEEP_OUTPUT = "22".repeat(32);

// Local noon so the local-time bounds DateRangeFilter derives from yyyy-MM-dd
// inputs always contain these instants regardless of the test runner's TZ.
const EARLY_TIME = Math.floor(new Date("2021-03-15T12:00:00").getTime() / 1000);
const LATE_TIME = Math.floor(new Date("2023-08-20T12:00:00").getTime() / 1000);

async function seedTwoUtxos() {
  await createRecord({ type: "address", inputString: OWN, label: "Test addr", addressImportance: "manual" });
  await addTransaction({ txid: TX_EARLY, blockHeight: 670_000, blockTime: EARLY_TIME, fee: 300, feeRate: 1, syncedAt: Date.now() });
  await addTransaction({ txid: TX_LATE, blockHeight: 800_000, blockTime: LATE_TIME, fee: 300, feeRate: 1, syncedAt: Date.now() });
  await bulkAddParticipants([
    { txid: TX_EARLY, role: "output", address: OWN, amount: 500_000, vout: 0 },
    { txid: TX_LATE, role: "output", address: OWN, amount: 1_000, vout: 0 },
  ]);
}

async function markLateUtxoAsDust() {
  await markOutpointsAsDust([{ txid: TX_LATE, vout: 0, address: OWN, amountSats: 1_000 }]);
}

async function seedFilterFixtures() {
  await createRecord({
    type: "address",
    inputString: FILTER_ADDR_A,
    label: "Treasury reserve",
    walletName: WALLET_A,
    addressImportance: "manual",
  });
  await createRecord({
    type: "address",
    inputString: FILTER_ADDR_B,
    label: "Cold storage",
    walletName: WALLET_B,
    addressImportance: "manual",
  });

  await addTransaction({ txid: TX_FILTER_FUND, blockHeight: 700_000, blockTime: 1_650_000_000, fee: 100, feeRate: 1, syncedAt: Date.now() });
  await addTransaction({ txid: TX_FILTER_PARTIAL, blockHeight: 700_001, blockTime: 1_650_000_100, fee: 100, feeRate: 1, syncedAt: Date.now() });
  await addTransaction({ txid: TX_FILTER_COINBASE, blockHeight: 700_002, blockTime: 1_650_000_200, fee: 0, feeRate: 0, syncedAt: Date.now() });
  await addTransaction({ txid: TX_FILTER_DEEP_FUND, blockHeight: 700_003, blockTime: 1_650_000_300, fee: 100, feeRate: 1, syncedAt: Date.now() });
  await addTransaction({ txid: TX_FILTER_DEEP_REORG, blockHeight: 700_004, blockTime: 1_650_000_400, fee: 100, feeRate: 1, syncedAt: Date.now() });
  await addTransaction({ txid: TX_FILTER_DEEP_OUTPUT, blockHeight: 700_005, blockTime: 1_650_000_500, fee: 100, feeRate: 1, syncedAt: Date.now() });

  await bulkAddParticipants([
    // Wallet A's unspent change has a partial-spend hop plus an origin hop.
    { txid: TX_FILTER_FUND, role: "input", address: FILTER_MERCHANT, amount: 100_000 },
    { txid: TX_FILTER_FUND, role: "output", address: FILTER_ADDR_A, amount: 99_000, vout: 0 },
    { txid: TX_FILTER_PARTIAL, role: "input", address: FILTER_ADDR_A, amount: 99_000, prevTxid: TX_FILTER_FUND, prevVout: 0 },
    { txid: TX_FILTER_PARTIAL, role: "output", address: FILTER_MERCHANT, amount: 60_000, vout: 0 },
    { txid: TX_FILTER_PARTIAL, role: "output", address: FILTER_ADDR_A, amount: 38_500, vout: 1 },

    // Wallet B's coinbase output has one hop and a coinbase classification.
    { txid: TX_FILTER_COINBASE, role: "output", address: FILTER_ADDR_B, amount: 50_000, vout: 0 },

    // Wallet B's second output has three hops, making the min-hops threshold
    // observable independently of the pattern and wallet filters.
    { txid: TX_FILTER_DEEP_FUND, role: "input", address: FILTER_MERCHANT, amount: 80_000 },
    { txid: TX_FILTER_DEEP_FUND, role: "output", address: FILTER_ADDR_B, amount: 79_000, vout: 0 },
    { txid: TX_FILTER_DEEP_REORG, role: "input", address: FILTER_ADDR_B, amount: 79_000, prevTxid: TX_FILTER_DEEP_FUND, prevVout: 0 },
    { txid: TX_FILTER_DEEP_REORG, role: "output", address: FILTER_ADDR_B, amount: 78_000, vout: 0 },
    { txid: TX_FILTER_DEEP_OUTPUT, role: "input", address: FILTER_ADDR_B, amount: 78_000, prevTxid: TX_FILTER_DEEP_REORG, prevVout: 0 },
    { txid: TX_FILTER_DEEP_OUTPUT, role: "output", address: FILTER_ADDR_B, amount: 77_000, vout: 0 },
  ]);
}

const earlyRowTestId = `utxo-prov-row-${TX_EARLY.slice(0, 8)}-0`;
const lateRowTestId = `utxo-prov-row-${TX_LATE.slice(0, 8)}-0`;
const filterPartialRowTestId = `utxo-prov-row-${TX_FILTER_PARTIAL.slice(0, 8)}-1`;
const filterCoinbaseRowTestId = `utxo-prov-row-${TX_FILTER_COINBASE.slice(0, 8)}-0`;
const filterDeepRowTestId = `utxo-prov-row-${TX_FILTER_DEEP_OUTPUT.slice(0, 8)}-0`;

async function chooseSelect(testId: string, optionName: string | RegExp) {
  fireEvent.click(screen.getByTestId(testId));
  fireEvent.click(await screen.findByRole("option", { name: optionName }));
}

describe("UtxoProvenance page", () => {
  beforeEach(async () => {
    Element.prototype.scrollIntoView = () => {};
    await clearAllRecords();
    await clearAllTransactionData();
    await clearDustFlags();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders every unspent UTXO when no filters narrow the list", async () => {
    await seedTwoUtxos();
    renderWithProviders(<UtxoProvenancePage />);

    await waitFor(() => expect(screen.getByTestId("prov-count").textContent).toBe("2 UTXOs"));
    expect(screen.getByTestId(earlyRowTestId)).toBeTruthy();
    expect(screen.getByTestId(lateRowTestId)).toBeTruthy();
  });

  it("narrows the visible list to UTXOs whose date falls inside the selected date range", async () => {
    await seedTwoUtxos();
    renderWithProviders(<UtxoProvenancePage />);
    await waitFor(() => expect(screen.getByTestId("prov-count").textContent).toBe("2 UTXOs"));

    fireEvent.change(screen.getByTestId("input-utxo-provenance-date-range-from"), { target: { value: "2021-01-01" } });
    fireEvent.change(screen.getByTestId("input-utxo-provenance-date-range-to"), { target: { value: "2021-12-31" } });

    await waitFor(() => expect(screen.getByTestId("prov-count").textContent).toBe("1 UTXOs"));
    expect(screen.getByTestId(earlyRowTestId)).toBeTruthy();
    expect(screen.queryByTestId(lateRowTestId)).toBeNull();
  });

  it("shows the date-range empty state when no unspent UTXO falls in the selected range", async () => {
    await seedTwoUtxos();
    renderWithProviders(<UtxoProvenancePage />);
    await waitFor(() => expect(screen.getByTestId("prov-count").textContent).toBe("2 UTXOs"));

    fireEvent.change(screen.getByTestId("input-utxo-provenance-date-range-from"), { target: { value: "2019-01-01" } });
    fireEvent.change(screen.getByTestId("input-utxo-provenance-date-range-to"), { target: { value: "2019-12-31" } });

    await waitFor(() => expect(screen.getByTestId("prov-empty")).toBeTruthy());
    expect(screen.getByTestId("prov-empty").textContent).toContain("No unspent UTXOs match the selected date range.");
    // The dust-specific wording must NOT appear for this cause of emptiness.
    expect(screen.getByTestId("prov-empty").textContent).not.toContain("flagged as dust");
  });

  it("narrows results to the selected wallet's addresses", async () => {
    await seedFilterFixtures();
    renderWithProviders(<UtxoProvenancePage />);

    await waitFor(() => expect(screen.getByTestId("prov-count").textContent).toBe("3 UTXOs"));
    await chooseSelect("prov-wallet-filter", WALLET_A);

    await waitFor(() => expect(screen.getByTestId("prov-count").textContent).toBe("1 UTXOs"));
    expect(screen.getByTestId(filterPartialRowTestId)).toBeTruthy();
    expect(screen.queryByTestId(filterCoinbaseRowTestId)).toBeNull();
    expect(screen.queryByTestId(filterDeepRowTestId)).toBeNull();
  });

  it("matches a selected pattern against every classification in the provenance trail", async () => {
    await seedFilterFixtures();
    renderWithProviders(<UtxoProvenancePage />);

    await waitFor(() => expect(screen.getByTestId("prov-count").textContent).toBe("3 UTXOs"));
    await chooseSelect("prov-class-filter", "Has partial spend");

    await waitFor(() => expect(screen.getByTestId("prov-count").textContent).toBe("1 UTXOs"));
    expect(screen.getByTestId(filterPartialRowTestId)).toBeTruthy();
    expect(screen.queryByTestId(filterCoinbaseRowTestId)).toBeNull();
    expect(screen.queryByTestId(filterDeepRowTestId)).toBeNull();

    // Coinbase is a separate classification and must remain selectable.
    await chooseSelect("prov-class-filter", "Coinbase origin");
    await waitFor(() => expect(screen.getByTestId("prov-count").textContent).toBe("1 UTXOs"));
    expect(screen.getByTestId(filterCoinbaseRowTestId)).toBeTruthy();
    expect(screen.queryByTestId(filterPartialRowTestId)).toBeNull();
  });

  it("excludes UTXOs whose recorded provenance trail is below the minimum hop threshold", async () => {
    await seedFilterFixtures();
    renderWithProviders(<UtxoProvenancePage />);

    await waitFor(() => expect(screen.getByTestId("prov-count").textContent).toBe("3 UTXOs"));
    await chooseSelect("prov-min-hops", "≥ 2");

    await waitFor(() => expect(screen.getByTestId("prov-count").textContent).toBe("2 UTXOs"));
    expect(screen.getByTestId(filterPartialRowTestId)).toBeTruthy();
    expect(screen.getByTestId(filterDeepRowTestId)).toBeTruthy();
    expect(screen.queryByTestId(filterCoinbaseRowTestId)).toBeNull();
  });

  it("matches search text against an address, transaction ID, and address label", async () => {
    await seedFilterFixtures();
    renderWithProviders(<UtxoProvenancePage />);

    await waitFor(() => expect(screen.getByTestId("prov-count").textContent).toBe("3 UTXOs"));
    const search = screen.getByTestId("prov-search");

    fireEvent.change(search, { target: { value: "filteraaaa" } });
    await waitFor(() => expect(screen.getByTestId("prov-count").textContent).toBe("1 UTXOs"));
    expect(screen.getByTestId(filterPartialRowTestId)).toBeTruthy();

    fireEvent.change(search, { target: { value: TX_FILTER_COINBASE } });
    await waitFor(() => expect(screen.getByTestId("prov-count").textContent).toBe("1 UTXOs"));
    expect(screen.getByTestId(filterCoinbaseRowTestId)).toBeTruthy();

    fireEvent.change(search, { target: { value: "treasury reserve" } });
    await waitFor(() => expect(screen.getByTestId("prov-count").textContent).toBe("1 UTXOs"));
    expect(screen.getByTestId(filterPartialRowTestId)).toBeTruthy();
  });

  it("hides dust-flagged UTXOs behind the Hide dust toggle and reports the hidden count", async () => {
    await seedTwoUtxos();
    await markLateUtxoAsDust();
    renderWithProviders(<UtxoProvenancePage />);
    await waitFor(() => expect(screen.getByTestId("prov-count").textContent).toBe("2 UTXOs"));

    // Wording lock: the switch's label is "Hide dust", not e.g. "Ignore dust".
    expect(screen.getByText("Hide dust")).toBeTruthy();
    expect(screen.queryByTestId("prov-dust-status")).toBeNull();

    fireEvent.click(screen.getByTestId("switch-ignore-prov-dust"));

    await waitFor(() => expect(screen.getByTestId("prov-count").textContent).toBe("1 UTXOs"));
    expect(screen.getByTestId(earlyRowTestId)).toBeTruthy();
    expect(screen.queryByTestId(lateRowTestId)).toBeNull();
    expect(screen.getByTestId("prov-dust-status").textContent).toBe("Hiding 1 flagged dust UTXO");

    // Toggling back off restores the dust-flagged row and clears the badge.
    fireEvent.click(screen.getByTestId("switch-ignore-prov-dust"));
    await waitFor(() => expect(screen.getByTestId("prov-count").textContent).toBe("2 UTXOs"));
    expect(screen.getByTestId(lateRowTestId)).toBeTruthy();
    expect(screen.queryByTestId("prov-dust-status")).toBeNull();
  });

  it("shows the dust empty state when every UTXO left in view is flagged as dust", async () => {
    await seedTwoUtxos();
    await markLateUtxoAsDust();
    renderWithProviders(<UtxoProvenancePage />);
    await waitFor(() => expect(screen.getByTestId("prov-count").textContent).toBe("2 UTXOs"));

    // Scope the date range to just the dust-flagged (late) UTXO, then hide dust.
    fireEvent.change(screen.getByTestId("input-utxo-provenance-date-range-from"), { target: { value: "2023-01-01" } });
    fireEvent.change(screen.getByTestId("input-utxo-provenance-date-range-to"), { target: { value: "2023-12-31" } });
    await waitFor(() => expect(screen.getByTestId("prov-count").textContent).toBe("1 UTXOs"));

    fireEvent.click(screen.getByTestId("switch-ignore-prov-dust"));

    await waitFor(() => expect(screen.getByTestId("prov-empty")).toBeTruthy());
    expect(screen.getByTestId("prov-empty").textContent).toContain("All unspent UTXOs in this view are flagged as dust.");
    expect(screen.getByTestId("prov-empty").textContent).toContain('Turn off \u201cHide dust\u201d to show them.');
    // The date-range-specific wording must NOT appear for this cause of emptiness.
    expect(screen.getByTestId("prov-empty").textContent).not.toContain("selected date range");
  });
});

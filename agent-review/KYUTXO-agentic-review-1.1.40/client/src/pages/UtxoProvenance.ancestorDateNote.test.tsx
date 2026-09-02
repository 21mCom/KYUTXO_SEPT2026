// @vitest-environment jsdom
//
// Task #2146: the UTXO Provenance date-range filter only scopes the
// top-level list of UTXOs (by their receiving tx's blockTime) — ancestor
// spend history shown in the expanded panel is, by design, never filtered
// (ancestors are always older than the UTXO they fund, so filtering them by
// the same receipt-date window would nearly always empty the trail out from
// under the user). This locks in the compensating UX: whenever the date
// filter is actively narrowing the list, the expanded ancestor panel must
// carry a note saying the history above is unscoped, so the wider hop dates
// don't look like a stale/broken filter.
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";

import { renderWithProviders } from "@/test/testProviders";
import { clearAllRecords, createRecord } from "@/lib/data/record-crud";
import {
  bulkAddTransactions,
  bulkAddParticipants,
  clearTransactions,
  clearParticipants,
} from "@/lib/data/transaction-crud";
import UtxoProvenancePage from "./UtxoProvenance";

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(async () => {
  cleanup();
  await clearAllRecords();
  await clearTransactions();
  await clearParticipants();
});

const ADDR_A = "bc1qprovancestornoteownedaddr0000000000000";
const ADDR_EXTERNAL = "bc1qprovancestornoteexternaladdr000000000000";

const TX_ANCESTOR = "a".repeat(64); // external -> address A (old)
const TX_FINAL = "b".repeat(64);    // address A -> address A, spends TX_ANCESTOR's output (recent)

// 2024-01-01 and 2024-06-01, far enough apart that a date range around the
// recent tx cleanly excludes the ancestor.
const T_OLD = Math.floor(new Date("2024-01-01T00:00:00Z").getTime() / 1000);
const T_NEW = Math.floor(new Date("2024-06-01T00:00:00Z").getTime() / 1000);

async function seedTwoHopChain() {
  await createRecord({
    type: "address",
    inputString: ADDR_A,
    label: "Owned",
  });

  await bulkAddTransactions([
    { txid: TX_ANCESTOR, blockHeight: 800_000, blockTime: T_OLD, fee: 100, feeRate: 1, syncedAt: Date.now() },
    { txid: TX_FINAL, blockHeight: 800_500, blockTime: T_NEW, fee: 100, feeRate: 1, syncedAt: Date.now() },
  ]);

  await bulkAddParticipants([
    // Ancestor hop: funded from outside the wallet.
    { txid: TX_ANCESTOR, role: "input", address: ADDR_EXTERNAL, amount: 50_000 },
    { txid: TX_ANCESTOR, role: "output", address: ADDR_A, amount: 49_900, vout: 0 },
    // Final hop: wallet reorg spending the ancestor's output back to itself,
    // creating the still-unspent UTXO under test.
    { txid: TX_FINAL, role: "input", address: ADDR_A, amount: 49_900, prevTxid: TX_ANCESTOR, prevVout: 0 },
    { txid: TX_FINAL, role: "output", address: ADDR_A, amount: 49_800, vout: 0 },
  ]);
}

async function expandTheOnlyRow() {
  const row = await screen.findByTestId(`utxo-prov-row-${TX_FINAL.slice(0, 8)}-0`);
  fireEvent.click(row);
  await waitFor(() => {
    expect(screen.getByTestId(`hop-list-${TX_FINAL.slice(0, 8)}-0`)).toBeTruthy();
  });
}

describe("UtxoProvenance ancestor history vs. date filter", () => {
  it("shows the full ancestor hop trail with no unscoped-note when no date filter is set", async () => {
    await seedTwoHopChain();
    renderWithProviders(<UtxoProvenancePage />);

    await expandTheOnlyRow();

    const hopList = screen.getByTestId(`hop-list-${TX_FINAL.slice(0, 8)}-0`);
    // Both hops (the funding tx and the final wallet-reorg tx) are present.
    expect(within(hopList).getByTestId(`hop-chip-${TX_FINAL.slice(0, 8)}`)).toBeTruthy();
    expect(within(hopList).getByTestId(`hop-chip-${TX_ANCESTOR.slice(0, 8)}`)).toBeTruthy();

    expect(
      screen.queryByTestId(`prov-ancestor-unscoped-note-${TX_FINAL.slice(0, 8)}-0`),
    ).toBeNull();
  });

  it("keeps the older ancestor hop visible and adds an unscoped note once the date range excludes it", async () => {
    await seedTwoHopChain();
    renderWithProviders(<UtxoProvenancePage />);

    // Narrow to a window that covers the final (recent) tx but not the
    // older ancestor tx.
    fireEvent.change(screen.getByTestId("input-utxo-provenance-date-range-from"), {
      target: { value: "2024-05-01" },
    });
    fireEvent.change(screen.getByTestId("input-utxo-provenance-date-range-to"), {
      target: { value: "2024-07-01" },
    });

    // The top-level list still shows the UTXO (its receiving tx, TX_FINAL,
    // falls inside the range).
    await expandTheOnlyRow();

    const hopList = screen.getByTestId(`hop-list-${TX_FINAL.slice(0, 8)}-0`);
    // The ancestor hop (outside the selected range) is still shown — the
    // trail is never truncated by the date filter.
    expect(within(hopList).getByTestId(`hop-chip-${TX_FINAL.slice(0, 8)}`)).toBeTruthy();
    expect(within(hopList).getByTestId(`hop-chip-${TX_ANCESTOR.slice(0, 8)}`)).toBeTruthy();

    // The panel now explains that this history isn't limited by the filter.
    expect(
      screen.getByTestId(`prov-ancestor-unscoped-note-${TX_FINAL.slice(0, 8)}-0`),
    ).toBeTruthy();
  });

  it("hides the UTXO from the list (and drops the note with it) once the range excludes its own receipt date", async () => {
    await seedTwoHopChain();
    renderWithProviders(<UtxoProvenancePage />);

    // A window that excludes even the final tx's own receipt date.
    fireEvent.change(screen.getByTestId("input-utxo-provenance-date-range-from"), {
      target: { value: "2024-01-01" },
    });
    fireEvent.change(screen.getByTestId("input-utxo-provenance-date-range-to"), {
      target: { value: "2024-01-31" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("prov-empty")).toBeTruthy();
    });
    expect(
      screen.queryByTestId(`utxo-prov-row-${TX_FINAL.slice(0, 8)}-0`),
    ).toBeNull();
  });
});

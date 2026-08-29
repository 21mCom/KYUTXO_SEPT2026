// @vitest-environment jsdom
//
// Page-level regression coverage for the UTXO Provenance report: seeds two
// unspent outputs at different dates, flags one as dust, and drives the real
// page UI to lock in the date-range filter, the "Hide dust" toggle (and its
// status badge), and the two distinct empty-state messages (no results in
// the selected date range vs. every result in view hidden by dust).

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

const earlyRowTestId = `utxo-prov-row-${TX_EARLY.slice(0, 8)}-0`;
const lateRowTestId = `utxo-prov-row-${TX_LATE.slice(0, 8)}-0`;

describe("UtxoProvenance page", () => {
  beforeEach(async () => {
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

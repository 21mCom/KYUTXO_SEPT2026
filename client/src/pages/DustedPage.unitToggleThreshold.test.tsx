// @vitest-environment jsdom
//
// Confirms the BTC/sats unit toggle (button-toggle-unit) on the dust-threshold
// input actually drives the real dust scan, not just the display string:
// switching to BTC, typing a BTC amount, and switching back must produce the
// exact same underlying sats threshold used by computeDustings, with no
// rounding drift and no silent no-op on the scan results.

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";
import { db } from "@/lib/database";
import { createRecord, clearAllRecords } from "@/lib/data/record-crud";
import { bulkAddParticipants, clearParticipants } from "@/lib/data/transaction-crud";
import DustedPage from "./DustedPage";

// jsdom has no layout, so the real virtualizer measures a 0-height scroll
// element and renders nothing. Render every row instead.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number; estimateSize: (i: number) => number }) => {
    const items = Array.from({ length: opts.count }, (_, index) => ({
      index,
      key: index,
      start: index * 56,
      size: opts.estimateSize(index),
    }));
    return {
      getTotalSize: () => opts.count * 56,
      getVirtualItems: () => items,
    };
  },
}));

const TXID_LOW = "a".repeat(64); // 500 sats — below both thresholds we test
const TXID_HIGH = "b".repeat(64); // 700 sats — above the 600-sat threshold, below the 1000-sat default
const ADDR = "bc1qdustedpageunittoggletest00000000000000";

async function seed() {
  const recordId = await createRecord({
    type: "address",
    inputString: ADDR,
    label: "Unit toggle test",
    tags: [],
    categories: [],
  });
  await bulkAddParticipants([
    { txid: TXID_LOW, role: "output", address: ADDR, amount: 500, vout: 0 },
    { txid: TXID_HIGH, role: "output", address: ADDR, amount: 700, vout: 1 },
  ]);
  return recordId;
}

function setInputValue(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

describe("DustedPage BTC/sats unit toggle drives the real threshold", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(async () => {
    await clearAllRecords();
    await clearParticipants();
    await db.dustFlags.clear();
  });

  it("defaults to sats and counts both outputs as dust under the 1000-sat default", async () => {
    const recordId = await seed();
    renderWithProviders(<DustedPage />);

    await waitFor(() =>
      expect(screen.getByTestId(`badge-total-${recordId}`).textContent).toBe("2"),
    );
    expect(screen.getByTestId(`badge-unspent-${recordId}`).textContent).toBe("2");
    expect(screen.getByTestId("input-dust-threshold").getAttribute("value")).toBe("1000");
    expect(screen.getByTestId("button-toggle-unit").textContent).toBe("sats");
  });

  it("switching to BTC and typing a BTC amount sets the exact sats threshold used by the scan", async () => {
    const recordId = await seed();
    renderWithProviders(<DustedPage />);
    await waitFor(() =>
      expect(screen.getByTestId(`badge-total-${recordId}`).textContent).toBe("2"),
    );

    // Toggle sats -> BTC. The input should immediately re-render showing the
    // current 1000-sat threshold as BTC.
    fireEvent.click(screen.getByTestId("button-toggle-unit"));
    expect(screen.getByTestId("button-toggle-unit").textContent).toBe("BTC");
    expect(screen.getByTestId("input-dust-threshold").getAttribute("value")).toBe(
      "0.00001000",
    );

    // Type 0.00000600 BTC (= 600 sats). Only the 500-sat output should now
    // qualify as dust; the 700-sat output no longer does.
    setInputValue(screen.getByTestId("input-dust-threshold"), "0.00000600");

    await waitFor(() =>
      expect(screen.getByTestId(`badge-total-${recordId}`).textContent).toBe("1"),
    );
    expect(screen.getByTestId(`badge-unspent-${recordId}`).textContent).toBe("1");
    expect(screen.getByTestId("text-results-summary").textContent).toContain("600");
    expect(screen.getByTestId("text-results-summary").textContent).not.toContain("60,000");

    // Expand the row and confirm the surviving dust output is the 500-sat one.
    fireEvent.click(screen.getByTestId(`button-toggle-outputs-${recordId}`));
    expect(
      screen.getByTestId(`text-outpoint-${recordId}-${TXID_LOW}-0`),
    ).toBeTruthy();
    expect(
      screen.queryByTestId(`text-outpoint-${recordId}-${TXID_HIGH}-1`),
    ).toBeNull();
  });

  it("round-trips BTC -> sats without drifting the underlying threshold", async () => {
    const recordId = await seed();
    renderWithProviders(<DustedPage />);
    await waitFor(() =>
      expect(screen.getByTestId(`badge-total-${recordId}`).textContent).toBe("2"),
    );

    fireEvent.click(screen.getByTestId("button-toggle-unit")); // -> BTC
    setInputValue(screen.getByTestId("input-dust-threshold"), "0.00000600");
    await waitFor(() =>
      expect(screen.getByTestId(`badge-total-${recordId}`).textContent).toBe("1"),
    );

    // Toggle back to sats: the input must show the exact whole-sat value with
    // no rounding drift, and the scan result must be unchanged.
    fireEvent.click(screen.getByTestId("button-toggle-unit")); // -> sats
    expect(screen.getByTestId("button-toggle-unit").textContent).toBe("sats");
    expect(screen.getByTestId("input-dust-threshold").getAttribute("value")).toBe("600");
    expect(screen.getByTestId(`badge-total-${recordId}`).textContent).toBe("1");

    // Toggle to BTC once more: still exactly 0.00000600, no accumulated drift.
    fireEvent.click(screen.getByTestId("button-toggle-unit")); // -> BTC
    expect(screen.getByTestId("input-dust-threshold").getAttribute("value")).toBe(
      "0.00000600",
    );
  });

  it("handles the smallest possible BTC increment (1 sat) without rounding to zero", async () => {
    const recordId = await createRecord({
      type: "address",
      inputString: ADDR,
      label: "1-sat threshold test",
      tags: [],
      categories: [],
    });
    await bulkAddParticipants([
      { txid: TXID_LOW, role: "output", address: ADDR, amount: 1, vout: 0 },
    ]);
    renderWithProviders(<DustedPage />);

    fireEvent.click(screen.getByTestId("button-toggle-unit")); // -> BTC
    setInputValue(screen.getByTestId("input-dust-threshold"), "0.00000001");

    // A threshold of 1 sat means "strictly below 1 sat" -> nothing qualifies
    // as dust, so the address never shows up as a dusted row.
    await waitFor(() =>
      expect(screen.getByTestId("state-empty")).toBeTruthy(),
    );
    expect(screen.queryByTestId(`row-dusted-${recordId}`)).toBeNull();

    // Bump to 2 sats via BTC input; now the 1-sat output qualifies.
    setInputValue(screen.getByTestId("input-dust-threshold"), "0.00000002");
    await waitFor(() =>
      expect(screen.getByTestId(`badge-total-${recordId}`).textContent).toBe("1"),
    );
  });
});

// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";
import { db } from "@/lib/database";
import { createRecord, clearAllRecords } from "@/lib/data/record-crud";
import { bulkAddParticipants, clearParticipants } from "@/lib/data/transaction-crud";
import { getAllDustFlags, markOutpointsAsDust, toOutpoint } from "@/lib/data/dust-flags-crud";
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

const TXID_A = "a".repeat(64);
const TXID_B = "b".repeat(64);
const ADDR = "bc1qdustedpageperoutputtest0000000000000000";

async function seed() {
  const recordId = await createRecord({
    type: "address",
    inputString: ADDR,
    label: "Dusted test",
    tags: [],
    categories: [],
  });
  // Two unspent dust outputs on the same address.
  await bulkAddParticipants([
    { txid: TXID_A, role: "output", address: ADDR, amount: 546, vout: 0 },
    { txid: TXID_B, role: "output", address: ADDR, amount: 800, vout: 1 },
  ]);
  return recordId;
}

describe("DustedPage per-output dust controls", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(async () => {
    await clearAllRecords();
    await clearParticipants();
    await db.dustFlags.clear();
  });

  it("expands a row to show individual outputs and marks a single output", async () => {
    const recordId = await seed();
    renderWithProviders(<DustedPage />);

    const toggle = await screen.findByTestId(
      `button-toggle-outputs-${recordId}`,
      {},
      { timeout: 10000 },
    );

    // Outputs are hidden before expanding.
    expect(
      screen.queryByTestId(`row-dust-output-${recordId}-${TXID_A}-0`),
    ).toBeNull();

    fireEvent.click(toggle);

    // Both outputs listed with outpoint + sats.
    expect(
      screen.getByTestId(`text-outpoint-${recordId}-${TXID_A}-0`).textContent,
    ).toBe(`${TXID_A}:0`);
    expect(
      screen.getByTestId(`text-output-sats-${recordId}-${TXID_B}-1`).textContent,
    ).toContain("800");

    // Mark only the first output.
    fireEvent.click(screen.getByTestId(`button-mark-output-${recordId}-${TXID_A}-0`));

    await waitFor(async () => {
      const flags = await getAllDustFlags();
      expect(flags.map((f) => f.outpoint)).toEqual([toOutpoint(TXID_A, 0)]);
    });

    // The marked output now shows Unmark; the other still shows Mark.
    await screen.findByTestId(`button-unmark-output-${recordId}-${TXID_A}-0`);
    expect(
      screen.getByTestId(`button-mark-output-${recordId}-${TXID_B}-1`),
    ).toBeTruthy();

    // Row-level button remains the bulk action ("Mark as dust" since not all flagged).
    expect(screen.getByTestId(`button-mark-dust-${recordId}`)).toBeTruthy();
  });

  it("unmarks a single flagged output without touching the other flag", async () => {
    const recordId = await seed();
    await markOutpointsAsDust([
      { txid: TXID_A, vout: 0, address: ADDR, amountSats: 546 },
      { txid: TXID_B, vout: 1, address: ADDR, amountSats: 800 },
    ]);
    renderWithProviders(<DustedPage />);

    const toggle = await screen.findByTestId(
      `button-toggle-outputs-${recordId}`,
      {},
      { timeout: 10000 },
    );
    fireEvent.click(toggle);

    fireEvent.click(
      await screen.findByTestId(`button-unmark-output-${recordId}-${TXID_A}-0`),
    );

    await waitFor(async () => {
      const flags = await getAllDustFlags();
      expect(flags.map((f) => f.outpoint)).toEqual([toOutpoint(TXID_B, 1)]);
    });

    // With not-all-flagged, the row bulk button flips back to "Mark as dust".
    await screen.findByTestId(`button-mark-dust-${recordId}`);
  });

  it("surfaces stale flags after a scan and removes them via the cleanup button", async () => {
    const recordId = await seed();
    const STALE_TXID = "c".repeat(64);
    // Flag a live dust output AND an outpoint that is spent (input references it),
    // so after the scan the spent one is stale.
    await bulkAddParticipants([
      { txid: STALE_TXID, role: "output", address: ADDR, amount: 400, vout: 0 },
      {
        txid: "d".repeat(64),
        role: "input",
        address: ADDR,
        amount: 400,
        prevTxid: STALE_TXID,
        prevVout: 0,
      },
    ]);
    await markOutpointsAsDust([
      { txid: TXID_A, vout: 0, address: ADDR, amountSats: 546 },
      { txid: STALE_TXID, vout: 0, address: ADDR, amountSats: 400 },
    ]);
    renderWithProviders(<DustedPage />);

    // Wait for the scan to finish and the stale banner to appear.
    const banner = await screen.findByTestId("banner-stale-flags", {}, { timeout: 10000 });
    expect(banner.textContent).toContain("1");
    expect(
      screen.getByTestId("text-stale-flags-summary").textContent,
    ).toContain("no longer match");

    fireEvent.click(screen.getByTestId("button-clean-stale-flags"));

    // Only the stale flag is removed; the live one survives.
    await waitFor(async () => {
      const flags = await getAllDustFlags();
      expect(flags.map((f) => f.outpoint)).toEqual([toOutpoint(TXID_A, 0)]);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("banner-stale-flags")).toBeNull();
    });
    // The address row is still present.
    expect(screen.getByTestId(`row-dusted-${recordId}`)).toBeTruthy();
  });
});

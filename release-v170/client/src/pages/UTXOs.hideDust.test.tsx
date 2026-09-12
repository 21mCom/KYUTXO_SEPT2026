// @vitest-environment jsdom
//
// Regression coverage for the "Hide dust" filter on the UTXOs page. The filter
// drops user-flagged dust outpoints BEFORE grouping, so the list, the
// Addresses/UTXOs count, and the summary totals must all exclude them. This was
// previously only verified by a live browser check; this jsdom test locks in
// the wiring so a refactor of the utxos memo chain (e.g. the engine fast path
// vs Dexie path selection) can't silently reintroduce dust into totals.
//
// The full page is rendered against real Dexie (fake-indexeddb) seeded via the
// real CRUD modules. The engine freshness gate is mocked to always fall back to
// the in-browser Dexie computation, and the virtualizer is stubbed (jsdom has
// no layout, so a real virtualizer would render zero rows).
import "fake-indexeddb/auto";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

// jsdom has no layout: render every row instead of a measured window.
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
      measureElement: () => {},
    };
  },
}));

// ScrollPositionIndicator uses window.matchMedia, which jsdom lacks; it is
// pure chrome, so stub it out (same as the scroll-preload sibling test).
vi.mock("@/components/ScrollPositionIndicator", () => ({
  ScrollPositionIndicator: () => null,
}));

// Force the Dexie path: the engine is never available in jsdom, and the page's
// dust filter must apply to whichever path produced the UTXO set anyway.
vi.mock("@/lib/engine/engine-freshness", () => ({
  evaluateEngineFreshness: vi.fn().mockResolvedValue({ useEngine: false }),
}));
vi.mock("@/lib/engine/engine-client", () => ({
  engineGetOwnedUtxos: vi.fn().mockResolvedValue([]),
  engineCountOwnedUtxos: vi.fn().mockResolvedValue(0),
  engineGetHeuristicOwnedUtxos: vi.fn().mockResolvedValue([]),
  engineCountHeuristicOwnedUtxos: vi.fn().mockResolvedValue(0),
}));

import { renderWithProviders } from "@/test/testProviders";
import { db } from "@/lib/database";
import { createRecord, clearAllRecords } from "@/lib/data/record-crud";
import {
  bulkAddTransactions,
  bulkAddParticipants,
  clearTransactions,
  clearParticipants,
} from "@/lib/data/transaction-crud";
import { markOutpointsAsDust } from "@/lib/data/dust-flags-crud";
import UTXOs from "./UTXOs";

// jsdom elements don't implement scrollTo (the page scrolls the list back to
// the top whenever a filter — including hideDust — changes).
beforeAll(() => {
  Element.prototype.scrollTo = () => {};
});

const TXID = "d".repeat(64);
const ADDR = "bc1qhidedusttotalstest000000000000000000000";
const DUST_SATS = 546;
const KEEP_SATS = 50_000;

async function seed() {
  await createRecord({
    type: "address",
    inputString: ADDR,
    label: "Hide-dust test",
    tags: [],
    categories: [],
  });
  await bulkAddTransactions([
    {
      txid: TXID,
      blockHeight: 800_000,
      blockTime: 1_700_000_000,
      fee: 100,
      feeRate: 1,
      syncedAt: Date.now(),
    },
  ]);
  // Two unspent outputs on the same address; vout 0 is the dust one.
  await bulkAddParticipants([
    { txid: TXID, role: "output", address: ADDR, amount: DUST_SATS, vout: 0 },
    { txid: TXID, role: "output", address: ADDR, amount: KEEP_SATS, vout: 1 },
  ]);
  await markOutpointsAsDust([
    { txid: TXID, vout: 0, address: ADDR, amountSats: DUST_SATS },
  ]);
}

function satsToBtc(sats: number): string {
  return (sats / 100_000_000).toFixed(8);
}

describe("UTXOs page Hide dust filter", () => {
  beforeEach(async () => {
    localStorage.clear();
    await clearAllRecords();
    await clearTransactions();
    await clearParticipants();
    await db.dustFlags.clear();
    await seed();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("drops the dust-flagged UTXO from the count and total when toggled, and shows the badge", async () => {
    renderWithProviders(<UTXOs />);

    // Both outputs are included before the toggle: 1 address / 2 UTXOs.
    await waitFor(
      () => {
        expect(screen.getByTestId("text-utxo-count").textContent).toBe("1 / 2");
      },
      { timeout: 10000 },
    );
    expect(screen.getByTestId("text-total-balance").textContent).toContain(
      `${satsToBtc(DUST_SATS + KEEP_SATS)} BTC`,
    );
    // No badge while the filter is off.
    expect(screen.queryByTestId("badge-dust-hidden")).toBeNull();

    fireEvent.click(screen.getByTestId("switch-hide-dust"));

    // The count and total drop by exactly the dust output.
    await waitFor(() => {
      expect(screen.getByTestId("text-utxo-count").textContent).toBe("1 / 1");
    });
    expect(screen.getByTestId("text-total-balance").textContent).toContain(
      `${satsToBtc(KEEP_SATS)} BTC`,
    );

    // The badge reports exactly what was hidden.
    const badge = screen.getByTestId("badge-dust-hidden");
    expect(badge.textContent).toContain("Hiding dust-flagged UTXOs");
    expect(badge.textContent).toContain("1 hidden");
    expect(badge.textContent).toContain(`${satsToBtc(DUST_SATS)} BTC`);
  });

  it("restores the dust UTXO to count and totals when toggled back off", async () => {
    renderWithProviders(<UTXOs />);

    await waitFor(
      () => {
        expect(screen.getByTestId("text-utxo-count").textContent).toBe("1 / 2");
      },
      { timeout: 10000 },
    );

    fireEvent.click(screen.getByTestId("switch-hide-dust"));
    await waitFor(() => {
      expect(screen.getByTestId("text-utxo-count").textContent).toBe("1 / 1");
    });

    // "Show dust" in the badge row turns the filter back off.
    fireEvent.click(screen.getByTestId("button-show-dust"));

    await waitFor(() => {
      expect(screen.getByTestId("text-utxo-count").textContent).toBe("1 / 2");
    });
    expect(screen.getByTestId("text-total-balance").textContent).toContain(
      `${satsToBtc(DUST_SATS + KEEP_SATS)} BTC`,
    );
    expect(screen.queryByTestId("badge-dust-hidden")).toBeNull();
  });
});

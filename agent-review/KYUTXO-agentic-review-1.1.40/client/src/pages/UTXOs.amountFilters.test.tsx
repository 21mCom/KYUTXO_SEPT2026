// @vitest-environment jsdom
//
// Page-level coverage for the UTXOs BTC/sats amount controls. The filter UI
// displays the selected unit, but stores thresholds canonically as BTC and
// the UTXO data is canonically sats. These tests ensure converting between
// those representations does not move an exact boundary or couple the range
// fields together.
import "fake-indexeddb/auto";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { format } from "date-fns";

// jsdom has no layout: render every row instead of a measured virtual window.
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

vi.mock("@/components/ScrollPositionIndicator", () => ({
  ScrollPositionIndicator: () => null,
}));

// Force the in-browser computation so this test exercises the same
// filterByDateAndAmount path used when the native read engine is unavailable.
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
import { clearAllRecords, createRecord } from "@/lib/data/record-crud";
import {
  bulkAddTransactions,
  bulkAddParticipants,
  clearTransactions,
  clearParticipants,
} from "@/lib/data/transaction-crud";
import { db } from "@/lib/database";
import UTXOs from "./UTXOs";

beforeAll(() => {
  Element.prototype.scrollTo = () => {};
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = vi.fn();
});

// Keep the first eight characters distinct because AddressLink uses that
// prefix in its test ID.
const ADDR_546 = "bc1q546amountfilteraddress00000000000000000";
const ADDR_547 = "bc1q547amountfilteraddress00000000000000000";
const ADDR_550 = "bc1q550amountfilteraddress00000000000000000";
const SHARED_ADDR = "bc1qsharedamountfilteraddress000000000000000";
const TXID_546 = "a".repeat(64);
const TXID_547 = "b".repeat(64);
const TXID_550 = "c".repeat(64);
const TXID_SHARED_MATCH = "d".repeat(64);
const TXID_SHARED_UNRELATED = "e".repeat(64);
const DATE_FILTER_ADDR = "bc1qdatefilteraddress000000000000000000000";
const TXID_DATE_EARLY = "f".repeat(64);
const TXID_DATE_MATCH = "1".repeat(64);
const TXID_DATE_LATE = "2".repeat(64);

function localNoonOnDay(day: number): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), day, 12, 0, 0, 0);
}

function unixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

async function seedDateFilterOutputs() {
  const earlyDate = localNoonOnDay(5);
  const matchDate = localNoonOnDay(15);
  const lateDate = localNoonOnDay(25);

  await createRecord({
    type: "address",
    inputString: DATE_FILTER_ADDR,
    label: "Shared date filter address",
    tags: [],
    categories: [],
  });
  await bulkAddTransactions([
    {
      txid: TXID_DATE_EARLY,
      blockHeight: 800_001,
      blockTime: unixSeconds(earlyDate),
      fee: 100,
      feeRate: 1,
      syncedAt: Date.now(),
    },
    {
      txid: TXID_DATE_MATCH,
      blockHeight: 800_002,
      blockTime: unixSeconds(matchDate),
      fee: 100,
      feeRate: 1,
      syncedAt: Date.now(),
    },
    {
      txid: TXID_DATE_LATE,
      blockHeight: 800_003,
      blockTime: unixSeconds(lateDate),
      fee: 100,
      feeRate: 1,
      syncedAt: Date.now(),
    },
  ]);
  await bulkAddParticipants([
    { txid: TXID_DATE_EARLY, role: "output", address: DATE_FILTER_ADDR, amount: 700, vout: 0 },
    { txid: TXID_DATE_MATCH, role: "output", address: DATE_FILTER_ADDR, amount: 800, vout: 0 },
    { txid: TXID_DATE_LATE, role: "output", address: DATE_FILTER_ADDR, amount: 900, vout: 0 },
  ]);

  return { earlyDate, matchDate, lateDate };
}

async function seed() {
  await Promise.all(
    [
      [ADDR_546, TXID_546, 546],
      [ADDR_547, TXID_547, 547],
      [ADDR_550, TXID_550, 550],
    ].map(async ([address, txid]) => {
      await createRecord({
        type: "address",
        inputString: address,
        label: `Amount ${address.slice(-3)}`,
        tags: [],
        categories: [],
      });
      await bulkAddTransactions([
        {
          txid,
          blockHeight: 800_000,
          blockTime: 1_700_000_000,
          fee: 100,
          feeRate: 1,
          syncedAt: Date.now(),
        },
      ]);
    }),
  );
  await bulkAddParticipants([
    { txid: TXID_546, role: "output", address: ADDR_546, amount: 546, vout: 0 },
    { txid: TXID_547, role: "output", address: ADDR_547, amount: 547, vout: 0 },
    { txid: TXID_550, role: "output", address: ADDR_550, amount: 550, vout: 0 },
  ]);
}

async function openAmountRange() {
  fireEvent.click(await screen.findByTestId("button-advanced-filters"));
  // Radix Tabs selects on the pointer-down phase; fireEvent.click alone does
  // not reproduce a browser click in jsdom.
  const rangeTab = await screen.findByTestId("tab-amount-range");
  fireEvent.mouseDown(rangeTab, { button: 0 });
  await screen.findByTestId("input-amount-min");
}

async function openAmountExact() {
  fireEvent.click(await screen.findByTestId("button-advanced-filters"));
  const exactTab = await screen.findByTestId("tab-amount-exact");
  fireEvent.mouseDown(exactTab, { button: 0 });
  await screen.findByTestId("input-amount-exact");
}

async function openDateExact() {
  fireEvent.click(await screen.findByTestId("button-advanced-filters"));
  const exactTab = await screen.findByTestId("tab-date-exact");
  fireEvent.mouseDown(exactTab, { button: 0 });
  await screen.findByTestId("button-date-exact");
}

async function openDateRange() {
  fireEvent.click(await screen.findByTestId("button-advanced-filters"));
  const rangeTab = await screen.findByTestId("tab-date-range");
  fireEvent.mouseDown(rangeTab, { button: 0 });
  await screen.findByTestId("button-date-start");
}

async function selectCalendarDate(buttonTestId: string, date: Date) {
  fireEvent.click(await screen.findByTestId(buttonTestId));
  const dateButton = await waitFor(() => {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button[name="day"]')).find((candidate) => {
      const timestamp = candidate.getAttribute("data-time-value");
      if (timestamp) {
        const candidateDate = new Date(Number(timestamp));
        return (
          candidateDate.getFullYear() === date.getFullYear() &&
          candidateDate.getMonth() === date.getMonth() &&
          candidateDate.getDate() === date.getDate()
        );
      }
      const label = candidate.getAttribute("aria-label") ?? "";
      const matchesLabel = (
        label.includes(date.toLocaleString("en-US", { month: "long" })) &&
        label.includes(String(date.getDate())) &&
        label.includes(String(date.getFullYear()))
      );
      const matchesVisibleDay = (
        candidate.textContent?.trim() === String(date.getDate()) &&
        !candidate.classList.contains("day-outside")
      );
      return matchesLabel || matchesVisibleDay;
    });
    if (!button) {
      throw new Error(`Could not find calendar date ${date.toISOString()}`);
    }
    return button;
  });
  fireEvent.click(dateButton);
  await waitFor(() => {
    expect(screen.getByTestId(buttonTestId).textContent).toContain(format(date, "MMM d, yyyy"));
  });
}

describe("UTXOs page BTC/sats amount filters", () => {
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

  it("toggles the displayed total without changing the exact satoshi balance", async () => {
    renderWithProviders(<UTXOs />);

    await waitFor(
      () => expect(screen.getByTestId("text-utxo-count").textContent).toBe("3 / 3"),
      { timeout: 10000 },
    );
    expect(screen.getByTestId("text-total-balance").textContent).toContain("0.00001643 BTC");

    fireEvent.click(screen.getByTestId("button-toggle-unit"));
    expect(screen.getByTestId("button-toggle-unit").textContent).toBe("BTC");
    expect(screen.getByTestId("text-total-balance").textContent).toContain("1,643 sats");

    fireEvent.click(screen.getByTestId("button-toggle-unit"));
    expect(screen.getByTestId("button-toggle-unit").textContent).toBe("sats");
    expect(screen.getByTestId("text-total-balance").textContent).toContain("0.00001643 BTC");
  });

  it("uses exact sats boundaries and keeps min/max edits independent", async () => {
    renderWithProviders(<UTXOs />);

    await waitFor(
      () => expect(screen.getByTestId("text-utxo-count").textContent).toBe("3 / 3"),
      { timeout: 10000 },
    );

    // Switch the page to sats before opening Advanced Filters. The inputs and
    // their labels must use sats while the underlying filter remains BTC-based.
    fireEvent.click(screen.getByTestId("button-toggle-unit"));
    await openAmountRange();

    expect(screen.getByTestId("input-amount-min").getAttribute("step")).toBe("1");
    expect(screen.getByTestId("input-amount-max").getAttribute("step")).toBe("1");

    const min = screen.getByTestId("input-amount-min") as HTMLInputElement;
    const max = screen.getByTestId("input-amount-max") as HTMLInputElement;
    fireEvent.change(min, { target: { value: "546" } });
    fireEvent.change(max, { target: { value: "550" } });

    await waitFor(() => {
      expect(screen.getByTestId("text-utxo-count").textContent).toBe("3 / 3");
    });
    expect(min.value).toBe("546");
    expect(max.value).toBe("550");
    expect(screen.getByText("546 sats - 550 sats")).toBeTruthy();

    // Moving only the lower boundary to 547 excludes the exact 546-sat
    // address, while the independently edited upper boundary stays at 550.
    fireEvent.change(min, { target: { value: "547" } });
    await waitFor(() => {
      expect(screen.getByTestId("text-utxo-count").textContent).toBe("2 / 2");
    });
    expect(min.value).toBe("547");
    expect(max.value).toBe("550");
    expect(screen.queryByTestId(`link-address-${ADDR_546.slice(0, 8)}`)).toBeNull();
    expect(screen.getByTestId(`link-address-${ADDR_547.slice(0, 8)}`)).toBeTruthy();
    expect(screen.getByTestId(`link-address-${ADDR_550.slice(0, 8)}`)).toBeTruthy();

    // Toggle to BTC and back: both thresholds retain their exact satoshi
    // meaning, rather than drifting through a rounded display value.
    fireEvent.click(screen.getByTestId("button-toggle-unit"));
    await waitFor(() => expect(min.value).toBe("0.00000547"));
    expect(max.value).toBe("0.0000055");
    fireEvent.click(screen.getByTestId("button-toggle-unit"));
    expect(min.value).toBe("547");
    expect(max.value).toBe("550");
    expect(screen.getByTestId("text-utxo-count").textContent).toBe("2 / 2");
  });

  it("keeps unrelated outputs out of a matching address group and totals", async () => {
    await createRecord({
      type: "address",
      inputString: SHARED_ADDR,
      label: "Shared amount filter address",
      tags: [],
      categories: [],
    });
    await bulkAddTransactions([
      {
        txid: TXID_SHARED_MATCH,
        blockHeight: 800_000,
        blockTime: 1_700_000_000,
        fee: 100,
        feeRate: 1,
        syncedAt: Date.now(),
      },
      {
        txid: TXID_SHARED_UNRELATED,
        blockHeight: 800_000,
        blockTime: 1_700_000_000,
        fee: 100,
        feeRate: 1,
        syncedAt: Date.now(),
      },
    ]);
    await bulkAddParticipants([
      { txid: TXID_SHARED_MATCH, role: "output", address: SHARED_ADDR, amount: 600, vout: 0 },
      { txid: TXID_SHARED_UNRELATED, role: "output", address: SHARED_ADDR, amount: 1_200, vout: 1 },
    ]);

    renderWithProviders(<UTXOs />);
    await waitFor(
      () => expect(screen.getByTestId("text-utxo-count").textContent).toBe("4 / 5"),
      { timeout: 10000 },
    );

    await openAmountExact();
    fireEvent.change(screen.getByTestId("input-amount-exact"), {
      target: { value: "0.000006" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("text-utxo-count").textContent).toBe("1 / 1");
      expect(screen.getByTestId("text-total-balance").textContent).toContain("0.00000600 BTC");
    });
    expect(screen.getByTestId(`row-address-${SHARED_ADDR.slice(0, 8)}`)).toBeTruthy();
    expect(screen.queryByTestId(`row-address-${ADDR_546.slice(0, 8)}`)).toBeNull();

    fireEvent.click(screen.getByTestId(`row-address-${SHARED_ADDR.slice(0, 8)}`));
    expect(
      screen.getByTestId(`row-utxo-${TXID_SHARED_MATCH}:0`),
    ).toBeTruthy();
    expect(
      screen.queryByTestId(`row-utxo-${TXID_SHARED_UNRELATED}:1`),
    ).toBeNull();

    // The same narrowed result must remain in place when the balance display
    // changes units.
    fireEvent.click(screen.getByTestId("button-toggle-unit"));
    expect(screen.getByTestId("text-total-balance").textContent).toContain("600 sats");
    expect(screen.getByTestId("text-utxo-count").textContent).toBe("1 / 1");
    fireEvent.click(screen.getByTestId("button-toggle-unit"));
    expect(screen.getByTestId("text-total-balance").textContent).toContain("0.00000600 BTC");
    expect(screen.getByTestId("text-utxo-count").textContent).toBe("1 / 1");
  });

  it("keeps unrelated same-address outputs out of exact-date rows and aggregates", async () => {
    const { earlyDate, matchDate, lateDate } = await seedDateFilterOutputs();

    renderWithProviders(<UTXOs />);
    await waitFor(
      () => expect(screen.getByTestId("text-utxo-count").textContent).toBe("4 / 6"),
      { timeout: 10000 },
    );

    await openDateExact();
    await selectCalendarDate("button-date-exact", matchDate);

    await waitFor(() => {
      expect(screen.getByTestId("text-utxo-count").textContent).toBe("1 / 1");
      expect(screen.getByTestId("text-total-balance").textContent).toContain("0.00000800 BTC");
    });
    const groupRow = screen.getByTestId(`row-address-${DATE_FILTER_ADDR.slice(0, 8)}`);
    expect(groupRow.textContent).toContain(format(matchDate, "MMM d, yyyy"));
    expect(groupRow.textContent).not.toContain(format(earlyDate, "MMM d, yyyy"));
    expect(groupRow.textContent).not.toContain(format(lateDate, "MMM d, yyyy"));

    fireEvent.click(groupRow);
    expect(screen.getByTestId(`row-utxo-${TXID_DATE_MATCH}:0`)).toBeTruthy();
    expect(screen.queryByTestId(`row-utxo-${TXID_DATE_EARLY}:0`)).toBeNull();
    expect(screen.queryByTestId(`row-utxo-${TXID_DATE_LATE}:0`)).toBeNull();
  });

  it("keeps unrelated same-address outputs out of range-date rows and aggregates", async () => {
    const { earlyDate, matchDate, lateDate } = await seedDateFilterOutputs();

    renderWithProviders(<UTXOs />);
    await waitFor(
      () => expect(screen.getByTestId("text-utxo-count").textContent).toBe("4 / 6"),
      { timeout: 10000 },
    );

    await openDateRange();
    await selectCalendarDate("button-date-start", localNoonOnDay(12));
    await selectCalendarDate("button-date-end", localNoonOnDay(18));

    await waitFor(() => {
      expect(screen.getByTestId("text-utxo-count").textContent).toBe("1 / 1");
      expect(screen.getByTestId("text-total-balance").textContent).toContain("0.00000800 BTC");
    });
    const groupRow = screen.getByTestId(`row-address-${DATE_FILTER_ADDR.slice(0, 8)}`);
    expect(groupRow.textContent).toContain(format(matchDate, "MMM d, yyyy"));
    expect(groupRow.textContent).not.toContain(format(earlyDate, "MMM d, yyyy"));
    expect(groupRow.textContent).not.toContain(format(lateDate, "MMM d, yyyy"));

    fireEvent.click(groupRow);
    expect(screen.getByTestId(`row-utxo-${TXID_DATE_MATCH}:0`)).toBeTruthy();
    expect(screen.queryByTestId(`row-utxo-${TXID_DATE_EARLY}:0`)).toBeNull();
    expect(screen.queryByTestId(`row-utxo-${TXID_DATE_LATE}:0`)).toBeNull();
  });
});

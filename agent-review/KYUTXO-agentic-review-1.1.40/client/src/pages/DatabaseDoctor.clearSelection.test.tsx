// @vitest-environment jsdom
//
// Regression test for the "Clear selection (N)" button on the Balance Integrity
// stale-address list (BalanceIntegrityCard, data-testid="button-clear-selection").
//
// The selection set spans the virtualized list, so a user can tick rows in one
// scrolled window, scroll to a different window and tick more, then clear the
// whole selection at once. This test exercises that exact flow and asserts that
// clicking "Clear selection":
//   - empties the selection (the button and "Recompute selected" disappear, and
//     visible checkboxes go unchecked),
//   - does NOT re-run the balance check or touch the loaded stale list/scratch
//     store (no extra detect/clearStaleReport calls; caption + list unchanged),
//   - is hidden whenever no rows are selected.

import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type {
  StaleAddressDetail,
  StaleBalanceCheckResult,
} from "@/lib/data/address-stats";

// The card calls into the address-stats engine and the local scratch store.
// Both are mocked so the test exercises only the BalanceIntegrityCard selection
// state + StaleAddressList virtualization, not Dexie/IndexedDB.
vi.mock("@/lib/data/address-stats", () => ({
  detectStaleCachedBalances: vi.fn(),
  recomputeAddressStats: vi.fn(),
}));
vi.mock("@/lib/data/stale-balance-report-store", () => ({
  clearStaleReport: vi.fn(async () => {}),
  appendStaleReportRows: vi.fn(async () => {}),
  getStaleReportWindow: vi.fn(async () => [] as StaleAddressDetail[]),
  exportStaleReport: vi.fn(async () => ({ blob: new Blob(), rowCount: 0 })),
}));

import { BalanceIntegrityCard } from "./DatabaseDoctor";
import {
  detectStaleCachedBalances,
  recomputeAddressStats,
} from "@/lib/data/address-stats";
import {
  getStaleReportWindow,
  clearStaleReport,
} from "@/lib/data/stale-balance-report-store";

const detectMock = vi.mocked(detectStaleCachedBalances);
const recomputeMock = vi.mocked(recomputeAddressStats);
const getWindowMock = vi.mocked(getStaleReportWindow);
const clearStoreMock = vi.mocked(clearStaleReport);

// A large stale set so the virtualized list has several windows: only a slice is
// rendered at a time and scrolling reveals rows from a different window.
const TOTAL = 250;
const allRows: StaleAddressDetail[] = Array.from({ length: TOTAL }, (_, i) => {
  const id = i + 1;
  return {
    recordId: id,
    address: `bc1qaddr${id}`,
    cachedSats: 1000 + id,
    computedSats: 2000 + id,
  };
});

// @tanstack/react-virtual needs ResizeObserver and real element dimensions to
// emit virtual rows. jsdom provides neither, so shim them; without this the
// virtualized list renders zero rows (see DatabaseDoctor.staleList.test.tsx).
const FAKE_RECT: DOMRect = {
  width: 600,
  height: 260,
  top: 0,
  left: 0,
  right: 600,
  bottom: 260,
  x: 0,
  y: 0,
  toJSON() {},
};

beforeAll(() => {
  Object.defineProperty(window.HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return 600;
    },
  });
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return 260;
    },
  });
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return FAKE_RECT;
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
  // The detect mock streams the whole stale set so staleRowsCount === TOTAL and
  // the virtual list knows its full row count; the window reader returns slices.
  detectMock.mockImplementation(async (opts) => {
    if (opts.onStaleBatch) await opts.onStaleBatch(allRows);
    return {
      sampled: 2000,
      staleCount: TOTAL,
      staleAddresses: [],
      checkedAll: false,
      cancelled: false,
    } satisfies StaleBalanceCheckResult;
  });
  getWindowMock.mockImplementation(async (offset: number, limit: number) =>
    allRows.slice(offset, offset + limit),
  );
});

// Make the scroll container's scrollTop deterministically settable so the
// virtualizer reads our offset on a scroll event (jsdom has no layout).
function controlScroll(el: HTMLElement) {
  let value = 0;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => value,
    set: (v: number) => {
      value = v;
    },
  });
}

describe("BalanceIntegrityCard - Clear selection across scrolled rows", () => {
  it("clears a selection spanning two scrolled windows without re-running the check or altering the list", async () => {
    render(<BalanceIntegrityCard />);

    fireEvent.click(screen.getByTestId("button-run-balance-check"));

    // The stale verdict + list mount once the (mocked) check resolves.
    await screen.findByTestId("list-stale-addresses");
    const caption = screen.getByTestId("text-stale-list-caption");
    const captionBefore = caption.textContent;

    // The check ran exactly once and cleared the scratch store exactly once.
    expect(detectMock).toHaveBeenCalledTimes(1);
    expect(clearStoreMock).toHaveBeenCalledTimes(1);

    // No selection yet, so the Clear selection button is absent.
    expect(screen.queryByTestId("button-clear-selection")).toBeNull();
    expect(screen.queryByTestId("button-recompute-selected")).toBeNull();

    // --- First window: tick two rows near the top (ids 1 and 5). ---
    const cb1 = await screen.findByTestId("checkbox-stale-1");
    fireEvent.click(cb1);
    fireEvent.click(screen.getByTestId("checkbox-stale-5"));

    // The Clear selection button now appears, showing the running count.
    await waitFor(() => {
      expect(screen.getByTestId("button-clear-selection").textContent).toContain(
        "Clear selection (2)",
      );
    });

    // --- Scroll to the bottom window and tick two more rows (ids 245 and 250). ---
    const scrollEl = screen.getByTestId("scroll-stale-addresses");
    controlScroll(scrollEl);
    scrollEl.scrollTop = TOTAL * 56; // past the end; clamps to the last rows
    fireEvent.scroll(scrollEl);

    // The far rows belong to a different (later) loaded window; wait for them.
    const cb250 = await screen.findByTestId("checkbox-stale-250");
    fireEvent.click(cb250);
    fireEvent.click(screen.getByTestId("checkbox-stale-245"));

    // Selection now spans both scrolled windows: 4 rows total.
    await waitFor(() => {
      expect(screen.getByTestId("button-clear-selection").textContent).toContain(
        "Clear selection (4)",
      );
    });
    expect(screen.getByTestId("button-recompute-selected").textContent).toContain(
      "Recompute selected (4)",
    );
    // The far rows show as checked.
    expect(screen.getByTestId("checkbox-stale-250").getAttribute("data-state")).toBe(
      "checked",
    );
    expect(screen.getByTestId("checkbox-stale-245").getAttribute("data-state")).toBe(
      "checked",
    );

    // --- Clear the whole selection. ---
    fireEvent.click(screen.getByTestId("button-clear-selection"));

    // The selection is empty: both the Clear and Recompute-selected buttons go away.
    await waitFor(() => {
      expect(screen.queryByTestId("button-clear-selection")).toBeNull();
    });
    expect(screen.queryByTestId("button-recompute-selected")).toBeNull();

    // Still-visible far rows are now unchecked.
    expect(screen.getByTestId("checkbox-stale-250").getAttribute("data-state")).toBe(
      "unchecked",
    );
    expect(screen.getByTestId("checkbox-stale-245").getAttribute("data-state")).toBe(
      "unchecked",
    );

    // The loaded stale list is untouched: the list is still mounted, its caption
    // is unchanged, and the plain Recompute (all) action remains available.
    expect(screen.getByTestId("list-stale-addresses")).toBeTruthy();
    expect(screen.getByTestId("text-stale-list-caption").textContent).toBe(captionBefore);
    expect(screen.getByTestId("button-recompute-balances")).toBeTruthy();

    // No balance check re-run and no store reset were triggered by clearing.
    expect(detectMock).toHaveBeenCalledTimes(1);
    expect(recomputeMock).not.toHaveBeenCalled();
    expect(clearStoreMock).toHaveBeenCalledTimes(1);
  });

  it("hides the Clear selection button once the last selected row is unticked", async () => {
    render(<BalanceIntegrityCard />);

    fireEvent.click(screen.getByTestId("button-run-balance-check"));
    await screen.findByTestId("list-stale-addresses");

    // Hidden with no selection.
    expect(screen.queryByTestId("button-clear-selection")).toBeNull();

    // Tick one row -> button appears.
    const cb = await screen.findByTestId("checkbox-stale-1");
    fireEvent.click(cb);
    await screen.findByTestId("button-clear-selection");

    // Untick the same row -> button disappears again (no Clear button needed).
    fireEvent.click(screen.getByTestId("checkbox-stale-1"));
    await waitFor(() => {
      expect(screen.queryByTestId("button-clear-selection")).toBeNull();
    });
  });
});

// @vitest-environment jsdom
//
// Regression test for "Recompute selected" on the Balance Integrity stale-address
// list (BalanceIntegrityCard). The card offers two rebuild actions:
//   - "Recompute" (button-recompute-balances)  -> rebuilds EVERY cached balance
//   - "Recompute selected" (button-recompute-selected) -> rebuilds ONLY the rows
//     the user ticked.
//
// Without a test pinning the wiring, a regression could silently make
// "Recompute selected" rebuild everything (slow on large vaults) or rebuild the
// wrong subset. These tests assert that:
//   - "Recompute selected" calls recomputeAddressStats with EXACTLY the ticked
//     recordIds (and nothing else),
//   - the plain "Recompute" path passes NO recordIds (i.e. rebuilds all),
//   - the post-recompute re-check repeats the SAME scope (checkAll) as the run.

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
import { getStaleReportWindow } from "@/lib/data/stale-balance-report-store";

const detectMock = vi.mocked(detectStaleCachedBalances);
const recomputeMock = vi.mocked(recomputeAddressStats);
const getWindowMock = vi.mocked(getStaleReportWindow);

// A small stale set; all rows fit in the first loaded window so they render
// without scrolling.
const TOTAL = 5;
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

// Wire detect so the first run reports stale rows (streamed into the scratch
// store), and any subsequent re-check returns clean. `checkedAll` is configurable
// so we can verify the re-check repeats the original scope.
function wireStaleThenClean(checkedAll: boolean) {
  detectMock
    .mockImplementationOnce(async (opts) => {
      if (opts.onStaleBatch) await opts.onStaleBatch(allRows);
      return {
        sampled: checkedAll ? 500 : 2000,
        staleCount: TOTAL,
        staleAddresses: [],
        checkedAll,
        cancelled: false,
      } satisfies StaleBalanceCheckResult;
    })
    .mockImplementationOnce(async () => {
      return {
        sampled: checkedAll ? 500 : 2000,
        staleCount: 0,
        staleAddresses: [],
        checkedAll,
        cancelled: false,
      } satisfies StaleBalanceCheckResult;
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
  getWindowMock.mockImplementation(async (offset: number, limit: number) =>
    allRows.slice(offset, offset + limit),
  );
  recomputeMock.mockResolvedValue({ updated: 1, cancelled: false });
});

describe("BalanceIntegrityCard - Recompute selected scopes to ticked rows", () => {
  it("passes EXACTLY the ticked recordIds to recomputeAddressStats", async () => {
    wireStaleThenClean(false);

    render(<BalanceIntegrityCard />);

    fireEvent.click(screen.getByTestId("button-run-balance-check"));
    await screen.findByTestId("list-stale-addresses");

    // Tick three of the five rows (ids 2, 4, 5).
    fireEvent.click(await screen.findByTestId("checkbox-stale-2"));
    fireEvent.click(screen.getByTestId("checkbox-stale-4"));
    fireEvent.click(screen.getByTestId("checkbox-stale-5"));

    await waitFor(() => {
      expect(screen.getByTestId("button-recompute-selected").textContent).toContain(
        "Recompute selected (3)",
      );
    });

    fireEvent.click(screen.getByTestId("button-recompute-selected"));

    // The re-check flips the verdict to clean once the recompute resolves.
    await waitFor(() => {
      const verdict = screen.getByTestId("text-balance-verdict");
      expect(verdict.textContent).toContain("up-to-date cached balances");
    });

    // Recompute was called once, scoped to EXACTLY the ticked ids (order-agnostic).
    expect(recomputeMock).toHaveBeenCalledTimes(1);
    const arg = recomputeMock.mock.calls[0][0];
    expect(arg?.recordIds).toBeDefined();
    expect([...(arg!.recordIds as number[])].sort((a, b) => a - b)).toEqual([2, 4, 5]);
  });

  it("the plain Recompute (all) passes NO recordIds", async () => {
    wireStaleThenClean(false);

    render(<BalanceIntegrityCard />);

    fireEvent.click(screen.getByTestId("button-run-balance-check"));
    await screen.findByTestId("list-stale-addresses");

    // Tick a row to prove the plain "Recompute" ignores the selection entirely.
    fireEvent.click(await screen.findByTestId("checkbox-stale-1"));
    await screen.findByTestId("button-recompute-selected");

    // Use the plain "Recompute" button (rebuild all), not "Recompute selected".
    fireEvent.click(screen.getByTestId("button-recompute-balances"));

    await waitFor(() => {
      const verdict = screen.getByTestId("text-balance-verdict");
      expect(verdict.textContent).toContain("up-to-date cached balances");
    });

    expect(recomputeMock).toHaveBeenCalledTimes(1);
    // No recordIds => rebuild every cached balance.
    expect(recomputeMock.mock.calls[0][0]?.recordIds).toBeUndefined();
  });

  it("re-runs the post-(selected)recompute check with the same scope (sample)", async () => {
    wireStaleThenClean(false);

    render(<BalanceIntegrityCard />);

    // Sample check (checkAll=false).
    fireEvent.click(screen.getByTestId("button-run-balance-check"));
    await screen.findByTestId("list-stale-addresses");
    expect(detectMock.mock.calls[0][0].checkAll).toBe(false);

    fireEvent.click(await screen.findByTestId("checkbox-stale-3"));
    await screen.findByTestId("button-recompute-selected");
    fireEvent.click(screen.getByTestId("button-recompute-selected"));

    await waitFor(() => {
      const verdict = screen.getByTestId("text-balance-verdict");
      expect(verdict.textContent).toContain("up-to-date cached balances");
    });

    // The post-recompute re-check repeated the original (sample) scope.
    expect(detectMock).toHaveBeenCalledTimes(2);
    expect(detectMock.mock.calls[1][0].checkAll).toBe(false);
  });

  it("re-runs the post-(selected)recompute check with the same scope (full scan)", async () => {
    wireStaleThenClean(true);

    render(<BalanceIntegrityCard />);

    // Full-table scan (checkAll=true).
    fireEvent.click(screen.getByTestId("button-check-all-balances"));
    await screen.findByTestId("list-stale-addresses");
    expect(detectMock.mock.calls[0][0].checkAll).toBe(true);

    fireEvent.click(await screen.findByTestId("checkbox-stale-3"));
    await screen.findByTestId("button-recompute-selected");
    fireEvent.click(screen.getByTestId("button-recompute-selected"));

    await waitFor(() => {
      const verdict = screen.getByTestId("text-balance-verdict");
      expect(verdict.textContent).toContain("up-to-date cached balances");
    });

    // The recompute was still scoped to the single ticked id...
    expect(recomputeMock).toHaveBeenCalledTimes(1);
    expect(recomputeMock.mock.calls[0][0]?.recordIds).toEqual([3]);
    // ...and the re-check repeated the original full-table scope.
    expect(detectMock).toHaveBeenCalledTimes(2);
    expect(detectMock.mock.calls[1][0].checkAll).toBe(true);
  });
});

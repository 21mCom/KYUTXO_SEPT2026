// @vitest-environment jsdom
//
// Component test for the BalanceIntegrityCard's error-recovery banner when the
// *Recompute* path fails.
//
// A sibling test (DatabaseDoctor.balanceErrorRecovery.test.tsx) already covers
// the banner when the read-only check (detectStaleCachedBalances) throws. But
// the same error state is also reachable from runRecompute: when
// recomputeAddressStats rejects with a non-abort error, the card must surface
// banner-balance-error so the user is never silently stranded mid-fix.
//
// These tests assert that:
//   - a rejected (non-abort) recompute shows banner-balance-error with the
//     thrown message, plus Retry and Dismiss,
//   - Retry from a *failed recompute* re-runs the read-only check at the last
//     scope (lastCheckAllRef) — it does NOT re-run the recompute,
//   - Retry repeats whichever scope (sample vs. full-table) the original check
//     used, and
//   - Dismiss returns the card to idle without kicking off any work.
//
// address-stats and the local scratch store are mocked so no real
// IndexedDB scan/recompute happens, matching the sibling BalanceIntegrityCard
// tests.

import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type {
  StaleAddressDetail,
  StaleBalanceCheckResult,
} from "@/lib/data/address-stats";

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
vi.mock("@/lib/legacy-decrypt", () => ({ isEncryptedPlaceholder: () => false }));

import { BalanceIntegrityCard } from "./DatabaseDoctor";
import {
  detectStaleCachedBalances,
  recomputeAddressStats,
} from "@/lib/data/address-stats";
import { getStaleReportWindow } from "@/lib/data/stale-balance-report-store";

const detectMock = vi.mocked(detectStaleCachedBalances);
const recomputeMock = vi.mocked(recomputeAddressStats);
const getWindowMock = vi.mocked(getStaleReportWindow);

// A small stale set so the Recompute button (gated on staleCount > 0) appears.
const TOTAL = 3;
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
// virtualized stale list renders zero rows (see DatabaseDoctor.staleList.test.tsx).
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

// A detect implementation that reports stale rows at the given scope, so the
// Recompute button shows. Streams the rows into the (mocked) scratch store.
function makeStaleDetect(checkedAll: boolean) {
  return (async (opts: any): Promise<StaleBalanceCheckResult> => {
    if (opts.onStaleBatch) await opts.onStaleBatch(allRows);
    return {
      sampled: checkedAll ? 500 : 2000,
      staleCount: TOTAL,
      staleAddresses: [],
      checkedAll,
      cancelled: false,
    } satisfies StaleBalanceCheckResult;
  }) as unknown as typeof detectStaleCachedBalances;
}

// A clean re-check used after a recovering Retry.
function makeCleanDetect(checkedAll: boolean) {
  return (async (): Promise<StaleBalanceCheckResult> => ({
    sampled: checkedAll ? 500 : 2000,
    staleCount: 0,
    staleAddresses: [],
    checkedAll,
    cancelled: false,
  })) as unknown as typeof detectStaleCachedBalances;
}

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
  getWindowMock.mockImplementation(async (offset: number, limit: number) =>
    allRows.slice(offset, offset + limit),
  );
});

describe("BalanceIntegrityCard - Recompute error recovery", () => {
  it("shows the error banner with Retry and Dismiss when Recompute fails", async () => {
    detectMock.mockImplementation(makeStaleDetect(false));
    recomputeMock.mockRejectedValue(new Error("recompute blew up"));

    render(<BalanceIntegrityCard />);

    fireEvent.click(screen.getByTestId("button-run-balance-check"));
    // Stale verdict surfaces the Recompute button.
    const recomputeBtn = await screen.findByTestId("button-recompute-balances");
    fireEvent.click(recomputeBtn);

    const banner = await screen.findByTestId("banner-balance-error");
    expect(banner).toBeTruthy();
    // The thrown message surfaces to the user.
    expect(banner.textContent).toContain("recompute blew up");
    expect(screen.getByTestId("button-retry-balance-check")).toBeTruthy();
    expect(screen.getByTestId("button-dismiss-balance-error")).toBeTruthy();
    // No idle / verdict UI while the error is showing.
    expect(screen.queryByTestId("text-balance-idle")).toBeNull();
    expect(screen.queryByTestId("banner-balance-result")).toBeNull();
  });

  it("Retry from a failed recompute re-runs the read-only check, not the recompute (sample scope)", async () => {
    detectMock.mockImplementation(makeStaleDetect(false));
    recomputeMock.mockRejectedValue(new Error("recompute blew up"));

    render(<BalanceIntegrityCard />);

    // Sample check (checkAll=false) finds stale rows.
    fireEvent.click(screen.getByTestId("button-run-balance-check"));
    fireEvent.click(await screen.findByTestId("button-recompute-balances"));
    await screen.findByTestId("banner-balance-error");

    // Only the initial check has run; the recompute attempt failed.
    expect(detectMock).toHaveBeenCalledTimes(1);
    expect((detectMock.mock.calls[0][0] as any).checkAll).toBe(false);
    expect(recomputeMock).toHaveBeenCalledTimes(1);

    // The next check succeeds with a clean verdict.
    detectMock.mockClear();
    recomputeMock.mockClear();
    detectMock.mockImplementation(makeCleanDetect(false));

    fireEvent.click(screen.getByTestId("button-retry-balance-check"));

    // Retry runs the read-only check at the last scope (sample) — never the recompute.
    await waitFor(() => expect(detectMock).toHaveBeenCalledTimes(1));
    expect((detectMock.mock.calls[0][0] as any).checkAll).toBe(false);
    expect(recomputeMock).not.toHaveBeenCalled();
    // The now-clean re-check replaces the error banner with a verdict.
    await waitFor(() => {
      expect(screen.getByTestId("banner-balance-result")).toBeTruthy();
    });
    expect(screen.queryByTestId("banner-balance-error")).toBeNull();
  });

  it("Retry from a failed recompute repeats the full-table scope", async () => {
    detectMock.mockImplementation(makeStaleDetect(true));
    recomputeMock.mockRejectedValue(new Error("recompute blew up"));

    render(<BalanceIntegrityCard />);

    // Full-table scan (checkAll=true) finds stale rows.
    fireEvent.click(screen.getByTestId("button-check-all-balances"));
    fireEvent.click(await screen.findByTestId("button-recompute-balances"));
    await screen.findByTestId("banner-balance-error");

    expect(detectMock).toHaveBeenCalledTimes(1);
    expect((detectMock.mock.calls[0][0] as any).checkAll).toBe(true);

    detectMock.mockClear();
    recomputeMock.mockClear();
    detectMock.mockImplementation(makeCleanDetect(true));

    fireEvent.click(screen.getByTestId("button-retry-balance-check"));

    // Retry must repeat the full-table scope the user originally chose.
    await waitFor(() => expect(detectMock).toHaveBeenCalledTimes(1));
    expect((detectMock.mock.calls[0][0] as any).checkAll).toBe(true);
    expect(recomputeMock).not.toHaveBeenCalled();
  });

  it("Dismiss after a failed recompute returns the card to idle without more work", async () => {
    detectMock.mockImplementation(makeStaleDetect(false));
    recomputeMock.mockRejectedValue(new Error("recompute blew up"));

    render(<BalanceIntegrityCard />);

    fireEvent.click(screen.getByTestId("button-run-balance-check"));
    fireEvent.click(await screen.findByTestId("button-recompute-balances"));
    await screen.findByTestId("banner-balance-error");

    detectMock.mockClear();
    recomputeMock.mockClear();

    fireEvent.click(screen.getByTestId("button-dismiss-balance-error"));

    await waitFor(() => {
      expect(screen.getByTestId("text-balance-idle")).toBeTruthy();
    });
    // Dismiss is purely local state — it clears the banner and runs nothing.
    expect(screen.queryByTestId("banner-balance-error")).toBeNull();
    expect(screen.queryByTestId("banner-balance-result")).toBeNull();
    expect(detectMock).not.toHaveBeenCalled();
    expect(recomputeMock).not.toHaveBeenCalled();
  });
});

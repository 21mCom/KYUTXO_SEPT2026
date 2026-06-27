// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type {
  StaleAddressDetail,
  StaleBalanceCheckResult,
} from "@/lib/data/address-stats";

// The card calls into the address-stats engine and the local scratch store.
// Both are mocked so the test exercises only the BalanceIntegrityCard state
// machine (run check -> done -> recompute -> re-check), not Dexie/IndexedDB.
vi.mock("@/lib/data/address-stats", () => ({
  detectStaleCachedBalances: vi.fn(),
  recomputeAddressStats: vi.fn(),
}));
vi.mock("@/lib/data/stale-balance-report-store", () => ({
  clearStaleReport: vi.fn(async () => {}),
  appendStaleReportRows: vi.fn(async () => {}),
  getStaleReportWindow: vi.fn(async () => [] as StaleAddressDetail[]),
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

function makeStaleRow(id: number): StaleAddressDetail {
  return {
    recordId: id,
    address: `bc1qaddr${id}`,
    cachedSats: 1000 + id,
    computedSats: 2000 + id,
  };
}

// A deferred promise helper so a test can hold a mock "in flight" and assert an
// intermediate UI state before resolving it.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
});

describe("BalanceIntegrityCard - check to done with stale results", () => {
  it("renders the stale list and the capped-count message when staleAddresses < staleCount", async () => {
    const streamed = [makeStaleRow(1), makeStaleRow(2), makeStaleRow(3)];

    // The real engine streams stale rows via onStaleBatch (which the card uses
    // to grow staleRowsCount) and reports an exact staleCount in its result.
    // Here staleCount (10) is deliberately larger than the streamed rows (3) to
    // trigger the "Showing the first N of M" capped caption.
    detectMock.mockImplementation(async (opts) => {
      if (opts.onStaleBatch) await opts.onStaleBatch(streamed);
      const result: StaleBalanceCheckResult = {
        sampled: 2000,
        staleCount: 10,
        staleAddresses: [],
        checkedAll: false,
        cancelled: false,
      };
      return result;
    });
    getWindowMock.mockResolvedValue(streamed);

    render(<BalanceIntegrityCard />);

    fireEvent.click(screen.getByTestId("button-run-balance-check"));

    // Verdict reflects the stale count.
    const verdict = await screen.findByTestId("text-balance-verdict");
    expect(verdict.textContent).toContain("10 of 2,000");
    expect(verdict.textContent).toContain("sampled");

    // The stale list itself is mounted.
    expect(screen.getByTestId("list-stale-addresses")).toBeTruthy();

    // The capped caption shows streamed (3) vs total (10).
    const caption = screen.getByTestId("text-stale-list-caption");
    expect(caption.textContent).toContain("Showing the first 3 of 10");

    // Recompute action is offered because the result is stale.
    expect(screen.getByTestId("button-recompute-balances")).toBeTruthy();
  });
});

describe("BalanceIntegrityCard - recompute and re-check", () => {
  it("transitions through recomputing and re-runs the check to a clean result", async () => {
    // First check finds stale rows; the re-check after recompute finds none.
    detectMock
      .mockImplementationOnce(async (opts) => {
        if (opts.onStaleBatch) await opts.onStaleBatch([makeStaleRow(1)]);
        return {
          sampled: 2000,
          staleCount: 1,
          staleAddresses: [],
          checkedAll: false,
          cancelled: false,
        } satisfies StaleBalanceCheckResult;
      })
      .mockImplementationOnce(async () => {
        return {
          sampled: 2000,
          staleCount: 0,
          staleAddresses: [],
          checkedAll: false,
          cancelled: false,
        } satisfies StaleBalanceCheckResult;
      });
    getWindowMock.mockResolvedValue([makeStaleRow(1)]);

    // Hold the recompute mid-flight so we can observe the "recomputing" state.
    const recomputeGate = deferred<void>();
    recomputeMock.mockImplementation(async (options) => {
      options?.onProgress?.({ processed: 5, total: 10 });
      await recomputeGate.promise;
      return { updated: 1, cancelled: false };
    });

    render(<BalanceIntegrityCard />);

    fireEvent.click(screen.getByTestId("button-run-balance-check"));

    // Wait for the first (stale) result and its Recompute button.
    const recomputeBtn = await screen.findByTestId("button-recompute-balances");

    fireEvent.click(recomputeBtn);

    // While the recompute promise is pending, the recomputing progress shows.
    const progress = await screen.findByTestId("text-balance-recompute-progress");
    expect(progress.textContent).toContain("Recomputing balances");
    expect(progress.textContent).toContain("5 of 10");

    // Let the recompute finish; the card then re-runs the check (2nd detect call).
    recomputeGate.resolve();

    // The re-check returns clean, so the verdict flips to the all-good message.
    await waitFor(() => {
      const verdict = screen.getByTestId("text-balance-verdict");
      expect(verdict.textContent).toContain("up-to-date cached balances");
    });

    // The check ran twice (initial + post-recompute re-check) with the same scope.
    expect(detectMock).toHaveBeenCalledTimes(2);
    expect(recomputeMock).toHaveBeenCalledTimes(1);
    // The recompute re-check used the same (sample) scope as the initial run.
    expect(detectMock.mock.calls[1][0].checkAll).toBe(false);

    // The Recompute button is gone now that nothing is stale.
    expect(screen.queryByTestId("button-recompute-balances")).toBeNull();
  });
});

describe("BalanceIntegrityCard - error state", () => {
  it("shows the error banner with the message when the balance check throws", async () => {
    detectMock.mockRejectedValue(new Error("scan engine exploded"));

    render(<BalanceIntegrityCard />);

    fireEvent.click(screen.getByTestId("button-run-balance-check"));

    const banner = await screen.findByTestId("banner-balance-error");
    expect(banner.textContent).toContain("scan engine exploded");

    // No success/result banner is shown when the check failed.
    expect(screen.queryByTestId("banner-balance-result")).toBeNull();
  });

  it("shows the error banner when recompute throws", async () => {
    // First check finds a stale row so the Recompute button is offered.
    detectMock.mockImplementation(async (opts) => {
      if (opts.onStaleBatch) await opts.onStaleBatch([makeStaleRow(1)]);
      return {
        sampled: 2000,
        staleCount: 1,
        staleAddresses: [],
        checkedAll: false,
        cancelled: false,
      } satisfies StaleBalanceCheckResult;
    });
    getWindowMock.mockResolvedValue([makeStaleRow(1)]);
    recomputeMock.mockRejectedValue(new Error("recompute blew up"));

    render(<BalanceIntegrityCard />);

    fireEvent.click(screen.getByTestId("button-run-balance-check"));

    const recomputeBtn = await screen.findByTestId("button-recompute-balances");
    fireEvent.click(recomputeBtn);

    const banner = await screen.findByTestId("banner-balance-error");
    expect(banner.textContent).toContain("recompute blew up");
  });
});

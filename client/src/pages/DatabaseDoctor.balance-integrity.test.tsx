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

describe("BalanceIntegrityCard - cancelling an in-flight check", () => {
  it("returns to the idle state without a verdict when a sample check is cancelled mid-flight", async () => {
    // Hold the detect call in flight so Cancel is clicked while it is pending.
    const detectGate = deferred<StaleBalanceCheckResult>();
    detectMock.mockImplementation(async (opts) => {
      opts.onProgress?.(50, 2000);
      return detectGate.promise;
    });

    render(<BalanceIntegrityCard />);

    fireEvent.click(screen.getByTestId("button-run-balance-check"));

    // The scan is running: the Cancel button appears while detect is pending.
    const cancelBtn = await screen.findByTestId("button-cancel-balance-check");
    expect(screen.queryByTestId("text-balance-idle")).toBeNull();

    fireEvent.click(cancelBtn);

    // Cancel immediately resets the card to idle.
    await screen.findByTestId("text-balance-idle");
    expect(screen.queryByTestId("text-balance-verdict")).toBeNull();
    expect(screen.queryByTestId("banner-balance-result")).toBeNull();
    expect(screen.queryByTestId("text-balance-progress")).toBeNull();

    // Even when the now-aborted scan resolves, no stale verdict leaks through.
    detectGate.resolve({
      sampled: 2000,
      staleCount: 7,
      staleAddresses: [],
      checkedAll: false,
      cancelled: true,
    });

    await waitFor(() => {
      expect(screen.getByTestId("text-balance-idle")).toBeTruthy();
    });
    expect(screen.queryByTestId("text-balance-verdict")).toBeNull();
    expect(screen.queryByTestId("banner-balance-result")).toBeNull();
    expect(screen.queryByTestId("button-recompute-balances")).toBeNull();
  });

  it("returns to the idle state without a verdict when a full scan is cancelled mid-flight", async () => {
    const detectGate = deferred<StaleBalanceCheckResult>();
    detectMock.mockImplementation(async (opts) => {
      opts.onProgress?.(120, 500);
      return detectGate.promise;
    });

    render(<BalanceIntegrityCard />);

    fireEvent.click(screen.getByTestId("button-check-all-balances"));

    const cancelBtn = await screen.findByTestId("button-cancel-balance-check");
    expect(detectMock.mock.calls[0][0].checkAll).toBe(true);

    fireEvent.click(cancelBtn);

    await screen.findByTestId("text-balance-idle");
    expect(screen.queryByTestId("text-balance-verdict")).toBeNull();
    expect(screen.queryByTestId("banner-balance-result")).toBeNull();
    expect(screen.queryByTestId("text-balance-progress")).toBeNull();

    // Resolving the aborted full scan must not surface a verdict either.
    detectGate.resolve({
      sampled: 500,
      staleCount: 3,
      staleAddresses: [],
      checkedAll: true,
      cancelled: true,
    });

    await waitFor(() => {
      expect(screen.getByTestId("text-balance-idle")).toBeTruthy();
    });
    expect(screen.queryByTestId("text-balance-verdict")).toBeNull();
    expect(screen.queryByTestId("banner-balance-result")).toBeNull();
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

describe("BalanceIntegrityCard - check all addresses (full scan)", () => {
  it("shows the full-scan progress wording and a 'synced' done verdict", async () => {
    // Hold the detect call in flight so we can observe the checking progress.
    const detectGate = deferred<StaleBalanceCheckResult>();
    detectMock.mockImplementation(async (opts) => {
      // Report progress with a total so the optional "of <total>" appears.
      opts.onProgress?.(120, 500);
      return detectGate.promise;
    });

    render(<BalanceIntegrityCard />);

    fireEvent.click(screen.getByTestId("button-check-all-balances"));

    // While the scan runs, the full-scan wording (with "of <total>") shows.
    const progress = await screen.findByTestId("text-balance-progress");
    expect(progress.textContent).toContain("Checking all addresses…");
    expect(progress.textContent).toContain("120 of 500 scanned so far.");

    // The scan was launched in full-table mode.
    expect(detectMock).toHaveBeenCalledTimes(1);
    expect(detectMock.mock.calls[0][0].checkAll).toBe(true);

    // Finish the scan: a clean, full-table result (checkedAll: true).
    detectGate.resolve({
      sampled: 500,
      staleCount: 0,
      staleAddresses: [],
      checkedAll: true,
      cancelled: false,
    });

    // The done verdict uses "synced" wording (not "sampled") for a full scan.
    await waitFor(() => {
      const verdict = screen.getByTestId("text-balance-verdict");
      expect(verdict.textContent).toContain("All 500 synced addresses");
      expect(verdict.textContent).not.toContain("sampled");
    });
  });

  it("re-runs the post-recompute check with checkAll=true (same scope picked)", async () => {
    // First full scan finds a stale row; the re-check after recompute is clean.
    detectMock
      .mockImplementationOnce(async (opts) => {
        if (opts.onStaleBatch) await opts.onStaleBatch([makeStaleRow(1)]);
        return {
          sampled: 500,
          staleCount: 1,
          staleAddresses: [],
          checkedAll: true,
          cancelled: false,
        } satisfies StaleBalanceCheckResult;
      })
      .mockImplementationOnce(async () => {
        return {
          sampled: 500,
          staleCount: 0,
          staleAddresses: [],
          checkedAll: true,
          cancelled: false,
        } satisfies StaleBalanceCheckResult;
      });
    getWindowMock.mockResolvedValue([makeStaleRow(1)]);
    recomputeMock.mockResolvedValue({ updated: 1, cancelled: false });

    render(<BalanceIntegrityCard />);

    fireEvent.click(screen.getByTestId("button-check-all-balances"));

    // The first full scan reports the stale verdict in "synced" wording.
    await waitFor(() => {
      const verdict = screen.getByTestId("text-balance-verdict");
      expect(verdict.textContent).toContain("1 of 500 synced addresses");
    });

    fireEvent.click(await screen.findByTestId("button-recompute-balances"));

    // After recompute, the re-check flips the verdict to clean (still "synced").
    await waitFor(() => {
      const verdict = screen.getByTestId("text-balance-verdict");
      expect(verdict.textContent).toContain("up-to-date cached balances");
    });

    // The check ran twice and the re-check used the full-table scope (checkAll=true).
    expect(detectMock).toHaveBeenCalledTimes(2);
    expect(detectMock.mock.calls[0][0].checkAll).toBe(true);
    expect(detectMock.mock.calls[1][0].checkAll).toBe(true);
    expect(recomputeMock).toHaveBeenCalledTimes(1);
  });
});

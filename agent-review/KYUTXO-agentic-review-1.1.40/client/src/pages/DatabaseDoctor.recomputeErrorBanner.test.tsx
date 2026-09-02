// @vitest-environment jsdom
//
// Tests for the BalanceIntegrityCard recompute error-banner robustness.
//
// #1043: A full-table Recompute that errors mid-rebuild (after onProgress has
//        already fired) must land on the balance-error banner, not stay frozen
//        on the "Recomputing… N of M" progress line.
//
// #1052: When the Recompute pass itself succeeds but the follow-up re-check
//        then throws (e.g. the stale-report scratch store is unavailable), the
//        error banner must still be surfaced. Before the fix, the error was
//        swallowed because the re-check (runCheck) aborts the shared controller
//        at its start, which caused the catch block to misread the situation as
//        a user-initiated cancel and reset to idle.

import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type {
  StaleBalanceCheckResult,
  StaleAddressDetail,
} from "@/lib/data/address-stats";

vi.mock("@/lib/data/address-stats", () => ({
  detectStaleCachedBalances: vi.fn(),
  recomputeAddressStats: vi.fn(),
}));

// Mock the stale-balance-report-store so we can control clearStaleReport
// (called inside runCheck). A throwing clearStaleReport is the cheapest way
// to reproduce the post-recompute re-check failure scenario (#1052).
const clearStaleReportMock = vi.fn(async () => {});
vi.mock("@/lib/data/stale-balance-report-store", () => ({
  clearStaleReport: (...args: unknown[]) => clearStaleReportMock(...args),
  appendStaleReportRows: vi.fn(async () => {}),
  getStaleReportWindow: vi.fn(async () => [] as StaleAddressDetail[]),
  exportStaleReport: vi.fn(async () => ({ blob: new Blob(), rowCount: 0 })),
}));

import { BalanceIntegrityCard } from "./DatabaseDoctor";
import {
  detectStaleCachedBalances,
  recomputeAddressStats,
} from "@/lib/data/address-stats";

const detectMock = vi.mocked(detectStaleCachedBalances);
const recomputeMock = vi.mocked(recomputeAddressStats);

// A stale check result with one stale address — just enough for the
// "Recompute" button to appear.
const STALE_RESULT: StaleBalanceCheckResult = {
  sampled: 100,
  staleCount: 1,
  staleAddresses: [],
  checkedAll: false,
  cancelled: false,
};

beforeAll(() => {
  // @tanstack/react-virtual needs ResizeObserver + real dimensions in jsdom.
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  // clearStaleReport succeeds by default; tests override as needed.
  clearStaleReportMock.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe("BalanceIntegrityCard - recompute error-banner robustness", () => {
  it("shows the error banner when recomputeAddressStats throws mid-rebuild (#1043)", async () => {
    // First check → stale results so the Recompute button appears.
    detectMock.mockResolvedValueOnce(STALE_RESULT);
    // Recompute throws (e.g. a mid-rebuild DB failure).
    recomputeMock.mockRejectedValue(new Error("disk full during recompute"));

    render(<BalanceIntegrityCard />);

    fireEvent.click(screen.getByTestId("button-run-balance-check"));
    await screen.findByTestId("button-recompute-balances");

    fireEvent.click(screen.getByTestId("button-recompute-balances"));

    // The error banner must appear with the error message.
    const banner = await screen.findByTestId("banner-balance-error");
    expect(banner.textContent).toContain("disk full during recompute");
    // The "Recomputing… N of M" progress line must be gone.
    expect(screen.queryByTestId("text-balance-recompute-progress")).toBeNull();
  });

  it("shows the error banner when the post-recompute re-check fails (#1052)", async () => {
    // First check → stale results so the Recompute button appears.
    detectMock.mockResolvedValueOnce(STALE_RESULT);
    // Recompute succeeds.
    recomputeMock.mockResolvedValue({ updated: 1, cancelled: false });
    // The re-check's clearStaleReport throws on its second invocation.
    // Call #1: triggered by "Run balance check" click (succeeds).
    // Call #2: triggered by the post-recompute re-check inside runCheck (throws).
    clearStaleReportMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("report store unavailable"));

    render(<BalanceIntegrityCard />);

    fireEvent.click(screen.getByTestId("button-run-balance-check"));
    await screen.findByTestId("button-recompute-balances");

    fireEvent.click(screen.getByTestId("button-recompute-balances"));

    // The error banner must appear, surfacing the re-check failure.
    const banner = await screen.findByTestId("banner-balance-error");
    expect(banner.textContent).toContain("report store unavailable");
    // No stale progress line from the now-finished recompute.
    expect(screen.queryByTestId("text-balance-recompute-progress")).toBeNull();
    // The card must not have silently reset to idle (that would hide the error).
    expect(screen.queryByTestId("text-balance-idle")).toBeNull();
  });
});

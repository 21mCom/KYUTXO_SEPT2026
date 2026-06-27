// @vitest-environment jsdom
//
// Component test for the BalanceIntegrityCard's error-recovery banner.
//
// The error banner (banner-balance-error) shows when detectStaleCachedBalances
// throws a non-abort error. It offers two recovery paths with no prior
// automated coverage:
//   - Retry (button-retry-balance-check) re-runs the LAST check at the same
//     sample-vs-full scope (lastCheckAllRef), for both "Run balance check"
//     (sampled) and "Check all addresses" (full-table).
//   - Dismiss (button-dismiss-balance-error) returns the card to idle
//     (text-balance-idle).
//
// address-stats is mocked so no real IndexedDB scan/recompute happens; the
// local scratch store is the real fake-indexeddb-backed one, matching the
// sibling BalanceIntegrityCard tests.

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { clearStaleReport } from "@/lib/data/stale-balance-report-store";
import {
  detectStaleCachedBalances,
  recomputeAddressStats,
} from "@/lib/data/address-stats";
import type { BalanceIntegrityCard as BalanceIntegrityCardType } from "./DatabaseDoctor";

vi.mock("@/lib/database", () => ({ db: {} }));
vi.mock("@/lib/data/address-stats", () => ({
  detectStaleCachedBalances: vi.fn(),
  recomputeAddressStats: vi.fn(),
}));
vi.mock("@/lib/legacy-decrypt", () => ({ isEncryptedPlaceholder: () => false }));

let BalanceIntegrityCard: typeof BalanceIntegrityCardType;

beforeAll(async () => {
  ({ BalanceIntegrityCard } = await import("./DatabaseDoctor"));
});

const detectMock = vi.mocked(detectStaleCachedBalances);
const recomputeMock = vi.mocked(recomputeAddressStats);

// A detect implementation that always rejects with a non-abort error so the
// card lands in the error state. It records the scope it was called with.
function makeFailingDetect(message = "scan blew up") {
  return (async (_opts: any): Promise<never> => {
    throw new Error(message);
  }) as unknown as typeof detectStaleCachedBalances;
}

beforeEach(async () => {
  await clearStaleReport();
  detectMock.mockReset();
  recomputeMock.mockReset();
  detectMock.mockImplementation(makeFailingDetect());
  recomputeMock.mockResolvedValue(undefined as any);
});

afterEach(() => cleanup());

describe("BalanceIntegrityCard error recovery", () => {
  it("shows the error banner with Retry and Dismiss when the check fails", async () => {
    render(<BalanceIntegrityCard />);

    fireEvent.click(screen.getByTestId("button-run-balance-check"));

    const banner = await screen.findByTestId("banner-balance-error");
    expect(banner).toBeTruthy();
    // The thrown message surfaces to the user.
    expect(banner.textContent).toContain("scan blew up");
    expect(screen.getByTestId("button-retry-balance-check")).toBeTruthy();
    expect(screen.getByTestId("button-dismiss-balance-error")).toBeTruthy();
    // No idle / verdict UI while the error is showing.
    expect(screen.queryByTestId("text-balance-idle")).toBeNull();
    expect(screen.queryByTestId("banner-balance-result")).toBeNull();
  });

  it("Retry re-runs the sampled check at the same scope (checkAll false)", async () => {
    render(<BalanceIntegrityCard />);

    fireEvent.click(screen.getByTestId("button-run-balance-check"));
    await screen.findByTestId("banner-balance-error");

    // The initial check called detect once at the sampled scope.
    await waitFor(() => expect(detectMock).toHaveBeenCalledTimes(1));
    expect((detectMock.mock.calls[0][0] as any).checkAll).toBe(false);

    detectMock.mockClear();
    fireEvent.click(screen.getByTestId("button-retry-balance-check"));

    // Retry repeats the last scope: sampled, not full-table.
    await waitFor(() => expect(detectMock).toHaveBeenCalledTimes(1));
    expect((detectMock.mock.calls[0][0] as any).checkAll).toBe(false);
    // Still failing, so the banner remains for another recovery attempt.
    expect(await screen.findByTestId("banner-balance-error")).toBeTruthy();
  });

  it("Retry re-runs the full-table check at the same scope (checkAll true)", async () => {
    render(<BalanceIntegrityCard />);

    fireEvent.click(screen.getByTestId("button-check-all-balances"));
    await screen.findByTestId("banner-balance-error");

    await waitFor(() => expect(detectMock).toHaveBeenCalledTimes(1));
    expect((detectMock.mock.calls[0][0] as any).checkAll).toBe(true);

    detectMock.mockClear();
    fireEvent.click(screen.getByTestId("button-retry-balance-check"));

    // Retry must repeat the full-table scope the user originally chose.
    await waitFor(() => expect(detectMock).toHaveBeenCalledTimes(1));
    expect((detectMock.mock.calls[0][0] as any).checkAll).toBe(true);
  });

  it("Retry that now succeeds replaces the error banner with a verdict", async () => {
    render(<BalanceIntegrityCard />);

    fireEvent.click(screen.getByTestId("button-run-balance-check"));
    await screen.findByTestId("banner-balance-error");

    // Make the next run succeed with a clean verdict.
    detectMock.mockImplementation(
      (async (opts: any) => ({
        sampled: 0,
        staleCount: 0,
        staleAddresses: [],
        checkedAll: !!opts?.checkAll,
        cancelled: false,
      })) as unknown as typeof detectStaleCachedBalances,
    );

    fireEvent.click(screen.getByTestId("button-retry-balance-check"));

    await waitFor(() => {
      expect(screen.getByTestId("banner-balance-result")).toBeTruthy();
    });
    expect(screen.queryByTestId("banner-balance-error")).toBeNull();
  });

  it("Dismiss returns the card to the idle state", async () => {
    render(<BalanceIntegrityCard />);

    fireEvent.click(screen.getByTestId("button-run-balance-check"));
    await screen.findByTestId("banner-balance-error");

    fireEvent.click(screen.getByTestId("button-dismiss-balance-error"));

    await waitFor(() => {
      expect(screen.getByTestId("text-balance-idle")).toBeTruthy();
    });
    // Dismiss must clear the error banner and leave no verdict behind.
    expect(screen.queryByTestId("banner-balance-error")).toBeNull();
    expect(screen.queryByTestId("banner-balance-result")).toBeNull();
    // Dismiss is purely local state — it must not kick off another scan.
    expect(detectMock).toHaveBeenCalledTimes(1);
  });
});

// @vitest-environment jsdom
//
// Component test for the BalanceIntegrityCard's recompute-selected wiring.
//
// Task #550 covered the presentational StaleAddressList (checkboxes, select-all,
// selected state). This test covers the *card* that owns the selection state and
// drives the recompute:
//   - ticking a subset of stale rows and clicking "Recompute selected (N)" calls
//     recomputeAddressStats with exactly the chosen recordIds and origin "user"
//   - the selection is cleared when a fresh "Run balance check" runs
//
// address-stats is mocked so no real IndexedDB scan/recompute happens; the local
// scratch store is the real fake-indexeddb-backed one (the card streams stale
// rows into it and the virtualized list reads windows back from it on demand),
// matching DatabaseDoctor.staleList.test.tsx.

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { clearStaleReport } from "@/lib/data/stale-balance-report-store";
import {
  detectStaleCachedBalances,
  recomputeAddressStats,
  type StaleAddressDetail,
  type StaleBalanceCheckResult,
} from "@/lib/data/address-stats";
import type { BalanceIntegrityCard as BalanceIntegrityCardType } from "./DatabaseDoctor";

// DatabaseDoctor.tsx pulls in the IndexedDB-backed db and the heavy stats module.
// The card only needs the stats functions, which we mock, and the db, which it
// never touches in this flow.
vi.mock("@/lib/database", () => ({ db: {} }));
vi.mock("@/lib/data/address-stats", () => ({
  detectStaleCachedBalances: vi.fn(),
  recomputeAddressStats: vi.fn(),
}));
vi.mock("@/lib/legacy-decrypt", () => ({ isEncryptedPlaceholder: () => false }));

// @tanstack/react-virtual needs ResizeObserver and real element dimensions to
// emit virtual rows. jsdom provides neither, so shim them; without this the
// virtualized stale list would render zero rows and there would be nothing to
// tick.
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

let BalanceIntegrityCard: typeof BalanceIntegrityCardType;

beforeAll(async () => {
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

  ({ BalanceIntegrityCard } = await import("./DatabaseDoctor"));
});

const staleRows: StaleAddressDetail[] = [
  { recordId: 11, address: "addr-eleven", cachedSats: 0, computedSats: 1000 },
  { recordId: 22, address: "addr-twenty-two", cachedSats: 50, computedSats: 2000 },
];

const detectMock = vi.mocked(detectStaleCachedBalances);
const recomputeMock = vi.mocked(recomputeAddressStats);

// A detect implementation that streams the stale rows to the card's onStaleBatch
// (which spools them to the scratch store) and reports a stale verdict. The
// `checkedAll` flag mirrors the lever the card chose so we can assert the
// re-check scope.
function makeDetectImpl(rows: StaleAddressDetail[]) {
  return (async (opts: any): Promise<StaleBalanceCheckResult> => {
    if (opts?.onStaleBatch) await opts.onStaleBatch(rows);
    return {
      sampled: rows.length,
      staleCount: rows.length,
      staleAddresses: [],
      checkedAll: !!opts?.checkAll,
      cancelled: false,
    };
  }) as unknown as typeof detectStaleCachedBalances;
}

beforeEach(async () => {
  await clearStaleReport();
  detectMock.mockReset();
  recomputeMock.mockReset();
  detectMock.mockImplementation(makeDetectImpl(staleRows));
  recomputeMock.mockResolvedValue(undefined as any);
});

afterEach(() => cleanup());

// Run a balance check and wait until the stale list has rendered its first row.
async function runCheckAndAwaitRows() {
  fireEvent.click(screen.getByTestId("button-run-balance-check"));
  await waitFor(() => {
    expect(screen.getByTestId("row-stale-address-11")).toBeTruthy();
  });
}

describe("BalanceIntegrityCard recompute-selected flow", () => {
  it("recomputes only the ticked rows with origin 'user'", async () => {
    render(<BalanceIntegrityCard />);

    await runCheckAndAwaitRows();

    // Tick a single row (the subset) and confirm the targeted button appears.
    fireEvent.click(await screen.findByTestId("checkbox-stale-11"));
    const recomputeSelected = await screen.findByTestId("button-recompute-selected");
    expect(recomputeSelected.textContent).toContain("Recompute selected (1)");

    // detect ran once for the initial check; clicking recompute-selected should
    // call recomputeAddressStats with exactly the chosen id, then re-check.
    detectMock.mockClear();
    fireEvent.click(recomputeSelected);

    await waitFor(() => {
      expect(recomputeMock).toHaveBeenCalledTimes(1);
    });
    const arg = recomputeMock.mock.calls[0][0] as any;
    expect(arg.origin).toBe("user");
    expect(arg.recordIds).toEqual([11]);

    // The post-recompute re-check repeats the original scope (sampled, not
    // checkAll) — the card remembered the lever the user pressed.
    await waitFor(() => {
      expect(detectMock).toHaveBeenCalledTimes(1);
    });
    expect((detectMock.mock.calls[0][0] as any).checkAll).toBe(false);
  });

  it("re-checking at the full-table scope recomputes selected rows at that scope", async () => {
    render(<BalanceIntegrityCard />);

    // Use the "Check all addresses" lever instead of the sampled one.
    fireEvent.click(screen.getByTestId("button-check-all-balances"));
    await waitFor(() => {
      expect(screen.getByTestId("row-stale-address-11")).toBeTruthy();
    });

    fireEvent.click(await screen.findByTestId("checkbox-stale-22"));
    const recomputeSelected = await screen.findByTestId("button-recompute-selected");

    detectMock.mockClear();
    fireEvent.click(recomputeSelected);

    await waitFor(() => {
      expect(recomputeMock).toHaveBeenCalledTimes(1);
    });
    expect((recomputeMock.mock.calls[0][0] as any).recordIds).toEqual([22]);

    // The re-check must repeat the full-table scope.
    await waitFor(() => {
      expect(detectMock).toHaveBeenCalledTimes(1);
    });
    expect((detectMock.mock.calls[0][0] as any).checkAll).toBe(true);
  });

  it("returns to idle without a verdict when a recompute is cancelled", async () => {
    // A recompute that never resolves on its own — it only settles once the
    // abort signal fires. This lets us click "Cancel" while the card is mid
    // recompute and prove the card unwinds cleanly.
    recomputeMock.mockImplementation(
      ((opts: any) =>
        new Promise<void>((resolve) => {
          if (opts?.signal?.aborted) {
            resolve();
            return;
          }
          opts?.signal?.addEventListener("abort", () => resolve());
        })) as unknown as typeof recomputeAddressStats,
    );

    render(<BalanceIntegrityCard />);

    await runCheckAndAwaitRows();

    // Pick a row and kick off the (stuck) recompute.
    fireEvent.click(await screen.findByTestId("checkbox-stale-11"));
    fireEvent.click(await screen.findByTestId("button-recompute-selected"));

    // The card is now recomputing: the progress line and Cancel button show.
    await waitFor(() => {
      expect(screen.getByTestId("text-balance-recompute-progress")).toBeTruthy();
    });
    const cancelButton = screen.getByTestId("button-cancel-balance-check");

    // Cancel mid-recompute: the card must drop back to idle, with no stale/clean
    // verdict banner left behind.
    fireEvent.click(cancelButton);

    await waitFor(() => {
      expect(screen.getByTestId("text-balance-idle")).toBeTruthy();
    });
    expect(screen.queryByTestId("banner-balance-result")).toBeNull();
    expect(screen.queryByTestId("text-balance-verdict")).toBeNull();
    expect(screen.queryByTestId("banner-balance-error")).toBeNull();
  });

  it("does not re-run the balance check when the recompute is aborted", async () => {
    // Same stuck-until-aborted recompute as above.
    recomputeMock.mockImplementation(
      ((opts: any) =>
        new Promise<void>((resolve) => {
          if (opts?.signal?.aborted) {
            resolve();
            return;
          }
          opts?.signal?.addEventListener("abort", () => resolve());
        })) as unknown as typeof recomputeAddressStats,
    );

    render(<BalanceIntegrityCard />);

    await runCheckAndAwaitRows();

    fireEvent.click(await screen.findByTestId("checkbox-stale-11"));

    // Clear the detect calls from the initial check so any later call can only be
    // the post-recompute re-check.
    detectMock.mockClear();

    fireEvent.click(await screen.findByTestId("button-recompute-selected"));
    await waitFor(() => {
      expect(recomputeMock).toHaveBeenCalledTimes(1);
    });

    // Cancel before the recompute could ever resolve on its own.
    fireEvent.click(screen.getByTestId("button-cancel-balance-check"));

    await waitFor(() => {
      expect(screen.getByTestId("text-balance-idle")).toBeTruthy();
    });

    // The aborted recompute must NOT trigger a fresh detect/re-check; otherwise
    // the card could report a stale verdict from work the user cancelled.
    expect(detectMock).not.toHaveBeenCalled();
  });

  it("leaves a full recompute (no selection) at idle with no verdict when cancelled", async () => {
    // The card also exposes a full-table "Recompute" button (no recordIds) that
    // shares the same AbortController handling as recompute-selected. A recompute
    // that only settles on abort lets us cancel mid-rebuild and prove the full
    // path unwinds just as cleanly.
    recomputeMock.mockImplementation(
      ((opts: any) =>
        new Promise<void>((resolve) => {
          if (opts?.signal?.aborted) {
            resolve();
            return;
          }
          opts?.signal?.addEventListener("abort", () => resolve());
        })) as unknown as typeof recomputeAddressStats,
    );

    render(<BalanceIntegrityCard />);

    // Run the check so stale rows exist and the full-table Recompute button shows.
    await runCheckAndAwaitRows();

    // Clear the detect calls from the initial check so any later call can only be
    // the post-recompute re-check.
    detectMock.mockClear();

    // Kick off the full recompute (no rows ticked) and confirm it ran with no
    // recordIds — i.e. the whole-table path, not the selected path.
    fireEvent.click(await screen.findByTestId("button-recompute-balances"));
    await waitFor(() => {
      expect(recomputeMock).toHaveBeenCalledTimes(1);
    });
    expect((recomputeMock.mock.calls[0][0] as any).recordIds).toBeUndefined();

    // The card is now recomputing: the progress line and Cancel button show.
    await waitFor(() => {
      expect(screen.getByTestId("text-balance-recompute-progress")).toBeTruthy();
    });

    // Cancel mid-recompute: the card must drop back to idle with no stale/clean
    // verdict banner and no error banner left behind.
    fireEvent.click(screen.getByTestId("button-cancel-balance-check"));

    await waitFor(() => {
      expect(screen.getByTestId("text-balance-idle")).toBeTruthy();
    });
    expect(screen.queryByTestId("banner-balance-result")).toBeNull();
    expect(screen.queryByTestId("text-balance-verdict")).toBeNull();
    expect(screen.queryByTestId("banner-balance-error")).toBeNull();

    // The aborted full recompute must NOT trigger a fresh detect/re-check; the
    // user cancelled, so no new verdict should be computed from that work.
    expect(detectMock).not.toHaveBeenCalled();
  });

  it("clears the selection when a fresh balance check is run", async () => {
    render(<BalanceIntegrityCard />);

    await runCheckAndAwaitRows();

    // Select rows so the targeted button is showing.
    fireEvent.click(await screen.findByTestId("checkbox-stale-11"));
    fireEvent.click(await screen.findByTestId("checkbox-stale-22"));
    await waitFor(() => {
      expect(screen.getByTestId("button-recompute-selected").textContent).toContain(
        "Recompute selected (2)",
      );
    });

    // A fresh check resets selectedIds to empty: the targeted button only renders
    // when something is selected, so its disappearance proves the reset.
    fireEvent.click(screen.getByTestId("button-run-balance-check"));
    await waitFor(() => {
      expect(screen.queryByTestId("button-recompute-selected")).toBeNull();
    });
    // The list itself still renders (the new check found the same stale rows),
    // confirming the button is gone because the selection cleared, not because
    // the list vanished.
    await waitFor(() => {
      expect(screen.getByTestId("row-stale-address-11")).toBeTruthy();
    });
  });
});

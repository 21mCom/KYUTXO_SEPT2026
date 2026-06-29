// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

// ---------------------------------------------------------------------------
// This test locks in the CANCEL path of the top-banner global
// "Resolve & Recompute" pass on the Balance Overview (Task #642 follow-up).
//
// When the user clicks "Stop resolving" mid-run, handleCancelFixPrevouts aborts
// the AbortController handed to resolvePrevouts. The resolve resolves with
// { cancelled: true } and whatever it managed to attribute (no rollback). The
// handler then:
//   - re-reads countUnresolvedPrevoutInputs so the banner count reflects the
//     partial progress, and
//   - the finally block clears fixingPrevouts/cancelling so the banner button
//     leaves its "Stopping…/Stop" spinner and returns to the idle
//     "Resolve & Recompute" label (re-enabled), with the cancel button gone.
//
// Without this coverage a regression could roll back resolved spends, leave the
// banner stuck on a spinner, or fail to refresh the unresolved count.
// ---------------------------------------------------------------------------

// @tanstack/react-virtual needs ResizeObserver and real element dimensions.
const FAKE_RECT: DOMRect = {
  width: 600,
  height: 384,
  top: 0,
  left: 0,
  right: 600,
  bottom: 384,
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
      return 384;
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
  if (!(navigator as any).clipboard) {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn() },
    });
  }
});

// --- toast capture --------------------------------------------------------
interface ToastCall {
  title?: string;
  description?: string;
  variant?: string;
}
const toastCalls: ToastCall[] = [];
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({
    toast: (args: ToastCall) => {
      toastCalls.push(args);
    },
    dismiss: vi.fn(),
    toasts: [],
  }),
}));

vi.mock("@/hooks/use-db-change-signal", () => ({
  useDbChangeSignal: () => 0,
}));

vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => undefined,
}));

const GROUP_NAME = "Wallet A";

const ENGINE_SUMMARY = {
  summaries: [
    { groupKey: GROUP_NAME, totalSats: 500_000, addressCount: 2, utxoCount: 2 },
  ],
  totals: { totalSats: 500_000, totalAddresses: 2, totalUtxos: 2 },
  staleAddressCount: 0,
};
vi.mock("@/lib/engine/engine-client", () => ({
  engineGetBalanceGroupSummaries: vi.fn(() => Promise.resolve(ENGINE_SUMMARY)),
  subscribeEngineReadiness: () => () => {},
}));
vi.mock("@/lib/engine/engine-freshness", () => ({
  evaluateEngineFreshness: vi.fn(() => Promise.resolve({ useEngine: true })),
}));

vi.mock("@/lib/data/address-stats", () => ({
  recomputeAddressStats: vi.fn(() => Promise.resolve({ cancelled: false })),
  countHeuristicMatchedAddresses: vi.fn(() => Promise.resolve(0)),
}));

vi.mock("@/lib/data/record-crud", () => ({
  countRecordsByType: vi.fn(() => Promise.resolve(2)),
  getRecordsPageByTypeIdReverseKeyset: vi.fn(() => Promise.resolve([])),
  getAddressBalanceRowsForGroup: vi.fn(() => Promise.resolve([])),
  getRecordsByIds: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/lib/balance-grouping", () => ({
  getGroupKeys: () => [],
}));

// The unresolved count starts high (banner renders) and DROPS after the cancel,
// so we can assert the count refreshes to reflect the partial progress. The
// first read (initial banner) returns 5; the read after the cancelled resolve
// returns 2 (3 were attributed before stop).
const UNRESOLVED_BEFORE = 5;
const UNRESOLVED_AFTER = 2;
const countUnresolvedPrevoutInputs = vi.fn();
vi.mock("@/lib/data/transaction-crud", () => ({
  countUnresolvedPrevoutInputs: (...args: unknown[]) =>
    countUnresolvedPrevoutInputs(...args),
  getUnresolvedSpendBreakdown: vi.fn(() =>
    Promise.resolve({ byRecordId: new Map(), unattributable: 0 }),
  ),
  getMissingSourceTxids: vi.fn(() => Promise.resolve([])),
  getMissingSourceTxidDetails: vi.fn(() => Promise.resolve([])),
}));

// resolvePrevouts is the seam: it stays pending until we manually resolve it,
// so the banner sits in its "Resolving…/Stop" state long enough for the cancel
// click. The mock captures the abort signal so the resolution can report
// cancelled === signal.aborted, mirroring the real implementation's contract.
let resolveDeferred: {
  resolve: (v: any) => void;
  promise: Promise<any>;
  signal?: AbortSignal;
};
const resolvePrevouts = vi.fn((_onProgress: unknown, options: any) => {
  let resolve!: (v: any) => void;
  const promise = new Promise<any>((r) => {
    resolve = r;
  });
  resolveDeferred = { resolve, promise, signal: options?.signal };
  return promise;
});
vi.mock("@/lib/transaction-sync", () => ({
  transactionSyncService: { resolvePrevouts },
}));

const BalanceOverview = (await import("./BalanceOverview")).default;

beforeEach(() => {
  toastCalls.length = 0;
  resolvePrevouts.mockClear();
  countUnresolvedPrevoutInputs.mockReset();
  // Default: every read returns the "before" count, except the post-cancel read
  // which we override per-test below.
  countUnresolvedPrevoutInputs.mockResolvedValue(UNRESOLVED_BEFORE);
});

afterEach(() => {
  cleanup();
});

describe("BalanceOverview global Resolve & Recompute — cancel", () => {
  it("returns the banner to idle and refreshes the unresolved count after a cancel", async () => {
    render(<BalanceOverview />);
    await screen.findByTestId("button-fix-prevouts");

    // Start the global resolve; it stays pending (deferred) so the banner shows
    // the cancel ("Stop resolving") button.
    fireEvent.click(screen.getByTestId("button-fix-prevouts"));
    const cancelBtn = await screen.findByTestId("button-cancel-fix-prevouts");
    expect(cancelBtn.textContent).toContain("Stop");

    // The handler handed resolvePrevouts an abort signal.
    await waitFor(() => expect(resolvePrevouts).toHaveBeenCalledTimes(1));
    expect(resolveDeferred.signal).toBeInstanceOf(AbortSignal);
    expect(resolveDeferred.signal?.aborted).toBe(false);

    // Click "Stop resolving" → the handler aborts the signal.
    fireEvent.click(cancelBtn);
    await waitFor(() => expect(resolveDeferred.signal?.aborted).toBe(true));

    // The post-cancel count read reflects the partial progress (dropped to 2).
    countUnresolvedPrevoutInputs.mockResolvedValue(UNRESOLVED_AFTER);

    // The resolve settles as cancelled, keeping the 3 spends it attributed
    // before the abort (no rollback).
    resolveDeferred.resolve({
      resolved: 3,
      fetchedFromNode: 3,
      errors: 0,
      resolvedAddresses: [],
      cancelled: true,
    });

    // The banner returns to idle: button shows the actionable label again, is
    // re-enabled, and the cancel button is gone.
    await waitFor(() => {
      const btn = screen.getByTestId("button-fix-prevouts");
      expect(btn.textContent).toContain("Resolve & Recompute");
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.queryByTestId("button-cancel-fix-prevouts")).toBeNull();

    // The unresolved count refreshed to the partial-progress value, so the
    // banner copy reflects what's still pending after the stop.
    await waitFor(() => {
      const banner = screen.getByTestId("banner-spend-warning");
      expect(banner.textContent).toContain(`${UNRESOLVED_AFTER} spends`);
    });

    // A "Resolve stopped" toast reports the partial outcome.
    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("Resolve stopped");
    expect(toastCalls[0].description).toContain("3");
  });
});

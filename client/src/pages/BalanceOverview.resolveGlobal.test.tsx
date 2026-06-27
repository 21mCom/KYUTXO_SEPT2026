// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

// ---------------------------------------------------------------------------
// These tests lock in the FAILURE path of the top-banner global
// "Resolve & Recompute" pass on the Balance Overview. handleFixPrevouts calls
// transactionSyncService.resolvePrevouts inside try/catch/finally; when that
// call rejects, the catch must surface a destructive "Resolve failed" toast and
// the finally must clear the resolving state so the banner button leaves its
// "Resolving…/Stop" spinner and returns to the actionable "Resolve & Recompute"
// label (re-enabled). Without this coverage the global pass could silently
// regress, leaving users with a stuck spinner and no feedback.
//
// We drive the real BalanceOverview component through its engine fast path so we
// never touch the Dexie aggregation scan: evaluateEngineFreshness reports the
// mirror is fresh and engineGetBalanceGroupSummaries returns a single group with
// no stale addresses, which is enough to reach phase "ready". countUnresolved-
// PrevoutInputs returns a positive count so the spend-warning banner (and its
// "Resolve & Recompute" button) render.
// ---------------------------------------------------------------------------

// @tanstack/react-virtual needs ResizeObserver and real element dimensions to
// emit virtual rows. jsdom provides neither, so without these shims the
// virtualized address list would render zero rows.
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

// Price data — the component reads it via useLiveQuery; return nothing.
vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => undefined,
}));

const GROUP_NAME = "Wallet A";

// Engine fast path: claim the mirror is fresh and return one group with zero
// stale addresses so the component renders without the Dexie aggregation scan.
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

// A positive unresolved count makes the spend-warning banner render, which is
// what carries the global "Resolve & Recompute" button. unattributable is 0 so
// the import/missing buttons stay hidden — only the global resolve is in play.
const UNRESOLVED_COUNT = 5;
vi.mock("@/lib/data/transaction-crud", () => ({
  countUnresolvedPrevoutInputs: vi.fn(() => Promise.resolve(UNRESOLVED_COUNT)),
  getUnresolvedSpendBreakdown: vi.fn(() =>
    Promise.resolve({ byRecordId: new Map(), unattributable: 0 }),
  ),
  getMissingSourceTxids: vi.fn(() => Promise.resolve([])),
  getMissingSourceTxidDetails: vi.fn(() => Promise.resolve([])),
}));

// resolvePrevouts is the seam: the global pass rejects so we can assert the
// failure toast + state cleanup. A test can override the rejection error to
// exercise the connectivity vs. internal-error messaging.
let resolveShouldReject: boolean;
let resolveRejectError: unknown;
const resolvePrevouts = vi.fn(() => {
  if (resolveShouldReject) {
    return Promise.reject(resolveRejectError ?? new Error("node unreachable"));
  }
  return Promise.resolve({
    resolved: 0,
    fetchedFromNode: 0,
    errors: 0,
    resolvedAddresses: [],
    cancelled: false,
  });
});
vi.mock("@/lib/transaction-sync", () => ({
  transactionSyncService: { resolvePrevouts },
}));

const BalanceOverview = (await import("./BalanceOverview")).default;

async function renderAndShowGlobalResolve() {
  render(<BalanceOverview />);
  // The banner (and its global resolve button) render once the unresolved
  // count effect lands a positive value.
  await screen.findByTestId("button-fix-prevouts");
}

beforeEach(() => {
  toastCalls.length = 0;
  resolvePrevouts.mockClear();
  resolveShouldReject = false;
  resolveRejectError = undefined;
});

afterEach(() => {
  cleanup();
});

describe("BalanceOverview global Resolve & Recompute", () => {
  it("toasts 'Resolve failed' (destructive) and clears the resolving state when resolvePrevouts rejects", async () => {
    resolveShouldReject = true;
    await renderAndShowGlobalResolve();

    fireEvent.click(screen.getByTestId("button-fix-prevouts"));

    await waitFor(() => expect(resolvePrevouts).toHaveBeenCalledTimes(1));
    // The global pass passes a progress callback + recompute origin and no
    // record-id restriction (it spans every wallet).
    const [onProgress, options] = resolvePrevouts.mock.calls[0] as unknown as [unknown, any];
    expect(typeof onProgress).toBe("function");
    expect(options.recomputeOrigin).toBe("user");
    expect(options.restrictToRecordIds).toBeUndefined();

    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("Resolve failed");
    expect(toastCalls[0].variant).toBe("destructive");

    // The finally block must clear the resolving state so the banner button
    // leaves its "Resolving…/Stop" spinner and returns to the actionable
    // "Resolve & Recompute" label, re-enabled.
    await waitFor(() => {
      const btn = screen.getByTestId("button-fix-prevouts");
      expect(btn.textContent).toContain("Resolve & Recompute");
      expect(btn.textContent).not.toContain("Resolving…");
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    });
    // The "Stop resolving" cancel button must no longer be present.
    expect(screen.queryByTestId("button-cancel-fix-prevouts")).toBeNull();
  });

  it("surfaces a connectivity reason when the global resolve fails reaching the node", async () => {
    resolveShouldReject = true;
    resolveRejectError = new Error("connect ECONNREFUSED 127.0.0.1:8332");
    await renderAndShowGlobalResolve();

    fireEvent.click(screen.getByTestId("button-fix-prevouts"));

    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("Resolve failed");
    expect(toastCalls[0].variant).toBe("destructive");
    expect(toastCalls[0].description).toContain("Bitcoin node");
    expect(toastCalls[0].description).not.toContain("internal error");
  });

  it("surfaces an internal-error reason for a non-connectivity global failure", async () => {
    resolveShouldReject = true;
    resolveRejectError = new Error("Cannot read properties of undefined (reading 'vout')");
    await renderAndShowGlobalResolve();

    fireEvent.click(screen.getByTestId("button-fix-prevouts"));

    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("Resolve failed");
    expect(toastCalls[0].variant).toBe("destructive");
    expect(toastCalls[0].description).toContain("internal error");
    expect(toastCalls[0].description).not.toContain("Bitcoin node");
  });
});

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
//
// The success-path tests need the unresolved count to *change* across the
// resolve: it must be positive at mount (so the banner renders) and then take a
// configurable follow-up value once handleFixPrevouts re-reads it after
// resolvePrevouts succeeds. We gate on the `resolveCalled` flag (flipped inside
// the resolvePrevouts mock) so the mount-time count effect always sees the
// positive value and only the post-resolve re-read sees followUpUnresolvedCount.
const UNRESOLVED_COUNT = 5;
let resolveCalled = false;
let followUpUnresolvedCount = UNRESOLVED_COUNT;
const countUnresolvedPrevoutInputs = vi.fn(() =>
  Promise.resolve(resolveCalled ? followUpUnresolvedCount : UNRESOLVED_COUNT),
);
vi.mock("@/lib/data/transaction-crud", () => ({
  countUnresolvedPrevoutInputs,
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
// When set, resolvePrevouts returns this still-pending promise instead of
// resolving immediately, letting a test hold the global pass open across a
// Stop click and then settle it with cancelled: true.
let resolveHeld: {
  promise: Promise<unknown>;
  settle: (value: unknown) => void;
} | null;
// The success path returns a configurable { resolved, cancelled } payload so each
// of handleFixPrevouts' four success branches can be exercised in turn.
let resolveResult: { resolved: number; cancelled: boolean };
const resolvePrevouts = vi.fn(() => {
  resolveCalled = true;
  if (resolveShouldReject) {
    return Promise.reject(resolveRejectError ?? new Error("node unreachable"));
  }
  if (resolveHeld) {
    return resolveHeld.promise;
  }
  return Promise.resolve({
    resolved: resolveResult.resolved,
    fetchedFromNode: 0,
    errors: 0,
    resolvedAddresses: [],
    cancelled: resolveResult.cancelled,
  });
});
vi.mock("@/lib/transaction-sync", () => ({
  transactionSyncService: { resolvePrevouts },
}));

function makeHeldResolve() {
  let settle: (value: unknown) => void = () => {};
  const promise = new Promise<unknown>((res) => {
    settle = res;
  });
  resolveHeld = { promise, settle };
  return resolveHeld;
}

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
  countUnresolvedPrevoutInputs.mockClear();
  resolveShouldReject = false;
  resolveRejectError = undefined;
  resolveHeld = null;
  resolveCalled = false;
  // Restore the default unresolved count; tests override followUpUnresolvedCount
  // after mount to assert the banner refreshes to the new value once the pass
  // (cancelled or completed) re-reads the count.
  followUpUnresolvedCount = UNRESOLVED_COUNT;
  resolveResult = { resolved: 0, cancelled: false };
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
    expect(toastCalls[0].description).toContain("Couldn't reach your Bitcoin node");
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
    expect(toastCalls[0].description).toContain("An internal error stopped the resolve");
    expect(toastCalls[0].description).not.toContain("Bitcoin node");
  });

  it("toasts 'Resolve stopped', keeps the spends already resolved, refreshes the unresolved count, and clears the resolving state when the user cancels mid-flight", async () => {
    // Hold the global pass open so we can click Stop while it is still running.
    const held = makeHeldResolve();
    await renderAndShowGlobalResolve();

    // The banner starts by reporting the original unresolved count.
    expect(screen.getByTestId("banner-spend-warning").textContent).toContain(
      `${UNRESOLVED_COUNT} spends`,
    );

    fireEvent.click(screen.getByTestId("button-fix-prevouts"));

    // Starting the pass swaps the button for the in-flight "Stop" control and
    // passes an abort signal the cancel handler can trip.
    const stopButton = await screen.findByTestId("button-cancel-fix-prevouts");
    const [, options] = resolvePrevouts.mock.calls[0] as unknown as [unknown, any];
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal.aborted).toBe(false);

    // Click Stop: this aborts the in-progress resolve. The button reflects the
    // stopping state and the underlying signal is now aborted.
    fireEvent.click(stopButton);
    expect(options.signal.aborted).toBe(true);
    await waitFor(() =>
      expect(
        screen.getByTestId("button-cancel-fix-prevouts").textContent,
      ).toContain("Stopping…"),
    );

    // The stopped pass refreshes the unresolved count to a new, lower value:
    // spends resolved before the abort are kept, so fewer remain pending. The
    // gated count mock returns this once the pass has started (resolveCalled).
    const REMAINING_AFTER_CANCEL = 3;
    followUpUnresolvedCount = REMAINING_AFTER_CANCEL;

    // Settle the held resolve as cancelled, reporting the spends resolved before
    // the user stopped (these are kept — no rollback).
    held.settle({
      resolved: 2,
      fetchedFromNode: 2,
      errors: 0,
      resolvedAddresses: [],
      cancelled: true,
    });

    // The cancellation path surfaces a non-destructive "Resolve stopped" toast
    // that names the spends kept and the refreshed remaining count.
    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("Resolve stopped");
    expect(toastCalls[0].variant).toBeUndefined();
    expect(toastCalls[0].description).toContain("resolving 2 spends");
    expect(toastCalls[0].description).toContain(
      `${REMAINING_AFTER_CANCEL} still pending`,
    );

    // The finally block clears the resolving state: the banner button returns to
    // the actionable "Resolve & Recompute" label (re-enabled) and the Stop
    // button is gone.
    await waitFor(() => {
      const btn = screen.getByTestId("button-fix-prevouts");
      expect(btn.textContent).toContain("Resolve & Recompute");
      expect(btn.textContent).not.toContain("Resolving…");
      expect(btn.textContent).not.toContain("Stopping…");
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.queryByTestId("button-cancel-fix-prevouts")).toBeNull();

    // The banner now reports the refreshed (lower) unresolved count, proving the
    // post-cancel count refresh propagated to the UI.
    expect(screen.getByTestId("banner-spend-warning").textContent).toContain(
      `${REMAINING_AFTER_CANCEL} spends`,
    );
  });

  // -------------------------------------------------------------------------
  // SUCCESS paths. After resolvePrevouts resolves, handleFixPrevouts re-reads
  // countUnresolvedPrevoutInputs and picks one of four toasts based on
  // { cancelled, resolved } and the fresh remaining count. We drive each branch
  // and confirm the re-check actually happened (the follow-up count read) plus
  // that the spend-warning banner clears only when the count reaches 0.
  // -------------------------------------------------------------------------

  it("re-checks the unresolved count and toasts 'Resolve stopped' when the pass was cancelled", async () => {
    resolveResult = { resolved: 2, cancelled: true };
    followUpUnresolvedCount = 3;
    await renderAndShowGlobalResolve();

    fireEvent.click(screen.getByTestId("button-fix-prevouts"));

    await waitFor(() => expect(resolvePrevouts).toHaveBeenCalledTimes(1));
    // The success branch must re-read the unresolved count: once on mount, then
    // again after resolvePrevouts resolves.
    await waitFor(() =>
      expect(countUnresolvedPrevoutInputs.mock.calls.length).toBeGreaterThanOrEqual(2),
    );

    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("Resolve stopped");
    expect(toastCalls[0].variant).toBeUndefined();
    expect(toastCalls[0].description).toContain("2");
    expect(toastCalls[0].description).toContain("3");

    // 3 still pending → banner stays up showing the refreshed count.
    await waitFor(() => {
      const banner = screen.getByTestId("banner-spend-warning");
      expect(banner.textContent).toContain("3 spends");
    });
  });

  it("re-checks the count and toasts a destructive 'Nothing to resolve' when nothing resolved", async () => {
    resolveResult = { resolved: 0, cancelled: false };
    followUpUnresolvedCount = UNRESOLVED_COUNT;
    await renderAndShowGlobalResolve();

    fireEvent.click(screen.getByTestId("button-fix-prevouts"));

    await waitFor(() => expect(resolvePrevouts).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(countUnresolvedPrevoutInputs.mock.calls.length).toBeGreaterThanOrEqual(2),
    );

    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("Nothing to resolve");
    expect(toastCalls[0].variant).toBe("destructive");

    // Nothing changed, so the banner is still present.
    expect(screen.queryByTestId("banner-spend-warning")).not.toBeNull();
  });

  it("re-checks the count and toasts 'Partially resolved' when some spends remain", async () => {
    resolveResult = { resolved: 4, cancelled: false };
    followUpUnresolvedCount = 1;
    await renderAndShowGlobalResolve();

    fireEvent.click(screen.getByTestId("button-fix-prevouts"));

    await waitFor(() => expect(resolvePrevouts).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(countUnresolvedPrevoutInputs.mock.calls.length).toBeGreaterThanOrEqual(2),
    );

    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("Partially resolved");
    expect(toastCalls[0].variant).toBeUndefined();
    expect(toastCalls[0].description).toContain("4");
    expect(toastCalls[0].description).toContain("1");

    // 1 still unattributable → banner stays up with the refreshed count.
    await waitFor(() => {
      const banner = screen.getByTestId("banner-spend-warning");
      expect(banner.textContent).toContain("1 spend");
    });
  });

  it("re-checks the count, toasts 'Resolved', and clears the banner when none remain", async () => {
    resolveResult = { resolved: 5, cancelled: false };
    followUpUnresolvedCount = 0;
    await renderAndShowGlobalResolve();

    fireEvent.click(screen.getByTestId("button-fix-prevouts"));

    await waitFor(() => expect(resolvePrevouts).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(countUnresolvedPrevoutInputs.mock.calls.length).toBeGreaterThanOrEqual(2),
    );

    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("Resolved");
    expect(toastCalls[0].variant).toBeUndefined();
    expect(toastCalls[0].description).toContain("5");

    // Count reached 0 → the spend-warning banner (and its global resolve
    // button) must disappear.
    await waitFor(() => {
      expect(screen.queryByTestId("banner-spend-warning")).toBeNull();
      expect(screen.queryByTestId("button-fix-prevouts")).toBeNull();
    });
  });
});

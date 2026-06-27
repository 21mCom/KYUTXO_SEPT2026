// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, act } from "@testing-library/react";

// ---------------------------------------------------------------------------
// These tests lock in the top-level "Resolve & Recompute" banner action on the
// Balance Overview. Unlike the per-wallet and per-address actions, this global
// action resolves EVERY pending spend across the whole database (no
// restrictToRecordIds) and surfaces live "Resolving… resolved/total" progress
// via resolveProgressGlobal plus an outcome toast:
//   1. handleFixPrevouts calls resolvePrevouts with recomputeOrigin "user" and
//      NO restrictToRecordIds (whole-database scope).
//   2. The three resolve outcomes surface the right toast: fully resolved,
//      partially resolved (some spends still unattributable), and nothing
//      resolved.
//   3. The in-button progress label updates from the onProgress callback while
//      the resolve is still in flight.
// We drive the real BalanceOverview through its engine fast path so we never
// touch the Dexie aggregation scan. The banner only renders once the spend
// health effect reports unresolvedPrevouts > 0, which countUnresolvedPrevoutInputs
// supplies on mount.
// ---------------------------------------------------------------------------

// @tanstack/react-virtual needs ResizeObserver and real element dimensions to
// emit virtual rows. jsdom provides neither.
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

const RECORD_ID_A = 101;
const RECORD_ID_B = 202;
const ADDRESS_A = "bc1qpendingaddraxxxxxxxxxxxxxxxxxxxxxxxxx";
const ADDRESS_B = "bc1qpendingaddrbxxxxxxxxxxxxxxxxxxxxxxxxx";
const COUNT_A = 3;
const COUNT_B = 2;
const TOTAL_PENDING = COUNT_A + COUNT_B; // 5 across the whole database

const ADDRESS_ROWS = [
  { id: RECORD_ID_A, address: ADDRESS_A, sats: 300_000, utxoCount: 1, label: "A" },
  { id: RECORD_ID_B, address: ADDRESS_B, sats: 200_000, utxoCount: 1, label: "B" },
];

vi.mock("@/lib/data/record-crud", () => ({
  countRecordsByType: vi.fn(() => Promise.resolve(2)),
  getRecordsPageByTypeIdReverseKeyset: vi.fn(() => Promise.resolve([])),
  getAddressBalanceRowsForGroup: vi.fn(() => Promise.resolve(ADDRESS_ROWS)),
  getRecordsByIds: vi.fn(() =>
    Promise.resolve([
      { id: RECORD_ID_A, address: ADDRESS_A },
      { id: RECORD_ID_B, address: ADDRESS_B },
    ]),
  ),
}));

vi.mock("@/lib/balance-grouping", () => ({
  getGroupKeys: () => [GROUP_NAME],
}));

// The global banner renders when countUnresolvedPrevoutInputs reports > 0 on
// mount. After the resolve runs, the SAME function reports how many spends are
// still pending; we switch its answer based on whether resolvePrevouts has been
// called yet so the outcome toast (fully/partially/nothing) can be asserted.
let remainingAfterResolve = 0;
const countUnresolvedPrevoutInputs = vi.fn(() =>
  Promise.resolve(resolvePrevouts.mock.calls.length === 0 ? TOTAL_PENDING : remainingAfterResolve),
);
vi.mock("@/lib/data/transaction-crud", () => ({
  countUnresolvedPrevoutInputs,
  getUnresolvedSpendBreakdown: vi.fn(() =>
    Promise.resolve({
      byRecordId: new Map([
        [RECORD_ID_A, COUNT_A],
        [RECORD_ID_B, COUNT_B],
      ]),
      unattributable: 0,
    }),
  ),
  getMissingSourceTxids: vi.fn(() => Promise.resolve([])),
}));

// resolvePrevouts is the seam we assert scoping on; its return value drives the
// outcome toast. A test can install a deferred to hold the call open and drive
// the onProgress callback while the button is still in its "Resolving…" state.
let resolveResult: { resolved: number };
let resolveDeferred: { promise: Promise<void>; resolve: () => void } | null;
let resolveShouldReject: boolean;
let resolveRejectError: unknown;
let lastOnProgress: ((resolved: number, total: number) => void) | undefined;
const resolvePrevouts = vi.fn((onProgress: any) => {
  lastOnProgress = onProgress;
  if (resolveShouldReject) {
    return Promise.reject(resolveRejectError ?? new Error("engine crashed mid-pass"));
  }
  const payload = {
    resolved: resolveResult.resolved,
    fetchedFromNode: 0,
    errors: 0,
    resolvedAddresses: [],
  };
  if (resolveDeferred) {
    return resolveDeferred.promise.then(() => payload);
  }
  return Promise.resolve(payload);
});
vi.mock("@/lib/transaction-sync", () => ({
  transactionSyncService: { resolvePrevouts },
}));

const BalanceOverview = (await import("./BalanceOverview")).default;

async function renderWithBanner() {
  render(<BalanceOverview />);
  // The global banner button only renders once the spend-health effect populates
  // unresolvedPrevouts (count > 0) from countUnresolvedPrevoutInputs.
  await screen.findByTestId("button-fix-prevouts");
}

beforeEach(() => {
  toastCalls.length = 0;
  resolvePrevouts.mockClear();
  countUnresolvedPrevoutInputs.mockClear();
  resolveResult = { resolved: 0 };
  resolveDeferred = null;
  resolveShouldReject = false;
  resolveRejectError = undefined;
  lastOnProgress = undefined;
  remainingAfterResolve = 0;
});

afterEach(() => {
  cleanup();
});

describe("BalanceOverview global Resolve & Recompute", () => {
  it("resolves the whole database (no restrictToRecordIds) with recomputeOrigin 'user'", async () => {
    resolveResult = { resolved: TOTAL_PENDING };
    await renderWithBanner();

    fireEvent.click(screen.getByTestId("button-fix-prevouts"));

    await waitFor(() => expect(resolvePrevouts).toHaveBeenCalledTimes(1));
    const [onProgress, options] = resolvePrevouts.mock.calls[0] as unknown as [unknown, any];
    // The global resolve passes a progress callback (drives resolveProgressGlobal).
    expect(typeof onProgress).toBe("function");
    expect(options.recomputeOrigin).toBe("user");
    // Whole-database scope: it must NOT restrict to any record ids.
    expect(options.restrictToRecordIds).toBeUndefined();
  });

  it("toasts 'Resolved' when every pending spend across all wallets is resolved", async () => {
    resolveResult = { resolved: TOTAL_PENDING };
    remainingAfterResolve = 0;
    await renderWithBanner();

    fireEvent.click(screen.getByTestId("button-fix-prevouts"));

    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("Resolved");
    expect(toastCalls[0].variant).toBeUndefined();
    expect(toastCalls[0].description).toContain("across all wallets");
  });

  it("toasts 'Partially resolved' when some spends remain unattributable", async () => {
    resolveResult = { resolved: 2 }; // resolved 2, 3 still pending
    remainingAfterResolve = 3;
    await renderWithBanner();

    fireEvent.click(screen.getByTestId("button-fix-prevouts"));

    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("Partially resolved");
    expect(toastCalls[0].description).toContain("3 still can't be attributed");
  });

  it("toasts 'Nothing to resolve' (destructive) when nothing resolves", async () => {
    resolveResult = { resolved: 0 };
    remainingAfterResolve = TOTAL_PENDING;
    await renderWithBanner();

    fireEvent.click(screen.getByTestId("button-fix-prevouts"));

    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("Nothing to resolve");
    expect(toastCalls[0].variant).toBe("destructive");
  });

  it("toasts 'Resolve failed' (destructive) and clears the in-button 'Resolving…' state when resolvePrevouts rejects", async () => {
    resolveShouldReject = true;
    await renderWithBanner();

    fireEvent.click(screen.getByTestId("button-fix-prevouts"));

    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("Resolve failed");
    expect(toastCalls[0].variant).toBe("destructive");

    // The finally block must clear fixingPrevouts so the banner button leaves
    // its "Resolving…" spinner and returns to the actionable label.
    await waitFor(() => {
      const btn = screen.getByTestId("button-fix-prevouts");
      expect(btn.textContent).toContain("Resolve & Recompute");
      expect(btn.textContent).not.toContain("Resolving…");
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("surfaces a connectivity reason when the global resolve fails reaching the node", async () => {
    resolveShouldReject = true;
    resolveRejectError = new Error("Network request timed out after 30s. Check your node connection.");
    await renderWithBanner();

    fireEvent.click(screen.getByTestId("button-fix-prevouts"));

    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("Resolve failed");
    expect(toastCalls[0].variant).toBe("destructive");
    expect(toastCalls[0].description).toContain("Bitcoin node");
    expect(toastCalls[0].description).not.toContain("internal error");
  });

  it("surfaces an internal-error reason for a non-connectivity global failure", async () => {
    resolveShouldReject = true;
    resolveRejectError = new Error("engine crashed mid-pass");
    await renderWithBanner();

    fireEvent.click(screen.getByTestId("button-fix-prevouts"));

    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("Resolve failed");
    expect(toastCalls[0].variant).toBe("destructive");
    expect(toastCalls[0].description).toContain("internal error");
    expect(toastCalls[0].description).not.toContain("Bitcoin node");
  });

  it("updates the in-button progress label from the onProgress callback while resolving", async () => {
    // Hold the resolve open so the button stays in its "Resolving…" state while
    // we drive progress through the captured onProgress callback.
    let release!: () => void;
    const promise = new Promise<void>((res) => {
      release = res;
    });
    resolveDeferred = { promise, resolve: release };
    resolveResult = { resolved: TOTAL_PENDING };
    remainingAfterResolve = 0;

    await renderWithBanner();

    fireEvent.click(screen.getByTestId("button-fix-prevouts"));

    // Wait until resolvePrevouts has been invoked and captured the callback.
    await waitFor(() => expect(lastOnProgress).toBeTypeOf("function"));

    const btn = screen.getByTestId("button-fix-prevouts");
    // Before any progress with total > 0, the label is the plain "Resolving…".
    expect(btn.textContent).toContain("Resolving…");
    expect(btn.textContent).not.toMatch(/\d+\/\d+/);

    // Drive a progress tick; the label should now show resolved/total.
    act(() => {
      lastOnProgress!(2, TOTAL_PENDING);
    });
    await waitFor(() =>
      expect(screen.getByTestId("button-fix-prevouts").textContent).toContain(
        `Resolving… 2/${TOTAL_PENDING}`,
      ),
    );

    // Advance progress again to confirm the label tracks subsequent ticks.
    act(() => {
      lastOnProgress!(4, TOTAL_PENDING);
    });
    await waitFor(() =>
      expect(screen.getByTestId("button-fix-prevouts").textContent).toContain(
        `Resolving… 4/${TOTAL_PENDING}`,
      ),
    );

    // Let the resolve finish so the outcome toast fires and state cleans up.
    await act(async () => {
      release();
      await promise;
    });
    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("Resolved");
  });
});

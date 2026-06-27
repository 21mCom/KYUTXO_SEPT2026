// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, act } from "@testing-library/react";

// ---------------------------------------------------------------------------
// These tests lock in the per-wallet (group-level) "Resolve" action on the
// Balance Overview. Unlike the per-address action, it scopes resolution to
// EVERY pending record id in the clicked group and surfaces live
// "Resolving… resolved/total" progress via resolvePrevouts' onProgress callback:
//   1. handleResolveGroup passes restrictToRecordIds = Set of every pending
//      record id for the group (not just one address).
//   2. The three resolve outcomes surface the right toast: fully resolved,
//      partially resolved (some spends unattributable), and nothing resolved.
//   3. The in-button progress label updates from the onProgress callback while
//      the resolve is still in flight.
// We drive the real BalanceOverview component through its engine fast path so we
// never touch the Dexie aggregation scan: evaluateEngineFreshness reports the
// mirror is fresh and engineGetBalanceGroupSummaries returns a single group with
// no stale addresses, which is enough to reach phase "ready".
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

// Two pending records, BOTH in GROUP_NAME. The group resolve must scope to the
// union of their record ids.
const RECORD_ID_A = 101;
const RECORD_ID_B = 202;
const ADDRESS_A = "bc1qpendingaddraxxxxxxxxxxxxxxxxxxxxxxxxx";
const ADDRESS_B = "bc1qpendingaddrbxxxxxxxxxxxxxxxxxxxxxxxxx";
const COUNT_A = 3;
const COUNT_B = 2;
const GROUP_TOTAL_PENDING = COUNT_A + COUNT_B; // 5

const ADDRESS_ROWS = [
  { id: RECORD_ID_A, address: ADDRESS_A, sats: 300_000, utxoCount: 1, label: "A" },
  { id: RECORD_ID_B, address: ADDRESS_B, sats: 200_000, utxoCount: 1, label: "B" },
];

// getRecordsByIds feeds the per-group rollup: each record is assigned to the
// group via getGroupKeys (mocked below).
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

// Both pending records belong to GROUP_NAME, so the group rollup sums their
// counts and unions their record ids.
vi.mock("@/lib/balance-grouping", () => ({
  getGroupKeys: () => [GROUP_NAME],
}));

vi.mock("@/lib/data/transaction-crud", () => ({
  countUnresolvedPrevoutInputs: vi.fn(() => Promise.resolve(0)),
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
    return Promise.reject(resolveRejectError ?? new Error("node unreachable"));
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

async function expandGroupAndShowResolve() {
  render(<BalanceOverview />);
  const expandBtn = await screen.findByTestId(`button-expand-${GROUP_NAME}`);
  fireEvent.click(expandBtn);
  // The per-group resolve button only renders once the breakdown effect has
  // populated unresolvedByGroup (count > 0) and the group is expanded.
  await screen.findByTestId(`button-resolve-${GROUP_NAME}`);
}

beforeEach(() => {
  toastCalls.length = 0;
  resolvePrevouts.mockClear();
  resolveResult = { resolved: 0 };
  resolveDeferred = null;
  resolveShouldReject = false;
  resolveRejectError = undefined;
  lastOnProgress = undefined;
});

afterEach(() => {
  cleanup();
});

describe("BalanceOverview per-wallet Resolve", () => {
  it("scopes resolution to every pending record id in the clicked group", async () => {
    resolveResult = { resolved: GROUP_TOTAL_PENDING };
    await expandGroupAndShowResolve();

    fireEvent.click(screen.getByTestId(`button-resolve-${GROUP_NAME}`));

    await waitFor(() => expect(resolvePrevouts).toHaveBeenCalledTimes(1));
    const [onProgress, options] = resolvePrevouts.mock.calls[0] as unknown as [unknown, any];
    // The group resolve DOES pass a progress callback (unlike per-address).
    expect(typeof onProgress).toBe("function");
    expect(options.recomputeOrigin).toBe("user");
    expect(options.restrictToRecordIds).toBeInstanceOf(Set);
    expect(Array.from(options.restrictToRecordIds as Set<number>).sort((a, b) => a - b)).toEqual([
      RECORD_ID_A,
      RECORD_ID_B,
    ]);
  });

  it("toasts 'Resolved' when every pending spend in the group is resolved", async () => {
    resolveResult = { resolved: GROUP_TOTAL_PENDING };
    await expandGroupAndShowResolve();

    fireEvent.click(screen.getByTestId(`button-resolve-${GROUP_NAME}`));

    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("Resolved");
    expect(toastCalls[0].variant).toBeUndefined();
    expect(toastCalls[0].description).toContain(`"${GROUP_NAME}"`);
  });

  it("toasts 'Partially resolved' when some spends remain unattributable", async () => {
    resolveResult = { resolved: 2 }; // 2 of 5 resolved -> 3 still pending
    await expandGroupAndShowResolve();

    fireEvent.click(screen.getByTestId(`button-resolve-${GROUP_NAME}`));

    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("Partially resolved");
    expect(toastCalls[0].description).toContain("3 still can't be attributed");
  });

  it("toasts 'Nothing to resolve' (destructive) when nothing resolves", async () => {
    resolveResult = { resolved: 0 };
    await expandGroupAndShowResolve();

    fireEvent.click(screen.getByTestId(`button-resolve-${GROUP_NAME}`));

    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("Nothing to resolve");
    expect(toastCalls[0].variant).toBe("destructive");
  });

  it("toasts 'Resolve failed' (destructive) and clears the resolving state when resolvePrevouts rejects", async () => {
    resolveShouldReject = true;
    await expandGroupAndShowResolve();

    fireEvent.click(screen.getByTestId(`button-resolve-${GROUP_NAME}`));

    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("Resolve failed");
    expect(toastCalls[0].variant).toBe("destructive");

    // The finally block must clear the resolving state so the button leaves its
    // "Resolving…" spinner and returns to the actionable "Resolve" label.
    await waitFor(() => {
      const btn = screen.getByTestId(`button-resolve-${GROUP_NAME}`);
      expect(btn.textContent).toContain("Resolve");
      expect(btn.textContent).not.toContain("Resolving…");
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("surfaces a connectivity reason when the group resolve fails reaching the node", async () => {
    resolveShouldReject = true;
    resolveRejectError = new Error("connect ECONNREFUSED 127.0.0.1:8332");
    await expandGroupAndShowResolve();

    fireEvent.click(screen.getByTestId(`button-resolve-${GROUP_NAME}`));

    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("Resolve failed");
    expect(toastCalls[0].variant).toBe("destructive");
    expect(toastCalls[0].description).toContain("Couldn't reach your Bitcoin node");
    expect(toastCalls[0].description).not.toContain("internal error");
  });

  it("surfaces an internal-error reason for a non-connectivity group failure", async () => {
    resolveShouldReject = true;
    resolveRejectError = new Error("Cannot read properties of undefined (reading 'vout')");
    await expandGroupAndShowResolve();

    fireEvent.click(screen.getByTestId(`button-resolve-${GROUP_NAME}`));

    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("Resolve failed");
    expect(toastCalls[0].variant).toBe("destructive");
    expect(toastCalls[0].description).toContain("An internal error stopped the resolve");
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
    resolveResult = { resolved: GROUP_TOTAL_PENDING };

    await expandGroupAndShowResolve();

    fireEvent.click(screen.getByTestId(`button-resolve-${GROUP_NAME}`));

    // Wait until resolvePrevouts has been invoked and captured the callback.
    await waitFor(() => expect(lastOnProgress).toBeTypeOf("function"));

    const btn = screen.getByTestId(`button-resolve-${GROUP_NAME}`);
    // Before any progress with total > 0, the label is the plain "Resolving…".
    expect(btn.textContent).toContain("Resolving…");
    expect(btn.textContent).not.toMatch(/\d+\/\d+/);

    // Drive a progress tick; the label should now show resolved/total.
    act(() => {
      lastOnProgress!(2, GROUP_TOTAL_PENDING);
    });
    await waitFor(() =>
      expect(screen.getByTestId(`button-resolve-${GROUP_NAME}`).textContent).toContain(
        `Resolving… 2/${GROUP_TOTAL_PENDING}`,
      ),
    );

    // Advance progress again to confirm the label tracks subsequent ticks.
    act(() => {
      lastOnProgress!(4, GROUP_TOTAL_PENDING);
    });
    await waitFor(() =>
      expect(screen.getByTestId(`button-resolve-${GROUP_NAME}`).textContent).toContain(
        `Resolving… 4/${GROUP_TOTAL_PENDING}`,
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

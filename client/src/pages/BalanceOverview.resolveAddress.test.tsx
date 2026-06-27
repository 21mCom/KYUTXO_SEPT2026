// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

// ---------------------------------------------------------------------------
// These tests lock in the per-address "Resolve" action on the Balance Overview:
//   1. handleResolveAddress scopes resolution to ONLY the clicked address's
//      record id (restrictToRecordIds === Set([recordId])).
//   2. The three resolve outcomes surface the right toast: fully resolved,
//      partially resolved (some spends unattributable), and nothing resolved.
//   3. The pending badge + Resolve button appear only for rows whose record id
//      has pending spends.
// We drive the real BalanceOverview component through its engine fast path so
// we never touch the Dexie aggregation scan: evaluateEngineFreshness reports the
// mirror is fresh and engineGetBalanceGroupSummaries returns a single group with
// no stale addresses, which is enough to reach phase "ready".
// ---------------------------------------------------------------------------

// @tanstack/react-virtual needs ResizeObserver and real element dimensions to
// emit virtual rows. jsdom provides neither, so without these shims the
// virtualized address list would render zero rows and the row assertions could
// never run.
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

// Engine fast path: claim the mirror is fresh and return one group with zero
// stale addresses so the component renders without the Dexie aggregation scan.
const ENGINE_SUMMARY = {
  summaries: [
    { groupKey: "Wallet A", totalSats: 500_000, addressCount: 2, utxoCount: 2 },
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

// Two addresses in the group. PENDING_RECORD_ID has pending spends; the other
// does not — exercising the conditional badge/button rendering.
const PENDING_RECORD_ID = 101;
const PENDING_ADDRESS = "bc1qpendingaddrxxxxxxxxxxxxxxxxxxxxxxxxx";
const CLEAN_RECORD_ID = 202;
const CLEAN_ADDRESS = "bc1qcleanaddrxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

const ADDRESS_ROWS = [
  { id: PENDING_RECORD_ID, address: PENDING_ADDRESS, sats: 300_000, utxoCount: 1, label: "Pending" },
  { id: CLEAN_RECORD_ID, address: CLEAN_ADDRESS, sats: 200_000, utxoCount: 1, label: "Clean" },
];

vi.mock("@/lib/data/record-crud", () => ({
  countRecordsByType: vi.fn(() => Promise.resolve(2)),
  getRecordsPageByTypeIdReverseKeyset: vi.fn(() => Promise.resolve([])),
  getAddressBalanceRowsForGroup: vi.fn(() => Promise.resolve(ADDRESS_ROWS)),
  getRecordsByIds: vi.fn(() => Promise.resolve([])),
}));

// getGroupKeys only feeds the group-level rollup (not the per-address rows), so
// returning [] keeps that path inert without affecting what we assert on.
vi.mock("@/lib/balance-grouping", () => ({
  getGroupKeys: () => [],
}));

// Number of unresolved spends pending attribution to PENDING_RECORD_ID. The
// per-address badge/button render off this map (keyed by record id === row id).
const PENDING_COUNT = 3;
vi.mock("@/lib/data/transaction-crud", () => ({
  countUnresolvedPrevoutInputs: vi.fn(() => Promise.resolve(0)),
  getUnresolvedSpendBreakdown: vi.fn(() =>
    Promise.resolve({
      byRecordId: new Map([[PENDING_RECORD_ID, PENDING_COUNT]]),
      unattributable: 0,
    }),
  ),
}));

// resolvePrevouts is the seam we assert scoping on; its return value drives the
// outcome toast. Each test overrides the resolved count via resolveResult.
let resolveResult: { resolved: number };
let resolveShouldReject: boolean;
const resolvePrevouts = vi.fn(() => {
  if (resolveShouldReject) {
    return Promise.reject(new Error("node unreachable"));
  }
  return Promise.resolve({ resolved: resolveResult.resolved, fetchedFromNode: 0, errors: 0, resolvedAddresses: [] });
});
vi.mock("@/lib/transaction-sync", () => ({
  transactionSyncService: { resolvePrevouts },
}));

const BalanceOverview = (await import("./BalanceOverview")).default;

async function expandGroupAndShowRows() {
  render(<BalanceOverview />);
  // Wait for the engine fast path to land us on the ready group card.
  const expandBtn = await screen.findByTestId("button-expand-Wallet A");
  fireEvent.click(expandBtn);
  // Address rows load lazily; wait for the pending row to appear.
  await screen.findByTestId(`row-address-${PENDING_ADDRESS}`);
}

beforeEach(() => {
  toastCalls.length = 0;
  resolvePrevouts.mockClear();
  resolveResult = { resolved: 0 };
  resolveShouldReject = false;
});

afterEach(() => {
  cleanup();
});

describe("BalanceOverview per-address Resolve", () => {
  it("shows the pending badge + Resolve button only for rows with pending spends", async () => {
    await expandGroupAndShowRows();

    // The pending address has both a badge and a Resolve button.
    expect(screen.getByTestId(`badge-address-unresolved-${PENDING_ADDRESS}`)).toBeTruthy();
    expect(screen.getByTestId(`button-resolve-address-${PENDING_ADDRESS}`)).toBeTruthy();

    // The clean address (row exists) has neither.
    expect(screen.getByTestId(`row-address-${CLEAN_ADDRESS}`)).toBeTruthy();
    expect(screen.queryByTestId(`badge-address-unresolved-${CLEAN_ADDRESS}`)).toBeNull();
    expect(screen.queryByTestId(`button-resolve-address-${CLEAN_ADDRESS}`)).toBeNull();
  });

  it("scopes resolution to only the clicked address's record id", async () => {
    resolveResult = { resolved: PENDING_COUNT };
    await expandGroupAndShowRows();

    fireEvent.click(screen.getByTestId(`button-resolve-address-${PENDING_ADDRESS}`));

    await waitFor(() => expect(resolvePrevouts).toHaveBeenCalledTimes(1));
    const [onProgress, options] = resolvePrevouts.mock.calls[0] as unknown as [unknown, any];
    // Per-address resolve passes a progress callback (it shows in-row progress).
    expect(typeof onProgress).toBe("function");
    expect(options.recomputeOrigin).toBe("user");
    expect(options.restrictToRecordIds).toBeInstanceOf(Set);
    expect(Array.from(options.restrictToRecordIds as Set<number>)).toEqual([PENDING_RECORD_ID]);
  });

  it("toasts 'Resolved' when every pending spend is resolved", async () => {
    resolveResult = { resolved: PENDING_COUNT };
    await expandGroupAndShowRows();

    fireEvent.click(screen.getByTestId(`button-resolve-address-${PENDING_ADDRESS}`));

    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("Resolved");
    expect(toastCalls[0].variant).toBeUndefined();
  });

  it("toasts 'Partially resolved' when some spends remain unattributable", async () => {
    resolveResult = { resolved: 1 }; // 1 of PENDING_COUNT resolved -> 2 still pending
    await expandGroupAndShowRows();

    fireEvent.click(screen.getByTestId(`button-resolve-address-${PENDING_ADDRESS}`));

    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("Partially resolved");
    expect(toastCalls[0].description).toContain("2 still can't be attributed");
  });

  it("toasts 'Nothing to resolve' (destructive) when nothing resolves", async () => {
    resolveResult = { resolved: 0 };
    await expandGroupAndShowRows();

    fireEvent.click(screen.getByTestId(`button-resolve-address-${PENDING_ADDRESS}`));

    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("Nothing to resolve");
    expect(toastCalls[0].variant).toBe("destructive");
  });

  it("toasts 'Resolve failed' (destructive) and clears the resolving state when resolvePrevouts rejects", async () => {
    resolveShouldReject = true;
    await expandGroupAndShowRows();

    fireEvent.click(screen.getByTestId(`button-resolve-address-${PENDING_ADDRESS}`));

    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("Resolve failed");
    expect(toastCalls[0].variant).toBe("destructive");

    // The finally block must clear the resolving state so the button leaves its
    // "Resolving…" spinner and returns to the actionable "Resolve" label.
    await waitFor(() => {
      const btn = screen.getByTestId(`button-resolve-address-${PENDING_ADDRESS}`);
      expect(btn.textContent).toContain("Resolve");
      expect(btn.textContent).not.toContain("Resolving…");
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    });
  });
});

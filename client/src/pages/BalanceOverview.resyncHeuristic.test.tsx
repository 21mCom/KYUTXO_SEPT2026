// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, act } from "@testing-library/react";

// ---------------------------------------------------------------------------
// These tests lock in the heuristic-mode banner's one-click "Re-sync
// addresses" action on the Balance Overview. The banner renders when
// countHeuristicMatchedAddresses returns a positive count; clicking the action
// must fetch the heuristic address list, verify a provider is configured and
// reachable, re-sync each address via transactionSyncService.syncSingleAddress,
// then recount and clear the banner when none remain. We also cover the
// no-provider guard so the action fails non-destructively.
// ---------------------------------------------------------------------------

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

// The heuristic count gates the banner. It is positive at mount; after a
// successful re-sync the handler re-reads it and we flip it via the
// `resyncCalled` flag so the count drops to its follow-up value.
const HEURISTIC_COUNT = 2;
let resyncCalled = false;
let followUpHeuristicCount = HEURISTIC_COUNT;
const countHeuristicMatchedAddresses = vi.fn(() =>
  Promise.resolve(resyncCalled ? followUpHeuristicCount : HEURISTIC_COUNT),
);
const getHeuristicMatchedAddresses = vi.fn(() => {
  // First call (banner list / bulk action's up-front read) returns the full
  // set and marks the run started; later calls (e.g. the single-address
  // handler's post-sync membership re-check) reflect the follow-up count:
  // 0 → everything promoted, otherwise "B" remains heuristic.
  const list = resyncCalled
    ? followUpHeuristicCount === 0
      ? []
      : ["B"]
    : ["A", "B"];
  resyncCalled = true;
  return Promise.resolve(list);
});
vi.mock("@/lib/data/address-stats", () => ({
  recomputeAddressStats: vi.fn(() => Promise.resolve({ cancelled: false })),
  countHeuristicMatchedAddresses,
  getHeuristicMatchedAddresses,
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

// No unresolved prevouts and nothing unattributable so only the heuristic
// banner is in play.
vi.mock("@/lib/data/transaction-crud", () => ({
  countUnresolvedPrevoutInputs: vi.fn(() => Promise.resolve(0)),
  getUnresolvedSpendBreakdown: vi.fn(() =>
    Promise.resolve({ byRecordId: new Map(), unattributable: 0 }),
  ),
  getMissingSourceTxids: vi.fn(() => Promise.resolve([])),
  getMissingSourceTxidDetails: vi.fn(() => Promise.resolve([])),
}));

const getNodeSettings = vi.fn();
vi.mock("@/lib/data/node-settings-crud", () => ({
  getNodeSettings: (...a: unknown[]) => getNodeSettings(...a),
}));

// settings-crud reads the real Dexie db at mount (getSettings('default')); in
// jsdom that throws DatabaseClosedError as an unhandled rejection. Report the
// formula as already upgraded (version 2) so the one-time backfill is skipped.
vi.mock("@/lib/data/settings-crud", () => ({
  getSettings: vi.fn(() => Promise.resolve({ balanceFormulaVersion: 2 })),
  updateSettings: vi.fn(() => Promise.resolve()),
}));

const getBlockHeight = vi.fn(() => Promise.resolve(800_000));
const createProviderFromSettings = vi.fn(() => ({ getBlockHeight }));
vi.mock("@/lib/blockchain-api", () => ({
  createProviderFromSettings: (...a: unknown[]) => createProviderFromSettings(...a),
}));

vi.mock("@/lib/txid-backfill", () => ({
  runTxidBackfill: vi.fn(() => Promise.resolve({ rebuilt: 0 })),
}));

const syncSingleAddress = vi.fn(() => Promise.resolve({ success: true }));
const updateProvider = vi.fn();
vi.mock("@/lib/transaction-sync", () => ({
  transactionSyncService: {
    syncSingleAddress: (...a: unknown[]) => syncSingleAddress(...a),
    updateProvider: (...a: unknown[]) => updateProvider(...a),
    resolvePrevouts: vi.fn(() => Promise.resolve({ resolved: 0, cancelled: false })),
  },
}));

const BalanceOverview = (await import("./BalanceOverview")).default;

async function renderAndShowBanner() {
  render(<BalanceOverview />);
  await screen.findByTestId("button-resync-heuristic");
}

beforeEach(() => {
  toastCalls.length = 0;
  syncSingleAddress.mockClear();
  updateProvider.mockClear();
  getHeuristicMatchedAddresses.mockClear();
  countHeuristicMatchedAddresses.mockClear();
  getNodeSettings.mockReset();
  createProviderFromSettings.mockClear();
  getBlockHeight.mockClear();
  resyncCalled = false;
  followUpHeuristicCount = HEURISTIC_COUNT;
  getHeuristicMatchedAddresses.mockImplementation(() => {
    const list = resyncCalled
      ? followUpHeuristicCount === 0
        ? []
        : ["B"]
      : ["A", "B"];
    resyncCalled = true;
    return Promise.resolve(list);
  });
  syncSingleAddress.mockResolvedValue({ success: true });
});

afterEach(() => {
  cleanup();
});

describe("BalanceOverview heuristic re-sync", () => {
  it("re-syncs each heuristic address, recounts, and clears the banner when none remain", async () => {
    getNodeSettings.mockResolvedValue({ id: "default", type: "esplora" });
    followUpHeuristicCount = 0;
    await renderAndShowBanner();

    fireEvent.click(screen.getByTestId("button-resync-heuristic"));

    await waitFor(() => expect(syncSingleAddress).toHaveBeenCalledTimes(2));
    expect(syncSingleAddress).toHaveBeenCalledWith("A", expect.any(Function));
    expect(syncSingleAddress).toHaveBeenCalledWith("B", expect.any(Function));
    expect(updateProvider).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("Re-synced");
    expect(toastCalls[0].variant).toBeUndefined();

    // Count reached 0 → the banner (and its action) disappear on their own.
    await waitFor(() => {
      expect(screen.queryByTestId("banner-heuristic-warning")).toBeNull();
      expect(screen.queryByTestId("button-resync-heuristic")).toBeNull();
    });
  });

  it("shows the current address and live tx-fetch counter while re-syncing", async () => {
    getNodeSettings.mockResolvedValue({ id: "default", type: "esplora" });
    followUpHeuristicCount = 0;

    // Hold the first address's sync open so we can observe the banner state,
    // and drive its onProgress callback to simulate streaming fetch progress.
    let capturedOnProgress: ((p: { transactionsNew: number; transactionsFound: number }) => void) | undefined;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => { releaseFirst = r; });
    syncSingleAddress.mockImplementation(async (_addr: unknown, onProgress?: unknown) => {
      if (!capturedOnProgress) {
        capturedOnProgress = onProgress as typeof capturedOnProgress;
        await firstGate;
      }
      return { success: true };
    });

    await renderAndShowBanner();
    fireEvent.click(screen.getByTestId("button-resync-heuristic"));

    // Before any progress event: fallback "fetching transactions…" line with the address.
    await waitFor(() => {
      const line = screen.getByTestId("text-heuristic-resync-address-progress");
      expect(line.textContent).toContain("A");
      expect(line.textContent).toContain("fetching transactions");
    });

    // A streamed progress event updates the counter.
    act(() => {
      capturedOnProgress!({ transactionsNew: 25, transactionsFound: 120 });
    });
    await waitFor(() => {
      expect(screen.getByTestId("text-heuristic-resync-current-address").textContent).toBe("A");
      expect(screen.getByTestId("text-heuristic-resync-tx-progress").textContent).toContain("25/120 transactions fetched");
    });

    // Finishing the run clears the per-address progress line.
    act(() => releaseFirst());
    await waitFor(() => {
      expect(screen.queryByTestId("text-heuristic-resync-address-progress")).toBeNull();
    });
  });

  it("does NOT sync and warns when no provider is configured", async () => {
    getNodeSettings.mockResolvedValue(null);
    await renderAndShowBanner();

    fireEvent.click(screen.getByTestId("button-resync-heuristic"));

    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("No blockchain provider configured");
    expect(toastCalls[0].variant).toBe("destructive");
    expect(syncSingleAddress).not.toHaveBeenCalled();

    // The action returns to its actionable state and the banner stays up.
    await waitFor(() => {
      const btn = screen.getByTestId("button-resync-heuristic");
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.queryByTestId("banner-heuristic-warning")).not.toBeNull();
  });

  it("warns and keeps the banner when the provider is unreachable", async () => {
    getNodeSettings.mockResolvedValue({ id: "default", type: "esplora" });
    getBlockHeight.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    await renderAndShowBanner();

    fireEvent.click(screen.getByTestId("button-resync-heuristic"));

    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("Can't reach the blockchain provider");
    expect(toastCalls[0].variant).toBe("destructive");
    expect(syncSingleAddress).not.toHaveBeenCalled();
    expect(screen.queryByTestId("banner-heuristic-warning")).not.toBeNull();
  });

  it("toasts 'Partially re-synced' when some addresses fail but others succeed", async () => {
    getNodeSettings.mockResolvedValue({ id: "default", type: "esplora" });
    followUpHeuristicCount = 1;
    syncSingleAddress
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false });
    await renderAndShowBanner();

    fireEvent.click(screen.getByTestId("button-resync-heuristic"));

    await waitFor(() => expect(syncSingleAddress).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("Partially re-synced");
    expect(toastCalls[0].variant).toBeUndefined();

    // 1 still heuristic → banner stays up with the refreshed count.
    await waitFor(() => {
      const banner = screen.getByTestId("banner-heuristic-warning");
      expect(banner.textContent).toContain("1 address");
    });
  });

  it("lists the specific heuristic addresses when the detail is expanded", async () => {
    getNodeSettings.mockResolvedValue({ id: "default", type: "esplora" });
    await renderAndShowBanner();

    fireEvent.click(screen.getByTestId("button-toggle-heuristic-details"));

    await waitFor(() => {
      expect(screen.getByTestId("row-heuristic-address-A")).not.toBeNull();
      expect(screen.getByTestId("row-heuristic-address-B")).not.toBeNull();
    });
    // Each listed address has its own re-sync action.
    expect(screen.getByTestId("button-resync-heuristic-address-A")).not.toBeNull();
    expect(screen.getByTestId("button-resync-heuristic-address-B")).not.toBeNull();
    // No sync happens just from expanding the list.
    expect(syncSingleAddress).not.toHaveBeenCalled();
  });

  it("re-syncs only the chosen address from the expanded list", async () => {
    getNodeSettings.mockResolvedValue({ id: "default", type: "esplora" });
    followUpHeuristicCount = 1;
    await renderAndShowBanner();

    fireEvent.click(screen.getByTestId("button-toggle-heuristic-details"));
    await screen.findByTestId("button-resync-heuristic-address-A");

    fireEvent.click(screen.getByTestId("button-resync-heuristic-address-A"));

    await waitFor(() => expect(syncSingleAddress).toHaveBeenCalledTimes(1));
    expect(syncSingleAddress).toHaveBeenCalledWith("A", expect.any(Function));
    expect(syncSingleAddress.mock.calls.every((c) => c[0] !== "B")).toBe(true);
    expect(updateProvider).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("Re-synced");
    expect(toastCalls[0].variant).toBeUndefined();
  });

  it("toasts an honest 'still estimated' message when the sync succeeds but the address stays heuristic", async () => {
    getNodeSettings.mockResolvedValue({ id: "default", type: "esplora" });
    // The address remains in the heuristic set after the (successful) sync:
    // no exact prevout data could be resolved for it.
    getHeuristicMatchedAddresses.mockImplementation(() => {
      resyncCalled = true;
      return Promise.resolve(["A", "B"]);
    });
    await renderAndShowBanner();

    fireEvent.click(screen.getByTestId("button-toggle-heuristic-details"));
    await screen.findByTestId("button-resync-heuristic-address-A");

    fireEvent.click(screen.getByTestId("button-resync-heuristic-address-A"));

    await waitFor(() => expect(syncSingleAddress).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("Re-synced, but still estimated");
    expect(toastCalls[0].description).toContain("still uses estimated matching");
    expect(toastCalls[0].variant).toBeUndefined();
  });

  it("shows a live tx-fetch counter on the per-address Re-sync button", async () => {
    getNodeSettings.mockResolvedValue({ id: "default", type: "esplora" });
    followUpHeuristicCount = 1;

    // Hold the sync open so we can drive its onProgress callback and observe
    // the in-flight button state.
    let capturedOnProgress: ((p: { transactionsNew: number; transactionsFound: number }) => void) | undefined;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    syncSingleAddress.mockImplementation(async (_addr: unknown, onProgress?: unknown) => {
      capturedOnProgress = onProgress as typeof capturedOnProgress;
      await gate;
      return { success: true };
    });

    await renderAndShowBanner();
    fireEvent.click(screen.getByTestId("button-toggle-heuristic-details"));
    await screen.findByTestId("button-resync-heuristic-address-A");
    fireEvent.click(screen.getByTestId("button-resync-heuristic-address-A"));

    // Before any progress event: plain spinner fallback, no counter yet.
    await waitFor(() => {
      const btn = screen.getByTestId("button-resync-heuristic-address-A");
      expect((btn as HTMLButtonElement).disabled).toBe(true);
      expect(btn.textContent).toContain("Re-syncing");
    });
    expect(screen.queryByTestId("text-heuristic-single-resync-tx-progress-A")).toBeNull();
    await waitFor(() => expect(capturedOnProgress).toBeDefined());

    // A streamed progress event replaces the spinner label with the live counter.
    act(() => {
      capturedOnProgress!({ transactionsNew: 25, transactionsFound: 120 });
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("text-heuristic-single-resync-tx-progress-A").textContent,
      ).toContain("25/120 transactions fetched");
    });
    // The other row stays untouched.
    expect(screen.queryByTestId("text-heuristic-single-resync-tx-progress-B")).toBeNull();

    // Finishing the sync clears the counter and re-enables the button family.
    act(() => release());
    await waitFor(() => {
      expect(screen.queryByTestId("text-heuristic-single-resync-tx-progress-A")).toBeNull();
    });
  });

  it("warns without syncing when a single-address re-sync has no provider", async () => {
    getNodeSettings.mockResolvedValue(null);
    await renderAndShowBanner();

    fireEvent.click(screen.getByTestId("button-toggle-heuristic-details"));
    await screen.findByTestId("button-resync-heuristic-address-A");

    fireEvent.click(screen.getByTestId("button-resync-heuristic-address-A"));

    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].title).toBe("No blockchain provider configured");
    expect(toastCalls[0].variant).toBe("destructive");
    expect(syncSingleAddress).not.toHaveBeenCalled();
  });
});

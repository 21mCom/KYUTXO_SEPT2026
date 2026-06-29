// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";

// ---------------------------------------------------------------------------
// These tests lock in the Balance Overview spend-warning banner copy that
// distinguishes unresolved spends from the subset that is *unattributable*
// (can't yet be tied to any tracked wallet):
//   1. With a mix of attributable + unattributable unresolved spends, the
//      banner shows the count line (data-testid="text-unattributable-spends")
//      and ends with a plain period (no "more history" note).
//   2. When *every* unresolved spend is unattributable, the same line adds the
//      "import their source history to attribute them." wording.
//   3. When nothing is unattributable, the line is absent entirely.
// The banner renders above the phase-based content, so we only need the two
// spend-health effects to run — no engine fast path / row expansion required.
// ---------------------------------------------------------------------------

// @tanstack/react-virtual needs ResizeObserver + real dimensions; jsdom has
// neither. The component mounts the virtualized list even before rows load, so
// supply the same shims the sibling resolveAddress test uses.
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

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}));

vi.mock("@/hooks/use-db-change-signal", () => ({
  useDbChangeSignal: () => 0,
}));

vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => undefined,
}));

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

// Spend-health seam. Both values are mutable so each test can paint a different
// (unresolved total, unattributable subset) scenario before rendering.
let unresolvedCount = 0;
let unattributableCount = 0;
vi.mock("@/lib/data/transaction-crud", () => ({
  countUnresolvedPrevoutInputs: vi.fn(() => Promise.resolve(unresolvedCount)),
  getUnresolvedSpendBreakdown: vi.fn(() =>
    Promise.resolve({ byRecordId: new Map(), unattributable: unattributableCount }),
  ),
}));

vi.mock("@/lib/transaction-sync", () => ({
  transactionSyncService: { resolvePrevouts: vi.fn() },
}));

const BalanceOverview = (await import("./BalanceOverview")).default;

beforeEach(() => {
  unresolvedCount = 0;
  unattributableCount = 0;
});

afterEach(() => {
  cleanup();
});

describe("BalanceOverview spend-warning unattributable line", () => {
  it("shows the unattributable count with a plain period when some spends are still attributable", async () => {
    unresolvedCount = 5;
    unattributableCount = 2;
    render(<BalanceOverview />);

    const line = await screen.findByTestId("text-unattributable-spends");
    // Mix case: count line present, ending with a period (no history note).
    expect(line.textContent).toContain("2 of these can't yet be tied to any tracked wallet");
    expect(line.textContent).toContain(".");
    expect(line.textContent).not.toContain("more transaction history");
  });

  it("notes more history is needed when every unresolved spend is unattributable", async () => {
    unresolvedCount = 3;
    unattributableCount = 3;
    render(<BalanceOverview />);

    const line = await screen.findByTestId("text-unattributable-spends");
    expect(line.textContent).toContain("3 of these can't yet be tied to any tracked wallet");
    expect(line.textContent).toContain("import their source history to attribute them.");
  });

  it("omits the unattributable line when every unresolved spend is attributable", async () => {
    unresolvedCount = 4;
    unattributableCount = 0;
    render(<BalanceOverview />);

    // The banner still appears for the unresolved spends...
    await screen.findByTestId("banner-spend-warning");
    // ...but the unattributable sub-line is absent.
    await waitFor(() =>
      expect(screen.queryByTestId("text-unattributable-spends")).toBeNull(),
    );
  });
});

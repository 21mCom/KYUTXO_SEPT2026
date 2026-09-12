// @vitest-environment jsdom
//
// Guard tests for the Balance page's user-curated filter (BalanceOverview.tsx).
//
// Blockchain sync auto-creates records for counterparty addresses
// (addressImportance "blockchain-discovered", often inheriting the parent's
// walletName). Their local history is one-sided — we only store the txs that
// touched the user's own addresses — so any "balance" computed for them is
// really just sats seen received. The Balance page must therefore exclude them
// from group summaries and totals by default (matching the UTXOs page's
// ownership model), and only count them when the explicit "Include discovered"
// toggle is on.
//
// Mirrors the BalanceOverview.hideDust.test.tsx harness, but forces the engine
// fast path OFF (evaluateEngineFreshness -> useEngine: false) so the REAL Dexie
// aggregation pass (aggregateGroups) runs against a mocked record pager.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
  toast: toastSpy,
}));

vi.mock("@/hooks/use-db-change-signal", () => ({
  useDbChangeSignal: () => 0,
}));
vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => undefined,
}));

vi.mock("@/lib/data/price-data-crud", () => ({
  getBtcUsdPriceData: vi.fn().mockResolvedValue(undefined),
}));

const GROUP_NAME = "Wallet A";
const CURATED_ADDRESS = "bc1qcuratedownedaddress000000000000000000";
const DISCOVERED_ADDRESS = "bc1qdiscoveredcounterparty000000000000000";

// One curated address (100k sats / 2 UTXOs) and one blockchain-discovered
// counterparty (50k sats / 1 UTXO) sharing the SAME wallet group — exactly the
// shape sync produces when a discovered record inherits the parent walletName.
const CURATED_REC = {
  id: 1,
  type: "address",
  inputString: CURATED_ADDRESS,
  walletName: GROUP_NAME,
  addressImportance: "manual",
  cachedBalanceSats: 100_000,
  cachedUtxoCount: 2,
  statsComputedAt: 10,
};
const DISCOVERED_REC = {
  id: 2,
  type: "address",
  inputString: DISCOVERED_ADDRESS,
  walletName: GROUP_NAME,
  addressImportance: "blockchain-discovered",
  cachedBalanceSats: 50_000,
  cachedUtxoCount: 1,
  statsComputedAt: 10,
};

const getAddressBalanceRowsForGroup = vi.fn();
const getRecordsPageByTypeIdReverseKeyset = vi.fn();
const findRecordByInputString = vi.fn();
vi.mock("@/lib/data/record-crud", () => ({
  countRecordsByType: vi.fn().mockResolvedValue(2),
  getRecordsPageByTypeIdReverseKeyset: (...a: unknown[]) => getRecordsPageByTypeIdReverseKeyset(...a),
  getAddressBalanceRowsForGroup: (...a: unknown[]) => getAddressBalanceRowsForGroup(...a),
  getRecordsByIds: vi.fn().mockResolvedValue([]),
  findRecordByInputString: (...a: unknown[]) => findRecordByInputString(...a),
}));

vi.mock("@/lib/data/dust-flags-crud", () => ({
  getUnspentDustByAddress: vi.fn().mockResolvedValue({ byAddress: new Map() }),
}));

// Engine fast path is mocked but must never be used: freshness says no, and the
// include-discovered view bypasses it by design.
const engineGetBalanceGroupSummaries = vi.fn();
vi.mock("@/lib/engine/engine-client", () => ({
  engineGetBalanceGroupSummaries: (...a: unknown[]) => engineGetBalanceGroupSummaries(...a),
  subscribeEngineReadiness: vi.fn().mockReturnValue(() => {}),
}));
vi.mock("@/lib/engine/engine-freshness", () => ({
  evaluateEngineFreshness: vi.fn().mockResolvedValue({ useEngine: false }),
}));
vi.mock("@/lib/data/address-stats", () => ({
  recomputeAddressStats: vi.fn().mockResolvedValue({ cancelled: false }),
  countHeuristicMatchedAddresses: vi.fn(() => Promise.resolve(0)),
}));
vi.mock("@/lib/data/settings-crud", () => ({
  getSettings: vi.fn().mockResolvedValue({ balanceFormulaVersion: 2 }),
  updateSettings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/data/transaction-crud", () => ({
  getMissingSourceTxids: vi.fn().mockResolvedValue([]),
  getUnresolvedSpendBreakdown: vi.fn().mockResolvedValue({
    byRecordId: new Map<number, number>(),
    unattributable: 0,
  }),
  countUnresolvedPrevoutInputs: vi.fn().mockResolvedValue(0),
  getMissingSourceTxidDetails: vi.fn().mockResolvedValue([]),
  buildMissingSourceJson: vi.fn().mockReturnValue("{}"),
  buildMissingSourceCsv: vi.fn().mockReturnValue(""),
}));

vi.mock("@/lib/data/node-settings-crud", () => ({
  getNodeSettings: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/blockchain-api", () => ({
  createProviderFromSettings: vi.fn(() => ({ getBlockHeight: vi.fn() })),
}));
vi.mock("@/lib/txid-backfill", () => ({
  runTxidBackfill: vi.fn(),
}));
vi.mock("@/lib/transaction-sync", () => ({
  transactionSyncService: {
    resolvePrevouts: vi.fn().mockResolvedValue(undefined),
  },
}));

// Render every virtualized row (jsdom's zero-size scroll element would
// otherwise render none).
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, index) => ({
        index,
        key: index,
        start: index * 34,
        size: 34,
      })),
    getTotalSize: () => opts.count * 34,
    measureElement: () => {},
  }),
}));

const BalanceOverview = (await import("./BalanceOverview")).default;

async function renderReady() {
  render(<BalanceOverview />);
  await waitFor(() =>
    expect(screen.getByTestId("text-total-balance")).toBeTruthy(),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Single page of address records; aggregateGroups stops after one batch
  // because the page is smaller than its batch size.
  getRecordsPageByTypeIdReverseKeyset.mockResolvedValue([CURATED_REC, DISCOVERED_REC]);
  getAddressBalanceRowsForGroup.mockResolvedValue([
    { id: 1, address: CURATED_ADDRESS, label: "", sats: 100_000, utxoCount: 2 },
  ]);
  findRecordByInputString.mockResolvedValue(CURATED_REC);
});

afterEach(() => {
  cleanup();
});

describe("BalanceOverview · blockchain-discovered exclusion", () => {
  it("excludes discovered addresses from totals and group summaries by default", async () => {
    await renderReady();

    // Only the curated address counts: 100,000 sats, not 150,000.
    await waitFor(() =>
      expect(screen.getByTestId("text-total-balance").textContent).toContain("0.00100000"),
    );
    expect(screen.getByTestId(`text-group-balance-${GROUP_NAME}`).textContent).toContain(
      "0.00100000",
    );
    expect(screen.queryByTestId("badge-discovered-included")).toBeNull();
    // The engine fast path was not consulted for numbers (freshness said no).
    expect(engineGetBalanceGroupSummaries).not.toHaveBeenCalled();
  });

  it("counts discovered addresses only while the Include discovered toggle is on", async () => {
    await renderReady();
    await waitFor(() =>
      expect(screen.getByTestId("text-total-balance").textContent).toContain("0.00100000"),
    );

    fireEvent.click(screen.getByTestId("switch-include-discovered"));

    // Both addresses count: 150,000 sats, and the explanatory badge shows.
    await waitFor(() =>
      expect(screen.getByTestId("text-total-balance").textContent).toContain("0.00150000"),
    );
    expect(screen.getByTestId(`text-group-balance-${GROUP_NAME}`).textContent).toContain(
      "0.00150000",
    );
    expect(screen.getByTestId("badge-discovered-included")).toBeTruthy();

    fireEvent.click(screen.getByTestId("switch-include-discovered"));
    await waitFor(() =>
      expect(screen.getByTestId("text-total-balance").textContent).toContain("0.00100000"),
    );
    expect(screen.queryByTestId("badge-discovered-included")).toBeNull();
  });

  it("passes the toggle through to the expanded per-address rows", async () => {
    await renderReady();
    await waitFor(() =>
      expect(screen.getByTestId("text-total-balance").textContent).toContain("0.00100000"),
    );

    fireEvent.click(screen.getByTestId(`button-expand-${GROUP_NAME}`));
    await waitFor(() =>
      expect(getAddressBalanceRowsForGroup).toHaveBeenCalledWith(
        "wallet",
        GROUP_NAME,
        { includeDiscovered: false },
      ),
    );

    fireEvent.click(screen.getByTestId("switch-include-discovered"));
    await waitFor(() =>
      expect(getAddressBalanceRowsForGroup).toHaveBeenCalledWith(
        "wallet",
        GROUP_NAME,
        { includeDiscovered: true },
      ),
    );
  });

  it("resets the toggle to its default on remount", async () => {
    await renderReady();
    fireEvent.click(screen.getByTestId("switch-include-discovered"));
    await waitFor(() =>
      expect(screen.getByTestId("text-total-balance").textContent).toContain("0.00150000"),
    );

    cleanup();
    await renderReady();
    await waitFor(() =>
      expect(screen.getByTestId("text-total-balance").textContent).toContain("0.00100000"),
    );
    expect(screen.queryByTestId("badge-discovered-included")).toBeNull();
  });
});

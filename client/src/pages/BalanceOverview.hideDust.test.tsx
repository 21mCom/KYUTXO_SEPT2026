// @vitest-environment jsdom
//
// Guard tests for the Balance page "Hide dust" toggle (BalanceOverview.tsx).
// Mirrors the UTXOs page's filter: when enabled, user-flagged dust UTXOs that
// are still unspent are subtracted from the total balance, the per-group
// summaries, and the expanded per-address rows; toggling off restores the
// original numbers exactly. Only dust on addresses actually counted in the
// totals is subtracted (the effect checks the record's cachedUtxoCount).
//
// The page is engine/Dexie heavy, so (mirroring the sibling
// BalanceOverview.copyButtons.test.tsx) we mock the data/engine layer so just
// enough renders to drive the toggle and read the displayed numbers.

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
const ADDRESS = "bc1qhidedustaddress000000000000000000000000";

const getAddressBalanceRowsForGroup = vi.fn();
const findRecordByInputString = vi.fn();
vi.mock("@/lib/data/record-crud", () => ({
  countRecordsByType: vi.fn().mockResolvedValue(1),
  getRecordsPageByTypeIdReverseKeyset: vi.fn().mockResolvedValue([]),
  getAddressBalanceRowsForGroup: (...a: unknown[]) => getAddressBalanceRowsForGroup(...a),
  getRecordsByIds: vi.fn().mockResolvedValue([]),
  findRecordByInputString: (...a: unknown[]) => findRecordByInputString(...a),
}));

const getUnspentDustByAddress = vi.fn();
vi.mock("@/lib/data/dust-flags-crud", () => ({
  getUnspentDustByAddress: (...a: unknown[]) => getUnspentDustByAddress(...a),
}));

// Engine fast path: one group of 100,000 sats across 3 UTXOs.
vi.mock("@/lib/engine/engine-client", () => ({
  engineGetBalanceGroupSummaries: vi.fn().mockResolvedValue({
    summaries: [
      { groupKey: GROUP_NAME, totalSats: 100_000, addressCount: 1, utxoCount: 3 },
    ],
    totals: { totalSats: 100_000, totalAddresses: 1, totalUtxos: 3 },
    staleAddressCount: 0,
  }),
  subscribeEngineReadiness: vi.fn().mockReturnValue(() => {}),
}));
vi.mock("@/lib/engine/engine-freshness", () => ({
  evaluateEngineFreshness: vi.fn().mockResolvedValue({ useEngine: true }),
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
  getAddressBalanceRowsForGroup.mockResolvedValue([
    { id: 1, address: ADDRESS, label: "", sats: 100_000, utxoCount: 3 },
  ]);
  // 2 unspent dust flags worth 1,500 sats on the tracked address.
  getUnspentDustByAddress.mockResolvedValue({
    byAddress: new Map([[ADDRESS, { sats: 1_500, count: 2 }]]),
  });
  findRecordByInputString.mockResolvedValue({
    id: 1,
    inputString: ADDRESS,
    walletName: GROUP_NAME,
    cachedUtxoCount: 3,
    cachedBalanceSats: 100_000,
  });
});

afterEach(() => {
  cleanup();
});

describe("BalanceOverview · Hide dust toggle", () => {
  it("keeps the exact balance and excluded amount when switching between BTC and sats", async () => {
    await renderReady();

    expect(screen.getByTestId("button-toggle-unit").textContent).toBe("BTC");
    expect(screen.getByTestId("text-total-balance").textContent).toContain("0.00100000 BTC");

    fireEvent.click(screen.getByTestId("switch-hide-dust"));
    await waitFor(() =>
      expect(screen.getByTestId("text-total-balance").textContent).toContain("0.00098500 BTC"),
    );

    // The unit toggle is display-only: the dust adjustment remains exactly
    // 1,500 sats rather than being recalculated from a rounded BTC value.
    fireEvent.click(screen.getByTestId("button-toggle-unit"));
    expect(screen.getByTestId("button-toggle-unit").textContent).toBe("sats");
    expect(screen.getByTestId("text-total-balance").textContent).toContain("98,500 sats");
    expect(screen.getByTestId(`text-group-balance-${GROUP_NAME}`).textContent).toContain(
      "98,500 sats",
    );
    expect(screen.getByTestId("badge-dust-hidden").textContent).toContain("1,500 sats");

    // Switching back must recover the same canonical sats value.
    fireEvent.click(screen.getByTestId("button-toggle-unit"));
    expect(screen.getByTestId("text-total-balance").textContent).toContain("0.00098500 BTC");
  });

  it("subtracts unspent dust from the total, group, and address rows when enabled", async () => {
    await renderReady();
    expect(screen.getByTestId("text-total-balance").textContent).toContain("0.00100000");

    fireEvent.click(screen.getByTestId("switch-hide-dust"));

    // Badge with the excluded totals appears.
    await waitFor(() =>
      expect(screen.getByTestId("badge-dust-hidden").textContent).toContain("2 excluded"),
    );
    // Total drops by 1,500 sats: 100,000 → 98,500.
    await waitFor(() =>
      expect(screen.getByTestId("text-total-balance").textContent).toContain("0.00098500"),
    );
    // Group summary drops too.
    expect(screen.getByTestId(`text-group-balance-${GROUP_NAME}`).textContent).toContain(
      "0.00098500",
    );

    // Expanded address row reflects the adjusted balance.
    fireEvent.click(screen.getByTestId(`button-expand-${GROUP_NAME}`));
    await waitFor(() =>
      expect(screen.getByText(/1 UTXO/)).toBeTruthy(),
    );
  });

  it("restores the original totals when toggled back off", async () => {
    await renderReady();
    fireEvent.click(screen.getByTestId("switch-hide-dust"));
    await waitFor(() =>
      expect(screen.getByTestId("text-total-balance").textContent).toContain("0.00098500"),
    );

    fireEvent.click(screen.getByTestId("button-show-dust"));
    await waitFor(() =>
      expect(screen.getByTestId("text-total-balance").textContent).toContain("0.00100000"),
    );
    expect(screen.queryByTestId("badge-dust-hidden")).toBeNull();
  });

  it("resets the toggle to its default on remount", async () => {
    await renderReady();
    fireEvent.click(screen.getByTestId("switch-hide-dust"));
    await waitFor(() =>
      expect(screen.getByTestId("text-total-balance").textContent).toContain("0.00098500"),
    );

    cleanup();
    await renderReady();
    await waitFor(() =>
      expect(screen.getByTestId("text-total-balance").textContent).toContain("0.00100000"),
    );
    expect(screen.queryByTestId("badge-dust-hidden")).toBeNull();
  });

  it("does not subtract dust for addresses that are not counted in the totals", async () => {
    // Record exists but has no counted UTXOs (cachedUtxoCount 0).
    findRecordByInputString.mockResolvedValue({
      id: 1,
      inputString: ADDRESS,
      walletName: GROUP_NAME,
      cachedUtxoCount: 0,
      cachedBalanceSats: 0,
    });
    await renderReady();

    fireEvent.click(screen.getByTestId("switch-hide-dust"));
    await waitFor(() => expect(getUnspentDustByAddress).toHaveBeenCalled());

    // Total is unchanged and the badge shows no excluded count.
    await waitFor(() =>
      expect(screen.getByTestId("badge-dust-hidden")).toBeTruthy(),
    );
    expect(screen.getByTestId("text-total-balance").textContent).toContain("0.00100000");
    expect(screen.getByTestId("badge-dust-hidden").textContent).not.toContain("excluded,");
  });
});

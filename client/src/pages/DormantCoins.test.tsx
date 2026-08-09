// @vitest-environment jsdom
//
// Page-level test for the Dormant Coins report: seeds a small vault with a
// dormant own output, a paid-alongside unknown output and a co-spend clue,
// runs the scan through the real page UI, asserts the summary + virtualized
// results render from the scratch store, and verifies the interrupted-run
// notice appears when the persisted run meta says the last scan never finished.

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";
import { createRecord, clearAllRecords } from "@/lib/data/record-crud";
import {
  addTransaction,
  bulkAddParticipants,
  clearAllTransactionData,
} from "@/lib/data/transaction-crud";
import {
  beginDormantRun,
  clearDormantReport,
} from "@/lib/data/dormant-coins-report-store";
import DormantCoins from "./DormantCoins";

const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

// The per-row "Check node" action creates a provider from node settings; stub
// the factory so tests control the outpoint verdict without any network.
const getTxOutspendMock = vi.fn();
const getBlockHeightMock = vi.fn();
vi.mock("@/lib/blockchain-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/blockchain-api")>();
  return {
    ...actual,
    createProviderFromSettings: () => ({
      name: "Test Esplora",
      getTxOutspend: getTxOutspendMock,
      getBlockHeight: getBlockHeightMock,
    }),
  };
});

// The per-row Re-sync action delegates the actual network sync to the shared
// transaction sync service; stub it so tests control the outcome.
const syncSingleAddressMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/transaction-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/transaction-sync")>();
  return {
    ...actual,
    transactionSyncService: {
      updateProvider: vi.fn(),
      syncSingleAddress: syncSingleAddressMock,
    },
  };
});

// jsdom has no layout, so the real virtualizer measures a 0-height scroll
// element and renders nothing. Render every row instead.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number; estimateSize: (i: number) => number }) => {
    const items = Array.from({ length: opts.count }, (_, index) => ({
      index,
      key: index,
      start: index * 64,
      size: opts.estimateSize(index),
    }));
    return {
      getTotalSize: () => opts.count * 64,
      getVirtualItems: () => items,
    };
  },
}));

const NOW = 1_800_000_000;
const YEAR = 365.25 * 24 * 60 * 60;
const yearsAgo = (y: number) => Math.floor(NOW - y * YEAR);

const OWN = "bc1qpagedormantownaaaaaaaaaaaaaaaaaaaaaaa";
const U_PAID = "bc1qpagedormantpaidbbbbbbbbbbbbbbbbbbbb";
const U_CO = "bc1qpagedormantcospendccccccccccccccccc";

const TX_FUND = "ab".repeat(32);
const TX_CO_FUND = "cd".repeat(32);
const TX_COSPEND = "ef".repeat(32);

// The engine computes "now" from the real clock, so fixtures are dated
// relative to the REAL now (5y/6y old) to stay deterministically dormant
// under the default 3-year threshold.
async function seedRelativeToRealNow() {
  const realNow = Math.floor(Date.now() / 1000);
  const old = realNow - Math.floor(5 * YEAR);
  const older = realNow - Math.floor(6 * YEAR);
  await createRecord({ type: "address", inputString: OWN, label: "Forgotten change", addressImportance: "manual" });
  await addTransaction({ txid: TX_FUND, blockHeight: 700_010, blockTime: old, fee: 500, feeRate: 2, syncedAt: Date.now() });
  await addTransaction({ txid: TX_CO_FUND, blockHeight: 600_010, blockTime: older, fee: 500, feeRate: 2, syncedAt: Date.now() });
  await addTransaction({ txid: TX_COSPEND, blockHeight: 600_020, blockTime: older + 100, fee: 500, feeRate: 2, syncedAt: Date.now() });
  await bulkAddParticipants([
    { txid: TX_FUND, role: "output", address: OWN, amount: 750_000, vout: 0 },
    { txid: TX_FUND, role: "output", address: U_PAID, amount: 250_000, vout: 1 },
    { txid: TX_FUND, role: "input", address: "bc1qpagefunder0000000000000000000000000", amount: 1_010_000, prevTxid: "00".repeat(32), prevVout: 0 },
    { txid: TX_COSPEND, role: "input", address: OWN, amount: 100_000, prevTxid: "00".repeat(32), prevVout: 1 },
    { txid: TX_COSPEND, role: "input", address: U_CO, amount: 640_000, prevTxid: TX_CO_FUND, prevVout: 0 },
    { txid: TX_COSPEND, role: "output", address: "bc1qpagecospenddest00000000000000000", amount: 735_000, vout: 0 },
    { txid: TX_CO_FUND, role: "output", address: U_CO, amount: 640_000, vout: 0 },
    { txid: TX_CO_FUND, role: "output", address: U_CO, amount: 640_001, vout: 1 },
    { txid: TX_CO_FUND, role: "input", address: "bc1qpagecofunder0000000000000000000000", amount: 1_300_000, prevTxid: "00".repeat(32), prevVout: 2 },
  ]);
}

describe("DormantCoins page", () => {
  beforeEach(async () => {
    toastSpy.mockClear();
    await clearAllRecords();
    await clearAllTransactionData();
    await clearDormantReport();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders controls and the local-data-only caveat", async () => {
    renderWithProviders(<DormantCoins />);
    expect(screen.getByTestId("page-dormant-coins")).toBeTruthy();
    expect(screen.getByTestId("input-min-age-years")).toBeTruthy();
    expect(screen.getByTestId("input-min-amount")).toBeTruthy();
    expect(screen.getByTestId("input-dust-threshold")).toBeTruthy();
    expect(screen.getByTestId("checkbox-ignore-dust")).toBeTruthy();
    expect(screen.getByTestId("alert-local-data-caveat").textContent).toContain("Local data only");
    expect(screen.getByTestId("button-run-scan")).toBeTruthy();
  });

  it("runs a scan and renders summary, rows and clue groups", async () => {
    await seedRelativeToRealNow();
    renderWithProviders(<DormantCoins />);

    fireEvent.click(screen.getByTestId("button-run-scan"));

    await waitFor(() => expect(screen.getByTestId("text-summary-rows").textContent).toBe("3"));
    expect(screen.getByTestId("text-summary-total-sats").textContent).toBe("1,640,001 sats");
    expect(screen.getByTestId("text-summary-own-sats").textContent).toBe("750,000 sats");
    expect(screen.getByTestId("text-summary-groups").textContent).toBe("1");

    // Rows render from the scratch store through the windowed list.
    await waitFor(() =>
      expect(screen.getByTestId(`row-dormant-${TX_CO_FUND.slice(0, 12)}-1`)).toBeTruthy(),
    );
    // Own dormant output.
    expect(screen.getByTestId(`row-dormant-${TX_FUND.slice(0, 12)}-0`)).toBeTruthy();
    expect(screen.getByTestId(`badge-clue-${TX_FUND.slice(0, 12)}-0`).textContent).toBe("Own dormant output");
    expect(screen.getByTestId(`badge-ownership-${TX_FUND.slice(0, 12)}-0`).textContent).toBe("Owned");
    // Paid-alongside unknown output.
    expect(screen.getByTestId(`badge-clue-${TX_FUND.slice(0, 12)}-1`).textContent).toBe("Paid alongside you");
    expect(screen.getByTestId(`badge-ownership-${TX_FUND.slice(0, 12)}-1`).textContent).toBe("Unknown");
    // Co-spent unknown output (the vout NOT spent by TX_COSPEND).
    expect(screen.getByTestId(`badge-clue-${TX_CO_FUND.slice(0, 12)}-1`).textContent).toBe("Co-spent with your keys");
    // The spent vout is absent.
    expect(screen.queryByTestId(`row-dormant-${TX_CO_FUND.slice(0, 12)}-0`)).toBeNull();

    // Clue group list.
    await waitFor(() => expect(screen.getByTestId("row-group-1")).toBeTruthy());
    expect(screen.getByTestId("text-group-sats-1").textContent).toBe("640,001 sats");
    expect(screen.getByTestId("badge-groups-count").textContent).toBe("1");

    // Export buttons become available once there are results.
    expect(screen.getByTestId("button-export-csv")).toBeTruthy();
    expect(screen.getByTestId("button-export-json")).toBeTruthy();
  });

  it("shows the interrupted-run notice when the last scan never finished", async () => {
    await beginDormantRun({
      minAgeYears: 3,
      minAmountSats: 10_000,
      dustThresholdSats: 1000,
      ignoreDust: false,
    });
    renderWithProviders(<DormantCoins />);
    await waitFor(() => expect(screen.getByTestId("alert-interrupted")).toBeTruthy());
    expect(screen.getByTestId("alert-interrupted").textContent).toContain("interrupted");
  });

  it("verifies a single outpoint against the node on demand and annotates the row", async () => {
    await seedRelativeToRealNow();
    renderWithProviders(<DormantCoins />);
    fireEvent.click(screen.getByTestId("button-run-scan"));
    const ownKey = `${TX_FUND.slice(0, 12)}-0`;
    await waitFor(() => expect(screen.getByTestId(`row-dormant-${ownKey}`)).toBeTruthy());

    // Still unspent.
    getTxOutspendMock.mockResolvedValueOnce({ spent: false });
    fireEvent.click(screen.getByTestId(`button-live-check-${ownKey}`));
    await waitFor(() => expect(screen.getByTestId(`live-unspent-${ownKey}`)).toBeTruthy());
    expect(getTxOutspendMock).toHaveBeenCalledWith(TX_FUND, 0, expect.anything());

    // Spent: a different row reports spent with the spending txid.
    const paidKey = `${TX_FUND.slice(0, 12)}-1`;
    getTxOutspendMock.mockResolvedValueOnce({ spent: true, spentTxid: "12".repeat(32) });
    fireEvent.click(screen.getByTestId(`button-live-check-${paidKey}`));
    await waitFor(() => expect(screen.getByTestId(`live-spent-${paidKey}`)).toBeTruthy());

    // Unknown: failures surface as a retry control, and retry can succeed.
    const coKey = `${TX_CO_FUND.slice(0, 12)}-1`;
    getTxOutspendMock.mockRejectedValueOnce(new Error("node unreachable"));
    fireEvent.click(screen.getByTestId(`button-live-check-${coKey}`));
    await waitFor(() => expect(screen.getByTestId(`button-live-retry-${coKey}`)).toBeTruthy());
    expect(
      (screen.getByTestId(`button-live-retry-${coKey}`) as HTMLElement).getAttribute("title"),
    ).toContain("node unreachable");
    getTxOutspendMock.mockResolvedValueOnce({ spent: false });
    fireEvent.click(screen.getByTestId(`button-live-retry-${coKey}`));
    await waitFor(() => expect(screen.getByTestId(`live-unspent-${coKey}`)).toBeTruthy());

    // Earlier annotations are untouched.
    expect(screen.getByTestId(`live-unspent-${ownKey}`)).toBeTruthy();
    expect(screen.getByTestId(`live-spent-${paidKey}`)).toBeTruthy();
  });

  it("offers a one-click re-sync on a spent annotation and marks the row stale after it", async () => {
    await seedRelativeToRealNow();
    renderWithProviders(<DormantCoins />);
    fireEvent.click(screen.getByTestId("button-run-scan"));
    const ownKey = `${TX_FUND.slice(0, 12)}-0`;
    await waitFor(() => expect(screen.getByTestId(`row-dormant-${ownKey}`)).toBeTruthy());

    // Node reports the output as spent → the row exposes a Re-sync action.
    getTxOutspendMock.mockResolvedValueOnce({ spent: true, spentTxid: "34".repeat(32) });
    fireEvent.click(screen.getByTestId(`button-live-check-${ownKey}`));
    await waitFor(() => expect(screen.getByTestId(`live-spent-${ownKey}`)).toBeTruthy());
    expect(screen.getByTestId(`button-resync-${ownKey}`)).toBeTruthy();

    // Failed re-sync: destructive toast, button comes back.
    getBlockHeightMock.mockResolvedValue(800_000);
    syncSingleAddressMock.mockResolvedValueOnce({ success: false });
    toastSpy.mockClear();
    fireEvent.click(screen.getByTestId(`button-resync-${ownKey}`));
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Re-sync failed", variant: "destructive" }),
      ),
    );
    expect(screen.getByTestId(`button-resync-${ownKey}`)).toBeTruthy();

    // Successful re-sync: toast nudges a new scan, row is marked stale.
    syncSingleAddressMock.mockResolvedValueOnce({ success: true });
    toastSpy.mockClear();
    fireEvent.click(screen.getByTestId(`button-resync-${ownKey}`));
    await waitFor(() => expect(screen.getByTestId(`resynced-stale-${ownKey}`)).toBeTruthy());
    expect(syncSingleAddressMock).toHaveBeenCalledWith(OWN);
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Address re-synced",
        description: expect.stringContaining("Run a new dormant scan"),
      }),
    );
    expect(screen.getByTestId(`resynced-stale-${ownKey}`).getAttribute("title")).toContain(
      "Run a new dormant scan",
    );
    expect(screen.queryByTestId(`button-resync-${ownKey}`)).toBeNull();
    // The Spent badge itself remains.
    expect(screen.getByTestId(`live-spent-${ownKey}`)).toBeTruthy();
  });

  it("persists completed results across a remount", async () => {
    await seedRelativeToRealNow();
    const first = renderWithProviders(<DormantCoins />);
    fireEvent.click(screen.getByTestId("button-run-scan"));
    await waitFor(() => expect(screen.getByTestId("text-summary-rows").textContent).toBe("3"));
    first.unmount();

    renderWithProviders(<DormantCoins />);
    await waitFor(() => expect(screen.getByTestId("text-summary-rows").textContent).toBe("3"));
    expect(screen.queryByTestId("alert-interrupted")).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId(`row-dormant-${TX_FUND.slice(0, 12)}-0`)).toBeTruthy(),
    );
  });
});

// @vitest-environment jsdom
//
// Integration tests for the Balance page's "Import missing history" action
// (handleImportMissingHistory in BalanceOverview.tsx).
//
// The banner that hosts the button only renders with real data + a provider, so
// it can't be exercised manually in an empty vault. These tests render the page
// with the data layer mocked so the unattributable-spends banner shows, click
// "Import missing history", and assert the handler's branches:
//   - nothing to import (getMissingSourceTxids returns [])
//   - no blockchain provider configured (getNodeSettings returns null)
//   - provider unreachable (getBlockHeight throws)
//   - a successful import that lowers the unattributable count
//
// The heavy aggregation/engine paths are stubbed to no-ops; the page only needs
// to render far enough for the banner and its button to appear.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

// ── Toast capture ───────────────────────────────────────────────────────────
const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
  toast: toastSpy,
}));

// ── DB change signal / live query: stable, inert values ─────────────────────
vi.mock("@/hooks/use-db-change-signal", () => ({
  useDbChangeSignal: () => 0,
}));
vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => undefined,
}));

// ── Heavy data/engine paths the page mounts but these tests don't exercise ──
vi.mock("@/lib/data/price-data-crud", () => ({
  getBtcUsdPriceData: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/data/record-crud", () => ({
  countRecordsByType: vi.fn().mockResolvedValue(0),
  getRecordsPageByTypeIdReverseKeyset: vi.fn().mockResolvedValue([]),
  getAddressBalanceRowsForGroup: vi.fn().mockResolvedValue([]),
  getRecordsByIds: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/engine/engine-client", () => ({
  engineGetBalanceGroupSummaries: vi.fn().mockResolvedValue({
    summaries: [],
    totals: { totalSats: 0, totalAddresses: 0, totalUtxos: 0 },
    staleAddressCount: 0,
  }),
  subscribeEngineReadiness: vi.fn().mockReturnValue(() => {}),
}));
vi.mock("@/lib/engine/engine-freshness", () => ({
  evaluateEngineFreshness: vi.fn().mockResolvedValue({ useEngine: false }),
}));
vi.mock("@/lib/data/address-stats", () => ({
  recomputeAddressStats: vi.fn().mockResolvedValue({ cancelled: false }),
}));

// ── The collaborators handleImportMissingHistory actually drives ────────────
const getMissingSourceTxids = vi.fn();
const getUnresolvedSpendBreakdown = vi.fn();
const countUnresolvedPrevoutInputs = vi.fn();
const getMissingSourceTxidDetails = vi.fn().mockResolvedValue([]);
vi.mock("@/lib/data/transaction-crud", () => ({
  getMissingSourceTxids: (...a: unknown[]) => getMissingSourceTxids(...a),
  getUnresolvedSpendBreakdown: (...a: unknown[]) => getUnresolvedSpendBreakdown(...a),
  countUnresolvedPrevoutInputs: (...a: unknown[]) => countUnresolvedPrevoutInputs(...a),
  getMissingSourceTxidDetails: (...a: unknown[]) => getMissingSourceTxidDetails(...a),
}));

const getNodeSettings = vi.fn();
vi.mock("@/lib/data/node-settings-crud", () => ({
  getNodeSettings: (...a: unknown[]) => getNodeSettings(...a),
}));

const getBlockHeight = vi.fn();
const createProviderFromSettings = vi.fn(() => ({ getBlockHeight }));
vi.mock("@/lib/blockchain-api", () => ({
  createProviderFromSettings: (...a: unknown[]) => createProviderFromSettings(...a),
}));

const runTxidBackfill = vi.fn();
vi.mock("@/lib/txid-backfill", () => ({
  runTxidBackfill: (...a: unknown[]) => runTxidBackfill(...a),
}));

const resolvePrevouts = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/transaction-sync", () => ({
  transactionSyncService: {
    resolvePrevouts: (...a: unknown[]) => resolvePrevouts(...a),
  },
}));

const BalanceOverview = (await import("./BalanceOverview")).default;

// ---- Helpers ---------------------------------------------------------------

// Default the page into the "unattributable spends" state so the banner and the
// "Import missing history" button render. Individual tests override mocks first.
function primeBannerState(opts?: { unresolved?: number; unattributable?: number }) {
  const unresolved = opts?.unresolved ?? 3;
  const unattributable = opts?.unattributable ?? 3;
  countUnresolvedPrevoutInputs.mockResolvedValue(unresolved);
  getUnresolvedSpendBreakdown.mockResolvedValue({
    byRecordId: new Map<number, number>(),
    unattributable,
  });
}

async function renderAndWaitForBanner() {
  render(<BalanceOverview />);
  await waitFor(() =>
    expect(screen.getByTestId("button-import-missing-history")).toBeTruthy(),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  toastSpy.mockReset();
  // Sensible defaults; tests override as needed.
  getMissingSourceTxidDetails.mockResolvedValue([]);
  resolvePrevouts.mockResolvedValue(undefined);
  createProviderFromSettings.mockReturnValue({ getBlockHeight });
});

afterEach(() => {
  cleanup();
});

describe("BalanceOverview · Import missing history", () => {
  it("renders the import button when there are unattributable spends", async () => {
    primeBannerState();
    await renderAndWaitForBanner();

    expect(screen.getByTestId("banner-spend-warning")).toBeTruthy();
    expect(screen.getByTestId("text-unattributable-spends")).toBeTruthy();
  });

  it("tells the user there is nothing to import when no source txids are missing", async () => {
    primeBannerState();
    getMissingSourceTxids.mockResolvedValue([]);

    await renderAndWaitForBanner();
    fireEvent.click(screen.getByTestId("button-import-missing-history"));

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Nothing to import" }),
      ),
    );
    // It must short-circuit before touching node settings / the provider.
    expect(getNodeSettings).not.toHaveBeenCalled();
    expect(runTxidBackfill).not.toHaveBeenCalled();
  });

  it("warns when no blockchain provider is configured", async () => {
    primeBannerState();
    getMissingSourceTxids.mockResolvedValue(["txMissing"]);
    getNodeSettings.mockResolvedValue(null);

    await renderAndWaitForBanner();
    fireEvent.click(screen.getByTestId("button-import-missing-history"));

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "No blockchain provider configured",
          variant: "destructive",
        }),
      ),
    );
    expect(runTxidBackfill).not.toHaveBeenCalled();
  });

  it("warns (offline) when the provider is unreachable", async () => {
    primeBannerState();
    getMissingSourceTxids.mockResolvedValue(["txMissing"]);
    getNodeSettings.mockResolvedValue({ id: "default", type: "esplora" });
    getBlockHeight.mockRejectedValue(new Error("ECONNREFUSED"));

    await renderAndWaitForBanner();
    fireEvent.click(screen.getByTestId("button-import-missing-history"));

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Can't reach the blockchain provider",
          variant: "destructive",
        }),
      ),
    );
    expect(runTxidBackfill).not.toHaveBeenCalled();
  });

  it("imports the missing history and reports the lowered unattributable count", async () => {
    primeBannerState({ unresolved: 3, unattributable: 3 });
    getMissingSourceTxids.mockResolvedValue(["txMissing1", "txMissing2"]);
    getNodeSettings.mockResolvedValue({ id: "default", type: "esplora" });
    getBlockHeight.mockResolvedValue(800000);
    runTxidBackfill.mockResolvedValue({ rebuilt: 2, failed: 0 });

    await renderAndWaitForBanner();

    // After the import + resolve pass, everything is now attributed. Swap the
    // counts only once the banner is up so the initial render still shows it.
    countUnresolvedPrevoutInputs.mockResolvedValue(0);
    getUnresolvedSpendBreakdown.mockResolvedValue({
      byRecordId: new Map<number, number>(),
      unattributable: 0,
    });

    fireEvent.click(screen.getByTestId("button-import-missing-history"));

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "History imported",
          description: expect.stringContaining("All spends are now attributed"),
        }),
      ),
    );

    expect(runTxidBackfill).toHaveBeenCalledWith(
      expect.objectContaining({ getBlockHeight }),
      ["txMissing1", "txMissing2"],
      expect.any(Object),
    );
    // A resolve pass runs after a successful import so balances self-correct.
    expect(resolvePrevouts).toHaveBeenCalled();
  });

  it("reports remaining unattributable spends after a partial import", async () => {
    primeBannerState({ unresolved: 5, unattributable: 5 });
    getMissingSourceTxids.mockResolvedValue(["txMissing1", "txMissing2"]);
    getNodeSettings.mockResolvedValue({ id: "default", type: "esplora" });
    getBlockHeight.mockResolvedValue(800000);
    runTxidBackfill.mockResolvedValue({ rebuilt: 1, failed: 1 });
    // One source imported, but some spends still can't be attributed.
    countUnresolvedPrevoutInputs.mockResolvedValue(2);
    getUnresolvedSpendBreakdown.mockResolvedValue({
      byRecordId: new Map<number, number>(),
      unattributable: 2,
    });

    await renderAndWaitForBanner();
    fireEvent.click(screen.getByTestId("button-import-missing-history"));

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "History imported",
          description: expect.stringContaining("still can't be attributed"),
        }),
      ),
    );
    expect(resolvePrevouts).toHaveBeenCalled();
  });

  it("surfaces a clear error and resets the button when the import throws unexpectedly", async () => {
    primeBannerState();
    getMissingSourceTxids.mockResolvedValue(["txMissing1"]);
    getNodeSettings.mockResolvedValue({ id: "default", type: "esplora" });
    getBlockHeight.mockResolvedValue(800000);
    // The backfill blows up mid-run (e.g. an unexpected DB/IPC failure).
    runTxidBackfill.mockRejectedValue(new Error("kaboom"));

    await renderAndWaitForBanner();
    fireEvent.click(screen.getByTestId("button-import-missing-history"));

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Import failed",
          variant: "destructive",
        }),
      ),
    );

    // The catch path threw before any successful import, so no resolve pass.
    expect(resolvePrevouts).not.toHaveBeenCalled();

    // The finally block must clear the importing state so the button returns to
    // its idle (non-spinning) label rather than being stuck on "Importing…".
    await waitFor(() => {
      const button = screen.getByTestId("button-import-missing-history");
      expect(button.textContent).toContain("Import missing history");
      expect(button.textContent).not.toContain("Importing");
      expect((button as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("keeps what was imported and shows the 'kept N' copy when cancelled mid-run", async () => {
    primeBannerState({ unresolved: 5, unattributable: 5 });
    getMissingSourceTxids.mockResolvedValue(["txMissing1", "txMissing2"]);
    getNodeSettings.mockResolvedValue({ id: "default", type: "esplora" });
    getBlockHeight.mockResolvedValue(800000);
    // Simulate the user clicking "Cancel" while the backfill is in flight: the
    // run's signal becomes aborted but two source transactions were already
    // imported and must be kept.
    runTxidBackfill.mockImplementation(async () => {
      await waitFor(() =>
        expect(screen.getByTestId("button-cancel-import-history")).toBeTruthy(),
      );
      fireEvent.click(screen.getByTestId("button-cancel-import-history"));
      return { rebuilt: 2, failed: 0 };
    });

    await renderAndWaitForBanner();
    fireEvent.click(screen.getByTestId("button-import-missing-history"));

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Import cancelled",
          description: expect.stringContaining(
            "Kept 2 source transactions imported so far",
          ),
        }),
      ),
    );
    // Cancelled → the follow-up resolve pass must be skipped even though some
    // transactions were imported.
    expect(resolvePrevouts).not.toHaveBeenCalled();

    // The finally block must clear the importing state so the button returns to
    // its idle (non-spinning) label rather than being stuck on "Importing…".
    await waitFor(() => {
      const button = screen.getByTestId("button-import-missing-history");
      expect(button.textContent).toContain("Import missing history");
      expect(button.textContent).not.toContain("Importing");
      expect((button as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("shows the 'stopped before any imported' copy when cancelled before anything imported", async () => {
    primeBannerState();
    getMissingSourceTxids.mockResolvedValue(["txMissing1"]);
    getNodeSettings.mockResolvedValue({ id: "default", type: "esplora" });
    getBlockHeight.mockResolvedValue(800000);
    runTxidBackfill.mockImplementation(async () => {
      await waitFor(() =>
        expect(screen.getByTestId("button-cancel-import-history")).toBeTruthy(),
      );
      fireEvent.click(screen.getByTestId("button-cancel-import-history"));
      return { rebuilt: 0, failed: 0 };
    });

    await renderAndWaitForBanner();
    fireEvent.click(screen.getByTestId("button-import-missing-history"));

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Import cancelled",
          description: "Stopped before any source transactions were imported.",
        }),
      ),
    );
    expect(resolvePrevouts).not.toHaveBeenCalled();
  });

  it("explains a node outage when the import fails on a connectivity error", async () => {
    primeBannerState();
    getMissingSourceTxids.mockResolvedValue(["txMissing1"]);
    getNodeSettings.mockResolvedValue({ id: "default", type: "esplora" });
    getBlockHeight.mockResolvedValue(800000);
    // The backfill fails while reaching the node for a source transaction.
    runTxidBackfill.mockRejectedValue(new Error("connection to node timed out"));

    await renderAndWaitForBanner();
    fireEvent.click(screen.getByTestId("button-import-missing-history"));

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Import failed",
          variant: "destructive",
          description: expect.stringContaining("Couldn't reach your Bitcoin node"),
        }),
      ),
    );
  });

  it("explains an internal error when the import fails for a non-connectivity reason", async () => {
    primeBannerState();
    getMissingSourceTxids.mockResolvedValue(["txMissing1"]);
    getNodeSettings.mockResolvedValue({ id: "default", type: "esplora" });
    getBlockHeight.mockResolvedValue(800000);
    // The backfill blows up for an unexpected, non-network reason.
    runTxidBackfill.mockRejectedValue(new Error("kaboom"));

    await renderAndWaitForBanner();
    fireEvent.click(screen.getByTestId("button-import-missing-history"));

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Import failed",
          variant: "destructive",
          description: expect.stringContaining("An internal error stopped the resolve"),
        }),
      ),
    );
  });

  it("reports when no history could be imported (all fetches failed)", async () => {
    primeBannerState();
    getMissingSourceTxids.mockResolvedValue(["txMissing1"]);
    getNodeSettings.mockResolvedValue({ id: "default", type: "esplora" });
    getBlockHeight.mockResolvedValue(800000);
    runTxidBackfill.mockResolvedValue({ rebuilt: 0, failed: 1 });

    await renderAndWaitForBanner();
    fireEvent.click(screen.getByTestId("button-import-missing-history"));

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "No history imported",
          variant: "destructive",
        }),
      ),
    );
    // Nothing imported → no resolve pass kicked off.
    expect(resolvePrevouts).not.toHaveBeenCalled();
  });

  it("shows import success (not 'Import failed') when the follow-up resolve pass throws", async () => {
    // The import itself saves one source transaction successfully …
    primeBannerState({ unresolved: 3, unattributable: 3 });
    getMissingSourceTxids.mockResolvedValue(["txMissing1"]);
    getNodeSettings.mockResolvedValue({ id: "default", type: "esplora" });
    getBlockHeight.mockResolvedValue(800000);
    runTxidBackfill.mockResolvedValue({ rebuilt: 1, failed: 0 });

    // … but the follow-up prevout-resolution/recompute pass fails (e.g. the node
    // dropped the connection between the import and the resolve step).
    resolvePrevouts.mockRejectedValue(new Error("connection reset"));

    // The prevout counts stay the same (resolve failed → nothing changed).
    countUnresolvedPrevoutInputs.mockResolvedValue(2);
    getUnresolvedSpendBreakdown.mockResolvedValue({
      byRecordId: new Map<number, number>(),
      unattributable: 2,
    });

    await renderAndWaitForBanner();
    fireEvent.click(screen.getByTestId("button-import-missing-history"));

    // The import succeeded (rebuilt=1), so the toast must report success — NOT "Import failed".
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: "History imported" }),
      ),
    );
    // "Import failed" must never fire — the transactions were saved.
    const failCalls = toastSpy.mock.calls.filter(
      (c: Parameters<typeof toastSpy>) => (c[0] as { title?: string })?.title === "Import failed",
    );
    expect(failCalls).toHaveLength(0);

    // The button must be fully reset after the handler completes.
    await waitFor(() => {
      const button = screen.getByTestId("button-import-missing-history");
      expect(button.textContent).toContain("Import missing history");
      expect(button.textContent).not.toContain("Importing");
      expect((button as HTMLButtonElement).disabled).toBe(false);
    });
  });
});

// @vitest-environment jsdom
//
// Regression coverage for the Standard-mode accuracy warning on the SQLite
// engine fast path. When engineDecision === 'engine' the page clears
// `participants` to [], so the Dexie coverage scan reports total = 0 and the
// "only X% of inputs have outpoint data" warning (plus its one-click
// "Re-sync N affected addresses" button) would silently vanish unless the
// page asks the engine for coverage via engineGetOutpointCoverage. These
// tests pin that wiring at the page level:
//   1. engine-provided coverage renders the warning + re-sync button;
//   2. an engine coverage failure never falsely claims 100% coverage.
import "fake-indexeddb/auto";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, cleanup, fireEvent } from "@testing-library/react";

// jsdom has no layout: render every row instead of a measured window.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number; estimateSize: (i: number) => number }) => {
    const items = Array.from({ length: opts.count }, (_, index) => ({
      index,
      key: index,
      start: index * 56,
      size: opts.estimateSize(index),
    }));
    return {
      getTotalSize: () => opts.count * 56,
      getVirtualItems: () => items,
      measureElement: () => {},
    };
  },
}));

// ScrollPositionIndicator uses window.matchMedia, which jsdom lacks.
vi.mock("@/components/ScrollPositionIndicator", () => ({
  ScrollPositionIndicator: () => null,
}));

// Force the ENGINE path: freshness always says the mirror is usable.
vi.mock("@/lib/engine/engine-freshness", () => ({
  evaluateEngineFreshness: vi.fn().mockResolvedValue({ useEngine: true }),
}));

// Engine client: the owned-UTXO queries return an empty set (the warning is
// independent of rows on screen); coverage is swapped per test.
const engineGetOutpointCoverage = vi.fn();
vi.mock("@/lib/engine/engine-client", () => ({
  engineGetOwnedUtxos: vi.fn().mockResolvedValue([]),
  engineCountOwnedUtxos: vi.fn().mockResolvedValue(0),
  engineGetHeuristicOwnedUtxos: vi.fn().mockResolvedValue([]),
  engineCountHeuristicOwnedUtxos: vi.fn().mockResolvedValue(0),
  get engineGetOutpointCoverage() {
    return engineGetOutpointCoverage;
  },
}));

// Sync plumbing is out of scope here — stubbed so the click path can't hit a
// network even accidentally.
vi.mock("@/lib/transaction-sync", () => ({
  transactionSyncService: {
    syncSingleAddress: vi.fn(async () => ({ success: true })),
    updateProvider: vi.fn(),
  },
}));
vi.mock("@/lib/data/node-settings-crud", () => ({
  getNodeSettings: vi.fn(async () => ({ useElectrum: false })),
}));
vi.mock("@/lib/blockchain-api", () => ({
  createProviderFromSettings: vi.fn(() => ({
    getBlockHeight: async () => 800_000,
  })),
}));

import { renderWithProviders } from "@/test/testProviders";
import UTXOs from "./UTXOs";

beforeAll(() => {
  Element.prototype.scrollTo = () => {};
  Element.prototype.scrollIntoView = vi.fn();
  (Element.prototype as any).hasPointerCapture = vi.fn();
});

// Open the Radix "Calculation Mode" <Select> via keyboard (pointer events
// don't open it under jsdom) and pick "Exact (Beta)". The page no longer
// persists this choice to localStorage, so tests must drive it via the UI.
async function switchModeToExact() {
  const trigger = await screen.findByTestId("select-utxo-mode");
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
  const option = await screen.findByRole("option", { name: /^Exact \(Beta\)$/ });
  fireEvent.click(option);
}

const ADDR_1 = "bc1qaffectedaddressone000000000000000000001";
const ADDR_2 = "bc1qaffectedaddresstwo000000000000000000002";

describe("UTXOs coverage warning on the engine fast path", () => {
  beforeEach(() => {
    // The page no longer persists any settings to localStorage.
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the Standard-mode warning and re-sync button from engine-provided coverage", async () => {
    // 2 of 4 inputs carry outpoint data → 50% coverage, two affected addresses.
    engineGetOutpointCoverage.mockResolvedValue({
      total: 4,
      withData: 2,
      affectedAddresses: [ADDR_1, ADDR_2],
    });

    renderWithProviders(<UTXOs />);

    const warning = await screen.findByTestId(
      "text-heuristic-coverage-warning",
      {},
      { timeout: 10000 },
    );
    expect(warning.textContent).toContain("only 50% of inputs have outpoint data");

    const button = await screen.findByTestId("button-resync-affected", {}, { timeout: 10000 });
    expect(button.textContent).toContain("Re-sync 2 affected addresses");

    // The coverage really came from the engine (participants are cleared to []
    // on this path, so the Dexie scan could never have produced total = 4).
    expect(engineGetOutpointCoverage).toHaveBeenCalled();
  });

  it("does not falsely claim 100% coverage when the engine coverage query fails", async () => {
    // Exact mode makes the claim observable: 100% renders "using outpoint-based
    // UTXO matching", 0% renders the "requires re-sync" warning.
    engineGetOutpointCoverage.mockRejectedValue(new Error("engine worker crashed"));

    renderWithProviders(<UTXOs />);
    await switchModeToExact();

    await waitFor(
      () => {
        expect(engineGetOutpointCoverage).toHaveBeenCalled();
      },
      { timeout: 10000 },
    );

    // Failure must degrade to the zero-coverage warning, never to a green
    // full-coverage claim.
    await waitFor(
      () => {
        expect(
          screen.getByText(/Exact mode requires re-sync to populate outpoint data/),
        ).toBeTruthy();
      },
      { timeout: 10000 },
    );
    expect(screen.queryByText(/using outpoint-based UTXO matching/)).toBeNull();
  });
});

// @vitest-environment jsdom
//
// Tests for the "Hide 0-transaction addresses" toggle in the Address Checker.
//
// The toggle must (a) be absent before any results exist, (b) when enabled,
// hide only rows that finished with 0 confirmed transactions while keeping
// errored and invalid rows visible, and (c) show an accurate hidden-row count.

import { describe, it, expect, beforeEach, vi } from "vitest";
import "fake-indexeddb/auto";
import { screen, waitFor, fireEvent, within, cleanup } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

// Radix Tooltips only render their content on hover; render the parts inline so
// the page needs no TooltipProvider in the tree.
// Render every virtualized row (jsdom's zero-size scroll element would
// otherwise render none).
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, index) => ({
        index,
        key: index,
        start: index * 53,
        size: 53,
        end: (index + 1) * 53,
      })),
    getTotalSize: () => opts.count * 53,
    measureElement: () => {},
  }),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/hooks/use-node-settings", () => ({
  useNodeSettings: () => ({ nodeSettings: { id: "default", providerType: "mempool-space" } }),
}));

const getAddressCoreStats = vi.fn();
const createProviderFromSettings = vi.fn(() => ({ getAddressCoreStats }));
// The shared provider harness (RecordDetailPanel -> transaction-sync) imports
// more than createProviderFromSettings — keep the originals, override one.
vi.mock("@/lib/blockchain-api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createProviderFromSettings: (...a: unknown[]) => createProviderFromSettings(...a),
}));

// The "In Vault" column's batched membership lookup hits Dexie; these tests
// don't seed a vault, so stub it to an empty result.
vi.mock("@/lib/data/record-crud", () => ({
  getSavedAddressRecordLookup: async () => new Map(),
}));

import AddressChecker from "./AddressChecker";

// Valid mainnet addresses.
const ADDR_EMPTY = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const ADDR_ACTIVE = "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3";
const ADDR_ERROR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const ADDR_INVALID = "not-a-bitcoin-address";

async function runCheckWithAllRows() {
  fireEvent.change(screen.getByTestId("textarea-address-input"), {
    target: { value: `${ADDR_EMPTY}\n${ADDR_ACTIVE}\n${ADDR_ERROR}\n${ADDR_INVALID}` },
  });
  fireEvent.click(screen.getByTestId("button-run-check"));
  await waitFor(() => {
    expect(screen.getByTestId("button-reset-check")).toBeTruthy();
  });
}

describe("AddressChecker — hide 0-transaction rows toggle", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    getAddressCoreStats.mockImplementation(async (address: string) => {
      if (address === ADDR_EMPTY) {
        return { txCount: 0, receivedSats: 0, sentSats: 0, balanceSats: 0 };
      }
      if (address === ADDR_ERROR) {
        throw new Error("node unreachable");
      }
      return { txCount: 3, receivedSats: 100000, sentSats: 40000, balanceSats: 60000 };
    });
  });

  it("does not show the toggle before any results exist", () => {
    renderWithProviders(<AddressChecker />);
    expect(screen.queryByTestId("checkbox-hide-zero-tx")).toBeNull();
  });

  it("hides done-zero rows only, keeps error/invalid rows, and shows the hidden count", async () => {
    renderWithProviders(<AddressChecker />);
    await runCheckWithAllRows();

    // Rows (original indexes): 0 = done/0-tx, 1 = done/active, 2 = error, 3 = invalid.
    expect(within(screen.getByTestId("row-address-0")).getByText("Done")).toBeTruthy();
    expect(within(screen.getByTestId("row-address-1")).getByText("Done")).toBeTruthy();
    expect(within(screen.getByTestId("row-address-2")).getByText("Error")).toBeTruthy();
    expect(within(screen.getByTestId("row-address-3")).getByText("Invalid")).toBeTruthy();

    // No hidden-count label while the toggle is off.
    expect(screen.queryByTestId("text-hidden-count")).toBeNull();

    fireEvent.click(screen.getByTestId("checkbox-hide-zero-tx"));

    // Only the done row with 0 transactions disappears.
    await waitFor(() => {
      expect(screen.queryByTestId("row-address-0")).toBeNull();
    });
    expect(screen.getByTestId("row-address-1")).toBeTruthy();
    expect(screen.getByTestId("row-address-2")).toBeTruthy();
    expect(screen.getByTestId("row-address-3")).toBeTruthy();

    // Original-index test-ids are preserved for the remaining rows.
    expect(screen.getByTestId("cell-txcount-1").textContent).toBe("3");

    // Hidden-count label reads "1 address hidden" (singular).
    expect(screen.getByTestId("text-hidden-count").textContent).toBe("1 address hidden");

    // Toggling back off restores the row and removes the label.
    fireEvent.click(screen.getByTestId("checkbox-hide-zero-tx"));
    await waitFor(() => {
      expect(screen.getByTestId("row-address-0")).toBeTruthy();
    });
    expect(screen.queryByTestId("text-hidden-count")).toBeNull();
  });

  it("resets the toggle to off on Reset", async () => {
    renderWithProviders(<AddressChecker />);
    await runCheckWithAllRows();

    fireEvent.click(screen.getByTestId("checkbox-hide-zero-tx"));
    await waitFor(() => {
      expect(screen.queryByTestId("row-address-0")).toBeNull();
    });

    fireEvent.click(screen.getByTestId("button-reset-check"));
    expect(screen.queryByTestId("checkbox-hide-zero-tx")).toBeNull();

    // Run again in the same mounted component: the toggle is back and unchecked.
    await runCheckWithAllRows();
    expect(screen.getByTestId("checkbox-hide-zero-tx").getAttribute("data-state")).toBe("unchecked");
    expect(screen.getByTestId("row-address-0")).toBeTruthy();
  });
});

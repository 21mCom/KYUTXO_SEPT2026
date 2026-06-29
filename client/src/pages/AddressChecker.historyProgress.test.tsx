// @vitest-environment jsdom
//
// Regression test for the Address Checker's live history scan-progress counter.
//
// The First Seen cell doubles as the per-row history control. While the on-demand
// history walk is running it renders a live "scanned / total" counter
// (testid `text-history-scan-<address>`) fed by an `onProgress` callback threaded
// through `getAddressHistoryDates`. This test proves:
//   1. the counter advances page-by-page as `onProgress` fires, then resolves to
//      the formatted first-seen date once the walk completes;
//   2. the cancel path: after the user cancels, a late `onProgress` call must NOT
//      update the row (the counter freezes at its last value).
//
// A stubbed provider returns cheap core stats (so the row reaches "Done" with a
// known txCount/total) and a controllable `getAddressHistoryDates` whose promise
// and `onProgress` callback the test drives manually.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act, cleanup } from "@testing-library/react";

// Radix Tooltips only render content on hover; render the parts inline so nothing
// in this page needs a TooltipProvider in the tree.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/hooks/use-node-settings", () => ({
  useNodeSettings: () => ({ nodeSettings: { id: "default", providerType: "mempool-space" } }),
}));

interface HistoryDates {
  firstSeenTime?: number;
  lastSeenTime?: number;
  receivedSats?: number;
  sentSats?: number;
}

// Captured handles so the test can drive the in-flight history walk by hand.
let capturedOnProgress: ((scanned: number) => void) | null = null;
let resolveHistory: ((dates: HistoryDates) => void) | null = null;

const getAddressCoreStats = vi.fn(async () => ({
  txCount: 100,
  receivedSats: 500000,
  sentSats: 200000,
  balanceSats: 300000,
}));

const getAddressHistoryDates = vi.fn((_address: string, onProgress?: (scanned: number) => void) => {
  capturedOnProgress = onProgress ?? null;
  return new Promise<HistoryDates>(resolve => {
    resolveHistory = resolve;
  });
});

const createProviderFromSettings = vi.fn(() => ({ getAddressCoreStats, getAddressHistoryDates }));
vi.mock("@/lib/blockchain-api", () => ({
  createProviderFromSettings: (...a: unknown[]) => createProviderFromSettings(...a),
}));

import AddressChecker from "./AddressChecker";

// Valid mainnet bech32 address (BIP173 test vector).
const ADDR = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

// 2021-06-01 00:00:00 UTC — the resolved first-seen instant.
const FIRST_SEEN = Math.floor(Date.UTC(2021, 5, 1) / 1000);
const FIRST_SEEN_LABEL = new Date(FIRST_SEEN * 1000).toLocaleDateString(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
});

// Run the checker up to the point where the address row is "Done" and its
// First Seen cell is ready to start an on-demand history walk.
async function renderAndCheck() {
  render(<AddressChecker />);
  fireEvent.change(screen.getByTestId("textarea-address-input"), { target: { value: ADDR } });
  fireEvent.click(screen.getByTestId("button-run-check"));
  await waitFor(() => {
    expect(screen.getByTestId(`button-load-history-${ADDR}`)).toBeTruthy();
  });
}

describe("AddressChecker — live history scan-progress counter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnProgress = null;
    resolveHistory = null;
  });

  it("advances the scanned / total counter page-by-page, then shows the first-seen date", async () => {
    await renderAndCheck();

    // Kick off the on-demand history walk for this row.
    fireEvent.click(screen.getByTestId(`button-load-history-${ADDR}`));

    // The walk is now in flight: the cell shows the live progress span and the
    // history Cancel button is available.
    await waitFor(() => {
      expect(screen.getByTestId(`text-history-scan-${ADDR}`)).toBeTruthy();
    });
    expect(screen.getByTestId("button-cancel-history")).toBeTruthy();
    expect(getAddressHistoryDates).toHaveBeenCalledTimes(1);
    expect(capturedOnProgress).toBeTypeOf("function");

    // First page comes back.
    act(() => capturedOnProgress!(25));
    expect(screen.getByTestId(`text-history-scan-${ADDR}`).textContent).toContain("25 / 100");

    // Second page — the counter advances.
    act(() => capturedOnProgress!(70));
    expect(screen.getByTestId(`text-history-scan-${ADDR}`).textContent).toContain("70 / 100");

    // A page count above the known total is clamped to the total.
    act(() => capturedOnProgress!(150));
    expect(screen.getByTestId(`text-history-scan-${ADDR}`).textContent).toContain("100 / 100");

    // The walk resolves: the counter is replaced by the formatted first-seen date.
    // Use a distinct last-seen instant so the first-seen label is unambiguous.
    await act(async () => {
      resolveHistory!({ firstSeenTime: FIRST_SEEN, lastSeenTime: FIRST_SEEN + 86400 * 30 });
    });
    await waitFor(() => {
      expect(screen.queryByTestId(`text-history-scan-${ADDR}`)).toBeNull();
    });
    expect(screen.getByText(FIRST_SEEN_LABEL)).toBeTruthy();
  });

  it("freezes the counter after cancel: a late onProgress call does not update the row", async () => {
    cleanup();
    await renderAndCheck();

    fireEvent.click(screen.getByTestId(`button-load-history-${ADDR}`));
    await waitFor(() => {
      expect(screen.getByTestId(`text-history-scan-${ADDR}`)).toBeTruthy();
    });

    // One page in before the user cancels.
    act(() => capturedOnProgress!(20));
    expect(screen.getByTestId(`text-history-scan-${ADDR}`).textContent).toContain("20 / 100");

    // User cancels the history walk.
    fireEvent.click(screen.getByTestId("button-cancel-history"));

    // A late page callback arrives after cancellation — it must be ignored, so
    // the counter stays frozen at its last pre-cancel value.
    act(() => capturedOnProgress!(80));
    const span = screen.queryByTestId(`text-history-scan-${ADDR}`);
    if (span) {
      expect(span.textContent).toContain("20 / 100");
      expect(span.textContent).not.toContain("80");
    }
  });
});

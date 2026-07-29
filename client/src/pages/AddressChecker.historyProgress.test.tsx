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

interface HistoryDates {
  firstSeenTime?: number;
  lastSeenTime?: number;
  receivedSats?: number;
  sentSats?: number;
}

// Captured handles so the test can drive the in-flight history walk by hand.
let capturedOnProgress: ((scanned: number) => void) | null = null;
let resolveHistory: ((dates: HistoryDates) => void) | null = null;
// Every history call, in order, so multi-run tests can resolve old walks late.
let historyCalls: { address: string; resolve: (dates: HistoryDates) => void }[] = [];

const getAddressCoreStats = vi.fn(async () => ({
  txCount: 100,
  receivedSats: 500000,
  sentSats: 200000,
  balanceSats: 300000,
}));

const getAddressHistoryDates = vi.fn((address: string, onProgress?: (scanned: number) => void) => {
  capturedOnProgress = onProgress ?? null;
  return new Promise<HistoryDates>(resolve => {
    resolveHistory = resolve;
    historyCalls.push({ address, resolve });
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
    historyCalls = [];
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

    // First page comes back. Progress ticks are buffered and flushed on a short
    // interval, so wait for the flush rather than asserting synchronously.
    act(() => capturedOnProgress!(25));
    await waitFor(() => {
      expect(screen.getByTestId(`text-history-scan-${ADDR}`).textContent).toContain("25 / 100");
    });

    // Second page — the counter advances.
    act(() => capturedOnProgress!(70));
    await waitFor(() => {
      expect(screen.getByTestId(`text-history-scan-${ADDR}`).textContent).toContain("70 / 100");
    });

    // A page count above the known total is clamped to the total.
    act(() => capturedOnProgress!(150));
    await waitFor(() => {
      expect(screen.getByTestId(`text-history-scan-${ADDR}`).textContent).toContain("100 / 100");
    });

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

    // One page in before the user cancels (wait for the buffered flush).
    act(() => capturedOnProgress!(20));
    await waitFor(() => {
      expect(screen.getByTestId(`text-history-scan-${ADDR}`).textContent).toContain("20 / 100");
    });

    // User cancels the history walk.
    fireEvent.click(screen.getByTestId("button-cancel-history"));

    // A late page callback arrives after cancellation — it must be ignored, so
    // the counter stays frozen at its last pre-cancel value. Wait past a flush
    // interval to prove the buffered tick is dropped, not merely delayed.
    act(() => capturedOnProgress!(80));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 400));
    });
    const span = screen.queryByTestId(`text-history-scan-${ADDR}`);
    if (span) {
      expect(span.textContent).toContain("20 / 100");
      expect(span.textContent).not.toContain("80");
    }
  });

  it("a cancelled run's stale worker cannot mutate rows or stop a newer run", async () => {
    cleanup();
    // Second valid mainnet bech32 address (BIP173 P2WSH test vector).
    const ADDR2 = "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv2";

    render(<AddressChecker />);
    fireEvent.change(screen.getByTestId("textarea-address-input"), {
      target: { value: `${ADDR}\n${ADDR2}` },
    });
    fireEvent.click(screen.getByTestId("button-run-check"));
    await waitFor(() => {
      expect(screen.getByTestId(`button-load-history-${ADDR}`)).toBeTruthy();
      expect(screen.getByTestId(`button-load-history-${ADDR2}`)).toBeTruthy();
    });

    // Run 1: start a walk for ADDR, then cancel it while it is in flight.
    fireEvent.click(screen.getByTestId(`button-load-history-${ADDR}`));
    await waitFor(() => {
      expect(screen.getByTestId(`text-history-scan-${ADDR}`)).toBeTruthy();
    });
    expect(historyCalls).toHaveLength(1);
    fireEvent.click(screen.getByTestId("button-cancel-history"));
    // Cancel promptly reverts the loading row to idle (Load button is back).
    await waitFor(() => {
      expect(screen.getByTestId(`button-load-history-${ADDR}`)).toBeTruthy();
    });

    // Run 2 starts immediately for ADDR2 while run 1's walk is still unresolved.
    fireEvent.click(screen.getByTestId(`button-load-history-${ADDR2}`));
    await waitFor(() => {
      expect(screen.getByTestId(`text-history-scan-${ADDR2}`)).toBeTruthy();
    });
    expect(historyCalls).toHaveLength(2);

    // Run 1's stale walk now resolves late — it must not mark ADDR done...
    await act(async () => {
      historyCalls[0].resolve({ firstSeenTime: FIRST_SEEN, lastSeenTime: FIRST_SEEN });
    });
    expect(screen.getByTestId(`button-load-history-${ADDR}`)).toBeTruthy();
    expect(screen.queryByText(FIRST_SEEN_LABEL)).toBeNull();
    // ...and its finalizer must not stop the newer run (Cancel still shown,
    // ADDR2's walk still in flight).
    expect(screen.getByTestId("button-cancel-history")).toBeTruthy();
    expect(screen.getByTestId(`text-history-scan-${ADDR2}`)).toBeTruthy();

    // Run 2 finishes normally: ADDR2 gets its date and the run winds down.
    await act(async () => {
      historyCalls[1].resolve({ firstSeenTime: FIRST_SEEN, lastSeenTime: FIRST_SEEN + 86400 * 30 });
    });
    await waitFor(() => {
      expect(screen.queryByTestId(`text-history-scan-${ADDR2}`)).toBeNull();
    });
    expect(screen.getByText(FIRST_SEEN_LABEL)).toBeTruthy();
    expect(screen.queryByTestId("button-cancel-history")).toBeNull();
    // ADDR remains untouched and retryable.
    expect(screen.getByTestId(`button-load-history-${ADDR}`)).toBeTruthy();
  });

  it("a cancelled walk stays dead across Reset + a fresh address check", async () => {
    cleanup();
    await renderAndCheck();

    // Start a walk, then cancel it while its promise is still pending.
    fireEvent.click(screen.getByTestId(`button-load-history-${ADDR}`));
    await waitFor(() => {
      expect(screen.getByTestId(`text-history-scan-${ADDR}`)).toBeTruthy();
    });
    expect(historyCalls).toHaveLength(1);
    fireEvent.click(screen.getByTestId("button-cancel-history"));

    // Reset and run a brand-new check over the same address. runCheck clears
    // the history cancel flag — the old worker must stay stale regardless.
    fireEvent.click(screen.getByTestId("button-reset-check"));
    fireEvent.change(screen.getByTestId("textarea-address-input"), { target: { value: ADDR } });
    fireEvent.click(screen.getByTestId("button-run-check"));
    await waitFor(() => {
      expect(screen.getByTestId(`button-load-history-${ADDR}`)).toBeTruthy();
    });

    // The cancelled run's walk resolves late: it must not mark the new row done
    // or surface a first-seen date on the fresh dataset.
    await act(async () => {
      historyCalls[0].resolve({ firstSeenTime: FIRST_SEEN, lastSeenTime: FIRST_SEEN });
    });
    expect(screen.getByTestId(`button-load-history-${ADDR}`)).toBeTruthy();
    expect(screen.queryByText(FIRST_SEEN_LABEL)).toBeNull();
    expect(screen.queryByTestId("button-cancel-history")).toBeNull();
  });

  it("a new check while a history walk is in flight frees the history controls", async () => {
    cleanup();
    await renderAndCheck();

    // Start a walk and leave it in flight (promise never resolved yet).
    fireEvent.click(screen.getByTestId(`button-load-history-${ADDR}`));
    await waitFor(() => {
      expect(screen.getByTestId(`text-history-scan-${ADDR}`)).toBeTruthy();
    });
    expect(historyCalls).toHaveLength(1);

    // Start a brand-new check WITHOUT cancelling history first. The new check
    // takes ownership of the rows and must clear the history-running state so
    // the Load controls are usable on the fresh dataset.
    fireEvent.click(screen.getByTestId("button-run-check"));
    await waitFor(() => {
      const loadButton = screen.getByTestId(`button-load-history-${ADDR}`) as HTMLButtonElement;
      expect(loadButton.disabled).toBe(false);
    });
    expect(screen.queryByTestId("button-cancel-history")).toBeNull();

    // The superseded walk resolving late must not mutate the new dataset...
    await act(async () => {
      historyCalls[0].resolve({ firstSeenTime: FIRST_SEEN, lastSeenTime: FIRST_SEEN });
    });
    expect(screen.queryByText(FIRST_SEEN_LABEL)).toBeNull();

    // ...and a new history walk can start normally on the fresh rows.
    fireEvent.click(screen.getByTestId(`button-load-history-${ADDR}`));
    await waitFor(() => {
      expect(screen.getByTestId(`text-history-scan-${ADDR}`)).toBeTruthy();
    });
    expect(historyCalls).toHaveLength(2);
  });
});

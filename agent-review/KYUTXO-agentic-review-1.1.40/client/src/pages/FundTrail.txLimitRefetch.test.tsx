// @vitest-environment jsdom
//
// Refetch test: changing `settings.fundTrailTxLimit` must automatically
// recompute the Fund Trail center hop. The center-hop useQuery keys on
// fundTrailTxLimit, so when the user edits the limit in Settings, React Query
// should see a new query key and refetch — re-invoking computeOneHop with the
// new cap rather than leaving the user staring at stale results.
//
// The sibling FundTrail.txLimitWiring.test.tsx proves the *current* value is
// threaded through; this test proves the query actually RE-FIRES when the value
// changes. It mutates the mocked fundTrailTxLimit between renders (reusing the
// SAME QueryClient) and asserts computeOneHop is called again with the new
// limit for the center hop. Reusing the client is what makes this meaningful:
// if fundTrailTxLimit were dropped from the query key, React Query would serve
// the cached center hop and never refetch, so this test would fail.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TrailHop } from "@/lib/data/fund-trail-engine";

// ResizeObserver shim (some shadcn primitives reach for it).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

const INITIAL_TX_LIMIT = 50;
const NEW_TX_LIMIT = 123;

// --- useSettings: report a *mutable* fundTrailTxLimit --------------------
// Reading from a module-level holder lets the test change the limit between
// renders (simulating the user editing it in Settings) and have the next
// render of FundTrail observe the new value.
let currentTxLimit = INITIAL_TX_LIMIT;
vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({ fundTrailTxLimit: currentTxLimit }),
}));

// --- toast / record-preview: trivial stubs -------------------------------
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}));
vi.mock("@/contexts/RecordPreviewContext", () => ({
  useRecordPreview: () => ({
    openRecordPreview: vi.fn(),
    openRecordPreviewByAddress: vi.fn(),
  }),
}));

// --- Swap radix Select for a native <select> so options are choosable -----
vi.mock("@/components/ui/select", async () => {
  const React = await import("react");
  const SelectTrigger: any = () => null;
  SelectTrigger.__isTrigger = true;
  return {
    Select: ({ value, onValueChange, children }: any) => {
      let testid: string | undefined;
      React.Children.forEach(children, (child: any) => {
        if (child && child.type && child.type.__isTrigger) {
          testid = child.props["data-testid"];
        }
      });
      return React.createElement(
        "select",
        {
          "data-testid": testid,
          value: value ?? "",
          onChange: (e: any) => onValueChange?.(e.target.value),
        },
        children,
      );
    },
    SelectTrigger,
    SelectValue: () => null,
    SelectContent: ({ children }: any) =>
      React.createElement(React.Fragment, null, children),
    SelectItem: ({ value, children }: any) =>
      React.createElement("option", { value }, children),
  };
});

// --- Engine seam: spy on computeOneHop, stub data loaders -----------------
const GROUP = "Exchange";

const CENTER_HOP: TrailHop = {
  sources: [],
  destinations: [],
  isCapped: false,
  shownTxCount: 0,
  totalTxCount: 0,
};

const computeOneHopSpy = vi.fn(async (): Promise<TrailHop> => CENTER_HOP);

vi.mock("@/lib/data/fund-trail-engine", async () => {
  const actual = await vi.importActual<typeof import("@/lib/data/fund-trail-engine")>(
    "@/lib/data/fund-trail-engine",
  );
  return {
    ...actual,
    listGroupValues: vi.fn(async () => [GROUP]),
    getAddressesForGroup: vi.fn(async () => [
      { inputString: "addr-1" },
      { inputString: "addr-2" },
    ]),
    computeOneHop: (...args: unknown[]) =>
      (computeOneHopSpy as unknown as (...a: unknown[]) => Promise<TrailHop>)(...args),
  };
});

const { default: FundTrail } = await import("./FundTrail");

/** Pull the txLimit (from the trailing options arg) out of a spy call. */
function txLimitOf(call: unknown[]): number | undefined {
  const opts = call[call.length - 1] as { txLimit?: number };
  return opts?.txLimit;
}

beforeEach(() => {
  currentTxLimit = INITIAL_TX_LIMIT;
  computeOneHopSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("FundTrail txLimit refetch", () => {
  it("re-runs the center hop with the new limit when fundTrailTxLimit changes", async () => {
    // One shared client across both renders — a stale (unchanged) query key
    // would be served from this cache instead of refetching.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const tree = (
      <QueryClientProvider client={queryClient}>
        <FundTrail />
      </QueryClientProvider>
    );
    const { rerender } = render(tree);

    // Choose a group to fire the initial center hop query.
    await waitFor(() => {
      const sel = screen.getByTestId("fund-trail-group-select") as HTMLSelectElement;
      expect(Array.from(sel.options).some((o) => o.value === GROUP)).toBe(true);
    });
    fireEvent.change(screen.getByTestId("fund-trail-group-select"), {
      target: { value: GROUP },
    });

    await waitFor(() => {
      expect(computeOneHopSpy).toHaveBeenCalled();
    });

    // First run uses the initial limit.
    expect(txLimitOf(computeOneHopSpy.mock.calls[0])).toBe(INITIAL_TX_LIMIT);
    const callsAfterInitial = computeOneHopSpy.mock.calls.length;

    // Simulate the user raising the limit in Settings, then re-render so
    // FundTrail observes the new value (the selected group state persists).
    currentTxLimit = NEW_TX_LIMIT;
    rerender(
      <QueryClientProvider client={queryClient}>
        <FundTrail />
      </QueryClientProvider>,
    );

    // Because the center-hop query key includes fundTrailTxLimit, React Query
    // treats this as a new query and refetches with the new cap.
    await waitFor(() => {
      expect(computeOneHopSpy.mock.calls.length).toBeGreaterThan(callsAfterInitial);
    });

    const latestCall =
      computeOneHopSpy.mock.calls[computeOneHopSpy.mock.calls.length - 1];
    expect(txLimitOf(latestCall)).toBe(NEW_TX_LIMIT);
  });
});

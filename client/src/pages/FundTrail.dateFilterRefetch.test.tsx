// @vitest-environment jsdom
//
// Refetch test: changing the From/To date inputs must automatically recompute
// the Fund Trail center hop. The center-hop useQuery keys on dateRange.start /
// dateRange.end (derived from the date inputs via toDateRange), so when the
// user narrows or widens the window React Query should see a new query key and
// refetch — re-invoking computeOneHop with the new dateRange rather than
// leaving the user staring at stale, all-time results.
//
// The sibling FundTrail.dateFilterResults.test.tsx proves the filter genuinely
// narrows the rendered trail; the sibling FundTrail.txLimitRefetch.test.tsx
// proves the limit re-fires the query. This test is the date-input equivalent
// of the latter: it drives the native <input type="date"> controls (reusing the
// SAME QueryClient) and asserts computeOneHop is called again with the new
// dateRange for the center hop. Reusing the client is what makes this
// meaningful: if dateRange.start/end were dropped from the query key, React
// Query would serve the cached center hop and never refetch, so this test would
// fail.

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

// Window the test types into the From/To inputs.
const FROM = "2023-10-01";
const TO = "2023-12-31";

// Expected unix-second bounds, computed exactly the way toDateRange does
// (local-time start-of-day / end-of-day) so the assertion is independent of the
// runner's timezone.
const EXPECTED_START = Math.floor(new Date(`${FROM}T00:00:00`).getTime() / 1000);
const EXPECTED_END = Math.floor(new Date(`${TO}T23:59:59`).getTime() / 1000);

// --- use-settings: a fixed limit so only the date inputs move the key --------
vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({ fundTrailTxLimit: 50 }),
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

/** Pull the dateRange (4th positional arg) out of a spy call. */
function dateRangeOf(
  call: unknown[],
): { start?: number; end?: number } | undefined {
  return call[3] as { start?: number; end?: number } | undefined;
}

beforeEach(() => {
  computeOneHopSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("FundTrail date filter refetch", () => {
  it("re-runs the center hop with the new dateRange when the From/To inputs change", async () => {
    // One shared client across the whole test — a stale (unchanged) query key
    // would be served from this cache instead of refetching.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <FundTrail />
      </QueryClientProvider>,
    );

    // Choose a group to fire the initial center hop query (no date filter yet).
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

    // First run is unfiltered: dateRange is undefined.
    expect(dateRangeOf(computeOneHopSpy.mock.calls[0])).toBeUndefined();
    const callsAfterInitial = computeOneHopSpy.mock.calls.length;

    // The user narrows the window via the From/To date inputs. Each change
    // updates startDate/endDate, which toDateRange folds into the query key.
    fireEvent.change(screen.getByTestId("input-fund-trail-date-range-from"), {
      target: { value: FROM },
    });
    fireEvent.change(screen.getByTestId("input-fund-trail-date-range-to"), {
      target: { value: TO },
    });

    // Because the center-hop query key includes dateRange.start and
    // dateRange.end, React Query treats this as a new query and refetches with
    // the new window.
    await waitFor(() => {
      expect(computeOneHopSpy.mock.calls.length).toBeGreaterThan(callsAfterInitial);
    });

    const latestCall =
      computeOneHopSpy.mock.calls[computeOneHopSpy.mock.calls.length - 1];
    const latestRange = dateRangeOf(latestCall);
    expect(latestRange).toBeDefined();
    expect(latestRange?.start).toBe(EXPECTED_START);
    expect(latestRange?.end).toBe(EXPECTED_END);
  });
});

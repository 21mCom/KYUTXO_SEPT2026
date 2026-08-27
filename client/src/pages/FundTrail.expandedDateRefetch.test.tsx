// @vitest-environment jsdom
//
// Refetch test for EXPANDED sub-trails: changing the From/To date inputs must
// not only re-run the center hop — it must also re-run any sub-hop the user has
// already expanded, with the SAME new window. Each FlowCard fetches its own
// next hop via computeOneHop; that fetch closes over `dateRange`, and a
// window-change effect re-fires it. A refactor that dropped dateRange from that
// effect's deps would leave an expanded branch frozen on stale all-time results
// while the center hop correctly narrows — exactly the regression this locks in.
//
// This is the expanded-hop equivalent of FundTrail.dateFilterRefetch.test.tsx
// (which proves the center hop re-fires). We render the real FundTrail page,
// select a group, EXPAND one source hop, then drive the date inputs and assert
// the expanded hop's computeOneHop is re-invoked with the new dateRange. Reusing
// the SAME page/QueryClient (the FlowCard stays mounted across the date change)
// is what makes it meaningful: the refetch happens only because dateRange
// changed, not because the component remounted.

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
// (local-time start-of-day / end-of-day) so the assertion is timezone-stable.
const EXPECTED_START = Math.floor(new Date(`${FROM}T00:00:00`).getTime() / 1000);
const EXPECTED_END = Math.floor(new Date(`${TO}T23:59:59`).getTime() / 1000);

// --- use-settings: a fixed limit so only the date inputs move the window -----
vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({ fundTrailTxLimit: 50 }),
}));

// --- toast / record-preview: trivial stubs ----------------------------------
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}));
vi.mock("@/contexts/RecordPreviewContext", () => ({
  useRecordPreview: () => ({
    openRecordPreview: vi.fn(),
    openRecordPreviewByAddress: vi.fn(),
  }),
}));

// --- Swap radix Select for a native <select> so options are choosable --------
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

// --- Engine seam: spy on computeOneHop, stub data loaders --------------------
const GROUP = "Exchange";
const EXPAND_TARGET = "Counterparty";

// The center hop exposes one (uncapped) source the FlowCard can expand. We
// return it for the CENTER computeOneHop call (selfLabel === GROUP) on every
// refetch so the FlowCard keeps the same key and stays mounted across the date
// change rather than disappearing.
const CENTER_HOP: TrailHop = {
  sources: [
    {
      groupLabel: EXPAND_TARGET,
      dimension: "walletName",
      totalSats: 100,
      details: [{ address: "ext-cp", txid: "tx-cp", amount: 100, blockTime: 1000 }],
      isUnknown: false,
    },
  ],
  destinations: [],
  isCapped: false,
  shownTxCount: 1,
  totalTxCount: 1,
};

// The expanded sub-hop result (selfLabel === EXPAND_TARGET).
const EXPAND_HOP: TrailHop = {
  sources: [],
  destinations: [],
  isCapped: false,
  shownTxCount: 5,
  totalTxCount: 5,
};

// Route by selfLabel (3rd positional arg) so call ORDER doesn't matter: the
// center hop and the expanded sub-hop each always get the right shape.
const computeOneHopSpy = vi.fn(async (...args: unknown[]): Promise<TrailHop> => {
  const selfLabel = args[2] as string | null;
  return selfLabel === GROUP ? CENTER_HOP : EXPAND_HOP;
});

vi.mock("@/lib/data/fund-trail-engine", async () => {
  const actual = await vi.importActual<typeof import("@/lib/data/fund-trail-engine")>(
    "@/lib/data/fund-trail-engine",
  );
  return {
    ...actual,
    listGroupValues: vi.fn(async () => [GROUP]),
    getAddressesForGroup: vi.fn(async () => [{ inputString: "addr-1" }]),
    computeOneHop: (...args: unknown[]) =>
      (computeOneHopSpy as unknown as (...a: unknown[]) => Promise<TrailHop>)(...args),
  };
});

const { default: FundTrail } = await import("./FundTrail");

/** Pull the (selfLabel, dateRange) pair out of a spy call. */
function callInfo(
  call: unknown[],
): { selfLabel: string | null; dateRange?: { start?: number; end?: number } } {
  return {
    selfLabel: call[2] as string | null,
    dateRange: call[3] as { start?: number; end?: number } | undefined,
  };
}

beforeEach(() => {
  computeOneHopSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("FundTrail expanded-hop date filter refetch", () => {
  it("re-runs an already-expanded sub-hop with the new dateRange when the From/To inputs change", async () => {
    // One shared client across the whole test — a stale (unchanged) effect
    // would never re-fire computeOneHop for the expanded sub-hop.
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

    // Expand the one source hop. This fires computeOneHop for the SUB-hop
    // (selfLabel === EXPAND_TARGET) with no date filter yet.
    const expandBtn = await screen.findByTestId(`fund-trail-expand-${EXPAND_TARGET}-d0`);
    fireEvent.click(expandBtn);

    await waitFor(() => {
      expect(
        computeOneHopSpy.mock.calls.some(
          (c) => callInfo(c).selfLabel === EXPAND_TARGET,
        ),
      ).toBe(true);
    });

    // The expanded sub-hop's first run is unfiltered: dateRange is undefined.
    const firstExpand = computeOneHopSpy.mock.calls.find(
      (c) => callInfo(c).selfLabel === EXPAND_TARGET,
    )!;
    expect(callInfo(firstExpand).dateRange).toBeUndefined();
    const subHopCallsBefore = computeOneHopSpy.mock.calls.filter(
      (c) => callInfo(c).selfLabel === EXPAND_TARGET,
    ).length;

    // The user narrows the window via the From/To date inputs.
    fireEvent.change(screen.getByTestId("input-fund-trail-date-range-from"), {
      target: { value: FROM },
    });
    fireEvent.change(screen.getByTestId("input-fund-trail-date-range-to"), {
      target: { value: TO },
    });

    // The expanded sub-hop must re-run with the new window (not just the
    // center hop). Wait for a fresh sub-hop call beyond the initial one.
    await waitFor(() => {
      const subHopCallsNow = computeOneHopSpy.mock.calls.filter(
        (c) => callInfo(c).selfLabel === EXPAND_TARGET,
      ).length;
      expect(subHopCallsNow).toBeGreaterThan(subHopCallsBefore);
    });

    // The latest expanded sub-hop call carries the new window — proving the
    // refetch used the changed dateRange, not stale all-time bounds.
    const subHopCalls = computeOneHopSpy.mock.calls.filter(
      (c) => callInfo(c).selfLabel === EXPAND_TARGET,
    );
    const latest = callInfo(subHopCalls[subHopCalls.length - 1]);
    expect(latest.dateRange).toBeDefined();
    expect(latest.dateRange?.start).toBe(EXPECTED_START);
    expect(latest.dateRange?.end).toBe(EXPECTED_END);
  });
});

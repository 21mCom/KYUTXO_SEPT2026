// @vitest-environment jsdom
//
// Refetch test for EXPANDED sub-trails: changing `settings.fundTrailTxLimit`
// must not only re-run the center hop — it must also re-run any sub-hop the user
// has already expanded, with the SAME new cap. Each FlowCard fetches its own
// next hop via computeOneHop; that fetch is re-fired by an effect keyed on
// `refetchKey`, which includes fundTrailTxLimit. A refactor that dropped
// fundTrailTxLimit from that effect's deps would leave an expanded branch capped
// at the OLD limit while the center hop correctly uses the new one — exactly the
// regression this locks in.
//
// This is the tx-limit equivalent of FundTrail.expandedDateRefetch.test.tsx
// (which proves the expanded hop re-fires on a date-window change) and the
// expanded-hop equivalent of FundTrail.txLimitRefetch.test.tsx (which proves the
// CENTER hop re-fires on a limit change). We render the real FundTrail page,
// select a group, EXPAND one source hop, then mutate the mocked fundTrailTxLimit
// (re-rendering so FundTrail observes it) and assert the expanded hop's
// computeOneHop is re-invoked with the new txLimit option. Reusing the SAME
// page/QueryClient (the FlowCard stays mounted across the limit change) is what
// makes it meaningful: the refetch happens only because fundTrailTxLimit
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

// The center hop exposes one source the FlowCard can expand. We return it for
// the CENTER computeOneHop call (selfLabel === GROUP) on every refetch so the
// FlowCard keeps the same key and stays mounted across the limit change rather
// than disappearing.
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

/** Pull the (selfLabel, txLimit) pair out of a spy call. */
function callInfo(call: unknown[]): { selfLabel: string | null; txLimit?: number } {
  const opts = call[call.length - 1] as { txLimit?: number } | undefined;
  return {
    selfLabel: call[2] as string | null,
    txLimit: opts?.txLimit,
  };
}

beforeEach(() => {
  currentTxLimit = INITIAL_TX_LIMIT;
  computeOneHopSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("FundTrail expanded-hop txLimit refetch", () => {
  it("re-runs an already-expanded sub-hop with the new txLimit when fundTrailTxLimit changes", async () => {
    // One shared client across both renders — a stale (unchanged) effect would
    // never re-fire computeOneHop for the expanded sub-hop.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <FundTrail />
      </QueryClientProvider>,
    );

    // Choose a group to fire the initial center hop query.
    await waitFor(() => {
      const sel = screen.getByTestId("fund-trail-group-select") as HTMLSelectElement;
      expect(Array.from(sel.options).some((o) => o.value === GROUP)).toBe(true);
    });
    fireEvent.change(screen.getByTestId("fund-trail-group-select"), {
      target: { value: GROUP },
    });

    // Expand the one source hop. This fires computeOneHop for the SUB-hop
    // (selfLabel === EXPAND_TARGET) with the initial limit.
    const expandBtn = await screen.findByTestId(`fund-trail-expand-${EXPAND_TARGET}-d0`);
    fireEvent.click(expandBtn);

    await waitFor(() => {
      expect(
        computeOneHopSpy.mock.calls.some(
          (c) => callInfo(c).selfLabel === EXPAND_TARGET,
        ),
      ).toBe(true);
    });

    // The expanded sub-hop's first run uses the initial limit.
    const firstExpand = computeOneHopSpy.mock.calls.find(
      (c) => callInfo(c).selfLabel === EXPAND_TARGET,
    )!;
    expect(callInfo(firstExpand).txLimit).toBe(INITIAL_TX_LIMIT);
    const subHopCallsBefore = computeOneHopSpy.mock.calls.filter(
      (c) => callInfo(c).selfLabel === EXPAND_TARGET,
    ).length;

    // Simulate the user raising the limit in Settings, then re-render so
    // FundTrail observes the new value (the selected group + expanded state
    // persist across the re-render).
    currentTxLimit = NEW_TX_LIMIT;
    rerender(
      <QueryClientProvider client={queryClient}>
        <FundTrail />
      </QueryClientProvider>,
    );

    // The expanded sub-hop must re-run with the new cap (not just the center
    // hop). Wait for a fresh sub-hop call beyond the initial one.
    await waitFor(() => {
      const subHopCallsNow = computeOneHopSpy.mock.calls.filter(
        (c) => callInfo(c).selfLabel === EXPAND_TARGET,
      ).length;
      expect(subHopCallsNow).toBeGreaterThan(subHopCallsBefore);
    });

    // The latest expanded sub-hop call carries the new limit — proving the
    // refetch used the changed fundTrailTxLimit, not the stale old cap.
    const subHopCalls = computeOneHopSpy.mock.calls.filter(
      (c) => callInfo(c).selfLabel === EXPAND_TARGET,
    );
    const latest = callInfo(subHopCalls[subHopCalls.length - 1]);
    expect(latest.txLimit).toBe(NEW_TX_LIMIT);
  });
});

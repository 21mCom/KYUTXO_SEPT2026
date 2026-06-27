// @vitest-environment jsdom
//
// Wiring test: the Fund Trail page must thread the user-configured
// `settings.fundTrailTxLimit` through to computeOneHop as `options.txLimit`
// for BOTH the center hop (the initial group query) and every expanded hop
// (the FlowCard "Expand hop" handler).
//
// The engine itself honours options.txLimit (covered by
// fund-trail-engine.txlimit.test.ts); this test locks in the page-level
// plumbing so a future refactor can't silently drop the wiring and revert to
// the hardcoded DEFAULT_TX_LIMIT of 2000.
//
// We render the real FundTrail page but stub the engine seam: computeOneHop is
// a spy that records the options it was called with, listGroupValues /
// getAddressesForGroup return fixed data, and useSettings reports a custom
// fundTrailTxLimit. Selecting a group fires the center hop; clicking a flow
// card's Expand button fires the expand hop. Both calls must carry the custom
// limit.

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

const CUSTOM_TX_LIMIT = 37;

// --- useSettings: report a custom fundTrailTxLimit ------------------------
vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({ fundTrailTxLimit: CUSTOM_TX_LIMIT }),
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
const EXPAND_TARGET = "Counterparty";

// The center hop returns one source flow ("Counterparty") that the FlowCard can
// expand. The expand call returns an empty hop (we only care that it ran).
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

const EXPAND_HOP: TrailHop = {
  sources: [],
  destinations: [],
  isCapped: false,
  shownTxCount: 0,
  totalTxCount: 0,
};

const computeOneHopSpy = vi.fn(async (): Promise<TrailHop> => EXPAND_HOP);

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

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <FundTrail />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  computeOneHopSpy.mockClear();
  // Center hop returns the expandable result; subsequent (expand) calls return
  // the empty hop.
  computeOneHopSpy.mockResolvedValueOnce(CENTER_HOP);
});

afterEach(() => {
  cleanup();
});

describe("FundTrail txLimit wiring", () => {
  it("passes the configured txLimit to the center hop query", async () => {
    renderPage();

    // Choose a group to trigger the center hop query (gated by selectedGroup).
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

    // The center-hop call must carry the configured limit as options.txLimit.
    const centerCall = computeOneHopSpy.mock.calls[0];
    const centerOptions = centerCall[centerCall.length - 1] as { txLimit?: number };
    expect(centerOptions).toEqual({ txLimit: CUSTOM_TX_LIMIT });
  });

  it("passes the configured txLimit to the expand handler", async () => {
    renderPage();

    await waitFor(() => {
      const sel = screen.getByTestId("fund-trail-group-select") as HTMLSelectElement;
      expect(Array.from(sel.options).some((o) => o.value === GROUP)).toBe(true);
    });
    fireEvent.change(screen.getByTestId("fund-trail-group-select"), {
      target: { value: GROUP },
    });

    // Wait for the center hop's source FlowCard (with its Expand button) to render.
    const expandBtn = await screen.findByTestId(
      `fund-trail-expand-${EXPAND_TARGET}-d0`,
    );

    computeOneHopSpy.mockClear();
    fireEvent.click(expandBtn);

    await waitFor(() => {
      expect(computeOneHopSpy).toHaveBeenCalled();
    });

    const expandCall = computeOneHopSpy.mock.calls[0];
    const expandOptions = expandCall[expandCall.length - 1] as { txLimit?: number };
    expect(expandOptions).toEqual({ txLimit: CUSTOM_TX_LIMIT });
  });
});

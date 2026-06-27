// @vitest-environment jsdom
//
// Error-surfacing test: when a FlowCard's "Expand hop" handler computes the
// next hop and computeOneHop REJECTS, the user must see a visible, dismissible
// error on that card — not a silent empty state that looks like the trail
// genuinely ended.
//
// We render the real FundTrail page but stub the engine seam: the center hop
// resolves with one expandable source flow, then the expand call rejects.
// Clicking Expand must surface the error message (and fire a toast), and must
// NOT render the "No further sources found." empty copy.

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

// --- useSettings: report a custom fundTrailTxLimit ------------------------
vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({ fundTrailTxLimit: 2000 }),
}));

// --- toast: capture calls so we can assert the error surfaced ------------
const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
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
const EXPAND_ERROR = "boom: hop computation failed";

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
  toastSpy.mockClear();
  computeOneHopSpy.mockReset();
  // Center hop resolves with the expandable result; the expand call rejects.
  computeOneHopSpy.mockResolvedValueOnce(CENTER_HOP);
});

afterEach(() => {
  cleanup();
});

describe("FundTrail expand error surfacing", () => {
  it("shows a dismissible error (not the empty state) when expand rejects", async () => {
    renderPage();

    await waitFor(() => {
      const sel = screen.getByTestId("fund-trail-group-select") as HTMLSelectElement;
      expect(Array.from(sel.options).some((o) => o.value === GROUP)).toBe(true);
    });
    fireEvent.change(screen.getByTestId("fund-trail-group-select"), {
      target: { value: GROUP },
    });

    const expandBtn = await screen.findByTestId(
      `fund-trail-expand-${EXPAND_TARGET}-d0`,
    );

    // The next computeOneHop (the expand) rejects.
    computeOneHopSpy.mockRejectedValueOnce(new Error(EXPAND_ERROR));
    fireEvent.click(expandBtn);

    // Inline error appears with the message.
    const errorEl = await screen.findByTestId(
      `fund-trail-expand-error-${EXPAND_TARGET}-d0`,
    );
    expect(errorEl.textContent).toContain(EXPAND_ERROR);

    // A toast was fired too.
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );

    // The empty "No further sources found." copy must NOT be shown on error.
    expect(screen.queryByText("No further sources found.")).toBeNull();

    // The error is dismissible.
    fireEvent.click(
      screen.getByTestId(`fund-trail-expand-error-dismiss-${EXPAND_TARGET}-d0`),
    );
    await waitFor(() => {
      expect(
        screen.queryByTestId(`fund-trail-expand-error-${EXPAND_TARGET}-d0`),
      ).toBeNull();
    });
  });
});

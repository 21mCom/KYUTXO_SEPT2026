// @vitest-environment jsdom
//
// Render test: when a hop comes back capped (isCapped=true), the Fund Trail
// page must surface a CapNotice so users know they are tracing an incomplete
// trail. The notice text must reflect the hop's shownTxCount / totalTxCount.
// When a hop is not capped, no notice should render.
//
// Task #771 proved the engine caps and the page passes the configured limit;
// this locks in the *UI* contract so a refactor can't silently drop or
// mis-wire the notice. We render the real FundTrail page but stub the engine
// seam: computeOneHop returns a controllable hop, and the data loaders return
// fixed groups/addresses so selecting a group fires the center hop.

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

// --- useSettings: report a custom fundTrailTxLimit -----------------------
vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({ fundTrailTxLimit: 2000 }),
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

// --- Engine seam: control computeOneHop, stub data loaders ----------------
const GROUP = "Exchange";

const SHOWN = 50;
const TOTAL = 1234;

const CAPPED_HOP: TrailHop = {
  sources: [
    {
      groupLabel: "Counterparty",
      dimension: "walletName",
      totalSats: 100,
      details: [{ address: "ext-cp", txid: "tx-cp", amount: 100, blockTime: 1000 }],
      isUnknown: false,
    },
  ],
  destinations: [],
  isCapped: true,
  shownTxCount: SHOWN,
  totalTxCount: TOTAL,
};

const UNCAPPED_HOP: TrailHop = {
  sources: [
    {
      groupLabel: "Counterparty",
      dimension: "walletName",
      totalSats: 100,
      details: [{ address: "ext-cp", txid: "tx-cp", amount: 100, blockTime: 1000 }],
      isUnknown: false,
    },
  ],
  destinations: [],
  isCapped: false,
  shownTxCount: SHOWN,
  totalTxCount: SHOWN,
};

const computeOneHopSpy = vi.fn(async (): Promise<TrailHop> => UNCAPPED_HOP);

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

async function selectGroup() {
  await waitFor(() => {
    const sel = screen.getByTestId("fund-trail-group-select") as HTMLSelectElement;
    expect(Array.from(sel.options).some((o) => o.value === GROUP)).toBe(true);
  });
  fireEvent.change(screen.getByTestId("fund-trail-group-select"), {
    target: { value: GROUP },
  });
}

beforeEach(() => {
  computeOneHopSpy.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("FundTrail CapNotice", () => {
  it("renders the cap notice with shown/total counts when the center hop is capped", async () => {
    computeOneHopSpy.mockResolvedValue(CAPPED_HOP);
    renderPage();
    await selectGroup();

    const notice = await screen.findByTestId("fund-trail-cap-notice");
    expect(notice).toBeTruthy();
    expect(notice.textContent).toContain(SHOWN.toLocaleString());
    expect(notice.textContent).toContain(TOTAL.toLocaleString());
  });

  it("renders no cap notice when the center hop is not capped", async () => {
    computeOneHopSpy.mockResolvedValue(UNCAPPED_HOP);
    renderPage();
    await selectGroup();

    // Wait for the hop to render (its expandable source FlowCard appears).
    await screen.findByTestId("fund-trail-expand-Counterparty-d0");

    expect(screen.queryByTestId("fund-trail-cap-notice")).toBeNull();
    expect(screen.queryByTestId("fund-trail-cap-notice-range")).toBeNull();
  });
});

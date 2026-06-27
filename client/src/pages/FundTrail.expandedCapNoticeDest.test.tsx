// @vitest-environment jsdom
//
// Expanded-hop CapNotice test — DESTINATION direction. Mirror of
// FundTrail.expandedCapNotice.test.tsx, which only exercises the source
// branch. The destination branch (direction="dest", the "Where X sent to:" /
// expandedHop.destinations path) renders the SAME expandedHop.isCapped notice
// block but through a separate slice of FlowCard's JSX. This test locks in
// that dest path so a refactor can't silently drop the warning for outgoing
// trails, leaving users tracing deeper to follow a silently-incomplete trail.
//
//   - expanded dest hop capped, NO date range  -> all-time notice
//                                                 (testid `fund-trail-cap-notice`)
//   - expanded dest hop capped, date range     -> window-aware notice
//                                                 (testid `fund-trail-cap-notice-range`)
//   - expanded dest hop NOT capped             -> no notice at all
//
// In every capped case the notice text must reflect the expanded hop's
// shownTxCount / totalTxCount.
//
// We render the real FundTrail page but stub the engine seam: computeOneHop is
// a spy that returns an uncapped, expandable CENTER hop first (with a single
// DESTINATION flow, so no center notice appears) and the per-test EXPAND hop
// afterwards. listGroupValues / getAddressesForGroup return fixed data.
// Selecting a group fires the center hop; clicking the dest FlowCard's Expand
// button fires the expand hop.

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

// --- useSettings: a plain tx limit; not the focus of this test --------------
vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({ fundTrailTxLimit: 2000 }),
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
const SHOWN = 50;
const TOTAL = 1234;

// The center hop returns one (uncapped) DESTINATION flow that the FlowCard can
// expand. Keeping it uncapped guarantees any rendered notice belongs to the
// EXPANDED hop, not the center hop.
const CENTER_HOP: TrailHop = {
  sources: [],
  destinations: [
    {
      groupLabel: EXPAND_TARGET,
      dimension: "walletName",
      totalSats: 100,
      details: [{ address: "ext-cp", txid: "tx-cp", amount: 100, blockTime: 1000 }],
      isUnknown: false,
    },
  ],
  isCapped: false,
  shownTxCount: 1,
  totalTxCount: 1,
};

const CAPPED_EXPAND_HOP: TrailHop = {
  sources: [],
  destinations: [],
  isCapped: true,
  shownTxCount: SHOWN,
  totalTxCount: TOTAL,
};

const UNCAPPED_EXPAND_HOP: TrailHop = {
  sources: [],
  destinations: [],
  isCapped: false,
  shownTxCount: SHOWN,
  totalTxCount: SHOWN,
};

const computeOneHopSpy = vi.fn(async (): Promise<TrailHop> => UNCAPPED_EXPAND_HOP);

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

function activateDateRange() {
  fireEvent.change(screen.getByTestId("fund-trail-start-date"), {
    target: { value: "2024-01-01" },
  });
}

async function expandCenterFlow() {
  // The center dest flow renders at depth 0 with direction="dest".
  const expandBtn = await screen.findByTestId(`fund-trail-expand-${EXPAND_TARGET}-d0`);
  fireEvent.click(expandBtn);
}

beforeEach(() => {
  computeOneHopSpy.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("FundTrail expanded-hop cap notice (destination direction)", () => {
  it("shows the all-time notice when the expanded dest hop is capped (no date range)", async () => {
    // First call (center hop) is uncapped & expandable; expand call is capped.
    computeOneHopSpy.mockResolvedValueOnce(CENTER_HOP);
    computeOneHopSpy.mockResolvedValue(CAPPED_EXPAND_HOP);
    renderPage();

    await selectGroup();
    await expandCenterFlow();

    const notice = await screen.findByTestId("fund-trail-cap-notice");
    const text = notice.textContent ?? "";
    expect(text).toContain(SHOWN.toLocaleString());
    expect(text).toContain(TOTAL.toLocaleString());

    // The window-aware variant must NOT be present without an active range.
    expect(screen.queryByTestId("fund-trail-cap-notice-range")).toBeNull();
  });

  it("shows the window-aware notice when the expanded dest hop is capped AND a date range is active", async () => {
    computeOneHopSpy.mockResolvedValueOnce(CENTER_HOP);
    computeOneHopSpy.mockResolvedValue(CAPPED_EXPAND_HOP);
    renderPage();

    activateDateRange();
    await selectGroup();
    await expandCenterFlow();

    const notice = await screen.findByTestId("fund-trail-cap-notice-range");
    const text = notice.textContent ?? "";
    expect(text).toContain(SHOWN.toLocaleString());
    expect(text).toContain(TOTAL.toLocaleString());
    expect(text.toLowerCase()).toContain("date range");

    // The all-time variant must NOT also be present.
    expect(screen.queryByTestId("fund-trail-cap-notice")).toBeNull();
  });

  it("renders NO notice when the expanded dest hop is not capped", async () => {
    computeOneHopSpy.mockResolvedValueOnce(CENTER_HOP);
    computeOneHopSpy.mockResolvedValue(UNCAPPED_EXPAND_HOP);
    renderPage();

    await selectGroup();
    await expandCenterFlow();

    // The expanded section resolves to an empty-destinations message; wait for
    // it so we know the expand hop finished rendering before asserting no notice.
    await screen.findByText("No further destinations found.");

    expect(screen.queryByTestId("fund-trail-cap-notice")).toBeNull();
    expect(screen.queryByTestId("fund-trail-cap-notice-range")).toBeNull();
  });
});

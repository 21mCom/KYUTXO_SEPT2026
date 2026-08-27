// @vitest-environment jsdom
//
// Expanded-hop CapNotice test: when a user clicks "Expand hop" inside a
// FlowCard, the NEXT hop can also come back capped. FundTrail renders a
// CapNotice inside that expanded section (separate code from the center hop's
// notice covered by FundTrail.capNotice.test.tsx). This test locks in that
// expanded path so a refactor can't silently drop it, leaving users tracing
// deeper to follow a silently-incomplete trail.
//
//   - expanded hop capped, NO date range  -> all-time notice
//                                            (testid `fund-trail-cap-notice`)
//   - expanded hop capped, date range     -> window-aware notice
//                                            (testid `fund-trail-cap-notice-range`)
//   - expanded hop NOT capped             -> no notice at all
//
// In every capped case the notice text must reflect the expanded hop's
// shownTxCount / totalTxCount.
//
// We render the real FundTrail page but stub the engine seam: computeOneHop is
// a spy that returns an uncapped, expandable CENTER hop first (so no center
// notice appears) and the per-test EXPAND hop afterwards. listGroupValues /
// getAddressesForGroup return fixed data. Selecting a group fires the center
// hop; clicking the FlowCard's Expand button fires the expand hop.

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
// A deeper hop the d1 FlowCard can itself expand into (d1 -> d2). Distinct from
// EXPAND_TARGET so its expand button has its own testid at depth 1.
const CHILD_TARGET = "Mixer";
const SHOWN = 50;
const TOTAL = 1234;

// The center hop returns one (uncapped) source flow that the FlowCard can
// expand. Keeping it uncapped guarantees any rendered notice belongs to the
// EXPANDED hop, not the center hop.
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

// A middle hop (the d0 expand result) that is uncapped but itself exposes a
// source the d1 FlowCard can expand again, taking us to depth 2.
const MID_HOP: TrailHop = {
  sources: [
    {
      groupLabel: CHILD_TARGET,
      dimension: "walletName",
      totalSats: 80,
      details: [{ address: "ext-mx", txid: "tx-mx", amount: 80, blockTime: 1000 }],
      isUnknown: false,
    },
  ],
  destinations: [],
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
  fireEvent.change(screen.getByTestId("input-fund-trail-date-range-from"), {
    target: { value: "2024-01-01" },
  });
}

async function expandCenterFlow() {
  const expandBtn = await screen.findByTestId(`fund-trail-expand-${EXPAND_TARGET}-d0`);
  fireEvent.click(expandBtn);
}

async function expandChildFlow() {
  const expandBtn = await screen.findByTestId(`fund-trail-expand-${CHILD_TARGET}-d1`);
  fireEvent.click(expandBtn);
}

beforeEach(() => {
  computeOneHopSpy.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("FundTrail expanded-hop cap notice", () => {
  it("shows the all-time notice when the expanded hop is capped (no date range)", async () => {
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

  it("shows the window-aware notice when the expanded hop is capped AND a date range is active", async () => {
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

  it("renders NO notice when the expanded hop is not capped", async () => {
    computeOneHopSpy.mockResolvedValueOnce(CENTER_HOP);
    computeOneHopSpy.mockResolvedValue(UNCAPPED_EXPAND_HOP);
    renderPage();

    await selectGroup();
    await expandCenterFlow();

    // The expanded section resolves to an empty-sources message; wait for it so
    // we know the expand hop finished rendering before asserting no notice.
    await screen.findByText("No further sources found.");

    expect(screen.queryByTestId("fund-trail-cap-notice")).toBeNull();
    expect(screen.queryByTestId("fund-trail-cap-notice-range")).toBeNull();
  });

  it("shows the notice for a DEEPLY nested expanded hop (d1 -> d2) that is capped", async () => {
    // center hop (uncapped, expandable), d0 expand -> MID_HOP (uncapped,
    // expandable child), d1 expand -> capped deep hop.
    computeOneHopSpy.mockResolvedValueOnce(CENTER_HOP);
    computeOneHopSpy.mockResolvedValueOnce(MID_HOP);
    computeOneHopSpy.mockResolvedValue(CAPPED_EXPAND_HOP);
    renderPage();

    await selectGroup();
    await expandCenterFlow();
    // The d1 FlowCard (the child of the first expand) must render before we can
    // expand it deeper.
    await screen.findByTestId(`fund-trail-flow-card-${CHILD_TARGET}-d1`);
    await expandChildFlow();

    const notice = await screen.findByTestId("fund-trail-cap-notice");
    const text = notice.textContent ?? "";
    expect(text).toContain(SHOWN.toLocaleString());
    expect(text).toContain(TOTAL.toLocaleString());

    // Neither the center nor the d0 hop was capped, so the deep notice is the
    // only one, and the window-aware variant must be absent without a range.
    expect(screen.queryByTestId("fund-trail-cap-notice-range")).toBeNull();
  });

  it("renders NO notice at the deeper level (d1 -> d2) when that hop is not capped", async () => {
    computeOneHopSpy.mockResolvedValueOnce(CENTER_HOP);
    computeOneHopSpy.mockResolvedValueOnce(MID_HOP);
    computeOneHopSpy.mockResolvedValue(UNCAPPED_EXPAND_HOP);
    renderPage();

    await selectGroup();
    await expandCenterFlow();
    await screen.findByTestId(`fund-trail-flow-card-${CHILD_TARGET}-d1`);
    await expandChildFlow();

    // The deepest expand resolves to an empty-sources message; wait for it so we
    // know the d2 hop finished rendering before asserting no notice exists.
    await screen.findByText("No further sources found.");

    expect(screen.queryByTestId("fund-trail-cap-notice")).toBeNull();
    expect(screen.queryByTestId("fund-trail-cap-notice-range")).toBeNull();
  });
});

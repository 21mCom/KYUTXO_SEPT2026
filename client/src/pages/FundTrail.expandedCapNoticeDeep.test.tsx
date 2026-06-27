// @vitest-environment jsdom
//
// Expanded-hop CapNotice test — DEEP (depth >= 1) nesting.
//
// FundTrail.expandedCapNotice.test.tsx (source) and
// FundTrail.expandedCapNoticeDest.test.tsx (dest) both expand a SINGLE hop at
// depth 0 and assert the expandedHop.isCapped CapNotice renders. But the very
// same CapNotice block also renders for FlowCards nested at depth >= 1: a
// FlowCard produced inside an expanded hop, then itself expanded. That
// recursive case was untested, so a regression in deeper nesting could drop
// the warning while depth-0 stayed green — leaving a user who is tracing two
// hops deep to follow a silently-incomplete trail.
//
// This test expands the depth-0 FlowCard, then expands one of the child
// FlowCards it produced (depth 1), and asserts:
//
//   - expanded depth-1 hop capped, NO date range -> all-time notice
//                                                   (testid `fund-trail-cap-notice`)
//   - expanded depth-1 hop capped, date range    -> window-aware notice
//                                                   (testid `fund-trail-cap-notice-range`)
//   - expanded depth-1 hop NOT capped            -> no notice at all
//
// In every capped case the notice text must reflect the depth-1 expanded hop's
// shownTxCount / totalTxCount.
//
// We render the real FundTrail page but stub the engine seam: computeOneHop is
// a spy returning, in order, the CENTER hop (one uncapped, expandable DEST
// flow), the depth-0 EXPAND hop (one uncapped, expandable DEST flow), and
// finally the depth-1 EXPAND hop (the per-test capped/uncapped result). Keeping
// the first two hops uncapped guarantees any rendered notice belongs to the
// depth-1 hop, not a shallower one.

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
const DEPTH0_TARGET = "Counterparty"; // depth-0 dest FlowCard
const DEPTH1_TARGET = "DeepCounterparty"; // depth-1 dest FlowCard (the one we expand)
const SHOWN = 50;
const TOTAL = 1234;

// Center hop: one uncapped DEST flow -> a depth-0 FlowCard the user can expand.
const CENTER_HOP: TrailHop = {
  sources: [],
  destinations: [
    {
      groupLabel: DEPTH0_TARGET,
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

// Depth-0 expand hop: one uncapped DEST flow -> a depth-1 FlowCard. Still
// uncapped so any notice must belong to the depth-1 hop expanded next.
const DEPTH0_EXPAND_HOP: TrailHop = {
  sources: [],
  destinations: [
    {
      groupLabel: DEPTH1_TARGET,
      dimension: "walletName",
      totalSats: 80,
      details: [{ address: "ext-deep", txid: "tx-deep", amount: 80, blockTime: 2000 }],
      isUnknown: false,
    },
  ],
  isCapped: false,
  shownTxCount: 1,
  totalTxCount: 1,
};

// Depth-1 expand hop: the case under test.
const CAPPED_DEPTH1_HOP: TrailHop = {
  sources: [],
  destinations: [],
  isCapped: true,
  shownTxCount: SHOWN,
  totalTxCount: TOTAL,
};

const UNCAPPED_DEPTH1_HOP: TrailHop = {
  sources: [],
  destinations: [],
  isCapped: false,
  shownTxCount: SHOWN,
  totalTxCount: SHOWN,
};

const computeOneHopSpy = vi.fn(async (): Promise<TrailHop> => UNCAPPED_DEPTH1_HOP);

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

async function expandDepth0Flow() {
  const btn = await screen.findByTestId(`fund-trail-expand-${DEPTH0_TARGET}-d0`);
  fireEvent.click(btn);
}

async function expandDepth1Flow() {
  // Produced inside the depth-0 expanded hop; renders at depth 1.
  const btn = await screen.findByTestId(`fund-trail-expand-${DEPTH1_TARGET}-d1`);
  fireEvent.click(btn);
}

beforeEach(() => {
  computeOneHopSpy.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("FundTrail expanded-hop cap notice (deep / depth >= 1 nesting)", () => {
  it("shows the all-time notice when the depth-1 expanded hop is capped (no date range)", async () => {
    // 1) center hop, 2) depth-0 expand, 3+) depth-1 expand (capped).
    computeOneHopSpy.mockResolvedValueOnce(CENTER_HOP);
    computeOneHopSpy.mockResolvedValueOnce(DEPTH0_EXPAND_HOP);
    computeOneHopSpy.mockResolvedValue(CAPPED_DEPTH1_HOP);
    renderPage();

    await selectGroup();
    await expandDepth0Flow();
    await expandDepth1Flow();

    const notice = await screen.findByTestId("fund-trail-cap-notice");
    const text = notice.textContent ?? "";
    expect(text).toContain(SHOWN.toLocaleString());
    expect(text).toContain(TOTAL.toLocaleString());

    // The window-aware variant must NOT be present without an active range.
    expect(screen.queryByTestId("fund-trail-cap-notice-range")).toBeNull();
  });

  it("shows the window-aware notice when the depth-1 expanded hop is capped AND a date range is active", async () => {
    computeOneHopSpy.mockResolvedValueOnce(CENTER_HOP);
    computeOneHopSpy.mockResolvedValueOnce(DEPTH0_EXPAND_HOP);
    computeOneHopSpy.mockResolvedValue(CAPPED_DEPTH1_HOP);
    renderPage();

    activateDateRange();
    await selectGroup();
    await expandDepth0Flow();
    await expandDepth1Flow();

    const notice = await screen.findByTestId("fund-trail-cap-notice-range");
    const text = notice.textContent ?? "";
    expect(text).toContain(SHOWN.toLocaleString());
    expect(text).toContain(TOTAL.toLocaleString());
    expect(text.toLowerCase()).toContain("date range");

    // The all-time variant must NOT also be present.
    expect(screen.queryByTestId("fund-trail-cap-notice")).toBeNull();
  });

  it("renders NO notice when the depth-1 expanded hop is not capped", async () => {
    computeOneHopSpy.mockResolvedValueOnce(CENTER_HOP);
    computeOneHopSpy.mockResolvedValueOnce(DEPTH0_EXPAND_HOP);
    computeOneHopSpy.mockResolvedValue(UNCAPPED_DEPTH1_HOP);
    renderPage();

    await selectGroup();
    await expandDepth0Flow();
    await expandDepth1Flow();

    // The depth-1 expanded section resolves to an empty-destinations message;
    // wait for it so we know the expand hop finished before asserting no notice.
    await screen.findByText("No further destinations found.");

    expect(screen.queryByTestId("fund-trail-cap-notice")).toBeNull();
    expect(screen.queryByTestId("fund-trail-cap-notice-range")).toBeNull();
  });
});

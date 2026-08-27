// @vitest-environment jsdom
//
// Expanded-hop CapNotice test — DEEP (depth >= 2, near MAX_DEPTH) nesting.
//
// FundTrail.expandedCapNotice.test.tsx (source) and
// FundTrail.expandedCapNoticeDest.test.tsx (dest) expand a SINGLE hop at
// depth 0 and assert the expandedHop.isCapped CapNotice renders. But the very
// same CapNotice block also renders for FlowCards nested arbitrarily deep: a
// FlowCard produced inside an expanded hop, then itself expanded, all the way
// down to MAX_DEPTH (5). That deep recursive case was untested, so a regression
// could drop the warning at depth 2+ while shallower levels stayed green —
// leaving a user tracing a deep trail to follow a silently-incomplete picture.
//
// This test expands the depth-0 FlowCard and then keeps expanding the single
// child FlowCard each hop produces, descending hop by hop down to DEEP_DEPTH
// (4 — one short of MAX_DEPTH=5, the deepest level an Expand button is offered).
// It then asserts, for the hop expanded at that deepest level:
//
//   - deepest expanded hop capped, NO date range -> all-time notice
//                                                   (testid `fund-trail-cap-notice`)
//   - deepest expanded hop capped, date range    -> window-aware notice
//                                                   (testid `fund-trail-cap-notice-range`)
//   - deepest expanded hop NOT capped            -> no notice at all
//
// In every capped case the notice text must reflect the deepest expanded hop's
// shownTxCount / totalTxCount.
//
// We render the real FundTrail page but stub the engine seam: computeOneHop is
// a spy returning, in order, the CENTER hop, then one uncapped intermediate hop
// per level descended (each producing exactly one expandable DEST child), and
// finally the deepest hop (the per-test capped/uncapped result). Keeping every
// shallower hop uncapped guarantees any rendered notice belongs to the deepest
// hop, not a shallower one.

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
const SHOWN = 50;
const TOTAL = 1234;

// The FlowCard rendered at depth d carries this (unique) label. Unique labels
// keep each level's testid distinct and avoid the visited-cycle guard tripping.
const labelAt = (d: number) => `Hop${d}`;

// MAX_DEPTH in FundTrail.tsx is 5 (the last depth an Expand button is offered).
// We descend to depth 4 — one short of that — so the deepest expanded hop is
// about as deep as the UI ever lets a user go.
const DEEP_DEPTH = 4;

// One uncapped DEST flow whose groupLabel is the NEXT level's FlowCard label,
// so expanding the card at depth `d` reveals an expandable card at depth d+1.
function intermediateHop(d: number): TrailHop {
  return {
    sources: [],
    destinations: [
      {
        groupLabel: labelAt(d + 1),
        dimension: "walletName",
        totalSats: 100,
        details: [
          { address: `ext-${d}`, txid: `tx-${d}`, amount: 100, blockTime: 1000 + d },
        ],
        isUnknown: false,
      },
    ],
    isCapped: false,
    shownTxCount: 1,
    totalTxCount: 1,
  };
}

// Center hop: one uncapped DEST flow -> the depth-0 FlowCard the user expands.
const CENTER_HOP: TrailHop = intermediateHop(-1);

// Deepest expand hop: the case under test (no further children).
const CAPPED_DEEP_HOP: TrailHop = {
  sources: [],
  destinations: [],
  isCapped: true,
  shownTxCount: SHOWN,
  totalTxCount: TOTAL,
};

const UNCAPPED_DEEP_HOP: TrailHop = {
  sources: [],
  destinations: [],
  isCapped: false,
  shownTxCount: SHOWN,
  totalTxCount: SHOWN,
};

const computeOneHopSpy = vi.fn(async (): Promise<TrailHop> => UNCAPPED_DEEP_HOP);

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

// Expand the FlowCard rendered at depth `d` (label Hop{d}).
async function expandAt(d: number) {
  const btn = await screen.findByTestId(`fund-trail-expand-${labelAt(d)}-d${d}`);
  fireEvent.click(btn);
}

// Walk the trail from depth 0 down to (and including) DEEP_DEPTH, expanding the
// single child at each level. The last expansion triggers the deepest hop.
async function descendToDeepest() {
  for (let d = 0; d <= DEEP_DEPTH; d++) {
    await expandAt(d);
  }
}

// Queue the engine responses: center hop, one intermediate hop per intervening
// level (so each reveals the next expandable child), then the deepest hop.
function queueHops(deepest: TrailHop) {
  computeOneHopSpy.mockResolvedValueOnce(CENTER_HOP);
  for (let d = 0; d < DEEP_DEPTH; d++) {
    computeOneHopSpy.mockResolvedValueOnce(intermediateHop(d));
  }
  computeOneHopSpy.mockResolvedValue(deepest);
}

beforeEach(() => {
  computeOneHopSpy.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("FundTrail expanded-hop cap notice (deep / near-MAX_DEPTH nesting)", () => {
  it("shows the all-time notice when the deepest expanded hop is capped (no date range)", async () => {
    queueHops(CAPPED_DEEP_HOP);
    renderPage();

    await selectGroup();
    await descendToDeepest();

    const notice = await screen.findByTestId("fund-trail-cap-notice");
    const text = notice.textContent ?? "";
    expect(text).toContain(SHOWN.toLocaleString());
    expect(text).toContain(TOTAL.toLocaleString());

    // The window-aware variant must NOT be present without an active range.
    expect(screen.queryByTestId("fund-trail-cap-notice-range")).toBeNull();
  });

  it("shows the window-aware notice when the deepest expanded hop is capped AND a date range is active", async () => {
    queueHops(CAPPED_DEEP_HOP);
    renderPage();

    activateDateRange();
    await selectGroup();
    await descendToDeepest();

    const notice = await screen.findByTestId("fund-trail-cap-notice-range");
    const text = notice.textContent ?? "";
    expect(text).toContain(SHOWN.toLocaleString());
    expect(text).toContain(TOTAL.toLocaleString());
    expect(text.toLowerCase()).toContain("date range");

    // The all-time variant must NOT also be present.
    expect(screen.queryByTestId("fund-trail-cap-notice")).toBeNull();
  });

  it("renders NO notice when the deepest expanded hop is not capped", async () => {
    queueHops(UNCAPPED_DEEP_HOP);
    renderPage();

    await selectGroup();
    await descendToDeepest();

    // The deepest expanded section resolves to an empty-destinations message;
    // wait for it so we know the deepest hop finished before asserting no notice.
    await screen.findByText("No further destinations found.");

    expect(screen.queryByTestId("fund-trail-cap-notice")).toBeNull();
    expect(screen.queryByTestId("fund-trail-cap-notice-range")).toBeNull();
  });
});

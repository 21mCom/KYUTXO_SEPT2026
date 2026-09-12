// @vitest-environment jsdom
//
// Max-depth guardrail test.
//
// FundTrail caps traversal at MAX_DEPTH=5: a FlowCard only offers the Expand
// button while `depth < MAX_DEPTH`, and once a card is rendered at depth 5 the
// button is replaced by a "(max depth reached)" hint (FundTrail.tsx ~lines
// 243-246, 381-385). Without this guard a user could keep expanding forever
// (runaway recursion / performance), and if the hint regressed away a user
// would be left confused about why a deep trail simply stopped.
//
// This test descends a trail hop by hop — expanding the single DEST child each
// hop produces — from depth 0 down to depth 5 (MAX_DEPTH). It then asserts that
// for the FlowCard rendered at depth 5:
//
//   - the Expand button is NOT rendered (testid `fund-trail-expand-Hop5-d5`)
//   - the "(max depth reached)" hint IS shown instead
//
// As a sanity anchor it also confirms the depth-4 card (one shallower, the
// deepest level the UI still offers Expand) DID render an Expand button.
//
// We render the real FundTrail page but stub the engine seam: computeOneHop is
// a spy returning the CENTER hop, then one uncapped intermediate hop per level
// descended, each producing exactly one expandable DEST child for the next
// level down.

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

// The FlowCard rendered at depth d carries this (unique) label. Unique labels
// keep each level's testid distinct and avoid the visited-cycle guard tripping.
const labelAt = (d: number) => `Hop${d}`;

// MAX_DEPTH in FundTrail.tsx is 5 — the first depth at which no Expand button
// is offered. We descend all the way to it.
const MAX_DEPTH = 5;

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

const computeOneHopSpy = vi.fn(async (): Promise<TrailHop> => intermediateHop(0));

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

// Expand the FlowCard rendered at depth `d` (label Hop{d}).
async function expandAt(d: number) {
  const btn = await screen.findByTestId(`fund-trail-expand-${labelAt(d)}-d${d}`);
  fireEvent.click(btn);
}

// Expand the single child at each level from depth 0 up to (but NOT including)
// `stopBefore`. Stopping at MAX_DEPTH means the final expansion is at depth
// MAX_DEPTH-1, which reveals the FlowCard rendered at depth MAX_DEPTH.
async function descendTo(stopBefore: number) {
  for (let d = 0; d < stopBefore; d++) {
    await expandAt(d);
  }
}

// Queue the engine responses: center hop, then one intermediate hop per level
// descended (each revealing the next expandable child, including Hop{MAX_DEPTH}).
function queueHops() {
  computeOneHopSpy.mockResolvedValueOnce(CENTER_HOP);
  for (let d = 0; d < MAX_DEPTH; d++) {
    computeOneHopSpy.mockResolvedValueOnce(intermediateHop(d));
  }
}

beforeEach(() => {
  computeOneHopSpy.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("FundTrail max-depth guardrail", () => {
  it("stops offering Expand at MAX_DEPTH and shows the (max depth reached) hint", async () => {
    queueHops();
    renderPage();

    await selectGroup();
    await descendTo(MAX_DEPTH);

    // The depth-MAX_DEPTH FlowCard must have rendered (its label appears).
    await screen.findByTestId(
      `fund-trail-flow-card-${labelAt(MAX_DEPTH)}-d${MAX_DEPTH}`,
    );

    // No Expand button at the deepest card...
    expect(
      screen.queryByTestId(`fund-trail-expand-${labelAt(MAX_DEPTH)}-d${MAX_DEPTH}`),
    ).toBeNull();

    // ...and the "(max depth reached)" hint is shown instead.
    expect(screen.getByText("(max depth reached)")).toBeTruthy();
  });

  it("still offers Expand one level shallower (depth MAX_DEPTH-1)", async () => {
    queueHops();
    renderPage();

    await selectGroup();
    // Descend only to depth MAX_DEPTH-1 (do NOT expand it), so the deepest
    // rendered card sits one level above the cap and the depth-MAX_DEPTH card
    // never appears.
    await descendTo(MAX_DEPTH - 1);

    // The card one level above the cap DID offer an Expand button.
    expect(
      await screen.findByTestId(
        `fund-trail-expand-${labelAt(MAX_DEPTH - 1)}-d${MAX_DEPTH - 1}`,
      ),
    ).toBeTruthy();

    // And no card has reached the cap yet, so the hint is absent.
    expect(screen.queryByText("(max depth reached)")).toBeNull();
  });
});

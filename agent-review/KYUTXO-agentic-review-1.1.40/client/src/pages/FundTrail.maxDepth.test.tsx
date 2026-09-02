// @vitest-environment jsdom
//
// Max-depth boundary test: FundTrail caps how deep a fund trail can be
// expanded at MAX_DEPTH (currently 5). When a FlowCard reaches that depth it
// must STOP offering the Expand button and instead show a "(max depth reached)"
// hint, so users know the trail ended on purpose rather than from a bug. This
// boundary is an easy off-by-one to break in a refactor (e.g. letting
// depth === MAX_DEPTH expand, or dropping the hint), and nothing else covers
// it, so we lock it in here.
//
//   - expand a trail repeatedly until depth === MAX_DEPTH -> deepest FlowCard
//     shows "(max depth reached)" and has NO expand button
//   - the FlowCard one level shallower (depth === MAX_DEPTH - 1) still offers
//     the Expand button
//
// We render the real FundTrail page but stub the engine seam: computeOneHop is
// a spy whose nth call returns a hop carrying a single, distinctly-labelled
// source so each successive expand creates a deeper FlowCard with its own
// testid. listGroupValues / getAddressesForGroup return fixed data. Selecting a
// group fires the center hop; clicking each FlowCard's Expand button fires the
// next hop one level deeper.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TrailHop } from "@/lib/data/fund-trail-engine";

// MAX_DEPTH is a private const in FundTrail.tsx; mirror it here. The test asserts
// the boundary at this value, so if the source const changes this must too.
const MAX_DEPTH = 5;

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

// Each hop carries a single source whose label encodes the depth of the
// FlowCard it will render as, so expand buttons/cards get unique testids.
function hopWithSource(label: string): TrailHop {
  return {
    sources: [
      {
        groupLabel: label,
        dimension: "walletName",
        totalSats: 100,
        details: [
          { address: `ext-${label}`, txid: `tx-${label}`, amount: 100, blockTime: 1000 },
        ],
        isUnknown: false,
      },
    ],
    destinations: [],
    isCapped: false,
    shownTxCount: 1,
    totalTxCount: 1,
  };
}

const computeOneHopSpy = vi.fn(async (): Promise<TrailHop> => hopWithSource("Hop0"));

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

// Expand the FlowCard for `Hop{depth}` (which sits at `d{depth}`).
async function expandHopAtDepth(depth: number) {
  const btn = await screen.findByTestId(`fund-trail-expand-Hop${depth}-d${depth}`);
  fireEvent.click(btn);
}

beforeEach(() => {
  computeOneHopSpy.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("FundTrail max-depth boundary", () => {
  it("stops offering Expand and shows '(max depth reached)' once depth === MAX_DEPTH", async () => {
    // Center hop renders Hop0 at d0; every subsequent expand returns the next
    // deeper hop. Hop{n} renders at d{n}: Hop0..Hop{MAX_DEPTH}.
    computeOneHopSpy.mockResolvedValueOnce(hopWithSource("Hop0")); // center hop
    for (let d = 1; d <= MAX_DEPTH; d++) {
      computeOneHopSpy.mockResolvedValueOnce(hopWithSource(`Hop${d}`));
    }
    renderPage();

    await selectGroup();
    // Expand from d0 through d{MAX_DEPTH - 1}; the last click produces the
    // FlowCard at d{MAX_DEPTH}.
    for (let d = 0; d < MAX_DEPTH; d++) {
      await screen.findByTestId(`fund-trail-flow-card-Hop${d}-d${d}`);
      await expandHopAtDepth(d);
    }

    // The deepest FlowCard renders at MAX_DEPTH.
    const deepest = await screen.findByTestId(
      `fund-trail-flow-card-Hop${MAX_DEPTH}-d${MAX_DEPTH}`,
    );
    expect(deepest).toBeTruthy();

    // It must announce the cap...
    expect(deepest.textContent ?? "").toContain("(max depth reached)");

    // ...and offer NO way to expand further.
    expect(
      screen.queryByTestId(`fund-trail-expand-Hop${MAX_DEPTH}-d${MAX_DEPTH}`),
    ).toBeNull();
  });

  it("still offers Expand at one level shallower (depth === MAX_DEPTH - 1)", async () => {
    const shallow = MAX_DEPTH - 1;
    computeOneHopSpy.mockResolvedValueOnce(hopWithSource("Hop0")); // center hop
    for (let d = 1; d <= shallow; d++) {
      computeOneHopSpy.mockResolvedValueOnce(hopWithSource(`Hop${d}`));
    }
    renderPage();

    await selectGroup();
    // Expand down to the FlowCard at d{MAX_DEPTH - 1}.
    for (let d = 0; d < shallow; d++) {
      await screen.findByTestId(`fund-trail-flow-card-Hop${d}-d${d}`);
      await expandHopAtDepth(d);
    }

    // The shallower card exists, still has its Expand button, and does NOT show
    // the max-depth hint.
    const card = await screen.findByTestId(
      `fund-trail-flow-card-Hop${shallow}-d${shallow}`,
    );
    expect(
      screen.getByTestId(`fund-trail-expand-Hop${shallow}-d${shallow}`),
    ).toBeTruthy();
    expect(card.textContent ?? "").not.toContain("(max depth reached)");
  });
});

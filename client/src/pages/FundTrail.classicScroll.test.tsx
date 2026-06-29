// @vitest-environment jsdom
//
// PERMANENT AUTOMATED GUARD against the Classic multi-hop Fund Trail
// whole-page-overflow regression (Task #1315 fixed it; this catches it coming
// back). jsdom cannot MEASURE real layout/overflow — pixel measurement lives in
// the browser/e2e recipe documented at
// `.agents/memory/fund-trail-classic-scroll-verify.md`. But the specific
// regression vectors named in the fix ARE structural and therefore checkable
// here from the rendered DOM:
//
//   - dropping `overflow-y-auto` from a column (the column would no longer
//     scroll inside its pane, pushing the page),
//   - dropping `min-h-0` / `flex-1` from a column or the layout root (a flex
//     child without `min-h-0` refuses to shrink below content height, so the
//     inner `overflow-y-auto` never engages and the whole page grows),
//   - reintroducing `h-screen` on the layout root (a nested `h-screen` forces a
//     viewport-tall block inside the already-viewport-tall app shell, which is
//     exactly the original whole-page-scroll bug).
//
// If any of those classes move, this test fails — a cheap CI tripwire that
// front-runs the (more expensive, manual) browser verification.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TrailHop } from "@/lib/data/fund-trail-engine";
import {
  makeMultiHopFixture,
  FIXTURE_CENTER_LABEL,
} from "@/components/fund-trail/__tests__/fixtures";

// ResizeObserver shim (some shadcn primitives reach for it).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

// --- Reactive use-settings mock (Classic layout) ---------------------------
const settingsStore = vi.hoisted(() => {
  let layout = "classic";
  const listeners = new Set<() => void>();
  return {
    getLayout: () => layout,
    setLayout: (v: string) => {
      layout = v;
      listeners.forEach((l) => l());
    },
    listeners,
  };
});

vi.mock("@/hooks/use-settings", async () => {
  const React = await import("react");
  return {
    useSettings: () => {
      const [, force] = React.useReducer((x: number) => x + 1, 0);
      React.useEffect(() => {
        settingsStore.listeners.add(force);
        return () => {
          settingsStore.listeners.delete(force);
        };
      }, []);
      return {
        fundTrailTxLimit: 2000,
        intermediaryAddressCap: 200,
        fundTrailLayout: settingsStore.getLayout(),
      };
    },
    updateFundTrailLayout: (v: string) => settingsStore.setLayout(v),
  };
});
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}));
vi.mock("@/contexts/RecordPreviewContext", () => ({
  useRecordPreview: () => ({
    openRecordPreview: vi.fn(),
    openRecordPreviewByAddress: vi.fn(),
  }),
}));

// Swap radix Select for a native <select> so options are choosable.
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

const GROUP = FIXTURE_CENTER_LABEL; // "Treasury"

const EMPTY_HOP: TrailHop = {
  sources: [],
  destinations: [],
  isCapped: false,
  shownTxCount: 0,
  totalTxCount: 0,
};

vi.mock("@/lib/data/fund-trail-engine", async () => {
  const actual = await vi.importActual<typeof import("@/lib/data/fund-trail-engine")>(
    "@/lib/data/fund-trail-engine",
  );
  return {
    ...actual,
    listGroupValues: vi.fn(async () => [GROUP]),
    getAddressesForGroup: vi.fn(async () => [
      { inputString: "bc1qcenteraaa000000000000000000000000" },
    ]),
    computeOneHop: vi.fn(async () => EMPTY_HOP),
    computeMultiHopKnown: vi.fn(async () => makeMultiHopFixture()),
  };
});

const { default: FundTrail } = await import("./FundTrail");

beforeEach(() => {
  settingsStore.setLayout("classic");
});

afterEach(() => {
  cleanup();
});

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

// Walk up from an element to the nearest ancestor whose class list contains a
// scroll class (`overflow-y-auto` / `overflow-y-scroll` / `overflow-auto`).
// This mirrors the browser recipe's "first overflow-y:auto parent" walk, so the
// jsdom guard and the e2e measurement agree on which nodes are "scroll columns".
function nearestScrollAncestor(el: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = el.parentElement;
  while (cur) {
    const cls = cur.className || "";
    if (
      /\boverflow-y-auto\b/.test(cls) ||
      /\boverflow-y-scroll\b/.test(cls) ||
      /\boverflow-auto\b/.test(cls)
    ) {
      return cur;
    }
    cur = cur.parentElement;
  }
  return null;
}

async function renderClassicMultiHop() {
  renderPage();

  // Multi-hop (any side > 1 hop) BEFORE picking a group, matching the fixture
  // depths (src=2, dst=3) so only the multi-hop query runs.
  fireEvent.change(screen.getByTestId("fund-trail-backward-hops"), {
    target: { value: "2" },
  });
  fireEvent.change(screen.getByTestId("fund-trail-forward-hops"), {
    target: { value: "3" },
  });

  await waitFor(() => {
    const sel = screen.getByTestId("fund-trail-group-select") as HTMLSelectElement;
    expect(Array.from(sel.options).some((o) => o.value === GROUP)).toBe(true);
  });
  fireEvent.change(screen.getByTestId("fund-trail-group-select"), {
    target: { value: GROUP },
  });

  // Wait for the Classic trail to resolve (hop cards rendered).
  await waitFor(() =>
    expect(
      document.querySelectorAll('[data-testid^="fund-trail-hop-card-"]').length,
    ).toBeGreaterThan(0),
  );
}

describe("FundTrail Classic — per-column scroll structure (whole-page overflow guard)", () => {
  it("renders exactly two independent scroll columns, each able to shrink (overflow-y-auto + min-h-0 + flex-1)", async () => {
    await renderClassicMultiHop();

    const hopCards = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="fund-trail-hop-card-"]'),
    );
    expect(hopCards.length).toBeGreaterThan(1);

    // Every hop card must live inside a scrollable ancestor — otherwise the
    // column overflows the page instead of scrolling inside its pane.
    const scrollColumns = new Set<HTMLElement>();
    for (const card of hopCards) {
      const scroller = nearestScrollAncestor(card);
      expect(
        scroller,
        `hop card ${card.getAttribute("data-testid")} has no overflow-y scroll ancestor`,
      ).not.toBeNull();
      if (scroller) scrollColumns.add(scroller);
    }

    // Both Incoming and Outgoing columns scroll independently — and ONLY those
    // two (the center node is a separate, hop-card-free scroller and so is not
    // counted by the walk above). If a future refactor collapses them into one
    // scroller (or adds a third around the cards), this count changes.
    expect(scrollColumns.size).toBe(2);

    // Each scroll column must be a flex child that can shrink below its content
    // height (min-h-0) and grow to share the row (flex-1); without these the
    // inner overflow never engages and the page grows instead.
    for (const col of scrollColumns) {
      const cls = col.className;
      expect(cls, `scroll column missing min-h-0: "${cls}"`).toMatch(/\bmin-h-0\b/);
      expect(cls, `scroll column missing flex-1: "${cls}"`).toMatch(/\bflex-1\b/);
      expect(cls, `scroll column missing overflow-y-auto: "${cls}"`).toMatch(
        /\boverflow-y-auto\b/,
      );
    }
  });

  it("layout root contains the columns, clips its own overflow, can shrink (min-h-0), and never uses h-screen", async () => {
    await renderClassicMultiHop();

    const aCard = document.querySelector<HTMLElement>(
      '[data-testid^="fund-trail-hop-card-"]',
    );
    expect(aCard).not.toBeNull();

    // Find the MultiHopTrailLayout root: the outermost ancestor of a hop card
    // that is itself a flex column clipping overflow (overflow-hidden + min-h-0).
    // This is the container that, if it ever regains `h-screen`, reintroduces
    // the original whole-page-scroll bug.
    let root: HTMLElement | null = null;
    let cur: HTMLElement | null = aCard!.parentElement;
    while (cur) {
      const cls = cur.className || "";
      if (/\boverflow-hidden\b/.test(cls) && /\bmin-h-0\b/.test(cls)) {
        root = cur; // keep walking up; we want the OUTERMOST such container
      }
      cur = cur.parentElement;
    }
    expect(root, "no overflow-hidden + min-h-0 layout root found above hop cards").not.toBeNull();
    expect(root!.className).toMatch(/\bflex-col\b/);

    // The classic layout subtree must NOT reintroduce a viewport-tall block.
    const body = screen.getByTestId("fund-trail-body");
    const hScreenNodes = body.querySelectorAll('[class*="h-screen"]');
    expect(
      hScreenNodes.length,
      "h-screen reintroduced inside the Fund Trail body — this causes whole-page scrolling",
    ).toBe(0);
  });
});

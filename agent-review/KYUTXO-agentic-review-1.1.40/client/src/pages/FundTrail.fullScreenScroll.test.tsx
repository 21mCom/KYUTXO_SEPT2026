// @vitest-environment jsdom
//
// PERMANENT AUTOMATED GUARD against the whole-page-overflow regression in the
// Fund Trail FULL-SCREEN render path. `FundTrail.classicScroll.test.tsx` and
// `FundTrail.variantScroll.test.tsx` guard the normal (inline) render path
// inside `fund-trail-body`, but the page has a SEPARATE full-screen branch
// (the `isFullScreen` overlay, testid `fund-trail-fullscreen`) that wraps the
// same layouts in DIFFERENT containers:
//
//   - the variant/classic content wrapper is `flex-1 min-h-0 overflow-hidden`,
//   - classic additionally nests an inner `flex flex-col h-full overflow-auto`.
//
// A CSS/flex change to that full-screen wrapper could reintroduce whole-page
// scrolling for a layout WITHOUT failing either inline guard, since neither of
// them exercises the full-screen path. This file extends the same structural,
// class-assertion approach to the full-screen overlay for the Classic layout
// and all four alternates (horizontal, vertical, breakout, Sankey).
//
// jsdom cannot MEASURE real layout/overflow (pixel truth lives in the browser/
// e2e recipe), but the regression vectors are STRUCTURAL and so are checkable
// from the rendered DOM:
//
//   - the full-screen content wrapper around the layout dropping
//     `overflow-hidden` / `min-h-0` (without these the inner overflow never
//     engages and the page grows),
//   - the classic inner wrapper dropping `h-full` / `overflow-auto`,
//   - a variant scroll container dropping `overflow-(y-)?auto` or its
//     shrink/size anchor (`min-h-0` for flex-child scrollers, `h-full` for the
//     `.ft-root` root scroller),
//   - reintroducing `h-screen` anywhere inside the full-screen overlay (a
//     nested viewport-tall block is exactly the original whole-page-scroll bug).
//
// If any of those move, this test fails — a cheap CI tripwire that front-runs
// the (more expensive, manual) browser verification.

import { afterEach, describe, expect, it, vi } from "vitest";
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

// --- Reactive use-settings mock (layout is swapped per test) ----------------
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
// scroll class, but STOP at `boundary` (the full-screen overlay) so the walk
// stays inside the full-screen subtree rather than escaping into the inline
// body which is still mounted behind the overlay.
function nearestScrollAncestor(
  el: Element,
  boundary: Element,
): HTMLElement | null {
  let cur: Element | null = el.parentElement;
  while (cur && cur !== boundary.parentElement) {
    const cls = (cur as HTMLElement).className || "";
    const clsStr = typeof cls === "string" ? cls : "";
    if (
      /\boverflow-y-auto\b/.test(clsStr) ||
      /\boverflow-y-scroll\b/.test(clsStr) ||
      /\boverflow-auto\b/.test(clsStr)
    ) {
      return cur as HTMLElement;
    }
    if (cur === boundary) break;
    cur = cur.parentElement;
  }
  return null;
}

// Drive the page into multi-hop, pick the group, then enter full-screen mode
// and return the full-screen overlay element.
async function enterFullScreen(layout: string): Promise<HTMLElement> {
  settingsStore.setLayout(layout);
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

  // The Expand control only appears once a multi-hop trail has resolved.
  await waitFor(() => screen.getByTestId("fund-trail-expand"));
  fireEvent.click(screen.getByTestId("fund-trail-expand"));

  return await screen.findByTestId("fund-trail-fullscreen");
}

// ---------------------------------------------------------------------------
// Classic full-screen path
// ---------------------------------------------------------------------------

describe("FundTrail Classic — full-screen scroll-contained structure (whole-page overflow guard)", () => {
  it("wraps the classic layout in a clip-and-shrink content pane with an h-full overflow-auto inner, and never uses h-screen", async () => {
    const overlay = await enterFullScreen("classic");

    // The classic hop cards must have resolved inside the overlay.
    const hopCards = Array.from(
      overlay.querySelectorAll<HTMLElement>('[data-testid^="fund-trail-hop-card-"]'),
    );
    expect(
      hopCards.length,
      "no classic hop cards rendered inside the full-screen overlay",
    ).toBeGreaterThan(0);

    // The full-screen content wrapper must clip its own overflow and be able to
    // shrink (overflow-hidden + min-h-0); without these the inner overflow never
    // engages and the page grows.
    let wrapper: HTMLElement | null = null;
    let cur: HTMLElement | null = hopCards[0].parentElement;
    while (cur && cur !== overlay.parentElement) {
      const cls = cur.className || "";
      if (/\boverflow-hidden\b/.test(cls) && /\bmin-h-0\b/.test(cls)) {
        wrapper = cur; // keep walking up; we want the OUTERMOST such wrapper
      }
      if (cur === overlay) break;
      cur = cur.parentElement;
    }
    expect(
      wrapper,
      "no overflow-hidden + min-h-0 full-screen content wrapper found above the classic layout",
    ).not.toBeNull();

    // The classic inner wrapper must be h-full (bounded by the content pane) and
    // scroll its own overflow (overflow-auto).
    let inner: HTMLElement | null = null;
    cur = hopCards[0].parentElement;
    while (cur && cur !== overlay.parentElement) {
      const cls = cur.className || "";
      if (/\bh-full\b/.test(cls) && /\boverflow-auto\b/.test(cls)) {
        inner = cur;
        break;
      }
      if (cur === overlay) break;
      cur = cur.parentElement;
    }
    expect(
      inner,
      "no h-full + overflow-auto classic inner wrapper found inside the full-screen overlay",
    ).not.toBeNull();

    // No viewport-tall block anywhere inside the full-screen overlay.
    const hScreenNodes = overlay.querySelectorAll('[class*="h-screen"]');
    expect(
      hScreenNodes.length,
      "h-screen reintroduced inside the Fund Trail full-screen overlay — this causes whole-page scrolling",
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Alternate variant full-screen path
// ---------------------------------------------------------------------------

type Variant = "horizontal" | "vertical" | "breakout" | "sankey";
const VARIANTS: Variant[] = ["horizontal", "vertical", "breakout", "sankey"];

describe.each(VARIANTS)(
  "FundTrail %s variant — full-screen scroll-contained structure (whole-page overflow guard)",
  (layout) => {
    it("keeps every node inside a scroll pane that can shrink, wraps the variant in a clip-and-shrink content pane, and never reintroduces h-screen", async () => {
      const overlay = await enterFullScreen(layout);

      // Wait for the chosen variant to resolve inside the overlay.
      await waitFor(() =>
        expect(
          overlay.querySelectorAll('[data-testid^="ft-node-"]').length,
        ).toBeGreaterThan(0),
      );

      // The variant root (`.ft-root`) must be sized by its parent (h-full),
      // never the viewport (h-screen).
      const ftRoot = overlay.querySelector<HTMLElement>(".ft-root");
      expect(ftRoot, "no .ft-root found inside the full-screen overlay").not.toBeNull();
      expect(
        ftRoot!.className,
        `ft-root missing h-full: "${ftRoot!.className}"`,
      ).toMatch(/\bh-full\b/);
      expect(
        ftRoot!.className,
        `ft-root reintroduced h-screen: "${ftRoot!.className}"`,
      ).not.toMatch(/\bh-screen\b/);

      // The full-screen content wrapper that hosts the variant must clip its own
      // overflow and be able to shrink (overflow-hidden + min-h-0).
      const wrapper = ftRoot!.parentElement!;
      expect(
        wrapper.className,
        `full-screen variant wrapper missing overflow-hidden: "${wrapper.className}"`,
      ).toMatch(/\boverflow-hidden\b/);
      expect(
        wrapper.className,
        `full-screen variant wrapper missing min-h-0: "${wrapper.className}"`,
      ).toMatch(/\bmin-h-0\b/);

      // Every rendered node must live inside a scroll container — otherwise its
      // column overflows the page instead of scrolling inside its pane.
      const nodes = Array.from(
        overlay.querySelectorAll<HTMLElement>('[data-testid^="ft-node-"]'),
      );
      expect(nodes.length).toBeGreaterThan(0);

      const scrollers = new Set<HTMLElement>();
      for (const node of nodes) {
        const scroller = nearestScrollAncestor(node, overlay);
        expect(
          scroller,
          `node ${node.getAttribute("data-testid")} has no overflow scroll ancestor inside the overlay`,
        ).not.toBeNull();
        if (scroller) scrollers.add(scroller);
      }

      // Each scroll container must actually scroll (overflow-(y-)?auto) AND be
      // able to shrink below content height. Flex-child scrollers do that via
      // `min-h-0`; a root-level scroller (`.ft-root`) does it by being `h-full`.
      for (const scroller of scrollers) {
        const cls = scroller.className;
        expect(cls, `scroll container missing overflow-(y-)?auto: "${cls}"`).toMatch(
          /\boverflow-(y-)?auto\b/,
        );
        if (/\bft-root\b/.test(cls)) {
          expect(cls, `root scroll container missing h-full: "${cls}"`).toMatch(
            /\bh-full\b/,
          );
        } else {
          expect(cls, `flex-child scroll container missing min-h-0: "${cls}"`).toMatch(
            /\bmin-h-0\b/,
          );
        }
      }

      // No viewport-tall block anywhere inside the full-screen overlay.
      const hScreenNodes = overlay.querySelectorAll('[class*="h-screen"]');
      expect(
        hScreenNodes.length,
        "h-screen reintroduced inside the Fund Trail full-screen overlay — this causes whole-page scrolling",
      ).toBe(0);
    });
  },
);

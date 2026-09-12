// @vitest-environment jsdom
//
// PERMANENT AUTOMATED GUARD against the whole-page-overflow regression in the
// FOUR ALTERNATE Fund Trail layouts (horizontal hop timeline, vertical timeline
// scroll, full-screen breakout, Sankey flow). Task #1315 fixed the bug and
// `FundTrail.classicScroll.test.tsx` guards the CLASSIC layout — but the four
// alternates render via `MultiHopVariantLayout` with their OWN scroll/overflow
// containers, so a CSS/flex change could reintroduce whole-page scrolling in one
// of them without failing any test. This file extends the same structural,
// class-assertion approach to every alternate layout.
//
// jsdom cannot MEASURE real layout/overflow (pixel truth lives in the browser/
// e2e recipe), but the regression vectors are STRUCTURAL and so are checkable
// from the rendered DOM:
//
//   - a rendered node with NO `overflow-(y-)?auto` scroll ancestor (its column
//     would overflow the page instead of scrolling inside its pane),
//   - a flex-child scroll container that drops `min-h-0` (a flex child without
//     `min-h-0` refuses to shrink below content height, so the inner overflow
//     never engages and the whole page grows),
//   - a root scroll container that drops `h-full` (it would no longer be bounded
//     by the app shell),
//   - the page wrapper around the variant dropping `overflow-hidden` / `min-h-0`,
//   - reintroducing `h-screen` anywhere inside `fund-trail-body` (a nested
//     viewport-tall block is exactly the original whole-page-scroll bug).
//
// If any of those move, this test fails — a cheap CI tripwire that front-runs the
// (more expensive, manual) browser verification.

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
// scroll class (`overflow-y-auto` / `overflow-y-scroll` / `overflow-auto`).
// Mirrors the Classic guard so the jsdom guard and the e2e measurement agree on
// which nodes are "scroll containers".
function nearestScrollAncestor(el: Element): HTMLElement | null {
  let cur: Element | null = el.parentElement;
  while (cur) {
    const cls = (cur as HTMLElement).className || "";
    const clsStr = typeof cls === "string" ? cls : "";
    if (
      /\boverflow-y-auto\b/.test(clsStr) ||
      /\boverflow-y-scroll\b/.test(clsStr) ||
      /\boverflow-auto\b/.test(clsStr)
    ) {
      return cur as HTMLElement;
    }
    cur = cur.parentElement;
  }
  return null;
}

type Variant = "horizontal" | "vertical" | "breakout" | "sankey";
const VARIANTS: Variant[] = ["horizontal", "vertical", "breakout", "sankey"];

async function renderVariantMultiHop(layout: Variant) {
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

  // Wait for the chosen variant to resolve (its shared synthesized nodes render).
  await waitFor(() =>
    expect(
      document.querySelectorAll('[data-testid^="ft-node-"]').length,
    ).toBeGreaterThan(0),
  );
}

describe.each(VARIANTS)(
  "FundTrail %s variant — scroll-contained structure (whole-page overflow guard)",
  (layout) => {
    it("keeps every node inside a scroll pane that can shrink, and never reintroduces h-screen", async () => {
      await renderVariantMultiHop(layout);

      const body = screen.getByTestId("fund-trail-body");

      // The variant root (`.ft-root`) must be sized by its parent (h-full), never
      // the viewport (h-screen) — a nested viewport-tall block is the original bug.
      const ftRoot = body.querySelector<HTMLElement>(".ft-root");
      expect(ftRoot, "no .ft-root found inside fund-trail-body").not.toBeNull();
      expect(ftRoot!.className, `ft-root missing h-full: "${ftRoot!.className}"`).toMatch(
        /\bh-full\b/,
      );
      expect(
        ftRoot!.className,
        `ft-root reintroduced h-screen: "${ftRoot!.className}"`,
      ).not.toMatch(/\bh-screen\b/);

      // The page wrapper that hosts the variant must clip its own overflow and be
      // able to shrink (min-h-0); without these the inner overflow never engages
      // and the page grows.
      const wrapper = ftRoot!.parentElement!;
      expect(
        wrapper.className,
        `variant wrapper missing overflow-hidden: "${wrapper.className}"`,
      ).toMatch(/\boverflow-hidden\b/);
      expect(
        wrapper.className,
        `variant wrapper missing min-h-0: "${wrapper.className}"`,
      ).toMatch(/\bmin-h-0\b/);

      // Every rendered node must live inside a scroll container — otherwise its
      // column overflows the page instead of scrolling inside its pane.
      const nodes = Array.from(
        body.querySelectorAll<HTMLElement>('[data-testid^="ft-node-"]'),
      );
      expect(nodes.length).toBeGreaterThan(0);

      const scrollers = new Set<HTMLElement>();
      for (const node of nodes) {
        const scroller = nearestScrollAncestor(node);
        expect(
          scroller,
          `node ${node.getAttribute("data-testid")} has no overflow scroll ancestor`,
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

      // No viewport-tall block anywhere inside the variant subtree.
      const hScreenNodes = body.querySelectorAll('[class*="h-screen"]');
      expect(
        hScreenNodes.length,
        "h-screen reintroduced inside the Fund Trail body — this causes whole-page scrolling",
      ).toBe(0);
    });
  },
);

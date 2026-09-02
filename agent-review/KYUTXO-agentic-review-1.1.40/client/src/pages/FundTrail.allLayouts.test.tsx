// @vitest-environment jsdom
//
// Page-level confirmation that ALL FIVE Fund Trail layouts — Classic columns,
// Horizontal hop timeline, Vertical timeline scroll, Full-screen breakout, and
// Sankey flow — render the same live multi-hop trail when chosen through the
// real Layout selector.
//
// The four alternate layouts go through MultiHopVariantLayout (covered in
// detail by ../components/fund-trail/__tests__/variants.test.tsx); Classic is
// rendered directly by FundTrail.tsx via MultiHopTrailLayout. Only at the page
// level do all five share one selector + one engine result, so this is the
// canonical "switch through every mode" check.
//
// We render the real FundTrail page and stub the engine seam: listGroupValues /
// getAddressesForGroup feed the group picker, and computeMultiHopKnown returns
// the shared multi-hop fixture. For each layout we assert, inside the trail body
// (which excludes the control bar's <select> option text):
//   - the traced-entity center label renders,
//   - the hop-1 source ("Exchange A") and destination ("Merchant X") render,
//   - the hop-1 in/out totals render (2.1 in / 2.5 out; Sankey collapses the
//     center to the larger of the two, so only 2.5 is asserted there),
//   - no console errors are logged.

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
import { FUND_TRAIL_LAYOUT_OPTIONS } from "@/components/fund-trail/view-data";

// ResizeObserver shim (some shadcn / variant primitives reach for it).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

// --- Reactive use-settings mock --------------------------------------------
// FundTrail reads `fundTrailLayout` from useSettings() and switches it through
// the named `updateFundTrailLayout`, so the mock must be a live store: updating
// the layout has to re-render every useSettings consumer (otherwise the
// selector change never takes effect and the page renders an invalid layout).
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

// --- Engine seam: stub loaders + return the shared multi-hop fixture --------
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
    // Single-hop path is disabled in multi-hop mode, but stub it defensively.
    computeOneHop: vi.fn(async () => EMPTY_HOP),
    computeMultiHopKnown: vi.fn(async () => makeMultiHopFixture()),
  };
});

const { default: FundTrail } = await import("./FundTrail");

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  settingsStore.setLayout("classic");
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  errorSpy.mockRestore();
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

// The trail body excludes the control bar (and thus the group <select> option
// text), so its textContent reflects only what the chosen layout rendered.
function bodyText(): string {
  return screen.getByTestId("fund-trail-body").textContent ?? "";
}

describe("FundTrail — every layout renders the same multi-hop trail", () => {
  it("Classic + all four alternate layouts surface consistent center + hop-1 data", async () => {
    renderPage();

    // Make it a multi-hop trace (any side > 1 hop) BEFORE picking a group, so
    // only the multi-hop query runs. Depths match the fixture (src=2, dst=3).
    fireEvent.change(screen.getByTestId("fund-trail-backward-hops"), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByTestId("fund-trail-forward-hops"), {
      target: { value: "3" },
    });

    // Group picker is populated by listGroupValues; choose the traced entity.
    await waitFor(() => {
      const sel = screen.getByTestId("fund-trail-group-select") as HTMLSelectElement;
      expect(Array.from(sel.options).some((o) => o.value === GROUP)).toBe(true);
    });
    fireEvent.change(screen.getByTestId("fund-trail-group-select"), {
      target: { value: GROUP },
    });

    // Wait for the (default Classic) trail to resolve.
    await waitFor(() => expect(bodyText()).toContain("Exchange A"));

    for (const { value: layout } of FUND_TRAIL_LAYOUT_OPTIONS) {
      // Classic is the default; the others are selected through the real
      // Layout selector (only present in multi-hop mode).
      if (layout !== "classic") {
        fireEvent.change(screen.getByTestId("fund-trail-layout-select"), {
          target: { value: layout },
        });
      }

      errorSpy.mockClear();

      // Same center + hop-1 source/destination in every layout.
      await waitFor(() => expect(bodyText()).toContain("Exchange A"));
      const text = bodyText();
      expect(text, `${layout}: center label`).toContain(FIXTURE_CENTER_LABEL);
      expect(text, `${layout}: hop-1 source`).toContain("Exchange A");
      expect(text, `${layout}: hop-1 destination`).toContain("Merchant X");

      // Hop-1 in/out totals (210M in -> "2.1", 250M out -> "2.5"). The Sankey
      // center bar collapses to the larger side, so only the out total shows.
      if (layout === "sankey") {
        expect(text, `${layout}: hop-1 out total`).toContain("2.5");
      } else {
        expect(text, `${layout}: hop-1 in total`).toContain("2.1");
        expect(text, `${layout}: hop-1 out total`).toContain("2.5");
      }

      expect(errorSpy, `${layout}: console errors`).not.toHaveBeenCalled();
    }
  });
});

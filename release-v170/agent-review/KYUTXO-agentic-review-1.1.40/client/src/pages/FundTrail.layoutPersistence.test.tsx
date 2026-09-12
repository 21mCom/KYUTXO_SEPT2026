// @vitest-environment jsdom
//
// Page-level guard that a PERSISTED Fund Trail layout actually surfaces in the
// FundTrail UI once multi-hop mode is re-entered — i.e. the read path, not just
// the write. Task #1284 added a hook-level write -> persist -> useSettings
// read-back test (use-settings.fundTrailLayout.test.tsx); this complements it by
// proving the persisted value flows all the way into the rendered page:
//   - the Layout selector (hidden until multi-hop mode) shows the SAVED label,
//   - the SAVED layout's variant renders (not the default Classic columns).
//
// The selector is only present when multi-hop mode is active
// (backwardHops > 1 || forwardHops > 1), and those hop depths are local React
// state that reset to 1 on mount — so the test must re-enter multi-hop mode
// before the persisted layout can surface (see
// .agents/memory/fund-trail-layout-persistence.md).
//
// Crucially, the layout selector is NEVER touched here: the layout comes purely
// from the persisted settings read on mount, so this catches a refactor that
// stores the value but fails to surface it in the page.

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

// ResizeObserver shim (some shadcn / variant primitives reach for it).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

// --- Reactive use-settings mock --------------------------------------------
// The store stands in for the persisted settings row: it is seeded with a
// non-default layout BEFORE the page mounts, mirroring useSettings() reading a
// previously-persisted settings.fundTrailLayout back from IndexedDB. The page
// must reflect that seeded value without the selector ever being clicked.
const settingsStore = vi.hoisted(() => {
  let layout = "sankey";
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

// --- Swap radix Select for a native <select> so its value is inspectable -----
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
    computeOneHop: vi.fn(async () => EMPTY_HOP),
    computeMultiHopKnown: vi.fn(async () => makeMultiHopFixture()),
  };
});

const { default: FundTrail } = await import("./FundTrail");

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Seed the persisted layout to a non-default value BEFORE mounting.
  settingsStore.setLayout("sankey");
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

describe("FundTrail — persisted layout surfaces on multi-hop re-entry", () => {
  it("shows the saved layout's label and renders its variant without touching the selector", async () => {
    renderPage();

    // Enter multi-hop mode (depths match the fixture: src=2, dst=3) so only the
    // multi-hop query runs and the Layout selector becomes visible.
    fireEvent.change(screen.getByTestId("fund-trail-backward-hops"), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByTestId("fund-trail-forward-hops"), {
      target: { value: "3" },
    });

    // Pick the traced entity once the group picker is populated.
    await waitFor(() => {
      const sel = screen.getByTestId("fund-trail-group-select") as HTMLSelectElement;
      expect(Array.from(sel.options).some((o) => o.value === GROUP)).toBe(true);
    });
    fireEvent.change(screen.getByTestId("fund-trail-group-select"), {
      target: { value: GROUP },
    });

    // Wait for the multi-hop trail to resolve and render.
    await waitFor(() =>
      expect(screen.getByTestId("fund-trail-body").textContent ?? "").toContain(
        "Exchange A",
      ),
    );

    // The Layout selector reflects the PERSISTED value (the selector itself was
    // never changed) and shows the saved option's label.
    const layoutSelect = screen.getByTestId(
      "fund-trail-layout-select",
    ) as HTMLSelectElement;
    expect(layoutSelect.value).toBe("sankey");
    const selectedOption = Array.from(layoutSelect.options).find(
      (o) => o.value === "sankey",
    );
    expect(selectedOption?.textContent).toBe("Sankey flow");

    // The saved layout's VARIANT renders: the Sankey flow draws a dedicated
    // center node (ft-node-center) that the default Classic layout never emits,
    // so its presence proves the persisted layout — not Classic — is on screen.
    expect(screen.getByTestId("ft-node-center")).toBeTruthy();

    // And the trail body still surfaces the shared center + hop-1 data.
    const body = screen.getByTestId("fund-trail-body").textContent ?? "";
    expect(body).toContain(FIXTURE_CENTER_LABEL);
    expect(body).toContain("Exchange A");
    expect(body).toContain("Merchant X");

    expect(errorSpy).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
//
// Regression guard for the Fund Trail full-screen open/close flow.
//
// The full-screen overlay (Expand button -> overlay visible, Esc-to-exit, and
// the "Exit full screen" button) was only ever verified by hand. A future
// refactor of FundTrail.tsx could quietly drop the Esc keydown listener or
// break the open/close toggle and nobody would notice until a user hit it.
//
// This test drives the real FundTrail page into multi-hop mode (so the Expand
// control and overlay can render) and locks in three behaviours:
//   1. clicking Expand mounts the overlay (testid: fund-trail-fullscreen)
//   2. pressing Escape unmounts it
//   3. clicking "Exit full screen" (testid: fund-trail-exit-fullscreen)
//      unmounts it
//
// It uses the shared provider harness (TestProviders) per the repo's
// test-provider guard, stubs the engine seam with a realistic multi-hop
// fixture, and swaps the radix Select for a native <select> so options are
// choosable.

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
import { TestProviders } from "@/test/testProviders";

// ResizeObserver shim (some shadcn primitives reach for it).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

// Partial mock — RecordPreviewProvider (pulled in by TestProviders) also
// consumes useCustomFields/useSeedNames/useWalletSoftware from this module, so
// keep the real exports and override only useSettings.
vi.mock("@/hooks/use-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-settings")>();
  return {
    ...actual,
    useSettings: () => ({
      fundTrailTxLimit: 2000,
      intermediaryAddressCap: 200,
      fundTrailLayout: "classic",
    }),
  };
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}));

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

const GROUP = FIXTURE_CENTER_LABEL;

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
      <TestProviders>
        <FundTrail />
      </TestProviders>
    </QueryClientProvider>,
  );
}

// Drive the page into multi-hop mode and surface the Expand control, but stop
// short of opening the overlay so each test can exercise the toggle itself.
async function reachExpandControl() {
  renderPage();

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

  await waitFor(() =>
    expect(screen.getByTestId("fund-trail-expand")).toBeTruthy(),
  );
}

describe("FundTrail full-screen open/close flow", () => {
  it("clicking Expand makes the full-screen overlay visible", async () => {
    await reachExpandControl();

    // Overlay is not mounted until Expand is clicked.
    expect(screen.queryByTestId("fund-trail-fullscreen")).toBeNull();

    fireEvent.click(screen.getByTestId("fund-trail-expand"));

    await waitFor(() =>
      expect(screen.getByTestId("fund-trail-fullscreen")).toBeTruthy(),
    );
  });

  it("pressing Escape exits the full-screen overlay", async () => {
    await reachExpandControl();
    fireEvent.click(screen.getByTestId("fund-trail-expand"));
    await waitFor(() =>
      expect(screen.getByTestId("fund-trail-fullscreen")).toBeTruthy(),
    );

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() =>
      expect(screen.queryByTestId("fund-trail-fullscreen")).toBeNull(),
    );
  });

  it("clicking 'Exit full screen' exits the overlay", async () => {
    await reachExpandControl();
    fireEvent.click(screen.getByTestId("fund-trail-expand"));
    await waitFor(() =>
      expect(screen.getByTestId("fund-trail-fullscreen")).toBeTruthy(),
    );

    fireEvent.click(screen.getByTestId("fund-trail-exit-fullscreen"));

    await waitFor(() =>
      expect(screen.queryByTestId("fund-trail-fullscreen")).toBeNull(),
    );
  });
});

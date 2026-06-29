// @vitest-environment jsdom
//
// Guards the Fund Trail full-screen auto-close effect: once the overlay is open
// it must NOT get stuck showing an empty view. If the user drops out of
// multi-hop mode (so isMultiHop becomes false and there is no multi-hop trail to
// render), the overlay should close itself automatically (isFullScreen resets to
// false). We drive a real render, enter full screen with a multi-hop trail, then
// switch the hop depths back to single-hop and assert the full-screen overlay is
// torn down.

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
import { computeMultiHopKnown } from "@/lib/data/fund-trail-engine";
import {
  makeMultiHopFixture,
  FIXTURE_CENTER_LABEL,
} from "@/components/fund-trail/__tests__/fixtures";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({
    fundTrailTxLimit: 2000,
    intermediaryAddressCap: 200,
    fundTrailLayout: "classic",
  }),
  updateFundTrailLayout: vi.fn(),
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}));
vi.mock("@/contexts/RecordPreviewContext", () => ({
  useRecordPreview: () => ({
    openRecordPreview: vi.fn(),
    openRecordPreviewByAddress: vi.fn(),
  }),
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
      <FundTrail />
    </QueryClientProvider>,
  );
}

async function enterFullScreen() {
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
  fireEvent.click(screen.getByTestId("fund-trail-expand"));

  await waitFor(() =>
    expect(screen.getByTestId("fund-trail-fullscreen")).toBeTruthy(),
  );
}

describe("FundTrail full-screen auto-close", () => {
  it("resets isFullScreen when the user drops out of multi-hop mode", async () => {
    await enterFullScreen();

    // Drop back to single-hop (1 source / 1 destination depth). isMultiHop
    // becomes false, so the multi-hop overlay has nothing to show.
    fireEvent.change(screen.getByTestId("fund-trail-backward-hops"), {
      target: { value: "1" },
    });
    fireEvent.change(screen.getByTestId("fund-trail-forward-hops"), {
      target: { value: "1" },
    });

    // The full-screen overlay must auto-close rather than getting stuck blank.
    await waitFor(() =>
      expect(screen.queryByTestId("fund-trail-fullscreen")).toBeNull(),
    );

    // Re-enter multi-hop. The render guard alone would re-show a still-open
    // overlay, so this proves the auto-close effect actually reset the
    // isFullScreen *state*: the overlay must NOT reappear until the user
    // explicitly expands again (the Expand button is back in the toolbar).
    fireEvent.change(screen.getByTestId("fund-trail-backward-hops"), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByTestId("fund-trail-forward-hops"), {
      target: { value: "3" },
    });

    await waitFor(() =>
      expect(screen.getByTestId("fund-trail-expand")).toBeTruthy(),
    );
    expect(screen.queryByTestId("fund-trail-fullscreen")).toBeNull();
  });

  it("resets isFullScreen when the multi-hop trail empties out mid-session", async () => {
    await enterFullScreen();

    // The trail result empties out while we stay in multi-hop mode: the
    // underlying recompute now yields no trail (null) and there is no
    // in-progress snapshot, so multiHopDisplay becomes null even though
    // isMultiHop is still true. The overlay must NOT get stuck blank.
    vi.mocked(computeMultiHopKnown).mockResolvedValue(
      null as unknown as Awaited<ReturnType<typeof computeMultiHopKnown>>,
    );

    // Trigger a recompute that keeps us in multi-hop mode (backward stays 2).
    fireEvent.change(screen.getByTestId("fund-trail-forward-hops"), {
      target: { value: "2" },
    });

    // The full-screen overlay must auto-close rather than getting stuck blank.
    await waitFor(() =>
      expect(screen.queryByTestId("fund-trail-fullscreen")).toBeNull(),
    );

    // Restore a real trail in multi-hop mode. The render guard alone would
    // re-show a still-open overlay, so this proves the auto-close effect
    // actually reset the isFullScreen *state*: the overlay must NOT reappear
    // until the user explicitly expands again (Expand is back in the toolbar).
    vi.mocked(computeMultiHopKnown).mockResolvedValue(makeMultiHopFixture());
    fireEvent.change(screen.getByTestId("fund-trail-forward-hops"), {
      target: { value: "3" },
    });

    await waitFor(() =>
      expect(screen.getByTestId("fund-trail-expand")).toBeTruthy(),
    );
    expect(screen.queryByTestId("fund-trail-fullscreen")).toBeNull();
  });
});

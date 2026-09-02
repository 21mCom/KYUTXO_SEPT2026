// @vitest-environment jsdom
//
// Confirms the full-screen Fund Trail layout keyboard shortcuts: once the trail
// is expanded to full screen, pressing the number keys 1–5 switches to the
// corresponding layout in FUND_TRAIL_LAYOUT_OPTIONS order (Classic, Horizontal,
// Vertical, Breakout, Sankey). We drive a real keydown on window and assert the
// layout actually changed by reading the live settings store the page writes to,
// and confirm a visible shortcut hint is present in the toolbar.

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

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

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

describe("FundTrail full-screen layout keyboard shortcuts", () => {
  it("pressing 1–5 switches to the matching layout in option order", async () => {
    await enterFullScreen();

    for (let i = 0; i < FUND_TRAIL_LAYOUT_OPTIONS.length; i++) {
      fireEvent.keyDown(window, { key: String(i + 1) });
      await waitFor(() =>
        expect(settingsStore.getLayout()).toBe(
          FUND_TRAIL_LAYOUT_OPTIONS[i].value,
        ),
      );
    }
  });

  it("ignores number keys when typing in an input", async () => {
    await enterFullScreen();
    settingsStore.setLayout("classic");

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    fireEvent.keyDown(input, { key: "5" });
    // No change — the shortcut should be suppressed while typing.
    expect(settingsStore.getLayout()).toBe("classic");
    input.remove();
  });

  it("renders a visible shortcut hint in the toolbar", async () => {
    await enterFullScreen();
    expect(
      screen.getByTestId("fund-trail-fullscreen-shortcut-hint"),
    ).toBeTruthy();
  });
});

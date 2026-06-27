// @vitest-environment jsdom
//
// CapNotice rendering test: the Fund Trail page shows a "trail may be
// incomplete" warning ONLY when results are actually capped, and it must pick
// the correct wording for the situation:
//
//   - capped WITH an active date range  -> window-aware notice
//                                          (testid `fund-trail-cap-notice-range`)
//   - capped WITHOUT a date range       -> all-time notice
//                                          (testid `fund-trail-cap-notice`)
//   - not capped (range or not)         -> no notice at all
//
// In every capped case the notice text must reflect the hop's shownTxCount /
// totalTxCount. Without this, a future change could silently swap, drop, or
// mis-wire the warning, misleading users into believing they're seeing a
// complete trail.
//
// We render the real FundTrail page but stub the engine seam: computeOneHop is
// a spy whose resolved hop (capped or not) we control per test, and
// listGroupValues / getAddressesForGroup return fixed data. Selecting a group
// fires the center hop; setting the start-date input activates a date range.

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
const SHOWN = 50;
const TOTAL = 1234;

// A populated source so the hop renders a real FlowCard alongside the notice.
const SAMPLE_SOURCES = [
  {
    groupLabel: "Counterparty",
    dimension: "walletName" as const,
    totalSats: 100,
    details: [{ address: "ext-cp", txid: "tx-cp", amount: 100, blockTime: 1000 }],
    isUnknown: false,
  },
];

const CAPPED_HOP: TrailHop = {
  sources: SAMPLE_SOURCES,
  destinations: [],
  isCapped: true,
  shownTxCount: SHOWN,
  totalTxCount: TOTAL,
};

const UNCAPPED_HOP: TrailHop = {
  sources: SAMPLE_SOURCES,
  destinations: [],
  isCapped: false,
  shownTxCount: SHOWN,
  totalTxCount: SHOWN,
};

// Hops returned by an *expand* click. They have no further sources (so the
// nested level just renders "No further sources found." alongside any notice),
// keeping the only CapNotice on screen the one belonging to the expanded hop.
const CAPPED_EXPAND_HOP: TrailHop = {
  sources: [],
  destinations: [],
  isCapped: true,
  shownTxCount: SHOWN,
  totalTxCount: TOTAL,
};

const UNCAPPED_EXPAND_HOP: TrailHop = {
  sources: [],
  destinations: [],
  isCapped: false,
  shownTxCount: SHOWN,
  totalTxCount: SHOWN,
};

const computeOneHopSpy = vi.fn(async (): Promise<TrailHop> => UNCAPPED_HOP);

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

function activateDateRange() {
  fireEvent.change(screen.getByTestId("fund-trail-start-date"), {
    target: { value: "2024-01-01" },
  });
}

beforeEach(() => {
  computeOneHopSpy.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("FundTrail cap notice", () => {
  it("shows the window-aware notice when capped AND a date range is active", async () => {
    computeOneHopSpy.mockResolvedValue(CAPPED_HOP);
    renderPage();

    activateDateRange();
    await selectGroup();

    const rangeNotice = await screen.findByTestId("fund-trail-cap-notice-range");
    // The window-aware copy surfaces shown/total counts so users know how much
    // of the date-range slice they're actually seeing.
    const rangeText = rangeNotice.textContent ?? "";
    expect(rangeText).toContain(SHOWN.toLocaleString());
    expect(rangeText).toContain(TOTAL.toLocaleString());
    expect(rangeText.toLowerCase()).toContain("date range");

    // The all-time variant must NOT also be present.
    expect(screen.queryByTestId("fund-trail-cap-notice")).toBeNull();
  });

  it("shows the all-time notice when capped with NO date range", async () => {
    computeOneHopSpy.mockResolvedValue(CAPPED_HOP);
    renderPage();

    await selectGroup();

    const allTimeNotice = await screen.findByTestId("fund-trail-cap-notice");
    const allTimeText = allTimeNotice.textContent ?? "";
    expect(allTimeText).toContain(SHOWN.toLocaleString());
    expect(allTimeText).toContain(TOTAL.toLocaleString());

    // The window-aware variant must NOT be present without an active range.
    expect(screen.queryByTestId("fund-trail-cap-notice-range")).toBeNull();
  });

  it("renders NO notice when results are not capped (no date range)", async () => {
    computeOneHopSpy.mockResolvedValue(UNCAPPED_HOP);
    renderPage();

    await selectGroup();

    // Wait for the center hop to resolve (its expandable source FlowCard appears).
    await screen.findByTestId("fund-trail-expand-Counterparty-d0");

    expect(screen.queryByTestId("fund-trail-cap-notice")).toBeNull();
    expect(screen.queryByTestId("fund-trail-cap-notice-range")).toBeNull();
  });

  it("renders NO notice when results are not capped (with date range)", async () => {
    computeOneHopSpy.mockResolvedValue(UNCAPPED_HOP);
    renderPage();

    activateDateRange();
    await selectGroup();

    await screen.findByTestId("fund-trail-expand-Counterparty-d0");

    // Even with an active range, an uncapped result shows neither notice.
    expect(screen.queryByTestId("fund-trail-cap-notice")).toBeNull();
    expect(screen.queryByTestId("fund-trail-cap-notice-range")).toBeNull();
  });
});

// Drives an expand by selecting a group (center hop -> UNCAPPED_HOP, which
// exposes a "Counterparty" FlowCard) and clicking that card's Expand button.
// The center hop is always uncapped here, so any notice that shows up belongs
// to the *expanded* hop — letting us assert on the deeper-hop wiring in
// isolation despite the notice testids being shared across depths.
async function expandCenterHop() {
  const expandBtn = await screen.findByTestId(
    "fund-trail-expand-Counterparty-d0",
  );
  // Center hop is uncapped: neither notice should be present before expanding.
  expect(screen.queryByTestId("fund-trail-cap-notice")).toBeNull();
  expect(screen.queryByTestId("fund-trail-cap-notice-range")).toBeNull();
  fireEvent.click(expandBtn);
}

describe("FundTrail cap notice on expanded hops", () => {
  it("shows the window-aware notice on an expanded hop when capped AND a date range is active", async () => {
    // Center hop expandable + uncapped; the expand call returns a capped hop.
    computeOneHopSpy.mockResolvedValueOnce(UNCAPPED_HOP);
    computeOneHopSpy.mockResolvedValue(CAPPED_EXPAND_HOP);
    renderPage();

    activateDateRange();
    await selectGroup();
    await expandCenterHop();

    const rangeNotice = await screen.findByTestId("fund-trail-cap-notice-range");
    const rangeText = rangeNotice.textContent ?? "";
    expect(rangeText).toContain(SHOWN.toLocaleString());
    expect(rangeText).toContain(TOTAL.toLocaleString());
    expect(rangeText.toLowerCase()).toContain("date range");

    // The all-time variant must NOT also be present.
    expect(screen.queryByTestId("fund-trail-cap-notice")).toBeNull();
  });

  it("shows the all-time notice on an expanded hop when capped with NO date range", async () => {
    computeOneHopSpy.mockResolvedValueOnce(UNCAPPED_HOP);
    computeOneHopSpy.mockResolvedValue(CAPPED_EXPAND_HOP);
    renderPage();

    await selectGroup();
    await expandCenterHop();

    const allTimeNotice = await screen.findByTestId("fund-trail-cap-notice");
    const allTimeText = allTimeNotice.textContent ?? "";
    expect(allTimeText).toContain(SHOWN.toLocaleString());
    expect(allTimeText).toContain(TOTAL.toLocaleString());

    // The window-aware variant must NOT be present without an active range.
    expect(screen.queryByTestId("fund-trail-cap-notice-range")).toBeNull();
  });

  it("renders NO notice on an expanded hop when its result is not capped", async () => {
    computeOneHopSpy.mockResolvedValueOnce(UNCAPPED_HOP);
    computeOneHopSpy.mockResolvedValue(UNCAPPED_EXPAND_HOP);
    renderPage();

    await selectGroup();
    await expandCenterHop();

    // Wait for the expanded section to resolve ("No further sources found.").
    await screen.findByText(/no further sources found/i);

    expect(screen.queryByTestId("fund-trail-cap-notice")).toBeNull();
    expect(screen.queryByTestId("fund-trail-cap-notice-range")).toBeNull();
  });
});

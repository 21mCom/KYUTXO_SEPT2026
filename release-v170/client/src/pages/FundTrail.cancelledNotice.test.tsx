// @vitest-environment jsdom
//
// Cancelled-trace notice test for the FundTrail page.
//
// Task #1212: when a user cancels a deep multi-hop trace, the partial results
// stay on screen but should be accompanied by a persistent, non-spinning notice
// summarizing how deep the trace got ("reached hop N of M — results partial"),
// so a partial trail is not mistaken for a complete one. Starting a new trace
// clears the notice.
//
// This test stubs the engine seam so the trace emits a progress event then
// stays pending until aborted, then asserts:
//   - after Cancel, a persistent cancelled notice appears with the right depth
//   - the live spinning progress banner disappears
//   - starting a new trace clears the cancelled notice
//
// Uses the same Select/use-settings/toast/record-preview mocks as the sibling
// page tests.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MultiHopProgress, MultiHopTrailResult } from "@/lib/data/fund-trail-engine";

// ResizeObserver shim (some shadcn primitives reach for it).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({ fundTrailTxLimit: 2000 }),
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

const GROUP = "Exchange";

let lastSignal: AbortSignal | undefined;

// A multi-hop trace that emits one "tracing" progress event then stays pending
// until its signal aborts (mimicking a slow deep trace the user cancels).
const computeMultiHopKnownSpy = vi.fn(
  (
    _addresses: string[],
    _dimension: string,
    _group: string | null,
    _back: number,
    _fwd: number,
    _dateRange: unknown,
    signal?: AbortSignal,
    _options?: unknown,
    onProgress?: (p: MultiHopProgress) => void,
  ): Promise<MultiHopTrailResult> => {
    lastSignal = signal;
    onProgress?.({
      direction: "dest",
      depth: 2,
      maxDepth: 4,
      phase: "tracing",
      sources: [],
      destinations: [],
      caps: [],
    });
    return new Promise<MultiHopTrailResult>((_resolve, reject) => {
      signal?.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError")),
      );
    });
  },
);

vi.mock("@/lib/data/fund-trail-engine", async () => {
  const actual = await vi.importActual<typeof import("@/lib/data/fund-trail-engine")>(
    "@/lib/data/fund-trail-engine",
  );
  return {
    ...actual,
    listGroupValues: vi.fn(async () => [GROUP]),
    getAddressesForGroup: vi.fn(async () => [{ inputString: "addr-1" }]),
    computeMultiHopKnown: (...args: unknown[]) =>
      (computeMultiHopKnownSpy as unknown as (...a: unknown[]) => Promise<MultiHopTrailResult>)(
        ...args,
      ),
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
    expect(Array.from(sel.options).some(o => o.value === GROUP)).toBe(true);
  });
  fireEvent.change(screen.getByTestId("fund-trail-group-select"), {
    target: { value: GROUP },
  });
}

beforeEach(() => {
  lastSignal = undefined;
  computeMultiHopKnownSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("FundTrail cancelled-trace notice", () => {
  it("shows a persistent notice after cancel and clears it on a new trace", async () => {
    renderPage();

    // Enter multi-hop mode: destinations depth = 4.
    fireEvent.change(screen.getByTestId("fund-trail-forward-hops"), {
      target: { value: "4" },
    });

    await selectGroup();

    // Live progress banner is up while tracing.
    await screen.findByTestId("fund-trail-multihop-progress-text");
    expect(screen.queryByTestId("fund-trail-multihop-cancelled")).toBeNull();

    // Cancel the trace.
    fireEvent.click(screen.getByTestId("fund-trail-multihop-cancel"));
    await waitFor(() => expect(lastSignal!.aborted).toBe(true));

    // The persistent, non-spinning notice appears summarizing how deep it got.
    const notice = await screen.findByTestId("fund-trail-multihop-cancelled-text");
    expect(notice.textContent).toContain("hop 2 of 4");
    expect(notice.textContent?.toLowerCase()).toContain("partial");

    // The live spinning progress banner is gone.
    expect(screen.queryByTestId("fund-trail-multihop-progress")).toBeNull();

    // Starting a new trace (change hop depth) clears the cancelled notice.
    fireEvent.change(screen.getByTestId("fund-trail-forward-hops"), {
      target: { value: "3" },
    });
    await waitFor(() =>
      expect(screen.queryByTestId("fund-trail-multihop-cancelled")).toBeNull(),
    );
  });
});

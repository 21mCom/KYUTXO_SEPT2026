// @vitest-environment jsdom
//
// Multi-hop progress + cancel test for the FundTrail page.
//
// Task #1197: tracing several hops through a large wallet must not freeze the
// page. The page wires computeMultiHopKnown's onProgress callback to a live
// banner ("Tracing … hop N of M…") and lets the user cancel mid-flight via
// queryClient.cancelQueries, which aborts the AbortSignal react-query hands to
// the queryFn.
//
// This test stubs the engine seam so the trace stays pending and emits a
// progress event, then asserts:
//   - the progress banner appears with the correct "hop N of M" text
//   - clicking Cancel aborts the signal the engine received (so a real trace
//     would stop between hops)
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

// Capture the AbortSignal the page passes into the trace so the test can assert
// that Cancel aborts it.
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
      depth: 1,
      maxDepth: 3,
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

describe("FundTrail multi-hop progress + cancel", () => {
  it("shows a hop-progress banner and cancels the in-flight trace", async () => {
    renderPage();

    // Enter multi-hop mode: destinations depth = 3.
    fireEvent.change(screen.getByTestId("fund-trail-forward-hops"), {
      target: { value: "3" },
    });

    await selectGroup();

    // The progress banner appears with the live hop count.
    const text = await screen.findByTestId("fund-trail-multihop-progress-text");
    expect(text.textContent).toContain("hop 1 of 3");

    // The engine received an AbortSignal that is not yet aborted.
    expect(lastSignal).toBeInstanceOf(AbortSignal);
    expect(lastSignal!.aborted).toBe(false);

    // Cancel aborts that signal so a real trace would stop between hops.
    fireEvent.click(screen.getByTestId("fund-trail-multihop-cancel"));
    await waitFor(() => expect(lastSignal!.aborted).toBe(true));
  });
});

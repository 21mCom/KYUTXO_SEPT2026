// @vitest-environment jsdom
//
// Cache-key wiring test for the multi-hop Fund Trail query.
//
// The multi-hop results live in the TanStack Query cache under the key
// `["fund-trail-multihop", ...]`. That cache is in-memory, but it survives
// SPA navigation (away and back) as long as the key is stable — so the page
// must encode every input that defines the result (center address, hop depths,
// window, tx limit) into that key. If it didn't, returning to the page would
// either re-query needlessly or, worse, show stale results from a different
// center address under a colliding key.
//
// This test locks in two guarantees:
//   1. Changing the backward/forward hop-depth selects produces a multi-hop
//      query whose cache key carries the chosen depths (so the same depths
//      restore to the same cached entry without re-querying).
//   2. Switching the center address spawns a *new* cache key, resetting the
//      multi-hop query (the old address's entry is not reused).
//
// We render the real FundTrail page, stub the engine seam (computeMultiHopKnown
// is a spy returning an empty trail), and inspect the QueryClient's cache to
// assert the keys directly. validateAddress is the real implementation so the
// address-mode gate behaves authentically.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MultiHopTrailResult } from "@/lib/data/fund-trail-engine";
import { TestProviders } from "@/test/testProviders";

// ResizeObserver shim (some shadcn primitives reach for it).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

const CUSTOM_TX_LIMIT = 2000;

// Two genuinely-valid mainnet addresses so the address-mode gate (real
// validateAddress) lets the multi-hop query run.
const ADDRESS_A = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const ADDRESS_B = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";

// Partial mock — RecordPreviewProvider (pulled in by TestProviders) also
// consumes useCustomFields/useSeedNames/useWalletSoftware from this module, so
// keep the real exports and override only useSettings.
vi.mock("@/hooks/use-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-settings")>();
  return {
    ...actual,
    useSettings: () => ({ fundTrailTxLimit: CUSTOM_TX_LIMIT }),
  };
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}));

// --- Swap radix Select for a native <select> so options are choosable -----
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

// --- Engine seam: spy on computeMultiHopKnown, stub the rest --------------
const EMPTY_MULTIHOP: MultiHopTrailResult = {
  sources: [],
  destinations: [],
  caps: [],
};

const computeMultiHopKnownSpy = vi.fn(
  async (): Promise<MultiHopTrailResult> => EMPTY_MULTIHOP,
);

vi.mock("@/lib/data/fund-trail-engine", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/data/fund-trail-engine")
  >("@/lib/data/fund-trail-engine");
  return {
    ...actual,
    listGroupValues: vi.fn(async () => []),
    getAddressesForGroup: vi.fn(async () => []),
    getRecordByAddress: vi.fn(async () => undefined),
    computeOneHop: vi.fn(async () => ({
      sources: [],
      destinations: [],
      isCapped: false,
      shownTxCount: 0,
      totalTxCount: 0,
    })),
    computeMultiHopKnown: (...args: unknown[]) =>
      (computeMultiHopKnownSpy as unknown as (
        ...a: unknown[]
      ) => Promise<MultiHopTrailResult>)(...args),
  };
});

const { default: FundTrail } = await import("./FundTrail");

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <TestProviders>
        <FundTrail />
      </TestProviders>
    </QueryClientProvider>,
  );
  return { queryClient, ...utils };
}

/** All cache keys currently registered for the multi-hop query. */
function multiHopKeys(queryClient: QueryClient): unknown[][] {
  return queryClient
    .getQueryCache()
    .getAll()
    .map((q) => q.queryKey as unknown[])
    .filter((k) => Array.isArray(k) && k[0] === "fund-trail-multihop");
}

async function enterAddressMode(address: string) {
  fireEvent.click(screen.getByTestId("fund-trail-mode-address"));
  fireEvent.change(screen.getByTestId("fund-trail-address-input"), {
    target: { value: address },
  });
}

beforeEach(() => {
  computeMultiHopKnownSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("FundTrail multi-hop cache key", () => {
  it("encodes the chosen backward/forward hop depths into the query key", async () => {
    const { queryClient } = renderPage();

    await enterAddressMode(ADDRESS_A);

    // Bump both hop-depth selects past 1 so the multi-hop query activates.
    fireEvent.change(screen.getByTestId("fund-trail-backward-hops"), {
      target: { value: "3" },
    });
    fireEvent.change(screen.getByTestId("fund-trail-forward-hops"), {
      target: { value: "2" },
    });

    await waitFor(() => {
      expect(computeMultiHopKnownSpy).toHaveBeenCalled();
    });

    // The engine must receive the chosen depths (args: addresses, dimension,
    // selfLabel, backwardHops, forwardHops, ...).
    const call = computeMultiHopKnownSpy.mock.calls.at(-1)!;
    expect(call[0]).toEqual([ADDRESS_A]);
    expect(call[3]).toBe(3); // backwardHops
    expect(call[4]).toBe(2); // forwardHops

    // And the cache key must carry those same depths so a return visit with
    // identical depths re-uses the cached entry instead of re-querying.
    // [ "fund-trail-multihop", sourceMode, dim/"address", center,
    //   start, end, txLimit, backwardHops, forwardHops ]
    const key = multiHopKeys(queryClient).find(
      (k) => k[7] === 3 && k[8] === 2,
    );
    expect(key).toBeDefined();
    expect(key![1]).toBe("address");
    expect(key![3]).toBe(ADDRESS_A);
    expect(key![6]).toBe(CUSTOM_TX_LIMIT);
  });

  it("resets the multi-hop query to a fresh key when the center address changes", async () => {
    const { queryClient } = renderPage();

    await enterAddressMode(ADDRESS_A);
    fireEvent.change(screen.getByTestId("fund-trail-backward-hops"), {
      target: { value: "2" },
    });

    await waitFor(() => {
      const call = computeMultiHopKnownSpy.mock.calls.at(-1);
      expect(call?.[0]).toEqual([ADDRESS_A]);
      expect(call?.[3]).toBe(2); // backwardHops
    });

    const keysAfterA = multiHopKeys(queryClient);
    expect(keysAfterA.some((k) => k[3] === ADDRESS_A)).toBe(true);

    // Switch the center address — this must spawn a new query key, not reuse
    // the entry computed for ADDRESS_A.
    computeMultiHopKnownSpy.mockClear();
    fireEvent.change(screen.getByTestId("fund-trail-address-input"), {
      target: { value: ADDRESS_B },
    });

    await waitFor(() => {
      const call = computeMultiHopKnownSpy.mock.calls.at(-1);
      expect(call?.[0]).toEqual([ADDRESS_B]);
      expect(call?.[3]).toBe(2); // backwardHops
    });

    // A distinct cache key now exists for ADDRESS_B (reset, not reused).
    const keysAfterB = multiHopKeys(queryClient);
    expect(keysAfterB.some((k) => k[3] === ADDRESS_B)).toBe(true);
    const keyA = keysAfterA.find((k) => k[3] === ADDRESS_A)!;
    const keyB = keysAfterB.find((k) => k[3] === ADDRESS_B)!;
    expect(keyB).not.toEqual(keyA);
  });
});

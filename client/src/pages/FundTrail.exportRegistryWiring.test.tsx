// @vitest-environment jsdom
//
// Wiring test: the Fund Trail *export* must serialize the exact expanded trail
// the user sees on screen. The FundTrail page lets each FlowCard register the
// hop it has expanded into a page-level registry keyed by `flowPath(...)`, and
// the exporter (`buildFundTrailSnapshot`) reads those hops back by the same
// keys. If the registration key and the read-back key ever drift, the export
// would silently drop hops the user opened.
//
// fund-trail-export.test.ts already verifies the builder given a correct
// registry; this test verifies the *page* actually registers each expanded hop
// under the precise key the builder reads. We render the real FundTrail page,
// expand a source group (and a nested hop under it) plus a destination group,
// then trigger an export and assert:
//   - the registry handed to buildFundTrailSnapshot contains hops under exactly
//     `flowPath("", "source", label)` / `flowPath("", "dest", label)` and the
//     nested `flowPath(parentPath, "source", childLabel)` keys, and
//   - the resulting snapshot actually nests those expanded children, and
//   - collapsing a group unregisters its hop so it is excluded from the export.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GroupFlow, TrailHop } from "@/lib/data/fund-trail-engine";

// ResizeObserver shim (some shadcn primitives reach for it).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

// --- useSettings / toast / record-preview: trivial stubs -----------------
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

// --- Flatten the radix DropdownMenu so the export items are clickable -----
vi.mock("@/components/ui/dropdown-menu", async () => {
  const React = await import("react");
  return {
    DropdownMenu: ({ children }: any) =>
      React.createElement(React.Fragment, null, children),
    DropdownMenuTrigger: ({ children }: any) =>
      React.createElement(React.Fragment, null, children),
    DropdownMenuContent: ({ children }: any) =>
      React.createElement(React.Fragment, null, children),
    DropdownMenuItem: ({ children, onClick, ...props }: any) =>
      React.createElement("button", { onClick, ...props }, children),
  };
});

// --- Export seam: keep the real builder + flowPath, but capture the registry
//     handed to buildFundTrailSnapshot and stub the actual download. ---------
const captured = vi.hoisted(() => ({
  expandedHops: null as Map<string, TrailHop> | null,
  snapshot: null as import("@/lib/data/fund-trail-export").FundTrailSnapshot | null,
}));

vi.mock("@/lib/data/fund-trail-export", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/data/fund-trail-export")
  >("@/lib/data/fund-trail-export");
  return {
    ...actual,
    triggerDownload: vi.fn(),
    buildFundTrailSnapshot: (...args: any[]) => {
      const snap = (actual.buildFundTrailSnapshot as any)(...args);
      // Freeze a copy of the registry keys at export time (the page reuses a
      // single Map instance, which would otherwise mutate under us).
      captured.expandedHops = new Map(args[3] as Map<string, TrailHop>);
      captured.snapshot = snap;
      return snap;
    },
  };
});

// --- Engine seam: stub the loaders, dispatch hops by group label ----------
const ROOT = "Origin";
const SRC = "Alice"; // expandable source group on the center hop
const SRC_CHILD = "Carol"; // next hop under Alice (source side)
const SRC_GRANDCHILD = "Dave"; // next hop under Carol (source side)
const DST = "Bob"; // expandable destination group on the center hop
const DST_CHILD = "Erin"; // next hop under Bob (destination side)

function mkFlow(groupLabel: string, addr: string, txid: string): GroupFlow {
  return {
    groupLabel,
    dimension: "walletName",
    totalSats: 100,
    details: [{ address: addr, txid, amount: 100, blockTime: 1000 }],
    isUnknown: false,
  };
}

function mkHop(sources: GroupFlow[], destinations: GroupFlow[]): TrailHop {
  return {
    sources,
    destinations,
    isCapped: false,
    shownTxCount: sources.length + destinations.length,
    totalTxCount: sources.length + destinations.length,
  };
}

const EMPTY_HOP = mkHop([], []);

// computeOneHop is reused for the center query (selfLabel = selected group) and
// every FlowCard expansion (selfLabel = that group's label). Dispatch on label.
const HOPS: Record<string, TrailHop> = {
  [ROOT]: mkHop(
    [mkFlow(SRC, "addr-alice", "tx-alice")],
    [mkFlow(DST, "addr-bob", "tx-bob")],
  ),
  [SRC]: mkHop([mkFlow(SRC_CHILD, "addr-carol", "tx-carol")], []),
  [SRC_CHILD]: mkHop([mkFlow(SRC_GRANDCHILD, "addr-dave", "tx-dave")], []),
  [DST]: mkHop([], [mkFlow(DST_CHILD, "addr-erin", "tx-erin")]),
};

const computeOneHopSpy = vi.fn(
  async (
    _addresses: string[],
    _dimension: unknown,
    selfLabel: string | null,
  ): Promise<TrailHop> => (selfLabel ? HOPS[selfLabel] ?? EMPTY_HOP : EMPTY_HOP),
);

vi.mock("@/lib/data/fund-trail-engine", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/data/fund-trail-engine")
  >("@/lib/data/fund-trail-engine");
  return {
    ...actual,
    listGroupValues: vi.fn(async () => [ROOT]),
    getAddressesForGroup: vi.fn(async () => [{ inputString: "addr-1" }]),
    computeOneHop: (...args: unknown[]) =>
      (computeOneHopSpy as unknown as (...a: unknown[]) => Promise<TrailHop>)(
        ...args,
      ),
  };
});

const { default: FundTrail } = await import("./FundTrail");
const { flowPath } = await import("@/lib/data/fund-trail-export");

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

/** Pick the group, then wait for the center hop's source/dest cards to render. */
async function selectRootGroup() {
  await waitFor(() => {
    const sel = screen.getByTestId(
      "fund-trail-group-select",
    ) as HTMLSelectElement;
    expect(Array.from(sel.options).some((o) => o.value === ROOT)).toBe(true);
  });
  fireEvent.change(screen.getByTestId("fund-trail-group-select"), {
    target: { value: ROOT },
  });
  await screen.findByTestId(`fund-trail-expand-${SRC}-d0`);
  await screen.findByTestId(`fund-trail-expand-${DST}-d0`);
}

function clickExportCsv() {
  fireEvent.click(screen.getByTestId("fund-trail-export-csv"));
  return waitFor(() => {
    expect(captured.snapshot).not.toBeNull();
  });
}

beforeEach(() => {
  captured.expandedHops = null;
  captured.snapshot = null;
  computeOneHopSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("FundTrail export registry wiring", () => {
  it("registers an expanded source hop under the key the exporter reads", async () => {
    renderPage();
    await selectRootGroup();

    // Expand the "Alice" source group.
    fireEvent.click(screen.getByTestId(`fund-trail-expand-${SRC}-d0`));
    // Its expanded child card must appear.
    await screen.findByTestId(`fund-trail-flow-card-${SRC_CHILD}-d1`);

    await clickExportCsv();

    const key = flowPath("", "source", SRC);
    expect(captured.expandedHops!.has(key)).toBe(true);

    // And the exporter actually nested the expanded child under that group.
    const aliceNode = captured.snapshot!.sources.find(
      (n) => n.groupLabel === SRC,
    );
    expect(aliceNode).toBeDefined();
    expect(aliceNode!.children.map((c) => c.groupLabel)).toEqual([SRC_CHILD]);
  });

  it("registers an expanded destination hop under the key the exporter reads", async () => {
    renderPage();
    await selectRootGroup();

    fireEvent.click(screen.getByTestId(`fund-trail-expand-${DST}-d0`));
    await screen.findByTestId(`fund-trail-flow-card-${DST_CHILD}-d1`);

    await clickExportCsv();

    const key = flowPath("", "dest", DST);
    expect(captured.expandedHops!.has(key)).toBe(true);

    const bobNode = captured.snapshot!.destinations.find(
      (n) => n.groupLabel === DST,
    );
    expect(bobNode).toBeDefined();
    expect(bobNode!.children.map((c) => c.groupLabel)).toEqual([DST_CHILD]);
  });

  it("registers a nested hop under the nested path key", async () => {
    renderPage();
    await selectRootGroup();

    // Expand Alice → reveals Carol; expand Carol → reveals Dave.
    fireEvent.click(screen.getByTestId(`fund-trail-expand-${SRC}-d0`));
    const carolExpand = await screen.findByTestId(
      `fund-trail-expand-${SRC_CHILD}-d1`,
    );
    fireEvent.click(carolExpand);
    await screen.findByTestId(`fund-trail-flow-card-${SRC_GRANDCHILD}-d2`);

    await clickExportCsv();

    const parentKey = flowPath("", "source", SRC); // "source/Alice"
    const nestedKey = flowPath(parentKey, "source", SRC_CHILD); // "source/Alice/Carol"
    expect(captured.expandedHops!.has(parentKey)).toBe(true);
    expect(captured.expandedHops!.has(nestedKey)).toBe(true);

    // The snapshot nests Carol under Alice and Dave under Carol.
    const alice = captured.snapshot!.sources.find((n) => n.groupLabel === SRC)!;
    const carol = alice.children.find((c) => c.groupLabel === SRC_CHILD)!;
    expect(carol).toBeDefined();
    expect(carol.children.map((c) => c.groupLabel)).toEqual([SRC_GRANDCHILD]);
  });

  it("unregisters a collapsed hop so it is excluded from the export", async () => {
    renderPage();
    await selectRootGroup();

    const key = flowPath("", "source", SRC);

    // Expand, confirm it is registered.
    fireEvent.click(screen.getByTestId(`fund-trail-expand-${SRC}-d0`));
    await screen.findByTestId(`fund-trail-flow-card-${SRC_CHILD}-d1`);
    await clickExportCsv();
    expect(captured.expandedHops!.has(key)).toBe(true);

    // Collapse the same group (the Expand button toggles).
    captured.snapshot = null;
    fireEvent.click(screen.getByTestId(`fund-trail-expand-${SRC}-d0`));
    await waitFor(() => {
      expect(
        screen.queryByTestId(`fund-trail-flow-card-${SRC_CHILD}-d1`),
      ).toBeNull();
    });

    await clickExportCsv();
    expect(captured.expandedHops!.has(key)).toBe(false);

    const aliceNode = captured.snapshot!.sources.find(
      (n) => n.groupLabel === SRC,
    );
    expect(aliceNode!.children).toEqual([]);
  });
});

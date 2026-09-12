// @vitest-environment jsdom
//
// Cancel-during-layout regression coverage. Previously the Cancel button only
// existed while data was loading (isAnalyzing); once the graph was built and
// the force simulation started, the header flipped back to "Analyze" and the
// only escape from a long "Laying out graph..." phase was reloading the page.
// These tests pin that (a) the Cancel control stays available during the
// layout phase, (b) clicking it stops the simulation and returns the page to
// an idle, non-stuck state, and (c) the dense-graph pruning disclosure notice
// reaches the user.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import type { NetworkGraph } from "@/lib/network-analysis";

// The node testid is `node-address-${id.slice(0, 8)}` — fixture addresses must
// differ in their first 8 characters.
const ADDRS = Array.from(
  { length: 40 },
  (_, i) => `C${String(i).padStart(2, "0")}canceladdrxxxxxxxxxxxxxxxxxxxxx`,
);

const node = (id: string, i: number): NetworkGraph["nodes"][number] => ({
  id,
  label: id.slice(0, 6),
  tags: [],
  degree: 2,
  community: i,
  centrality: 0.5,
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
});

const edges: NetworkGraph["edges"] = ADDRS.slice(1).map((id, i) => ({
  source: ADDRS[i],
  target: id,
  weight: 1,
  txids: [`tx${i}`],
}));

function makeGraph(statsOverride?: Partial<NetworkGraph["stats"]>): NetworkGraph {
  return {
    nodes: ADDRS.map(node),
    edges,
    layoutEdges: edges,
    communities: new Map<number, string[]>(ADDRS.map((id, i) => [i, [id]])),
    stats: {
      nodeCount: ADDRS.length,
      edgeCount: edges.length,
      communityCount: ADDRS.length,
      largestCommunitySize: 1,
      isolatedNodes: 0,
      avgDegree: 2,
      bridgeNodes: [],
      skippedCliqueTransactions: 0,
      hiddenEdgeCount: 0,
      ...statsOverride,
    },
  };
}

const records = ADDRS.map((id, i) => ({
  id: i + 1,
  type: "address",
  inputString: id,
  syncDepth: 0,
}));

const { buildNetworkGraphMock } = vi.hoisted(() => ({
  buildNetworkGraphMock: vi.fn(),
}));

vi.mock("@/lib/dataFacade", () => ({
  getRecordsByType: vi.fn(() => Promise.resolve(records)),
  countTransactionParticipants: vi.fn(() => Promise.resolve(0)),
  getAllTransactionParticipants: vi.fn(() => Promise.resolve([])),
  getParticipantsByRecordIds: vi.fn(() => Promise.resolve([])),
  getParticipantsByTxids: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/lib/network-analysis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/network-analysis")>();
  return {
    ...actual,
    buildNetworkGraph: buildNetworkGraphMock,
  };
});

vi.mock("@/contexts/RecordPreviewContext", () => ({
  useRecordPreview: () => ({ openRecordPreviewByAddress: vi.fn(() => Promise.resolve()) }),
}));

import NetworkAnalysis from "./NetworkAnalysis";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("NetworkAnalysis — cancel during layout", () => {
  it("keeps a Cancel control during the layout phase and stopping it returns the page to idle", async () => {
    buildNetworkGraphMock.mockResolvedValue(makeGraph());
    render(<NetworkAnalysis />);
    fireEvent.click(screen.getByTestId("button-run-analysis"));

    // Layout phase begins: the "Laying out graph..." indicator shows and the
    // Cancel control (not Analyze) is available.
    await waitFor(() => expect(screen.getByText("Laying out graph...")).toBeTruthy(), {
      timeout: 5000,
    });
    const cancel = screen.getByTestId("button-cancel-analysis");
    expect(screen.queryByTestId("button-run-analysis")).toBeNull();

    fireEvent.click(cancel);

    // The layout indicator disappears immediately — the page is not stuck —
    // the Analyze button is back (idle state), and the graph stays visible,
    // frozen at its last laid-out positions.
    await waitFor(() => expect(screen.queryByText("Laying out graph...")).toBeNull(), {
      timeout: 5000,
    });
    expect(screen.getByTestId("button-run-analysis")).toBeTruthy();
    expect(screen.getByTestId(`node-address-${ADDRS[0].slice(0, 8)}`)).toBeTruthy();
  });
});

describe("NetworkAnalysis — dense-graph disclosure", () => {
  it("discloses weight-pruned edges and skipped oversized transactions in the stats panel", async () => {
    buildNetworkGraphMock.mockResolvedValue(
      makeGraph({ hiddenEdgeCount: 12_345, skippedCliqueTransactions: 3 }),
    );
    render(<NetworkAnalysis />);
    fireEvent.click(screen.getByTestId("button-run-analysis"));

    await waitFor(() => expect(screen.getByTestId("notice-hidden-edges")).toBeTruthy(), {
      timeout: 5000,
    });
    expect(screen.getByTestId("notice-hidden-edges").textContent).toContain("12,345");
    expect(screen.getByTestId("notice-skipped-cliques").textContent).toContain("3");
    expect(screen.getByTestId("text-stat-shown-edges").textContent).toBe(
      (edges.length - 12_345).toLocaleString(),
    );
    expect(screen.getByTestId("text-stat-skipped-cliques").textContent).toBe("3");
    // Full-graph connection count is still reported.
    expect(screen.getByTestId("text-stat-edges").textContent).toBe(
      edges.length.toLocaleString(),
    );
  });

  it("renders no pruning notice for normal-sized graphs", async () => {
    buildNetworkGraphMock.mockResolvedValue(makeGraph());
    render(<NetworkAnalysis />);
    fireEvent.click(screen.getByTestId("button-run-analysis"));

    await waitFor(
      () => expect(screen.getByTestId(`node-address-${ADDRS[0].slice(0, 8)}`)).toBeTruthy(),
      { timeout: 5000 },
    );
    expect(screen.queryByTestId("notice-hidden-edges")).toBeNull();
    expect(screen.queryByTestId("notice-skipped-cliques")).toBeNull();
    expect(screen.queryByTestId("text-stat-shown-edges")).toBeNull();
  });
});

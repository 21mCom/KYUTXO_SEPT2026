// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import type { NetworkGraph } from "@/lib/network-analysis";

// NetworkAnalysis.tsx pulls in a heavy data/graph surface. We stub the data
// facade and the graph builder so a click on "Analyze" produces a fixed,
// deterministic graph; the real d3-force layout then renders the SVG nodes.
const ALPHA = "1AlphaAddressxxxxxxxxxxxxxxxxxxxxxxx";
const BRAVO = "1BravoAddressxxxxxxxxxxxxxxxxxxxxxxx";

const node = (id: string): NetworkGraph["nodes"][number] => ({
  id,
  label: id.slice(0, 6),
  tags: [],
  degree: 1,
  community: 0,
  centrality: 0.5,
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
});

const graph: NetworkGraph = {
  nodes: [node(ALPHA), node(BRAVO)],
  edges: [{ source: ALPHA, target: BRAVO, weight: 1, txids: ["tx1"] }],
  communities: new Map<number, string[]>([[0, [ALPHA, BRAVO]]]),
  stats: {
    nodeCount: 2,
    edgeCount: 1,
    communityCount: 1,
    largestCommunitySize: 2,
    isolatedNodes: 0,
    avgDegree: 1,
    bridgeNodes: [],
  },
};

const records = [
  { id: 1, type: "address", inputString: ALPHA, syncDepth: 0 },
  { id: 2, type: "address", inputString: BRAVO, syncDepth: 0 },
];

const openRecordPreviewByAddress = vi.fn(() => Promise.resolve());

vi.mock("@/lib/dataFacade", () => ({
  getRecordsByType: vi.fn(() => Promise.resolve(records)),
  countTransactionParticipants: vi.fn(() => Promise.resolve(0)),
  getAllTransactionParticipants: vi.fn(() => Promise.resolve([])),
  getParticipantsByRecordIds: vi.fn(() => Promise.resolve([])),
  getParticipantsByTxids: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/lib/network-analysis", () => ({
  buildNetworkGraph: vi.fn(() => Promise.resolve(graph)),
  MAX_NODES: 3000,
  getCommunityColor: vi.fn(() => "#000000"),
}));

vi.mock("@/contexts/RecordPreviewContext", () => ({
  useRecordPreview: () => ({ openRecordPreviewByAddress }),
}));

import NetworkAnalysis from "./NetworkAnalysis";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  openRecordPreviewByAddress.mockClear();
});

const alphaTestId = `node-address-${ALPHA.slice(0, 8)}`;
const bravoTestId = `node-address-${BRAVO.slice(0, 8)}`;

async function renderAndAnalyze() {
  render(<NetworkAnalysis />);
  fireEvent.click(screen.getByTestId("button-run-analysis"));
  // d3-force lays out the nodes asynchronously after the graph is built.
  await waitFor(() => expect(screen.getByTestId(alphaTestId)).toBeTruthy(), {
    timeout: 5000,
  });
}

describe("NetworkAnalysis node interaction", () => {
  it("opens the node's record on a mouse click (passing the address)", async () => {
    await renderAndAnalyze();
    fireEvent.click(screen.getByTestId(alphaTestId));
    expect(openRecordPreviewByAddress).toHaveBeenCalledTimes(1);
    expect(openRecordPreviewByAddress).toHaveBeenCalledWith(ALPHA);
  });

  it("opens the record when Enter is pressed on a focused node", async () => {
    await renderAndAnalyze();
    fireEvent.keyDown(screen.getByTestId(bravoTestId), { key: "Enter" });
    expect(openRecordPreviewByAddress).toHaveBeenCalledTimes(1);
    expect(openRecordPreviewByAddress).toHaveBeenCalledWith(BRAVO);
  });

  it("opens the record when Space is pressed on a focused node", async () => {
    await renderAndAnalyze();
    fireEvent.keyDown(screen.getByTestId(bravoTestId), { key: " " });
    expect(openRecordPreviewByAddress).toHaveBeenCalledTimes(1);
    expect(openRecordPreviewByAddress).toHaveBeenCalledWith(BRAVO);
  });

  it("does not open a record for other keys", async () => {
    await renderAndAnalyze();
    fireEvent.keyDown(screen.getByTestId(alphaTestId), { key: "a" });
    expect(openRecordPreviewByAddress).not.toHaveBeenCalled();
  });

  it("exposes a button role and tab focus for keyboard users", async () => {
    await renderAndAnalyze();
    const el = screen.getByTestId(alphaTestId);
    expect(el.getAttribute("role")).toBe("button");
    expect(el.getAttribute("tabindex")).toBe("0");
  });
});

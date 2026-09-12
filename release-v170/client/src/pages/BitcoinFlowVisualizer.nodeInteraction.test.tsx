// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { FlowData } from "@/hooks/use-flow-data";

// BitcoinFlowVisualizer.tsx imports a large surface (IndexedDB-backed db,
// data facade, vocabulary hooks, child components). Stub the heavy modules so
// the page mounts cheaply and deterministically, and feed it a fixed flow so
// the Sankey nodes render predictably.
const INPUT_ADDR = "bc1qinputaddressxxxxxxxxxxxxxxxxxxxxxxxx0";
const OUTPUT_ADDR = "bc1qoutputaddressxxxxxxxxxxxxxxxxxxxxxxx1";
const SELECTED_ADDR = "bc1qselectedaddressxxxxxxxxxxxxxxxxxxxx2";

const flowData: FlowData = {
  nodes: [
    {
      id: "in-1",
      address: INPUT_ADDR,
      amount: 0.5,
      timestamp: "2024-01-01",
      hop: -1,
      type: "input",
      isLabeled: false,
    },
    {
      id: "sel-1",
      address: SELECTED_ADDR,
      amount: 1,
      timestamp: "2024-01-02",
      hop: 0,
      type: "selected",
      isLabeled: true,
    },
    {
      id: "out-1",
      address: OUTPUT_ADDR,
      amount: 0.4,
      timestamp: "2024-01-03",
      hop: 1,
      type: "output",
      isLabeled: false,
    },
  ],
  links: [],
  stats: {
    inputCount: 1,
    outputCount: 1,
    totalInputValue: 0.5,
    totalOutputValue: 0.4,
  },
};

// Radix UI primitives (Slider/ScrollArea) observe element size at mount.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

const openRecordPreviewByAddress = vi.fn(() => Promise.resolve());

vi.mock("@/lib/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/database")>();
  return { ...actual, db: {} };
});
vi.mock("@/lib/dataFacade", () => ({ getParticipantsByAddresses: vi.fn() }));
vi.mock("@/hooks/use-flow-data", () => ({
  useFlowData: () => ({
    flowData,
    isLoading: false,
    error: null,
    dataSource: "local",
    fetchFlow: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-page-shortcuts", () => ({ usePageShortcuts: vi.fn() }));
vi.mock("@/hooks/use-owners", () => ({ useOwners: () => ({ owners: [], isLoading: false }) }));
vi.mock("@/hooks/use-wallet-names", () => ({ useWalletNames: () => ({ walletNames: [], isLoading: false }) }));
vi.mock("@/hooks/use-tags", () => ({ useTags: () => ({ tags: [], isLoading: false }) }));
vi.mock("@/components/HopPathExplorer", () => ({ HopPathExplorer: () => null }));
vi.mock("@/components/RecordDetailPanel", () => ({ RecordDetailPanel: () => null }));
vi.mock("@/components/ScrollPositionIndicator", () => ({ ScrollPositionIndicator: () => null }));
vi.mock("@/contexts/RecordPreviewContext", () => ({
  useRecordPreview: () => ({ openRecordPreviewByAddress }),
}));

import BitcoinFlowVisualizer from "./BitcoinFlowVisualizer";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  openRecordPreviewByAddress.mockClear();
});

describe("BitcoinFlowVisualizer Sankey node interaction", () => {
  it("opens the input node's record on a mouse click", () => {
    render(<BitcoinFlowVisualizer />);
    fireEvent.click(screen.getByTestId("sankey-input-in-1"));
    expect(openRecordPreviewByAddress).toHaveBeenCalledTimes(1);
    expect(openRecordPreviewByAddress).toHaveBeenCalledWith(INPUT_ADDR);
  });

  it("opens the output node's record on a mouse click", () => {
    render(<BitcoinFlowVisualizer />);
    fireEvent.click(screen.getByTestId("sankey-output-out-1"));
    expect(openRecordPreviewByAddress).toHaveBeenCalledTimes(1);
    expect(openRecordPreviewByAddress).toHaveBeenCalledWith(OUTPUT_ADDR);
  });

  it("opens the selected node's record on a mouse click", () => {
    render(<BitcoinFlowVisualizer />);
    fireEvent.click(screen.getByTestId("sankey-selected-node"));
    expect(openRecordPreviewByAddress).toHaveBeenCalledTimes(1);
    expect(openRecordPreviewByAddress).toHaveBeenCalledWith(SELECTED_ADDR);
  });

  it("opens the record when Enter is pressed on a focused input node", () => {
    render(<BitcoinFlowVisualizer />);
    fireEvent.keyDown(screen.getByTestId("sankey-input-in-1"), { key: "Enter" });
    expect(openRecordPreviewByAddress).toHaveBeenCalledTimes(1);
    expect(openRecordPreviewByAddress).toHaveBeenCalledWith(INPUT_ADDR);
  });

  it("opens the record when Space is pressed on a focused output node", () => {
    render(<BitcoinFlowVisualizer />);
    fireEvent.keyDown(screen.getByTestId("sankey-output-out-1"), { key: " " });
    expect(openRecordPreviewByAddress).toHaveBeenCalledTimes(1);
    expect(openRecordPreviewByAddress).toHaveBeenCalledWith(OUTPUT_ADDR);
  });

  it("does not open a record for other keys", () => {
    render(<BitcoinFlowVisualizer />);
    fireEvent.keyDown(screen.getByTestId("sankey-input-in-1"), { key: "a" });
    expect(openRecordPreviewByAddress).not.toHaveBeenCalled();
  });

  it("exposes a button role and tab focus on Sankey nodes", () => {
    render(<BitcoinFlowVisualizer />);
    const node = screen.getByTestId("sankey-input-in-1");
    expect(node.getAttribute("role")).toBe("button");
    expect(node.getAttribute("tabindex")).toBe("0");
  });
});

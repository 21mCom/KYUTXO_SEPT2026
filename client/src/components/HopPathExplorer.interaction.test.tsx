// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { HopPathExplorer } from "./HopPathExplorer";
import type { FlowNode } from "@/hooks/use-flow-data";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CENTER = "bc1qcenteraddressxxxxxxxxxxxxxxxxxxxxxxx0";
const SOURCE = "bc1qsourceaddressxxxxxxxxxxxxxxxxxxxxxxx1";
const DEST = "bc1qdestaddressxxxxxxxxxxxxxxxxxxxxxxxxxx2";

const nodes: FlowNode[] = [
  {
    id: "selected",
    address: CENTER,
    amount: 1,
    timestamp: "2024-01-01T00:00:00Z",
    hop: 0,
    type: "selected",
    isLabeled: true,
  },
  {
    id: "src-1",
    address: SOURCE,
    amount: 0.5,
    timestamp: "2023-12-31T00:00:00Z",
    hop: -1,
    type: "input",
    isLabeled: false,
  },
  {
    id: "dest-1",
    address: DEST,
    amount: 0.4,
    timestamp: "2024-01-02T00:00:00Z",
    hop: 1,
    type: "output",
    isLabeled: false,
  },
];

describe("HopPathExplorer node interaction", () => {
  it("opens the record in one step on a mouse click (no intermediate panel)", () => {
    const onNodeClick = vi.fn();
    const { getByTestId } = render(
      <HopPathExplorer
        nodes={nodes}
        links={[]}
        centerAddress={CENTER}
        onNodeClick={onNodeClick}
      />,
    );

    fireEvent.click(getByTestId("hop-node-src-1"));

    expect(onNodeClick).toHaveBeenCalledTimes(1);
    expect(onNodeClick).toHaveBeenCalledWith(SOURCE);
  });

  it("opens the record when Enter is pressed on a focused node", () => {
    const onNodeClick = vi.fn();
    const { getByTestId } = render(
      <HopPathExplorer
        nodes={nodes}
        links={[]}
        centerAddress={CENTER}
        onNodeClick={onNodeClick}
      />,
    );

    fireEvent.keyDown(getByTestId("hop-node-dest-1"), { key: "Enter" });

    expect(onNodeClick).toHaveBeenCalledTimes(1);
    expect(onNodeClick).toHaveBeenCalledWith(DEST);
  });

  it("opens the record when Space is pressed on a focused node", () => {
    const onNodeClick = vi.fn();
    const { getByTestId } = render(
      <HopPathExplorer
        nodes={nodes}
        links={[]}
        centerAddress={CENTER}
        onNodeClick={onNodeClick}
      />,
    );

    fireEvent.keyDown(getByTestId("hop-node-dest-1"), { key: " " });

    expect(onNodeClick).toHaveBeenCalledTimes(1);
    expect(onNodeClick).toHaveBeenCalledWith(DEST);
  });

  it("does not open the record for other keys", () => {
    const onNodeClick = vi.fn();
    const { getByTestId } = render(
      <HopPathExplorer
        nodes={nodes}
        links={[]}
        centerAddress={CENTER}
        onNodeClick={onNodeClick}
      />,
    );

    fireEvent.keyDown(getByTestId("hop-node-src-1"), { key: "a" });

    expect(onNodeClick).not.toHaveBeenCalled();
  });

  it("exposes a button role and tab focus for keyboard users", () => {
    const { getByTestId } = render(
      <HopPathExplorer nodes={nodes} links={[]} centerAddress={CENTER} />,
    );

    const node = getByTestId("hop-node-src-1");
    expect(node.getAttribute("role")).toBe("button");
    expect(node.getAttribute("tabindex")).toBe("0");
  });
});

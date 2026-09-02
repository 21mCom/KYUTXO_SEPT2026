import { describe, it, expect, vi } from "vitest";
import { createGraphNodeActivation } from "./graph-node-interaction";

function mouseEvent() {
  return { stopPropagation: vi.fn() } as unknown as Parameters<
    ReturnType<typeof createGraphNodeActivation>["onClick"]
  >[0];
}

function keyEvent(key: string) {
  return {
    key,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as Parameters<
    ReturnType<typeof createGraphNodeActivation>["onKeyDown"]
  >[0];
}

describe("createGraphNodeActivation", () => {
  it("opens the record on a single mouse click (one step) and stops propagation", () => {
    const activate = vi.fn();
    const { onClick } = createGraphNodeActivation(activate);

    const e = mouseEvent();
    onClick(e);

    expect(activate).toHaveBeenCalledTimes(1);
    expect(e.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("opens the record when Enter is pressed on the focused node", () => {
    const activate = vi.fn();
    const { onKeyDown } = createGraphNodeActivation(activate);

    const e = keyEvent("Enter");
    onKeyDown(e);

    expect(activate).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(e.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("opens the record when Space is pressed on the focused node", () => {
    const activate = vi.fn();
    const { onKeyDown } = createGraphNodeActivation(activate);

    const e = keyEvent(" ");
    onKeyDown(e);

    expect(activate).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("ignores other keys (does not open the record, does not preventDefault)", () => {
    const activate = vi.fn();
    const { onKeyDown } = createGraphNodeActivation(activate);

    const e = keyEvent("a");
    onKeyDown(e);

    expect(activate).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
//
// Verifies the BehaviorFilter control: it surfaces selected behavior labels as
// removable chips, toggling a chip removes that label, and Clear empties the set.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";

const { BehaviorFilter } = await import("@/components/BehaviorFilter");
import type { BehaviorLabel } from "@/lib/behavior-profile";

afterEach(() => {
  cleanup();
});

describe("BehaviorFilter", () => {
  it("renders no chips when nothing is selected", () => {
    const onChange = vi.fn();
    const { queryByTestId, getByTestId } = render(
      <BehaviorFilter selected={new Set<BehaviorLabel>()} onChange={onChange} />,
    );
    expect(getByTestId("button-toggle-behavior-filter")).toBeTruthy();
    expect(queryByTestId("chip-behavior-dormant")).toBeNull();
    expect(queryByTestId("button-clear-behavior-filter")).toBeNull();
  });

  it("shows a chip for each selected label and toggles it off when clicked", () => {
    const onChange = vi.fn();
    const { getByTestId } = render(
      <BehaviorFilter
        selected={new Set<BehaviorLabel>(["dormant", "accumulator"])}
        onChange={onChange}
      />,
    );
    const chip = getByTestId("chip-behavior-dormant");
    expect(chip.textContent).toContain("Dormant");
    fireEvent.click(chip);
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as Set<BehaviorLabel>;
    expect(next.has("dormant")).toBe(false);
    expect(next.has("accumulator")).toBe(true);
  });

  it("clears all selections via the Clear button", () => {
    const onChange = vi.fn();
    const { getByTestId } = render(
      <BehaviorFilter
        selected={new Set<BehaviorLabel>(["high-activity"])}
        onChange={onChange}
      />,
    );
    fireEvent.click(getByTestId("button-clear-behavior-filter"));
    const next = onChange.mock.calls[0][0] as Set<BehaviorLabel>;
    expect(next.size).toBe(0);
  });

  it("shows scanned / total progress while the tally is computing", () => {
    const { getByTestId } = render(
      <BehaviorFilter
        selected={new Set<BehaviorLabel>()}
        onChange={vi.fn()}
        countsComputing
        countsProgress={{ processed: 1200, total: 50000 }}
      />,
    );
    fireEvent.click(getByTestId("button-toggle-behavior-filter"));
    const indicator = getByTestId("text-behavior-counts-computing");
    expect(indicator.textContent).toContain("1,200");
    expect(indicator.textContent).toContain("50,000");
  });

  it("falls back to a generic counting label before the total is known", () => {
    const { getByTestId } = render(
      <BehaviorFilter
        selected={new Set<BehaviorLabel>()}
        onChange={vi.fn()}
        countsComputing
        countsProgress={{ processed: 0, total: null }}
      />,
    );
    fireEvent.click(getByTestId("button-toggle-behavior-filter"));
    expect(getByTestId("text-behavior-counts-computing").textContent).toContain(
      "Counting",
    );
  });

  it("invokes onCancelCounts when the Stop button is clicked", () => {
    const onCancelCounts = vi.fn();
    const { getByTestId } = render(
      <BehaviorFilter
        selected={new Set<BehaviorLabel>()}
        onChange={vi.fn()}
        countsComputing
        countsProgress={{ processed: 10, total: 100 }}
        onCancelCounts={onCancelCounts}
      />,
    );
    fireEvent.click(getByTestId("button-toggle-behavior-filter"));
    fireEvent.click(getByTestId("button-cancel-behavior-counts"));
    expect(onCancelCounts).toHaveBeenCalledTimes(1);
  });
});

// @vitest-environment jsdom
//
// Verifies the BehaviorFilter control: it surfaces selected behavior labels as
// removable chips, toggling a chip removes that label, and Clear empties the set.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";

const { BehaviorFilter } = await import("@/components/BehaviorFilter");
import {
  type BehaviorLabel,
  type BehaviorTallyCounts,
  emptyBehaviorTally,
} from "@/lib/behavior-profile";

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

  it("lists 'Synced — No Activity' separately from 'Not Synced' with its own count", () => {
    const counts: BehaviorTallyCounts = {
      ...emptyBehaviorTally(),
      "synced-no-activity": 7,
      "not-enough-data": 3,
      dormant: 2,
    };
    const { getByTestId } = render(
      <BehaviorFilter
        selected={new Set<BehaviorLabel>()}
        onChange={vi.fn()}
        counts={counts}
      />,
    );
    fireEvent.click(getByTestId("button-toggle-behavior-filter"));

    // The two synced-vs-not-synced buckets render as distinct rows with distinct
    // labels and their own counts — the new "synced-no-activity" bin is never
    // folded into "Not Synced".
    const syncedNoActivity = getByTestId("option-behavior-synced-no-activity");
    expect(syncedNoActivity.textContent).toContain("Synced");
    expect(syncedNoActivity.textContent).toContain("No Activity");
    expect(getByTestId("count-behavior-synced-no-activity").textContent).toBe("7");

    const notSynced = getByTestId("option-behavior-not-enough-data");
    expect(notSynced.textContent).toContain("Not Synced");
    expect(notSynced.textContent).not.toContain("No Activity");
    expect(getByTestId("count-behavior-not-enough-data").textContent).toBe("3");

    // The two are independent elements, not the same row reused.
    expect(syncedNoActivity).not.toBe(notSynced);
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

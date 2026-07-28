// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { DateAddedFilter } from "./DateAddedFilter";
import { formatAddedDate } from "@/lib/format-added-date";

afterEach(cleanup);

function setup(overrides: Partial<Parameters<typeof DateAddedFilter>[0]> = {}) {
  const onSortChange = vi.fn();
  const onSinceChange = vi.fn();
  render(
    <DateAddedFilter
      sort="default"
      since={null}
      onSortChange={onSortChange}
      onSinceChange={onSinceChange}
      {...overrides}
    />
  );
  return { onSortChange, onSinceChange };
}

describe("DateAddedFilter", () => {
  it("defaults to newest-first with no active badge", () => {
    setup();
    expect(screen.getByTestId("button-date-added-sort").textContent).toContain("Newest first");
    expect(screen.queryByTestId("badge-date-added-active")).toBeNull();
    expect(screen.queryByTestId("button-date-added-reset")).toBeNull();
  });

  it("engaging the toggle from the untouched default switches to oldest-first", () => {
    const { onSortChange } = setup();
    fireEvent.click(screen.getByTestId("button-date-added-sort"));
    expect(onSortChange).toHaveBeenCalledWith("oldest");
  });

  it("toggling back from oldest selects explicit newest (stays in date-sort mode)", () => {
    const { onSortChange } = setup({ sort: "oldest" });
    fireEvent.click(screen.getByTestId("button-date-added-sort"));
    expect(onSortChange).toHaveBeenCalledWith("newest");
  });

  it("explicit newest shows the active badge (date-sort mode engaged)", () => {
    setup({ sort: "newest" });
    expect(screen.getByTestId("badge-date-added-active").textContent).toContain("Newest first");
    expect(screen.getByTestId("button-date-added-reset")).toBeTruthy();
  });

  it("shows the active badge and reset button when sorted oldest-first", () => {
    setup({ sort: "oldest" });
    expect(screen.getByTestId("badge-date-added-active").textContent).toContain("Oldest first");
    expect(screen.getByTestId("button-date-added-reset")).toBeTruthy();
  });

  it("preset buttons emit an added-since threshold in the right window", () => {
    const { onSinceChange } = setup();
    const before = Date.now();
    fireEvent.click(screen.getByTestId("button-added-preset-24h"));
    const after = Date.now();
    expect(onSinceChange).toHaveBeenCalledTimes(1);
    const since = onSinceChange.mock.calls[0][0] as number;
    expect(since).toBeGreaterThanOrEqual(before - 24 * 60 * 60 * 1000);
    expect(since).toBeLessThanOrEqual(after - 24 * 60 * 60 * 1000);
  });

  it("'Any time' preset clears the threshold", () => {
    const { onSinceChange } = setup({ since: Date.now() - 1000 });
    fireEvent.click(screen.getByTestId("button-added-preset-any"));
    expect(onSinceChange).toHaveBeenCalledWith(null);
  });

  it("custom since-date emits local midnight of the chosen day", () => {
    const { onSinceChange } = setup();
    fireEvent.change(screen.getByTestId("input-added-since-date"), {
      target: { value: "2026-07-01" },
    });
    expect(onSinceChange).toHaveBeenCalledWith(new Date("2026-07-01T00:00:00").getTime());
  });

  it("clearing the custom date clears the threshold", () => {
    const { onSinceChange } = setup();
    const input = screen.getByTestId("input-added-since-date");
    fireEvent.change(input, { target: { value: "2026-07-01" } });
    fireEvent.change(input, { target: { value: "" } });
    expect(onSinceChange).toHaveBeenLastCalledWith(null);
  });

  it("reset returns both sort and window to defaults", () => {
    const { onSortChange, onSinceChange } = setup({ sort: "oldest", since: Date.now() - 1000 });
    fireEvent.click(screen.getByTestId("button-date-added-reset"));
    expect(onSortChange).toHaveBeenCalledWith("default");
    expect(onSinceChange).toHaveBeenCalledWith(null);
  });
});

describe("formatAddedDate", () => {
  const NOW = new Date("2026-07-28T12:00:00Z").getTime();

  it("renders relative for recent items and absolute for older ones", () => {
    expect(formatAddedDate(NOW - 30_000, NOW)).toBe("just now");
    expect(formatAddedDate(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(formatAddedDate(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
    expect(formatAddedDate(NOW - 2 * 86_400_000, NOW)).toBe("2d ago");
    expect(formatAddedDate(NOW - 30 * 86_400_000, NOW)).toMatch(/Jun \d+, 2026/);
  });

  it("handles missing values", () => {
    expect(formatAddedDate(undefined, NOW)).toBe("-");
    expect(formatAddedDate(0, NOW)).toBe("-");
  });
});

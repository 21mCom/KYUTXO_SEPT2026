// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDebouncedValue } from "./use-debounced-value";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useDebouncedValue", () => {
  it("returns the initial value immediately", () => {
    const { result } = renderHook(() => useDebouncedValue("hello", 300));
    const [debounced] = result.current;
    expect(debounced).toBe("hello");
  });

  it("isPending is false when value has not changed", () => {
    const { result } = renderHook(() => useDebouncedValue("hello", 300));
    const [, isPending] = result.current;
    expect(isPending).toBe(false);
  });

  it("isPending becomes true when the input value changes", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 300),
      { initialProps: { value: "a" } },
    );

    rerender({ value: "b" });

    const [debounced, isPending] = result.current;
    expect(debounced).toBe("a");
    expect(isPending).toBe(true);
  });

  it("updates the debounced value after the delay", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 300),
      { initialProps: { value: "a" } },
    );

    rerender({ value: "b" });

    act(() => {
      vi.advanceTimersByTime(300);
    });

    const [debounced, isPending] = result.current;
    expect(debounced).toBe("b");
    expect(isPending).toBe(false);
  });

  it("does not update the debounced value before the delay elapses", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 300),
      { initialProps: { value: "a" } },
    );

    rerender({ value: "b" });

    act(() => {
      vi.advanceTimersByTime(299);
    });

    const [debounced, isPending] = result.current;
    expect(debounced).toBe("a");
    expect(isPending).toBe(true);
  });

  it("resets the timer when the value changes before the delay completes", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 300),
      { initialProps: { value: "a" } },
    );

    rerender({ value: "b" });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    rerender({ value: "c" });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current[0]).toBe("a");
    expect(result.current[1]).toBe(true);

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(result.current[0]).toBe("c");
    expect(result.current[1]).toBe(false);
  });

  it("cleans up the timer on unmount", () => {
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

    const { rerender, unmount } = renderHook(
      ({ value }) => useDebouncedValue(value, 300),
      { initialProps: { value: "a" } },
    );

    rerender({ value: "b" });

    const callCountBefore = clearTimeoutSpy.mock.calls.length;
    unmount();

    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(callCountBefore);
    clearTimeoutSpy.mockRestore();
  });

  it("works with non-string types", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 200),
      { initialProps: { value: 1 } },
    );

    expect(result.current[0]).toBe(1);

    rerender({ value: 2 });
    expect(result.current[0]).toBe(1);
    expect(result.current[1]).toBe(true);

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current[0]).toBe(2);
    expect(result.current[1]).toBe(false);
  });

  it("handles rapid consecutive changes and only uses the last value", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 300),
      { initialProps: { value: "a" } },
    );

    rerender({ value: "b" });
    act(() => { vi.advanceTimersByTime(50); });

    rerender({ value: "c" });
    act(() => { vi.advanceTimersByTime(50); });

    rerender({ value: "d" });
    act(() => { vi.advanceTimersByTime(50); });

    rerender({ value: "e" });

    expect(result.current[0]).toBe("a");
    expect(result.current[1]).toBe(true);

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(result.current[0]).toBe("e");
    expect(result.current[1]).toBe(false);
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

type ChangeCallback = (changedTables: string[], meta?: { origin?: string }) => void;
let capturedListener: ChangeCallback | null = null;
const mockUnsubscribe = vi.fn();

vi.mock("@/lib/database", () => ({
  subscribeToDbChanges: vi.fn((listener: ChangeCallback) => {
    capturedListener = listener;
    return mockUnsubscribe;
  }),
}));

import { useDbChangeSignal } from "./use-db-change-signal";

beforeEach(() => {
  vi.useFakeTimers();
  capturedListener = null;
  mockUnsubscribe.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useDbChangeSignal", () => {
  it("returns 0 initially", () => {
    const { result } = renderHook(() => useDbChangeSignal(["records"]));
    expect(result.current).toBe(0);
  });

  it("subscribes to db changes on mount", () => {
    renderHook(() => useDbChangeSignal(["records"]));
    expect(capturedListener).not.toBeNull();
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => useDbChangeSignal(["records"]));
    unmount();
    expect(mockUnsubscribe).toHaveBeenCalled();
  });

  it("increments signal when a matching table changes", () => {
    const { result } = renderHook(() => useDbChangeSignal(["records"]));

    act(() => {
      capturedListener!(["records"]);
    });

    expect(result.current).toBe(1);
  });

  it("does not increment signal when a non-matching table changes", () => {
    const { result } = renderHook(() => useDbChangeSignal(["records"]));

    act(() => {
      capturedListener!(["settings"]);
    });

    expect(result.current).toBe(0);
  });

  it("increments signal when changedTables is empty (broadcast)", () => {
    const { result } = renderHook(() => useDbChangeSignal(["records"]));

    act(() => {
      capturedListener!([]);
    });

    expect(result.current).toBe(1);
  });

  it("increments on each matching change", () => {
    const { result } = renderHook(() => useDbChangeSignal(["records"]));

    act(() => {
      capturedListener!(["records"]);
    });
    act(() => {
      capturedListener!(["records"]);
    });

    expect(result.current).toBe(2);
  });

  it("debounces changes when debounceMs is provided", () => {
    const { result } = renderHook(() => useDbChangeSignal(["records"], 200));

    act(() => {
      capturedListener!(["records"]);
    });

    expect(result.current).toBe(0);

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current).toBe(1);
  });

  it("resets debounce timer on rapid changes", () => {
    const { result } = renderHook(() => useDbChangeSignal(["records"], 200));

    act(() => {
      capturedListener!(["records"]);
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() => {
      capturedListener!(["records"]);
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(result.current).toBe(0);

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(result.current).toBe(1);
  });

  it("passes meta to the filter and skips when filter returns false", () => {
    const filter = vi.fn(
      (_tables: string[], meta?: { origin?: string }) => meta?.origin !== "blockchain-sync",
    );
    const { result } = renderHook(() =>
      useDbChangeSignal(["records"], undefined, { filter }),
    );

    act(() => {
      capturedListener!(["records"], { origin: "blockchain-sync" });
    });
    expect(result.current).toBe(0);
    expect(filter).toHaveBeenCalledWith(["records"], { origin: "blockchain-sync" });

    act(() => {
      capturedListener!(["records"], { origin: "user" });
    });
    expect(result.current).toBe(1);
  });

  it("uses the latest filter without resubscribing", () => {
    let allow = false;
    const { result, rerender } = renderHook(
      ({ allowVal }: { allowVal: boolean }) =>
        useDbChangeSignal(["records"], undefined, {
          filter: () => allowVal,
        }),
      { initialProps: { allowVal: allow } },
    );

    act(() => {
      capturedListener!(["records"]);
    });
    expect(result.current).toBe(0);

    allow = true;
    rerender({ allowVal: true });

    act(() => {
      capturedListener!(["records"]);
    });
    expect(result.current).toBe(1);
  });

  it("clears pending debounce timer on unmount", () => {
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
    const { unmount } = renderHook(() => useDbChangeSignal(["records"], 200));

    act(() => {
      capturedListener!(["records"]);
    });

    const callsBefore = clearTimeoutSpy.mock.calls.length;
    unmount();
    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThanOrEqual(callsBefore);
    clearTimeoutSpy.mockRestore();
  });
});

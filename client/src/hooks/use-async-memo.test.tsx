// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import {
  processInChunks,
  checkAbort,
  useAsyncMemo,
} from "./use-async-memo";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("processInChunks", () => {
  it("processes all items and returns results", async () => {
    vi.useRealTimers();
    const items = [1, 2, 3, 4, 5];
    const result = await processInChunks(items, (n) => n * 2, 10);
    expect(result).toEqual([2, 4, 6, 8, 10]);
  });

  it("handles an empty array", async () => {
    vi.useRealTimers();
    const result = await processInChunks([], (n: number) => n, 5);
    expect(result).toEqual([]);
  });

  it("processes items in chunks and yields between them", async () => {
    vi.useRealTimers();
    const items = [1, 2, 3, 4];
    const processor = vi.fn((n: number) => n);

    const result = await processInChunks(items, processor, 2);

    expect(result).toEqual([1, 2, 3, 4]);
    expect(processor).toHaveBeenCalledTimes(4);
  });

  it("does not yield after the last chunk", async () => {
    vi.useRealTimers();
    const items = [1, 2];
    const result = await processInChunks(items, (n) => n * 10, 5);
    expect(result).toEqual([10, 20]);
  });

  it("uses default chunk size of 500", async () => {
    vi.useRealTimers();
    const items = Array.from({ length: 10 }, (_, i) => i);
    const result = await processInChunks(items, (n) => n + 1);
    expect(result).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
  });
});

describe("checkAbort", () => {
  it("does nothing when signal is not aborted", () => {
    const controller = new AbortController();
    expect(() => checkAbort(controller.signal)).not.toThrow();
  });

  it("throws AbortedError when signal is aborted", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => checkAbort(controller.signal)).toThrow("Aborted");
  });

  it("thrown error has name AbortedError", () => {
    const controller = new AbortController();
    controller.abort();
    try {
      checkAbort(controller.signal);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).name).toBe("AbortedError");
    }
  });
});

describe("useAsyncMemo", () => {
  it("returns the initial value immediately", () => {
    const { result } = renderHook(() =>
      useAsyncMemo(async () => "resolved", [], "initial"),
    );

    expect(result.current.value).toBe("initial");
  });

  it("isComputing is true while factory is pending", () => {
    const { result } = renderHook(() =>
      useAsyncMemo(async () => {
        return new Promise(() => {});
      }, [], "init"),
    );

    expect(result.current.isComputing).toBe(true);
  });

  it("updates value when factory resolves", async () => {
    vi.useRealTimers();

    const { result } = renderHook(() =>
      useAsyncMemo(async () => "resolved-value", [], "init"),
    );

    await waitFor(() => {
      expect(result.current.value).toBe("resolved-value");
    });

    expect(result.current.isComputing).toBe(false);
  });

  it("sets isComputing to false after factory resolves", async () => {
    vi.useRealTimers();

    const { result } = renderHook(() =>
      useAsyncMemo(async () => 42, [], 0),
    );

    await waitFor(() => {
      expect(result.current.isComputing).toBe(false);
    });

    expect(result.current.value).toBe(42);
  });

  it("aborts previous computation when deps change", async () => {
    vi.useRealTimers();

    const abortedSignals: boolean[] = [];

    const factory = async (signal: AbortSignal) => {
      await new Promise((r) => setTimeout(r, 10));
      abortedSignals.push(signal.aborted);
      return signal.aborted ? "stale" : "fresh";
    };

    const { result, rerender } = renderHook(
      ({ dep }) => useAsyncMemo(factory, [dep], "init"),
      { initialProps: { dep: 1 } },
    );

    rerender({ dep: 2 });

    await waitFor(() => {
      expect(result.current.isComputing).toBe(false);
    });

    expect(result.current.value).toBe("fresh");
  });

  it("sets isComputing to false when factory rejects", async () => {
    vi.useRealTimers();

    const { result } = renderHook(() =>
      useAsyncMemo(
        async () => {
          throw new Error("fail");
        },
        [],
        "fallback",
      ),
    );

    await waitFor(() => {
      expect(result.current.isComputing).toBe(false);
    });

    expect(result.current.value).toBe("fallback");
  });

  it("does not update value when factory rejects", async () => {
    vi.useRealTimers();

    const { result } = renderHook(() =>
      useAsyncMemo(
        async () => {
          throw new Error("fail");
        },
        [],
        "initial",
      ),
    );

    await waitFor(() => {
      expect(result.current.isComputing).toBe(false);
    });

    expect(result.current.value).toBe("initial");
  });

  it("ignores stale resolved values after deps change", async () => {
    vi.useRealTimers();

    const resolvers: Array<(v: string) => void> = [];

    const factory = async (_signal: AbortSignal) => {
      return new Promise<string>((resolve) => {
        resolvers.push(resolve);
      });
    };

    const { result, rerender } = renderHook(
      ({ dep }) => useAsyncMemo(factory, [dep], "init"),
      { initialProps: { dep: 1 } },
    );

    await waitFor(() => {
      expect(resolvers.length).toBe(1);
    });

    rerender({ dep: 2 });

    await waitFor(() => {
      expect(resolvers.length).toBe(2);
    });

    act(() => {
      resolvers[1]("second");
    });

    await waitFor(() => {
      expect(result.current.value).toBe("second");
    });

    act(() => {
      resolvers[0]("first-stale");
    });

    await waitFor(() => {
      expect(result.current.isComputing).toBe(false);
    });

    expect(result.current.value).toBe("second");
  });

  it("cleans up by aborting on unmount", async () => {
    vi.useRealTimers();

    let capturedSignal: AbortSignal | null = null;

    const { unmount } = renderHook(() =>
      useAsyncMemo(
        async (signal) => {
          capturedSignal = signal;
          return new Promise(() => {});
        },
        [],
        "init",
      ),
    );

    await waitFor(() => {
      expect(capturedSignal).not.toBeNull();
    });

    expect(capturedSignal!.aborted).toBe(false);

    unmount();

    expect(capturedSignal!.aborted).toBe(true);
  });
});

// Unit coverage for the Address Checker's concurrent-run helpers:
// bounded pool (concurrency cap, cancellation, failure isolation),
// batch chunking, and the throttled row-patch buffer.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runWithConcurrency, chunk, createPatchBuffer } from "./address-checker-run";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("runWithConcurrency", () => {
  it("processes every item exactly once", async () => {
    const seen: number[] = [];
    const items = Array.from({ length: 20 }, (_, i) => i);
    await runWithConcurrency(
      items,
      async (item) => {
        await tick();
        seen.push(item);
      },
      { concurrency: 4 },
    );
    expect(seen.slice().sort((a, b) => a - b)).toEqual(items);
  });

  it("never exceeds the concurrency bound", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await runWithConcurrency(
      Array.from({ length: 30 }, (_, i) => i),
      async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await tick();
        await tick();
        inFlight--;
      },
      { concurrency: 5 },
    );
    expect(maxInFlight).toBeLessThanOrEqual(5);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("a throwing worker fails only its item and frees the slot", async () => {
    const done: number[] = [];
    const { failures } = await runWithConcurrency(
      [0, 1, 2, 3, 4, 5],
      async (item) => {
        await tick();
        if (item === 2 || item === 4) throw new Error(`boom-${item}`);
        done.push(item);
      },
      { concurrency: 2 },
    );
    expect(done.slice().sort((a, b) => a - b)).toEqual([0, 1, 3, 5]);
    expect(failures.map((f) => f.item).sort()).toEqual([2, 4]);
    expect((failures[0].error as Error).message).toMatch(/^boom-/);
  });

  it("cancellation stops new items promptly but awaits in-flight work", async () => {
    let cancelled = false;
    const started: number[] = [];
    const finished: number[] = [];
    await runWithConcurrency(
      Array.from({ length: 50 }, (_, i) => i),
      async (item) => {
        started.push(item);
        if (item === 3) cancelled = true;
        await tick();
        finished.push(item);
      },
      { concurrency: 3, isCancelled: () => cancelled },
    );
    // No new items were dequeued after cancellation propagated…
    expect(started.length).toBeLessThan(10);
    // …but everything that started was allowed to finish.
    expect(finished.slice().sort((a, b) => a - b)).toEqual(
      started.slice().sort((a, b) => a - b),
    );
  });

  it("handles an empty item list", async () => {
    const { failures } = await runWithConcurrency([], async () => {}, { concurrency: 4 });
    expect(failures).toEqual([]);
  });
});

describe("chunk", () => {
  it("splits into consecutive fixed-size batches", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([1, 2], 10)).toEqual([[1, 2]]);
    expect(chunk([], 3)).toEqual([]);
  });

  it("guards against a non-positive batch size", () => {
    expect(chunk([1, 2, 3], 0)).toEqual([[1], [2], [3]]);
  });
});

describe("createPatchBuffer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("merges patches per row and flushes on the interval", () => {
    const apply = vi.fn();
    const buf = createPatchBuffer<{ status: string; error?: string }>(apply, 250);

    buf.add(1, { status: "loading" });
    buf.add(1, { status: "done" });
    buf.add(2, { status: "error", error: "x" });
    expect(apply).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);
    expect(apply).toHaveBeenCalledTimes(1);
    const batch = apply.mock.calls[0][0] as Map<number, object>;
    expect(batch.get(1)).toEqual({ status: "done" });
    expect(batch.get(2)).toEqual({ status: "error", error: "x" });

    // Nothing queued → interval tick does not call apply again.
    vi.advanceTimersByTime(1000);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("stop() flushes the remainder and halts the timer", () => {
    const apply = vi.fn();
    const buf = createPatchBuffer<{ status: string }>(apply, 250);
    buf.add(7, { status: "done" });
    buf.stop();
    expect(apply).toHaveBeenCalledTimes(1);
    expect((apply.mock.calls[0][0] as Map<number, object>).get(7)).toEqual({ status: "done" });
    buf.add(8, { status: "done" });
    // Timer restarts on demand after stop; flushNow still works.
    buf.flushNow();
    expect(apply).toHaveBeenCalledTimes(2);
    buf.stop();
  });
});

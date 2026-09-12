// Shared windowed-list loader for virtualized result lists whose full result
// set lives in a local IndexedDB scratch store, NOT in memory (Balance
// Integrity stale-address list, Dormant Coins lists).
//
// Loads fixed-size row windows from the store for the visible range and
// caches them by absolute row index. A `count` reset to 0 clears the cache
// (a new run rewrote the store).
//
// Mid-load cancellation contract (regression-tested by
// DatabaseDoctor.staleList.midLoadRangeChange.test.tsx): when the load effect
// re-runs while a fetch is in flight (visible range or count changed), the
// cleanup must remove the in-flight windows from the pending set IMMEDIATELY
// and the loader must check cancellation per window — otherwise the re-run
// skips those windows as "already pending" while the cancelled loader never
// schedules a re-render, leaving rows stuck on "Loading…" forever.

import { useEffect, useRef, useState } from "react";

export const DEFAULT_WINDOW_SIZE = 100;

export function useWindowedRows<T>(
  count: number,
  fetchWindow: (offset: number, limit: number) => Promise<T[]>,
  windowSize: number = DEFAULT_WINDOW_SIZE,
) {
  const rowCacheRef = useRef<Map<number, T>>(new Map());
  const pendingRef = useRef<Set<number>>(new Set());
  const [cacheVersion, setCacheVersion] = useState(0);
  // null until the consumer reports a visible range — loading before then
  // would double-fetch window 0 (once for a placeholder {0,0} range, once for
  // the real range).
  const [range, setRange] = useState<{ first: number; last: number } | null>(null);

  useEffect(() => {
    if (count === 0) {
      rowCacheRef.current.clear();
      pendingRef.current.clear();
      setCacheVersion((v) => v + 1);
    }
  }, [count]);

  useEffect(() => {
    if (count === 0 || range === null) return;
    const { first, last } = range;
    const startWindow = Math.floor(first / windowSize);
    const endWindow = Math.floor(last / windowSize);
    const windowsToLoad: number[] = [];
    for (let w = startWindow; w <= endWindow; w++) {
      if (pendingRef.current.has(w)) continue;
      const offset = w * windowSize;
      const end = Math.min(offset + windowSize, count);
      let missing = false;
      for (let i = offset; i < end; i++) {
        if (!rowCacheRef.current.has(i)) {
          missing = true;
          break;
        }
      }
      if (missing) windowsToLoad.push(w);
    }
    if (windowsToLoad.length === 0) return;

    let cancelled = false;
    for (const w of windowsToLoad) pendingRef.current.add(w);
    (async () => {
      try {
        for (const w of windowsToLoad) {
          // A cleanup ran (range/count changed): stop. The next effect run
          // re-queues any windows that are still missing, because cleanup
          // already removed them from pendingRef.
          if (cancelled) return;
          const offset = w * windowSize;
          const rows = await fetchWindow(offset, windowSize);
          rows.forEach((row, idx) => rowCacheRef.current.set(offset + idx, row));
        }
        setCacheVersion((v) => v + 1);
      } finally {
        for (const w of windowsToLoad) pendingRef.current.delete(w);
      }
    })();
    return () => {
      cancelled = true;
      // Remove immediately so the effect's next run (e.g. the visible range
      // grew while a load was in flight) doesn't skip these windows forever
      // after this load was cancelled — otherwise loaded rows would sit in
      // the cache without a re-render ever being scheduled.
      for (const w of windowsToLoad) pendingRef.current.delete(w);
    };
    // cacheVersion intentionally excluded: it would re-trigger after each load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range?.first, range?.last, count, fetchWindow, windowSize]);

  return { rowCacheRef, setRange, cacheVersion };
}

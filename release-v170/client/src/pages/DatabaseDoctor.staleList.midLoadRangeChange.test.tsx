// @vitest-environment jsdom
//
// Regression test for the windowed-list mid-load race in StaleAddressList
// (Task #2021). When the effect that loads 100-row windows re-runs while a
// load is still in flight (visible range or count changed), its cleanup sets
// `cancelled` — but if the in-flight windows stayed in the pending set until
// the loader's `finally`, the effect's re-run would skip them ("already
// pending") while the cancelled loader never schedules a re-render. Result:
// the fetched rows sit in the cache but the list is stuck on "Loading…"
// forever. The fix removes the windows from the pending set in the cleanup
// itself and makes the loader check cancellation per window.
//
// This test pins the fix down by holding the first window fetch open with a
// deferred promise, changing `count` mid-load (which re-runs the effect via
// its dependency array — the same path a visible-range change takes), then
// releasing the fetches and asserting the rows actually render.

import "fake-indexeddb/auto";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { StaleAddressList as StaleAddressListType } from "./DatabaseDoctor";

// Deferred per-call fetches so the test controls exactly when each window
// load resolves.
type Deferred = {
  offset: number;
  resolve: (rows: unknown[]) => void;
};
const fetchCalls: Deferred[] = [];

vi.mock("@/lib/data/stale-balance-report-store", () => ({
  clearStaleReport: vi.fn(async () => {}),
  appendStaleReportRows: vi.fn(async () => {}),
  exportStaleReport: vi.fn(async () => {}),
  getStaleReportWindow: vi.fn(
    (offset: number, _limit: number) =>
      new Promise<unknown[]>((resolve) => {
        fetchCalls.push({ offset, resolve: resolve as (rows: unknown[]) => void });
      }),
  ),
}));

// StaleAddressList is presentational; stub the heavy imports DatabaseDoctor.tsx
// drags in (mirrors staleReset.test.tsx).
vi.mock("@/lib/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/database")>();
  return { ...actual, db: {} };
});
vi.mock("@/lib/data/address-stats", () => ({
  detectStaleCachedBalances: vi.fn(),
  recomputeAddressStats: vi.fn(),
}));
vi.mock("@/lib/legacy-decrypt", () => ({ isEncryptedPlaceholder: () => false }));

// @tanstack/react-virtual needs ResizeObserver and real element dimensions.
const FAKE_RECT: DOMRect = {
  width: 600,
  height: 260,
  top: 0,
  left: 0,
  right: 600,
  bottom: 260,
  x: 0,
  y: 0,
  toJSON() {},
};

let StaleAddressList: typeof StaleAddressListType;

beforeAll(async () => {
  Object.defineProperty(window.HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return 600;
    },
  });
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return 260;
    },
  });
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return FAKE_RECT;
  };

  ({ StaleAddressList } = await import("./DatabaseDoctor"));
});

afterEach(() => {
  cleanup();
  fetchCalls.length = 0;
});

function makeRows(offset: number, limit: number) {
  return Array.from({ length: limit }, (_, i) => {
    const id = offset + i + 1;
    return {
      recordId: id,
      address: `bc1qstaleaddr${id}`,
      cachedSats: 1000 + id,
      computedSats: 2000 + id,
    };
  });
}

const noop = () => {};

describe("StaleAddressList - range/count change while a window load is in flight", () => {
  it("still renders the rows after the in-flight load was cancelled mid-way", async () => {
    // Initial render: count covers >1 window (STALE_WINDOW_SIZE = 100); the
    // visible viewport only needs window 0. The fetch stays pending.
    const { rerender } = render(
      <StaleAddressList
        count={250}
        selectedIds={new Set()}
        onToggleRow={noop}
        onSetManySelected={noop}
      />,
    );

    // The load effect ran and requested window 0 — held open by the deferred.
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].offset).toBe(0);

    // Rows show as Loading… while the fetch is in flight.
    expect(screen.getByTestId("row-stale-loading-0")).toBeTruthy();

    // Mid-load, `count` changes (same effect-dependency path as a visible
    // range change): cleanup runs on the first load, then the effect re-runs.
    // Window 0 is still missing from the cache, so with the fix the re-run
    // must re-queue it (cleanup removed it from the pending set immediately);
    // with the old pattern it would be skipped as "already pending".
    rerender(
      <StaleAddressList
        count={260}
        selectedIds={new Set()}
        onToggleRow={noop}
        onSetManySelected={noop}
      />,
    );

    expect(fetchCalls.length).toBe(2);
    expect(fetchCalls[1].offset).toBe(0);

    // Release the SECOND (live) fetch first, then the cancelled first one —
    // the cancelled loader must neither be needed for the render nor clobber
    // anything when it finally resolves.
    fetchCalls[1].resolve(makeRows(0, 100));
    fetchCalls[0].resolve(makeRows(0, 100));

    // The rows render — no rows stuck on "Loading…" in the visible window.
    await screen.findByTestId("checkbox-stale-1");
    expect(screen.getByTestId("text-stale-address-1").textContent).toBe("bc1qstaleaddr1");
    expect(screen.queryByTestId("row-stale-loading-0")).toBeNull();
  });

  it("cancelled loader alone never leaves visible rows on Loading… (resolve order: cancelled first)", async () => {
    const { rerender } = render(
      <StaleAddressList
        count={250}
        selectedIds={new Set()}
        onToggleRow={noop}
        onSetManySelected={noop}
      />,
    );
    expect(fetchCalls.length).toBe(1);

    rerender(
      <StaleAddressList
        count={260}
        selectedIds={new Set()}
        onToggleRow={noop}
        onSetManySelected={noop}
      />,
    );
    expect(fetchCalls.length).toBe(2);

    // Resolve the CANCELLED fetch first: it fills the cache but must not be
    // the only chance at a re-render — the live fetch's completion schedules
    // one regardless.
    fetchCalls[0].resolve(makeRows(0, 100));
    fetchCalls[1].resolve(makeRows(0, 100));

    await screen.findByTestId("checkbox-stale-1");
    expect(screen.queryByTestId("row-stale-loading-0")).toBeNull();
  });
});

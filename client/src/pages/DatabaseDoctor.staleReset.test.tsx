// @vitest-environment jsdom
//
// Regression test for the StaleAddressList cache reset between Balance Integrity
// runs (the `useEffect` on `count` in DatabaseDoctor.tsx that clears
// rowCacheRef/pendingRef when `count` resets to 0).
//
// The list caches each loaded window in a ref keyed by absolute row index and
// only reloads an index when it is missing from that cache. A new balance check
// resets the scratch store and drops `count` back to 0 before streaming a fresh
// stale set in. If the cache reset ever regressed, the indices the previous run
// already filled would still be considered "loaded", so the second run would
// silently render the FIRST run's rows at those positions (and the header
// "select all" — which acts on every cached row — would select the old run's
// ids). This test pins that reset down:
//   - run 1 loads a large stale set and selects its first window,
//   - a second run replaces the scratch store with a different, smaller stale
//     set and resets `count` to 0 and then to the new size,
//   - the previously cached rows are gone (no leftover row testids), the new
//     run's rows show in their place, and the header "select all" acts only on
//     the new run's loaded rows — never the stale carryover.

import 'fake-indexeddb/auto';
import { useEffect, useRef, useState } from "react";
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import {
  clearStaleReport,
  appendStaleReportRows,
} from "@/lib/data/stale-balance-report-store";
import type { StaleAddressList as StaleAddressListType } from "./DatabaseDoctor";

// DatabaseDoctor.tsx pulls in the IndexedDB-backed db and the stats module.
// StaleAddressList is a pure presentational component, so stub those heavy
// imports to keep this test fast and isolated (mirrors selectAll.test.tsx).
vi.mock("@/lib/database", () => ({ db: {} }));
vi.mock("@/lib/data/address-stats", () => ({
  detectStaleCachedBalances: vi.fn(),
  recomputeAddressStats: vi.fn(),
}));
vi.mock("@/lib/legacy-decrypt", () => ({ isEncryptedPlaceholder: () => false }));

// @tanstack/react-virtual needs ResizeObserver and real element dimensions to
// emit virtual rows. jsdom provides neither, so shim them; without this the
// virtualized list would render zero rows.
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

// Run 1: a stale set larger than one window (STALE_WINDOW_SIZE = 100), recordId
// equals the 1-based row position so window 0 holds ids 1..100.
const RUN1_TOTAL = 250;
const run1Rows = Array.from({ length: RUN1_TOTAL }, (_, i) => {
  const id = i + 1;
  return {
    recordId: id,
    address: `bc1qrun1addr${id}`,
    cachedSats: 1000 + id,
    computedSats: 2000 + id,
  };
});

// Run 2: a smaller stale set with COMPLETELY DIFFERENT record ids, so a leftover
// run-1 row would be unmistakable (its id can never appear in run 2).
const RUN2_TOTAL = 4;
const run2Rows = Array.from({ length: RUN2_TOTAL }, (_, i) => {
  const id = 5001 + i;
  return {
    recordId: id,
    address: `bc1qrun2addr${id}`,
    cachedSats: 7000 + id,
    computedSats: 8000 + id,
  };
});

beforeEach(async () => {
  await clearStaleReport();
});

afterEach(() => cleanup());

// Stateful wrapper that owns the selection set AND the `count` (the number of
// rows streamed into the scratch store so far). It mirrors the real
// BalanceIntegrityCard contract: when a new run resets the row count to 0 it
// also clears the selection (BalanceIntegrityCard.runCheck calls
// setStaleRowsCount(0) and setSelectedIds(new Set()) together). The current
// count + selection are exposed via callbacks so the test can drive a second run
// and assert exactly which ids remain selected.
function Harness({
  count,
  onSelectionChange,
}: {
  count: number;
  onSelectionChange: (selected: Set<number>) => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const prevCountRef = useRef(count);

  // A new run drops count to 0; clear the selection at that same moment, exactly
  // as BalanceIntegrityCard.runCheck does.
  useEffect(() => {
    if (count === 0 && prevCountRef.current !== 0) {
      setSelected(new Set());
    }
    prevCountRef.current = count;
  }, [count]);

  useEffect(() => {
    onSelectionChange(selected);
  }, [selected, onSelectionChange]);

  return (
    <StaleAddressList
      count={count}
      selectedIds={selected}
      onToggleRow={(id) =>
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        })
      }
      onSetManySelected={(ids, select) =>
        setSelected((prev) => {
          const next = new Set(prev);
          for (const id of ids) {
            if (select) next.add(id);
            else next.delete(id);
          }
          return next;
        })
      }
    />
  );
}

describe("StaleAddressList - fresh run never carries over the previous run's rows", () => {
  it("clears the cached rows and selection when count resets, then shows only the new run's rows", async () => {
    // --- Run 1: load the first window and select it. ---
    await appendStaleReportRows(run1Rows);

    let selection = new Set<number>();
    const { rerender } = render(
      <Harness count={RUN1_TOTAL} onSelectionChange={(s) => (selection = s)} />,
    );

    // First window (ids 1..100) loads in.
    await screen.findByTestId("checkbox-stale-1");

    // Select the whole loaded window via the header checkbox.
    fireEvent.click(screen.getByTestId("checkbox-stale-select-all"));
    await waitFor(() => {
      expect(selection.size).toBe(100);
    });
    expect(selection.has(1)).toBe(true);
    expect(selection.has(100)).toBe(true);

    // --- Run 2: the scratch store is replaced with a different, smaller set and
    // the row count resets to 0 before the new rows stream in. ---
    await clearStaleReport();
    await appendStaleReportRows(run2Rows);

    // count -> 0 (new run begins; the cache + selection must reset here).
    rerender(<Harness count={0} onSelectionChange={(s) => (selection = s)} />);

    // Selection is dropped the instant the run resets.
    await waitFor(() => {
      expect(selection.size).toBe(0);
    });

    // count -> the new run's size as its rows finish streaming in.
    rerender(<Harness count={RUN2_TOTAL} onSelectionChange={(s) => (selection = s)} />);

    // The new run's rows render...
    await screen.findByTestId("checkbox-stale-5001");
    expect(screen.getByTestId("text-stale-address-5001").textContent).toBe(
      "bc1qrun2addr5001",
    );

    // ...and NONE of run 1's rows survive (their ids can never appear in run 2).
    expect(screen.queryByTestId("checkbox-stale-1")).toBeNull();
    expect(screen.queryByTestId("checkbox-stale-50")).toBeNull();
    expect(screen.queryByTestId("checkbox-stale-100")).toBeNull();
    expect(screen.queryByTestId("text-stale-address-1")).toBeNull();

    // The selection still references no old ids.
    expect(selection.size).toBe(0);

    // --- The header "select all" acts only on the new run's loaded rows. ---
    fireEvent.click(screen.getByTestId("checkbox-stale-select-all"));

    await waitFor(() => {
      expect(selection.size).toBe(RUN2_TOTAL);
    });
    // Only the new run's ids — no leftover run-1 carryover.
    for (const r of run2Rows) {
      expect(selection.has(r.recordId)).toBe(true);
    }
    expect(selection.has(1)).toBe(false);
    expect(selection.has(100)).toBe(false);

    // Header reads "checked": every loaded row (all from run 2) is selected.
    expect(
      screen.getByTestId("checkbox-stale-select-all").getAttribute("data-state"),
    ).toBe("checked");
  });
});

// @vitest-environment jsdom
//
// Regression test for the StaleAddressList header "Select all loaded addresses"
// checkbox (data-testid="checkbox-stale-select-all").
//
// The header checkbox is deliberately bounded: it only ever acts on rows whose
// window has been loaded into the cache (the rows the user has actually scrolled
// into view), NEVER the unloaded remainder of a very large stale set. This
// guards against a user accidentally recomputing hundreds of thousands of
// addresses they never saw. This test pins that bounded behavior down:
//   - with a stale set larger than one window, clicking "select all" selects
//     only the currently-loaded row ids (not the full count),
//   - scrolling to load another window and clicking "select all" again extends
//     the selection to the newly-loaded rows only,
//   - the header checkbox shows "indeterminate" when only some loaded rows are
//     selected.

import 'fake-indexeddb/auto';
import { useEffect, useState } from "react";
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import {
  clearStaleReport,
  appendStaleReportRows,
} from "@/lib/data/stale-balance-report-store";
import type { StaleAddressList as StaleAddressListType } from "./DatabaseDoctor";

// DatabaseDoctor.tsx pulls in the IndexedDB-backed db and the stats module.
// StaleAddressList is a pure presentational component, so stub those heavy
// imports to keep this test fast and isolated (mirrors staleList.test.tsx).
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

// A stale set larger than one window (STALE_WINDOW_SIZE = 100) so only a slice
// is loaded at a time and scrolling reveals rows from a later window. recordId
// equals the 1-based row position, so window 0 holds ids 1..100, window 1 holds
// ids 101..200, etc.
const TOTAL = 250;
const allRows = Array.from({ length: TOTAL }, (_, i) => {
  const id = i + 1;
  return {
    recordId: id,
    address: `bc1qaddr${id}`,
    cachedSats: 1000 + id,
    computedSats: 2000 + id,
  };
});
const STALE_ROW_HEIGHT = 56;

beforeEach(async () => {
  await clearStaleReport();
  await appendStaleReportRows(allRows);
});

afterEach(() => cleanup());

// Make the scroll container's scrollTop deterministically settable so the
// virtualizer reads our offset on a scroll event (jsdom has no layout). Reused
// from the clear-selection test.
function controlScroll(el: HTMLElement) {
  let value = 0;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => value,
    set: (v: number) => {
      value = v;
    },
  });
}

// Stateful wrapper so toggles and the header "select all" actually mutate a real
// selection set. The current selection is mirrored out via onSelectionChange so
// the test can assert exactly which ids are selected after each action.
function Harness({
  count,
  onSelectionChange,
}: {
  count: number;
  onSelectionChange: (selected: Set<number>) => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
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

describe("StaleAddressList - bounded 'select all loaded addresses'", () => {
  it("select-all selects only the loaded window, then extends to newly-loaded rows on scroll", async () => {
    let selection = new Set<number>();
    render(<Harness count={TOTAL} onSelectionChange={(s) => (selection = s)} />);

    // Wait for the first window (ids 1..100) to load in.
    await screen.findByTestId("checkbox-stale-1");

    // Click the header "select all": it acts on the loaded window only.
    fireEvent.click(screen.getByTestId("checkbox-stale-select-all"));

    // Exactly the first window's 100 ids are selected — NOT the full 250 set.
    await waitFor(() => {
      expect(selection.size).toBe(100);
    });
    expect(selection.size).toBeLessThan(TOTAL);
    expect(selection.has(1)).toBe(true);
    expect(selection.has(100)).toBe(true);
    // A row from a window the user never scrolled to is untouched.
    expect(selection.has(150)).toBe(false);
    expect(selection.has(250)).toBe(false);

    // With every loaded row selected the header now reads "checked".
    expect(
      screen.getByTestId("checkbox-stale-select-all").getAttribute("data-state"),
    ).toBe("checked");

    // --- Scroll down to load the next window (ids ~101..200). ---
    const scrollEl = screen.getByTestId("scroll-stale-addresses");
    controlScroll(scrollEl);
    scrollEl.scrollTop = 130 * STALE_ROW_HEIGHT; // lands in window 1
    fireEvent.scroll(scrollEl);

    // Wait for a row that only exists in the newly-loaded window.
    await screen.findByTestId("checkbox-stale-130");

    // The first window stays selected; the new window is not yet selected, so the
    // header drops back to "indeterminate" (some loaded rows selected).
    await waitFor(() => {
      expect(
        screen.getByTestId("checkbox-stale-select-all").getAttribute("data-state"),
      ).toBe("indeterminate");
    });

    // Click "select all" again: it extends to the rows now loaded (windows 0+1),
    // still never the unloaded final window.
    fireEvent.click(screen.getByTestId("checkbox-stale-select-all"));

    await waitFor(() => {
      expect(selection.size).toBe(200);
    });
    expect(selection.size).toBeLessThan(TOTAL);
    expect(selection.has(1)).toBe(true); // window 0 still selected
    expect(selection.has(130)).toBe(true); // window 1 newly selected
    expect(selection.has(200)).toBe(true);
    // The last window (ids 201..250) was never scrolled to, so still untouched.
    expect(selection.has(250)).toBe(false);
  });

  it("header checkbox is indeterminate when only some loaded rows are selected", async () => {
    let selection = new Set<number>();
    render(<Harness count={TOTAL} onSelectionChange={(s) => (selection = s)} />);

    await screen.findByTestId("checkbox-stale-1");

    // Nothing selected yet: header is unchecked.
    expect(
      screen.getByTestId("checkbox-stale-select-all").getAttribute("data-state"),
    ).toBe("unchecked");

    // Tick a single loaded row.
    fireEvent.click(screen.getByTestId("checkbox-stale-1"));

    await waitFor(() => {
      expect(selection.has(1)).toBe(true);
    });
    // Some — but not all — loaded rows selected => indeterminate.
    expect(
      screen.getByTestId("checkbox-stale-select-all").getAttribute("data-state"),
    ).toBe("indeterminate");
  });
});

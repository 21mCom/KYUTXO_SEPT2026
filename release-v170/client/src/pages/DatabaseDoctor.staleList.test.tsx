// @vitest-environment jsdom
//
// Component test for the StaleAddressList rendered by the Database Doctor's
// Balance Integrity check. It verifies the virtualized list renders a row per
// stale address and that each "Open" link targets the matching Records page
// record (/records?id=<recordId>).
//
// The full stale set lives in a local IndexedDB scratch store (see
// stale-balance-report-store.ts), NOT in props, so the component is rendered
// with just a `count` and reads each visible window from the store on demand.

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import {
  clearStaleReport,
  appendStaleReportRows,
} from "@/lib/data/stale-balance-report-store";
import type { StaleAddressList as StaleAddressListType } from "./DatabaseDoctor";

// DatabaseDoctor.tsx pulls in the IndexedDB-backed db and the stats module.
// StaleAddressList is a pure presentational component, so stub those heavy
// imports to keep this test fast and isolated.
import { vi } from "vitest";
vi.mock("@/lib/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/database")>();
  return { ...actual, db: {} };
});
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

// DatabaseDoctor is imported dynamically (after the mocks above are hoisted) so
// its heavy IndexedDB/stats imports stay stubbed.
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

const rows = [
  { recordId: 11, address: "addr-eleven", cachedSats: 0, computedSats: 1000 },
  { recordId: 22, address: "addr-twenty-two", cachedSats: 50, computedSats: 2000 },
];

beforeEach(async () => {
  await clearStaleReport();
  await appendStaleReportRows(rows);
});

afterEach(() => cleanup());

// Minimal selection harness: most tests don't exercise selection, so default
// to an empty set and no-op handlers. Specific tests override these.
function renderList(
  overrides: Partial<{
    count: number;
    selectedIds: Set<number>;
    onToggleRow: (recordId: number) => void;
    onSetManySelected: (recordIds: number[], select: boolean) => void;
  }> = {},
) {
  return render(
    <StaleAddressList
      count={overrides.count ?? rows.length}
      selectedIds={overrides.selectedIds ?? new Set<number>()}
      onToggleRow={overrides.onToggleRow ?? (() => {})}
      onSetManySelected={overrides.onSetManySelected ?? (() => {})}
    />,
  );
}

describe("StaleAddressList", () => {
  it("renders a row per stale address with cached and computed balances", async () => {
    renderList();

    // Rows are fetched from the scratch store on demand, so wait for the first
    // window to load in.
    await waitFor(() => {
      expect(screen.getByTestId("row-stale-address-11")).toBeTruthy();
    });
    expect(screen.getByTestId("row-stale-address-22")).toBeTruthy();

    expect(screen.getByTestId("text-stale-address-11").textContent).toBe("addr-eleven");
    expect(screen.getByTestId("text-stale-cached-11").textContent).toBe("0 sats");
    expect(screen.getByTestId("text-stale-computed-11").textContent).toBe("1,000 sats");
    expect(screen.getByTestId("text-stale-cached-22").textContent).toBe("50 sats");
    expect(screen.getByTestId("text-stale-computed-22").textContent).toBe("2,000 sats");
  });

  it("links each Open button to that record on the Records page", async () => {
    renderList();

    // The Button uses asChild, so the wouter Link's anchor receives the testid.
    const link11 = await screen.findByTestId("link-stale-address-11");
    const link22 = screen.getByTestId("link-stale-address-22");

    expect(link11.tagName).toBe("A");
    expect(link11.getAttribute("href")).toBe("/records?id=11");
    expect(link22.getAttribute("href")).toBe("/records?id=22");
  });

  it("calls onToggleRow with the record id when a row checkbox is clicked", async () => {
    const onToggleRow = vi.fn();
    renderList({ onToggleRow });

    const checkbox = await screen.findByTestId("checkbox-stale-11");
    fireEvent.click(checkbox);
    expect(onToggleRow).toHaveBeenCalledWith(11);
  });

  it("reflects the selected state on each row's checkbox", async () => {
    renderList({ selectedIds: new Set([22]) });

    await screen.findByTestId("checkbox-stale-11");
    expect(screen.getByTestId("checkbox-stale-11").getAttribute("data-state")).toBe(
      "unchecked",
    );
    expect(screen.getByTestId("checkbox-stale-22").getAttribute("data-state")).toBe(
      "checked",
    );
  });

  it("select-all toggles every loaded row via onSetManySelected", async () => {
    const onSetManySelected = vi.fn();
    renderList({ onSetManySelected });

    // Wait for the loaded window so both record ids are known to the header.
    await screen.findByTestId("checkbox-stale-11");
    fireEvent.click(screen.getByTestId("checkbox-stale-select-all"));

    expect(onSetManySelected).toHaveBeenCalledTimes(1);
    const [ids, select] = onSetManySelected.mock.calls[0];
    expect([...ids].sort((a: number, b: number) => a - b)).toEqual([11, 22]);
    expect(select).toBe(true);
  });

  it("select-all header shows checked once every loaded row is selected", async () => {
    renderList({ selectedIds: new Set([11, 22]) });

    await screen.findByTestId("checkbox-stale-11");
    expect(
      screen.getByTestId("checkbox-stale-select-all").getAttribute("data-state"),
    ).toBe("checked");
  });
});

// @vitest-environment jsdom
//
// Page-level wiring proof for the no-hover note icon in the UTXOs LONG
// virtualized list — the sibling of Transactions.scrollPreload.test.tsx.
//
// preload-indicator-style tests prove a single AddressLink / TxidLink lights up
// its note icon once an external preload resolves. What they do NOT reach is the
// page-level decision of WHICH rows to preload as the user scrolls the UTXOs
// virtual list. The UTXOs page has the same scroll-driven preload wiring as the
// Transactions page (a useVirtualizer + a visibleRangeKey effect that calls
// batchPreloadIdentifiers for visible rows), but over a FLATTENED row model:
// each address group is one row and, when expanded, each of its UTXOs is its
// own row. If that effect ever stopped firing for newly-visible rows, users
// would scroll into UTXO rows whose note icons never appear without hovering.
//
// This test mounts the real VirtualizedUtxoList, drives the visible window by
// stubbing @tanstack/react-virtual (jsdom has no layout, so a real virtualizer
// yields no rows), and asserts the REAL metadata-hover preload pipeline runs for
// exactly the newly-visible identifiers (group addresses + utxo txids). Because
// the preload path is real, scrolling back over already-warmed rows must NOT
// re-query the DB — that is the dedup guarantee. getRecordsByInputStrings (the
// single DB query batchPreloadIdentifiers fans out to) is the observable proxy:
// a call for an identifier == "the list invoked batchPreloadIdentifiers for it".
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, waitFor } from "@testing-library/react";

// --- Controllable virtual window ----------------------------------------
// useVirtualizer is stubbed so the test owns the visible range. The component
// derives its preload range from getVirtualItems()[0..last].index, so changing
// `virtualWindow` + re-rendering simulates a scroll.
let virtualWindow: Array<{ index: number; start: number; size: number; end: number; key: number }> = [];
function setVisibleRange(start: number, end: number): void {
  const items = [];
  for (let i = start; i <= end; i++) {
    items.push({ index: i, start: i * 60, size: 60, end: (i + 1) * 60, key: i });
  }
  virtualWindow = items;
}
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => virtualWindow,
    getTotalSize: () => 100000,
    measureElement: () => {},
  }),
}));

// --- Real metadata-hover, stubbed DB seam --------------------------------
// metadata-hover.batchPreloadIdentifiers fans out to getRecordsByInputStrings.
// Keeping the real preload module exercises its cache/in-flight dedup; only the
// IndexedDB query is stubbed so we can observe and dedup-check it.
const { getRecordsByInputString, getRecordsByInputStrings } = vi.hoisted(() => ({
  getRecordsByInputString: vi.fn(),
  getRecordsByInputStrings: vi.fn(),
}));
vi.mock("@/lib/data/record-crud", () => ({
  getRecordsByInputString,
  getRecordsByInputStrings,
}));

// The address/txid links are covered by preload-indicator tests; stub them here
// so the test needs no provider stack and stays focused on preload wiring.
vi.mock("@/components/AddressLink", () => ({
  AddressLink: ({ address }: { address: string }) => <span>{address}</span>,
}));
vi.mock("@/components/TxidLink", () => ({
  TxidLink: ({ txid }: { txid: string }) => <span>{txid}</span>,
}));
vi.mock("@/components/ScrollPositionIndicator", () => ({
  ScrollPositionIndicator: () => null,
}));

import { VirtualizedUtxoList, type FlatUtxoRow, type AddressGroup, type UTXO } from "./UTXOs";
import { invalidateCachedRecord } from "@/lib/metadata-hover";

// 64-hex txid, unique per index.
function txid(i: number): string {
  return i.toString(16).padStart(64, "0");
}
// Distinct, valid-looking bech32-ish address string, unique per index.
function address(i: number): string {
  return `bc1q${i.toString(16).padStart(20, "0")}`;
}

function makeUtxo(txidStr: string, addr: string): UTXO {
  return {
    id: `${txidStr}:0`,
    txid: txidStr,
    vout: 0,
    address: addr,
    amountSats: 100000,
    blockTime: 1_700_000_000,
    blockHeight: 800000,
  };
}

function makeGroup(i: number): AddressGroup {
  const addr = address(i);
  return {
    address: addr,
    totalSats: 100000,
    utxos: [makeUtxo(txid(i), addr)],
    earliestDate: 1_700_000_000,
    latestDate: 1_700_000_000,
  };
}

// Build a flattened row model of N address GROUP rows only (collapsed). Each
// group row preloads its address. This isolates the group-row preload decision.
function groupRows(n: number): FlatUtxoRow[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: "group" as const,
    group: makeGroup(i),
  }));
}

const header = (
  <tr>
    <th>Address</th>
  </tr>
);

// Collect the identifiers passed to every getRecordsByInputStrings call.
function queriedIds(): string[] {
  return getRecordsByInputStrings.mock.calls.flatMap((c) => c[0] as string[]);
}

const ROW_COUNT = 40;

beforeEach(() => {
  getRecordsByInputString.mockReset();
  getRecordsByInputStrings.mockReset();
  // Each visible identifier resolves to a record (the resolved value is
  // irrelevant here; only the fact that it was queried matters for wiring).
  getRecordsByInputStrings.mockImplementation(async (ids: string[]) =>
    ids.map((id) => ({
      id: 1,
      type: "address",
      inputString: id,
      inputStringLower: id.toLowerCase(),
      notes: "has a note",
    })),
  );
  // Clear any cache entries left over from a previous test.
  for (let i = 0; i < ROW_COUNT; i++) {
    invalidateCachedRecord(address(i));
    invalidateCachedRecord(txid(i));
  }
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderList(rows: FlatUtxoRow[]) {
  return render(
    <VirtualizedUtxoList
      flattenedRows={rows}
      expandedAddresses={new Set()}
      displayUnit="btc"
      onToggleGroup={() => {}}
      onOpenUtxo={() => {}}
      scrollRef={{ current: null }}
      header={header}
    />,
  );
}

describe("VirtualizedUtxoList scroll-driven preload", () => {
  it("preloads exactly the newly visible address rows as the window scrolls", async () => {
    const rows = groupRows(ROW_COUNT);
    setVisibleRange(0, 4);
    const { rerender } = renderList(rows);

    // Initial window 0-4 -> those five group addresses get preloaded.
    await waitFor(() => expect(getRecordsByInputStrings).toHaveBeenCalled());
    await flush();
    const initial = new Set(queriedIds());
    for (let i = 0; i <= 4; i++) expect(initial.has(address(i))).toBe(true);
    // Rows outside the window were not touched.
    expect(initial.has(address(5))).toBe(false);

    getRecordsByInputStrings.mockClear();

    // Scroll the window forward to rows 5-9.
    setVisibleRange(5, 9);
    rerender(
      <VirtualizedUtxoList
        flattenedRows={rows}
        expandedAddresses={new Set()}
        displayUnit="btc"
        onToggleGroup={() => {}}
        onOpenUtxo={() => {}}
        scrollRef={{ current: null }}
        header={header}
      />,
    );
    await flush();

    const afterScroll = queriedIds();
    for (let i = 5; i <= 9; i++) expect(afterScroll).toContain(address(i));
    // The hover-only single-id path was never used.
    expect(getRecordsByInputString).not.toHaveBeenCalled();
  });

  it("preloads utxo txid rows from the flattened (expanded) row model", async () => {
    // Mix group + utxo rows: even indices are groups, odd indices are the
    // expanded UTXO rows that follow them. This mirrors an expanded address.
    const rows: FlatUtxoRow[] = [];
    for (let i = 0; i < ROW_COUNT; i += 2) {
      const group = makeGroup(i);
      rows.push({ kind: "group", group });
      rows.push({ kind: "utxo", utxo: group.utxos[0], index: 0 });
    }

    setVisibleRange(0, 3); // group(0), utxo(0), group(2), utxo(2)
    renderList(rows);

    await waitFor(() => expect(getRecordsByInputStrings).toHaveBeenCalled());
    await flush();

    const queried = queriedIds();
    // Group rows preload their address; utxo rows preload their txid.
    expect(queried).toContain(address(0));
    expect(queried).toContain(txid(0));
    expect(queried).toContain(address(2));
    expect(queried).toContain(txid(2));
  });

  it("does not re-fire preloads for rows already warmed (dedup)", async () => {
    const rows = groupRows(ROW_COUNT);
    setVisibleRange(0, 4);
    const { rerender } = renderList(rows);
    await waitFor(() => expect(getRecordsByInputStrings).toHaveBeenCalled());
    await flush();

    // Move forward to 5-9 (new rows), warming them too.
    setVisibleRange(5, 9);
    rerender(
      <VirtualizedUtxoList
        flattenedRows={rows}
        expandedAddresses={new Set()}
        displayUnit="btc"
        onToggleGroup={() => {}}
        onOpenUtxo={() => {}}
        scrollRef={{ current: null }}
        header={header}
      />,
    );
    await flush();

    getRecordsByInputStrings.mockClear();

    // Scroll back over a window (3-7) whose rows are all already warmed.
    setVisibleRange(3, 7);
    rerender(
      <VirtualizedUtxoList
        flattenedRows={rows}
        expandedAddresses={new Set()}
        displayUnit="btc"
        onToggleGroup={() => {}}
        onOpenUtxo={() => {}}
        scrollRef={{ current: null }}
        header={header}
      />,
    );
    await flush();

    // Every row in 3-7 was cached on the way out, so no DB query should fire.
    expect(getRecordsByInputStrings).not.toHaveBeenCalled();
  });

  it("only queries the rows not yet warmed when windows partially overlap", async () => {
    const rows = groupRows(ROW_COUNT);
    setVisibleRange(0, 4);
    const { rerender } = renderList(rows);
    await waitFor(() => expect(getRecordsByInputStrings).toHaveBeenCalled());
    await flush();

    getRecordsByInputStrings.mockClear();

    // Overlapping window 2-6: rows 2-4 are already warmed, only 5-6 are new.
    setVisibleRange(2, 6);
    rerender(
      <VirtualizedUtxoList
        flattenedRows={rows}
        expandedAddresses={new Set()}
        displayUnit="btc"
        onToggleGroup={() => {}}
        onOpenUtxo={() => {}}
        scrollRef={{ current: null }}
        header={header}
      />,
    );
    await flush();

    const queried = queriedIds();
    expect(queried).toContain(address(5));
    expect(queried).toContain(address(6));
    // The already-warmed overlap is not re-queried.
    expect(queried).not.toContain(address(2));
    expect(queried).not.toContain(address(3));
    expect(queried).not.toContain(address(4));
  });
});

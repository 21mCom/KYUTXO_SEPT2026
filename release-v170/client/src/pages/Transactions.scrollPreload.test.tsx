// @vitest-environment jsdom
//
// Page-level wiring proof for the no-hover note icon in a LONG virtualized list.
//
// Task #1164 proved that a single AddressLink / TxidLink lights up its note
// icon once an external preload resolves. What that test does NOT reach is the
// page-level decision of WHICH rows to preload as the user scrolls a virtual
// list. If the Transactions page ever stopped firing batchPreloadIdentifiers
// for newly-visible rows (e.g. a virtual-scroll range change was missed), users
// would scroll into rows whose icons never appear without hovering.
//
// This test mounts the real VirtualizedTransactionList, drives the visible
// window by stubbing @tanstack/react-virtual (jsdom has no layout, so a real
// virtualizer yields no rows), and asserts the REAL metadata-hover preload
// pipeline runs for exactly the newly-visible txids. Because the preload path
// is real, scrolling back over already-warmed rows must NOT re-query the DB —
// that is the dedup guarantee. getRecordsByInputStrings (the single DB query
// batchPreloadIdentifiers fans out to) is the observable proxy: a call for an
// identifier == "the page invoked batchPreloadIdentifiers for that row".
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, waitFor } from "@testing-library/react";
import type { Record as DbRecord, BlockchainTransaction } from "@/lib/database";

// --- Controllable virtual window ----------------------------------------
// useVirtualizer is stubbed so the test owns the visible range. The component
// derives its preload range from getVirtualItems()[0..last].index, so changing
// `virtualWindow` + re-rendering simulates a scroll.
let virtualWindow: Array<{ index: number; start: number; size: number; key: number }> = [];
function setVisibleRange(start: number, end: number): void {
  const items = [];
  for (let i = start; i <= end; i++) {
    items.push({ index: i, start: i * 120, size: 120, key: i });
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
const { getRecordsByInputString, getRecordsByInputStrings, bulkGetRecords } = vi.hoisted(() => ({
  getRecordsByInputString: vi.fn(),
  getRecordsByInputStrings: vi.fn(),
  bulkGetRecords: vi.fn(),
}));
vi.mock("@/lib/data/record-crud", () => ({
  getRecordsByInputString,
  getRecordsByInputStrings,
  bulkGetRecords,
  getAddressRecordsByImportanceTiers: vi.fn(),
}));

// No participants -> the address-preload branch stays empty, so this test
// isolates the row (txid) preload decision.
vi.mock("@/lib/participant-repo", () => ({
  fetchParticipantsByTxids: vi.fn(async () => []),
}));

// The address/txid links are covered by preload-indicator.test.tsx; stub them
// here so the test needs no provider stack and stays focused on preload wiring.
vi.mock("@/components/AddressLink", () => ({
  AddressLink: ({ address }: { address: string }) => <span>{address}</span>,
}));
vi.mock("@/components/TxidLink", () => ({
  TxidLink: ({ txid }: { txid: string }) => <span>{txid}</span>,
}));
vi.mock("@/components/ScrollPositionIndicator", () => ({
  ScrollPositionIndicator: () => null,
}));

import { VirtualizedTransactionList } from "./Transactions";
import { invalidateCachedRecord } from "@/lib/metadata-hover";

function txid(i: number): string {
  // 64-hex txids, unique per row.
  return i.toString(16).padStart(64, "0");
}

function makeTransactions(n: number): BlockchainTransaction[] {
  return Array.from({ length: n }, (_, i) => ({
    txid: txid(i),
    blockHeight: 800000 + i,
    blockTime: 1_700_000_000 + i * 600,
    fee: 1000,
    feeRate: 5,
    vsize: 140,
    hasOpReturn: false,
  })) as unknown as BlockchainTransaction[];
}

function recordWith(inputString: string): DbRecord {
  return {
    id: 1,
    type: "address",
    inputString,
    inputStringLower: inputString.toLowerCase(),
    label: "Labeled",
    notes: "has a note",
    tags: [],
    categories: [],
    createdAt: 0,
    updatedAt: 0,
  } as DbRecord;
}

// Collect the identifiers passed to every getRecordsByInputStrings call.
function queriedIds(): string[] {
  return getRecordsByInputStrings.mock.calls.flatMap((c) => c[0] as string[]);
}

const TX_COUNT = 40;
const allTx = makeTransactions(TX_COUNT);

beforeEach(() => {
  getRecordsByInputString.mockReset();
  getRecordsByInputStrings.mockReset();
  bulkGetRecords.mockReset();
  bulkGetRecords.mockResolvedValue([]);
  // Each visible identifier resolves to a record that has metadata.
  getRecordsByInputStrings.mockImplementation(async (ids: string[]) =>
    ids.map((id) => recordWith(id)),
  );
  // Clear any cache entries left over from a previous test.
  for (let i = 0; i < TX_COUNT; i++) invalidateCachedRecord(txid(i));
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

describe("VirtualizedTransactionList scroll-driven preload", () => {
  it("preloads exactly the newly visible rows as the window scrolls", async () => {
    setVisibleRange(0, 4);
    const { rerender } = render(
      <VirtualizedTransactionList
        transactions={allTx}
        expandedTxs={new Set()}
        toggleExpanded={() => {}}
        baseAddressToRecord={new Map()}
      />,
    );

    // Initial window 0-4 -> those five txids get preloaded.
    await waitFor(() => expect(getRecordsByInputStrings).toHaveBeenCalled());
    await flush();
    const initial = new Set(queriedIds());
    for (let i = 0; i <= 4; i++) expect(initial.has(txid(i))).toBe(true);
    // Rows outside the window were not touched.
    expect(initial.has(txid(5))).toBe(false);

    getRecordsByInputStrings.mockClear();

    // Scroll the window forward to rows 5-9.
    setVisibleRange(5, 9);
    rerender(
      <VirtualizedTransactionList
        transactions={allTx}
        expandedTxs={new Set()}
        toggleExpanded={() => {}}
        baseAddressToRecord={new Map()}
      />,
    );
    await flush();

    const afterScroll = queriedIds();
    // The newly visible rows are preloaded.
    for (let i = 5; i <= 9; i++) expect(afterScroll).toContain(txid(i));
    // The hover-only path was never used.
    expect(getRecordsByInputString).not.toHaveBeenCalled();
  });

  it("does not re-fire preloads for rows already warmed (dedup)", async () => {
    setVisibleRange(0, 4);
    const { rerender } = render(
      <VirtualizedTransactionList
        transactions={allTx}
        expandedTxs={new Set()}
        toggleExpanded={() => {}}
        baseAddressToRecord={new Map()}
      />,
    );
    await waitFor(() => expect(getRecordsByInputStrings).toHaveBeenCalled());
    await flush();

    // Move forward to 5-9 (new rows), warming them too.
    setVisibleRange(5, 9);
    rerender(
      <VirtualizedTransactionList
        transactions={allTx}
        expandedTxs={new Set()}
        toggleExpanded={() => {}}
        baseAddressToRecord={new Map()}
      />,
    );
    await flush();

    getRecordsByInputStrings.mockClear();

    // Scroll back over a window (3-7) whose rows are all already warmed.
    setVisibleRange(3, 7);
    rerender(
      <VirtualizedTransactionList
        transactions={allTx}
        expandedTxs={new Set()}
        toggleExpanded={() => {}}
        baseAddressToRecord={new Map()}
      />,
    );
    await flush();

    // Every row in 3-7 was cached on the way out, so no DB query should fire.
    expect(getRecordsByInputStrings).not.toHaveBeenCalled();
  });

  it("only queries the rows not yet warmed when windows partially overlap", async () => {
    setVisibleRange(0, 4);
    const { rerender } = render(
      <VirtualizedTransactionList
        transactions={allTx}
        expandedTxs={new Set()}
        toggleExpanded={() => {}}
        baseAddressToRecord={new Map()}
      />,
    );
    await waitFor(() => expect(getRecordsByInputStrings).toHaveBeenCalled());
    await flush();

    getRecordsByInputStrings.mockClear();

    // Overlapping window 2-6: rows 2-4 are already warmed, only 5-6 are new.
    setVisibleRange(2, 6);
    rerender(
      <VirtualizedTransactionList
        transactions={allTx}
        expandedTxs={new Set()}
        toggleExpanded={() => {}}
        baseAddressToRecord={new Map()}
      />,
    );
    await flush();

    const queried = queriedIds();
    expect(queried).toContain(txid(5));
    expect(queried).toContain(txid(6));
    // The already-warmed overlap is not re-queried.
    expect(queried).not.toContain(txid(2));
    expect(queried).not.toContain(txid(3));
    expect(queried).not.toContain(txid(4));
  });
});

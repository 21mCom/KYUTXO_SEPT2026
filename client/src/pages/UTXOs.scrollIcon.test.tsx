// @vitest-environment jsdom
//
// Scroll-driven NO-HOVER note-icon proof for the UTXOs virtualized list.
//
// Two sibling tests already exist but neither closes this gap:
//   * UTXOs.scrollPreload.test.tsx proves the page INVOKES the preload
//     pipeline for newly-visible rows — but it stubs AddressLink/TxidLink, so
//     it never renders the real orange FileText icon.
//   * UTXOs.metadataIndicator.test.tsx renders the real AddressLink/TxidLink
//     and asserts the icon — but only AFTER a `fireEvent.focus(link)`, i.e. it
//     proves the HOVER path, not the scroll path.
//
// What a user actually relies on is: scroll a previously off-screen row into
// view and its note icon lights up on its own, WITHOUT hovering. This test
// renders the REAL VirtualizedUtxoList with the REAL AddressLink/TxidLink, owns
// the virtual window (jsdom has no layout so a real virtualizer yields no
// rows), scrolls a target row into view, and asserts the real
// `svg.lucide-file-text.text-orange-500` appears — firing NO pointer/focus
// events. It covers BOTH a collapsed address (group) row AND an expanded UTXO
// (txid) row. The only stubbed seam is the IndexedDB query the preload fans out
// to (getRecordsByInputStrings); the metadata-hover cache, the page preload
// effect, and the link components are all real.
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, cleanup, waitFor } from "@testing-library/react";

// --- Controllable virtual window ----------------------------------------
// useVirtualizer is stubbed so the test owns the visible range. The component
// only renders rows for getVirtualItems(), so changing `virtualWindow` + a
// rerender simulates a scroll: rows leave/enter the DOM exactly like the real
// virtualizer would.
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

// Only the IndexedDB query is stubbed; the real metadata-hover cache + preload
// run. getRecordsByInputStrings is the single query batchPreloadIdentifiers
// fans out to — returning a metadata-rich record for each visible identifier so
// hasHoverMetadata() is true and the orange FileText indicator renders.
const { getRecordsByInputStrings } = vi.hoisted(() => ({
  getRecordsByInputStrings: vi.fn(),
}));
vi.mock("@/lib/data/record-crud", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data/record-crud")>()),
  getRecordsByInputStrings: (...args: unknown[]) => getRecordsByInputStrings(...args),
}));

// The scroll-position chip reads a real scroll element; it is peripheral to the
// icon-visibility behavior under test, so stub it out.
vi.mock("@/components/ScrollPositionIndicator", () => ({
  ScrollPositionIndicator: () => null,
}));

import { renderWithProviders } from "@/test/testProviders";
import {
  VirtualizedUtxoList,
  type FlatUtxoRow,
  type AddressGroup,
  type UTXO,
} from "./UTXOs";
import { invalidateCachedRecord } from "@/lib/metadata-hover";
import type { Record as DbRecord } from "@/lib/database";

// Addresses/txids must be unique in their FIRST 8 chars because the link
// testids are `link-address-${addr.slice(0,8)}` / `link-txid-${txid.slice(0,8)}`.
function address(i: number): string {
  return `bc1q${i.toString(16).padStart(4, "0")}${"0".repeat(34)}`;
}
function txid(i: number): string {
  return `${i.toString(16).padStart(8, "0")}${"0".repeat(56)}`;
}

// A record that passes hasHoverMetadata (label is not "Unlabeled"), so the
// orange FileText indicator renders once the preload caches it.
function metaRecord(inputString: string): DbRecord {
  return {
    id: 1,
    type: "address",
    inputString,
    label: "Cold Storage",
    owner: "Treasury",
    notes: "has a note",
    tags: [],
    categories: [],
    addressImportance: "verified",
  } as unknown as DbRecord;
}

function makeUtxo(i: number): UTXO {
  return {
    id: `${txid(i)}:0`,
    txid: txid(i),
    vout: 0,
    address: address(i),
    amountSats: 100000,
    blockTime: 1_700_000_000,
    blockHeight: 800000,
  };
}

function makeGroup(i: number): AddressGroup {
  return {
    address: address(i),
    totalSats: 100000,
    utxos: [makeUtxo(i)],
    earliestDate: 1_700_000_000,
    latestDate: 1_700_000_000,
  };
}

const header = (
  <tr>
    <th>Address</th>
  </tr>
);

const TOTAL = 40;

beforeEach(() => {
  getRecordsByInputStrings.mockReset();
  getRecordsByInputStrings.mockImplementation(async (ids: string[]) =>
    ids.map((id) => metaRecord(id)),
  );
  // Clear any cache entries left over from a previous test so an off-screen row
  // genuinely starts un-warmed.
  for (let i = 0; i < TOTAL; i++) {
    invalidateCachedRecord(address(i));
    invalidateCachedRecord(txid(i));
  }
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderList(rows: FlatUtxoRow[], expanded: Set<string>) {
  return renderWithProviders(
    <VirtualizedUtxoList
      flattenedRows={rows}
      expandedAddresses={expanded}
      displayUnit="btc"
      onToggleGroup={() => {}}
      onOpenUtxo={() => {}}
      scrollRef={{ current: null }}
      header={header}
    />,
  );
}

function rerenderList(
  rerender: (ui: React.ReactElement) => void,
  rows: FlatUtxoRow[],
  expanded: Set<string>,
) {
  rerender(
    <VirtualizedUtxoList
      flattenedRows={rows}
      expandedAddresses={expanded}
      displayUnit="btc"
      onToggleGroup={() => {}}
      onOpenUtxo={() => {}}
      scrollRef={{ current: null }}
      header={header}
    />,
  );
}

describe("VirtualizedUtxoList scroll-driven note icon (no hover)", () => {
  it("lights up a collapsed address row's orange note icon when it scrolls into view", async () => {
    const rows: FlatUtxoRow[] = Array.from({ length: TOTAL }, (_, i) => ({
      kind: "group" as const,
      group: makeGroup(i),
    }));
    const TARGET = 30;
    const targetTestId = `link-address-${address(TARGET).slice(0, 8)}`;

    // Window 0-4: the target group row is far off-screen and not in the DOM.
    setVisibleRange(0, 4);
    const { rerender } = renderList(rows, new Set());
    expect(screen.queryByTestId(targetTestId)).toBeNull();

    // Scroll so rows 28-32 are visible. NO focus/hover/pointer event is fired —
    // the icon must appear purely from the scroll-driven preload.
    setVisibleRange(28, 32);
    rerenderList(rerender, rows, new Set());

    await waitFor(() => {
      const link = screen.getByTestId(targetTestId);
      expect(link.querySelector("svg.lucide-file-text.text-orange-500")).toBeTruthy();
    });
  });

  it("lights up an expanded UTXO (txid) row's orange note icon when it scrolls into view", async () => {
    // Interleave group + expanded utxo rows: group(k) at index 2k, utxo(k) at
    // index 2k+1 — the flattened shape the page produces for an expanded group.
    const expanded = new Set<string>();
    const rows: FlatUtxoRow[] = [];
    for (let k = 0; k < TOTAL / 2; k++) {
      const group = makeGroup(k);
      expanded.add(group.address);
      rows.push({ kind: "group", group });
      rows.push({ kind: "utxo", utxo: group.utxos[0], index: 0 });
    }
    const TARGET = 15; // utxo(15) sits at flattened index 31
    const targetTestId = `link-txid-${txid(TARGET).slice(0, 8)}`;

    // Window 0-4: the target utxo row is off-screen and not in the DOM.
    setVisibleRange(0, 4);
    const { rerender } = renderList(rows, expanded);
    expect(screen.queryByTestId(targetTestId)).toBeNull();

    // Scroll so indices 30-32 are visible (index 31 = utxo(15)). No hover fired.
    setVisibleRange(30, 32);
    rerenderList(rerender, rows, expanded);

    await waitFor(() => {
      const link = screen.getByTestId(targetTestId);
      expect(link.querySelector("svg.lucide-file-text.text-orange-500")).toBeTruthy();
    });
  });
});

/**
 * Fund Trail alternate-view adapter.
 *
 * Maps the real, live multi-hop engine result (MultiHopTrailResult) into the
 * shape the graduated layout variants consume. Pure + read-only — it performs
 * no DB access and no writes (CRUD-guard safe).
 *
 * Key differences from the original mockup `_data.ts`:
 *  - Node `id` is synthesized deterministically (the engine has no per-node id).
 *  - There is NO per-node `cap` and NO `behind` parent pointer. Caps are
 *    hop-level (per depth + direction) and surfaced via `capForHop`. Variants
 *    must not imply a single node/parent is capped or that a deep hop has a
 *    specific known parent.
 */

import type {
  MultiHopTrailResult,
  HopNode,
  MultiHopCapEntry,
  GroupingDimension,
  GroupFlowDetail,
} from "@/lib/data/fund-trail-engine";

export type Dimension = GroupingDimension;
export type Direction = "source" | "dest";
export type SampleDetail = GroupFlowDetail;

/** A live HopNode plus a synthesized, stable id for React keys + selection. */
export interface SampleNode extends HopNode {
  id: string;
}

export interface CenterNode {
  groupLabel: string;
  dimension: Dimension;
  /** sats flowing in across hop-1 sources */
  totalInSats: number;
  /** sats flowing out across hop-1 destinations */
  totalOutSats: number;
}

export interface TimeRange {
  startSec: number;
  endSec: number;
}

export interface FundTrailViewData {
  center: CenterNode;
  sources: SampleNode[];
  destinations: SampleNode[];
  timeRange: TimeRange;
  caps: MultiHopCapEntry[];
  maxSourceDepth: number;
  maxDestDepth: number;
  /** Position 0..1 of a timestamp along the shared time range. */
  timePosition: (blockTime: number) => number;
  /** Representative date for a node = earliest known detail blockTime. */
  nodeDate: (node: SampleNode) => number;
  sourcesAtHop: (depth: number) => SampleNode[];
  destinationsAtHop: (depth: number) => SampleNode[];
  capForHop: (
    depth: number,
    direction: Direction,
  ) => MultiHopCapEntry | undefined;
}

// --- Pure formatting helpers (data-independent) ------------------------------

export const DIMENSION_LABEL: Record<Dimension, string> = {
  walletName: "Wallet",
  owner: "Owner",
  seedName: "Seed",
};

/** sats -> "1.50000000" (8dp). Set `trim` to drop trailing zeros. */
export function formatBtc(sats: number, trim = false): string {
  const btc = sats / 100_000_000;
  const s = btc.toFixed(8);
  return trim ? s.replace(/\.?0+$/, "") : s;
}

/** Middle-truncate any identifier, e.g. shortMiddle(addr, 6, 4) -> "bc1qcb…d6x7". */
export function shortMiddle(value: string, head = 6, tail = 4): string {
  if (!value) return "";
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function shortTxid(txid: string): string {
  return shortMiddle(txid, 4, 3);
}

export function shortAddr(address: string): string {
  return shortMiddle(address, 6, 2);
}

/** Format a Unix-second timestamp, e.g. "Sep 28, 2023". */
export function formatDate(blockTime: number): string {
  if (!blockTime) return "—";
  return new Date(blockTime * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Short date form "Sep 28". */
export function formatDateShort(blockTime: number): string {
  if (!blockTime) return "—";
  return new Date(blockTime * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// --- Adapter -----------------------------------------------------------------

function withIds(nodes: HopNode[], direction: Direction): SampleNode[] {
  const prefix = direction === "source" ? "src" : "dst";
  return nodes.map((n, i) => ({
    ...n,
    id: `${prefix}-h${n.hopDepth}-${i}`,
  }));
}

/** Earliest known (non-zero) detail blockTime; 0 when none are known. */
function earliestDetailTime(node: HopNode): number {
  let min = 0;
  for (const d of node.details) {
    if (!d.blockTime) continue;
    if (min === 0 || d.blockTime < min) min = d.blockTime;
  }
  return min;
}

export function buildFundTrailViewData(
  result: MultiHopTrailResult,
  centerLabel: string,
  dimension: Dimension,
): FundTrailViewData {
  const sources = withIds(result.sources, "source");
  const destinations = withIds(result.destinations, "dest");

  // Totals use only hop-1 nodes (direct flows into/out of the center). Summing
  // across all depths would double-count upstream/downstream chain segments.
  const totalInSats = result.sources
    .filter((n) => n.hopDepth === 1)
    .reduce((s, n) => s + n.totalSats, 0);
  const totalOutSats = result.destinations
    .filter((n) => n.hopDepth === 1)
    .reduce((s, n) => s + n.totalSats, 0);

  // Shared time range across every known detail blockTime.
  let startSec = 0;
  let endSec = 0;
  for (const node of [...sources, ...destinations]) {
    for (const d of node.details) {
      if (!d.blockTime) continue;
      if (startSec === 0 || d.blockTime < startSec) startSec = d.blockTime;
      if (d.blockTime > endSec) endSec = d.blockTime;
    }
  }
  if (startSec === 0) startSec = endSec; // degenerate when no known times
  const timeRange: TimeRange = { startSec, endSec };

  const maxSourceDepth = sources.reduce((m, n) => Math.max(m, n.hopDepth), 0);
  const maxDestDepth = destinations.reduce((m, n) => Math.max(m, n.hopDepth), 0);

  const timePosition = (blockTime: number): number => {
    if (!blockTime) return 0;
    if (timeRange.endSec === timeRange.startSec) return 0;
    return Math.min(
      1,
      Math.max(
        0,
        (blockTime - timeRange.startSec) /
          (timeRange.endSec - timeRange.startSec),
      ),
    );
  };

  const nodeDate = (node: SampleNode): number =>
    earliestDetailTime(node) || timeRange.startSec;

  return {
    center: { groupLabel: centerLabel, dimension, totalInSats, totalOutSats },
    sources,
    destinations,
    timeRange,
    caps: result.caps,
    maxSourceDepth,
    maxDestDepth,
    timePosition,
    nodeDate,
    sourcesAtHop: (depth) => sources.filter((n) => n.hopDepth === depth),
    destinationsAtHop: (depth) =>
      destinations.filter((n) => n.hopDepth === depth),
    capForHop: (depth, direction) =>
      result.caps.find((c) => c.depth === depth && c.direction === direction),
  };
}

export type FundTrailLayout =
  | "classic"
  | "horizontal"
  | "vertical"
  | "breakout"
  | "sankey";

export const FUND_TRAIL_LAYOUT_OPTIONS: {
  value: FundTrailLayout;
  label: string;
}[] = [
  { value: "classic", label: "Classic columns" },
  { value: "horizontal", label: "Horizontal hop timeline" },
  { value: "vertical", label: "Vertical timeline scroll" },
  { value: "breakout", label: "Full-screen breakout" },
  { value: "sankey", label: "Sankey flow" },
];

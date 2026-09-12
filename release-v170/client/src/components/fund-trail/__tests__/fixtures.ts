// Shared multi-hop fixtures for the Fund Trail view-data adapter + layout
// variant tests. Mirrors the real engine's MultiHopTrailResult shape (flat
// HopNode lists keyed by hopDepth + direction, plus per-hop caps) so the pure
// adapter and the presentational variants are exercised against data that looks
// like what computeMultiHopKnown actually returns — without any DB access.

import type {
  MultiHopTrailResult,
  HopNode,
  GroupFlowDetail,
  GroupingDimension,
} from "@/lib/data/fund-trail-engine";

export const FIXTURE_CENTER_LABEL = "Treasury";
export const FIXTURE_DIMENSION: GroupingDimension = "walletName";

// Distinct, increasing block times (Unix seconds) so the shared time range is
// non-degenerate and timePosition spreads nodes across the axis.
const T = {
  h2srcA: 1_700_000_000, // earliest
  h1srcA: 1_700_100_000,
  h1srcB: 1_700_200_000,
  h1dstA: 1_700_300_000,
  h1dstB: 1_700_400_000,
  h2dst: 1_700_500_000,
  h3dst: 1_700_600_000, // latest
};

function detail(
  address: string,
  txid: string,
  amount: number,
  blockTime: number,
): GroupFlowDetail {
  return { address, txid, amount, blockTime };
}

function node(partial: Omit<HopNode, "dimension"> & {
  dimension?: GroupingDimension;
}): HopNode {
  return { dimension: FIXTURE_DIMENSION, ...partial };
}

/**
 * A realistic multi-hop trail: 2 source hops, 3 destination hops, a mix of
 * known + unknown entities, and one capped destination hop. Hop-1 totals are
 * deliberately different from the deeper-hop sats so totals-correctness (hop-1
 * only) is observable.
 */
export function makeMultiHopFixture(): MultiHopTrailResult {
  const sources: HopNode[] = [
    node({
      groupLabel: "Exchange A",
      hopDepth: 1,
      direction: "source",
      totalSats: 150_000_000,
      isUnknown: false,
      details: [
        detail("bc1qsourceaaa0000000000000000000000000", "txsrcA1", 150_000_000, T.h1srcA),
      ],
    }),
    node({
      groupLabel: "Unknown Source",
      hopDepth: 1,
      direction: "source",
      totalSats: 60_000_000,
      isUnknown: true,
      unknownAddresses: ["bc1qsourcebbb0000000000000000000000000"],
      details: [
        detail("bc1qsourcebbb0000000000000000000000000", "txsrcB1", 60_000_000, T.h1srcB),
      ],
    }),
    node({
      groupLabel: "Cold Storage",
      hopDepth: 2,
      direction: "source",
      totalSats: 999_000_000,
      isUnknown: false,
      pathAddresses: ["bc1qsourcebbb0000000000000000000000000"],
      details: [
        detail("bc1qsourceccc0000000000000000000000000", "txsrcA2", 999_000_000, T.h2srcA),
      ],
    }),
  ];

  const destinations: HopNode[] = [
    node({
      groupLabel: "Merchant X",
      hopDepth: 1,
      direction: "dest",
      totalSats: 130_000_000,
      isUnknown: false,
      details: [
        detail("bc1qdestaaa00000000000000000000000000", "txdstA1", 130_000_000, T.h1dstA),
      ],
    }),
    node({
      groupLabel: "Unknown Destination",
      hopDepth: 1,
      direction: "dest",
      totalSats: 120_000_000,
      isUnknown: true,
      unknownAddresses: ["bc1qdestbbb00000000000000000000000000"],
      details: [
        detail("bc1qdestbbb00000000000000000000000000", "txdstB1", 120_000_000, T.h1dstB),
      ],
    }),
    node({
      groupLabel: "Service Y",
      hopDepth: 2,
      direction: "dest",
      totalSats: 60_000_000,
      isUnknown: false,
      pathAddresses: ["bc1qdestbbb00000000000000000000000000"],
      details: [
        detail("bc1qdestccc00000000000000000000000000", "txdst2", 60_000_000, T.h2dst),
      ],
    }),
    node({
      groupLabel: "Service Z",
      hopDepth: 3,
      direction: "dest",
      totalSats: 30_000_000,
      isUnknown: false,
      pathAddresses: ["bc1qdestccc00000000000000000000000000"],
      details: [
        detail("bc1qdestddd00000000000000000000000000", "txdst3", 30_000_000, T.h3dst),
      ],
    }),
  ];

  return {
    sources,
    destinations,
    caps: [
      {
        depth: 1,
        direction: "dest",
        isCapped: true,
        shownTxCount: 500,
        totalTxCount: 1_250,
      },
      {
        depth: 1,
        direction: "source",
        isCapped: false,
        shownTxCount: 2,
        totalTxCount: 2,
      },
    ],
  };
}

/** A trail with no known block times, to exercise the degenerate time range. */
export function makeNoTimeFixture(): MultiHopTrailResult {
  return {
    sources: [
      node({
        groupLabel: "Exchange A",
        hopDepth: 1,
        direction: "source",
        totalSats: 100_000_000,
        isUnknown: false,
        details: [detail("bc1qnotimesrc000000000000000000000000", "txnt1", 100_000_000, 0)],
      }),
    ],
    destinations: [
      node({
        groupLabel: "Merchant X",
        hopDepth: 1,
        direction: "dest",
        totalSats: 40_000_000,
        isUnknown: false,
        details: [detail("bc1qnotimedst000000000000000000000000", "txnt2", 40_000_000, 0)],
      }),
    ],
    caps: [],
  };
}

/** An empty trail, to exercise fully degenerate adapter output. */
export function makeEmptyFixture(): MultiHopTrailResult {
  return { sources: [], destinations: [], caps: [] };
}

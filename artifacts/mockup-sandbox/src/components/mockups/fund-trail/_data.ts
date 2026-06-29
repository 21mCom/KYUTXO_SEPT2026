/**
 * Shared, illustrative Fund Trail sample data for the four layout mockups.
 * Mirrors the real engine types (GroupFlow / HopNode / GroupFlowDetail) so every
 * variant renders the SAME data — this keeps the comparison about LAYOUT, not content.
 *
 * Amounts are in sats (like the engine); show as BTC via formatBtc().
 * blockTime is Unix seconds (like the engine). Dates ordered so the timeline
 * reads correctly: sources older (Sep), destinations newer (Oct).
 *
 * This is a `_`-prefixed module, so it is NOT a preview target.
 */

export type Dimension = "walletName" | "owner" | "seedName";
export type Direction = "source" | "dest";

export interface SampleDetail {
  address: string;
  txid: string;
  /** sats */
  amount: number;
  /** Unix seconds */
  blockTime: number;
  recordId?: number;
}

export interface SampleNode {
  id: string;
  groupLabel: string;
  dimension: Dimension;
  /** 1 = direct counterparty, 2 = one hop further out */
  hopDepth: number;
  direction: Direction;
  /** sats */
  totalSats: number;
  isUnknown: boolean;
  /** Addresses used to expand an unknown bucket (only when isUnknown) */
  unknownAddresses?: string[];
  details: SampleDetail[];
  /** Cap notice for very busy groups: showing `shown` of `total` txns */
  cap?: { shown: number; total: number };
  /** Hop-1 node this hop-2 node sits behind (for visual chaining) */
  behind?: string;
  /** Unknown intermediary addresses traversed to reach a deeper hop */
  pathAddresses?: string[];
}

export interface CenterNode {
  groupLabel: string;
  dimension: Dimension;
  /** sats flowing in across hop-1 sources */
  totalInSats: number;
  /** sats flowing out across hop-1 destinations */
  totalOutSats: number;
}

// --- Dates (Unix seconds, UTC midnight) ---------------------------------------
const SEP_18 = 1694995200;
const SEP_20 = 1695168000;
const SEP_28 = 1695859200;
const SEP_29 = 1695945600;
const SEP_30 = 1696032000;
const OCT_01 = 1696118400;
const OCT_02 = 1696204800;
const OCT_03 = 1696291200;
const OCT_05 = 1696464000;
const OCT_06 = 1696550400;

export const TIME_RANGE = { startSec: SEP_18, endSec: OCT_06 };

export const CENTER: CenterNode = {
  groupLabel: "Alice",
  dimension: "owner",
  totalInSats: 200_500_000, // 2.005 BTC in (hop-1 sources)
  totalOutSats: 195_000_000, // 1.95 BTC out (hop-1 destinations)
};

export const SOURCES: SampleNode[] = [
  {
    id: "src-coinbase",
    groupLabel: "Coinbase Withdrawal",
    dimension: "walletName",
    hopDepth: 1,
    direction: "source",
    totalSats: 150_000_000,
    isUnknown: false,
    details: [
      {
        address: "bc1qcb9w0zr4k8xv2m7n3p5t6q8s9d0f1g2h3j4x7",
        txid: "a91f7c2e8b4d6a0f3e5c9b1d7a8f2c4e6b0d9a1f3c5e7b2d4a6f8c0e2b4d63d2",
        amount: 120_000_000,
        blockTime: SEP_28,
        recordId: 1001,
      },
      {
        address: "bc1qcb9w0zr4k8xv2m7n3p5t6q8s9d0f1g2h3j4x7",
        txid: "a91f55a1c3e7b9d2f4068a1c3e5079b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a23d2",
        amount: 30_000_000,
        blockTime: SEP_28,
        recordId: 1002,
      },
    ],
  },
  {
    id: "src-coldstorage",
    groupLabel: "Cold Storage 1",
    dimension: "seedName",
    hopDepth: 1,
    direction: "source",
    totalSats: 42_000_000,
    isUnknown: false,
    details: [
      {
        address: "bc1qcs7m3n8p2k5v9w0x1z4t6q8r5y7u3a2b4c1k2",
        txid: "7be0a4c8e2069b1d3f5a7c9e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6c14",
        amount: 42_000_000,
        blockTime: SEP_30,
        recordId: 1003,
      },
    ],
  },
  {
    id: "src-unknown",
    groupLabel: "Unknown Source",
    dimension: "walletName",
    hopDepth: 1,
    direction: "source",
    totalSats: 8_500_000,
    isUnknown: true,
    unknownAddresses: [
      "bc1qzz3k7m9p1n5v8w2x4t6q0r3y5u7a9b2c4d609",
      "bc1qzz8w4m2k6n0p3v5x7t9q1r4y6u8a0b3c5d6e1",
      "bc1qzz1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p709",
    ],
    cap: { shown: 2000, total: 5120 },
    details: [
      {
        address: "bc1qzz3k7m9p1n5v8w2x4t6q0r3y5u7a9b2c4d609",
        txid: "3c5e7b2d4a6f8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a6b01",
        amount: 5_000_000,
        blockTime: SEP_29,
      },
      {
        address: "bc1qzz8w4m2k6n0p3v5x7t9q1r4y6u8a0b3c5d6e1",
        txid: "9f1d3b5a7c9e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b02",
        amount: 2_500_000,
        blockTime: SEP_29,
      },
      {
        address: "bc1qzz1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p709",
        txid: "2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b03",
        amount: 1_000_000,
        blockTime: SEP_29,
      },
    ],
  },
  {
    id: "src-kraken",
    groupLabel: "Kraken",
    dimension: "walletName",
    hopDepth: 2,
    direction: "source",
    totalSats: 120_000_000,
    isUnknown: false,
    behind: "Coinbase Withdrawal",
    details: [
      {
        address: "bc1qkr4k8m2n6p0v3w5x7t9q1r3y5u7a9b2c4d6e8",
        txid: "5d7f9b1a3c5e7092b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e7",
        amount: 120_000_000,
        blockTime: SEP_20,
      },
    ],
  },
  {
    id: "src-bob",
    groupLabel: "Bob",
    dimension: "owner",
    hopDepth: 2,
    direction: "source",
    totalSats: 6_000_000,
    isUnknown: false,
    behind: "Unknown Source",
    pathAddresses: [
      "bc1qzz3k7m9p1n5v8w2x4t6q0r3y5u7a9b2c4d609",
      "bc1qzz8w4m2k6n0p3v5x7t9q1r4y6u8a0b3c5d6e1",
    ],
    details: [
      {
        address: "bc1qbob2k6m0n4p8v2w6x0t4q8r2y6u0a4b8c2d6f",
        txid: "8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4f6a8c18",
        amount: 6_000_000,
        blockTime: SEP_18,
      },
    ],
  },
];

export const DESTINATIONS: SampleNode[] = [
  {
    id: "dst-hardware",
    groupLabel: "Hardware Wallet",
    dimension: "walletName",
    hopDepth: 1,
    direction: "dest",
    totalSats: 110_000_000,
    isUnknown: false,
    details: [
      {
        address: "bc1qhw2k8m4n6p0v3w5x7t9q1r3y5u7a9b2c4d6m4",
        txid: "f02a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d09aa",
        amount: 110_000_000,
        blockTime: OCT_02,
        recordId: 2001,
      },
    ],
  },
  {
    id: "dst-merchant",
    groupLabel: "Merchant Pay",
    dimension: "owner",
    hopDepth: 1,
    direction: "dest",
    totalSats: 30_000_000,
    isUnknown: false,
    details: [
      {
        address: "bc1qmp5k9m3n7p1v4w6x8t0q2r4y6u8a0b3c5d6q8",
        txid: "1c77a3c5e7092b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0be1",
        amount: 30_000_000,
        blockTime: OCT_03,
        recordId: 2002,
      },
    ],
  },
  {
    id: "dst-unknown",
    groupLabel: "Unknown Destination",
    dimension: "walletName",
    hopDepth: 1,
    direction: "dest",
    totalSats: 55_000_000,
    isUnknown: true,
    unknownAddresses: [
      "bc1qyy7k1m5n9p3v7w1x5t9q3r7y1u5a9b3c7d641",
      "bc1qyy2a6b0c4d8e2f6g0h4i8j2k6l0m4n8o2p641",
    ],
    details: [
      {
        address: "bc1qyy7k1m5n9p3v7w1x5t9q3r7y1u5a9b3c7d641",
        txid: "6b8d0f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6d41",
        amount: 40_000_000,
        blockTime: OCT_01,
      },
      {
        address: "bc1qyy2a6b0c4d8e2f6g0h4i8j2k6l0m4n8o2p641",
        txid: "4a6c8e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4d42",
        amount: 15_000_000,
        blockTime: OCT_01,
      },
    ],
  },
  {
    id: "dst-mixer",
    groupLabel: "Mixer?",
    dimension: "walletName",
    hopDepth: 2,
    direction: "dest",
    totalSats: 50_000_000,
    isUnknown: false,
    behind: "Unknown Destination",
    pathAddresses: [
      "bc1qyy7k1m5n9p3v7w1x5t9q3r7y1u5a9b3c7d641",
      "bc1qyy2a6b0c4d8e2f6g0h4i8j2k6l0m4n8o2p641",
    ],
    details: [
      {
        address: "bc1qmx3k7m1n5p9v3w7x1t5q9r3y7u1a5b9c3d6f0",
        txid: "0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0e05",
        amount: 50_000_000,
        blockTime: OCT_05,
      },
    ],
  },
  {
    id: "dst-savings",
    groupLabel: "Savings",
    dimension: "seedName",
    hopDepth: 2,
    direction: "dest",
    totalSats: 25_000_000,
    isUnknown: false,
    behind: "Merchant Pay",
    details: [
      {
        address: "bc1qsv5k9m3n7p1v5w9x3t7q1r5y9u3a7b1c5d6f2",
        txid: "2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2e06",
        amount: 25_000_000,
        blockTime: OCT_06,
      },
    ],
  },
];

// --- Helpers ------------------------------------------------------------------

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
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Short txid form like the brief: "a91f…3d2". */
export function shortTxid(txid: string): string {
  return shortMiddle(txid, 4, 3);
}

/** Short address form like the brief: "bc1qcb…x7". */
export function shortAddr(address: string): string {
  return shortMiddle(address, 6, 2);
}

/** Format a Unix-second timestamp, e.g. "Sep 28, 2023". */
export function formatDate(blockTime: number): string {
  return new Date(blockTime * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Short date form "Sep 28". */
export function formatDateShort(blockTime: number): string {
  return new Date(blockTime * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Position 0..1 of a timestamp along the shared time range (for axes/spines). */
export function timePosition(blockTime: number): number {
  const { startSec, endSec } = TIME_RANGE;
  if (endSec === startSec) return 0;
  return Math.min(1, Math.max(0, (blockTime - startSec) / (endSec - startSec)));
}

/** The representative date for a node = earliest detail blockTime. */
export function nodeDate(node: SampleNode): number {
  return node.details.reduce(
    (min, d) => (d.blockTime < min ? d.blockTime : min),
    node.details[0]?.blockTime ?? TIME_RANGE.startSec,
  );
}

export function sourcesAtHop(depth: number): SampleNode[] {
  return SOURCES.filter((n) => n.hopDepth === depth);
}

export function destinationsAtHop(depth: number): SampleNode[] {
  return DESTINATIONS.filter((n) => n.hopDepth === depth);
}

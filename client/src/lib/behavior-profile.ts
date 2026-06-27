/**
 * Address Behavior Profile
 *
 * A deterministic, neutral behavioral description for a Bitcoin address based
 * solely on cached on-chain metrics already stored in IndexedDB. No network
 * access, no AI — every label traces back to observable thresholds below.
 *
 * Rule priority (first match wins):
 *   1. not-enough-data — not synced, or synced but zero transactions
 *   2. dormant        — synced + txs, last activity > DORMANT_YEARS ago
 *   3. high-activity  — txCount >= HIGH_ACTIVITY_TX_THRESHOLD (regardless of recency)
 *   4. accumulator    — positive balance + utxoCount >= MIN_UTXO_ACCUMULATOR +
 *                       high UTXO-to-tx ratio (holds value, rarely spends)
 *   5. distributor    — txCount >= MIN_TX_DISTRIBUTOR + low utxo count +
 *                       near-zero balance (sends out frequently)
 *   6. consolidator   — txCount >= MIN_TX_CONSOLIDATOR + utxoCount <=
 *                       MAX_UTXO_CONSOLIDATOR (merged many inputs into few)
 *   7. fragmented     — utxoCount >= FRAGMENTED_UTXO_THRESHOLD (dust/privacy split)
 *   8. active         — last activity within ACTIVE_MONTHS
 *   9. used           — catch-all: has tx history, no strong pattern
 */

export type BehaviorLabel =
  | 'not-enough-data'
  | 'dormant'
  | 'high-activity'
  | 'accumulator'
  | 'distributor'
  | 'consolidator'
  | 'fragmented'
  | 'active'
  | 'used';

export interface BehaviorProfile {
  label: BehaviorLabel;
  /** Human-readable one-sentence explanation citing the metrics behind it. */
  summarySentence: string;
  /** Short bullet reasons (up to 3) for transparency. */
  reasons: string[];
}

// ── Named thresholds ────────────────────────────────────────────────────────

/** Minimum seconds of inactivity to classify as Dormant (3 years). */
const DORMANT_SECONDS = 3 * 365.25 * 24 * 3600;

/** Minimum tx count to classify as High Activity. */
const HIGH_ACTIVITY_TX_THRESHOLD = 50;

/** Minimum UTXOs to consider Accumulator pattern. */
const MIN_UTXO_ACCUMULATOR = 3;

/** Minimum UTXO-to-tx ratio to classify as Accumulator (≥40 % of txs leave a UTXO). */
const UTXO_TX_RATIO_ACCUMULATOR = 0.4;

/** Minimum tx count to classify as Distributor. */
const MIN_TX_DISTRIBUTOR = 10;

/** Maximum UTXOs allowed for Distributor pattern (address frequently sends out). */
const MAX_UTXO_DISTRIBUTOR = 2;

/** Maximum balance (sats) allowed for Distributor — near-zero balance. */
const MAX_BALANCE_DISTRIBUTOR = 10_000; // 0.0001 BTC

/** Minimum tx count to classify as Consolidator. */
const MIN_TX_CONSOLIDATOR = 5;

/** Maximum UTXOs allowed for Consolidator pattern. */
const MAX_UTXO_CONSOLIDATOR = 2;

/** Minimum UTXOs to classify as Fragmented. */
const FRAGMENTED_UTXO_THRESHOLD = 8;

/** Maximum seconds since last activity to classify as Active (12 months). */
const ACTIVE_SECONDS = 12 * 30.44 * 24 * 3600;

// ── Public interface ────────────────────────────────────────────────────────

export interface BehaviorInput {
  /** Whether stats have been computed from synced tx data. */
  synced: boolean;
  /** Net balance in satoshis (output sats − input sats). */
  balanceSats: number;
  /** Number of unique transactions involving this address. */
  txCount: number;
  /** Current unspent output count. */
  utxoCount: number;
  /** Unix timestamp (seconds) of the most recent transaction, 0 if unknown. */
  lastActivityTime: number;
  /** Current time as Unix timestamp (seconds). Defaults to Date.now()/1000. */
  nowSeconds?: number;
}

/**
 * Classify an address's behavior from its cached on-chain metrics.
 * Pure function — same input always returns the same result.
 */
export function classifyBehavior(input: BehaviorInput): BehaviorProfile {
  const {
    synced,
    balanceSats,
    txCount,
    utxoCount,
    lastActivityTime,
    nowSeconds = Math.floor(Date.now() / 1000),
  } = input;

  // 1. Not enough data
  if (!synced) {
    return {
      label: 'not-enough-data',
      summarySentence: 'This address has not been synced yet — behavior will appear once transaction history is imported.',
      reasons: ['No synced transactions found'],
    };
  }
  if (txCount === 0) {
    return {
      label: 'not-enough-data',
      summarySentence: 'Stats are synced but no transactions have been found for this address yet.',
      reasons: ['Synced with 0 transactions on record'],
    };
  }

  const secondsSinceLast = lastActivityTime > 0 ? nowSeconds - lastActivityTime : Infinity;
  const utxoTxRatio = txCount > 0 ? utxoCount / txCount : 0;

  // 2. Dormant
  if (secondsSinceLast >= DORMANT_SECONDS) {
    const yearsAgo = Math.round(secondsSinceLast / (365.25 * 24 * 3600));
    return {
      label: 'dormant',
      summarySentence: `This address has had no activity for roughly ${yearsAgo} year${yearsAgo !== 1 ? 's' : ''} and appears to be dormant.`,
      reasons: [
        `Last transaction was ~${yearsAgo} year${yearsAgo !== 1 ? 's' : ''} ago`,
        `${txCount} total transaction${txCount !== 1 ? 's' : ''} on record`,
      ],
    };
  }

  // 3. High activity
  if (txCount >= HIGH_ACTIVITY_TX_THRESHOLD) {
    return {
      label: 'high-activity',
      summarySentence: `This address sees heavy use with ${txCount} transactions, suggesting a frequently-used payment or exchange address.`,
      reasons: [
        `${txCount} transactions (threshold: ${HIGH_ACTIVITY_TX_THRESHOLD})`,
        utxoCount > 0 ? `${utxoCount} current UTXO${utxoCount !== 1 ? 's' : ''}` : 'No current UTXOs',
      ],
    };
  }

  // 4. Accumulator
  if (
    balanceSats > 0 &&
    utxoCount >= MIN_UTXO_ACCUMULATOR &&
    utxoTxRatio >= UTXO_TX_RATIO_ACCUMULATOR
  ) {
    return {
      label: 'accumulator',
      summarySentence: `This address consistently holds value — it accumulates bitcoin and rarely spends, with ${utxoCount} current UTXO${utxoCount !== 1 ? 's' : ''} across ${txCount} transaction${txCount !== 1 ? 's' : ''}.`,
      reasons: [
        `${utxoCount} UTXOs / ${txCount} txs = ${(utxoTxRatio * 100).toFixed(0)}% UTXO-to-tx ratio`,
        `Positive balance (${balanceSats.toLocaleString()} sats)`,
        `UTXO-to-tx ratio ≥ ${(UTXO_TX_RATIO_ACCUMULATOR * 100).toFixed(0)}% threshold`,
      ],
    };
  }

  // 5. Distributor
  if (
    txCount >= MIN_TX_DISTRIBUTOR &&
    utxoCount <= MAX_UTXO_DISTRIBUTOR &&
    balanceSats <= MAX_BALANCE_DISTRIBUTOR
  ) {
    return {
      label: 'distributor',
      summarySentence: `This address frequently sends bitcoin outward — it has ${txCount} transactions but holds little or no balance, suggesting a spending or distribution wallet.`,
      reasons: [
        `${txCount} transactions (threshold: ${MIN_TX_DISTRIBUTOR})`,
        `${utxoCount} current UTXO${utxoCount !== 1 ? 's' : ''} (≤ ${MAX_UTXO_DISTRIBUTOR} threshold)`,
        `Balance ≤ ${MAX_BALANCE_DISTRIBUTOR.toLocaleString()} sats`,
      ],
    };
  }

  // 6. Consolidator
  if (txCount >= MIN_TX_CONSOLIDATOR && utxoCount <= MAX_UTXO_CONSOLIDATOR) {
    return {
      label: 'consolidator',
      summarySentence: `This address has merged multiple inputs into a small number of UTXOs — it shows a consolidation pattern with ${txCount} transactions but only ${utxoCount} current UTXO${utxoCount !== 1 ? 's' : ''}.`,
      reasons: [
        `${txCount} transactions (threshold: ${MIN_TX_CONSOLIDATOR})`,
        `${utxoCount} current UTXO${utxoCount !== 1 ? 's' : ''} (≤ ${MAX_UTXO_CONSOLIDATOR} threshold)`,
      ],
    };
  }

  // 7. Fragmented
  if (utxoCount >= FRAGMENTED_UTXO_THRESHOLD) {
    return {
      label: 'fragmented',
      summarySentence: `This address holds ${utxoCount} separate UTXOs, which is a fragmented pattern — often seen after receiving many small payments or after a privacy split.`,
      reasons: [
        `${utxoCount} UTXOs (threshold: ${FRAGMENTED_UTXO_THRESHOLD})`,
        `${txCount} total transaction${txCount !== 1 ? 's' : ''}`,
      ],
    };
  }

  // 8. Active
  if (secondsSinceLast <= ACTIVE_SECONDS) {
    const monthsAgo = Math.round(secondsSinceLast / (30.44 * 24 * 3600));
    return {
      label: 'active',
      summarySentence: `This address has seen recent activity — its last transaction was about ${monthsAgo === 0 ? 'less than a month' : `${monthsAgo} month${monthsAgo !== 1 ? 's' : ''}`} ago.`,
      reasons: [
        `Last transaction ~${monthsAgo === 0 ? '<1 month' : `${monthsAgo} month${monthsAgo !== 1 ? 's' : ''}`} ago`,
        `${txCount} total transaction${txCount !== 1 ? 's' : ''}`,
      ],
    };
  }

  // 9. Used (catch-all)
  return {
    label: 'used',
    summarySentence: `This address has been used with ${txCount} transaction${txCount !== 1 ? 's' : ''} but does not show a strong behavioral pattern.`,
    reasons: [
      `${txCount} transaction${txCount !== 1 ? 's' : ''}`,
      utxoCount > 0 ? `${utxoCount} current UTXO${utxoCount !== 1 ? 's' : ''}` : 'No current UTXOs',
    ],
  };
}

/**
 * Cached on-chain stat fields as stored on an address record. Every field is
 * optional/nullable to tolerate records that predate a given column.
 */
export interface CachedAddressStats {
  statsComputedAt?: number | null;
  cachedBalanceSats?: number | null;
  cachedTxCount?: number | null;
  cachedUtxoCount?: number | null;
  cachedLastActivityTime?: number | null;
}

/**
 * Map an address record's cached stats directly to its behavior label. Thin
 * wrapper over {@link classifyBehavior} so every consumer (the Records filter,
 * the vault-wide tally, etc.) classifies identically — there is a single source
 * of truth for the rules. `synced` is derived from `statsComputedAt`.
 */
export function behaviorLabelFromCachedStats(
  s: CachedAddressStats,
  nowSeconds?: number,
): BehaviorLabel {
  return classifyBehavior({
    synced: s.statsComputedAt != null,
    balanceSats: s.cachedBalanceSats ?? 0,
    txCount: s.cachedTxCount ?? 0,
    utxoCount: s.cachedUtxoCount ?? 0,
    lastActivityTime: s.cachedLastActivityTime ?? 0,
    nowSeconds,
  }).label;
}

/** A count of how many addresses fall into each behavior label. */
export type BehaviorTallyCounts = Record<BehaviorLabel, number>;

/** All behavior labels, used to build a zeroed tally. */
export const ALL_BEHAVIOR_LABELS: BehaviorLabel[] = [
  'not-enough-data',
  'dormant',
  'high-activity',
  'accumulator',
  'distributor',
  'consolidator',
  'fragmented',
  'active',
  'used',
];

/** A fresh tally with every label set to zero. */
export function emptyBehaviorTally(): BehaviorTallyCounts {
  const out = {} as BehaviorTallyCounts;
  for (const label of ALL_BEHAVIOR_LABELS) out[label] = 0;
  return out;
}

/** Display name for each label. */
export const BEHAVIOR_LABEL_DISPLAY: Record<BehaviorLabel, string> = {
  'not-enough-data': 'Not Synced',
  'dormant': 'Dormant',
  'high-activity': 'High Activity',
  'accumulator': 'Accumulator',
  'distributor': 'Distributor',
  'consolidator': 'Consolidator',
  'fragmented': 'Fragmented',
  'active': 'Active',
  'used': 'Used',
};

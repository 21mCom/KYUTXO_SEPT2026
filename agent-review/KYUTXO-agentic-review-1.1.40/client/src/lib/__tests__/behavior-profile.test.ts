import { describe, it, expect } from 'vitest';
import {
  classifyBehavior,
  BEHAVIOR_LABEL_DISPLAY,
  behaviorLabelFromCachedStats,
  emptyBehaviorTally,
  ALL_BEHAVIOR_LABELS,
  type BehaviorInput,
} from '../behavior-profile';

const NOW = 1_700_000_000; // fixed reference time (seconds)

function input(overrides: Partial<BehaviorInput> = {}): BehaviorInput {
  return {
    synced: true,
    balanceSats: 0,
    txCount: 0,
    utxoCount: 0,
    lastActivityTime: 0,
    nowSeconds: NOW,
    ...overrides,
  };
}

describe('classifyBehavior', () => {
  describe('not-enough-data', () => {
    it('returns not-enough-data when not synced', () => {
      const result = classifyBehavior(input({ synced: false, txCount: 5 }));
      expect(result.label).toBe('not-enough-data');
      expect(result.summarySentence).toContain('not been synced');
      expect(result.reasons.length).toBeGreaterThan(0);
    });

    it('returns not-enough-data when both synced=false and txCount=0', () => {
      const result = classifyBehavior(input({ synced: false, txCount: 0 }));
      expect(result.label).toBe('not-enough-data');
    });
  });

  describe('synced-no-activity', () => {
    it('returns synced-no-activity when synced but txCount is 0', () => {
      const result = classifyBehavior(input({ synced: true, txCount: 0 }));
      expect(result.label).toBe('synced-no-activity');
      expect(result.summarySentence).toContain('synced');
      expect(result.reasons.length).toBeGreaterThan(0);
    });

    it('does NOT return synced-no-activity when not synced (uses not-enough-data instead)', () => {
      const result = classifyBehavior(input({ synced: false, txCount: 0 }));
      expect(result.label).toBe('not-enough-data');
    });
  });

  describe('dormant', () => {
    it('returns dormant when last activity > 3 years ago', () => {
      const threeYearsAgo = NOW - 3 * 366 * 24 * 3600;
      const result = classifyBehavior(input({
        synced: true, txCount: 3, lastActivityTime: threeYearsAgo,
      }));
      expect(result.label).toBe('dormant');
      expect(result.summarySentence).toMatch(/dormant/i);
    });

    it('does NOT return dormant when last activity < 3 years ago', () => {
      const oneYearAgo = NOW - 365 * 24 * 3600;
      const result = classifyBehavior(input({
        synced: true, txCount: 3, lastActivityTime: oneYearAgo,
      }));
      expect(result.label).not.toBe('dormant');
    });
  });

  describe('high-activity', () => {
    it('returns high-activity at or above 50 txs', () => {
      const recentTime = NOW - 30 * 24 * 3600;
      const result = classifyBehavior(input({
        synced: true, txCount: 50, lastActivityTime: recentTime,
      }));
      expect(result.label).toBe('high-activity');
      expect(result.summarySentence).toContain('50');
    });

    it('returns high-activity even without recent activity (takes priority over dormant check? No — dormant runs first)', () => {
      // dormant takes priority over high-activity by rule order
      const veryOldTime = NOW - 4 * 366 * 24 * 3600;
      const result = classifyBehavior(input({
        synced: true, txCount: 200, lastActivityTime: veryOldTime,
      }));
      // dormant fires first
      expect(result.label).toBe('dormant');
    });

    it('does NOT return high-activity below 50 txs', () => {
      const recentTime = NOW - 30 * 24 * 3600;
      const result = classifyBehavior(input({
        synced: true, txCount: 49, lastActivityTime: recentTime,
      }));
      expect(result.label).not.toBe('high-activity');
    });
  });

  describe('accumulator', () => {
    it('returns accumulator for positive balance with high UTXO-to-tx ratio', () => {
      const recentTime = NOW - 200 * 24 * 3600;
      const result = classifyBehavior(input({
        synced: true,
        txCount: 10,
        utxoCount: 5,
        balanceSats: 500_000,
        lastActivityTime: recentTime,
      }));
      expect(result.label).toBe('accumulator');
      expect(result.summarySentence).toMatch(/accumulate/i);
    });

    it('does NOT return accumulator when balance is zero', () => {
      const recentTime = NOW - 200 * 24 * 3600;
      const result = classifyBehavior(input({
        synced: true,
        txCount: 10,
        utxoCount: 5,
        balanceSats: 0,
        lastActivityTime: recentTime,
      }));
      expect(result.label).not.toBe('accumulator');
    });

    it('does NOT return accumulator when UTXO-to-tx ratio is too low', () => {
      const recentTime = NOW - 200 * 24 * 3600;
      const result = classifyBehavior(input({
        synced: true,
        txCount: 20,
        utxoCount: 1, // ratio = 0.05, below 0.4 threshold
        balanceSats: 50_000,
        lastActivityTime: recentTime,
      }));
      expect(result.label).not.toBe('accumulator');
    });
  });

  describe('distributor', () => {
    it('returns distributor for many txs, low UTXOs, near-zero balance', () => {
      const recentTime = NOW - 60 * 24 * 3600;
      const result = classifyBehavior(input({
        synced: true,
        txCount: 15,
        utxoCount: 1,
        balanceSats: 5_000, // below 10,000 sats threshold
        lastActivityTime: recentTime,
      }));
      expect(result.label).toBe('distributor');
      expect(result.summarySentence).toMatch(/distribut|spend/i);
    });

    it('does NOT return distributor when txCount is too low', () => {
      const recentTime = NOW - 60 * 24 * 3600;
      const result = classifyBehavior(input({
        synced: true,
        txCount: 5,
        utxoCount: 0,
        balanceSats: 0,
        lastActivityTime: recentTime,
      }));
      expect(result.label).not.toBe('distributor');
    });
  });

  describe('consolidator', () => {
    it('returns consolidator for txCount >= 5 and utxoCount <= 2', () => {
      const recentTime = NOW - 400 * 24 * 3600;
      const result = classifyBehavior(input({
        synced: true,
        txCount: 8,
        utxoCount: 1,
        balanceSats: 200_000,
        lastActivityTime: recentTime,
      }));
      expect(result.label).toBe('consolidator');
      expect(result.summarySentence).toMatch(/consolidat/i);
    });

    it('does NOT return consolidator when utxoCount is too high', () => {
      const recentTime = NOW - 400 * 24 * 3600;
      const result = classifyBehavior(input({
        synced: true,
        txCount: 8,
        utxoCount: 5,
        balanceSats: 200_000,
        lastActivityTime: recentTime,
      }));
      expect(result.label).not.toBe('consolidator');
    });
  });

  describe('fragmented', () => {
    it('returns fragmented when utxoCount >= 8 (balance zero to skip accumulator)', () => {
      // balance = 0 prevents accumulator (requires balance > 0)
      const oldTime = NOW - 500 * 24 * 3600;
      const result = classifyBehavior(input({
        synced: true,
        txCount: 4,
        utxoCount: 10,
        balanceSats: 0,
        lastActivityTime: oldTime,
      }));
      expect(result.label).toBe('fragmented');
      expect(result.summarySentence).toMatch(/fragment/i);
    });

    it('does NOT return fragmented when utxoCount < 8', () => {
      const oldTime = NOW - 500 * 24 * 3600;
      const result = classifyBehavior(input({
        synced: true,
        txCount: 4,
        utxoCount: 7,
        balanceSats: 0,
        lastActivityTime: oldTime,
      }));
      expect(result.label).not.toBe('fragmented');
    });
  });

  describe('active', () => {
    it('returns active when last activity is within 12 months', () => {
      const recentTime = NOW - 180 * 24 * 3600; // 6 months
      const result = classifyBehavior(input({
        synced: true,
        txCount: 3,
        utxoCount: 2,
        balanceSats: 0,
        lastActivityTime: recentTime,
      }));
      expect(result.label).toBe('active');
      expect(result.summarySentence).toMatch(/recent/i);
    });

    it('does NOT return active when last activity is > 12 months ago (and not dormant)', () => {
      const thirteenMonthsAgo = NOW - 400 * 24 * 3600;
      const result = classifyBehavior(input({
        synced: true,
        txCount: 2,
        utxoCount: 1,
        balanceSats: 0,
        lastActivityTime: thirteenMonthsAgo,
      }));
      // Should not be active or dormant (dormant requires >3 years)
      expect(result.label).not.toBe('active');
      expect(result.label).not.toBe('dormant');
    });
  });

  describe('used (catch-all)', () => {
    it('returns used when no strong pattern matches', () => {
      const thirteenMonthsAgo = NOW - 400 * 24 * 3600;
      const result = classifyBehavior(input({
        synced: true,
        txCount: 2,
        utxoCount: 1,
        balanceSats: 0,
        lastActivityTime: thirteenMonthsAgo,
      }));
      expect(result.label).toBe('used');
      expect(result.summarySentence).toContain('2');
    });
  });

  describe('output structure', () => {
    it('always returns a label, summarySentence, and reasons array', () => {
      const profiles = [
        input({ synced: false }),
        input({ synced: true, txCount: 5, lastActivityTime: NOW - 100 }),
        input({ synced: true, txCount: 60, lastActivityTime: NOW - 100 }),
      ];
      for (const p of profiles) {
        const result = classifyBehavior(p);
        expect(typeof result.label).toBe('string');
        expect(typeof result.summarySentence).toBe('string');
        expect(result.summarySentence.length).toBeGreaterThan(0);
        expect(Array.isArray(result.reasons)).toBe(true);
      }
    });

    it('BEHAVIOR_LABEL_DISPLAY covers every possible label', () => {
      const labels = [
        'not-enough-data', 'synced-no-activity', 'dormant', 'high-activity',
        'accumulator', 'distributor', 'consolidator', 'fragmented', 'active', 'used',
      ] as const;
      for (const label of labels) {
        expect(BEHAVIOR_LABEL_DISPLAY[label]).toBeTruthy();
      }
    });
  });

  describe('determinism', () => {
    it('same input always produces same label', () => {
      const params = input({
        synced: true, txCount: 12, utxoCount: 5,
        balanceSats: 300_000, lastActivityTime: NOW - 200 * 24 * 3600,
      });
      const r1 = classifyBehavior(params);
      const r2 = classifyBehavior(params);
      expect(r1.label).toBe(r2.label);
      expect(r1.summarySentence).toBe(r2.summarySentence);
    });
  });
});

describe('behaviorLabelFromCachedStats', () => {
  it('treats a missing statsComputedAt as not-synced', () => {
    expect(
      behaviorLabelFromCachedStats({ cachedTxCount: 5 }, NOW),
    ).toBe('not-enough-data');
  });

  it('matches classifyBehavior for synced cached stats', () => {
    const label = behaviorLabelFromCachedStats(
      { statsComputedAt: 1, cachedTxCount: 80, cachedLastActivityTime: NOW - 1000 },
      NOW,
    );
    expect(label).toBe('high-activity');
    expect(label).toBe(
      classifyBehavior(
        input({ synced: true, txCount: 80, lastActivityTime: NOW - 1000 }),
      ).label,
    );
  });

  it('tolerates null cached fields — synced with all-null counts yields synced-no-activity', () => {
    expect(
      behaviorLabelFromCachedStats(
        {
          statsComputedAt: 1,
          cachedBalanceSats: null,
          cachedTxCount: null,
          cachedUtxoCount: null,
          cachedLastActivityTime: null,
        },
        NOW,
      ),
    ).toBe('synced-no-activity');
  });
});

describe('emptyBehaviorTally', () => {
  it('returns a zero count for every label', () => {
    const tally = emptyBehaviorTally();
    expect(Object.keys(tally).sort()).toEqual([...ALL_BEHAVIOR_LABELS].sort());
    for (const label of ALL_BEHAVIOR_LABELS) {
      expect(tally[label]).toBe(0);
    }
  });
});

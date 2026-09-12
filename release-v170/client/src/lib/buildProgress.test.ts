import { describe, it, expect } from 'vitest';
import {
  computeOverallProgress,
  decideCancelAction,
  DEFAULT_CANCEL_CONFIRM_THRESHOLD,
  type BuildProgressState,
} from './buildProgress';

function progress(step: number, current: number, total: number, totalSteps = 2): BuildProgressState {
  return { step, current, total, totalSteps };
}

describe('DEFAULT_CANCEL_CONFIRM_THRESHOLD', () => {
  it('equals 75', () => {
    expect(DEFAULT_CANCEL_CONFIRM_THRESHOLD).toBe(75);
  });
});

describe('computeOverallProgress', () => {
  describe('returns 0 for inactive/initial states', () => {
    it('step 0 with totalSteps > 0', () => {
      expect(computeOverallProgress(progress(0, 0, 100))).toBe(0);
    });

    it('step 0 even with current > 0', () => {
      expect(computeOverallProgress(progress(0, 50, 100))).toBe(0);
    });

    it('totalSteps is 0', () => {
      expect(computeOverallProgress({ step: 1, current: 50, total: 100, totalSteps: 0 })).toBe(0);
    });

    it('totalSteps is negative', () => {
      expect(computeOverallProgress({ step: 1, current: 50, total: 100, totalSteps: -1 })).toBe(0);
    });

    it('step is negative', () => {
      expect(computeOverallProgress({ step: -1, current: 50, total: 100, totalSteps: 2 })).toBe(0);
    });
  });

  describe('step 1 of 2 (first half: 0%–50%)', () => {
    it('0% at start of step 1 (current=0, total=100)', () => {
      expect(computeOverallProgress(progress(1, 0, 100))).toBe(0);
    });

    it('12.5% at 25% through step 1', () => {
      expect(computeOverallProgress(progress(1, 25, 100))).toBe(12.5);
    });

    it('25% at 50% through step 1', () => {
      expect(computeOverallProgress(progress(1, 50, 100))).toBe(25);
    });

    it('37.5% at 75% through step 1', () => {
      expect(computeOverallProgress(progress(1, 75, 100))).toBe(37.5);
    });

    it('50% at end of step 1', () => {
      expect(computeOverallProgress(progress(1, 100, 100))).toBe(50);
    });
  });

  describe('step 2 of 2 (second half: 50%–100%)', () => {
    it('50% at start of step 2 (current=0, total=100)', () => {
      expect(computeOverallProgress(progress(2, 0, 100))).toBe(50);
    });

    it('62.5% at 25% through step 2', () => {
      expect(computeOverallProgress(progress(2, 25, 100))).toBe(62.5);
    });

    it('75% at 50% through step 2', () => {
      expect(computeOverallProgress(progress(2, 50, 100))).toBe(75);
    });

    it('87.5% at 75% through step 2', () => {
      expect(computeOverallProgress(progress(2, 75, 100))).toBe(87.5);
    });

    it('100% at end of step 2', () => {
      expect(computeOverallProgress(progress(2, 100, 100))).toBe(100);
    });
  });

  describe('edge cases', () => {
    it('total is 0 treats step fraction as 0', () => {
      expect(computeOverallProgress(progress(1, 0, 0))).toBe(0);
      expect(computeOverallProgress(progress(2, 0, 0))).toBe(50);
    });

    it('handles current exceeding total (> 100% within a step)', () => {
      const result = computeOverallProgress(progress(1, 150, 100));
      expect(result).toBe(75);
    });

    it('works with 3 total steps', () => {
      expect(computeOverallProgress(progress(1, 0, 100, 3))).toBeCloseTo(0);
      expect(computeOverallProgress(progress(1, 50, 100, 3))).toBeCloseTo(100 / 6);
      expect(computeOverallProgress(progress(2, 0, 100, 3))).toBeCloseTo(100 / 3);
      expect(computeOverallProgress(progress(3, 50, 100, 3))).toBeCloseTo(500 / 6);
      expect(computeOverallProgress(progress(3, 100, 100, 3))).toBe(100);
    });

    it('works with 1 total step', () => {
      expect(computeOverallProgress(progress(1, 0, 100, 1))).toBe(0);
      expect(computeOverallProgress(progress(1, 50, 100, 1))).toBe(50);
      expect(computeOverallProgress(progress(1, 100, 100, 1))).toBe(100);
    });

    it('handles very large numbers', () => {
      expect(computeOverallProgress(progress(2, 500000, 1000000))).toBe(75);
    });
  });
});

describe('decideCancelAction', () => {
  it('returns noop when there is no abort controller', () => {
    expect(decideCancelAction(false, 50)).toBe('noop');
    expect(decideCancelAction(false, 80)).toBe('noop');
    expect(decideCancelAction(false, 0)).toBe('noop');
  });

  describe('with an active abort controller', () => {
    it('returns abort at 0% progress', () => {
      expect(decideCancelAction(true, 0)).toBe('abort');
    });

    it('returns abort at 50% progress', () => {
      expect(decideCancelAction(true, 50)).toBe('abort');
    });

    it('returns abort just below threshold (74.99%)', () => {
      expect(decideCancelAction(true, 74.99)).toBe('abort');
    });

    it('returns show_confirm at exactly the threshold (75%)', () => {
      expect(decideCancelAction(true, 75)).toBe('show_confirm');
    });

    it('returns show_confirm just above threshold (75.01%)', () => {
      expect(decideCancelAction(true, 75.01)).toBe('show_confirm');
    });

    it('returns show_confirm at 90% progress', () => {
      expect(decideCancelAction(true, 90)).toBe('show_confirm');
    });

    it('returns show_confirm at 100% progress', () => {
      expect(decideCancelAction(true, 100)).toBe('show_confirm');
    });
  });

  describe('threshold boundary with computed progress values', () => {
    it('step 2 at 49/100 is 74.5% → abort', () => {
      const p = computeOverallProgress(progress(2, 49, 100));
      expect(p).toBe(74.5);
      expect(decideCancelAction(true, p)).toBe('abort');
    });

    it('step 2 at 50/100 is exactly 75% → show_confirm', () => {
      const p = computeOverallProgress(progress(2, 50, 100));
      expect(p).toBe(75);
      expect(decideCancelAction(true, p)).toBe('show_confirm');
    });

    it('step 2 at 51/100 is 75.5% → show_confirm', () => {
      const p = computeOverallProgress(progress(2, 51, 100));
      expect(p).toBe(75.5);
      expect(decideCancelAction(true, p)).toBe('show_confirm');
    });

    it('step 1 at any percentage is always below 75% → abort', () => {
      for (const pct of [0, 25, 50, 75, 99, 100]) {
        const p = computeOverallProgress(progress(1, pct, 100));
        expect(p).toBeLessThanOrEqual(50);
        expect(decideCancelAction(true, p)).toBe('abort');
      }
    });

    it('step 0 is always 0% → abort', () => {
      const p = computeOverallProgress(progress(0, 99, 100));
      expect(p).toBe(0);
      expect(decideCancelAction(true, p)).toBe('abort');
    });
  });
});

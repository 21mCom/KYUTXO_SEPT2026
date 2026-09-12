// Regression guard for the date-bearing outputs of the Continuity Certificate /
// Evidence Bundle exports built in lineageEngine.ts. The PDF surfaces (the
// "Generated:" header, the summary origin/activity dates and the per-segment
// "Date" column, all rendered via toLocaleString/toLocaleDateString) are pinned
// separately in lineageEngine.test.ts. This file covers the two remaining
// date-bearing surfaces that nothing else pins:
//   - the machine-readable JSON bundle fields (generatedAt, summary.earliestOrigin,
//     summary.latestActivity and each segment's origin.date), all emitted as a
//     full ISO-8601 timestamp via toISOString(), and
//   - the dated download filename's date stamp, an ISO YYYY-MM-DD (date only)
//     produced by evidenceBundleFilename().
// A locale/format swap, a raw epoch, or (for the filename) a full ISO string with
// the time portion would silently regress these, so each assertion explicitly
// rejects those wrong forms.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CustodySegment } from '../db-types';

const { state } = vi.hoisted(() => ({
  state: {
    segments: [] as CustodySegment[],
  },
}));

vi.mock('../database', () => ({
  db: {
    custodySegments: {
      where: () => ({
        anyOf: () => ({
          toArray: () => Promise.resolve([...state.segments]),
        }),
        above: () => ({
          limit: () => ({
            toArray: () => Promise.resolve([...state.segments]),
          }),
        }),
      }),
    },
    utxoLineage: {
      where: () => ({
        anyOf: () => ({
          toArray: () => Promise.resolve([]),
        }),
      }),
    },
  },
}));

vi.mock('../dataFacade', () => ({
  getParticipantsByTxid: vi.fn(),
  bulkAddUtxoLineage: vi.fn(),
  addCustodySegment: vi.fn(),
}));

import {
  generateEvidenceBundle,
  evidenceBundleFilename,
  type EvidenceBundleOptions,
} from '../lineageEngine';

// 2025-06-15T08:00:00Z — fixed origin date (Unix seconds) so the per-segment
// ISO date is deterministic.
const ORIGIN_SECONDS = Math.floor(Date.UTC(2025, 5, 15, 8, 0, 0) / 1000);

function createMockSegment(index: number): CustodySegment {
  const now = Date.now();
  return {
    id: index + 1,
    segmentId: `seg_test${index}`,
    originTxid: `txid_origin_${index}`,
    originVout: 0,
    originAddress: `addr_origin_${index}`,
    originDate: ORIGIN_SECONDS,
    originAmount: 10000000 * (index + 1),
    currentAmount: 10000000 * (index + 1),
    currentTxid: `txid_current_${index}`,
    currentVout: 0,
    currentAddress: `addr_current_${index}`,
    status: 'active',
    hopCount: index + 1,
    evidenceTxids: [`txid_origin_${index}`, `txid_current_${index}`],
    createdAt: now,
    updatedAt: now,
  };
}

const defaultOptions: EvidenceBundleOptions = {
  includeAddresses: false,
  includeTxids: false,
  includeLineageChain: false,
  redactExternalAddresses: true,
  selectedSegmentIds: ['seg_test0'],
};

const ISO_FULL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

afterEach(() => {
  vi.useRealTimers();
});

describe('Evidence Bundle JSON date formatting', () => {
  beforeEach(() => {
    state.segments.length = 0;
    state.segments.push(createMockSegment(0));
  });

  it('stamps generatedAt as a full ISO timestamp, not a raw epoch or locale form', async () => {
    const fixed = new Date('2026-06-27T15:30:45Z');
    vi.useFakeTimers();
    vi.setSystemTime(fixed);

    const bundle = await generateEvidenceBundle(defaultOptions);

    expect(bundle.generatedAt).toBe(fixed.toISOString());
    expect(bundle.generatedAt).toMatch(ISO_FULL);

    // Reject the regression forms: raw epoch (ms + seconds) and a locale form.
    const fixedMs = fixed.getTime();
    expect(bundle.generatedAt).not.toBe(String(fixedMs));
    expect(bundle.generatedAt).not.toBe(String(Math.floor(fixedMs / 1000)));
    expect(bundle.generatedAt).not.toBe(fixed.toLocaleString());
    expect(bundle.generatedAt).not.toContain('/');
  });

  it('emits the per-segment origin.date as a full ISO timestamp, not a raw epoch or locale form', async () => {
    const bundle = await generateEvidenceBundle(defaultOptions);

    const originDate = bundle.segments[0].origin?.date;
    const expected = new Date(ORIGIN_SECONDS * 1000).toISOString();
    expect(originDate).toBe(expected);
    expect(originDate).toMatch(ISO_FULL);

    // Reject raw epoch (seconds + ms) and the slashed locale date.
    expect(originDate).not.toBe(String(ORIGIN_SECONDS));
    expect(originDate).not.toBe(String(ORIGIN_SECONDS * 1000));
    expect(originDate).not.toContain('/');
    expect(originDate).not.toBe(new Date(ORIGIN_SECONDS * 1000).toLocaleDateString());
  });

  it('emits the summary earliest/latest dates as full ISO timestamps, not raw epochs or locale forms', async () => {
    const bundle = await generateEvidenceBundle(defaultOptions);

    for (const value of [bundle.summary.earliestOrigin, bundle.summary.latestActivity]) {
      expect(value).toMatch(ISO_FULL);
      expect(value).not.toContain('/');
      expect(value).not.toMatch(/^\d+$/); // not a bare epoch
    }
  });
});

describe('Evidence Bundle download filename date stamp', () => {
  it('stamps the filename with an ISO YYYY-MM-DD date, not a raw epoch, time portion, or locale form', () => {
    const fixed = new Date('2026-06-27T15:30:45Z');
    const expectedStamp = '2026-06-27';

    for (const ext of ['json', 'pdf'] as const) {
      const filename = evidenceBundleFilename(ext, { date: fixed });

      expect(filename).toBe(`evidence-bundle-${expectedStamp}.${ext}`);
      expect(filename).toMatch(new RegExp(`^evidence-bundle-\\d{4}-\\d{2}-\\d{2}\\.${ext}$`));

      // Reject the regression forms: raw epoch (ms + seconds), a full ISO string
      // with the time portion, and a slashed locale date.
      const fixedMs = fixed.getTime();
      expect(filename).not.toContain(String(fixedMs));
      expect(filename).not.toContain(String(Math.floor(fixedMs / 1000)));
      expect(filename).not.toContain('T');
      expect(filename).not.toContain(':');
      expect(filename).not.toContain('/');
    }
  });

  it('stamps the partial filename with the same ISO date and a -partial marker', () => {
    const fixed = new Date('2026-06-27T15:30:45Z');

    for (const ext of ['json', 'pdf'] as const) {
      const filename = evidenceBundleFilename(ext, { partial: true, date: fixed });

      expect(filename).toBe(`evidence-bundle-partial-2026-06-27.${ext}`);
      expect(filename).toMatch(
        new RegExp(`^evidence-bundle-partial-\\d{4}-\\d{2}-\\d{2}\\.${ext}$`),
      );
      expect(filename).not.toContain('T');
      expect(filename).not.toContain(':');
    }
  });

  it('defaults to today\'s date when no date is supplied', () => {
    const fixed = new Date('2026-06-27T15:30:45Z');
    vi.useFakeTimers();
    vi.setSystemTime(fixed);

    expect(evidenceBundleFilename('json')).toMatch(/^evidence-bundle-\d{4}-\d{2}-\d{2}\.json$/);
  });
});

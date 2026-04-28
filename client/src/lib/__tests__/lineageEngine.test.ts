import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  type EvidenceBundleOptions,
  type EvidenceBundle,
} from '../lineageEngine';

function createMockSegment(index: number): CustodySegment {
  const now = Date.now();
  return {
    id: index + 1,
    segmentId: `seg_test${index}`,
    originTxid: `txid_origin_${index}`,
    originVout: 0,
    originAddress: `addr_origin_${index}`,
    originDate: Math.floor(now / 1000) - 86400 * (30 - index),
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

async function computeExpectedHash(bundle: EvidenceBundle): Promise<string> {
  const content = JSON.stringify({
    generatedAt: bundle.generatedAt,
    summary: bundle.summary,
    segmentCount: bundle.segments.length,
    segmentIds: bundle.segments.map((s) => s.segmentId).sort(),
  });
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

const SEGMENT_COUNT = 5;

const defaultOptions: EvidenceBundleOptions = {
  includeAddresses: false,
  includeTxids: false,
  includeLineageChain: false,
  redactExternalAddresses: true,
  selectedSegmentIds: Array.from({ length: SEGMENT_COUNT }, (_, i) => `seg_test${i}`),
};

describe('generateEvidenceBundle cancellation', () => {
  beforeEach(() => {
    state.segments.length = 0;
    for (let i = 0; i < SEGMENT_COUNT; i++) {
      state.segments.push(createMockSegment(i));
    }
  });

  it('returns an empty partial bundle when aborted before any segments are processed', async () => {
    const signal = AbortSignal.abort();

    const result = await generateEvidenceBundle(defaultOptions, undefined, signal);

    expect(result.isPartial).toBe(true);
    expect(result.segments).toHaveLength(0);
    expect(result.summary.totalSegments).toBe(0);
    expect(result.summary.totalValueBtc).toBe(0);
    expect(result.requestedSegments).toBe(SEGMENT_COUNT);
    expect(result.version).toBe('1.0');
    expect(result.bundleId).toMatch(/^bundle_[a-f0-9]{12}$/);
    expect(result.integrityHash).toBeUndefined();
  });

  it('returns a partial bundle when aborted mid-way through segment processing', async () => {
    const abortAfter = 2;
    const controller = new AbortController();

    const result = await generateEvidenceBundle(
      defaultOptions,
      (current) => {
        if (current === abortAfter) {
          controller.abort();
        }
      },
      controller.signal,
    );

    expect(result.isPartial).toBe(true);
    expect(result.segments).toHaveLength(abortAfter);
    expect(result.summary.totalSegments).toBe(abortAfter);
    expect(result.requestedSegments).toBe(SEGMENT_COUNT);
    expect(result.segments[0].segmentId).toBe('seg_test0');
    expect(result.segments[1].segmentId).toBe('seg_test1');
  });

  it('computes a valid integrity hash on partial bundles', async () => {
    const abortAfter = 3;
    const controller = new AbortController();

    const result = await generateEvidenceBundle(
      defaultOptions,
      (current) => {
        if (current === abortAfter) {
          controller.abort();
        }
      },
      controller.signal,
    );

    expect(result.isPartial).toBe(true);
    expect(result.integrityHash).toBeDefined();
    expect(result.integrityHash).toMatch(/^[a-f0-9]{64}$/);

    const expectedHash = await computeExpectedHash(result);
    expect(result.integrityHash).toBe(expectedHash);
  });

  it('returns a complete bundle when no abort signal is provided', async () => {
    const progressCalls: Array<[number, number]> = [];

    const result = await generateEvidenceBundle(defaultOptions, (current, total) => {
      progressCalls.push([current, total]);
    });

    expect(result.isPartial).toBeUndefined();
    expect(result.segments).toHaveLength(SEGMENT_COUNT);
    expect(result.summary.totalSegments).toBe(SEGMENT_COUNT);
    expect(result.integrityHash).toBeDefined();
    expect(result.integrityHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.version).toBe('1.0');
    expect(result.bundleId).toMatch(/^bundle_[a-f0-9]{12}$/);
    expect(progressCalls).toHaveLength(SEGMENT_COUNT);
    expect(progressCalls[progressCalls.length - 1][0]).toBe(SEGMENT_COUNT);
    expect(progressCalls[progressCalls.length - 1][1]).toBe(SEGMENT_COUNT);
  });

  it('returns a complete bundle when signal is provided but never aborted', async () => {
    const controller = new AbortController();

    const result = await generateEvidenceBundle(defaultOptions, undefined, controller.signal);

    expect(result.isPartial).toBeUndefined();
    expect(result.segments).toHaveLength(SEGMENT_COUNT);
    expect(result.summary.totalSegments).toBe(SEGMENT_COUNT);
    expect(result.integrityHash).toBeDefined();
  });

  it('aborting after the first segment still produces a partial bundle with one segment', async () => {
    const controller = new AbortController();

    const result = await generateEvidenceBundle(
      defaultOptions,
      (current) => {
        if (current === 1) {
          controller.abort();
        }
      },
      controller.signal,
    );

    expect(result.isPartial).toBe(true);
    expect(result.segments).toHaveLength(1);
    expect(result.summary.totalSegments).toBe(1);
    expect(result.integrityHash).toBeDefined();
    expect(result.segments[0].segmentId).toBe('seg_test0');
  });

  it('partial bundle summary reflects only processed segments value', async () => {
    const abortAfter = 2;
    const controller = new AbortController();

    const result = await generateEvidenceBundle(
      defaultOptions,
      (current) => {
        if (current === abortAfter) {
          controller.abort();
        }
      },
      controller.signal,
    );

    const processedOriginAmounts = state.segments
      .slice(0, abortAfter)
      .reduce((sum, s) => sum + s.originAmount, 0);
    const expectedBtc = processedOriginAmounts / 100000000;

    expect(result.isPartial).toBe(true);
    expect(result.summary.totalValueBtc).toBeCloseTo(expectedBtc, 8);
  });

  it('integrity hash on complete bundle is computed correctly', async () => {
    const result = await generateEvidenceBundle(defaultOptions);

    expect(result.integrityHash).toBeDefined();
    const expectedHash = await computeExpectedHash(result);
    expect(result.integrityHash).toBe(expectedHash);
  });
});

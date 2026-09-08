import { describe, expect, it } from 'vitest';
import { parseOwnerCostBasisReport } from './owner-cost-basis-storage';

const valid = {
  version: 1,
  policyRevision: 'policy',
  batches: [],
  disposals: [],
  warnings: [],
  assumptions: [],
  byOwner: [],
};

describe('parseOwnerCostBasisReport', () => {
  it('accepts a calculator report and rejects every corrupt nested cache section', () => {
    expect(parseOwnerCostBasisReport(JSON.stringify(valid))).toEqual(valid);
    expect(parseOwnerCostBasisReport('{')).toBeNull();
    const malformed = {
      batches: { ...valid, batches: [null] },
      disposals: { ...valid, disposals: [null] },
      allocations: {
        ...valid,
        disposals: [{ txid: 'tx', owner: '', kind: 'external', sats: 1, allocations: [null],
          costProvenance: 'unknown', proceedsProvenance: 'unknown', matchingMethod: 'fifo' }],
      },
      warnings: { ...valid, warnings: [null] },
      assumptions: { ...valid, assumptions: [null] },
      byOwner: { ...valid, byOwner: [null] },
    };
    for (const [section, report] of Object.entries(malformed)) {
      expect(parseOwnerCostBasisReport(JSON.stringify(report)), section).toBeNull();
    }
  });
});

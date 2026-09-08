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
  it('accepts a calculator report and rejects corrupt nested cache rows', () => {
    expect(parseOwnerCostBasisReport(JSON.stringify(valid))).toEqual(valid);
    expect(parseOwnerCostBasisReport('{')).toBeNull();
    expect(parseOwnerCostBasisReport(JSON.stringify({ ...valid, batches: [null] }))).toBeNull();
    expect(parseOwnerCostBasisReport(JSON.stringify({
      ...valid,
      disposals: [{ txid: 'tx', owner: '', kind: 'external', sats: 1, allocations: [null],
        costProvenance: 'unknown', proceedsProvenance: 'unknown', matchingMethod: 'fifo' }],
    }))).toBeNull();
  });
});
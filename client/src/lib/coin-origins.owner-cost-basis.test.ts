import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { calculateOwnerCostBasis } from './owner-cost-basis-core';
import { editorRowsFor } from './coin-origins';

describe('owner cost-basis editor leg identity', () => {
  it('uses the disposal legs rather than Cartesian-expanding transaction participants', () => {
    const report = calculateOwnerCostBasis({
      owners: [
        { id: 1, name: 'Alice', createdAt: 1 },
        { id: 2, name: 'Bob', createdAt: 1 },
        { id: 3, name: 'Carol', createdAt: 1 },
      ],
      residencies: [],
      addresses: [
        { address: 'alice', owner: 'Alice' },
        { address: 'bob', owner: 'Bob' },
        { address: 'carol', owner: 'Carol' },
      ],
      transactions: [
        { txid: 'a', costBasisUsd: 10 },
        { txid: 'b', costBasisUsd: 10 },
        { txid: 'move' },
      ],
      participants: [
        { txid: 'a', role: 'output', address: 'alice', amount: 5, vout: 0 },
        { txid: 'b', role: 'output', address: 'bob', amount: 5, vout: 0 },
        { txid: 'move', role: 'input', address: 'alice', amount: 5, id: 11 },
        { txid: 'move', role: 'input', address: 'bob', amount: 5, id: 12 },
        { txid: 'move', role: 'output', address: 'carol', amount: 10, vout: 0 },
        // An unrelated participant must never become an editor row.
        { txid: 'move', role: 'output', address: 'outside', amount: 1, vout: 1 },
      ],
    });

    expect(editorRowsFor(report)).toEqual([
      expect.objectContaining({
        txid: 'move', legKey: 'output:0', recipientLegKey: 'output:0',
        owner: 'Carol',
      }),
    ]);
    expect(editorRowsFor(report)[0].sourceLegKey).toMatch(/^input:1[12]$/);
    expect(['Alice', 'Bob']).toContain(editorRowsFor(report)[0].sourceOwner);
  });
});
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { calculateOwnerCostBasis } from './owner-cost-basis-core';
import {
  editorRowsFor,
} from './coin-origins';
import { db } from './database';
import { DexieVaultRepository } from './repository/dexie';

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

describe('browser owner-book fingerprints', () => {
  it('changes exact source and policy checkpoints even when row revisions are retained', async () => {
    const repository = new DexieVaultRepository(db);
    const tables = [db.records, db.owners, db.blockchainTransactions, db.transactionParticipants,
      db.transactionMetadata, db.transactionLegMetadata, db.entities, db.addressOwnership,
      db.recordModelMigrationState, db.ownerResidencies];
    try {
      const ownerId = await db.owners.add({ name: 'Alice', createdAt: 1 });
      await db.records.add({ type: 'address', inputString: 'owned', label: '',
        tags: [], categories: [], owner: 'Alice', addressImportance: 'manual' });
      await db.blockchainTransactions.add({ txid: 'buy', blockHeight: 1,
        blockTime: 1_704_067_200, fee: 0, feeRate: 0, syncedAt: 1 });
      await db.transactionParticipants.add({ txid: 'buy', role: 'output',
        address: 'owned', amount: 1, vout: 0 });
      const metadataId = await db.transactionMetadata.add({ txid: 'buy', costBasisUsd: 1, updatedAt: 7 });
      const first = await repository.ownerCostBasisPage({ limit: 1 });
      await db.transactionMetadata.put({ id: metadataId, txid: 'buy', costBasisUsd: 2, updatedAt: 7 });
      const replaced = await repository.ownerCostBasisPage({ limit: 1 });
      expect(replaced.checkpointKey).not.toBe(first.checkpointKey);
      await db.owners.put({ id: ownerId, name: 'Alice', createdAt: 1, defaultMatchingMethod: 'lifo' });
      const policy = await repository.ownerCostBasisPage({ limit: 1 });
      expect(policy.checkpointKey).not.toBe(replaced.checkpointKey);
      await expect(repository.ownerCostBasisPage({
        limit: 1, expectedCheckpointKey: first.checkpointKey,
      })).rejects.toThrow(/changed/i);
    } finally {
      await db.transaction('rw', tables, async () => {
        for (const table of tables) await table.clear();
      });
    }
  });
});

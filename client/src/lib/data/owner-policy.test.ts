import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../database';
import { clearInlineTables, readInlineTables, restoreInlineTables } from '../backup/inline-tables';
import { restoreLegacyVocabulary } from '../backup/legacy-restore-misc';
import { clearAllRecords, createRecord, updateRecord } from './record-crud';
import { addTransaction, bulkAddParticipants, bulkDeleteParticipants, clearParticipants, clearTransactions } from './transaction-crud';
import { UNASSIGNED_OWNER_VALUE } from '../owner-constants';
import {
  createOwnerResidency,
  createPolicyOwner,
  ensureDefaultOwner,
  findResidencyGaps,
  getActiveOwnerSelectorOptions,
  getOwnerPolicySummary,
  getPolicyOwners,
  resolveOwnerPolicy,
  archivePolicyOwner,
  updatePolicyOwner,
  validateResidencyRanges,
} from './owner-policy';

describe('owner residency date policies', () => {
  beforeEach(async () => {
    await db.open();
    await db.ownerResidencies.clear();
    await db.owners.clear();
    await clearAllRecords({ skipNotification: true });
    await clearTransactions({ skipNotification: true });
    await clearParticipants({ skipNotification: true });
  });

  it('treats both ends as inclusive and refuses boundary overlaps', () => {
    expect(() => validateResidencyRanges([
      { startDate: '2024-01-01', endDate: '2024-03-31' },
      { startDate: '2024-03-31', endDate: '2024-12-31' },
    ])).toThrow('Residency dates overlap');
  });

  it('permits and reports a gap between otherwise valid blocks', () => {
    const rows = [
      { startDate: '2024-01-01', endDate: '2024-01-31' },
      { startDate: '2024-02-02', endDate: undefined },
    ];
    expect(findResidencyGaps(rows)).toEqual([{ startDate: '2024-02-01', endDate: '2024-02-01' }]);
  });

  it('refuses an unbounded block followed by any later block', () => {
    expect(() => validateResidencyRanges([
      { startDate: '2024-01-01', endDate: undefined },
      { startDate: '2025-01-01', endDate: undefined },
    ])).toThrow('Residency dates overlap');
  });

  it('creates the default Me owner, permits its rename, and keeps archived owners out of selectors', async () => {
    const me = await ensureDefaultOwner();
    expect(me).toMatchObject({ name: 'Me', kind: 'person' });
    await updatePolicyOwner(me.id!, { name: 'Renamed me' });
    expect((await ensureDefaultOwner()).id).toBe(me.id);
    expect((await getPolicyOwners(true)).filter((owner) => owner.name === 'Me')).toHaveLength(0);
    const companyId = await createPolicyOwner('Vault Co', 'company');
    await db.owners.update(companyId, { archivedAt: 123 });
    const options = await getActiveOwnerSelectorOptions();
    expect(options).toEqual(expect.arrayContaining([
      { value: UNASSIGNED_OWNER_VALUE, label: 'Unassigned' },
      { value: 'Renamed me', label: 'Renamed me', ownerId: me.id },
    ]));
    expect(options.some((option) => option.value === 'Vault Co')).toBe(false);
  });

  it('refuses to archive the default owner whether alone or alongside another owner', async () => {
    const owner = await ensureDefaultOwner();
    await expect(archivePolicyOwner(owner.id!)).rejects.toThrow(
      'The default owner can be renamed but cannot be archived',
    );
    await createPolicyOwner('Second owner');
    await expect(archivePolicyOwner(owner.id!)).rejects.toThrow(
      'The default owner can be renamed but cannot be archived',
    );
    const defaultOwner = await ensureDefaultOwner();
    expect(defaultOwner.id).toBe(owner.id);
    expect(defaultOwner.archivedAt).toBeUndefined();
    const options = await getActiveOwnerSelectorOptions();
    expect(options.map((option) => option.value)).toEqual(
      expect.arrayContaining([UNASSIGNED_OWNER_VALUE, 'Me', 'Second owner']),
    );
  });

  it('resolves inclusive boundaries across multiple blocks and uses FIFO in gaps', async () => {
    const ownerId = await createPolicyOwner('Alice');
    await createOwnerResidency(ownerId, {
      startDate: '2023-01-01', endDate: '2023-06-30', jurisdiction: 'GB', matchingMethod: 'lifo',
    });
    await createOwnerResidency(ownerId, {
      startDate: '2023-07-02', jurisdiction: 'US', matchingMethod: 'hifo',
    });
    await expect(resolveOwnerPolicy(ownerId, '2023-06-30')).resolves.toMatchObject({
      residency: { jurisdiction: 'GB', matchingMethod: 'lifo' }, matchingMethod: 'lifo',
    });
    await expect(resolveOwnerPolicy(ownerId, '2023-07-01')).resolves.toMatchObject({
      residency: null, matchingMethod: 'fifo',
    });
    await expect(resolveOwnerPolicy(ownerId, '2023-07-02')).resolves.toMatchObject({
      residency: { jurisdiction: 'US', matchingMethod: 'hifo' }, matchingMethod: 'hifo',
    });
  });

  it('summarizes live/unassigned batches and outside-residency disposals, then permits archive after reassignment', async () => {
    const ownerId = await createPolicyOwner('Alice');
    const aliceRecordId = await createRecord({ type: 'address', inputString: 'alice-address', label: '', tags: [], categories: [], owner: 'Alice', source: 'manual' }, { skipNotification: true, skipVocabularySync: true });
    await createRecord({ type: 'address', inputString: 'unassigned-address', label: '', tags: [], categories: [], source: 'manual' }, { skipNotification: true, skipVocabularySync: true });
    await addTransaction({ txid: 'receive', blockTime: 1_704_067_200 } as any, { skipNotification: true }); // 2024-01-01
    await addTransaction({ txid: 'dispose', blockTime: 1_735_689_600 } as any, { skipNotification: true }); // 2025-01-01
    const participantIds = await bulkAddParticipants([
      { txid: 'receive', role: 'output', address: 'alice-address', amount: 10_000, vout: 0 },
      { txid: 'receive', role: 'output', address: 'unassigned-address', amount: 2_000, vout: 1 },
      { txid: 'dispose', role: 'input', address: 'alice-address', amount: 10_000, prevTxid: 'receive', prevVout: 0 },
      { txid: 'dispose', role: 'output', address: 'external', amount: 10_000, vout: 0 },
    ] as any, { skipNotification: true });
    const summary = await getOwnerPolicySummary(ownerId);
    expect(summary).toMatchObject({
      currentHoldingsSats: 0,
      unassignedBatchCount: 1,
      unassignedSats: 2_000,
      disposalDatesOutsideResidency: ['2025-01-01'],
    });
    await expect(archivePolicyOwner(ownerId)).resolves.toBeUndefined(); // all Alice batches were disposed

    // A fresh owner with a live batch is refused until that address is reassigned.
    const liveOwner = await createPolicyOwner('Bob');
    await updateRecord(aliceRecordId, { owner: 'Bob' }, { skipNotification: true, skipVocabularySync: true });
    await bulkDeleteParticipants([participantIds[2]], { skipNotification: true });
    await expect(archivePolicyOwner(liveOwner)).rejects.toThrow('open coin-origin batch');
    await updateRecord(aliceRecordId, { owner: undefined }, { skipNotification: true, skipVocabularySync: true });
    await expect(archivePolicyOwner(liveOwner)).resolves.toBeUndefined();
  });

  it('round-trips policy owner fields and residency owner links through inline backup tables', async () => {
    const ownerId = await createPolicyOwner('Archived Company', 'company');
    await db.owners.update(ownerId, { archivedAt: 999 });
    await createOwnerResidency(ownerId, {
      startDate: '2020-01-01', endDate: '2020-12-31', jurisdiction: 'CA',
      region: 'ON', notes: 'Historic', matchingMethod: 'specific-identification',
    });
    const inline = await readInlineTables();
    await clearInlineTables();
    await restoreInlineTables(inline, 'replace');
    const owner = await db.owners.where('name').equals('Archived Company').first();
    expect(owner).toMatchObject({ kind: 'company', archivedAt: 999 });
    const residencies = await db.ownerResidencies.where('ownerId').equals(owner!.id!).toArray();
    expect(residencies).toHaveLength(1);
    expect(residencies[0]).toMatchObject({
      ownerId: owner!.id, startDate: '2020-01-01', endDate: '2020-12-31',
      jurisdiction: 'CA', region: 'ON', notes: 'Historic', matchingMethod: 'specific-identification',
    });
  });

  it('rejects malformed and overlapping residency backup histories before policy rows are restored', async () => {
    const conflicting = {
      owners: [{ id: 9, name: 'Imported', createdAt: 1 }],
      ownerResidencies: [
        { ownerId: 9, startDate: '2024-01-01', endDate: '2024-03-31', jurisdiction: 'US', matchingMethod: 'fifo' },
        { ownerId: 9, startDate: '2024-03-31', jurisdiction: 'CA', matchingMethod: 'lifo' },
      ],
    };
    await expect(restoreInlineTables(conflicting, 'replace')).rejects.toThrow('Residency dates overlap');
    expect(await db.owners.count()).toBe(0);
    await expect(restoreLegacyVocabulary({
      ...conflicting,
      ownerResidencies: [{ ownerId: 9, startDate: 'not-a-date', jurisdiction: 'US', matchingMethod: 'bad' }],
    }, 'replace')).rejects.toThrow('Invalid owner residency');
    expect(await db.owners.count()).toBe(0);
  });

  it('preflights v3 and legacy merge histories against live residency rows without partial owner writes', async () => {
    const liveId = await createPolicyOwner('Live');
    await createOwnerResidency(liveId, { startDate: '2024-01-01', jurisdiction: 'US', matchingMethod: 'fifo' });
    const collision = {
      owners: [{ id: 7, name: 'Live', isDefault: true, createdAt: 1 }, { id: 8, name: 'Would be partial', createdAt: 2 }],
      ownerResidencies: [{ ownerId: 7, startDate: '2024-02-01', jurisdiction: 'CA', matchingMethod: 'lifo' }],
    };
    await expect(restoreInlineTables(collision, 'merge')).rejects.toThrow('Residency dates overlap');
    expect(await db.owners.where('name').equals('Would be partial').count()).toBe(0);
    expect(await db.ownerResidencies.where('ownerId').equals(liveId).count()).toBe(1);
    await expect(restoreLegacyVocabulary(collision, 'merge')).rejects.toThrow('Residency dates overlap');
    expect(await db.owners.where('name').equals('Would be partial').count()).toBe(0);
    expect(await db.ownerResidencies.where('ownerId').equals(liveId).count()).toBe(1);
  });
});
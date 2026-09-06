// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/database';
import { clearAllRecords, createRecord, getRecord } from '@/lib/data/record-crud';
import { clearSettings } from '@/lib/data/settings-crud';
import {
  applyCategoryMappingDecision, applyCategoryMappingDraft, getCategoryMappingCheckpoints, getCategoryMappingItems,
  getCategoryMappingDraft, saveCategoryMappingDraft,
} from './category-mapping-crud';

const record = (inputString: string, type: 'address' | 'transaction', categories: string[]) =>
  createRecord({ type, inputString, label: '', notes: '', tags: [], categories } as any);

describe('category mapping CRUD', () => {
  beforeEach(async () => {
    await clearAllRecords();
    await db.categories.clear();
    await db.tags.clear();
    await clearSettings();
  });

  it('includes orphaned and vocabulary categories with accurate counts', async () => {
    await db.categories.add({ name: 'Empty', createdAt: Date.now() });
    await record('bc1qcategorymap00000000000000000000000000000001', 'address', ['Legacy']);
    await record('bc1qcategorymap00000000000000000000000000000002', 'address', ['Legacy']);
    expect(await getCategoryMappingItems()).toEqual([
      expect.objectContaining({ name: 'Empty', usageCount: 0 }),
      expect.objectContaining({ name: 'Legacy', usageCount: 2 }),
    ]);
  });

  it('maps a category to a canonical tag and removes it from every record', async () => {
    await db.tags.add({ name: 'Cold storage', createdAt: Date.now() });
    const id = await record('bc1qcategorymap00000000000000000000000000000003', 'address', ['Savings']);
    await applyCategoryMappingDecision('Savings', { kind: 'tag', tagName: 'cold storage' });
    const updated = await getRecord(id);
    expect(updated?.categories).toEqual([]);
    expect(updated?.tags).toEqual(['Cold storage']);
  });

  it('groups and applies every case variant without deleting vocabulary early', async () => {
    await db.categories.bulkAdd([
      { name: 'Savings', createdAt: Date.now() },
      { name: 'SAVINGS', createdAt: Date.now() },
    ]);
    const one = await record('bc1qcategorymap00000000000000000000000000000005', 'address', ['Savings']);
    const two = await record('bc1qcategorymap00000000000000000000000000000006', 'address', ['SAVINGS']);
    expect((await getCategoryMappingItems()).filter((item) => item.name.toLowerCase() === 'savings'))
      .toEqual([expect.objectContaining({ usageCount: 2 })]);
    await applyCategoryMappingDecision('savings', { kind: 'drop' });
    expect((await getRecord(one))?.categories).toEqual([]);
    expect((await getRecord(two))?.categories).toEqual([]);
    expect((await db.categories.toArray()).filter((item) => item.name.toLowerCase() === 'savings')).toEqual([]);
  });

  it('retains a skipped draft and allows it to be replaced before apply', async () => {
    await saveCategoryMappingDraft({ Old: { kind: 'skip' } });
    expect(await getCategoryMappingDraft()).toEqual({ Old: { kind: 'skip' } });
    await saveCategoryMappingDraft({ Old: { kind: 'drop' } });
    expect(await getCategoryMappingDraft()).toEqual({ Old: { kind: 'drop' } });
  });

  it('only classifies record types on which the selected classification is representable', async () => {
    const addressId = await record('bc1qcategorymap00000000000000000000000000000004', 'address', ['Legacy']);
    const transactionId = await record('category-map-transaction', 'transaction', ['Legacy']);
    await applyCategoryMappingDecision('Legacy', { kind: 'classification', classification: 'flowType:received' });
    expect((await getRecord(transactionId))?.flowType).toBe('received');
    expect((await getRecord(transactionId))?.categories).toEqual([]);
    expect((await getRecord(addressId))?.categories).toEqual(['Legacy']);
  });

  it('checkpoints completed decisions when a later decision fails and resumes without replaying', async () => {
    const id = await record('bc1qcategorymap00000000000000000000000000000007', 'address', ['First']);
    await expect(applyCategoryMappingDraft({
      First: { kind: 'drop' },
      Broken: { kind: 'tag', tagName: ' ' },
    })).rejects.toThrow('Choose a tag');
    expect((await getCategoryMappingCheckpoints()).first?.status).toBe('applied');
    expect((await getRecord(id))?.categories).toEqual([]);
    await applyCategoryMappingDraft({
      First: { kind: 'drop' },
      Broken: { kind: 'drop' },
    });
    expect((await getCategoryMappingCheckpoints()).broken?.status).toBe('applied');
  });

  it('rejects crafted classification field names before any record can be mutated', async () => {
    const id = await record('bc1qcategorymap00000000000000000000000000000008', 'transaction', ['Unsafe']);
    await expect(applyCategoryMappingDecision('Unsafe', {
      kind: 'classification',
      classification: 'inputString:evil',
    } as any)).rejects.toThrow('Unsupported category classification');
    await expect(applyCategoryMappingDecision('Unsafe', {
      kind: 'classification',
      classification: 'arbitraryField:evil',
    } as any)).rejects.toThrow('Unsupported category classification');
    expect(await getRecord(id)).toMatchObject({
      inputString: 'bc1qcategorymap00000000000000000000000000000008',
      categories: ['Unsafe'],
    });
  });
});
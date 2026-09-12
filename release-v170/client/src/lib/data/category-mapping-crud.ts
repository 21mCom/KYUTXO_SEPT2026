import { db, isCategoryMappingClassification, type Record } from '../database';
import type {
  CategoryMappingCheckpoint,
  CategoryMappingClassification,
  CategoryMappingDraftDecision,
} from '../db-types';
import {
  bulkUpdateRecords,
  getRecordCategoryKeys,
  getRecordsByCategoryCaseInsensitive,
} from './record-crud';
import { createCategory, deleteCategory, ensureSelectableVocabularyEntry } from './vocabulary-crud';
import { ensureSettings, mutateSettings } from './settings-crud';

const categoryKey = (name: string) => name.trim().toLocaleLowerCase();

export interface CategoryMappingItem {
  name: string;
  categoryId?: number;
  usageCount: number;
}

export async function getCategoryMappingItems(): Promise<CategoryMappingItem[]> {
  const [categories, keys] = await Promise.all([
    db.categories.toArray(),
    getRecordCategoryKeys(),
  ]);
  const byName = new Map<string, CategoryMappingItem>();
  for (const category of categories) {
    byName.set(categoryKey(category.name), {
      name: category.name, categoryId: category.id, usageCount: 0,
    });
  }
  for (const key of keys) {
    if (typeof key !== 'string' || !key.trim()) continue;
    const normalized = categoryKey(key);
    const existing = byName.get(normalized);
    if (!existing) byName.set(normalized, { name: key, usageCount: 0 });
  }
  const items = [...byName.values()];
  await Promise.all(items.map(async (item) => {
    item.usageCount = (await recordsForCategory(item.name)).length;
  }));
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getCategoryMappingDraft(): Promise<{ [category: string]: CategoryMappingDraftDecision }> {
  return (await ensureSettings()).categoryMappingDraft ?? {};
}

export async function saveCategoryMappingDraft(
  draft: { [category: string]: CategoryMappingDraftDecision },
): Promise<void> {
  await ensureSettings();
  await mutateSettings('default', () => ({ categoryMappingDraft: draft }));
}

function withoutCategory(record: Record, category: string): string[] {
  const key = categoryKey(category);
  return record.categories.filter((value) => categoryKey(value) !== key);
}

async function recordsForCategory(category: string): Promise<Record[]> {
  const key = categoryKey(category);
  return getRecordsByCategoryCaseInsensitive(key);
}

async function removeCategoryVocabulary(category: string): Promise<void> {
  // deleteCategory removes exact record values, so it is only safe after no
  // case-insensitive variant remains anywhere in records.
  if ((await recordsForCategory(category)).length > 0) return;
  const key = categoryKey(category);
  const variants = (await db.categories.toArray())
    .filter((entry) => categoryKey(entry.name) === key);
  for (const entry of variants) {
    if (entry.id != null) await deleteCategory(entry.id);
  }
}

export async function getCategoryMappingCheckpoints(): Promise<{ [category: string]: CategoryMappingCheckpoint }> {
  return (await ensureSettings()).categoryMappingCheckpoints ?? {};
}

export async function checkpointCategoryMappingDecision(
  category: string,
  status: CategoryMappingCheckpoint['status'],
): Promise<void> {
  await ensureSettings();
  await mutateSettings('default', (current) => ({
    categoryMappingCheckpoints: {
      ...(current.categoryMappingCheckpoints ?? {}),
      [categoryKey(category)]: { status, appliedAt: Date.now() },
    },
  }));
}

export async function clearCategoryMappingCheckpoint(category: string): Promise<void> {
  await ensureSettings();
  await mutateSettings('default', (current) => {
    const checkpoints = { ...(current.categoryMappingCheckpoints ?? {}) };
    delete checkpoints[categoryKey(category)];
    return { categoryMappingCheckpoints: checkpoints };
  });
}

/** Applies a draft one decision at a time with a durable checkpoint after each
 * successful write. If a later decision fails, callers can safely call this
 * again: checkpointed decisions are skipped rather than replayed. */
export async function applyCategoryMappingDraft(
  draft: { [category: string]: CategoryMappingDraftDecision },
): Promise<string[]> {
  const checkpoints = await getCategoryMappingCheckpoints();
  const completed: string[] = [];
  for (const [category, decision] of Object.entries(draft)) {
    if (decision.kind === 'skip' || checkpoints[categoryKey(category)]) continue;
    await applyCategoryMappingDecision(category, decision);
    const remains = (await getCategoryMappingItems())
      .some((item) => categoryKey(item.name) === categoryKey(category));
    await checkpointCategoryMappingDecision(category, remains ? 'partially-applied' : 'applied');
    if (!remains) completed.push(category);
  }
  return completed;
}

async function applyClassification(
  records: Record[],
  category: string,
  classification: CategoryMappingClassification,
): Promise<void> {
  if (!isCategoryMappingClassification(classification)) {
    throw new Error('Unsupported category classification');
  }
  const [field, value] = classification.split(':') as [string, string];
  const updates = records
    .filter((record) =>
      (field === 'counterpartyType' && record.type === 'address') ||
      (field !== 'counterpartyType' && record.type === 'transaction'))
    .map((record) => ({
      id: record.id!,
      changes: {
        categories: withoutCategory(record, category),
        [field]: value,
      } as Partial<Record>,
    }));
  // A classification cannot be represented on the other record type. Keep its
  // category there rather than silently losing information.
  await bulkUpdateRecords(updates);
}

/** Apply one explicit retirement decision.  This is the only write path used by
 * the Settings workflow, so vocabulary and record changes stay CRUD-mediated. */
export async function applyCategoryMappingDecision(
  category: string,
  decision: Exclude<CategoryMappingDraftDecision, { kind: 'skip' }>,
): Promise<void> {
  if (decision.kind === 'classification' && !isCategoryMappingClassification(decision.classification)) {
    throw new Error('Unsupported category classification');
  }
  const records = await recordsForCategory(category);
  if (decision.kind === 'tag') {
    const tagName = decision.tagName.trim();
    if (!tagName) throw new Error('Choose a tag');
    const canonicalTagName = await ensureSelectableVocabularyEntry('tag', tagName);
    await bulkUpdateRecords(records.map((record) => ({
      id: record.id!,
      changes: {
        categories: withoutCategory(record, category),
        tags: [...new Set([...record.tags, canonicalTagName])],
      },
    })));
    await removeCategoryVocabulary(category);
    return;
  }
  if (decision.kind === 'rename') {
    const target = decision.categoryName.trim();
    if (!target) throw new Error('Enter a category name');
    if (categoryKey(target) === categoryKey(category)) return;
    const existing = await db.categories.where('name').equalsIgnoreCase(target).first();
    if (!existing) await createCategory(target);
    await bulkUpdateRecords(records.map((record) => ({
      id: record.id!,
      changes: { categories: [...new Set(record.categories.map((value) =>
        categoryKey(value) === categoryKey(category) ? target : value))] },
    })));
    await removeCategoryVocabulary(category);
    return;
  }
  if (decision.kind === 'drop') {
    await bulkUpdateRecords(records.map((record) => ({
      id: record.id!, changes: { categories: withoutCategory(record, category) },
    })));
    await removeCategoryVocabulary(category);
    return;
  }
  await applyClassification(records, category, decision.classification);
  // Only remove the vocabulary value when no unrepresentable records remain.
  if ((await recordsForCategory(category)).length === 0) {
    await removeCategoryVocabulary(category);
  }
}
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Category } from '@/lib/database';
import { bulkUpdateRecords } from '@/lib/dataFacade';

export function useCategories() {
  const categories = useLiveQuery(() => db.categories.orderBy('name').toArray());

  return {
    categories: categories ?? [],
    isLoading: categories === undefined,
  };
}

export async function createCategory(name: string) {
  const existing = await db.categories.where('name').equals(name).first();
  if (existing) {
    throw new Error('Category already exists');
  }

  const id = await db.categories.add({
    name,
    createdAt: Date.now(),
  });
  return id;
}

export async function updateCategory(id: number, data: Partial<Category>) {
  await db.categories.update(id, data);
}

export async function deleteCategory(id: number) {
  const category = await db.categories.get(id);
  if (!category) return;

  const records = await db.records.filter(r => r.categories.includes(category.name)).toArray();
  if (records.length > 0) {
    await bulkUpdateRecords(
      records.map(record => ({
        id: record.id!,
        changes: { categories: record.categories.filter(c => c !== category.name) },
      }))
    );
  }

  await db.categories.delete(id);
}

export async function getCategoryUsageCount(categoryName: string): Promise<number> {
  return db.records.filter(r => r.categories.includes(categoryName)).count();
}

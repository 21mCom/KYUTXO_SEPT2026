import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Category } from '@/lib/database';

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
  for (const record of records) {
    await db.records.update(record.id!, {
      categories: record.categories.filter(c => c !== category.name),
      updatedAt: Date.now(),
    });
  }

  await db.categories.delete(id);
}

export async function getCategoryUsageCount(categoryName: string): Promise<number> {
  return db.records.filter(r => r.categories.includes(categoryName)).count();
}

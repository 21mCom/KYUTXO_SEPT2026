import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/database';

export { createCategory, updateCategory, deleteCategory, getCategoryUsageCount } from '@/lib/data/vocabulary-crud';

export function useCategories() {
  const categories = useLiveQuery(() => db.categories.orderBy('name').toArray());

  return {
    categories: categories ?? [],
    isLoading: categories === undefined,
  };
}

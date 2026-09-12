import { useEffect, useState } from 'react';
import { useDbChangeSignal } from './use-db-change-signal';
import { getCategories } from '@/lib/data/vocabulary-crud';

export { createCategory, updateCategory, deleteCategory, getCategoryUsageCount } from '@/lib/data/vocabulary-crud';

export function useCategories() {
  const [categories, setCategories] = useState<Awaited<ReturnType<typeof getCategories>>>();
  const signal = useDbChangeSignal(['categories']);
  useEffect(() => { void getCategories().then((rows) => setCategories(rows.sort((a, b) => a.name.localeCompare(b.name)))); }, [signal]);

  return {
    categories: categories ?? [],
    isLoading: categories === undefined,
  };
}

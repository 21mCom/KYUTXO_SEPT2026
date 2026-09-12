import { useEffect, useState } from 'react';
import { useDbChangeSignal } from './use-db-change-signal';
import { getCategories } from '@/lib/data/vocabulary-crud';

export { createCategory, updateCategory, deleteCategory, getCategoryUsageCount } from '@/lib/data/vocabulary-crud';

export function useCategories() {
  const [categories, setCategories] = useState<Awaited<ReturnType<typeof getCategories>>>();
  const signal = useDbChangeSignal(['categories']);
  useEffect(() => {
    let cancelled = false;
    void getCategories().then((rows) => {
      if (!cancelled) setCategories(rows.sort((a, b) => a.name.localeCompare(b.name)));
    });
    return () => { cancelled = true; };
  }, [signal]);

  return {
    categories: categories ?? [],
    isLoading: categories === undefined,
  };
}

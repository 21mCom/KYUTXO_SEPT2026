import { useEffect, useState } from 'react';
import { useDbChangeSignal } from './use-db-change-signal';
import { getTags } from '@/lib/data/vocabulary-crud';

export { createTag, updateTag, deleteTag, getTagUsageCount } from '@/lib/data/vocabulary-crud';

export function useTags() {
  const [tags, setTags] = useState<Awaited<ReturnType<typeof getTags>>>();
  const signal = useDbChangeSignal(['tags']);
  useEffect(() => {
    let cancelled = false;
    void getTags().then((rows) => {
      if (!cancelled) setTags(rows.sort((a, b) => a.name.localeCompare(b.name)));
    });
    return () => { cancelled = true; };
  }, [signal]);

  return {
    tags: tags ?? [],
    isLoading: tags === undefined,
  };
}

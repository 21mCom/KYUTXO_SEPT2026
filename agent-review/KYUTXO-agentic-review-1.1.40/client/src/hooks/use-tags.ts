import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/database';

export { createTag, updateTag, deleteTag, getTagUsageCount } from '@/lib/data/vocabulary-crud';

export function useTags() {
  const tags = useLiveQuery(() => db.tags.orderBy('name').toArray());

  return {
    tags: tags ?? [],
    isLoading: tags === undefined,
  };
}

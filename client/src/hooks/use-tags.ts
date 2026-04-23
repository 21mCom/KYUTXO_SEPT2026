import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Tag } from '@/lib/database';

export function useTags() {
  const tags = useLiveQuery(() => db.tags.orderBy('name').toArray());

  return {
    tags: tags ?? [],
    isLoading: tags === undefined,
  };
}

export async function createTag(name: string, color?: string) {
  const existing = await db.tags.where('name').equals(name).first();
  if (existing) {
    throw new Error('Tag already exists');
  }

  const id = await db.tags.add({
    name,
    color,
    createdAt: Date.now(),
  });
  return id;
}

export async function updateTag(id: number, data: Partial<Tag>) {
  await db.tags.update(id, data);
}

export async function deleteTag(id: number) {
  const tag = await db.tags.get(id);
  if (!tag) return;

  const records = await db.records.filter(r => r.tags.includes(tag.name)).toArray();
  for (const record of records) {
    await db.records.update(record.id!, {
      tags: record.tags.filter(t => t !== tag.name),
      updatedAt: Date.now(),
    });
  }

  await db.tags.delete(id);
}

export async function getTagUsageCount(tagName: string): Promise<number> {
  return db.records.filter(r => r.tags.includes(tagName)).count();
}

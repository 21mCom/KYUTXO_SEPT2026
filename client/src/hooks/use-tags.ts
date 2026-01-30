import { useLiveQuery } from 'dexie-react-hooks';
import { useState, useEffect } from 'react';
import { db, type Tag } from '@/lib/database';
import { 
  getDecryptedTags,
  isEncryptionReady,
} from '@/lib/encryptionFacade';

export function useTags() {
  const [decryptedTags, setDecryptedTags] = useState<Tag[]>([]);
  const [isDecrypting, setIsDecrypting] = useState(false);
  
  const rawTags = useLiveQuery(() => db.tags.orderBy('name').toArray());
  
  useEffect(() => {
    const decrypt = async () => {
      if (!rawTags) {
        setDecryptedTags([]);
        return;
      }
      
      if (!isEncryptionReady()) {
        setDecryptedTags(rawTags);
        return;
      }
      
      setIsDecrypting(true);
      try {
        const decrypted = await getDecryptedTags();
        decrypted.sort((a, b) => a.name.localeCompare(b.name));
        setDecryptedTags(decrypted);
      } catch (error) {
        console.error('Failed to decrypt tags:', error);
        setDecryptedTags(rawTags);
      } finally {
        setIsDecrypting(false);
      }
    };
    
    decrypt();
  }, [rawTags]);
  
  return {
    tags: decryptedTags,
    isLoading: rawTags === undefined || isDecrypting,
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
  
  // Remove tag from all records
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

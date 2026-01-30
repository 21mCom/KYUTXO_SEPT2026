import { useLiveQuery } from 'dexie-react-hooks';
import { useState, useEffect } from 'react';
import { db, type Category } from '@/lib/database';
import { 
  getDecryptedCategories,
  isEncryptionReady,
} from '@/lib/encryptionFacade';

export function useCategories() {
  const [decryptedCategories, setDecryptedCategories] = useState<Category[]>([]);
  const [isDecrypting, setIsDecrypting] = useState(false);
  
  const rawCategories = useLiveQuery(() => db.categories.orderBy('name').toArray());
  
  useEffect(() => {
    const decrypt = async () => {
      if (!rawCategories) {
        setDecryptedCategories([]);
        return;
      }
      
      if (!isEncryptionReady()) {
        setDecryptedCategories(rawCategories);
        return;
      }
      
      setIsDecrypting(true);
      try {
        const decrypted = await getDecryptedCategories();
        decrypted.sort((a, b) => a.name.localeCompare(b.name));
        setDecryptedCategories(decrypted);
      } catch (error) {
        console.error('Failed to decrypt categories:', error);
        setDecryptedCategories(rawCategories);
      } finally {
        setIsDecrypting(false);
      }
    };
    
    decrypt();
  }, [rawCategories]);
  
  return {
    categories: decryptedCategories,
    isLoading: rawCategories === undefined || isDecrypting,
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
  
  // Remove category from all records
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

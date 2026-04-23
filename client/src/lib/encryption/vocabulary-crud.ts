import { db, type Tag, type Category, type Owner, type WalletName, type SeedName, type WalletSoftware } from '../database';

export async function createTag(name: string, color?: string): Promise<number> {
  const tag: Tag = {
    name,
    color,
    createdAt: Date.now(),
  };

  const id = await db.tags.add(tag);
  return id as number;
}

export async function getDecryptedTags(): Promise<Tag[]> {
  return db.tags.toArray();
}

export async function updateTag(id: number, data: Partial<Tag>): Promise<void> {
  const existing = await db.tags.get(id);
  if (!existing) throw new Error('Tag not found');
  
  const updated: Tag = {
    ...existing,
    ...data,
    id,
  };
  
  await db.tags.put(updated);
}

export async function deleteTag(id: number): Promise<void> {
  await db.tags.delete(id);
}

export async function createCategory(name: string): Promise<number> {
  const category: Category = {
    name,
    createdAt: Date.now(),
  };

  const id = await db.categories.add(category);
  return id as number;
}

export async function getDecryptedCategories(): Promise<Category[]> {
  return db.categories.toArray();
}

export async function updateCategory(id: number, data: Partial<Category>): Promise<void> {
  const existing = await db.categories.get(id);
  if (!existing) throw new Error('Category not found');
  
  const updated: Category = {
    ...existing,
    ...data,
    id,
  };
  
  await db.categories.put(updated);
}

export async function deleteCategory(id: number): Promise<void> {
  await db.categories.delete(id);
}

export async function createOwner(name: string): Promise<number> {
  const owner: Owner = {
    name,
    createdAt: Date.now(),
  };

  const id = await db.owners.add(owner);
  return id as number;
}

export async function getDecryptedOwners(): Promise<Owner[]> {
  return db.owners.toArray();
}

export async function updateOwner(id: number, data: Partial<Owner>): Promise<void> {
  const existing = await db.owners.get(id);
  if (!existing) throw new Error('Owner not found');
  
  const updated: Owner = {
    ...existing,
    ...data,
    id,
  };
  
  await db.owners.put(updated);
}

export async function deleteOwner(id: number): Promise<void> {
  await db.owners.delete(id);
}

export async function createWalletNameEntry(name: string): Promise<number> {
  const walletName: WalletName = {
    name,
    createdAt: Date.now(),
  };

  const id = await db.walletNames.add(walletName);
  return id as number;
}

export async function getDecryptedWalletNames(): Promise<WalletName[]> {
  return db.walletNames.toArray();
}

export async function updateWalletNameEntry(id: number, data: Partial<WalletName>): Promise<void> {
  const existing = await db.walletNames.get(id);
  if (!existing) throw new Error('Wallet name not found');
  
  const updated: WalletName = {
    ...existing,
    ...data,
    id,
  };
  
  await db.walletNames.put(updated);
}

export async function deleteWalletNameEntry(id: number): Promise<void> {
  await db.walletNames.delete(id);
}

export async function createSeedNameEntry(name: string): Promise<number> {
  const seedName: SeedName = {
    name,
    createdAt: Date.now(),
  };

  const id = await db.seedNames.add(seedName);
  return id as number;
}

export async function getDecryptedSeedNames(): Promise<SeedName[]> {
  return db.seedNames.toArray();
}

export async function updateSeedNameEntry(id: number, data: Partial<SeedName>): Promise<void> {
  const existing = await db.seedNames.get(id);
  if (!existing) throw new Error('Seed name not found');
  
  const updated: SeedName = {
    ...existing,
    ...data,
    id,
  };
  
  await db.seedNames.put(updated);
}

export async function deleteSeedNameEntry(id: number): Promise<void> {
  await db.seedNames.delete(id);
}

export async function createWalletSoftwareEntry(name: string): Promise<number> {
  const walletSoftware: WalletSoftware = {
    name,
    createdAt: Date.now(),
  };

  const id = await db.walletSoftware.add(walletSoftware);
  return id as number;
}

export async function getDecryptedWalletSoftware(): Promise<WalletSoftware[]> {
  return db.walletSoftware.toArray();
}

export async function updateWalletSoftwareEntry(id: number, data: Partial<WalletSoftware>): Promise<void> {
  const existing = await db.walletSoftware.get(id);
  if (!existing) throw new Error('Wallet software not found');
  
  const updated: WalletSoftware = {
    ...existing,
    ...data,
    id,
  };
  
  await db.walletSoftware.put(updated);
}

export async function deleteWalletSoftwareEntry(id: number): Promise<void> {
  await db.walletSoftware.delete(id);
}

export async function syncTagsToMaster(tagNames: string[]): Promise<void> {
  if (!tagNames || tagNames.length === 0) return;
  
  const existingTags = await db.tags.toArray();
  const existingNames = new Set(
    existingTags.map(t => t.name.toLowerCase())
  );
  
  for (const name of tagNames) {
    const trimmedName = name.trim();
    if (trimmedName && !existingNames.has(trimmedName.toLowerCase())) {
      const tag: Tag = {
        name: trimmedName,
        createdAt: Date.now(),
      };
      await db.tags.add(tag);
      existingNames.add(trimmedName.toLowerCase());
    }
  }
}

export async function syncCategoriesToMaster(categoryNames: string[]): Promise<void> {
  if (!categoryNames || categoryNames.length === 0) return;
  
  const existingCategories = await db.categories.toArray();
  const existingNames = new Set(
    existingCategories.map(c => c.name.toLowerCase())
  );
  
  for (const name of categoryNames) {
    const trimmedName = name.trim();
    if (trimmedName && !existingNames.has(trimmedName.toLowerCase())) {
      const category: Category = {
        name: trimmedName,
        createdAt: Date.now(),
      };
      await db.categories.add(category);
      existingNames.add(trimmedName.toLowerCase());
    }
  }
}

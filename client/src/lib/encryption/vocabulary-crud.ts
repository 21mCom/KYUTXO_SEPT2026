import { db, type Tag, type Category, type Owner, type WalletName, type SeedName, type WalletSoftware } from '../database';
import {
  encryptTag,
  decryptTag,
  encryptCategory,
  decryptCategory,
  encryptOwner,
  decryptOwner,
  encryptWalletName,
  decryptWalletName,
  encryptSeedName,
  decryptSeedName,
  encryptWalletSoftware,
  decryptWalletSoftware,
} from '../dbEncryption';
import { getKey } from './key-management';

// ============ TAG OPERATIONS ============

export async function createTag(name: string, color?: string): Promise<number> {
  const key = getKey();
  
  const tag: Tag = {
    name,
    color,
    createdAt: Date.now(),
  };

  const encrypted = await encryptTag(tag, key);
  const id = await db.tags.add(encrypted);
  return id as number;
}

export async function getDecryptedTags(): Promise<Tag[]> {
  const key = getKey();
  const tags = await db.tags.toArray();
  
  return Promise.all(
    tags.map(async (tag) => {
      if (tag.isEncrypted) {
        return await decryptTag(tag, key);
      }
      return tag;
    })
  );
}

export async function updateTag(id: number, data: Partial<Tag>): Promise<void> {
  const key = getKey();
  
  const existing = await db.tags.get(id);
  if (!existing) throw new Error('Tag not found');
  
  const decrypted = existing.isEncrypted
    ? await decryptTag(existing, key)
    : existing;
  
  const updated: Tag = {
    ...decrypted,
    ...data,
    id,
  };
  
  const encrypted = await encryptTag(updated, key);
  await db.tags.put(encrypted);
}

export async function deleteTag(id: number): Promise<void> {
  await db.tags.delete(id);
}

// ============ CATEGORY OPERATIONS ============

export async function createCategory(name: string): Promise<number> {
  const key = getKey();
  
  const category: Category = {
    name,
    createdAt: Date.now(),
  };

  const encrypted = await encryptCategory(category, key);
  const id = await db.categories.add(encrypted);
  return id as number;
}

export async function getDecryptedCategories(): Promise<Category[]> {
  const key = getKey();
  const categories = await db.categories.toArray();
  
  return Promise.all(
    categories.map(async (cat) => {
      if (cat.isEncrypted) {
        return await decryptCategory(cat, key);
      }
      return cat;
    })
  );
}

export async function updateCategory(id: number, data: Partial<Category>): Promise<void> {
  const key = getKey();
  
  const existing = await db.categories.get(id);
  if (!existing) throw new Error('Category not found');
  
  const decrypted = existing.isEncrypted
    ? await decryptCategory(existing, key)
    : existing;
  
  const updated: Category = {
    ...decrypted,
    ...data,
    id,
  };
  
  const encrypted = await encryptCategory(updated, key);
  await db.categories.put(encrypted);
}

export async function deleteCategory(id: number): Promise<void> {
  await db.categories.delete(id);
}

// ============ OWNER OPERATIONS ============

export async function createOwner(name: string): Promise<number> {
  const key = getKey();
  
  const owner: Owner = {
    name,
    createdAt: Date.now(),
  };

  const encrypted = await encryptOwner(owner, key);
  const id = await db.owners.add(encrypted);
  return id as number;
}

export async function getDecryptedOwners(): Promise<Owner[]> {
  const key = getKey();
  const owners = await db.owners.toArray();
  
  return Promise.all(
    owners.map(async (owner) => {
      if (owner.isEncrypted) {
        return await decryptOwner(owner, key);
      }
      return owner;
    })
  );
}

export async function updateOwner(id: number, data: Partial<Owner>): Promise<void> {
  const key = getKey();
  
  const existing = await db.owners.get(id);
  if (!existing) throw new Error('Owner not found');
  
  const decrypted = existing.isEncrypted
    ? await decryptOwner(existing, key)
    : existing;
  
  const updated: Owner = {
    ...decrypted,
    ...data,
    id,
  };
  
  const encrypted = await encryptOwner(updated, key);
  await db.owners.put(encrypted);
}

export async function deleteOwner(id: number): Promise<void> {
  await db.owners.delete(id);
}

// ============ WALLET NAME OPERATIONS ============

export async function createWalletNameEntry(name: string): Promise<number> {
  const key = getKey();
  
  const walletName: WalletName = {
    name,
    createdAt: Date.now(),
  };

  const encrypted = await encryptWalletName(walletName, key);
  const id = await db.walletNames.add(encrypted);
  return id as number;
}

export async function getDecryptedWalletNames(): Promise<WalletName[]> {
  const key = getKey();
  const walletNames = await db.walletNames.toArray();
  
  return Promise.all(
    walletNames.map(async (wn) => {
      if (wn.isEncrypted) {
        return await decryptWalletName(wn, key);
      }
      return wn;
    })
  );
}

export async function updateWalletNameEntry(id: number, data: Partial<WalletName>): Promise<void> {
  const key = getKey();
  
  const existing = await db.walletNames.get(id);
  if (!existing) throw new Error('Wallet name not found');
  
  const decrypted = existing.isEncrypted
    ? await decryptWalletName(existing, key)
    : existing;
  
  const updated: WalletName = {
    ...decrypted,
    ...data,
    id,
  };
  
  const encrypted = await encryptWalletName(updated, key);
  await db.walletNames.put(encrypted);
}

export async function deleteWalletNameEntry(id: number): Promise<void> {
  await db.walletNames.delete(id);
}

// ============ SEED NAME OPERATIONS ============

export async function createSeedNameEntry(name: string): Promise<number> {
  const key = getKey();
  
  const seedName: SeedName = {
    name,
    createdAt: Date.now(),
  };

  const encrypted = await encryptSeedName(seedName, key);
  const id = await db.seedNames.add(encrypted);
  return id as number;
}

export async function getDecryptedSeedNames(): Promise<SeedName[]> {
  const key = getKey();
  const seedNames = await db.seedNames.toArray();
  
  return Promise.all(
    seedNames.map(async (sn) => {
      if (sn.isEncrypted) {
        return await decryptSeedName(sn, key);
      }
      return sn;
    })
  );
}

export async function updateSeedNameEntry(id: number, data: Partial<SeedName>): Promise<void> {
  const key = getKey();
  
  const existing = await db.seedNames.get(id);
  if (!existing) throw new Error('Seed name not found');
  
  const decrypted = existing.isEncrypted
    ? await decryptSeedName(existing, key)
    : existing;
  
  const updated: SeedName = {
    ...decrypted,
    ...data,
    id,
  };
  
  const encrypted = await encryptSeedName(updated, key);
  await db.seedNames.put(encrypted);
}

export async function deleteSeedNameEntry(id: number): Promise<void> {
  await db.seedNames.delete(id);
}

// ============ WALLET SOFTWARE OPERATIONS ============

export async function createWalletSoftwareEntry(name: string): Promise<number> {
  const key = getKey();
  
  const walletSoftware: WalletSoftware = {
    name,
    createdAt: Date.now(),
  };

  const encrypted = await encryptWalletSoftware(walletSoftware, key);
  const id = await db.walletSoftware.add(encrypted);
  return id as number;
}

export async function getDecryptedWalletSoftware(): Promise<WalletSoftware[]> {
  const key = getKey();
  const walletSoftware = await db.walletSoftware.toArray();
  
  return Promise.all(
    walletSoftware.map(async (ws) => {
      if (ws.isEncrypted) {
        return await decryptWalletSoftware(ws, key);
      }
      return ws;
    })
  );
}

export async function updateWalletSoftwareEntry(id: number, data: Partial<WalletSoftware>): Promise<void> {
  const key = getKey();
  
  const existing = await db.walletSoftware.get(id);
  if (!existing) throw new Error('Wallet software not found');
  
  const decrypted = existing.isEncrypted
    ? await decryptWalletSoftware(existing, key)
    : existing;
  
  const updated: WalletSoftware = {
    ...decrypted,
    ...data,
    id,
  };
  
  const encrypted = await encryptWalletSoftware(updated, key);
  await db.walletSoftware.put(encrypted);
}

export async function deleteWalletSoftwareEntry(id: number): Promise<void> {
  await db.walletSoftware.delete(id);
}

// ============ SYNC HELPERS ============

export async function syncTagsToMaster(tagNames: string[]): Promise<void> {
  if (!tagNames || tagNames.length === 0) return;
  
  const key = getKey();
  
  const existingTags = await db.tags.toArray();
  const decryptedTags = await Promise.all(
    existingTags.map(async (tag) => {
      if (tag.isEncrypted) {
        return await decryptTag(tag, key);
      }
      return tag;
    })
  );
  
  const existingNames = new Set(
    decryptedTags.map(t => t.name.toLowerCase())
  );
  
  for (const name of tagNames) {
    const trimmedName = name.trim();
    if (trimmedName && !existingNames.has(trimmedName.toLowerCase())) {
      const tag: Tag = {
        name: trimmedName,
        createdAt: Date.now(),
      };
      const encrypted = await encryptTag(tag, key);
      await db.tags.add(encrypted);
      existingNames.add(trimmedName.toLowerCase());
    }
  }
}

export async function syncCategoriesToMaster(categoryNames: string[]): Promise<void> {
  if (!categoryNames || categoryNames.length === 0) return;
  
  const key = getKey();
  
  const existingCategories = await db.categories.toArray();
  const decryptedCategories = await Promise.all(
    existingCategories.map(async (cat) => {
      if (cat.isEncrypted) {
        return await decryptCategory(cat, key);
      }
      return cat;
    })
  );
  
  const existingNames = new Set(
    decryptedCategories.map(c => c.name.toLowerCase())
  );
  
  for (const name of categoryNames) {
    const trimmedName = name.trim();
    if (trimmedName && !existingNames.has(trimmedName.toLowerCase())) {
      const category: Category = {
        name: trimmedName,
        createdAt: Date.now(),
      };
      const encrypted = await encryptCategory(category, key);
      await db.categories.add(encrypted);
      existingNames.add(trimmedName.toLowerCase());
    }
  }
}

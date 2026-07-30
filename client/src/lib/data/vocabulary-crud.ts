import { db, type Tag, type Category, type Owner, type WalletName, type SeedName, type WalletSoftware } from '../database';
import { bulkUpdateRecords } from './record-crud';

export const SEED_NAME_MAX_LENGTH = 15;

export async function createTag(name: string, color?: string): Promise<number> {
  if (!name.trim()) {
    throw new Error('Tag name cannot be empty');
  }

  const trimmedName = name.trim();
  const existing = await db.tags.where('name').equalsIgnoreCase(trimmedName).first();
  if (existing) {
    throw new Error('Tag already exists');
  }

  const tag: Tag = {
    name: trimmedName,
    color,
    createdAt: Date.now(),
  };

  const id = await db.tags.add(tag);
  return id as number;
}

export async function getTags(): Promise<Tag[]> {
  return db.tags.toArray();
}

export async function updateTag(id: number, data: Partial<Tag>): Promise<void> {
  if (data.name !== undefined) {
    const trimmedName = data.name.trim();
    if (!trimmedName) {
      throw new Error('Tag name cannot be empty');
    }
    const existing = await db.tags.where('name').equalsIgnoreCase(trimmedName).first();
    if (existing && existing.id !== id) {
      throw new Error('Tag already exists');
    }
    data = { ...data, name: trimmedName };
  }
  await db.tags.update(id, data);
}

export async function deleteTag(id: number): Promise<void> {
  const tag = await db.tags.get(id);
  if (!tag) return;

  const records = await db.records.where('tags').equals(tag.name).toArray();
  if (records.length > 0) {
    await bulkUpdateRecords(
      records.map(record => ({
        id: record.id!,
        changes: { tags: record.tags.filter(t => t !== tag.name) },
      }))
    );
  }

  await db.tags.delete(id);
}

export async function getTagUsageCount(tagName: string): Promise<number> {
  return db.records.where('tags').equals(tagName).count();
}

export async function createCategory(name: string): Promise<number> {
  if (!name.trim()) {
    throw new Error('Category name cannot be empty');
  }

  const trimmedName = name.trim();
  const existing = await db.categories.where('name').equalsIgnoreCase(trimmedName).first();
  if (existing) {
    throw new Error('Category already exists');
  }

  const category: Category = {
    name: trimmedName,
    createdAt: Date.now(),
  };

  const id = await db.categories.add(category);
  return id as number;
}

export async function getCategories(): Promise<Category[]> {
  return db.categories.toArray();
}

export async function updateCategory(id: number, data: Partial<Category>): Promise<void> {
  if (data.name !== undefined) {
    const trimmedName = data.name.trim();
    if (!trimmedName) {
      throw new Error('Category name cannot be empty');
    }
    const existing = await db.categories.where('name').equalsIgnoreCase(trimmedName).first();
    if (existing && existing.id !== id) {
      throw new Error('Category already exists');
    }
    data = { ...data, name: trimmedName };
  }
  await db.categories.update(id, data);
}

export async function deleteCategory(id: number): Promise<void> {
  const category = await db.categories.get(id);
  if (!category) return;

  const records = await db.records.where('categories').equals(category.name).toArray();
  if (records.length > 0) {
    await bulkUpdateRecords(
      records.map(record => ({
        id: record.id!,
        changes: { categories: record.categories.filter(c => c !== category.name) },
      }))
    );
  }

  await db.categories.delete(id);
}

export async function getCategoryUsageCount(categoryName: string): Promise<number> {
  return db.records.where('categories').equals(categoryName).count();
}

export async function createOwner(name: string): Promise<number> {
  if (!name.trim()) {
    throw new Error('Owner name cannot be empty');
  }

  const trimmedName = name.trim();
  const existing = await db.owners.where('name').equalsIgnoreCase(trimmedName).first();
  if (existing) {
    throw new Error('Owner already exists');
  }

  return await db.owners.add({ name: trimmedName, createdAt: Date.now() }) as number;
}

export async function getOwners(): Promise<Owner[]> {
  return db.owners.toArray();
}

export async function updateOwner(id: number, data: Partial<Owner>): Promise<void> {
  if (data.name !== undefined) {
    const trimmedName = data.name.trim();
    if (!trimmedName) {
      throw new Error('Owner name cannot be empty');
    }
    const existing = await db.owners.where('name').equalsIgnoreCase(trimmedName).first();
    if (existing && existing.id !== id) {
      throw new Error('Owner already exists');
    }
    data = { ...data, name: trimmedName };
  }
  await db.owners.update(id, data);
}

export async function deleteOwner(id: number): Promise<void> {
  await db.owners.delete(id);
}

export async function getOwnerUsageCount(ownerName: string): Promise<number> {
  return db.records.where('owner').equals(ownerName).count();
}

export async function createWalletName(name: string): Promise<number> {
  if (!name.trim()) {
    throw new Error('Wallet name cannot be empty');
  }

  const trimmedName = name.trim();
  const existing = await db.walletNames.where('name').equalsIgnoreCase(trimmedName).first();
  if (existing) {
    throw new Error('Wallet name already exists');
  }

  return await db.walletNames.add({ name: trimmedName, createdAt: Date.now() }) as number;
}

export const createWalletNameEntry = createWalletName;

export async function getWalletNames(): Promise<WalletName[]> {
  return db.walletNames.toArray();
}

export async function updateWalletName(id: number, data: Partial<WalletName>): Promise<void> {
  if (data.name !== undefined) {
    const trimmedName = data.name.trim();
    if (!trimmedName) {
      throw new Error('Wallet name cannot be empty');
    }
    const existing = await db.walletNames.where('name').equalsIgnoreCase(trimmedName).first();
    if (existing && existing.id !== id) {
      throw new Error('Wallet name already exists');
    }
    data = { ...data, name: trimmedName };
  }
  await db.walletNames.update(id, data);
}

export const updateWalletNameEntry = updateWalletName;

export async function deleteWalletName(id: number): Promise<void> {
  await db.walletNames.delete(id);
}

export const deleteWalletNameEntry = deleteWalletName;

export async function getWalletNameUsageCount(walletNameValue: string): Promise<number> {
  return db.records.where('walletName').equals(walletNameValue).count();
}

export async function createSeedName(name: string): Promise<number> {
  if (!name.trim()) {
    throw new Error('Seed name cannot be empty');
  }

  const trimmedName = name.trim();

  if (trimmedName.length > SEED_NAME_MAX_LENGTH) {
    throw new Error(`Seed names are limited to ${SEED_NAME_MAX_LENGTH} characters to prevent accidental seed phrase entry`);
  }

  const existing = await db.seedNames.where('name').equalsIgnoreCase(trimmedName).first();
  if (existing) {
    throw new Error('Seed name already exists');
  }

  return await db.seedNames.add({ name: trimmedName, createdAt: Date.now() }) as number;
}

export const createSeedNameEntry = createSeedName;

export async function getSeedNames(): Promise<SeedName[]> {
  return db.seedNames.toArray();
}

export async function updateSeedName(id: number, data: Partial<SeedName>): Promise<void> {
  if (data.name !== undefined) {
    const trimmedName = data.name.trim();
    if (!trimmedName) {
      throw new Error('Seed name cannot be empty');
    }
    if (trimmedName.length > SEED_NAME_MAX_LENGTH) {
      throw new Error(`Seed names are limited to ${SEED_NAME_MAX_LENGTH} characters to prevent accidental seed phrase entry`);
    }
    const existing = await db.seedNames.where('name').equalsIgnoreCase(trimmedName).first();
    if (existing && existing.id !== id) {
      throw new Error('Seed name already exists');
    }
    data = { ...data, name: trimmedName };
  }
  await db.seedNames.update(id, data);
}

export const updateSeedNameEntry = updateSeedName;

export async function deleteSeedName(id: number): Promise<void> {
  await db.seedNames.delete(id);
}

export const deleteSeedNameEntry = deleteSeedName;

export async function getSeedNameUsageCount(seedNameValue: string): Promise<number> {
  return db.records.where('seedName').equals(seedNameValue).count();
}

export async function createWalletSoftware(name: string): Promise<number> {
  if (!name.trim()) {
    throw new Error('Wallet software name cannot be empty');
  }

  const trimmedName = name.trim();
  const existing = await db.walletSoftware.where('name').equalsIgnoreCase(trimmedName).first();
  if (existing) {
    throw new Error('Wallet software already exists');
  }

  return await db.walletSoftware.add({ name: trimmedName, createdAt: Date.now() }) as number;
}

export const createWalletSoftwareEntry = createWalletSoftware;

export async function getWalletSoftware(): Promise<WalletSoftware[]> {
  return db.walletSoftware.toArray();
}

export async function updateWalletSoftware(id: number, data: Partial<WalletSoftware>): Promise<void> {
  if (data.name !== undefined) {
    const trimmedName = data.name.trim();
    if (!trimmedName) {
      throw new Error('Wallet software name cannot be empty');
    }
    const existing = await db.walletSoftware.where('name').equalsIgnoreCase(trimmedName).first();
    if (existing && existing.id !== id) {
      throw new Error('Wallet software already exists');
    }
    data = { ...data, name: trimmedName };
  }
  await db.walletSoftware.update(id, data);
}

export const updateWalletSoftwareEntry = updateWalletSoftware;

export async function deleteWalletSoftware(id: number): Promise<void> {
  await db.walletSoftware.delete(id);
}

export const deleteWalletSoftwareEntry = deleteWalletSoftware;

export async function getWalletSoftwareUsageCount(walletSoftwareValue: string): Promise<number> {
  return db.records.where('walletSoftware').equals(walletSoftwareValue).count();
}

export async function propagateTagRename(oldName: string, newName: string): Promise<number> {
  const records = await db.records.where('tags').equals(oldName).toArray();
  if (records.length === 0) return 0;
  await bulkUpdateRecords(
    records.map(record => ({
      id: record.id!,
      changes: { tags: record.tags.map(t => t === oldName ? newName : t) },
    }))
  );
  return records.length;
}

export async function propagateCategoryRename(oldName: string, newName: string): Promise<number> {
  const records = await db.records.where('categories').equals(oldName).toArray();
  if (records.length === 0) return 0;
  await bulkUpdateRecords(
    records.map(record => ({
      id: record.id!,
      changes: { categories: record.categories.map(c => c === oldName ? newName : c) },
    }))
  );
  return records.length;
}

export async function propagateStringFieldRename(field: string, oldName: string, newName: string): Promise<number> {
  const records = await db.records.where(field).equals(oldName).toArray();
  if (records.length === 0) return 0;
  await bulkUpdateRecords(
    records.map(record => ({
      id: record.id!,
      changes: { [field]: newName },
    }))
  );
  return records.length;
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
      await createTag(trimmedName);
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
      await createCategory(trimmedName);
      existingNames.add(trimmedName.toLowerCase());
    }
  }
}

const EXPECTED_VOCABULARY_ERRORS = [
  'already exists',
  'cannot be empty',
  'are limited to',
] as const;

function isExpectedVocabularyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return EXPECTED_VOCABULARY_ERRORS.some(pattern => msg.includes(pattern));
}

export async function ensureOwner(name: string): Promise<void> {
  try {
    await createOwner(name);
  } catch (err) {
    if (!isExpectedVocabularyError(err)) throw err;
  }
}

export async function ensureWalletName(name: string): Promise<void> {
  try {
    await createWalletName(name);
  } catch (err) {
    if (!isExpectedVocabularyError(err)) throw err;
  }
}

export async function ensureSeedName(name: string): Promise<void> {
  try {
    await createSeedName(name);
  } catch (err) {
    if (!isExpectedVocabularyError(err)) throw err;
  }
}

export async function ensureWalletSoftware(name: string): Promise<void> {
  try {
    await createWalletSoftware(name);
  } catch (err) {
    if (!isExpectedVocabularyError(err)) throw err;
  }
}

/**
 * Distinct entity values present on records, whether or not they exist in the
 * vocabulary tables. Records created by older imports or code paths that skip
 * vocab sync (createRecord does not auto-create vocab rows) can carry values
 * with no vocabulary entry; filter dropdowns must still offer them. All five
 * fields are indexed (walletName, seedName, owner, *tags, *categories), so
 * uniqueKeys() is cheap even on large vaults.
 */
export async function getRecordEntityValues(): Promise<{
  wallets: string[];
  seeds: string[];
  owners: string[];
  tags: string[];
  categories: string[];
}> {
  const distinct = async (index: string): Promise<string[]> => {
    const keys = await db.records.orderBy(index).uniqueKeys();
    return keys.filter((k): k is string => typeof k === 'string' && k.trim() !== '');
  };
  const [wallets, seeds, owners, tags, categories] = await Promise.all([
    distinct('walletName'),
    distinct('seedName'),
    distinct('owner'),
    distinct('tags'),
    distinct('categories'),
  ]);
  return { wallets, seeds, owners, tags, categories };
}

export async function restoreTag(data: { name: string; color?: string; createdAt: number }): Promise<number> {
  return await db.tags.add(data) as number;
}

export async function restoreCategory(data: { name: string; createdAt: number }): Promise<number> {
  return await db.categories.add(data) as number;
}

export async function restoreOwner(data: { name: string; createdAt: number }): Promise<number> {
  return await db.owners.add(data) as number;
}

export async function restoreWalletName(data: { name: string; createdAt: number }): Promise<number> {
  return await db.walletNames.add(data) as number;
}

export async function restoreSeedName(data: { name: string; createdAt: number }): Promise<number> {
  return await db.seedNames.add(data) as number;
}

export async function restoreWalletSoftware(data: { name: string; createdAt: number }): Promise<number> {
  return await db.walletSoftware.add(data) as number;
}

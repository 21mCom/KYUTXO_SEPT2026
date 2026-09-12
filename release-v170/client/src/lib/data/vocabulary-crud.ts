import { type Tag, type Category, type Owner, type WalletName, type SeedName, type WalletSoftware, type Record as DbRecord } from '../database';
import { getVaultRepository, type VaultTableName, type VaultRows } from '../repository';
import { bulkUpdateRecords } from './record-crud';

export const SEED_NAME_MAX_LENGTH = 15;
const PAGE_SIZE = 500;

async function listRows<T extends VaultTableName>(table: T): Promise<VaultRows[T][]> {
  const repository = getVaultRepository();
  const rows: VaultRows[T][] = [];
  let cursor: string | number | undefined;
  do {
    const page = await repository.list(table, { cursor, limit: PAGE_SIZE });
    rows.push(...page.rows);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return rows;
}

async function vocabularyByName<T extends Tag | Category | Owner | WalletName | SeedName | WalletSoftware>(
  table: 'tags' | 'categories' | 'owners' | 'walletNames' | 'seedNames' | 'walletSoftware',
  name: string,
): Promise<T | undefined> {
  return (await listRows(table) as T[]).find((row) => row.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0);
}

async function recordsMatching(field: keyof DbRecord, value: string): Promise<DbRecord[]> {
  return (await listRows('records')).filter((record) => {
    const current = record[field];
    return Array.isArray(current) ? current.includes(value) : current === value;
  });
}

export async function createTag(name: string, color?: string): Promise<number> {
  if (!name.trim()) {
    throw new Error('Tag name cannot be empty');
  }

  const trimmedName = name.trim();
  const existing = await vocabularyByName<Tag>('tags', trimmedName);
  if (existing) {
    throw new Error('Tag already exists');
  }

  const tag: Tag = {
    name: trimmedName,
    color,
    createdAt: Date.now(),
  };

  const id = await getVaultRepository().add('tags', tag);
  return id as number;
}

export async function getTags(): Promise<Tag[]> {
  return listRows('tags');
}

export async function updateTag(id: number, data: Partial<Tag>): Promise<void> {
  if (data.name !== undefined) {
    const trimmedName = data.name.trim();
    if (!trimmedName) {
      throw new Error('Tag name cannot be empty');
    }
    const existing = await vocabularyByName<Tag>('tags', trimmedName);
    if (existing && existing.id !== id) {
      throw new Error('Tag already exists');
    }
    data = { ...data, name: trimmedName };
  }
  await getVaultRepository().update('tags', id, data);
}

export async function deleteTag(id: number): Promise<void> {
  const tag = await getVaultRepository().get('tags', id);
  if (!tag) return;

  const records = await recordsMatching('tags', tag.name);
  if (records.length > 0) {
    await bulkUpdateRecords(
      records.map(record => ({
        id: record.id!,
        changes: { tags: record.tags.filter(t => t !== tag.name) },
      }))
    );
  }

  await getVaultRepository().delete('tags', id);
}

export async function getTagUsageCount(tagName: string): Promise<number> {
  return (await recordsMatching('tags', tagName)).length;
}

export async function createCategory(name: string): Promise<number> {
  if (!name.trim()) {
    throw new Error('Category name cannot be empty');
  }

  const trimmedName = name.trim();
  const existing = await vocabularyByName<Category>('categories', trimmedName);
  if (existing) {
    throw new Error('Category already exists');
  }

  const category: Category = {
    name: trimmedName,
    createdAt: Date.now(),
  };

  const id = await getVaultRepository().add('categories', category);
  return id as number;
}

export async function getCategories(): Promise<Category[]> {
  return listRows('categories');
}

export async function updateCategory(id: number, data: Partial<Category>): Promise<void> {
  if (data.name !== undefined) {
    const trimmedName = data.name.trim();
    if (!trimmedName) {
      throw new Error('Category name cannot be empty');
    }
    const existing = await vocabularyByName<Category>('categories', trimmedName);
    if (existing && existing.id !== id) {
      throw new Error('Category already exists');
    }
    data = { ...data, name: trimmedName };
  }
  await getVaultRepository().update('categories', id, data);
}

export async function deleteCategory(id: number): Promise<void> {
  const category = await getVaultRepository().get('categories', id);
  if (!category) return;

  const records = await recordsMatching('categories', category.name);
  if (records.length > 0) {
    await bulkUpdateRecords(
      records.map(record => ({
        id: record.id!,
        changes: { categories: record.categories.filter(c => c !== category.name) },
      }))
    );
  }

  await getVaultRepository().delete('categories', id);
}

export async function getCategoryUsageCount(categoryName: string): Promise<number> {
  return (await recordsMatching('categories', categoryName)).length;
}

export async function createOwner(name: string): Promise<number> {
  if (!name.trim()) {
    throw new Error('Owner name cannot be empty');
  }

  const trimmedName = name.trim();
  const existing = await vocabularyByName<Owner>('owners', trimmedName);
  if (existing) {
    throw new Error('Owner already exists');
  }

  return await getVaultRepository().add('owners', { name: trimmedName, createdAt: Date.now() }) as number;
}

export async function getOwners(): Promise<Owner[]> {
  return listRows('owners');
}

export async function updateOwner(id: number, data: Partial<Owner>): Promise<void> {
  if (data.name !== undefined) {
    const trimmedName = data.name.trim();
    if (!trimmedName) {
      throw new Error('Owner name cannot be empty');
    }
    const existing = await vocabularyByName<Owner>('owners', trimmedName);
    if (existing && existing.id !== id) {
      throw new Error('Owner already exists');
    }
    data = { ...data, name: trimmedName };
  }
  await getVaultRepository().update('owners', id, data);
}

export async function deleteOwner(id: number): Promise<void> {
  await getVaultRepository().delete('owners', id);
}

export async function getOwnerUsageCount(ownerName: string): Promise<number> {
  return (await recordsMatching('owner', ownerName)).length;
}

export async function createWalletName(name: string): Promise<number> {
  if (!name.trim()) {
    throw new Error('Wallet name cannot be empty');
  }

  const trimmedName = name.trim();
  const existing = await vocabularyByName<WalletName>('walletNames', trimmedName);
  if (existing) {
    throw new Error('Wallet name already exists');
  }

  return await getVaultRepository().add('walletNames', { name: trimmedName, createdAt: Date.now() }) as number;
}

export const createWalletNameEntry = createWalletName;

export async function getWalletNames(): Promise<WalletName[]> {
  return listRows('walletNames');
}

export async function updateWalletName(id: number, data: Partial<WalletName>): Promise<void> {
  if (data.name !== undefined) {
    const trimmedName = data.name.trim();
    if (!trimmedName) {
      throw new Error('Wallet name cannot be empty');
    }
    const existing = await vocabularyByName<WalletName>('walletNames', trimmedName);
    if (existing && existing.id !== id) {
      throw new Error('Wallet name already exists');
    }
    data = { ...data, name: trimmedName };
  }
  await getVaultRepository().update('walletNames', id, data);
}

export const updateWalletNameEntry = updateWalletName;

export async function deleteWalletName(id: number): Promise<void> {
  await getVaultRepository().delete('walletNames', id);
}

export const deleteWalletNameEntry = deleteWalletName;

export async function getWalletNameUsageCount(walletNameValue: string): Promise<number> {
  return (await recordsMatching('walletName', walletNameValue)).length;
}

export async function createSeedName(name: string): Promise<number> {
  if (!name.trim()) {
    throw new Error('Seed name cannot be empty');
  }

  const trimmedName = name.trim();

  if (trimmedName.length > SEED_NAME_MAX_LENGTH) {
    throw new Error(`Seed names are limited to ${SEED_NAME_MAX_LENGTH} characters to prevent accidental seed phrase entry`);
  }

  const existing = await vocabularyByName<SeedName>('seedNames', trimmedName);
  if (existing) {
    throw new Error('Seed name already exists');
  }

  return await getVaultRepository().add('seedNames', { name: trimmedName, createdAt: Date.now() }) as number;
}

export const createSeedNameEntry = createSeedName;

export async function getSeedNames(): Promise<SeedName[]> {
  return listRows('seedNames');
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
    const existing = await vocabularyByName<SeedName>('seedNames', trimmedName);
    if (existing && existing.id !== id) {
      throw new Error('Seed name already exists');
    }
    data = { ...data, name: trimmedName };
  }
  await getVaultRepository().update('seedNames', id, data);
}

export const updateSeedNameEntry = updateSeedName;

export async function deleteSeedName(id: number): Promise<void> {
  await getVaultRepository().delete('seedNames', id);
}

export const deleteSeedNameEntry = deleteSeedName;

export async function getSeedNameUsageCount(seedNameValue: string): Promise<number> {
  return (await recordsMatching('seedName', seedNameValue)).length;
}

export async function createWalletSoftware(name: string): Promise<number> {
  if (!name.trim()) {
    throw new Error('Wallet software name cannot be empty');
  }

  const trimmedName = name.trim();
  const existing = await vocabularyByName<WalletSoftware>('walletSoftware', trimmedName);
  if (existing) {
    throw new Error('Wallet software already exists');
  }

  return await getVaultRepository().add('walletSoftware', { name: trimmedName, createdAt: Date.now() }) as number;
}

export const createWalletSoftwareEntry = createWalletSoftware;

export async function getWalletSoftware(): Promise<WalletSoftware[]> {
  return listRows('walletSoftware');
}

export async function updateWalletSoftware(id: number, data: Partial<WalletSoftware>): Promise<void> {
  if (data.name !== undefined) {
    const trimmedName = data.name.trim();
    if (!trimmedName) {
      throw new Error('Wallet software name cannot be empty');
    }
    const existing = await vocabularyByName<WalletSoftware>('walletSoftware', trimmedName);
    if (existing && existing.id !== id) {
      throw new Error('Wallet software already exists');
    }
    data = { ...data, name: trimmedName };
  }
  await getVaultRepository().update('walletSoftware', id, data);
}

export const updateWalletSoftwareEntry = updateWalletSoftware;

export async function deleteWalletSoftware(id: number): Promise<void> {
  await getVaultRepository().delete('walletSoftware', id);
}

export const deleteWalletSoftwareEntry = deleteWalletSoftware;

export async function getWalletSoftwareUsageCount(walletSoftwareValue: string): Promise<number> {
  return (await recordsMatching('walletSoftware', walletSoftwareValue)).length;
}

export async function propagateTagRename(oldName: string, newName: string): Promise<number> {
  const records = await recordsMatching('tags', oldName);
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
  const records = await recordsMatching('categories', oldName);
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
  const records = await recordsMatching(field as keyof DbRecord, oldName);
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

  const existingTags = await listRows('tags');
  const existingNames = new Set(
    existingTags.map(t => t.name.toLowerCase())
  );

  for (const name of tagNames) {
    const trimmedName = name.trim();
    if (trimmedName && !existingNames.has(trimmedName.toLowerCase())) {
      await ensureTag(trimmedName);
      existingNames.add(trimmedName.toLowerCase());
    }
  }
}

export async function syncCategoriesToMaster(categoryNames: string[]): Promise<void> {
  if (!categoryNames || categoryNames.length === 0) return;

  const existingCategories = await listRows('categories');
  const existingNames = new Set(
    existingCategories.map(c => c.name.toLowerCase())
  );

  for (const name of categoryNames) {
    const trimmedName = name.trim();
    if (trimmedName && !existingNames.has(trimmedName.toLowerCase())) {
      await ensureCategory(trimmedName);
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

type SelectableVocabularyKind = 'tag' | 'category' | 'owner' | 'walletName' | 'seedName' | 'walletSoftware';

const SELECTABLE_VOCABULARY: Record<SelectableVocabularyKind, {
  create: (name: string) => Promise<number>;
  findExisting: (name: string) => Promise<{ name: string } | undefined>;
}> = {
  tag: { create: createTag, findExisting: (n) => vocabularyByName<Tag>('tags', n) },
  category: { create: createCategory, findExisting: (n) => vocabularyByName<Category>('categories', n) },
  owner: { create: createOwner, findExisting: (n) => vocabularyByName<Owner>('owners', n) },
  walletName: { create: createWalletName, findExisting: (n) => vocabularyByName<WalletName>('walletNames', n) },
  seedName: { create: createSeedName, findExisting: (n) => vocabularyByName<SeedName>('seedNames', n) },
  walletSoftware: { create: createWalletSoftware, findExisting: (n) => vocabularyByName<WalletSoftware>('walletSoftware', n) },
};

/**
 * Interactive "Add new" helper: creates the entry, or — if it already exists
 * (any case) — returns the existing entry's canonical name instead of throwing.
 * Real validation errors (empty name, over-length seed name) still throw.
 * Returns the canonical stored name to select.
 */
export async function ensureSelectableVocabularyEntry(
  kind: SelectableVocabularyKind,
  name: string,
): Promise<string> {
  const trimmedName = name.trim();
  const { create, findExisting } = SELECTABLE_VOCABULARY[kind];
  try {
    await create(trimmedName);
    return trimmedName;
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) {
      const existing = await findExisting(trimmedName);
      if (existing) return existing.name;
      // Raced with a delete: retry the create once, else fall back to input.
      try {
        await create(trimmedName);
        return trimmedName;
      } catch (retryErr) {
        if (retryErr instanceof Error && retryErr.message.includes('already exists')) {
          const raced = await findExisting(trimmedName);
          return raced?.name ?? trimmedName;
        }
        throw retryErr;
      }
    }
    throw err;
  }
}

export async function ensureTag(name: string, color?: string): Promise<void> {
  try {
    await createTag(name, color);
  } catch (err) {
    if (!isExpectedVocabularyError(err)) throw err;
  }
}

export async function ensureCategory(name: string): Promise<void> {
  try {
    await createCategory(name);
  } catch (err) {
    if (!isExpectedVocabularyError(err)) throw err;
  }
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
    const values = new Set<string>();
    for (const record of await listRows('records')) {
      const value = record[index as keyof DbRecord];
      if (Array.isArray(value)) value.forEach((item) => { if (typeof item === 'string' && item.trim()) values.add(item); });
      else if (typeof value === 'string' && value.trim()) values.add(value);
    }
    return [...values];
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
  return await getVaultRepository().add('tags', data) as number;
}

export async function restoreCategory(data: { name: string; createdAt: number }): Promise<number> {
  return await getVaultRepository().add('categories', data) as number;
}

export async function restoreOwner(data: Owner): Promise<number> {
  return await getVaultRepository().add('owners', data) as number;
}

export async function restoreWalletName(data: { name: string; createdAt: number }): Promise<number> {
  return await getVaultRepository().add('walletNames', data) as number;
}

export async function restoreSeedName(data: { name: string; createdAt: number }): Promise<number> {
  return await getVaultRepository().add('seedNames', data) as number;
}

export async function restoreWalletSoftware(data: { name: string; createdAt: number }): Promise<number> {
  return await getVaultRepository().add('walletSoftware', data) as number;
}

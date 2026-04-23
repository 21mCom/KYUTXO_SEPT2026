import { useLiveQuery } from 'dexie-react-hooks';
import { db, type SeedName } from '@/lib/database';

export function useSeedNames() {
  const seedNames = useLiveQuery(() => db.seedNames.orderBy('name').toArray());

  return {
    seedNames: seedNames ?? [],
    isLoading: seedNames === undefined,
  };
}

export const SEED_NAME_MAX_LENGTH = 15;

export async function createSeedName(name: string) {
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

  return await db.seedNames.add({ name: trimmedName, createdAt: Date.now() });
}

export async function updateSeedName(id: number, data: Partial<SeedName>) {
  if (data.name) {
    const trimmedName = data.name.trim();
    if (trimmedName.length > SEED_NAME_MAX_LENGTH) {
      throw new Error(`Seed names are limited to ${SEED_NAME_MAX_LENGTH} characters to prevent accidental seed phrase entry`);
    }
    data.name = trimmedName;
  }
  await db.seedNames.update(id, data);
}

export async function deleteSeedName(id: number) {
  await db.seedNames.delete(id);
}

export async function getSeedNameUsageCount(seedNameValue: string): Promise<number> {
  return db.records.where('seedName').equals(seedNameValue).count();
}

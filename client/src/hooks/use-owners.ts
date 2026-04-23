import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Owner } from '@/lib/database';

export function useOwners() {
  const owners = useLiveQuery(() => db.owners.orderBy('name').toArray());

  return {
    owners: owners ?? [],
    isLoading: owners === undefined,
  };
}

export async function createOwner(name: string) {
  if (!name.trim()) {
    throw new Error('Owner name cannot be empty');
  }

  const trimmedName = name.trim();
  const existing = await db.owners.where('name').equalsIgnoreCase(trimmedName).first();
  if (existing) {
    throw new Error('Owner already exists');
  }

  return await db.owners.add({ name: trimmedName, createdAt: Date.now() });
}

export async function updateOwner(id: number, data: Partial<Owner>) {
  await db.owners.update(id, data);
}

export async function deleteOwner(id: number) {
  await db.owners.delete(id);
}

export async function getOwnerUsageCount(ownerName: string): Promise<number> {
  return db.records.where('owner').equals(ownerName).count();
}

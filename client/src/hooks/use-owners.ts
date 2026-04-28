import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/database';

export { createOwner, updateOwner, deleteOwner, getOwnerUsageCount } from '@/lib/data/vocabulary-crud';

export function useOwners() {
  const owners = useLiveQuery(() => db.owners.orderBy('name').toArray());

  return {
    owners: owners ?? [],
    isLoading: owners === undefined,
  };
}

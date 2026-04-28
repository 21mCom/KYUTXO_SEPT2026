import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/database';

export { createSeedName, updateSeedName, deleteSeedName, getSeedNameUsageCount, SEED_NAME_MAX_LENGTH } from '@/lib/data/vocabulary-crud';

export function useSeedNames() {
  const seedNames = useLiveQuery(() => db.seedNames.orderBy('name').toArray());

  return {
    seedNames: seedNames ?? [],
    isLoading: seedNames === undefined,
  };
}

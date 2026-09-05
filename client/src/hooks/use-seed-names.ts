import { useEffect, useState } from 'react';
import { useDbChangeSignal } from './use-db-change-signal';
import { getSeedNames } from '@/lib/data/vocabulary-crud';

export { createSeedName, updateSeedName, deleteSeedName, getSeedNameUsageCount, SEED_NAME_MAX_LENGTH } from '@/lib/data/vocabulary-crud';

export function useSeedNames() {
  const [seedNames, setSeedNames] = useState<Awaited<ReturnType<typeof getSeedNames>>>();
  const signal = useDbChangeSignal(['seedNames']);
  useEffect(() => { void getSeedNames().then((rows) => setSeedNames(rows.sort((a, b) => a.name.localeCompare(b.name)))); }, [signal]);

  return {
    seedNames: seedNames ?? [],
    isLoading: seedNames === undefined,
  };
}

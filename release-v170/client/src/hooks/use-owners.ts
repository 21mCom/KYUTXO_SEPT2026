import { useEffect, useState } from 'react';
import { useDbChangeSignal } from './use-db-change-signal';
import { getOwners } from '@/lib/data/vocabulary-crud';

export { createOwner, updateOwner, deleteOwner, getOwnerUsageCount } from '@/lib/data/vocabulary-crud';

export function useOwners() {
  const [owners, setOwners] = useState<Awaited<ReturnType<typeof getOwners>>>();
  const signal = useDbChangeSignal(['owners']);
  useEffect(() => { void getOwners().then((rows) => setOwners(rows.sort((a, b) => a.name.localeCompare(b.name)))); }, [signal]);

  return {
    owners: owners ?? [],
    isLoading: owners === undefined,
  };
}

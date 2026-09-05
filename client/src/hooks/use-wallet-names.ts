import { useEffect, useState } from 'react';
import { useDbChangeSignal } from './use-db-change-signal';
import { getWalletNames } from '@/lib/data/vocabulary-crud';

export { createWalletName, updateWalletName, deleteWalletName, getWalletNameUsageCount } from '@/lib/data/vocabulary-crud';

export function useWalletNames() {
  const [walletNames, setWalletNames] = useState<Awaited<ReturnType<typeof getWalletNames>>>();
  const signal = useDbChangeSignal(['walletNames']);
  useEffect(() => { void getWalletNames().then((rows) => setWalletNames(rows.sort((a, b) => a.name.localeCompare(b.name)))); }, [signal]);

  return {
    walletNames: walletNames ?? [],
    isLoading: walletNames === undefined,
  };
}

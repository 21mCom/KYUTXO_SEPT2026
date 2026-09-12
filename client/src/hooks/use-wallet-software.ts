import { useEffect, useState } from 'react';
import { useDbChangeSignal } from './use-db-change-signal';
import { getWalletSoftware } from '@/lib/data/vocabulary-crud';

export { createWalletSoftware, updateWalletSoftware, deleteWalletSoftware, getWalletSoftwareUsageCount } from '@/lib/data/vocabulary-crud';

export function useWalletSoftware() {
  const [walletSoftware, setWalletSoftware] = useState<Awaited<ReturnType<typeof getWalletSoftware>>>();
  const signal = useDbChangeSignal(['walletSoftware']);
  useEffect(() => {
    let cancelled = false;
    void getWalletSoftware().then((rows) => {
      if (!cancelled) setWalletSoftware(rows.sort((a, b) => a.name.localeCompare(b.name)));
    });
    return () => { cancelled = true; };
  }, [signal]);

  return {
    walletSoftware: walletSoftware ?? [],
    isLoading: walletSoftware === undefined,
  };
}

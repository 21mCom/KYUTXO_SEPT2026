import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/database';

export { createWalletName, updateWalletName, deleteWalletName, getWalletNameUsageCount } from '@/lib/data/vocabulary-crud';

export function useWalletNames() {
  const walletNames = useLiveQuery(() => db.walletNames.orderBy('name').toArray());

  return {
    walletNames: walletNames ?? [],
    isLoading: walletNames === undefined,
  };
}

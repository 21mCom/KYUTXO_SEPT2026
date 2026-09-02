import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/database';

export { createWalletSoftware, updateWalletSoftware, deleteWalletSoftware, getWalletSoftwareUsageCount } from '@/lib/data/vocabulary-crud';

export function useWalletSoftware() {
  const walletSoftware = useLiveQuery(() => db.walletSoftware.orderBy('name').toArray());

  return {
    walletSoftware: walletSoftware ?? [],
    isLoading: walletSoftware === undefined,
  };
}

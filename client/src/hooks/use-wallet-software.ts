import { useLiveQuery } from 'dexie-react-hooks';
import { useState, useEffect } from 'react';
import { db, type WalletSoftware } from '@/lib/database';
import { 
  createWalletSoftwareEntry as facadeCreateWalletSoftware,
  updateWalletSoftwareEntry as facadeUpdateWalletSoftware,
  deleteWalletSoftwareEntry as facadeDeleteWalletSoftware,
  getDecryptedWalletSoftware,
  isEncryptionReady,
} from '@/lib/encryptionFacade';

export function useWalletSoftware() {
  const [decryptedWalletSoftware, setDecryptedWalletSoftware] = useState<WalletSoftware[]>([]);
  const [isDecrypting, setIsDecrypting] = useState(false);
  
  const rawWalletSoftware = useLiveQuery(() => db.walletSoftware.orderBy('name').toArray());
  
  useEffect(() => {
    const decrypt = async () => {
      if (!rawWalletSoftware) {
        setDecryptedWalletSoftware([]);
        return;
      }
      
      if (!isEncryptionReady()) {
        setDecryptedWalletSoftware(rawWalletSoftware);
        return;
      }
      
      setIsDecrypting(true);
      try {
        const decrypted = await getDecryptedWalletSoftware();
        decrypted.sort((a, b) => a.name.localeCompare(b.name));
        setDecryptedWalletSoftware(decrypted);
      } catch (error) {
        console.error('Failed to decrypt wallet software:', error);
        setDecryptedWalletSoftware(rawWalletSoftware);
      } finally {
        setIsDecrypting(false);
      }
    };
    
    decrypt();
  }, [rawWalletSoftware]);
  
  return {
    walletSoftware: decryptedWalletSoftware,
    isLoading: rawWalletSoftware === undefined || isDecrypting,
  };
}

export async function createWalletSoftware(name: string) {
  if (!name.trim()) {
    throw new Error('Wallet software name cannot be empty');
  }
  
  const existingWalletSoftware = await getDecryptedWalletSoftware();
  const trimmedName = name.trim();
  const existing = existingWalletSoftware.find(ws => ws.name.toLowerCase() === trimmedName.toLowerCase());
  if (existing) {
    throw new Error('Wallet software already exists');
  }
  
  return await facadeCreateWalletSoftware(trimmedName);
}

export async function updateWalletSoftware(id: number, data: Partial<WalletSoftware>) {
  return await facadeUpdateWalletSoftware(id, data);
}

export async function deleteWalletSoftware(id: number) {
  return await facadeDeleteWalletSoftware(id);
}

export async function getWalletSoftwareUsageCount(walletSoftwareValue: string): Promise<number> {
  return db.records.where('walletSoftware').equals(walletSoftwareValue).count();
}

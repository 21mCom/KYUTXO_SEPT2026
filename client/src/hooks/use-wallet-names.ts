import { useLiveQuery } from 'dexie-react-hooks';
import { useState, useEffect } from 'react';
import { db, type WalletName } from '@/lib/database';
import { 
  createWalletNameEntry as facadeCreateWalletName,
  updateWalletNameEntry as facadeUpdateWalletName,
  deleteWalletNameEntry as facadeDeleteWalletName,
  getDecryptedWalletNames,
  isEncryptionReady,
} from '@/lib/encryptionFacade';

export function useWalletNames() {
  const [decryptedWalletNames, setDecryptedWalletNames] = useState<WalletName[]>([]);
  const [isDecrypting, setIsDecrypting] = useState(false);
  
  const rawWalletNames = useLiveQuery(() => db.walletNames.orderBy('name').toArray());
  
  useEffect(() => {
    const decrypt = async () => {
      if (!rawWalletNames) {
        setDecryptedWalletNames([]);
        return;
      }
      
      if (!isEncryptionReady()) {
        setDecryptedWalletNames(rawWalletNames);
        return;
      }
      
      setIsDecrypting(true);
      try {
        const decrypted = await getDecryptedWalletNames();
        decrypted.sort((a, b) => a.name.localeCompare(b.name));
        setDecryptedWalletNames(decrypted);
      } catch (error) {
        console.error('Failed to decrypt wallet names:', error);
        setDecryptedWalletNames(rawWalletNames);
      } finally {
        setIsDecrypting(false);
      }
    };
    
    decrypt();
  }, [rawWalletNames]);
  
  return {
    walletNames: decryptedWalletNames,
    isLoading: rawWalletNames === undefined || isDecrypting,
  };
}

export async function createWalletName(name: string) {
  if (!name.trim()) {
    throw new Error('Wallet name cannot be empty');
  }
  
  const existingWalletNames = await getDecryptedWalletNames();
  const trimmedName = name.trim();
  const existing = existingWalletNames.find(wn => wn.name.toLowerCase() === trimmedName.toLowerCase());
  if (existing) {
    throw new Error('Wallet name already exists');
  }
  
  return await facadeCreateWalletName(trimmedName);
}

export async function updateWalletName(id: number, data: Partial<WalletName>) {
  return await facadeUpdateWalletName(id, data);
}

export async function deleteWalletName(id: number) {
  return await facadeDeleteWalletName(id);
}

export async function getWalletNameUsageCount(walletNameValue: string): Promise<number> {
  return db.records.filter(r => r.walletName === walletNameValue).count();
}

import { useLiveQuery } from 'dexie-react-hooks';
import { useState, useEffect } from 'react';
import { db, type SeedName } from '@/lib/database';
import { 
  createSeedNameEntry as facadeCreateSeedName,
  updateSeedNameEntry as facadeUpdateSeedName,
  deleteSeedNameEntry as facadeDeleteSeedName,
  getDecryptedSeedNames,
  isEncryptionReady,
} from '@/lib/encryptionFacade';

export function useSeedNames() {
  const [decryptedSeedNames, setDecryptedSeedNames] = useState<SeedName[]>([]);
  const [isDecrypting, setIsDecrypting] = useState(false);
  
  const rawSeedNames = useLiveQuery(() => db.seedNames.orderBy('name').toArray());
  
  useEffect(() => {
    const decrypt = async () => {
      if (!rawSeedNames) {
        setDecryptedSeedNames([]);
        return;
      }
      
      if (!isEncryptionReady()) {
        setDecryptedSeedNames(rawSeedNames);
        return;
      }
      
      setIsDecrypting(true);
      try {
        const decrypted = await getDecryptedSeedNames();
        decrypted.sort((a, b) => a.name.localeCompare(b.name));
        setDecryptedSeedNames(decrypted);
      } catch (error) {
        console.error('Failed to decrypt seed names:', error);
        setDecryptedSeedNames(rawSeedNames);
      } finally {
        setIsDecrypting(false);
      }
    };
    
    decrypt();
  }, [rawSeedNames]);
  
  return {
    seedNames: decryptedSeedNames,
    isLoading: rawSeedNames === undefined || isDecrypting,
  };
}

export const SEED_NAME_MAX_LENGTH = 15;

export async function createSeedName(name: string) {
  if (!name.trim()) {
    throw new Error('Seed name cannot be empty');
  }
  
  const trimmedName = name.trim();
  
  if (trimmedName.length > SEED_NAME_MAX_LENGTH) {
    throw new Error(`Seed names are limited to ${SEED_NAME_MAX_LENGTH} characters to prevent accidental seed phrase entry`);
  }
  
  const existingSeedNames = await getDecryptedSeedNames();
  const existing = existingSeedNames.find(sn => sn.name.toLowerCase() === trimmedName.toLowerCase());
  if (existing) {
    throw new Error('Seed name already exists');
  }
  
  return await facadeCreateSeedName(trimmedName);
}

export async function updateSeedName(id: number, data: Partial<SeedName>) {
  if (data.name) {
    const trimmedName = data.name.trim();
    if (trimmedName.length > SEED_NAME_MAX_LENGTH) {
      throw new Error(`Seed names are limited to ${SEED_NAME_MAX_LENGTH} characters to prevent accidental seed phrase entry`);
    }
    data.name = trimmedName;
  }
  return await facadeUpdateSeedName(id, data);
}

export async function deleteSeedName(id: number) {
  return await facadeDeleteSeedName(id);
}

export async function getSeedNameUsageCount(seedNameValue: string): Promise<number> {
  return db.records.filter(r => r.seedName === seedNameValue).count();
}

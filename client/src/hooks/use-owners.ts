import { useLiveQuery } from 'dexie-react-hooks';
import { useState, useEffect } from 'react';
import { db, type Owner } from '@/lib/database';
import { 
  createOwner as facadeCreateOwner,
  updateOwner as facadeUpdateOwner,
  deleteOwner as facadeDeleteOwner,
  getDecryptedOwners,
  isEncryptionReady,
} from '@/lib/encryptionFacade';

export function useOwners() {
  const [decryptedOwners, setDecryptedOwners] = useState<Owner[]>([]);
  const [isDecrypting, setIsDecrypting] = useState(false);
  
  const rawOwners = useLiveQuery(() => db.owners.orderBy('name').toArray());
  
  useEffect(() => {
    const decrypt = async () => {
      if (!rawOwners) {
        setDecryptedOwners([]);
        return;
      }
      
      if (!isEncryptionReady()) {
        setDecryptedOwners(rawOwners);
        return;
      }
      
      setIsDecrypting(true);
      try {
        const decrypted = await getDecryptedOwners();
        decrypted.sort((a, b) => a.name.localeCompare(b.name));
        setDecryptedOwners(decrypted);
      } catch (error) {
        console.error('Failed to decrypt owners:', error);
        setDecryptedOwners(rawOwners);
      } finally {
        setIsDecrypting(false);
      }
    };
    
    decrypt();
  }, [rawOwners]);
  
  return {
    owners: decryptedOwners,
    isLoading: rawOwners === undefined || isDecrypting,
  };
}

export async function createOwner(name: string) {
  if (!name.trim()) {
    throw new Error('Owner name cannot be empty');
  }
  
  const existingOwners = await getDecryptedOwners();
  const trimmedName = name.trim();
  const existing = existingOwners.find(o => o.name.toLowerCase() === trimmedName.toLowerCase());
  if (existing) {
    throw new Error('Owner already exists');
  }
  
  return await facadeCreateOwner(trimmedName);
}

export async function updateOwner(id: number, data: Partial<Owner>) {
  return await facadeUpdateOwner(id, data);
}

export async function deleteOwner(id: number) {
  return await facadeDeleteOwner(id);
}

export async function getOwnerUsageCount(ownerName: string): Promise<number> {
  const allRecords = await db.records.toArray();
  return allRecords.filter(r => r.owner === ownerName).length;
}

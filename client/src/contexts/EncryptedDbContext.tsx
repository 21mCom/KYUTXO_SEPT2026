import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { createEncryptedStores, type EncryptedStore } from '@/lib/encryptedDb';
import type { Record, Attachment, Tag, Category, Settings } from '@/lib/database';

interface EncryptedDbContextType {
  records: EncryptedStore<Record>;
  attachments: EncryptedStore<Attachment>;
  tags: EncryptedStore<Tag>;
  categories: EncryptedStore<Category>;
  settings: EncryptedStore<Settings>;
  isReady: boolean;
}

const EncryptedDbContext = createContext<EncryptedDbContextType | undefined>(undefined);

export function EncryptedDbProvider({ children }: { children: ReactNode }) {
  const { encryptionKey, isAuthenticated } = useAuth();

  const stores = useMemo(() => {
    return createEncryptedStores(() => encryptionKey);
  }, [encryptionKey]);

  const value = useMemo(() => ({
    ...stores,
    isReady: isAuthenticated && encryptionKey !== null,
  }), [stores, isAuthenticated, encryptionKey]);

  return (
    <EncryptedDbContext.Provider value={value}>
      {children}
    </EncryptedDbContext.Provider>
  );
}

export function useEncryptedDb() {
  const context = useContext(EncryptedDbContext);
  if (context === undefined) {
    throw new Error('useEncryptedDb must be used within an EncryptedDbProvider');
  }
  return context;
}

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { 
  deriveKey, 
  generateSalt, 
  hashPassword, 
  verifyPassword,
  bufferToBase64,
  base64ToBuffer,
} from '@/lib/crypto';
import { 
  isVaultInitialized, 
  getVaultSettings, 
  saveVaultSettings,
  setMigrationComplete,
  isAttachmentPathsMigrated,
  setAttachmentPathsMigrated,
  getPendingPasswordChange,
} from '@/lib/vault';
import { hasPlaintextData, migrateToEncrypted } from '@/lib/dbEncryption';
import { initEncryptionFacade, clearEncryptionFacade } from '@/lib/encryptionFacade';
import { migrateAttachmentPaths } from '@/lib/attachments';
import {
  bulkDecryptDatabase,
  bulkEncryptDatabase,
  getDbDecryptionState,
  setDbDecryptionState,
  type BulkCryptoProgress,
} from '@/lib/encryption/bulk-crypto';

interface AuthContextType {
  isInitialized: boolean | null;
  isAuthenticated: boolean;
  encryptionKey: CryptoKey | null;
  setupPassword: (password: string) => Promise<void>;
  login: (password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  isLoading: boolean;
  isMigrating: boolean;
  migrationProgress: string | null;
  hasPendingPasswordChange: boolean;
  bulkCryptoProgress: BulkCryptoProgress | null;
  bulkCryptoMode: 'decrypt' | 'encrypt' | null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isInitialized, setIsInitialized] = useState<boolean | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [encryptionKey, setEncryptionKey] = useState<CryptoKey | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isMigrating, setIsMigrating] = useState(false);
  const [migrationProgress, setMigrationProgress] = useState<string | null>(null);
  const [hasPendingPasswordChange, setHasPendingPasswordChange] = useState(false);
  const [bulkCryptoProgress, setBulkCryptoProgress] = useState<BulkCryptoProgress | null>(null);
  const [bulkCryptoMode, setBulkCryptoMode] = useState<'decrypt' | 'encrypt' | null>(null);

  useEffect(() => {
    const checkVault = async () => {
      try {
        const initialized = await isVaultInitialized();
        setIsInitialized(initialized);
      } catch (error) {
        console.error('Failed to check vault status:', error);
        setIsInitialized(false);
      } finally {
        setIsLoading(false);
      }
    };

    checkVault();
  }, []);

  const runAttachmentPathMigration = useCallback(async () => {
    const alreadyMigrated = await isAttachmentPathsMigrated();
    if (alreadyMigrated) return;

    try {
      const result = await migrateAttachmentPaths((current, total, message) => {
        setMigrationProgress(message);
      });
      if (result.failed === 0 && result.migrated >= 0) {
        await setAttachmentPathsMigrated(true);
      }
      if (result.migrated > 0) {
        setMigrationProgress(`Secured ${result.migrated} attachment path${result.migrated > 1 ? 's' : ''}.${result.failed > 0 ? ` ${result.failed} failed — will retry next login.` : ''}`);
        setTimeout(() => setMigrationProgress(null), 5000);
      } else if (result.failed > 0) {
        setMigrationProgress(`Attachment migration: ${result.failed} file${result.failed > 1 ? 's' : ''} failed. Will retry next login.`);
        setTimeout(() => setMigrationProgress(null), 5000);
      }
    } catch (error) {
      console.error('Attachment path migration failed:', error);
    }
  }, []);

  const runLegacyMigration = useCallback(async (key: CryptoKey) => {
    const hasPlaintext = await hasPlaintextData();
    if (!hasPlaintext) {
      await setMigrationComplete(true);
    } else {
      setIsMigrating(true);
      setMigrationProgress('Encrypting your data...');

      try {
        const result = await migrateToEncrypted(key);
        await setMigrationComplete(true);
        
        const total = result.records + result.attachments + result.tags + result.categories + result.participants;
        setMigrationProgress(`Encrypted ${total} items successfully!`);
        
        setTimeout(() => setMigrationProgress(null), 2000);
      } catch (error) {
        console.error('Migration failed:', error);
        setMigrationProgress('Migration failed. Some data may not be encrypted.');
      } finally {
        setIsMigrating(false);
      }
    }

    await runAttachmentPathMigration();
  }, [runAttachmentPathMigration]);

  const performBulkDecrypt = useCallback(async (key: CryptoKey) => {
    const state = await getDbDecryptionState();

    if (state === 'decrypted') {
      return;
    }

    setBulkCryptoMode('decrypt');
    setBulkCryptoProgress(null);

    try {
      const result = await bulkDecryptDatabase(key, (progress) => {
        setBulkCryptoProgress(progress);
      });

      if (result.totalFailed > 0) {
        console.warn(`[BulkDecrypt] ${result.totalFailed} items failed to decrypt`);
      }
      console.log(`[BulkDecrypt] Decrypted ${result.totalDecrypted} items`);
    } catch (error) {
      console.error('[BulkDecrypt] Fatal error:', error);
    } finally {
      setBulkCryptoMode(null);
      setBulkCryptoProgress(null);
    }
  }, []);

  const performBulkEncrypt = useCallback(async (key: CryptoKey) => {
    const state = await getDbDecryptionState();

    if (state === 'encrypted') {
      return;
    }

    setBulkCryptoMode('encrypt');
    setBulkCryptoProgress(null);

    try {
      const result = await bulkEncryptDatabase(key, (progress) => {
        setBulkCryptoProgress(progress);
      });

      if (result.totalFailed > 0) {
        console.warn(`[BulkEncrypt] ${result.totalFailed} items failed to encrypt`);
      }
      console.log(`[BulkEncrypt] Encrypted ${result.totalEncrypted} items`);
    } catch (error) {
      console.error('[BulkEncrypt] Fatal error:', error);
    } finally {
      setBulkCryptoMode(null);
      setBulkCryptoProgress(null);
    }
  }, []);

  const setupPassword = useCallback(async (password: string) => {
    setIsLoading(true);
    try {
      const salt = generateSalt();
      const hash = await hashPassword(password, salt);
      const key = await deriveKey(password, salt);

      await saveVaultSettings(bufferToBase64(salt), hash);
      await setDbDecryptionState('encrypted');

      initEncryptionFacade(key);
      
      setEncryptionKey(key);
      setIsInitialized(true);
      setIsAuthenticated(true);

      runLegacyMigration(key);
    } finally {
      setIsLoading(false);
    }
  }, [runLegacyMigration]);

  const login = useCallback(async (password: string): Promise<boolean> => {
    setIsLoading(true);
    try {
      const settings = await getVaultSettings();
      if (!settings) {
        return false;
      }

      const salt = base64ToBuffer(settings.salt);
      const isValid = await verifyPassword(password, salt, settings.passwordHash);

      if (isValid) {
        const key = await deriveKey(password, salt);
        initEncryptionFacade(key);
        setEncryptionKey(key);

        const pending = await getPendingPasswordChange();
        if (pending) {
          setHasPendingPasswordChange(true);
          console.warn('Detected interrupted password change. Visit Settings to resume or abandon.');
        }

        await runLegacyMigration(key);
        await performBulkDecrypt(key);

        setIsAuthenticated(true);
        return true;
      }

      const pending = await getPendingPasswordChange();
      if (pending) {
        const pendingSalt = base64ToBuffer(pending.newSalt);
        const pendingValid = await verifyPassword(password, pendingSalt, pending.newHash);
        if (pendingValid) {
          const key = await deriveKey(password, pendingSalt);
          initEncryptionFacade(key);
          setEncryptionKey(key);
          setHasPendingPasswordChange(true);
          console.warn('Logged in with pending new password. Visit Settings to resume or abandon the password change.');
          
          await runLegacyMigration(key);
          await performBulkDecrypt(key);

          setIsAuthenticated(true);
          return true;
        }
      }

      return false;
    } finally {
      setIsLoading(false);
    }
  }, [runLegacyMigration, performBulkDecrypt]);

  const logout = useCallback(async () => {
    if (encryptionKey) {
      await performBulkEncrypt(encryptionKey);
    }
    clearEncryptionFacade();
    setEncryptionKey(null);
    setIsAuthenticated(false);
  }, [encryptionKey, performBulkEncrypt]);

  return (
    <AuthContext.Provider
      value={{
        isInitialized,
        isAuthenticated,
        encryptionKey,
        setupPassword,
        login,
        logout,
        isLoading,
        isMigrating,
        migrationProgress,
        hasPendingPasswordChange,
        bulkCryptoProgress,
        bulkCryptoMode,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

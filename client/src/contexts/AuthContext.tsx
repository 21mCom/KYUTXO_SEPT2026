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
} from '@/lib/vault';
import { migrateToEncrypted, hasPlaintextData } from '@/lib/dbEncryption';
import { initEncryptionFacade, clearEncryptionFacade } from '@/lib/encryptionFacade';
import { migrateAttachmentPaths } from '@/lib/attachments';

interface AuthContextType {
  isInitialized: boolean | null; // null = loading
  isAuthenticated: boolean;
  encryptionKey: CryptoKey | null;
  setupPassword: (password: string) => Promise<void>;
  login: (password: string) => Promise<boolean>;
  logout: () => void;
  isLoading: boolean;
  isMigrating: boolean;
  migrationProgress: string | null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isInitialized, setIsInitialized] = useState<boolean | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [encryptionKey, setEncryptionKey] = useState<CryptoKey | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isMigrating, setIsMigrating] = useState(false);
  const [migrationProgress, setMigrationProgress] = useState<string | null>(null);

  // Check if vault is initialized on mount
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
      if (result.failed === 0) {
        await setAttachmentPathsMigrated(true);
      }
      if (result.migrated > 0) {
        setMigrationProgress(`Secured ${result.migrated} attachment path${result.migrated > 1 ? 's' : ''}.${result.failed > 0 ? ` ${result.failed} failed — will retry next login.` : ''}`);
        setTimeout(() => setMigrationProgress(null), 3000);
      }
    } catch (error) {
      console.error('Attachment path migration failed:', error);
    }
  }, []);

  // Run migration after successful login if needed
  const runMigration = useCallback(async (key: CryptoKey) => {
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

  // Setup a new password (first-time setup)
  const setupPassword = useCallback(async (password: string) => {
    setIsLoading(true);
    try {
      const salt = generateSalt();
      const hash = await hashPassword(password, salt);
      const key = await deriveKey(password, salt);

      // Save salt and hash to vault
      await saveVaultSettings(bufferToBase64(salt), hash);

      // Initialize the encryption facade with the key
      initEncryptionFacade(key);
      
      setEncryptionKey(key);
      setIsInitialized(true);
      setIsAuthenticated(true);

      // Run migration in background
      runMigration(key);
    } finally {
      setIsLoading(false);
    }
  }, [runMigration]);

  // Login with existing password
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
        
        // Initialize the encryption facade with the key
        initEncryptionFacade(key);
        
        setEncryptionKey(key);
        setIsAuthenticated(true);

        // Run migration in background
        runMigration(key);
        return true;
      }

      return false;
    } finally {
      setIsLoading(false);
    }
  }, [runMigration]);

  // Logout
  const logout = useCallback(() => {
    clearEncryptionFacade();
    setEncryptionKey(null);
    setIsAuthenticated(false);
  }, []);

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

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { 
  generateSalt, 
  hashPassword, 
  verifyPassword,
  bufferToBase64,
  base64ToBuffer,
  deriveKey,
} from '@/lib/crypto';
import { 
  isVaultInitialized, 
  getVaultSettings, 
  saveVaultSettings,
  isAttachmentPathsMigrated,
  setAttachmentPathsMigrated,
  isLegacyDecryptComplete,
  setLegacyDecryptComplete,
} from '@/lib/vault';
import { migrateAttachmentPaths } from '@/lib/attachments';
import { hasLegacyEncryptedRecords, decryptLegacyRecords, type LegacyDecryptProgress } from '@/lib/legacy-decrypt';

interface AuthContextType {
  isInitialized: boolean | null;
  isAuthenticated: boolean;
  setupPassword: (password: string) => Promise<void>;
  login: (password: string) => Promise<boolean>;
  logout: () => void;
  isLoading: boolean;
  legacyMigrationProgress: LegacyDecryptProgress | null;
  legacyMigrationResult: { totalDecrypted: number; totalFailed: number; unexpectedError?: boolean } | null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isInitialized, setIsInitialized] = useState<boolean | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [legacyMigrationProgress, setLegacyMigrationProgress] = useState<LegacyDecryptProgress | null>(null);
  const [legacyMigrationResult, setLegacyMigrationResult] = useState<{ totalDecrypted: number; totalFailed: number; unexpectedError?: boolean } | null>(null);

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
      const result = await migrateAttachmentPaths();
      if (result.failed === 0 && result.migrated >= 0) {
        await setAttachmentPathsMigrated(true);
      }
    } catch (error) {
      console.error('Attachment path migration failed:', error);
    }
  }, []);

  const runLegacyDecryptMigration = useCallback(async (password: string, saltBase64: string) => {
    try {
      const alreadyDone = await isLegacyDecryptComplete();
      if (alreadyDone) return;

      const hasLegacy = await hasLegacyEncryptedRecords();
      if (!hasLegacy) {
        await setLegacyDecryptComplete(true);
        return;
      }

      const salt = base64ToBuffer(saltBase64);
      const encryptionKey = await deriveKey(password, salt);

      const result = await decryptLegacyRecords(encryptionKey, (progress) => {
        setLegacyMigrationProgress(progress);
      });

      console.log(`[LegacyDecrypt] Complete: ${result.totalDecrypted} decrypted, ${result.totalFailed} failed, ${result.tableErrors.length} table errors`);

      if (result.totalFailed === 0 && result.tableErrors.length === 0) {
        await setLegacyDecryptComplete(true);
      }

      const hasIssues = result.totalFailed > 0 || result.tableErrors.length > 0;
      if (hasIssues) {
        setLegacyMigrationResult({
          totalDecrypted: result.totalDecrypted,
          totalFailed: result.totalFailed + result.tableErrors.length,
        });
      }
    } catch (error) {
      console.error('[LegacyDecrypt] Migration failed:', error);
      setLegacyMigrationResult({ totalDecrypted: 0, totalFailed: 0, unexpectedError: true });
    } finally {
      setLegacyMigrationProgress(null);
    }
  }, []);

  const setupPassword = useCallback(async (password: string) => {
    setIsLoading(true);
    try {
      const salt = generateSalt();
      const hash = await hashPassword(password, salt);

      await saveVaultSettings(bufferToBase64(salt), hash);

      setIsInitialized(true);
      setIsAuthenticated(true);

      runAttachmentPathMigration();
    } finally {
      setIsLoading(false);
    }
  }, [runAttachmentPathMigration]);

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
        setIsAuthenticated(true);
        runAttachmentPathMigration();
        runLegacyDecryptMigration(password, settings.salt);
        return true;
      }

      return false;
    } finally {
      setIsLoading(false);
    }
  }, [runAttachmentPathMigration, runLegacyDecryptMigration]);

  const logout = useCallback(() => {
    setIsAuthenticated(false);
    setLegacyMigrationProgress(null);
    setLegacyMigrationResult(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        isInitialized,
        isAuthenticated,
        setupPassword,
        login,
        logout,
        isLoading,
        legacyMigrationProgress,
        legacyMigrationResult,
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

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
  getLegacyDecryptCompletedTables,
  addLegacyDecryptCompletedTable,
  isLegacyFileDecryptComplete,
  setLegacyFileDecryptComplete,
} from '@/lib/vault';
import { migrateAttachmentPaths } from '@/lib/attachments';
import { hasLegacyEncryptedRecords, decryptLegacyRecords, getTotalTableCount, type LegacyDecryptProgress } from '@/lib/legacy-decrypt';
import { decryptLegacyAttachmentFiles, type FileDecryptProgress } from '@/lib/legacy-decrypt-files';
import { getActivityBus } from '@/lib/activity-bus';

interface AuthContextType {
  isInitialized: boolean | null;
  isAuthenticated: boolean;
  setupPassword: (password: string) => Promise<void>;
  login: (password: string) => Promise<boolean>;
  logout: () => void;
  isLoading: boolean;
  legacyMigrationProgress: LegacyDecryptProgress | null;
  legacyMigrationResult: { totalDecrypted: number; totalFailed: number; unexpectedError?: boolean } | null;
  fileDecryptProgress: FileDecryptProgress | null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isInitialized, setIsInitialized] = useState<boolean | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [legacyMigrationProgress, setLegacyMigrationProgress] = useState<LegacyDecryptProgress | null>(null);
  const [legacyMigrationResult, setLegacyMigrationResult] = useState<{ totalDecrypted: number; totalFailed: number; unexpectedError?: boolean } | null>(null);
  const [fileDecryptProgress, setFileDecryptProgress] = useState<FileDecryptProgress | null>(null);

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

  const runLegacyFileDecryptMigration = useCallback(async (encryptionKey: CryptoKey) => {
    try {
      const fileDone = await isLegacyFileDecryptComplete();
      if (fileDone) return;

      setFileDecryptProgress({ current: 0, total: 0, decrypted: 0, failed: 0, skipped: 0 });

      const result = await decryptLegacyAttachmentFiles(
        encryptionKey,
        (progress) => {
          setFileDecryptProgress(progress);
          try {
            getActivityBus().publishTask({
              id: 'file-decrypt',
              label: 'Decrypting Attachment Files',
              phase: `${progress.current} / ${progress.total} files`,
              current: progress.current,
              total: progress.total,
            });
          } catch {}
        },
      );

      console.log(`[FileDecrypt] Complete: ${result.totalDecrypted} decrypted, ${result.totalFailed} failed, ${result.totalSkipped} skipped`);

      if (result.totalFailed === 0) {
        await setLegacyFileDecryptComplete(true);
      }
    } catch (error) {
      console.error('[FileDecrypt] Migration failed:', error);
    } finally {
      setFileDecryptProgress(null);
      try { getActivityBus().completeTask('file-decrypt'); } catch {}
    }
  }, []);

  const runLegacyDecryptMigration = useCallback(async (password: string, saltBase64: string) => {
    const salt = base64ToBuffer(saltBase64);
    const encryptionKey = await deriveKey(password, salt);

    try {
      const alreadyDone = await isLegacyDecryptComplete();
      if (alreadyDone) {
        await runLegacyFileDecryptMigration(encryptionKey);
        return;
      }

      const completedTables = await getLegacyDecryptCompletedTables();

      const hasLegacy = await hasLegacyEncryptedRecords(completedTables);
      if (!hasLegacy) {
        await setLegacyDecryptComplete(true);
        await runLegacyFileDecryptMigration(encryptionKey);
        return;
      }

      const totalTables = getTotalTableCount();
      setLegacyMigrationProgress({
        tableName: 'Preparing',
        tableIndex: completedTables.length,
        tableCount: totalTables,
        current: 0,
        total: 0,
        failed: 0,
      });

      if (completedTables.length > 0) {
        console.log(`[LegacyDecrypt] Resuming — ${completedTables.length} tables already completed: ${completedTables.join(', ')}`);
      }

      const result = await decryptLegacyRecords(
        encryptionKey,
        (progress) => {
          setLegacyMigrationProgress(progress);
          try {
            getActivityBus().publishTask({
              id: 'legacy-decrypt',
              label: 'Migrating Encrypted Data',
              phase: `${progress.tableName} (table ${progress.tableIndex + 1}/${progress.tableCount})`,
              current: progress.current,
              total: progress.total,
            });
          } catch {}
        },
        {
          alreadyCompletedTables: completedTables,
          onTableComplete: async (tableName: string) => {
            try {
              await addLegacyDecryptCompletedTable(tableName);
              console.log(`[LegacyDecrypt] Checkpoint saved: ${tableName}`);
            } catch (err) {
              console.error(`[LegacyDecrypt] Failed to save checkpoint for ${tableName}:`, err);
            }
          },
        },
      );

      console.log(`[LegacyDecrypt] Complete: ${result.totalDecrypted} decrypted, ${result.totalFailed} failed, ${result.tableErrors.length} table errors`);

      const metadataFullyComplete = result.totalFailed === 0 && result.tableErrors.length === 0;
      if (metadataFullyComplete) {
        await setLegacyDecryptComplete(true);
      }

      setLegacyMigrationResult({
        totalDecrypted: result.totalDecrypted,
        totalFailed: result.totalFailed + result.tableErrors.length,
      });

      if (metadataFullyComplete) {
        await runLegacyFileDecryptMigration(encryptionKey);
      } else {
        console.warn('[LegacyDecrypt] Skipping file decryption — metadata migration incomplete, will retry next login');
      }
    } catch (error) {
      console.error('[LegacyDecrypt] Migration failed:', error);
      setLegacyMigrationResult({ totalDecrypted: 0, totalFailed: 0, unexpectedError: true });
    } finally {
      setLegacyMigrationProgress(null);
      try { getActivityBus().completeTask('legacy-decrypt'); } catch {}
    }
  }, [runLegacyFileDecryptMigration]);

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
    setFileDecryptProgress(null);
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
        fileDecryptProgress,
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

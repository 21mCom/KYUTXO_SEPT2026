import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
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
  getLegacyFileDecryptCheckpoint,
  setLegacyFileDecryptCheckpoint,
  markFreshVaultMigrationsComplete,
  isInputStringLowerRepaired,
  setInputStringLowerRepaired,
} from '@/lib/vault';
import { repairInputStringLower, countRecords } from '@/lib/data/record-crud';
import { countAttachments } from '@/lib/data/attachments-crud';
import { countEvidenceAttachments } from '@/lib/data/evidence-crud';
import { migrateAttachmentPaths } from '@/lib/attachments';
import { decryptLegacyRecords, getTotalTableCount, countUnrecoveredLegacyRows, type LegacyDecryptProgress } from '@/lib/legacy-decrypt';
import { decryptLegacyAttachmentFiles, type FileDecryptProgress } from '@/lib/legacy-decrypt-files';
import { getActivityBus } from '@/lib/activity-bus';

interface AuthContextType {
  isInitialized: boolean | null;
  isAuthenticated: boolean;
  setupPassword: (password: string) => Promise<void>;
  login: (password: string) => Promise<boolean>;
  logout: () => void;
  isLoading: boolean;
  isMigrating: boolean;
  legacyMigrationProgress: LegacyDecryptProgress | null;
  legacyMigrationResult: { totalDecrypted: number; totalFailed: number; unexpectedError?: boolean } | null;
  fileDecryptProgress: FileDecryptProgress | null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isInitialized, setIsInitialized] = useState<boolean | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isMigrating, setIsMigrating] = useState(false);
  // Single-flight guard: a startup migration is fired-and-forgotten from login,
  // so a quick logout/re-login could otherwise launch a second concurrent run
  // and reintroduce the IndexedDB contention this migration hardening avoids.
  const migrationInFlightRef = useRef(false);
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
        {
          // Durable resume: an interrupted hours-long run continues from the last
          // clean batch instead of restarting the whole table scan.
          getCheckpoint: getLegacyFileDecryptCheckpoint,
          saveCheckpoint: setLegacyFileDecryptCheckpoint,
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

      // No upfront "has legacy data?" probe: that probe walked tables on every
      // unmigrated login. decryptLegacyRecords already scans by keyset batches,
      // finds nothing on a clean vault, and marks the flag complete — so it is the
      // single, bounded scanner. (Fresh vaults skip here via isLegacyDecryptComplete.)
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

      // Decrypt counts alone are not proof of success: a malformed/garbage
      // encrypted payload can decrypt without raising an error yet leave the
      // record blank or showing "[encrypted]". Mirror the manual "Restore
      // Locked Data" panel and run an independent re-scan before declaring the
      // vault fully unlocked, so login can never wrongly mark a still-locked
      // vault complete. This scan only runs on migration logins (the flag is
      // still false here), not on every normal login.
      const decryptSucceeded = result.totalFailed === 0 && result.tableErrors.length === 0;
      let metadataFullyComplete = decryptSucceeded;
      if (decryptSucceeded) {
        try {
          const scan = await countUnrecoveredLegacyRows();
          if (scan.totalUnrecovered > 0) {
            metadataFullyComplete = false;
            console.warn(
              `[LegacyDecrypt] Verification found ${scan.totalUnrecovered} still-locked record(s) after decrypt — not marking complete, will retry next login`,
            );
          }
        } catch (err) {
          metadataFullyComplete = false;
          console.error('[LegacyDecrypt] Post-decrypt verification scan failed — not marking complete:', err);
        }
      }
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

  // Repairs stale `inputStringLower` left behind by the legacy decryption on
  // vaults that already migrated (see repairInputStringLower). Guarded by a
  // one-time flag and only marked done when the pass fully succeeds, so a
  // partial failure retries on the next login instead of leaving records
  // unsearchable.
  const runInputStringLowerRepair = useCallback(async () => {
    try {
      if (await isInputStringLowerRepaired()) return;
      const result = await repairInputStringLower();
      if (result.ok) {
        await setInputStringLowerRepaired(true);
        if (result.fixed > 0) {
          console.log(`[InputStringLowerRepair] Repaired ${result.fixed} of ${result.scanned} records`);
        }
      } else {
        console.warn('[InputStringLowerRepair] Incomplete — will retry next login');
      }
    } catch (err) {
      console.error('[InputStringLowerRepair] Failed:', err);
    }
  }, []);

  const runStartupMigrations = useCallback(async (password: string, saltBase64: string) => {
    // Single-flight: if a migration is already running (e.g. it was started by a
    // previous login and the user logged out then back in), do not start a
    // second one. The original run is still progressing against the same vault.
    if (migrationInFlightRef.current) return;
    migrationInFlightRef.current = true;
    setIsMigrating(true);
    try {
      // Serialize heavy startup work. Running attachment-path normalization and
      // legacy decryption concurrently on a large vault starves both into
      // IndexedDB transaction aborts. Path normalization must also complete
      // before file decryption reads those paths.
      await runAttachmentPathMigration();
      await runLegacyDecryptMigration(password, saltBase64);
      await runInputStringLowerRepair();
    } finally {
      migrationInFlightRef.current = false;
      setIsMigrating(false);
    }
  }, [runAttachmentPathMigration, runLegacyDecryptMigration, runInputStringLowerRepair]);

  const setupPassword = useCallback(async (password: string) => {
    setIsLoading(true);
    try {
      const salt = generateSalt();
      const saltBase64 = bufferToBase64(salt);
      const hash = await hashPassword(password, salt);

      await saveVaultSettings(saltBase64, hash);

      // Brand-new vault: nothing legacy to scan/decrypt/repair. Mark every
      // one-time startup migration done up front so the very first login of a
      // large fresh vault never walks every big table looking for legacy rows
      // that cannot exist.
      //
      // Guard: only do this when the data DB is genuinely empty. If a vault row
      // is ever created on top of pre-existing data (e.g. an import flow or an
      // upgrade that creates the vault late), marking migrations complete would
      // permanently strand that legacy data unrepaired. We check every table the
      // startup repairs touch (records, attachments, evidence attachments). These
      // counts are indexed and effectively free on a fresh (empty) vault.
      const hasExistingData =
        (await countRecords()) > 0 ||
        (await countAttachments()) > 0 ||
        (await countEvidenceAttachments()) > 0;
      if (hasExistingData) {
        // Pre-existing data under a freshly-created vault: run the repairs now in
        // the background (same fire-and-forget contract as login) so the data is
        // not left unrepaired until some later login.
        runStartupMigrations(password, saltBase64);
      } else {
        await markFreshVaultMigrationsComplete();
      }

      setIsInitialized(true);
      setIsAuthenticated(true);
    } finally {
      setIsLoading(false);
    }
  }, [runStartupMigrations]);

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
        runStartupMigrations(password, settings.salt);
        return true;
      }

      return false;
    } finally {
      setIsLoading(false);
    }
  }, [runStartupMigrations]);

  const logout = useCallback(() => {
    setIsAuthenticated(false);
    // Do NOT clear isMigrating if a startup migration is still running in the
    // background — keep the gate up so a re-login does not mount the data-heavy
    // app on top of the ongoing migration. The migration's own finally resets it.
    if (!migrationInFlightRef.current) {
      setIsMigrating(false);
    }
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
        isMigrating,
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

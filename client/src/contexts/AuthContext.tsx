import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import {
  generateSalt,
  hashPassword,
  verifyPassword,
  bufferToBase64,
  base64ToBuffer,
  deriveKey,
  LEGACY_PBKDF2_ITERATIONS,
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
  isSearchVisibilityRepaired,
  setSearchVisibilityRepaired,
  getVaultKdfIterations,
  upgradeVaultKdfIfNeeded,
} from '@/lib/vault';
import {
  repairInputStringLower,
  repairAddressImportanceTiers,
  detectSearchVisibilityIssues,
  countRecords,
} from '@/lib/data/record-crud';
import { countAttachments } from '@/lib/data/attachments-crud';
import { countEvidenceAttachments } from '@/lib/data/evidence-crud';
import { migrateAttachmentPaths } from '@/lib/attachments';
import { decryptLegacyRecords, getTotalTableCount, countUnrecoveredLegacyRows, type LegacyDecryptProgress, type LockedRecordRef } from '@/lib/legacy-decrypt';
import { decryptLegacyAttachmentFiles, type FileDecryptProgress } from '@/lib/legacy-decrypt-files';
import { getActivityBus } from '@/lib/activity-bus';
import { db, CURRENT_SCHEMA_VERSION } from '@/lib/database';
import {
  subscribeDbUpgradeProgress,
  clearDbUpgradeProgress,
  type DbUpgradeProgress,
} from '@/lib/db-upgrade-progress';

interface AuthContextType {
  isInitialized: boolean | null;
  isAuthenticated: boolean;
  setupPassword: (password: string) => Promise<void>;
  login: (password: string) => Promise<boolean>;
  logout: () => void;
  isLoading: boolean;
  isMigrating: boolean;
  /**
   * Non-null while a one-time Dexie schema upgrade of an older on-disk vault
   * is running (detected before the first open). The UI must show a visible
   * "upgrading" overlay for it — on large vaults this phase can take minutes
   * and previously hid behind the bare "Loading vault..." spinner.
   */
  dbUpgrade: DbUpgradeProgress | null;
  /**
   * Short human label for post-decrypt startup repair phases (attachment path
   * normalization, search-index repair). Shown under the migration spinner so
   * long tail work never looks like a silent hang.
   */
  migrationPhase: string | null;
  legacyMigrationProgress: LegacyDecryptProgress | null;
  legacyMigrationResult: { totalDecrypted: number; totalFailed: number; unexpectedError?: boolean; stillLocked?: number; verificationFailed?: boolean; lockedRecords?: LockedRecordRef[]; lockedRecordsTruncated?: boolean } | null;
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
  const [legacyMigrationResult, setLegacyMigrationResult] = useState<{ totalDecrypted: number; totalFailed: number; unexpectedError?: boolean; stillLocked?: number; verificationFailed?: boolean; lockedRecords?: LockedRecordRef[]; lockedRecordsTruncated?: boolean } | null>(null);
  const [fileDecryptProgress, setFileDecryptProgress] = useState<FileDecryptProgress | null>(null);
  const [dbUpgrade, setDbUpgrade] = useState<DbUpgradeProgress | null>(null);
  const [migrationPhase, setMigrationPhase] = useState<string | null>(null);

  useEffect(() => {
    const checkVault = async () => {
      try {
        // Detect a pending one-time schema upgrade BEFORE anything opens the
        // main database. Opening a vault written by an older release runs the
        // whole Dexie upgrade chain (index rebuilds + data walks) before the
        // first query resolves — minutes on a large vault. Run it eagerly here
        // behind a visible overlay instead of letting it fire lazily under a
        // spinner that looks hung. Feature-detected: indexedDB.databases() is
        // available in Chromium/Electron; elsewhere we silently keep the old
        // lazy-open behavior.
        try {
          if (typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function') {
            const dbs = await indexedDB.databases();
            const main = dbs.find((d) => d.name === 'KYUTXODatabase');
            // Dexie stores schemaVersion * 10 as the raw IndexedDB version.
            if (main?.version && main.version < CURRENT_SCHEMA_VERSION * 10) {
              setDbUpgrade({ version: 0, step: 'Preparing upgrade', rowsProcessed: 0 });
              const unsubscribe = subscribeDbUpgradeProgress((p) => {
                if (p) setDbUpgrade(p);
              });
              try {
                await db.open();
                console.log(`[DbUpgrade] Schema upgrade to v${CURRENT_SCHEMA_VERSION} complete`);
              } finally {
                unsubscribe();
                clearDbUpgradeProgress();
                setDbUpgrade(null);
              }
            }
          }
        } catch (upgradeError) {
          // A failed eager open must not block the login screen: the next
          // query surfaces the same error through the normal paths.
          console.error('[DbUpgrade] Eager schema upgrade failed:', upgradeError);
          setDbUpgrade(null);
        }

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
      const result = await migrateAttachmentPaths((current, total) => {
        setMigrationPhase(`Checking attachment files… ${current} / ${total}`);
      });
      if (result.failed === 0 && result.migrated >= 0) {
        await setAttachmentPathsMigrated(true);
      }
    } catch (error) {
      console.error('Attachment path migration failed:', error);
    } finally {
      setMigrationPhase(null);
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
    // Legacy at-rest payloads were only ever encrypted with a key derived at
    // the pre-strengthening iteration count — ALWAYS derive at LEGACY here,
    // regardless of the vault's current (upgraded) KDF parameters.
    const encryptionKey = await deriveKey(password, salt, LEGACY_PBKDF2_ITERATIONS);

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
      // Track what the verification scan found so the UI can tell the user when
      // some records are still locked and point them to the manual recovery
      // panel. A console.warn alone is invisible to the user.
      let stillLocked = 0;
      let verificationFailed = false;
      let lockedRecords: LockedRecordRef[] = [];
      let lockedRecordsTruncated = false;
      if (decryptSucceeded) {
        try {
          // Surface the verification re-scan in the overlay. Without this the
          // last decrypt progress (e.g. "Evidence Attachments — 100%") stays on
          // screen while the scan re-walks every table, which on a big vault
          // reads as a hang and invites a force-quit.
          const verifyTableCount = getTotalTableCount();
          setLegacyMigrationProgress({
            tableName: 'Preparing',
            tableIndex: 0,
            tableCount: verifyTableCount,
            current: 0,
            total: 0,
            failed: 0,
            phase: 'verify',
          });
          const scan = await countUnrecoveredLegacyRows((p) => {
            setLegacyMigrationProgress({
              tableName: p.tableName,
              tableIndex: p.tableIndex,
              tableCount: p.tableCount,
              current: p.rowsScanned ?? 0,
              total: 0,
              failed: 0,
              phase: 'verify',
            });
            try {
              getActivityBus().publishTask({
                id: 'legacy-decrypt',
                label: 'Verifying Migrated Data',
                phase: `${p.tableName} (table ${p.tableIndex + 1}/${p.tableCount})`,
                current: p.rowsScanned ?? 0,
                total: 0,
              });
            } catch {}
          });
          if (scan.totalUnrecovered > 0) {
            metadataFullyComplete = false;
            stillLocked = scan.totalUnrecovered;
            lockedRecords = scan.lockedRecords;
            lockedRecordsTruncated = scan.lockedRecordsTruncated;
            console.warn(
              `[LegacyDecrypt] Verification found ${scan.totalUnrecovered} still-locked record(s) after decrypt — not marking complete, will retry next login`,
            );
          }
        } catch (err) {
          metadataFullyComplete = false;
          verificationFailed = true;
          console.error('[LegacyDecrypt] Post-decrypt verification scan failed — not marking complete:', err);
        }
      }
      if (metadataFullyComplete) {
        await setLegacyDecryptComplete(true);
      }

      setLegacyMigrationResult({
        totalDecrypted: result.totalDecrypted,
        totalFailed: result.totalFailed + result.tableErrors.length,
        stillLocked,
        verificationFailed,
        lockedRecords,
        lockedRecordsTruncated,
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
      setMigrationPhase('Repairing search index…');
      const result = await repairInputStringLower((scanned) => {
        setMigrationPhase(`Repairing search index… ${scanned.toLocaleString()} records checked`);
      });
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
    } finally {
      setMigrationPhase(null);
    }
  }, []);

  // Background search-visibility repair (Task #1742): detects and fixes the two
  // data classes that make old records unfindable in Records search —
  // missing/invalid importance tiers and desynced inputStringLower search keys.
  // Same repairs as the Database Doctor's manual buttons (shared
  // deriveAddressImportance provenance rules), but run automatically once per
  // vault generation. The flag is re-armed after backup restores, which can
  // reintroduce both classes from old backups. Runs fully in the background
  // (activity bus progress only — never blocks the UI); each repair is
  // keyset-batched and re-runnable, so an interrupted pass simply retries on
  // the next login (flag only set on full success).
  const searchVisibilityRepairInFlightRef = useRef(false);
  const runSearchVisibilityRepair = useCallback(async () => {
    if (searchVisibilityRepairInFlightRef.current) return;
    searchVisibilityRepairInFlightRef.current = true;
    const bus = () => {
      try { return getActivityBus(); } catch { return null; }
    };
    try {
      if (await isSearchVisibilityRepaired()) return;

      const issues = await detectSearchVisibilityIssues((scanned) => {
        bus()?.publishTask({
          id: 'search-visibility-repair',
          label: 'Checking Record Search Health',
          phase: `${scanned.toLocaleString()} records checked`,
          current: scanned,
          total: 0,
        });
      });

      let allOk = true;
      if (issues.tiersAffected) {
        const result = await repairAddressImportanceTiers((scanned, fixed) => {
          bus()?.publishTask({
            id: 'search-visibility-repair',
            label: 'Repairing Record Visibility',
            phase: `Importance tiers — ${scanned.toLocaleString()} checked, ${fixed.toLocaleString()} fixed`,
            current: scanned,
            total: 0,
          });
        });
        if (!result.ok) allOk = false;
        else if (result.fixed > 0) {
          console.log(`[SearchVisibilityRepair] Normalized ${result.fixed} importance tier(s)`);
        }
      }
      if (issues.searchKeysAffected) {
        const result = await repairInputStringLower((scanned, fixed) => {
          bus()?.publishTask({
            id: 'search-visibility-repair',
            label: 'Repairing Record Visibility',
            phase: `Search keys — ${scanned.toLocaleString()} checked, ${fixed.toLocaleString()} fixed`,
            current: scanned,
            total: 0,
          });
        });
        if (!result.ok) allOk = false;
        else if (result.fixed > 0) {
          console.log(`[SearchVisibilityRepair] Rebuilt ${result.fixed} search key(s)`);
        }
      }

      if (allOk) {
        await setSearchVisibilityRepaired(true);
      } else {
        console.warn('[SearchVisibilityRepair] Incomplete — will retry next login');
      }
    } catch (err) {
      console.error('[SearchVisibilityRepair] Failed:', err);
    } finally {
      searchVisibilityRepairInFlightRef.current = false;
      try { getActivityBus().completeTask('search-visibility-repair'); } catch {}
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
      setMigrationPhase(null);
    }
    // Deliberately NOT awaited and launched only after the gated migrations
    // finish (they hold the migration overlay up; this pass must never block
    // the UI). Serialized behind them so it never contends with the legacy
    // decrypt for IndexedDB transactions. Its own single-flight guard makes a
    // quick logout/re-login safe.
    void runSearchVisibilityRepair();
  }, [runAttachmentPathMigration, runLegacyDecryptMigration, runInputStringLowerRepair, runSearchVisibilityRepair]);

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
      // Verify with the KDF parameters the stored hash was derived with
      // (absent on pre-strengthening vaults = legacy 100k).
      const isValid = await verifyPassword(
        password,
        salt,
        settings.passwordHash,
        getVaultKdfIterations(settings),
      );

      if (isValid) {
        setIsAuthenticated(true);
        runStartupMigrations(password, settings.salt);
        // Transparent KDF upgrade: re-derive the stored hash at the current
        // iteration count. Best-effort — a failure here must never block a
        // valid login; the upgrade simply retries on the next unlock.
        try {
          await upgradeVaultKdfIfNeeded(password, settings);
        } catch (error) {
          console.error('KDF upgrade failed (will retry next unlock):', error);
        }
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
        dbUpgrade,
        migrationPhase,
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

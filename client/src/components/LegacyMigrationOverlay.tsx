import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Unlock } from "lucide-react";
import { useAdaptiveLocation } from "@/lib/hashLocation";

export function LegacyMigrationOverlay() {
  const { legacyMigrationProgress, legacyMigrationResult, fileDecryptProgress } = useAuth();
  const [, setLocation] = useAdaptiveLocation();
  const [dismissedMigrationResult, setDismissedMigrationResult] = useState(false);

  if (dismissedMigrationResult) {
    return null;
  }

  if (!legacyMigrationProgress && !legacyMigrationResult && !fileDecryptProgress) {
    return null;
  }

  if (fileDecryptProgress) {
    const hasFileTotal = fileDecryptProgress.total > 0;
    const filePct = hasFileTotal
      ? Math.round((fileDecryptProgress.current / fileDecryptProgress.total) * 100)
      : 0;

    return (
      <div className="fixed inset-0 z-[9999] bg-background/95 flex items-center justify-center" data-testid="file-decrypt-overlay">
        <div className="text-center max-w-md space-y-4 p-6">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto" />
          <div className="text-2xl font-semibold text-foreground">Decrypting Attachment Files</div>
          <p className="text-muted-foreground">
            Restoring encrypted files to their original format.
          </p>
          <div className="w-full bg-muted rounded-full h-2">
            <div
              className={`bg-primary h-2 rounded-full transition-all duration-200 ${hasFileTotal ? '' : 'w-full animate-pulse'}`}
              style={hasFileTotal ? { width: `${filePct}%` } : undefined}
            />
          </div>
          <p className="text-sm text-muted-foreground">
            {hasFileTotal
              ? `${fileDecryptProgress.current} / ${fileDecryptProgress.total} files (${filePct}%)`
              : (fileDecryptProgress.phase || 'Preparing')}
          </p>
          {fileDecryptProgress.decrypted > 0 && (
            <p className="text-xs text-muted-foreground">
              {fileDecryptProgress.decrypted} decrypted, {fileDecryptProgress.skipped} already plain
              {fileDecryptProgress.failed > 0 && `, ${fileDecryptProgress.failed} failed`}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Please do not close the application.
          </p>
        </div>
      </div>
    );
  }

  if (legacyMigrationResult) {
    // The post-decrypt verification scan can find records that are still locked
    // even when the decrypt pass itself reported no errors (a garbage payload
    // can "decrypt" without throwing yet leave the row blank). Surface that to
    // the user so they know their data is not fully unlocked and can run the
    // manual "Restore Locked Data" panel — otherwise the only signal is a
    // console.warn they never see.
    const hasLockedRemaining =
      !legacyMigrationResult.unexpectedError &&
      ((legacyMigrationResult.stillLocked ?? 0) > 0 || !!legacyMigrationResult.verificationFailed);

    const goToRecovery = () => {
      setDismissedMigrationResult(true);
      setLocation("/settings");
    };

    return (
      <div className="fixed inset-0 z-[9999] bg-background/95 flex items-center justify-center" data-testid="legacy-migration-overlay">
        <div className="text-center max-w-md space-y-4 p-6">
          <div className="text-2xl font-semibold text-foreground">Data Migration Complete</div>
          {legacyMigrationResult.unexpectedError ? (
            <p className="text-destructive">
              Migration encountered an unexpected error. Your data is safe — it will be retried on your next login.
            </p>
          ) : (
            <>
              {legacyMigrationResult.totalDecrypted > 0 && (
                <p className="text-muted-foreground">
                  Successfully restored {legacyMigrationResult.totalDecrypted} records.
                </p>
              )}
              {legacyMigrationResult.totalFailed > 0 && (
                <p className="text-destructive">
                  {legacyMigrationResult.totalFailed} records could not be decrypted and were left unchanged.
                  They will be retried on your next login.
                </p>
              )}
              {legacyMigrationResult.totalFailed === 0 &&
                legacyMigrationResult.totalDecrypted > 0 &&
                !hasLockedRemaining && (
                  <p className="text-muted-foreground">
                    All records were successfully migrated.
                  </p>
                )}
            </>
          )}
          {hasLockedRemaining && (
            <div
              className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-left space-y-2"
              data-testid="notice-still-locked"
            >
              <p className="text-sm font-medium text-foreground">
                Some data is still locked
              </p>
              <p className="text-sm text-muted-foreground">
                {legacyMigrationResult.verificationFailed
                  ? "We couldn't confirm that every record was unlocked. Some records may still be locked."
                  : `${legacyMigrationResult.stillLocked} record${
                      legacyMigrationResult.stillLocked === 1 ? "" : "s"
                    } could not be unlocked during login.`}{" "}
                Open <span className="font-medium">Settings → "Restore Locked Data"</span> and enter
                your vault password to recover the rest. Your data is safe in the meantime.
              </p>
              <Button
                size="sm"
                onClick={goToRecovery}
                data-testid="button-open-restore-locked-data"
              >
                <Unlock className="h-4 w-4" />
                Open Restore Locked Data
              </Button>
            </div>
          )}
          <button
            onClick={() => setDismissedMigrationResult(true)}
            className="mt-4 px-4 py-2 bg-primary text-primary-foreground rounded-md"
            data-testid="button-dismiss-migration"
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

  const progress = legacyMigrationProgress!;
  const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <div className="fixed inset-0 z-[9999] bg-background/95 flex items-center justify-center" data-testid="legacy-migration-overlay">
      <div className="text-center max-w-md space-y-4 p-6">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto" />
        <div className="text-2xl font-semibold text-foreground">Migrating Encrypted Data</div>
        {progress.tableIndex > 0 && progress.tableName === 'Preparing' && (
          <p className="text-sm text-muted-foreground">
            Resuming from previous session ({progress.tableIndex} of {progress.tableCount} tables already done)
          </p>
        )}
        <p className="text-muted-foreground">
          Restoring plaintext for: {progress.tableName}
        </p>
        <div className="w-full bg-muted rounded-full h-2">
          <div
            className={`bg-primary h-2 rounded-full transition-all duration-200 ${progress.total > 0 ? '' : 'w-full animate-pulse'}`}
            style={progress.total > 0 ? { width: `${pct}%` } : undefined}
          />
        </div>
        <p className="text-sm text-muted-foreground">
          {progress.total > 0
            ? `${progress.current} / ${progress.total} records (${pct}%)`
            : `${progress.current} records processed`}
          {progress.failed > 0 && ` — ${progress.failed} failed`}
        </p>
        <p className="text-xs text-muted-foreground">
          Table {progress.tableIndex + 1} of {progress.tableCount}
        </p>
        <p className="text-xs text-muted-foreground">
          Please do not close the application.
        </p>
      </div>
    </div>
  );
}

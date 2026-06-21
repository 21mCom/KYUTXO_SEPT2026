import { useCallback, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Loader2,
  Unlock,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  getVaultSettings,
  setLegacyDecryptComplete,
  resetLegacyDecryptProgress,
  addLegacyDecryptCompletedTable,
} from "@/lib/vault";
import { base64ToBuffer, verifyPassword, deriveKey } from "@/lib/crypto";
import {
  decryptLegacyRecords,
  countUnrecoveredLegacyRows,
  type LegacyDecryptProgress,
  type LegacyDecryptResult,
  type UnrecoveredScanProgress,
} from "@/lib/legacy-decrypt";
import {
  isEngineAvailable,
  engineSeedInFlight,
  seedAll,
  type SeedProgress,
} from "@/lib/engine/engine-client";

type RecoveryPhase = "idle" | "decrypting" | "verifying" | "seeding" | "done" | "error";

interface RecoverySummary {
  decrypt: LegacyDecryptResult;
  fullSuccess: boolean;
  remainingUnrecovered: number;
  engineReseeded: boolean;
  engineReseedError: string | null;
}

export default function LegacyRecoveryPanel() {
  const [password, setPassword] = useState("");
  const [phase, setPhase] = useState<RecoveryPhase>("idle");
  const [decryptProgress, setDecryptProgress] = useState<LegacyDecryptProgress | null>(null);
  const [scanProgress, setScanProgress] = useState<UnrecoveredScanProgress | null>(null);
  const [seedProgress, setSeedProgress] = useState<SeedProgress | null>(null);
  const [summary, setSummary] = useState<RecoverySummary | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Keep the running flag in a ref so re-entrant clicks cannot start a second
  // recovery pass over the same vault.
  const runningRef = useRef(false);

  const isRunning = phase === "decrypting" || phase === "verifying" || phase === "seeding";

  const runRecovery = useCallback(async () => {
    if (!password || runningRef.current) return;
    runningRef.current = true;
    setErrorMessage(null);
    setSummary(null);
    setDecryptProgress(null);
    setScanProgress(null);
    setSeedProgress(null);
    setPhase("decrypting");

    try {
      const settings = await getVaultSettings();
      if (!settings) {
        throw new Error("No vault settings found.");
      }
      const salt = base64ToBuffer(settings.salt);
      const valid = await verifyPassword(password, salt, settings.passwordHash);
      if (!valid) {
        setPhase("error");
        setErrorMessage("Incorrect password. The current password is the key that unlocks your data — recovery cannot run without it.");
        return;
      }
      const key = await deriveKey(password, salt);

      // Clear any wrongly-recorded completion so the decrypt pass revisits EVERY
      // table from scratch. A past bug could mark the migration complete after a
      // mid-table abort, permanently short-circuiting login decryption.
      await resetLegacyDecryptProgress();

      const decrypt = await decryptLegacyRecords(
        key,
        (p) => setDecryptProgress(p),
        {
          // No alreadyCompletedTables: deliberately re-scan everything.
          onTableComplete: addLegacyDecryptCompletedTable,
        },
      );

      // Independently verify the result. A payload can decrypt and write yet
      // still leave the row's sentinel blank/placeholder (malformed payload),
      // and any row that failed to decrypt stays locked too. This re-scan is the
      // honest source of truth for "is anything still locked?" — we never claim
      // success on decrypt counts alone.
      setPhase("verifying");
      const scan = await countUnrecoveredLegacyRows((p) => setScanProgress(p));

      // Only mark the whole migration complete when nothing failed AND the
      // verification found zero rows still locked. Otherwise leave the flag false
      // so login keeps trying and the user can re-run recovery.
      const fullSuccess =
        decrypt.totalFailed === 0 &&
        decrypt.tableErrors.length === 0 &&
        scan.totalUnrecovered === 0;
      if (fullSuccess) {
        await setLegacyDecryptComplete(true);
      }

      // Refresh the native read-engine mirror so fast reads reflect the newly
      // restored plaintext. This is a SEPARATE, best-effort step: a mirror
      // refresh failure must never mask a successful data restore, so we capture
      // its error instead of throwing out of the whole recovery. No-op in the
      // browser preview where the engine is unavailable.
      let engineReseeded = false;
      let engineReseedError: string | null = null;
      if (isEngineAvailable()) {
        setPhase("seeding");
        try {
          // Never start a rebuild on top of an in-flight seed: a second stream
          // after a shared seedBegin would corrupt the mirror. Wait it out first.
          while (engineSeedInFlight()) {
            await seedAll();
          }
          await seedAll((p) => setSeedProgress(p));
          engineReseeded = true;
        } catch (err) {
          engineReseedError = err instanceof Error ? err.message : String(err);
        }
      }

      setSummary({
        decrypt,
        fullSuccess,
        remainingUnrecovered: scan.totalUnrecovered,
        engineReseeded,
        engineReseedError,
      });
      setPhase("done");
    } catch (err) {
      setPhase("error");
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      runningRef.current = false;
      setPassword("");
    }
  }, [password]);

  const decryptPct =
    decryptProgress && decryptProgress.total > 0
      ? Math.min(100, Math.round((decryptProgress.current / decryptProgress.total) * 100))
      : null;

  const seedPct =
    seedProgress && seedProgress.overallTotal > 0
      ? Math.min(100, Math.round((seedProgress.overallProcessed / seedProgress.overallTotal) * 100))
      : null;

  const scanPct =
    scanProgress && scanProgress.tableCount > 0
      ? Math.min(100, Math.round((scanProgress.tableIndex / scanProgress.tableCount) * 100))
      : null;

  return (
    <Card data-testid="card-legacy-recovery">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Unlock className="h-5 w-5" />
          Restore Locked Data
        </CardTitle>
        <CardDescription>
          If some of your records show up blank or as "[encrypted]", their real
          values may still be safely stored in an older encrypted form that was
          never finished unlocking. Enter your current vault password to restore
          them. This reads through every table and can take a while on large
          vaults — keep the app open until it finishes. It only restores data;
          it never deletes anything.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="recovery-password">Vault password</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="recovery-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your vault password"
              className="max-w-xs"
              disabled={isRunning}
              data-testid="input-recovery-password"
              onKeyDown={(e) => {
                if (e.key === "Enter" && password && !isRunning) runRecovery();
              }}
            />
            <Button
              onClick={runRecovery}
              disabled={isRunning || !password}
              data-testid="button-run-recovery"
            >
              {isRunning ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Unlock className="h-4 w-4 mr-2" />
              )}
              {isRunning ? "Restoring..." : "Restore locked data"}
            </Button>
          </div>
        </div>

        {phase === "decrypting" && (
          <div className="space-y-2" data-testid="section-recovery-decrypting">
            <div className="flex items-center justify-between gap-2 flex-wrap text-sm">
              <span className="font-medium">
                Restoring{decryptProgress ? `: ${decryptProgress.tableName}` : "..."}
              </span>
              {decryptProgress && (
                <span className="font-mono text-xs text-muted-foreground">
                  Table {decryptProgress.tableIndex + 1} of {decryptProgress.tableCount}
                  {decryptProgress.total > 0
                    ? ` · ${decryptProgress.current.toLocaleString()} / ${decryptProgress.total.toLocaleString()}`
                    : ` · ${decryptProgress.current.toLocaleString()} scanned`}
                  {decryptProgress.failed > 0 ? ` · ${decryptProgress.failed} failed` : ""}
                </span>
              )}
            </div>
            <Progress value={decryptPct ?? undefined} className={decryptPct === null ? "animate-pulse" : ""} />
          </div>
        )}

        {phase === "verifying" && (
          <div className="space-y-2" data-testid="section-recovery-verifying">
            <div className="flex items-center justify-between gap-2 flex-wrap text-sm">
              <span className="font-medium">
                Checking what's still locked{scanProgress ? `: ${scanProgress.tableName}` : "..."}
              </span>
              {scanProgress && (
                <span className="font-mono text-xs text-muted-foreground">
                  Table {scanProgress.tableIndex + 1} of {scanProgress.tableCount}
                </span>
              )}
            </div>
            <Progress value={scanPct ?? undefined} className={scanPct === null ? "animate-pulse" : ""} />
          </div>
        )}

        {phase === "seeding" && (
          <div className="space-y-2" data-testid="section-recovery-seeding">
            <div className="flex items-center justify-between gap-2 flex-wrap text-sm">
              <span className="font-medium flex items-center gap-2">
                <Database className="h-4 w-4" />
                Refreshing fast-search index
              </span>
              {seedProgress && (
                <span className="font-mono text-xs text-muted-foreground">
                  {seedProgress.overallProcessed.toLocaleString()} / {seedProgress.overallTotal.toLocaleString()}
                </span>
              )}
            </div>
            <Progress value={seedPct ?? undefined} className={seedPct === null ? "animate-pulse" : ""} />
          </div>
        )}

        {phase === "error" && errorMessage && (
          <div
            className="rounded-md border border-destructive/40 bg-destructive/10 p-3 flex items-start gap-2"
            data-testid="recovery-error"
          >
            <XCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
            <div className="text-sm text-destructive">{errorMessage}</div>
          </div>
        )}

        {phase === "done" && summary && (
          <div className="space-y-3" data-testid="section-recovery-results">
            <div
              className={`rounded-md border p-3 flex items-start gap-2 ${
                summary.fullSuccess
                  ? "border-green-600/40 bg-green-600/10 dark:border-green-400/40"
                  : "border-yellow-600/40 bg-yellow-600/10 dark:border-yellow-400/40"
              }`}
            >
              {summary.fullSuccess ? (
                <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400 mt-0.5 shrink-0" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400 mt-0.5 shrink-0" />
              )}
              <div className="text-sm space-y-1">
                <div className="font-medium" data-testid="text-recovery-headline">
                  {summary.fullSuccess
                    ? `Restored ${summary.decrypt.totalDecrypted.toLocaleString()} records. Everything is unlocked.`
                    : `Restored ${summary.decrypt.totalDecrypted.toLocaleString()} records, but some data is still locked.`}
                </div>
                {summary.remainingUnrecovered > 0 && (
                  <div className="text-muted-foreground" data-testid="text-recovery-remaining">
                    {summary.remainingUnrecovered.toLocaleString()} records are still locked after
                    this pass. You can safely run "Restore locked data" again with the correct
                    password. Nothing was deleted, and the still-locked data is untouched.
                  </div>
                )}
                {summary.decrypt.totalFailed > 0 && (
                  <div className="text-muted-foreground" data-testid="text-recovery-failed">
                    {summary.decrypt.totalFailed.toLocaleString()} rows failed to decrypt. This
                    usually means a different password than the one that originally
                    encrypted them. The vault was left ready to retry — nothing was deleted.
                  </div>
                )}
                {summary.decrypt.tableErrors.length > 0 && (
                  <ul className="text-muted-foreground list-disc pl-5">
                    {summary.decrypt.tableErrors.map((msg, i) => (
                      <li key={i}>{msg}</li>
                    ))}
                  </ul>
                )}
                {summary.engineReseeded && (
                  <div className="text-muted-foreground">Fast-search index refreshed.</div>
                )}
                {summary.engineReseedError && (
                  <div className="text-muted-foreground" data-testid="text-recovery-reseed-error">
                    Your data was restored, but refreshing the fast-search index failed
                    ({summary.engineReseedError}). Your records are safe — the index will
                    rebuild on the next launch.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

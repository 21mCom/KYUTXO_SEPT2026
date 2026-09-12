import { useCallback, useState } from "react";
import { Loader2, Play, Search, ShieldCheck, XCircle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getVaultSettings, getLegacyDecryptCompletedTables, verifyVaultPassword } from "@/lib/vault";
import { base64ToBuffer, deriveKey, LEGACY_PBKDF2_ITERATIONS } from "@/lib/crypto";
import { auditLegacyPayloads, type LegacyAuditResult } from "@/lib/legacy-decrypt";

type AuditPhase = "idle" | "running" | "done" | "error";

export default function MigrationAuditPanel() {
  const [password, setPassword] = useState("");
  const [phase, setPhase] = useState<AuditPhase>("idle");
  const [result, setResult] = useState<LegacyAuditResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isRunning = phase === "running";

  const runAudit = useCallback(async () => {
    if (!password) return;
    setPhase("running");
    setErrorMessage(null);
    setResult(null);
    try {
      const settings = await getVaultSettings();
      if (!settings) {
        throw new Error("No vault settings found.");
      }
      const salt = base64ToBuffer(settings.salt);
      const valid = await verifyVaultPassword(password, settings);
      if (!valid) {
        setPhase("error");
        setErrorMessage("Incorrect password.");
        return;
      }
      // Legacy payloads were only ever encrypted at the legacy iteration count.
      const key = await deriveKey(password, salt, LEGACY_PBKDF2_ITERATIONS);
      const completed = await getLegacyDecryptCompletedTables();
      const audit = await auditLegacyPayloads(key, { alreadyCompletedTables: completed });
      setResult(audit);
      setPhase("done");
    } catch (err) {
      setPhase("error");
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setPassword("");
    }
  }, [password]);

  return (
    <Card data-testid="card-migration-audit">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Search className="h-5 w-5" />
          Migration Recovery Audit
        </CardTitle>
        <CardDescription>
          A read-only check that decrypts a small sample from each table and
          reports which fields still exist in the encrypted data, how many rows
          can still be recovered, and which tables were already migrated. It never
          changes or deletes anything, and only shows field names and counts —
          never your actual data.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="audit-password">Vault password</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="audit-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your vault password"
              className="max-w-xs"
              disabled={isRunning}
              data-testid="input-audit-password"
              onKeyDown={(e) => {
                if (e.key === "Enter" && password && !isRunning) runAudit();
              }}
            />
            <Button
              onClick={runAudit}
              disabled={isRunning || !password}
              data-testid="button-run-audit"
            >
              {isRunning ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Play className="h-4 w-4 mr-2" />
              )}
              {isRunning ? "Auditing..." : "Run audit"}
            </Button>
          </div>
        </div>

        {phase === "error" && errorMessage && (
          <div
            className="rounded-md border border-destructive/40 bg-destructive/10 p-3 flex items-start gap-2"
            data-testid="audit-error"
          >
            <XCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
            <div className="text-sm text-destructive">{errorMessage}</div>
          </div>
        )}

        {phase === "done" && result && (
          <div className="space-y-2" data-testid="section-audit-results">
            <div className="text-sm font-medium">Per-table results</div>
            <div className="grid gap-2">
              {result.tables.map((t) => (
                <div
                  key={t.tableName}
                  className="rounded-md border p-3 space-y-1 text-sm"
                  data-testid={`audit-result-${t.tableName.replace(/\s+/g, "-")}`}
                >
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="font-medium flex items-center gap-2">
                      {t.alreadyMigrated ? (
                        <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                      ) : (
                        <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                      )}
                      {t.tableName}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {t.totalRows} rows · {t.encryptedRows} recoverable
                      {t.alreadyMigrated ? " · already migrated" : ""}
                    </span>
                  </div>
                  {t.decryptFailures > 0 && (
                    <div className="text-xs text-destructive">
                      {t.decryptFailures} of {t.sampledRows} sampled rows failed to
                      decrypt (wrong password or corrupted data).
                    </div>
                  )}
                  {t.fieldNames.length > 0 ? (
                    <div className="text-xs text-muted-foreground">
                      Fields in payload:{" "}
                      <span className="font-mono">{t.fieldNames.join(", ")}</span>
                    </div>
                  ) : t.encryptedRows > 0 ? (
                    <div className="text-xs text-muted-foreground italic">
                      No field names read from the sample.
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground italic">
                      No encrypted data remaining.
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

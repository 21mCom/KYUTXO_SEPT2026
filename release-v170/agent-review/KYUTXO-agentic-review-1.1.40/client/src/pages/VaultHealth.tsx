import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Database,
  HeartPulse,
  Loader2,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getVaultHealthStatus,
  runVaultHealthCheck,
  VaultHealthCancelledError,
  type VaultHealthSnapshot,
  type VaultHealthStatus,
} from "@/lib/vault-health";

type Phase = "checking" | "done" | "failed" | "cancelled";

const STATUS_LABELS: Record<VaultHealthStatus, string> = {
  healthy: "Healthy",
  warning: "Needs attention",
  problem: "Problem found",
};

function formatCount(value: number): string {
  return value.toLocaleString();
}

function formatDate(value?: number): string {
  return value ? new Date(value).toLocaleString() : "Never";
}

function StatusIcon({ status }: { status: VaultHealthStatus }) {
  if (status === "healthy") return <CheckCircle2 className="h-5 w-5 text-emerald-600" />;
  if (status === "problem") return <XCircle className="h-5 w-5 text-destructive" />;
  return <AlertTriangle className="h-5 w-5 text-amber-600" />;
}

function CategoryCard({
  title,
  description,
  status,
  count,
  detail,
  action,
  actionLabel,
  testId,
}: {
  title: string;
  description: string;
  status: VaultHealthStatus;
  count: number;
  detail: string;
  action: string;
  actionLabel: string;
  testId: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <StatusIcon status={status} />
            <div>
              <CardTitle className="text-base">{title}</CardTitle>
              <CardDescription className="mt-1">{description}</CardDescription>
            </div>
          </div>
          <Badge
            variant={status === "problem" ? "destructive" : status === "warning" ? "outline" : "secondary"}
            className={status === "warning" ? "border-amber-300 text-amber-700 dark:text-amber-400" : ""}
          >
            {STATUS_LABELS[status]}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold">{formatCount(count)}</span>
          <span className="text-sm text-muted-foreground">affected records</span>
        </div>
        <p className="text-sm text-muted-foreground">{detail}</p>
        <Link href={action} data-testid={`${testId}-link`}>
          <Button variant="outline" size="sm" data-testid={`${testId}-action`}>
            {actionLabel}
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}

function Summary({
  snapshot,
  phase,
}: {
  snapshot: VaultHealthSnapshot | null;
  phase: Phase;
}) {
  if (phase === "checking") {
    return (
      <Card data-testid="card-health-summary-checking">
        <CardContent className="flex items-center gap-3 py-6">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <div>
            <p className="font-medium">Checking your local vault…</p>
            <p className="text-sm text-muted-foreground">This is read-only and may take a little while on a large vault.</p>
          </div>
        </CardContent>
      </Card>
    );
  }
  if (phase === "failed") {
    return (
      <Card className="border-destructive/40 bg-destructive/5" data-testid="card-health-summary-failed">
        <CardContent className="flex items-center gap-3 py-6">
          <CircleAlert className="h-6 w-6 text-destructive" />
          <div>
            <p className="font-medium text-destructive">The health check failed</p>
            <p className="text-sm text-muted-foreground">No repair was attempted. Retry the read-only check.</p>
          </div>
        </CardContent>
      </Card>
    );
  }
  if (phase === "cancelled" || !snapshot) {
    return (
      <Card data-testid="card-health-summary-cancelled">
        <CardContent className="flex items-center gap-3 py-6">
          <ShieldCheck className="h-6 w-6 text-muted-foreground" />
          <div>
            <p className="font-medium">No health result yet</p>
            <p className="text-sm text-muted-foreground">Run the check whenever you are ready.</p>
          </div>
        </CardContent>
      </Card>
    );
  }
  const status = getVaultHealthStatus(snapshot);
  return (
    <Card data-testid="card-health-summary">
      <CardContent className="flex items-center justify-between gap-4 py-6 flex-wrap">
        <div className="flex items-center gap-3">
          <StatusIcon status={status} />
          <div>
            <p className="text-lg font-semibold" data-testid="text-health-verdict">
              {status === "healthy" ? "Your vault is healthy" : `Your vault ${status === "problem" ? "has problems" : "needs attention"}`}
            </p>
            <p className="text-sm text-muted-foreground">
              {formatCount(snapshot.integrity.totalRecords)} local records checked · Last checked {formatDate(snapshot.checkedAt)}
            </p>
          </div>
        </div>
        <Badge variant={status === "problem" ? "destructive" : status === "warning" ? "outline" : "secondary"}>
          {STATUS_LABELS[status]}
        </Badge>
      </CardContent>
    </Card>
  );
}

export default function VaultHealth() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [snapshot, setSnapshot] = useState<VaultHealthSnapshot | null>(null);
  const [progress, setProgress] = useState("Preparing read-only checks…");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const runTokenRef = useRef(0);

  const runCheck = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const token = ++runTokenRef.current;
    setPhase("checking");
    setSnapshot(null);
    setErrorMessage(null);
    setProgress("Preparing read-only checks…");
    try {
      const result = await runVaultHealthCheck({
        signal: controller.signal,
        onProgress: ({ phase: nextPhase, processed, total }) => {
          if (token !== runTokenRef.current) return;
          setProgress(
            processed != null && total != null
              ? `${nextPhase} ${formatCount(processed)} of ${formatCount(total)}`
              : nextPhase,
          );
        },
      });
      if (token !== runTokenRef.current) return;
      setSnapshot(result);
      setPhase("done");
      setProgress("");
    } catch (error) {
      if (token !== runTokenRef.current) return;
      if (error instanceof VaultHealthCancelledError || controller.signal.aborted) {
        setPhase("cancelled");
        setProgress("");
      } else {
        setPhase("failed");
        setErrorMessage(error instanceof Error ? error.message : String(error));
        setProgress("");
      }
    } finally {
      if (token === runTokenRef.current) controllerRef.current = null;
    }
  }, []);

  useEffect(() => {
    void runCheck();
    return () => {
      runTokenRef.current += 1;
      controllerRef.current?.abort();
    };
  }, [runCheck]);

  const cancelCheck = () => {
    controllerRef.current?.abort();
    setProgress("Cancelling…");
  };

  const overallError = snapshot?.integrity.tableErrors ?? 0;
  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-5xl mx-auto p-6 space-y-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold flex items-center gap-2" data-testid="text-page-title">
              <HeartPulse className="h-6 w-6" />
              Vault Health
            </h1>
            <p className="text-sm text-muted-foreground mt-2 max-w-3xl">
              One read-only view of your local vault’s integrity, metadata, conflicts, sync freshness, backup readiness, and privacy findings. Nothing is changed by refreshing or checking.
            </p>
          </div>
          <div className="flex gap-2">
            {phase === "checking" ? (
              <Button variant="outline" onClick={cancelCheck} data-testid="button-cancel-health-check">
                Cancel check
              </Button>
            ) : (
              <Button onClick={() => void runCheck()} data-testid="button-refresh-health">
                <RefreshCw className="mr-2 h-4 w-4" />
                Refresh check
              </Button>
            )}
          </div>
        </div>

        {phase === "checking" && (
          <div className="rounded-md border bg-muted/40 px-4 py-3 text-sm text-muted-foreground" data-testid="text-health-progress">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              {progress}
            </div>
          </div>
        )}
        {phase === "failed" && errorMessage && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive" data-testid="banner-health-error">
            {errorMessage}
          </div>
        )}
        <Summary snapshot={snapshot} phase={phase} />

        {snapshot && phase === "done" && (
          <div className="grid gap-4 md:grid-cols-2">
            <CategoryCard
              title="Integrity"
              description="Checks whether stored records and local tables can be read safely."
              status={snapshot.integrity.lockedUnreadable || overallError ? "problem" : snapshot.integrity.blankIdentifiers ? "warning" : "healthy"}
              count={snapshot.integrity.lockedUnreadable + snapshot.integrity.blankIdentifiers + snapshot.integrity.tableErrors}
              detail={snapshot.integrity.lockedUnreadable > 0 ? `${formatCount(snapshot.integrity.lockedUnreadable)} records still look locked or unreadable.` : overallError > 0 ? `${formatCount(overallError)} local table${overallError === 1 ? "" : "s"} could not be read.` : "All checked local tables and record identifiers are readable."}
              action="/database-doctor"
              actionLabel="Open Database Doctor"
              testId="card-health-integrity"
            />
            <CategoryCard
              title="Metadata"
              description="Finds metadata that can be hidden, stale, or skipped by indexed views."
              status={snapshot.metadata.canonicalIdentifierCollisions > 0 ? "problem" : snapshot.metadata.missingTier + snapshot.metadata.invalidTier + snapshot.metadata.searchKeyDesynced + snapshot.metadata.staleTypeFields + snapshot.metadata.nonCanonicalIdentifiers + snapshot.metadata.hiddenTagged > 0 ? "warning" : "healthy"}
              count={snapshot.metadata.missingTier + snapshot.metadata.invalidTier + snapshot.metadata.searchKeyDesynced + snapshot.metadata.staleTypeFields + snapshot.metadata.nonCanonicalIdentifiers + snapshot.metadata.canonicalIdentifierCollisions + snapshot.metadata.hiddenTagged}
              detail={snapshot.metadata.canonicalIdentifierCollisions > 0 ? `${formatCount(snapshot.metadata.canonicalIdentifierCollisions)} non-canonical records collide with another identifier; review before normalizing.` : snapshot.metadata.hiddenTagged > 0 ? `${formatCount(snapshot.metadata.hiddenTagged)} discovered records have your labels, tags, or notes and are hidden from the default Records view.` : "No stale or incomplete metadata was found."}
              action="/database-doctor"
              actionLabel="Review metadata checks"
              testId="card-health-metadata"
            />
            <CategoryCard
              title="Metadata conflicts"
              description="Compares values from multiple import sources without changing them."
              status={snapshot.conflicts.records > 0 ? "warning" : "healthy"}
              count={snapshot.conflicts.records}
              detail={snapshot.conflicts.records > 0 ? `${formatCount(snapshot.conflicts.fields)} field conflict${snapshot.conflicts.fields === 1 ? "" : "s"} across ${formatCount(snapshot.conflicts.records)} record${snapshot.conflicts.records === 1 ? "" : "s"} need review.` : "No unresolved metadata conflicts were found."}
              action="/conflict-resolution"
              actionLabel="Review conflicts"
              testId="card-health-conflicts"
            />
            <CategoryCard
              title="Sync freshness"
              description="Checks whether address records have a recent local sync checkpoint."
              status={snapshot.sync.unavailable ? "problem" : snapshot.sync.neverSynced + snapshot.sync.stale > 0 ? "warning" : "healthy"}
              count={snapshot.sync.neverSynced + snapshot.sync.stale}
              detail={snapshot.sync.unavailable ? "The local sync-state store could not be read. No sync was started; open sync tools after reviewing the vault integrity problem." : snapshot.sync.addressRecords === 0 ? "There are no address records to sync yet." : `${formatCount(snapshot.sync.neverSynced)} never synced and ${formatCount(snapshot.sync.stale)} have not synced in the last 30 days. Latest checkpoint: ${formatDate(snapshot.sync.latestSyncedAt)}.`}
              action="/transaction-sync"
              actionLabel="Open sync tools"
              testId="card-health-sync"
            />
            <CategoryCard
              title="Backup readiness"
              description="Confirms the local tables are readable and a local backup can be created."
              status={snapshot.backup.canExport ? "healthy" : "problem"}
              count={snapshot.backup.canExport ? 0 : snapshot.integrity.tableErrors}
              detail={snapshot.backup.canExport ? `${formatCount(snapshot.backup.recordCount)} records and ${formatCount(snapshot.backup.attachmentCount)} attachments are available to export. Backups are manual and stay on your device.` : "Some local tables could not be read, so create a backup after resolving the integrity problem."}
              action="/export"
              actionLabel="Create a backup"
              testId="card-health-backup"
            />
            <CategoryCard
              title="Privacy findings"
              description="Shows the latest saved Privacy Audit result without running a new analysis."
              status={snapshot.privacy.unavailable ? "problem" : !snapshot.privacy.hasRun || snapshot.privacy.interrupted ? "warning" : snapshot.privacy.criticalOrHigh > 0 ? "problem" : snapshot.privacy.findings > 0 ? "warning" : "healthy"}
              count={snapshot.privacy.findings}
              detail={snapshot.privacy.unavailable ? "The saved Privacy Audit history could not be read. No new audit was run; open Privacy Audit after reviewing the vault integrity problem." : !snapshot.privacy.hasRun ? "No Privacy Audit has been completed yet." : snapshot.privacy.interrupted ? "The last Privacy Audit was interrupted. Run it again to get a complete result." : `${formatCount(snapshot.privacy.findings)} finding${snapshot.privacy.findings === 1 ? "" : "s"} in the latest audit${snapshot.privacy.score != null ? ` (score ${snapshot.privacy.score})` : ""}, completed ${formatDate(snapshot.privacy.lastRunAt)}.`}
              action="/privacy-audit"
              actionLabel="Open Privacy Audit"
              testId="card-health-privacy"
            />
          </div>
        )}
      </div>
    </div>
  );
}
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Loader2,
  Play,
  Square,
  Trash2,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  stripLegacyMarkers,
  type StripMarkersProgress,
  type StripMarkersResult,
  type StripMarkersTableResult,
} from "@/lib/legacy-decrypt";

type StripPhase = "idle" | "running" | "done" | "cancelled" | "error";

interface StripState {
  phase: StripPhase;
  progress: StripMarkersProgress | null;
  result: StripMarkersResult | null;
  errorMessage?: string;
}

const initialState: StripState = {
  phase: "idle",
  progress: null,
  result: null,
};

interface StripMarkersPanelProps {
  disabled?: boolean;
  onRunningChange?: (running: boolean) => void;
}

export default function StripMarkersPanel({ disabled = false, onRunningChange }: StripMarkersPanelProps) {
  const [state, setState] = useState<StripState>(initialState);
  const abortRef = useRef<AbortController | null>(null);

  const runStrip = useCallback(async () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setState({ phase: "running", progress: null, result: null });

    try {
      const result = await stripLegacyMarkers(
        (progress) => {
          setState((prev) => ({ ...prev, progress }));
        },
        ctrl.signal,
      );

      if (ctrl.signal.aborted) {
        setState((prev) => ({
          ...prev,
          phase: "cancelled",
          result,
        }));
      } else {
        setState({ phase: "done", progress: null, result });
      }
    } catch (err) {
      if (!ctrl.signal.aborted) {
        console.error("[StripMarkersPanel] Strip failed:", err);
        setState((prev) => ({
          ...prev,
          phase: "error",
          errorMessage: err instanceof Error ? err.message : String(err),
        }));
      }
    } finally {
      abortRef.current = null;
    }
  }, []);

  const cancelStrip = useCallback(() => {
    abortRef.current?.abort();
    setState((prev) => ({ ...prev, phase: "cancelled" }));
  }, []);

  const isRunning = state.phase === "running";
  const isDone = state.phase === "done" || state.phase === "cancelled" || state.phase === "error";

  useEffect(() => {
    onRunningChange?.(isRunning);
  }, [isRunning, onRunningChange]);

  const progressPct =
    state.progress && state.progress.tableCount > 0
      ? ((state.progress.tableIndex + 1) / state.progress.tableCount) * 100
      : 0;

  return (
    <Card data-testid="card-strip-markers">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <Trash2 className="h-4 w-4" />
              Strip Stale Markers
            </CardTitle>
            <CardDescription>
              Remove leftover legacy marker fields (
              <code className="text-xs">_legacyEncryptedPayload</code>,{" "}
              <code className="text-xs">isEncrypted</code>,{" "}
              <code className="text-xs">encryptedPayload</code>) from every
              table. All sensitive values are already plaintext — this only
              deletes the stale housekeeping keys.
            </CardDescription>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {!isRunning ? (
            <Button
              onClick={runStrip}
              disabled={disabled}
              data-testid="button-strip-markers"
            >
              <Play className="h-4 w-4 mr-2" />
              Strip stale markers
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={cancelStrip}
              data-testid="button-cancel-strip"
            >
              <Square className="h-4 w-4 mr-2" />
              Cancel
            </Button>
          )}
          {isRunning && (
            <span className="text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              {state.progress
                ? `${state.progress.phase === "verify" ? "Verifying" : "Processing"} ${state.progress.tableName} (${state.progress.tableIndex + 1} / ${state.progress.tableCount})…`
                : "Starting…"}
            </span>
          )}
        </div>

        {isRunning && state.progress && (
          <div className="space-y-1" data-testid="progress-strip">
            <div className="flex items-center justify-between text-xs text-muted-foreground gap-2 flex-wrap">
              <span>
                Table {state.progress.tableIndex + 1} /{" "}
                {state.progress.tableCount}: {state.progress.tableName}
              </span>
              <span>{state.progress.rowsCleaned} rows cleaned so far</span>
            </div>
            <Progress value={progressPct} />
          </div>
        )}

        {isDone && state.result && (
          <StripResultBanner phase={state.phase} result={state.result} errorMessage={state.errorMessage} />
        )}

        {isDone && state.result && state.result.tableResults.length > 0 && (
          <div className="space-y-1" data-testid="section-strip-table-results">
            <div className="text-sm font-medium">Per-table summary</div>
            <div className="grid gap-1 text-xs">
              {state.result.tableResults
                .filter((t) => t.rowsBefore > 0)
                .map((t) => (
                  <TableResultRow
                    key={t.tableName}
                    result={t}
                  />
                ))}
              {state.result.tableResults.every((t) => t.rowsBefore === 0) && (
                <div className="text-muted-foreground italic" data-testid="text-no-markers-found">
                  No stale marker fields were found in any table.
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TableResultRow({ result }: { result: StripMarkersTableResult }) {
  const allClean = result.rowsRemaining === 0;
  return (
    <div
      className="flex items-center justify-between gap-2 rounded-md border p-2 flex-wrap"
      data-testid={`strip-result-${result.tableName.replace(/\s+/g, "-")}`}
    >
      <span>{result.tableName}</span>
      <span className="font-mono text-muted-foreground flex items-center gap-2">
        {result.rowsBefore} before → {result.rowsCleaned} cleaned
        {allClean ? (
          <CheckCircle2 className="h-3 w-3 text-green-600 dark:text-green-400" data-testid={`icon-clean-${result.tableName.replace(/\s+/g, "-")}`} />
        ) : (
          <span className="text-destructive">({result.rowsRemaining} remaining)</span>
        )}
      </span>
    </div>
  );
}

function StripResultBanner({
  phase,
  result,
  errorMessage,
}: {
  phase: StripPhase;
  result: StripMarkersResult;
  errorMessage?: string;
}) {
  if (phase === "error") {
    return (
      <div
        className="rounded-md border border-destructive/40 bg-destructive/10 p-3 flex items-start gap-2"
        data-testid="strip-verdict-error"
      >
        <XCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
        <div className="text-sm">
          <div className="font-medium text-destructive">Strip failed</div>
          <div className="text-muted-foreground">{errorMessage ?? "Unknown error"}</div>
        </div>
      </div>
    );
  }

  if (phase === "cancelled") {
    return (
      <div
        className="rounded-md border p-3 flex items-start gap-2"
        data-testid="strip-verdict-cancelled"
      >
        <XCircle className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
        <div className="text-sm">
          <div className="font-medium">Cancelled</div>
          <div className="text-muted-foreground">
            {result.totalCleaned > 0
              ? `${result.totalCleaned} row${result.totalCleaned === 1 ? "" : "s"} were cleaned before cancellation.`
              : "No rows were cleaned before cancellation."}
          </div>
        </div>
      </div>
    );
  }

  const hasErrors = result.tableErrors.length > 0;
  const hasVerificationErrors = result.verificationErrors.length > 0;
  const verifiedClean = result.totalRemaining === 0 && !hasVerificationErrors;

  if (result.totalBefore === 0) {
    const anyIssue = hasErrors || hasVerificationErrors;
    return (
      <div
        className={`rounded-md border p-3 flex items-start gap-2 ${
          anyIssue
            ? "border-destructive/40 bg-destructive/10"
            : "border-green-500/40 bg-green-500/10"
        }`}
        data-testid="strip-verdict-clean"
      >
        {anyIssue ? (
          <XCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
        ) : (
          <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400 mt-0.5 shrink-0" />
        )}
        <div className="text-sm">
          <div className={`font-medium ${anyIssue ? "text-destructive" : "text-green-700 dark:text-green-300"}`}>
            {hasErrors
              ? "Completed with errors — no rows cleaned"
              : hasVerificationErrors
              ? "No markers found — verification incomplete"
              : "No stale markers found"}
          </div>
          <div className="text-muted-foreground">
            {hasErrors
              ? "Errors prevented some tables from being processed."
              : hasVerificationErrors
              ? "Verification could not confirm all tables are clean — some reads failed."
              : "Every table was already free of legacy marker fields."}
          </div>
          {anyIssue && (
            <ul className="mt-1 space-y-0.5 text-xs text-destructive list-disc list-inside">
              {result.tableErrors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
              {result.verificationErrors.map((e, i) => (
                <li key={`v-${i}`}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  const verdictColor = !verifiedClean
    ? "border-destructive/40 bg-destructive/10"
    : hasErrors
    ? "border-yellow-500/40 bg-yellow-500/10"
    : "border-green-500/40 bg-green-500/10";

  const iconColor = !verifiedClean
    ? "text-destructive"
    : hasErrors
    ? "text-yellow-600 dark:text-yellow-400"
    : "text-green-600 dark:text-green-400";

  const titleColor = !verifiedClean
    ? "text-destructive"
    : hasErrors
    ? "text-yellow-700 dark:text-yellow-300"
    : "text-green-700 dark:text-green-300";

  return (
    <div
      className={`rounded-md border p-3 flex items-start gap-2 ${verdictColor}`}
      data-testid="strip-verdict-done"
    >
      {verifiedClean ? (
        <CheckCircle2 className={`h-4 w-4 mt-0.5 shrink-0 ${iconColor}`} />
      ) : (
        <XCircle className={`h-4 w-4 mt-0.5 shrink-0 ${iconColor}`} />
      )}
      <div className="text-sm">
        <div className={`font-medium ${titleColor}`}>
          {result.totalCleaned} of {result.totalBefore} row{result.totalBefore === 1 ? "" : "s"} cleaned
          {!verifiedClean && result.totalRemaining > 0 && ` — ${result.totalRemaining} remaining`}
          {hasVerificationErrors && " — verification incomplete"}
          {verifiedClean && hasErrors && " — with errors"}
        </div>
        <div className="text-muted-foreground">
          {hasVerificationErrors
            ? "Verification could not complete for all tables — the remaining count may be inaccurate."
            : result.totalRemaining > 0
            ? `Verification found ${result.totalRemaining} row${result.totalRemaining === 1 ? "" : "s"} still carrying stale markers.`
            : hasErrors
            ? `Stale markers removed where possible. ${result.tableErrors.length} table error${result.tableErrors.length === 1 ? "" : "s"} occurred.`
            : "Verification confirmed: all stale legacy marker fields have been removed."}
        </div>
        {(hasErrors || hasVerificationErrors) && (
          <ul className="mt-1 space-y-0.5 text-xs text-destructive list-disc list-inside">
            {result.tableErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
            {result.verificationErrors.map((e, i) => (
              <li key={`v-${i}`}>{e}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

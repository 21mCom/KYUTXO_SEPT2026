import { useCallback, useEffect, useRef, useState } from "react";
import {
  Hourglass,
  Play,
  X,
  Loader2,
  Download,
  Info,
  AlertTriangle,
  History,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { downloadBlob } from "@/lib/backup/sink";
import {
  runDormantScan,
  DEFAULT_MIN_AGE_YEARS,
  DEFAULT_MIN_AMOUNT_SATS,
  DEFAULT_DUST_THRESHOLD_SATS,
  type DormantScanParams,
  type DormantScanPhase,
  type DormantScanSummary,
} from "@/lib/dormant-coins";
import {
  appendDormantGroups,
  appendDormantRows,
  beginDormantRun,
  clearDormantReport,
  completeDormantRun,
  countDormantGroups,
  countDormantRows,
  exportDormantReport,
  getDormantRunMeta,
} from "@/lib/data/dormant-coins-report-store";
import { DormantGroupsList, DormantResultsList } from "./dormant-coins/dormant-results-list";

type RunState =
  | { status: "idle" }
  | { status: "running"; phase: DormantScanPhase; processed: number; total?: number }
  | { status: "done"; summary: DormantScanSummary }
  | { status: "error"; message: string };

const PHASE_LABELS: Record<DormantScanPhase, string> = {
  records: "Loading address records",
  transactions: "Loading transaction history",
  participants: "Scanning inputs & outputs",
  classify: "Clustering co-spend clues",
  store: "Writing report",
};

function formatSats(sats: number): string {
  return sats.toLocaleString() + " sats";
}

function parsePositiveInt(raw: string, fallback: number): number {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parsePositiveFloat(raw: string, fallback: number): number {
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export default function DormantCoins() {
  const { toast } = useToast();

  // ── Threshold controls ──────────────────────────────────────────────────
  const [yearsInput, setYearsInput] = useState(String(DEFAULT_MIN_AGE_YEARS));
  const [minAmountInput, setMinAmountInput] = useState(String(DEFAULT_MIN_AMOUNT_SATS));
  const [dustInput, setDustInput] = useState(String(DEFAULT_DUST_THRESHOLD_SATS));
  const [ignoreDust, setIgnoreDust] = useState(false);

  // ── Run state ───────────────────────────────────────────────────────────
  const [runState, setRunState] = useState<RunState>({ status: "idle" });
  const [rowsCount, setRowsCount] = useState(0);
  const [groupsCount, setGroupsCount] = useState(0);
  // Summary/counts of the last COMPLETED run (shown after reload too).
  const [summary, setSummary] = useState<DormantScanSummary | null>(null);
  // Set when the persisted run meta says "running" — the previous scan was
  // interrupted (reload/crash mid-run) and the stored rows are partial.
  const [interrupted, setInterrupted] = useState(false);
  const [exporting, setExporting] = useState<null | "csv" | "json">(null);

  const abortRef = useRef<AbortController | null>(null);
  // Monotonic run token: a new run (or Cancel) bumps it, so workers from a
  // superseded run see a stale token and can never mutate newer state.
  const runIdRef = useRef(0);

  // Restore the persisted report on mount (results survive reloads).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [meta, rowCount, groupCount] = await Promise.all([
        getDormantRunMeta(),
        countDormantRows(),
        countDormantGroups(),
      ]);
      if (cancelled) return;
      setRowsCount(rowCount);
      setGroupsCount(groupCount);
      if (meta?.status === "running") {
        setInterrupted(true);
      } else if (meta?.status === "complete" && meta.summary) {
        setSummary(meta.summary);
      }
    })();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
      // Invalidate any in-flight run so its late batches can't touch state.
      runIdRef.current++;
    };
  }, []);

  const isRunning = runState.status === "running";

  const runScan = useCallback(async () => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    const runToken = ++runIdRef.current;
    const isStale = () => runIdRef.current !== runToken;

    const params: DormantScanParams = {
      minAgeYears: parsePositiveFloat(yearsInput, DEFAULT_MIN_AGE_YEARS),
      minAmountSats: parsePositiveInt(minAmountInput, DEFAULT_MIN_AMOUNT_SATS),
      dustThresholdSats: parsePositiveInt(dustInput, DEFAULT_DUST_THRESHOLD_SATS),
      ignoreDust,
    };

    await clearDormantReport();
    await beginDormantRun(params);
    if (isStale()) return;
    setRowsCount(0);
    setGroupsCount(0);
    setSummary(null);
    setInterrupted(false);
    setRunState({ status: "running", phase: "records", processed: 0 });

    try {
      const result = await runDormantScan(params, {
        signal: abort.signal,
        onProgress: (p) => {
          if (!isStale()) {
            setRunState({ status: "running", phase: p.phase, processed: p.processed, total: p.total });
          }
        },
        // Awaited inside the scan: each batch is persisted before the next is
        // produced, giving backpressure and keeping peak memory bounded.
        onBatch: async (batch) => {
          await appendDormantRows(batch);
          if (!isStale()) setRowsCount((c) => c + batch.length);
        },
        onGroupBatch: async (groups) => {
          await appendDormantGroups(groups);
          if (!isStale()) setGroupsCount((c) => c + groups.length);
        },
      });

      if (isStale() || abort.signal.aborted || result === null) return;

      await completeDormantRun(result);
      if (isStale()) return;
      setSummary(result);
      setRunState({ status: "done", summary: result });
      toast({
        title: "Scan complete",
        description:
          result.rowCount === 0
            ? "No dormant outputs found for these thresholds."
            : `Found ${result.rowCount.toLocaleString()} dormant output${
                result.rowCount !== 1 ? "s" : ""
              } (${formatSats(result.totalSats)}).`,
      });
    } catch (err) {
      if (isStale() || abort.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      setRunState({ status: "error", message });
      toast({
        variant: "destructive",
        title: "Scan failed",
        description: message,
      });
    }
  }, [yearsInput, minAmountInput, dustInput, ignoreDust, toast]);

  const cancelScan = useCallback(() => {
    // Bump the token FIRST so any late batch/progress callback from the
    // cancelled run is a no-op even before the abort propagates.
    runIdRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    setRunState({ status: "idle" });
    setInterrupted(true); // partial rows remain in the store — say so
  }, []);

  const exportReport = useCallback(
    async (format: "csv" | "json") => {
      setExporting(format);
      try {
        const { blob, rowCount } = await exportDormantReport(format);
        if (rowCount === 0) {
          toast({ description: "Nothing to export — run a scan first." });
          return;
        }
        const stamp = new Date().toISOString().slice(0, 10);
        const filename = `dormant-coins-${stamp}.${format}`;
        downloadBlob(blob, filename);
        toast({
          title: "Export complete",
          description: `Exported ${rowCount.toLocaleString()} dormant output${
            rowCount !== 1 ? "s" : ""
          } as ${filename}.`,
        });
      } catch (err) {
        toast({
          variant: "destructive",
          title: "Export failed",
          description:
            err instanceof Error ? err.message : "Could not export the dormant coins report.",
        });
      } finally {
        setExporting(null);
      }
    },
    [toast],
  );

  const progressPercent =
    runState.status === "running" && runState.total && runState.total > 0
      ? Math.round((runState.processed / runState.total) * 100)
      : null;

  const hasResults = rowsCount > 0;

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6" data-testid="page-dormant-coins">
      <div>
        <h1 className="text-2xl font-bold tracking-tight" data-testid="text-page-title">
          Dormant Coins
        </h1>
        <p className="text-muted-foreground mt-1" data-testid="text-page-description">
          Hunt for forgotten or lost-key coins: old outputs in your synced history that are still
          unspent — on your own addresses and on unknown addresses linked to your old transactions.
        </p>
      </div>

      <Alert data-testid="alert-local-data-caveat">
        <Info className="h-4 w-4" />
        <AlertTitle>Local data only</AlertTitle>
        <AlertDescription>
          This report is computed entirely from locally synced history, as of your last address
          sync. &ldquo;Still holds coins&rdquo; uses exact outpoint matching against local data
          only — later counterparty spends may be unseen. The scan itself performs no network
          requests; use a row&apos;s explicit &ldquo;Check node&rdquo; action to verify that exact
          output against your configured node before hunting for keys.
        </AlertDescription>
      </Alert>

      {interrupted && (
        <Alert variant="destructive" data-testid="alert-interrupted">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Previous scan was interrupted</AlertTitle>
          <AlertDescription>
            The results below are partial — the last scan did not finish. Run a new scan for a
            complete report.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Hourglass className="h-5 w-5" />
            Dormancy scan
          </CardTitle>
          <CardDescription>
            Scans every synced input and output for old, still-unspent coins. Dust-sized outputs
            are excluded and never count as an address&apos;s last activity, so repeatedly dusted
            old addresses still surface with their true dormancy date.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="input-min-age-years">Minimum dormancy (years)</Label>
              <Input
                id="input-min-age-years"
                data-testid="input-min-age-years"
                type="number"
                min={0}
                step={0.5}
                value={yearsInput}
                onChange={(e) => setYearsInput(e.target.value)}
                disabled={isRunning}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="input-min-amount">Minimum amount (sats)</Label>
              <Input
                id="input-min-amount"
                data-testid="input-min-amount"
                type="number"
                min={0}
                value={minAmountInput}
                onChange={(e) => setMinAmountInput(e.target.value)}
                disabled={isRunning}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="input-dust-threshold">Dust threshold (sats)</Label>
              <Input
                id="input-dust-threshold"
                data-testid="input-dust-threshold"
                type="number"
                min={0}
                value={dustInput}
                onChange={(e) => setDustInput(e.target.value)}
                disabled={isRunning || ignoreDust}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm" htmlFor="checkbox-ignore-dust">
            <Checkbox
              id="checkbox-ignore-dust"
              data-testid="checkbox-ignore-dust"
              checked={ignoreDust}
              onCheckedChange={(v) => setIgnoreDust(v === true)}
              disabled={isRunning}
            />
            Ignore dust entirely (treat every output as meaningful)
          </label>

          <div className="flex items-center gap-2 flex-wrap">
            <Button onClick={runScan} disabled={isRunning} data-testid="button-run-scan">
              {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {isRunning ? "Scanning…" : "Run scan"}
            </Button>
            {isRunning && (
              <Button variant="outline" onClick={cancelScan} data-testid="button-cancel-scan">
                <X className="h-4 w-4" />
                Cancel
              </Button>
            )}
            {hasResults && (
              <>
                <Button
                  variant="outline"
                  onClick={() => exportReport("csv")}
                  disabled={isRunning || exporting !== null}
                  data-testid="button-export-csv"
                >
                  {exporting === "csv" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  Export CSV
                </Button>
                <Button
                  variant="outline"
                  onClick={() => exportReport("json")}
                  disabled={isRunning || exporting !== null}
                  data-testid="button-export-json"
                >
                  {exporting === "json" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  Export JSON
                </Button>
              </>
            )}
          </div>

          {runState.status === "running" && (
            <div className="space-y-1.5" data-testid="container-scan-progress">
              <p className="text-sm text-muted-foreground" data-testid="text-scan-progress">
                {PHASE_LABELS[runState.phase]}… {runState.processed.toLocaleString()}
                {runState.total ? ` / ${runState.total.toLocaleString()}` : ""}
              </p>
              <Progress value={progressPercent ?? undefined} data-testid="progress-scan" />
            </div>
          )}

          {runState.status === "error" && (
            <Alert variant="destructive" data-testid="alert-scan-error">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Scan failed</AlertTitle>
              <AlertDescription>{runState.message}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {summary && (
        <Card data-testid="card-scan-summary">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <History className="h-4 w-4" />
              Last completed scan
            </CardTitle>
            <CardDescription>
              {summary.scannedParticipants.toLocaleString()} participants across{" "}
              {summary.scannedTransactions.toLocaleString()} transactions · age ≥{" "}
              {summary.params.minAgeYears} yrs · ≥ {summary.params.minAmountSats.toLocaleString()}{" "}
              sats
              {summary.params.ignoreDust
                ? " · dust ignored"
                : ` · dust ≤ ${summary.params.dustThresholdSats.toLocaleString()} sats excluded`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="space-y-0.5">
                <p className="text-xs text-muted-foreground">Dormant outputs</p>
                <p className="text-lg font-semibold tabular-nums" data-testid="text-summary-rows">
                  {summary.rowCount.toLocaleString()}
                </p>
              </div>
              <div className="space-y-0.5">
                <p className="text-xs text-muted-foreground">Total dormant</p>
                <p className="text-lg font-semibold tabular-nums" data-testid="text-summary-total-sats">
                  {formatSats(summary.totalSats)}
                </p>
              </div>
              <div className="space-y-0.5">
                <p className="text-xs text-muted-foreground">On your addresses</p>
                <p className="text-lg font-semibold tabular-nums" data-testid="text-summary-own-sats">
                  {formatSats(summary.ownSats)}
                </p>
              </div>
              <div className="space-y-0.5">
                <p className="text-xs text-muted-foreground">Co-spend clue groups</p>
                <p className="text-lg font-semibold tabular-nums" data-testid="text-summary-groups">
                  {summary.groupCount.toLocaleString()}
                </p>
              </div>
            </div>
            {summary.missingOutpointInputs > 0 && (
              <Alert data-testid="alert-missing-outpoints">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Some spend data lacks exact outpoints</AlertTitle>
                <AlertDescription>
                  {summary.missingOutpointInputs.toLocaleString()} spend input
                  {summary.missingOutpointInputs !== 1 ? "s" : ""} had no prevout reference, so the
                  outputs they consumed cannot be matched exactly and may be overstated as unspent.
                  Re-sync the affected addresses to capture full outpoint data.
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      )}

      {hasResults ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Dormant unspent outputs</CardTitle>
            <CardDescription>
              Ranked oldest first, then by amount. &ldquo;Unknown&rdquo; rows are counterparty
              addresses linked to your old transactions — possible lost keys.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DormantResultsList count={rowsCount} nowSec={Math.floor(Date.now() / 1000)} />
          </CardContent>
        </Card>
      ) : (
        runState.status === "done" && (
          <Card>
            <CardContent className="py-8 text-center">
              <p className="text-muted-foreground" data-testid="text-no-results">
                No dormant outputs found for these thresholds. Try lowering the minimum age or
                amount.
              </p>
            </CardContent>
          </Card>
        )
      )}

      {groupsCount > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              Co-spend clue groups
              <Badge variant="secondary" data-testid="badge-groups-count">
                {groupsCount.toLocaleString()}
              </Badge>
            </CardTitle>
            <CardDescription>
              Unknown addresses that shared transaction inputs with your own keys in old
              transactions. Common-input-ownership says they are likely the same entity — possibly
              your own lost keys.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DormantGroupsList count={groupsCount} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

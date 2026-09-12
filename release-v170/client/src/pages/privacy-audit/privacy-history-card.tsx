import { useState, useCallback, useMemo, useEffect } from "react";
import {
  Activity,
  Download,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import type { PrivacyAuditHistoryEntry } from "@/lib/database";
import { clearPrivacyAuditHistory, getPrivacyAuditHistory } from "@/lib/data/privacy-history-crud";
import { useDbChangeSignal } from "@/hooks/use-db-change-signal";
import {
  buildPrivacyHistoryCsv,
  buildPrivacyHistoryPdf,
  computePrivacyHistoryScopeLabel,
} from "@/lib/privacy-history-export";
import { useToast } from "@/hooks/use-toast";
import { FINDING_TYPE_LABELS, type PrivacyFindingType } from "@/lib/privacy-audit";

export function formatHistoryDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function PrivacyHistoryCard() {
  const historySignal = useDbChangeSignal(["privacyAuditHistory"]);
  const [history, setHistory] = useState<PrivacyAuditHistoryEntry[] | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void getPrivacyAuditHistory().then((entries) => {
      if (!cancelled) setHistory(entries);
    });
    return () => { cancelled = true; };
  }, [historySignal]);
  const { toast } = useToast();

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [rangeMatchedNone, setRangeMatchedNone] = useState(false);

  const entryKey = useCallback(
    (entry: PrivacyAuditHistoryEntry) => entry.id ?? entry.timestamp,
    [],
  );

  const exportList = useMemo(() => {
    const list = history ?? [];
    if (selectedIds.size === 0) return list;
    return list.filter((e) => selectedIds.has(e.id ?? e.timestamp));
  }, [history, selectedIds]);

  const exportScopeLabel = useMemo(
    () => computePrivacyHistoryScopeLabel(exportList),
    [exportList],
  );

  const toggleSelected = useCallback((key: number) => {
    setRangeMatchedNone(false);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setRangeMatchedNone(false);
    setSelectedIds(new Set((history ?? []).map((e) => e.id ?? e.timestamp)));
  }, [history]);

  const clearSelection = useCallback(() => {
    setRangeMatchedNone(false);
    setSelectedIds(new Set());
  }, []);

  const selectRange = useCallback(() => {
    const list = history ?? [];
    const fromTs = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : -Infinity;
    const toTs = toDate ? new Date(`${toDate}T23:59:59.999`).getTime() : Infinity;
    const matched = list.filter((e) => e.timestamp >= fromTs && e.timestamp <= toTs);
    if (matched.length === 0) {
      setRangeMatchedNone(true);
      toast({
        title: "No runs in that date range",
        description:
          "Nothing was selected. Adjust the dates or pick runs by hand — your current selection is unchanged.",
      });
      return;
    }
    setRangeMatchedNone(false);
    setSelectedIds(new Set(matched.map((e) => e.id ?? e.timestamp)));
  }, [history, fromDate, toDate, toast]);

  const chartData = useMemo(
    () =>
      (history ?? []).map((h) => ({
        ts: h.timestamp,
        date: formatHistoryDate(h.timestamp),
        score: h.score,
        grade: h.grade,
      })),
    [history],
  );

  const adversaryChartData = useMemo(
    () =>
      (history ?? [])
        .filter((h) => h.adversary && h.adversary.status !== "cancelled")
        .map((h) => {
          const adv = h.adversary as Extract<
            NonNullable<PrivacyAuditHistoryEntry["adversary"]>,
            { exposureCount: number }
          >;
          return {
            ts: h.timestamp,
            date: formatHistoryDate(h.timestamp),
            exposure: adv.exposureCount,
            separation: adv.separationCount,
            confusion: adv.confusionCount,
          };
        }),
    [history],
  );

  const rows = useMemo(() => {
    const list = history ?? [];
    const out: {
      entry: PrivacyAuditHistoryEntry;
      scoreDelta: number | null;
      changes: { type: string; from: number; to: number }[];
    }[] = [];
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i];
      const prev = i > 0 ? list[i - 1] : null;
      const scoreDelta = prev ? entry.score - prev.score : null;
      const changes: { type: string; from: number; to: number }[] = [];
      if (prev) {
        const types = Array.from(
          new Set([
            ...Object.keys(entry.findingTypeCounts ?? {}),
            ...Object.keys(prev.findingTypeCounts ?? {}),
          ]),
        );
        for (const type of types) {
          const to = entry.findingTypeCounts?.[type] ?? 0;
          const from = prev.findingTypeCounts?.[type] ?? 0;
          if (to !== from) changes.push({ type, from, to });
        }
        changes.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));
      }
      out.push({ entry, scoreDelta, changes });
    }
    return out;
  }, [history]);

  const handleClear = useCallback(async () => {
    try {
      await clearPrivacyAuditHistory();
      toast({ title: "History Cleared", description: "All privacy audit history was removed." });
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Clear Failed",
        description: e instanceof Error ? e.message : "Could not clear history.",
      });
    }
  }, [toast]);

  const exportNeedsFallbackConfirm = rangeMatchedNone && selectedIds.size === 0;
  const [pendingExport, setPendingExport] = useState<"csv" | "pdf" | null>(null);

  const runCsvExport = useCallback(() => {
    const list = exportList;
    if (list.length === 0) return;
    try {
      const csv = buildPrivacyHistoryCsv(list);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `privacy-history-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast({
        title: "History Exported",
        description: `${list.length} audit run${list.length === 1 ? "" : "s"} exported to CSV.`,
      });
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Export Failed",
        description: e instanceof Error ? e.message : "Could not export history.",
      });
    }
  }, [exportList, toast]);

  const runPdfExport = useCallback(async () => {
    const list = exportList;
    if (list.length === 0) return;
    try {
      const blob = await buildPrivacyHistoryPdf(list);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `privacy-history-${new Date().toISOString().slice(0, 10)}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast({
        title: "History Exported",
        description: `${list.length} audit run${list.length === 1 ? "" : "s"} exported to PDF.`,
      });
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Export Failed",
        description: e instanceof Error ? e.message : "Could not export history.",
      });
    }
  }, [exportList, toast]);

  const handleExportCsv = useCallback(() => {
    if (exportNeedsFallbackConfirm) {
      setPendingExport("csv");
      return;
    }
    runCsvExport();
  }, [exportNeedsFallbackConfirm, runCsvExport]);

  const handleExportPdf = useCallback(() => {
    if (exportNeedsFallbackConfirm) {
      setPendingExport("pdf");
      return;
    }
    void runPdfExport();
  }, [exportNeedsFallbackConfirm, runPdfExport]);

  const confirmFallbackExport = useCallback(() => {
    const kind = pendingExport;
    setPendingExport(null);
    if (kind === "csv") runCsvExport();
    else if (kind === "pdf") void runPdfExport();
  }, [pendingExport, runCsvExport, runPdfExport]);

  if (!history || history.length === 0) return null;

  const latest = history[history.length - 1];
  const first = history[0];
  const overallDelta = latest.score - first.score;

  return (
    <Card data-testid="container-privacy-history">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Privacy History
          </CardTitle>
          <CardDescription className="text-xs">
            {history.length} audit{history.length === 1 ? "" : "s"} recorded
            {history.length > 1 && (
              <>
                {" · "}
                <span
                  className={
                    overallDelta > 0
                      ? "text-green-600 dark:text-green-400"
                      : overallDelta < 0
                      ? "text-red-600 dark:text-red-400"
                      : ""
                  }
                  data-testid="text-history-overall-delta"
                >
                  {overallDelta > 0 ? "+" : ""}
                  {overallDelta} pts overall
                </span>
              </>
            )}
            {" · keeps last 30 runs"}
            {selectedIds.size > 0 && (
              <>
                {" · "}
                <span className="font-medium" data-testid="text-history-selected-count">
                  {selectedIds.size} selected for export
                </span>
              </>
            )}
          </CardDescription>
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          {exportNeedsFallbackConfirm && (
            <span
              className="mr-1 inline-flex items-center gap-1 text-xs font-medium text-amber-600 dark:text-amber-400"
              data-testid="warning-history-export-empty-range"
            >
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              Empty range — exports all runs
            </span>
          )}
          {exportScopeLabel && (
            <Badge
              variant="secondary"
              className="mr-1"
              data-testid="badge-history-export-scope"
            >
              {exportScopeLabel}
            </Badge>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportCsv}
            data-testid="button-export-history-csv"
          >
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportPdf}
            data-testid="button-export-history-pdf"
          >
            <Download className="h-4 w-4" />
            Export PDF
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClear}
            data-testid="button-clear-history"
          >
            Clear
          </Button>
        </div>
        <AlertDialog
          open={pendingExport !== null}
          onOpenChange={(open) => {
            if (!open) setPendingExport(null);
          }}
        >
          <AlertDialogContent data-testid="dialog-export-fallback-confirm">
            <AlertDialogHeader>
              <AlertDialogTitle>Export all stored runs?</AlertDialogTitle>
              <AlertDialogDescription>
                The date range you picked matched 0 runs, so nothing is selected.
                Exporting now will include all {history?.length ?? 0} stored run
                {(history?.length ?? 0) === 1 ? "" : "s"}. Adjust the dates or pick
                runs by hand to export a subset.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="button-export-fallback-cancel">
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmFallbackExport}
                data-testid="button-export-fallback-confirm"
              >
                Export all runs
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardHeader>
      <CardContent className="space-y-4">
        {chartData.length > 1 ? (
          <div data-testid="container-history-sparkline">
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={chartData} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                <XAxis dataKey="date" tick={{ fontSize: 9 }} interval="preserveStartEnd" />
                <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} />
                <Tooltip
                  formatter={(value: number, _name, entry: { payload?: { grade: string } }) => [
                    `${value}/100 (${entry.payload?.grade ?? ""})`,
                    "Score",
                  ]}
                  contentStyle={{ fontSize: 11 }}
                />
                <ReferenceLine y={80} stroke="#22c55e" strokeDasharray="3 3" strokeOpacity={0.5} />
                <ReferenceLine y={60} stroke="#eab308" strokeDasharray="3 3" strokeOpacity={0.5} />
                <Line
                  type="monotone"
                  dataKey="score"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  dot={{ r: 2 }}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground" data-testid="text-history-need-more">
            Run the audit again over time to see your score trend appear here.
          </p>
        )}

        {adversaryChartData.length > 1 && (
          <div data-testid="container-adversary-trend">
            <div className="flex items-center justify-between gap-2 flex-wrap mb-1">
              <span className="text-xs font-medium">Adversary View trend</span>
              <div className="flex items-center gap-3 flex-wrap text-[10px] text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-full bg-red-500" />
                  Exposure clusters
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
                  Preserved separations
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
                  Change confusions
                </span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={120}>
              <LineChart data={adversaryChartData} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                <XAxis dataKey="date" tick={{ fontSize: 9 }} interval="preserveStartEnd" />
                <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
                <Tooltip contentStyle={{ fontSize: 11 }} />
                <Line
                  type="monotone"
                  dataKey="exposure"
                  name="Exposure clusters"
                  stroke="#ef4444"
                  strokeWidth={2}
                  dot={{ r: 2 }}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="separation"
                  name="Preserved separations"
                  stroke="#22c55e"
                  strokeWidth={2}
                  dot={{ r: 2 }}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="confusion"
                  name="Change confusions"
                  stroke="#f59e0b"
                  strokeWidth={2}
                  dot={{ r: 2 }}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        <div
          className="flex flex-wrap items-end gap-3 rounded-md border p-3"
          data-testid="container-history-export-selection"
        >
          <div className="space-y-1">
            <Label htmlFor="history-from-date" className="text-xs text-muted-foreground">
              From
            </Label>
            <Input
              id="history-from-date"
              type="date"
              value={fromDate}
              onChange={(e) => {
                setRangeMatchedNone(false);
                setFromDate(e.target.value);
              }}
              className="h-9 w-[10.5rem]"
              data-testid="input-history-from-date"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="history-to-date" className="text-xs text-muted-foreground">
              To
            </Label>
            <Input
              id="history-to-date"
              type="date"
              value={toDate}
              onChange={(e) => {
                setRangeMatchedNone(false);
                setToDate(e.target.value);
              }}
              className="h-9 w-[10.5rem]"
              data-testid="input-history-to-date"
            />
          </div>
          <div className="flex items-center gap-1 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={selectRange}
              disabled={!fromDate && !toDate}
              data-testid="button-history-select-range"
            >
              Select range
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={selectAll}
              data-testid="button-history-select-all"
            >
              Select all
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={clearSelection}
              disabled={selectedIds.size === 0}
              data-testid="button-history-clear-selection"
            >
              Clear selection
            </Button>
          </div>
          <p
            className={`w-full text-xs ${
              rangeMatchedNone ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
            }`}
            data-testid="text-history-export-hint"
          >
            {rangeMatchedNone
              ? "0 runs fall in that date range — selection unchanged. Adjust the dates or pick runs by hand. Exporting now will ask for confirmation first."
              : selectedIds.size === 0
              ? "No runs picked — exports will include all stored runs."
              : `Exports will include ${selectedIds.size} selected run${
                  selectedIds.size === 1 ? "" : "s"
                }.`}
          </p>
        </div>

        <div className="space-y-2">
          {rows.map(({ entry, scoreDelta, changes }) => {
            const key = entryKey(entry);
            return (
            <div
              key={entry.id ?? entry.timestamp}
              className="border rounded-md p-3 space-y-2"
              data-testid={`row-history-${entry.id ?? entry.timestamp}`}
            >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                  <Checkbox
                    checked={selectedIds.has(key)}
                    onCheckedChange={() => toggleSelected(key)}
                    aria-label={`Select run from ${formatHistoryDate(entry.timestamp)} for export`}
                    data-testid={`checkbox-history-select-${entry.id ?? entry.timestamp}`}
                  />
                  <span className="text-xs text-muted-foreground" data-testid="text-history-date">
                    {formatHistoryDate(entry.timestamp)}
                  </span>
                  <Badge variant="outline" data-testid="badge-history-grade">
                    {entry.grade}
                  </Badge>
                  <span className="text-sm font-medium" data-testid="text-history-score">
                    {entry.score}/100
                  </span>
                  {scoreDelta !== null && scoreDelta !== 0 && (
                    <span
                      className={`text-xs font-mono ${
                        scoreDelta > 0
                          ? "text-green-600 dark:text-green-400"
                          : "text-red-600 dark:text-red-400"
                      }`}
                      data-testid="text-history-delta"
                    >
                      {scoreDelta > 0 ? "+" : ""}
                      {scoreDelta}
                    </span>
                  )}
                  {entry.owner || entry.walletName ? (
                    <>
                      {entry.owner && (
                        <Badge
                          variant="secondary"
                          className="text-xs"
                          data-testid="badge-history-scope-owner"
                        >
                          Owner: {entry.owner}
                        </Badge>
                      )}
                      {entry.walletName && (
                        <Badge
                          variant="secondary"
                          className="text-xs"
                          data-testid="badge-history-scope-wallet"
                        >
                          Wallet: {entry.walletName}
                        </Badge>
                      )}
                    </>
                  ) : (
                    <Badge
                      variant="secondary"
                      className="text-xs"
                      data-testid="badge-history-scope-all"
                    >
                      All
                    </Badge>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">
                  {entry.totalFindings} issue{entry.totalFindings === 1 ? "" : "s"}
                </span>
              </div>

              {entry.adversary?.status === "cancelled" && (
                <div
                  className="flex flex-wrap gap-1"
                  data-testid={`container-history-adversary-cancelled-${entry.id ?? entry.timestamp}`}
                >
                  <Badge
                    variant="secondary"
                    className="text-xs"
                    data-testid="badge-history-adversary-cancelled"
                  >
                    Adversary analysis cancelled
                  </Badge>
                </div>
              )}

              {entry.adversary && entry.adversary.status !== "cancelled" && (
                <div
                  className="flex flex-wrap gap-1"
                  data-testid={`container-history-adversary-${entry.id ?? entry.timestamp}`}
                >
                  <Badge variant="outline" className="text-xs" data-testid="badge-history-adversary-exposure">
                    <span className="text-red-600 dark:text-red-400 font-medium">
                      {entry.adversary.exposureCount}
                    </span>
                    <span className="ml-1">
                      exposed cluster{entry.adversary.exposureCount === 1 ? "" : "s"} (
                      {entry.adversary.addressesExposed} addr
                      {entry.adversary.addressesExposed === 1 ? "" : "s"})
                    </span>
                  </Badge>
                  <Badge variant="outline" className="text-xs" data-testid="badge-history-adversary-separation">
                    <span className="text-green-600 dark:text-green-400 font-medium">
                      {entry.adversary.separationCount}
                    </span>
                    <span className="ml-1">
                      separation{entry.adversary.separationCount === 1 ? "" : "s"} preserved
                    </span>
                  </Badge>
                  <Badge variant="outline" className="text-xs" data-testid="badge-history-adversary-confusion">
                    <span className="text-amber-600 dark:text-amber-400 font-medium">
                      {entry.adversary.confusionCount}
                    </span>
                    <span className="ml-1">
                      change confusion{entry.adversary.confusionCount === 1 ? "" : "s"}
                    </span>
                  </Badge>
                  <Badge variant="outline" className="text-xs" data-testid="badge-history-adversary-context">
                    <span className="font-medium">{entry.adversary.contextMergeCount}</span>
                    <span className="ml-1">
                      context merge{entry.adversary.contextMergeCount === 1 ? "" : "s"}
                    </span>
                  </Badge>
                </div>
              )}

              {changes.length > 0 && (
                <div className="flex flex-wrap gap-1" data-testid="container-history-changes">
                  {changes.slice(0, 8).map((c) => {
                    const improved = c.to < c.from;
                    return (
                      <Badge
                        key={c.type}
                        variant="secondary"
                        className="text-xs"
                        data-testid={`badge-history-change-${c.type.toLowerCase()}`}
                      >
                        <span
                          className={
                            improved
                              ? "text-green-600 dark:text-green-400"
                              : "text-red-600 dark:text-red-400"
                          }
                        >
                          {improved ? "▾" : "▴"}
                        </span>
                        <span className="ml-1">
                          {FINDING_TYPE_LABELS[c.type as PrivacyFindingType] ?? c.type}: {c.from}→{c.to}
                        </span>
                      </Badge>
                    );
                  })}
                  {changes.length > 8 && (
                    <span className="text-xs text-muted-foreground self-center">
                      +{changes.length - 8} more
                    </span>
                  )}
                </div>
              )}
            </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

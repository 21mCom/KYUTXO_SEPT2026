// "Compare backups" dialog: pick two v3 backup files (encrypted or plaintext)
// and see a read-only what-changed report — per-table added/removed/changed
// counts with drill-down field deltas — without any restore or vault writes.
//
// The comparison runs entirely in-page over the two picked files
// (compareBackups streams both ZIPs; attachment file bytes are never read),
// with progress + cancellation, and the result can be exported to CSV.

import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  FileSpreadsheet,
  FileUp,
  Lock,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { compareBackups, type BackupDiffResult, type TableDiff } from "@/lib/backup/compare";
import {
  diffKeyIdentifier,
  canonicalDiffIdentifier,
  resolveDiffIdentifiers,
} from "@/lib/backup/compare-link-resolution";
import { AddressLink } from "@/components/AddressLink";
import { blobChunks } from "@/lib/backup/zip-stream";
import { BackupCancelledError, downloadBlob } from "@/lib/backup/sink";

interface BackupCompareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Stage = "pick" | "running" | "results";

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

// One drill-down list for a table's diff entries, virtualized so a huge diff
// (thousands of changed rows) never mounts more than the visible window.
// Exported for the jsdom test (BackupCompareDialog.diffLinks.test.tsx).
export function TableDrillDown({ diff }: { diff: TableDiff }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: diff.entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 42,
    overscan: 8,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  // Read-only live-vault link resolution for the visible window: canonical
  // identifier -> live record id. Batched per window and debounced so a huge
  // diff (or fast scrolling) never fires per-row queries; identifiers that
  // were already attempted (hit or miss) are never re-queried.
  const [links, setLinks] = useState<Map<string, number>>(new Map());
  const attemptedRef = useRef<Set<string>>(new Set());

  const virtualItems = virtualizer.getVirtualItems();
  const pendingIdentifiers: string[] = [];
  for (const vi of virtualItems) {
    const entry = diff.entries[vi.index];
    const identifier = entry ? diffKeyIdentifier(diff.table, entry.key) : null;
    if (!identifier) continue;
    const canonical = canonicalDiffIdentifier(identifier);
    if (!attemptedRef.current.has(canonical)) pendingIdentifiers.push(canonical);
  }
  const pendingSignature = pendingIdentifiers.join("\n");

  useEffect(() => {
    if (pendingSignature === "") return;
    const batch = pendingSignature.split("\n");
    let cancelled = false;
    const timer = setTimeout(async () => {
      for (const id of batch) attemptedRef.current.add(id);
      try {
        const resolved = await resolveDiffIdentifiers(batch);
        if (cancelled || resolved.size === 0) return;
        setLinks((prev) => {
          const next = new Map(prev);
          for (const [k, v] of resolved) next.set(k, v);
          return next;
        });
      } catch {
        // Resolution is best-effort decoration: on failure the rows simply
        // stay plain text (retry is possible after collapse/expand).
        if (!cancelled) for (const id of batch) attemptedRef.current.delete(id);
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pendingSignature]);

  // Render the entry key as the app's standard record/address link when the
  // identifier matched a live-vault record, plain text otherwise. dustFlags
  // keys are outpoints (`txid:vout`): only the txid part links.
  const renderKey = (key: string) => {
    const identifier = diffKeyIdentifier(diff.table, key);
    const recordId = identifier ? links.get(canonicalDiffIdentifier(identifier)) : undefined;
    if (identifier == null || recordId == null) {
      return <span className="break-all font-mono">{key}</span>;
    }
    const suffix = key.length > identifier.length ? key.slice(identifier.length) : "";
    return (
      <span className="break-all font-mono" data-testid={`compare-key-link-${diff.table}`}>
        <AddressLink
          address={identifier}
          recordId={recordId}
          truncate={false}
          showCopy={false}
        />
        {suffix}
      </span>
    );
  };

  return (
    <div
      ref={parentRef}
      className="max-h-72 overflow-y-auto rounded-md border bg-muted/30"
      data-testid={`compare-drilldown-${diff.table}`}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const entry = diff.entries[vi.index];
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 top-0 w-full border-b px-3 py-2 text-xs"
              style={{ transform: `translateY(${vi.start}px)` }}
              data-testid={`compare-entry-${diff.table}`}
            >
              <div className="flex items-start gap-2">
                <Badge
                  variant={
                    entry.change === "added"
                      ? "default"
                      : entry.change === "removed"
                        ? "destructive"
                        : "secondary"
                  }
                  className="mt-0.5 shrink-0 text-[10px]"
                >
                  {entry.change}
                </Badge>
                {renderKey(entry.key)}
              </div>
              {entry.deltas && (
                <div className="mt-1 space-y-0.5 pl-14">
                  {entry.deltas.map((d) => (
                    <div key={d.field} className="break-all">
                      <span className="font-medium">{d.field}:</span>{" "}
                      <span className="text-red-600 line-through dark:text-red-400">
                        {d.oldValue ?? "—"}
                      </span>{" "}
                      →{" "}
                      <span className="text-green-700 dark:text-green-400">
                        {d.newValue ?? "—"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function BackupCompareDialog({ open, onOpenChange }: BackupCompareDialogProps) {
  const { toast } = useToast();
  const [stage, setStage] = useState<Stage>("pick");
  const [olderFile, setOlderFile] = useState<File | null>(null);
  const [newerFile, setNewerFile] = useState<File | null>(null);
  const [olderPassword, setOlderPassword] = useState("");
  const [newerPassword, setNewerPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [progressPhase, setProgressPhase] = useState("");
  const [result, setResult] = useState<BackupDiffResult | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const olderInputRef = useRef<HTMLInputElement>(null);
  const newerInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const reset = () => {
    setStage("pick");
    setOlderFile(null);
    setNewerFile(null);
    setOlderPassword("");
    setNewerPassword("");
    setError(null);
    setProgress(0);
    setProgressPhase("");
    setResult(null);
    setExpanded(new Set());
    if (olderInputRef.current) olderInputRef.current.value = "";
    if (newerInputRef.current) newerInputRef.current.value = "";
  };

  const handleOpenChange = (next: boolean) => {
    if (!next && stage === "running") {
      // Closing mid-run cancels the comparison rather than leaving it running
      // against files the user can no longer see.
      abortRef.current?.abort();
    }
    onOpenChange(next);
  };

  const handleCompare = async () => {
    if (!olderFile || !newerFile) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setStage("running");
    setError(null);
    setProgress(0);
    setProgressPhase("Starting...");
    try {
      const diff = await compareBackups({
        older: { source: blobChunks(olderFile), password: olderPassword || undefined },
        newer: { source: blobChunks(newerFile), password: newerPassword || undefined },
        signal: controller.signal,
        onProgress: (p) => {
          setProgress(p.percent);
          setProgressPhase(p.phase);
        },
      });
      setResult(diff);
      setStage("results");
      const changedTables = diff.tables.filter(
        (t) => t.added + t.removed + t.changed > 0,
      ).length;
      toast({
        title: "Comparison Complete",
        description:
          changedTables === 0
            ? "No differences found between the two backups."
            : `Found differences in ${changedTables} table${changedTables === 1 ? "" : "s"}.`,
      });
    } catch (e) {
      if (e instanceof BackupCancelledError) {
        setStage("pick");
        toast({
          title: "Comparison Cancelled",
          description: "The backup comparison was cancelled before completion.",
        });
        return;
      }
      console.error("Backup comparison failed:", e);
      setStage("pick");
      setError(e instanceof Error ? e.message : "Failed to compare the backups.");
    } finally {
      abortRef.current = null;
    }
  };

  const handleExportCsv = () => {
    if (!result) return;
    const dateStr = new Date().toISOString().split("T")[0];
    const blob = new Blob(result.csv.parts, { type: "text/csv;charset=utf-8" });
    downloadBlob(blob, `kyutxo-backup-diff-${dateStr}.csv`);
    toast({
      title: "Diff Exported",
      description: `Exported ${result.csv.rowCount} diff row(s) as a CSV spreadsheet.`,
    });
  };

  const toggleTable = (table: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(table)) next.delete(table);
      else next.add(table);
      return next;
    });
  };

  const changedTables = result?.tables.filter((t) => t.added + t.removed + t.changed > 0) ?? [];
  const suppressedOnlyTables =
    result?.tables.filter(
      (t) => t.added + t.removed + t.changed === 0 && t.suppressed > 0,
    ) ?? [];
  const totalChanges = changedTables.reduce((n, t) => n + t.added + t.removed + t.changed, 0);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-3xl"
        data-testid="compare-dialog"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowLeftRight className="h-5 w-5" />
            Compare Backups
          </DialogTitle>
          <DialogDescription>
            Pick two v3 backup files to see exactly what changed between them — records,
            transactions, participants, vocabulary, and settings. The comparison is read-only:
            nothing is restored and your vault is never touched.
          </DialogDescription>
        </DialogHeader>

        {stage === "pick" && (
          <div className="space-y-4">
            {error && (
              <Alert variant="destructive" data-testid="compare-error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {(
              [
                {
                  side: "older" as const,
                  file: olderFile,
                  setFile: setOlderFile,
                  password: olderPassword,
                  setPassword: setOlderPassword,
                  inputRef: olderInputRef,
                  title: "Older backup (baseline)",
                },
                {
                  side: "newer" as const,
                  file: newerFile,
                  setFile: setNewerFile,
                  password: newerPassword,
                  setPassword: setNewerPassword,
                  inputRef: newerInputRef,
                  title: "Newer backup (to compare against it)",
                },
              ]
            ).map((slot) => (
              <div key={slot.side} className="space-y-3 rounded-lg border p-4">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-sm font-medium">{slot.title}</Label>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => slot.inputRef.current?.click()}
                    data-testid={`button-pick-${slot.side}-file`}
                  >
                    <FileUp className="mr-2 h-4 w-4" />
                    {slot.file ? "Choose a different file" : "Choose file"}
                  </Button>
                  <input
                    ref={slot.inputRef}
                    type="file"
                    accept=".zip"
                    className="hidden"
                    data-testid={`input-compare-${slot.side}-file`}
                    onChange={(e) => {
                      const f = e.target.files?.[0] ?? null;
                      slot.setFile(f);
                      setError(null);
                    }}
                  />
                </div>
                {slot.file && (
                  <div
                    className="flex items-center gap-2 text-sm text-muted-foreground"
                    data-testid={`text-${slot.side}-file-name`}
                  >
                    <span className="break-all">{slot.file.name}</span>
                    <button
                      type="button"
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                      aria-label={`Remove ${slot.side} file`}
                      onClick={() => {
                        slot.setFile(null);
                        if (slot.inputRef.current) slot.inputRef.current.value = "";
                      }}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label
                    htmlFor={`compare-${slot.side}-password`}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground"
                  >
                    <Lock className="h-3 w-3" />
                    Password (only if this backup is encrypted)
                  </Label>
                  <Input
                    id={`compare-${slot.side}-password`}
                    type="password"
                    value={slot.password}
                    onChange={(e) => slot.setPassword(e.target.value)}
                    placeholder="Leave blank for unencrypted backups"
                    data-testid={`input-compare-${slot.side}-password`}
                  />
                </div>
              </div>
            ))}

            <Button
              className="w-full"
              size="lg"
              onClick={handleCompare}
              disabled={!olderFile || !newerFile}
              data-testid="button-run-compare"
            >
              <ArrowLeftRight className="mr-2 h-4 w-4" />
              Compare Backups
            </Button>
          </div>
        )}

        {stage === "running" && (
          <div className="space-y-3" data-testid="compare-progress">
            <div className="flex items-center justify-between text-sm">
              <span>{progressPhase}</span>
              <span>{progress}%</span>
            </div>
            <Progress value={progress} />
            <Button
              variant="outline"
              className="w-full"
              onClick={() => abortRef.current?.abort()}
              data-testid="button-cancel-compare"
            >
              Cancel
            </Button>
          </div>
        )}

        {stage === "results" && result && (
          <div className="space-y-4" data-testid="compare-results">
            <div className="rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium">{formatDate(result.older.exportDate)}</span>
                {result.older.compact && <Badge variant="secondary">compact</Badge>}
                {result.older.encrypted && <Badge variant="secondary">encrypted</Badge>}
                <ArrowLeftRight className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="font-medium">{formatDate(result.newer.exportDate)}</span>
                {result.newer.compact && <Badge variant="secondary">compact</Badge>}
                {result.newer.encrypted && <Badge variant="secondary">encrypted</Badge>}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {totalChanges === 0
                  ? "No differences found between the two backups."
                  : `${totalChanges} difference${totalChanges === 1 ? "" : "s"} across ${changedTables.length} table${changedTables.length === 1 ? "" : "s"}.`}
              </p>
            </div>

            {changedTables.length > 0 && (
              <div className="space-y-2">
                {changedTables.map((t) => (
                  <div key={t.table} className="rounded-lg border" data-testid={`compare-summary-${t.table}`}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50"
                      onClick={() => toggleTable(t.table)}
                      data-testid={`button-toggle-${t.table}`}
                    >
                      <span className="flex items-center gap-2 font-medium">
                        {expanded.has(t.table) ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                        {t.label}
                      </span>
                      <span className="flex items-center gap-3 text-xs">
                        {t.added > 0 && (
                          <span
                            className="text-green-700 dark:text-green-400"
                            data-testid={`compare-count-${t.table}-added`}
                          >
                            +{t.added} added
                          </span>
                        )}
                        {t.removed > 0 && (
                          <span
                            className="text-red-600 dark:text-red-400"
                            data-testid={`compare-count-${t.table}-removed`}
                          >
                            −{t.removed} removed
                          </span>
                        )}
                        {t.changed > 0 && (
                          <span
                            className="text-amber-600 dark:text-amber-400"
                            data-testid={`compare-count-${t.table}-changed`}
                          >
                            ~{t.changed} changed
                          </span>
                        )}
                        {t.suppressed > 0 && (
                          <span className="text-muted-foreground">
                            {t.suppressed} pruned by compact export
                          </span>
                        )}
                      </span>
                    </button>
                    {expanded.has(t.table) && (
                      <div className="border-t p-2">
                        <TableDrillDown diff={t} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {suppressedOnlyTables.length > 0 && (
              <p className="text-xs text-muted-foreground" data-testid="compare-suppressed-note">
                Discovery-only rows pruned by a compact export were skipped:{" "}
                {suppressedOnlyTables
                  .map((t) => `${t.label} (${t.suppressed})`)
                  .join(", ")}
                .
              </p>
            )}

            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                variant="outline"
                className="flex-1"
                onClick={handleExportCsv}
                disabled={result.csv.rowCount === 0}
                data-testid="button-export-compare-csv"
              >
                <FileSpreadsheet className="mr-2 h-4 w-4" />
                Export Diff as CSV
              </Button>
              <Button
                variant="outline"
                className="flex-1"
                onClick={reset}
                data-testid="button-compare-again"
              >
                Compare Different Files
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

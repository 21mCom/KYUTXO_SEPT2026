// TEMPORARY DIAGNOSTIC COMPONENT
// ---------------------------------------------------------------------------
// Renders the temporary "Decryption Verification" panel. Delete this file
// (and its imports / call-sites in VaultManagement and SettingsPage) once the
// legacy-decrypt migration has been confirmed across the dataset.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCopy,
  FlaskConical,
  Loader2,
  Play,
  Square,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import {
  scanFilesForEncryption,
  scanTablesForEncryption,
  ScanCancelledError,
  type FileScanProgress,
  type FileScanResult,
  type TableScanProgress,
  type TableScanResult,
} from "@/lib/decryption-verification";
import {
  getLegacyDecryptCompletedTables,
  getVaultSettings,
  isLegacyDecryptComplete,
  isLegacyFileDecryptComplete,
} from "@/lib/vault";

interface VaultFlagsState {
  legacyDecryptComplete: boolean;
  legacyDecryptCompletedTables: string[];
  legacyFileDecryptComplete: boolean;
  loaded: boolean;
}

type ScanPhase = "idle" | "tables" | "files" | "done" | "cancelled" | "error";

interface ScanState {
  phase: ScanPhase;
  startedAt: number | null;
  finishedAt: number | null;
  tableProgress: TableScanProgress | null;
  fileProgress: FileScanProgress | null;
  tableResults: TableScanResult[];
  fileResult: FileScanResult | null;
  errorMessage?: string;
}

const initialScanState: ScanState = {
  phase: "idle",
  startedAt: null,
  finishedAt: null,
  tableProgress: null,
  fileProgress: null,
  tableResults: [],
  fileResult: null,
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 100) / 10;
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  return `${m}m ${s}s`;
}

function buildPlainTextReport(state: ScanState, flags: VaultFlagsState): string {
  const lines: string[] = [];
  lines.push("Decryption Verification Report");
  lines.push("==============================");
  lines.push(`Generated: ${new Date().toISOString()}`);
  if (state.startedAt && state.finishedAt) {
    lines.push(`Duration: ${formatDuration(state.finishedAt - state.startedAt)}`);
  }
  lines.push("");
  lines.push("Vault flags");
  lines.push(`- legacyDecryptComplete:        ${flags.legacyDecryptComplete}`);
  lines.push(`- legacyFileDecryptComplete:    ${flags.legacyFileDecryptComplete}`);
  lines.push(
    `- legacyDecryptCompletedTables: ${
      flags.legacyDecryptCompletedTables.length > 0
        ? flags.legacyDecryptCompletedTables.join(", ")
        : "(none)"
    }`,
  );
  lines.push("");

  const totalSuspicious = computeTotalSuspicious(state);
  lines.push("Verdict");
  if (totalSuspicious === 0 && state.phase === "done") {
    lines.push("- All clear: no legacy-encryption traces detected.");
  } else if (state.phase === "done") {
    lines.push(`- Found ${totalSuspicious} item(s) that still look encrypted.`);
  } else {
    lines.push(`- Scan phase: ${state.phase}`);
  }
  lines.push("");

  lines.push("Tables");
  lines.push("------");
  for (const t of state.tableResults) {
    lines.push(`* ${t.tableName}`);
    lines.push(`    rows: ${t.totalRows}`);
    lines.push(`    legacy markers: ${t.markerRows}`);
    lines.push(`    suspicious fields: ${t.suspiciousFieldRows}`);
    if (t.sampleMarkerIds.length > 0) {
      lines.push(`    sample marker IDs: ${t.sampleMarkerIds.join(", ")}`);
    }
    if (t.sampleSuspiciousIds.length > 0) {
      lines.push(`    sample suspicious IDs: ${t.sampleSuspiciousIds.join(", ")}`);
    }
    if (t.error) {
      lines.push(`    error: ${t.error}`);
    }
  }
  lines.push("");

  lines.push("Attachment files");
  lines.push("----------------");
  if (state.fileResult) {
    const f = state.fileResult;
    lines.push(`- total files: ${f.totalFiles}`);
    lines.push(`- looks plain: ${f.plainFiles}`);
    lines.push(`- looks encrypted: ${f.encryptedFiles}`);
    lines.push(`    in attachments: ${f.perSource.attachments}`);
    lines.push(`    in evidenceAttachments: ${f.perSource.evidenceAttachments}`);
    lines.push(`- unreadable: ${f.unreadableFiles}`);
    if (f.sampleEncryptedPaths.length > 0) {
      lines.push(`- sample encrypted paths:`);
      for (const p of f.sampleEncryptedPaths) lines.push(`    ${p}`);
    }
    if (f.sampleUnreadable.length > 0) {
      lines.push(`- sample unreadable:`);
      for (const u of f.sampleUnreadable) lines.push(`    ${u.path} — ${u.error}`);
    }
  } else {
    lines.push("(file scan did not run)");
  }

  return lines.join("\n");
}

function computeTotalSuspicious(state: ScanState): number {
  let total = 0;
  for (const t of state.tableResults) {
    total += t.markerRows + t.suspiciousFieldRows;
  }
  if (state.fileResult) {
    total += state.fileResult.encryptedFiles + state.fileResult.unreadableFiles;
  }
  return total;
}

export default function DecryptionVerificationPanel({
  collapsedByDefault = false,
  disabled = false,
  onRunningChange,
}: {
  collapsedByDefault?: boolean;
  disabled?: boolean;
  onRunningChange?: (running: boolean) => void;
} = {}) {
  const { toast } = useToast();
  const [collapsed, setCollapsed] = useState(collapsedByDefault);
  const [flags, setFlags] = useState<VaultFlagsState>({
    legacyDecryptComplete: false,
    legacyDecryptCompletedTables: [],
    legacyFileDecryptComplete: false,
    loaded: false,
  });
  const [scan, setScan] = useState<ScanState>(initialScanState);
  const abortRef = useRef<AbortController | null>(null);

  const loadFlags = useCallback(async () => {
    try {
      const settings = await getVaultSettings();
      const [decryptDone, fileDone, completed] = await Promise.all([
        isLegacyDecryptComplete(),
        isLegacyFileDecryptComplete(),
        getLegacyDecryptCompletedTables(),
      ]);
      setFlags({
        legacyDecryptComplete: !!settings && decryptDone,
        legacyDecryptCompletedTables: completed,
        legacyFileDecryptComplete: !!settings && fileDone,
        loaded: true,
      });
    } catch (err) {
      console.error("[DecryptionVerification] Failed to load vault flags:", err);
      setFlags((prev) => ({ ...prev, loaded: true }));
    }
  }, []);

  useEffect(() => {
    loadFlags();
  }, [loadFlags]);

  const runScan = useCallback(async () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setScan({
      ...initialScanState,
      phase: "tables",
      startedAt: Date.now(),
    });

    let tableResults: TableScanResult[] = [];
    let fileResult: FileScanResult | null = null;

    try {
      tableResults = await scanTablesForEncryption({
        signal: ctrl.signal,
        onProgress: (p) => {
          setScan((prev) => ({ ...prev, tableProgress: p }));
        },
      });
      setScan((prev) => ({ ...prev, tableResults, phase: "files", tableProgress: null }));

      const fileScan = await scanFilesForEncryption({
        signal: ctrl.signal,
        onProgress: (p) => {
          setScan((prev) => ({ ...prev, fileProgress: p }));
        },
      });
      fileResult = fileScan.result;

      setScan((prev) => ({
        ...prev,
        fileResult,
        phase: "done",
        finishedAt: Date.now(),
        fileProgress: null,
      }));

      // Refresh vault flags so the user can compare.
      await loadFlags();
    } catch (err) {
      if (err instanceof ScanCancelledError) {
        setScan((prev) => ({
          ...prev,
          tableResults,
          fileResult,
          phase: "cancelled",
          finishedAt: Date.now(),
        }));
      } else {
        console.error("[DecryptionVerification] Scan failed:", err);
        setScan((prev) => ({
          ...prev,
          tableResults,
          fileResult,
          phase: "error",
          finishedAt: Date.now(),
          errorMessage: err instanceof Error ? err.message : String(err),
        }));
      }
    } finally {
      abortRef.current = null;
    }
  }, [loadFlags]);

  const cancelScan = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleCopyReport = useCallback(async () => {
    try {
      const text = buildPlainTextReport(scan, flags);
      await navigator.clipboard.writeText(text);
      toast({ title: "Report copied", description: "Plain-text report copied to clipboard." });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Copy failed",
        description: err instanceof Error ? err.message : "Could not copy report.",
      });
    }
  }, [scan, flags, toast]);

  const isRunning = scan.phase === "tables" || scan.phase === "files";
  const totalSuspicious = computeTotalSuspicious(scan);
  const hasResult = scan.phase === "done" || scan.phase === "cancelled" || scan.phase === "error";

  useEffect(() => {
    onRunningChange?.(isRunning);
  }, [isRunning, onRunningChange]);

  return (
    <Card
      className="border-warning/40 bg-warning/5 dark:bg-warning/10"
      style={{ borderColor: "hsl(var(--chart-3) / 0.5)" }}
      data-testid="card-decryption-verification"
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <FlaskConical className="h-4 w-4" />
              Decryption Verification
              <Badge variant="outline" data-testid="badge-temporary">TEMPORARY DIAGNOSTIC</Badge>
            </CardTitle>
            <CardDescription>
              One-shot read-only scan that checks every legacy-encrypted table and attachment file
              for any data that still looks encrypted. Safe to remove once you're satisfied.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCollapsed((c) => !c)}
              data-testid="button-toggle-decryption-verification"
            >
              {collapsed ? "Show" : "Hide"}
            </Button>
          </div>
        </div>
      </CardHeader>

      {!collapsed && (
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {!isRunning ? (
              <Button onClick={runScan} disabled={disabled} data-testid="button-run-decryption-scan">
                <Play className="h-4 w-4 mr-2" />
                Run scan
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={cancelScan}
                data-testid="button-cancel-decryption-scan"
              >
                <Square className="h-4 w-4 mr-2" />
                Cancel
              </Button>
            )}
            {hasResult && (
              <Button
                variant="outline"
                onClick={handleCopyReport}
                data-testid="button-copy-decryption-report"
              >
                <ClipboardCopy className="h-4 w-4 mr-2" />
                Copy report
              </Button>
            )}
            {isRunning && (
              <span className="text-sm text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" />
                {scan.phase === "tables" ? "Scanning tables…" : "Scanning files…"}
              </span>
            )}
          </div>

          {/* Vault flag summary */}
          <div
            className="rounded-md border p-3 text-sm space-y-1"
            data-testid="section-vault-flags"
          >
            <div className="font-medium mb-1">Vault flags (what the app thinks)</div>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-muted-foreground">legacyDecryptComplete</span>
              <Badge
                variant={flags.legacyDecryptComplete ? "secondary" : "outline"}
                data-testid="badge-flag-decrypt-complete"
              >
                {flags.legacyDecryptComplete ? "true" : "false"}
              </Badge>
            </div>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-muted-foreground">legacyFileDecryptComplete</span>
              <Badge
                variant={flags.legacyFileDecryptComplete ? "secondary" : "outline"}
                data-testid="badge-flag-file-decrypt-complete"
              >
                {flags.legacyFileDecryptComplete ? "true" : "false"}
              </Badge>
            </div>
            <div>
              <span className="text-muted-foreground">legacyDecryptCompletedTables</span>
              <div className="mt-1 flex flex-wrap gap-1" data-testid="list-completed-tables">
                {flags.legacyDecryptCompletedTables.length === 0 ? (
                  <span className="text-xs text-muted-foreground italic">(none)</span>
                ) : (
                  flags.legacyDecryptCompletedTables.map((t) => (
                    <Badge key={t} variant="outline" data-testid={`badge-completed-${t}`}>
                      {t}
                    </Badge>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Live progress */}
          {scan.tableProgress && (
            <div className="space-y-1" data-testid="progress-tables">
              <div className="flex items-center justify-between text-xs text-muted-foreground gap-2 flex-wrap">
                <span>
                  Table {scan.tableProgress.tableIndex + 1} / {scan.tableProgress.tableCount}:{" "}
                  {scan.tableProgress.tableName}
                </span>
                <span>
                  {scan.tableProgress.rowsScanned} / {scan.tableProgress.totalRowsInTable} rows
                </span>
              </div>
              <Progress
                value={
                  scan.tableProgress.totalRowsInTable > 0
                    ? (scan.tableProgress.rowsScanned / scan.tableProgress.totalRowsInTable) * 100
                    : 100
                }
              />
            </div>
          )}
          {scan.fileProgress && (
            <div className="space-y-1" data-testid="progress-files">
              <div className="flex items-center justify-between text-xs text-muted-foreground gap-2 flex-wrap">
                <span>
                  Files {scan.fileProgress.current} / {scan.fileProgress.total}
                </span>
                <span>
                  plain {scan.fileProgress.plain} · enc {scan.fileProgress.encrypted} · unread{" "}
                  {scan.fileProgress.unreadable}
                </span>
              </div>
              <Progress
                value={
                  scan.fileProgress.total > 0
                    ? (scan.fileProgress.current / scan.fileProgress.total) * 100
                    : 100
                }
              />
            </div>
          )}

          {/* Verdict */}
          {hasResult && (
            <VerdictBanner
              phase={scan.phase}
              totalSuspicious={totalSuspicious}
              errorMessage={scan.errorMessage}
            />
          )}

          {/* Per-table cards */}
          {scan.tableResults.length > 0 && (
            <div className="space-y-2" data-testid="section-table-results">
              <div className="text-sm font-medium">Tables</div>
              <div className="grid gap-2 sm:grid-cols-2">
                {scan.tableResults.map((t) => (
                  <TableResultCard key={t.tableName} result={t} />
                ))}
              </div>
            </div>
          )}

          {/* Attachment summary */}
          {scan.fileResult && (
            <div data-testid="section-file-results">
              <div className="text-sm font-medium mb-2">Attachment files</div>
              <FileResultCard result={scan.fileResult} />
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function VerdictBanner({
  phase,
  totalSuspicious,
  errorMessage,
}: {
  phase: ScanPhase;
  totalSuspicious: number;
  errorMessage?: string;
}) {
  if (phase === "error") {
    return (
      <div
        className="rounded-md border border-destructive/40 bg-destructive/10 p-3 flex items-start gap-2"
        data-testid="verdict-error"
      >
        <XCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
        <div className="text-sm">
          <div className="font-medium text-destructive">Scan failed</div>
          <div className="text-muted-foreground">{errorMessage ?? "Unknown error"}</div>
        </div>
      </div>
    );
  }
  if (phase === "cancelled") {
    return (
      <div
        className="rounded-md border p-3 flex items-start gap-2"
        data-testid="verdict-cancelled"
      >
        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
        <div className="text-sm">
          <div className="font-medium">Scan cancelled</div>
          <div className="text-muted-foreground">
            Showing partial results from before the scan was stopped.
          </div>
        </div>
      </div>
    );
  }
  if (totalSuspicious === 0) {
    return (
      <div
        className="rounded-md border border-green-500/40 bg-green-500/10 p-3 flex items-start gap-2"
        data-testid="verdict-clear"
      >
        <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400 mt-0.5 shrink-0" />
        <div className="text-sm">
          <div className="font-medium text-green-700 dark:text-green-300">
            All clear — no legacy encryption detected
          </div>
          <div className="text-muted-foreground">
            Every scanned table and attachment file looks like plaintext.
          </div>
        </div>
      </div>
    );
  }
  return (
    <div
      className="rounded-md border border-destructive/40 bg-destructive/10 p-3 flex items-start gap-2"
      data-testid="verdict-suspicious"
    >
      <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
      <div className="text-sm">
        <div className="font-medium text-destructive">
          Found {totalSuspicious} item{totalSuspicious === 1 ? "" : "s"} that still look encrypted
        </div>
        <div className="text-muted-foreground">
          See the per-table and per-file breakdown below for details.
        </div>
      </div>
    </div>
  );
}

function TableResultCard({ result }: { result: TableScanResult }) {
  const suspicious = result.markerRows + result.suspiciousFieldRows;
  const isClean = suspicious === 0 && !result.error;
  return (
    <div
      className={`rounded-md border p-3 text-sm space-y-2 ${
        isClean ? "" : "border-destructive/40 bg-destructive/5"
      }`}
      data-testid={`table-result-${result.tableName.replace(/\s+/g, "-")}`}
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="font-medium">{result.tableName}</div>
        {isClean ? (
          <Badge variant="secondary">clean</Badge>
        ) : (
          <Badge variant="destructive">{suspicious} suspicious</Badge>
        )}
      </div>
      <div className="text-xs text-muted-foreground">
        {result.totalRows} row{result.totalRows === 1 ? "" : "s"} scanned
      </div>
      {result.error ? (
        <div className="text-xs text-destructive">Error: {result.error}</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-1 text-xs">
            <div>
              <span className="text-muted-foreground">Legacy markers:</span>{" "}
              <span className="font-mono">{result.markerRows}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Suspicious fields:</span>{" "}
              <span className="font-mono">{result.suspiciousFieldRows}</span>
            </div>
          </div>
          {(result.sampleMarkerIds.length > 0 || result.sampleSuspiciousIds.length > 0) && (
            <div className="text-xs text-muted-foreground space-y-1">
              {result.sampleMarkerIds.length > 0 && (
                <div>
                  Sample marker IDs:{" "}
                  <span className="font-mono">{result.sampleMarkerIds.join(", ")}</span>
                </div>
              )}
              {result.sampleSuspiciousIds.length > 0 && (
                <div>
                  Sample suspicious IDs:{" "}
                  <span className="font-mono">{result.sampleSuspiciousIds.join(", ")}</span>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FileResultCard({ result }: { result: FileScanResult }) {
  const suspicious = result.encryptedFiles + result.unreadableFiles;
  const isClean = suspicious === 0;
  return (
    <div
      className={`rounded-md border p-3 text-sm space-y-2 ${
        isClean ? "" : "border-destructive/40 bg-destructive/5"
      }`}
      data-testid="file-result-card"
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="font-medium">All attachment files</div>
        {isClean ? (
          <Badge variant="secondary">clean</Badge>
        ) : (
          <Badge variant="destructive">{suspicious} suspicious</Badge>
        )}
      </div>
      <div className="grid grid-cols-2 gap-1 text-xs sm:grid-cols-4">
        <div>
          <span className="text-muted-foreground">Total:</span>{" "}
          <span className="font-mono">{result.totalFiles}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Plain:</span>{" "}
          <span className="font-mono">{result.plainFiles}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Encrypted:</span>{" "}
          <span className="font-mono">{result.encryptedFiles}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Unreadable:</span>{" "}
          <span className="font-mono">{result.unreadableFiles}</span>
        </div>
      </div>
      <div className="text-xs text-muted-foreground">
        attachments: {result.perSource.attachments} · evidenceAttachments:{" "}
        {result.perSource.evidenceAttachments}
      </div>
      {result.sampleEncryptedPaths.length > 0 && (
        <div className="text-xs text-muted-foreground">
          <div className="mb-1">Sample encrypted paths:</div>
          <ul className="space-y-0.5">
            {result.sampleEncryptedPaths.map((p) => (
              <li key={p} className="font-mono break-all" data-testid={`sample-encrypted-${p}`}>
                {p}
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.sampleUnreadable.length > 0 && (
        <div className="text-xs text-muted-foreground">
          <div className="mb-1">Sample unreadable files:</div>
          <ul className="space-y-0.5">
            {result.sampleUnreadable.map((u) => (
              <li
                key={u.path}
                className="font-mono break-all"
                data-testid={`sample-unreadable-${u.path}`}
              >
                {u.path} — {u.error}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

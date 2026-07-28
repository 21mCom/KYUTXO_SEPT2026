import { useState, useRef, useCallback } from "react";
import { Search, Loader2, AlertCircle, CheckCircle, Clock, X, RefreshCw, Info, CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNodeSettings } from "@/hooks/use-node-settings";
import { createProviderFromSettings, type BlockchainProvider } from "@/lib/blockchain-api";
import { validateAddress, formatBTC } from "@/lib/bitcoin";
import type { AddressInfo, ApiTransaction } from "@/lib/providers/types";
import { computeHistoryFromTxs } from "@/lib/providers/address-history";

type RowStatus = "pending" | "loading" | "done" | "error";
// History (First/Last Seen) is loaded on demand, separately from core stats.
type HistoryPhase = "idle" | "loading" | "done" | "error";

interface AddressRow {
  raw: string;
  isInvalid: boolean;
  invalidReason?: string;
  status: RowStatus;
  info?: AddressInfo;
  error?: string;
  historyPhase: HistoryPhase;
  historyError?: string;
  /** Running count of transactions scanned during an in-progress history walk. */
  historyScanned?: number;
}

// Fallback derivation for providers exposing neither getAddressCoreStats nor
// getAddressInfo. Reuses the shared history walk (robust outpoint-based sent
// matching) and adds the confirmed tx count + derived balance.
function deriveAddressInfoFromTxs(address: string, txs: ApiTransaction[]): AddressInfo {
  const history = computeHistoryFromTxs(address, txs);
  const receivedSats = history.receivedSats ?? 0;
  const sentSats = history.sentSats ?? 0;
  return {
    txCount: txs.filter(tx => tx.status.confirmed).length,
    receivedSats,
    sentSats,
    balanceSats: receivedSats - sentSats,
    firstSeenTime: history.firstSeenTime,
    lastSeenTime: history.lastSeenTime,
  };
}

function formatDate(unixSeconds: number | undefined): string {
  if (!unixSeconds) return "—";
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function StatusBadge({ status }: { status: RowStatus }) {
  if (status === "pending") {
    return (
      <Badge variant="secondary" className="gap-1">
        <Clock className="h-3 w-3" />
        Pending
      </Badge>
    );
  }
  if (status === "loading") {
    return (
      <Badge variant="secondary" className="gap-1">
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking
      </Badge>
    );
  }
  if (status === "done") {
    return (
      <Badge variant="secondary" className="gap-1 text-green-600 dark:text-green-400">
        <CheckCircle className="h-3 w-3" />
        Done
      </Badge>
    );
  }
  return (
    <Badge variant="destructive" className="gap-1">
      <AlertCircle className="h-3 w-3" />
      Error
    </Badge>
  );
}

// Renders the First Seen cell, which doubles as the per-row on-demand control
// for loading transaction history (First/Last Seen, and on Electrum Received/Sent).
function renderFirstSeen(row: AddressRow, onLoad: () => void, isHistoryRunning: boolean) {
  if (row.isInvalid || row.status !== "done") {
    return <span className="text-muted-foreground">—</span>;
  }
  if (row.historyPhase === "done") {
    return <span className="text-muted-foreground">{formatDate(row.info?.firstSeenTime)}</span>;
  }
  if (row.historyPhase === "loading") {
    const total = row.info?.txCount;
    const scanned = row.historyScanned;
    // Show "scanned / total" once any page has come back so long history walks
    // (exchange/mining-pool addresses) report progress instead of a bare spinner.
    const progressLabel =
      scanned !== undefined && total
        ? `${Math.min(scanned, total).toLocaleString()} / ${total.toLocaleString()}`
        : scanned !== undefined
          ? scanned.toLocaleString()
          : "Loading…";
    return (
      <span
        className="inline-flex items-center justify-end gap-1 text-muted-foreground tabular-nums"
        data-testid={`text-history-scan-${row.raw}`}
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        {progressLabel}
      </span>
    );
  }
  if (row.historyPhase === "error") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            onClick={onLoad}
            disabled={isHistoryRunning}
            className="text-destructive"
            data-testid={`button-retry-history-${row.raw}`}
          >
            <AlertCircle className="h-3 w-3 mr-1" />
            Retry
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <span className="text-xs max-w-xs block">{row.historyError}</span>
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onLoad}
      disabled={isHistoryRunning}
      data-testid={`button-load-history-${row.raw}`}
    >
      <CalendarClock className="h-3 w-3 mr-1" />
      Load
    </Button>
  );
}

interface ParseResult {
  rows: AddressRow[];
  duplicatesSkipped: number;
}

function parseInput(text: string): ParseResult {
  const lines = text
    .split(/[\n,;]+/)
    .map(l => l.trim())
    .filter(l => l.length > 0);

  const seen = new Set<string>();
  const rows: AddressRow[] = [];
  let duplicatesSkipped = 0;

  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) {
      duplicatesSkipped++;
      continue;
    }
    seen.add(key);

    const result = validateAddress(line);
    if (!result.isValid) {
      rows.push({
        raw: line,
        isInvalid: true,
        invalidReason: result.error || "Not a valid Bitcoin address",
        status: "pending",
        historyPhase: "idle",
      });
    } else {
      rows.push({ raw: line, isInvalid: false, status: "pending", historyPhase: "idle" });
    }
  }

  return { rows, duplicatesSkipped };
}

export default function AddressChecker() {
  const { nodeSettings } = useNodeSettings();
  const [pastedText, setPastedText] = useState("");
  const [rows, setRows] = useState<AddressRow[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [hasRun, setHasRun] = useState(false);
  const [duplicatesSkipped, setDuplicatesSkipped] = useState(0);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [isHistoryRunning, setIsHistoryRunning] = useState(false);
  const cancelledRef = useRef(false);
  const historyCancelledRef = useRef(false);
  // The provider used for the most recent check, reused for on-demand history.
  const providerRef = useRef<BlockchainProvider | null>(null);

  // kept for potential future use
  const _updateRow = useCallback((index: number, patch: Partial<AddressRow>) => {
    setRows(prev => prev.map((r, i) => i === index ? { ...r, ...patch } : r));
  }, []);

  const runCheck = async () => {
    setProviderError(null);
    const { rows: parsed, duplicatesSkipped: dupes } = parseInput(pastedText);
    if (parsed.length === 0 && dupes === 0) return;

    setRows(parsed);
    setDuplicatesSkipped(dupes);
    setHasRun(true);
    setIsRunning(true);
    cancelledRef.current = false;
    historyCancelledRef.current = false;

    let provider: BlockchainProvider;
    try {
      provider = createProviderFromSettings(nodeSettings);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create provider. Check your Node Connection settings.";
      setProviderError(msg);
      setIsRunning(false);
      return;
    }
    providerRef.current = provider;

    const validIndexes = parsed
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => !r.isInvalid);

    for (const { i } of validIndexes) {
      if (cancelledRef.current) break;

      setRows(prev => prev.map((r, idx) => idx === i ? { ...r, status: "loading" } : r));

      const address = parsed[i].raw;

      try {
        let info: AddressInfo;
        // historyPhase = "idle" means First/Last Seen are loaded on demand.
        // "done" means the fallback already filled them in this pass.
        let historyPhase: HistoryPhase;

        if (provider.getAddressCoreStats) {
          // Fast tier: cheap core fields only, no history pagination.
          info = await provider.getAddressCoreStats(address);
          historyPhase = "idle";
        } else if (provider.getAddressInfo) {
          // Fallback: combined call already walks history for the dates.
          info = await provider.getAddressInfo(address);
          historyPhase = "done";
        } else {
          const txs = await provider.getAddressTransactions(address);
          info = deriveAddressInfoFromTxs(address, txs);
          historyPhase = "done";
        }

        setRows(prev => prev.map((r, idx) =>
          idx === i ? { ...r, status: "done", info, historyPhase, historyError: undefined } : r
        ));
      } catch (err) {
        if (cancelledRef.current) break;
        setRows(prev => prev.map((r, idx) =>
          idx === i
            ? { ...r, status: "error", error: err instanceof Error ? err.message : "Lookup failed" }
            : r
        ));
      }
    }

    setIsRunning(false);
  };

  // Run the on-demand history walk for the given row indexes, filling First/Last
  // Seen (and, on Electrum, Received/Sent). Runs sequentially and stops early if
  // the user cancels. Errors surface per-row without aborting the others.
  const loadHistoryForIndexes = async (targets: { i: number; address: string }[]) => {
    const provider = providerRef.current;
    if (!provider || !provider.getAddressHistoryDates || targets.length === 0) return;

    historyCancelledRef.current = false;
    setIsHistoryRunning(true);

    for (const { i, address } of targets) {
      if (historyCancelledRef.current) break;

      setRows(prev => prev.map((r, idx) =>
        idx === i ? { ...r, historyPhase: "loading", historyError: undefined, historyScanned: undefined } : r
      ));

      try {
        const dates = await provider.getAddressHistoryDates!(address, (scanned) => {
          if (historyCancelledRef.current) return;
          setRows(prev => prev.map((r, idx) =>
            idx === i && r.historyPhase === "loading" ? { ...r, historyScanned: scanned } : r
          ));
        });
        if (historyCancelledRef.current) {
          setRows(prev => prev.map((r, idx) =>
            idx === i && r.historyPhase === "loading" ? { ...r, historyPhase: "idle" } : r
          ));
          break;
        }
        setRows(prev => prev.map((r, idx) => {
          if (idx !== i) return r;
          const base: AddressInfo = r.info ?? { txCount: 0, balanceSats: 0 };
          const info: AddressInfo = {
            ...base,
            firstSeenTime: dates.firstSeenTime,
            lastSeenTime: dates.lastSeenTime,
            // Only Electrum's history path supplies these; keep fast-tier values otherwise.
            receivedSats: dates.receivedSats ?? base.receivedSats,
            sentSats: dates.sentSats ?? base.sentSats,
          };
          return { ...r, historyPhase: "done", info };
        }));
      } catch (err) {
        if (historyCancelledRef.current) break;
        setRows(prev => prev.map((r, idx) =>
          idx === i
            ? { ...r, historyPhase: "error", historyError: err instanceof Error ? err.message : "History load failed" }
            : r
        ));
      }
    }

    // Revert any rows still marked loading (e.g. cancelled mid-run) back to idle.
    if (historyCancelledRef.current) {
      setRows(prev => prev.map(r => r.historyPhase === "loading" ? { ...r, historyPhase: "idle" } : r));
    }

    setIsHistoryRunning(false);
  };

  const runHistoryForRow = (index: number) => {
    if (isHistoryRunning) return;
    const row = rows[index];
    if (!row || row.isInvalid || row.status !== "done") return;
    loadHistoryForIndexes([{ i: index, address: row.raw }]);
  };

  const runHistoryForAll = () => {
    if (isHistoryRunning) return;
    const targets = rows
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.status === "done" && (r.historyPhase === "idle" || r.historyPhase === "error"))
      .map(({ r, i }) => ({ i, address: r.raw }));
    loadHistoryForIndexes(targets);
  };

  const handleCancelHistory = () => {
    historyCancelledRef.current = true;
    setIsHistoryRunning(false);
  };

  const handleReset = () => {
    cancelledRef.current = true;
    historyCancelledRef.current = true;
    providerRef.current = null;
    setIsRunning(false);
    setIsHistoryRunning(false);
    setRows([]);
    setHasRun(false);
    setDuplicatesSkipped(0);
    setProviderError(null);
    setPastedText("");
  };

  const handleCancel = () => {
    cancelledRef.current = true;
    setIsRunning(false);
  };

  const validCount = rows.filter(r => !r.isInvalid).length;
  const invalidCount = rows.filter(r => r.isInvalid).length;
  const doneCount = rows.filter(r => r.status === "done").length;
  const errorCount = rows.filter(r => r.status === "error").length;

  const hasResults = rows.length > 0;
  const allDone = validCount > 0 && (doneCount + errorCount) === validCount && !isRunning;

  // History (First/Last Seen) load progress, tracked separately from core stats.
  const historyEligibleCount = rows.filter(r => r.status === "done").length;
  const historyPendingCount = rows.filter(
    r => r.status === "done" && (r.historyPhase === "idle" || r.historyPhase === "error")
  ).length;
  const historyDoneCount = rows.filter(r => r.historyPhase === "done").length;
  const canLoadHistory = historyEligibleCount > 0 && historyPendingCount > 0 && !isRunning && !isHistoryRunning;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Search className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Address Checker</h1>
            <p className="text-muted-foreground">
              Query live on-chain stats for any Bitcoin address — no data is saved
            </p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Paste Addresses</CardTitle>
            <CardDescription>
              One address per line. Results are queried from your configured node and never written to your vault.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Textarea
              placeholder={`bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh\nbc1q...\n1A1zP1...`}
              className="min-h-[160px] font-mono text-sm"
              value={pastedText}
              onChange={e => setPastedText(e.target.value)}
              disabled={isRunning}
              data-testid="textarea-address-input"
            />

            <div className="flex items-center gap-2 flex-wrap">
              <Button
                onClick={runCheck}
                disabled={!pastedText.trim() || isRunning}
                data-testid="button-run-check"
              >
                {isRunning ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Checking…
                  </>
                ) : (
                  <>
                    <Search className="h-4 w-4 mr-2" />
                    Check Addresses
                  </>
                )}
              </Button>

              {isRunning && (
                <Button variant="outline" onClick={handleCancel} data-testid="button-cancel-check">
                  <X className="h-4 w-4 mr-2" />
                  Cancel
                </Button>
              )}

              {canLoadHistory && (
                <Button
                  variant="outline"
                  onClick={runHistoryForAll}
                  data-testid="button-load-history-all"
                >
                  <CalendarClock className="h-4 w-4 mr-2" />
                  Load First/Last Seen ({historyPendingCount})
                </Button>
              )}

              {isHistoryRunning && (
                <Button variant="outline" onClick={handleCancelHistory} data-testid="button-cancel-history">
                  <X className="h-4 w-4 mr-2" />
                  Cancel
                </Button>
              )}

              {hasResults && !isRunning && !isHistoryRunning && (
                <Button variant="outline" onClick={handleReset} data-testid="button-reset-check">
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Reset
                </Button>
              )}

              {isRunning && validCount > 0 && (
                <span className="text-sm text-muted-foreground" data-testid="text-progress">
                  {doneCount + errorCount} / {validCount} complete
                </span>
              )}

              {isHistoryRunning && (
                <span className="text-sm text-muted-foreground inline-flex items-center gap-2" data-testid="text-history-progress">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Loading history {historyDoneCount} / {historyEligibleCount}
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        {providerError && (
          <Alert variant="destructive" data-testid="alert-provider-error">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              <strong>Node connection error:</strong> {providerError} Visit{" "}
              <a href="#/node-settings" className="underline">Node Connection settings</a> to fix this.
            </AlertDescription>
          </Alert>
        )}

        {hasResults && (
          <>
            {duplicatesSkipped > 0 && (
              <Alert data-testid="alert-duplicates-skipped">
                <Info className="h-4 w-4" />
                <AlertDescription>
                  {duplicatesSkipped} duplicate line{duplicatesSkipped !== 1 ? "s were" : " was"} skipped — each address is checked only once.
                </AlertDescription>
              </Alert>
            )}

            {invalidCount > 0 && (
              <Alert variant="destructive" data-testid="alert-invalid-addresses">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  {invalidCount} invalid line{invalidCount !== 1 ? "s were" : " was"} flagged (not valid Bitcoin addresses) — they appear in the table below but are not queried.
                </AlertDescription>
              </Alert>
            )}

            {allDone && errorCount === 0 && (
              <Alert data-testid="alert-check-complete">
                <CheckCircle className="h-4 w-4" />
                <AlertDescription>
                  All {validCount} address{validCount !== 1 ? "es" : ""} checked successfully.
                </AlertDescription>
              </Alert>
            )}

            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[200px]">Address</TableHead>
                      <TableHead className="text-right">Status</TableHead>
                      <TableHead className="text-right">Transactions</TableHead>
                      <TableHead className="text-right">Total Received</TableHead>
                      <TableHead className="text-right">Total Sent</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                      <TableHead className="text-right">First Seen</TableHead>
                      <TableHead className="text-right">Last Seen</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row, i) => (
                      <TableRow
                        key={i}
                        data-testid={`row-address-${i}`}
                        data-funded={
                          !row.isInvalid &&
                          row.status === "done" &&
                          (row.info?.balanceSats ?? 0) > 0
                            ? "true"
                            : undefined
                        }
                        className={[
                          row.isInvalid ? "opacity-50" : "",
                          !row.isInvalid &&
                          row.status === "done" &&
                          (row.info?.balanceSats ?? 0) > 0
                            ? "bg-primary/10 hover:bg-primary/15 dark:bg-primary/15 dark:hover:bg-primary/20"
                            : "",
                        ]
                          .filter(Boolean)
                          .join(" ") || undefined}
                      >
                        <TableCell className="font-mono text-xs">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="cursor-default">
                                {row.raw.length > 24
                                  ? `${row.raw.slice(0, 10)}…${row.raw.slice(-10)}`
                                  : row.raw}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="right">
                              <span className="font-mono text-xs break-all max-w-xs block">{row.raw}</span>
                            </TooltipContent>
                          </Tooltip>
                        </TableCell>

                        <TableCell className="text-right">
                          {row.isInvalid ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span>
                                  <Badge variant="destructive" className="gap-1 cursor-default">
                                    <AlertCircle className="h-3 w-3" />
                                    Invalid
                                  </Badge>
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>
                                <span className="text-xs">{row.invalidReason}</span>
                              </TooltipContent>
                            </Tooltip>
                          ) : row.status === "error" ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span>
                                  <StatusBadge status="error" />
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>
                                <span className="text-xs max-w-xs block">{row.error}</span>
                              </TooltipContent>
                            </Tooltip>
                          ) : (
                            <StatusBadge status={row.status} />
                          )}
                        </TableCell>

                        <TableCell className="text-right tabular-nums" data-testid={`cell-txcount-${i}`}>
                          {row.info ? row.info.txCount.toLocaleString() : "—"}
                        </TableCell>

                        <TableCell className="text-right tabular-nums" data-testid={`cell-received-${i}`}>
                          {row.info && row.info.receivedSats !== undefined ? (
                            <span className="font-mono text-xs">{formatBTC(row.info.receivedSats)}</span>
                          ) : "—"}
                        </TableCell>

                        <TableCell className="text-right tabular-nums" data-testid={`cell-sent-${i}`}>
                          {row.info && row.info.sentSats !== undefined ? (
                            <span className="font-mono text-xs">{formatBTC(row.info.sentSats)}</span>
                          ) : "—"}
                        </TableCell>

                        <TableCell className="text-right tabular-nums" data-testid={`cell-balance-${i}`}>
                          {row.info ? (
                            <span className="font-mono text-xs">{formatBTC(row.info.balanceSats)}</span>
                          ) : "—"}
                        </TableCell>

                        <TableCell className="text-right text-xs" data-testid={`cell-firstseen-${i}`}>
                          {renderFirstSeen(row, () => runHistoryForRow(i), isHistoryRunning)}
                        </TableCell>

                        <TableCell className="text-right text-xs text-muted-foreground" data-testid={`cell-lastseen-${i}`}>
                          {row.status === "done" && row.historyPhase === "done"
                            ? formatDate(row.info?.lastSeenTime)
                            : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

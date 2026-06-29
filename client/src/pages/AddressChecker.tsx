import { useState, useRef, useCallback } from "react";
import { Search, Loader2, AlertCircle, CheckCircle, Clock, X, RefreshCw, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNodeSettings } from "@/hooks/use-node-settings";
import { createProviderFromSettings } from "@/lib/blockchain-api";
import { validateAddress, formatBTC } from "@/lib/bitcoin";
import type { AddressInfo, ApiTransaction } from "@/lib/providers/types";

type RowStatus = "pending" | "loading" | "done" | "error";

interface AddressRow {
  raw: string;
  isInvalid: boolean;
  invalidReason?: string;
  status: RowStatus;
  info?: AddressInfo;
  error?: string;
}

function deriveAddressInfoFromTxs(address: string, txs: ApiTransaction[]): AddressInfo {
  let receivedSats = 0;
  let sentSats = 0;
  let firstSeenTime: number | undefined;
  let lastSeenTime: number | undefined;

  for (const tx of txs) {
    if (!tx.status.confirmed) continue;
    const blockTime = tx.status.block_time;
    if (blockTime) {
      if (firstSeenTime === undefined || blockTime < firstSeenTime) firstSeenTime = blockTime;
      if (lastSeenTime === undefined || blockTime > lastSeenTime) lastSeenTime = blockTime;
    }
    for (const out of tx.vout) {
      if (out.scriptpubkey_address === address) receivedSats += out.value;
    }
    for (const inp of tx.vin) {
      if (inp.prevout?.scriptpubkey_address === address) sentSats += inp.prevout.value;
    }
  }

  return {
    txCount: txs.filter(tx => tx.status.confirmed).length,
    receivedSats,
    sentSats,
    balanceSats: receivedSats - sentSats,
    firstSeenTime,
    lastSeenTime,
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
      });
    } else {
      rows.push({ raw: line, isInvalid: false, status: "pending" });
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
  const cancelledRef = useRef(false);

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

    let provider: ReturnType<typeof createProviderFromSettings>;
    try {
      provider = createProviderFromSettings(nodeSettings);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create provider. Check your Node Connection settings.";
      setProviderError(msg);
      setIsRunning(false);
      return;
    }

    const validIndexes = parsed
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => !r.isInvalid);

    for (const { i } of validIndexes) {
      if (cancelledRef.current) break;

      setRows(prev => prev.map((r, idx) => idx === i ? { ...r, status: "loading" } : r));

      const address = parsed[i].raw;

      try {
        let info: AddressInfo;

        if (provider.getAddressInfo) {
          info = await provider.getAddressInfo(address);
        } else {
          const txs = await provider.getAddressTransactions(address);
          info = deriveAddressInfoFromTxs(address, txs);
        }

        setRows(prev => prev.map((r, idx) =>
          idx === i ? { ...r, status: "done", info } : r
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

  const handleReset = () => {
    cancelledRef.current = true;
    setIsRunning(false);
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

              {hasResults && !isRunning && (
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
                        className={row.isInvalid ? "opacity-50" : undefined}
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
                          {row.info ? (
                            <span className="font-mono text-xs">{formatBTC(row.info.receivedSats)}</span>
                          ) : "—"}
                        </TableCell>

                        <TableCell className="text-right tabular-nums" data-testid={`cell-sent-${i}`}>
                          {row.info ? (
                            <span className="font-mono text-xs">{formatBTC(row.info.sentSats)}</span>
                          ) : "—"}
                        </TableCell>

                        <TableCell className="text-right tabular-nums" data-testid={`cell-balance-${i}`}>
                          {row.info ? (
                            <span className="font-mono text-xs">{formatBTC(row.info.balanceSats)}</span>
                          ) : "—"}
                        </TableCell>

                        <TableCell className="text-right text-xs text-muted-foreground" data-testid={`cell-firstseen-${i}`}>
                          {row.info ? formatDate(row.info.firstSeenTime) : "—"}
                        </TableCell>

                        <TableCell className="text-right text-xs text-muted-foreground" data-testid={`cell-lastseen-${i}`}>
                          {row.info ? formatDate(row.info.lastSeenTime) : "—"}
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

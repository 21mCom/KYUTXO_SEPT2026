import { useState, useRef, useCallback, useEffect, memo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Search, Loader2, AlertCircle, CheckCircle, Clock, X, RefreshCw, Info, CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useNodeSettings } from "@/hooks/use-node-settings";
import { createProviderFromSettings, type BlockchainProvider } from "@/lib/blockchain-api";
import { validateAddress, formatBTC } from "@/lib/bitcoin";
import type { AddressInfo, ApiTransaction } from "@/lib/providers/types";
import { computeHistoryFromTxs } from "@/lib/providers/address-history";
import { runWithConcurrency, chunk, createPatchBuffer } from "@/lib/address-checker-run";

// Provider-aware concurrency: an Electrum node over the pooled multiplexed
// socket tolerates many parallel lookups; public HTTP APIs (mempool.space,
// Blockstream…) get a conservative bound so we don't trip rate limits.
const ELECTRUM_CONCURRENCY = 8;
const HTTP_CONCURRENCY = 3;
// Electrum batch-history chunk size (addresses per IPC round-trip).
const ELECTRUM_BATCH_SIZE = 40;
// How often accumulated row patches are flushed into React state.
const ROW_FLUSH_INTERVAL_MS = 250;
// On-demand history walks run a few at a time. Kept conservative because each
// walk already fans out its own tx fetches internally.
const HISTORY_CONCURRENCY = 3;

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

// One table row, memoized so the 250 ms patch flushes only re-render rows
// whose object identity actually changed. Without this, a 5,000-address run
// re-renders the ENTIRE table (with per-cell Radix tooltips) on every flush —
// measured at multi-second main-thread freezes in a real browser.
const AddressCheckRow = memo(function AddressCheckRow({
  row,
  i,
  virtualIndex,
  measureRef,
  isHistoryRunning,
  onLoadHistory,
}: {
  row: AddressRow;
  i: number;
  /** Index of this row inside the virtualizer's item list (displayRows). */
  virtualIndex: number;
  /** rowVirtualizer.measureElement — dynamic row-height measurement. */
  measureRef: (el: HTMLTableRowElement | null) => void;
  isHistoryRunning: boolean;
  onLoadHistory: (index: number) => void;
}) {
  return (
    <TableRow
      ref={measureRef}
      data-index={virtualIndex}
      data-testid={`row-address-${i}`}
      data-funded={
        !row.isInvalid && row.status === "done" && (row.info?.balanceSats ?? 0) > 0
          ? "true"
          : undefined
      }
      className={[
        row.isInvalid ? "opacity-50" : "",
        !row.isInvalid && row.status === "done" && (row.info?.balanceSats ?? 0) > 0
          ? "bg-primary/10 hover:bg-primary/15 dark:bg-primary/15 dark:hover:bg-primary/20"
          : "",
      ]
        .filter(Boolean)
        .join(" ") || undefined}
    >
      {/* Native title tooltip: mounting a Radix Tooltip per address cell made
          the initial render of a 5,000-row list freeze the main thread for
          seconds. The full address stays reachable via the title attribute. */}
      <TableCell className="font-mono text-xs">
        <span className="cursor-default" title={row.raw}>
          {row.raw.length > 24
            ? `${row.raw.slice(0, 10)}…${row.raw.slice(-10)}`
            : row.raw}
        </span>
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
        {row.info && row.info.txCount !== 0 ? row.info.txCount.toLocaleString() : "—"}
      </TableCell>

      <TableCell className="text-right tabular-nums" data-testid={`cell-received-${i}`}>
        {row.info && row.info.receivedSats !== undefined && row.info.receivedSats !== 0 ? (
          <span className="font-mono text-xs">{formatBTC(row.info.receivedSats)}</span>
        ) : "—"}
      </TableCell>

      <TableCell className="text-right tabular-nums" data-testid={`cell-sent-${i}`}>
        {row.info && row.info.sentSats !== undefined && row.info.sentSats !== 0 ? (
          <span className="font-mono text-xs">{formatBTC(row.info.sentSats)}</span>
        ) : "—"}
      </TableCell>

      <TableCell className="text-right tabular-nums" data-testid={`cell-balance-${i}`}>
        {row.info && row.info.balanceSats !== 0 ? (
          <span className="font-mono text-xs">{formatBTC(row.info.balanceSats)}</span>
        ) : "—"}
      </TableCell>

      <TableCell className="text-right text-xs" data-testid={`cell-firstseen-${i}`}>
        {renderFirstSeen(row, () => onLoadHistory(i), isHistoryRunning)}
      </TableCell>

      <TableCell className="text-right text-xs text-muted-foreground" data-testid={`cell-lastseen-${i}`}>
        {row.status === "done" && row.historyPhase === "done"
          ? formatDate(row.info?.lastSeenTime)
          : "—"}
      </TableCell>
    </TableRow>
  );
});

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
  // Electrum batch prefetch progress: how many addresses have had their tx
  // counts fetched so far, out of all valid addresses. Non-null only while the
  // batch prefetch phase is running, so the UI can show movement before any
  // row is marked done. Null on HTTP (non-batch) providers.
  const [prefetchProgress, setPrefetchProgress] = useState<{ fetched: number; total: number } | null>(null);
  // When on, hides completed rows with 0 confirmed transactions from the table.
  const [hideZeroTx, setHideZeroTx] = useState(false);
  const cancelledRef = useRef(false);
  // Monotonic run token: each runCheck invocation bumps it and captures its
  // own value. Workers from a superseded run (user cancels then immediately
  // starts a new run while old lookups are still in flight) see a stale token
  // and stop; their buffered patches are dropped so they can never corrupt
  // the new run's rows.
  const runIdRef = useRef(0);
  const historyCancelledRef = useRef(false);
  // Monotonic history run token, mirroring runIdRef: a new history run bumps it
  // and resets the cancel flag, so workers/flushes/finalizers from a superseded
  // run see a stale token and become no-ops instead of mutating the new run's
  // rows or prematurely re-enabling the history controls.
  const historyRunIdRef = useRef(0);
  // Page-level scroll element + list offset for the row virtualizer: the
  // table does not own a scroll container, the whole page scrolls as one.
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  // The provider used for the most recent check, reused for on-demand history.
  const providerRef = useRef<BlockchainProvider | null>(null);
  // Mirrors of `rows` / `isHistoryRunning` so per-row callbacks passed to the
  // memoized table rows can stay referentially stable across renders.
  const rowsRef = useRef<AddressRow[]>(rows);
  rowsRef.current = rows;
  const isHistoryRunningRef = useRef(false);
  useEffect(() => {
    isHistoryRunningRef.current = isHistoryRunning;
  }, [isHistoryRunning]);

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
    setPrefetchProgress(null);
    setHasRun(true);
    setIsRunning(true);
    cancelledRef.current = false;
    historyCancelledRef.current = false;
    // A new check owns the rows: permanently invalidate any prior history
    // workers so late completions can't write onto the new dataset (clearing
    // the cancel flag alone would re-enable them).
    historyRunIdRef.current++;
    // Stale history runs no longer run their finalizer, so the new check must
    // resolve the history control state itself or it could stay stuck "running".
    setIsHistoryRunning(false);
    const runToken = ++runIdRef.current;
    const isStale = () => runIdRef.current !== runToken;
    // "Cancelled" for this run means either the user hit Cancel/Reset or a
    // newer run has taken over.
    const isCancelled = () => cancelledRef.current || isStale();

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

    // Row updates are buffered and flushed on a short interval so a huge run
    // re-renders the table a few times per second, not twice per address.
    const buffer = createPatchBuffer<AddressRow>(patches => {
      // A newer run owns the rows now — drop patches from this stale run.
      if (isStale()) return;
      setRows(prev => prev.map((r, idx) => {
        const patch = patches.get(idx);
        return patch ? { ...r, ...patch } : r;
      }));
    }, ROW_FLUSH_INTERVAL_MS);

    try {
      // Electrum batch fast-path: fetch tx counts for whole chunks of
      // addresses in one IPC round-trip each. Failures (whole batch or
      // per-address) simply leave the address out of the map — the worker
      // pool below falls back to per-address core-stats calls for those.
      const canBatch = !!provider.getAddressTxCountsBatch && !!provider.getAddressBalanceSats;
      const canBatchBalances = canBatch && !!provider.getAddressBalancesBatch;
      const batchTxCounts = new Map<string, number>();
      const batchBalances = new Map<string, number>();
      if (canBatch) {
        const batches = chunk(validIndexes.map(({ i }) => parsed[i].raw), ELECTRUM_BATCH_SIZE);
        // Surface prefetch progress immediately so a multi-minute batch phase
        // never looks hung at "0 / N complete". Updated once per batch — a few
        // times per second at most, so plain setState (no buffering) is fine.
        let prefetched = 0;
        if (!isStale() && batches.length > 0) {
          setPrefetchProgress({ fetched: 0, total: validIndexes.length });
        }
        try {
          for (const batch of batches) {
            if (isCancelled()) break;
            try {
              const counts = await provider.getAddressTxCountsBatch!(batch);
              for (const [addr, value] of counts) {
                if (typeof value === "number") batchTxCounts.set(addr, value);
              }
            } catch (err) {
              // Whole-batch failure: fall back to per-address lookups below.
              console.warn("[AddressChecker] Batch history failed, falling back per-address:", err);
            }
            if (canBatchBalances && !isCancelled()) {
              try {
                const balances = await provider.getAddressBalancesBatch!(batch);
                for (const [addr, value] of balances) {
                  if (typeof value === "number") batchBalances.set(addr, value);
                }
              } catch (err) {
                // Whole-batch failure: the worker pool below falls back to
                // per-address balance lookups for this chunk.
                console.warn("[AddressChecker] Batch balances failed, falling back per-address:", err);
              }
            }
            // Count attempted addresses (even batch failures) — this tracks
            // phase progress, not success; failures fall back per-address below.
            prefetched += batch.length;
            if (!isStale()) {
              setPrefetchProgress({ fetched: prefetched, total: validIndexes.length });
            }
          }
        } finally {
          // Prefetch phase over (completed or cancelled): hand the visible
          // progress back to the main counter / worker pool.
          if (!isStale()) setPrefetchProgress(null);
        }
      }

      const concurrency = canBatch ? ELECTRUM_CONCURRENCY : HTTP_CONCURRENCY;

      await runWithConcurrency(
        validIndexes,
        async ({ i }) => {
          buffer.add(i, { status: "loading" });
          const address = parsed[i].raw;

          try {
            let info: AddressInfo;
            // historyPhase = "idle" means First/Last Seen are loaded on demand.
            // "done" means the fallback already filled them in this pass.
            let historyPhase: HistoryPhase;

            const batchedCount = canBatch ? batchTxCounts.get(address) : undefined;
            if (batchedCount !== undefined) {
              // Tx count came from the batch. The balance usually did too;
              // per-address lookup remains only as the failure-isolation
              // fallback for rows the balance batch missed.
              const batchedBalance = batchBalances.get(address);
              const balanceSats =
                batchedBalance !== undefined
                  ? batchedBalance
                  : await provider.getAddressBalanceSats!(address);
              info = { txCount: batchedCount, balanceSats };
              historyPhase = "idle";
            } else if (provider.getAddressCoreStats) {
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

            if (isCancelled()) {
              buffer.add(i, { status: "pending" });
              return;
            }
            buffer.add(i, { status: "done", info, historyPhase, historyError: undefined });
          } catch (err) {
            if (isCancelled()) {
              buffer.add(i, { status: "pending" });
              return;
            }
            buffer.add(i, {
              status: "error",
              error: err instanceof Error ? err.message : "Lookup failed",
            });
          }
        },
        { concurrency, isCancelled },
      );
    } finally {
      buffer.stop();
      // A superseded run must not touch the new run's state at all.
      if (!isStale()) {
        // Cancellation safety net: nothing may stay stuck on "loading".
        if (cancelledRef.current) {
          setRows(prev => prev.map(r => r.status === "loading" ? { ...r, status: "pending" } : r));
        }
        setPrefetchProgress(null);
        setIsRunning(false);
      }
    }
  };

  // Run the on-demand history walk for the given row indexes, filling First/Last
  // Seen (and, on Electrum, Received/Sent). Walks run through the shared bounded
  // worker pool (a few at a time — each walk already fans out tx fetches
  // internally) and stop starting new rows promptly when the user cancels.
  // Errors surface per-row without aborting the others. High-frequency progress
  // counter updates are buffered and flushed on an interval; the once-per-row
  // loading/done/error transitions update state directly.
  const loadHistoryForIndexes = async (targets: { i: number; address: string }[]) => {
    const provider = providerRef.current;
    if (!provider || !provider.getAddressHistoryDates || targets.length === 0) return;

    historyCancelledRef.current = false;
    setIsHistoryRunning(true);
    const runToken = ++historyRunIdRef.current;
    const isStale = () => historyRunIdRef.current !== runToken;
    // "Cancelled" for this run means either the user hit Cancel/Reset or a
    // newer history run has taken over (which reset historyCancelledRef).
    const isCancelled = () => historyCancelledRef.current || isStale();

    // Buffers the per-row scan-progress counters so a long walk over many rows
    // re-renders the table a few times per second, not once per fetched page.
    const progressBuffer = createPatchBuffer<AddressRow>(patches => {
      if (isCancelled()) return;
      setRows(prev => prev.map((r, idx) => {
        const patch = patches.get(idx);
        // Progress only applies while the row is still loading (mirrors the
        // pre-pool behavior: a late progress tick never revives a settled row).
        return patch && r.historyPhase === "loading" ? { ...r, ...patch } : r;
      }));
    }, ROW_FLUSH_INTERVAL_MS);

    try {
      await runWithConcurrency(
        targets,
        async ({ i, address }) => {
          if (isStale()) return;
          setRows(prev => prev.map((r, idx) =>
            idx === i ? { ...r, historyPhase: "loading", historyError: undefined, historyScanned: undefined } : r
          ));

          try {
            const dates = await provider.getAddressHistoryDates!(address, (scanned) => {
              if (isCancelled()) return;
              progressBuffer.add(i, { historyScanned: scanned });
            });
            if (isCancelled()) {
              // A newer run owns the rows now — a stale worker must not touch them.
              if (isStale()) return;
              setRows(prev => prev.map((r, idx) =>
                idx === i && r.historyPhase === "loading" ? { ...r, historyPhase: "idle" } : r
              ));
              return;
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
            if (isCancelled()) {
              if (isStale()) return;
              setRows(prev => prev.map((r, idx) =>
                idx === i && r.historyPhase === "loading" ? { ...r, historyPhase: "idle" } : r
              ));
              return;
            }
            setRows(prev => prev.map((r, idx) =>
              idx === i
                ? { ...r, historyPhase: "error", historyError: err instanceof Error ? err.message : "History load failed" }
                : r
            ));
          }
        },
        { concurrency: HISTORY_CONCURRENCY, isCancelled },
      );
    } finally {
      progressBuffer.stop();

      // A superseded run must not touch the new run's rows or re-enable the
      // history controls while the newer run is still going.
      if (!isStale()) {
        // Revert any rows still marked loading (e.g. cancelled mid-run) back to idle.
        if (historyCancelledRef.current) {
          setRows(prev => prev.map(r => r.historyPhase === "loading" ? { ...r, historyPhase: "idle" } : r));
        }
        setIsHistoryRunning(false);
      }
    }
  };
  // Latest loadHistoryForIndexes, so stable callbacks below can call it
  // without re-creating themselves each render.
  const loadHistoryForIndexesRef = useRef(loadHistoryForIndexes);
  loadHistoryForIndexesRef.current = loadHistoryForIndexes;

  // Stable identity (reads via refs) so memoized rows never re-render just
  // because the parent re-rendered — see AddressCheckRow.
  const runHistoryForRow = useCallback((index: number) => {
    if (isHistoryRunningRef.current) return;
    const row = rowsRef.current[index];
    if (!row || row.isInvalid || row.status !== "done") return;
    loadHistoryForIndexesRef.current([{ i: index, address: row.raw }]);
  }, []);

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
    // Permanently invalidate in-flight workers: even if a later run resets the
    // cancel flag, workers from this run stay stale and cannot mutate rows.
    historyRunIdRef.current++;
    // Revert loading rows to idle right away: in-flight workers see the cancel
    // flag and no-op, and if a new run starts before they settle they become
    // stale and must not touch rows at all — so the revert happens here.
    setRows(prev => prev.map(r => r.historyPhase === "loading" ? { ...r, historyPhase: "idle" } : r));
    setIsHistoryRunning(false);
  };

  const handleReset = () => {
    cancelledRef.current = true;
    historyCancelledRef.current = true;
    historyRunIdRef.current++;
    providerRef.current = null;
    setIsRunning(false);
    setIsHistoryRunning(false);
    setPrefetchProgress(null);
    setRows([]);
    setHasRun(false);
    setDuplicatesSkipped(0);
    setProviderError(null);
    setPastedText("");
    setHideZeroTx(false);
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

  // Rows shown in the table. Hiding only ever removes rows that finished with 0
  // confirmed transactions — pending/loading/errored and invalid rows always stay
  // visible so nothing in-flight disappears mid-run. Original indexes are kept so
  // per-row callbacks and test-ids still target the right row in state.
  const indexedRows = rows.map((row, i) => ({ row, i }));
  const displayRows = hideZeroTx
    ? indexedRows.filter(
        ({ row }) =>
          row.isInvalid || row.status !== "done" || (row.info?.txCount ?? 0) !== 0
      )
    : indexedRows;
  const hiddenCount = indexedRows.length - displayRows.length;

  // Virtualize the results table off the page scroller: mounting 5,000 rows
  // at once froze the main thread for seconds; only the visible window (plus
  // overscan) is rendered now. scrollMargin = list offset inside the page
  // scroll element (see VirtualizedUtxoList for the pattern).
  const measureScrollMargin = useCallback(() => {
    const scrollEl = scrollRef.current;
    const listEl = listRef.current;
    if (!scrollEl || !listEl) return;
    const margin =
      listEl.getBoundingClientRect().top -
      scrollEl.getBoundingClientRect().top +
      scrollEl.scrollTop;
    // 1px guard prevents update loops from sub-pixel layout jitter.
    setScrollMargin(prev => (Math.abs(prev - margin) > 1 ? margin : prev));
  }, []);
  useEffect(measureScrollMargin);
  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measureScrollMargin);
    ro.observe(scrollEl);
    return () => ro.disconnect();
  }, [measureScrollMargin]);

  const ROW_ESTIMATE = 53;
  const rowVirtualizer = useVirtualizer({
    count: displayRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 20,
    // Dynamic measurement: rows whose content wraps onto extra lines (long
    // addresses, badges, error tooltips) are taller than ROW_ESTIMATE;
    // measuring the rendered elements keeps deep scroll offsets accurate
    // instead of drifting on wrapped rows (see QuantumRiskScanner).
    measureElement: (el) => el.getBoundingClientRect().height,
    scrollMargin,
    // Stable keys so toggling "Hide 0-transaction addresses" (which shifts
    // item indices) can't reuse a cached measured size from a different row.
    getItemKey: (index) => displayRows[index]?.i ?? index,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();

  return (
    <div className="flex-1 overflow-y-auto p-6" ref={scrollRef}>
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

              {isRunning && prefetchProgress && (
                <span
                  className="text-sm text-muted-foreground inline-flex items-center gap-2 tabular-nums"
                  data-testid="text-prefetch-progress"
                >
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Fetched history for {prefetchProgress.fetched.toLocaleString()} / {prefetchProgress.total.toLocaleString()} addresses…
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

            <div className="flex items-center gap-2 flex-wrap">
              <Checkbox
                id="hide-zero-tx"
                checked={hideZeroTx}
                onCheckedChange={checked => setHideZeroTx(checked === true)}
                disabled={isRunning}
                data-testid="checkbox-hide-zero-tx"
              />
              <Label
                htmlFor="hide-zero-tx"
                className={isRunning ? "text-muted-foreground" : undefined}
              >
                Hide 0-transaction addresses
              </Label>
              {hiddenCount > 0 && (
                <span className="text-sm text-muted-foreground" data-testid="text-hidden-count">
                  {hiddenCount} address{hiddenCount !== 1 ? "es" : ""} hidden
                </span>
              )}
            </div>

            <Card>
              <CardContent className="p-0">
                <div ref={listRef}>
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
                      {virtualItems.length > 0 && virtualItems[0].start > scrollMargin && (
                        <TableRow>
                          <TableCell colSpan={8} className="p-0 border-0" style={{ height: virtualItems[0].start - scrollMargin }} />
                        </TableRow>
                      )}
                      {virtualItems.map(virtualRow => {
                        const entry = displayRows[virtualRow.index];
                        if (!entry) return null;
                        return (
                          <AddressCheckRow
                            key={entry.i}
                            row={entry.row}
                            i={entry.i}
                            virtualIndex={virtualRow.index}
                            measureRef={rowVirtualizer.measureElement}
                            isHistoryRunning={isHistoryRunning}
                            onLoadHistory={runHistoryForRow}
                          />
                        );
                      })}
                      {virtualItems.length > 0 && (() => {
                        const lastItem = virtualItems[virtualItems.length - 1];
                        // Virtual item offsets include scrollMargin; getTotalSize() does not.
                        const remaining = rowVirtualizer.getTotalSize() - (lastItem.end - scrollMargin);
                        return remaining > 0 ? (
                          <TableRow>
                            <TableCell colSpan={8} className="p-0 border-0" style={{ height: remaining }} />
                          </TableRow>
                        ) : null;
                      })()}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

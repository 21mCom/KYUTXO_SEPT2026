// Windowed, virtualized result lists for the Dormant Coins report.
//
// The full result set lives in a local IndexedDB scratch store (see
// dormant-coins-report-store.ts), NOT in memory: these components only ever
// hold the rows for the windows the user has scrolled into view, fetched on
// demand and cached by absolute row index — the same pattern as the Balance
// Integrity stale-address list.

import { useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Loader2, RadioTower, AlertCircle, CheckCircle, XCircle, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AddressLink } from "@/components/AddressLink";
import { TxidLink } from "@/components/TxidLink";
import { useToast } from "@/hooks/use-toast";
import { useNodeSettings } from "@/hooks/use-node-settings";
import { useWindowedRows } from "@/hooks/use-windowed-rows";
import { createProviderFromSettings } from "@/lib/blockchain-api";
import { transactionSyncService } from "@/lib/transaction-sync";
import { checkOutpointLive, type LiveOutpointResult } from "@/lib/dormant-live-check";
import {
  DORMANT_CLUE_LABELS,
  formatAgeYears,
  type DormantClueGroup,
  type DormantClueType,
  type DormantOutputRow,
} from "@/lib/dormant-coins";
import {
  getDormantGroupWindow,
  getDormantRowWindow,
} from "@/lib/data/dormant-coins-report-store";

const ROW_HEIGHT = 64;
const GROUP_ROW_HEIGHT = 72;

function formatSats(sats: number): string {
  return sats.toLocaleString() + " sats";
}

function formatDate(unixSec: number): string {
  if (!unixSec) return "—";
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

export function clueBadgeClass(clue: DormantClueType): string {
  switch (clue) {
    case "own-dormant":
      return "bg-green-600 text-white no-default-hover-elevate no-default-active-elevate";
    case "co-spent":
      return "bg-orange-500 text-white no-default-hover-elevate no-default-active-elevate";
    case "paid-alongside":
      return "bg-blue-500 text-white no-default-hover-elevate no-default-active-elevate";
    case "suspected-change":
      return "bg-purple-500 text-white no-default-hover-elevate no-default-active-elevate";
  }
}

// Per-row live node-check state, keyed by "txid:vout".
export type LiveCheckState =
  | { phase: "checking" }
  | { phase: "done"; result: LiveOutpointResult }
  | { phase: "error"; message: string };

// Per-address re-sync state, keyed by address. "resynced" marks the row's
// report data as stale — the user should re-run the dormant scan.
export type ResyncState = "resyncing" | "resynced";

export function DormantResultsList({
  count,
  nowSec,
}: {
  count: number;
  nowSec: number;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const { rowCacheRef, setRange, cacheVersion } = useWindowedRows(count, getDormantRowWindow);
  const { nodeSettings } = useNodeSettings();
  const nodeSettingsRef = useRef(nodeSettings);
  nodeSettingsRef.current = nodeSettings;
  const { toast } = useToast();

  // Live node-check results, keyed by outpoint. Kept here (not in the row
  // cache) so scrolling a row out of the window and back preserves its state.
  const [liveChecks, setLiveChecks] = useState<ReadonlyMap<string, LiveCheckState>>(new Map());
  // Aborts in-flight checks on unmount / when a new run rewrote the store.
  const liveAbortRef = useRef<AbortController | null>(null);

  // Per-address re-sync state ("resyncing" while the network sync runs,
  // "resynced" once local history was refreshed — meaning the report rows
  // for that address are stale until the user re-runs the scan).
  const [resyncStates, setResyncStates] = useState<ReadonlyMap<string, ResyncState>>(new Map());

  useEffect(() => {
    // A new run rewrote the store — stale live results belong to old rows.
    liveAbortRef.current?.abort();
    liveAbortRef.current = null;
    setLiveChecks(new Map());
    setResyncStates(new Map());
  }, [count]);

  useEffect(() => {
    return () => liveAbortRef.current?.abort();
  }, []);

  const runLiveCheck = useCallback(async (row: DormantOutputRow) => {
    const key = `${row.txid}:${row.vout}`;
    setLiveChecks((prev) => {
      if (prev.get(key)?.phase === "checking") return prev; // already running
      const next = new Map(prev);
      next.set(key, { phase: "checking" });
      return next;
    });
    if (!liveAbortRef.current) liveAbortRef.current = new AbortController();
    const signal = liveAbortRef.current.signal;
    try {
      const provider = createProviderFromSettings(nodeSettingsRef.current);
      const result = await checkOutpointLive(provider, row, signal);
      if (signal.aborted) return;
      setLiveChecks((prev) => {
        const next = new Map(prev);
        next.set(key, { phase: "done", result });
        return next;
      });
    } catch (err) {
      if (signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      setLiveChecks((prev) => {
        const next = new Map(prev);
        next.set(key, { phase: "error", message });
        return next;
      });
    }
  }, []);

  // One-click per-address re-sync for rows the node reported as spent —
  // mirrors the Balance page's per-address Re-sync orchestration.
  const runResync = useCallback(
    async (address: string) => {
      let started = false;
      setResyncStates((prev) => {
        if (prev.get(address) === "resyncing") return prev; // already running
        started = true;
        const next = new Map(prev);
        next.set(address, "resyncing");
        return next;
      });
      // React may re-run the updater; use the captured flag only as a guard
      // against double-starting from rapid double clicks.
      if (!started) return;

      let ok = false;
      try {
        const nodeSettings = nodeSettingsRef.current;
        if (!nodeSettings) {
          toast({
            title: "No blockchain provider configured",
            description: "Configure a provider in Settings to re-sync this address.",
            variant: "destructive",
          });
          return;
        }

        try {
          const probe = createProviderFromSettings(nodeSettings);
          await probe.getBlockHeight();
        } catch (connErr) {
          console.warn("[DormantCoins] Provider unreachable for re-sync:", connErr);
          toast({
            title: "Can't reach the blockchain provider",
            description:
              "Check your connection or provider settings in Settings, then try again.",
            variant: "destructive",
          });
          return;
        }

        transactionSyncService.updateProvider(nodeSettings);
        try {
          const result = await transactionSyncService.syncSingleAddress(address);
          ok = result.success;
        } catch (err) {
          console.warn(`[DormantCoins] Re-sync failed for ${address}:`, err);
          ok = false;
        }

        if (ok) {
          toast({
            title: "Address re-synced",
            description:
              "Local history for this address was updated. Run a new dormant scan to refresh this report.",
          });
        } else {
          toast({
            title: "Re-sync failed",
            description:
              "Couldn't re-sync this address. Check your provider settings and try again.",
            variant: "destructive",
          });
        }
      } catch (err) {
        console.warn("[DormantCoins] Re-sync failed:", err);
        ok = false;
        toast({
          title: "Re-sync failed",
          description: "Couldn't re-sync this address. Please try again.",
          variant: "destructive",
        });
      } finally {
        setResyncStates((prev) => {
          const next = new Map(prev);
          if (ok) {
            next.set(address, "resynced");
          } else {
            next.delete(address);
          }
          return next;
        });
      }
    },
    [toast],
  );

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const virtualItems = virtualizer.getVirtualItems();

  useEffect(() => {
    if (virtualItems.length === 0) return;
    setRange({
      first: virtualItems[0].index,
      last: virtualItems[virtualItems.length - 1].index,
    });
    // setRange is stable; virtualItems identity changes per scroll frame, so
    // key off the visible boundary indices instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualItems.length ? virtualItems[0].index : 0, virtualItems.length ? virtualItems[virtualItems.length - 1].index : 0]);

  return (
    <div className="border rounded-md" data-testid="list-dormant-rows">
      <div className="grid grid-cols-[minmax(0,2fr)_auto_auto_auto_auto_auto] gap-3 px-3 py-2 bg-muted/50 border-b text-xs font-medium text-muted-foreground items-center">
        <span>Address</span>
        <span>Clue</span>
        <span className="text-right">Amount</span>
        <span className="text-right">Created</span>
        <span className="text-right">Funding tx</span>
        <span className="text-right">Node check</span>
      </div>
      <div ref={parentRef} className="h-[420px] overflow-auto" data-testid="scroll-dormant-rows">
        <div
          className="relative w-full"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
          data-cache-version={cacheVersion}
        >
          {virtualItems.map((virtualRow) => {
            const row = rowCacheRef.current.get(virtualRow.index);
            if (!row) {
              return (
                <div
                  key={`loading-${virtualRow.index}`}
                  className="absolute left-0 right-0 flex items-center px-3 border-b last:border-b-0"
                  style={{ height: `${ROW_HEIGHT}px`, transform: `translateY(${virtualRow.start}px)` }}
                  data-testid={`row-dormant-loading-${virtualRow.index}`}
                >
                  <span className="text-xs text-muted-foreground">Loading…</span>
                </div>
              );
            }
            return (
              <DormantRow
                key={`${row.txid}:${row.vout}`}
                row={row}
                nowSec={nowSec}
                liveCheck={liveChecks.get(`${row.txid}:${row.vout}`)}
                onLiveCheck={runLiveCheck}
                resyncState={resyncStates.get(row.address)}
                onResync={runResync}
                style={{ height: `${ROW_HEIGHT}px`, transform: `translateY(${virtualRow.start}px)` }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Renders the "Node check" cell: the explicit per-row action that verifies
// this exact outpoint against the configured node, and its result badge.
function LiveCheckCell({
  row,
  state,
  onCheck,
  resyncState,
  onResync,
}: {
  row: DormantOutputRow;
  state: LiveCheckState | undefined;
  onCheck: (row: DormantOutputRow) => void;
  resyncState: ResyncState | undefined;
  onResync: (address: string) => void;
}) {
  const key = `${row.txid.slice(0, 12)}-${row.vout}`;
  if (state?.phase === "checking") {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-muted-foreground"
        data-testid={`live-checking-${key}`}
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking…
      </span>
    );
  }
  if (state?.phase === "done") {
    return state.result.status === "unspent" ? (
      <Badge
        variant="secondary"
        className="gap-1 text-green-600 dark:text-green-400 text-[10px] px-1.5 py-0"
        title="The node confirms this output is still unspent."
        data-testid={`live-unspent-${key}`}
      >
        <CheckCircle className="h-3 w-3" />
        Still unspent
      </Badge>
    ) : (
      <span className="inline-flex items-center gap-1.5">
        <Badge
          variant="secondary"
          className="gap-1 text-red-600 dark:text-red-400 text-[10px] px-1.5 py-0"
          title={
            state.result.spentTxid
              ? `Spent by ${state.result.spentTxid} — your local history is behind. Re-sync this address.`
              : "The node reports this output as spent — your local history is behind. Re-sync this address."
          }
          data-testid={`live-spent-${key}`}
        >
          <XCircle className="h-3 w-3" />
          Spent
        </Badge>
        {resyncState === "resyncing" ? (
          <span
            className="inline-flex items-center gap-1 text-xs text-muted-foreground"
            data-testid={`resyncing-${key}`}
          >
            <Loader2 className="h-3 w-3 animate-spin" />
            Re-syncing…
          </span>
        ) : resyncState === "resynced" ? (
          <Badge
            variant="secondary"
            className="gap-1 text-amber-600 dark:text-amber-400 text-[10px] px-1.5 py-0"
            title="Local history for this address was re-synced — this report row is stale. Run a new dormant scan to refresh it."
            data-testid={`resynced-stale-${key}`}
          >
            <RefreshCw className="h-3 w-3" />
            Re-synced — re-run scan
          </Badge>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onResync(row.address)}
            className="h-7 px-2"
            title="Re-sync just this address from your configured node to catch up your local history."
            data-testid={`button-resync-${key}`}
          >
            <RefreshCw className="h-3 w-3 mr-1" />
            Re-sync
          </Button>
        )}
      </span>
    );
  }
  if (state?.phase === "error") {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onCheck(row)}
        className="text-destructive h-7 px-2"
        title={`Could not verify (status unknown): ${state.message} Click to retry.`}
        data-testid={`button-live-retry-${key}`}
      >
        <AlertCircle className="h-3 w-3 mr-1" />
        Unknown — retry
      </Button>
    );
  }
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => onCheck(row)}
      className="h-7 px-2"
      title="Check this exact output against your configured node (explicit network request)."
      data-testid={`button-live-check-${key}`}
    >
      <RadioTower className="h-3 w-3 mr-1" />
      Check node
    </Button>
  );
}

function DormantRow({
  row,
  nowSec,
  liveCheck,
  onLiveCheck,
  resyncState,
  onResync,
  style,
}: {
  row: DormantOutputRow;
  nowSec: number;
  liveCheck: LiveCheckState | undefined;
  onLiveCheck: (row: DormantOutputRow) => void;
  resyncState: ResyncState | undefined;
  onResync: (address: string) => void;
  style: React.CSSProperties;
}) {
  return (
    <div
      className="absolute left-0 right-0 grid grid-cols-[minmax(0,2fr)_auto_auto_auto_auto_auto] items-center gap-3 px-3 border-b last:border-b-0"
      style={style}
      data-testid={`row-dormant-${row.txid.slice(0, 12)}-${row.vout}`}
    >
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-2 min-w-0">
          <AddressLink
            address={row.address}
            label={row.label}
            recordId={row.recordId ?? null}
            className="text-xs"
          />
          <Badge
            variant={row.owned ? "default" : "secondary"}
            className="text-[10px] px-1.5 py-0"
            data-testid={`badge-ownership-${row.txid.slice(0, 12)}-${row.vout}`}
          >
            {row.owned ? "Owned" : "Unknown"}
          </Badge>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Last meaningful activity {formatDate(row.lastActivity)} · age{" "}
          {formatAgeYears(row.blockTime, nowSec)} yrs
          {row.groupId != null ? ` · co-spend group #${row.groupId}` : ""}
        </p>
      </div>
      <Badge
        className={`text-[10px] px-1.5 py-0 whitespace-nowrap ${clueBadgeClass(row.clueType)}`}
        data-testid={`badge-clue-${row.txid.slice(0, 12)}-${row.vout}`}
      >
        {DORMANT_CLUE_LABELS[row.clueType]}
      </Badge>
      <span
        className="text-right text-xs font-mono tabular-nums"
        data-testid={`text-amount-${row.txid.slice(0, 12)}-${row.vout}`}
      >
        {formatSats(row.amountSats)}
      </span>
      <span className="text-right text-xs text-muted-foreground whitespace-nowrap">
        {formatDate(row.blockTime)}
        {row.blockHeight > 0 ? (
          <span className="block text-[10px]">block {row.blockHeight.toLocaleString()}</span>
        ) : null}
      </span>
      <span className="text-right">
        <TxidLink txid={row.txid} className="text-xs" />
      </span>
      <span className="text-right whitespace-nowrap">
        <LiveCheckCell
          row={row}
          state={liveCheck}
          onCheck={onLiveCheck}
          resyncState={resyncState}
          onResync={onResync}
        />
      </span>
    </div>
  );
}

export function DormantGroupsList({ count }: { count: number }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const { rowCacheRef, setRange, cacheVersion } = useWindowedRows(count, getDormantGroupWindow);

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => parentRef.current,
    estimateSize: () => GROUP_ROW_HEIGHT,
    overscan: 8,
  });
  const virtualItems = virtualizer.getVirtualItems();

  useEffect(() => {
    if (virtualItems.length === 0) return;
    setRange({
      first: virtualItems[0].index,
      last: virtualItems[virtualItems.length - 1].index,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualItems.length ? virtualItems[0].index : 0, virtualItems.length ? virtualItems[virtualItems.length - 1].index : 0]);

  return (
    <div className="border rounded-md" data-testid="list-dormant-groups">
      <div className="grid grid-cols-[auto_minmax(0,2fr)_auto_auto_auto] gap-3 px-3 py-2 bg-muted/50 border-b text-xs font-medium text-muted-foreground items-center">
        <span>Group</span>
        <span>Likely same-entity addresses</span>
        <span className="text-right">Co-spend txs</span>
        <span className="text-right">Dormant outputs</span>
        <span className="text-right">Dormant total</span>
      </div>
      <div ref={parentRef} className="h-[260px] overflow-auto" data-testid="scroll-dormant-groups">
        <div
          className="relative w-full"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
          data-cache-version={cacheVersion}
        >
          {virtualItems.map((virtualRow) => {
            const group = rowCacheRef.current.get(virtualRow.index);
            if (!group) {
              return (
                <div
                  key={`loading-${virtualRow.index}`}
                  className="absolute left-0 right-0 flex items-center px-3 border-b last:border-b-0"
                  style={{ height: `${GROUP_ROW_HEIGHT}px`, transform: `translateY(${virtualRow.start}px)` }}
                  data-testid={`row-group-loading-${virtualRow.index}`}
                >
                  <span className="text-xs text-muted-foreground">Loading…</span>
                </div>
              );
            }
            return (
              <GroupRow
                key={group.groupId}
                group={group}
                style={{ height: `${GROUP_ROW_HEIGHT}px`, transform: `translateY(${virtualRow.start}px)` }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function GroupRow({ group, style }: { group: DormantClueGroup; style: React.CSSProperties }) {
  const shown = group.addresses.slice(0, 3);
  return (
    <div
      className="absolute left-0 right-0 grid grid-cols-[auto_minmax(0,2fr)_auto_auto_auto] items-center gap-3 px-3 border-b last:border-b-0"
      style={style}
      data-testid={`row-group-${group.groupId}`}
    >
      <Badge variant="outline" className="text-[10px]" data-testid={`badge-group-${group.groupId}`}>
        #{group.groupId}
      </Badge>
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          {shown.map((addr) => (
            <AddressLink key={addr} address={addr} className="text-xs" />
          ))}
          {group.addressCount > shown.length ? (
            <span className="text-[11px] text-muted-foreground">
              +{group.addressCount - shown.length} more
            </span>
          ) : null}
        </div>
        <p className="text-[11px] text-muted-foreground">
          {group.addressCount} address{group.addressCount !== 1 ? "es" : ""} · oldest dormant output{" "}
          {formatDate(group.oldestBlockTime)}
        </p>
      </div>
      <span className="text-right text-xs tabular-nums">{group.coSpendTxCount}</span>
      <span className="text-right text-xs tabular-nums">{group.dormantOutputCount}</span>
      <span
        className="text-right text-xs font-mono tabular-nums"
        data-testid={`text-group-sats-${group.groupId}`}
      >
        {formatSats(group.totalDormantSats)}
      </span>
    </div>
  );
}

// Windowed, virtualized result lists for the Dormant Coins report.
//
// The full result set lives in a local IndexedDB scratch store (see
// dormant-coins-report-store.ts), NOT in memory: these components only ever
// hold the rows for the windows the user has scrolled into view, fetched on
// demand and cached by absolute row index — the same pattern as the Balance
// Integrity stale-address list.

import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Badge } from "@/components/ui/badge";
import { AddressLink } from "@/components/AddressLink";
import { TxidLink } from "@/components/TxidLink";
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

const WINDOW_SIZE = 100;
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

/**
 * Generic windowed-list machinery: loads 100-row windows from IndexedDB for
 * the visible range and caches them by absolute index. `count` resets clear
 * the cache (a new run rewrote the store).
 */
function useWindowedRows<T>(count: number, fetchWindow: (offset: number, limit: number) => Promise<T[]>) {
  const rowCacheRef = useRef<Map<number, T>>(new Map());
  const pendingRef = useRef<Set<number>>(new Set());
  const [cacheVersion, setCacheVersion] = useState(0);
  const [range, setRange] = useState<{ first: number; last: number }>({ first: 0, last: 0 });

  useEffect(() => {
    if (count === 0) {
      rowCacheRef.current.clear();
      pendingRef.current.clear();
      setCacheVersion((v) => v + 1);
    }
  }, [count]);

  useEffect(() => {
    if (count === 0) return;
    const { first, last } = range;
    const startWindow = Math.floor(first / WINDOW_SIZE);
    const endWindow = Math.floor(last / WINDOW_SIZE);
    const windowsToLoad: number[] = [];
    for (let w = startWindow; w <= endWindow; w++) {
      if (pendingRef.current.has(w)) continue;
      const offset = w * WINDOW_SIZE;
      const end = Math.min(offset + WINDOW_SIZE, count);
      let missing = false;
      for (let i = offset; i < end; i++) {
        if (!rowCacheRef.current.has(i)) {
          missing = true;
          break;
        }
      }
      if (missing) windowsToLoad.push(w);
    }
    if (windowsToLoad.length === 0) return;

    let cancelled = false;
    for (const w of windowsToLoad) pendingRef.current.add(w);
    (async () => {
      try {
        for (const w of windowsToLoad) {
          // A cleanup ran (range/count changed): stop. The next effect run
          // re-queues any windows that are still missing, because cleanup
          // already removed them from pendingRef.
          if (cancelled) return;
          const offset = w * WINDOW_SIZE;
          const rows = await fetchWindow(offset, WINDOW_SIZE);
          rows.forEach((row, idx) => rowCacheRef.current.set(offset + idx, row));
        }
        setCacheVersion((v) => v + 1);
      } finally {
        for (const w of windowsToLoad) pendingRef.current.delete(w);
      }
    })();
    return () => {
      cancelled = true;
      // Remove immediately so the effect's next run (e.g. the visible range
      // grew while a load was in flight) doesn't skip these windows forever
      // after this load was cancelled — otherwise loaded rows would sit in
      // the cache without a re-render ever being scheduled.
      for (const w of windowsToLoad) pendingRef.current.delete(w);
    };
    // cacheVersion intentionally excluded: it would re-trigger after each load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.first, range.last, count, fetchWindow]);

  return { rowCacheRef, setRange, cacheVersion };
}

export function DormantResultsList({
  count,
  nowSec,
}: {
  count: number;
  nowSec: number;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const { rowCacheRef, setRange, cacheVersion } = useWindowedRows(count, getDormantRowWindow);

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
      <div className="grid grid-cols-[minmax(0,2fr)_auto_auto_auto_auto] gap-3 px-3 py-2 bg-muted/50 border-b text-xs font-medium text-muted-foreground items-center">
        <span>Address</span>
        <span>Clue</span>
        <span className="text-right">Amount</span>
        <span className="text-right">Created</span>
        <span className="text-right">Funding tx</span>
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
                style={{ height: `${ROW_HEIGHT}px`, transform: `translateY(${virtualRow.start}px)` }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DormantRow({
  row,
  nowSec,
  style,
}: {
  row: DormantOutputRow;
  nowSec: number;
  style: React.CSSProperties;
}) {
  return (
    <div
      className="absolute left-0 right-0 grid grid-cols-[minmax(0,2fr)_auto_auto_auto_auto] items-center gap-3 px-3 border-b last:border-b-0"
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

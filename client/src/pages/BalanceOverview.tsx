import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useDbChangeSignal } from "@/hooks/use-db-change-signal";
import { useLiveQuery } from "dexie-react-hooks";
import { getBtcUsdPriceData } from "@/lib/data/price-data-crud";
import {
  countRecordsByType,
  getRecordsPageByTypeIdReverseKeyset,
  getAddressBalanceRowsForGroup,
} from "@/lib/data/record-crud";
import { engineGetBalanceGroupSummaries, subscribeEngineReadiness } from "@/lib/engine/engine-client";
import { evaluateEngineFreshness } from "@/lib/engine/engine-freshness";
import { recomputeAddressStats } from "@/lib/data/address-stats";
import {
  type GroupBy,
  type AddressBalanceRow,
  getGroupKeys,
} from "@/lib/balance-grouping";
import { useVirtualizer } from "@tanstack/react-virtual";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Loader2,
  ChevronDown,
  ChevronRight,
  Wallet,
  Copy,
  Check,
} from "lucide-react";
import { SiBitcoin } from "react-icons/si";

type SortBy = "balance-desc" | "balance-asc" | "name-asc" | "name-desc" | "addresses-desc";
type DisplayUnit = "btc" | "sats";

interface GroupSummary {
  name: string;
  totalSats: number;
  addressCount: number;
  utxoCount: number;
}

type AggResult =
  | { needsBackfill: true }
  | {
      needsBackfill: false;
      summaries: Map<string, GroupSummary>;
      totalSats: number;
      totalAddresses: number;
      totalUtxos: number;
    };

const AGG_BATCH = 1000;

function formatBtc(sats: number, unit: DisplayUnit): string {
  if (unit === "sats") {
    return sats.toLocaleString() + " sats";
  }
  return (sats / 100_000_000).toFixed(8) + " BTC";
}

function formatUsd(amount: number): string {
  return "$" + amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Phase 1 aggregation: page through every address record by id-keyset, reading
 * ONLY the cached per-address stats fields (never participants/transactions).
 * Accumulates per-group totals plus a deduped overall total. Returns
 * `needsBackfill` if it finds an address whose stats predate `cachedUtxoCount`.
 */
async function aggregateGroups(
  groupBy: GroupBy,
  signal: AbortSignal,
  onProgress: (processed: number) => void,
): Promise<AggResult | null> {
  const summaries = new Map<string, GroupSummary>();
  let totalSats = 0;
  let totalAddresses = 0;
  let totalUtxos = 0;
  let processed = 0;
  let beforeIdExclusive: number | undefined = undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (signal.aborted) return null;
    const batch = await getRecordsPageByTypeIdReverseKeyset("address", {
      limit: AGG_BATCH,
      beforeIdExclusive,
    });
    if (batch.length === 0) break;

    for (const rec of batch) {
      // Stats written before cachedUtxoCount existed → trigger one-time backfill.
      if (rec.statsComputedAt != null && rec.cachedUtxoCount === undefined) {
        return { needsBackfill: true };
      }
      const utxo = rec.cachedUtxoCount ?? 0;
      if (utxo <= 0) continue;
      const sats = rec.cachedBalanceSats ?? 0;

      totalSats += sats;
      totalAddresses += 1;
      totalUtxos += utxo;

      for (const key of getGroupKeys(rec, groupBy)) {
        let g = summaries.get(key);
        if (!g) {
          g = { name: key, totalSats: 0, addressCount: 0, utxoCount: 0 };
          summaries.set(key, g);
        }
        g.totalSats += sats;
        g.addressCount += 1;
        g.utxoCount += utxo;
      }
    }

    processed += batch.length;
    onProgress(processed);

    beforeIdExclusive = batch[batch.length - 1].id ?? undefined;
    if (batch.length < AGG_BATCH || beforeIdExclusive == null) break;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return { needsBackfill: false, summaries, totalSats, totalAddresses, totalUtxos };
}

interface GroupAddressRowsProps {
  rows: AddressBalanceRow[];
  displayUnit: DisplayUnit;
  copiedAddress: string | null;
  onCopy: (address: string) => void;
}

/** Virtualized list of a single expanded group's addresses (cached rows only). */
function GroupAddressRows({ rows, displayUnit, copiedAddress, onCopy }: GroupAddressRowsProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 34,
    overscan: 12,
    measureElement: (el) => el.getBoundingClientRect().height,
  });
  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div ref={scrollRef} className="max-h-96 overflow-auto px-4 py-2">
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
        {virtualItems.map((vi) => {
          const addr = rows[vi.index];
          return (
            <div
              key={addr.id}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vi.start}px)` }}
            >
              <div
                className="flex items-center gap-2 py-1.5 text-sm"
                data-testid={`row-address-${addr.address}`}
              >
                <div className="flex-1 min-w-0 flex items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground truncate max-w-[200px]">
                    {addr.address}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onCopy(addr.address);
                    }}
                    className="flex-none text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                    data-testid={`button-copy-${addr.address}`}
                  >
                    {copiedAddress === addr.address ? (
                      <Check className="h-3 w-3" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                  </button>
                  {addr.label && (
                    <span className="text-xs text-muted-foreground/70 truncate max-w-[120px]">
                      {addr.label}
                    </span>
                  )}
                </div>

                <div className="flex-none flex items-center gap-2">
                  <span className="text-xs text-muted-foreground/50">
                    {addr.utxoCount} UTXO{addr.utxoCount !== 1 ? "s" : ""}
                  </span>
                  <span className="font-mono text-xs font-medium w-[130px] text-right">
                    {formatBtc(addr.sats, displayUnit)}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function BalanceOverview() {
  const [groupBy, setGroupBy] = useState<GroupBy>("wallet");
  const [sortBy, setSortBy] = useState<SortBy>("balance-desc");
  const [displayUnit, setDisplayUnit] = useState<DisplayUnit>("btc");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const dbSignal = useDbChangeSignal(["records", "blockchainTransactions"]);
  const computationId = useRef(0);
  const [engineReadySignal, setEngineReadySignal] = useState(0);

  // Re-run aggregation when the native read-engine flips to ready so the fast
  // path can take over from any Dexie fallback that ran first.
  useEffect(() => subscribeEngineReadiness(() => setEngineReadySignal((s) => s + 1)), []);

  const [phase, setPhase] = useState<"loading" | "backfilling" | "ready">("loading");
  const [groupSummaries, setGroupSummaries] = useState<Map<string, GroupSummary>>(new Map());
  const [totals, setTotals] = useState({ sats: 0, addresses: 0, utxos: 0 });
  const [addressRecordCount, setAddressRecordCount] = useState(0);
  const [aggProgress, setAggProgress] = useState({ processed: 0, total: 0 });
  const [backfillProgress, setBackfillProgress] = useState({ processed: 0, total: 0 });

  // Phase 2: per-group address rows, loaded on demand when a group is expanded.
  const [groupRows, setGroupRows] = useState<Map<string, AddressBalanceRow[]>>(new Map());
  const [loadingGroups, setLoadingGroups] = useState<Set<string>>(new Set());

  const groupByRef = useRef(groupBy);
  groupByRef.current = groupBy;
  const groupRowsRef = useRef(groupRows);
  groupRowsRef.current = groupRows;
  const loadingGroupsRef = useRef(loadingGroups);
  loadingGroupsRef.current = loadingGroups;

  const priceData = useLiveQuery(() => getBtcUsdPriceData(), []);

  // Reset expansion + row caches when the grouping dimension changes.
  useEffect(() => {
    setExpandedGroups(new Set());
    setGroupRows(new Map());
    setLoadingGroups(new Set());
  }, [groupBy]);

  // Phase 1: aggregate from the cache (with one-time backfill if data is stale).
  useEffect(() => {
    computationId.current += 1;
    const thisId = computationId.current;
    const abort = new AbortController();
    const signal = abort.signal;

    setPhase("loading");
    setGroupSummaries(new Map());
    setTotals({ sats: 0, addresses: 0, utxos: 0 });
    setAggProgress({ processed: 0, total: 0 });
    setBackfillProgress({ processed: 0, total: 0 });
    setGroupRows(new Map());
    setLoadingGroups(new Set());

    const run = async () => {
      const total = await countRecordsByType("address");
      if (thisId !== computationId.current) return;
      setAddressRecordCount(total);
      setAggProgress({ processed: 0, total });

      // Engine fast path: when the native read-engine mirror is fresh for the
      // 'records' scope, compute group summaries + grand totals in SQL. We only
      // trust it when the mirror reports no stale per-address stats; any stale
      // rows mean the Dexie path's one-time backfill still needs to run, so we
      // fall through to it to preserve that exact behaviour.
      try {
        const decision = await evaluateEngineFreshness("records");
        if (thisId !== computationId.current || signal.aborted) return;
        if (decision.useEngine) {
          const eng = await engineGetBalanceGroupSummaries(groupBy);
          if (thisId !== computationId.current || signal.aborted) return;
          if (eng.staleAddressCount === 0) {
            const map = new Map<string, GroupSummary>();
            for (const s of eng.summaries) {
              map.set(s.groupKey, {
                name: s.groupKey,
                totalSats: s.totalSats,
                addressCount: s.addressCount,
                utxoCount: s.utxoCount,
              });
            }
            setGroupSummaries(map);
            setTotals({
              sats: eng.totals.totalSats,
              addresses: eng.totals.totalAddresses,
              utxos: eng.totals.totalUtxos,
            });
            setPhase("ready");
            return;
          }
        }
      } catch (error) {
        // Engine unavailable/transient — fall through to the Dexie scan.
        console.warn("Balance overview engine fast path failed; using Dexie:", error);
      }

      let result = await aggregateGroups(groupBy, signal, (p) => {
        if (thisId === computationId.current) setAggProgress({ processed: p, total });
      });
      if (!result || thisId !== computationId.current || signal.aborted) return;

      if (result.needsBackfill) {
        setPhase("backfilling");
        setBackfillProgress({ processed: 0, total });
        const res = await recomputeAddressStats({
          signal,
          skipNotification: true,
          origin: "user",
          onProgress: (p) => {
            if (thisId === computationId.current) {
              setBackfillProgress({ processed: p.processed, total: p.total });
            }
          },
        });
        if (thisId !== computationId.current || signal.aborted || res.cancelled) return;

        setPhase("loading");
        setAggProgress({ processed: 0, total });
        result = await aggregateGroups(groupBy, signal, (p) => {
          if (thisId === computationId.current) setAggProgress({ processed: p, total });
        });
        if (!result || result.needsBackfill || thisId !== computationId.current || signal.aborted) return;
      }

      setGroupSummaries(result.summaries);
      setTotals({ sats: result.totalSats, addresses: result.totalAddresses, utxos: result.totalUtxos });
      setPhase("ready");
    };

    run();
    return () => {
      abort.abort();
    };
  }, [groupBy, dbSignal, engineReadySignal]);

  const ensureGroupRows = useCallback(async (name: string) => {
    if (groupRowsRef.current.has(name) || loadingGroupsRef.current.has(name)) return;
    setLoadingGroups((prev) => {
      const next = new Set(prev);
      next.add(name);
      return next;
    });
    try {
      const rows = await getAddressBalanceRowsForGroup(groupByRef.current, name);
      rows.sort((a, b) => b.sats - a.sats);
      setGroupRows((prev) => {
        const next = new Map(prev);
        next.set(name, rows);
        return next;
      });
    } finally {
      setLoadingGroups((prev) => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
    }
  }, []);

  // Re-load rows for any group that is still expanded after a recompute.
  useEffect(() => {
    if (phase !== "ready") return;
    for (const name of Array.from(expandedGroups)) void ensureGroupRows(name);
  }, [phase, expandedGroups, ensureGroupRows]);

  const latestPrice = useMemo(() => {
    if (!priceData || priceData.length === 0) return null;
    const sorted = [...priceData].sort((a, b) => b.date.localeCompare(a.date));
    return { date: sorted[0].date, price: sorted[0].close };
  }, [priceData]);

  const groups = useMemo(() => {
    const result = Array.from(groupSummaries.values());
    switch (sortBy) {
      case "balance-desc":
        result.sort((a, b) => b.totalSats - a.totalSats);
        break;
      case "balance-asc":
        result.sort((a, b) => a.totalSats - b.totalSats);
        break;
      case "name-asc":
        result.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "name-desc":
        result.sort((a, b) => b.name.localeCompare(a.name));
        break;
      case "addresses-desc":
        result.sort((a, b) => b.addressCount - a.addressCount);
        break;
    }
    return result;
  }, [groupSummaries, sortBy]);

  const toggleGroup = useCallback(
    (name: string) => {
      const willExpand = !expandedGroups.has(name);
      setExpandedGroups((prev) => {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
      });
      if (willExpand) void ensureGroupRows(name);
    },
    [expandedGroups, ensureGroupRows],
  );

  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const copyAddress = useCallback((address: string) => {
    navigator.clipboard.writeText(address);
    setCopiedAddress(address);
    setTimeout(() => setCopiedAddress(null), 2000);
  }, []);

  const totalBalance = totals.sats;
  const totalAddresses = totals.addresses;
  const isBusy = phase !== "ready";

  const groupByLabel: Record<GroupBy, string> = {
    wallet: "Wallet",
    seed: "Seed",
    owner: "Owner",
    tag: "Tag",
    category: "Category",
  };

  const backfillPct =
    backfillProgress.total > 0
      ? Math.round((backfillProgress.processed / backfillProgress.total) * 100)
      : 0;

  return (
    <div className="flex flex-col h-full">
      <div className="flex-none p-4 pb-2 border-b">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <SiBitcoin className="h-5 w-5 text-[hsl(var(--primary))]" />
            <h1 className="text-lg font-semibold" data-testid="text-page-title">Balance</h1>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Select value={groupBy} onValueChange={(v) => setGroupBy(v as GroupBy)}>
              <SelectTrigger className="w-[140px]" data-testid="select-group-by">
                <SelectValue placeholder="Group by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="wallet">By Wallet</SelectItem>
                <SelectItem value="seed">By Seed</SelectItem>
                <SelectItem value="owner">By Owner</SelectItem>
                <SelectItem value="tag">By Tag</SelectItem>
                <SelectItem value="category">By Category</SelectItem>
              </SelectContent>
            </Select>

            <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortBy)}>
              <SelectTrigger className="w-[160px]" data-testid="select-sort-by">
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="balance-desc">Highest Balance</SelectItem>
                <SelectItem value="balance-asc">Lowest Balance</SelectItem>
                <SelectItem value="name-asc">Name A-Z</SelectItem>
                <SelectItem value="name-desc">Name Z-A</SelectItem>
                <SelectItem value="addresses-desc">Most Addresses</SelectItem>
              </SelectContent>
            </Select>

            <Button
              variant="outline"
              size="sm"
              onClick={() => setDisplayUnit((u) => (u === "btc" ? "sats" : "btc"))}
              data-testid="button-toggle-unit"
            >
              {displayUnit === "btc" ? "BTC" : "sats"}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {phase === "backfilling" ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3 max-w-md mx-auto">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Preparing balances for the first time…</p>
            <div className="w-full">
              <Progress value={backfillPct} data-testid="progress-backfill" />
              <p className="text-xs text-muted-foreground/60 text-center mt-2" data-testid="text-backfill-progress">
                {backfillProgress.processed.toLocaleString()} / {backfillProgress.total.toLocaleString()} addresses
              </p>
            </div>
          </div>
        ) : phase === "loading" && groupSummaries.size === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Calculating balances…</p>
            {aggProgress.total > 0 && (
              <p className="text-xs text-muted-foreground/60" data-testid="text-agg-progress">
                {Math.min(aggProgress.processed, aggProgress.total).toLocaleString()} / {aggProgress.total.toLocaleString()} addresses
              </p>
            )}
          </div>
        ) : phase === "ready" && addressRecordCount === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <Wallet className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No address records found</p>
            <p className="text-xs text-muted-foreground/60">
              Add addresses first to see balances
            </p>
          </div>
        ) : phase === "ready" && groups.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <Wallet className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No UTXO data found</p>
            <p className="text-xs text-muted-foreground/60">
              Sync your addresses first to see balances
            </p>
          </div>
        ) : (
          <div className="space-y-3 max-w-3xl mx-auto">
            <Card data-testid="card-total-balance">
              <CardContent className="py-4 px-5">
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
                      Total Balance
                    </p>
                    <div className="flex items-center gap-2">
                      <p className="text-2xl font-bold font-mono" data-testid="text-total-balance">
                        {formatBtc(totalBalance, displayUnit)}
                      </p>
                      {isBusy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                    </div>
                    {latestPrice && (
                      <p className="text-sm text-muted-foreground mt-0.5" data-testid="text-total-usd">
                        {formatUsd((totalBalance / 100_000_000) * latestPrice.price)}
                      </p>
                    )}
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">
                      {groups.length} {groupByLabel[groupBy].toLowerCase()}{groups.length !== 1 ? "s" : ""}
                    </p>
                    <p className="text-xs text-muted-foreground">{totalAddresses} addresses</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {groups.map((group) => {
              const isExpanded = expandedGroups.has(group.name);
              const percentage = totalBalance > 0 ? (group.totalSats / totalBalance) * 100 : 0;
              const usdValue = latestPrice ? (group.totalSats / 100_000_000) * latestPrice.price : null;
              const rows = groupRows.get(group.name);
              const rowsLoading = loadingGroups.has(group.name);

              return (
                <Card key={group.name} data-testid={`card-group-${group.name}`}>
                  <div
                    className="flex items-center gap-3 py-3 px-4 cursor-pointer hover-elevate rounded-md"
                    onClick={() => toggleGroup(group.name)}
                    data-testid={`button-expand-${group.name}`}
                  >
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground flex-none" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground flex-none" />
                    )}

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium truncate" data-testid={`text-group-name-${group.name}`}>
                          {group.name}
                        </span>
                        <Badge variant="secondary" className="text-xs flex-none">
                          {group.addressCount} addr
                        </Badge>
                        <Badge variant="outline" className="text-xs flex-none">
                          {group.utxoCount} UTXO{group.utxoCount !== 1 ? "s" : ""}
                        </Badge>
                      </div>
                    </div>

                    <div className="flex-none text-right">
                      <p className="font-mono text-sm font-medium" data-testid={`text-group-balance-${group.name}`}>
                        {formatBtc(group.totalSats, displayUnit)}
                      </p>
                      <div className="flex items-center gap-1.5 justify-end">
                        {usdValue !== null && (
                          <span className="text-xs text-muted-foreground">
                            {formatUsd(usdValue)}
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground/60">
                          {percentage.toFixed(1)}%
                        </span>
                      </div>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="border-t">
                      {rowsLoading && !rows ? (
                        <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          <span>Loading addresses…</span>
                        </div>
                      ) : rows && rows.length > 0 ? (
                        <GroupAddressRows
                          rows={rows}
                          displayUnit={displayUnit}
                          copiedAddress={copiedAddress}
                          onCopy={copyAddress}
                        />
                      ) : (
                        <div className="py-4 text-center text-sm text-muted-foreground">
                          No addresses with a balance
                        </div>
                      )}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

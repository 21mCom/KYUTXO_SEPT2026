import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useDbChangeSignal } from "@/hooks/use-db-change-signal";
import { useLiveQuery } from "dexie-react-hooks";
import { getBtcUsdPriceData } from "@/lib/data/price-data-crud";
import {
  countRecordsByType,
  getRecordsPageByTypeIdReverseKeyset,
  getAddressBalanceRowsForGroup,
  getRecordsByIds,
} from "@/lib/data/record-crud";
import { engineGetBalanceGroupSummaries, subscribeEngineReadiness } from "@/lib/engine/engine-client";
import { evaluateEngineFreshness } from "@/lib/engine/engine-freshness";
import { recomputeAddressStats } from "@/lib/data/address-stats";
import { countUnresolvedPrevoutInputs, getUnresolvedSpendBreakdown, getMissingSourceTxids, getMissingSourceTxidDetails, buildMissingSourceJson, buildMissingSourceCsv, type MissingSourceDetail } from "@/lib/data/transaction-crud";
import { transactionSyncService } from "@/lib/transaction-sync";
import { runTxidBackfill } from "@/lib/txid-backfill";
import { createProviderFromSettings } from "@/lib/blockchain-api";
import { getNodeSettings } from "@/lib/data/node-settings-crud";
import { describeResolveError } from "@/lib/resolve-error";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Loader2,
  ChevronDown,
  ChevronRight,
  Wallet,
  Copy,
  Check,
  AlertTriangle,
  Download,
  X,
  ListChecks,
  StopCircle,
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
  /** recordId -> number of pending spends, for the per-address resolve action. */
  unresolvedByRecordId: Map<number, number>;
  /** recordIds currently running a targeted resolve. */
  resolvingRecordIds: Set<number>;
  /** recordIds whose in-flight per-address resolve has been requested to stop. */
  cancellingRecordIds: Set<number>;
  /** recordId -> { resolved, total } progress for an in-flight per-address resolve. */
  resolveProgressByRecordId: Map<number, { resolved: number; total: number }>;
  onResolveAddress: (recordId: number, address: string) => void;
  onCancelResolveAddress: (recordId: number) => void;
}

/** Virtualized list of a single expanded group's addresses (cached rows only). */
function GroupAddressRows({
  rows,
  displayUnit,
  copiedAddress,
  onCopy,
  unresolvedByRecordId,
  resolvingRecordIds,
  cancellingRecordIds,
  resolveProgressByRecordId,
  onResolveAddress,
  onCancelResolveAddress,
}: GroupAddressRowsProps) {
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
          const pending = unresolvedByRecordId.get(addr.id) ?? 0;
          const isResolving = resolvingRecordIds.has(addr.id);
          const resolveProgress = resolveProgressByRecordId.get(addr.id);
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
                  {pending > 0 && (
                    <>
                      <Badge
                        variant="outline"
                        className="text-xs flex-none gap-1 border-yellow-400 dark:border-yellow-600 text-yellow-700 dark:text-yellow-300"
                        title={`${pending.toLocaleString()} spend${pending !== 1 ? "s" : ""} pending attribution — balance may be too high`}
                        data-testid={`badge-address-unresolved-${addr.address}`}
                      >
                        <AlertTriangle className="h-3 w-3" />
                        {pending.toLocaleString()} pending
                      </Badge>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={(e) => {
                          e.stopPropagation();
                          onResolveAddress(addr.id, addr.address);
                        }}
                        disabled={isResolving}
                        data-testid={`button-resolve-address-${addr.address}`}
                        className="flex-none border-yellow-400 dark:border-yellow-600 text-yellow-800 dark:text-yellow-200"
                      >
                        {isResolving ? (
                          <>
                            <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
                            {cancellingRecordIds.has(addr.id)
                              ? "Stopping…"
                              : resolveProgress && resolveProgress.total > 0
                                ? `Resolving… ${resolveProgress.resolved.toLocaleString()}/${resolveProgress.total.toLocaleString()}`
                                : "Resolving…"}
                          </>
                        ) : (
                          "Resolve"
                        )}
                      </Button>
                      {isResolving && !cancellingRecordIds.has(addr.id) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={(e) => {
                            e.stopPropagation();
                            onCancelResolveAddress(addr.id);
                          }}
                          data-testid={`button-stop-resolve-address-${addr.address}`}
                          className="flex-none text-muted-foreground"
                        >
                          <StopCircle className="h-3 w-3 mr-1" />
                          Stop
                        </Button>
                      )}
                    </>
                  )}
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

  const dbSignal = useDbChangeSignal(["records", "blockchainTransactions", "transactionParticipants"]);
  const computationId = useRef(0);
  const [engineReadySignal, setEngineReadySignal] = useState(0);

  // Spend health: unresolved prevout inputs (blank-address inputs with prevTxid/prevVout).
  const [unresolvedPrevouts, setUnresolvedPrevouts] = useState<number | null>(null);
  const [spendWarningDismissed, setSpendWarningDismissed] = useState(false);
  const [fixingPrevouts, setFixingPrevouts] = useState(false);
  // True while fetching + importing the missing source transactions behind
  // unattributable spends (the "Import missing history" banner action).
  const [importingHistory, setImportingHistory] = useState(false);
  // Fetch progress for the import action: { processed, total } source txs.
  const [importProgress, setImportProgress] = useState<{ processed: number; total: number } | null>(null);
  // AbortController for the in-flight "Import missing history" run, so the user
  // can cancel a long import partway through. Any transactions already imported
  // are kept; cancelling only stops further fetches.
  const importAbortRef = useRef<AbortController | null>(null);
  // Offline path: the list of missing source txids (with the spending txids that
  // reference them) shown in a dialog so fully-offline users can import them by
  // hand. `null` until the dialog is opened and the list has been computed.
  const [missingDialogOpen, setMissingDialogOpen] = useState(false);
  const [missingDetails, setMissingDetails] = useState<MissingSourceDetail[] | null>(null);
  const [missingLoading, setMissingLoading] = useState(false);
  // Unresolved spends that map to no tracked source record (prevout not locally
  // known, or its output belongs to no tracked address). These overstate the
  // overall balance but no single wallet card can reflect them.
  const [unattributableSpends, setUnattributableSpends] = useState(0);

  // Per-group breakdown of unresolved spends: groupKey -> number of pending spends.
  // Lets each affected wallet card flag that its balance is overstated.
  const [unresolvedByGroup, setUnresolvedByGroup] = useState<Map<string, number>>(new Map());
  // groupKey -> source record ids whose spends are pending. Powers the per-wallet
  // "Resolve" action so it can scope resolution to just that group's records.
  const [unresolvedRecordIdsByGroup, setUnresolvedRecordIdsByGroup] = useState<Map<string, number[]>>(new Map());
  // recordId -> number of pending spends. Powers the per-address "Resolve" action
  // inside an expanded group, scoping resolution to that one source record.
  const [unresolvedByRecordId, setUnresolvedByRecordId] = useState<Map<number, number>>(new Map());
  // Groups currently running a targeted resolve (one at a time per group).
  const [resolvingGroups, setResolvingGroups] = useState<Set<string>>(new Set());
  // Source record ids currently running a targeted per-address resolve.
  const [resolvingRecordIds, setResolvingRecordIds] = useState<Set<number>>(new Set());
  // Per-group resolve progress: groupKey -> { resolved, total } as reported by
  // resolvePrevouts' onProgress callback, so the group card can show how far along it is.
  const [resolveProgressByGroup, setResolveProgressByGroup] = useState<Map<string, { resolved: number; total: number }>>(new Map());
  // Per-address resolve progress: recordId -> { resolved, total } as reported by
  // resolvePrevouts' onProgress callback, so the address row can show how far along it is.
  const [resolveProgressByRecordId, setResolveProgressByRecordId] = useState<Map<number, { resolved: number; total: number }>>(new Map());
  // Global resolve progress for the top banner's "Resolve & Recompute" pass, as
  // reported by resolvePrevouts' onProgress callback.
  const [resolveProgressGlobal, setResolveProgressGlobal] = useState<{ resolved: number; total: number } | null>(null);
  // AbortController for the in-progress global "Resolve & Recompute" pass, so the
  // banner can cancel a long-running resolve without rolling back partial work.
  const fixPrevoutsAbortRef = useRef<AbortController | null>(null);
  const [cancellingFixPrevouts, setCancellingFixPrevouts] = useState(false);
  const resolveAbortByGroupRef = useRef<Map<string, AbortController>>(new Map());
  const resolveAbortByRecordRef = useRef<Map<number, AbortController>>(new Map());
  const [cancellingGroups, setCancellingGroups] = useState<Set<string>>(new Set());
  const [cancellingRecordIds, setCancellingRecordIds] = useState<Set<number>>(new Set());

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

  // Spend health: check for unresolved prevout inputs whenever db changes.
  useEffect(() => {
    let cancelled = false;
    countUnresolvedPrevoutInputs().then((count) => {
      if (!cancelled) {
        setUnresolvedPrevouts(count);
        if (count === 0) setSpendWarningDismissed(false);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [dbSignal]);

  // Spend health (per group): attribute unresolved spends to the wallet groups
  // whose source addresses will be debited once resolved. Recomputed alongside
  // the global count whenever the db changes or the grouping dimension changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { byRecordId, unattributable } = await getUnresolvedSpendBreakdown();
      if (cancelled) return;
      setUnattributableSpends(unattributable);
      if (byRecordId.size === 0) {
        setUnresolvedByGroup(new Map());
        setUnresolvedRecordIdsByGroup(new Map());
        setUnresolvedByRecordId(new Map());
        return;
      }
      setUnresolvedByRecordId(byRecordId);
      const records = await getRecordsByIds(Array.from(byRecordId.keys()));
      if (cancelled) return;
      const byGroup = new Map<string, number>();
      const recordIdsByGroup = new Map<string, number[]>();
      for (const rec of records) {
        if (rec.id == null) continue;
        const count = byRecordId.get(rec.id) ?? 0;
        if (count <= 0) continue;
        for (const key of getGroupKeys(rec, groupBy)) {
          byGroup.set(key, (byGroup.get(key) ?? 0) + count);
          const ids = recordIdsByGroup.get(key);
          if (ids) ids.push(rec.id);
          else recordIdsByGroup.set(key, [rec.id]);
        }
      }
      setUnresolvedByGroup(byGroup);
      setUnresolvedRecordIdsByGroup(recordIdsByGroup);
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [dbSignal, groupBy]);

  const { toast } = useToast();

  const handleResolveGroup = useCallback(async (name: string) => {
    const recordIds = unresolvedRecordIdsByGroup.get(name);
    if (!recordIds || recordIds.length === 0) return;
    const before = unresolvedByGroup.get(name) ?? 0;
    const abort = new AbortController();
    resolveAbortByGroupRef.current.set(name, abort);
    setResolvingGroups((prev) => new Set(prev).add(name));
    setResolveProgressByGroup((prev) => {
      const next = new Map(prev);
      next.set(name, { resolved: 0, total: 0 });
      return next;
    });
    try {
      const result = await transactionSyncService.resolvePrevouts(
        (resolved, total) => {
          setResolveProgressByGroup((prev) => {
            const next = new Map(prev);
            next.set(name, { resolved, total });
            return next;
          });
        },
        {
          recomputeOrigin: "user",
          restrictToRecordIds: new Set(recordIds),
          signal: abort.signal,
        },
      );
      // Refresh the global count so the top banner stays in sync. The per-group
      // badge/note and this group's balance refresh automatically because
      // resolvePrevouts notifies the 'records'/'transactionParticipants' scopes.
      const remaining = await countUnresolvedPrevoutInputs();
      setUnresolvedPrevouts(remaining);
      if (remaining === 0) setSpendWarningDismissed(false);

      if (result.cancelled) {
        toast({
          title: "Resolve stopped",
          description:
            result.resolved > 0
              ? `Stopped after resolving ${result.resolved.toLocaleString()} spend${result.resolved !== 1 ? "s" : ""} in "${name}".`
              : `Stopped before any spends in "${name}" were resolved.`,
        });
      } else {
        const stillPending = Math.max(before - result.resolved, 0);
        if (result.resolved === 0) {
          toast({
            title: "Nothing to resolve",
            description: `No spends in "${name}" could be attributed to a known source. Their balances can't be corrected automatically.`,
            variant: "destructive",
          });
        } else if (stillPending > 0) {
          toast({
            title: "Partially resolved",
            description: `Resolved ${result.resolved.toLocaleString()} spend${result.resolved !== 1 ? "s" : ""} in "${name}". ${stillPending.toLocaleString()} still can't be attributed.`,
          });
        } else {
          toast({
            title: "Resolved",
            description: `Resolved ${result.resolved.toLocaleString()} spend${result.resolved !== 1 ? "s" : ""} in "${name}" and recomputed its balance.`,
          });
        }
      }
    } catch (err) {
      console.warn("[BalanceOverview] Per-group prevout resolve failed:", err);
      toast({
        title: "Resolve failed",
        description: `Couldn't resolve "${name}"'s pending spends. ${describeResolveError(err)}`,
        variant: "destructive",
      });
    } finally {
      resolveAbortByGroupRef.current.delete(name);
      setResolvingGroups((prev) => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
      setCancellingGroups((prev) => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
      setResolveProgressByGroup((prev) => {
        if (!prev.has(name)) return prev;
        const next = new Map(prev);
        next.delete(name);
        return next;
      });
    }
  }, [unresolvedRecordIdsByGroup, unresolvedByGroup, toast]);

  const handleCancelResolveGroup = useCallback((name: string) => {
    const abort = resolveAbortByGroupRef.current.get(name);
    if (abort) {
      setCancellingGroups((prev) => new Set(prev).add(name));
      abort.abort();
    }
  }, []);

  const handleResolveAddress = useCallback(async (recordId: number, address: string) => {
    const before = unresolvedByRecordId.get(recordId) ?? 0;
    if (before <= 0) return;
    const abort = new AbortController();
    resolveAbortByRecordRef.current.set(recordId, abort);
    setResolvingRecordIds((prev) => new Set(prev).add(recordId));
    setResolveProgressByRecordId((prev) => {
      const next = new Map(prev);
      next.set(recordId, { resolved: 0, total: 0 });
      return next;
    });
    try {
      const result = await transactionSyncService.resolvePrevouts(
        (resolved, total) => {
          setResolveProgressByRecordId((prev) => {
            const next = new Map(prev);
            next.set(recordId, { resolved, total });
            return next;
          });
        },
        {
          recomputeOrigin: "user",
          restrictToRecordIds: new Set([recordId]),
          signal: abort.signal,
        },
      );
      // Keep the top banner in sync. This address's row, its group note/badge,
      // and the balance refresh automatically because resolvePrevouts notifies
      // the 'records'/'transactionParticipants' scopes.
      const remaining = await countUnresolvedPrevoutInputs();
      setUnresolvedPrevouts(remaining);
      if (remaining === 0) setSpendWarningDismissed(false);

      if (result.cancelled) {
        toast({
          title: "Resolve stopped",
          description:
            result.resolved > 0
              ? `Stopped after resolving ${result.resolved.toLocaleString()} spend${result.resolved !== 1 ? "s" : ""} for ${address}.`
              : `Stopped before any spends for ${address} were resolved.`,
        });
      } else {
        const stillPending = Math.max(before - result.resolved, 0);
        if (result.resolved === 0) {
          toast({
            title: "Nothing to resolve",
            description: `No spends for ${address} could be attributed to a known source. Its balance can't be corrected automatically.`,
            variant: "destructive",
          });
        } else if (stillPending > 0) {
          toast({
            title: "Partially resolved",
            description: `Resolved ${result.resolved.toLocaleString()} spend${result.resolved !== 1 ? "s" : ""} for ${address}. ${stillPending.toLocaleString()} still can't be attributed.`,
          });
        } else {
          toast({
            title: "Resolved",
            description: `Resolved ${result.resolved.toLocaleString()} spend${result.resolved !== 1 ? "s" : ""} for ${address} and recomputed its balance.`,
          });
        }
      }
    } catch (err) {
      console.warn("[BalanceOverview] Per-address prevout resolve failed:", err);
      toast({
        title: "Resolve failed",
        description: `Couldn't resolve ${address}'s pending spends. ${describeResolveError(err)}`,
        variant: "destructive",
      });
    } finally {
      resolveAbortByRecordRef.current.delete(recordId);
      setResolvingRecordIds((prev) => {
        const next = new Set(prev);
        next.delete(recordId);
        return next;
      });
      setCancellingRecordIds((prev) => {
        const next = new Set(prev);
        next.delete(recordId);
        return next;
      });
      setResolveProgressByRecordId((prev) => {
        if (!prev.has(recordId)) return prev;
        const next = new Map(prev);
        next.delete(recordId);
        return next;
      });
    }
  }, [unresolvedByRecordId, toast]);

  const handleCancelResolveAddress = useCallback((recordId: number) => {
    const abort = resolveAbortByRecordRef.current.get(recordId);
    if (abort) {
      setCancellingRecordIds((prev) => new Set(prev).add(recordId));
      abort.abort();
    }
  }, []);

  const handleFixPrevouts = useCallback(async () => {
    const controller = new AbortController();
    fixPrevoutsAbortRef.current = controller;
    setCancellingFixPrevouts(false);
    setFixingPrevouts(true);
    setResolveProgressGlobal({ resolved: 0, total: 0 });
    try {
      // resolvePrevouts now recomputes stats for every newly-resolved source
      // address itself (origin "user"), so we don't need a second pass here.
      const result = await transactionSyncService.resolvePrevouts(
        (resolved, total) => setResolveProgressGlobal({ resolved, total }),
        { recomputeOrigin: "user", signal: controller.signal },
      );
      const remaining = await countUnresolvedPrevoutInputs();
      setUnresolvedPrevouts(remaining);
      if (remaining === 0) setSpendWarningDismissed(false);

      if (result.cancelled) {
        toast({
          title: "Resolve stopped",
          description:
            result.resolved > 0
              ? `Stopped after resolving ${result.resolved.toLocaleString()} spend${result.resolved !== 1 ? "s" : ""}. ${remaining.toLocaleString()} still pending.`
              : "Stopped before any spends were resolved.",
        });
      } else if (result.resolved === 0) {
        toast({
          title: "Nothing to resolve",
          description:
            "No pending spends could be attributed to a known source. Their balances can't be corrected automatically.",
          variant: "destructive",
        });
      } else if (remaining > 0) {
        toast({
          title: "Partially resolved",
          description: `Resolved ${result.resolved.toLocaleString()} spend${result.resolved !== 1 ? "s" : ""} across all wallets. ${remaining.toLocaleString()} still can't be attributed.`,
        });
      } else {
        toast({
          title: "Resolved",
          description: `Resolved ${result.resolved.toLocaleString()} spend${result.resolved !== 1 ? "s" : ""} across all wallets and recomputed balances.`,
        });
      }
    } catch (err) {
      console.warn("[BalanceOverview] Prevout fix failed:", err);
      toast({
        title: "Resolve failed",
        description: `Couldn't resolve pending spends. ${describeResolveError(err)}`,
        variant: "destructive",
      });
    } finally {
      fixPrevoutsAbortRef.current = null;
      setCancellingFixPrevouts(false);
      setFixingPrevouts(false);
      setResolveProgressGlobal(null);
    }
  }, [toast]);

  // Cancel the in-progress global resolve. Aborting stops further network
  // fetching cleanly; spends already resolved are kept (no rollback) and the
  // unresolved count refreshes in handleFixPrevouts' completion path.
  const handleCancelFixPrevouts = useCallback(() => {
    if (fixPrevoutsAbortRef.current) {
      setCancellingFixPrevouts(true);
      fixPrevoutsAbortRef.current.abort();
    }
  }, []);

  // Fetch + import the source transactions behind unattributable spends, then
  // attribute those spends locally. "Resolve & Recompute" can only attribute a
  // spend whose prevout output is already stored locally; when the source
  // transaction was never imported there is nothing local to resolve against.
  // This action closes that gap: it pulls the missing source transactions from
  // the configured blockchain provider, writes them into the vault, and then
  // runs a resolve pass so the now-local prevouts attribute and balances drop.
  const handleImportMissingHistory = useCallback(async () => {
    const abort = new AbortController();
    importAbortRef.current = abort;
    setImportingHistory(true);
    setImportProgress(null);
    try {
      const txids = await getMissingSourceTxids();
      if (txids.length === 0) {
        toast({
          title: "Nothing to import",
          description:
            "These spends' source addresses aren't tracked, so importing more history can't tie them to a wallet.",
        });
        return;
      }

      const nodeSettings = await getNodeSettings("default");
      if (!nodeSettings) {
        toast({
          title: "No blockchain provider configured",
          description:
            "Configure a provider in Settings to fetch the missing source transactions.",
          variant: "destructive",
        });
        return;
      }

      let provider: ReturnType<typeof createProviderFromSettings>;
      try {
        provider = createProviderFromSettings(nodeSettings);
        await provider.getBlockHeight();
      } catch (connErr) {
        console.warn("[BalanceOverview] Provider unreachable for history import:", connErr);
        toast({
          title: "Can't reach the blockchain provider",
          description:
            "Check your connection or provider settings in Settings, then try again.",
          variant: "destructive",
        });
        return;
      }

      setImportProgress({ processed: 0, total: txids.length });
      const result = await runTxidBackfill(provider, txids, {
        signal: abort.signal,
        onProgress: (p) => {
          if (p.phase === "fetching") {
            setImportProgress({ processed: p.processed, total: p.orphansFound });
          }
        },
      });

      const cancelled = abort.signal.aborted;

      // Importing the source transactions made their outputs locally known. Now
      // attribute the original spends that referenced them (their inputs are
      // still blank) and recompute the affected source balances. Skip this when
      // the user cancelled — we keep whatever was imported but don't kick off
      // another long pass they just asked to stop.
      setImportProgress(null);
      // The follow-up resolve/recompute pass is best-effort: a failure here must
      // NOT mask the successful import. Run it in its own try-catch so the import
      // success toast still fires even when attribution or recompute fails.
      let resolveNote: string | null = null;
      if (result.rebuilt > 0 && !cancelled) {
        try {
          await transactionSyncService.resolvePrevouts(undefined, { recomputeOrigin: "user" });
        } catch (resolveErr) {
          console.warn("[BalanceOverview] Post-import attribution/recompute failed:", resolveErr);
          resolveNote =
            "The attribution step encountered an error — balances may need a manual recompute.";
        }
      }

      const remaining = await countUnresolvedPrevoutInputs();
      setUnresolvedPrevouts(remaining);
      const { byRecordId, unattributable } = await getUnresolvedSpendBreakdown();
      setUnattributableSpends(unattributable);
      setUnresolvedByRecordId(byRecordId);
      if (remaining === 0) setSpendWarningDismissed(false);

      const importedDesc =
        result.rebuilt > 0
          ? `Imported ${result.rebuilt.toLocaleString()} source transaction${result.rebuilt !== 1 ? "s" : ""}.`
          : "";

      if (cancelled) {
        toast({
          title: "Import cancelled",
          description:
            result.rebuilt > 0
              ? `Stopped early. Kept ${result.rebuilt.toLocaleString()} source transaction${result.rebuilt !== 1 ? "s" : ""} imported so far.`
              : "Stopped before any source transactions were imported.",
        });
      } else if (result.rebuilt === 0) {
        toast({
          title: "No history imported",
          description:
            result.failed > 0
              ? `${result.failed.toLocaleString()} source transaction${result.failed !== 1 ? "s" : ""} couldn't be fetched — check your node connection and try again.`
              : "These source transactions weren't found on this provider — they may not be indexed here yet.",
          variant: result.failed > 0 ? "destructive" : "default",
        });
      } else if (resolveNote) {
        // Import succeeded but the follow-up attribution/recompute step failed.
        // Report the import success with a clear note about the follow-up issue so
        // the user knows transactions were saved but balances may need a recompute.
        toast({
          title: "History imported",
          description: `${importedDesc} ${resolveNote}`,
        });
      } else if (unattributable === 0) {
        toast({
          title: "History imported",
          description: `${importedDesc} All spends are now attributed and balances corrected.`,
        });
      } else {
        toast({
          title: "History imported",
          description: `${importedDesc} ${unattributable.toLocaleString()} spend${unattributable !== 1 ? "s" : ""} still can't be attributed (their source addresses aren't tracked).`,
        });
      }
    } catch (err) {
      console.warn("[BalanceOverview] Import missing history failed:", err);
      toast({
        title: "Import failed",
        description: `Couldn't import the missing source transactions. ${describeResolveError(err)}`,
        variant: "destructive",
      });
    } finally {
      setImportingHistory(false);
      setImportProgress(null);
      importAbortRef.current = null;
    }
  }, [toast]);

  // User-triggered cancel of an in-flight history import. Aborts the run's
  // signal; any transactions already imported are kept.
  const handleCancelImportHistory = useCallback(() => {
    importAbortRef.current?.abort();
  }, []);

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

  const { copy, copiedKey } = useCopyToClipboard();
  const copyAddress = useCallback((address: string) => {
    copy(address, { label: "Address" });
  }, [copy]);

  // Open the "missing transactions" dialog and compute the list. Works fully
  // offline — it reads only local participant data and needs no provider.
  const openMissingDialog = useCallback(async () => {
    setMissingDialogOpen(true);
    setMissingLoading(true);
    try {
      const details = await getMissingSourceTxidDetails();
      setMissingDetails(details);
    } catch (err) {
      console.warn("[BalanceOverview] Failed to compute missing source txids:", err);
      setMissingDetails([]);
      toast({
        title: "Couldn't build the list",
        description: "Something went wrong reading the missing transactions. Please try again.",
        variant: "destructive",
      });
    } finally {
      setMissingLoading(false);
    }
  }, [toast]);

  const copyText = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ description: label });
    } catch {
      toast({
        title: "Copy failed",
        description: "Could not copy to your clipboard.",
        variant: "destructive",
      });
    }
  }, [toast]);

  const copyAllMissing = useCallback(() => {
    if (!missingDetails || missingDetails.length === 0) return;
    const text = missingDetails.map((d) => d.sourceTxid).join("\n");
    void copyText(
      text,
      `Copied ${missingDetails.length.toLocaleString()} source transaction id${missingDetails.length !== 1 ? "s" : ""}`,
    );
  }, [missingDetails, copyText]);

  // Save the missing-transaction list as a downloadable file. Works fully offline
  // (just builds a Blob from the in-memory list) so it's consistent with the
  // dialog itself — no provider or network needed.
  const downloadMissing = useCallback(
    (format: "json" | "csv") => {
      if (!missingDetails || missingDetails.length === 0) return;
      try {
        const content =
          format === "json"
            ? buildMissingSourceJson(missingDetails)
            : buildMissingSourceCsv(missingDetails);
        const mime =
          format === "json"
            ? "application/json;charset=utf-8"
            : "text/csv;charset=utf-8";
        const stamp = new Date().toISOString().slice(0, 10);
        const filename = `kyutxo-missing-transactions-${stamp}.${format}`;
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        toast({
          description: `Saved ${missingDetails.length.toLocaleString()} source transaction${missingDetails.length !== 1 ? "s" : ""} to ${filename}`,
        });
      } catch (err) {
        console.warn("[BalanceOverview] Failed to download missing transactions:", err);
        toast({
          title: "Download failed",
          description: "Couldn't save the file. Please try again.",
          variant: "destructive",
        });
      }
    },
    [missingDetails, toast],
  );

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

  const showSpendWarning =
    !spendWarningDismissed &&
    unresolvedPrevouts !== null &&
    unresolvedPrevouts > 0;

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

      {showSpendWarning && (
        <div
          className="flex-none flex items-start gap-3 px-4 py-3 border-b bg-yellow-50 dark:bg-yellow-950/30"
          data-testid="banner-spend-warning"
        >
          <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400 mt-0.5 flex-none" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-yellow-800 dark:text-yellow-200">
              Some spends could not be attributed — balances may be too high
            </p>
            <p className="text-xs text-yellow-700/80 dark:text-yellow-300/70 mt-0.5">
              {unresolvedPrevouts!.toLocaleString()} spend{unresolvedPrevouts !== 1 ? "s" : ""} with an unknown source address.
              Resolving them will subtract the correct amounts from the source wallets.
            </p>
            {unattributableSpends > 0 && (
              <p
                className="text-xs text-yellow-700/80 dark:text-yellow-300/70 mt-0.5"
                data-testid="text-unattributable-spends"
              >
                {unattributableSpends.toLocaleString()} of these can't yet be tied to any tracked wallet
                {unattributableSpends === unresolvedPrevouts ? " — import their source history to attribute them." : "."}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-none flex-wrap justify-end">
            {unattributableSpends > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={openMissingDialog}
                disabled={importingHistory || fixingPrevouts}
                data-testid="button-view-missing-transactions"
                className="border-yellow-400 dark:border-yellow-600 text-yellow-800 dark:text-yellow-200"
              >
                <ListChecks className="h-3 w-3 mr-1.5" />
                View missing transactions
              </Button>
            )}
            {unattributableSpends > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleImportMissingHistory}
                disabled={importingHistory || fixingPrevouts}
                data-testid="button-import-missing-history"
                className="border-yellow-400 dark:border-yellow-600 text-yellow-800 dark:text-yellow-200"
              >
                {importingHistory ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
                    {importProgress
                      ? `Importing ${importProgress.processed.toLocaleString()}/${importProgress.total.toLocaleString()}…`
                      : "Importing…"}
                  </>
                ) : (
                  <>
                    <Download className="h-3 w-3 mr-1.5" />
                    Import missing history
                  </>
                )}
              </Button>
            )}
            {importingHistory && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleCancelImportHistory}
                data-testid="button-cancel-import-history"
                className="border-yellow-400 dark:border-yellow-600 text-yellow-800 dark:text-yellow-200"
              >
                <X className="h-3 w-3 mr-1.5" />
                Cancel
              </Button>
            )}
            {fixingPrevouts ? (
              <Button
                size="sm"
                variant="outline"
                onClick={handleCancelFixPrevouts}
                disabled={cancellingFixPrevouts}
                data-testid="button-cancel-fix-prevouts"
                className="border-yellow-400 dark:border-yellow-600 text-yellow-800 dark:text-yellow-200"
              >
                <StopCircle className="h-3 w-3 mr-1.5" />
                {cancellingFixPrevouts
                  ? "Stopping…"
                  : resolveProgressGlobal && resolveProgressGlobal.total > 0
                    ? `Stop (${resolveProgressGlobal.resolved.toLocaleString()}/${resolveProgressGlobal.total.toLocaleString()})`
                    : "Stop resolving"}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={handleFixPrevouts}
                disabled={importingHistory}
                data-testid="button-fix-prevouts"
                className="border-yellow-400 dark:border-yellow-600 text-yellow-800 dark:text-yellow-200"
              >
                Resolve & Recompute
              </Button>
            )}
            <button
              onClick={() => setSpendWarningDismissed(true)}
              className="text-yellow-600/60 dark:text-yellow-400/60 hover:text-yellow-700 dark:hover:text-yellow-300 transition-colors"
              data-testid="button-dismiss-spend-warning"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      <Dialog open={missingDialogOpen} onOpenChange={setMissingDialogOpen}>
        <DialogContent className="max-w-2xl" data-testid="dialog-missing-transactions">
          <DialogHeader>
            <DialogTitle>Missing source transactions</DialogTitle>
            <DialogDescription>
              These source transactions aren't in your vault yet. Import them (for example from a
              wallet export) so KYUTXO can match their outputs to your spends and correct the
              affected balances. No internet connection is needed.
            </DialogDescription>
          </DialogHeader>

          {missingLoading ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Finding missing transactions…</p>
            </div>
          ) : !missingDetails || missingDetails.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-2">
              <Check className="h-6 w-6 text-muted-foreground/60" />
              <p className="text-sm text-muted-foreground" data-testid="text-no-missing-transactions">
                Nothing to import — these spends' source addresses aren't tracked, so more history
                won't tie them to a wallet.
              </p>
            </div>
          ) : (
            <>
              <p className="text-xs text-muted-foreground" data-testid="text-missing-count">
                {missingDetails.length.toLocaleString()} source transaction
                {missingDetails.length !== 1 ? "s" : ""} to import.
              </p>
              <ScrollArea className="h-[320px] rounded-md border">
                <div className="divide-y">
                  {missingDetails.map((d) => (
                    <div
                      key={d.sourceTxid}
                      className="flex items-start gap-2 p-3"
                      data-testid={`row-missing-${d.sourceTxid}`}
                    >
                      <div className="flex-1 min-w-0">
                        <p
                          className="text-xs font-mono break-all"
                          data-testid={`text-missing-source-${d.sourceTxid}`}
                        >
                          {d.sourceTxid}
                        </p>
                        {d.spendingTxids.length > 0 && (
                          <p className="text-xs text-muted-foreground mt-1 break-all">
                            Referenced by{" "}
                            {d.spendingTxids.length === 1
                              ? d.spendingTxids[0]
                              : `${d.spendingTxids.length.toLocaleString()} spends: ${d.spendingTxids.join(", ")}`}
                          </p>
                        )}
                      </div>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="flex-none"
                        onClick={() => copy(d.sourceTxid, { label: "Transaction id" })}
                        data-testid={`button-copy-missing-${d.sourceTxid}`}
                      >
                        <Copy className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </>
          )}

          <DialogFooter className="flex-wrap gap-2 sm:gap-2">
            {missingDetails && missingDetails.length > 0 && (
              <>
                <Button
                  variant="outline"
                  onClick={copyAllMissing}
                  data-testid="button-copy-all-missing"
                >
                  <Copy className="h-4 w-4 mr-1.5" />
                  Copy all source ids
                </Button>
                <Button
                  variant="outline"
                  onClick={() => downloadMissing("json")}
                  data-testid="button-download-missing-json"
                >
                  <Download className="h-4 w-4 mr-1.5" />
                  Download JSON
                </Button>
                <Button
                  variant="outline"
                  onClick={() => downloadMissing("csv")}
                  data-testid="button-download-missing-csv"
                >
                  <Download className="h-4 w-4 mr-1.5" />
                  Download CSV
                </Button>
              </>
            )}
            <Button onClick={() => setMissingDialogOpen(false)} data-testid="button-close-missing-dialog">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
              const unresolvedCount = unresolvedByGroup.get(group.name) ?? 0;

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
                        {unresolvedCount > 0 && (
                          <Badge
                            variant="outline"
                            className="text-xs flex-none gap-1 border-yellow-400 dark:border-yellow-600 text-yellow-700 dark:text-yellow-300"
                            title={`${unresolvedCount.toLocaleString()} spend${unresolvedCount !== 1 ? "s" : ""} pending attribution — balance may be too high`}
                            data-testid={`badge-unresolved-${group.name}`}
                          >
                            <AlertTriangle className="h-3 w-3" />
                            {unresolvedCount.toLocaleString()} pending
                          </Badge>
                        )}
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
                      {unresolvedCount > 0 && (
                        <div
                          className="flex items-center gap-2 px-4 py-2 text-xs text-yellow-700 dark:text-yellow-300 bg-yellow-50 dark:bg-yellow-950/30 border-b"
                          data-testid={`note-unresolved-${group.name}`}
                        >
                          <AlertTriangle className="h-3.5 w-3.5 flex-none" />
                          <span className="flex-1">
                            {unresolvedCount.toLocaleString()} spend{unresolvedCount !== 1 ? "s" : ""} pending attribution — this balance may be too high until resolved.
                          </span>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleResolveGroup(group.name);
                            }}
                            disabled={resolvingGroups.has(group.name)}
                            data-testid={`button-resolve-${group.name}`}
                            className="flex-none border-yellow-400 dark:border-yellow-600 text-yellow-800 dark:text-yellow-200"
                          >
                            {resolvingGroups.has(group.name) ? (
                              <>
                                <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
                                {cancellingGroups.has(group.name)
                                  ? "Stopping…"
                                  : (() => {
                                      const prog = resolveProgressByGroup.get(group.name);
                                      return prog && prog.total > 0
                                        ? `Resolving… ${prog.resolved.toLocaleString()}/${prog.total.toLocaleString()}`
                                        : "Resolving…";
                                    })()}
                              </>
                            ) : (
                              "Resolve"
                            )}
                          </Button>
                          {resolvingGroups.has(group.name) && !cancellingGroups.has(group.name) && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleCancelResolveGroup(group.name);
                              }}
                              data-testid={`button-stop-resolve-${group.name}`}
                              className="flex-none text-muted-foreground"
                            >
                              <StopCircle className="h-3 w-3 mr-1" />
                              Stop
                            </Button>
                          )}
                        </div>
                      )}
                      {rowsLoading && !rows ? (
                        <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          <span>Loading addresses…</span>
                        </div>
                      ) : rows && rows.length > 0 ? (
                        <GroupAddressRows
                          rows={rows}
                          displayUnit={displayUnit}
                          copiedAddress={copiedKey}
                          onCopy={copyAddress}
                          unresolvedByRecordId={unresolvedByRecordId}
                          resolvingRecordIds={resolvingRecordIds}
                          cancellingRecordIds={cancellingRecordIds}
                          resolveProgressByRecordId={resolveProgressByRecordId}
                          onResolveAddress={handleResolveAddress}
                          onCancelResolveAddress={handleCancelResolveAddress}
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

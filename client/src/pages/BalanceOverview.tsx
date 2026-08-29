import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import { useGuardedAddressCopy } from "@/hooks/use-guarded-address-copy";
import { useDbChangeSignal } from "@/hooks/use-db-change-signal";
import { useLiveQuery } from "dexie-react-hooks";
import { getBtcUsdPriceData } from "@/lib/data/price-data-crud";
import { isUserCuratedImportance } from "@/lib/db-types";
import {
  countRecordsByType,
  getRecordsPageByTypeIdReverseKeyset,
  getAddressBalanceRowsForGroup,
  getRecordsByIds,
  findRecordByInputString,
} from "@/lib/data/record-crud";
import { getUnspentDustByAddress } from "@/lib/data/dust-flags-crud";
import { engineGetBalanceGroupSummaries, subscribeEngineReadiness } from "@/lib/engine/engine-client";
import { evaluateEngineFreshness } from "@/lib/engine/engine-freshness";
import { recomputeAddressStats, countHeuristicMatchedAddresses, getHeuristicMatchedAddresses } from "@/lib/data/address-stats";
import { getSettings, updateSettings } from "@/lib/data/settings-crud";
import { countUnresolvedPrevoutInputs, getUnresolvedSpendBreakdown, getMissingSourceTxids, getMissingSourceTxidDetails, buildMissingSourceJson, buildMissingSourceCsv, type MissingSourceDetail } from "@/lib/data/transaction-crud";
import { transactionSyncService } from "@/lib/transaction-sync";
import { runTxidBackfill, detectOrphanedTxRecords, formatDetailOutcome, type BackfillTxDetail } from "@/lib/txid-backfill";
import { TxidLink } from "@/components/TxidLink";
import { createProviderFromSettings } from "@/lib/blockchain-api";
import { getNodeSettings } from "@/lib/data/node-settings-crud";
import { describeResolveError } from "@/lib/resolve-error";
import {
  type GroupBy,
  type AddressBalanceRow,
  getGroupKeys,
} from "@/lib/balance-grouping";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useVirtualizer } from "@tanstack/react-virtual";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FilterChips } from "@/components/FilterChips";
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
 *
 * Unless `includeDiscovered` is set, only user-curated addresses are counted —
 * blockchain-discovered records (auto-created for counterparty addresses during
 * sync, often inheriting the parent's wallet name) carry one-sided local
 * history, so their "balance" is really just sats seen received and would
 * inflate every total with funds the user does not control.
 */
async function aggregateGroups(
  groupBy: GroupBy,
  signal: AbortSignal,
  onProgress: (processed: number) => void,
  includeDiscovered: boolean,
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
      // Skip non-curated (blockchain-discovered / pending-review) records
      // before anything else so an excluded row can neither count toward the
      // totals nor trigger the backfill pass.
      if (!includeDiscovered && !isUserCuratedImportance(rec.addressImportance)) continue;
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
    <div ref={scrollRef} className="max-h-96 overflow-auto px-4 py-2" data-testid="scroll-group-address-rows">
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

// Virtualized renderer for the heuristic-matched address list. On large vaults
// this set can run into the thousands, so we virtualize the rows (matching the
// @tanstack/react-virtual pattern used by Records/Transactions/UTXOs/Bulk
// Editor) instead of mounting one DOM row per address. Rows can wrap (addresses
// use break-all), so we measure each rendered row.
const HEURISTIC_ROW_HEIGHT = 44;

function VirtualizedHeuristicList({
  addresses,
  resyncingAddresses,
  resyncTxProgress,
  resyncDisabled,
  copiedKey,
  onCopy,
  onResync,
}: {
  addresses: string[];
  resyncingAddresses: Set<string>;
  /** address -> live { fetched, total } tx counter for an in-flight per-address re-sync. */
  resyncTxProgress: Map<string, { fetched: number; total: number }>;
  resyncDisabled: boolean;
  copiedKey: string | null;
  onCopy: (address: string) => void;
  onResync: (address: string) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: addresses.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => HEURISTIC_ROW_HEIGHT,
    overscan: 20,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    let prevWidth = el.clientWidth;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const newWidth = entry.contentRect.width;
      if (newWidth !== prevWidth) {
        prevWidth = newWidth;
        virtualizer.measure();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [virtualizer]);

  return (
    <div
      ref={parentRef}
      className="max-h-[280px] overflow-auto rounded-md border border-yellow-300 dark:border-yellow-800 bg-yellow-50/50 dark:bg-yellow-950/20"
      data-testid="scroll-heuristic-addresses"
    >
      <div
        className="relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const address = addresses[virtualRow.index];
          const isResyncing = resyncingAddresses.has(address);
          const txProgress = isResyncing ? resyncTxProgress.get(address) : undefined;
          return (
            <div
              key={address}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              className="absolute left-0 right-0 flex items-center gap-2 px-3 py-2 border-b border-yellow-200 dark:border-yellow-900"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
              data-testid={`row-heuristic-address-${address}`}
            >
              <p
                className="flex-1 min-w-0 text-xs font-mono break-all text-yellow-800 dark:text-yellow-200"
                data-testid={`text-heuristic-address-${address}`}
              >
                {address}
              </p>
              <Button
                size="icon"
                variant="ghost"
                className="flex-none h-7 w-7 text-yellow-700 dark:text-yellow-300"
                onClick={() => onCopy(address)}
                data-testid={`button-copy-heuristic-address-${address}`}
              >
                {copiedKey === address ? (
                  <Check className="h-3 w-3" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onResync(address)}
                disabled={isResyncing || resyncDisabled}
                data-testid={`button-resync-heuristic-address-${address}`}
                className="flex-none border-yellow-400 dark:border-yellow-600 text-yellow-800 dark:text-yellow-200"
              >
                {isResyncing ? (
                  <>
                    <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                    {txProgress && txProgress.total > 0 ? (
                      <span
                        data-testid={`text-heuristic-single-resync-tx-progress-${address}`}
                      >
                        {txProgress.fetched.toLocaleString()}/
                        {txProgress.total.toLocaleString()} transactions fetched
                      </span>
                    ) : (
                      "Re-syncing…"
                    )}
                  </>
                ) : (
                  "Re-sync"
                )}
              </Button>
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
  // Separate signal so flag/unflag actions on the Dusted/UTXOs pages refresh
  // the dust adjustments without re-running the full balance aggregation.
  const dustFlagsSignal = useDbChangeSignal(["dustFlags"]);
  const computationId = useRef(0);
  const [engineReadySignal, setEngineReadySignal] = useState(0);

  // Spend health: unresolved prevout inputs (blank-address inputs with prevTxid/prevVout).
  const [unresolvedPrevouts, setUnresolvedPrevouts] = useState<number | null>(null);
  const [spendWarningDismissed, setSpendWarningDismissed] = useState(false);
  // Addresses still computed with the FIFO heuristic (synced before prevout data
  // was collected). Their balances can be wrong for coinjoin/batch transactions;
  // re-syncing them promotes each to exact prevout matching.
  const [heuristicAddressCount, setHeuristicAddressCount] = useState<number | null>(null);
  const [heuristicWarningDismissed, setHeuristicWarningDismissed] = useState(false);
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
  // Per-transaction outcomes from the last "Import missing history" run, so
  // the user can see exactly which txids were rebuilt / skipped / failed (with
  // record links when the txid belongs to a tracked transaction record).
  // `null` until a run finishes; cleared when dismissed.
  const [importDetails, setImportDetails] = useState<BackfillTxDetail[] | null>(null);
  const [showAllImportDetails, setShowAllImportDetails] = useState(false);
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
  // True while re-syncing the heuristic-matched addresses (the heuristic-mode
  // banner's "Re-sync addresses" action). Each address is re-fetched so it
  // collects exact prevout data and is promoted off the FIFO fallback.
  const [resyncingHeuristic, setResyncingHeuristic] = useState(false);
  // Per-address progress for the heuristic re-sync: { processed, total }.
  const [heuristicResyncProgress, setHeuristicResyncProgress] = useState<{ processed: number; total: number } | null>(null);
  const [cancellingResyncHeuristic, setCancellingResyncHeuristic] = useState(false);
  // Per-address fetch progress for the in-flight heuristic re-sync: which
  // address is currently being fetched and how many of its transactions have
  // been processed so far, as reported by syncSingleAddress's onProgress.
  const [heuristicResyncAddressProgress, setHeuristicResyncAddressProgress] = useState<{
    address: string;
    fetched: number;
    total: number;
  } | null>(null);
  const resyncHeuristicAbortRef = useRef<AbortController | null>(null);
  // Expandable detail under the heuristic banner: the specific address strings
  // still on FIFO matching, loaded lazily when the user opens the list (and kept
  // fresh on db changes while open). Each can be re-synced on its own.
  const [heuristicDetailsOpen, setHeuristicDetailsOpen] = useState(false);
  const [heuristicAddresses, setHeuristicAddresses] = useState<string[] | null>(null);
  const [loadingHeuristicList, setLoadingHeuristicList] = useState(false);
  // Addresses currently running a one-off per-address re-sync (so each row's
  // button can show its own spinner and the rest stay enabled).
  const [resyncingHeuristicAddresses, setResyncingHeuristicAddresses] = useState<Set<string>>(new Set());
  // address -> live { fetched, total } tx counter for an in-flight per-address
  // re-sync, so a single large address doesn't look frozen while it fetches.
  const [singleResyncTxProgress, setSingleResyncTxProgress] = useState<Map<string, { fetched: number; total: number }>>(new Map());
  const resolveAbortByGroupRef = useRef<Map<string, AbortController>>(new Map());
  const resolveAbortByRecordRef = useRef<Map<number, AbortController>>(new Map());
  const [cancellingGroups, setCancellingGroups] = useState<Set<string>>(new Set());
  const [cancellingRecordIds, setCancellingRecordIds] = useState<Set<number>>(new Set());

  // Re-run aggregation when the native read-engine flips to ready so the fast
  // path can take over from any Dexie fallback that ran first.
  useEffect(() => subscribeEngineReadiness(() => setEngineReadySignal((s) => s + 1)), []);

  // Hide user-flagged dust UTXOs from all balance totals when enabled
  // (mirrors the UTXOs page toggle; off = identical to before).
  const [hideDust, setHideDust] = useState(false);
  // Whether blockchain-discovered addresses are counted in the balances.
  // Default off: their local history is one-sided (only txs that touched the
  // user's own addresses are stored), so their "balance" is just sats seen
  // received — not funds the user controls. Mirrors the UTXOs page toggle.
  const [includeDiscovered, setIncludeDiscovered] = useState(false);
  // Precomputed dust adjustments while "Hide dust" is on: per-address and
  // per-group sats/count to subtract, plus deduped grand totals. Only dust on
  // addresses actually counted in the totals (cachedUtxoCount > 0) is included.
  const [dustAdj, setDustAdj] = useState<{
    byAddress: Map<string, { sats: number; count: number }>;
    byGroup: Map<string, { sats: number; count: number }>;
    totalSats: number;
    totalCount: number;
  } | null>(null);

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
  const includeDiscoveredRef = useRef(includeDiscovered);
  includeDiscoveredRef.current = includeDiscovered;

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

      // Check whether cached balances were computed with the old formula
      // (received − spent). Version 2 = unspent-output sum (never negative).
      // This must run before the engine fast path: engine group summaries read
      // cachedBalanceSats directly, so they would serve stale totals if we
      // didn't recompute first.
      const settings = await getSettings('default');
      const needsFormulaUpgrade = !settings?.balanceFormulaVersion || settings.balanceFormulaVersion < 2;
      if (thisId !== computationId.current || signal.aborted) return;

      if (needsFormulaUpgrade) {
        setPhase("backfilling");
        setBackfillProgress({ processed: 0, total });
        const res = await recomputeAddressStats({
          signal,
          skipNotification: true,
          origin: "user",
          // Small batches so the progress counter visibly ticks every ~1s on
          // large vaults; with the default 500 the first update can take 5s+
          // and the screen looks stalled (the "frozen app" report).
          batchSize: 100,
          onProgress: (p) => {
            if (thisId === computationId.current) {
              setBackfillProgress({ processed: p.processed, total: p.total });
            }
          },
        });
        if (thisId !== computationId.current || signal.aborted || res.cancelled) return;

        // Mark the formula as upgraded so subsequent loads skip this recompute.
        try {
          await updateSettings('default', { balanceFormulaVersion: 2 }, { skipNotification: true });
        } catch {
          // Best-effort; the recompute already ran so balances are correct.
        }

        setPhase("loading");
        setAggProgress({ processed: 0, total });
      }

      // Engine fast path: when the native read-engine mirror is fresh for the
      // 'records' scope, compute group summaries + grand totals in SQL. We only
      // trust it when the mirror reports no stale per-address stats; any stale
      // rows mean the Dexie path's one-time backfill still needs to run, so we
      // fall through to it to preserve that exact behaviour.
      try {
        const decision = await evaluateEngineFreshness("records");
        if (thisId !== computationId.current || signal.aborted) return;
        // The engine query serves only the default (user-curated) view; the
        // include-discovered view always takes the Dexie path below.
        if (decision.useEngine && !includeDiscovered) {
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
      }, includeDiscovered);
      if (!result || thisId !== computationId.current || signal.aborted) return;

      if (result.needsBackfill) {
        setPhase("backfilling");
        setBackfillProgress({ processed: 0, total });
        const res = await recomputeAddressStats({
          signal,
          skipNotification: true,
          origin: "user",
          // Small batches for a visibly moving counter (see formula-upgrade
          // backfill above).
          batchSize: 100,
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
        }, includeDiscovered);
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
  }, [groupBy, dbSignal, engineReadySignal, includeDiscovered]);

  // Dust adjustments: while "Hide dust" is on, compute how many sats/UTXOs to
  // subtract per address and per group. A dust flag only counts when it is
  // still unspent AND its address is actually included in the cached totals
  // (record exists with cachedUtxoCount > 0). Recomputed on db changes and
  // when the grouping dimension changes (group keys depend on it).
  useEffect(() => {
    if (!hideDust) {
      setDustAdj(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const dust = await getUnspentDustByAddress();
      const byAddress = new Map<string, { sats: number; count: number }>();
      const byGroup = new Map<string, { sats: number; count: number }>();
      let totalSats = 0;
      let totalCount = 0;
      for (const [address, adj] of Array.from(dust.byAddress.entries())) {
        if (cancelled) return;
        const rec = await findRecordByInputString(address);
        if (!rec || (rec.cachedUtxoCount ?? 0) <= 0) continue;
        // Keep the dust adjustments aligned with the displayed set: dust on an
        // excluded blockchain-discovered address must not be subtracted.
        if (!includeDiscovered && !isUserCuratedImportance(rec.addressImportance)) continue;
        byAddress.set(address, adj);
        totalSats += adj.sats;
        totalCount += adj.count;
        for (const key of getGroupKeys(rec, groupBy)) {
          const g = byGroup.get(key) ?? { sats: 0, count: 0 };
          g.sats += adj.sats;
          g.count += adj.count;
          byGroup.set(key, g);
        }
      }
      if (!cancelled) setDustAdj({ byAddress, byGroup, totalSats, totalCount });
    })().catch((err) => {
      console.warn("[BalanceOverview] Failed to compute dust adjustments:", err);
      if (!cancelled) setDustAdj(null);
    });
    return () => {
      cancelled = true;
    };
  }, [hideDust, groupBy, dbSignal, dustFlagsSignal, includeDiscovered]);

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

  // Heuristic-mode health: count addresses whose stats still use FIFO matching
  // (no prevout data). Pure local read; recomputed whenever the db changes.
  useEffect(() => {
    let cancelled = false;
    countHeuristicMatchedAddresses().then((count) => {
      if (!cancelled) {
        setHeuristicAddressCount(count);
        if (count === 0) setHeuristicWarningDismissed(false);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [dbSignal]);

  // Load the specific heuristic-matched addresses only when the detail list is
  // open, and refresh it on any db change (e.g. after a re-sync drops one off
  // the list). Same local read as the count above, just keeping the strings.
  useEffect(() => {
    if (!heuristicDetailsOpen) return;
    let cancelled = false;
    setLoadingHeuristicList(true);
    getHeuristicMatchedAddresses().then((addresses) => {
      if (!cancelled) {
        setHeuristicAddresses(addresses);
        setLoadingHeuristicList(false);
      }
    }).catch(() => {
      if (!cancelled) setLoadingHeuristicList(false);
    });
    return () => { cancelled = true; };
  }, [heuristicDetailsOpen, dbSignal]);

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

  // Re-sync every address whose UTXO stats still use the FIFO heuristic (the
  // heuristic-mode banner's one-click action). Re-fetching each address from the
  // configured provider collects exact prevout data and runs a prevout-resolve
  // pass, promoting the address off the FIFO fallback. Once an address is no
  // longer heuristic the dbSignal-driven recount drops the banner on its own;
  // we also recount explicitly when the run finishes.
  const handleResyncHeuristic = useCallback(async () => {
    const controller = new AbortController();
    resyncHeuristicAbortRef.current = controller;
    setCancellingResyncHeuristic(false);
    setResyncingHeuristic(true);
    setHeuristicResyncProgress(null);
    try {
      const addresses = await getHeuristicMatchedAddresses(controller.signal);
      if (addresses.length === 0) {
        toast({
          title: "Nothing to re-sync",
          description: "These addresses are already using exact matching.",
        });
        return;
      }

      const nodeSettings = await getNodeSettings("default");
      if (!nodeSettings) {
        toast({
          title: "No blockchain provider configured",
          description:
            "Configure a provider in Settings to re-sync these addresses.",
          variant: "destructive",
        });
        return;
      }

      try {
        const probe = createProviderFromSettings(nodeSettings);
        await probe.getBlockHeight();
      } catch (connErr) {
        console.warn("[BalanceOverview] Provider unreachable for heuristic re-sync:", connErr);
        toast({
          title: "Can't reach the blockchain provider",
          description:
            "Check your connection or provider settings in Settings, then try again.",
          variant: "destructive",
        });
        return;
      }

      transactionSyncService.updateProvider(nodeSettings);

      setHeuristicResyncProgress({ processed: 0, total: addresses.length });
      let synced = 0;
      let failed = 0;
      for (const address of addresses) {
        if (controller.signal.aborted) break;
        setHeuristicResyncAddressProgress({ address, fetched: 0, total: 0 });
        try {
          const result = await transactionSyncService.syncSingleAddress(address, (progress) => {
            // Live per-address fetch counter so a large address doesn't look
            // frozen. transactionsNew/transactionsFound carry the streaming
            // "processed / total" counts during the syncing-addresses phase.
            setHeuristicResyncAddressProgress({
              address,
              fetched: progress.transactionsNew,
              total: progress.transactionsFound,
            });
          });
          if (result.success) synced += 1;
          else failed += 1;
        } catch (err) {
          console.warn(`[BalanceOverview] Heuristic re-sync failed for ${address}:`, err);
          failed += 1;
        }
        setHeuristicResyncProgress({ processed: synced + failed, total: addresses.length });
      }
      setHeuristicResyncAddressProgress(null);

      const cancelled = controller.signal.aborted;
      // Recount so the banner reflects reality immediately; the dbSignal effect
      // also recounts, but doing it here avoids a flash of the stale count.
      const remaining = await countHeuristicMatchedAddresses();
      setHeuristicAddressCount(remaining);
      if (remaining === 0) setHeuristicWarningDismissed(false);

      if (cancelled) {
        toast({
          title: "Re-sync stopped",
          description:
            synced > 0
              ? `Re-synced ${synced.toLocaleString()} address${synced !== 1 ? "es" : ""}. ${remaining.toLocaleString()} still use estimated matching.`
              : "Stopped before any addresses were re-synced.",
        });
      } else if (failed > 0) {
        toast({
          title: synced > 0 ? "Partially re-synced" : "Re-sync failed",
          description:
            synced > 0
              ? `Re-synced ${synced.toLocaleString()} address${synced !== 1 ? "es" : ""}, but ${failed.toLocaleString()} couldn't be re-synced. ${remaining.toLocaleString()} still use estimated matching.`
              : "None of the addresses could be re-synced. Check your provider settings and try again.",
          variant: synced > 0 ? undefined : "destructive",
        });
      } else if (remaining > 0) {
        // Every sync succeeded, but some addresses stayed heuristic (their
        // spend prevouts couldn't be resolved) — don't claim exact matching.
        toast({
          title: "Re-synced, but some still estimated",
          description: `Re-synced ${synced.toLocaleString()} address${synced !== 1 ? "es" : ""}, but ${remaining.toLocaleString()} still use${remaining === 1 ? "s" : ""} estimated matching — their spend data couldn't be resolved.`,
        });
      } else {
        toast({
          title: "Re-synced",
          description: `Re-synced ${synced.toLocaleString()} address${synced !== 1 ? "es" : ""} with exact matching.`,
        });
      }
    } catch (err) {
      console.warn("[BalanceOverview] Heuristic re-sync failed:", err);
      toast({
        title: "Re-sync failed",
        description: "Couldn't re-sync the affected addresses. Please try again.",
        variant: "destructive",
      });
    } finally {
      resyncHeuristicAbortRef.current = null;
      setCancellingResyncHeuristic(false);
      setResyncingHeuristic(false);
      setHeuristicResyncProgress(null);
      setHeuristicResyncAddressProgress(null);
    }
  }, [toast]);

  // Cancel the in-progress heuristic re-sync. Aborting stops further fetching
  // cleanly between addresses; addresses already re-synced keep their new exact
  // data, and the heuristic count refreshes in the completion path above.
  const handleCancelResyncHeuristic = useCallback(() => {
    if (resyncHeuristicAbortRef.current) {
      setCancellingResyncHeuristic(true);
      resyncHeuristicAbortRef.current.abort();
    }
  }, []);

  // Re-sync a single heuristic-matched address (the per-address action in the
  // banner's expandable list). Same provider checks as the bulk action, scoped
  // to one address so the user can fix just the addresses they care about. Once
  // the address collects exact prevout data the dbSignal-driven recount drops it
  // from both the count and the open list on its own; we also recount here to
  // avoid a flash of the stale count.
  const handleResyncSingleHeuristic = useCallback(async (address: string) => {
    setResyncingHeuristicAddresses((prev) => {
      if (prev.has(address)) return prev;
      const next = new Set(prev);
      next.add(address);
      return next;
    });
    try {
      const nodeSettings = await getNodeSettings("default");
      if (!nodeSettings) {
        toast({
          title: "No blockchain provider configured",
          description:
            "Configure a provider in Settings to re-sync this address.",
          variant: "destructive",
        });
        return;
      }

      try {
        const probe = createProviderFromSettings(nodeSettings);
        await probe.getBlockHeight();
      } catch (connErr) {
        console.warn("[BalanceOverview] Provider unreachable for heuristic re-sync:", connErr);
        toast({
          title: "Can't reach the blockchain provider",
          description:
            "Check your connection or provider settings in Settings, then try again.",
          variant: "destructive",
        });
        return;
      }

      transactionSyncService.updateProvider(nodeSettings);

      let ok = false;
      try {
        const result = await transactionSyncService.syncSingleAddress(address, (progress) => {
          // Live per-address fetch counter (same mapping as the bulk action):
          // transactionsNew/transactionsFound carry the streaming
          // "processed / total" counts during the syncing-addresses phase.
          setSingleResyncTxProgress((prev) => {
            const next = new Map(prev);
            next.set(address, {
              fetched: progress.transactionsNew,
              total: progress.transactionsFound,
            });
            return next;
          });
        });
        ok = result.success;
      } catch (err) {
        console.warn(`[BalanceOverview] Heuristic re-sync failed for ${address}:`, err);
        ok = false;
      }

      // Success from the sync call only means the network sync ran — it does
      // NOT guarantee this address gained exact prevout data. Re-check whether
      // the address is still in the heuristic set before choosing the toast.
      const remainingAddresses = await getHeuristicMatchedAddresses();
      const remaining = remainingAddresses.length;
      const stillHeuristic = remainingAddresses.includes(address);
      setHeuristicAddressCount(remaining);
      if (remaining === 0) setHeuristicWarningDismissed(false);

      if (ok && !stillHeuristic) {
        toast({
          title: "Re-synced",
          description: "This address now uses exact matching.",
        });
      } else if (ok) {
        toast({
          title: "Re-synced, but still estimated",
          description:
            "This address still uses estimated matching — its spend data couldn't be resolved.",
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
      console.warn("[BalanceOverview] Heuristic re-sync failed:", err);
      toast({
        title: "Re-sync failed",
        description: "Couldn't re-sync this address. Please try again.",
        variant: "destructive",
      });
    } finally {
      setResyncingHeuristicAddresses((prev) => {
        const next = new Set(prev);
        next.delete(address);
        return next;
      });
      setSingleResyncTxProgress((prev) => {
        if (!prev.has(address)) return prev;
        const next = new Map(prev);
        next.delete(address);
        return next;
      });
    }
  }, [toast]);

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

      // Map txid → transaction-record id for any of these txids that belong to
      // tracked transaction records, so per-transaction details can link
      // straight to the record (same map the Settings rebuild passes).
      let orphanRecordIds: Map<string, number> | undefined;
      try {
        ({ recordIds: orphanRecordIds } = await detectOrphanedTxRecords());
      } catch (detectErr) {
        console.warn("[BalanceOverview] Orphan record detection failed (details will lack record links):", detectErr);
      }

      setImportProgress({ processed: 0, total: txids.length });
      const result = await runTxidBackfill(provider, txids, {
        signal: abort.signal,
        recordIds: orphanRecordIds,
        onProgress: (p) => {
          if (p.phase === "fetching") {
            setImportProgress({ processed: p.processed, total: p.orphansFound });
          }
        },
      });

      const cancelled = abort.signal.aborted;

      // Surface the per-transaction outcomes (rebuilt / skipped / failed, with
      // record links) below the banner. A cancelled run still shows whatever
      // was processed before the stop.
      setImportDetails(result.details && result.details.length > 0 ? result.details : null);
      setShowAllImportDetails(false);

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
      const rows = await getAddressBalanceRowsForGroup(groupByRef.current, name, {
        includeDiscovered: includeDiscoveredRef.current,
      });
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

  // Apply dust adjustments to the per-group summaries when "Hide dust" is on.
  const effectiveSummaries = useMemo(() => {
    if (!hideDust || !dustAdj || dustAdj.byGroup.size === 0) return groupSummaries;
    const next = new Map<string, GroupSummary>();
    groupSummaries.forEach((g, key) => {
      const adj = dustAdj.byGroup.get(key);
      next.set(
        key,
        adj
          ? {
              ...g,
              totalSats: Math.max(0, g.totalSats - adj.sats),
              utxoCount: Math.max(0, g.utxoCount - adj.count),
            }
          : g,
      );
    });
    return next;
  }, [groupSummaries, hideDust, dustAdj]);

  const groups = useMemo(() => {
    const result = Array.from(effectiveSummaries.values());
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
  }, [effectiveSummaries, sortBy]);

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

  const { copy, copiedKey, copyAddress: guardedCopyAddress } = useGuardedAddressCopy();
  const copyAddress = useCallback((address: string) => {
    void guardedCopyAddress(address);
  }, [guardedCopyAddress]);

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

  const hiddenDustSats = hideDust && dustAdj ? dustAdj.totalSats : 0;
  const hiddenDustCount = hideDust && dustAdj ? dustAdj.totalCount : 0;
  const filterChips = [
    ...(hideDust
      ? [{
          key: "hide-dust",
          label: "Excluding dust-flagged UTXOs from balances",
          onRemove: () => setHideDust(false),
        }]
      : []),
    ...(includeDiscovered
      ? [{
          key: "include-discovered",
          label: "Including discovered addresses",
          onRemove: () => setIncludeDiscovered(false),
        }]
      : []),
  ];
  const totalBalance = Math.max(0, totals.sats - hiddenDustSats);
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

  const showHeuristicWarning =
    !heuristicWarningDismissed &&
    heuristicAddressCount !== null &&
    heuristicAddressCount > 0;

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

            <div className="flex items-center gap-2 min-h-9">
              <Switch
                id="switch-balance-hide-dust"
                checked={hideDust}
                onCheckedChange={setHideDust}
                data-testid="switch-hide-dust"
              />
              <Label htmlFor="switch-balance-hide-dust" className="text-sm cursor-pointer whitespace-nowrap">
                Hide dust
              </Label>
            </div>

            <div className="flex items-center gap-2 min-h-9">
              <Switch
                id="switch-balance-include-discovered"
                checked={includeDiscovered}
                onCheckedChange={setIncludeDiscovered}
                data-testid="switch-include-discovered"
              />
              <Label htmlFor="switch-balance-include-discovered" className="text-sm cursor-pointer whitespace-nowrap">
                Include discovered
              </Label>
            </div>
          </div>
        </div>

        {includeDiscovered && (
          <div className="flex items-center gap-2 flex-wrap mt-2">
            <Badge variant="secondary" className="gap-1" data-testid="badge-discovered-included">
              Including blockchain-discovered addresses — their history is one-sided, so these balances may not be funds you control
            </Badge>
          </div>
        )}

        {hideDust && (
          <div className="flex items-center gap-2 flex-wrap mt-2">
            <Badge variant="secondary" className="gap-1" data-testid="badge-dust-hidden">
              Excluding dust-flagged UTXOs from balances
              {hiddenDustCount > 0 && (
                <span>
                  ({hiddenDustCount.toLocaleString()} excluded, {formatBtc(hiddenDustSats, displayUnit)})
                </span>
              )}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setHideDust(false)}
              className="h-6 text-xs"
              data-testid="button-show-dust"
            >
              Include dust
            </Button>
          </div>
        )}
        <FilterChips
          chips={filterChips}
          onClearAll={() => {
            setHideDust(false);
            setIncludeDiscovered(false);
          }}
          testIdPrefix="balance"
          className="mt-2"
        />
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

      {importDetails && importDetails.length > 0 && (
        <div
          className="flex-none flex items-start gap-3 px-4 py-3 border-b bg-muted/40"
          data-testid="panel-import-details"
        >
          <div className="flex-1 min-w-0 space-y-1 text-sm">
            <p className="text-xs font-medium text-foreground">
              Last import — affected transactions
            </p>
            <ul className="space-y-0.5">
              {(showAllImportDetails ? importDetails : importDetails.slice(0, 10)).map((d) => (
                <li
                  key={d.txid}
                  className="flex items-center gap-2 flex-wrap"
                  data-testid={`import-detail-${d.txid.slice(0, 8)}`}
                >
                  <TxidLink
                    txid={d.txid}
                    recordId={d.recordId ?? null}
                    showMetadataIndicator={false}
                  />
                  <span
                    className="text-xs text-muted-foreground"
                    data-testid={`import-detail-outcome-${d.txid.slice(0, 8)}`}
                  >
                    {formatDetailOutcome(d)}
                  </span>
                </li>
              ))}
            </ul>
            {importDetails.length > 10 && !showAllImportDetails && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setShowAllImportDetails(true)}
                data-testid="button-show-all-import-details"
              >
                Show all {importDetails.length.toLocaleString()} transactions
              </Button>
            )}
          </div>
          <button
            onClick={() => setImportDetails(null)}
            className="flex-none text-muted-foreground/60 hover:text-muted-foreground transition-colors"
            data-testid="button-dismiss-import-details"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {showHeuristicWarning && (
        <div
          className="flex-none flex flex-col gap-3 px-4 py-3 border-b bg-yellow-50 dark:bg-yellow-950/30"
          data-testid="banner-heuristic-warning"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400 mt-0.5 flex-none" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-yellow-800 dark:text-yellow-200">
                Some balances use estimated UTXO matching — they may be inaccurate
              </p>
              <p className="text-xs text-yellow-700/80 dark:text-yellow-300/70 mt-0.5">
                {heuristicAddressCount!.toLocaleString()} address{heuristicAddressCount !== 1 ? "es" : ""} {heuristicAddressCount !== 1 ? "were" : "was"} synced
                before exact spend data was collected, so their balances are guessed by matching
                same-value amounts. This can be wrong for coinjoin or batch transactions. Re-sync
                {heuristicAddressCount !== 1 ? " these addresses" : " this address"} to fetch exact
                spend data and switch to precise matching.
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setHeuristicDetailsOpen((o) => !o)}
                data-testid="button-toggle-heuristic-details"
                className="mt-1 -ml-2 h-7 px-2 text-xs text-yellow-800 dark:text-yellow-200"
              >
                {heuristicDetailsOpen ? (
                  <ChevronDown className="h-3 w-3 mr-1" />
                ) : (
                  <ChevronRight className="h-3 w-3 mr-1" />
                )}
                {heuristicDetailsOpen
                  ? "Hide affected addresses"
                  : heuristicAddressCount === 1
                    ? "Show affected address"
                    : "Show affected addresses"}
              </Button>
            </div>
            <div className="flex items-center gap-2 flex-none flex-wrap justify-end">
              {resyncingHeuristic ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleCancelResyncHeuristic}
                  disabled={cancellingResyncHeuristic}
                  data-testid="button-cancel-resync-heuristic"
                  className="border-yellow-400 dark:border-yellow-600 text-yellow-800 dark:text-yellow-200"
                >
                  <StopCircle className="h-3 w-3 mr-1.5" />
                  {cancellingResyncHeuristic
                    ? "Stopping…"
                    : heuristicResyncProgress && heuristicResyncProgress.total > 0
                      ? `Stop (${heuristicResyncProgress.processed.toLocaleString()}/${heuristicResyncProgress.total.toLocaleString()})`
                      : "Stop re-syncing"}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleResyncHeuristic}
                  disabled={resyncingHeuristicAddresses.size > 0}
                  data-testid="button-resync-heuristic"
                  className="border-yellow-400 dark:border-yellow-600 text-yellow-800 dark:text-yellow-200"
                >
                  Re-sync all
                </Button>
              )}
              <button
                onClick={() => setHeuristicWarningDismissed(true)}
                className="text-yellow-600/60 dark:text-yellow-400/60 hover:text-yellow-700 dark:hover:text-yellow-300 transition-colors"
                data-testid="button-dismiss-heuristic-warning"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {resyncingHeuristic && heuristicResyncAddressProgress && (
            <div
              className="ml-7 flex items-center gap-2 text-xs text-yellow-700/80 dark:text-yellow-300/70"
              data-testid="text-heuristic-resync-address-progress"
            >
              <Loader2 className="h-3 w-3 animate-spin flex-none" />
              <span className="min-w-0 truncate">
                Re-syncing{" "}
                <span className="font-mono" data-testid="text-heuristic-resync-current-address">
                  {heuristicResyncAddressProgress.address}
                </span>
                {heuristicResyncAddressProgress.total > 0 ? (
                  <>
                    {" — "}
                    <span data-testid="text-heuristic-resync-tx-progress">
                      {heuristicResyncAddressProgress.fetched.toLocaleString()}/
                      {heuristicResyncAddressProgress.total.toLocaleString()} transactions fetched
                    </span>
                  </>
                ) : (
                  " — fetching transactions…"
                )}
              </span>
            </div>
          )}

          {heuristicDetailsOpen && (
            <div className="ml-7" data-testid="list-heuristic-addresses">
              {loadingHeuristicList && heuristicAddresses === null ? (
                <div
                  className="flex items-center gap-2 text-xs text-yellow-700/80 dark:text-yellow-300/70 py-2"
                  data-testid="text-heuristic-list-loading"
                >
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Loading addresses…
                </div>
              ) : heuristicAddresses && heuristicAddresses.length > 0 ? (
                <VirtualizedHeuristicList
                  addresses={heuristicAddresses}
                  resyncingAddresses={resyncingHeuristicAddresses}
                  resyncTxProgress={singleResyncTxProgress}
                  resyncDisabled={resyncingHeuristic}
                  copiedKey={copiedKey}
                  onCopy={(address) => void guardedCopyAddress(address)}
                  onResync={handleResyncSingleHeuristic}
                />
              ) : (
                <p
                  className="text-xs text-yellow-700/80 dark:text-yellow-300/70 py-2"
                  data-testid="text-heuristic-list-empty"
                >
                  No addresses are currently using estimated matching.
                </p>
              )}
            </div>
          )}
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
              const rawRows = groupRows.get(group.name);
              // Apply per-address dust adjustments to the expanded rows so
              // they stay consistent with the adjusted group totals.
              const rows =
                rawRows && hideDust && dustAdj && dustAdj.byAddress.size > 0
                  ? rawRows.map((r) => {
                      const adj = dustAdj.byAddress.get(r.address);
                      return adj
                        ? {
                            ...r,
                            sats: Math.max(0, r.sats - adj.sats),
                            utxoCount: Math.max(0, r.utxoCount - adj.count),
                          }
                        : r;
                    })
                  : rawRows;
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

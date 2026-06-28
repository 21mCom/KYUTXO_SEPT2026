import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useContext,
  createContext,
} from "react";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { useSettings } from "@/hooks/use-settings";
import {
  ChevronDown,
  ChevronRight,
  ArrowLeft,
  ArrowRight,
  Loader2,
  Info,
  ChevronsLeftRight,
  AlertCircle,
  RefreshCw,
  X,
  Download,
  FileText,
  FileSpreadsheet,
  MapPin,
  Ban,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { useRecordPreview } from "@/contexts/RecordPreviewContext";
import {
  type GroupingDimension,
  type GroupFlow,
  type TrailHop,
  type DateRange,
  type HopNode,
  type MultiHopTrailResult,
  type MultiHopProgress,
  listGroupValues,
  getAddressesForGroup,
  getRecordByAddress,
  computeOneHop,
  computeMultiHopKnown,
  formatBtc,
  formatDate,
  formatDateRange,
  deduplicateDetails,
  UNKNOWN_SOURCE_LABEL,
  UNKNOWN_DEST_LABEL,
  MAX_HOP_DEPTH,
} from "@/lib/data/fund-trail-engine";
import { validateAddress, truncateAddress } from "@/lib/bitcoin";
import {
  buildFundTrailSnapshot,
  buildMultiHopFundTrailSnapshot,
  buildFundTrailCsv,
  buildFundTrailPdf,
  fundTrailFilename,
  triggerDownload,
  flowPath,
} from "@/lib/data/fund-trail-export";
import { AddressLink } from "@/components/AddressLink";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DIMENSION_LABELS: Record<GroupingDimension, string> = {
  walletName: "Wallet",
  owner: "Owner",
  seedName: "Seed",
};

/** Maximum hop depth before we stop offering the Expand button */
const MAX_DEPTH = 5;

// ---------------------------------------------------------------------------
// Cap notice — shown when a hop was truncated to the most recent N txs
// ---------------------------------------------------------------------------

function CapNotice({
  shownTxCount,
  totalTxCount,
  dateRange,
}: {
  shownTxCount?: number;
  totalTxCount?: number;
  dateRange?: DateRange;
}) {
  const rangeActive = !!dateRange;
  return (
    <div
      className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
      data-testid={
        rangeActive ? "fund-trail-cap-notice-range" : "fund-trail-cap-notice"
      }
    >
      <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      {rangeActive ? (
        <span>
          Showing the{" "}
          {shownTxCount != null ? shownTxCount.toLocaleString() : ""} most recent
          {totalTxCount != null ? ` of ${totalTxCount.toLocaleString()}` : ""}{" "}
          transactions in this date range, so the trail may be incomplete.
          Narrow the window further to trace older activity.
        </span>
      ) : (
        <span>
          Showing only the most recent{" "}
          {shownTxCount != null ? shownTxCount.toLocaleString() : ""} transactions
          {totalTxCount != null ? ` of ${totalTxCount.toLocaleString()}` : ""} to
          keep things fast. Narrow your selection to trace older activity.
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expanded-hop registry — lets the Export action capture hops the user opened
// ---------------------------------------------------------------------------

/**
 * Each FlowCard reports the hop it has expanded (keyed by its path) into this
 * registry so the page-level Export can serialize the *currently-displayed*
 * trail, including any expanded hops, without lifting all that state up.
 */
interface ExpandedHopRegistry {
  register: (path: string, hop: TrailHop) => void;
  unregister: (path: string) => void;
}

const ExpandedHopContext = createContext<ExpandedHopRegistry | null>(null);

// ---------------------------------------------------------------------------
// Detail Row — one address/txid/amount line inside an expanded flow
// ---------------------------------------------------------------------------

function DetailRow({
  address,
  txid,
  amount,
  blockTime,
  recordId,
}: {
  address: string;
  txid: string;
  amount: number;
  blockTime: number;
  recordId?: number;
}) {
  const { openRecordPreviewByAddress } = useRecordPreview();

  return (
    <div className="flex flex-col gap-0.5 py-1 border-t border-border/40 first:border-t-0 text-xs">
      <div className="flex items-center gap-2 flex-wrap">
        <AddressLink
          address={address}
          recordId={recordId}
          showCopy={false}
        />
        <span className="text-muted-foreground">{formatBtc(amount)}</span>
        {blockTime > 0 && (
          <span className="text-muted-foreground">{formatDate(blockTime)}</span>
        )}
      </div>
      <button
        onClick={() => openRecordPreviewByAddress(txid)}
        className="font-mono text-muted-foreground hover:text-foreground hover:underline truncate max-w-[280px] text-left"
        title={txid}
        data-testid={`fund-trail-txid-${txid.slice(0, 12)}`}
      >
        tx: {txid.slice(0, 18)}…
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FlowCard — self-contained, recursively expandable hop card
// ---------------------------------------------------------------------------

/**
 * Renders one source or destination group with:
 * - A summary row (label + amount badge)
 * - A "Details" toggle revealing individual address/txid/amount/date rows
 * - An "Expand hop" button that lazily fetches the next hop and renders
 *   further FlowCards inside, allowing arbitrary-depth traversal
 * - Cycle detection via the `visitedLabels` set passed from above
 */
function FlowCard({
  flow,
  direction,
  dimension,
  depth,
  visitedLabels,
  dateRange,
  path,
}: {
  flow: GroupFlow;
  direction: "source" | "dest";
  dimension: GroupingDimension;
  depth: number;
  visitedLabels: Set<string>;
  dateRange?: DateRange;
  path: string;
}) {
  const { fundTrailTxLimit } = useSettings();
  const { toast } = useToast();
  const [showDetails, setShowDetails] = useState(false);
  const [isExpanding, setIsExpanding] = useState(false);
  const [expandedHop, setExpandedHop] = useState<TrailHop | null>(null);
  const [expandError, setExpandError] = useState<string | null>(null);
  // Track visited labels within this branch (child of visitedLabels)
  const [branchVisited] = useState<Set<string>>(() => new Set(visitedLabels));

  // Report our expanded hop to the page-level registry so Export can capture it.
  const hopRegistry = useContext(ExpandedHopContext);
  useEffect(() => {
    if (!hopRegistry) return;
    if (expandedHop) {
      hopRegistry.register(path, expandedHop);
    } else {
      hopRegistry.unregister(path);
    }
    return () => hopRegistry.unregister(path);
  }, [hopRegistry, path, expandedHop]);

  const uniqueDetails = deduplicateDetails(flow.details);

  // An unknown group can still be expanded using its known detail addresses
  const unknownAddresses = flow.unknownAddresses ?? [];
  const canExpand =
    depth < MAX_DEPTH &&
    !visitedLabels.has(flow.groupLabel) &&
    (!flow.isUnknown || unknownAddresses.length > 0);

  const isExpanded = expandedHop !== null;

  // Actually compute this hop with the *current* window / tx limit. Shared by
  // the Expand button and the refresh-on-window-change effect below so both
  // always use the same dateRange/fundTrailTxLimit the page is currently on.
  const runExpand = useCallback(async () => {
    setIsExpanding(true);
    setExpandError(null);
    try {
      let addresses: string[];
      let selfLabel: string | null;

      if (flow.isUnknown) {
        // Use the individual addresses collected in the unknown bucket
        addresses = unknownAddresses;
        selfLabel = null;
      } else {
        const records = await getAddressesForGroup(dimension, flow.groupLabel);
        addresses = records
          .map(r => r.inputString)
          .filter((s): s is string => !!s);
        selfLabel = flow.groupLabel;
      }

      // Mark this group as visited before computing to prevent cycles
      branchVisited.add(flow.groupLabel);

      const hop = await computeOneHop(addresses, dimension, selfLabel, dateRange, undefined, {
        txLimit: fundTrailTxLimit,
      });
      setExpandedHop(hop);
    } catch (err) {
      console.error('[FundTrail] expand error', err);
      branchVisited.delete(flow.groupLabel);
      const message =
        err instanceof Error && err.message
          ? err.message
          : "Something went wrong while loading this hop.";
      setExpandError(message);
      toast({
        title: "Couldn't expand hop",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsExpanding(false);
    }
  }, [flow, dimension, unknownAddresses, branchVisited, dateRange, fundTrailTxLimit, toast]);

  const handleExpand = useCallback(() => {
    if (isExpanded) {
      setExpandedHop(null);
      return;
    }
    void runExpand();
  }, [isExpanded, runExpand]);

  // Keep an already-expanded sub-trail in sync with the active window / tx
  // limit. When the user changes the From/To dates (or the limit) the center
  // hop re-runs with the new window; an open sub-hop must re-fetch with that
  // SAME window instead of being left showing stale all-time results. We
  // re-run only when those inputs actually change — not on the initial expand
  // (runExpand already handled that) and not on unrelated re-renders.
  const refetchKey = `${dateRange?.start ?? ""}|${dateRange?.end ?? ""}|${fundTrailTxLimit}`;
  const lastRefetchKey = useRef(refetchKey);
  useEffect(() => {
    if (lastRefetchKey.current === refetchKey) return;
    lastRefetchKey.current = refetchKey;
    if (isExpanded) {
      void runExpand();
    }
  }, [refetchKey, isExpanded, runExpand]);

  // The next level's visited set includes everything visited so far + this node
  const nextVisited = new Set(branchVisited);
  nextVisited.add(flow.groupLabel);

  return (
    <div
      className="rounded-md border border-border bg-card"
      data-testid={`fund-trail-flow-card-${flow.groupLabel.replace(/\s/g, "-")}-d${depth}`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap px-3 pt-3 pb-2">
        <span className="text-xs font-semibold shrink-0 text-muted-foreground uppercase tracking-wide">
          {direction === "source" ? "Incoming from:" : "Outgoing to:"}
        </span>
        <span className="font-medium text-sm truncate flex-1 min-w-0">
          {flow.groupLabel}
        </span>
        <Badge variant="secondary" className="shrink-0">
          {formatBtc(flow.totalSats)}
        </Badge>
      </div>

      {/* Action row */}
      <div className="flex items-center gap-1 flex-wrap px-3 pb-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setShowDetails(v => !v)}
          data-testid={`fund-trail-details-toggle-${flow.groupLabel.replace(/\s/g, "-")}-d${depth}`}
        >
          <Info className="h-3 w-3 mr-1" />
          {showDetails ? "Hide" : "Details"} ({uniqueDetails.length})
        </Button>

        {canExpand && (
          <Button
            size="sm"
            variant="ghost"
            onClick={handleExpand}
            disabled={isExpanding}
            data-testid={`fund-trail-expand-${flow.groupLabel.replace(/\s/g, "-")}-d${depth}`}
          >
            {isExpanding ? (
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            ) : isExpanded ? (
              <ChevronDown className="h-3 w-3 mr-1" />
            ) : (
              <ChevronRight className="h-3 w-3 mr-1" />
            )}
            {isExpanded ? "Collapse" : "Expand"} hop
          </Button>
        )}

        {!canExpand && visitedLabels.has(flow.groupLabel) && (
          <span className="text-xs text-muted-foreground italic pl-1">
            (already shown above)
          </span>
        )}
        {!canExpand && depth >= MAX_DEPTH && (
          <span className="text-xs text-muted-foreground italic pl-1">
            (max depth reached)
          </span>
        )}
      </div>

      {/* Expand error */}
      {expandError && (
        <div
          className="mx-3 mb-3 flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-2 py-2"
          data-testid={`fund-trail-expand-error-${flow.groupLabel.replace(/\s/g, "-")}-d${depth}`}
        >
          <AlertCircle className="h-4 w-4 shrink-0 text-destructive mt-0.5" />
          <div className="flex-1 min-w-0 flex flex-col gap-2">
            <p className="text-xs text-destructive">
              Couldn't expand this hop: {expandError}
            </p>
            <div>
              <Button
                size="sm"
                variant="outline"
                onClick={handleExpand}
                disabled={isExpanding}
                data-testid={`fund-trail-expand-error-retry-${flow.groupLabel.replace(/\s/g, "-")}-d${depth}`}
              >
                {isExpanding ? (
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3 mr-1" />
                )}
                Retry
              </Button>
            </div>
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5 shrink-0"
            onClick={() => setExpandError(null)}
            data-testid={`fund-trail-expand-error-dismiss-${flow.groupLabel.replace(/\s/g, "-")}-d${depth}`}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}

      {/* Detail rows */}
      {showDetails && uniqueDetails.length > 0 && (
        <div className="mx-3 mb-3 rounded-md bg-muted/30 px-2 py-1">
          {uniqueDetails.map((d, i) => (
            <DetailRow key={i} {...d} />
          ))}
        </div>
      )}

      {/* Expanded next hop — rendered as further FlowCards */}
      {isExpanded && expandedHop && !isExpanding && (
        <div className="mx-3 mb-3 border-t border-border/50 pt-2">
          <p className="text-xs text-muted-foreground mb-2 font-medium">
            {direction === "source"
              ? `Incoming — where ${flow.groupLabel} received funds from:`
              : `Outgoing — where ${flow.groupLabel} sent funds to:`}
          </p>

          {expandedHop.isCapped && (
            <div className="mb-2">
              <CapNotice
                shownTxCount={expandedHop.shownTxCount}
                totalTxCount={expandedHop.totalTxCount}
                dateRange={dateRange}
              />
            </div>
          )}

          {direction === "source" && (
            <>
              {expandedHop.sources.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">
                  No further sources found.
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {expandedHop.sources.map(f => (
                    <FlowCard
                      key={f.groupLabel}
                      flow={f}
                      direction="source"
                      dimension={dimension}
                      depth={depth + 1}
                      visitedLabels={nextVisited}
                      dateRange={dateRange}
                      path={flowPath(path, "source", f.groupLabel)}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {direction === "dest" && (
            <>
              {expandedHop.destinations.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">
                  No further destinations found.
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {expandedHop.destinations.map(f => (
                    <FlowCard
                      key={f.groupLabel}
                      flow={f}
                      direction="dest"
                      dimension={dimension}
                      depth={depth + 1}
                      visitedLabels={nextVisited}
                      dateRange={dateRange}
                      path={flowPath(path, "dest", f.groupLabel)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// HopCard — flat card for multi-hop auto-traced results (no expand button)
// ---------------------------------------------------------------------------

/**
 * Simplified card for multi-hop layout. Shows which hop depth the entity was
 * found at, its group label, total amount, and a Details toggle. No manual
 * expand — the depth was set by the user and the trail was pre-computed.
 */
function HopCard({
  node,
  direction,
}: {
  node: HopNode;
  direction: "source" | "dest";
}) {
  const [showDetails, setShowDetails] = useState(false);
  const uniqueDetails = deduplicateDetails(node.details);

  return (
    <div
      className="rounded-md border border-border bg-card"
      data-testid={`fund-trail-hop-card-${node.groupLabel.replace(/\s/g, "-")}-h${node.hopDepth}`}
    >
      <div className="flex items-center gap-2 flex-wrap px-3 pt-3 pb-2">
        <Badge
          variant="outline"
          className="shrink-0 text-xs font-mono"
          data-testid={`fund-trail-hop-badge-${node.groupLabel.replace(/\s/g, "-")}-h${node.hopDepth}`}
        >
          Hop {node.hopDepth}
        </Badge>
        <span className="text-xs font-semibold shrink-0 text-muted-foreground uppercase tracking-wide">
          {direction === "source" ? "from:" : "to:"}
        </span>
        <span className="font-medium text-sm truncate flex-1 min-w-0">
          {node.groupLabel}
        </span>
        <Badge variant="secondary" className="shrink-0">
          {formatBtc(node.totalSats)}
        </Badge>
      </div>

      <div className="flex items-center gap-1 flex-wrap px-3 pb-2">
        {uniqueDetails.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowDetails(v => !v)}
            data-testid={`fund-trail-hop-details-${node.groupLabel.replace(/\s/g, "-")}-h${node.hopDepth}`}
          >
            <Info className="h-3 w-3 mr-1" />
            {showDetails ? "Hide" : "Details"} ({uniqueDetails.length})
          </Button>
        )}
        {node.isUnknown && (
          <span className="text-xs text-muted-foreground italic pl-1">
            unidentified
          </span>
        )}
      </div>

      {showDetails && uniqueDetails.length > 0 && (
        <div className="mx-3 mb-3 rounded-md bg-muted/30 px-2 py-1">
          {uniqueDetails.map((d, i) => (
            <DetailRow key={i} {...d} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MultiHopTrailLayout — flat scrollable layout for auto-traced multi-hop results
// ---------------------------------------------------------------------------

/**
 * Renders a multi-hop trail result as a flat scrollable 3-column layout:
 * sources (left) | center node (middle) | destinations (right).
 *
 * Each HopNode is a top-level card with a "Hop N" badge — no nesting. This
 * avoids the cramped nested-column problem of the manual expand approach.
 */
function MultiHopTrailLayout({
  centerLabel,
  centerDisplayMode = "group",
  centerRecordLabel,
  dimension,
  multiHopResult,
  dateRange,
  backwardHops,
  forwardHops,
}: {
  centerLabel: string;
  centerDisplayMode?: "group" | "address";
  centerRecordLabel?: string | null;
  dimension: GroupingDimension;
  multiHopResult: MultiHopTrailResult;
  dateRange?: DateRange;
  backwardHops: number;
  forwardHops: number;
}) {
  const { toast } = useToast();
  const { intermediaryAddressCap } = useSettings();
  const [isExporting, setIsExporting] = useState(false);
  // Opt-in: when on, exports list every traversed intermediary address instead
  // of the scannable "(+N more)" summary, so an auditor gets the complete path.
  const [fullChains, setFullChains] = useState(false);

  const hasSources = multiHopResult.sources.length > 0;
  const hasDests = multiHopResult.destinations.length > 0;
  // Totals use only hop-1 nodes — those represent direct flows into/out of
  // the center address. Summing across all depths would double-count because
  // deeper nodes are upstream/downstream chain segments of the same funds.
  const totalIn = multiHopResult.sources
    .filter(n => n.hopDepth === 1)
    .reduce((s, n) => s + n.totalSats, 0);
  const totalOut = multiHopResult.destinations
    .filter(n => n.hopDepth === 1)
    .reduce((s, n) => s + n.totalSats, 0);

  const isCapped = multiHopResult.caps.some(c => c.isCapped);
  const shownTxCount = multiHopResult.caps.filter(c => c.isCapped).reduce((s, c) => s + c.shownTxCount, 0);
  const totalTxCount = multiHopResult.caps.filter(c => c.isCapped).reduce((s, c) => s + c.totalTxCount, 0);

  const handleExport = useCallback(
    async (format: "csv" | "pdf" | "pdf-detailed") => {
      setIsExporting(true);
      try {
        const snapshot = buildMultiHopFundTrailSnapshot(
          centerLabel,
          dimension,
          multiHopResult,
        );
        if (format === "csv") {
          const csv = buildFundTrailCsv(snapshot, {
            maxIntermediaryAddresses: intermediaryAddressCap,
            fullChains,
          });
          triggerDownload(
            new Blob([csv], { type: "text/csv;charset=utf-8" }),
            fundTrailFilename(centerLabel, "csv"),
          );
        } else {
          const detailed = format === "pdf-detailed";
          const blob = await buildFundTrailPdf(snapshot, {
            detailed,
            maxIntermediaryAddresses: intermediaryAddressCap,
            fullChains,
          });
          triggerDownload(blob, fundTrailFilename(centerLabel, "pdf"));
        }
        toast({
          title: "Export ready",
          description:
            format === "csv"
              ? "Fund Trail exported as CSV."
              : format === "pdf-detailed"
                ? "Fund Trail exported as detailed PDF."
                : "Fund Trail exported as PDF.",
        });
      } catch (err) {
        console.error("[FundTrail] export error", err);
        toast({
          variant: "destructive",
          title: "Export failed",
          description: "Couldn't generate the export. Please try again.",
        });
      } finally {
        setIsExporting(false);
      }
    },
    [centerLabel, dimension, multiHopResult, intermediaryAddressCap, fullChains, toast],
  );

  const dateRangeLabel = formatDateRange(dateRange);

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-auto">
      {dateRangeLabel && (
        <div className="sticky top-0 z-50 flex justify-center px-6 pt-4">
          <Badge
            variant="secondary"
            className="text-xs shadow-sm"
            data-testid="fund-trail-active-range"
          >
            {dateRangeLabel}
          </Badge>
        </div>
      )}
      {isCapped && (
        <div className="px-6 pt-4">
          <CapNotice
            shownTxCount={shownTxCount}
            totalTxCount={totalTxCount}
            dateRange={dateRange}
          />
        </div>
      )}
      {/* Export toolbar */}
      <div className="flex items-center justify-end px-6 pt-4">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={isExporting || (!hasSources && !hasDests)}
              data-testid="fund-trail-export-button"
            >
              {isExporting ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Download className="h-4 w-4 mr-2" />
              )}
              Export
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => handleExport("csv")}
              data-testid="fund-trail-export-csv"
            >
              <FileSpreadsheet className="h-4 w-4 mr-2" />
              Export as CSV
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => handleExport("pdf")}
              data-testid="fund-trail-export-pdf"
            >
              <FileText className="h-4 w-4 mr-2" />
              Export as PDF
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => handleExport("pdf-detailed")}
              data-testid="fund-trail-export-pdf-detailed"
            >
              <FileText className="h-4 w-4 mr-2" />
              Export as detailed PDF
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={fullChains}
              onCheckedChange={(v) => setFullChains(v === true)}
              onSelect={(e) => e.preventDefault()}
              data-testid="fund-trail-export-full-chains"
            >
              Include full intermediary chains
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex flex-1 gap-4 px-6 pb-6 pt-2 min-h-0 overflow-auto">
        {/* Sources column */}
        <div className="flex flex-col gap-3 flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
            <div className="flex flex-col min-w-0">
              <span className="text-sm font-semibold text-muted-foreground uppercase tracking-wide leading-tight">
                Incoming
              </span>
              <span className="text-xs text-muted-foreground leading-tight">
                up to {backwardHops} hop{backwardHops !== 1 ? "s" : ""} back
              </span>
            </div>
            {hasSources && (
              <Badge variant="outline" className="text-xs ml-auto">
                {formatBtc(totalIn)} in
              </Badge>
            )}
          </div>

          {!hasSources && (
            <p className="text-sm text-muted-foreground italic">
              No incoming sources found within {backwardHops} hop{backwardHops !== 1 ? "s" : ""}.
            </p>
          )}

          {multiHopResult.sources.map((node, i) => (
            <HopCard
              key={`${node.groupLabel}-h${node.hopDepth}-${i}`}
              node={node}
              direction="source"
            />
          ))}
        </div>

        {/* Center node */}
        <div className="flex flex-col items-center justify-start gap-3 w-44 shrink-0">
          <div
            className="rounded-md border-2 border-primary bg-primary/10 px-4 py-5 text-center w-full"
            data-testid="fund-trail-center-node"
          >
            {centerDisplayMode === "address" ? (
              <>
                <div className="flex items-center justify-center gap-1 mb-1">
                  <MapPin className="h-3 w-3 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground uppercase tracking-wide font-medium">
                    Address
                  </span>
                </div>
                <div
                  className="font-mono text-xs break-all leading-snug"
                  data-testid="fund-trail-center-address"
                >
                  {truncateAddress(centerLabel, 8, 8)}
                </div>
                {centerRecordLabel && (
                  <div
                    className="text-xs text-muted-foreground mt-1 break-words"
                    data-testid="fund-trail-center-record-label"
                  >
                    {centerRecordLabel}
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="text-xs text-muted-foreground mb-1 uppercase tracking-wide font-medium">
                  {DIMENSION_LABELS[dimension]}
                </div>
                <div className="font-semibold text-sm break-words">{centerLabel}</div>
              </>
            )}
            <ChevronsLeftRight className="h-4 w-4 mx-auto mt-2 text-primary" />
          </div>

          <div className="text-xs text-muted-foreground text-center space-y-1">
            {hasSources && (
              <div>
                {multiHopResult.sources.filter(n => !n.isUnknown).length} known source
                {multiHopResult.sources.filter(n => !n.isUnknown).length !== 1 ? "s" : ""}
              </div>
            )}
            {hasDests && (
              <div>
                {multiHopResult.destinations.filter(n => !n.isUnknown).length} known destination
                {multiHopResult.destinations.filter(n => !n.isUnknown).length !== 1 ? "s" : ""}
              </div>
            )}
            {!hasSources && !hasDests && (
              <div className="italic">No transactions found.</div>
            )}
          </div>
        </div>

        {/* Destinations column */}
        <div className="flex flex-col gap-3 flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <ArrowLeft className="h-4 w-4 text-muted-foreground" />
            <div className="flex flex-col min-w-0">
              <span className="text-sm font-semibold text-muted-foreground uppercase tracking-wide leading-tight">
                Outgoing
              </span>
              <span className="text-xs text-muted-foreground leading-tight">
                up to {forwardHops} hop{forwardHops !== 1 ? "s" : ""} forward
              </span>
            </div>
            {hasDests && (
              <Badge variant="outline" className="text-xs ml-auto">
                {formatBtc(totalOut)} out
              </Badge>
            )}
          </div>

          {!hasDests && (
            <p className="text-sm text-muted-foreground italic">
              No outgoing destinations found within {forwardHops} hop{forwardHops !== 1 ? "s" : ""}.
            </p>
          )}

          {multiHopResult.destinations.map((node, i) => (
            <HopCard
              key={`${node.groupLabel}-h${node.hopDepth}-${i}`}
              node={node}
              direction="dest"
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MultiHopProgressBanner — live "Tracing hop N of M…" status with a Cancel
// control, shown while a multi-hop trail is being computed.
// ---------------------------------------------------------------------------

function MultiHopProgressBanner({
  progress,
  onCancel,
}: {
  progress: MultiHopProgress | null;
  onCancel: () => void;
}) {
  const directionLabel =
    progress?.direction === "dest" ? "destinations" : "sources";
  const depth = progress?.depth ?? 1;
  const maxDepth = progress?.maxDepth ?? 1;

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-4 py-2"
      data-testid="fund-trail-multihop-progress"
    >
      <div className="flex items-center gap-2 text-sm text-muted-foreground min-w-0">
        <Loader2 className="h-4 w-4 animate-spin shrink-0" />
        <span data-testid="fund-trail-multihop-progress-text">
          Tracing {directionLabel} — hop {depth} of {maxDepth}…
        </span>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onCancel}
        data-testid="fund-trail-multihop-cancel"
      >
        <Ban className="h-4 w-4 mr-2" />
        Cancel
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MultiHopCancelledNotice — persistent, non-spinning banner shown after a
// trace is cancelled, summarizing how deep it got so the partial trail below
// is not mistaken for a complete result.
// ---------------------------------------------------------------------------

function MultiHopCancelledNotice({
  cancelled,
}: {
  cancelled: MultiHopProgress;
}) {
  const directionLabel =
    cancelled.direction === "dest" ? "destinations" : "sources";
  const depth = cancelled.depth;
  const maxDepth = cancelled.maxDepth;

  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 px-4 py-2 text-sm text-muted-foreground"
      data-testid="fund-trail-multihop-cancelled"
    >
      <AlertCircle className="h-4 w-4 shrink-0" />
      <span data-testid="fund-trail-multihop-cancelled-text">
        Trace stopped while tracing {directionLabel} — reached hop {depth} of{" "}
        {maxDepth}. Results below are partial and may be incomplete.
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

/** Convert yyyy-mm-dd start/end strings into a DateRange in Unix seconds (local). */
function toDateRange(startDate: string, endDate: string): DateRange | undefined {
  let start: number | undefined;
  let end: number | undefined;
  if (startDate) {
    const d = new Date(`${startDate}T00:00:00`);
    if (!isNaN(d.getTime())) start = Math.floor(d.getTime() / 1000);
  }
  if (endDate) {
    const d = new Date(`${endDate}T23:59:59`);
    if (!isNaN(d.getTime())) end = Math.floor(d.getTime() / 1000);
  }
  if (start == null && end == null) return undefined;
  return { start, end };
}

export default function FundTrail() {
  const { fundTrailTxLimit, intermediaryAddressCap } = useSettings();

  // --- Source mode: trace by group or by a single address ---
  const [sourceMode, setSourceMode] = useState<"group" | "address">("group");
  const [addressInput, setAddressInput] = useState<string>("");
  const [addressError, setAddressError] = useState<string | null>(null);

  const queryClient = useQueryClient();

  // --- Hop depth controls (1 = same as single-hop; >1 = auto multi-hop) ---
  const [backwardHops, setBackwardHops] = useState(1);
  const [forwardHops, setForwardHops] = useState(1);
  const isMultiHop = backwardHops > 1 || forwardHops > 1;

  // Live progress for the multi-hop trace: which hop depth is currently being
  // traced, plus a snapshot of the partial results already gathered. Cleared
  // when a trace finishes; retained after a cancel so the partial trail stays
  // on screen.
  const [multiHopProgress, setMultiHopProgress] = useState<MultiHopProgress | null>(
    null,
  );

  // Snapshot of how far the trace got when the user cancelled it. Drives a
  // persistent, non-spinning notice above the trail so a partial result is not
  // mistaken for a complete one. Cleared when a new trace starts.
  const [cancelledTrace, setCancelledTrace] = useState<MultiHopProgress | null>(
    null,
  );

  const trimmedAddress = addressInput.trim();
  const isAddressValid =
    sourceMode === "address" &&
    trimmedAddress.length > 0 &&
    validateAddress(trimmedAddress).isValid;

  const handleAddressChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setAddressInput(val);
      const t = val.trim();
      if (t.length > 0 && !validateAddress(t).isValid) {
        setAddressError("Not a valid Bitcoin address");
      } else {
        setAddressError(null);
      }
    },
    [],
  );

  const handleModeSwitch = useCallback((mode: "group" | "address") => {
    setSourceMode(mode);
    setAddressError(null);
  }, []);

  // --- Group controls ---
  const [dimension, setDimension] = useState<GroupingDimension>("walletName");
  const [selectedGroup, setSelectedGroup] = useState<string>("");
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");

  const dateRange = toDateRange(startDate, endDate);
  const hasDateFilter = !!dateRange;

  const handleDimensionChange = useCallback((val: string) => {
    setDimension(val as GroupingDimension);
    setSelectedGroup("");
  }, []);

  const handleGroupChange = useCallback((val: string) => {
    setSelectedGroup(val);
  }, []);

  const handleClearDates = useCallback(() => {
    setStartDate("");
    setEndDate("");
  }, []);

  // Whether we have enough to run a trail
  const isActive =
    sourceMode === "group" ? !!selectedGroup : isAddressValid;

  // --- Group value list (only needed in group mode) ---
  const { data: groupValues = [], isLoading: isLoadingGroups } = useQuery({
    queryKey: ["fund-trail-groups", dimension],
    queryFn: () => listGroupValues(dimension),
    enabled: sourceMode === "group",
  });

  // --- Record lookup for address mode (label display in center node) ---
  const { data: addressRecord } = useQuery({
    queryKey: ["fund-trail-address-record", trimmedAddress],
    enabled: isAddressValid,
    queryFn: () => getRecordByAddress(trimmedAddress),
  });

  // --- Center node hop (single-hop, used when isMultiHop = false) ---
  const {
    data: centerHop,
    isLoading: isLoadingCenter,
    isFetching: isFetchingCenter,
    isPlaceholderData: isCenterPlaceholder,
  } = useQuery<TrailHop>({
    queryKey: [
      "fund-trail-center",
      sourceMode,
      sourceMode === "group" ? dimension : "address",
      sourceMode === "group" ? selectedGroup : trimmedAddress,
      dateRange?.start ?? null,
      dateRange?.end ?? null,
      fundTrailTxLimit,
    ],
    enabled: isActive && !isMultiHop,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      if (sourceMode === "address") {
        return computeOneHop(
          [trimmedAddress],
          dimension,
          null,
          dateRange,
          undefined,
          { txLimit: fundTrailTxLimit },
        );
      }
      const records = await getAddressesForGroup(dimension, selectedGroup);
      const addresses = records
        .map(r => r.inputString)
        .filter((s): s is string => !!s);
      return computeOneHop(addresses, dimension, selectedGroup, dateRange, undefined, {
        txLimit: fundTrailTxLimit,
      });
    },
  });

  // --- Multi-hop query (used when backwardHops > 1 || forwardHops > 1) ---
  const {
    data: multiHopResult,
    isLoading: isLoadingMultiHop,
    isFetching: isFetchingMultiHop,
    isPlaceholderData: isMultiHopPlaceholder,
  } = useQuery<MultiHopTrailResult>({
    queryKey: [
      "fund-trail-multihop",
      sourceMode,
      sourceMode === "group" ? dimension : "address",
      sourceMode === "group" ? selectedGroup : trimmedAddress,
      dateRange?.start ?? null,
      dateRange?.end ?? null,
      fundTrailTxLimit,
      backwardHops,
      forwardHops,
    ],
    enabled: isActive && isMultiHop,
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => {
      // Reset progress at the start so a stale partial from a previous trace
      // never lingers under the new one. Also drop any leftover cancel notice.
      setMultiHopProgress(null);
      setCancelledTrace(null);
      const onProgress = (p: MultiHopProgress) => {
        // Ignore late callbacks from a trace that has since been aborted.
        if (signal?.aborted) return;
        setMultiHopProgress(p.phase === "done" ? null : p);
      };
      const txOptions = { txLimit: fundTrailTxLimit };
      let result: MultiHopTrailResult;
      if (sourceMode === "address") {
        result = await computeMultiHopKnown(
          [trimmedAddress],
          dimension,
          null,
          backwardHops,
          forwardHops,
          dateRange,
          signal,
          txOptions,
          onProgress,
        );
      } else {
        const records = await getAddressesForGroup(dimension, selectedGroup);
        const addresses = records
          .map(r => r.inputString)
          .filter((s): s is string => !!s);
        result = await computeMultiHopKnown(
          addresses,
          dimension,
          selectedGroup,
          backwardHops,
          forwardHops,
          dateRange,
          signal,
          txOptions,
          onProgress,
        );
      }
      // Trace finished cleanly — drop the live progress indicator.
      setMultiHopProgress(null);
      return result;
    },
  });

  // Cancel the in-flight multi-hop trace. queryClient.cancelQueries aborts the
  // AbortSignal react-query passes into queryFn, which computeMultiHopKnown
  // observes between hops and throws AbortError. The partial results gathered so
  // far remain on screen because we keep multiHopProgress around on cancel.
  const handleCancelMultiHop = useCallback(() => {
    // Snapshot how far the trace got before aborting so the persistent notice
    // can report it; the live progress banner disappears once fetching stops.
    setCancelledTrace(multiHopProgress);
    queryClient.cancelQueries({
      queryKey: [
        "fund-trail-multihop",
        sourceMode,
        sourceMode === "group" ? dimension : "address",
        sourceMode === "group" ? selectedGroup : trimmedAddress,
        dateRange?.start ?? null,
        dateRange?.end ?? null,
        fundTrailTxLimit,
        backwardHops,
        forwardHops,
      ],
    });
  }, [
    queryClient,
    sourceMode,
    dimension,
    selectedGroup,
    trimmedAddress,
    dateRange?.start,
    dateRange?.end,
    fundTrailTxLimit,
    backwardHops,
    forwardHops,
    multiHopProgress,
  ]);

  // A recompute is in flight when the active query is fetching a new window/
  // limit but we still have a previous trail on screen (placeholderData).
  const isRecomputing = isMultiHop
    ? isFetchingMultiHop && (isMultiHopPlaceholder || !isLoadingMultiHop) && isActive
    : isFetchingCenter && (isCenterPlaceholder || !isLoadingCenter) && isActive;

  const isLoadingActive = isMultiHop ? isLoadingMultiHop : isLoadingCenter;

  // Multi-hop trace is actively running (initial trace or a recompute). While
  // this is true we show the progress banner + Cancel control.
  const isMultiHopTracing = isMultiHop && isActive && isFetchingMultiHop;

  // What to render in multi-hop mode: the finished result when we have one,
  // otherwise the latest partial snapshot so already-completed hops are visible
  // while deeper hops are still loading (or after a cancel).
  const multiHopDisplay: MultiHopTrailResult | null =
    multiHopResult ??
    (multiHopProgress
      ? {
          sources: multiHopProgress.sources,
          destinations: multiHopProgress.destinations,
          caps: multiHopProgress.caps,
        }
      : null);

  // Dim the trail only when refreshing a previously-completed result; a growing
  // partial (first trace) should read as live progress, not a stale view.
  const dimMultiHop = isMultiHopTracing && !!multiHopResult;

  // Label and display info for the center node
  const centerLabel =
    sourceMode === "address" ? trimmedAddress : selectedGroup;
  const centerRecordLabel: string | null =
    sourceMode === "address"
      ? (addressRecord?.walletName?.trim() ||
          addressRecord?.owner?.trim() ||
          addressRecord?.seedName?.trim() ||
          null)
      : null;

  return (
    <div className="flex flex-col h-full overflow-auto">
      {/* Header */}
      <div className="border-b border-border px-6 py-4">
        <h1 className="text-xl font-semibold">Fund Trail</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Trace where coins came from and went. Set source and destination hop
          depth to automatically surface known entities through unknown
          intermediaries — or keep depth at 1 and expand hops manually.
        </p>
      </div>

      {/* Controls */}
      <div className="px-6 py-4 flex flex-wrap items-end gap-4 border-b border-border">

        {/* Mode toggle */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground font-medium">
            Trace by
          </label>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant={sourceMode === "group" ? "default" : "outline"}
              onClick={() => handleModeSwitch("group")}
              data-testid="fund-trail-mode-group"
            >
              Group
            </Button>
            <Button
              size="sm"
              variant={sourceMode === "address" ? "default" : "outline"}
              onClick={() => handleModeSwitch("address")}
              data-testid="fund-trail-mode-address"
            >
              Address
            </Button>
          </div>
        </div>

        {/* Group mode controls */}
        {sourceMode === "group" && (
          <>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground font-medium">
                Group by
              </label>
              <Select value={dimension} onValueChange={handleDimensionChange}>
                <SelectTrigger
                  className="w-40"
                  data-testid="fund-trail-dimension-select"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="walletName">Wallet</SelectItem>
                  <SelectItem value="owner">Owner</SelectItem>
                  <SelectItem value="seedName">Seed</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1 min-w-[200px]">
              <label className="text-xs text-muted-foreground font-medium">
                Select {DIMENSION_LABELS[dimension]}
              </label>
              {isLoadingGroups ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading…
                </div>
              ) : (
                <Select value={selectedGroup} onValueChange={handleGroupChange}>
                  <SelectTrigger
                    className="w-56"
                    data-testid="fund-trail-group-select"
                  >
                    <SelectValue
                      placeholder={`Choose a ${DIMENSION_LABELS[dimension]}…`}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {groupValues.length === 0 ? (
                      <SelectItem value="__none__" disabled>
                        No {DIMENSION_LABELS[dimension].toLowerCase()} values found
                      </SelectItem>
                    ) : (
                      groupValues.map(v => (
                        <SelectItem key={v} value={v}>
                          {v}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              )}
            </div>
          </>
        )}

        {/* Address mode input */}
        {sourceMode === "address" && (
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground font-medium">
              Bitcoin address
            </label>
            <input
              type="text"
              value={addressInput}
              onChange={handleAddressChange}
              placeholder="Enter or paste a Bitcoin address…"
              spellCheck={false}
              autoComplete="off"
              data-testid="fund-trail-address-input"
              className="flex h-9 w-80 rounded-md border border-input bg-transparent px-3 py-1 text-sm font-mono shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            {addressError && (
              <p
                className="text-xs text-destructive"
                data-testid="fund-trail-address-error"
              >
                {addressError}
              </p>
            )}
          </div>
        )}

        {/* Date filters (shared between both modes) */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground font-medium">
            From
          </label>
          <input
            type="date"
            value={startDate}
            max={endDate || undefined}
            onChange={e => setStartDate(e.target.value)}
            data-testid="fund-trail-start-date"
            className="flex h-9 w-40 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground font-medium">
            To
          </label>
          <input
            type="date"
            value={endDate}
            min={startDate || undefined}
            onChange={e => setEndDate(e.target.value)}
            data-testid="fund-trail-end-date"
            className="flex h-9 w-40 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>

        {hasDateFilter ? (
          <Button
            size="default"
            variant="outline"
            onClick={handleClearDates}
            data-testid="fund-trail-clear-dates"
          >
            <X className="h-4 w-4 mr-1" />
            All time
          </Button>
        ) : (
          <span
            className="text-xs text-muted-foreground italic pb-2.5"
            data-testid="fund-trail-date-status"
          >
            Showing all time
          </span>
        )}

        {/* Hop depth controls */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground font-medium">
            Sources depth
          </label>
          <Select
            value={String(backwardHops)}
            onValueChange={v => setBackwardHops(Number(v))}
          >
            <SelectTrigger className="w-20" data-testid="fund-trail-backward-hops">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: MAX_HOP_DEPTH }, (_, i) => i + 1).map(n => (
                <SelectItem key={n} value={String(n)}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground font-medium">
            Destinations depth
          </label>
          <Select
            value={String(forwardHops)}
            onValueChange={v => setForwardHops(Number(v))}
          >
            <SelectTrigger className="w-20" data-testid="fund-trail-forward-hops">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: MAX_HOP_DEPTH }, (_, i) => i + 1).map(n => (
                <SelectItem key={n} value={String(n)}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {isRecomputing && !isMultiHop ? (
          <span
            className="flex items-center gap-2 text-xs text-muted-foreground pb-2.5"
            data-testid="fund-trail-recomputing"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            Updating…
          </span>
        ) : null}
      </div>

      {/* Body */}
      {!isActive ? (
        <EmptyState sourceMode={sourceMode} dimension={dimension} />
      ) : isMultiHop ? (
        <div
          className="flex flex-col flex-1 min-h-0"
          aria-busy={isMultiHopTracing}
          data-testid="fund-trail-body"
        >
          {isMultiHopTracing && (
            <div className="px-6 pt-4">
              <MultiHopProgressBanner
                progress={multiHopProgress}
                onCancel={handleCancelMultiHop}
              />
            </div>
          )}
          {!isMultiHopTracing && cancelledTrace && (
            <div className="px-6 pt-4">
              <MultiHopCancelledNotice cancelled={cancelledTrace} />
            </div>
          )}
          {multiHopDisplay ? (
            <div
              className={
                dimMultiHop
                  ? "flex flex-col flex-1 min-h-0 opacity-60 transition-opacity"
                  : "flex flex-col flex-1 min-h-0 transition-opacity"
              }
            >
              <MultiHopTrailLayout
                centerLabel={centerLabel}
                centerDisplayMode={sourceMode}
                centerRecordLabel={centerRecordLabel}
                dimension={dimension}
                multiHopResult={multiHopDisplay}
                dateRange={dateRange}
                backwardHops={backwardHops}
                forwardHops={forwardHops}
              />
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center flex-1 gap-3 text-muted-foreground">
              <Loader2 className="h-8 w-8 animate-spin" />
              <p className="text-sm">Computing fund trail…</p>
            </div>
          )}
        </div>
      ) : isLoadingActive ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-3 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin" />
          <p className="text-sm">Computing fund trail…</p>
        </div>
      ) : (
        <div
          className={
            isRecomputing
              ? "flex flex-col flex-1 opacity-60 transition-opacity"
              : "flex flex-col flex-1 transition-opacity"
          }
          aria-busy={isRecomputing}
          data-testid="fund-trail-body"
        >
          <TrailLayout
            centerLabel={centerLabel}
            centerDisplayMode={sourceMode}
            centerRecordLabel={centerRecordLabel}
            dimension={dimension}
            centerHop={centerHop ?? { sources: [], destinations: [] }}
            dateRange={dateRange}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trail Layout — three-column view
// ---------------------------------------------------------------------------

function TrailLayout({
  centerLabel,
  centerDisplayMode = "group",
  centerRecordLabel,
  dimension,
  centerHop,
  dateRange,
}: {
  centerLabel: string;
  centerDisplayMode?: "group" | "address";
  centerRecordLabel?: string | null;
  dimension: GroupingDimension;
  centerHop: TrailHop;
  dateRange?: DateRange;
}) {
  const { toast } = useToast();
  const { intermediaryAddressCap } = useSettings();
  const [isExporting, setIsExporting] = useState(false);
  const hasSources = centerHop.sources.length > 0;
  const hasDests = centerHop.destinations.length > 0;
  const totalIn = centerHop.sources.reduce((s, f) => s + f.totalSats, 0);
  const totalOut = centerHop.destinations.reduce((s, f) => s + f.totalSats, 0);

  // The center label itself is always in the visited set for children
  const rootVisited = new Set([centerLabel]);

  // Registry of hops the FlowCard tree has expanded, keyed by path, so Export
  // can capture the currently-displayed trail including any expanded hops.
  const expandedHopsRef = useRef<Map<string, TrailHop>>(new Map());
  const hopRegistry: ExpandedHopRegistry = useRef<ExpandedHopRegistry>({
    register: (path, hop) => expandedHopsRef.current.set(path, hop),
    unregister: (path) => expandedHopsRef.current.delete(path),
  }).current;

  const handleExport = useCallback(
    async (format: "csv" | "pdf" | "pdf-detailed") => {
      setIsExporting(true);
      try {
        const snapshot = buildFundTrailSnapshot(
          centerLabel,
          dimension,
          centerHop,
          expandedHopsRef.current,
        );
        if (format === "csv") {
          const csv = buildFundTrailCsv(snapshot, {
            maxIntermediaryAddresses: intermediaryAddressCap,
          });
          triggerDownload(
            new Blob([csv], { type: "text/csv;charset=utf-8" }),
            fundTrailFilename(centerLabel, "csv"),
          );
        } else {
          const detailed = format === "pdf-detailed";
          const blob = await buildFundTrailPdf(snapshot, {
            detailed,
            maxIntermediaryAddresses: intermediaryAddressCap,
          });
          triggerDownload(blob, fundTrailFilename(centerLabel, "pdf"));
        }
        toast({
          title: "Export ready",
          description:
            format === "csv"
              ? "Fund Trail exported as CSV."
              : format === "pdf-detailed"
                ? "Fund Trail exported as detailed PDF."
                : "Fund Trail exported as PDF.",
        });
      } catch (err) {
        console.error("[FundTrail] export error", err);
        toast({
          variant: "destructive",
          title: "Export failed",
          description: "Couldn't generate the export. Please try again.",
        });
      } finally {
        setIsExporting(false);
      }
    },
    [centerLabel, dimension, centerHop, intermediaryAddressCap, toast],
  );

  const dateRangeLabel = formatDateRange(dateRange);

  return (
    <ExpandedHopContext.Provider value={hopRegistry}>
    <div className="flex flex-col flex-1 min-h-0 overflow-auto">
      {dateRangeLabel && (
        <div className="sticky top-0 z-50 flex justify-center px-6 pt-4">
          <Badge
            variant="secondary"
            className="text-xs shadow-sm"
            data-testid="fund-trail-active-range"
          >
            {dateRangeLabel}
          </Badge>
        </div>
      )}
      {centerHop.isCapped && (
        <div className="px-6 pt-4">
          <CapNotice
            shownTxCount={centerHop.shownTxCount}
            totalTxCount={centerHop.totalTxCount}
            dateRange={dateRange}
          />
        </div>
      )}
      {/* Export toolbar */}
      <div className="flex items-center justify-end px-6 pt-4">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={isExporting || (!hasSources && !hasDests)}
              data-testid="fund-trail-export-button"
            >
              {isExporting ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Download className="h-4 w-4 mr-2" />
              )}
              Export
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => handleExport("csv")}
              data-testid="fund-trail-export-csv"
            >
              <FileSpreadsheet className="h-4 w-4 mr-2" />
              Export as CSV
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => handleExport("pdf")}
              data-testid="fund-trail-export-pdf"
            >
              <FileText className="h-4 w-4 mr-2" />
              Export as PDF
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => handleExport("pdf-detailed")}
              data-testid="fund-trail-export-pdf-detailed"
            >
              <FileText className="h-4 w-4 mr-2" />
              Export as detailed PDF
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

    <div className="flex flex-1 gap-4 px-6 pb-6 pt-2 min-h-0 overflow-auto">
      {/* Sources column */}
      <div className="flex flex-col gap-3 flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <ArrowRight className="h-4 w-4 text-muted-foreground" />
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-semibold text-muted-foreground uppercase tracking-wide leading-tight">
              Incoming
            </span>
            <span className="text-xs text-muted-foreground leading-tight">
              received from
            </span>
          </div>
          {hasSources && (
            <Badge variant="outline" className="text-xs ml-auto">
              {formatBtc(totalIn)} in
            </Badge>
          )}
        </div>

        {!hasSources && (
          <p className="text-sm text-muted-foreground italic">
            No incoming transactions found.
          </p>
        )}

        {centerHop.sources.map(flow => (
          <FlowCard
            key={flow.groupLabel}
            flow={flow}
            direction="source"
            dimension={dimension}
            depth={0}
            visitedLabels={rootVisited}
            dateRange={dateRange}
            path={flowPath("", "source", flow.groupLabel)}
          />
        ))}
      </div>

      {/* Center node */}
      <div className="flex flex-col items-center justify-start gap-3 w-44 shrink-0">
        <div
          className="rounded-md border-2 border-primary bg-primary/10 px-4 py-5 text-center w-full"
          data-testid="fund-trail-center-node"
        >
          {centerDisplayMode === "address" ? (
            <>
              <div className="flex items-center justify-center gap-1 mb-1">
                <MapPin className="h-3 w-3 text-muted-foreground" />
                <span className="text-xs text-muted-foreground uppercase tracking-wide font-medium">
                  Address
                </span>
              </div>
              <div
                className="font-mono text-xs break-all leading-snug"
                data-testid="fund-trail-center-address"
              >
                {truncateAddress(centerLabel, 8, 8)}
              </div>
              {centerRecordLabel && (
                <div
                  className="text-xs text-muted-foreground mt-1 break-words"
                  data-testid="fund-trail-center-record-label"
                >
                  {centerRecordLabel}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="text-xs text-muted-foreground mb-1 uppercase tracking-wide font-medium">
                {DIMENSION_LABELS[dimension]}
              </div>
              <div className="font-semibold text-sm break-words">{centerLabel}</div>
            </>
          )}
          <ChevronsLeftRight className="h-4 w-4 mx-auto mt-2 text-primary" />
        </div>

        <div className="text-xs text-muted-foreground text-center space-y-1">
          {hasSources && (
            <div>
              {centerHop.sources.length} source
              {centerHop.sources.length !== 1 ? "s" : ""}
            </div>
          )}
          {hasDests && (
            <div>
              {centerHop.destinations.length} destination
              {centerHop.destinations.length !== 1 ? "s" : ""}
            </div>
          )}
          {!hasSources && !hasDests && (
            <div className="italic">No transactions found.</div>
          )}
        </div>
      </div>

      {/* Destinations column */}
      <div className="flex flex-col gap-3 flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <ArrowLeft className="h-4 w-4 text-muted-foreground" />
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-semibold text-muted-foreground uppercase tracking-wide leading-tight">
              Outgoing
            </span>
            <span className="text-xs text-muted-foreground leading-tight">
              sent to
            </span>
          </div>
          {hasDests && (
            <Badge variant="outline" className="text-xs ml-auto">
              {formatBtc(totalOut)} out
            </Badge>
          )}
        </div>

        {!hasDests && (
          <p className="text-sm text-muted-foreground italic">
            No outgoing transactions found.
          </p>
        )}

        {centerHop.destinations.map(flow => (
          <FlowCard
            key={flow.groupLabel}
            flow={flow}
            direction="dest"
            dimension={dimension}
            depth={0}
            visitedLabels={rootVisited}
            dateRange={dateRange}
            path={flowPath("", "dest", flow.groupLabel)}
          />
        ))}
      </div>
      </div>
    </div>
    </ExpandedHopContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({
  sourceMode,
  dimension,
}: {
  sourceMode: "group" | "address";
  dimension: GroupingDimension;
}) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-4 text-center px-6 py-16 text-muted-foreground">
      <ChevronsLeftRight className="h-12 w-12 opacity-30" />
      {sourceMode === "address" ? (
        <div>
          <p className="font-medium text-foreground">Enter an address to begin</p>
          <p className="text-sm mt-1 max-w-sm">
            Paste a Bitcoin address to trace where its coins came from and
            where they went. Expand any source or destination hop-by-hop.
          </p>
        </div>
      ) : (
        <div>
          <p className="font-medium text-foreground">
            Select a {DIMENSION_LABELS[dimension]} to begin
          </p>
          <p className="text-sm mt-1 max-w-sm">
            Choose a grouping dimension and a specific{" "}
            {DIMENSION_LABELS[dimension].toLowerCase()} to see where its coins
            came from and where they went. Expand any line to trace further.
          </p>
        </div>
      )}
    </div>
  );
}

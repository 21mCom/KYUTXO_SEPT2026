import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useContext,
  createContext,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useSettings } from "@/hooks/use-settings";
import {
  ChevronDown,
  ChevronRight,
  ArrowLeft,
  ArrowRight,
  Loader2,
  Info,
  ChevronsLeftRight,
  X,
  Download,
  FileText,
  FileSpreadsheet,
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
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { useRecordPreview } from "@/contexts/RecordPreviewContext";
import {
  type GroupingDimension,
  type GroupFlow,
  type TrailHop,
  type DateRange,
  listGroupValues,
  getAddressesForGroup,
  computeOneHop,
  formatBtc,
  formatDate,
  deduplicateDetails,
  UNKNOWN_SOURCE_LABEL,
  UNKNOWN_DEST_LABEL,
} from "@/lib/data/fund-trail-engine";
import {
  buildFundTrailSnapshot,
  buildFundTrailCsv,
  buildFundTrailPdf,
  fundTrailFilename,
  triggerDownload,
  flowPath,
} from "@/lib/data/fund-trail-export";

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
}: {
  shownTxCount?: number;
  totalTxCount?: number;
}) {
  return (
    <div
      className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
      data-testid="fund-trail-cap-notice"
    >
      <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <span>
        Showing only the most recent{" "}
        {shownTxCount != null ? shownTxCount.toLocaleString() : ""} transactions
        {totalTxCount != null ? ` of ${totalTxCount.toLocaleString()}` : ""} to
        keep things fast. Narrow your selection to trace older activity.
      </span>
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
  const { openRecordPreview, openRecordPreviewByAddress } = useRecordPreview();

  return (
    <div className="flex flex-col gap-0.5 py-1 border-t border-border/40 first:border-t-0 text-xs">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() =>
            recordId != null
              ? openRecordPreview(recordId)
              : openRecordPreviewByAddress(address)
          }
          className="font-mono text-primary hover:underline truncate max-w-[220px] text-left"
          title={address}
          data-testid={`fund-trail-address-${address.slice(0, 12)}`}
        >
          {address.slice(0, 16)}…{address.slice(-8)}
        </button>
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
  const [showDetails, setShowDetails] = useState(false);
  const [isExpanding, setIsExpanding] = useState(false);
  const [expandedHop, setExpandedHop] = useState<TrailHop | null>(null);
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

  const handleExpand = useCallback(async () => {
    if (isExpanded) {
      setExpandedHop(null);
      return;
    }

    setIsExpanding(true);
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
    } finally {
      setIsExpanding(false);
    }
  }, [isExpanded, flow, dimension, unknownAddresses, branchVisited, dateRange, fundTrailTxLimit]);

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
        {direction === "source" ? (
          <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (
          <ArrowLeft className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
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
              ? `Where ${flow.groupLabel} received from:`
              : `Where ${flow.groupLabel} sent to:`}
          </p>

          {expandedHop.isCapped && (
            <div className="mb-2">
              <CapNotice
                shownTxCount={expandedHop.shownTxCount}
                totalTxCount={expandedHop.totalTxCount}
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
  const { fundTrailTxLimit } = useSettings();
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

  // --- Group value list ---
  const { data: groupValues = [], isLoading: isLoadingGroups } = useQuery({
    queryKey: ["fund-trail-groups", dimension],
    queryFn: () => listGroupValues(dimension),
  });

  // --- Center node hop ---
  const { data: centerHop, isLoading: isLoadingCenter } = useQuery<TrailHop>({
    queryKey: [
      "fund-trail-center",
      dimension,
      selectedGroup,
      dateRange?.start ?? null,
      dateRange?.end ?? null,
      fundTrailTxLimit,
    ],
    enabled: !!selectedGroup,
    queryFn: async () => {
      const records = await getAddressesForGroup(dimension, selectedGroup);
      const addresses = records
        .map(r => r.inputString)
        .filter((s): s is string => !!s);
      return computeOneHop(addresses, dimension, selectedGroup, dateRange, undefined, {
        txLimit: fundTrailTxLimit,
      });
    },
  });

  return (
    <div className="flex flex-col h-full overflow-auto">
      {/* Header */}
      <div className="border-b border-border px-6 py-4">
        <h1 className="text-xl font-semibold">Fund Trail</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Trace where coins came from and went, grouped by wallet, owner, or
          seed. Expand any source or destination hop-by-hop.
        </p>
      </div>

      {/* Controls */}
      <div className="px-6 py-4 flex flex-wrap items-end gap-4 border-b border-border">
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
      </div>

      {/* Body */}
      {!selectedGroup ? (
        <EmptyState dimension={dimension} />
      ) : isLoadingCenter ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-3 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin" />
          <p className="text-sm">Computing fund trail…</p>
        </div>
      ) : (
        <TrailLayout
          centerLabel={selectedGroup}
          dimension={dimension}
          centerHop={centerHop ?? { sources: [], destinations: [] }}
          dateRange={dateRange}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trail Layout — three-column view
// ---------------------------------------------------------------------------

function TrailLayout({
  centerLabel,
  dimension,
  centerHop,
  dateRange,
}: {
  centerLabel: string;
  dimension: GroupingDimension;
  centerHop: TrailHop;
  dateRange?: DateRange;
}) {
  const { toast } = useToast();
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
    async (format: "csv" | "pdf") => {
      setIsExporting(true);
      try {
        const snapshot = buildFundTrailSnapshot(
          centerLabel,
          dimension,
          centerHop,
          expandedHopsRef.current,
        );
        if (format === "csv") {
          const csv = buildFundTrailCsv(snapshot);
          triggerDownload(
            new Blob([csv], { type: "text/csv;charset=utf-8" }),
            fundTrailFilename(centerLabel, "csv"),
          );
        } else {
          const blob = await buildFundTrailPdf(snapshot);
          triggerDownload(blob, fundTrailFilename(centerLabel, "pdf"));
        }
        toast({
          title: "Export ready",
          description: `Fund Trail exported as ${format.toUpperCase()}.`,
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
    [centerLabel, dimension, centerHop, toast],
  );

  return (
    <ExpandedHopContext.Provider value={hopRegistry}>
    <div className="flex flex-col flex-1 min-h-0 overflow-auto">
      {centerHop.isCapped && (
        <div className="px-6 pt-4">
          <CapNotice
            shownTxCount={centerHop.shownTxCount}
            totalTxCount={centerHop.totalTxCount}
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
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

    <div className="flex flex-1 gap-4 px-6 pb-6 pt-2 min-h-0 overflow-auto">
      {/* Sources column */}
      <div className="flex flex-col gap-3 flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <ArrowRight className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Sources
          </span>
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
          <div className="text-xs text-muted-foreground mb-1 uppercase tracking-wide font-medium">
            {DIMENSION_LABELS[dimension]}
          </div>
          <div className="font-semibold text-sm break-words">{centerLabel}</div>
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
          <span className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Destinations
          </span>
          {hasDests && (
            <Badge variant="outline" className="text-xs ml-auto">
              {formatBtc(totalOut)} out
            </Badge>
          )}
          <ArrowLeft className="h-4 w-4 text-muted-foreground" />
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

function EmptyState({ dimension }: { dimension: GroupingDimension }) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-4 text-center px-6 py-16 text-muted-foreground">
      <ChevronsLeftRight className="h-12 w-12 opacity-30" />
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
    </div>
  );
}

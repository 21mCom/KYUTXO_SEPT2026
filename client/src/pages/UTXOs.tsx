import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useToast } from "@/hooks/use-toast";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { PAGE_DEBOUNCE } from "@/config/debounce";
import { useAsyncMemo, yieldToUI, checkAbort } from "@/hooks/use-async-memo";
import { useDbChangeSignal } from "@/hooks/use-db-change-signal";
import { useAddressRecords } from "@/hooks/use-address-records";
import { useLiveQuery } from "dexie-react-hooks";
import { format } from "date-fns";
import { Link } from "wouter";
import { BlockchainTransaction, TransactionParticipant, Record as DbRecord, USER_CURATED_TIERS } from "@/lib/database";
import { getAllAddressSyncState } from "@/lib/data/address-sync-crud";
import { getDustFlaggedOutpointSet } from "@/lib/data/dust-flags-crud";
import { getPriceDataByAsset } from "@/lib/data/price-data-crud";
import { transactionSyncService } from "@/lib/transaction-sync";
import { createProviderFromSettings } from "@/lib/blockchain-api";
import { getNodeSettings } from "@/lib/data/node-settings-crud";
import { countRecordsByTypeAndImportanceTiers, getTransactionsByTxids } from "@/lib/dataFacade";
import {
  engineGetOwnedUtxos,
  engineCountOwnedUtxos,
  engineGetHeuristicOwnedUtxos,
  engineCountHeuristicOwnedUtxos,
  engineGetOutpointCoverage,
} from "@/lib/engine/engine-client";
import { evaluateEngineFreshness } from "@/lib/engine/engine-freshness";
import type { OwnedUtxo } from "@/lib/engine/engine-core";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { BlockchainToggle } from "@/components/BlockchainToggle";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { 
  TransactionSearchFilters, 
  SearchFilters, 
  defaultFilters, 
  hasActiveSearchFilters,
  filterByDateAndAmount 
} from "@/components/TransactionSearchFilters";
import { 
  Search,
  CalendarIcon,
  Coins,
  RefreshCw,
  AlertCircle,
  X,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronRight,
  ChevronDown,
  ChevronRight as ChevronRightIcon,
  Copy,
  Check,
  TrendingUp,
  TrendingDown,
  HelpCircle,
  Loader2,
  FileSignature,
  ShieldCheck
} from "lucide-react";
import { SiBitcoin } from "react-icons/si";
import { getOwners, getWalletNames, getTags, getCategories, getParticipantsByAddresses, getSpendInputsByOutpoints } from "@/lib/dataFacade";
import { UNASSIGNED_OWNER_OPTION, UNASSIGNED_OWNER_VALUE } from "@/lib/owner-constants";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import { BuildPsbtDialog } from "@/components/BuildPsbtDialog";
import { SavedPsbtsDialog } from "@/components/SavedPsbtsDialog";
import {
  peekPendingNotarization,
  clearPendingNotarization,
  subscribePendingNotarization,
  type NotarizationIntent,
} from "@/lib/evidence-notarization";
import { UTXODetailPanel } from "@/components/UTXODetailPanel";
import { AddressLink } from "@/components/AddressLink";
import { TxidLink } from "@/components/TxidLink";
import { batchPreloadIdentifiers } from "@/lib/metadata-hover";
import { ScrollPositionIndicator } from "@/components/ScrollPositionIndicator";
import { searchPendingClass } from "@/lib/search-pending-class";

type UTXOCalculationMode = "heuristic" | "exact";

// Filters reset to these defaults on every navigation/reload — this page does
// not persist filter/sort/mode/hide-dust selections across sessions, matching
// the rest of the app's filtered list pages.
const DEFAULT_DISPLAY_UNIT: "btc" | "sats" = "btc";
const DEFAULT_SORT_COLUMN: SortColumn = "date";
const DEFAULT_SORT_DIRECTION: SortDirection = "desc";
const DEFAULT_UTXO_MODE: UTXOCalculationMode = "heuristic";

/** Sentinel option in the owner/wallet/tag/category multi-selects meaning "no value assigned". */
function satsToBtc(sats: number): string {
  return (sats / 100_000_000).toFixed(8);
}

function formatUsdValue(value: number | undefined): string {
  if (value === undefined) return "-";
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

export interface UTXO {
  id: string;
  txid: string;
  vout: number;
  address: string;
  amountSats: number;
  blockTime: number;
  blockHeight: number;
  recordId?: number;
  label?: string;
  owner?: string;
  walletName?: string;
  tags?: string[];
  categories?: string[];
  valueAtReceipt?: number;
  priceAtReceipt?: number;
}

export interface AddressGroup {
  address: string;
  totalSats: number;
  utxos: UTXO[];
  earliestDate: number;
  latestDate: number;
  recordId?: number;
  label?: string;
  owner?: string;
  walletName?: string;
  tags?: string[];
  categories?: string[];
  totalValueAtReceipt?: number;
  totalCurrentValue?: number;
  gain?: number;
  gainPercent?: number;
}

function narrowAddressGroup(
  group: AddressGroup,
  matchingUtxos: UTXO[],
  latestPrice: { price: number } | null,
): AddressGroup {
  const totalSats = matchingUtxos.reduce((sum, utxo) => sum + utxo.amountSats, 0);
  const receiptValues = matchingUtxos
    .map(utxo => utxo.valueAtReceipt)
    .filter((value): value is number => value !== undefined);
  const totalValueAtReceipt = receiptValues.length > 0
    ? receiptValues.reduce((sum, value) => sum + value, 0)
    : undefined;
  const totalCurrentValue = latestPrice
    ? (totalSats / 100_000_000) * latestPrice.price
    : undefined;
  const gain = totalCurrentValue !== undefined && totalValueAtReceipt !== undefined
    ? totalCurrentValue - totalValueAtReceipt
    : undefined;

  return {
    ...group,
    utxos: matchingUtxos,
    totalSats,
    earliestDate: Math.min(...matchingUtxos.map(utxo => utxo.blockTime)),
    latestDate: Math.max(...matchingUtxos.map(utxo => utxo.blockTime)),
    totalValueAtReceipt,
    totalCurrentValue,
    gain,
    gainPercent: gain !== undefined &&
      totalValueAtReceipt !== undefined &&
      totalValueAtReceipt > 0
      ? (gain / totalValueAtReceipt) * 100
      : undefined,
  };
}

type SortColumn = "amount" | "date" | "address" | "gain";
type SortDirection = "asc" | "desc";

export function CopyTxidButton({ txid }: { txid: string }) {
  const { copy, isCopied } = useCopyToClipboard();
  const copied = isCopied(txid);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    copy(txid, { label: "Transaction ID" });
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-6 w-6"
      onClick={handleCopy}
      data-testid={`button-copy-${txid.slice(0, 8)}`}
    >
      {copied ? (
        <Check className="h-3 w-3 text-green-500" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </Button>
  );
}

export type FlatUtxoRow =
  | { kind: 'group'; group: AddressGroup }
  | { kind: 'utxo'; utxo: UTXO; index: number };

// Presentational row renderer for the UTXOs table. Extracted as a pure-props
// component so the AddressLink / TxidLink metadata-indicator wiring can be
// regression-tested in isolation, without rendering the whole (engine-backed,
// virtualized) page. AddressLink/TxidLink only pass `recordId` (no
// `hasMetadata`), so the orange FileText indicator only appears once the hover
// tooltip resolves a metadata-rich record.
export function UtxoTableRow({
  row,
  isExpanded = false,
  displayUnit,
  onToggleGroup,
  onOpenUtxo,
  measureRef,
  dataIndex,
  dustFlaggedOutpoints,
  selectedOutpoints,
  onToggleUtxoSelected,
  onToggleGroupSelected,
}: {
  row: FlatUtxoRow;
  isExpanded?: boolean;
  displayUnit: "btc" | "sats";
  onToggleGroup: (address: string) => void;
  onOpenUtxo: (utxo: UTXO) => void;
  measureRef?: (el: HTMLElement | null) => void;
  dataIndex?: number;
  /** Set of "txid:vout" outpoints the user flagged as dust. */
  dustFlaggedOutpoints?: Set<string>;
  /** Set of "txid:vout" outpoints currently selected for the PSBT builder. */
  selectedOutpoints?: Set<string>;
  onToggleUtxoSelected?: (utxo: UTXO) => void;
  onToggleGroupSelected?: (group: AddressGroup) => void;
}) {
  const selectionEnabled = !!selectedOutpoints && !!onToggleUtxoSelected && !!onToggleGroupSelected;
  if (row.kind === 'group') {
    const group = row.group;
    const dustCount = dustFlaggedOutpoints
      ? group.utxos.filter(u => dustFlaggedOutpoints.has(`${u.txid}:${u.vout}`)).length
      : 0;
    const allSelected = group.utxos.length > 0 && group.utxos.every(u => selectedOutpoints?.has(`${u.txid}:${u.vout}`));
    return (
      <TableRow
        ref={measureRef}
        data-index={dataIndex}
        className="cursor-pointer hover-elevate"
        onClick={() => onToggleGroup(group.address)}
        data-testid={`row-address-${group.address.slice(0, 8)}`}
      >
        {selectionEnabled && (
          <TableCell className="w-8" onClick={(e) => e.stopPropagation()}>
            <Checkbox
              checked={allSelected}
              onCheckedChange={() => onToggleGroupSelected(group)}
              aria-label={`Select all UTXOs for ${group.address}`}
              data-testid={`checkbox-group-${group.address.slice(0, 8)}`}
            />
          </TableCell>
        )}
        <TableCell className="w-8">
          {isExpanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRightIcon className="h-4 w-4" />
          )}
        </TableCell>
        <TableCell onClick={(e) => e.stopPropagation()}>
          <div className="flex flex-col gap-1">
            <AddressLink
              address={group.address}
              recordId={group.recordId}
            />
            {group.label && (
              <span className="text-xs text-muted-foreground">{group.label}</span>
            )}
            <div className="flex flex-wrap gap-1">
              {group.utxos.length > 1 && (
                <Badge variant="secondary" className="w-fit text-xs">
                  {group.utxos.length} UTXOs
                </Badge>
              )}
              {dustCount > 0 && (
                <Badge
                  variant="outline"
                  className="w-fit text-xs text-orange-600 dark:text-orange-400"
                  data-testid={`badge-dust-group-${group.address.slice(0, 8)}`}
                >
                  {dustCount} dust
                </Badge>
              )}
            </div>
          </div>
        </TableCell>
        <TableCell className="font-mono">
          {displayUnit === "btc" ? (
            <span>{satsToBtc(group.totalSats)} BTC</span>
          ) : (
            <span>{group.totalSats.toLocaleString()} sats</span>
          )}
        </TableCell>
        <TableCell className="text-sm">
          <div className="flex flex-col">
            <span>{format(new Date(group.latestDate * 1000), "MMM d, yyyy")}</span>
            {group.earliestDate !== group.latestDate && (
              <span className="text-xs text-muted-foreground">
                From {format(new Date(group.earliestDate * 1000), "MMM d, yyyy")}
              </span>
            )}
          </div>
        </TableCell>
        <TableCell>
          {formatUsdValue(group.totalValueAtReceipt)}
        </TableCell>
        <TableCell>
          {formatUsdValue(group.totalCurrentValue)}
        </TableCell>
        <TableCell>
          {group.gain !== undefined ? (
            <div className={cn(
              "flex items-center gap-1",
              group.gain > 0 ? "text-green-600 dark:text-green-400" : group.gain < 0 ? "text-red-600 dark:text-red-400" : ""
            )}>
              {group.gain > 0 ? <TrendingUp className="h-3 w-3" /> : group.gain < 0 ? <TrendingDown className="h-3 w-3" /> : null}
              <span>{formatUsdValue(group.gain)}</span>
              {group.gainPercent !== undefined && (
                <span className="text-xs">({group.gainPercent > 0 ? '+' : ''}{group.gainPercent.toFixed(1)}%)</span>
              )}
            </div>
          ) : (
            <span className="text-muted-foreground">-</span>
          )}
        </TableCell>
      </TableRow>
    );
  }

  const { utxo, index: idx } = row;
  const isSelected = selectedOutpoints?.has(`${utxo.txid}:${utxo.vout}`) ?? false;
  return (
    <TableRow
      ref={measureRef}
      data-index={dataIndex}
      className="bg-muted/30 cursor-pointer hover-elevate"
      onClick={() => onOpenUtxo(utxo)}
      data-testid={`row-utxo-${utxo.id}`}
    >
      {selectionEnabled && (
        <TableCell className="w-8" onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => onToggleUtxoSelected(utxo)}
            aria-label={`Select UTXO ${utxo.txid}:${utxo.vout}`}
            data-testid={`checkbox-utxo-${utxo.id}`}
          />
        </TableCell>
      )}
      <TableCell></TableCell>
      <TableCell colSpan={2} className="font-mono text-sm" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 pl-4">
          <span className="text-muted-foreground text-xs">{idx + 1}.</span>
          <TxidLink
            txid={utxo.txid}
            showExternalLink={true}
          />
          <span className="text-muted-foreground text-xs">:{utxo.vout}</span>
          <span className="ml-2">
            {displayUnit === "btc" ? (
              <span>{satsToBtc(utxo.amountSats)} BTC</span>
            ) : (
              <span>{utxo.amountSats.toLocaleString()} sats</span>
            )}
          </span>
          {dustFlaggedOutpoints?.has(`${utxo.txid}:${utxo.vout}`) && (
            <Badge
              variant="outline"
              className="text-xs text-orange-600 dark:text-orange-400"
              data-testid={`badge-dust-${utxo.id}`}
            >
              Dust
            </Badge>
          )}
          <Link
            href={`/coin-origins?outpoint=${encodeURIComponent(`${utxo.txid}:${utxo.vout}`)}`}
            onClick={(event) => event.stopPropagation()}
          >
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              data-testid={`button-passport-${utxo.id}`}
            >
              <ShieldCheck className="mr-1 h-3 w-3" />
              Passport
            </Button>
          </Link>
        </div>
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {format(new Date(utxo.blockTime * 1000), "MMM d, yyyy")}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {formatUsdValue(utxo.valueAtReceipt)}
      </TableCell>
      <TableCell></TableCell>
      <TableCell></TableCell>
    </TableRow>
  );
}

// Virtualized UTXO list. Extracted as a pure-props component (like
// VirtualizedTransactionList) so the virtual-scroll note-icon preload wiring can
// be regression-tested in isolation, without rendering the whole engine-backed,
// Dexie-driven page. As the visible window moves it preloads hover metadata for
// the newly-visible rows (group addresses + utxo txids from the flattened row
// model) via batchPreloadIdentifiers, so note icons appear without a hover.
//
// The list does NOT own a scroll container: the entire page scrolls as one
// (scrollRef points at the page-level scroll element). The virtualizer is fed
// scrollMargin = the list's offset from the top of that scroll element so the
// visible-row window stays correct below the header/summary/filter sections.
export function VirtualizedUtxoList({
  flattenedRows,
  expandedAddresses,
  displayUnit,
  onToggleGroup,
  onOpenUtxo,
  scrollRef,
  header,
  dustFlaggedOutpoints,
  selectedOutpoints,
  onToggleUtxoSelected,
  onToggleGroupSelected,
}: {
  flattenedRows: FlatUtxoRow[];
  expandedAddresses: Set<string>;
  displayUnit: "btc" | "sats";
  onToggleGroup: (address: string) => void;
  onOpenUtxo: (utxo: UTXO) => void;
  scrollRef: React.RefObject<HTMLDivElement>;
  header: React.ReactNode;
  dustFlaggedOutpoints?: Set<string>;
  /** Set of "txid:vout" outpoints currently selected for the PSBT builder. */
  selectedOutpoints?: Set<string>;
  onToggleUtxoSelected?: (utxo: UTXO) => void;
  onToggleGroupSelected?: (group: AddressGroup) => void;
}) {
  // Extra selection column shifts the spacer colSpans from 7 to 8.
  const colSpan = selectedOutpoints ? 8 : 7;
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

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
  }, [scrollRef]);

  // Content above the list (status cards, filter badges) mounts/unmounts with
  // renders of this page, so re-measure after every commit...
  useEffect(measureScrollMargin);

  // ...and on container resizes (window/sidebar changes), which don't
  // necessarily re-render this component.
  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measureScrollMargin);
    ro.observe(scrollEl);
    return () => ro.disconnect();
  }, [scrollRef, measureScrollMargin]);

  const utxoVirtualizer = useVirtualizer({
    count: flattenedRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => flattenedRows[index]?.kind === 'utxo' ? 44 : 72,
    overscan: 20,
    measureElement: (el) => el.getBoundingClientRect().height,
    scrollMargin,
  });

  const utxoVirtualItems = utxoVirtualizer.getVirtualItems();
  const utxoVisibleRangeKey = utxoVirtualItems.length > 0
    ? `${utxoVirtualItems[0].index}-${utxoVirtualItems[utxoVirtualItems.length - 1].index}`
    : '';

  useEffect(() => {
    if (!utxoVisibleRangeKey || flattenedRows.length === 0) return;
    const [startStr, endStr] = utxoVisibleRangeKey.split('-');
    const start = parseInt(startStr);
    const end = parseInt(endStr);
    const ids: string[] = [];
    for (let i = start; i <= end; i++) {
      const row = flattenedRows[i];
      if (!row) continue;
      if (row.kind === 'group') ids.push(row.group.address);
      else if (row.kind === 'utxo') ids.push(row.utxo.txid);
    }
    if (ids.length > 0) batchPreloadIdentifiers(ids);
  }, [utxoVisibleRangeKey, flattenedRows]);

  return (
    <div ref={listRef}>
      <Table>
        <TableHeader className="sticky top-0 bg-card z-10">
          {header}
        </TableHeader>
        <TableBody>
          {utxoVirtualizer.getVirtualItems().length > 0 && utxoVirtualizer.getVirtualItems()[0].start > scrollMargin && (
            <TableRow>
              <TableCell colSpan={colSpan} className="p-0 border-0" style={{ height: utxoVirtualizer.getVirtualItems()[0].start - scrollMargin }} />
            </TableRow>
          )}
          {utxoVirtualizer.getVirtualItems().map(virtualRow => {
            const row = flattenedRows[virtualRow.index];
            const key = row.kind === 'group'
              ? `group-${row.group.address}`
              : `utxo-${row.utxo.id}`;
            return (
              <UtxoTableRow
                key={key}
                row={row}
                isExpanded={row.kind === 'group' && expandedAddresses.has(row.group.address)}
                displayUnit={displayUnit}
                onToggleGroup={onToggleGroup}
                onOpenUtxo={onOpenUtxo}
                measureRef={utxoVirtualizer.measureElement}
                dataIndex={virtualRow.index}
                dustFlaggedOutpoints={dustFlaggedOutpoints}
                selectedOutpoints={selectedOutpoints}
                onToggleUtxoSelected={onToggleUtxoSelected}
                onToggleGroupSelected={onToggleGroupSelected}
              />
            );
          })}
          {utxoVirtualizer.getVirtualItems().length > 0 && (() => {
            const lastItem = utxoVirtualizer.getVirtualItems().at(-1)!;
            // Virtual item offsets include scrollMargin; getTotalSize() does not.
            const remaining = utxoVirtualizer.getTotalSize() - (lastItem.end - scrollMargin);
            return remaining > 0 ? (
              <TableRow>
                <TableCell colSpan={colSpan} className="p-0 border-0" style={{ height: remaining }} />
              </TableRow>
            ) : null;
          })()}
        </TableBody>
      </Table>
      <ScrollPositionIndicator
        virtualItems={utxoVirtualizer.getVirtualItems()}
        totalCount={flattenedRows.length}
        scrollElement={scrollRef.current}
        label="rows"
        variant="table"
      />
    </div>
  );
}

export default function UTXOs() {
  const { toast } = useToast();

  const [search, setSearch] = useState("");
  const [debouncedSearch, isSearchPending] = useDebouncedValue(search, PAGE_DEBOUNCE.UTXOs);
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined);
  const [searchFilters, setSearchFilters] = useState<SearchFilters>(defaultFilters);
  const [ownerFilter, setOwnerFilter] = useState<string[]>([]);
  const [walletFilter, setWalletFilter] = useState<string[]>([]);
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);
  const [sortColumn, setSortColumn] = useState<SortColumn>(DEFAULT_SORT_COLUMN);
  const [sortDirection, setSortDirection] = useState<SortDirection>(DEFAULT_SORT_DIRECTION);
  const [utxoMode, setUtxoMode] = useState<UTXOCalculationMode>(DEFAULT_UTXO_MODE);
  const [displayUnit, setDisplayUnit] = useState<"btc" | "sats">(DEFAULT_DISPLAY_UNIT);
  const [expandedAddresses, setExpandedAddresses] = useState<Set<string>>(new Set());
  const [selectedUtxo, setSelectedUtxo] = useState<UTXO | null>(null);
  const [detailPanelOpen, setDetailPanelOpen] = useState(false);
  // PSBT builder selection: outpoint ("txid:vout") -> UTXO snapshot, so the
  // build dialog works off stable data even if the list re-renders.
  const [selectedUtxosForPsbt, setSelectedUtxosForPsbt] = useState<Map<string, UTXO>>(new Map());
  const [buildPsbtOpen, setBuildPsbtOpen] = useState(false);
  const [savedPsbtsOpen, setSavedPsbtsOpen] = useState(false);
  // Pending evidence notarization handed off from the Evidence page (the
  // file's SHA-256 digest is embedded as an OP_RETURN output in the PSBT).
  const [notarization, setNotarization] = useState<NotarizationIntent | null>(() =>
    peekPendingNotarization(),
  );
  // Pick up an intent set while this page is already mounted (e.g. the app is
  // open in this tab and the Evidence page hands off without a route remount).
  useEffect(() => {
    const sync = () => setNotarization(peekPendingNotarization());
    sync();
    return subscribePendingNotarization(sync);
  }, []);
  const dismissNotarization = useCallback(() => {
    // Clear only the intent currently shown; the subscription keeps state in
    // sync, so a newer handoff (different nonce) is never wiped by accident.
    if (notarization) clearPendingNotarization(notarization.nonce);
    setNotarization(null);
  }, [notarization]);
  
  // Smart filtering: exclude blockchain-discovered addresses by default
  const [includeBlockchainDiscovered, setIncludeBlockchainDiscovered] = useState(false);

  // Hide user-flagged dust UTXOs from the list and totals when enabled.
  const [hideDust, setHideDust] = useState(false);

  const txDbSignal = useDbChangeSignal(['blockchainTransactions', 'transactionParticipants']);

  const [transactions, setTransactions] = useState<BlockchainTransaction[] | undefined>(undefined);
  const transactionsRequestId = useRef(0);

  const [participants, setParticipants] = useState<TransactionParticipant[] | undefined>(undefined);
  const [participantsLoading, setParticipantsLoading] = useState(false);
  const participantsRequestId = useRef(0);

  // Native SQLite read-engine integration (mirrors the Records screen). When the
  // engine is READY and its mirror is fresh, the owned-UTXO set is read straight
  // from SQLite instead of computing it in-browser from every participant. The
  // engine only computes the EXACT prevout anti-join for user-curated tiers, so
  // the fast path is limited to exact mode with the blockchain-discovered toggle
  // off and no historical "as of" date cutoff; anything else falls back to Dexie.
  type EngineDecision = 'pending' | 'engine' | 'dexie';
  const [engineDecision, setEngineDecision] = useState<EngineDecision>('pending');
  const [engineRawUtxos, setEngineRawUtxos] = useState<
    (OwnedUtxo & { blockTime: number; blockHeight: number })[] | null
  >(null);
  const [engineUtxosLoading, setEngineUtxosLoading] = useState(false);
  const engineLoadRequestId = useRef(0);
  // Re-evaluate engine freshness whenever the mirrored source tables change.
  const recordsDbSignal = useDbChangeSignal(['records']);

  const { records: rawRecords } = useAddressRecords({ includeBlockchainDiscovered });
  
  // Count blockchain-discovered records using compound index
  const blockchainDiscoveredCount = useLiveQuery(
    async () => {
      return countRecordsByTypeAndImportanceTiers('address', ['blockchain-discovered', 'pending-review']);
    },
    []
  );

  const addressSyncState = useLiveQuery(
    () => getAllAddressSyncState(),
    []
  );

  // Load price data for value calculations
  const priceData = useLiveQuery(
    () => getPriceDataByAsset('BTC', 'USD'),
    []
  );

  // User-flagged dust outpoints ("txid:vout") so rows can show a Dust badge.
  const dustFlaggedOutpoints = useLiveQuery(
    () => getDustFlaggedOutpointSet(),
    []
  );

  // Load vocabulary items for filter dropdowns
  const [owners, setOwners] = useState<string[]>([]);
  const [walletNames, setWalletNames] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [vocabLoaded, setVocabLoaded] = useState(false);

  useEffect(() => {
    const loadVocabulary = async () => {
      try {
        const [allOwners, allWalletNames, allTags, allCategories] = await Promise.all([
          getOwners(),
          getWalletNames(),
          getTags(),
          getCategories()
        ]);
        setOwners(allOwners.map(o => o.name).filter(Boolean).sort());
        setWalletNames(allWalletNames.map(w => w.name).filter(Boolean).sort());
        setTags(allTags.map(t => t.name).filter(Boolean).sort());
        setCategories(allCategories.map(c => c.name).filter(Boolean).sort());
        setVocabLoaded(true);
      } catch (error) {
        console.error('Failed to load vocabulary:', error);
      }
    };
    loadVocabulary();
  }, []);

  const processedRecords = rawRecords ?? [];

  useEffect(() => {
    // While the engine decision is still resolving, hold off on the expensive
    // Dexie participant load so we never do it just to throw it away.
    if (engineDecision === 'pending') {
      return;
    }

    // Engine fast path: the owned-UTXO set comes from SQLite, so there is no
    // need to stream every participant into the browser. Clear the Dexie-derived
    // state so the in-browser computations short-circuit to empty.
    if (engineDecision === 'engine') {
      participantsRequestId.current += 1;
      setParticipants([]);
      setParticipantsLoading(false);
      return;
    }

    if (!processedRecords || processedRecords.length === 0) {
      setParticipants(undefined);
      return;
    }

    const addresses = processedRecords
      .filter(r => r.type === 'address' && r.inputString)
      .map(r => r.inputString!);

    if (addresses.length === 0) {
      setParticipants([]);
      return;
    }

    participantsRequestId.current += 1;
    const thisRequestId = participantsRequestId.current;
    const abortController = new AbortController();
    setParticipantsLoading(true);

    // Address-keyed load misses spend inputs that carry no prevout address
    // (Electrum-synced inputs are stored with a blank address). Follow up with
    // an outpoint-keyed load for inputs spending the owned outputs we just
    // fetched, so spent detection sees those spends too.
    const loadWithSpendInputs = async () => {
      const byAddress = await getParticipantsByAddresses(addresses, abortController.signal);
      const seenIds = new Set<number>();
      const ownedOutpoints: Array<[string, number]> = [];
      for (const p of byAddress) {
        if (p.id !== undefined) seenIds.add(p.id);
        if (p.role === 'output' && p.vout !== undefined && p.vout !== null) {
          ownedOutpoints.push([p.txid, p.vout]);
        }
      }
      const spendInputs = await getSpendInputsByOutpoints(ownedOutpoints, abortController.signal);
      const merged = byAddress.slice();
      for (const p of spendInputs) {
        if (p.id === undefined || !seenIds.has(p.id)) merged.push(p);
      }
      return merged;
    };

    loadWithSpendInputs()
      .then(result => {
        if (thisRequestId === participantsRequestId.current) {
          setParticipants(result);
          setParticipantsLoading(false);
        }
      })
      .catch((e) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        if (thisRequestId === participantsRequestId.current) {
          setParticipants([]);
          setParticipantsLoading(false);
        }
      });
    return () => { abortController.abort(); };
  }, [processedRecords, engineDecision]);

  useEffect(() => {
    if (!participants || participants.length === 0) {
      setTransactions(participants === undefined ? undefined : []);
      return;
    }

    const txids = new Set<string>();
    for (const p of participants) txids.add(p.txid);

    if (txids.size === 0) {
      setTransactions([]);
      return;
    }

    transactionsRequestId.current += 1;
    const thisRequestId = transactionsRequestId.current;

    const txidArray = Array.from(txids);
    const batchSize = 500;
    const loadBatched = async () => {
      const results: BlockchainTransaction[] = [];
      for (let i = 0; i < txidArray.length; i += batchSize) {
        const batch = txidArray.slice(i, i + batchSize);
        const txs = await getTransactionsByTxids(batch);
        results.push(...txs);
        if (i + batchSize < txidArray.length) {
          await new Promise(r => setTimeout(r, 0));
        }
      }
      return results;
    };

    loadBatched()
      .then(result => {
        if (thisRequestId === transactionsRequestId.current) {
          setTransactions(result);
        }
      })
      .catch(() => {
        if (thisRequestId === transactionsRequestId.current) {
          setTransactions([]);
        }
      });
  }, [participants, txDbSignal]);

  const addressToRecord = useMemo(() => {
    const map = new Map<string, DbRecord>();
    processedRecords.forEach(record => {
      if (record.type === 'address' && record.inputString) {
        map.set(record.inputString, record);
      }
    });
    return map;
  }, [processedRecords]);

  // Build set of user-curated addresses (for filtering UTXOs)
  const userCuratedAddresses = useMemo(() => {
    const set = new Set<string>();
    processedRecords.forEach(record => {
      if (record.type === 'address' && record.inputString) {
        const importance = record.addressImportance;
        // Include if no importance set (legacy) or if user-curated tier
        if (!importance || USER_CURATED_TIERS.includes(importance)) {
          set.add(record.inputString);
        }
      }
    });
    return set;
  }, [processedRecords]);

  // Count blockchain-discovered addresses that have UTXOs
  const blockchainDiscoveredWithUtxos = useMemo(() => {
    const set = new Set<string>();
    processedRecords.forEach(record => {
      if (record.type === 'address' && record.inputString) {
        const importance = record.addressImportance;
        // Only count blockchain-discovered and pending-review tiers
        if (importance && !USER_CURATED_TIERS.includes(importance)) {
          set.add(record.inputString);
        }
      }
    });
    return set;
  }, [processedRecords]);

  const txidToTx = useMemo(() => {
    const map = new Map<string, BlockchainTransaction>();
    transactions?.forEach(tx => {
      map.set(tx.txid, tx);
    });
    return map;
  }, [transactions]);

  // Create price lookup map by date
  const priceByDate = useMemo(() => {
    const map = new Map<string, number>();
    priceData?.forEach(p => {
      map.set(p.date, p.close);
    });
    return map;
  }, [priceData]);

  // Get latest price date and value
  const latestPrice = useMemo(() => {
    if (!priceData || priceData.length === 0) return null;
    const sorted = [...priceData].sort((a, b) => b.date.localeCompare(a.date));
    return { date: sorted[0].date, price: sorted[0].close };
  }, [priceData]);

  const lastSyncTime = useMemo(() => {
    if (!addressSyncState || addressSyncState.length === 0) return null;
    return Math.max(...addressSyncState.map(s => s.lastSyncedAt));
  }, [addressSyncState]);

  // Get price for a specific timestamp
  const getPriceForTimestamp = useCallback((timestamp: number): number | undefined => {
    const date = format(new Date(timestamp * 1000), 'yyyy-MM-dd');
    return priceByDate.get(date);
  }, [priceByDate]);

  // The engine serves the owned-UTXO set straight from SQLite for BOTH modes:
  // exact (prevout anti-join) and heuristic (no-prevout amount-matching). Each
  // mode covers all three views — the default user-curated set (fast path off a
  // materialized table), the "include blockchain-discovered" view (the tier set
  // is widened), and an "as of" date view (a block-time cutoff). The mode picks
  // which engine query to run; anything that fails the freshness gate falls back
  // to the in-browser Dexie computation for that mode.
  const engineEligible = utxoMode === 'exact' || utxoMode === 'heuristic';

  // When the blockchain-discovered toggle is on, widen the owned-tier set so the
  // engine includes those addresses; otherwise pass undefined to use the default
  // user-curated tiers (which can hit the materialized fast path).
  const engineTiers = useMemo<string[] | undefined>(
    () =>
      includeBlockchainDiscovered
        ? [...USER_CURATED_TIERS, 'blockchain-discovered', 'pending-review']
        : undefined,
    [includeBlockchainDiscovered],
  );

  // Historical "as of" cutoff in unix seconds. Matches the in-browser exact
  // computation: end-of-selected-day (start-of-day + 86400) so the chosen date
  // is inclusive. Undefined means "current" (no cutoff).
  const engineAsOfBlockTime = useMemo<number | undefined>(
    () =>
      selectedDate
        ? Math.floor(selectedDate.getTime() / 1000) + 86400
        : undefined,
    [selectedDate],
  );

  // Decide whether to read from the engine. The owned-UTXO read depends on all
  // three mirror tables (records for ownership, blockchainTransactions for the
  // blockTime JOIN, and transactionParticipants for the spend anti-join), so the
  // shared gate is asked for the 'allMirrors' scope — checking only records would
  // serve stale UTXOs whenever a sync or prevout backfill changes the tx/
  // participant tables without touching records. Any mismatch or error falls back
  // to the in-browser Dexie computation.
  useEffect(() => {
    let cancelled = false;
    if (!engineEligible) {
      setEngineDecision('dexie');
      return;
    }
    setEngineDecision('pending');
    (async () => {
      const decision = await evaluateEngineFreshness('allMirrors');
      if (cancelled) return;
      setEngineDecision(decision.useEngine ? 'engine' : 'dexie');
    })();
    return () => {
      cancelled = true;
    };
  }, [engineEligible, recordsDbSignal, txDbSignal]);

  // Load the owned-UTXO set from the engine when the fast path is active. Owned
  // UTXOs are paged by integer primary key (keyset), then enriched with the block
  // time/height of their txid so the rest of the page (dates, value-at-receipt)
  // works exactly as it does for the Dexie path. Record metadata and price are
  // layered on in a cheap memo below so they never trigger a re-fetch.
  useEffect(() => {
    if (engineDecision !== 'engine') {
      setEngineRawUtxos(null);
      setEngineUtxosLoading(false);
      return;
    }
    engineLoadRequestId.current += 1;
    const requestId = engineLoadRequestId.current;
    let cancelled = false;
    setEngineUtxosLoading(true);
    // Pick the engine query for the active mode. The heuristic estimates the
    // unspent set by FIFO amount-matching (no prevouts); exact uses the prevout
    // anti-join. Both share the same tier/as-of/keyset contract.
    const countFn =
      utxoMode === 'heuristic' ? engineCountHeuristicOwnedUtxos : engineCountOwnedUtxos;
    const getFn =
      utxoMode === 'heuristic' ? engineGetHeuristicOwnedUtxos : engineGetOwnedUtxos;
    (async () => {
      try {
        const total = await countFn({
          tiers: engineTiers,
          asOfBlockTime: engineAsOfBlockTime,
        });
        if (cancelled || requestId !== engineLoadRequestId.current) return;
        if (total === 0) {
          setEngineRawUtxos([]);
          setEngineUtxosLoading(false);
          return;
        }

        const owned: OwnedUtxo[] = [];
        const PAGE = 10000;
        let afterId: number | undefined = undefined;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const batch = await getFn({
            tiers: engineTiers,
            asOfBlockTime: engineAsOfBlockTime,
            afterId,
            limit: PAGE,
          });
          if (cancelled || requestId !== engineLoadRequestId.current) return;
          owned.push(...batch);
          if (batch.length < PAGE) break;
          afterId = batch[batch.length - 1].id;
          await yieldToUI();
        }

        // Resolve block time/height for every txid in the owned set.
        const txids = Array.from(new Set(owned.map((u) => u.txid)));
        const txMap = new Map<string, BlockchainTransaction>();
        const BATCH = 500;
        for (let i = 0; i < txids.length; i += BATCH) {
          const slice = txids.slice(i, i + BATCH);
          const txs = await getTransactionsByTxids(slice);
          if (cancelled || requestId !== engineLoadRequestId.current) return;
          for (const tx of txs) txMap.set(tx.txid, tx);
          if (i + BATCH < txids.length) await yieldToUI();
        }

        // Match the Dexie exact path exactly: outputs whose tx has no confirmed
        // block time (blockTime <= 0) are excluded there, so drop them here too.
        // The engine's own anti-join already filters blockTime > 0 (and, for an
        // "as of" read, <= cutoff) against the mirror, but block time is re-read
        // from live Dexie above, so we re-apply the same bounds on that
        // authoritative value to stay self-consistent with the date view.
        const cutoff = engineAsOfBlockTime;
        const enriched = owned
          .map((u) => {
            const tx = txMap.get(u.txid);
            return {
              ...u,
              blockTime: tx?.blockTime ?? 0,
              blockHeight: tx?.blockHeight ?? 0,
            };
          })
          .filter((u) => u.blockTime > 0 && (cutoff == null || u.blockTime <= cutoff));
        if (cancelled || requestId !== engineLoadRequestId.current) return;
        setEngineRawUtxos(enriched);
        setEngineUtxosLoading(false);
      } catch {
        if (cancelled || requestId !== engineLoadRequestId.current) return;
        // On any engine failure, drop back to the Dexie computation.
        setEngineRawUtxos(null);
        setEngineUtxosLoading(false);
        setEngineDecision('dexie');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [engineDecision, txDbSignal, engineTiers, engineAsOfBlockTime, utxoMode]);

  // Enrich the engine's owned UTXOs with record metadata and price-at-receipt.
  // Kept separate from the fetch so changing price data or record labels does not
  // re-run the engine query — only this cheap map re-runs.
  const engineUtxos = useMemo<UTXO[] | null>(() => {
    if (engineRawUtxos === null) return null;
    return engineRawUtxos.map((u) => {
      const record = addressToRecord.get(u.address);
      const priceAtReceipt = getPriceForTimestamp(u.blockTime);
      const btcAmount = u.amount / 100_000_000;
      const valueAtReceipt =
        priceAtReceipt !== undefined ? btcAmount * priceAtReceipt : undefined;
      return {
        id: `${u.txid}:${u.vout ?? 0}`,
        txid: u.txid,
        vout: u.vout ?? 0,
        address: u.address,
        amountSats: u.amount,
        blockTime: u.blockTime,
        blockHeight: u.blockHeight,
        recordId: record?.id ?? u.recordId ?? undefined,
        label: record?.label,
        owner: record?.owner,
        walletName: record?.walletName,
        tags: record?.tags,
        categories: record?.categories,
        valueAtReceipt,
        priceAtReceipt,
      };
    });
  }, [engineRawUtxos, addressToRecord, getPriceForTimestamp]);

  // Outpoint coverage on the engine fast path. The engine path clears
  // `participants` to [], so the Dexie computation below would report total = 0
  // and the Standard-mode accuracy warning (plus its one-click "Re-sync affected
  // addresses" action) would never render even when legacy outpoint-less input
  // rows exist. Ask the engine for the same coverage stats instead. On failure,
  // null keeps the default zero status (same as today's behavior) rather than
  // falsely claiming full coverage.
  const { value: engineOutpointStatus, isComputing: engineOutpointStatusComputing } = useAsyncMemo(async () => {
    if (engineDecision !== 'engine') return null;
    try {
      const coverage = await engineGetOutpointCoverage({ tiers: engineTiers });
      if (coverage.total === 0) {
        return { hasData: true, percentage: 100, total: 0, withData: 0, affectedAddresses: [] as string[] };
      }
      const percentage = Math.round((coverage.withData / coverage.total) * 100);
      return {
        hasData: percentage > 0,
        percentage,
        total: coverage.total,
        withData: coverage.withData,
        affectedAddresses: coverage.affectedAddresses,
      };
    } catch {
      return null;
    }
  }, [engineDecision, engineTiers, txDbSignal], null);

  const { value: dexieOutpointDataStatus, isComputing: dexieOutpointDataStatusComputing } = useAsyncMemo(async (signal) => {
    if (!participants) return { hasData: false, percentage: 0, total: 0, withData: 0, affectedAddresses: [] as string[] };
    let inputCount = 0;
    let withDataCount = 0;
    // Owned addresses whose transactions contain outpoint-less input rows.
    // These are the addresses a targeted re-sync must refresh to backfill
    // prevTxid/prevVout. When a legacy input row carries an owned address we
    // take it directly; when it carries a blank/foreign address (some legacy
    // rows do), we fall back to every owned address participating in that tx.
    const affected = new Set<string>();
    const txidsNeedingOwners = new Set<string>();
    for (let i = 0; i < participants.length; i++) {
      const p = participants[i];
      if (p.role === 'input') {
        inputCount++;
        if (p.prevTxid !== undefined && p.prevTxid !== null) {
          withDataCount++;
        } else if (p.address && addressToRecord.has(p.address)) {
          affected.add(p.address);
        } else {
          txidsNeedingOwners.add(p.txid);
        }
      }
      if (i % 1000 === 999) {
        checkAbort(signal);
        await yieldToUI();
      }
    }
    if (txidsNeedingOwners.size > 0) {
      for (let i = 0; i < participants.length; i++) {
        const p = participants[i];
        if (txidsNeedingOwners.has(p.txid) && p.address && addressToRecord.has(p.address)) {
          affected.add(p.address);
        }
        if (i % 1000 === 999) {
          checkAbort(signal);
          await yieldToUI();
        }
      }
    }
    const affectedAddresses = Array.from(affected).sort();
    if (inputCount === 0) return { hasData: true, percentage: 100, total: 0, withData: 0, affectedAddresses: [] as string[] };
    const percentage = Math.round((withDataCount / inputCount) * 100);
    return {
      hasData: percentage > 0,
      percentage,
      total: inputCount,
      withData: withDataCount,
      affectedAddresses
    };
  }, [participants, addressToRecord], { hasData: false, percentage: 0, total: 0, withData: 0, affectedAddresses: [] as string[] });

  // The engine path reports coverage via its own SQL query; the Dexie path via
  // the participant scan above.
  const outpointDataStatus =
    engineDecision === 'engine'
      ? (engineOutpointStatus ?? { hasData: false, percentage: 0, total: 0, withData: 0, affectedAddresses: [] as string[] })
      : dexieOutpointDataStatus;
  const outpointDataStatusComputing =
    engineDecision === 'engine' ? engineOutpointStatusComputing : dexieOutpointDataStatusComputing;

  // For backward compatibility
  const hasOutpointData = outpointDataStatus.hasData && outpointDataStatus.percentage >= 50;

  // Targeted re-sync of just the addresses whose transactions still carry
  // outpoint-less input rows (legacy pre-migration data). Same provider checks
  // and per-address loop as the Balance page's heuristic re-sync, scoped to the
  // affected list computed alongside the coverage warning above.
  const [resyncingAffected, setResyncingAffected] = useState(false);
  const [cancellingResyncAffected, setCancellingResyncAffected] = useState(false);
  const [affectedResyncProgress, setAffectedResyncProgress] = useState<{ processed: number; total: number } | null>(null);
  const [affectedResyncAddressProgress, setAffectedResyncAddressProgress] = useState<{
    address: string;
    fetched: number;
    total: number;
  } | null>(null);
  const resyncAffectedAbortRef = useRef<AbortController | null>(null);

  const handleResyncAffected = useCallback(async (addresses: string[]) => {
    const controller = new AbortController();
    resyncAffectedAbortRef.current = controller;
    setCancellingResyncAffected(false);
    setResyncingAffected(true);
    setAffectedResyncProgress(null);
    try {
      if (addresses.length === 0) {
        toast({
          title: "Nothing to re-sync",
          description: "No affected addresses were identified.",
        });
        return;
      }

      const nodeSettings = await getNodeSettings("default");
      if (!nodeSettings) {
        toast({
          title: "No blockchain provider configured",
          description: "Configure a provider in Settings to re-sync these addresses.",
          variant: "destructive",
        });
        return;
      }

      try {
        const probe = createProviderFromSettings(nodeSettings);
        await probe.getBlockHeight();
      } catch (connErr) {
        console.warn("[UTXOs] Provider unreachable for affected-address re-sync:", connErr);
        toast({
          title: "Can't reach the blockchain provider",
          description: "Check your connection or provider settings in Settings, then try again.",
          variant: "destructive",
        });
        return;
      }

      transactionSyncService.updateProvider(nodeSettings);

      setAffectedResyncProgress({ processed: 0, total: addresses.length });
      let synced = 0;
      let failed = 0;
      for (const address of addresses) {
        if (controller.signal.aborted) break;
        setAffectedResyncAddressProgress({ address, fetched: 0, total: 0 });
        try {
          const result = await transactionSyncService.syncSingleAddress(address, (progress) => {
            // Live per-address fetch counter so a large address doesn't look
            // frozen; transactionsNew/transactionsFound carry the streaming
            // "processed / total" counts during the syncing-addresses phase.
            setAffectedResyncAddressProgress({
              address,
              fetched: progress.transactionsNew,
              total: progress.transactionsFound,
            });
          });
          if (result.success) synced += 1;
          else failed += 1;
        } catch (err) {
          console.warn(`[UTXOs] Affected-address re-sync failed for ${address}:`, err);
          failed += 1;
        }
        setAffectedResyncProgress({ processed: synced + failed, total: addresses.length });
      }
      setAffectedResyncAddressProgress(null);

      const cancelled = controller.signal.aborted;
      if (cancelled) {
        toast({
          title: "Re-sync stopped",
          description:
            synced > 0
              ? `Re-synced ${synced.toLocaleString()} address${synced !== 1 ? "es" : ""} before stopping.`
              : "Stopped before any addresses were re-synced.",
        });
      } else if (failed > 0) {
        toast({
          title: synced > 0 ? "Partially re-synced" : "Re-sync failed",
          description:
            synced > 0
              ? `Re-synced ${synced.toLocaleString()} address${synced !== 1 ? "es" : ""}, but ${failed.toLocaleString()} couldn't be re-synced.`
              : "None of the addresses could be re-synced. Check your provider settings and try again.",
          variant: synced > 0 ? undefined : "destructive",
        });
      } else {
        toast({
          title: "Re-synced",
          description: `Re-synced ${synced.toLocaleString()} affected address${synced !== 1 ? "es" : ""}. Outpoint data will refresh automatically.`,
        });
      }
    } catch (err) {
      console.warn("[UTXOs] Affected-address re-sync failed:", err);
      toast({
        title: "Re-sync failed",
        description: "Couldn't re-sync the affected addresses. Please try again.",
        variant: "destructive",
      });
    } finally {
      resyncAffectedAbortRef.current = null;
      setCancellingResyncAffected(false);
      setResyncingAffected(false);
      setAffectedResyncProgress(null);
      setAffectedResyncAddressProgress(null);
    }
  }, [toast]);

  // Aborting stops cleanly between addresses; addresses already re-synced keep
  // their new exact outpoint data.
  const handleCancelResyncAffected = useCallback(() => {
    if (resyncAffectedAbortRef.current) {
      setCancellingResyncAffected(true);
      resyncAffectedAbortRef.current.abort();
    }
  }, []);

  const { value: utxosHeuristic, isComputing: utxosHeuristicComputing } = useAsyncMemo(async (signal) => {
    if (!participants || !transactions) return [];

    const cutoffTime = selectedDate 
      ? Math.floor(selectedDate.getTime() / 1000) + 86400
      : Infinity;

    const outputs: typeof participants = [];
    const inputs: typeof participants = [];
    // Outpoint-first spent detection: an input that carries prevTxid/prevVout
    // identifies EXACTLY which output it consumed, so that spend is applied
    // directly (same as Exact mode) regardless of address/amount. Only inputs
    // MISSING outpoint data fall back to FIFO address:amount matching below.
    // Without this, Electrum-synced inputs (which have outpoints but no prevout
    // address/amount) never match any output key, every output counts as
    // unspent, and the page total inflates to "total received".
    const spentOutpoints = new Set<string>();
    for (let i = 0; i < participants.length; i++) {
      const p = participants[i];
      if (p.role === 'output') outputs.push(p);
      else if (p.role === 'input') {
        if (p.prevTxid !== undefined && p.prevTxid !== null && p.prevVout !== undefined && p.prevVout !== null) {
          const tx = txidToTx.get(p.txid);
          const inputBlockTime = tx?.blockTime ?? 0;
          if (inputBlockTime > 0 && inputBlockTime <= cutoffTime) {
            spentOutpoints.add(`${p.prevTxid}:${p.prevVout}`);
          }
        } else {
          inputs.push(p);
        }
      }
      if (i % 1000 === 999) {
        checkAbort(signal);
        await yieldToUI();
      }
    }

    const outputsWithTime = outputs.map(output => {
      const tx = txidToTx.get(output.txid);
      return { output, blockTime: tx?.blockTime ?? 0, blockHeight: tx?.blockHeight ?? 0 };
    }).filter(o => o.blockTime > 0 && o.blockTime <= cutoffTime);

    outputsWithTime.sort((a, b) => {
      if (a.blockTime !== b.blockTime) return a.blockTime - b.blockTime;
      return (a.output.vout ?? 0) - (b.output.vout ?? 0);
    });

    checkAbort(signal);
    await yieldToUI();

    const inputsWithTime = inputs.map(input => {
      const tx = txidToTx.get(input.txid);
      return { input, blockTime: tx?.blockTime ?? 0 };
    }).filter(i => i.blockTime > 0 && i.blockTime <= cutoffTime);

    inputsWithTime.sort((a, b) => a.blockTime - b.blockTime);

    const inputsByAddressAmount = new Map<string, { input: TransactionParticipant; blockTime: number }[]>();
    for (let i = 0; i < inputsWithTime.length; i++) {
      const item = inputsWithTime[i];
      const key = `${item.input.address}:${item.input.amount}`;
      const existing = inputsByAddressAmount.get(key) || [];
      existing.push(item);
      inputsByAddressAmount.set(key, existing);
      if (i % 1000 === 999) {
        checkAbort(signal);
        await yieldToUI();
      }
    }

    const result: UTXO[] = [];
    const matchedInputIndices = new Map<string, number>();

    for (let i = 0; i < outputsWithTime.length; i++) {
      const { output, blockTime, blockHeight } = outputsWithTime[i];

      // Spent via a known outpoint — authoritative, skip before any FIFO
      // matching (and without consuming a FIFO input).
      if (spentOutpoints.has(`${output.txid}:${output.vout ?? 0}`)) {
        if (i % 1000 === 999) {
          checkAbort(signal);
          await yieldToUI();
        }
        continue;
      }

      const key = `${output.address}:${output.amount}`;
      const matchingInputs = inputsByAddressAmount.get(key) || [];
      
      const currentIndex = matchedInputIndices.get(key) || 0;
      
      const spendingInput = matchingInputs.find((item, idx) => 
        idx >= currentIndex && item.blockTime > blockTime
      );

      if (spendingInput) {
        const spendIdx = matchingInputs.indexOf(spendingInput);
        matchedInputIndices.set(key, spendIdx + 1);
      } else {
        const record = addressToRecord.get(output.address);
        
        if (record) {
          const priceAtReceipt = getPriceForTimestamp(blockTime);
          const btcAmount = output.amount / 100_000_000;
          const valueAtReceipt = priceAtReceipt !== undefined ? btcAmount * priceAtReceipt : undefined;
          
          result.push({
            id: `${output.txid}:${output.vout ?? 0}`,
            txid: output.txid,
            vout: output.vout ?? 0,
            address: output.address,
            amountSats: output.amount,
            blockTime: blockTime,
            blockHeight: blockHeight,
            recordId: record?.id,
            label: record?.label,
            owner: record?.owner,
            walletName: record?.walletName,
            tags: record?.tags,
            categories: record?.categories,
            valueAtReceipt,
            priceAtReceipt
          });
        }
      }

      if (i % 1000 === 999) {
        checkAbort(signal);
        await yieldToUI();
      }
    }

    return result;
  }, [participants, transactions, txidToTx, addressToRecord, selectedDate, getPriceForTimestamp], [] as UTXO[]);

  const { value: utxosExact, isComputing: utxosExactComputing } = useAsyncMemo(async (signal) => {
    if (!participants || !transactions) return [];

    const cutoffTime = selectedDate 
      ? Math.floor(selectedDate.getTime() / 1000) + 86400
      : Infinity;

    const outputs: typeof participants = [];
    const spentOutpoints = new Set<string>();

    for (let i = 0; i < participants.length; i++) {
      const p = participants[i];
      if (p.role === 'output') {
        outputs.push(p);
      } else if (p.role === 'input') {
        if (p.prevTxid !== undefined && p.prevVout !== undefined) {
          const tx = txidToTx.get(p.txid);
          const inputBlockTime = tx?.blockTime ?? 0;
          if (inputBlockTime > 0 && inputBlockTime <= cutoffTime) {
            spentOutpoints.add(`${p.prevTxid}:${p.prevVout}`);
          }
        }
      }
      if (i % 1000 === 999) {
        checkAbort(signal);
        await yieldToUI();
      }
    }

    const result: UTXO[] = [];

    for (let i = 0; i < outputs.length; i++) {
      const output = outputs[i];
      const tx = txidToTx.get(output.txid);
      const blockTime = tx?.blockTime ?? 0;
      const blockHeight = tx?.blockHeight ?? 0;

      if (blockTime <= 0 || blockTime > cutoffTime) continue;

      const outpoint = `${output.txid}:${output.vout ?? 0}`;
      if (spentOutpoints.has(outpoint)) continue;

      const record = addressToRecord.get(output.address);
      if (!record) continue;
      
      const priceAtReceipt = getPriceForTimestamp(blockTime);
      const btcAmount = output.amount / 100_000_000;
      const valueAtReceipt = priceAtReceipt !== undefined ? btcAmount * priceAtReceipt : undefined;
      
      result.push({
        id: outpoint,
        txid: output.txid,
        vout: output.vout ?? 0,
        address: output.address,
        amountSats: output.amount,
        blockTime: blockTime,
        blockHeight: blockHeight,
        recordId: record?.id,
        label: record?.label,
        owner: record?.owner,
        walletName: record?.walletName,
        tags: record?.tags,
        categories: record?.categories,
        valueAtReceipt,
        priceAtReceipt
      });

      if (i % 1000 === 999) {
        checkAbort(signal);
        await yieldToUI();
      }
    }

    return result;
  }, [participants, transactions, txidToTx, addressToRecord, selectedDate, getPriceForTimestamp], [] as UTXO[]);

  // Select which UTXO calculation to use. When the engine fast path is active we
  // use its owned-UTXO set (always exact); otherwise fall back to the in-browser
  // computation for the current mode.
  const allUtxos = useMemo(() => {
    if (engineDecision === 'engine') return engineUtxos ?? [];
    return utxoMode === 'exact' ? utxosExact : utxosHeuristic;
  }, [engineDecision, engineUtxos, utxoMode, utxosExact, utxosHeuristic]);

  // When "Hide dust" is on, drop user-flagged dust outpoints before grouping so
  // both the list and every total exclude them. Off = identical to before.
  const { utxos, hiddenDustCount, hiddenDustSats } = useMemo(() => {
    if (!hideDust || !dustFlaggedOutpoints || dustFlaggedOutpoints.size === 0) {
      return { utxos: allUtxos, hiddenDustCount: 0, hiddenDustSats: 0 };
    }
    let count = 0;
    let sats = 0;
    const kept = allUtxos.filter(u => {
      if (dustFlaggedOutpoints.has(`${u.txid}:${u.vout}`)) {
        count++;
        sats += u.amountSats;
        return false;
      }
      return true;
    });
    return { utxos: kept, hiddenDustCount: count, hiddenDustSats: sats };
  }, [allUtxos, hideDust, dustFlaggedOutpoints]);

  const { value: addressGroups, isComputing: addressGroupsComputing } = useAsyncMemo(async (signal) => {
    const groups = new Map<string, AddressGroup>();
    
    for (let i = 0; i < utxos.length; i++) {
      const utxo = utxos[i];
      const existing = groups.get(utxo.address);
      
      if (existing) {
        existing.totalSats += utxo.amountSats;
        existing.utxos.push(utxo);
        existing.earliestDate = Math.min(existing.earliestDate, utxo.blockTime);
        existing.latestDate = Math.max(existing.latestDate, utxo.blockTime);
        if (utxo.valueAtReceipt !== undefined) {
          existing.totalValueAtReceipt = (existing.totalValueAtReceipt || 0) + utxo.valueAtReceipt;
        }
      } else {
        groups.set(utxo.address, {
          address: utxo.address,
          totalSats: utxo.amountSats,
          utxos: [utxo],
          earliestDate: utxo.blockTime,
          latestDate: utxo.blockTime,
          recordId: utxo.recordId,
          label: utxo.label,
          owner: utxo.owner,
          walletName: utxo.walletName,
          tags: utxo.tags,
          categories: utxo.categories,
          totalValueAtReceipt: utxo.valueAtReceipt
        });
      }

      if (i % 1000 === 999) {
        checkAbort(signal);
        await yieldToUI();
      }
    }

    const groupsArray = Array.from(groups.values());
    groupsArray.forEach(group => {
      if (latestPrice) {
        const btcAmount = group.totalSats / 100_000_000;
        group.totalCurrentValue = btcAmount * latestPrice.price;
        
        if (group.totalValueAtReceipt !== undefined) {
          group.gain = group.totalCurrentValue - group.totalValueAtReceipt;
          group.gainPercent = group.totalValueAtReceipt > 0 
            ? ((group.totalCurrentValue - group.totalValueAtReceipt) / group.totalValueAtReceipt) * 100
            : undefined;
        }
      }
    });

    return groupsArray;
  }, [utxos, latestPrice], [] as AddressGroup[]);

  const filteredGroups = useMemo(() => {
    let filtered = addressGroups;

    // Apply smart filtering: only show user-curated addresses by default
    if (!includeBlockchainDiscovered) {
      filtered = filtered.filter(g => userCuratedAddresses.has(g.address));
    }

    // Apply date and amount filters from TransactionSearchFilters
    if (hasActiveSearchFilters(searchFilters)) {
      filtered = filtered.flatMap(group => {
        // Filter by checking if any UTXO in the group matches the criteria
        const matchingUtxos = filterByDateAndAmount(
          group.utxos,
          searchFilters,
          (u) => u.blockTime,
          (u) => u.amountSats
        );
        return matchingUtxos.length > 0
          ? [narrowAddressGroup(group, matchingUtxos, latestPrice)]
          : [];
      });
    }

    // Each dimension is OR-within (matches ANY selected value, including the
    // "Unassigned" sentinel) and AND-across (must also satisfy other dims).
    if (ownerFilter.length > 0) {
      filtered = filtered.filter(g =>
        ownerFilter.some(v => v === UNASSIGNED_OWNER_VALUE ? !g.owner : g.owner === v)
      );
    }

    if (walletFilter.length > 0) {
      filtered = filtered.filter(g =>
        walletFilter.some(v => v === UNASSIGNED_OWNER_VALUE ? !g.walletName : g.walletName === v)
      );
    }

    if (tagFilter.length > 0) {
      filtered = filtered.filter(g =>
        tagFilter.some(v => v === UNASSIGNED_OWNER_VALUE ? (!g.tags || g.tags.length === 0) : !!g.tags?.includes(v))
      );
    }

    if (categoryFilter.length > 0) {
      filtered = filtered.filter(g =>
        categoryFilter.some(v => v === UNASSIGNED_OWNER_VALUE ? (!g.categories || g.categories.length === 0) : !!g.categories?.includes(v))
      );
    }

    if (debouncedSearch.trim()) {
      const q = debouncedSearch.toLowerCase();
      filtered = filtered.filter(g =>
        g.address.toLowerCase().includes(q) ||
        g.label?.toLowerCase().includes(q) ||
        g.owner?.toLowerCase().includes(q) ||
        g.walletName?.toLowerCase().includes(q) ||
        g.tags?.some(t => t.toLowerCase().includes(q)) ||
        g.categories?.some(c => c.toLowerCase().includes(q)) ||
        g.utxos.some(u => u.txid.toLowerCase().includes(q))
      );
    }

    return filtered;
  }, [addressGroups, ownerFilter, walletFilter, tagFilter, categoryFilter, debouncedSearch, searchFilters, includeBlockchainDiscovered, userCuratedAddresses, latestPrice]);

  const sortedGroups = useMemo(() => {
    const sorted = [...filteredGroups];
    
    sorted.sort((a, b) => {
      let cmp = 0;
      switch (sortColumn) {
        case "amount":
          cmp = a.totalSats - b.totalSats;
          break;
        case "date":
          cmp = a.latestDate - b.latestDate;
          break;
        case "address":
          cmp = a.address.localeCompare(b.address);
          break;
        case "gain":
          const gainA = a.gain ?? 0;
          const gainB = b.gain ?? 0;
          cmp = gainA - gainB;
          break;
      }
      return sortDirection === "asc" ? cmp : -cmp;
    });

    return sorted;
  }, [filteredGroups, sortColumn, sortDirection]);

  const flattenedRows = useMemo((): FlatUtxoRow[] => {
    const rows: FlatUtxoRow[] = [];
    for (const group of sortedGroups) {
      rows.push({ kind: 'group', group });
      if (expandedAddresses.has(group.address)) {
        group.utxos.forEach((utxo, idx) => {
          rows.push({ kind: 'utxo', utxo, index: idx });
        });
      }
    }
    return rows;
  }, [sortedGroups, expandedAddresses]);

  const utxoScrollRef = useRef<HTMLDivElement>(null);

  const totalSats = filteredGroups.reduce((sum, g) => sum + g.totalSats, 0);
  const totalUtxoCount = filteredGroups.reduce((sum, g) => sum + g.utxos.length, 0);
  const totalAddressCount = filteredGroups.length;
  const totalValueAtReceipt = filteredGroups.reduce((sum, g) => sum + (g.totalValueAtReceipt || 0), 0);
  const totalCurrentValue = filteredGroups.reduce((sum, g) => sum + (g.totalCurrentValue || 0), 0);
  const totalGain = totalCurrentValue - totalValueAtReceipt;

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortColumn(column);
      setSortDirection("desc");
    }
  };

  const clearFilters = () => {
    setSearch("");
    setOwnerFilter([]);
    setWalletFilter([]);
    setTagFilter([]);
    setCategoryFilter([]);
    setSelectedDate(undefined);
    setSearchFilters(defaultFilters);
    setHideDust(false);
  };

  const activeFilterCount =
    (search.trim() ? 1 : 0) +
    ownerFilter.length + walletFilter.length + tagFilter.length + categoryFilter.length +
    (selectedDate ? 1 : 0) +
    (hasActiveSearchFilters(searchFilters) ? 1 : 0) +
    (hideDust ? 1 : 0);
  const hasActiveFilters = activeFilterCount > 0;

  const isDataLoading = engineDecision === 'pending'
    ? true
    : engineDecision === 'engine'
      ? engineUtxosLoading
      : (!transactions || !participants);
  const isComputing = utxosHeuristicComputing || utxosExactComputing || addressGroupsComputing || outpointDataStatusComputing;
  const isLoading = isDataLoading || participantsLoading;

  useEffect(() => {
    utxoScrollRef.current?.scrollTo(0, 0);
  }, [debouncedSearch, ownerFilter, walletFilter, tagFilter, categoryFilter, selectedDate, searchFilters, sortColumn, sortDirection, includeBlockchainDiscovered, hideDust]);

  const toggleExpanded = (address: string) => {
    setExpandedAddresses(prev => {
      const next = new Set(prev);
      if (next.has(address)) {
        next.delete(address);
      } else {
        next.add(address);
      }
      return next;
    });
  };

  const openUtxoDetail = (utxo: UTXO) => {
    setSelectedUtxo(utxo);
    setDetailPanelOpen(true);
  };

  const selectedOutpointSet = useMemo(
    () => new Set(selectedUtxosForPsbt.keys()),
    [selectedUtxosForPsbt]
  );
  const selectedPsbtTotalSats = useMemo(() => {
    let sum = 0;
    selectedUtxosForPsbt.forEach(u => { sum += u.amountSats; });
    return sum;
  }, [selectedUtxosForPsbt]);

  const toggleUtxoSelected = useCallback((utxo: UTXO) => {
    setSelectedUtxosForPsbt(prev => {
      const next = new Map(prev);
      const key = `${utxo.txid}:${utxo.vout}`;
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.set(key, utxo);
      }
      return next;
    });
  }, []);

  const toggleGroupSelected = useCallback((group: AddressGroup) => {
    setSelectedUtxosForPsbt(prev => {
      const next = new Map(prev);
      const allSelected = group.utxos.length > 0 && group.utxos.every(u => next.has(`${u.txid}:${u.vout}`));
      if (allSelected) {
        for (const u of group.utxos) next.delete(`${u.txid}:${u.vout}`);
      } else {
        for (const u of group.utxos) next.set(`${u.txid}:${u.vout}`, u);
      }
      return next;
    });
  }, []);

  const SortableHeader = ({ column, label }: { column: SortColumn; label: string }) => (
    <TableHead>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 gap-1 -ml-3"
        onClick={() => handleSort(column)}
        data-testid={`button-sort-${column}`}
      >
        {label}
        {sortColumn === column && sortDirection === "asc" ? (
          <ArrowUp className="h-3 w-3" />
        ) : sortColumn === column && sortDirection === "desc" ? (
          <ArrowDown className="h-3 w-3" />
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-50" />
        )}
      </Button>
    </TableHead>
  );

  return (
    <div ref={utxoScrollRef} className="flex flex-col h-full overflow-y-auto overflow-x-hidden p-4 gap-4">
      <div className="flex-none flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="text-page-title">
            <Coins className="h-6 w-6" />
            UTXOs
          </h1>
          <p className="text-muted-foreground mt-1">
            View unspent transaction outputs grouped by address
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSavedPsbtsOpen(true)}
            data-testid="button-saved-psbts"
          >
            <FileSignature className="h-4 w-4 mr-1" />
            Saved PSBTs
          </Button>
          <BlockchainToggle
            checked={includeBlockchainDiscovered}
            onCheckedChange={setIncludeBlockchainDiscovered}
            hiddenCount={blockchainDiscoveredCount ?? 0}
          />
        </div>
      </div>

      {(participantsLoading || isComputing) && (
        <Card className="flex-none">
          <CardContent className="py-4">
            <div className="flex flex-col gap-2">
              {participantsLoading && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="status-participants-loading">
                  <RefreshCw className="h-4 w-4 animate-spin" />
                  <span>Loading transaction participants for {processedRecords.length.toLocaleString()} addresses...</span>
                </div>
              )}
              {isComputing && !participantsLoading && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="status-computing">
                  <RefreshCw className="h-4 w-4 animate-spin" />
                  <span>Computing UTXO set...</span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center gap-2 text-sm text-muted-foreground flex-none flex-wrap">
        <AlertCircle className="h-4 w-4" />
        <span>
          Data based on last transaction sync
          {lastSyncTime && (
            <span className="ml-1">
              ({format(new Date(lastSyncTime), "MMM d, yyyy 'at' h:mm a")})
            </span>
          )}
          {utxoMode === 'heuristic' && outpointDataStatus.total > 0 && outpointDataStatus.percentage < 100 && (
            <>
              <span className="mx-2">|</span>
              <span className="text-amber-600 dark:text-amber-400" data-testid="text-heuristic-coverage-warning">
                Standard mode: only {outpointDataStatus.percentage}% of inputs have outpoint data — spends of the rest are estimated by amount matching (re-sync for accurate balances)
              </span>
              {outpointDataStatus.affectedAddresses.length > 0 && !resyncingAffected && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-auto p-0 ml-2 text-primary hover:underline"
                  onClick={() => handleResyncAffected(outpointDataStatus.affectedAddresses)}
                  data-testid="button-resync-affected"
                >
                  <RefreshCw className="h-3 w-3 mr-1" />
                  Re-sync {outpointDataStatus.affectedAddresses.length.toLocaleString()} affected address{outpointDataStatus.affectedAddresses.length !== 1 ? "es" : ""}
                </Button>
              )}
              {resyncingAffected && (
                <span className="ml-2 inline-flex items-center gap-2" data-testid="status-resync-affected">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>
                    {affectedResyncProgress
                      ? `Re-syncing ${affectedResyncProgress.processed.toLocaleString()}/${affectedResyncProgress.total.toLocaleString()} addresses`
                      : "Preparing re-sync..."}
                    {affectedResyncAddressProgress && affectedResyncAddressProgress.total > 0 && (
                      <span className="ml-1 text-xs">
                        ({affectedResyncAddressProgress.fetched.toLocaleString()}/{affectedResyncAddressProgress.total.toLocaleString()} transactions)
                      </span>
                    )}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto p-0 text-destructive hover:underline"
                    onClick={handleCancelResyncAffected}
                    disabled={cancellingResyncAffected}
                    data-testid="button-stop-resync-affected"
                  >
                    {cancellingResyncAffected ? "Stopping..." : "Stop"}
                  </Button>
                </span>
              )}
            </>
          )}
          {utxoMode === 'heuristic' && (outpointDataStatus.total === 0 || outpointDataStatus.percentage === 100) && (
            <>
              <span className="mx-2">|</span>
              <span className="text-amber-600 dark:text-amber-400">
                Standard mode uses heuristics; balances may be approximate
              </span>
            </>
          )}
          {utxoMode === 'exact' && outpointDataStatus.percentage === 0 && (
            <>
              <span className="mx-2">|</span>
              <span className="text-amber-600 dark:text-amber-400">
                Exact mode requires re-sync to populate outpoint data
              </span>
            </>
          )}
          {utxoMode === 'exact' && outpointDataStatus.percentage > 0 && outpointDataStatus.percentage < 100 && (
            <>
              <span className="mx-2">|</span>
              <span className="text-amber-600 dark:text-amber-400">
                Exact mode: {outpointDataStatus.percentage}% of inputs have outpoint data (re-sync for full accuracy)
              </span>
            </>
          )}
          {utxoMode === 'exact' && outpointDataStatus.percentage === 100 && (
            <>
              <span className="mx-2">|</span>
              <span className="text-green-600 dark:text-green-400">
                Exact mode: using outpoint-based UTXO matching
              </span>
            </>
          )}
        </span>
        <Link href="/transaction-sync">
          <Button variant="ghost" size="sm" className="h-auto p-0 text-primary hover:underline" data-testid="link-sync">
            <RefreshCw className="h-3 w-3 mr-1" />
            Sync now
          </Button>
        </Link>
        {latestPrice ? (
          <span className="ml-4 text-xs">
            Price data as of {format(new Date(latestPrice.date), "MMM d, yyyy")}
          </span>
        ) : (
          <span className="ml-4 text-xs text-amber-600 dark:text-amber-400">
            No price data -
            <Link href="/settings/price-import" className="ml-1 text-primary hover:underline" data-testid="link-import-prices">
              Import price history
            </Link>
          </span>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 flex-none">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Addresses / UTXOs</CardDescription>
            <CardTitle className="text-2xl" data-testid="text-utxo-count">
              {totalAddressCount.toLocaleString()} / {totalUtxoCount.toLocaleString()}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Balance</CardDescription>
            <CardTitle className="text-2xl flex items-center gap-2" data-testid="text-total-balance">
              <SiBitcoin className="h-5 w-5 text-primary" />
              {displayUnit === "btc" ? (
                <span>{satsToBtc(totalSats)} BTC</span>
              ) : (
                <span>{totalSats.toLocaleString()} sats</span>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="ml-2 h-6 text-xs"
                onClick={() => setDisplayUnit(u => u === "btc" ? "sats" : "btc")}
                data-testid="button-toggle-unit"
              >
                {displayUnit === "btc" ? "sats" : "BTC"}
              </Button>
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Cost Basis</CardDescription>
            <CardTitle className="text-xl" data-testid="text-cost-basis">
              {totalValueAtReceipt > 0 ? formatUsdValue(totalValueAtReceipt) : "-"}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Unrealized Gain/Loss</CardDescription>
            <CardTitle className={cn(
              "text-xl flex items-center gap-1",
              totalGain > 0 ? "text-green-600 dark:text-green-400" : totalGain < 0 ? "text-red-600 dark:text-red-400" : ""
            )} data-testid="text-total-gain">
              {totalGain > 0 ? <TrendingUp className="h-4 w-4" /> : totalGain < 0 ? <TrendingDown className="h-4 w-4" /> : null}
              {totalValueAtReceipt > 0 ? formatUsdValue(totalGain) : "-"}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card className="flex-none">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-4">
            <div className="flex-1 min-w-[200px]">
              <Label className="sr-only">Search</Label>
              <div className="relative">
                {isSearchPending ? (
                  <Loader2 className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground animate-spin" data-testid="icon-search-pending" />
                ) : (
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                )}
                <Input
                  placeholder="Search address, txid, label, owner, wallet, tag, or category..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-10"
                  data-testid="input-search"
                />
              </div>
            </div>
            
            <TransactionSearchFilters
              filters={searchFilters}
              onChange={setSearchFilters}
              onClear={() => setSearchFilters(defaultFilters)}
              showEntityFilters={false}
              displayUnit={displayUnit}
            />

            <div className="w-[180px]">
              <Label className="sr-only">Owner</Label>
              <MultiSelectCombobox
                values={ownerFilter}
                onChange={setOwnerFilter}
                options={[UNASSIGNED_OWNER_VALUE, ...owners]}
                placeholder="All Owners"
                optionLabels={{ [UNASSIGNED_OWNER_VALUE]: UNASSIGNED_OWNER_OPTION.label }}
                searchPlaceholder="Search owners..."
                testId="select-owner"
              />
            </div>

            <div className="w-[180px]">
              <Label className="sr-only">Wallet</Label>
              <MultiSelectCombobox
                values={walletFilter}
                onChange={setWalletFilter}
                options={[UNASSIGNED_OWNER_VALUE, ...walletNames]}
                placeholder="All Wallets"
                searchPlaceholder="Search wallets..."
                testId="select-wallet"
              />
            </div>

            <div className="w-[160px]">
              <Label className="sr-only">Tag</Label>
              <MultiSelectCombobox
                values={tagFilter}
                onChange={setTagFilter}
                options={[UNASSIGNED_OWNER_VALUE, ...tags]}
                placeholder="All Tags"
                searchPlaceholder="Search tags..."
                testId="select-tag"
              />
            </div>

            <div className="w-[160px]">
              <Label className="sr-only">Category</Label>
              <MultiSelectCombobox
                values={categoryFilter}
                onChange={setCategoryFilter}
                options={[UNASSIGNED_OWNER_VALUE, ...categories]}
                placeholder="All Categories"
                searchPlaceholder="Search categories..."
                testId="select-category"
              />
            </div>

            <div className="w-[200px]">
              <Label className="sr-only">Historical Date</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "w-full justify-start text-left font-normal",
                      !selectedDate && "text-muted-foreground"
                    )}
                    data-testid="button-date-picker"
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {selectedDate ? format(selectedDate, "MMM d, yyyy") : "View as of date..."}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={selectedDate}
                    onSelect={setSelectedDate}
                    disabled={(date) => date > new Date() || date < new Date(2009, 0, 3)}
                    captionLayout="dropdown-buttons"
                    fromYear={2009}
                    toYear={new Date().getFullYear()}
                    defaultMonth={selectedDate || new Date()}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            </div>

            <div className="flex items-center gap-1">
              <div className="w-[160px]">
                <Label className="sr-only">Calculation Mode</Label>
                <Select value={utxoMode} onValueChange={(v) => setUtxoMode(v as UTXOCalculationMode)}>
                  <SelectTrigger data-testid="select-utxo-mode">
                    <SelectValue placeholder="Mode" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="heuristic">Standard</SelectItem>
                    <SelectItem value="exact">Exact (Beta)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8" data-testid="button-mode-help">
                    <HelpCircle className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-80" align="start">
                  <div className="space-y-3">
                    <h4 className="font-medium">UTXO Calculation Modes</h4>
                    <div className="space-y-2 text-sm">
                      <div>
                        <span className="font-medium">Standard Mode:</span>
                        <p className="text-muted-foreground">
                          Uses address + amount matching to identify spent UTXOs. Fast and works with any data, but may be approximate when the same address receives identical amounts multiple times.
                        </p>
                      </div>
                      <div>
                        <span className="font-medium">Exact Mode (Beta):</span>
                        <p className="text-muted-foreground">
                          Uses outpoint data (txid:vout) for 100% accurate UTXO identification. Requires transaction sync data with outpoint information. Shows exact which specific UTXO was spent in each transaction.
                        </p>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground border-t pt-2">
                      Tip: If Exact mode shows 0% data coverage, re-sync your transactions to fetch outpoint data.
                    </p>
                  </div>
                </PopoverContent>
              </Popover>
            </div>

            <div className="flex items-center gap-2 min-h-9">
              <Switch
                id="switch-hide-dust"
                checked={hideDust}
                onCheckedChange={setHideDust}
                data-testid="switch-hide-dust"
              />
              <Label htmlFor="switch-hide-dust" className="text-sm cursor-pointer whitespace-nowrap">
                Hide dust
              </Label>
            </div>

            {hasActiveFilters && (
              <Button
                variant="outline"
                size="sm"
                onClick={clearFilters}
                title="Clear all filters"
                data-testid="button-clear-filters"
              >
                <X className="h-4 w-4 mr-1" />
                Clear all filters
                <span className="ml-1 rounded-full bg-muted-foreground/20 text-foreground h-5 w-5 text-xs flex items-center justify-center">
                  {activeFilterCount}
                </span>
              </Button>
            )}
          </div>

          {hideDust && (
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="gap-1" data-testid="badge-dust-hidden">
                Hiding dust-flagged UTXOs
                {hiddenDustCount > 0 && (
                  <span>
                    ({hiddenDustCount.toLocaleString()} hidden, {displayUnit === "btc" ? `${satsToBtc(hiddenDustSats)} BTC` : `${hiddenDustSats.toLocaleString()} sats`})
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
                Show dust
              </Button>
            </div>
          )}

          {selectedDate && (
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="gap-1">
                <CalendarIcon className="h-3 w-3" />
                Showing UTXOs as of {format(selectedDate, "MMMM d, yyyy")}
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedDate(undefined)}
                className="h-6 text-xs"
                data-testid="button-clear-date"
              >
                Show current
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <div className={searchPendingClass(isSearchPending, 'UTXOs')}>
        {notarization && (
          <div
            className="flex items-center justify-between gap-2 mb-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 flex-none flex-wrap"
            data-testid="bar-notarization-intent"
          >
            <span className="text-sm flex items-center gap-2 min-w-0">
              <ShieldCheck className="h-4 w-4 shrink-0 text-primary" />
              <span className="truncate">
                Notarizing <span className="font-medium">{notarization.evidenceFilename ?? "evidence file"}</span>
                {" "}— select the UTXOs to fund the transaction, then Build PSBT.
              </span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={dismissNotarization}
              data-testid="button-dismiss-notarization"
            >
              <X className="h-4 w-4 mr-1" />
              Cancel notarization
            </Button>
          </div>
        )}
        {selectedUtxosForPsbt.size > 0 && (
          <div
            className="flex items-center justify-between gap-2 mb-2 rounded-md border bg-card px-3 py-2 flex-none flex-wrap"
            data-testid="bar-utxo-selection"
          >
            <span className="text-sm" data-testid="text-selection-summary">
              <span className="font-medium">{selectedUtxosForPsbt.size} UTXO{selectedUtxosForPsbt.size !== 1 ? "s" : ""} selected</span>
              <span className="ml-2 text-muted-foreground">
                {selectedPsbtTotalSats.toLocaleString()} sats ({satsToBtc(selectedPsbtTotalSats)} BTC)
              </span>
            </span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => setBuildPsbtOpen(true)}
                data-testid="button-build-psbt"
              >
                <FileSignature className="h-4 w-4 mr-1" />
                Build PSBT
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedUtxosForPsbt(new Map())}
                data-testid="button-clear-selection"
              >
                <X className="h-4 w-4 mr-1" />
                Clear
              </Button>
            </div>
          </div>
        )}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              {filteredGroups.length === addressGroups.length 
                ? `${totalAddressCount} addresses (${totalUtxoCount} UTXOs)` 
                : `${filteredGroups.length} of ${addressGroups.length} addresses`}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading || isComputing ? (
              <div className="flex flex-col items-center justify-center h-32 gap-2" data-testid="status-loading">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
                <p className="text-sm text-muted-foreground">
                  {engineDecision === 'engine' ? "Loading UTXOs..." : !transactions ? "Loading transactions..." : participantsLoading ? "Loading participants..." : isComputing ? "Computing UTXOs..." : "Loading..."}
                </p>
              </div>
            ) : sortedGroups.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-32 text-muted-foreground">
                <Coins className="h-8 w-8 mb-2 opacity-50" />
                <p>No UTXOs found</p>
                {hasActiveFilters && (
                  <Button variant="ghost" onClick={clearFilters} className="mt-1" data-testid="button-clear-filters-empty">
                    Clear filters
                  </Button>
                )}
              </div>
            ) : (
              <VirtualizedUtxoList
                flattenedRows={flattenedRows}
                expandedAddresses={expandedAddresses}
                displayUnit={displayUnit}
                onToggleGroup={toggleExpanded}
                onOpenUtxo={openUtxoDetail}
                scrollRef={utxoScrollRef}
                dustFlaggedOutpoints={dustFlaggedOutpoints}
                selectedOutpoints={selectedOutpointSet}
                onToggleUtxoSelected={toggleUtxoSelected}
                onToggleGroupSelected={toggleGroupSelected}
                header={
                  <TableRow>
                    <TableHead className="w-8"></TableHead>
                    <TableHead className="w-8"></TableHead>
                    <SortableHeader column="address" label="Address" />
                    <SortableHeader column="amount" label="UTXO Value" />
                    <SortableHeader column="date" label="Date" />
                    <TableHead>Value at Receipt</TableHead>
                    <TableHead>Current Value</TableHead>
                    <SortableHeader column="gain" label="Gain/Loss" />
                  </TableRow>
                }
              />
            )}
          </CardContent>
        </Card>
      </div>

      <UTXODetailPanel
        open={detailPanelOpen}
        onClose={() => setDetailPanelOpen(false)}
        utxo={selectedUtxo}
        latestPrice={latestPrice}
      />

      <BuildPsbtDialog
        open={buildPsbtOpen}
        onOpenChange={setBuildPsbtOpen}
        utxos={Array.from(selectedUtxosForPsbt.values())}
        recordForAddress={(address) => addressToRecord.get(address)}
        notarization={notarization}
        onSaved={dismissNotarization}
      />
      <SavedPsbtsDialog
        open={savedPsbtsOpen}
        onOpenChange={setSavedPsbtsOpen}
      />
    </div>
  );
}

import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ScrollPositionIndicator } from "@/components/ScrollPositionIndicator";
import { useAsyncMemo, yieldToUI, checkAbort } from "@/hooks/use-async-memo";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { PAGE_DEBOUNCE } from "@/config/debounce";
import { useDbChangeSignal } from "@/hooks/use-db-change-signal";
import { useLiveQuery } from "dexie-react-hooks";
import { format } from "date-fns";
import { BlockchainTransaction, TransactionParticipant, Record, type AddressImportance } from "@/lib/database";
import { bulkGetRecords, getAddressRecordsByImportanceTiers } from "@/lib/data/record-crud";
import {
  countTransactions,
  countTransactionsWithOpReturn,
  getTransactionsByTxids,
  bulkGetTransactionsByPrimaryKeys,
  getTransactionsPageByBlockTime,
  getOpReturnTransactionsPageByBlockTime,
  getOrderedTransactionPrimaryKeysByBlockTime,
  getOpReturnTransactionPrimaryKeys,
  getParticipantsByRecordIds,
} from "@/lib/data/transaction-crud";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { BlockchainToggle } from "@/components/BlockchainToggle";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { 
  TransactionSearchFilters, 
  SearchFilters, 
  defaultFilters, 
  hasActiveSearchFilters,
  filterByDateAndAmount 
} from "@/components/TransactionSearchFilters";
import { 
  ChevronLeft, 
  ChevronRight, 
  ChevronDown, 
  ChevronUp,
  Search,
  ArrowDownLeft,
  ArrowUpRight,
  ExternalLink,
  Clock,
  Hash,
  Zap,
  Link as LinkIcon,
  FileCode,
  Scale,
  ChevronsDownUp,
  ChevronsUpDown,
  Loader2,
  AlertTriangle,
  Info
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getParticipantsByTxids } from "@/lib/participant-repo";
import { ClickableAddress } from "@/components/ClickableAddress";
import { searchPendingClass } from "@/lib/search-pending-class";
import { Switch } from "@/components/ui/switch";
import {
  isSqlitePrototypeEnabled,
  setSqlitePrototypeEnabled,
  setActiveBackend,
  ensureSqliteInit,
  getSqliteStatus,
  seedSqlite,
  cancelSqliteSeeding,
  sqliteCountParticipants,
  type SeedProgress,
  type StorageMode,
} from "@/lib/sqlite-client";
import { Database } from "lucide-react";

const ITEMS_PER_PAGE = 25;
const MAX_COLLECTED_MATCHES = 50_000;
const VIRTUAL_ITEM_ESTIMATE = 120;
const VIRTUAL_OVERSCAN = 10;
const EXPAND_ALL_SEARCH_CAP = 200;

// Helper to format satoshis to BTC
function satsToBtc(sats: number | undefined): string {
  if (sats === undefined || sats === null) return "0.00000000";
  return (sats / 100_000_000).toFixed(8);
}

// Helper to format satoshis in a readable way
function formatSats(sats: number | undefined): string {
  if (sats === undefined || sats === null || sats === 0) return "0 sats";
  if (sats >= 100_000_000) {
    return `${satsToBtc(sats)} BTC`;
  } else if (sats >= 1_000_000) {
    return `${(sats / 1_000_000).toFixed(2)}M sats`;
  } else if (sats >= 1_000) {
    return `${(sats / 1_000).toFixed(1)}k sats`;
  }
  return `${sats} sats`;
}

interface VirtualizedLoadedStats {
  loadedVolume: number;
  loadedLinkedAddressCount: number;
  loadedTxCount: number;
}
// User-curated importance tiers (exclude blockchain-discovered and pending-review by default)
const USER_CURATED_TIERS: AddressImportance[] = ['verified', 'manual', 'wallet-import', 'xpub-derived'];

function TransactionCard({
  tx,
  inputs,
  outputs,
  totalOutputValue,
  isExpanded,
  onToggleExpand,
  addressToRecord,
  participantsLoaded = true,
}: {
  tx: BlockchainTransaction;
  inputs: TransactionParticipant[];
  outputs: TransactionParticipant[];
  totalOutputValue: number;
  isExpanded: boolean;
  onToggleExpand: () => void;
  addressToRecord: Map<string, Record>;
  participantsLoaded?: boolean;
}) {
  const txDate = new Date(tx.blockTime * 1000);

  return (
    <Collapsible open={isExpanded} onOpenChange={onToggleExpand}>
      <Card data-testid={`card-transaction-${tx.txid.slice(0, 8)}`}>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover-elevate">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <Hash className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <ClickableAddress
                    address={tx.txid}
                    className="flex-1 min-w-0"
                  />
                  <a
                    href={`https://mempool.space/tx/${tx.txid}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="text-muted-foreground hover:text-primary"
                    data-testid={`link-explorer-${tx.txid.slice(0, 8)}`}
                  >
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
                <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground flex-wrap">
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {format(txDate, "MMM d, yyyy HH:mm")}
                  </span>
                  <span className="flex items-center gap-1">
                    Block {(tx.blockHeight ?? 0).toLocaleString()}
                  </span>
                  <span className="flex items-center gap-1">
                    <Zap className="h-3 w-3" />
                    {(tx.feeRate ?? 0).toFixed(1)} sat/vB
                  </span>
                  {tx.vsize && (
                    <span className="flex items-center gap-1">
                      <Scale className="h-3 w-3" />
                      {tx.vsize.toLocaleString()} vB
                    </span>
                  )}
                  {tx.hasOpReturn && (
                    <Badge variant="outline" className="text-xs bg-purple-50 dark:bg-purple-950 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-800">
                      <FileCode className="h-3 w-3 mr-1" />
                      OP_RETURN
                    </Badge>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <div className="font-mono text-sm font-medium" data-testid={`text-amount-${tx.txid.slice(0, 8)}`}>
                    {participantsLoaded ? `${satsToBtc(totalOutputValue)} BTC` : '\u2014'}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Fee: {formatSats(tx.fee)}
                  </div>
                </div>
                {isExpanded ? (
                  <ChevronUp className="h-5 w-5 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-5 w-5 text-muted-foreground" />
                )}
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <CardContent className="pt-0">
            {!participantsLoaded ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                <span className="text-sm text-muted-foreground">Loading transaction details...</span>
              </div>
            ) : (
              <>
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                      <ArrowDownLeft className="h-4 w-4 text-red-500" />
                      Inputs ({inputs.length})
                    </h4>
                    <div className="space-y-2">
                      {inputs.map((input, idx) => {
                        const linkedRecord = addressToRecord.get(input.address);
                        return (
                          <div
                            key={`${input.txid}-input-${idx}`}
                            className="p-2 rounded-md bg-muted/50 text-sm"
                            data-testid={`participant-input-${idx}`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <ClickableAddress
                                address={input.address}
                                className="text-xs truncate flex-1"
                              />
                              <span className="font-mono text-xs font-medium whitespace-nowrap">
                                {formatSats(input.amount)}
                              </span>
                            </div>
                            {linkedRecord && (
                              <div className="flex items-center gap-1 mt-1">
                                <LinkIcon className="h-3 w-3 text-primary" />
                                <Badge variant="secondary" className="text-xs">
                                  {linkedRecord.label || linkedRecord.owner || 'Labeled'}
                                </Badge>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                      <ArrowUpRight className="h-4 w-4 text-green-500" />
                      Outputs ({outputs.length})
                    </h4>
                    <div className="space-y-2">
                      {outputs.map((output, idx) => {
                        const linkedRecord = addressToRecord.get(output.address);
                        return (
                          <div
                            key={`${output.txid}-output-${idx}`}
                            className="p-2 rounded-md bg-muted/50 text-sm"
                            data-testid={`participant-output-${idx}`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <ClickableAddress
                                address={output.address}
                                className="text-xs truncate flex-1"
                              />
                              <span className="font-mono text-xs font-medium whitespace-nowrap">
                                {formatSats(output.amount)}
                              </span>
                            </div>
                            {linkedRecord && (
                              <div className="flex items-center gap-1 mt-1">
                                <LinkIcon className="h-3 w-3 text-primary" />
                                <Badge variant="secondary" className="text-xs">
                                  {linkedRecord.label || linkedRecord.owner || 'Labeled'}
                                </Badge>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {tx.hasOpReturn && tx.opReturnData && tx.opReturnData.length > 0 && (
                  <div className="mt-4 pt-4 border-t">
                    <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                      <FileCode className="h-4 w-4 text-purple-500" />
                      OP_RETURN Data ({tx.opReturnData.length})
                    </h4>
                    <div className="space-y-2">
                      {tx.opReturnData.map((opReturn, idx) => (
                        <div
                          key={`op-return-${idx}`}
                          className="p-3 rounded-md bg-purple-50 dark:bg-purple-950/50 border border-purple-200 dark:border-purple-800 text-sm"
                          data-testid={`op-return-${idx}`}
                        >
                          <div className="flex items-center gap-2 mb-2">
                            <Badge variant="outline" className="text-xs">
                              Output #{opReturn.vout}
                            </Badge>
                          </div>
                          {opReturn.dataText && (
                            <div className="mb-2">
                              <span className="text-xs text-muted-foreground">Text:</span>
                              <pre className="mt-1 p-2 bg-background rounded text-xs font-mono whitespace-pre-wrap break-all">
                                {opReturn.dataText}
                              </pre>
                            </div>
                          )}
                          <div>
                            <span className="text-xs text-muted-foreground">Hex:</span>
                            <pre className="mt-1 p-2 bg-background rounded text-xs font-mono whitespace-pre-wrap break-all text-muted-foreground">
                              {opReturn.dataHex || '(empty)'}
                            </pre>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

function VirtualizedTransactionList({
  transactions,
  expandedTxs,
  toggleExpanded,
  baseAddressToRecord,
  onStatsChange,
  backendVersion = 0,
}: {
  transactions: BlockchainTransaction[];
  expandedTxs: Set<string>;
  toggleExpanded: (txid: string) => void;
  baseAddressToRecord: Map<string, Record>;
  onStatsChange?: (stats: VirtualizedLoadedStats) => void;
  backendVersion?: number;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const participantCacheRef = useRef(new Map<string, TransactionParticipant[]>());
  const recordCacheRef = useRef(new Map<string, Record>());
  const pendingLoadsRef = useRef(new Set<string>());
  const [cacheVersion, setCacheVersion] = useState(0);
  const statsRef = useRef<{
    volume: number;
    txCount: number;
    linkedAddresses: Set<string>;
    allAddresses: Set<string>;
  }>({ volume: 0, txCount: 0, linkedAddresses: new Set(), allAddresses: new Set() });

  const txIdentity = transactions.length > 0
    ? `${transactions.length}-${transactions[0].txid}-${transactions[transactions.length - 1].txid}`
    : '';

  useEffect(() => {
    participantCacheRef.current = new Map();
    recordCacheRef.current = new Map();
    pendingLoadsRef.current = new Set();
    statsRef.current = { volume: 0, txCount: 0, linkedAddresses: new Set(), allAddresses: new Set() };
    setCacheVersion(0);
    onStatsChange?.({ loadedVolume: 0, loadedLinkedAddressCount: 0, loadedTxCount: 0 });
  }, [txIdentity, backendVersion]);

  const virtualizer = useVirtualizer({
    count: transactions.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => VIRTUAL_ITEM_ESTIMATE,
    overscan: VIRTUAL_OVERSCAN,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const visibleRangeKey = virtualItems.length > 0
    ? `${virtualItems[0].index}-${virtualItems[virtualItems.length - 1].index}`
    : '';

  useEffect(() => {
    if (!visibleRangeKey || transactions.length === 0) return;

    const [startStr, endStr] = visibleRangeKey.split('-');
    const start = parseInt(startStr);
    const end = parseInt(endStr);

    const cache = participantCacheRef.current;
    const pending = pendingLoadsRef.current;
    const txidsToLoad: string[] = [];

    for (let i = start; i <= end; i++) {
      const tx = transactions[i];
      if (tx && !cache.has(tx.txid) && !pending.has(tx.txid)) {
        txidsToLoad.push(tx.txid);
      }
    }

    if (txidsToLoad.length === 0) return;

    let cancelled = false;
    txidsToLoad.forEach(txid => pending.add(txid));

    (async () => {
      try {
        const participants = await getParticipantsByTxids(txidsToLoad);
        if (cancelled) return;

        for (const txid of txidsToLoad) {
          if (!cache.has(txid)) cache.set(txid, []);
        }
        for (const p of participants) {
          const arr = cache.get(p.txid);
          if (arr) arr.push(p);
          else cache.set(p.txid, [p]);
        }

        const recordIds = new Set<number>();
        for (const p of participants) {
          if (p.recordId != null) recordIds.add(p.recordId);
        }
        if (recordIds.size > 0) {
          const records = await bulkGetRecords(Array.from(recordIds));
          if (!cancelled) {
            for (const r of records) {
              if (r && r.type === 'address' && r.inputString) {
                recordCacheRef.current.set(r.inputString, r);
              }
            }
          }
        }

        if (!cancelled) {
          const stats = statsRef.current;
          stats.txCount += txidsToLoad.length;
          for (const p of participants) {
            stats.allAddresses.add(p.address);
            if (p.role === 'output') stats.volume += p.amount;
            if (baseAddressToRecord.has(p.address) || recordCacheRef.current.has(p.address)) {
              stats.linkedAddresses.add(p.address);
            }
          }
          setCacheVersion(v => v + 1);
          onStatsChange?.({
            loadedVolume: stats.volume,
            loadedLinkedAddressCount: stats.linkedAddresses.size,
            loadedTxCount: stats.txCount,
          });
        }
      } finally {
        txidsToLoad.forEach(txid => pending.delete(txid));
      }
    })();

    return () => { cancelled = true; };
  }, [visibleRangeKey, transactions]);

  const mergedAddressToRecord = useMemo(() => {
    const merged = new Map(baseAddressToRecord);
    for (const [addr, record] of recordCacheRef.current) {
      merged.set(addr, record);
    }
    return merged;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseAddressToRecord, cacheVersion]);

  useEffect(() => {
    if (!onStatsChange) return;
    const stats = statsRef.current;
    if (stats.allAddresses.size === 0) return;

    const newLinked = new Set<string>();
    const records = recordCacheRef.current;
    for (const addr of stats.allAddresses) {
      if (baseAddressToRecord.has(addr) || records.has(addr)) {
        newLinked.add(addr);
      }
    }
    stats.linkedAddresses = newLinked;

    onStatsChange({
      loadedVolume: stats.volume,
      loadedLinkedAddressCount: newLinked.size,
      loadedTxCount: stats.txCount,
    });
  }, [baseAddressToRecord, onStatsChange]);

  return (
    <div
      ref={parentRef}
      className="flex-1 overflow-y-auto"
      data-testid="virtual-scroll-container"
    >
      <div
        className="relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualItems.map(virtualRow => {
          const tx = transactions[virtualRow.index];
          const participants = participantCacheRef.current.get(tx.txid) || [];
          const inputs = participants.filter(p => p.role === 'input');
          const outputs = participants.filter(p => p.role === 'output');
          const totalOutputValue = outputs.reduce((sum, p) => sum + p.amount, 0);
          const isExpanded = expandedTxs.has(tx.txid);
          const isLoaded = participantCacheRef.current.has(tx.txid);

          return (
            <div
              key={tx.txid}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              className="absolute left-0 right-0 pb-3"
              style={{
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <TransactionCard
                tx={tx}
                inputs={inputs}
                outputs={outputs}
                totalOutputValue={totalOutputValue}
                isExpanded={isExpanded}
                onToggleExpand={() => toggleExpanded(tx.txid)}
                addressToRecord={mergedAddressToRecord}
                participantsLoaded={isLoaded}
              />
            </div>
          );
        })}
      </div>
      <ScrollPositionIndicator
        virtualItems={virtualItems}
        totalCount={transactions.length}
        scrollElement={parentRef.current}
        label="transactions"
      />
    </div>
  );
}

export default function Transactions() {
  const [search, setSearch] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [expandedTxs, setExpandedTxs] = useState<Set<string>>(new Set());
  const [searchFilters, setSearchFilters] = useState<SearchFilters>(defaultFilters);
  
  // Smart filtering: exclude transactions only involving blockchain-discovered addresses
  // This filters at the DATABASE level, avoiding loading records we don't need
  const [includeBlockchainDiscovered, setIncludeBlockchainDiscovered] = useState(false);
  
  // OP_RETURN filter: only show transactions with OP_RETURN data
  const [opReturnOnly, setOpReturnOnly] = useState(false);
  const [searchProgress, setSearchProgress] = useState<{ scanned: number; total: number; matches: number } | null>(null);
  const [virtualizedStats, setVirtualizedStats] = useState<VirtualizedLoadedStats | null>(null);

  const handleVirtualizedStatsChange = useCallback((stats: VirtualizedLoadedStats) => {
    setVirtualizedStats(stats);
  }, []);

  // --- SQLite-WASM prototype (Task #229) -----------------------------------
  const [sqliteEnabled, setSqliteEnabled] = useState(() => isSqlitePrototypeEnabled());
  const [sqliteReady, setSqliteReady] = useState(false);
  const [sqliteStorageMode, setSqliteStorageMode] = useState<StorageMode | null>(null);
  const [seedProgress, setSeedProgress] = useState<SeedProgress | null>(null);
  const [backendVersion, setBackendVersion] = useState(0);

  const activateSqlite = useCallback(async () => {
    try {
      const initResult = await ensureSqliteInit();
      setSqliteStorageMode(initResult.storageMode);
      console.log(
        `[sqlite-proto] initialized — SQLite ${initResult.sqliteVersion}, storage: ${initResult.storageMode}`
      );

      const status = await getSqliteStatus();
      if (status.rowCount === 0) {
        const result = await seedSqlite((p) => setSeedProgress(p));
        setSeedProgress(null);
        if (result.cancelled) {
          console.log('[sqlite-proto] seeding cancelled by user');
          return false;
        }
        console.log(
          `[sqlite-proto] seeded ${result.rowCount.toLocaleString()} participants in ${result.durationMs.toFixed(0)}ms`
        );
      } else {
        console.log(`[sqlite-proto] reusing persisted data: ${status.rowCount.toLocaleString()} participants`);
      }

      // One-time count benchmark for direct comparison.
      const dexieT0 = performance.now();
      const dexieCount = await db.transactionParticipants.count();
      const dexieT1 = performance.now();
      const sqliteT0 = performance.now();
      const sqliteCount = await sqliteCountParticipants();
      const sqliteT1 = performance.now();
      console.log(
        `[bench] countParticipants  Dexie ${(dexieT1 - dexieT0).toFixed(1)}ms (${dexieCount})  |  ` +
          `SQLite ${(sqliteT1 - sqliteT0).toFixed(1)}ms (${sqliteCount})`
      );

      setActiveBackend('sqlite');
      setSqliteReady(true);
      setBackendVersion((v) => v + 1);
      return true;
    } catch (err) {
      console.error('[sqlite-proto] activation failed', err);
      setSeedProgress(null);
      return false;
    }
  }, []);

  const handleSqliteToggle = useCallback((checked: boolean) => {
    setSqliteEnabled(checked);
    setSqlitePrototypeEnabled(checked);
    if (checked) {
      activateSqlite();
    } else {
      setActiveBackend('dexie');
      setSqliteReady(false);
      setSeedProgress(null);
      setBackendVersion((v) => v + 1);
    }
  }, [activateSqlite]);

  // Restore active backend on mount if the preference was previously enabled.
  useEffect(() => {
    if (sqliteEnabled) {
      activateSqlite();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCancelSeed = useCallback(() => {
    cancelSqliteSeeding();
  }, []);
  // -------------------------------------------------------------------------

  const [debouncedSearch, isSearchPending] = useDebouncedValue(search, PAGE_DEBOUNCE.Transactions);

  const txDbSignal = useDbChangeSignal(['blockchainTransactions', 'transactionParticipants', 'records'], 500);

  const needsClientSideFiltering = debouncedSearch.trim() !== '' ||
    searchFilters.amountMode !== 'any' ||
    searchFilters.dateMode !== 'any';

  useEffect(() => {
    if (!needsClientSideFiltering) {
      setVirtualizedStats(null);
    }
  }, [needsClientSideFiltering]);

  const curatedRecords = useLiveQuery(
    async () => {
      if (includeBlockchainDiscovered) return null;
      return getAddressRecordsByImportanceTiers(USER_CURATED_TIERS);
    },
    [includeBlockchainDiscovered]
  );

  const { value: userCuratedTxidSet, isComputing: userCuratedTxidSetComputing } = useAsyncMemo(async (signal) => {
    if (includeBlockchainDiscovered) return new Set<string>();
    if (!curatedRecords || curatedRecords.length === 0) return new Set<string>();

    const recordIds = curatedRecords
      .filter(r => r.id !== undefined)
      .map(r => r.id as number);

    if (recordIds.length === 0) return new Set<string>();

    const txids = new Set<string>();
    const batchSize = 500;
    for (let i = 0; i < recordIds.length; i += batchSize) {
      checkAbort(signal);
      const batch = recordIds.slice(i, i + batchSize);
      const matchingParticipants = await getParticipantsByRecordIds(batch);
      matchingParticipants.forEach(p => txids.add(p.txid));
      if (i + batchSize < recordIds.length) await yieldToUI();
    }
    return txids;
  }, [curatedRecords, includeBlockchainDiscovered], new Set<string>());

  const { value: txCounts } = useAsyncMemo(async (signal) => {
    const totalDbCount = await countTransactions();
    checkAbort(signal);

    let filteredCount: number;
    if (includeBlockchainDiscovered && !opReturnOnly) {
      filteredCount = totalDbCount;
    } else if (includeBlockchainDiscovered && opReturnOnly) {
      filteredCount = await countTransactionsWithOpReturn();
      checkAbort(signal);
    } else if (!includeBlockchainDiscovered && opReturnOnly) {
      let count = 0;
      const txidArray = Array.from(userCuratedTxidSet);
      const batchSize = 500;
      for (let i = 0; i < txidArray.length; i += batchSize) {
        const batch = txidArray.slice(i, i + batchSize);
        const txs = await getTransactionsByTxids(batch);
        count += txs.filter(tx => tx.hasOpReturn).length;
        checkAbort(signal);
      }
      filteredCount = count;
    } else {
      filteredCount = userCuratedTxidSet.size;
    }

    const blockchainOnlyCount = includeBlockchainDiscovered ? 0
      : Math.max(0, totalDbCount - userCuratedTxidSet.size);

    return { totalDbCount, filteredCount, blockchainOnlyCount };
  }, [includeBlockchainDiscovered, opReturnOnly, userCuratedTxidSet, txDbSignal],
     { totalDbCount: 0, filteredCount: 0, blockchainOnlyCount: 0 });

  const blockchainOnlyTxCount = txCounts.blockchainOnlyCount;

  const totalFilteredCountForOffset = txCounts.filteredCount;
  const totalPagesForOffset = Math.max(1, Math.ceil(totalFilteredCountForOffset / ITEMS_PER_PAGE));
  const safePageForOffset = Math.min(currentPage, totalPagesForOffset);
  const dbOffset = (safePageForOffset - 1) * ITEMS_PER_PAGE;

  const { value: loadedTransactions, isComputing: txLoading } = useAsyncMemo(async (signal) => {
    if (needsClientSideFiltering) return [] as BlockchainTransaction[];

    const needsFilter = !includeBlockchainDiscovered || opReturnOnly;

    if (!needsFilter) {
      return getTransactionsPageByBlockTime(dbOffset, ITEMS_PER_PAGE);
    }

    if (includeBlockchainDiscovered && opReturnOnly) {
      return getOpReturnTransactionsPageByBlockTime(dbOffset, ITEMS_PER_PAGE);
    }

    const txidArray = Array.from(userCuratedTxidSet);
    const allCurated: BlockchainTransaction[] = [];
    const batchSize = 500;
    for (let i = 0; i < txidArray.length; i += batchSize) {
      checkAbort(signal);
      const batch = txidArray.slice(i, i + batchSize);
      const batchTxs = await getTransactionsByTxids(batch);
      allCurated.push(...batchTxs);
      if (i + batchSize < txidArray.length) await yieldToUI();
    }

    const filtered = opReturnOnly ? allCurated.filter(tx => tx.hasOpReturn) : allCurated;
    filtered.sort((a, b) => (b.blockTime ?? 0) - (a.blockTime ?? 0));
    return filtered.slice(dbOffset, dbOffset + ITEMS_PER_PAGE);
  }, [needsClientSideFiltering, includeBlockchainDiscovered, userCuratedTxidSet, opReturnOnly,
      dbOffset, txDbSignal],
     [] as BlockchainTransaction[]);

  const { value: scanResult, isComputing: scanLoading } = useAsyncMemo(async (signal) => {
    if (!needsClientSideFiltering) {
      setSearchProgress(null);
      return { matches: [] as BlockchainTransaction[], totalMatchCount: 0, limitReached: false, totalLinkedAddressCount: 0 };
    }

    const hasDateFilter = searchFilters.dateMode !== 'any';
    const hasAmountFilter = searchFilters.amountMode !== 'any';
    const hasTextSearch = debouncedSearch.trim() !== '';
    const needsParticipants = hasTextSearch || hasAmountFilter;
    const searchLower = debouncedSearch.trim().toLowerCase();
    const BATCH_SIZE = 500;

    const addressRecordMap = new Map<string, Record>();
    if (curatedRecords) {
      for (const r of curatedRecords) {
        if (r.type === 'address' && r.inputString) {
          addressRecordMap.set(r.inputString, r);
        }
      }
    }

    const allMatches: BlockchainTransaction[] = [];
    let totalMatchCount = 0;
    let scanned = 0;
    let scanTotal = 0;
    const totalLinkedAddresses = new Set<string>();

    async function filterBatch(batch: BlockchainTransaction[]): Promise<BlockchainTransaction[]> {
      let filtered = batch;

      if (hasDateFilter) {
        const dateOnlyFilters: SearchFilters = { ...searchFilters, amountMode: 'any' as const };
        filtered = filterByDateAndAmount(filtered, dateOnlyFilters, tx => tx.blockTime, () => 0);
      }

      if (filtered.length === 0) return filtered;

      if (!needsParticipants) {
        if (addressRecordMap.size > 0) {
          const txids = filtered.map(tx => tx.txid);
          const participants = await getParticipantsByTxids(txids);
          checkAbort(signal);
          for (const p of participants) {
            if (addressRecordMap.has(p.address)) {
              totalLinkedAddresses.add(p.address);
            }
          }
        }
        return filtered;
      }

      const txids = filtered.map(tx => tx.txid);
      const participants = await getParticipantsByTxids(txids);
      checkAbort(signal);

      const partMap = new Map<string, TransactionParticipant[]>();
      for (const p of participants) {
        const arr = partMap.get(p.txid) || [];
        arr.push(p);
        partMap.set(p.txid, arr);
      }

      if (hasTextSearch) {
        const missingRecordIds = new Set<number>();
        for (const parts of partMap.values()) {
          for (const p of parts) {
            if (p.recordId != null && !addressRecordMap.has(p.address)) {
              missingRecordIds.add(p.recordId);
            }
          }
        }
        if (missingRecordIds.size > 0) {
          const records = await bulkGetRecords(Array.from(missingRecordIds));
          checkAbort(signal);
          for (const r of records) {
            if (r && r.type === 'address' && r.inputString) {
              addressRecordMap.set(r.inputString, r);
            }
          }
        }
      }

      if (hasAmountFilter) {
        const amountOnlyFilters: SearchFilters = { ...searchFilters, dateMode: 'any' as const };
        filtered = filterByDateAndAmount(
          filtered,
          amountOnlyFilters,
          tx => tx.blockTime,
          tx => {
            const parts = partMap.get(tx.txid) || [];
            return parts.filter(p => p.role === 'output').reduce((sum, p) => sum + p.amount, 0);
          }
        );
      }

      if (hasTextSearch) {
        filtered = filtered.filter(tx => {
          if (tx.txid.toLowerCase().includes(searchLower)) return true;
          const txParts = partMap.get(tx.txid);
          if (txParts) {
            if (txParts.some(p => p.address.toLowerCase().includes(searchLower))) return true;
            const linkedRecords = txParts.map(p => addressRecordMap.get(p.address)).filter(Boolean);
            if (linkedRecords.some(r => r?.label?.toLowerCase().includes(searchLower))) return true;
          }
          return false;
        });
      }

      if (addressRecordMap.size > 0) {
        for (const tx of filtered) {
          const parts = partMap.get(tx.txid) || [];
          for (const p of parts) {
            if (addressRecordMap.has(p.address)) {
              totalLinkedAddresses.add(p.address);
            }
          }
        }
      }

      return filtered;
    }

    if (includeBlockchainDiscovered) {
      if (opReturnOnly) {
        const allKeys = await getOpReturnTransactionPrimaryKeys();
        checkAbort(signal);
        scanTotal = allKeys.length;
        setSearchProgress({ scanned: 0, total: scanTotal, matches: 0 });

        for (let i = 0; i < allKeys.length; i += BATCH_SIZE) {
          checkAbort(signal);
          const batchKeys = allKeys.slice(i, i + BATCH_SIZE);
          const batchRaw = await bulkGetTransactionsByPrimaryKeys(batchKeys);
          const batch = batchRaw.filter(Boolean) as BlockchainTransaction[];
          const matches = await filterBatch(batch);
          totalMatchCount += matches.length;
          if (allMatches.length < MAX_COLLECTED_MATCHES) {
            const room = MAX_COLLECTED_MATCHES - allMatches.length;
            allMatches.push(...matches.slice(0, room));
          }
          scanned += batchKeys.length;
          setSearchProgress({ scanned, total: scanTotal, matches: totalMatchCount });
          if (i + BATCH_SIZE < allKeys.length) await yieldToUI();
        }
      } else {
        const allKeys = await getOrderedTransactionPrimaryKeysByBlockTime();
        checkAbort(signal);
        scanTotal = allKeys.length;
        setSearchProgress({ scanned: 0, total: scanTotal, matches: 0 });

        for (let i = 0; i < allKeys.length; i += BATCH_SIZE) {
          checkAbort(signal);
          const batchKeys = allKeys.slice(i, i + BATCH_SIZE);
          const batchRaw = await bulkGetTransactionsByPrimaryKeys(batchKeys);
          const batch = batchRaw.filter(Boolean) as BlockchainTransaction[];
          const matches = await filterBatch(batch);
          totalMatchCount += matches.length;
          if (allMatches.length < MAX_COLLECTED_MATCHES) {
            const room = MAX_COLLECTED_MATCHES - allMatches.length;
            allMatches.push(...matches.slice(0, room));
          }
          scanned += batchKeys.length;
          setSearchProgress({ scanned, total: scanTotal, matches: totalMatchCount });
          if (i + BATCH_SIZE < allKeys.length) await yieldToUI();
        }
      }
    } else {
      const txidArray = Array.from(userCuratedTxidSet);
      scanTotal = txidArray.length;
      setSearchProgress({ scanned: 0, total: scanTotal, matches: 0 });

      for (let i = 0; i < txidArray.length; i += BATCH_SIZE) {
        checkAbort(signal);
        const batchTxids = txidArray.slice(i, i + BATCH_SIZE);
        let batch = await getTransactionsByTxids(batchTxids);
        if (opReturnOnly) {
          batch = batch.filter(tx => tx.hasOpReturn === true);
        }
        const matches = await filterBatch(batch);
        totalMatchCount += matches.length;
        if (allMatches.length < MAX_COLLECTED_MATCHES) {
          const room = MAX_COLLECTED_MATCHES - allMatches.length;
          allMatches.push(...matches.slice(0, room));
        }
        scanned += batchTxids.length;
        setSearchProgress({ scanned, total: scanTotal, matches: totalMatchCount });
        if (i + BATCH_SIZE < txidArray.length) await yieldToUI();
      }
    }

    allMatches.sort((a, b) => (b.blockTime ?? 0) - (a.blockTime ?? 0));
    setSearchProgress(null);
    return { matches: allMatches, totalMatchCount, limitReached: totalMatchCount > allMatches.length, totalLinkedAddressCount: totalLinkedAddresses.size };
  }, [needsClientSideFiltering, includeBlockchainDiscovered, opReturnOnly,
      userCuratedTxidSet, debouncedSearch, searchFilters, curatedRecords, txDbSignal],
     { matches: [] as BlockchainTransaction[], totalMatchCount: 0, limitReached: false, totalLinkedAddressCount: 0 });

  const needsBroadParticipants = debouncedSearch.trim() !== '' || searchFilters.amountMode !== 'any';

  const preFilteredTransactions = useMemo(() => {
    if (!needsClientSideFiltering) return loadedTransactions;

    let results = [...loadedTransactions];

    const hasDateFilter = searchFilters.dateMode !== 'any';
    if (hasDateFilter) {
      const dateOnlyFilters: SearchFilters = { ...searchFilters, amountMode: 'any' as const };
      results = filterByDateAndAmount(results, dateOnlyFilters, tx => tx.blockTime, () => 0);
    }

    return results;
  }, [loadedTransactions, needsClientSideFiltering, searchFilters]);

  const { value: broadParticipantMap } = useAsyncMemo(async (signal) => {
    if (!needsBroadParticipants || preFilteredTransactions.length === 0) {
      return new Map<string, TransactionParticipant[]>();
    }
    
    const txidsToLoad = preFilteredTransactions.map(tx => tx.txid);
    const allParticipants: TransactionParticipant[] = [];
    const batchSize = 500;
    for (let i = 0; i < txidsToLoad.length; i += batchSize) {
      checkAbort(signal);
      const batch = txidsToLoad.slice(i, i + batchSize);
      const batchParts = await getParticipantsByTxids(batch);
      allParticipants.push(...batchParts);
      if (i + batchSize < txidsToLoad.length) await yieldToUI();
    }
    
    const map = new Map<string, TransactionParticipant[]>();
    for (const p of allParticipants) {
      const existing = map.get(p.txid) || [];
      existing.push(p);
      map.set(p.txid, existing);
    }
    return map;
  }, [needsBroadParticipants, preFilteredTransactions, backendVersion], new Map<string, TransactionParticipant[]>());

  const { value: broadRecords } = useAsyncMemo(async (signal) => {
    const recordIds = new Set<number>();
    for (const parts of broadParticipantMap.values()) {
      for (const p of parts) {
        if (p.recordId != null) recordIds.add(p.recordId);
      }
    }
    if (recordIds.size === 0) return [] as Record[];
    const records = await bulkGetRecords(Array.from(recordIds));
    return records.filter(Boolean) as Record[];
  }, [broadParticipantMap], [] as Record[]);

  const searchAddressMap = useMemo(() => {
    const map = new Map<string, Record>();
    if (curatedRecords) {
      for (const record of curatedRecords) {
        if (record.type === 'address' && record.inputString) {
          map.set(record.inputString, record);
        }
      }
    }
    for (const record of broadRecords) {
      if (record.type === 'address' && record.inputString) {
        map.set(record.inputString, record);
      }
    }
    return map;
  }, [curatedRecords, broadRecords]);

  const filteredTransactions = useMemo(() => {
    if (needsClientSideFiltering) return scanResult.matches;
    return loadedTransactions;
  }, [needsClientSideFiltering, scanResult.matches, loadedTransactions]);

  const totalFilteredCount = needsClientSideFiltering
    ? scanResult.totalMatchCount
    : txCounts.filteredCount;
  const navigableCount = needsClientSideFiltering
    ? filteredTransactions.length
    : txCounts.filteredCount;
  const totalPages = Math.max(1, Math.ceil(navigableCount / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);
  const startIndex = (safePage - 1) * ITEMS_PER_PAGE;
  const paginatedTransactionSlice = needsClientSideFiltering
    ? filteredTransactions.slice(startIndex, startIndex + ITEMS_PER_PAGE)
    : filteredTransactions;

  const { value: pageParticipantMap } = useAsyncMemo(async (signal) => {
    if (needsClientSideFiltering) return new Map<string, TransactionParticipant[]>();
    const txids = paginatedTransactionSlice.map(tx => tx.txid);
    if (txids.length === 0) return new Map<string, TransactionParticipant[]>();
    
    if (needsBroadParticipants && broadParticipantMap.size > 0) {
      const map = new Map<string, TransactionParticipant[]>();
      for (const txid of txids) {
        if (broadParticipantMap.has(txid)) {
          map.set(txid, broadParticipantMap.get(txid)!);
        }
      }
      const missingTxids = txids.filter(t => !map.has(t));
      if (missingTxids.length > 0) {
        const extra = await getParticipantsByTxids(missingTxids);
        checkAbort(signal);
        for (const p of extra) {
          const existing = map.get(p.txid) || [];
          existing.push(p);
          map.set(p.txid, existing);
        }
      }
      return map;
    }
    
    const loaded = await getParticipantsByTxids(txids);
    checkAbort(signal);
    const map = new Map<string, TransactionParticipant[]>();
    for (const p of loaded) {
      const existing = map.get(p.txid) || [];
      existing.push(p);
      map.set(p.txid, existing);
    }
    return map;
  }, [needsClientSideFiltering, paginatedTransactionSlice, needsBroadParticipants, broadParticipantMap, backendVersion], new Map<string, TransactionParticipant[]>());

  const { value: pageRecords } = useAsyncMemo(async (signal) => {
    const recordIds = new Set<number>();
    for (const parts of pageParticipantMap.values()) {
      for (const p of parts) {
        if (p.recordId != null) recordIds.add(p.recordId);
      }
    }
    if (recordIds.size === 0) return [] as Record[];
    const records = await bulkGetRecords(Array.from(recordIds));
    return records.filter(Boolean) as Record[];
  }, [pageParticipantMap], [] as Record[]);

  const addressToRecord = useMemo(() => {
    const map = new Map<string, Record>(searchAddressMap);
    for (const record of pageRecords) {
      if (record.type === 'address' && record.inputString) {
        map.set(record.inputString, record);
      }
    }
    return map;
  }, [searchAddressMap, pageRecords]);

  const toggleExpanded = (txid: string) => {
    setExpandedTxs(prev => {
      const newSet = new Set(prev);
      if (newSet.has(txid)) {
        newSet.delete(txid);
      } else {
        newSet.add(txid);
      }
      return newSet;
    });
  };

  const perTxParticipants = useMemo(() => {
    const result = new Map<string, { inputs: TransactionParticipant[]; outputs: TransactionParticipant[]; totalOutputValue: number }>();
    for (const tx of paginatedTransactionSlice) {
      const parts = pageParticipantMap.get(tx.txid) || [];
      const inputs: TransactionParticipant[] = [];
      const outputs: TransactionParticipant[] = [];
      let totalOutputValue = 0;
      for (const p of parts) {
        if (p.role === 'input') {
          inputs.push(p);
        } else {
          outputs.push(p);
          totalOutputValue += p.amount;
        }
      }
      result.set(tx.txid, { inputs, outputs, totalOutputValue });
    }
    return result;
  }, [paginatedTransactionSlice, pageParticipantMap]);

  const stats = useMemo(() => {
    const txCount = totalFilteredCount;

    if (needsClientSideFiltering) {
      const allNavigableFees = filteredTransactions.reduce((sum, tx) => sum + tx.fee, 0);
      return {
        txCount,
        pageVolume: virtualizedStats ? virtualizedStats.loadedVolume : null as number | null,
        pageFees: allNavigableFees,
        allNavigableFees,
        linkedAddressCount: virtualizedStats ? virtualizedStats.loadedLinkedAddressCount : null as number | null,
        isPartialStats: true,
        loadedTxCount: virtualizedStats?.loadedTxCount ?? 0,
      };
    }

    const pageFees = paginatedTransactionSlice.reduce((sum, tx) => sum + tx.fee, 0);
    let pageVolume = 0;
    const linkedAddresses = new Set<string>();
    for (const tx of paginatedTransactionSlice) {
      const entry = perTxParticipants.get(tx.txid);
      if (entry) {
        pageVolume += entry.totalOutputValue;
        for (const p of entry.inputs) {
          if (addressToRecord.has(p.address)) linkedAddresses.add(p.address);
        }
        for (const p of entry.outputs) {
          if (addressToRecord.has(p.address)) linkedAddresses.add(p.address);
        }
      }
    }
    const allNavigableFees = filteredTransactions.reduce((sum, tx) => sum + tx.fee, 0);

    return {
      txCount,
      pageVolume,
      pageFees,
      allNavigableFees,
      linkedAddressCount: linkedAddresses.size,
      isPartialStats: false,
      loadedTxCount: paginatedTransactionSlice.length,
    };
  }, [totalFilteredCount, paginatedTransactionSlice, perTxParticipants, filteredTransactions, addressToRecord, needsClientSideFiltering, virtualizedStats]);

  const expandAllSource = useMemo(() => {
    return needsClientSideFiltering
      ? filteredTransactions.slice(0, EXPAND_ALL_SEARCH_CAP)
      : paginatedTransactionSlice;
  }, [needsClientSideFiltering, filteredTransactions, paginatedTransactionSlice]);

  const allExpanded = useMemo(() => {
    return expandAllSource.length > 0 && expandAllSource.every(tx => expandedTxs.has(tx.txid));
  }, [expandAllSource, expandedTxs]);

  const filteredTxIdentity = useMemo(() => {
    if (filteredTransactions.length === 0) return '';
    let h = 0x811c9dc5;
    for (const tx of filteredTransactions) {
      const id = tx.txid;
      for (let i = 0; i < id.length; i++) {
        h ^= id.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
    }
    return `${filteredTransactions.length}:${h >>> 0}`;
  }, [filteredTransactions]);

  const filteredTxRef = useRef(filteredTransactions);
  filteredTxRef.current = filteredTransactions;

  const [volumeProgress, setVolumeProgress] = useState<{ processed: number; total: number } | null>(null);

  const { value: allNavigableVolume, isComputing: volumeComputing } = useAsyncMemo(async (signal) => {
    if (!needsClientSideFiltering || filteredTxIdentity === '') {
      setVolumeProgress(null);
      return null;
    }

    const txs = filteredTxRef.current;
    const txids = txs.map(tx => tx.txid);
    const total = txids.length;
    setVolumeProgress({ processed: 0, total });
    let totalVolume = 0;
    const BATCH_SIZE = 500;

    for (let i = 0; i < txids.length; i += BATCH_SIZE) {
      checkAbort(signal);
      const batch = txids.slice(i, i + BATCH_SIZE);
      const participants = await getParticipantsByTxids(batch);
      checkAbort(signal);
      for (const p of participants) {
        if (p.role === 'output') {
          totalVolume += p.amount;
        }
      }
      setVolumeProgress({ processed: Math.min(i + BATCH_SIZE, total), total });
      if (i + BATCH_SIZE < txids.length) await yieldToUI();
    }

    return totalVolume;
  }, [needsClientSideFiltering, filteredTxIdentity], null as number | null);

  const isLoading = needsClientSideFiltering ? scanLoading : txLoading;

  return (
    <div className="flex flex-col h-full overflow-hidden p-4 gap-4">
      <div className="flex-none flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Blockchain Transactions</h1>
          <p className="text-muted-foreground mt-1">
            View synced transaction data with amounts, fees, and linked addresses
          </p>
        </div>
        <div className="flex flex-col items-end gap-3">
          <BlockchainToggle
            checked={includeBlockchainDiscovered}
            onCheckedChange={(checked) => {
              setIncludeBlockchainDiscovered(checked);
              setCurrentPage(1);
            }}
            hiddenCount={blockchainOnlyTxCount}
          />
          <div className="flex flex-col items-end gap-1.5" data-testid="sqlite-prototype-toggle">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm">SQLite-WASM prototype</span>
              <Switch
                checked={sqliteEnabled}
                onCheckedChange={handleSqliteToggle}
                disabled={!!seedProgress}
                data-testid="switch-sqlite-backend"
              />
            </div>
            {seedProgress ? (
              <div className="flex items-center gap-2" data-testid="text-seed-progress">
                <div className="w-40 h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-300"
                    style={{
                      width: `${seedProgress.total > 0 ? Math.min(100, (seedProgress.processed / seedProgress.total) * 100) : 0}%`,
                    }}
                  />
                </div>
                <span className="text-xs text-muted-foreground tabular-nums">
                  Seeding {seedProgress.processed.toLocaleString()}/{seedProgress.total.toLocaleString()}
                </span>
                <button
                  className="text-xs text-muted-foreground underline hover-elevate rounded-md px-1"
                  onClick={handleCancelSeed}
                  data-testid="button-cancel-seed"
                >
                  Cancel
                </button>
              </div>
            ) : sqliteEnabled && sqliteReady ? (
              <span className="text-xs text-muted-foreground" data-testid="text-sqlite-status">
                Active{sqliteStorageMode ? ` · ${sqliteStorageMode === 'opfs-sahpool' ? 'OPFS (persistent)' : 'in-memory (fallback)'}` : ''} · benchmarks in console
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {/* Stats Overview */}
      <div className="grid gap-4 sm:grid-cols-4 flex-none">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Transactions</CardDescription>
            <CardTitle className="text-2xl" data-testid="text-total-transactions">
              {scanResult.limitReached ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-1 cursor-help" tabIndex={0} data-testid="indicator-approx-count">
                      <span>~{stats.txCount.toLocaleString()}</span>
                      <Info className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs">
                    <p>
                      Found {scanResult.totalMatchCount.toLocaleString()} total matches, but only the
                      first {navigableCount.toLocaleString()} are navigable due to memory limits.
                      Try narrowing your search filters.
                    </p>
                  </TooltipContent>
                </Tooltip>
              ) : (
                stats.txCount.toLocaleString()
              )}
            </CardTitle>
          </CardHeader>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{needsClientSideFiltering ? (volumeComputing ? 'Loaded Volume' : 'Volume') : 'Page Volume'}</CardDescription>
            <CardTitle className="text-2xl" data-testid="text-total-volume">
              {needsClientSideFiltering ? (
                volumeComputing ? (
                  stats.pageVolume !== null ? (
                    <div className="flex flex-col">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex items-center gap-1 cursor-help" tabIndex={0} data-testid="indicator-loaded-volume">
                            <span>{satsToBtc(stats.pageVolume)} BTC</span>
                            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="max-w-xs">
                          <p>
                            Volume from {stats.loadedTxCount.toLocaleString()} of {navigableCount.toLocaleString()} transactions
                            loaded so far.
                            {volumeProgress && volumeProgress.total > 0
                              ? ` Computing total… ${volumeProgress.processed.toLocaleString()} / ${volumeProgress.total.toLocaleString()}`
                              : " Computing total…"}
                          </p>
                        </TooltipContent>
                      </Tooltip>
                      <span className="text-xs text-muted-foreground" data-testid="text-volume-fraction">
                        {stats.loadedTxCount.toLocaleString()}/{navigableCount.toLocaleString()} txs loaded
                      </span>
                    </div>
                  ) : (
                    <span className="inline-flex items-center gap-2" data-testid="indicator-volume-loading">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                      <span className="text-muted-foreground text-base">
                        {volumeProgress && volumeProgress.total > 0
                          ? `Computing… ${volumeProgress.processed.toLocaleString()} / ${volumeProgress.total.toLocaleString()}`
                          : "Computing…"}
                      </span>
                    </span>
                  )
                ) : allNavigableVolume !== null ? (
                  scanResult.limitReached ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex items-center gap-1 cursor-help" tabIndex={0} data-testid="indicator-approx-volume">
                          <span>{satsToBtc(allNavigableVolume)} BTC</span>
                          <Info className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="max-w-xs">
                        <p>
                          Volume across {navigableCount.toLocaleString()} navigable matches.
                          Total search matched {scanResult.totalMatchCount.toLocaleString()} transactions.
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <>{satsToBtc(allNavigableVolume)} BTC</>
                  )
                ) : (
                  <span className="text-muted-foreground">—</span>
                )
              ) : (
                <>{satsToBtc(stats.pageVolume)} BTC</>
              )}
            </CardTitle>
          </CardHeader>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{needsClientSideFiltering ? 'Total Fees' : 'Page Fees'}</CardDescription>
            <CardTitle className="text-2xl" data-testid="text-total-fees">
              {scanResult.limitReached ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-1 cursor-help" tabIndex={0} data-testid="indicator-approx-fees">
                      <span>{formatSats(stats.pageFees)}</span>
                      <Info className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs">
                    <p>
                      {needsClientSideFiltering
                        ? `Showing fees for ${navigableCount.toLocaleString()} navigable matches. Total search matched ${scanResult.totalMatchCount.toLocaleString()} transactions.`
                        : `Showing fees for page ${safePage} of ${totalPages} only. Navigable total (${navigableCount.toLocaleString()} matches): ${formatSats(stats.allNavigableFees)}.`
                      }
                    </p>
                  </TooltipContent>
                </Tooltip>
              ) : (
                formatSats(stats.pageFees)
              )}
            </CardTitle>
          </CardHeader>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{stats.isPartialStats && !scanResult.limitReached ? 'Loaded Linked Addresses' : 'Linked Addresses'}</CardDescription>
            <CardTitle className="text-2xl" data-testid="text-linked-addresses">
              {stats.linkedAddressCount === null ? (
                <span className="text-muted-foreground">—</span>
              ) : scanResult.limitReached ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-1 cursor-help" tabIndex={0} data-testid="indicator-approx-addresses">
                      <span>{scanResult.totalLinkedAddressCount.toLocaleString()}</span>
                      <Info className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs">
                    <p>
                      Linked addresses across all {scanResult.totalMatchCount.toLocaleString()} matched transactions.
                      Only {navigableCount.toLocaleString()} matches are navigable.
                    </p>
                  </TooltipContent>
                </Tooltip>
              ) : stats.isPartialStats ? (
                <div className="flex flex-col">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex items-center gap-1 cursor-help" tabIndex={0} data-testid="indicator-loaded-addresses">
                        <span>{stats.linkedAddressCount.toLocaleString()}</span>
                        <Info className="h-4 w-4 text-muted-foreground" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-xs">
                      <p>
                        Linked addresses found in {stats.loadedTxCount.toLocaleString()} of {navigableCount.toLocaleString()} transactions
                        loaded so far. Scroll to load more.
                      </p>
                    </TooltipContent>
                  </Tooltip>
                  <span className="text-xs text-muted-foreground" data-testid="text-addresses-fraction">
                    {stats.loadedTxCount.toLocaleString()}/{navigableCount.toLocaleString()} txs loaded
                  </span>
                </div>
              ) : (
                stats.linkedAddressCount.toLocaleString()
              )}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Search and Filters */}
      <div className="flex-none flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          {isSearchPending ? (
            <Loader2 className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground animate-spin" data-testid="icon-search-pending" />
          ) : (
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          )}
          <Input
            placeholder="Search by txid, address, or label..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setCurrentPage(1);
            }}
            className="pl-10"
            data-testid="input-search"
          />
        </div>
        <TransactionSearchFilters
          filters={searchFilters}
          onChange={(filters) => {
            setSearchFilters(filters);
            setCurrentPage(1);
          }}
          onClear={() => {
            setSearchFilters(defaultFilters);
            setCurrentPage(1);
          }}
        />
        <Button
          variant={opReturnOnly ? "default" : "outline"}
          size="sm"
          onClick={() => {
            setOpReturnOnly(!opReturnOnly);
            setCurrentPage(1);
          }}
          className={opReturnOnly ? "bg-purple-600 hover:bg-purple-700 text-white" : ""}
          data-testid="button-opreturn-filter"
        >
          <FileCode className="h-4 w-4 mr-1" />
          OP_RETURN
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (allExpanded) {
              setExpandedTxs(new Set());
            } else {
              setExpandedTxs(new Set(expandAllSource.map(tx => tx.txid)));
            }
          }}
          data-testid="button-expand-collapse-all"
        >
          {allExpanded ? (
            <>
              <ChevronsDownUp className="h-4 w-4 mr-1" />
              Collapse All
            </>
          ) : (
            <>
              <ChevronsUpDown className="h-4 w-4 mr-1" />
              {needsClientSideFiltering && filteredTransactions.length > EXPAND_ALL_SEARCH_CAP
                ? `Expand First ${EXPAND_ALL_SEARCH_CAP}`
                : 'Expand All'}
            </>
          )}
        </Button>
      </div>

      <div className={`flex-1 flex flex-col gap-4 min-h-0 ${searchPendingClass(isSearchPending, 'Transactions')}`}>
      {scanResult.limitReached && (
        <div className="flex-none flex items-center gap-3 p-3 rounded-md bg-yellow-50 dark:bg-yellow-950/50 border border-yellow-200 dark:border-yellow-800 text-sm" data-testid="warning-search-limit">
          <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400 flex-shrink-0" />
          <span className="text-yellow-800 dark:text-yellow-200">
            Your search matched {scanResult.totalMatchCount.toLocaleString()} transactions, but only the first {MAX_COLLECTED_MATCHES.toLocaleString()} are shown. Try narrowing your search with more specific filters to see all results.
          </span>
        </div>
      )}

      {/* Transaction List */}
      {needsClientSideFiltering && !isLoading && filteredTransactions.length > 0 ? (
        <VirtualizedTransactionList
          transactions={filteredTransactions}
          expandedTxs={expandedTxs}
          toggleExpanded={toggleExpanded}
          baseAddressToRecord={addressToRecord}
          onStatsChange={handleVirtualizedStatsChange}
          backendVersion={backendVersion}
        />
      ) : (
        <div className="flex-1 overflow-y-auto space-y-3">
          {isLoading ? (
            searchProgress ? (
              <div className="flex flex-col items-center justify-center h-32 gap-3" data-testid="search-progress">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>
                    Searching... {searchProgress.scanned.toLocaleString()} of{' '}
                    {searchProgress.total > 0 ? searchProgress.total.toLocaleString() : '...'} scanned
                    {searchProgress.matches > 0 && (
                      <> ({searchProgress.matches.toLocaleString()} {searchProgress.matches === 1 ? 'match' : 'matches'} found)</>
                    )}
                  </span>
                </div>
                {searchProgress.total > 0 && (
                  <div className="w-64 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full transition-all duration-300"
                      style={{ width: `${Math.min(100, (searchProgress.scanned / searchProgress.total) * 100)}%` }}
                    />
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center justify-center h-32">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
              </div>
            )
          ) : paginatedTransactionSlice.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <p className="text-muted-foreground">
                  {search || hasActiveSearchFilters(searchFilters) ? "No transactions match your search" : "No transactions synced yet"}
                </p>
                {!search && !hasActiveSearchFilters(searchFilters) && (
                  <p className="text-sm text-muted-foreground mt-2">
                    Use Transaction Sync to fetch blockchain data for your addresses
                  </p>
                )}
              </CardContent>
            </Card>
          ) : (
            paginatedTransactionSlice.map((tx) => {
              const entry = perTxParticipants.get(tx.txid);
              const inputs = entry?.inputs || [];
              const outputs = entry?.outputs || [];
              return (
                <TransactionCard
                  key={tx.txid}
                  tx={tx}
                  inputs={inputs}
                  outputs={outputs}
                  totalOutputValue={entry?.totalOutputValue || 0}
                  isExpanded={expandedTxs.has(tx.txid)}
                  onToggleExpand={() => toggleExpanded(tx.txid)}
                  addressToRecord={addressToRecord}
                />
              );
            })
          )}
        </div>
      )}

      {/* Pagination - only for non-search mode */}
      {!needsClientSideFiltering && navigableCount > ITEMS_PER_PAGE && (
        <div className="flex items-center justify-between border-t pt-4 flex-none">
          <div className="text-sm text-muted-foreground">
            Showing {startIndex + 1}-{Math.min(startIndex + ITEMS_PER_PAGE, navigableCount)} of{' '}
            {navigableCount.toLocaleString()} transactions
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={safePage === 1}
              data-testid="button-prev-page"
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              Previous
            </Button>
            <span className="text-sm px-2">
              Page {safePage} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={safePage === totalPages}
              data-testid="button-next-page"
            >
              Next
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </div>
      )}

      {/* Virtual scroll results count */}
      {needsClientSideFiltering && !isLoading && filteredTransactions.length > 0 && (
        <div className="flex items-center justify-center border-t pt-3 flex-none text-sm text-muted-foreground" data-testid="text-virtual-scroll-count">
          {filteredTransactions.length.toLocaleString()} transactions
          {scanResult.limitReached && (
            <span className="ml-1">(of {scanResult.totalMatchCount.toLocaleString()} total matches)</span>
          )}
          <span className="ml-1">&mdash; scroll to browse</span>
        </div>
      )}
      </div>
    </div>
  );
}

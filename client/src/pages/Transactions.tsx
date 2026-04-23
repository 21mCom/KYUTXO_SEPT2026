import { useState, useMemo, useEffect, useRef } from "react";
import { useAsyncMemo, yieldToUI, checkAbort } from "@/hooks/use-async-memo";
import { useLiveQuery } from "dexie-react-hooks";
import { format } from "date-fns";
import { db, BlockchainTransaction, TransactionParticipant, Record } from "@/lib/database";
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
  ChevronsUpDown
} from "lucide-react";
import { getParticipantsByTxids } from "@/lib/dataFacade";
import { ClickableAddress } from "@/components/ClickableAddress";

const ITEMS_PER_PAGE = 25;

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

interface TransactionWithParticipants extends BlockchainTransaction {
  inputs: TransactionParticipant[];
  outputs: TransactionParticipant[];
  totalInputValue: number;
  totalOutputValue: number;
}

// User-curated importance tiers (exclude blockchain-discovered and pending-review by default)
const USER_CURATED_TIERS = ['verified', 'manual', 'wallet-import', 'xpub-derived'];

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

  const allTransactions = useLiveQuery(
    () => db.blockchainTransactions.orderBy('blockTime').reverse().toArray(),
    []
  );

  // Fetch records using compound index [type+addressImportance] for zero-scan filtering
  // After v14 migration, all records have addressImportance set
  const rawRecords = useLiveQuery(
    async () => {
      if (includeBlockchainDiscovered) {
        // Load all address records using type index
        return db.records.where('type').equals('address').toArray();
      } else {
        // Use compound index for efficient filtering without table scans
        return db.records
          .where('[type+addressImportance]')
          .anyOf(USER_CURATED_TIERS.map(tier => ['address', tier]))
          .toArray();
      }
    },
    [includeBlockchainDiscovered]
  );
  
  // Process records to get addresses
  const [processedRecords, setProcessedRecords] = useState<Record[]>([]);
  // Use a ref to track the latest request ID and prevent stale async updates
  const requestId = useRef(0);
  
  useEffect(() => {
    if (!rawRecords) return;
    
    // Increment request ID for this call - use ref to ensure we can check latest value
    requestId.current += 1;
    const thisRequestId = requestId.current;
    
    const processRecords = async () => {
      try {
        const records = rawRecords;
        // Only update if this is still the latest request
        if (thisRequestId === requestId.current) {
          setProcessedRecords(records);
        }
      } catch {
        // On failure, use raw records as fallback only if this is latest request
        if (thisRequestId === requestId.current) {
          setProcessedRecords(prev => prev.length === 0 ? rawRecords : prev);
        }
      }
    };
    
    processRecords();
  }, [rawRecords]);

  // Build address -> record lookup
  const addressToRecord = useMemo(() => {
    const map = new Map<string, Record>();
    processedRecords.forEach(record => {
      if (record.type === 'address' && record.inputString) {
        map.set(record.inputString, record);
      }
    });
    return map;
  }, [processedRecords]);

  const { value: userCuratedTxidSet, isComputing: userCuratedTxidSetComputing } = useAsyncMemo(async (signal) => {
    if (!processedRecords || processedRecords.length === 0) return new Set<string>();
    
    const recordIds = processedRecords
      .filter(r => r.id !== undefined)
      .map(r => r.id as number);
    
    if (recordIds.length === 0) return new Set<string>();
    
    const txids = new Set<string>();
    const batchSize = 500;
    for (let i = 0; i < recordIds.length; i += batchSize) {
      checkAbort(signal);
      const batch = recordIds.slice(i, i + batchSize);
      const matchingParticipants = await db.transactionParticipants
        .where('recordId')
        .anyOf(batch)
        .toArray();
      matchingParticipants.forEach(p => txids.add(p.txid));
      if (i + batchSize < recordIds.length) await yieldToUI();
    }
    return txids;
  }, [processedRecords], new Set<string>());

  const blockchainOnlyTxCount = useMemo(() => {
    if (!allTransactions || userCuratedTxidSetComputing) return 0;
    let count = 0;
    for (const tx of allTransactions) {
      if (!userCuratedTxidSet.has(tx.txid)) count++;
    }
    return count;
  }, [allTransactions, userCuratedTxidSet, userCuratedTxidSetComputing]);

  const needsBroadParticipants = search.trim() !== '' || searchFilters.amountMode !== 'any';

  const preFilteredTransactions = useMemo(() => {
    if (!allTransactions) return [];
    let results = [...allTransactions];
    
    if (!includeBlockchainDiscovered) {
      results = results.filter(tx => userCuratedTxidSet.has(tx.txid));
    }
    
    if (opReturnOnly) {
      results = results.filter(tx => tx.hasOpReturn === true);
    }
    
    const hasDateFilter = searchFilters.dateMode !== 'any';
    if (hasDateFilter) {
      const dateOnlyFilters: SearchFilters = { ...searchFilters, amountMode: 'any' as const };
      results = filterByDateAndAmount(results, dateOnlyFilters, tx => tx.blockTime, () => 0);
    }
    
    return results;
  }, [allTransactions, includeBlockchainDiscovered, userCuratedTxidSet, searchFilters, opReturnOnly]);

  const { value: broadParticipantMap } = useAsyncMemo(async (signal) => {
    if (!needsBroadParticipants || preFilteredTransactions.length === 0) {
      return new Map<string, TransactionParticipant[]>();
    }
    
    const maxTxidsForBroadLoad = 2000;
    const txidsToLoad = preFilteredTransactions.slice(0, maxTxidsForBroadLoad).map(tx => tx.txid);
    const loadedParticipants = await getParticipantsByTxids(txidsToLoad);
    checkAbort(signal);
    
    const map = new Map<string, TransactionParticipant[]>();
    for (const p of loadedParticipants) {
      const existing = map.get(p.txid) || [];
      existing.push(p);
      map.set(p.txid, existing);
    }
    return map;
  }, [needsBroadParticipants, preFilteredTransactions], new Map<string, TransactionParticipant[]>());

  const filteredTransactions = useMemo(() => {
    let results = preFilteredTransactions;
    
    if (searchFilters.amountMode !== 'any' && broadParticipantMap.size > 0) {
      const amountOnlyFilters: SearchFilters = { ...searchFilters, dateMode: 'any' as const };
      results = filterByDateAndAmount(
        results.filter(tx => broadParticipantMap.has(tx.txid)),
        amountOnlyFilters,
        (tx) => tx.blockTime,
        (tx) => {
          const parts = broadParticipantMap.get(tx.txid) || [];
          return parts.filter(p => p.role === 'output').reduce((sum, p) => sum + p.amount, 0);
        }
      );
    }
    
    if (search.trim()) {
      const searchLower = search.toLowerCase();
      results = results.filter(tx => {
        if (tx.txid.toLowerCase().includes(searchLower)) return true;
        
        const txParts = broadParticipantMap.get(tx.txid);
        if (txParts) {
          if (txParts.some(p => p.address.toLowerCase().includes(searchLower))) return true;
          const linkedRecords = txParts.map(p => addressToRecord.get(p.address)).filter(Boolean);
          if (linkedRecords.some(r => r?.label?.toLowerCase().includes(searchLower))) return true;
        }
        
        return false;
      });
    }
    
    return results;
  }, [preFilteredTransactions, search, searchFilters, broadParticipantMap, addressToRecord]);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filteredTransactions.length / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);
  const startIndex = (safePage - 1) * ITEMS_PER_PAGE;
  const paginatedTransactionSlice = filteredTransactions.slice(startIndex, startIndex + ITEMS_PER_PAGE);

  const { value: pageParticipantMap } = useAsyncMemo(async (signal) => {
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
  }, [paginatedTransactionSlice, needsBroadParticipants, broadParticipantMap], new Map<string, TransactionParticipant[]>());

  const paginatedTransactions = useMemo(() => {
    return paginatedTransactionSlice.map(tx => {
      const txParts = pageParticipantMap.get(tx.txid) || [];
      const inputs = txParts.filter(p => p.role === 'input');
      const outputs = txParts.filter(p => p.role === 'output');
      return {
        ...tx,
        inputs,
        outputs,
        totalInputValue: inputs.reduce((sum, p) => sum + p.amount, 0),
        totalOutputValue: outputs.reduce((sum, p) => sum + p.amount, 0),
      } as TransactionWithParticipants;
    });
  }, [paginatedTransactionSlice, pageParticipantMap]);

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

  const stats = useMemo(() => {
    const txCount = filteredTransactions.length;
    const fees = filteredTransactions.reduce((sum, tx) => sum + tx.fee, 0);
    const pageVolume = paginatedTransactions.reduce((sum, tx) => sum + tx.totalOutputValue, 0);
    
    const linkedAddresses = new Set<string>();
    paginatedTransactions.forEach(tx => {
      [...tx.inputs, ...tx.outputs].forEach(p => {
        if (addressToRecord.has(p.address)) {
          linkedAddresses.add(p.address);
        }
      });
    });
    
    return {
      txCount,
      pageVolume,
      fees,
      linkedAddressCount: linkedAddresses.size
    };
  }, [filteredTransactions, paginatedTransactions, addressToRecord]);

  const isLoading = !allTransactions;

  return (
    <div className="flex flex-col h-full overflow-hidden p-4 gap-4">
      <div className="flex-none flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Blockchain Transactions</h1>
          <p className="text-muted-foreground mt-1">
            View synced transaction data with amounts, fees, and linked addresses
          </p>
        </div>
        <BlockchainToggle
          checked={includeBlockchainDiscovered}
          onCheckedChange={(checked) => {
            setIncludeBlockchainDiscovered(checked);
            setCurrentPage(1);
          }}
          hiddenCount={blockchainOnlyTxCount}
        />
      </div>

      {/* Stats Overview */}
      <div className="grid gap-4 sm:grid-cols-4 flex-none">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Transactions</CardDescription>
            <CardTitle className="text-2xl" data-testid="text-total-transactions">
              {stats.txCount}
            </CardTitle>
          </CardHeader>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Page Volume</CardDescription>
            <CardTitle className="text-2xl" data-testid="text-total-volume">
              {satsToBtc(stats.pageVolume)} BTC
            </CardTitle>
          </CardHeader>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Fees Paid</CardDescription>
            <CardTitle className="text-2xl" data-testid="text-total-fees">
              {formatSats(stats.fees)}
            </CardTitle>
          </CardHeader>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Linked Addresses</CardDescription>
            <CardTitle className="text-2xl" data-testid="text-linked-addresses">
              {stats.linkedAddressCount}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Search and Filters */}
      <div className="flex-none flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
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
            const allTxids = paginatedTransactions.map(tx => tx.txid);
            const allExpanded = allTxids.every(txid => expandedTxs.has(txid));
            if (allExpanded) {
              setExpandedTxs(new Set());
            } else {
              setExpandedTxs(new Set(allTxids));
            }
          }}
          data-testid="button-expand-collapse-all"
        >
          {paginatedTransactions.length > 0 && paginatedTransactions.every(tx => expandedTxs.has(tx.txid)) ? (
            <>
              <ChevronsDownUp className="h-4 w-4 mr-1" />
              Collapse All
            </>
          ) : (
            <>
              <ChevronsUpDown className="h-4 w-4 mr-1" />
              Expand All
            </>
          )}
        </Button>
      </div>

      {/* Transaction List */}
      <div className="flex-1 overflow-y-auto space-y-3">
        {isLoading ? (
          <div className="flex items-center justify-center h-32">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        ) : paginatedTransactions.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground">
                {search ? "No transactions match your search" : "No transactions synced yet"}
              </p>
              {!search && (
                <p className="text-sm text-muted-foreground mt-2">
                  Use Transaction Sync to fetch blockchain data for your addresses
                </p>
              )}
            </CardContent>
          </Card>
        ) : (
          paginatedTransactions.map((tx) => {
            const isExpanded = expandedTxs.has(tx.txid);
            const txDate = new Date(tx.blockTime * 1000);
            
            return (
              <Collapsible
                key={tx.txid}
                open={isExpanded}
                onOpenChange={() => toggleExpanded(tx.txid)}
              >
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
                              {satsToBtc(tx.totalOutputValue)} BTC
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
                      <div className="grid md:grid-cols-2 gap-4">
                        {/* Inputs */}
                        <div>
                          <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                            <ArrowDownLeft className="h-4 w-4 text-red-500" />
                            Inputs ({tx.inputs.length})
                          </h4>
                          <div className="space-y-2">
                            {tx.inputs.map((input, idx) => {
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
                        
                        {/* Outputs */}
                        <div>
                          <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                            <ArrowUpRight className="h-4 w-4 text-green-500" />
                            Outputs ({tx.outputs.length})
                          </h4>
                          <div className="space-y-2">
                            {tx.outputs.map((output, idx) => {
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
                      
                      {/* OP_RETURN Data */}
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
                    </CardContent>
                  </CollapsibleContent>
                </Card>
              </Collapsible>
            );
          })
        )}
      </div>

      {/* Pagination */}
      {filteredTransactions.length > ITEMS_PER_PAGE && (
        <div className="flex items-center justify-between border-t pt-4 flex-none">
          <div className="text-sm text-muted-foreground">
            Showing {startIndex + 1}-{Math.min(startIndex + ITEMS_PER_PAGE, filteredTransactions.length)} of {filteredTransactions.length} transactions
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
    </div>
  );
}

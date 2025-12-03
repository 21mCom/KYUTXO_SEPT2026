import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { 
  ArrowLeft,
  RefreshCw,
  Check,
  AlertCircle,
  Clock,
  Wallet,
  ArrowDownUp,
  ExternalLink,
  Loader2,
  Info,
  Server,
  Settings,
  ChevronDown,
  ChevronRight
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { transactionSyncService, type SyncProgress, type SyncResult, type SyncOptions, type SourceCategory, type SourceSelection, getAddressSources, matchesSourceSelection } from "@/lib/transaction-sync";
import { db, type Record as DbRecord } from "@/lib/database";
import { useNodeSettings } from "@/hooks/use-node-settings";
import { getProviderDisplayName, getProviderPrivacyInfo } from "@/lib/blockchain-api";
import { Link } from "wouter";
import { formatDistanceToNow } from "date-fns";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export default function TransactionSync() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { nodeSettings } = useNodeSettings();
  
  const privacyInfo = getProviderPrivacyInfo(nodeSettings.providerType, nodeSettings.useTor);
  
  const [stats, setStats] = useState<{
    totalAddresses: number;
    syncedAddresses: number;
    totalTransactions: number;
    lastSyncTime: number | null;
  } | null>(null);
  
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [lastResult, setLastResult] = useState<SyncResult | null>(null);
  const [pendingReviewAddresses, setPendingReviewAddresses] = useState<DbRecord[]>([]);
  const [maxDepth, setMaxDepth] = useState<number>(1);
  const [depthStats, setDepthStats] = useState<Map<number, number>>(new Map());
  
  // New granular source selection state
  const [sourceCategories, setSourceCategories] = useState<SourceCategory[]>([]);
  const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set());
  const [includeNoSource, setIncludeNoSource] = useState<boolean>(true);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set(['manual', 'wallet-sync', 'xpub']));

  // Build current source selection from state
  const currentSourceSelection = useCallback((): SourceSelection => {
    return {
      selectedSources,
      includeNoSource,
    };
  }, [selectedSources, includeNoSource]);

  // Apply source filter to records for depth count calculation
  const applySourceFilter = useCallback((records: DbRecord[]): DbRecord[] => {
    // Always use custom selection now
    const selection = currentSourceSelection();
    return records.filter(r => matchesSourceSelection(r, selection));
  }, [currentSourceSelection]);

  const loadStats = useCallback(async () => {
    const s = await transactionSyncService.getStats();
    setStats(s);
    
    const pending = await transactionSyncService.getPendingReviewAddresses();
    setPendingReviewAddresses(pending);
  }, []);
  
  // Load available sources and set initial selection
  const loadSources = useCallback(async () => {
    const categories = await getAddressSources();
    setSourceCategories(categories);
    
    // By default, select all non-blockchain-sync sources
    // Always include manual/no-source entries by default (matches legacy 'manual-only' behavior)
    const newSelection = new Set<string>();
    for (const cat of categories) {
      for (const src of cat.sources) {
        // Skip blockchain-sync and __no_source__ (handled separately)
        if (cat.id !== 'blockchain-sync' && src.source !== '__no_source__') {
          newSelection.add(src.source);
        }
      }
    }
    setSelectedSources(newSelection);
    // Always include manual entries by default - this matches legacy 'manual-only' behavior
    setIncludeNoSource(true);
  }, []);
  
  // Calculate depth stats based on current source selection
  const calculateDepthStats = useCallback(async () => {
    const allRecords = await db.records.where('type').equals('address').toArray();
    const filteredRecords = applySourceFilter(allRecords);
    
    const depths = new Map<number, number>();
    for (const record of filteredRecords) {
      const depth = record.syncDepth ?? 0;
      depths.set(depth, (depths.get(depth) ?? 0) + 1);
    }
    setDepthStats(depths);
  }, [applySourceFilter]);

  useEffect(() => {
    loadStats();
    loadSources();
  }, [loadStats, loadSources]);
  
  // Recalculate depth stats when source selection changes
  useEffect(() => {
    calculateDepthStats();
  }, [selectedSources, includeNoSource, calculateDepthStats]);

  const handleSync = async () => {
    setIsSyncing(true);
    setSyncProgress({
      phase: 'idle',
      currentDepth: 0,
      maxDepth,
      addressesTotal: 0,
      addressesProcessed: 0,
      transactionsFound: 0,
      transactionsNew: 0,
      newAddressRecords: 0,
    });
    setLastResult(null);

    // Update the sync service to use current node settings
    transactionSyncService.updateProvider(nodeSettings);
    
    transactionSyncService.setProgressCallback((progress) => {
      setSyncProgress(progress);
    });

    try {
      const options: SyncOptions = {
        sourceFilter: 'custom',
        sourceSelection: currentSourceSelection(),
        maxDepth,
      };
      const result = await transactionSyncService.syncWithDepth(options);
      setLastResult(result);
      
      if (result.success) {
        toast({
          title: "Sync Complete",
          description: `Imported ${result.transactionsImported} new transactions from ${result.addressesSynced} addresses.`,
        });
      } else {
        toast({
          title: "Sync Completed with Errors",
          description: result.errors[0] || "Some addresses failed to sync",
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: "Sync Failed",
        description: error instanceof Error ? error.message : "An error occurred",
        variant: "destructive",
      });
    } finally {
      setIsSyncing(false);
      await loadStats();
      await loadSources();
      await calculateDepthStats();
    }
  };

  const formatSats = (sats: number) => {
    if (sats >= 100000000) {
      return `${(sats / 100000000).toFixed(8)} BTC`;
    }
    return `${sats.toLocaleString()} sats`;
  };

  const getProgressPercent = () => {
    if (!syncProgress || syncProgress.addressesTotal === 0) return 0;
    return Math.round((syncProgress.addressesProcessed / syncProgress.addressesTotal) * 100);
  };

  const getPhaseText = () => {
    if (!syncProgress) return '';
    switch (syncProgress.phase) {
      case 'idle': return 'Preparing...';
      case 'fetching-height': return 'Getting current block height...';
      case 'syncing-addresses': {
        const depthText = syncProgress.maxDepth && syncProgress.maxDepth > 1 
          ? ` (depth ${(syncProgress.currentDepth ?? 0) + 1}/${syncProgress.maxDepth})`
          : '';
        return `Syncing address ${syncProgress.addressesProcessed + 1} of ${syncProgress.addressesTotal}${depthText}`;
      }
      case 'processing': return 'Processing transactions...';
      case 'complete': return 'Sync complete!';
      case 'error': return `Error: ${syncProgress.error}`;
      default: return '';
    }
  };

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate("/")} data-testid="button-back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-page-title">Transaction Sync</h1>
            <p className="text-muted-foreground">Sync blockchain data for all your addresses (manual, imported, or derived)</p>
          </div>
        </div>

        {/* Current Provider Info */}
        <Alert variant={privacyInfo.level === 'low' ? 'destructive' : 'default'}>
          <Server className="h-4 w-4" />
          <AlertTitle className="flex items-center justify-between">
            <span className="flex items-center gap-2">
              Data Provider: {getProviderDisplayName(nodeSettings.providerType)}
              {nodeSettings.useTor && (
                <Badge variant="outline" className="text-xs">via Tor</Badge>
              )}
            </span>
            <Link href="/node-settings">
              <Button variant="ghost" size="sm" className="h-7 text-xs" data-testid="link-node-settings">
                <Settings className="h-3 w-3 mr-1" />
                Configure
              </Button>
            </Link>
          </AlertTitle>
          <AlertDescription>
            {privacyInfo.description}
          </AlertDescription>
        </Alert>

        {/* Stats Overview (Global Totals) */}
        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Total Addresses (All Sources)</CardDescription>
              <CardTitle className="text-2xl" data-testid="text-total-addresses">
                {stats?.totalAddresses ?? '-'}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                {stats?.syncedAddresses ?? 0} previously synced
              </p>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Transactions Found</CardDescription>
              <CardTitle className="text-2xl" data-testid="text-total-transactions">
                {stats?.totalTransactions ?? '-'}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                With 5+ confirmations
              </p>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Last Synced</CardDescription>
              <CardTitle className="text-2xl flex items-center gap-2" data-testid="text-last-sync">
                {stats?.lastSyncTime ? (
                  <>
                    <Clock className="h-5 w-5" />
                    <span className="text-lg">
                      {formatDistanceToNow(stats.lastSyncTime, { addSuffix: true })}
                    </span>
                  </>
                ) : (
                  'Never'
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                Run sync to fetch new transactions
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Sync Control */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5" />
              Sync Transactions
            </CardTitle>
            <CardDescription>
              Fetch latest blockchain data for addresses in your database based on the selected source filter
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Sync Controls Row */}
            <div className="grid gap-4 sm:grid-cols-2">
              {/* Source Selection */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Address Sources</Label>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      disabled={isSyncing}
                      onClick={() => {
                        const allSources = new Set<string>();
                        for (const cat of sourceCategories) {
                          for (const src of cat.sources) {
                            if (src.source !== '__no_source__') {
                              allSources.add(src.source);
                            }
                          }
                        }
                        setSelectedSources(allSources);
                        setIncludeNoSource(true);
                      }}
                      data-testid="button-select-all-sources"
                    >
                      All
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      disabled={isSyncing}
                      onClick={() => {
                        setSelectedSources(new Set());
                        setIncludeNoSource(false);
                      }}
                      data-testid="button-clear-sources"
                    >
                      None
                    </Button>
                  </div>
                </div>
                
                <ScrollArea className="h-48 border rounded-md p-2" data-testid="scroll-source-filter">
                  {sourceCategories.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No address sources found
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {sourceCategories.map((category) => {
                        const allSelected = category.sources.every(s => 
                          s.source === '__no_source__' ? includeNoSource : selectedSources.has(s.source)
                        );
                        const someSelected = category.sources.some(s => 
                          s.source === '__no_source__' ? includeNoSource : selectedSources.has(s.source)
                        );
                        const isExpanded = expandedCategories.has(category.id);
                        const totalCount = category.sources.reduce((sum, s) => sum + s.count, 0);
                        
                        return (
                          <Collapsible
                            key={category.id}
                            open={isExpanded}
                            onOpenChange={(open) => {
                              const newExpanded = new Set(expandedCategories);
                              if (open) {
                                newExpanded.add(category.id);
                              } else {
                                newExpanded.delete(category.id);
                              }
                              setExpandedCategories(newExpanded);
                            }}
                          >
                            <div className="flex items-center gap-2 py-1">
                              <Checkbox
                                checked={allSelected}
                                disabled={isSyncing}
                                onCheckedChange={(checked) => {
                                  const newSelection = new Set(selectedSources);
                                  for (const src of category.sources) {
                                    if (src.source === '__no_source__') {
                                      setIncludeNoSource(checked === true);
                                    } else if (checked) {
                                      newSelection.add(src.source);
                                    } else {
                                      newSelection.delete(src.source);
                                    }
                                  }
                                  setSelectedSources(newSelection);
                                }}
                                className={someSelected && !allSelected ? "opacity-50" : ""}
                                data-testid={`checkbox-category-${category.id}`}
                              />
                              <CollapsibleTrigger asChild>
                                <button
                                  className="flex items-center gap-1 text-sm font-medium flex-1 text-left hover-elevate rounded px-1"
                                  data-testid={`button-toggle-category-${category.id}`}
                                >
                                  {isExpanded ? (
                                    <ChevronDown className="h-4 w-4" />
                                  ) : (
                                    <ChevronRight className="h-4 w-4" />
                                  )}
                                  {category.label}
                                  <Badge variant="secondary" className="ml-auto text-xs">
                                    {totalCount}
                                  </Badge>
                                </button>
                              </CollapsibleTrigger>
                            </div>
                            
                            <CollapsibleContent>
                              <div className="pl-6 space-y-1">
                                {category.sources.map((src) => (
                                  <div key={src.source} className="flex items-center gap-2 py-0.5">
                                    <Checkbox
                                      checked={src.source === '__no_source__' ? includeNoSource : selectedSources.has(src.source)}
                                      disabled={isSyncing}
                                      onCheckedChange={(checked) => {
                                        if (src.source === '__no_source__') {
                                          setIncludeNoSource(checked === true);
                                        } else {
                                          const newSelection = new Set(selectedSources);
                                          if (checked) {
                                            newSelection.add(src.source);
                                          } else {
                                            newSelection.delete(src.source);
                                          }
                                          setSelectedSources(newSelection);
                                        }
                                      }}
                                      data-testid={`checkbox-source-${src.source.replace(/[^a-zA-Z0-9]/g, '-')}`}
                                    />
                                    <span className="text-sm truncate flex-1" title={src.displayName}>
                                      {src.displayName}
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                      {src.count}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </CollapsibleContent>
                          </Collapsible>
                        );
                      })}
                    </div>
                  )}
                </ScrollArea>
                <p className="text-xs text-muted-foreground">
                  {selectedSources.size + (includeNoSource ? 1 : 0)} source(s) selected
                </p>
              </div>

              {/* Depth Control */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label htmlFor="max-depth">Sync Depth</Label>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-4 w-4 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      <p className="text-sm">
                        <strong>Depth 1:</strong> Only sync your addresses (depth 0)<br />
                        <strong>Depth 2:</strong> Also sync addresses found in their transactions<br />
                        <strong>Depth 3+:</strong> Continue following the chain
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </div>
                <Select
                  value={maxDepth.toString()}
                  onValueChange={(value) => setMaxDepth(parseInt(value))}
                  disabled={isSyncing}
                >
                  <SelectTrigger id="max-depth" className="w-full" data-testid="select-max-depth">
                    <SelectValue placeholder="Select sync depth" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1 level (added manually, wallet sync or via xpubs)</SelectItem>
                    <SelectItem value="2">2 levels (+ first-hop addresses)</SelectItem>
                    <SelectItem value="3">3 levels (+ second-hop addresses)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {maxDepth === 1 && "Safe: Only syncs depth-0 addresses"}
                  {maxDepth === 2 && "Moderate: Discovers connected addresses"}
                  {maxDepth === 3 && "Deep: Traces further relationships"}
                </p>
              </div>
            </div>

            {/* Depth Stats */}
            {depthStats.size > 0 && (
              <div className="flex flex-wrap gap-2 pt-2">
                {Array.from(depthStats.entries())
                  .sort((a, b) => a[0] - b[0])
                  .map(([depth, count]) => (
                    <Badge 
                      key={depth} 
                      variant={depth === 0 ? "default" : "secondary"}
                      className="text-xs"
                    >
                      Depth {depth}: {count} addresses
                    </Badge>
                  ))}
              </div>
            )}
            {isSyncing && syncProgress && (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span>{getPhaseText()}</span>
                  <span>{getProgressPercent()}%</span>
                </div>
                <Progress value={getProgressPercent()} className="h-2" />
                
                {syncProgress.currentAddress && (
                  <p className="text-xs text-muted-foreground font-mono truncate">
                    {syncProgress.currentAddress}
                  </p>
                )}
                
                <div className="grid grid-cols-3 gap-4 text-sm">
                  <div>
                    <p className="text-muted-foreground">Found</p>
                    <p className="font-medium">{syncProgress.transactionsFound} txs</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">New</p>
                    <p className="font-medium">{syncProgress.transactionsNew} txs</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">New Addresses</p>
                    <p className="font-medium">{syncProgress.newAddressRecords}</p>
                  </div>
                </div>
              </div>
            )}
            
            {!isSyncing && lastResult && (
              <Alert variant={lastResult.success ? "default" : "destructive"}>
                {lastResult.success ? <Check className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
                <AlertTitle>{lastResult.success ? 'Sync Complete' : 'Sync Completed with Errors'}</AlertTitle>
                <AlertDescription>
                  <p>
                    Synced {lastResult.addressesSynced} addresses. 
                    Imported {lastResult.transactionsImported} new transactions
                    {lastResult.transactionsUpdated > 0 && `, updated ${lastResult.transactionsUpdated}`}.
                    {lastResult.newAddressRecords > 0 && ` Created ${lastResult.newAddressRecords} new address records for review.`}
                  </p>
                  {lastResult.errors.length > 0 && (
                    <ul className="mt-2 list-disc list-inside text-sm">
                      {lastResult.errors.slice(0, 3).map((err, i) => (
                        <li key={i}>{err}</li>
                      ))}
                    </ul>
                  )}
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
          <CardFooter>
            <Button 
              onClick={handleSync} 
              disabled={isSyncing || (stats?.totalAddresses ?? 0) === 0}
              data-testid="button-sync"
            >
              {isSyncing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Syncing...
                </>
              ) : (
                <>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Start Sync
                </>
              )}
            </Button>
            {(stats?.totalAddresses ?? 0) === 0 && (
              <p className="ml-4 text-sm text-muted-foreground">
                Add some addresses first to sync their transactions
              </p>
            )}
          </CardFooter>
        </Card>

        {/* Pending Review */}
        {pendingReviewAddresses.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Wallet className="h-5 w-5" />
                Pending Review
                <Badge variant="secondary">{pendingReviewAddresses.length}</Badge>
              </CardTitle>
              <CardDescription>
                Addresses discovered through transaction sync that need identification
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-64">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Address</TableHead>
                      <TableHead>Added</TableHead>
                      <TableHead className="w-20"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pendingReviewAddresses.slice(0, 20).map((record) => (
                      <TableRow key={record.id}>
                        <TableCell className="font-mono text-sm">
                          {record.inputString.substring(0, 12)}...{record.inputString.substring(record.inputString.length - 8)}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {formatDistanceToNow(record.createdAt, { addSuffix: true })}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              window.open(`https://mempool.space/address/${record.inputString}`, '_blank');
                            }}
                            data-testid={`button-view-address-${record.id}`}
                          >
                            <ExternalLink className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {pendingReviewAddresses.length > 20 && (
                  <p className="text-center text-sm text-muted-foreground py-2">
                    ...and {pendingReviewAddresses.length - 20} more
                  </p>
                )}
              </ScrollArea>
            </CardContent>
            <CardFooter>
              <p className="text-sm text-muted-foreground">
                Edit these addresses from the main Records view to assign owners and labels
              </p>
            </CardFooter>
          </Card>
        )}

        {/* How it works */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ArrowDownUp className="h-5 w-5" />
              How It Works
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex gap-3">
              <Badge variant="outline" className="shrink-0">1</Badge>
              <p>All addresses in your database are synced: manually added, imported from wallets, or derived from xPubs</p>
            </div>
            <div className="flex gap-3">
              <Badge variant="outline" className="shrink-0">2</Badge>
              <p>Sync queries mempool.space for transaction history of each address</p>
            </div>
            <div className="flex gap-3">
              <Badge variant="outline" className="shrink-0">3</Badge>
              <p>Only transactions with 5+ confirmations are imported (considered settled)</p>
            </div>
            <div className="flex gap-3">
              <Badge variant="outline" className="shrink-0">4</Badge>
              <p>Transaction details are stored locally: block time, fees, inputs, and outputs</p>
            </div>
            <div className="flex gap-3">
              <Badge variant="outline" className="shrink-0">5</Badge>
              <p>Unknown addresses in transactions are created as "Pending Review" for you to identify</p>
            </div>
            <div className="flex gap-3">
              <Badge variant="outline" className="shrink-0">6</Badge>
              <p>Run sync periodically to catch new transactions</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
  Loader2,
  Info,
  Server,
  Settings,
  ChevronDown,
  ChevronRight,
  Square,
  Pause,
  Play,
  Trash2
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { transactionSyncService, type SyncProgress, type SyncResult, type SyncOptions, type SourceCategory, type SourceSelection, type SourceInfo, getAddressSources } from "@/lib/transaction-sync";
import type { PausedSyncState } from "@/lib/database";
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
  const [isStopping, setIsStopping] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [lastResult, setLastResult] = useState<SyncResult | null>(null);
  const [maxDepth, setMaxDepth] = useState<number>(1);
  
  // Paused sync state for resume functionality
  const [pausedState, setPausedState] = useState<PausedSyncState | null>(null);
  
  // New granular source selection state
  const [sourceCategories, setSourceCategories] = useState<SourceCategory[]>([]);
  const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set());
  const [includeNoSource, setIncludeNoSource] = useState<boolean>(true);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set(['manual', 'wallet-sync', 'xpub']));
  
  // Filtered count based on current selection
  const [filteredAddressCount, setFilteredAddressCount] = useState<number | null>(null);

  // Build current source selection from state
  const currentSourceSelection = useCallback((): SourceSelection => {
    return {
      selectedSources,
      includeNoSource,
    };
  }, [selectedSources, includeNoSource]);

  const loadStats = useCallback(async () => {
    const s = await transactionSyncService.getStats();
    setStats(s);
  }, []);
  
  // Load available sources and set initial selection
  const loadSources = useCallback(async () => {
    const categories = await getAddressSources();
    setSourceCategories(categories);
    
    // By default, select all non-blockchain-sync sources
    // Always include manual/no-source entries by default (matches legacy 'manual-only' behavior)
    // IMPORTANT: Store the RAW sources (e.g., "NamaDompet (0/1)") not grouped names
    const newSelection = new Set<string>();
    for (const cat of categories) {
      for (const src of cat.sources) {
        // Skip blockchain-sync and __no_source__ (handled separately)
        if (cat.id !== 'blockchain-sync' && src.source !== '__no_source__') {
          // Add all raw sources that map to this grouped source
          const rawSources = src.rawSources || [src.source];
          for (const raw of rawSources) {
            newSelection.add(raw);
          }
        }
      }
    }
    setSelectedSources(newSelection);
    // Always include manual entries by default - this matches legacy 'manual-only' behavior
    setIncludeNoSource(true);
  }, []);

  // Load paused state on mount
  const loadPausedState = useCallback(async () => {
    const state = await transactionSyncService.getPausedState();
    setPausedState(state ?? null);
  }, []);

  useEffect(() => {
    loadStats();
    loadSources();
    loadPausedState();
  }, [loadStats, loadSources, loadPausedState]);

  // Update filtered address count whenever selection changes
  useEffect(() => {
    const updateFilteredCount = async () => {
      const options: SyncOptions = {
        sourceFilter: 'custom',
        sourceSelection: {
          selectedSources,
          includeNoSource,
        },
        maxDepth,
      };
      const count = await transactionSyncService.getFilteredAddressCount(options);
      setFilteredAddressCount(count);
    };
    updateFilteredCount();
  }, [selectedSources, includeNoSource, maxDepth]);

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
      const wasStopped = isStopping;
      setIsSyncing(false);
      setIsStopping(false);
      await loadStats();
      await loadSources();
      await loadPausedState();
      
      // If sync was stopped/paused, update the result message
      if (wasStopped && lastResult === null) {
        // Check if it was paused (state was saved) or stopped
        const newPausedState = await transactionSyncService.getPausedState();
        if (newPausedState) {
          toast({
            title: "Sync Paused",
            description: `${newPausedState.remainingRecordIds.length} addresses remaining. You can resume anytime.`,
          });
        } else {
          toast({
            title: "Sync Stopped",
            description: "Sync was stopped. Any transactions already found have been saved.",
          });
        }
      }
    }
  };

  const handlePauseSync = () => {
    setIsStopping(true);
    transactionSyncService.requestPause();
    toast({
      title: "Pausing Sync",
      description: "Finishing current address, then pausing...",
    });
  };

  const handleStopSync = () => {
    setIsStopping(true);
    transactionSyncService.stopSync();
    toast({
      title: "Stopping Sync",
      description: "Finishing current address, then stopping...",
    });
  };
  
  const handleResumeSync = async () => {
    setIsSyncing(true);
    setSyncProgress({
      phase: 'idle',
      addressesTotal: pausedState?.remainingRecordIds.length ?? 0,
      addressesProcessed: 0,
      transactionsFound: pausedState?.transactionsImported ?? 0,
      transactionsNew: pausedState?.transactionsImported ?? 0,
      newAddressRecords: pausedState?.newAddressRecords ?? 0,
    });
    setLastResult(null);

    // Update the sync service to use current node settings
    transactionSyncService.updateProvider(nodeSettings);
    
    transactionSyncService.setProgressCallback((progress) => {
      setSyncProgress(progress);
    });

    try {
      const result = await transactionSyncService.resumeSync();
      setLastResult(result);
      // Note: paused state is managed by the service - if sync was paused again, state is preserved
      // If sync completed, service clears the state
      
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
        title: "Resume Failed",
        description: error instanceof Error ? error.message : "An error occurred",
        variant: "destructive",
      });
    } finally {
      setIsSyncing(false);
      setIsStopping(false);
      await loadStats();
      await loadSources();
      await loadPausedState(); // Reload paused state (may have new state if paused again, or cleared if complete)
    }
  };
  
  const handleDiscardPausedSync = async () => {
    await transactionSyncService.clearPausedState();
    setPausedState(null);
    toast({
      title: "Paused Sync Discarded",
      description: "You can start a fresh sync anytime.",
    });
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

        {/* Stats Overview (Database Totals) */}
        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Database Addresses</CardDescription>
              <CardTitle className="text-2xl" data-testid="text-total-addresses">
                {stats?.totalAddresses ?? '-'}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                Total across all wallets ({stats?.syncedAddresses ?? 0} synced)
              </p>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Database Transactions</CardDescription>
              <CardTitle className="text-2xl" data-testid="text-total-transactions">
                {stats?.totalTransactions ?? '-'}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                Previously synced (5+ confirmations)
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
                              // Add all raw sources, not just the grouped display name
                              const rawSources = src.rawSources || [src.source];
                              for (const raw of rawSources) {
                                allSources.add(raw);
                              }
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
                        // Check if all raw sources for this category are selected
                        const allSelected = category.sources.every(s => {
                          if (s.source === '__no_source__') return includeNoSource;
                          const rawSources = s.rawSources || [s.source];
                          return rawSources.every(raw => selectedSources.has(raw));
                        });
                        const someSelected = category.sources.some(s => {
                          if (s.source === '__no_source__') return includeNoSource;
                          const rawSources = s.rawSources || [s.source];
                          return rawSources.some(raw => selectedSources.has(raw));
                        });
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
                                  // Handle no-source separately since it uses its own state
                                  for (const src of category.sources) {
                                    if (src.source === '__no_source__') {
                                      setIncludeNoSource(checked === true);
                                      break;
                                    }
                                  }
                                  
                                  // Use functional update to ensure new Set reference triggers re-render
                                  setSelectedSources(prev => {
                                    const newSelection = new Set(prev);
                                    for (const src of category.sources) {
                                      if (src.source !== '__no_source__') {
                                        // Add/remove all raw sources for this grouped source
                                        const rawSources = src.rawSources || [src.source];
                                        for (const raw of rawSources) {
                                          if (checked) {
                                            newSelection.add(raw);
                                          } else {
                                            newSelection.delete(raw);
                                          }
                                        }
                                      }
                                    }
                                    return newSelection;
                                  });
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
                                {category.sources.map((src) => {
                                  // Check if all raw sources for this grouped source are selected
                                  const rawSources = src.rawSources || [src.source];
                                  const isChecked = src.source === '__no_source__' 
                                    ? includeNoSource 
                                    : rawSources.every(raw => selectedSources.has(raw));
                                  
                                  return (
                                    <div key={src.source} className="flex items-center gap-2 py-0.5">
                                      <Checkbox
                                        checked={isChecked}
                                        disabled={isSyncing}
                                        onCheckedChange={(checked) => {
                                          if (src.source === '__no_source__') {
                                            setIncludeNoSource(checked === true);
                                          } else {
                                            // Use functional update to ensure new Set reference triggers re-render
                                            setSelectedSources(prev => {
                                              const newSelection = new Set(prev);
                                              // Add/remove all raw sources for this grouped source
                                              for (const raw of rawSources) {
                                                if (checked) {
                                                  newSelection.add(raw);
                                                } else {
                                                  newSelection.delete(raw);
                                                }
                                              }
                                              return newSelection;
                                            });
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
                                  );
                                })}
                              </div>
                            </CollapsibleContent>
                          </Collapsible>
                        );
                      })}
                    </div>
                  )}
                </ScrollArea>
                {filteredAddressCount !== null && (
                  <div className="text-xs text-muted-foreground">
                    <Badge variant="secondary" className="font-medium">
                      {filteredAddressCount} address{filteredAddressCount !== 1 ? 'es' : ''}
                    </Badge>
                    {' '}will be synced based on current selection
                  </div>
                )}
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
          <CardFooter className="gap-2">
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
            {isSyncing && (
              <>
                <Button 
                  variant="outline"
                  onClick={handlePauseSync}
                  disabled={isStopping}
                  data-testid="button-pause-sync"
                >
                  {isStopping ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Pausing...
                    </>
                  ) : (
                    <>
                      <Pause className="mr-2 h-4 w-4" />
                      Pause
                    </>
                  )}
                </Button>
                <Button 
                  variant="destructive"
                  onClick={handleStopSync}
                  disabled={isStopping}
                  data-testid="button-stop-sync"
                >
                  <Square className="mr-2 h-4 w-4" />
                  Stop
                </Button>
              </>
            )}
            {!isSyncing && pausedState && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Button 
                    onClick={handleResumeSync}
                    data-testid="button-resume-sync"
                  >
                    <Play className="mr-2 h-4 w-4" />
                    Resume ({pausedState.remainingRecordIds.length} remaining)
                  </Button>
                  <Button 
                    variant="outline"
                    onClick={handleDiscardPausedSync}
                    data-testid="button-discard-paused"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Discard
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Paused at depth {pausedState.currentDepth}. Already synced {pausedState.addressesSynced} addresses, found {pausedState.transactionsImported} transactions.
                </p>
              </div>
            )}
            {!isSyncing && !pausedState && (stats?.totalAddresses ?? 0) === 0 && (
              <p className="ml-2 text-sm text-muted-foreground">
                Add some addresses first to sync their transactions
              </p>
            )}
          </CardFooter>
        </Card>

        {/* How it works */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Info className="h-5 w-5" />
              How It Works
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-2">
            <p>
              Fetches transaction history for your selected addresses from the configured blockchain API. 
              Only confirmed transactions (5+ confirmations) are imported.
            </p>
            <p>
              New addresses discovered in transactions are automatically added as "Unknown" for later review. 
              Use deeper sync levels to trace connected addresses.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

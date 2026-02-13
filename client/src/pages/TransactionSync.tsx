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
import { Input } from "@/components/ui/input";
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
  Trash2,
  ShieldAlert,
  Search,
  Ban,
  X,
  SkipForward
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { transactionSyncService, type SyncProgress, type SyncResult, type SyncOptions, type SourceCategory, type SourceSelection, type SourceInfo, type SyncDepthEstimate, getAddressSources } from "@/lib/transaction-sync";
import type { PausedSyncState, SkippedAddress, AddressBlacklist, SyncProtectionSettings } from "@/lib/database";
import { DEFAULT_SYNC_PROTECTION } from "@/lib/database";
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
  const [depthEstimate, setDepthEstimate] = useState<SyncDepthEstimate | null>(null);
  
  // Sync protection
  const [syncProtection, setSyncProtection] = useState<SyncProtectionSettings>({ ...DEFAULT_SYNC_PROTECTION });
  const [showProtectionSettings, setShowProtectionSettings] = useState(false);
  
  // Single address sync
  const [singleAddress, setSingleAddress] = useState('');
  const [isSingleSyncing, setIsSingleSyncing] = useState(false);
  const [singleSyncResult, setSingleSyncResult] = useState<SyncResult | null>(null);
  
  // Skipped addresses and blacklist
  const [skippedAddresses, setSkippedAddresses] = useState<SkippedAddress[]>([]);
  const [blacklist, setBlacklist] = useState<AddressBlacklist[]>([]);
  const [showBlacklist, setShowBlacklist] = useState(false);

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

  const loadSkippedAddresses = useCallback(async () => {
    const skipped = await transactionSyncService.getSkippedAddresses();
    setSkippedAddresses(skipped);
  }, []);

  const loadBlacklist = useCallback(async () => {
    const bl = await transactionSyncService.getBlacklist();
    setBlacklist(bl);
  }, []);

  useEffect(() => {
    loadStats();
    loadSources();
    loadPausedState();
    loadSkippedAddresses();
    loadBlacklist();
  }, [loadStats, loadSources, loadPausedState, loadSkippedAddresses, loadBlacklist]);

  // Update filtered address count and depth estimates whenever selection changes
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
      const estimate = await transactionSyncService.getMultiDepthEstimate(options);
      setFilteredAddressCount(estimate.depth0);
      setDepthEstimate(estimate);
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

    // Update the sync service to use current node settings and protection
    transactionSyncService.updateProvider(nodeSettings);
    transactionSyncService.setSyncProtection(syncProtection);
    
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
        const skippedMsg = result.addressesSkipped > 0 ? ` (${result.addressesSkipped} skipped)` : '';
        toast({
          title: "Sync Complete",
          description: `Imported ${result.transactionsImported} new transactions from ${result.addressesSynced} addresses.${skippedMsg}`,
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
      await loadSkippedAddresses();
      
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

  const handleSingleAddressSync = async () => {
    if (!singleAddress.trim()) return;
    setIsSingleSyncing(true);
    setSingleSyncResult(null);

    transactionSyncService.updateProvider(nodeSettings);

    try {
      const result = await transactionSyncService.syncSingleAddress(
        singleAddress.trim(),
        (progress) => setSyncProgress(progress)
      );
      setSingleSyncResult(result);
      if (result.success) {
        toast({
          title: "Single Address Sync Complete",
          description: `Found ${result.transactionsImported} new transactions.`,
        });
      } else {
        toast({
          title: "Single Address Sync Failed",
          description: result.errors[0] || "Unknown error",
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
      setIsSingleSyncing(false);
      await loadStats();
    }
  };

  const handleAddToBlacklist = async (address: string, reason?: string) => {
    await transactionSyncService.addToBlacklist(address, reason);
    await loadBlacklist();
    await loadSkippedAddresses();
    toast({ title: "Added to Blacklist", description: `${address.substring(0, 12)}... will be skipped in future syncs.` });
  };

  const handleRemoveFromBlacklist = async (address: string) => {
    await transactionSyncService.removeFromBlacklist(address);
    await loadBlacklist();
    toast({ title: "Removed from Blacklist", description: `${address.substring(0, 12)}... will be included in syncs again.` });
  };

  const handleDismissSkipped = async (id: number) => {
    await transactionSyncService.dismissSkippedAddress(id);
    await loadSkippedAddresses();
  };

  const handleDismissAllSkipped = async () => {
    await transactionSyncService.dismissAllSkipped();
    await loadSkippedAddresses();
  };

  const getSkipReasonLabel = (reason: string) => {
    switch (reason) {
      case 'tx-count-exceeded': return 'High Volume';
      case 'timeout': return 'Timed Out';
      case 'blacklisted': return 'Blacklisted';
      case 'error': return 'Error';
      default: return reason;
    }
  };

  const getSkipReasonVariant = (reason: string): "default" | "destructive" | "outline" | "secondary" => {
    switch (reason) {
      case 'tx-count-exceeded': return 'secondary';
      case 'timeout': return 'outline';
      case 'blacklisted': return 'destructive';
      case 'error': return 'destructive';
      default: return 'default';
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
        const currentDepthDisplay = (syncProgress.currentDepth ?? 0) + 1;
        const maxDepthDisplay = syncProgress.maxDepth ?? 1;
        const depthLabel = currentDepthDisplay === 1 ? 'your addresses' : `depth-${syncProgress.currentDepth ?? 0} addresses`;
        if (maxDepthDisplay > 1) {
          return `Depth ${currentDepthDisplay}/${maxDepthDisplay} (${depthLabel}): address ${syncProgress.addressesProcessed + 1} of ${syncProgress.addressesTotal.toLocaleString()}`;
        }
        return `Syncing address ${syncProgress.addressesProcessed + 1} of ${syncProgress.addressesTotal.toLocaleString()}`;
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
              <Button variant="ghost" size="sm" data-testid="link-node-settings">
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
                      disabled={isSyncing}
                      onClick={() => {
                        const allSources = new Set<string>();
                        for (const cat of sourceCategories) {
                          for (const src of cat.sources) {
                            if (src.source !== '__no_source__') {
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
                  <div className="text-xs text-muted-foreground space-y-1" data-testid="text-sync-estimate">
                    <div>
                      <Badge variant="secondary" className="font-medium">
                        {filteredAddressCount.toLocaleString()} address{filteredAddressCount !== 1 ? 'es' : ''}
                      </Badge>
                      {' '}will be synced based on current selection
                    </div>
                    {depthEstimate && maxDepth > 1 && (
                      <div className="pl-1 space-y-0.5">
                        {depthEstimate.perDepth.map((count, idx) => (
                          <div key={idx} className="flex items-center gap-1.5">
                            <span className="text-muted-foreground/60">
                              {idx === 0 ? 'Depth 1:' : `Depth ${idx + 1}:`}
                            </span>
                            <span>
                              {count.toLocaleString()} {idx === 0 ? 'selected' : 'previously discovered'}
                            </span>
                          </div>
                        ))}
                        <div className="flex items-center gap-1.5 pt-0.5 border-t border-muted">
                          <span className="text-muted-foreground/60">Total:</span>
                          <span className="font-medium">{depthEstimate.total.toLocaleString()} addresses across all depths</span>
                        </div>
                      </div>
                    )}
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

                {/* Sync Protection Settings */}
                <Collapsible open={showProtectionSettings} onOpenChange={setShowProtectionSettings}>
                  <CollapsibleTrigger asChild>
                    <Button variant="ghost" size="sm" className="w-full justify-start gap-2 mt-2" data-testid="button-toggle-protection">
                      <ShieldAlert className="h-4 w-4" />
                      {showProtectionSettings ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      Sync Protection
                      {blacklist.length > 0 && (
                        <Badge variant="secondary" className="ml-auto">{blacklist.length} blacklisted</Badge>
                      )}
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-3 pt-2">
                    <div className="space-y-2">
                      <Label htmlFor="tx-threshold" className="text-xs">Transaction Count Threshold</Label>
                      <div className="flex items-center gap-2">
                        <Input
                          id="tx-threshold"
                          type="number"
                          min={0}
                          value={syncProtection.txCountThreshold}
                          onChange={(e) => setSyncProtection(prev => ({ ...prev, txCountThreshold: parseInt(e.target.value) || 0 }))}
                          disabled={isSyncing}
                          className="w-24"
                          data-testid="input-tx-threshold"
                        />
                        <span className="text-xs text-muted-foreground">Skip addresses with more transactions (0 = disabled)</span>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="timeout" className="text-xs">Per-Address Timeout (seconds)</Label>
                      <div className="flex items-center gap-2">
                        <Input
                          id="timeout"
                          type="number"
                          min={0}
                          value={Math.round(syncProtection.perAddressTimeoutMs / 1000)}
                          onChange={(e) => setSyncProtection(prev => ({ ...prev, perAddressTimeoutMs: (parseInt(e.target.value) || 0) * 1000 }))}
                          disabled={isSyncing}
                          className="w-24"
                          data-testid="input-timeout"
                        />
                        <span className="text-xs text-muted-foreground">Max time per address (0 = no limit)</span>
                      </div>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
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
                
                <div className="grid grid-cols-4 gap-4 text-sm">
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
                  {(syncProgress.addressesSkipped ?? 0) > 0 && (
                    <div>
                      <p className="text-muted-foreground">Skipped</p>
                      <p className="font-medium text-amber-600">{syncProgress.addressesSkipped}</p>
                    </div>
                  )}
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
                    {lastResult.addressesSkipped > 0 && (
                      <span className="text-amber-600"> Skipped {lastResult.addressesSkipped} address{lastResult.addressesSkipped !== 1 ? 'es' : ''} (see below).</span>
                    )}
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

        {/* Single Address Sync */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Search className="h-5 w-5" />
              Sync Single Address
            </CardTitle>
            <CardDescription>
              Sync a specific address that was skipped or needs re-syncing
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Input
                placeholder="Enter Bitcoin address (bc1..., 1..., 3...)"
                value={singleAddress}
                onChange={(e) => setSingleAddress(e.target.value)}
                disabled={isSingleSyncing || isSyncing}
                className="font-mono text-xs"
                data-testid="input-single-address"
              />
              <Button
                onClick={handleSingleAddressSync}
                disabled={isSingleSyncing || isSyncing || !singleAddress.trim()}
                data-testid="button-single-sync"
              >
                {isSingleSyncing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
              </Button>
            </div>
            {singleSyncResult && (
              <Alert variant={singleSyncResult.success ? "default" : "destructive"}>
                {singleSyncResult.success ? <Check className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
                <AlertDescription>
                  {singleSyncResult.success
                    ? `Found ${singleSyncResult.transactionsImported} new transactions, ${singleSyncResult.transactionsUpdated} updated.`
                    : singleSyncResult.errors[0] || 'Unknown error'}
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        {/* Skipped Addresses */}
        {skippedAddresses.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <SkipForward className="h-5 w-5" />
                  Skipped Addresses ({skippedAddresses.length})
                </span>
                <Button variant="ghost" size="sm" onClick={handleDismissAllSkipped} data-testid="button-dismiss-all-skipped">
                  Dismiss All
                </Button>
              </CardTitle>
              <CardDescription>
                These addresses were skipped during sync due to protection rules
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="max-h-64">
                <div className="space-y-2">
                  {skippedAddresses.map((skipped) => (
                    <div key={skipped.id} className="flex items-center gap-2 py-1.5 border-b last:border-0">
                      <Badge variant={getSkipReasonVariant(skipped.reason)} className="shrink-0">
                        {getSkipReasonLabel(skipped.reason)}
                      </Badge>
                      <span className="font-mono text-xs truncate flex-1" title={skipped.address}>
                        {skipped.address}
                      </span>
                      {skipped.txCount && (
                        <span className="text-xs text-muted-foreground shrink-0">{skipped.txCount} txs</span>
                      )}
                      <div className="flex gap-1 shrink-0">
                        {skipped.reason !== 'blacklisted' && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleAddToBlacklist(skipped.address, `Skipped: ${skipped.reason}`)}
                                data-testid={`button-blacklist-${skipped.id}`}
                              >
                                <Ban className="h-3.5 w-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Add to blacklist</TooltipContent>
                          </Tooltip>
                        )}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => {
                                setSingleAddress(skipped.address);
                                handleDismissSkipped(skipped.id!);
                              }}
                              data-testid={`button-retry-${skipped.id}`}
                            >
                              <RefreshCw className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Copy to single sync</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleDismissSkipped(skipped.id!)}
                              data-testid={`button-dismiss-${skipped.id}`}
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Dismiss</TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        )}

        {/* Address Blacklist */}
        {blacklist.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Ban className="h-5 w-5" />
                Address Blacklist ({blacklist.length})
              </CardTitle>
              <CardDescription>
                These addresses will always be skipped during sync
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="max-h-48">
                <div className="space-y-2">
                  {blacklist.map((entry) => (
                    <div key={entry.id} className="flex items-center gap-2 py-1.5 border-b last:border-0">
                      <span className="font-mono text-xs truncate flex-1" title={entry.address}>
                        {entry.address}
                      </span>
                      {entry.reason && (
                        <span className="text-xs text-muted-foreground truncate max-w-32" title={entry.reason}>
                          {entry.reason}
                        </span>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="shrink-0"
                        onClick={() => handleRemoveFromBlacklist(entry.address)}
                        data-testid={`button-unblacklist-${entry.id}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        )}

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
            <p>
              <strong>Sync Protection:</strong> High-volume addresses (over the threshold) and blacklisted addresses 
              are automatically skipped to prevent sync stalls. Skipped addresses can be reviewed and synced individually.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

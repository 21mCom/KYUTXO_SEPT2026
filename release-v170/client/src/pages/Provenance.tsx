import { useState, useEffect, useCallback, useMemo } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { AddressLink } from "@/components/AddressLink";
import { TxidLink } from "@/components/TxidLink";
import { 
  ArrowLeft,
  Search,
  ArrowRight,
  ArrowDown,
  ArrowUp,
  Link2,
  Loader2,
  Info,
  CheckCircle2,
  AlertCircle,
  GitBranch,
  Filter,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Clock,
  Layers,
  ShieldCheck,
  Download,
  Upload,
  Sparkles,
  X,
  Check
} from "lucide-react";
import { 
  findLabeledConnections, 
  findPathBetweenAddresses,
  getProvenanceChain,
  getProvenanceStats,
  exploreAddress,
  upgradeAddressImportance,
  getImportanceTierInfo,
  IMPORTANCE_TIERS,
  type ConnectionResult,
  type AddressNode,
  type FlowPath,
  type ConnectionNode,
  type AddressExplorationResult,
  type ProvenanceFilter
} from "@/lib/provenance";
import { type Record as DbRecord, type AddressImportance, USER_CURATED_TIERS, ALL_IMPORTANCE_TIERS } from "@/lib/database";
import { getRecordsByType } from "@/lib/dataFacade";
import { formatDistanceToNow, format } from "date-fns";
import { ContinuityProof } from "@/components/ContinuityProof";
import { usePageShortcuts } from "@/hooks/use-page-shortcuts";

export default function Provenance() {
  const [, navigate] = useLocation();
  const { toast } = useToast();

  usePageShortcuts("Provenance", [
    { keys: ["Enter"], action: "Explore the entered address (while the address field is focused)" },
  ]);
  
  const [stats, setStats] = useState<{
    labeledAddresses: number;
    syncedAddresses: number;
    transactionsStored: number;
    potentialConnections: number;
  } | null>(null);
  
  const [isSearching, setIsSearching] = useState(false);
  const [searchDepth, setSearchDepth] = useState<number>(3);
  
  // Address Explorer state
  const [explorerAddress, setExplorerAddress] = useState("");
  const [explorationResult, setExplorationResult] = useState<AddressExplorationResult | null>(null);
  const [isExploring, setIsExploring] = useState(false);
  const [addressPickerOpen, setAddressPickerOpen] = useState(false);
  const [addressSearchQuery, setAddressSearchQuery] = useState("");
  
  // Tier filter state
  const [enabledTiers, setEnabledTiers] = useState<Set<AddressImportance>>(
    () => new Set<AddressImportance>(USER_CURATED_TIERS)
  );
  const [excludePendingReview, setExcludePendingReview] = useState(true);
  
  // Find All Connections state
  const [connections, setConnections] = useState<ConnectionResult[]>([]);
  const [expandedConnections, setExpandedConnections] = useState<Set<number>>(new Set());
  
  // Expanded node details
  const [expandedNode, setExpandedNode] = useState<ConnectionNode | null>(null);
  
  // Upgrade dialog state
  const [upgradeDialogOpen, setUpgradeDialogOpen] = useState(false);
  const [nodeToUpgrade, setNodeToUpgrade] = useState<ConnectionNode | null>(null);

  const [allAddresses, setAllAddresses] = useState<DbRecord[]>([]);
  const [labeledAddresses, setLabeledAddresses] = useState<DbRecord[]>([]);

  const loadStats = useCallback(async () => {
    const s = await getProvenanceStats();
    setStats(s);
    
    const rawAddresses = await getRecordsByType('address');
    const addresses = rawAddresses;
    setAllAddresses(addresses);
    
    const labeled = addresses.filter(r => 
      r.label && 
      r.label !== '' && 
      r.owner !== 'Pending Review'
    );
    setLabeledAddresses(labeled);
  }, []);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const buildFilter = (): ProvenanceFilter => ({
    includeTiers: Array.from(enabledTiers),
    excludePendingReview,
  });

  const handleExploreAddress = async () => {
    const trimmedAddress = explorerAddress.trim();
    if (!trimmedAddress) {
      toast({
        variant: "destructive",
        title: "Missing Input",
        description: "Please enter or select an address to explore",
      });
      return;
    }

    if (!isValidBitcoinAddress(trimmedAddress)) {
      toast({
        variant: "destructive",
        title: "Invalid Address",
        description: "Please enter a valid Bitcoin address",
      });
      return;
    }

    setIsExploring(true);
    setExplorationResult(null);
    
    // Check if this is an unlabeled/unknown address
    const existingRecord = allAddresses.find(r => r.inputString === trimmedAddress);
    if (!existingRecord) {
      toast({
        title: "Exploring Unknown Address",
        description: "This address is not in your records. You can add it via the Records page.",
      });
    }
    
    try {
      const result = await exploreAddress(trimmedAddress, searchDepth, buildFilter());
      setExplorationResult(result);
      
      const totalConnections = result.incoming.length + result.outgoing.length;
      if (totalConnections === 0) {
        toast({
          title: "No Connections Found",
          description: result.filteredOut > 0 
            ? `${result.filteredOut} addresses were filtered out. Try adjusting your filters.`
            : "No connections found within the search depth. Try syncing more transactions.",
        });
      } else {
        toast({
          title: "Exploration Complete",
          description: `Found ${result.incoming.length} incoming and ${result.outgoing.length} outgoing connections.`,
        });
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Exploration Failed",
        description: error instanceof Error ? error.message : "An error occurred",
      });
    } finally {
      setIsExploring(false);
    }
  };

  const handleFindConnections = async () => {
    setIsSearching(true);
    setConnections([]);
    
    try {
      const results = await findLabeledConnections(searchDepth);
      setConnections(results);
      
      if (results.length === 0) {
        toast({
          title: "No Connections Found",
          description: "No paths found between labeled addresses. Try syncing more transactions.",
        });
      } else {
        toast({
          title: "Connections Found",
          description: `Found ${results.length} connection(s) between labeled addresses.`,
        });
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Search Failed",
        description: error instanceof Error ? error.message : "An error occurred",
      });
    } finally {
      setIsSearching(false);
    }
  };

  const handleUpgradeAddress = async () => {
    if (!nodeToUpgrade?.recordId) return;
    
    const success = await upgradeAddressImportance(nodeToUpgrade.recordId, 'verified');
    
    if (success) {
      toast({
        title: "Address Upgraded",
        description: "Address has been marked as verified.",
      });
      // Refresh exploration
      if (explorationResult) {
        handleExploreAddress();
      }
      loadStats();
    } else {
      toast({
        variant: "destructive",
        title: "Upgrade Failed",
        description: "Could not upgrade address importance.",
      });
    }
    
    setUpgradeDialogOpen(false);
    setNodeToUpgrade(null);
  };

  const formatSats = (sats: number) => {
    if (sats >= 100000000) {
      return `${(sats / 100000000).toFixed(8)} BTC`;
    }
    return `${sats.toLocaleString()} sats`;
  };

  const truncateAddress = (addr: string) => {
    return `${addr.substring(0, 8)}...${addr.substring(addr.length - 6)}`;
  };

  const getLabelForAddress = (address: string) => {
    const record = allAddresses.find(r => r.inputString === address);
    return record?.label || null;
  };

  // Check if an address looks like a valid Bitcoin address (basic validation)
  const isValidBitcoinAddress = (addr: string): boolean => {
    const trimmed = addr.trim();
    if (!trimmed) return false;
    // Basic regex for Bitcoin addresses (mainnet and testnet)
    // P2PKH: starts with 1, P2SH: starts with 3, Bech32: starts with bc1/tb1
    const btcRegex = /^(1[1-9A-HJ-NP-Za-km-z]{25,34}|3[1-9A-HJ-NP-Za-km-z]{25,34}|bc1[a-zA-HJ-NP-Z0-9]{25,90}|tb1[a-zA-HJ-NP-Z0-9]{25,90})$/;
    return btcRegex.test(trimmed);
  };

  // Get the matching record for the current explorer address (trimmed for comparison)
  const selectedAddressRecord = useMemo(() => {
    const trimmed = explorerAddress.trim();
    if (!trimmed) return null;
    return allAddresses.find(r => r.inputString === trimmed) || null;
  }, [explorerAddress, allAddresses]);

  // Check if explore button should be enabled
  const canExplore = useMemo(() => {
    const trimmed = explorerAddress.trim();
    return trimmed.length > 0 && isValidBitcoinAddress(trimmed);
  }, [explorerAddress]);

  // Filter addresses for the picker based on search query
  const filteredAddresses = useMemo(() => {
    if (!addressSearchQuery.trim()) {
      return allAddresses.slice(0, 100); // Limit initial display
    }
    const query = addressSearchQuery.toLowerCase();
    return allAddresses.filter(r => 
      r.inputString?.toLowerCase().includes(query) ||
      r.label?.toLowerCase().includes(query) ||
      r.owner?.toLowerCase().includes(query) ||
      r.walletName?.toLowerCase().includes(query)
    ).slice(0, 100);
  }, [allAddresses, addressSearchQuery]);

  // Handle address selection from picker
  const handleAddressSelect = (address: string) => {
    setExplorerAddress(address);
    setAddressPickerOpen(false);
    setAddressSearchQuery("");
  };

  // Handle clearing the address input
  const handleClearAddress = () => {
    setExplorerAddress("");
    setExplorationResult(null);
  };

  const toggleTier = (tier: AddressImportance) => {
    const newSet = new Set(enabledTiers);
    if (newSet.has(tier)) {
      newSet.delete(tier);
    } else {
      newSet.add(tier);
    }
    setEnabledTiers(newSet);
  };

  const toggleConnectionExpanded = (idx: number) => {
    const newSet = new Set(expandedConnections);
    if (newSet.has(idx)) {
      newSet.delete(idx);
    } else {
      newSet.add(idx);
    }
    setExpandedConnections(newSet);
  };

  const renderImportanceBadge = (importance: AddressImportance | undefined) => {
    const info = getImportanceTierInfo(importance);
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge 
            variant="outline" 
            className={`text-xs ${info.color}`}
          >
            {info.shortLabel}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          <p className="font-medium">{info.label}</p>
          <p className="text-xs text-muted-foreground">{info.description}</p>
        </TooltipContent>
      </Tooltip>
    );
  };

  const renderConnectionNode = (node: ConnectionNode, showUpgrade: boolean = true) => {
    const tierInfo = getImportanceTierInfo(node.addressImportance);
    const canUpgrade = node.recordId && 
      IMPORTANCE_TIERS[node.addressImportance || 'pending-review'] < IMPORTANCE_TIERS['verified'];
    
    return (
      <Popover>
        <PopoverTrigger asChild>
          <div 
            className="flex items-center gap-2 p-2 rounded-md bg-muted/50 cursor-pointer hover-elevate"
            data-testid={`connection-node-${node.address.slice(0, 8)}`}
          >
            {/* Direction indicator */}
            {node.direction === 'incoming' ? (
              <Download className="h-3 w-3 text-green-500 shrink-0" />
            ) : (
              <Upload className="h-3 w-3 text-blue-500 shrink-0" />
            )}
            
            {/* Hop count badge */}
            <Badge variant="outline" className="text-xs shrink-0">
              {node.hopDistance}
            </Badge>
            
            {/* Address/Label */}
            <span className="font-mono text-xs truncate flex-1">
              {node.label || truncateAddress(node.address)}
            </span>
            
            {/* Importance tier */}
            {renderImportanceBadge(node.addressImportance)}
            
            {/* Transaction count indicator */}
            <Badge variant="secondary" className="text-xs shrink-0">
              {node.edges.length} tx
            </Badge>
            
            <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
          </div>
        </PopoverTrigger>
        <PopoverContent className="w-80" align="start">
          <div className="space-y-3">
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-medium text-sm">
                  {node.label || 'Unlabeled Address'}
                </span>
                {renderImportanceBadge(node.addressImportance)}
              </div>
              <div className="py-1">
                <AddressLink 
                  address={node.address}
                  recordId={node.recordId}
                  hasMetadata={!!(node.label || node.owner !== 'Pending Review')}
                  truncate={false}
                  showCopy={true}
                />
              </div>
              {node.owner && node.owner !== 'Pending Review' && (
                <p className="text-xs text-muted-foreground">
                  Owner: {node.owner}
                </p>
              )}
              {node.walletName && (
                <p className="text-xs text-muted-foreground">
                  Wallet: {node.walletName}
                </p>
              )}
            </div>
            
            <Separator />
            
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Layers className="h-3 w-3" />
                <span>Hop Distance: {node.hopDistance}</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <GitBranch className="h-3 w-3" />
                <span>{node.edges.length} transaction{node.edges.length !== 1 ? 's' : ''}</span>
              </div>
            </div>
            
            <Separator />
            
            {/* Transaction details */}
            <div className="space-y-1 max-h-32 overflow-y-auto">
              <p className="text-xs font-medium">Transactions:</p>
              {node.edges.slice(0, 5).map((edge, idx) => (
                <div key={idx} className="text-xs flex items-center gap-1 flex-wrap">
                  <TxidLink 
                    txid={edge.txid}
                    showCopy={true}
                    showExternalLink={true}
                  />
                  <span className="text-muted-foreground">•</span>
                  <span>{formatSats(edge.amount)}</span>
                </div>
              ))}
              {node.edges.length > 5 && (
                <p className="text-xs text-muted-foreground">
                  +{node.edges.length - 5} more...
                </p>
              )}
            </div>
            
            {/* Actions */}
            {showUpgrade && canUpgrade && (
              <>
                <Separator />
                <Button 
                  size="sm" 
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    setNodeToUpgrade(node);
                    setUpgradeDialogOpen(true);
                  }}
                  data-testid={`button-upgrade-${node.address.slice(0, 8)}`}
                >
                  <ShieldCheck className="h-3 w-3 mr-1" />
                  Verify Address
                </Button>
              </>
            )}
          </div>
        </PopoverContent>
      </Popover>
    );
  };

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate("/")} data-testid="button-back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-page-title">Provenance Tracking</h1>
            <p className="text-muted-foreground">Explore connections and trace the origins of your Bitcoin addresses</p>
          </div>
        </div>

        <Alert>
          <Info className="h-4 w-4" />
          <AlertTitle>How It Works</AlertTitle>
          <AlertDescription>
            Select any address to explore all its connections - both incoming (sources) and outgoing (destinations).
            Use tier filters to focus on addresses you've identified, or include blockchain-discovered addresses for complete picture.
          </AlertDescription>
        </Alert>

        {/* Stats Overview */}
        <div className="grid gap-4 sm:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Labeled Addresses</CardDescription>
              <CardTitle className="text-2xl" data-testid="text-labeled-count">
                {stats?.labeledAddresses ?? '-'}
              </CardTitle>
            </CardHeader>
          </Card>
          
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Synced Addresses</CardDescription>
              <CardTitle className="text-2xl" data-testid="text-synced-count">
                {stats?.syncedAddresses ?? '-'}
              </CardTitle>
            </CardHeader>
          </Card>
          
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Transactions</CardDescription>
              <CardTitle className="text-2xl" data-testid="text-tx-count">
                {stats?.transactionsStored ?? '-'}
              </CardTitle>
            </CardHeader>
          </Card>
          
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Possible Pairs</CardDescription>
              <CardTitle className="text-2xl" data-testid="text-pairs-count">
                {stats?.potentialConnections ?? '-'}
              </CardTitle>
            </CardHeader>
          </Card>
        </div>

        {/* Address Explorer - Main Feature */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5" />
              Explore Address Connections
            </CardTitle>
            <CardDescription>
              Paste any Bitcoin address or select from your records to explore connections
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col sm:flex-row gap-4">
              {/* Address input with searchable picker */}
              <div className="space-y-2 flex-1">
                <Label htmlFor="explorer-address">Address to Explore</Label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      id="explorer-address"
                      placeholder="Paste address or select from list..."
                      value={explorerAddress}
                      onChange={(e) => setExplorerAddress(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && explorerAddress.trim()) {
                          handleExploreAddress();
                        }
                      }}
                      disabled={isExploring}
                      className="pr-8 font-mono text-sm"
                      data-testid="input-explorer-address"
                    />
                    {explorerAddress && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute right-0 top-0 h-full px-2 hover:bg-transparent"
                        onClick={handleClearAddress}
                        disabled={isExploring}
                        data-testid="button-clear-address"
                      >
                        <X className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    )}
                  </div>
                  <Popover open={addressPickerOpen} onOpenChange={setAddressPickerOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        disabled={isExploring}
                        data-testid="button-address-picker"
                      >
                        <ChevronDown className="h-4 w-4" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[400px] p-0" align="end">
                      <Command shouldFilter={false}>
                        <CommandInput 
                          placeholder="Search addresses, labels, owners..." 
                          value={addressSearchQuery}
                          onValueChange={setAddressSearchQuery}
                          data-testid="input-address-search"
                        />
                        <CommandList>
                          <CommandEmpty>No addresses found</CommandEmpty>
                          <CommandGroup heading={`${allAddresses.length} addresses (showing up to 100)`}>
                            {filteredAddresses.map((record) => (
                              <CommandItem
                                key={record.id}
                                value={record.inputString}
                                onSelect={() => handleAddressSelect(record.inputString)}
                                className="flex items-center gap-2"
                                data-testid={`address-option-${record.id}`}
                              >
                                <Check 
                                  className={`h-4 w-4 ${explorerAddress === record.inputString ? 'opacity-100' : 'opacity-0'}`} 
                                />
                                {renderImportanceBadge(record.addressImportance)}
                                <div className="flex flex-col flex-1 min-w-0">
                                  <span className="truncate font-medium">
                                    {record.label || 'Unlabeled'}
                                  </span>
                                  <span className="text-xs text-muted-foreground font-mono truncate">
                                    {truncateAddress(record.inputString)}
                                  </span>
                                </div>
                                {record.owner && record.owner !== 'Pending Review' && (
                                  <Badge variant="outline" className="text-xs shrink-0">
                                    {record.owner}
                                  </Badge>
                                )}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>
                {/* Show validation hint or matching record info */}
                {explorerAddress && (
                  <div className="text-xs">
                    {selectedAddressRecord ? (
                      <span className="text-muted-foreground flex items-center gap-1">
                        <Check className="h-3 w-3 text-green-500" />
                        {selectedAddressRecord.label || 'Unlabeled'} 
                        {selectedAddressRecord.owner && selectedAddressRecord.owner !== 'Pending Review' && (
                          <span>({selectedAddressRecord.owner})</span>
                        )}
                      </span>
                    ) : isValidBitcoinAddress(explorerAddress) ? (
                      <span className="text-muted-foreground flex items-center gap-1">
                        <AlertCircle className="h-3 w-3 text-yellow-500" />
                        Address not in records - will explore blockchain data
                      </span>
                    ) : (
                      <span className="text-destructive flex items-center gap-1">
                        <AlertCircle className="h-3 w-3" />
                        Invalid Bitcoin address format
                      </span>
                    )}
                  </div>
                )}
              </div>
              
              {/* Search depth */}
              <div className="space-y-2 w-full sm:w-32">
                <Label htmlFor="search-depth">Depth</Label>
                <Select
                  value={searchDepth.toString()}
                  onValueChange={(v) => setSearchDepth(parseInt(v))}
                  disabled={isExploring}
                >
                  <SelectTrigger id="search-depth" data-testid="select-search-depth">
                    <SelectValue placeholder="Depth" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="2">2 hops</SelectItem>
                    <SelectItem value="3">3 hops</SelectItem>
                    <SelectItem value="4">4 hops</SelectItem>
                    <SelectItem value="5">5 hops</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            
            {/* Tier filters */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Filter className="h-4 w-4 text-muted-foreground" />
                <Label className="text-sm">Filter by Address Type</Label>
              </div>
              <div className="flex flex-wrap gap-2">
                {ALL_IMPORTANCE_TIERS.slice(0, -1).map((tier) => {
                  const info = getImportanceTierInfo(tier);
                  const isEnabled = enabledTiers.has(tier);
                  return (
                    <Button
                      key={tier}
                      size="sm"
                      variant={isEnabled ? "default" : "outline"}
                      onClick={() => toggleTier(tier)}
                      className="text-xs"
                      data-testid={`filter-tier-${tier}`}
                    >
                      {info.label}
                    </Button>
                  );
                })}
                <Separator orientation="vertical" className="h-6" />
                <div className="flex items-center gap-2">
                  <Checkbox 
                    id="exclude-pending"
                    checked={excludePendingReview}
                    onCheckedChange={(checked) => setExcludePendingReview(!!checked)}
                    data-testid="checkbox-exclude-pending"
                  />
                  <Label htmlFor="exclude-pending" className="text-xs cursor-pointer">
                    Hide Pending Review
                  </Label>
                </div>
              </div>
            </div>
            
            <Button 
              onClick={handleExploreAddress}
              disabled={isExploring || !canExplore}
              className="w-full sm:w-auto"
              data-testid="button-explore-address"
            >
              {isExploring ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Exploring...
                </>
              ) : (
                <>
                  <Search className="mr-2 h-4 w-4" />
                  Explore Connections
                </>
              )}
            </Button>

            {/* Exploration Results */}
            {explorationResult && (
              <div className="space-y-4 pt-4 border-t">
                {/* Center address info */}
                {explorationResult.centerNode && (
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-primary/10 border">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">
                          {explorationResult.centerNode.label || 'Center Address'}
                        </span>
                        {renderImportanceBadge(explorationResult.centerNode.addressImportance)}
                      </div>
                      <div className="mt-1">
                        <AddressLink 
                          address={explorationResult.centerAddress}
                          recordId={explorationResult.centerNode.recordId}
                          hasMetadata={!!(explorationResult.centerNode.label)}
                          showCopy={true}
                        />
                      </div>
                    </div>
                    <div className="text-right text-sm">
                      <div className="flex items-center gap-1 text-green-600 dark:text-green-400">
                        <Download className="h-3 w-3" />
                        <span>{explorationResult.incoming.length} in</span>
                      </div>
                      <div className="flex items-center gap-1 text-blue-600 dark:text-blue-400">
                        <Upload className="h-3 w-3" />
                        <span>{explorationResult.outgoing.length} out</span>
                      </div>
                    </div>
                  </div>
                )}
                
                {explorationResult.filteredOut > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {explorationResult.filteredOut} address(es) hidden by filters
                  </p>
                )}
                
                {/* Dual column layout for incoming/outgoing */}
                <div className="grid gap-4 lg:grid-cols-2">
                  {/* Incoming connections */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Download className="h-4 w-4 text-green-500" />
                      <span className="font-medium text-sm">
                        Incoming ({explorationResult.incoming.length})
                      </span>
                      <span className="text-xs text-muted-foreground">
                        Sources of funds
                      </span>
                    </div>
                    <ScrollArea className="h-64 border rounded-md p-2">
                      {explorationResult.incoming.length > 0 ? (
                        <div className="space-y-1">
                          {explorationResult.incoming.map((node, idx) => (
                            <div key={idx}>
                              {renderConnectionNode(node)}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground text-center py-8">
                          No incoming connections found
                        </p>
                      )}
                    </ScrollArea>
                  </div>
                  
                  {/* Outgoing connections */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Upload className="h-4 w-4 text-blue-500" />
                      <span className="font-medium text-sm">
                        Outgoing ({explorationResult.outgoing.length})
                      </span>
                      <span className="text-xs text-muted-foreground">
                        Destinations
                      </span>
                    </div>
                    <ScrollArea className="h-64 border rounded-md p-2">
                      {explorationResult.outgoing.length > 0 ? (
                        <div className="space-y-1">
                          {explorationResult.outgoing.map((node, idx) => (
                            <div key={idx}>
                              {renderConnectionNode(node)}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground text-center py-8">
                          No outgoing connections found
                        </p>
                      )}
                    </ScrollArea>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Find All Connections - Secondary feature */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Link2 className="h-5 w-5" />
              Find All Labeled Connections
            </CardTitle>
            <CardDescription>
              Discover all paths between your labeled addresses
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-end gap-4">
              <Button 
                onClick={handleFindConnections}
                disabled={isSearching || (stats?.labeledAddresses ?? 0) < 2}
                data-testid="button-find-connections"
              >
                {isSearching ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Searching...
                  </>
                ) : (
                  <>
                    <Search className="mr-2 h-4 w-4" />
                    Find Connections
                  </>
                )}
              </Button>
              
              {(stats?.labeledAddresses ?? 0) < 2 && (
                <p className="text-sm text-muted-foreground">
                  Label at least 2 addresses to search for connections.
                </p>
              )}
            </div>

            {connections.length > 0 && (
              <ScrollArea className="h-64 border rounded-md p-4">
                <div className="space-y-2">
                  {connections.map((conn, idx) => (
                    <div 
                      key={idx} 
                      className="space-y-2"
                    >
                      <div 
                        className="flex items-center gap-2 p-2 rounded-md bg-muted/50 cursor-pointer hover-elevate flex-wrap"
                        onClick={() => toggleConnectionExpanded(idx)}
                        data-testid={`connection-${idx}`}
                      >
                        {expandedConnections.has(idx) ? (
                          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                        ) : (
                          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                        )}
                        <AddressLink 
                          address={conn.sourceAddress}
                          label={getLabelForAddress(conn.sourceAddress)}
                          hasMetadata={!!getLabelForAddress(conn.sourceAddress)}
                          showCopy={false}
                        />
                        <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                        <AddressLink 
                          address={conn.targetAddress}
                          label={getLabelForAddress(conn.targetAddress)}
                          hasMetadata={!!getLabelForAddress(conn.targetAddress)}
                          showCopy={false}
                        />
                        <div className="ml-auto flex items-center gap-2">
                          <Badge variant="outline" className="text-xs">
                            {conn.shortestPath} hop{conn.shortestPath !== 1 ? 's' : ''}
                          </Badge>
                          {conn.directConnection && (
                            <CheckCircle2 className="h-4 w-4 text-green-500" />
                          )}
                        </div>
                      </div>
                      
                      {/* Expanded path details */}
                      {expandedConnections.has(idx) && conn.paths.length > 0 && (
                        <div className="ml-6 p-2 rounded-md border bg-background">
                          {conn.paths[0].hops.map((hop, hopIdx) => (
                            <div key={hopIdx} className="flex items-center gap-2 text-xs py-1 flex-wrap">
                              <Badge variant="outline" className="shrink-0 w-5 h-5 flex items-center justify-center p-0">
                                {hopIdx + 1}
                              </Badge>
                              <AddressLink 
                                address={hop.fromAddress}
                                label={getLabelForAddress(hop.fromAddress)}
                                hasMetadata={!!getLabelForAddress(hop.fromAddress)}
                                showCopy={false}
                              />
                              <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                              <AddressLink 
                                address={hop.toAddress}
                                label={getLabelForAddress(hop.toAddress)}
                                hasMetadata={!!getLabelForAddress(hop.toAddress)}
                                showCopy={false}
                              />
                              <span className="ml-auto text-muted-foreground whitespace-nowrap">
                                {formatSats(hop.amount)}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
        {/* Continuity Proof Section */}
        <ContinuityProof 
          selectedAddress={explorerAddress.trim() || undefined}
          onAddressSelect={(address) => setExplorerAddress(address)}
        />
      </div>
      
      {/* Upgrade Dialog */}
      <Dialog open={upgradeDialogOpen} onOpenChange={setUpgradeDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Verify Address</DialogTitle>
            <DialogDescription>
              Mark this address as verified? This indicates you have confirmed ownership or identified this address.
            </DialogDescription>
          </DialogHeader>
          
          {nodeToUpgrade && (
            <div className="space-y-2 p-4 rounded-lg bg-muted">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium">
                  {nodeToUpgrade.label || 'Unlabeled Address'}
                </span>
                {renderImportanceBadge(nodeToUpgrade.addressImportance)}
                <ArrowRight className="h-4 w-4" />
                {renderImportanceBadge('verified')}
              </div>
              <div className="pt-1">
                <AddressLink 
                  address={nodeToUpgrade.address}
                  recordId={nodeToUpgrade.recordId}
                  hasMetadata={!!(nodeToUpgrade.label)}
                  truncate={false}
                  showCopy={true}
                />
              </div>
            </div>
          )}
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setUpgradeDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleUpgradeAddress} data-testid="button-confirm-upgrade">
              <ShieldCheck className="h-4 w-4 mr-1" />
              Verify
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

import { useState, useEffect, useMemo } from "react";
import { useLocation } from "wouter";
import { 
  Wallet, 
  AlertTriangle, 
  CheckCircle2, 
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Search,
  ExternalLink,
  ArrowUpDown,
  RefreshCw
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { decryptRecords, isEncryptionReady } from "@/lib/encryptionFacade";
import { db } from "@/lib/database";
import type { Record as DbRecord } from "@/lib/database";

interface WalletStats {
  walletName: string;
  receiveTotal: number;
  receiveUsed: number;
  changeTotal: number;
  changeUsed: number;
  unknownTotal: number;
  unknownUsed: number;
  addressIds: number[];
}

type SortField = 'walletName' | 'receiveUsage' | 'changeUsage' | 'totalUsage';
type SortDirection = 'asc' | 'desc';

function parseChainType(record: DbRecord): 'receive' | 'change' | 'unknown' {
  // First check explicit chainType field
  if (record.chainType === 'receive') return 'receive';
  if (record.chainType === 'change') return 'change';
  
  // Try to parse from derivation path (e.g., m/84'/0'/0'/0/5 = receive, m/84'/0'/0'/1/5 = change)
  if (record.derivationPath) {
    const parts = record.derivationPath.split('/');
    // Look for the chain index (usually 4th component after account)
    // Standard: m/purpose'/coin'/account'/chain/index
    if (parts.length >= 5) {
      const chainIndex = parts[parts.length - 2]; // Second to last is chain
      if (chainIndex === '0') return 'receive';
      if (chainIndex === '1') return 'change';
    }
  }
  
  // If no derivation info, treat as receive (user's preference)
  return 'receive';
}

function getUsagePercentage(used: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((used / total) * 100);
}

function getStatusColor(percentage: number): 'green' | 'yellow' | 'red' {
  if (percentage < 70) return 'green';
  if (percentage < 90) return 'yellow';
  return 'red';
}

function StatusBadge({ used, total }: { used: number; total: number }) {
  if (total === 0) {
    return <Badge variant="outline" className="text-muted-foreground">N/A</Badge>;
  }
  
  const percentage = getUsagePercentage(used, total);
  const color = getStatusColor(percentage);
  
  const colorClasses = {
    green: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
    yellow: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
    red: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
  };
  
  const Icon = color === 'green' ? CheckCircle2 : color === 'yellow' ? AlertCircle : AlertTriangle;
  
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge className={`${colorClasses[color]} gap-1`}>
          <Icon className="h-3 w-3" />
          {used}/{total} ({percentage}%)
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        {percentage < 70 && "Plenty of unused addresses available"}
        {percentage >= 70 && percentage < 90 && "Running low on unused addresses"}
        {percentage >= 90 && "Almost all addresses used - import more soon!"}
      </TooltipContent>
    </Tooltip>
  );
}

function OverallStatusIndicator({ stats }: { stats: WalletStats }) {
  // Calculate overall usage across all address types
  const totalAddresses = stats.receiveTotal + stats.changeTotal + stats.unknownTotal;
  const totalUsed = stats.receiveUsed + stats.changeUsed + stats.unknownUsed;
  
  if (totalAddresses === 0) return null;
  
  const overallPercentage = getUsagePercentage(totalUsed, totalAddresses);
  const color = getStatusColor(overallPercentage);
  
  const Icon = color === 'green' ? CheckCircle2 : color === 'yellow' ? AlertCircle : AlertTriangle;
  const colorClasses = {
    green: "text-green-600 dark:text-green-400",
    yellow: "text-yellow-600 dark:text-yellow-400", 
    red: "text-red-600 dark:text-red-400"
  };
  
  return <Icon className={`h-5 w-5 ${colorClasses[color]}`} />;
}

export default function WalletOverview() {
  const [, navigate] = useLocation();
  const [walletStats, setWalletStats] = useState<WalletStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortField, setSortField] = useState<SortField>('walletName');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [expandedWallets, setExpandedWallets] = useState<Set<string>>(new Set());

  const loadWalletStats = async () => {
    setLoading(true);
    try {
      const rawRecords = await db.records.toArray();
      let records: DbRecord[];
      
      if (isEncryptionReady()) {
        records = await decryptRecords(rawRecords);
      } else {
        records = rawRecords;
      }

      // Filter to only address records with wallet names
      const addressRecords = records.filter(r => r.type === 'address' && r.walletName);
      
      // Get all transaction records for checking address usage
      const txRecords = records.filter(r => r.type === 'transaction');
      
      // Build a set of addresses that appear in transactions
      const usedAddresses = new Set<string>();
      
      // Check each address against transactions by looking at discoveredInTxid or firstSeenBlockTime
      for (const record of addressRecords) {
        // An address is "used" if it has transaction activity
        // We detect this by checking if it has firstSeenBlockTime (indicates blockchain activity)
        // or if it was discovered in a transaction
        if (record.firstSeenBlockTime || record.discoveredInTxid) {
          usedAddresses.add(record.inputString);
        }
      }
      
      // Also check if any address appears as a participant in transaction labels/notes
      // This is a fallback check
      for (const tx of txRecords) {
        // If this tx references addresses in its notes or other fields, those are used
        // For now, we rely on firstSeenBlockTime as the primary indicator
      }
      
      // Group by wallet name
      const walletMap = new Map<string, WalletStats>();
      
      for (const record of addressRecords) {
        const walletName = record.walletName!;
        const chainType = parseChainType(record);
        const isUsed = usedAddresses.has(record.inputString);
        
        if (!walletMap.has(walletName)) {
          walletMap.set(walletName, {
            walletName,
            receiveTotal: 0,
            receiveUsed: 0,
            changeTotal: 0,
            changeUsed: 0,
            unknownTotal: 0,
            unknownUsed: 0,
            addressIds: []
          });
        }
        
        const stats = walletMap.get(walletName)!;
        
        if (chainType === 'receive') {
          stats.receiveTotal++;
          if (isUsed) stats.receiveUsed++;
        } else if (chainType === 'change') {
          stats.changeTotal++;
          if (isUsed) stats.changeUsed++;
        } else {
          stats.unknownTotal++;
          if (isUsed) stats.unknownUsed++;
        }
        
        if (record.id) {
          stats.addressIds.push(record.id);
        }
      }
      
      setWalletStats(Array.from(walletMap.values()));
    } catch (error) {
      console.error("Failed to load wallet stats:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadWalletStats();
  }, []);

  const sortedAndFilteredStats = useMemo(() => {
    let filtered = walletStats;
    
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = walletStats.filter(w => 
        w.walletName.toLowerCase().includes(query)
      );
    }
    
    return [...filtered].sort((a, b) => {
      let comparison = 0;
      
      switch (sortField) {
        case 'walletName':
          comparison = a.walletName.localeCompare(b.walletName);
          break;
        case 'receiveUsage':
          comparison = getUsagePercentage(a.receiveUsed, a.receiveTotal) - 
                       getUsagePercentage(b.receiveUsed, b.receiveTotal);
          break;
        case 'changeUsage':
          comparison = getUsagePercentage(a.changeUsed, a.changeTotal) - 
                       getUsagePercentage(b.changeUsed, b.changeTotal);
          break;
        case 'totalUsage': {
          const aTotal = a.receiveTotal + a.changeTotal + a.unknownTotal;
          const aUsed = a.receiveUsed + a.changeUsed + a.unknownUsed;
          const bTotal = b.receiveTotal + b.changeTotal + b.unknownTotal;
          const bUsed = b.receiveUsed + b.changeUsed + b.unknownUsed;
          comparison = getUsagePercentage(aUsed, aTotal) - getUsagePercentage(bUsed, bTotal);
          break;
        }
      }
      
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [walletStats, searchQuery, sortField, sortDirection]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const toggleExpanded = (walletName: string) => {
    setExpandedWallets(prev => {
      const newSet = new Set(prev);
      if (newSet.has(walletName)) {
        newSet.delete(walletName);
      } else {
        newSet.add(walletName);
      }
      return newSet;
    });
  };

  // Summary stats
  const summaryStats = useMemo(() => {
    const criticalWallets = walletStats.filter(w => {
      const total = w.receiveTotal + w.changeTotal + w.unknownTotal;
      const used = w.receiveUsed + w.changeUsed + w.unknownUsed;
      return total > 0 && getUsagePercentage(used, total) >= 90;
    });
    
    const warningWallets = walletStats.filter(w => {
      const total = w.receiveTotal + w.changeTotal + w.unknownTotal;
      const used = w.receiveUsed + w.changeUsed + w.unknownUsed;
      const pct = total > 0 ? getUsagePercentage(used, total) : 0;
      return pct >= 70 && pct < 90;
    });
    
    return { critical: criticalWallets.length, warning: warningWallets.length };
  }, [walletStats]);

  const SortableHeader = ({ field, children }: { field: SortField; children: React.ReactNode }) => (
    <TableHead 
      className="cursor-pointer hover-elevate select-none"
      onClick={() => handleSort(field)}
      data-testid={`header-${field}`}
    >
      <div className="flex items-center gap-1">
        {children}
        <ArrowUpDown className={`h-3 w-3 ${sortField === field ? 'opacity-100' : 'opacity-40'}`} />
      </div>
    </TableHead>
  );

  return (
    <div className="flex flex-col h-full p-6 gap-4 overflow-hidden">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <Wallet className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Wallet Overview</h1>
        </div>
        
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={loadWalletStats}
            disabled={loading}
            data-testid="button-refresh"
          >
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Wallets
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-total-wallets">
              {walletStats.length}
            </div>
          </CardContent>
        </Card>
        
        <Card className={summaryStats.warning > 0 ? "border-yellow-500/50" : ""}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-yellow-500" />
              Needs Attention
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-600 dark:text-yellow-400" data-testid="text-warning-wallets">
              {summaryStats.warning}
            </div>
            <p className="text-xs text-muted-foreground">70-90% addresses used</p>
          </CardContent>
        </Card>
        
        <Card className={summaryStats.critical > 0 ? "border-red-500/50" : ""}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              Critical
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600 dark:text-red-400" data-testid="text-critical-wallets">
              {summaryStats.critical}
            </div>
            <p className="text-xs text-muted-foreground">90%+ addresses used</p>
          </CardContent>
        </Card>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search wallets..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
          data-testid="input-search"
        />
      </div>

      {/* Wallet Table */}
      <Card className="flex-1 overflow-hidden">
        <ScrollArea className="h-full">
          {loading ? (
            <div className="flex items-center justify-center h-48">
              <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : sortedAndFilteredStats.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-center p-4">
              <Wallet className="h-12 w-12 text-muted-foreground/50 mb-4" />
              <h3 className="font-medium text-muted-foreground">No wallets found</h3>
              <p className="text-sm text-muted-foreground mt-1">
                {searchQuery ? "Try a different search term" : "Import addresses with wallet names to see them here"}
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <SortableHeader field="walletName">Wallet Name</SortableHeader>
                  <SortableHeader field="receiveUsage">Receive Addresses</SortableHeader>
                  <SortableHeader field="changeUsage">Change Addresses</SortableHeader>
                  <SortableHeader field="totalUsage">Overall Status</SortableHeader>
                  <TableHead className="w-20">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedAndFilteredStats.map((stats) => {
                  const isExpanded = expandedWallets.has(stats.walletName);
                  const totalAddresses = stats.receiveTotal + stats.changeTotal + stats.unknownTotal;
                  const totalUsed = stats.receiveUsed + stats.changeUsed + stats.unknownUsed;
                  const overallPct = getUsagePercentage(totalUsed, totalAddresses);
                  
                  return (
                    <Collapsible key={stats.walletName} open={isExpanded} asChild>
                      <>
                        <TableRow 
                          className="cursor-pointer hover-elevate"
                          onClick={() => toggleExpanded(stats.walletName)}
                          data-testid={`row-wallet-${stats.walletName}`}
                        >
                          <TableCell>
                            <CollapsibleTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-6 w-6">
                                {isExpanded ? (
                                  <ChevronDown className="h-4 w-4" />
                                ) : (
                                  <ChevronRight className="h-4 w-4" />
                                )}
                              </Button>
                            </CollapsibleTrigger>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <OverallStatusIndicator stats={stats} />
                              <span className="font-medium">{stats.walletName}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <StatusBadge used={stats.receiveUsed} total={stats.receiveTotal} />
                          </TableCell>
                          <TableCell>
                            <StatusBadge used={stats.changeUsed} total={stats.changeTotal} />
                          </TableCell>
                          <TableCell>
                            {totalAddresses > 0 && (
                              <span className={`font-medium ${
                                overallPct >= 90 ? 'text-red-600 dark:text-red-400' :
                                overallPct >= 70 ? 'text-yellow-600 dark:text-yellow-400' :
                                'text-green-600 dark:text-green-400'
                              }`}>
                                {totalUsed}/{totalAddresses} addresses used ({overallPct}%)
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={(e) => {
                                e.stopPropagation();
                                navigate(`/?walletName=${encodeURIComponent(stats.walletName)}`);
                              }}
                              title="View addresses in Records"
                              data-testid={`button-view-${stats.walletName}`}
                            >
                              <ExternalLink className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                        <CollapsibleContent asChild>
                          <TableRow className="bg-muted/30">
                            <TableCell colSpan={6} className="p-4">
                              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                                <div>
                                  <h4 className="font-medium mb-2 flex items-center gap-2">
                                    Receive Addresses
                                    {stats.receiveTotal > 0 && (
                                      <span className="text-muted-foreground">
                                        ({stats.receiveUsed} used, {stats.receiveTotal - stats.receiveUsed} available)
                                      </span>
                                    )}
                                  </h4>
                                  {stats.receiveTotal > 0 ? (
                                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                                      <div 
                                        className={`h-full transition-all ${
                                          getStatusColor(getUsagePercentage(stats.receiveUsed, stats.receiveTotal)) === 'green' 
                                            ? 'bg-green-500' 
                                            : getStatusColor(getUsagePercentage(stats.receiveUsed, stats.receiveTotal)) === 'yellow'
                                            ? 'bg-yellow-500'
                                            : 'bg-red-500'
                                        }`}
                                        style={{ width: `${getUsagePercentage(stats.receiveUsed, stats.receiveTotal)}%` }}
                                      />
                                    </div>
                                  ) : (
                                    <p className="text-muted-foreground">No receive addresses tracked</p>
                                  )}
                                </div>
                                
                                <div>
                                  <h4 className="font-medium mb-2 flex items-center gap-2">
                                    Change Addresses
                                    {stats.changeTotal > 0 && (
                                      <span className="text-muted-foreground">
                                        ({stats.changeUsed} used, {stats.changeTotal - stats.changeUsed} available)
                                      </span>
                                    )}
                                  </h4>
                                  {stats.changeTotal > 0 ? (
                                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                                      <div 
                                        className={`h-full transition-all ${
                                          getStatusColor(getUsagePercentage(stats.changeUsed, stats.changeTotal)) === 'green' 
                                            ? 'bg-green-500' 
                                            : getStatusColor(getUsagePercentage(stats.changeUsed, stats.changeTotal)) === 'yellow'
                                            ? 'bg-yellow-500'
                                            : 'bg-red-500'
                                        }`}
                                        style={{ width: `${getUsagePercentage(stats.changeUsed, stats.changeTotal)}%` }}
                                      />
                                    </div>
                                  ) : (
                                    <p className="text-muted-foreground">No change addresses tracked</p>
                                  )}
                                </div>
                                
                                {stats.unknownTotal > 0 && (
                                  <div>
                                    <h4 className="font-medium mb-2 flex items-center gap-2">
                                      Unclassified
                                      <span className="text-muted-foreground">
                                        ({stats.unknownUsed} used, {stats.unknownTotal - stats.unknownUsed} available)
                                      </span>
                                    </h4>
                                    <p className="text-xs text-muted-foreground">
                                      Addresses without derivation path info (treated as receive)
                                    </p>
                                  </div>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        </CollapsibleContent>
                      </>
                    </Collapsible>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </ScrollArea>
      </Card>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-green-500" />
          <span>&lt;70% used - Healthy</span>
        </div>
        <div className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4 text-yellow-500" />
          <span>70-90% used - Running low</span>
        </div>
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-red-500" />
          <span>&gt;90% used - Import more addresses</span>
        </div>
      </div>
    </div>
  );
}

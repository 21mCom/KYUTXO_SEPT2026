import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
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
  Info
} from "lucide-react";
import { transactionSyncService, type SyncProgress, type SyncResult } from "@/lib/transaction-sync";
import { db, type Record as DbRecord } from "@/lib/database";
import { formatDistanceToNow } from "date-fns";

export default function TransactionSync() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  
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

  const loadStats = useCallback(async () => {
    const s = await transactionSyncService.getStats();
    setStats(s);
    
    const pending = await transactionSyncService.getPendingReviewAddresses();
    setPendingReviewAddresses(pending);
  }, []);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const handleSync = async () => {
    setIsSyncing(true);
    setSyncProgress({
      phase: 'idle',
      addressesTotal: 0,
      addressesProcessed: 0,
      transactionsFound: 0,
      transactionsNew: 0,
      newAddressRecords: 0,
    });
    setLastResult(null);

    transactionSyncService.setProgressCallback((progress) => {
      setSyncProgress(progress);
    });

    try {
      const result = await transactionSyncService.syncAllAddresses();
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
      case 'syncing-addresses': return `Syncing address ${syncProgress.addressesProcessed + 1} of ${syncProgress.addressesTotal}`;
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

        <Alert>
          <Info className="h-4 w-4" />
          <AlertTitle>Privacy Notice</AlertTitle>
          <AlertDescription>
            This feature queries mempool.space to fetch transaction data. The addresses you're syncing 
            will be visible to their servers. For maximum privacy, consider running your own Bitcoin node 
            (future feature).
          </AlertDescription>
        </Alert>

        {/* Stats Overview */}
        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Tracked Addresses</CardDescription>
              <CardTitle className="text-2xl" data-testid="text-total-addresses">
                {stats?.totalAddresses ?? '-'}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                {stats?.syncedAddresses ?? 0} synced
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
              Fetch latest blockchain data for all addresses in your database (manual entries, wallet imports, xPub derivations)
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
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

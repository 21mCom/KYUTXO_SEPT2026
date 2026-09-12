import { useState, useEffect, useRef, type ReactNode } from 'react';
import { ALL_IMPORTANCE_TIERS, IMPORTANCE_TIER_LABELS } from '@/lib/database';
import { getVaultRepository } from '@/lib/repository';
import { countAttachments } from '@/lib/data/attachments-crud';
import { countAddressSyncState } from '@/lib/data/address-sync-crud';
import { countPriceData } from '@/lib/data/price-data-crud';
import {
  countRecords,
  countRecordsByType,
  countRecordsByImportance,
  eachAddressRecord,
} from '@/lib/data/record-crud';
import {
  countTransactions,
  countTransactionParticipants,
  countAddresslessParticipants,
  countUnresolvedPrevoutInputs,
} from '@/lib/data/transaction-crud';
import { hasLegacyEncryptedRecords } from '@/lib/legacy-decrypt';
import { detectStaleCachedBalances, type StaleBalanceCheckResult } from '@/lib/data/address-stats';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { 
  Database, 
  Wallet, 
  FileText, 
  Tag, 
  FolderOpen,
  Paperclip,
  Link2,
  CheckCircle2,
  Key,
  Search,
  Users,
  ArrowRightLeft,
  DollarSign,
  BarChart3,
  RefreshCw,
  ShieldCheck,
  AlertTriangle,
  Loader2,
} from 'lucide-react';

interface StatCardProps {
  title: string;
  value: number | string;
  description?: string;
  icon: ReactNode;
}

function StatCard({ title, value, description, icon }: StatCardProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <div className="text-muted-foreground">{icon}</div>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold" data-testid={`stat-value-${title.toLowerCase().replace(/\s+/g, '-')}`}>
          {typeof value === 'number' ? value.toLocaleString() : value}
        </div>
        {description && (
          <p className="text-xs text-muted-foreground mt-1">{description}</p>
        )}
      </CardContent>
    </Card>
  );
}

interface BreakdownItemProps {
  label: string;
  count: number;
  total: number;
  color?: string;
}

function BreakdownItem({ label, count, total, color }: BreakdownItemProps) {
  const percentage = total > 0 ? Math.round((count / total) * 100) : 0;
  
  return (
    <div className="flex items-center justify-between py-2 border-b last:border-b-0">
      <div className="flex items-center gap-2">
        {color && <div className={`w-2 h-2 rounded-full ${color}`} />}
        <span className="text-sm">{label}</span>
      </div>
      <div className="flex items-center gap-2">
        <Badge variant="secondary">{count.toLocaleString()}</Badge>
        <span className="text-xs text-muted-foreground w-10 text-right">{percentage}%</span>
      </div>
    </div>
  );
}

interface StatsData {
  totalRecords: number;
  addressCount: number;
  transactionCount: number;
  otherCount: number;
  importanceBreakdown: { [key: string]: number };
  sourceBreakdown: [string, number][];
  ownerBreakdown: [string, number][];
  tags: number;
  categories: number;
  attachments: number;
  blockchainTransactions: number;
  transactionParticipants: number;
  addressSyncState: number;
  priceData: number;
  addresslessParticipants: number;
  unresolvedPrevoutInputs: number;
  hasLegacyEncryptedData: boolean;
}

async function loadAllStats(): Promise<StatsData> {
  const [
    totalRecords,
    addressCount,
    transactionCount,
    otherCount,
    tags,
    categories,
    attachments,
    blockchainTransactions,
    transactionParticipants,
    addressSyncState,
    priceData,
    addresslessParticipants,
    unresolvedPrevoutInputs,
    hasLegacyEncryptedData,
    ...importanceCounts
  ] = await Promise.all([
    countRecords(),
    countRecordsByType('address'),
    countRecordsByType('transaction'),
    countRecordsByType('other'),
    getVaultRepository().count('tags'),
    getVaultRepository().count('categories'),
    countAttachments(),
    countTransactions(),
    countTransactionParticipants(),
    countAddressSyncState(),
    countPriceData(),
    countAddresslessParticipants(),
    countUnresolvedPrevoutInputs(),
    hasLegacyEncryptedRecords(),
    ...ALL_IMPORTANCE_TIERS.map(tier =>
      countRecordsByImportance(tier as Parameters<typeof countRecordsByImportance>[0])
    ),
  ]);

  const importanceBreakdown: { [key: string]: number } = {};
  ALL_IMPORTANCE_TIERS.forEach((tier, i) => {
    importanceBreakdown[tier] = importanceCounts[i];
  });

  const tieredTotal = Object.values(importanceBreakdown).reduce((sum, c) => sum + c, 0);
  const legacyManual = addressCount - tieredTotal;
  if (legacyManual > 0) {
    importanceBreakdown['manual'] = (importanceBreakdown['manual'] || 0) + legacyManual;
  }

  const sourceBreakdown: { [key: string]: number } = {};
  const ownerBreakdown: { [key: string]: number } = {};

  await eachAddressRecord(record => {
    const source = record.source || 'manual';
    sourceBreakdown[source] = (sourceBreakdown[source] || 0) + 1;

    const owner = record.owner || 'Unknown';
    ownerBreakdown[owner] = (ownerBreakdown[owner] || 0) + 1;
  });

  const sortedSources = Object.entries(sourceBreakdown).sort((a, b) => b[1] - a[1]);
  const sortedOwners = Object.entries(ownerBreakdown).sort((a, b) => b[1] - a[1]);

  return {
    totalRecords,
    addressCount,
    transactionCount,
    otherCount,
    importanceBreakdown,
    sourceBreakdown: sortedSources,
    ownerBreakdown: sortedOwners,
    tags,
    categories,
    attachments,
    blockchainTransactions,
    transactionParticipants,
    addressSyncState,
    priceData,
    addresslessParticipants,
    unresolvedPrevoutInputs,
    hasLegacyEncryptedData,
  };
}

export default function DataStats() {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // On-demand stale cached balance check
  const [staleCheckState, setStaleCheckState] = useState<
    | { status: 'idle' }
    | { status: 'running'; sampled: number }
    | { status: 'done'; result: StaleBalanceCheckResult }
  >({ status: 'idle' });
  const staleCheckAbortRef = useRef<AbortController | null>(null);

  const refresh = async () => {
    setIsLoading(true);
    try {
      const data = await loadAllStats();
      setStats(data);
    } catch (error) {
      console.error('Failed to load stats:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const runStaleCheck = async () => {
    staleCheckAbortRef.current?.abort();
    const abort = new AbortController();
    staleCheckAbortRef.current = abort;
    setStaleCheckState({ status: 'running', sampled: 0 });
    try {
      const result = await detectStaleCachedBalances({
        signal: abort.signal,
        onProgress: (sampled) => setStaleCheckState({ status: 'running', sampled }),
      });
      if (!abort.signal.aborted) {
        setStaleCheckState({ status: 'done', result });
      }
    } catch {
      if (!abort.signal.aborted) setStaleCheckState({ status: 'idle' });
    }
  };

  useEffect(() => {
    refresh();
    return () => { staleCheckAbortRef.current?.abort(); };
  }, []);

  if (!stats) {
    return (
      <ScrollArea className="h-full">
        <div className="p-6 flex items-center justify-center">
          <div className="animate-pulse text-muted-foreground">Loading statistics...</div>
        </div>
      </ScrollArea>
    );
  }

  const importanceColors: { [key: string]: string } = {
    'verified': 'bg-green-500',
    'manual': 'bg-blue-500',
    'wallet-import': 'bg-purple-500',
    'xpub-derived': 'bg-orange-500',
    'blockchain-discovered': 'bg-yellow-500',
    'pending-review': 'bg-gray-400',
  };

  // Derived from the shared tier labels so it stays in sync with the tier set;
  // this page keeps its own labels for a few tiers.
  const importanceLabels: { [key: string]: string } = {
    ...IMPORTANCE_TIER_LABELS,
    'manual': 'Manual Entry',
    'wallet-import': 'Wallet Data Sync',
    'xpub-derived': 'xPub Derived',
  };

  return (
    <ScrollArea className="h-full">
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-page-title">Data Stats</h1>
            <p className="text-muted-foreground">Database statistics and record breakdowns</p>
          </div>
          <Button variant="outline" size="sm" onClick={refresh} disabled={isLoading} data-testid="button-refresh-stats">
            <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
          <StatCard
            title="Total Records"
            value={stats.totalRecords}
            description="All entries in database"
            icon={<Database className="h-4 w-4" />}
          />
          <StatCard
            title="Addresses"
            value={stats.addressCount}
            description="Bitcoin addresses tracked"
            icon={<Wallet className="h-4 w-4" />}
          />
          <StatCard
            title="Transaction IDs"
            value={stats.transactionCount}
            description="Transaction records"
            icon={<FileText className="h-4 w-4" />}
          />
          <StatCard
            title="Other Records"
            value={stats.otherCount}
            description="Other metadata entries"
            icon={<FolderOpen className="h-4 w-4" />}
          />
        </div>

        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
          <StatCard
            title="Tags"
            value={stats.tags}
            description="Custom tags created"
            icon={<Tag className="h-4 w-4" />}
          />
          <StatCard
            title="Categories"
            value={stats.categories}
            description="Categories defined"
            icon={<FolderOpen className="h-4 w-4" />}
          />
          <StatCard
            title="Attachments"
            value={stats.attachments}
            description="Files attached to records"
            icon={<Paperclip className="h-4 w-4" />}
          />
          <StatCard
            title="Price Data Points"
            value={stats.priceData}
            description="Historical price entries"
            icon={<DollarSign className="h-4 w-4" />}
          />
        </div>

        <div className="grid gap-4 grid-cols-2 lg:grid-cols-3">
          <StatCard
            title="Blockchain Transactions"
            value={stats.blockchainTransactions}
            description="Synced from blockchain"
            icon={<ArrowRightLeft className="h-4 w-4" />}
          />
          <StatCard
            title="Transaction Participants"
            value={stats.transactionParticipants}
            description="Inputs + outputs tracked"
            icon={<Link2 className="h-4 w-4" />}
          />
          <StatCard
            title="Synced Addresses"
            value={stats.addressSyncState}
            description="Addresses with sync state"
            icon={<Search className="h-4 w-4" />}
          />
        </div>

        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4" />
                Address Importance
              </CardTitle>
              <CardDescription>Breakdown by verification tier</CardDescription>
            </CardHeader>
            <CardContent>
              {Object.entries(stats.importanceBreakdown).map(([key, count]) => (
                <BreakdownItem
                  key={key}
                  label={importanceLabels[key] || key}
                  count={count}
                  total={stats.addressCount}
                  color={importanceColors[key]}
                />
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Key className="h-4 w-4" />
                Address Sources
              </CardTitle>
              <CardDescription>How addresses were added</CardDescription>
            </CardHeader>
            <CardContent>
              {stats.sourceBreakdown.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No addresses yet</p>
              ) : (
                stats.sourceBreakdown.slice(0, 8).map(([source, count]) => (
                  <BreakdownItem
                    key={source}
                    label={source}
                    count={count}
                    total={stats.addressCount}
                  />
                ))
              )}
              {stats.sourceBreakdown.length > 8 && (
                <p className="text-xs text-muted-foreground text-center pt-2">
                  +{stats.sourceBreakdown.length - 8} more sources
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Users className="h-4 w-4" />
                Address Owners
              </CardTitle>
              <CardDescription>Top owners by address count</CardDescription>
            </CardHeader>
            <CardContent>
              {stats.ownerBreakdown.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No addresses yet</p>
              ) : (
                stats.ownerBreakdown.slice(0, 8).map(([owner, count]) => (
                  <BreakdownItem
                    key={owner}
                    label={owner}
                    count={count}
                    total={stats.addressCount}
                  />
                ))
              )}
              {stats.ownerBreakdown.length > 8 && (
                <p className="text-xs text-muted-foreground text-center pt-2">
                  +{stats.ownerBreakdown.length - 8} more owners
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="h-4 w-4" />
              Quick Summary
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 grid-cols-2 md:grid-cols-4 text-center">
              <div>
                <div className="text-3xl font-bold text-green-500" data-testid="stat-verified-count">
                  {stats.importanceBreakdown['verified']}
                </div>
                <p className="text-sm text-muted-foreground">Verified Addresses</p>
              </div>
              <div>
                <div className="text-3xl font-bold text-blue-500" data-testid="stat-manual-count">
                  {stats.importanceBreakdown['manual'] + stats.importanceBreakdown['wallet-import']}
                </div>
                <p className="text-sm text-muted-foreground">Known Addresses</p>
              </div>
              <div>
                <div className="text-3xl font-bold text-yellow-500" data-testid="stat-discovered-count">
                  {stats.importanceBreakdown['blockchain-discovered']}
                </div>
                <p className="text-sm text-muted-foreground">Discovered</p>
              </div>
              <div>
                <div className="text-3xl font-bold text-gray-400" data-testid="stat-pending-count">
                  {stats.importanceBreakdown['pending-review']}
                </div>
                <p className="text-sm text-muted-foreground">Pending Review</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card data-testid="card-data-audit">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" />
              Data Audit
            </CardTitle>
            <CardDescription>
              Read-only breakdown of your database contents to help you understand what the millions
              of rows actually are before taking any action.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-md border p-3 space-y-1">
                <p className="text-sm font-medium">Blockchain-discovered records</p>
                <p className="text-2xl font-bold" data-testid="stat-blockchain-discovered">
                  {((stats.importanceBreakdown['blockchain-discovered'] ?? 0) + (stats.importanceBreakdown['pending-review'] ?? 0)).toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground">
                  Address and transaction records auto-created by sync. These can be reviewed and
                  removed via the Cleanup page.
                </p>
              </div>

              <div className="rounded-md border p-3 space-y-1">
                <p className="text-sm font-medium">Address-less transaction participants</p>
                <p className="text-2xl font-bold" data-testid="stat-addressless-participants">
                  {stats.addresslessParticipants.toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground">
                  Input/output rows without an address (OP_RETURN, coinbase, etc.). These are
                  normal and cannot be linked to any address record.
                </p>
              </div>

              <div className="rounded-md border p-3 space-y-1">
                <p className="text-sm font-medium flex items-center gap-1.5">
                  Unresolved spend inputs
                  {stats.unresolvedPrevoutInputs > 0 && (
                    <AlertTriangle className="h-3.5 w-3.5 text-yellow-600 dark:text-yellow-400" />
                  )}
                </p>
                <p className="text-2xl font-bold" data-testid="stat-unresolved-prevouts">
                  {stats.unresolvedPrevoutInputs.toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground">
                  {stats.unresolvedPrevoutInputs > 0
                    ? 'Input rows whose source address is not yet known. These spends are not subtracted from any wallet balance, causing overstated totals. Use "Resolve & Recompute" in the Balance page to fix.'
                    : 'All spend inputs have a known source address. Balances are complete.'}
                </p>
              </div>

              <div className="rounded-md border p-3 space-y-1">
                <p className="text-sm font-medium">Transaction sync participants</p>
                <p className="text-2xl font-bold" data-testid="stat-total-participants">
                  {stats.transactionParticipants.toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground">
                  Total input + output rows created by blockchain sync. Deep multi-hop syncs grow
                  this count quickly.
                </p>
              </div>

              <div className="rounded-md border p-3 space-y-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <p className="text-sm font-medium flex items-center gap-1.5">
                    Stale cached balances
                    {staleCheckState.status === 'done' && staleCheckState.result.staleCount > 0 && (
                      <AlertTriangle className="h-3.5 w-3.5 text-yellow-600 dark:text-yellow-400" />
                    )}
                    {staleCheckState.status === 'done' && staleCheckState.result.staleCount === 0 && (
                      <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
                    )}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={runStaleCheck}
                    disabled={staleCheckState.status === 'running'}
                    data-testid="button-run-stale-check"
                  >
                    {staleCheckState.status === 'running' ? (
                      <>
                        <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
                        Checking…
                      </>
                    ) : (
                      'Run Check'
                    )}
                  </Button>
                </div>
                {staleCheckState.status === 'idle' && (
                  <p className="text-xs text-muted-foreground">
                    Compares cached address balances against a fresh recompute to detect stale values.
                    Samples up to 2,000 synced addresses. Click "Run Check" to start.
                  </p>
                )}
                {staleCheckState.status === 'running' && (
                  <p className="text-xs text-muted-foreground" data-testid="text-stale-check-progress">
                    Checking… {staleCheckState.sampled.toLocaleString()} addresses sampled so far.
                  </p>
                )}
                {staleCheckState.status === 'done' && (
                  <>
                    <p className="text-2xl font-bold" data-testid="stat-stale-balances">
                      {staleCheckState.result.staleCount.toLocaleString()}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {staleCheckState.result.staleCount > 0
                        ? `${staleCheckState.result.staleCount} of ${staleCheckState.result.sampled.toLocaleString()} sampled addresses have a cached balance that differs from a fresh recompute. Use "Resolve & Recompute" in the Balance page, or run "Recompute Stats" from Settings.`
                        : `All ${staleCheckState.result.sampled.toLocaleString()} sampled addresses have up-to-date cached balances.`}
                    </p>
                  </>
                )}
              </div>

              <div className="rounded-md border p-3 space-y-1">
                <p className="text-sm font-medium">Legacy encrypted data</p>
                <div className="flex items-center gap-2 mt-1" data-testid="stat-legacy-encrypted">
                  {stats.hasLegacyEncryptedData ? (
                    <>
                      <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400 shrink-0" />
                      <span className="text-sm font-semibold text-yellow-700 dark:text-yellow-300">
                        Encrypted payloads present
                      </span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400 shrink-0" />
                      <span className="text-sm font-semibold text-green-700 dark:text-green-300">
                        Vault fully unlocked
                      </span>
                    </>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {stats.hasLegacyEncryptedData
                    ? 'Some records still hold encrypted payloads. Use "Restore Locked Data" in Settings to recover them.'
                    : 'No legacy encrypted payloads found. All records are in plaintext.'}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </ScrollArea>
  );
}

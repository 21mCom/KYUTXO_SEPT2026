import { useMemo, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/database';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { 
  Database, 
  Wallet, 
  FileText, 
  Tag, 
  FolderOpen,
  Paperclip,
  Link2,
  CheckCircle2,
  Clock,
  Key,
  Search,
  Users,
  ArrowRightLeft,
  DollarSign,
  BarChart3
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

export default function DataStats() {
  const records = useLiveQuery(() => db.records.toArray(), []);
  const tags = useLiveQuery(() => db.tags.count(), []);
  const categories = useLiveQuery(() => db.categories.count(), []);
  const attachments = useLiveQuery(() => db.attachments.count(), []);
  const blockchainTransactions = useLiveQuery(() => db.blockchainTransactions.count(), []);
  const transactionParticipants = useLiveQuery(() => db.transactionParticipants.count(), []);
  const addressSyncState = useLiveQuery(() => db.addressSyncState.count(), []);
  const priceData = useLiveQuery(() => db.priceData.count(), []);

  const stats = useMemo(() => {
    if (!records) return null;

    const totalRecords = records.length;
    const addresses = records.filter(r => r.type === 'address');
    const transactions = records.filter(r => r.type === 'transaction');
    const other = records.filter(r => r.type === 'other');

    const importanceBreakdown: { [key: string]: number } = {
      'verified': 0,
      'manual': 0,
      'wallet-import': 0,
      'xpub-derived': 0,
      'blockchain-discovered': 0,
      'pending-review': 0,
    };

    const sourceBreakdown: { [key: string]: number } = {};
    const ownerBreakdown: { [key: string]: number } = {};

    addresses.forEach(record => {
      const importance = record.addressImportance || 'manual';
      importanceBreakdown[importance] = (importanceBreakdown[importance] || 0) + 1;

      const source = record.source || 'manual';
      sourceBreakdown[source] = (sourceBreakdown[source] || 0) + 1;

      const owner = record.owner || 'Unknown';
      ownerBreakdown[owner] = (ownerBreakdown[owner] || 0) + 1;
    });

    const sortedSources = Object.entries(sourceBreakdown)
      .sort((a, b) => b[1] - a[1]);

    const sortedOwners = Object.entries(ownerBreakdown)
      .sort((a, b) => b[1] - a[1]);

    return {
      totalRecords,
      addressCount: addresses.length,
      transactionCount: transactions.length,
      otherCount: other.length,
      importanceBreakdown,
      sourceBreakdown: sortedSources,
      ownerBreakdown: sortedOwners,
    };
  }, [records]);

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

  const importanceLabels: { [key: string]: string } = {
    'verified': 'Verified',
    'manual': 'Manual Entry',
    'wallet-import': 'Wallet Data Sync',
    'xpub-derived': 'xPub Derived',
    'blockchain-discovered': 'Blockchain Discovered',
    'pending-review': 'Pending Review',
  };

  return (
    <ScrollArea className="h-full">
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Data Stats</h1>
          <p className="text-muted-foreground">Database statistics and record breakdowns</p>
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
            value={tags ?? 0}
            description="Custom tags created"
            icon={<Tag className="h-4 w-4" />}
          />
          <StatCard
            title="Categories"
            value={categories ?? 0}
            description="Categories defined"
            icon={<FolderOpen className="h-4 w-4" />}
          />
          <StatCard
            title="Attachments"
            value={attachments ?? 0}
            description="Files attached to records"
            icon={<Paperclip className="h-4 w-4" />}
          />
          <StatCard
            title="Price Data Points"
            value={priceData ?? 0}
            description="Historical price entries"
            icon={<DollarSign className="h-4 w-4" />}
          />
        </div>

        <div className="grid gap-4 grid-cols-2 lg:grid-cols-3">
          <StatCard
            title="Blockchain Transactions"
            value={blockchainTransactions ?? 0}
            description="Synced from blockchain"
            icon={<ArrowRightLeft className="h-4 w-4" />}
          />
          <StatCard
            title="Transaction Participants"
            value={transactionParticipants ?? 0}
            description="Inputs + outputs tracked"
            icon={<Link2 className="h-4 w-4" />}
          />
          <StatCard
            title="Synced Addresses"
            value={addressSyncState ?? 0}
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
      </div>
    </ScrollArea>
  );
}

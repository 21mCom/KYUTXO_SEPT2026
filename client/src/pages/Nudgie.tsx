import { useState, useMemo, useEffect, useRef } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { format } from "date-fns";
import { db, BlockchainTransaction, TransactionParticipant, Record } from "@/lib/database";
import { decryptRecords, updateRecord } from "@/lib/encryptionFacade";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { 
  ArrowDownLeft, 
  ArrowUpRight,
  ArrowLeftRight,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  ExternalLink,
  Clock,
  Filter,
  LayoutGrid,
  Focus,
  CheckCircle2,
  Circle,
  Users,
  HelpCircle,
  Sparkles
} from "lucide-react";

const USER_CURATED_TIERS = ['verified', 'manual', 'wallet-import', 'xpub-derived'];

function satsToBtc(sats: number | undefined): string {
  if (sats === undefined || sats === null) return "0.00000000";
  return (sats / 100_000_000).toFixed(8);
}

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

function truncate(str: string, start = 8, end = 8): string {
  if (str.length <= start + end + 3) return str;
  return `${str.slice(0, start)}...${str.slice(-end)}`;
}

interface TransactionWithContext extends BlockchainTransaction {
  inputs: TransactionParticipant[];
  outputs: TransactionParticipant[];
  totalInputValue: number;
  totalOutputValue: number;
  existingLabel?: string;
  existingRecordId?: number;
  groupType: 'self-transfer' | 'known-counterparty' | 'unknown';
  yourAddresses: Array<{ address: string; record?: Record; role: 'input' | 'output'; amount: number }>;
  counterpartyAddresses: Array<{ address: string; record?: Record; role: 'input' | 'output'; amount: number }>;
  netFlow: number;
}

type SourceFilter = 'all' | 'manual' | 'xpub-import' | 'wallet-import' | 'blockchain-sync';
type ViewMode = 'dashboard' | 'focus';

export default function Nudgie() {
  const [viewMode, setViewMode] = useState<ViewMode>('dashboard');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [focusIndex, setFocusIndex] = useState(0);
  const [expandedTxs, setExpandedTxs] = useState<Set<string>>(new Set());
  const [labelInputs, setLabelInputs] = useState<Map<string, string>>(new Map());
  const [savingTxids, setSavingTxids] = useState<Set<string>>(new Set());
  const { toast } = useToast();

  const transactions = useLiveQuery(
    () => db.blockchainTransactions.orderBy('blockTime').reverse().toArray(),
    []
  );

  const participants = useLiveQuery(
    () => db.transactionParticipants.toArray(),
    []
  );

  const rawAddressRecords = useLiveQuery(
    async () => {
      const [curatedRecords, blockchainRecords] = await Promise.all([
        db.records
          .where('[type+addressImportance]')
          .anyOf(USER_CURATED_TIERS.map(tier => ['address', tier]))
          .toArray(),
        db.records
          .where('[type+addressImportance]')
          .anyOf([['address', 'blockchain-discovered'], ['address', 'pending-review']])
          .filter(r => r.syncDepth === 0 || r.syncDepth === undefined)
          .toArray()
      ]);
      return [...curatedRecords, ...blockchainRecords];
    },
    []
  );

  const rawTransactionRecords = useLiveQuery(
    async () => {
      return db.records.where('type').equals('transaction').toArray();
    },
    []
  );

  const [decryptedAddressRecords, setDecryptedAddressRecords] = useState<Record[]>([]);
  const [decryptedTransactionRecords, setDecryptedTransactionRecords] = useState<Record[]>([]);
  const decryptRequestId = useRef(0);

  useEffect(() => {
    if (!rawAddressRecords || !rawTransactionRecords) return;
    
    decryptRequestId.current += 1;
    const thisRequestId = decryptRequestId.current;
    
    const decrypt = async () => {
      try {
        const [addresses, txRecords] = await Promise.all([
          decryptRecords(rawAddressRecords),
          decryptRecords(rawTransactionRecords)
        ]);
        if (thisRequestId === decryptRequestId.current) {
          setDecryptedAddressRecords(addresses);
          setDecryptedTransactionRecords(txRecords);
        }
      } catch {
        if (thisRequestId === decryptRequestId.current) {
          setDecryptedAddressRecords(rawAddressRecords);
          setDecryptedTransactionRecords(rawTransactionRecords);
        }
      }
    };
    
    decrypt();
  }, [rawAddressRecords, rawTransactionRecords]);

  const addressToRecord = useMemo(() => {
    const map = new Map<string, Record>();
    decryptedAddressRecords.forEach(record => {
      if (record.type === 'address' && record.inputString) {
        map.set(record.inputString, record);
      }
    });
    return map;
  }, [decryptedAddressRecords]);

  const txidToRecord = useMemo(() => {
    const map = new Map<string, Record>();
    decryptedTransactionRecords.forEach(record => {
      if (record.type === 'transaction' && record.inputString) {
        map.set(record.inputString, record);
      }
    });
    return map;
  }, [decryptedTransactionRecords]);

  const transactionsWithContext = useMemo(() => {
    if (!transactions || !participants) return [];
    
    const participantsByTxid = new Map<string, TransactionParticipant[]>();
    participants.forEach(p => {
      const existing = participantsByTxid.get(p.txid) || [];
      existing.push(p);
      participantsByTxid.set(p.txid, existing);
    });

    const results: TransactionWithContext[] = [];

    for (const tx of transactions) {
      const txParticipants = participantsByTxid.get(tx.txid) || [];
      const inputs = txParticipants.filter(p => p.role === 'input');
      const outputs = txParticipants.filter(p => p.role === 'output');
      
      const existingRecord = txidToRecord.get(tx.txid);
      
      if (existingRecord && existingRecord.label && existingRecord.label.trim() !== '') {
        continue;
      }

      const yourAddresses: TransactionWithContext['yourAddresses'] = [];
      const counterpartyAddresses: TransactionWithContext['counterpartyAddresses'] = [];

      let hasUserAddress = false;

      for (const input of inputs) {
        const record = addressToRecord.get(input.address);
        if (record) {
          hasUserAddress = true;
          yourAddresses.push({ address: input.address, record, role: 'input', amount: input.amount });
        } else {
          counterpartyAddresses.push({ address: input.address, record: undefined, role: 'input', amount: input.amount });
        }
      }

      for (const output of outputs) {
        const record = addressToRecord.get(output.address);
        if (record) {
          hasUserAddress = true;
          yourAddresses.push({ address: output.address, record, role: 'output', amount: output.amount });
        } else {
          counterpartyAddresses.push({ address: output.address, record: undefined, role: 'output', amount: output.amount });
        }
      }

      if (!hasUserAddress) continue;

      if (sourceFilter !== 'all') {
        const hasMatchingSource = yourAddresses.some(a => {
          if (!a.record) return false;
          const source = a.record.source || '';
          switch (sourceFilter) {
            case 'manual': return source === 'manual' || source === '';
            case 'xpub-import': return source === 'xpub-import';
            case 'wallet-import': return source.startsWith('walletImport-');
            case 'blockchain-sync': return source === 'blockchain-sync' && (a.record.syncDepth === 0 || a.record.syncDepth === undefined);
            default: return true;
          }
        });
        if (!hasMatchingSource) continue;
      }

      const yourInputs = yourAddresses.filter(a => a.role === 'input');
      const yourOutputs = yourAddresses.filter(a => a.role === 'output');
      const yourInputValue = yourInputs.reduce((sum, a) => sum + a.amount, 0);
      const yourOutputValue = yourOutputs.reduce((sum, a) => sum + a.amount, 0);
      const netFlow = yourOutputValue - yourInputValue;

      let groupType: TransactionWithContext['groupType'] = 'unknown';
      
      const yourOwners = new Set(yourAddresses.map(a => a.record?.owner).filter(Boolean));
      const counterpartyHasKnown = counterpartyAddresses.some(a => {
        const record = addressToRecord.get(a.address);
        return record && record.owner;
      });

      if (yourOwners.size === 1 && counterpartyAddresses.length === 0) {
        groupType = 'self-transfer';
      } else if (counterpartyHasKnown) {
        groupType = 'known-counterparty';
      } else {
        groupType = 'unknown';
      }

      results.push({
        ...tx,
        inputs,
        outputs,
        totalInputValue: inputs.reduce((sum, p) => sum + p.amount, 0),
        totalOutputValue: outputs.reduce((sum, p) => sum + p.amount, 0),
        existingLabel: existingRecord?.label,
        existingRecordId: existingRecord?.id,
        groupType,
        yourAddresses,
        counterpartyAddresses,
        netFlow
      });
    }

    return results;
  }, [transactions, participants, addressToRecord, txidToRecord, sourceFilter]);

  const groupedTransactions = useMemo(() => {
    const selfTransfers = transactionsWithContext.filter(tx => tx.groupType === 'self-transfer');
    const knownCounterparties = transactionsWithContext.filter(tx => tx.groupType === 'known-counterparty');
    const unknowns = transactionsWithContext.filter(tx => tx.groupType === 'unknown');
    
    return { selfTransfers, knownCounterparties, unknowns };
  }, [transactionsWithContext]);

  const totalUnlabeled = transactionsWithContext.length;
  const allTransactionsCount = transactions?.length || 0;
  const labeledCount = allTransactionsCount - totalUnlabeled;
  const progressPercent = allTransactionsCount > 0 ? (labeledCount / allTransactionsCount) * 100 : 100;

  const handleLabelChange = (txid: string, value: string) => {
    setLabelInputs(prev => new Map(prev).set(txid, value));
  };

  const handleSaveLabel = async (tx: TransactionWithContext) => {
    const label = labelInputs.get(tx.txid) || '';
    if (!label.trim()) {
      toast({ title: "Label required", description: "Please enter a label for this transaction", variant: "destructive" });
      return;
    }

    setSavingTxids(prev => new Set(prev).add(tx.txid));

    try {
      if (tx.existingRecordId) {
        await updateRecord(tx.existingRecordId, { label: label.trim() });
      } else {
        const { createRecord } = await import('@/lib/encryptionFacade');
        await createRecord({
          type: 'transaction',
          inputString: tx.txid,
          label: label.trim(),
          tags: [],
          categories: []
        });
      }

      toast({ title: "Saved", description: "Transaction labeled successfully" });
      setLabelInputs(prev => {
        const next = new Map(prev);
        next.delete(tx.txid);
        return next;
      });

      if (viewMode === 'focus') {
        setFocusIndex(prev => Math.max(0, Math.min(prev, transactionsWithContext.length - 2)));
      }
    } catch (error) {
      console.error('Failed to save label:', error);
      toast({ title: "Error", description: "Failed to save label", variant: "destructive" });
    } finally {
      setSavingTxids(prev => {
        const next = new Set(prev);
        next.delete(tx.txid);
        return next;
      });
    }
  };

  const handleQuickLabel = async (tx: TransactionWithContext, quickLabel: string) => {
    setLabelInputs(prev => new Map(prev).set(tx.txid, quickLabel));
    
    setSavingTxids(prev => new Set(prev).add(tx.txid));

    try {
      if (tx.existingRecordId) {
        await updateRecord(tx.existingRecordId, { label: quickLabel });
      } else {
        const { createRecord } = await import('@/lib/encryptionFacade');
        await createRecord({
          type: 'transaction',
          inputString: tx.txid,
          label: quickLabel,
          tags: [],
          categories: []
        });
      }

      toast({ title: "Saved", description: `Labeled as "${quickLabel}"` });
      setLabelInputs(prev => {
        const next = new Map(prev);
        next.delete(tx.txid);
        return next;
      });

      if (viewMode === 'focus') {
        setFocusIndex(prev => Math.max(0, Math.min(prev, transactionsWithContext.length - 2)));
      }
    } catch (error) {
      console.error('Failed to save label:', error);
      toast({ title: "Error", description: "Failed to save label", variant: "destructive" });
    } finally {
      setSavingTxids(prev => {
        const next = new Set(prev);
        next.delete(tx.txid);
        return next;
      });
    }
  };

  const toggleExpand = (txid: string) => {
    setExpandedTxs(prev => {
      const next = new Set(prev);
      if (next.has(txid)) {
        next.delete(txid);
      } else {
        next.add(txid);
      }
      return next;
    });
  };

  const focusTransaction = transactionsWithContext[focusIndex];

  const renderAddressCard = (addr: TransactionWithContext['yourAddresses'][0], isYours: boolean) => (
    <div 
      key={`${addr.address}-${addr.role}`}
      className={`p-3 rounded-md border ${isYours ? 'bg-primary/5 border-primary/20' : 'bg-muted/50 border-muted'}`}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-2">
          {addr.role === 'input' ? (
            <ArrowUpRight className="h-3 w-3 text-destructive" />
          ) : (
            <ArrowDownLeft className="h-3 w-3 text-green-600" />
          )}
          <span className="font-mono text-xs">{truncate(addr.address)}</span>
        </div>
        <span className="text-xs font-medium">{formatSats(addr.amount)}</span>
      </div>
      {addr.record ? (
        <div className="text-xs text-muted-foreground space-y-0.5">
          {addr.record.label && <div className="font-medium text-foreground">{addr.record.label}</div>}
          {addr.record.owner && <div>Owner: {addr.record.owner}</div>}
          {addr.record.walletName && <div>Wallet: {addr.record.walletName}</div>}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground italic">Unknown address</div>
      )}
    </div>
  );

  const renderTransactionCard = (tx: TransactionWithContext, compact = false) => {
    const isExpanded = expandedTxs.has(tx.txid);
    const isSaving = savingTxids.has(tx.txid);
    const currentLabel = labelInputs.get(tx.txid) || '';

    return (
      <Card key={tx.txid} className="mb-3" data-testid={`card-transaction-${tx.txid}`}>
        <Collapsible open={isExpanded} onOpenChange={() => toggleExpand(tx.txid)}>
          <CardHeader className="p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  {tx.netFlow >= 0 ? (
                    <Badge variant="outline" className="text-green-600 border-green-600/30 bg-green-600/5">
                      <ArrowDownLeft className="h-3 w-3 mr-1" />
                      Received
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-destructive border-destructive/30 bg-destructive/5">
                      <ArrowUpRight className="h-3 w-3 mr-1" />
                      Sent
                    </Badge>
                  )}
                  {tx.groupType === 'self-transfer' && (
                    <Badge variant="secondary" className="text-xs">
                      <ArrowLeftRight className="h-3 w-3 mr-1" />
                      Self-transfer
                    </Badge>
                  )}
                  {tx.groupType === 'known-counterparty' && (
                    <Badge variant="secondary" className="text-xs">
                      <Users className="h-3 w-3 mr-1" />
                      Known
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Clock className="h-3 w-3" />
                  <span>{format(new Date(tx.blockTime * 1000), 'MMM d, yyyy HH:mm')}</span>
                  <span className="font-mono">{truncate(tx.txid, 6, 6)}</span>
                  <a
                    href={`https://mempool.space/tx/${tx.txid}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover-elevate p-1 rounded"
                    data-testid={`link-tx-explorer-${tx.txid}`}
                  >
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </div>
              <div className="text-right">
                <div className={`font-bold ${tx.netFlow >= 0 ? 'text-green-600' : 'text-destructive'}`}>
                  {tx.netFlow >= 0 ? '+' : ''}{formatSats(Math.abs(tx.netFlow))}
                </div>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-6 px-2 mt-1" data-testid={`button-expand-${tx.txid}`}>
                    {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                    <span className="ml-1 text-xs">{isExpanded ? 'Less' : 'More'}</span>
                  </Button>
                </CollapsibleTrigger>
              </div>
            </div>

            {!compact && (
              <div className="mt-3 space-y-2">
                <div className="flex gap-2">
                  <Input
                    placeholder="Enter a label for this transaction..."
                    value={currentLabel}
                    onChange={(e) => handleLabelChange(tx.txid, e.target.value)}
                    className="flex-1"
                    disabled={isSaving}
                    data-testid={`input-label-${tx.txid}`}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && currentLabel.trim()) {
                        handleSaveLabel(tx);
                      }
                    }}
                  />
                  <Button 
                    onClick={() => handleSaveLabel(tx)} 
                    disabled={isSaving || !currentLabel.trim()}
                    data-testid={`button-save-${tx.txid}`}
                  >
                    {isSaving ? 'Saving...' : 'Save'}
                  </Button>
                </div>
                {tx.groupType === 'self-transfer' && (
                  <div className="flex gap-2">
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={() => handleQuickLabel(tx, 'Self-transfer')}
                      disabled={isSaving}
                      data-testid={`button-quick-self-${tx.txid}`}
                    >
                      <ArrowLeftRight className="h-3 w-3 mr-1" />
                      Self-transfer
                    </Button>
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={() => handleQuickLabel(tx, 'Consolidation')}
                      disabled={isSaving}
                      data-testid={`button-quick-consolidation-${tx.txid}`}
                    >
                      Consolidation
                    </Button>
                  </div>
                )}
              </div>
            )}
          </CardHeader>

          <CollapsibleContent>
            <CardContent className="pt-0 px-4 pb-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <h4 className="text-xs font-medium text-muted-foreground mb-2">Your Addresses</h4>
                  <div className="space-y-2">
                    {tx.yourAddresses.map(addr => renderAddressCard(addr, true))}
                  </div>
                </div>
                <div>
                  <h4 className="text-xs font-medium text-muted-foreground mb-2">Counterparty Addresses</h4>
                  <div className="space-y-2">
                    {tx.counterpartyAddresses.length > 0 ? (
                      tx.counterpartyAddresses.map(addr => renderAddressCard(addr, false))
                    ) : (
                      <div className="text-xs text-muted-foreground italic p-3 bg-muted/30 rounded-md">
                        No external addresses (internal transfer)
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </Card>
    );
  };

  const renderDashboardView = () => (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="text-lg">Progress</CardTitle>
              <CardDescription>
                {labeledCount} of {allTransactionsCount} transactions labeled
              </CardDescription>
            </div>
            <div className="text-2xl font-bold text-primary">
              {Math.round(progressPercent)}%
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Progress value={progressPercent} className="h-2" />
        </CardContent>
      </Card>

      <div className="grid grid-cols-3 gap-4">
        <Card className={groupedTransactions.selfTransfers.length > 0 ? 'border-primary/30' : ''}>
          <CardHeader className="p-4">
            <div className="flex items-center gap-2">
              <ArrowLeftRight className="h-4 w-4 text-primary" />
              <CardTitle className="text-sm">Likely Self-Transfers</CardTitle>
            </div>
            <CardDescription className="text-2xl font-bold">
              {groupedTransactions.selfTransfers.length}
            </CardDescription>
          </CardHeader>
        </Card>
        <Card className={groupedTransactions.knownCounterparties.length > 0 ? 'border-blue-500/30' : ''}>
          <CardHeader className="p-4">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-blue-500" />
              <CardTitle className="text-sm">Known Counterparties</CardTitle>
            </div>
            <CardDescription className="text-2xl font-bold">
              {groupedTransactions.knownCounterparties.length}
            </CardDescription>
          </CardHeader>
        </Card>
        <Card className={groupedTransactions.unknowns.length > 0 ? 'border-orange-500/30' : ''}>
          <CardHeader className="p-4">
            <div className="flex items-center gap-2">
              <HelpCircle className="h-4 w-4 text-orange-500" />
              <CardTitle className="text-sm">Needs Investigation</CardTitle>
            </div>
            <CardDescription className="text-2xl font-bold">
              {groupedTransactions.unknowns.length}
            </CardDescription>
          </CardHeader>
        </Card>
      </div>

      <ScrollArea className="h-[calc(100vh-420px)]">
        {groupedTransactions.selfTransfers.length > 0 && (
          <div className="mb-6">
            <h3 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
              <ArrowLeftRight className="h-4 w-4" />
              Likely Self-Transfers ({groupedTransactions.selfTransfers.length})
            </h3>
            {groupedTransactions.selfTransfers.map(tx => renderTransactionCard(tx))}
          </div>
        )}

        {groupedTransactions.knownCounterparties.length > 0 && (
          <div className="mb-6">
            <h3 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
              <Users className="h-4 w-4" />
              Known Counterparties ({groupedTransactions.knownCounterparties.length})
            </h3>
            {groupedTransactions.knownCounterparties.map(tx => renderTransactionCard(tx))}
          </div>
        )}

        {groupedTransactions.unknowns.length > 0 && (
          <div className="mb-6">
            <h3 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
              <HelpCircle className="h-4 w-4" />
              Needs Investigation ({groupedTransactions.unknowns.length})
            </h3>
            {groupedTransactions.unknowns.map(tx => renderTransactionCard(tx))}
          </div>
        )}

        {totalUnlabeled === 0 && (
          <div className="text-center py-12">
            <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto mb-4" />
            <h3 className="text-lg font-medium">All caught up!</h3>
            <p className="text-muted-foreground">Every transaction has been labeled.</p>
          </div>
        )}
      </ScrollArea>
    </div>
  );

  const renderFocusView = () => {
    if (!focusTransaction) {
      return (
        <div className="flex flex-col items-center justify-center h-[calc(100vh-200px)]">
          <CheckCircle2 className="h-16 w-16 text-green-500 mb-4" />
          <h2 className="text-xl font-medium mb-2">All caught up!</h2>
          <p className="text-muted-foreground">Every transaction has been labeled.</p>
        </div>
      );
    }

    const tx = focusTransaction;
    const isSaving = savingTxids.has(tx.txid);
    const currentLabel = labelInputs.get(tx.txid) || '';

    return (
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div className="text-sm text-muted-foreground">
            Transaction {focusIndex + 1} of {transactionsWithContext.length}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFocusIndex(prev => Math.max(0, prev - 1))}
              disabled={focusIndex === 0}
              data-testid="button-focus-prev"
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFocusIndex(prev => Math.min(transactionsWithContext.length - 1, prev + 1))}
              disabled={focusIndex >= transactionsWithContext.length - 1}
              data-testid="button-focus-next"
            >
              Next
            </Button>
          </div>
        </div>

        <Card className="border-2">
          <CardHeader>
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 mb-2">
                  {tx.netFlow >= 0 ? (
                    <Badge className="bg-green-600">
                      <ArrowDownLeft className="h-3 w-3 mr-1" />
                      Received {formatSats(Math.abs(tx.netFlow))}
                    </Badge>
                  ) : (
                    <Badge variant="destructive">
                      <ArrowUpRight className="h-3 w-3 mr-1" />
                      Sent {formatSats(Math.abs(tx.netFlow))}
                    </Badge>
                  )}
                  {tx.groupType === 'self-transfer' && (
                    <Badge variant="secondary">
                      <ArrowLeftRight className="h-3 w-3 mr-1" />
                      Likely Self-transfer
                    </Badge>
                  )}
                  {tx.groupType === 'known-counterparty' && (
                    <Badge variant="secondary">
                      <Users className="h-3 w-3 mr-1" />
                      Known Counterparty
                    </Badge>
                  )}
                </div>
                <CardTitle className="font-mono text-sm">{tx.txid}</CardTitle>
                <CardDescription className="flex items-center gap-2 mt-1">
                  <Clock className="h-3 w-3" />
                  {format(new Date(tx.blockTime * 1000), 'MMMM d, yyyy \'at\' HH:mm')}
                  <a
                    href={`https://mempool.space/tx/${tx.txid}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover-elevate p-1 rounded inline-flex items-center gap-1"
                  >
                    <ExternalLink className="h-3 w-3" />
                    View on mempool.space
                  </a>
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-2 gap-6">
              <div>
                <h4 className="font-medium mb-3 flex items-center gap-2">
                  <ArrowUpRight className="h-4 w-4 text-destructive" />
                  Your Addresses ({tx.yourAddresses.filter(a => a.role === 'input').length} inputs)
                </h4>
                <div className="space-y-2">
                  {tx.yourAddresses.filter(a => a.role === 'input').map(addr => renderAddressCard(addr, true))}
                  {tx.yourAddresses.filter(a => a.role === 'input').length === 0 && (
                    <div className="text-sm text-muted-foreground italic">No inputs from your addresses</div>
                  )}
                </div>
                <h4 className="font-medium mb-3 mt-4 flex items-center gap-2">
                  <ArrowDownLeft className="h-4 w-4 text-green-600" />
                  Your Addresses ({tx.yourAddresses.filter(a => a.role === 'output').length} outputs)
                </h4>
                <div className="space-y-2">
                  {tx.yourAddresses.filter(a => a.role === 'output').map(addr => renderAddressCard(addr, true))}
                  {tx.yourAddresses.filter(a => a.role === 'output').length === 0 && (
                    <div className="text-sm text-muted-foreground italic">No outputs to your addresses</div>
                  )}
                </div>
              </div>
              <div>
                <h4 className="font-medium mb-3 flex items-center gap-2">
                  <Users className="h-4 w-4" />
                  Counterparty Addresses ({tx.counterpartyAddresses.length})
                </h4>
                <div className="space-y-2">
                  {tx.counterpartyAddresses.length > 0 ? (
                    tx.counterpartyAddresses.map(addr => renderAddressCard(addr, false))
                  ) : (
                    <div className="text-sm text-muted-foreground italic p-3 bg-muted/30 rounded-md">
                      No external addresses - this appears to be an internal transfer
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="border-t pt-4">
              <h4 className="font-medium mb-3">Label this transaction</h4>
              <div className="space-y-3">
                <Input
                  placeholder="Enter a descriptive label..."
                  value={currentLabel}
                  onChange={(e) => handleLabelChange(tx.txid, e.target.value)}
                  disabled={isSaving}
                  className="text-lg"
                  data-testid="input-focus-label"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && currentLabel.trim()) {
                      handleSaveLabel(tx);
                    }
                  }}
                />
                
                {tx.groupType === 'self-transfer' && (
                  <div className="flex gap-2 flex-wrap">
                    <span className="text-sm text-muted-foreground">Quick labels:</span>
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={() => handleQuickLabel(tx, 'Self-transfer')}
                      disabled={isSaving}
                    >
                      Self-transfer
                    </Button>
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={() => handleQuickLabel(tx, 'Consolidation')}
                      disabled={isSaving}
                    >
                      Consolidation
                    </Button>
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={() => handleQuickLabel(tx, 'Move to cold storage')}
                      disabled={isSaving}
                    >
                      Move to cold storage
                    </Button>
                  </div>
                )}

                <Button 
                  onClick={() => handleSaveLabel(tx)} 
                  disabled={isSaving || !currentLabel.trim()}
                  className="w-full"
                  data-testid="button-focus-save"
                >
                  {isSaving ? 'Saving...' : 'Save Label & Continue'}
                  <ChevronRight className="h-4 w-4 ml-2" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  };

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-6 gap-4">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Sparkles className="h-6 w-6 text-primary" />
              Nudgie
            </h1>
            <p className="text-muted-foreground">
              Helping you towards clean, organized records.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Select value={sourceFilter} onValueChange={(v) => setSourceFilter(v as SourceFilter)}>
              <SelectTrigger className="w-[180px]" data-testid="select-source-filter">
                <Filter className="h-4 w-4 mr-2" />
                <SelectValue placeholder="Filter by source" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Sources</SelectItem>
                <SelectItem value="manual">Manual</SelectItem>
                <SelectItem value="xpub-import">XPUB Import</SelectItem>
                <SelectItem value="wallet-import">Wallet Import</SelectItem>
                <SelectItem value="blockchain-sync">Blockchain Sync (0-hop)</SelectItem>
              </SelectContent>
            </Select>

            <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as ViewMode)}>
              <TabsList>
                <TabsTrigger value="dashboard" data-testid="tab-dashboard">
                  <LayoutGrid className="h-4 w-4 mr-2" />
                  Dashboard
                </TabsTrigger>
                <TabsTrigger value="focus" data-testid="tab-focus">
                  <Focus className="h-4 w-4 mr-2" />
                  Focus
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </div>

        {viewMode === 'dashboard' ? renderDashboardView() : renderFocusView()}
      </div>
    </div>
  );
}

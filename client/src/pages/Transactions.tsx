import { useState, useMemo, useEffect, useRef } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { format } from "date-fns";
import { db, BlockchainTransaction, TransactionParticipant, Record } from "@/lib/database";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
  Link as LinkIcon
} from "lucide-react";
import { decryptRecords } from "@/lib/encryptionFacade";

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

// Truncate txid/address for display
function truncate(str: string, start = 8, end = 8): string {
  if (str.length <= start + end + 3) return str;
  return `${str.slice(0, start)}...${str.slice(-end)}`;
}

interface TransactionWithParticipants extends BlockchainTransaction {
  inputs: TransactionParticipant[];
  outputs: TransactionParticipant[];
  totalInputValue: number;
  totalOutputValue: number;
}

export default function Transactions() {
  const [search, setSearch] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [expandedTxs, setExpandedTxs] = useState<Set<string>>(new Set());

  // Fetch all transactions
  const transactions = useLiveQuery(
    () => db.blockchainTransactions.orderBy('blockTime').reverse().toArray(),
    []
  );

  // Fetch all participants
  const participants = useLiveQuery(
    () => db.transactionParticipants.toArray(),
    []
  );

  // Fetch all records for linking
  const rawRecords = useLiveQuery(
    () => db.records.toArray(),
    []
  );

  // Decrypt records to get addresses
  const [decryptedRecords, setDecryptedRecords] = useState<Record[]>([]);
  // Use a ref to track the latest request ID and prevent stale async updates
  const decryptRequestId = useRef(0);
  
  useEffect(() => {
    if (!rawRecords) return;
    
    // Increment request ID for this call - use ref to ensure we can check latest value
    decryptRequestId.current += 1;
    const thisRequestId = decryptRequestId.current;
    
    const decrypt = async () => {
      try {
        const decrypted = await decryptRecords(rawRecords);
        // Only update if this is still the latest request
        if (thisRequestId === decryptRequestId.current) {
          setDecryptedRecords(decrypted);
        }
      } catch {
        // On failure, use raw records as fallback only if this is latest request
        if (thisRequestId === decryptRequestId.current) {
          setDecryptedRecords(prev => prev.length === 0 ? rawRecords : prev);
        }
      }
    };
    
    decrypt();
  }, [rawRecords]);

  // Build address -> record lookup
  const addressToRecord = useMemo(() => {
    const map = new Map<string, Record>();
    decryptedRecords.forEach(record => {
      if (record.type === 'address' && record.inputString) {
        map.set(record.inputString, record);
      }
    });
    return map;
  }, [decryptedRecords]);

  // Combine transactions with their participants
  const transactionsWithParticipants = useMemo(() => {
    if (!transactions || !participants) return [];
    
    const participantsByTxid = new Map<string, TransactionParticipant[]>();
    participants.forEach(p => {
      const existing = participantsByTxid.get(p.txid) || [];
      existing.push(p);
      participantsByTxid.set(p.txid, existing);
    });

    return transactions.map(tx => {
      const txParticipants = participantsByTxid.get(tx.txid) || [];
      const inputs = txParticipants.filter(p => p.role === 'input');
      const outputs = txParticipants.filter(p => p.role === 'output');
      
      return {
        ...tx,
        inputs,
        outputs,
        totalInputValue: inputs.reduce((sum, p) => sum + p.amount, 0),
        totalOutputValue: outputs.reduce((sum, p) => sum + p.amount, 0),
      } as TransactionWithParticipants;
    });
  }, [transactions, participants]);

  // Filter by search
  const filteredTransactions = useMemo(() => {
    if (!search.trim()) return transactionsWithParticipants;
    
    const searchLower = search.toLowerCase();
    return transactionsWithParticipants.filter(tx => {
      // Search in txid
      if (tx.txid.toLowerCase().includes(searchLower)) return true;
      // Search in participant addresses
      const allAddresses = [...tx.inputs, ...tx.outputs].map(p => p.address);
      if (allAddresses.some(addr => addr.toLowerCase().includes(searchLower))) return true;
      // Search in linked record labels
      const linkedRecords = [...tx.inputs, ...tx.outputs]
        .map(p => addressToRecord.get(p.address))
        .filter(Boolean);
      if (linkedRecords.some(r => r?.label?.toLowerCase().includes(searchLower))) return true;
      return false;
    });
  }, [transactionsWithParticipants, search, addressToRecord]);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filteredTransactions.length / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);
  const startIndex = (safePage - 1) * ITEMS_PER_PAGE;
  const paginatedTransactions = filteredTransactions.slice(startIndex, startIndex + ITEMS_PER_PAGE);

  // Toggle transaction expansion
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

  // Stats
  const totalTxCount = transactions?.length ?? 0;
  const totalVolume = transactionsWithParticipants.reduce((sum, tx) => sum + tx.totalOutputValue, 0);
  const totalFees = transactionsWithParticipants.reduce((sum, tx) => sum + tx.fee, 0);

  // Get linked address count
  const linkedAddressCount = useMemo(() => {
    const linkedAddresses = new Set<string>();
    transactionsWithParticipants.forEach(tx => {
      [...tx.inputs, ...tx.outputs].forEach(p => {
        if (addressToRecord.has(p.address)) {
          linkedAddresses.add(p.address);
        }
      });
    });
    return linkedAddresses.size;
  }, [transactionsWithParticipants, addressToRecord]);

  const isLoading = !transactions || !participants;

  return (
    <div className="flex flex-col h-full overflow-hidden p-4 gap-4">
      <div className="flex-none">
        <h1 className="text-2xl font-bold" data-testid="text-page-title">Blockchain Transactions</h1>
        <p className="text-muted-foreground mt-1">
          View synced transaction data with amounts, fees, and linked addresses
        </p>
      </div>

      {/* Stats Overview */}
      <div className="grid gap-4 sm:grid-cols-4 flex-none">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Transactions</CardDescription>
            <CardTitle className="text-2xl" data-testid="text-total-transactions">
              {totalTxCount}
            </CardTitle>
          </CardHeader>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Volume</CardDescription>
            <CardTitle className="text-2xl" data-testid="text-total-volume">
              {satsToBtc(totalVolume)} BTC
            </CardTitle>
          </CardHeader>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Fees Paid</CardDescription>
            <CardTitle className="text-2xl" data-testid="text-total-fees">
              {formatSats(totalFees)}
            </CardTitle>
          </CardHeader>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Linked Addresses</CardDescription>
            <CardTitle className="text-2xl" data-testid="text-linked-addresses">
              {linkedAddressCount}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Search */}
      <div className="flex-none relative">
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
                            <code className="text-sm font-mono truncate" data-testid={`text-txid-${tx.txid.slice(0, 8)}`}>
                              {truncate(tx.txid, 12, 12)}
                            </code>
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
                                    <code className="font-mono text-xs truncate flex-1">
                                      {truncate(input.address)}
                                    </code>
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
                                    <code className="font-mono text-xs truncate flex-1">
                                      {truncate(output.address)}
                                    </code>
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

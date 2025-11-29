import { useState, useMemo, useEffect, useRef } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { format } from "date-fns";
import { db, BlockchainTransaction, TransactionParticipant, Record } from "@/lib/database";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { 
  ChevronDown, 
  ChevronUp,
  Search,
  ArrowDownLeft,
  ArrowUpRight,
  Repeat2,
  ExternalLink,
  Copy,
  Check,
  AlertTriangle
} from "lucide-react";
import { decryptRecords } from "@/lib/encryptionFacade";
import { useToast } from "@/hooks/use-toast";

function truncate(str: string, start = 8, end = 8): string {
  if (str.length <= start + end + 3) return str;
  return `${str.slice(0, start)}...${str.slice(-end)}`;
}

interface AddressReuseInfo {
  address: string;
  totalCount: number;
  inputCount: number;
  outputCount: number;
  transactions: {
    txid: string;
    blockTime: number;
    role: 'input' | 'output';
  }[];
  record?: Record;
}

export default function AddressReuse() {
  const [search, setSearch] = useState("");
  const [expandedAddresses, setExpandedAddresses] = useState<Set<string>>(new Set());
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const { toast } = useToast();

  const transactions = useLiveQuery(
    () => db.blockchainTransactions.toArray(),
    []
  );

  const participants = useLiveQuery(
    () => db.transactionParticipants.toArray(),
    []
  );

  const rawRecords = useLiveQuery(
    () => db.records.where('type').equals('address').toArray(),
    []
  );

  const [decryptedRecords, setDecryptedRecords] = useState<Record[]>([]);
  const decryptRequestId = useRef(0);
  
  useEffect(() => {
    if (!rawRecords) return;
    
    decryptRequestId.current += 1;
    const thisRequestId = decryptRequestId.current;
    
    const decrypt = async () => {
      try {
        const decrypted = await decryptRecords(rawRecords);
        if (thisRequestId === decryptRequestId.current) {
          setDecryptedRecords(decrypted);
        }
      } catch {
        if (thisRequestId === decryptRequestId.current) {
          setDecryptedRecords(prev => prev.length === 0 ? rawRecords : prev);
        }
      }
    };
    
    decrypt();
  }, [rawRecords]);

  const addressToRecord = useMemo(() => {
    const map = new Map<string, Record>();
    decryptedRecords.forEach(record => {
      if (record.inputString) {
        map.set(record.inputString, record);
      }
    });
    return map;
  }, [decryptedRecords]);

  const txidToBlockTime = useMemo(() => {
    const map = new Map<string, number>();
    transactions?.forEach(tx => {
      map.set(tx.txid, tx.blockTime);
    });
    return map;
  }, [transactions]);

  const reusedAddresses = useMemo(() => {
    if (!participants) return [];

    const addressMap = new Map<string, {
      inputTxids: Set<string>;
      outputTxids: Set<string>;
    }>();

    participants.forEach(p => {
      if (!addressMap.has(p.address)) {
        addressMap.set(p.address, { inputTxids: new Set(), outputTxids: new Set() });
      }
      const entry = addressMap.get(p.address)!;
      if (p.role === 'input') {
        entry.inputTxids.add(p.txid);
      } else {
        entry.outputTxids.add(p.txid);
      }
    });

    const result: AddressReuseInfo[] = [];

    addressMap.forEach((data, address) => {
      const allTxids = new Set([...Array.from(data.inputTxids), ...Array.from(data.outputTxids)]);
      const totalCount = allTxids.size;
      
      if (totalCount > 1) {
        const transactions: AddressReuseInfo['transactions'] = [];
        
        allTxids.forEach(txid => {
          const blockTime = txidToBlockTime.get(txid) || 0;
          const isInput = data.inputTxids.has(txid);
          const isOutput = data.outputTxids.has(txid);
          
          if (isOutput) {
            transactions.push({ txid, blockTime, role: 'output' });
          }
          if (isInput) {
            transactions.push({ txid, blockTime, role: 'input' });
          }
        });

        transactions.sort((a, b) => b.blockTime - a.blockTime);

        result.push({
          address,
          totalCount,
          inputCount: data.inputTxids.size,
          outputCount: data.outputTxids.size,
          transactions,
          record: addressToRecord.get(address),
        });
      }
    });

    result.sort((a, b) => b.totalCount - a.totalCount);

    return result;
  }, [participants, txidToBlockTime, addressToRecord]);

  const filteredAddresses = useMemo(() => {
    if (!search.trim()) return reusedAddresses;
    
    const searchLower = search.toLowerCase();
    return reusedAddresses.filter(item => {
      if (item.address.toLowerCase().includes(searchLower)) return true;
      if (item.record?.label?.toLowerCase().includes(searchLower)) return true;
      if (item.record?.owner?.toLowerCase().includes(searchLower)) return true;
      if (item.record?.walletName?.toLowerCase().includes(searchLower)) return true;
      return false;
    });
  }, [reusedAddresses, search]);

  const toggleExpanded = (address: string) => {
    setExpandedAddresses(prev => {
      const next = new Set(prev);
      if (next.has(address)) {
        next.delete(address);
      } else {
        next.add(address);
      }
      return next;
    });
  };

  const copyToClipboard = async (text: string, type: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedAddress(text);
      setTimeout(() => setCopiedAddress(null), 2000);
      toast({
        title: "Copied",
        description: `${type} copied to clipboard`,
      });
    } catch {
      toast({
        title: "Failed to copy",
        description: "Could not copy to clipboard",
        variant: "destructive",
      });
    }
  };

  const openInExplorer = (txid: string) => {
    window.open(`https://mempool.space/tx/${txid}`, '_blank');
  };

  const totalReusedAddresses = reusedAddresses.length;
  const totalReuseInstances = reusedAddresses.reduce((sum, a) => sum + a.totalCount, 0);

  return (
    <ScrollArea className="h-full">
      <div className="p-6 space-y-6">
        <div className="flex flex-col gap-4">
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-page-title">Address Reuse</h1>
            <p className="text-muted-foreground mt-1">
              Addresses that have been used in multiple transactions
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Reused Addresses</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-amber-500" />
                  <span className="text-2xl font-bold" data-testid="text-reused-count">{totalReusedAddresses}</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Total Reuse Instances</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2">
                  <Repeat2 className="h-5 w-5 text-blue-500" />
                  <span className="text-2xl font-bold" data-testid="text-reuse-instances">{totalReuseInstances}</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Average Reuse</CardTitle>
              </CardHeader>
              <CardContent>
                <span className="text-2xl font-bold" data-testid="text-average-reuse">
                  {totalReusedAddresses > 0 ? (totalReuseInstances / totalReusedAddresses).toFixed(1) : "0"}x
                </span>
              </CardContent>
            </Card>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Repeat2 className="h-5 w-5" />
              Reused Addresses
            </CardTitle>
            <CardDescription>
              Click on an address to see the transactions where it was reused
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="mb-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by address, label, owner..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-10"
                  data-testid="input-search-reuse"
                />
              </div>
            </div>

            {filteredAddresses.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                {reusedAddresses.length === 0 ? (
                  <div className="space-y-2">
                    <Repeat2 className="h-12 w-12 mx-auto opacity-50" />
                    <p>No address reuse detected</p>
                    <p className="text-sm">Sync transactions to detect address reuse patterns</p>
                  </div>
                ) : (
                  <p>No addresses match your search</p>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {filteredAddresses.map((item) => (
                  <Collapsible
                    key={item.address}
                    open={expandedAddresses.has(item.address)}
                    onOpenChange={() => toggleExpanded(item.address)}
                  >
                    <div className="border rounded-lg overflow-hidden">
                      <CollapsibleTrigger asChild>
                        <button
                          className="w-full p-4 flex items-center justify-between hover-elevate text-left"
                          data-testid={`button-expand-address-${item.address.slice(0, 8)}`}
                        >
                          <div className="flex items-center gap-3 min-w-0 flex-1">
                            <div className="flex flex-col min-w-0">
                              {item.record?.label && (
                                <span className="font-medium truncate" data-testid={`text-label-${item.address.slice(0, 8)}`}>
                                  {item.record.label}
                                </span>
                              )}
                              <span className="font-mono text-sm text-muted-foreground truncate">
                                {truncate(item.address, 10, 10)}
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center gap-3 flex-shrink-0">
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className="flex items-center gap-1" title="Incoming (received)">
                                <ArrowDownLeft className="h-3 w-3 text-green-500" />
                                <span data-testid={`text-incoming-count-${item.address.slice(0, 8)}`}>{item.outputCount}</span>
                              </Badge>
                              <Badge variant="outline" className="flex items-center gap-1" title="Outgoing (spent)">
                                <ArrowUpRight className="h-3 w-3 text-orange-500" />
                                <span data-testid={`text-outgoing-count-${item.address.slice(0, 8)}`}>{item.inputCount}</span>
                              </Badge>
                            </div>
                            
                            <Badge className="font-bold" data-testid={`text-total-count-${item.address.slice(0, 8)}`}>
                              {item.totalCount}x
                            </Badge>

                            {expandedAddresses.has(item.address) ? (
                              <ChevronUp className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <ChevronDown className="h-4 w-4 text-muted-foreground" />
                            )}
                          </div>
                        </button>
                      </CollapsibleTrigger>

                      <CollapsibleContent>
                        <div className="border-t bg-muted/30 p-4 space-y-3">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-sm break-all">{item.address}</span>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={(e) => {
                                e.stopPropagation();
                                copyToClipboard(item.address, "Address");
                              }}
                              data-testid={`button-copy-address-${item.address.slice(0, 8)}`}
                            >
                              {copiedAddress === item.address ? (
                                <Check className="h-4 w-4 text-green-500" />
                              ) : (
                                <Copy className="h-4 w-4" />
                              )}
                            </Button>
                          </div>

                          {item.record && (
                            <div className="flex flex-wrap gap-2 text-sm">
                              {item.record.owner && (
                                <Badge variant="secondary">Owner: {item.record.owner}</Badge>
                              )}
                              {item.record.walletName && (
                                <Badge variant="secondary">Wallet: {item.record.walletName}</Badge>
                              )}
                            </div>
                          )}

                          <div className="space-y-2">
                            <h4 className="text-sm font-medium text-muted-foreground">Transactions ({item.transactions.length})</h4>
                            <div className="space-y-1">
                              {item.transactions.map((tx) => (
                                <div
                                  key={`${tx.txid}-${tx.role}`}
                                  className="flex items-center justify-between p-2 rounded border bg-background"
                                  data-testid={`row-tx-${tx.txid.slice(0, 8)}`}
                                >
                                  <div className="flex items-center gap-3 min-w-0">
                                    {tx.role === 'output' ? (
                                      <div className="flex items-center gap-1 text-green-500" title="Incoming (received to this address)">
                                        <ArrowDownLeft className="h-4 w-4" />
                                        <span className="text-xs font-medium">IN</span>
                                      </div>
                                    ) : (
                                      <div className="flex items-center gap-1 text-orange-500" title="Outgoing (spent from this address)">
                                        <ArrowUpRight className="h-4 w-4" />
                                        <span className="text-xs font-medium">OUT</span>
                                      </div>
                                    )}
                                    <span className="font-mono text-sm truncate">
                                      {truncate(tx.txid, 12, 12)}
                                    </span>
                                  </div>

                                  <div className="flex items-center gap-2 flex-shrink-0">
                                    <span className="text-sm text-muted-foreground">
                                      {tx.blockTime > 0 ? format(new Date(tx.blockTime * 1000), 'MMM d, yyyy') : 'Pending'}
                                    </span>
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        copyToClipboard(tx.txid, "Transaction ID");
                                      }}
                                      title="Copy transaction ID"
                                      data-testid={`button-copy-txid-${tx.txid.slice(0, 8)}`}
                                    >
                                      {copiedAddress === tx.txid ? (
                                        <Check className="h-4 w-4 text-green-500" />
                                      ) : (
                                        <Copy className="h-4 w-4" />
                                      )}
                                    </Button>
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        openInExplorer(tx.txid);
                                      }}
                                      title="View on mempool.space"
                                      data-testid={`button-explorer-${tx.txid.slice(0, 8)}`}
                                    >
                                      <ExternalLink className="h-4 w-4" />
                                    </Button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      </CollapsibleContent>
                    </div>
                  </Collapsible>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </ScrollArea>
  );
}

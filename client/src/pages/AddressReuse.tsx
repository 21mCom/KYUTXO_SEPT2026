import { useState, useMemo, useEffect, useRef } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { format } from "date-fns";
import { db, BlockchainTransaction, TransactionParticipant, Record, AddressImportance } from "@/lib/database";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { 
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
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
  AlertTriangle,
  Filter,
  Edit,
  X
} from "lucide-react";
import { decryptRecords, updateRecord } from "@/lib/encryptionFacade";
import { useToast } from "@/hooks/use-toast";
import { useOwners } from "@/hooks/use-owners";
import { useWalletNames } from "@/hooks/use-wallet-names";
import { RecordFormDialog } from "@/components/RecordFormDialog";
import { useTags } from "@/hooks/use-tags";
import { useCategories } from "@/hooks/use-categories";
import { useSeedNames } from "@/hooks/use-seed-names";
import { useWalletSoftware } from "@/hooks/use-wallet-software";

function truncate(str: string, start = 8, end = 8): string {
  if (str.length <= start + end + 3) return str;
  return `${str.slice(0, start)}...${str.slice(-end)}`;
}

type ReuseReason = 'multi-receive' | 'change-to-self' | 'both';

interface AddressReuseInfo {
  address: string;
  totalCount: number;
  inputCount: number;
  outputCount: number;
  reuseReason: ReuseReason;
  selfChangeTxids: string[]; // Transactions where address is both input and output
  transactions: {
    txid: string;
    blockTime: number;
    role: 'input' | 'output';
    isSelfChange?: boolean;
  }[];
  record?: Record;
}

// Importance tier display labels and order
const IMPORTANCE_OPTIONS: { value: AddressImportance | 'all'; label: string }[] = [
  { value: 'all', label: 'All Tiers' },
  { value: 'verified', label: 'Verified' },
  { value: 'manual', label: 'Manual' },
  { value: 'wallet-import', label: 'Wallet Import' },
  { value: 'xpub-derived', label: 'xPub Derived' },
  { value: 'blockchain-discovered', label: 'Blockchain Discovered' },
  { value: 'pending-review', label: 'Pending Review' },
];

export default function AddressReuse() {
  const [search, setSearch] = useState("");
  const [expandedAddresses, setExpandedAddresses] = useState<Set<string>>(new Set());
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const { toast } = useToast();
  
  // Filter states
  const [reuseTypeFilter, setReuseTypeFilter] = useState<ReuseReason | 'all'>('all');
  const [ownerFilter, setOwnerFilter] = useState<string>('all');
  const [importanceFilter, setImportanceFilter] = useState<AddressImportance | 'all'>('all');
  const [walletNameFilter, setWalletNameFilter] = useState<string>('all');
  
  // Dialog state for editing records
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<Record | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  // Vocabulary hooks for filters and dialog
  const { owners } = useOwners();
  const { walletNames } = useWalletNames();
  const { tags } = useTags();
  const { categories } = useCategories();
  const { seedNames } = useSeedNames();
  const { walletSoftware } = useWalletSoftware();

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

    // Build address map tracking input/output txids
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
      // Find transactions where address appears as BOTH input and output (change-to-self)
      const selfChangeTxids: string[] = [];
      data.inputTxids.forEach(txid => {
        if (data.outputTxids.has(txid)) {
          selfChangeTxids.push(txid);
        }
      });
      
      const hasSelfChange = selfChangeTxids.length > 0;
      const hasMultiReceive = data.outputTxids.size >= 2;
      
      // Only flag as reuse if: received 2+ times OR has change-to-self
      if (!hasMultiReceive && !hasSelfChange) {
        return; // Not reuse - skip this address
      }
      
      // Determine reuse reason
      let reuseReason: ReuseReason;
      if (hasMultiReceive && hasSelfChange) {
        reuseReason = 'both';
      } else if (hasMultiReceive) {
        reuseReason = 'multi-receive';
      } else {
        reuseReason = 'change-to-self';
      }

      const allTxids = new Set([...Array.from(data.inputTxids), ...Array.from(data.outputTxids)]);
      const transactions: AddressReuseInfo['transactions'] = [];
      
      allTxids.forEach(txid => {
        const blockTime = txidToBlockTime.get(txid) || 0;
        const isInput = data.inputTxids.has(txid);
        const isOutput = data.outputTxids.has(txid);
        const isSelfChange = isInput && isOutput;
        
        if (isOutput) {
          transactions.push({ txid, blockTime, role: 'output', isSelfChange });
        }
        if (isInput) {
          transactions.push({ txid, blockTime, role: 'input', isSelfChange });
        }
      });

      transactions.sort((a, b) => b.blockTime - a.blockTime);

      result.push({
        address,
        totalCount: allTxids.size,
        inputCount: data.inputTxids.size,
        outputCount: data.outputTxids.size,
        reuseReason,
        selfChangeTxids,
        transactions,
        record: addressToRecord.get(address),
      });
    });

    // Sort by most recent transaction activity first (for default view)
    result.sort((a, b) => {
      const aLatest = a.transactions[0]?.blockTime || 0;
      const bLatest = b.transactions[0]?.blockTime || 0;
      return bLatest - aLatest;
    });

    return result;
  }, [participants, txidToBlockTime, addressToRecord]);

  // Split into YOUR addresses (with records) vs OTHER addresses (counterparties)
  const { yourReusedAddresses, otherReusedAddresses } = useMemo(() => {
    const yours: AddressReuseInfo[] = [];
    const others: AddressReuseInfo[] = [];
    
    reusedAddresses.forEach(item => {
      if (item.record) {
        yours.push(item);
      } else {
        others.push(item);
      }
    });
    
    return { yourReusedAddresses: yours, otherReusedAddresses: others };
  }, [reusedAddresses]);

  // Unique owners and wallet names from reused addresses for filter dropdowns
  const uniqueOwners = useMemo(() => {
    const ownersSet = new Set<string>();
    yourReusedAddresses.forEach(item => {
      if (item.record?.owner) ownersSet.add(item.record.owner);
    });
    return Array.from(ownersSet).sort();
  }, [yourReusedAddresses]);

  const uniqueWalletNames = useMemo(() => {
    const walletNamesSet = new Set<string>();
    yourReusedAddresses.forEach(item => {
      if (item.record?.walletName) walletNamesSet.add(item.record.walletName);
    });
    return Array.from(walletNamesSet).sort();
  }, [yourReusedAddresses]);

  // Apply all filters
  const filteredAddresses = useMemo(() => {
    let result = yourReusedAddresses;
    
    // Filter by reuse type
    if (reuseTypeFilter !== 'all') {
      result = result.filter(item => {
        if (reuseTypeFilter === 'both') return item.reuseReason === 'both';
        if (item.reuseReason === 'both') return true; // 'both' matches either filter
        return item.reuseReason === reuseTypeFilter;
      });
    }
    
    // Filter by owner
    if (ownerFilter !== 'all') {
      result = result.filter(item => item.record?.owner === ownerFilter);
    }
    
    // Filter by importance tier
    if (importanceFilter !== 'all') {
      result = result.filter(item => item.record?.addressImportance === importanceFilter);
    }
    
    // Filter by wallet name
    if (walletNameFilter !== 'all') {
      result = result.filter(item => item.record?.walletName === walletNameFilter);
    }
    
    // Filter by search text
    if (search.trim()) {
      const searchLower = search.toLowerCase();
      result = result.filter(item => {
        if (item.address.toLowerCase().includes(searchLower)) return true;
        if (item.record?.label?.toLowerCase().includes(searchLower)) return true;
        if (item.record?.owner?.toLowerCase().includes(searchLower)) return true;
        if (item.record?.walletName?.toLowerCase().includes(searchLower)) return true;
        return false;
      });
    }
    
    return result;
  }, [yourReusedAddresses, search, reuseTypeFilter, ownerFilter, importanceFilter, walletNameFilter]);

  // Check if any filters are active
  const hasActiveFilters = reuseTypeFilter !== 'all' || ownerFilter !== 'all' || importanceFilter !== 'all' || walletNameFilter !== 'all';
  
  const clearAllFilters = () => {
    setReuseTypeFilter('all');
    setOwnerFilter('all');
    setImportanceFilter('all');
    setWalletNameFilter('all');
    setSearch('');
  };
  
  // Open record for editing
  const openRecordDialog = (record: Record) => {
    setEditingRecord(record);
    setEditDialogOpen(true);
  };
  
  // Handle saving record
  const handleSaveRecord = async (data: any, files: File[]) => {
    if (!editingRecord?.id) return;
    
    setIsSubmitting(true);
    try {
      await updateRecord(editingRecord.id, {
        label: data.label,
        notes: data.notes,
        tags: data.tags,
        categories: data.categories,
        seedName: data.seedName,
        walletSoftware: data.walletSoftware,
        owner: data.owner,
        walletName: data.walletName,
        privateKeyStatus: data.privateKeyStatus,
        customFields: data.customFields,
      });
      
      toast({
        title: "Saved",
        description: "Record updated successfully",
      });
      
      setEditDialogOpen(false);
      setEditingRecord(null);
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to save record",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

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

  // Statistics based on filtered results (so stats update as filters change)
  const totalReusedAddresses = filteredAddresses.length;
  const multiReceiveCount = filteredAddresses.filter(a => a.reuseReason === 'multi-receive' || a.reuseReason === 'both').length;
  const changeToSelfCount = filteredAddresses.filter(a => a.reuseReason === 'change-to-self' || a.reuseReason === 'both').length;

  return (
    <ScrollArea className="h-full">
      <div className="p-6 space-y-6">
        <div className="flex flex-col gap-4">
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-page-title">Address Reuse</h1>
            <p className="text-muted-foreground mt-1">
              Addresses that received funds multiple times or had change routed back to them
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Total Reused</CardTitle>
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
                <CardTitle className="text-sm font-medium text-muted-foreground">Multi-Receive</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2">
                  <ArrowDownLeft className="h-5 w-5 text-amber-600" />
                  <span className="text-2xl font-bold" data-testid="text-multi-receive-count">{multiReceiveCount}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">Received funds 2+ times</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Change-to-Self</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2">
                  <Repeat2 className="h-5 w-5 text-orange-500" />
                  <span className="text-2xl font-bold" data-testid="text-change-to-self-count">{changeToSelfCount}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">Change sent back to same address</p>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Filters Section */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Filter className="h-4 w-4" />
                Filters
              </CardTitle>
              {hasActiveFilters && (
                <Button 
                  variant="ghost" 
                  size="sm" 
                  onClick={clearAllFilters}
                  className="h-7 text-xs"
                  data-testid="button-clear-filters"
                >
                  <X className="h-3 w-3 mr-1" />
                  Clear All
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Reuse Type Toggle */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-muted-foreground">Reuse Type</label>
              <ToggleGroup 
                type="single" 
                value={reuseTypeFilter} 
                onValueChange={(val) => setReuseTypeFilter((val as ReuseReason | 'all') || 'all')}
                className="justify-start flex-wrap"
              >
                <ToggleGroupItem value="all" size="sm" data-testid="toggle-reuse-all">Any Type</ToggleGroupItem>
                <ToggleGroupItem value="multi-receive" size="sm" data-testid="toggle-reuse-multi-receive">
                  <ArrowDownLeft className="h-3 w-3 mr-1" />
                  Multi-Receive
                </ToggleGroupItem>
                <ToggleGroupItem value="change-to-self" size="sm" data-testid="toggle-reuse-change-to-self">
                  <Repeat2 className="h-3 w-3 mr-1" />
                  Change-to-Self
                </ToggleGroupItem>
                <ToggleGroupItem value="both" size="sm" data-testid="toggle-reuse-both">Both</ToggleGroupItem>
              </ToggleGroup>
            </div>
            
            {/* Row of dropdown filters */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {/* Owner Filter */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-muted-foreground">Owner</label>
                <Select value={ownerFilter} onValueChange={setOwnerFilter}>
                  <SelectTrigger data-testid="select-owner-filter">
                    <SelectValue placeholder="All Owners" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Owners</SelectItem>
                    {uniqueOwners.map(owner => (
                      <SelectItem key={owner} value={owner}>{owner}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              
              {/* Wallet Name Filter */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-muted-foreground">Wallet</label>
                <Select value={walletNameFilter} onValueChange={setWalletNameFilter}>
                  <SelectTrigger data-testid="select-wallet-filter">
                    <SelectValue placeholder="All Wallets" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Wallets</SelectItem>
                    {uniqueWalletNames.map(wallet => (
                      <SelectItem key={wallet} value={wallet}>{wallet}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              
              {/* Importance Tier Filter */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-muted-foreground">Importance</label>
                <Select value={importanceFilter} onValueChange={(val) => setImportanceFilter(val as AddressImportance | 'all')}>
                  <SelectTrigger data-testid="select-importance-filter">
                    <SelectValue placeholder="All Tiers" />
                  </SelectTrigger>
                  <SelectContent>
                    {IMPORTANCE_OPTIONS.map(opt => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Repeat2 className="h-5 w-5" />
              Reused Addresses
              {hasActiveFilters && (
                <Badge variant="secondary" className="ml-2 text-xs">
                  Filtered
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              Addresses that appear in multiple transactions. Click to expand, or click the edit icon to view metadata.
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
                {yourReusedAddresses.length === 0 ? (
                  <div className="space-y-2">
                    <Repeat2 className="h-12 w-12 mx-auto opacity-50" />
                    <p>No address reuse detected in your tracked addresses</p>
                    <p className="text-sm">Sync transactions to detect address reuse patterns</p>
                  </div>
                ) : hasActiveFilters || search.trim() ? (
                  <div className="space-y-2">
                    <Filter className="h-12 w-12 mx-auto opacity-50" />
                    <p>No addresses match your filters</p>
                    <Button variant="ghost" size="sm" onClick={clearAllFilters} data-testid="button-clear-filters-empty">
                      Clear Filters
                    </Button>
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
                            {/* Reuse reason badge */}
                            {item.reuseReason === 'multi-receive' && (
                              <Badge variant="secondary" className="text-amber-600 dark:text-amber-400" title="Received funds multiple times">
                                Multi-receive
                              </Badge>
                            )}
                            {item.reuseReason === 'change-to-self' && (
                              <Badge variant="secondary" className="text-orange-600 dark:text-orange-400" title="Change sent back to same address">
                                Change-to-self
                              </Badge>
                            )}
                            {item.reuseReason === 'both' && (
                              <Badge variant="secondary" className="text-red-600 dark:text-red-400" title="Both multi-receive and change-to-self">
                                Both
                              </Badge>
                            )}

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
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <div className="flex items-center gap-2 flex-wrap min-w-0 flex-1">
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
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openRecordDialog(item.record!);
                                }}
                                data-testid={`button-edit-record-${item.address.slice(0, 8)}`}
                              >
                                <Edit className="h-3 w-3 mr-1" />
                                Edit Metadata
                              </Button>
                            )}
                          </div>

                          {item.record && (
                            <div className="flex flex-wrap gap-2 text-sm">
                              {item.record.owner && (
                                <Badge variant="secondary">Owner: {item.record.owner}</Badge>
                              )}
                              {item.record.walletName && (
                                <Badge variant="secondary">Wallet: {item.record.walletName}</Badge>
                              )}
                              {item.record.addressImportance && (
                                <Badge variant="outline" className="capitalize">
                                  {item.record.addressImportance.replace(/-/g, ' ')}
                                </Badge>
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

        {/* Info about counterparty addresses */}
        {otherReusedAddresses.length > 0 && (
          <div className="text-sm text-muted-foreground bg-muted/50 p-4 rounded-lg">
            <p>
              <span className="font-medium">Note:</span> {otherReusedAddresses.length.toLocaleString()} other addresses 
              (counterparties, exchanges, etc.) also appear in multiple of your transactions but are not shown here 
              since they're not addresses you control.
            </p>
          </div>
        )}
      </div>
      
      {/* Record Edit Dialog */}
      <RecordFormDialog
        open={editDialogOpen}
        onClose={() => {
          setEditDialogOpen(false);
          setEditingRecord(null);
        }}
        onSave={handleSaveRecord}
        initialData={editingRecord}
        isSubmitting={isSubmitting}
        availableTags={tags.map(t => t.name)}
        availableCategories={categories.map(c => c.name)}
        availableSeedNames={seedNames.map(s => s.name)}
        availableWalletSoftware={walletSoftware.map(w => w.name)}
        availableOwners={owners.map(o => o.name)}
        availableWalletNames={walletNames.map(w => w.name)}
      />
    </ScrollArea>
  );
}

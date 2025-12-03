import { useState, useMemo, useEffect, useRef } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { format } from "date-fns";
import { Link } from "wouter";
import { db, BlockchainTransaction, TransactionParticipant, Record as DbRecord } from "@/lib/database";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { 
  Search,
  CalendarIcon,
  Coins,
  RefreshCw,
  ExternalLink,
  AlertCircle,
  X,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronLeft,
  ChevronRight
} from "lucide-react";
import { SiBitcoin } from "react-icons/si";
import { decryptRecords, isEncryptionReady } from "@/lib/encryptionFacade";
import { cn } from "@/lib/utils";

const ITEMS_PER_PAGE = 50;

function satsToBtc(sats: number): string {
  return (sats / 100_000_000).toFixed(8);
}

function formatSats(sats: number): string {
  if (sats >= 100_000_000) {
    return `${satsToBtc(sats)} BTC`;
  } else if (sats >= 1_000_000) {
    return `${(sats / 1_000_000).toFixed(2)}M sats`;
  } else if (sats >= 1_000) {
    return `${(sats / 1_000).toFixed(1)}k sats`;
  }
  return `${sats.toLocaleString()} sats`;
}

function truncateAddress(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}...${addr.slice(-8)}`;
}

function truncateTxid(txid: string): string {
  return `${txid.slice(0, 8)}...${txid.slice(-8)}`;
}

interface UTXO {
  id: string;
  txid: string;
  vout: number;
  address: string;
  amountSats: number;
  blockTime: number;
  blockHeight: number;
  recordId?: number;
  label?: string;
  owner?: string;
  walletName?: string;
  tags?: string[];
  categories?: string[];
}

type SortColumn = "amount" | "date" | "address" | "owner" | "wallet";
type SortDirection = "asc" | "desc";

export default function UTXOs() {
  const [search, setSearch] = useState("");
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined);
  const [ownerFilter, setOwnerFilter] = useState<string>("all");
  const [walletFilter, setWalletFilter] = useState<string>("all");
  const [tagFilter, setTagFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [sortColumn, setSortColumn] = useState<SortColumn>("date");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [currentPage, setCurrentPage] = useState(1);
  const [displayUnit, setDisplayUnit] = useState<"btc" | "sats">("btc");

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

  const addressSyncState = useLiveQuery(
    () => db.addressSyncState.toArray(),
    []
  );

  const owners = useLiveQuery(
    () => db.owners.toArray(),
    []
  );

  const walletNames = useLiveQuery(
    () => db.walletNames.toArray(),
    []
  );

  const tags = useLiveQuery(
    () => db.tags.toArray(),
    []
  );

  const categories = useLiveQuery(
    () => db.categories.toArray(),
    []
  );

  const [decryptedRecords, setDecryptedRecords] = useState<DbRecord[]>([]);
  const decryptRequestId = useRef(0);
  
  useEffect(() => {
    if (!rawRecords) return;
    
    decryptRequestId.current += 1;
    const thisRequestId = decryptRequestId.current;
    
    const decrypt = async () => {
      try {
        if (isEncryptionReady()) {
          const decrypted = await decryptRecords(rawRecords);
          if (thisRequestId === decryptRequestId.current) {
            setDecryptedRecords(decrypted);
          }
        } else {
          if (thisRequestId === decryptRequestId.current) {
            setDecryptedRecords(rawRecords);
          }
        }
      } catch {
        if (thisRequestId === decryptRequestId.current) {
          setDecryptedRecords(rawRecords);
        }
      }
    };
    
    decrypt();
  }, [rawRecords]);

  const addressToRecord = useMemo(() => {
    const map = new Map<string, DbRecord>();
    decryptedRecords.forEach(record => {
      if (record.type === 'address' && record.inputString) {
        map.set(record.inputString, record);
      }
    });
    return map;
  }, [decryptedRecords]);

  const txidToTx = useMemo(() => {
    const map = new Map<string, BlockchainTransaction>();
    transactions?.forEach(tx => {
      map.set(tx.txid, tx);
    });
    return map;
  }, [transactions]);

  const lastSyncTime = useMemo(() => {
    if (!addressSyncState || addressSyncState.length === 0) return null;
    return Math.max(...addressSyncState.map(s => s.lastSyncedAt));
  }, [addressSyncState]);

  const utxos = useMemo(() => {
    if (!participants || !transactions) return [];

    const cutoffTime = selectedDate 
      ? Math.floor(selectedDate.getTime() / 1000) + 86400
      : Infinity;

    const outputs = participants.filter(p => p.role === 'output');
    const inputs = participants.filter(p => p.role === 'input');

    const outputsWithTime = outputs.map(output => {
      const tx = txidToTx.get(output.txid);
      return { output, blockTime: tx?.blockTime ?? 0, blockHeight: tx?.blockHeight ?? 0 };
    }).filter(o => o.blockTime > 0 && o.blockTime <= cutoffTime);

    outputsWithTime.sort((a, b) => {
      if (a.blockTime !== b.blockTime) return a.blockTime - b.blockTime;
      return (a.output.vout ?? 0) - (b.output.vout ?? 0);
    });

    const inputsWithTime = inputs.map(input => {
      const tx = txidToTx.get(input.txid);
      return { input, blockTime: tx?.blockTime ?? 0 };
    }).filter(i => i.blockTime > 0 && i.blockTime <= cutoffTime);

    inputsWithTime.sort((a, b) => a.blockTime - b.blockTime);

    const inputsByAddressAmount = new Map<string, { input: TransactionParticipant; blockTime: number }[]>();
    inputsWithTime.forEach(item => {
      const key = `${item.input.address}:${item.input.amount}`;
      const existing = inputsByAddressAmount.get(key) || [];
      existing.push(item);
      inputsByAddressAmount.set(key, existing);
    });

    const result: UTXO[] = [];
    const matchedInputIndices = new Map<string, number>();

    for (const { output, blockTime, blockHeight } of outputsWithTime) {
      const key = `${output.address}:${output.amount}`;
      const matchingInputs = inputsByAddressAmount.get(key) || [];
      
      const currentIndex = matchedInputIndices.get(key) || 0;
      
      const spendingInput = matchingInputs.find((item, idx) => 
        idx >= currentIndex && item.blockTime > blockTime
      );

      if (spendingInput) {
        const spendIdx = matchingInputs.indexOf(spendingInput);
        matchedInputIndices.set(key, spendIdx + 1);
        continue;
      }

      const record = addressToRecord.get(output.address);
      
      result.push({
        id: `${output.txid}:${output.vout ?? 0}`,
        txid: output.txid,
        vout: output.vout ?? 0,
        address: output.address,
        amountSats: output.amount,
        blockTime: blockTime,
        blockHeight: blockHeight,
        recordId: record?.id,
        label: record?.label,
        owner: record?.owner,
        walletName: record?.walletName,
        tags: record?.tags,
        categories: record?.categories,
      });
    }

    return result;
  }, [participants, transactions, txidToTx, addressToRecord, selectedDate]);

  const uniqueOwners = useMemo(() => {
    const set = new Set<string>();
    utxos.forEach(u => {
      if (u.owner) set.add(u.owner);
    });
    return Array.from(set).sort();
  }, [utxos]);

  const uniqueWallets = useMemo(() => {
    const set = new Set<string>();
    utxos.forEach(u => {
      if (u.walletName) set.add(u.walletName);
    });
    return Array.from(set).sort();
  }, [utxos]);

  const uniqueTags = useMemo(() => {
    const set = new Set<string>();
    utxos.forEach(u => {
      u.tags?.forEach(t => set.add(t));
    });
    return Array.from(set).sort();
  }, [utxos]);

  const uniqueCategories = useMemo(() => {
    const set = new Set<string>();
    utxos.forEach(u => {
      u.categories?.forEach(c => set.add(c));
    });
    return Array.from(set).sort();
  }, [utxos]);

  const filteredUtxos = useMemo(() => {
    let filtered = utxos;

    if (ownerFilter !== "all") {
      if (ownerFilter === "unassigned") {
        filtered = filtered.filter(u => !u.owner);
      } else {
        filtered = filtered.filter(u => u.owner === ownerFilter);
      }
    }

    if (walletFilter !== "all") {
      if (walletFilter === "unassigned") {
        filtered = filtered.filter(u => !u.walletName);
      } else {
        filtered = filtered.filter(u => u.walletName === walletFilter);
      }
    }

    if (tagFilter !== "all") {
      if (tagFilter === "unassigned") {
        filtered = filtered.filter(u => !u.tags || u.tags.length === 0);
      } else {
        filtered = filtered.filter(u => u.tags?.includes(tagFilter));
      }
    }

    if (categoryFilter !== "all") {
      if (categoryFilter === "unassigned") {
        filtered = filtered.filter(u => !u.categories || u.categories.length === 0);
      } else {
        filtered = filtered.filter(u => u.categories?.includes(categoryFilter));
      }
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      filtered = filtered.filter(u =>
        u.address.toLowerCase().includes(q) ||
        u.txid.toLowerCase().includes(q) ||
        u.label?.toLowerCase().includes(q) ||
        u.owner?.toLowerCase().includes(q) ||
        u.walletName?.toLowerCase().includes(q) ||
        u.tags?.some(t => t.toLowerCase().includes(q)) ||
        u.categories?.some(c => c.toLowerCase().includes(q))
      );
    }

    return filtered;
  }, [utxos, ownerFilter, walletFilter, tagFilter, categoryFilter, search]);

  const sortedUtxos = useMemo(() => {
    const sorted = [...filteredUtxos];
    
    sorted.sort((a, b) => {
      let cmp = 0;
      switch (sortColumn) {
        case "amount":
          cmp = a.amountSats - b.amountSats;
          break;
        case "date":
          cmp = a.blockTime - b.blockTime;
          break;
        case "address":
          cmp = a.address.localeCompare(b.address);
          break;
        case "owner":
          cmp = (a.owner || "").localeCompare(b.owner || "");
          break;
        case "wallet":
          cmp = (a.walletName || "").localeCompare(b.walletName || "");
          break;
      }
      return sortDirection === "asc" ? cmp : -cmp;
    });

    return sorted;
  }, [filteredUtxos, sortColumn, sortDirection]);

  const totalPages = Math.max(1, Math.ceil(sortedUtxos.length / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);
  const paginatedUtxos = sortedUtxos.slice(
    (safePage - 1) * ITEMS_PER_PAGE,
    safePage * ITEMS_PER_PAGE
  );

  const totalSats = filteredUtxos.reduce((sum, u) => sum + u.amountSats, 0);
  const utxoCount = filteredUtxos.length;

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortColumn(column);
      setSortDirection("desc");
    }
  };

  const clearFilters = () => {
    setSearch("");
    setOwnerFilter("all");
    setWalletFilter("all");
    setTagFilter("all");
    setCategoryFilter("all");
    setSelectedDate(undefined);
  };

  const hasActiveFilters = search || ownerFilter !== "all" || walletFilter !== "all" || tagFilter !== "all" || categoryFilter !== "all" || selectedDate;

  const isLoading = !transactions || !participants;

  useEffect(() => {
    setCurrentPage(1);
  }, [search, ownerFilter, walletFilter, tagFilter, categoryFilter, selectedDate]);

  const SortableHeader = ({ column, label }: { column: SortColumn; label: string }) => (
    <TableHead>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 gap-1 -ml-3"
        onClick={() => handleSort(column)}
        data-testid={`button-sort-${column}`}
      >
        {label}
        {sortColumn === column && sortDirection === "asc" ? (
          <ArrowUp className="h-3 w-3" />
        ) : sortColumn === column && sortDirection === "desc" ? (
          <ArrowDown className="h-3 w-3" />
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-50" />
        )}
      </Button>
    </TableHead>
  );

  return (
    <div className="flex flex-col h-full overflow-hidden p-4 gap-4">
      <div className="flex-none">
        <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="text-page-title">
          <Coins className="h-6 w-6" />
          UTXOs
        </h1>
        <p className="text-muted-foreground mt-1">
          View unspent transaction outputs with filters and historical snapshots
        </p>
      </div>

      <div className="flex items-center gap-2 text-sm text-muted-foreground flex-none">
        <AlertCircle className="h-4 w-4" />
        <span>
          Data based on last transaction sync
          {lastSyncTime && (
            <span className="ml-1">
              ({format(new Date(lastSyncTime), "MMM d, yyyy 'at' h:mm a")})
            </span>
          )}
        </span>
        <Link href="/transaction-sync">
          <Button variant="ghost" size="sm" className="h-auto p-0 text-primary hover:underline" data-testid="link-sync">
            <RefreshCw className="h-3 w-3 mr-1" />
            Sync now
          </Button>
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 flex-none">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total UTXOs</CardDescription>
            <CardTitle className="text-2xl" data-testid="text-utxo-count">
              {utxoCount.toLocaleString()}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Balance</CardDescription>
            <CardTitle className="text-2xl flex items-center gap-2" data-testid="text-total-balance">
              <SiBitcoin className="h-5 w-5 text-primary" />
              {displayUnit === "btc" ? (
                <span>{satsToBtc(totalSats)} BTC</span>
              ) : (
                <span>{totalSats.toLocaleString()} sats</span>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="ml-2 h-6 text-xs"
                onClick={() => setDisplayUnit(u => u === "btc" ? "sats" : "btc")}
                data-testid="button-toggle-unit"
              >
                {displayUnit === "btc" ? "Show sats" : "Show BTC"}
              </Button>
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card className="flex-none">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-4">
            <div className="flex-1 min-w-[200px]">
              <Label className="sr-only">Search</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search address, txid, label..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-10"
                  data-testid="input-search"
                />
              </div>
            </div>

            <div className="w-[180px]">
              <Label className="sr-only">Owner</Label>
              <Select value={ownerFilter} onValueChange={setOwnerFilter}>
                <SelectTrigger data-testid="select-owner">
                  <SelectValue placeholder="All Owners" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Owners</SelectItem>
                  <SelectItem value="unassigned">Unassigned</SelectItem>
                  {uniqueOwners.map(owner => (
                    <SelectItem key={owner} value={owner}>{owner}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="w-[180px]">
              <Label className="sr-only">Wallet</Label>
              <Select value={walletFilter} onValueChange={setWalletFilter}>
                <SelectTrigger data-testid="select-wallet">
                  <SelectValue placeholder="All Wallets" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Wallets</SelectItem>
                  <SelectItem value="unassigned">Unassigned</SelectItem>
                  {uniqueWallets.map(wallet => (
                    <SelectItem key={wallet} value={wallet}>{wallet}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="w-[160px]">
              <Label className="sr-only">Tag</Label>
              <Select value={tagFilter} onValueChange={setTagFilter}>
                <SelectTrigger data-testid="select-tag">
                  <SelectValue placeholder="All Tags" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Tags</SelectItem>
                  <SelectItem value="unassigned">No Tags</SelectItem>
                  {uniqueTags.map(tag => (
                    <SelectItem key={tag} value={tag}>{tag}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="w-[160px]">
              <Label className="sr-only">Category</Label>
              <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                <SelectTrigger data-testid="select-category">
                  <SelectValue placeholder="All Categories" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Categories</SelectItem>
                  <SelectItem value="unassigned">No Category</SelectItem>
                  {uniqueCategories.map(cat => (
                    <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="w-[200px]">
              <Label className="sr-only">Historical Date</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "w-full justify-start text-left font-normal",
                      !selectedDate && "text-muted-foreground"
                    )}
                    data-testid="button-date-picker"
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {selectedDate ? format(selectedDate, "MMM d, yyyy") : "View as of date..."}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={selectedDate}
                    onSelect={setSelectedDate}
                    disabled={(date) => date > new Date() || date < new Date(2009, 0, 3)}
                    captionLayout="dropdown-buttons"
                    fromYear={2009}
                    toYear={new Date().getFullYear()}
                    defaultMonth={selectedDate || new Date()}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            </div>

            {hasActiveFilters && (
              <Button
                variant="ghost"
                size="icon"
                onClick={clearFilters}
                title="Clear all filters"
                data-testid="button-clear-filters"
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>

          {selectedDate && (
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="gap-1">
                <CalendarIcon className="h-3 w-3" />
                Showing UTXOs as of {format(selectedDate, "MMMM d, yyyy")}
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedDate(undefined)}
                className="h-6 text-xs"
                data-testid="button-clear-date"
              >
                Show current
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex-1 overflow-hidden">
        <Card className="h-full flex flex-col">
          <CardHeader className="pb-2 flex-none">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">
                {filteredUtxos.length === utxos.length 
                  ? `${utxoCount} UTXOs` 
                  : `${filteredUtxos.length} of ${utxos.length} UTXOs`}
              </CardTitle>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={safePage <= 1}
                  onClick={() => setCurrentPage(p => p - 1)}
                  data-testid="button-prev-page"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm text-muted-foreground">
                  Page {safePage} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={safePage >= totalPages}
                  onClick={() => setCurrentPage(p => p + 1)}
                  data-testid="button-next-page"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex-1 overflow-auto p-0">
            {isLoading ? (
              <div className="flex items-center justify-center h-32">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
              </div>
            ) : paginatedUtxos.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-32 text-muted-foreground">
                <Coins className="h-8 w-8 mb-2 opacity-50" />
                <p>No UTXOs found</p>
                {hasActiveFilters && (
                  <Button variant="ghost" onClick={clearFilters} className="mt-1" data-testid="button-clear-filters-empty">
                    Clear filters
                  </Button>
                )}
              </div>
            ) : (
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10">
                  <TableRow>
                    <SortableHeader column="address" label="Address" />
                    <SortableHeader column="amount" label="Amount" />
                    <SortableHeader column="date" label="Received" />
                    <SortableHeader column="owner" label="Owner" />
                    <SortableHeader column="wallet" label="Wallet" />
                    <TableHead>Txid</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginatedUtxos.map((utxo) => (
                    <TableRow key={utxo.id} data-testid={`row-utxo-${utxo.id}`}>
                      <TableCell className="font-mono text-sm">
                        <div className="flex flex-col gap-1">
                          <span title={utxo.address}>{truncateAddress(utxo.address)}</span>
                          {utxo.label && (
                            <span className="text-xs text-muted-foreground">{utxo.label}</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono">
                        {displayUnit === "btc" ? (
                          <span>{satsToBtc(utxo.amountSats)} BTC</span>
                        ) : (
                          <span>{utxo.amountSats.toLocaleString()} sats</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        <div className="flex flex-col">
                          <span>{format(new Date(utxo.blockTime * 1000), "MMM d, yyyy")}</span>
                          <span className="text-xs text-muted-foreground">
                            Block {utxo.blockHeight.toLocaleString()}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        {utxo.owner ? (
                          <Badge variant="secondary">{utxo.owner}</Badge>
                        ) : (
                          <span className="text-muted-foreground text-sm">-</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {utxo.walletName ? (
                          <Badge variant="outline">{utxo.walletName}</Badge>
                        ) : (
                          <span className="text-muted-foreground text-sm">-</span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-sm">
                        <div className="flex items-center gap-1">
                          <span title={utxo.txid}>{truncateTxid(utxo.txid)}</span>
                          <span className="text-muted-foreground">:{utxo.vout}</span>
                          <a
                            href={`https://mempool.space/tx/${utxo.txid}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="ml-1 text-muted-foreground hover:text-primary"
                            onClick={(e) => e.stopPropagation()}
                            data-testid={`link-external-${utxo.txid.slice(0, 8)}`}
                          >
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

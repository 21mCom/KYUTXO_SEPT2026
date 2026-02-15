import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { format } from "date-fns";
import { Link } from "wouter";
import { db, BlockchainTransaction, TransactionParticipant, Record as DbRecord, PriceData } from "@/lib/database";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { BlockchainToggle } from "@/components/BlockchainToggle";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { 
  TransactionSearchFilters, 
  SearchFilters, 
  defaultFilters, 
  hasActiveSearchFilters,
  filterByDateAndAmount 
} from "@/components/TransactionSearchFilters";
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
  ChevronRight,
  ChevronDown,
  ChevronRight as ChevronRightIcon,
  Copy,
  Check,
  TrendingUp,
  TrendingDown,
  HelpCircle
} from "lucide-react";
import { SiBitcoin } from "react-icons/si";
import { decryptRecords, decryptRecordsWithProgress, isEncryptionReady, getDecryptedOwners, getDecryptedWalletNames, getDecryptedTags, getDecryptedCategories, getAllDecryptedParticipants } from "@/lib/encryptionFacade";
import type { DecryptProgress } from "@/lib/encryption/record-encryption";
import { cn } from "@/lib/utils";
import { UTXODetailPanel } from "@/components/UTXODetailPanel";
import { ClickableAddress } from "@/components/ClickableAddress";

const ITEMS_PER_PAGE = 50;
const SETTINGS_KEY = "kyutxo-utxos-settings";

type UTXOCalculationMode = "heuristic" | "exact";

interface UTXOSettings {
  displayUnit: "btc" | "sats";
  sortColumn: SortColumn;
  sortDirection: SortDirection;
  ownerFilter: string;
  walletFilter: string;
  tagFilter: string;
  categoryFilter: string;
  utxoMode: UTXOCalculationMode;
}

const DEFAULT_SETTINGS: UTXOSettings = {
  displayUnit: "btc",
  sortColumn: "date",
  sortDirection: "desc",
  ownerFilter: "all",
  walletFilter: "all",
  tagFilter: "all",
  categoryFilter: "all",
  utxoMode: "heuristic"
};

function loadSettings(): UTXOSettings {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
    }
  } catch {
    // Ignore parse errors
  }
  return DEFAULT_SETTINGS;
}

function saveSettings(settings: Partial<UTXOSettings>) {
  try {
    const current = loadSettings();
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...current, ...settings }));
  } catch {
    // Ignore storage errors
  }
}

function satsToBtc(sats: number): string {
  return (sats / 100_000_000).toFixed(8);
}

function truncateAddress(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}...${addr.slice(-8)}`;
}

function truncateTxid(txid: string): string {
  return `${txid.slice(0, 8)}...${txid.slice(-8)}`;
}

function formatUsdValue(value: number | undefined): string {
  if (value === undefined) return "-";
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
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
  valueAtReceipt?: number;
  priceAtReceipt?: number;
}

interface AddressGroup {
  address: string;
  totalSats: number;
  utxos: UTXO[];
  earliestDate: number;
  latestDate: number;
  recordId?: number;
  label?: string;
  owner?: string;
  walletName?: string;
  tags?: string[];
  categories?: string[];
  totalValueAtReceipt?: number;
  totalCurrentValue?: number;
  gain?: number;
  gainPercent?: number;
}

type SortColumn = "amount" | "date" | "address" | "gain";
type SortDirection = "asc" | "desc";

// User-curated importance tiers (exclude blockchain-discovered and pending-review by default)
const USER_CURATED_TIERS = ['verified', 'manual', 'wallet-import', 'xpub-derived'];

export default function UTXOs() {
  const initialSettings = useMemo(() => loadSettings(), []);
  
  const [search, setSearch] = useState("");
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined);
  const [searchFilters, setSearchFilters] = useState<SearchFilters>(defaultFilters);
  const [ownerFilter, setOwnerFilter] = useState<string>(initialSettings.ownerFilter);
  const [walletFilter, setWalletFilter] = useState<string>(initialSettings.walletFilter);
  const [tagFilter, setTagFilter] = useState<string>(initialSettings.tagFilter);
  const [categoryFilter, setCategoryFilter] = useState<string>(initialSettings.categoryFilter);
  const [sortColumn, setSortColumn] = useState<SortColumn>(initialSettings.sortColumn);
  const [sortDirection, setSortDirection] = useState<SortDirection>(initialSettings.sortDirection);
  const [utxoMode, setUtxoMode] = useState<UTXOCalculationMode>(initialSettings.utxoMode);
  const [currentPage, setCurrentPage] = useState(1);
  const [displayUnit, setDisplayUnit] = useState<"btc" | "sats">(initialSettings.displayUnit);
  const [expandedAddresses, setExpandedAddresses] = useState<Set<string>>(new Set());
  const [copiedTxid, setCopiedTxid] = useState<string | null>(null);
  const [selectedUtxo, setSelectedUtxo] = useState<UTXO | null>(null);
  const [detailPanelOpen, setDetailPanelOpen] = useState(false);
  
  // Smart filtering: exclude blockchain-discovered addresses by default
  const [includeBlockchainDiscovered, setIncludeBlockchainDiscovered] = useState(false);

  // NOTE: decryptProgress UI is rendered inline in JSX

  // Save settings when they change
  useEffect(() => {
    saveSettings({ displayUnit, sortColumn, sortDirection, ownerFilter, walletFilter, tagFilter, categoryFilter, utxoMode });
  }, [displayUnit, sortColumn, sortDirection, ownerFilter, walletFilter, tagFilter, categoryFilter, utxoMode]);

  const transactions = useLiveQuery(
    () => db.blockchainTransactions.toArray(),
    []
  );

  const participants = useLiveQuery(
    () => getAllDecryptedParticipants(),
    []
  );

  // Load address records using compound index [type+addressImportance] for zero-scan filtering
  // After v14 migration, all records have addressImportance set
  const rawRecords = useLiveQuery(
    async () => {
      if (includeBlockchainDiscovered) {
        // Load all address records using type index
        return db.records.where('type').equals('address').toArray();
      } else {
        // Use compound index for efficient filtering without table scans
        return db.records
          .where('[type+addressImportance]')
          .anyOf(USER_CURATED_TIERS.map(tier => ['address', tier]))
          .toArray();
      }
    },
    [includeBlockchainDiscovered]
  );
  
  // Count blockchain-discovered records using compound index
  const blockchainDiscoveredCount = useLiveQuery(
    async () => {
      return db.records
        .where('[type+addressImportance]')
        .anyOf([['address', 'blockchain-discovered'], ['address', 'pending-review']])
        .count();
    },
    []
  );

  const addressSyncState = useLiveQuery(
    () => db.addressSyncState.toArray(),
    []
  );

  // Load price data for value calculations
  const priceData = useLiveQuery(
    () => db.priceData
      .where('asset').equals('BTC')
      .filter(p => p.currency === 'USD')
      .toArray(),
    []
  );

  // Load vocabulary items for filter dropdowns
  const [owners, setOwners] = useState<string[]>([]);
  const [walletNames, setWalletNames] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [vocabLoaded, setVocabLoaded] = useState(false);

  useEffect(() => {
    const loadVocabulary = async () => {
      try {
        const [decryptedOwners, decryptedWalletNames, decryptedTags, decryptedCategories] = await Promise.all([
          getDecryptedOwners(),
          getDecryptedWalletNames(),
          getDecryptedTags(),
          getDecryptedCategories()
        ]);
        setOwners(decryptedOwners.map(o => o.name).filter(Boolean).sort());
        setWalletNames(decryptedWalletNames.map(w => w.name).filter(Boolean).sort());
        setTags(decryptedTags.map(t => t.name).filter(Boolean).sort());
        setCategories(decryptedCategories.map(c => c.name).filter(Boolean).sort());
        setVocabLoaded(true);
      } catch (error) {
        console.error('Failed to load vocabulary:', error);
      }
    };
    loadVocabulary();
  }, []);

  const [decryptedRecords, setDecryptedRecords] = useState<DbRecord[]>([]);
  const [decryptProgress, setDecryptProgress] = useState<DecryptProgress | null>(null);
  const decryptRequestId = useRef(0);
  
  useEffect(() => {
    if (!rawRecords) return;
    
    decryptRequestId.current += 1;
    const thisRequestId = decryptRequestId.current;
    
    const decrypt = async () => {
      try {
        if (isEncryptionReady()) {
          const decrypted = await decryptRecordsWithProgress(rawRecords, setDecryptProgress);
          setDecryptProgress(null);
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

  // Build set of user-curated addresses (for filtering UTXOs)
  const userCuratedAddresses = useMemo(() => {
    const set = new Set<string>();
    decryptedRecords.forEach(record => {
      if (record.type === 'address' && record.inputString) {
        const importance = record.addressImportance;
        // Include if no importance set (legacy) or if user-curated tier
        if (!importance || USER_CURATED_TIERS.includes(importance)) {
          set.add(record.inputString);
        }
      }
    });
    return set;
  }, [decryptedRecords]);

  // Count blockchain-discovered addresses that have UTXOs
  const blockchainDiscoveredWithUtxos = useMemo(() => {
    const set = new Set<string>();
    decryptedRecords.forEach(record => {
      if (record.type === 'address' && record.inputString) {
        const importance = record.addressImportance;
        // Only count blockchain-discovered and pending-review tiers
        if (importance && !USER_CURATED_TIERS.includes(importance)) {
          set.add(record.inputString);
        }
      }
    });
    return set;
  }, [decryptedRecords]);

  const txidToTx = useMemo(() => {
    const map = new Map<string, BlockchainTransaction>();
    transactions?.forEach(tx => {
      map.set(tx.txid, tx);
    });
    return map;
  }, [transactions]);

  // Create price lookup map by date
  const priceByDate = useMemo(() => {
    const map = new Map<string, number>();
    priceData?.forEach(p => {
      map.set(p.date, p.close);
    });
    return map;
  }, [priceData]);

  // Get latest price date and value
  const latestPrice = useMemo(() => {
    if (!priceData || priceData.length === 0) return null;
    const sorted = [...priceData].sort((a, b) => b.date.localeCompare(a.date));
    return { date: sorted[0].date, price: sorted[0].close };
  }, [priceData]);

  const lastSyncTime = useMemo(() => {
    if (!addressSyncState || addressSyncState.length === 0) return null;
    return Math.max(...addressSyncState.map(s => s.lastSyncedAt));
  }, [addressSyncState]);

  // Get price for a specific timestamp
  const getPriceForTimestamp = useCallback((timestamp: number): number | undefined => {
    const date = format(new Date(timestamp * 1000), 'yyyy-MM-dd');
    return priceByDate.get(date);
  }, [priceByDate]);

  // Check what percentage of inputs have outpoint data (prevTxid/prevVout) for exact UTXO matching
  const outpointDataStatus = useMemo(() => {
    if (!participants) return { hasData: false, percentage: 0, total: 0, withData: 0 };
    const inputs = participants.filter(p => p.role === 'input');
    if (inputs.length === 0) return { hasData: true, percentage: 100, total: 0, withData: 0 };
    
    // Count inputs with prevTxid populated (excludes coinbase which legitimately have none)
    const inputsWithOutpoint = inputs.filter(i => i.prevTxid !== undefined && i.prevTxid !== null);
    const percentage = Math.round((inputsWithOutpoint.length / inputs.length) * 100);
    
    return {
      hasData: percentage > 0,
      percentage,
      total: inputs.length,
      withData: inputsWithOutpoint.length
    };
  }, [participants]);

  // For backward compatibility
  const hasOutpointData = outpointDataStatus.hasData && outpointDataStatus.percentage >= 50;

  // HEURISTIC UTXO calculation (uses address:amount matching - may be approximate)
  const utxosHeuristic = useMemo(() => {
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
      
      // Only include UTXOs for addresses we have records for (non-discovered)
      if (!record) continue;
      
      const priceAtReceipt = getPriceForTimestamp(blockTime);
      const btcAmount = output.amount / 100_000_000;
      const valueAtReceipt = priceAtReceipt !== undefined ? btcAmount * priceAtReceipt : undefined;
      
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
        valueAtReceipt,
        priceAtReceipt
      });
    }

    return result;
  }, [participants, transactions, txidToTx, addressToRecord, selectedDate, getPriceForTimestamp]);

  // EXACT UTXO calculation (uses prevTxid:prevVout outpoint matching - 100% accurate)
  const utxosExact = useMemo(() => {
    if (!participants || !transactions) return [];

    const cutoffTime = selectedDate 
      ? Math.floor(selectedDate.getTime() / 1000) + 86400
      : Infinity;

    const outputs = participants.filter(p => p.role === 'output');
    const inputs = participants.filter(p => p.role === 'input');

    // Build a set of spent outpoints (prevTxid:prevVout) from inputs within the cutoff time
    const spentOutpoints = new Set<string>();
    inputs.forEach(input => {
      if (input.prevTxid !== undefined && input.prevVout !== undefined) {
        const tx = txidToTx.get(input.txid);
        const inputBlockTime = tx?.blockTime ?? 0;
        // Only count as spent if the spending tx is within cutoff
        if (inputBlockTime > 0 && inputBlockTime <= cutoffTime) {
          const outpoint = `${input.prevTxid}:${input.prevVout}`;
          spentOutpoints.add(outpoint);
        }
      }
    });

    const result: UTXO[] = [];

    for (const output of outputs) {
      const tx = txidToTx.get(output.txid);
      const blockTime = tx?.blockTime ?? 0;
      const blockHeight = tx?.blockHeight ?? 0;

      // Skip if output is not confirmed or after cutoff
      if (blockTime <= 0 || blockTime > cutoffTime) continue;

      // Check if this output has been spent (its outpoint appears in spentOutpoints)
      const outpoint = `${output.txid}:${output.vout ?? 0}`;
      if (spentOutpoints.has(outpoint)) continue;

      const record = addressToRecord.get(output.address);
      
      // Only include UTXOs for addresses we have records for (non-discovered)
      if (!record) continue;
      
      const priceAtReceipt = getPriceForTimestamp(blockTime);
      const btcAmount = output.amount / 100_000_000;
      const valueAtReceipt = priceAtReceipt !== undefined ? btcAmount * priceAtReceipt : undefined;
      
      result.push({
        id: outpoint,
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
        valueAtReceipt,
        priceAtReceipt
      });
    }

    return result;
  }, [participants, transactions, txidToTx, addressToRecord, selectedDate, getPriceForTimestamp]);

  // Select which UTXO calculation to use based on mode
  const utxos = useMemo(() => {
    return utxoMode === 'exact' ? utxosExact : utxosHeuristic;
  }, [utxoMode, utxosExact, utxosHeuristic]);

  // Group UTXOs by address
  const addressGroups = useMemo(() => {
    const groups = new Map<string, AddressGroup>();
    
    utxos.forEach(utxo => {
      const existing = groups.get(utxo.address);
      
      if (existing) {
        existing.totalSats += utxo.amountSats;
        existing.utxos.push(utxo);
        existing.earliestDate = Math.min(existing.earliestDate, utxo.blockTime);
        existing.latestDate = Math.max(existing.latestDate, utxo.blockTime);
        if (utxo.valueAtReceipt !== undefined) {
          existing.totalValueAtReceipt = (existing.totalValueAtReceipt || 0) + utxo.valueAtReceipt;
        }
      } else {
        groups.set(utxo.address, {
          address: utxo.address,
          totalSats: utxo.amountSats,
          utxos: [utxo],
          earliestDate: utxo.blockTime,
          latestDate: utxo.blockTime,
          recordId: utxo.recordId,
          label: utxo.label,
          owner: utxo.owner,
          walletName: utxo.walletName,
          tags: utxo.tags,
          categories: utxo.categories,
          totalValueAtReceipt: utxo.valueAtReceipt
        });
      }
    });

    // Calculate current values and gains
    const groupsArray = Array.from(groups.values());
    groupsArray.forEach(group => {
      if (latestPrice) {
        const btcAmount = group.totalSats / 100_000_000;
        group.totalCurrentValue = btcAmount * latestPrice.price;
        
        if (group.totalValueAtReceipt !== undefined) {
          group.gain = group.totalCurrentValue - group.totalValueAtReceipt;
          group.gainPercent = group.totalValueAtReceipt > 0 
            ? ((group.totalCurrentValue - group.totalValueAtReceipt) / group.totalValueAtReceipt) * 100
            : undefined;
        }
      }
    });

    return groupsArray;
  }, [utxos, latestPrice]);

  const filteredGroups = useMemo(() => {
    let filtered = addressGroups;

    // Apply smart filtering: only show user-curated addresses by default
    if (!includeBlockchainDiscovered) {
      filtered = filtered.filter(g => userCuratedAddresses.has(g.address));
    }

    // Apply date and amount filters from TransactionSearchFilters
    if (hasActiveSearchFilters(searchFilters)) {
      filtered = filtered.filter(group => {
        // Filter by checking if any UTXO in the group matches the criteria
        const matchingUtxos = filterByDateAndAmount(
          group.utxos,
          searchFilters,
          (u) => u.blockTime,
          (u) => u.amountSats
        );
        return matchingUtxos.length > 0;
      });
    }

    if (ownerFilter !== "all") {
      if (ownerFilter === "unassigned") {
        filtered = filtered.filter(g => !g.owner);
      } else {
        filtered = filtered.filter(g => g.owner === ownerFilter);
      }
    }

    if (walletFilter !== "all") {
      if (walletFilter === "unassigned") {
        filtered = filtered.filter(g => !g.walletName);
      } else {
        filtered = filtered.filter(g => g.walletName === walletFilter);
      }
    }

    if (tagFilter !== "all") {
      if (tagFilter === "unassigned") {
        filtered = filtered.filter(g => !g.tags || g.tags.length === 0);
      } else {
        filtered = filtered.filter(g => g.tags?.includes(tagFilter));
      }
    }

    if (categoryFilter !== "all") {
      if (categoryFilter === "unassigned") {
        filtered = filtered.filter(g => !g.categories || g.categories.length === 0);
      } else {
        filtered = filtered.filter(g => g.categories?.includes(categoryFilter));
      }
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      filtered = filtered.filter(g =>
        g.address.toLowerCase().includes(q) ||
        g.label?.toLowerCase().includes(q) ||
        g.owner?.toLowerCase().includes(q) ||
        g.walletName?.toLowerCase().includes(q) ||
        g.tags?.some(t => t.toLowerCase().includes(q)) ||
        g.categories?.some(c => c.toLowerCase().includes(q)) ||
        g.utxos.some(u => u.txid.toLowerCase().includes(q))
      );
    }

    return filtered;
  }, [addressGroups, ownerFilter, walletFilter, tagFilter, categoryFilter, search, searchFilters, includeBlockchainDiscovered, userCuratedAddresses]);

  const sortedGroups = useMemo(() => {
    const sorted = [...filteredGroups];
    
    sorted.sort((a, b) => {
      let cmp = 0;
      switch (sortColumn) {
        case "amount":
          cmp = a.totalSats - b.totalSats;
          break;
        case "date":
          cmp = a.latestDate - b.latestDate;
          break;
        case "address":
          cmp = a.address.localeCompare(b.address);
          break;
        case "gain":
          const gainA = a.gain ?? 0;
          const gainB = b.gain ?? 0;
          cmp = gainA - gainB;
          break;
      }
      return sortDirection === "asc" ? cmp : -cmp;
    });

    return sorted;
  }, [filteredGroups, sortColumn, sortDirection]);

  const totalPages = Math.max(1, Math.ceil(sortedGroups.length / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);
  const paginatedGroups = sortedGroups.slice(
    (safePage - 1) * ITEMS_PER_PAGE,
    safePage * ITEMS_PER_PAGE
  );

  const totalSats = filteredGroups.reduce((sum, g) => sum + g.totalSats, 0);
  const totalUtxoCount = filteredGroups.reduce((sum, g) => sum + g.utxos.length, 0);
  const totalAddressCount = filteredGroups.length;
  const totalValueAtReceipt = filteredGroups.reduce((sum, g) => sum + (g.totalValueAtReceipt || 0), 0);
  const totalCurrentValue = filteredGroups.reduce((sum, g) => sum + (g.totalCurrentValue || 0), 0);
  const totalGain = totalCurrentValue - totalValueAtReceipt;

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
    setSearchFilters(defaultFilters);
  };

  const hasActiveFilters = search || ownerFilter !== "all" || walletFilter !== "all" || tagFilter !== "all" || categoryFilter !== "all" || selectedDate || hasActiveSearchFilters(searchFilters);

  const isLoading = !transactions || !participants;

  useEffect(() => {
    setCurrentPage(1);
  }, [search, ownerFilter, walletFilter, tagFilter, categoryFilter, selectedDate, searchFilters]);

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

  const copyTxid = async (txid: string) => {
    try {
      await navigator.clipboard.writeText(txid);
      setCopiedTxid(txid);
      setTimeout(() => setCopiedTxid(null), 2000);
    } catch {
      // Ignore clipboard errors
    }
  };

  const openUtxoDetail = (utxo: UTXO) => {
    setSelectedUtxo(utxo);
    setDetailPanelOpen(true);
  };

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
    <div className="flex flex-col p-4 gap-4 overflow-y-auto">
      <div className="flex-none flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="text-page-title">
            <Coins className="h-6 w-6" />
            UTXOs
          </h1>
          <p className="text-muted-foreground mt-1">
            View unspent transaction outputs grouped by address
          </p>
        </div>
        <BlockchainToggle
          checked={includeBlockchainDiscovered}
          onCheckedChange={(checked) => {
            setIncludeBlockchainDiscovered(checked);
            setCurrentPage(1);
          }}
          hiddenCount={blockchainDiscoveredCount ?? 0}
        />
      </div>

      {decryptProgress && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground px-4 py-2">
          <RefreshCw className="h-4 w-4 animate-spin" />
          <span>
            Decrypting records {decryptProgress.current.toLocaleString()}/{decryptProgress.total.toLocaleString()}
            {decryptProgress.cached > 0 && ` (${decryptProgress.cached.toLocaleString()} cached)`}...
          </span>
        </div>
      )}

      <div className="flex items-center gap-2 text-sm text-muted-foreground flex-none flex-wrap">
        <AlertCircle className="h-4 w-4" />
        <span>
          Data based on last transaction sync
          {lastSyncTime && (
            <span className="ml-1">
              ({format(new Date(lastSyncTime), "MMM d, yyyy 'at' h:mm a")})
            </span>
          )}
          {utxoMode === 'heuristic' && (
            <>
              <span className="mx-2">|</span>
              <span className="text-amber-600 dark:text-amber-400">
                Standard mode uses heuristics; balances may be approximate
              </span>
            </>
          )}
          {utxoMode === 'exact' && outpointDataStatus.percentage === 0 && (
            <>
              <span className="mx-2">|</span>
              <span className="text-amber-600 dark:text-amber-400">
                Exact mode requires re-sync to populate outpoint data
              </span>
            </>
          )}
          {utxoMode === 'exact' && outpointDataStatus.percentage > 0 && outpointDataStatus.percentage < 100 && (
            <>
              <span className="mx-2">|</span>
              <span className="text-amber-600 dark:text-amber-400">
                Exact mode: {outpointDataStatus.percentage}% of inputs have outpoint data (re-sync for full accuracy)
              </span>
            </>
          )}
          {utxoMode === 'exact' && outpointDataStatus.percentage === 100 && (
            <>
              <span className="mx-2">|</span>
              <span className="text-green-600 dark:text-green-400">
                Exact mode: using outpoint-based UTXO matching
              </span>
            </>
          )}
        </span>
        <Link href="/transaction-sync">
          <Button variant="ghost" size="sm" className="h-auto p-0 text-primary hover:underline" data-testid="link-sync">
            <RefreshCw className="h-3 w-3 mr-1" />
            Sync now
          </Button>
        </Link>
        {latestPrice ? (
          <span className="ml-4 text-xs">
            Price data as of {format(new Date(latestPrice.date), "MMM d, yyyy")}
          </span>
        ) : (
          <span className="ml-4 text-xs text-amber-600 dark:text-amber-400">
            No price data -
            <Link href="/settings/price-import" className="ml-1 text-primary hover:underline" data-testid="link-import-prices">
              Import price history
            </Link>
          </span>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 flex-none">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Addresses / UTXOs</CardDescription>
            <CardTitle className="text-2xl" data-testid="text-utxo-count">
              {totalAddressCount.toLocaleString()} / {totalUtxoCount.toLocaleString()}
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
                {displayUnit === "btc" ? "sats" : "BTC"}
              </Button>
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Cost Basis</CardDescription>
            <CardTitle className="text-xl" data-testid="text-cost-basis">
              {totalValueAtReceipt > 0 ? formatUsdValue(totalValueAtReceipt) : "-"}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Unrealized Gain/Loss</CardDescription>
            <CardTitle className={cn(
              "text-xl flex items-center gap-1",
              totalGain > 0 ? "text-green-600 dark:text-green-400" : totalGain < 0 ? "text-red-600 dark:text-red-400" : ""
            )} data-testid="text-total-gain">
              {totalGain > 0 ? <TrendingUp className="h-4 w-4" /> : totalGain < 0 ? <TrendingDown className="h-4 w-4" /> : null}
              {totalValueAtReceipt > 0 ? formatUsdValue(totalGain) : "-"}
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
            
            <TransactionSearchFilters
              filters={searchFilters}
              onChange={(filters) => {
                setSearchFilters(filters);
                setCurrentPage(1);
              }}
              onClear={() => {
                setSearchFilters(defaultFilters);
                setCurrentPage(1);
              }}
            />

            <div className="w-[180px]">
              <Label className="sr-only">Owner</Label>
              <Select value={ownerFilter} onValueChange={setOwnerFilter}>
                <SelectTrigger data-testid="select-owner">
                  <SelectValue placeholder="All Owners" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Owners</SelectItem>
                  <SelectItem value="unassigned">Unassigned</SelectItem>
                  {owners.map(owner => (
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
                  {walletNames.map(wallet => (
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
                  {tags.map(tag => (
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
                  {categories.map(cat => (
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

            <div className="flex items-center gap-1">
              <div className="w-[160px]">
                <Label className="sr-only">Calculation Mode</Label>
                <Select value={utxoMode} onValueChange={(v) => setUtxoMode(v as UTXOCalculationMode)}>
                  <SelectTrigger data-testid="select-utxo-mode">
                    <SelectValue placeholder="Mode" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="heuristic">Standard</SelectItem>
                    <SelectItem value="exact">Exact (Beta)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8" data-testid="button-mode-help">
                    <HelpCircle className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-80" align="start">
                  <div className="space-y-3">
                    <h4 className="font-medium">UTXO Calculation Modes</h4>
                    <div className="space-y-2 text-sm">
                      <div>
                        <span className="font-medium">Standard Mode:</span>
                        <p className="text-muted-foreground">
                          Uses address + amount matching to identify spent UTXOs. Fast and works with any data, but may be approximate when the same address receives identical amounts multiple times.
                        </p>
                      </div>
                      <div>
                        <span className="font-medium">Exact Mode (Beta):</span>
                        <p className="text-muted-foreground">
                          Uses outpoint data (txid:vout) for 100% accurate UTXO identification. Requires transaction sync data with outpoint information. Shows exact which specific UTXO was spent in each transaction.
                        </p>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground border-t pt-2">
                      Tip: If Exact mode shows 0% data coverage, re-sync your transactions to fetch outpoint data.
                    </p>
                  </div>
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

      <div>
        <Card className="flex flex-col">
          <CardHeader className="pb-2 flex-none">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">
                {filteredGroups.length === addressGroups.length 
                  ? `${totalAddressCount} addresses (${totalUtxoCount} UTXOs)` 
                  : `${filteredGroups.length} of ${addressGroups.length} addresses`}
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
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex items-center justify-center h-32">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
              </div>
            ) : paginatedGroups.length === 0 ? (
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
                    <TableHead className="w-8"></TableHead>
                    <SortableHeader column="address" label="Address" />
                    <SortableHeader column="amount" label="UTXO Value" />
                    <SortableHeader column="date" label="Date" />
                    <TableHead>Value at Receipt</TableHead>
                    <TableHead>Current Value</TableHead>
                    <SortableHeader column="gain" label="Gain/Loss" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginatedGroups.flatMap((group) => {
                    const isExpanded = expandedAddresses.has(group.address);
                    const rows = [
                      <TableRow 
                        key={`group-${group.address}`} 
                        className="cursor-pointer hover-elevate" 
                        onClick={() => toggleExpanded(group.address)}
                        data-testid={`row-address-${group.address.slice(0, 8)}`}
                      >
                        <TableCell className="w-8">
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRightIcon className="h-4 w-4" />
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            <ClickableAddress 
                              address={group.address} 
                              className="text-sm"
                            />
                            {group.label && (
                              <span className="text-xs text-muted-foreground">{group.label}</span>
                            )}
                            {group.utxos.length > 1 && (
                              <Badge variant="secondary" className="w-fit text-xs">
                                {group.utxos.length} UTXOs
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="font-mono">
                          {displayUnit === "btc" ? (
                            <span>{satsToBtc(group.totalSats)} BTC</span>
                          ) : (
                            <span>{group.totalSats.toLocaleString()} sats</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">
                          <div className="flex flex-col">
                            <span>{format(new Date(group.latestDate * 1000), "MMM d, yyyy")}</span>
                            {group.earliestDate !== group.latestDate && (
                              <span className="text-xs text-muted-foreground">
                                From {format(new Date(group.earliestDate * 1000), "MMM d, yyyy")}
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          {formatUsdValue(group.totalValueAtReceipt)}
                        </TableCell>
                        <TableCell>
                          {formatUsdValue(group.totalCurrentValue)}
                        </TableCell>
                        <TableCell>
                          {group.gain !== undefined ? (
                            <div className={cn(
                              "flex items-center gap-1",
                              group.gain > 0 ? "text-green-600 dark:text-green-400" : group.gain < 0 ? "text-red-600 dark:text-red-400" : ""
                            )}>
                              {group.gain > 0 ? <TrendingUp className="h-3 w-3" /> : group.gain < 0 ? <TrendingDown className="h-3 w-3" /> : null}
                              <span>{formatUsdValue(group.gain)}</span>
                              {group.gainPercent !== undefined && (
                                <span className="text-xs">({group.gainPercent > 0 ? '+' : ''}{group.gainPercent.toFixed(1)}%)</span>
                              )}
                            </div>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ];

                    if (isExpanded) {
                      group.utxos.forEach((utxo, idx) => {
                        rows.push(
                          <TableRow 
                            key={`utxo-${utxo.id}`} 
                            className="bg-muted/30 cursor-pointer hover-elevate" 
                            onClick={() => openUtxoDetail(utxo)}
                            data-testid={`row-utxo-${utxo.id}`}
                          >
                            <TableCell></TableCell>
                            <TableCell colSpan={2} className="font-mono text-sm">
                              <div className="flex items-center gap-2 pl-4">
                                <span className="text-muted-foreground text-xs">{idx + 1}.</span>
                                <span title={utxo.txid}>{truncateTxid(utxo.txid)}:{utxo.vout}</span>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    copyTxid(utxo.txid);
                                  }}
                                  data-testid={`button-copy-${utxo.txid.slice(0, 8)}`}
                                >
                                  {copiedTxid === utxo.txid ? (
                                    <Check className="h-3 w-3 text-green-500" />
                                  ) : (
                                    <Copy className="h-3 w-3" />
                                  )}
                                </Button>
                                <a
                                  href={`https://mempool.space/tx/${utxo.txid}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-muted-foreground hover:text-primary"
                                  onClick={(e) => e.stopPropagation()}
                                  data-testid={`link-external-${utxo.txid.slice(0, 8)}`}
                                >
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                                <span className="ml-2">
                                  {displayUnit === "btc" ? (
                                    <span>{satsToBtc(utxo.amountSats)} BTC</span>
                                  ) : (
                                    <span>{utxo.amountSats.toLocaleString()} sats</span>
                                  )}
                                </span>
                              </div>
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {format(new Date(utxo.blockTime * 1000), "MMM d, yyyy")}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {formatUsdValue(utxo.valueAtReceipt)}
                            </TableCell>
                            <TableCell></TableCell>
                            <TableCell></TableCell>
                          </TableRow>
                        );
                      });
                    }

                    return rows;
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <UTXODetailPanel
        open={detailPanelOpen}
        onClose={() => setDetailPanelOpen(false)}
        utxo={selectedUtxo}
        latestPrice={latestPrice}
      />
    </div>
  );
}

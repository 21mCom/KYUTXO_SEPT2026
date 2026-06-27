import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useToast } from "@/hooks/use-toast";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { PAGE_DEBOUNCE } from "@/config/debounce";
import { useAsyncMemo, yieldToUI, checkAbort } from "@/hooks/use-async-memo";
import { useDbChangeSignal } from "@/hooks/use-db-change-signal";
import { useAddressRecords } from "@/hooks/use-address-records";
import { useLiveQuery } from "dexie-react-hooks";
import { format } from "date-fns";
import { Link } from "wouter";
import { BlockchainTransaction, TransactionParticipant, Record as DbRecord, PriceData, USER_CURATED_TIERS } from "@/lib/database";
import { getAllAddressSyncState } from "@/lib/data/address-sync-crud";
import { getPriceDataByAsset } from "@/lib/data/price-data-crud";
import { countRecordsByTypeAndImportanceTiers, getTransactionsByTxids } from "@/lib/dataFacade";
import {
  engineGetOwnedUtxos,
  engineCountOwnedUtxos,
  engineGetHeuristicOwnedUtxos,
  engineCountHeuristicOwnedUtxos,
} from "@/lib/engine/engine-client";
import { evaluateEngineFreshness } from "@/lib/engine/engine-freshness";
import type { OwnedUtxo } from "@/lib/engine/engine-core";
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
  AlertCircle,
  X,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronRight,
  ChevronDown,
  ChevronRight as ChevronRightIcon,
  Copy,
  Check,
  TrendingUp,
  TrendingDown,
  HelpCircle,
  Loader2
} from "lucide-react";
import { SiBitcoin } from "react-icons/si";
import { getOwners, getWalletNames, getTags, getCategories, getParticipantsByAddresses } from "@/lib/dataFacade";
import { cn } from "@/lib/utils";
import { UTXODetailPanel } from "@/components/UTXODetailPanel";
import { AddressLink } from "@/components/AddressLink";
import { TxidLink } from "@/components/TxidLink";
import { ScrollPositionIndicator } from "@/components/ScrollPositionIndicator";
import { searchPendingClass } from "@/lib/search-pending-class";

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

export function CopyTxidButton({ txid }: { txid: string }) {
  const { copy, isCopied } = useCopyToClipboard();
  const copied = isCopied(txid);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    copy(txid, { label: "Transaction ID" });
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-6 w-6"
      onClick={handleCopy}
      data-testid={`button-copy-${txid.slice(0, 8)}`}
    >
      {copied ? (
        <Check className="h-3 w-3 text-green-500" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </Button>
  );
}

export default function UTXOs() {
  const { toast } = useToast();
  const initialSettings = useMemo(() => loadSettings(), []);
  
  const [search, setSearch] = useState("");
  const [debouncedSearch, isSearchPending] = useDebouncedValue(search, PAGE_DEBOUNCE.UTXOs);
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined);
  const [searchFilters, setSearchFilters] = useState<SearchFilters>(defaultFilters);
  const [ownerFilter, setOwnerFilter] = useState<string>(initialSettings.ownerFilter);
  const [walletFilter, setWalletFilter] = useState<string>(initialSettings.walletFilter);
  const [tagFilter, setTagFilter] = useState<string>(initialSettings.tagFilter);
  const [categoryFilter, setCategoryFilter] = useState<string>(initialSettings.categoryFilter);
  const [sortColumn, setSortColumn] = useState<SortColumn>(initialSettings.sortColumn);
  const [sortDirection, setSortDirection] = useState<SortDirection>(initialSettings.sortDirection);
  const [utxoMode, setUtxoMode] = useState<UTXOCalculationMode>(initialSettings.utxoMode);
  const [displayUnit, setDisplayUnit] = useState<"btc" | "sats">(initialSettings.displayUnit);
  const [expandedAddresses, setExpandedAddresses] = useState<Set<string>>(new Set());
  const [selectedUtxo, setSelectedUtxo] = useState<UTXO | null>(null);
  const [detailPanelOpen, setDetailPanelOpen] = useState(false);
  
  // Smart filtering: exclude blockchain-discovered addresses by default
  const [includeBlockchainDiscovered, setIncludeBlockchainDiscovered] = useState(false);

  // Save settings when they change
  useEffect(() => {
    saveSettings({ displayUnit, sortColumn, sortDirection, ownerFilter, walletFilter, tagFilter, categoryFilter, utxoMode });
  }, [displayUnit, sortColumn, sortDirection, ownerFilter, walletFilter, tagFilter, categoryFilter, utxoMode]);

  const txDbSignal = useDbChangeSignal(['blockchainTransactions', 'transactionParticipants']);

  const [transactions, setTransactions] = useState<BlockchainTransaction[] | undefined>(undefined);
  const transactionsRequestId = useRef(0);

  const [participants, setParticipants] = useState<TransactionParticipant[] | undefined>(undefined);
  const [participantsLoading, setParticipantsLoading] = useState(false);
  const participantsRequestId = useRef(0);

  // Native SQLite read-engine integration (mirrors the Records screen). When the
  // engine is READY and its mirror is fresh, the owned-UTXO set is read straight
  // from SQLite instead of computing it in-browser from every participant. The
  // engine only computes the EXACT prevout anti-join for user-curated tiers, so
  // the fast path is limited to exact mode with the blockchain-discovered toggle
  // off and no historical "as of" date cutoff; anything else falls back to Dexie.
  type EngineDecision = 'pending' | 'engine' | 'dexie';
  const [engineDecision, setEngineDecision] = useState<EngineDecision>('pending');
  const [engineRawUtxos, setEngineRawUtxos] = useState<
    (OwnedUtxo & { blockTime: number; blockHeight: number })[] | null
  >(null);
  const [engineUtxosLoading, setEngineUtxosLoading] = useState(false);
  const engineLoadRequestId = useRef(0);
  // Re-evaluate engine freshness whenever the mirrored source tables change.
  const recordsDbSignal = useDbChangeSignal(['records']);

  const { records: rawRecords } = useAddressRecords({ includeBlockchainDiscovered });
  
  // Count blockchain-discovered records using compound index
  const blockchainDiscoveredCount = useLiveQuery(
    async () => {
      return countRecordsByTypeAndImportanceTiers('address', ['blockchain-discovered', 'pending-review']);
    },
    []
  );

  const addressSyncState = useLiveQuery(
    () => getAllAddressSyncState(),
    []
  );

  // Load price data for value calculations
  const priceData = useLiveQuery(
    () => getPriceDataByAsset('BTC', 'USD'),
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
        const [allOwners, allWalletNames, allTags, allCategories] = await Promise.all([
          getOwners(),
          getWalletNames(),
          getTags(),
          getCategories()
        ]);
        setOwners(allOwners.map(o => o.name).filter(Boolean).sort());
        setWalletNames(allWalletNames.map(w => w.name).filter(Boolean).sort());
        setTags(allTags.map(t => t.name).filter(Boolean).sort());
        setCategories(allCategories.map(c => c.name).filter(Boolean).sort());
        setVocabLoaded(true);
      } catch (error) {
        console.error('Failed to load vocabulary:', error);
      }
    };
    loadVocabulary();
  }, []);

  const processedRecords = rawRecords ?? [];

  useEffect(() => {
    // While the engine decision is still resolving, hold off on the expensive
    // Dexie participant load so we never do it just to throw it away.
    if (engineDecision === 'pending') {
      return;
    }

    // Engine fast path: the owned-UTXO set comes from SQLite, so there is no
    // need to stream every participant into the browser. Clear the Dexie-derived
    // state so the in-browser computations short-circuit to empty.
    if (engineDecision === 'engine') {
      participantsRequestId.current += 1;
      setParticipants([]);
      setParticipantsLoading(false);
      return;
    }

    if (!processedRecords || processedRecords.length === 0) {
      setParticipants(undefined);
      return;
    }

    const addresses = processedRecords
      .filter(r => r.type === 'address' && r.inputString)
      .map(r => r.inputString!);

    if (addresses.length === 0) {
      setParticipants([]);
      return;
    }

    participantsRequestId.current += 1;
    const thisRequestId = participantsRequestId.current;
    const abortController = new AbortController();
    setParticipantsLoading(true);

    getParticipantsByAddresses(addresses, abortController.signal)
      .then(result => {
        if (thisRequestId === participantsRequestId.current) {
          setParticipants(result);
          setParticipantsLoading(false);
        }
      })
      .catch((e) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        if (thisRequestId === participantsRequestId.current) {
          setParticipants([]);
          setParticipantsLoading(false);
        }
      });
    return () => { abortController.abort(); };
  }, [processedRecords, engineDecision]);

  useEffect(() => {
    if (!participants || participants.length === 0) {
      setTransactions(participants === undefined ? undefined : []);
      return;
    }

    const txids = new Set<string>();
    for (const p of participants) txids.add(p.txid);

    if (txids.size === 0) {
      setTransactions([]);
      return;
    }

    transactionsRequestId.current += 1;
    const thisRequestId = transactionsRequestId.current;

    const txidArray = Array.from(txids);
    const batchSize = 500;
    const loadBatched = async () => {
      const results: BlockchainTransaction[] = [];
      for (let i = 0; i < txidArray.length; i += batchSize) {
        const batch = txidArray.slice(i, i + batchSize);
        const txs = await getTransactionsByTxids(batch);
        results.push(...txs);
        if (i + batchSize < txidArray.length) {
          await new Promise(r => setTimeout(r, 0));
        }
      }
      return results;
    };

    loadBatched()
      .then(result => {
        if (thisRequestId === transactionsRequestId.current) {
          setTransactions(result);
        }
      })
      .catch(() => {
        if (thisRequestId === transactionsRequestId.current) {
          setTransactions([]);
        }
      });
  }, [participants, txDbSignal]);

  const addressToRecord = useMemo(() => {
    const map = new Map<string, DbRecord>();
    processedRecords.forEach(record => {
      if (record.type === 'address' && record.inputString) {
        map.set(record.inputString, record);
      }
    });
    return map;
  }, [processedRecords]);

  // Build set of user-curated addresses (for filtering UTXOs)
  const userCuratedAddresses = useMemo(() => {
    const set = new Set<string>();
    processedRecords.forEach(record => {
      if (record.type === 'address' && record.inputString) {
        const importance = record.addressImportance;
        // Include if no importance set (legacy) or if user-curated tier
        if (!importance || USER_CURATED_TIERS.includes(importance)) {
          set.add(record.inputString);
        }
      }
    });
    return set;
  }, [processedRecords]);

  // Count blockchain-discovered addresses that have UTXOs
  const blockchainDiscoveredWithUtxos = useMemo(() => {
    const set = new Set<string>();
    processedRecords.forEach(record => {
      if (record.type === 'address' && record.inputString) {
        const importance = record.addressImportance;
        // Only count blockchain-discovered and pending-review tiers
        if (importance && !USER_CURATED_TIERS.includes(importance)) {
          set.add(record.inputString);
        }
      }
    });
    return set;
  }, [processedRecords]);

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

  // The engine serves the owned-UTXO set straight from SQLite for BOTH modes:
  // exact (prevout anti-join) and heuristic (no-prevout amount-matching). Each
  // mode covers all three views — the default user-curated set (fast path off a
  // materialized table), the "include blockchain-discovered" view (the tier set
  // is widened), and an "as of" date view (a block-time cutoff). The mode picks
  // which engine query to run; anything that fails the freshness gate falls back
  // to the in-browser Dexie computation for that mode.
  const engineEligible = utxoMode === 'exact' || utxoMode === 'heuristic';

  // When the blockchain-discovered toggle is on, widen the owned-tier set so the
  // engine includes those addresses; otherwise pass undefined to use the default
  // user-curated tiers (which can hit the materialized fast path).
  const engineTiers = useMemo<string[] | undefined>(
    () =>
      includeBlockchainDiscovered
        ? [...USER_CURATED_TIERS, 'blockchain-discovered', 'pending-review']
        : undefined,
    [includeBlockchainDiscovered],
  );

  // Historical "as of" cutoff in unix seconds. Matches the in-browser exact
  // computation: end-of-selected-day (start-of-day + 86400) so the chosen date
  // is inclusive. Undefined means "current" (no cutoff).
  const engineAsOfBlockTime = useMemo<number | undefined>(
    () =>
      selectedDate
        ? Math.floor(selectedDate.getTime() / 1000) + 86400
        : undefined,
    [selectedDate],
  );

  // Decide whether to read from the engine. The owned-UTXO read depends on all
  // three mirror tables (records for ownership, blockchainTransactions for the
  // blockTime JOIN, and transactionParticipants for the spend anti-join), so the
  // shared gate is asked for the 'allMirrors' scope — checking only records would
  // serve stale UTXOs whenever a sync or prevout backfill changes the tx/
  // participant tables without touching records. Any mismatch or error falls back
  // to the in-browser Dexie computation.
  useEffect(() => {
    let cancelled = false;
    if (!engineEligible) {
      setEngineDecision('dexie');
      return;
    }
    setEngineDecision('pending');
    (async () => {
      const decision = await evaluateEngineFreshness('allMirrors');
      if (cancelled) return;
      setEngineDecision(decision.useEngine ? 'engine' : 'dexie');
    })();
    return () => {
      cancelled = true;
    };
  }, [engineEligible, recordsDbSignal, txDbSignal]);

  // Load the owned-UTXO set from the engine when the fast path is active. Owned
  // UTXOs are paged by integer primary key (keyset), then enriched with the block
  // time/height of their txid so the rest of the page (dates, value-at-receipt)
  // works exactly as it does for the Dexie path. Record metadata and price are
  // layered on in a cheap memo below so they never trigger a re-fetch.
  useEffect(() => {
    if (engineDecision !== 'engine') {
      setEngineRawUtxos(null);
      setEngineUtxosLoading(false);
      return;
    }
    engineLoadRequestId.current += 1;
    const requestId = engineLoadRequestId.current;
    let cancelled = false;
    setEngineUtxosLoading(true);
    // Pick the engine query for the active mode. The heuristic estimates the
    // unspent set by FIFO amount-matching (no prevouts); exact uses the prevout
    // anti-join. Both share the same tier/as-of/keyset contract.
    const countFn =
      utxoMode === 'heuristic' ? engineCountHeuristicOwnedUtxos : engineCountOwnedUtxos;
    const getFn =
      utxoMode === 'heuristic' ? engineGetHeuristicOwnedUtxos : engineGetOwnedUtxos;
    (async () => {
      try {
        const total = await countFn({
          tiers: engineTiers,
          asOfBlockTime: engineAsOfBlockTime,
        });
        if (cancelled || requestId !== engineLoadRequestId.current) return;
        if (total === 0) {
          setEngineRawUtxos([]);
          setEngineUtxosLoading(false);
          return;
        }

        const owned: OwnedUtxo[] = [];
        const PAGE = 10000;
        let afterId: number | undefined = undefined;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const batch = await getFn({
            tiers: engineTiers,
            asOfBlockTime: engineAsOfBlockTime,
            afterId,
            limit: PAGE,
          });
          if (cancelled || requestId !== engineLoadRequestId.current) return;
          owned.push(...batch);
          if (batch.length < PAGE) break;
          afterId = batch[batch.length - 1].id;
          await yieldToUI();
        }

        // Resolve block time/height for every txid in the owned set.
        const txids = Array.from(new Set(owned.map((u) => u.txid)));
        const txMap = new Map<string, BlockchainTransaction>();
        const BATCH = 500;
        for (let i = 0; i < txids.length; i += BATCH) {
          const slice = txids.slice(i, i + BATCH);
          const txs = await getTransactionsByTxids(slice);
          if (cancelled || requestId !== engineLoadRequestId.current) return;
          for (const tx of txs) txMap.set(tx.txid, tx);
          if (i + BATCH < txids.length) await yieldToUI();
        }

        // Match the Dexie exact path exactly: outputs whose tx has no confirmed
        // block time (blockTime <= 0) are excluded there, so drop them here too.
        // The engine's own anti-join already filters blockTime > 0 (and, for an
        // "as of" read, <= cutoff) against the mirror, but block time is re-read
        // from live Dexie above, so we re-apply the same bounds on that
        // authoritative value to stay self-consistent with the date view.
        const cutoff = engineAsOfBlockTime;
        const enriched = owned
          .map((u) => {
            const tx = txMap.get(u.txid);
            return {
              ...u,
              blockTime: tx?.blockTime ?? 0,
              blockHeight: tx?.blockHeight ?? 0,
            };
          })
          .filter((u) => u.blockTime > 0 && (cutoff == null || u.blockTime <= cutoff));
        if (cancelled || requestId !== engineLoadRequestId.current) return;
        setEngineRawUtxos(enriched);
        setEngineUtxosLoading(false);
      } catch {
        if (cancelled || requestId !== engineLoadRequestId.current) return;
        // On any engine failure, drop back to the Dexie computation.
        setEngineRawUtxos(null);
        setEngineUtxosLoading(false);
        setEngineDecision('dexie');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [engineDecision, txDbSignal, engineTiers, engineAsOfBlockTime, utxoMode]);

  // Enrich the engine's owned UTXOs with record metadata and price-at-receipt.
  // Kept separate from the fetch so changing price data or record labels does not
  // re-run the engine query — only this cheap map re-runs.
  const engineUtxos = useMemo<UTXO[] | null>(() => {
    if (engineRawUtxos === null) return null;
    return engineRawUtxos.map((u) => {
      const record = addressToRecord.get(u.address);
      const priceAtReceipt = getPriceForTimestamp(u.blockTime);
      const btcAmount = u.amount / 100_000_000;
      const valueAtReceipt =
        priceAtReceipt !== undefined ? btcAmount * priceAtReceipt : undefined;
      return {
        id: `${u.txid}:${u.vout ?? 0}`,
        txid: u.txid,
        vout: u.vout ?? 0,
        address: u.address,
        amountSats: u.amount,
        blockTime: u.blockTime,
        blockHeight: u.blockHeight,
        recordId: record?.id ?? u.recordId ?? undefined,
        label: record?.label,
        owner: record?.owner,
        walletName: record?.walletName,
        tags: record?.tags,
        categories: record?.categories,
        valueAtReceipt,
        priceAtReceipt,
      };
    });
  }, [engineRawUtxos, addressToRecord, getPriceForTimestamp]);

  const { value: outpointDataStatus, isComputing: outpointDataStatusComputing } = useAsyncMemo(async (signal) => {
    if (!participants) return { hasData: false, percentage: 0, total: 0, withData: 0 };
    let inputCount = 0;
    let withDataCount = 0;
    for (let i = 0; i < participants.length; i++) {
      const p = participants[i];
      if (p.role === 'input') {
        inputCount++;
        if (p.prevTxid !== undefined && p.prevTxid !== null) {
          withDataCount++;
        }
      }
      if (i % 1000 === 999) {
        checkAbort(signal);
        await yieldToUI();
      }
    }
    if (inputCount === 0) return { hasData: true, percentage: 100, total: 0, withData: 0 };
    const percentage = Math.round((withDataCount / inputCount) * 100);
    return {
      hasData: percentage > 0,
      percentage,
      total: inputCount,
      withData: withDataCount
    };
  }, [participants], { hasData: false, percentage: 0, total: 0, withData: 0 });

  // For backward compatibility
  const hasOutpointData = outpointDataStatus.hasData && outpointDataStatus.percentage >= 50;

  const { value: utxosHeuristic, isComputing: utxosHeuristicComputing } = useAsyncMemo(async (signal) => {
    if (!participants || !transactions) return [];

    const cutoffTime = selectedDate 
      ? Math.floor(selectedDate.getTime() / 1000) + 86400
      : Infinity;

    const outputs: typeof participants = [];
    const inputs: typeof participants = [];
    for (let i = 0; i < participants.length; i++) {
      const p = participants[i];
      if (p.role === 'output') outputs.push(p);
      else if (p.role === 'input') inputs.push(p);
      if (i % 1000 === 999) {
        checkAbort(signal);
        await yieldToUI();
      }
    }

    const outputsWithTime = outputs.map(output => {
      const tx = txidToTx.get(output.txid);
      return { output, blockTime: tx?.blockTime ?? 0, blockHeight: tx?.blockHeight ?? 0 };
    }).filter(o => o.blockTime > 0 && o.blockTime <= cutoffTime);

    outputsWithTime.sort((a, b) => {
      if (a.blockTime !== b.blockTime) return a.blockTime - b.blockTime;
      return (a.output.vout ?? 0) - (b.output.vout ?? 0);
    });

    checkAbort(signal);
    await yieldToUI();

    const inputsWithTime = inputs.map(input => {
      const tx = txidToTx.get(input.txid);
      return { input, blockTime: tx?.blockTime ?? 0 };
    }).filter(i => i.blockTime > 0 && i.blockTime <= cutoffTime);

    inputsWithTime.sort((a, b) => a.blockTime - b.blockTime);

    const inputsByAddressAmount = new Map<string, { input: TransactionParticipant; blockTime: number }[]>();
    for (let i = 0; i < inputsWithTime.length; i++) {
      const item = inputsWithTime[i];
      const key = `${item.input.address}:${item.input.amount}`;
      const existing = inputsByAddressAmount.get(key) || [];
      existing.push(item);
      inputsByAddressAmount.set(key, existing);
      if (i % 1000 === 999) {
        checkAbort(signal);
        await yieldToUI();
      }
    }

    const result: UTXO[] = [];
    const matchedInputIndices = new Map<string, number>();

    for (let i = 0; i < outputsWithTime.length; i++) {
      const { output, blockTime, blockHeight } = outputsWithTime[i];
      const key = `${output.address}:${output.amount}`;
      const matchingInputs = inputsByAddressAmount.get(key) || [];
      
      const currentIndex = matchedInputIndices.get(key) || 0;
      
      const spendingInput = matchingInputs.find((item, idx) => 
        idx >= currentIndex && item.blockTime > blockTime
      );

      if (spendingInput) {
        const spendIdx = matchingInputs.indexOf(spendingInput);
        matchedInputIndices.set(key, spendIdx + 1);
      } else {
        const record = addressToRecord.get(output.address);
        
        if (record) {
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
      }

      if (i % 1000 === 999) {
        checkAbort(signal);
        await yieldToUI();
      }
    }

    return result;
  }, [participants, transactions, txidToTx, addressToRecord, selectedDate, getPriceForTimestamp], [] as UTXO[]);

  const { value: utxosExact, isComputing: utxosExactComputing } = useAsyncMemo(async (signal) => {
    if (!participants || !transactions) return [];

    const cutoffTime = selectedDate 
      ? Math.floor(selectedDate.getTime() / 1000) + 86400
      : Infinity;

    const outputs: typeof participants = [];
    const spentOutpoints = new Set<string>();

    for (let i = 0; i < participants.length; i++) {
      const p = participants[i];
      if (p.role === 'output') {
        outputs.push(p);
      } else if (p.role === 'input') {
        if (p.prevTxid !== undefined && p.prevVout !== undefined) {
          const tx = txidToTx.get(p.txid);
          const inputBlockTime = tx?.blockTime ?? 0;
          if (inputBlockTime > 0 && inputBlockTime <= cutoffTime) {
            spentOutpoints.add(`${p.prevTxid}:${p.prevVout}`);
          }
        }
      }
      if (i % 1000 === 999) {
        checkAbort(signal);
        await yieldToUI();
      }
    }

    const result: UTXO[] = [];

    for (let i = 0; i < outputs.length; i++) {
      const output = outputs[i];
      const tx = txidToTx.get(output.txid);
      const blockTime = tx?.blockTime ?? 0;
      const blockHeight = tx?.blockHeight ?? 0;

      if (blockTime <= 0 || blockTime > cutoffTime) continue;

      const outpoint = `${output.txid}:${output.vout ?? 0}`;
      if (spentOutpoints.has(outpoint)) continue;

      const record = addressToRecord.get(output.address);
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

      if (i % 1000 === 999) {
        checkAbort(signal);
        await yieldToUI();
      }
    }

    return result;
  }, [participants, transactions, txidToTx, addressToRecord, selectedDate, getPriceForTimestamp], [] as UTXO[]);

  // Select which UTXO calculation to use. When the engine fast path is active we
  // use its owned-UTXO set (always exact); otherwise fall back to the in-browser
  // computation for the current mode.
  const utxos = useMemo(() => {
    if (engineDecision === 'engine') return engineUtxos ?? [];
    return utxoMode === 'exact' ? utxosExact : utxosHeuristic;
  }, [engineDecision, engineUtxos, utxoMode, utxosExact, utxosHeuristic]);

  const { value: addressGroups, isComputing: addressGroupsComputing } = useAsyncMemo(async (signal) => {
    const groups = new Map<string, AddressGroup>();
    
    for (let i = 0; i < utxos.length; i++) {
      const utxo = utxos[i];
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

      if (i % 1000 === 999) {
        checkAbort(signal);
        await yieldToUI();
      }
    }

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
  }, [utxos, latestPrice], [] as AddressGroup[]);

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

    if (debouncedSearch.trim()) {
      const q = debouncedSearch.toLowerCase();
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
  }, [addressGroups, ownerFilter, walletFilter, tagFilter, categoryFilter, debouncedSearch, searchFilters, includeBlockchainDiscovered, userCuratedAddresses]);

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

  type FlatUtxoRow =
    | { kind: 'group'; group: AddressGroup }
    | { kind: 'utxo'; utxo: UTXO; index: number };

  const flattenedRows = useMemo((): FlatUtxoRow[] => {
    const rows: FlatUtxoRow[] = [];
    for (const group of sortedGroups) {
      rows.push({ kind: 'group', group });
      if (expandedAddresses.has(group.address)) {
        group.utxos.forEach((utxo, idx) => {
          rows.push({ kind: 'utxo', utxo, index: idx });
        });
      }
    }
    return rows;
  }, [sortedGroups, expandedAddresses]);

  const utxoScrollRef = useRef<HTMLDivElement>(null);

  const utxoVirtualizer = useVirtualizer({
    count: flattenedRows.length,
    getScrollElement: () => utxoScrollRef.current,
    estimateSize: (index) => flattenedRows[index]?.kind === 'utxo' ? 44 : 72,
    overscan: 20,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

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

  const isDataLoading = engineDecision === 'pending'
    ? true
    : engineDecision === 'engine'
      ? engineUtxosLoading
      : (!transactions || !participants);
  const isComputing = utxosHeuristicComputing || utxosExactComputing || addressGroupsComputing || outpointDataStatusComputing;
  const isLoading = isDataLoading || participantsLoading;

  useEffect(() => {
    utxoScrollRef.current?.scrollTo(0, 0);
  }, [debouncedSearch, ownerFilter, walletFilter, tagFilter, categoryFilter, selectedDate, searchFilters, sortColumn, sortDirection, includeBlockchainDiscovered]);

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
    <div className="flex flex-col h-full overflow-hidden p-4 gap-4">
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
          onCheckedChange={setIncludeBlockchainDiscovered}
          hiddenCount={blockchainDiscoveredCount ?? 0}
        />
      </div>

      {(participantsLoading || isComputing) && (
        <Card className="flex-none">
          <CardContent className="py-4">
            <div className="flex flex-col gap-2">
              {participantsLoading && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="status-participants-loading">
                  <RefreshCw className="h-4 w-4 animate-spin" />
                  <span>Loading transaction participants for {processedRecords.length.toLocaleString()} addresses...</span>
                </div>
              )}
              {isComputing && !participantsLoading && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="status-computing">
                  <RefreshCw className="h-4 w-4 animate-spin" />
                  <span>Computing UTXO set...</span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
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
                {isSearchPending ? (
                  <Loader2 className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground animate-spin" data-testid="icon-search-pending" />
                ) : (
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                )}
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
              onChange={setSearchFilters}
              onClear={() => setSearchFilters(defaultFilters)}
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

      <div className={`flex-1 min-h-0 ${searchPendingClass(isSearchPending, 'UTXOs')}`}>
        <Card className="h-full flex flex-col">
          <CardHeader className="pb-2 flex-none">
            <CardTitle className="text-base">
              {filteredGroups.length === addressGroups.length 
                ? `${totalAddressCount} addresses (${totalUtxoCount} UTXOs)` 
                : `${filteredGroups.length} of ${addressGroups.length} addresses`}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex-1 min-h-0 p-0">
            {isLoading || isComputing ? (
              <div className="flex flex-col items-center justify-center h-32 gap-2" data-testid="status-loading">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
                <p className="text-sm text-muted-foreground">
                  {engineDecision === 'engine' ? "Loading UTXOs..." : !transactions ? "Loading transactions..." : participantsLoading ? "Loading participants..." : isComputing ? "Computing UTXOs..." : "Loading..."}
                </p>
              </div>
            ) : sortedGroups.length === 0 ? (
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
              <div ref={utxoScrollRef} className="h-full overflow-auto">
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
                    {utxoVirtualizer.getVirtualItems().length > 0 && utxoVirtualizer.getVirtualItems()[0].start > 0 && (
                      <TableRow>
                        <TableCell colSpan={7} className="p-0 border-0" style={{ height: utxoVirtualizer.getVirtualItems()[0].start }} />
                      </TableRow>
                    )}
                    {utxoVirtualizer.getVirtualItems().map(virtualRow => {
                      const row = flattenedRows[virtualRow.index];
                      if (row.kind === 'group') {
                        const group = row.group;
                        const isExpanded = expandedAddresses.has(group.address);
                        return (
                          <TableRow 
                            key={`group-${group.address}`} 
                            ref={utxoVirtualizer.measureElement}
                            data-index={virtualRow.index}
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
                            <TableCell onClick={(e) => e.stopPropagation()}>
                              <div className="flex flex-col gap-1">
                                <AddressLink
                                  address={group.address}
                                  recordId={group.recordId}
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
                        );
                      } else {
                        const { utxo, index: idx } = row;
                        return (
                          <TableRow 
                            key={`utxo-${utxo.id}`} 
                            ref={utxoVirtualizer.measureElement}
                            data-index={virtualRow.index}
                            className="bg-muted/30 cursor-pointer hover-elevate" 
                            onClick={() => openUtxoDetail(utxo)}
                            data-testid={`row-utxo-${utxo.id}`}
                          >
                            <TableCell></TableCell>
                            <TableCell colSpan={2} className="font-mono text-sm" onClick={(e) => e.stopPropagation()}>
                              <div className="flex items-center gap-2 pl-4">
                                <span className="text-muted-foreground text-xs">{idx + 1}.</span>
                                <TxidLink
                                  txid={utxo.txid}
                                  showExternalLink={true}
                                />
                                <span className="text-muted-foreground text-xs">:{utxo.vout}</span>
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
                      }
                    })}
                    {utxoVirtualizer.getVirtualItems().length > 0 && (() => {
                      const lastItem = utxoVirtualizer.getVirtualItems().at(-1)!;
                      const remaining = utxoVirtualizer.getTotalSize() - lastItem.end;
                      return remaining > 0 ? (
                        <TableRow>
                          <TableCell colSpan={7} className="p-0 border-0" style={{ height: remaining }} />
                        </TableRow>
                      ) : null;
                    })()}
                  </TableBody>
                </Table>
                <ScrollPositionIndicator
                  virtualItems={utxoVirtualizer.getVirtualItems()}
                  totalCount={flattenedRows.length}
                  scrollElement={utxoScrollRef.current}
                  label="rows"
                  variant="table"
                />
              </div>
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

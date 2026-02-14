import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tooltip as RadixTooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { 
  Search, Info, GitBranch, Clock, TrendingUp, 
  ArrowRight, Loader2, Database, Globe, AlertCircle, Route,
  Filter, ChevronDown, ChevronRight, Wallet, User, Tag, RefreshCw
} from "lucide-react";
import { SiBitcoin } from "react-icons/si";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useFlowData, type FlowNode } from "@/hooks/use-flow-data";
import { HopPathExplorer } from "@/components/HopPathExplorer";
import { RecordDetailPanel } from "@/components/RecordDetailPanel";
import { db, type ChainType, type AddressImportance, type VaultMetadata, type FlowType, type AcquisitionMethod, type DispositionType, type CounterpartyType } from "@/lib/database";
import { decryptRecords, decryptRecordsWithProgress, isEncryptionReady } from "@/lib/encryptionFacade";
import type { DecryptProgress } from "@/lib/encryption/record-encryption";
import { useOwners } from "@/hooks/use-owners";
import { useWalletNames } from "@/hooks/use-wallet-names";
import { useTags } from "@/hooks/use-tags";

interface FilteredAddress {
  address: string;
  label: string;
  owner?: string;
  walletName?: string;
  balanceSats: number;
  lastTxDate: number;
  txCount: number;
}

interface RecordViewData {
  id: string;
  type: "address" | "transaction" | "other";
  inputString: string;
  label: string;
  notes?: string;
  tags: string[];
  categories: string[];
  seedName?: string;
  walletSoftware?: string;
  owner?: string;
  walletName?: string;
  privateKeyStatus?: string;
  source?: string;
  derivationPath?: string;
  chainType?: ChainType;
  vault?: VaultMetadata;
  addressImportance?: AddressImportance;
  customFields?: { [key: string]: string };
  syncDepth?: number;
  maxSyncedDepth?: number;
  discoveredInTxid?: string;
  discoveredFromRecordId?: number;
  flowType?: FlowType;
  acquisitionMethod?: AcquisitionMethod;
  dispositionType?: DispositionType;
  costBasisUsd?: number;
  counterpartyType?: CounterpartyType;
}

interface FlowPathNode {
  id: string;
  address: string;
  amount: number;
  timestamp: string;
  hop: number;
  type: "input" | "output" | "selected";
  x: number;
  y: number;
  radius: number;
  isOwned: boolean;
  owner?: string;
  txid?: string;
}

interface FlowPathLink {
  source: FlowPathNode;
  target: FlowPathNode;
}

const generateFlowPathData = (nodes: FlowNode[], centerAddress: string) => {
  const selectedNode = nodes.find(n => n.type === "selected");
  if (!selectedNode) return { nodes: [], links: [] };
  
  const allNodes = nodes.filter(n => n.type !== "selected");
  const sortedNodes = [...allNodes].sort((a, b) => 
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  
  const inputNodes = sortedNodes.filter(n => n.type === "input");
  const outputNodes = sortedNodes.filter(n => n.type === "output");
  
  const chartWidth = 700;
  const chartHeight = 400;
  const centerX = chartWidth / 2;
  const paddingY = 40;
  const usableHeight = chartHeight - paddingY * 2;
  
  const maxAmount = Math.max(...nodes.map(n => n.amount), 0.001);
  const getRadius = (amount: number) => Math.max(6, Math.min(24, (amount / maxAmount) * 24 + 4));
  
  const pathNodes: FlowPathNode[] = [];
  const pathLinks: FlowPathLink[] = [];
  
  const centerNode: FlowPathNode = {
    id: selectedNode.id,
    address: selectedNode.address,
    amount: selectedNode.amount,
    timestamp: selectedNode.timestamp,
    hop: 0,
    type: "selected",
    x: centerX,
    y: chartHeight / 2,
    radius: 16,
    isOwned: true,
    owner: selectedNode.owner,
    txid: selectedNode.txid
  };
  pathNodes.push(centerNode);
  
  inputNodes.forEach((node, i) => {
    const ySpacing = usableHeight / (inputNodes.length + 1);
    const hopOffset = Math.abs(node.hop) * 60;
    const pathNode: FlowPathNode = {
      id: node.id,
      address: node.address,
      amount: node.amount,
      timestamp: node.timestamp,
      hop: node.hop,
      type: "input",
      x: centerX - 120 - hopOffset,
      y: paddingY + ySpacing * (i + 1),
      radius: getRadius(node.amount),
      isOwned: !!(node.isLabeled || node.owner),
      owner: node.owner,
      txid: node.txid
    };
    pathNodes.push(pathNode);
    pathLinks.push({ source: pathNode, target: centerNode });
  });
  
  outputNodes.forEach((node, i) => {
    const ySpacing = usableHeight / (outputNodes.length + 1);
    const hopOffset = Math.abs(node.hop) * 60;
    const pathNode: FlowPathNode = {
      id: node.id,
      address: node.address,
      amount: node.amount,
      timestamp: node.timestamp,
      hop: node.hop,
      type: "output",
      x: centerX + 120 + hopOffset,
      y: paddingY + ySpacing * (i + 1),
      radius: getRadius(node.amount),
      isOwned: !!(node.isLabeled || node.owner),
      owner: node.owner,
      txid: node.txid
    };
    pathNodes.push(pathNode);
    pathLinks.push({ source: centerNode, target: pathNode });
  });
  
  return { nodes: pathNodes, links: pathLinks };
};

function AddressFinderList({ addresses, onSelect, satsToBtcDisplay, formatDate }: {
  addresses: FilteredAddress[];
  onSelect: (address: string) => void;
  satsToBtcDisplay: (sats: number) => string;
  formatDate: (ts: number) => string;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const rowHeight = 44;
  const maxVisibleRows = 7;
  const containerHeight = Math.min(addresses.length * rowHeight, maxVisibleRows * rowHeight);

  const virtualizer = useVirtualizer({
    count: addresses.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 5,
  });

  return (
    <div className="border rounded-md overflow-hidden">
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 px-3 py-2 bg-muted/50 text-xs font-medium text-muted-foreground">
        <span>Address</span>
        <span className="text-right min-w-[120px]">Balance</span>
        <span className="text-right min-w-[90px]">Last Tx</span>
        <span className="text-right min-w-[40px]">Txs</span>
      </div>
      <div ref={parentRef} className="overflow-auto" style={{ height: containerHeight }}>
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map(virtualRow => {
            const addr = addresses[virtualRow.index];
            return (
              <button
                key={addr.address}
                onClick={() => onSelect(addr.address)}
                className="absolute left-0 w-full grid grid-cols-[1fr_auto_auto_auto] gap-2 px-3 text-sm hover-elevate border-t text-left items-center"
                style={{ top: virtualRow.start, height: rowHeight }}
                data-testid={`button-finder-address-${addr.address.slice(-8)}`}
              >
                <div className="min-w-0">
                  <div className="font-mono text-xs truncate">{addr.address}</div>
                  {addr.label && (
                    <div className="text-xs text-muted-foreground truncate">{addr.label}</div>
                  )}
                </div>
                <div className="text-right font-mono text-xs min-w-[120px]">
                  {satsToBtcDisplay(addr.balanceSats)} BTC
                </div>
                <div className="text-right text-xs text-muted-foreground min-w-[90px]">
                  {formatDate(addr.lastTxDate)}
                </div>
                <div className="text-right text-xs text-muted-foreground min-w-[40px]">
                  {addr.txCount}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function BitcoinFlowVisualizer() {
  const [, navigate] = useLocation();
  const [searchAddress, setSearchAddress] = useState("");
  const [hopDepth, setHopDepth] = useState([3]);
  const [allowBlockchainApi, setAllowBlockchainApi] = useState(false);
  const { flowData, isLoading, error, dataSource, fetchFlow } = useFlowData();

  const flowPathData = useMemo(() => {
    if (!flowData) return { nodes: [], links: [] };
    return generateFlowPathData(flowData.nodes, searchAddress);
  }, [flowData, searchAddress]);
  
  const [hoveredNode, setHoveredNode] = useState<FlowPathNode | null>(null);
  const [recordPanelOpen, setRecordPanelOpen] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<RecordViewData | null>(null);
  const [loadingRecord, setLoadingRecord] = useState(false);

  const { owners, isLoading: ownersLoading } = useOwners();
  const { walletNames, isLoading: walletsLoading } = useWalletNames();
  const { tags, isLoading: tagsLoading } = useTags();
  const vocabLoading = ownersLoading || walletsLoading || tagsLoading;

  const [decryptProgress, setDecryptProgress] = useState<DecryptProgress | null>(null);
  const [finderOpen, setFinderOpen] = useState(false);
  const [filterOwner, setFilterOwner] = useState<string>("__all__");
  const [filterWallet, setFilterWallet] = useState<string>("__all__");
  const [filterTag, setFilterTag] = useState<string>("__all__");
  const [filteredAddresses, setFilteredAddresses] = useState<FilteredAddress[]>([]);
  const [finderLoading, setFinderLoading] = useState(false);

  const hasActiveFilter = filterOwner !== "__all__" || filterWallet !== "__all__" || filterTag !== "__all__";

  useEffect(() => {
    if (!hasActiveFilter) {
      setFilteredAddresses([]);
      return;
    }

    let cancelled = false;
    const loadFilteredAddresses = async () => {
      setFinderLoading(true);
      try {
        if (!isEncryptionReady()) {
          setFilteredAddresses([]);
          return;
        }

        let records = await db.records
          .where('type')
          .equals('address')
          .toArray();

        const decrypted = await decryptRecordsWithProgress(records, setDecryptProgress);
        setDecryptProgress(null);

        let filtered = decrypted.filter(r => r.inputString);

        if (filterOwner !== "__all__") {
          filtered = filtered.filter(r => r.owner === filterOwner);
        }
        if (filterWallet !== "__all__") {
          filtered = filtered.filter(r => r.walletName === filterWallet);
        }
        if (filterTag !== "__all__") {
          filtered = filtered.filter(r => r.tags && r.tags.includes(filterTag));
        }

        const addressStrings = filtered.map(r => r.inputString);
        if (addressStrings.length === 0) {
          setFilteredAddresses([]);
          return;
        }

        const participants = await db.transactionParticipants
          .where('address')
          .anyOf(addressStrings)
          .toArray();

        const txids = Array.from(new Set(participants.map(p => p.txid)));
        const txMap = new Map<string, number>();
        if (txids.length > 0) {
          const txBatches: string[][] = [];
          for (let i = 0; i < txids.length; i += 500) {
            txBatches.push(txids.slice(i, i + 500));
          }
          for (const batch of txBatches) {
            const txs = await db.blockchainTransactions
              .where('txid')
              .anyOf(batch)
              .toArray();
            txs.forEach(tx => txMap.set(tx.txid, tx.blockTime));
          }
        }

        const addressStats = new Map<string, { outputSats: number; inputSats: number; lastTxTime: number; txCount: number }>();
        participants.forEach(p => {
          const stats = addressStats.get(p.address) || { outputSats: 0, inputSats: 0, lastTxTime: 0, txCount: 0 };
          const blockTime = txMap.get(p.txid) || 0;
          if (p.role === 'output') {
            stats.outputSats += p.amount;
          } else {
            stats.inputSats += p.amount;
          }
          if (blockTime > stats.lastTxTime) {
            stats.lastTxTime = blockTime;
          }
          stats.txCount++;
          addressStats.set(p.address, stats);
        });

        const results: FilteredAddress[] = [];
        for (const record of filtered) {
          const stats = addressStats.get(record.inputString);
          if (!stats || stats.txCount === 0) continue;
          results.push({
            address: record.inputString,
            label: record.label || '',
            owner: record.owner,
            walletName: record.walletName,
            balanceSats: stats.outputSats - stats.inputSats,
            lastTxDate: stats.lastTxTime,
            txCount: stats.txCount,
          });
        }

        results.sort((a, b) => b.lastTxDate - a.lastTxDate);

        if (!cancelled) {
          setFilteredAddresses(results);
        }
      } catch (err) {
        console.error('[FlowVisualizer] Error loading filtered addresses:', err);
        if (!cancelled) {
          setFilteredAddresses([]);
        }
      } finally {
        if (!cancelled) {
          setFinderLoading(false);
        }
      }
    };

    loadFilteredAddresses();
    return () => { cancelled = true; };
  }, [filterOwner, filterWallet, filterTag, hasActiveFilter]);

  const handleSelectAddress = (address: string) => {
    setSearchAddress(address);
    fetchFlow(address, hopDepth[0], allowBlockchainApi);
  };

  const satsToBtcDisplay = (sats: number): string => {
    return (sats / 100_000_000).toFixed(8);
  };

  const formatDate = (unixSeconds: number): string => {
    if (!unixSeconds) return 'N/A';
    return new Date(unixSeconds * 1000).toLocaleDateString();
  };

  const handleNodeClick = useCallback(async (address: string) => {
    if (!address) return;
    
    setLoadingRecord(true);
    
    try {
      const dbRecord = await db.records
        .where('inputString')
        .equals(address)
        .first();
      
      if (dbRecord && isEncryptionReady()) {
        const decryptedRecords = await decryptRecords([dbRecord]);
        const decrypted = decryptedRecords[0];
        if (decrypted) {
          const converted: RecordViewData = {
            id: String(decrypted.id),
            type: decrypted.type as "address" | "transaction" | "other",
            inputString: decrypted.inputString,
            label: decrypted.label || "",
            notes: decrypted.notes,
            tags: decrypted.tags || [],
            categories: decrypted.categories || [],
            seedName: decrypted.seedName,
            walletSoftware: decrypted.walletSoftware,
            owner: decrypted.owner,
            walletName: decrypted.walletName,
            privateKeyStatus: decrypted.privateKeyStatus,
            source: decrypted.source,
            derivationPath: decrypted.derivationPath,
            chainType: decrypted.chainType as ChainType | undefined,
            vault: decrypted.vault as VaultMetadata | undefined,
            addressImportance: decrypted.addressImportance as AddressImportance | undefined,
            customFields: decrypted.customFields as { [key: string]: string } | undefined,
            syncDepth: decrypted.syncDepth,
            maxSyncedDepth: decrypted.maxSyncedDepth,
            discoveredInTxid: decrypted.discoveredInTxid,
            discoveredFromRecordId: decrypted.discoveredFromRecordId,
            flowType: decrypted.flowType as FlowType | undefined,
            acquisitionMethod: decrypted.acquisitionMethod as AcquisitionMethod | undefined,
            dispositionType: decrypted.dispositionType as DispositionType | undefined,
            costBasisUsd: decrypted.costBasisUsd,
            counterpartyType: decrypted.counterpartyType as CounterpartyType | undefined,
          };
          setSelectedRecord(converted);
          setRecordPanelOpen(true);
        }
      } else {
        navigate(`/records?search=${encodeURIComponent(address)}`);
      }
    } catch (err) {
      console.error('[FlowVisualizer] Error loading record:', err);
      navigate(`/records?search=${encodeURIComponent(address)}`);
    } finally {
      setLoadingRecord(false);
    }
  }, [navigate]);

  const handleEditRecord = () => {
    if (selectedRecord) {
      setRecordPanelOpen(false);
      navigate(`/records?id=${selectedRecord.id}`);
    }
  };

  const handleSearch = () => {
    if (!searchAddress.trim()) return;
    fetchFlow(searchAddress.trim(), hopDepth[0], allowBlockchainApi);
  };

  const getNodeColor = (type: string, isOwned?: boolean) => {
    // Owned addresses get green-tinted colors, external get default
    if (isOwned) {
      switch (type) {
        case "input": return "hsl(142, 76%, 36%)"; // Green for owned inputs
        case "selected": return "hsl(var(--primary))";
        case "output": return "hsl(142, 76%, 36%)"; // Green for owned outputs  
        default: return "hsl(var(--muted))";
      }
    }
    switch (type) {
      case "input": return "hsl(var(--chart-1))";
      case "selected": return "hsl(var(--primary))";
      case "output": return "hsl(var(--chart-2))";
      default: return "hsl(var(--muted))";
    }
  };

  const inputNodes = flowData?.nodes.filter(n => n.type === "input") || [];
  const outputNodes = flowData?.nodes.filter(n => n.type === "output") || [];
  const selectedNode = flowData?.nodes.find(n => n.type === "selected");
  
  // Count owned vs external
  const ownedInputs = inputNodes.filter(n => n.isLabeled || n.owner);
  const externalInputs = inputNodes.filter(n => !n.isLabeled && !n.owner);
  const ownedOutputs = outputNodes.filter(n => n.isLabeled || n.owner);
  const externalOutputs = outputNodes.filter(n => !n.isLabeled && !n.owner);

  return (
    <ScrollArea className="h-full">
      <div className="p-6 space-y-6 max-w-7xl mx-auto">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold flex items-center gap-2" data-testid="text-page-title">
            <SiBitcoin className="h-8 w-8 text-primary" />
            Bitcoin Flow Visualizer
          </h1>
          <p className="text-muted-foreground">
            Trace UTXO provenance through the blockchain. Enter an address to visualize its transaction flow.
          </p>
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

        <Collapsible open={finderOpen} onOpenChange={setFinderOpen}>
          <Card>
            <CollapsibleTrigger asChild>
              <CardHeader className="cursor-pointer flex flex-row items-center justify-between gap-2 pb-2">
                <div className="flex items-center gap-2">
                  <Filter className="h-4 w-4 text-muted-foreground" />
                  <CardTitle className="text-base">Address Finder</CardTitle>
                  {hasActiveFilter && (
                    <Badge variant="secondary">{filteredAddresses.length} addresses</Badge>
                  )}
                </div>
                <Button variant="ghost" size="icon" data-testid="button-toggle-finder">
                  {finderOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </Button>
              </CardHeader>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent className="pt-0 space-y-4">
                <CardDescription>
                  Filter by owner, wallet, or tag to find addresses with transaction history.
                </CardDescription>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="space-y-1">
                    <Label className="text-xs font-medium flex items-center gap-1">
                      <User className="h-3 w-3" />
                      Owner
                    </Label>
                    <Select value={filterOwner} onValueChange={setFilterOwner} disabled={vocabLoading || !isEncryptionReady()}>
                      <SelectTrigger data-testid="select-filter-owner">
                        <SelectValue placeholder={vocabLoading ? "Loading..." : !isEncryptionReady() ? "Locked" : "All owners"} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__all__">All owners</SelectItem>
                        {owners.filter(o => o.name && o.name !== '[encrypted]').map(o => (
                          <SelectItem key={o.id} value={o.name}>{o.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium flex items-center gap-1">
                      <Wallet className="h-3 w-3" />
                      Wallet
                    </Label>
                    <Select value={filterWallet} onValueChange={setFilterWallet} disabled={vocabLoading || !isEncryptionReady()}>
                      <SelectTrigger data-testid="select-filter-wallet">
                        <SelectValue placeholder={vocabLoading ? "Loading..." : !isEncryptionReady() ? "Locked" : "All wallets"} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__all__">All wallets</SelectItem>
                        {walletNames.filter(w => w.name && w.name !== '[encrypted]').map(w => (
                          <SelectItem key={w.id} value={w.name}>{w.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium flex items-center gap-1">
                      <Tag className="h-3 w-3" />
                      Tag
                    </Label>
                    <Select value={filterTag} onValueChange={setFilterTag} disabled={vocabLoading || !isEncryptionReady()}>
                      <SelectTrigger data-testid="select-filter-tag">
                        <SelectValue placeholder={vocabLoading ? "Loading..." : !isEncryptionReady() ? "Locked" : "All tags"} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__all__">All tags</SelectItem>
                        {tags.filter(t => t.name && t.name !== '[encrypted]').map(t => (
                          <SelectItem key={t.id} value={t.name}>{t.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {finderLoading && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading addresses...
                  </div>
                )}

                {hasActiveFilter && !finderLoading && !isEncryptionReady() && (
                  <div className="text-sm text-muted-foreground py-4 text-center">
                    Database is locked. Unlock with your password to search addresses.
                  </div>
                )}

                {hasActiveFilter && !finderLoading && filteredAddresses.length === 0 && isEncryptionReady() && (
                  <div className="text-sm text-muted-foreground py-4 text-center">
                    No addresses with transaction history found for this filter.
                  </div>
                )}

                {filteredAddresses.length > 0 && !finderLoading && (
                  <AddressFinderList addresses={filteredAddresses} onSelect={handleSelectAddress} satsToBtcDisplay={satsToBtcDisplay} formatDate={formatDate} />
                )}
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>

        <Card>
          <CardContent className="pt-6 space-y-6">
            <div className="flex flex-col md:flex-row gap-4">
              <div className="flex-1 space-y-2">
                <Label htmlFor="address-search" className="text-xs font-medium flex items-center gap-1">
                  <Search className="h-3 w-3" />
                  Bitcoin Address
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="address-search"
                    placeholder="Enter Bitcoin address (e.g., bc1q...)"
                    value={searchAddress}
                    onChange={(e) => setSearchAddress(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                    className="font-mono text-sm"
                    data-testid="input-address-search"
                  />
                  <Button 
                    onClick={handleSearch} 
                    disabled={!searchAddress.trim() || isLoading}
                    data-testid="button-search"
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Tracing...
                      </>
                    ) : (
                      "Trace"
                    )}
                  </Button>
                </div>
              </div>

              <div className="w-full md:w-48 space-y-2">
                <Label className="text-xs font-medium flex items-center gap-1">
                  <GitBranch className="h-3 w-3" />
                  Hop Depth
                </Label>
                <div className="flex items-center gap-4">
                  <Slider
                    value={hopDepth}
                    onValueChange={setHopDepth}
                    min={1}
                    max={10}
                    step={1}
                    className="flex-1"
                    data-testid="slider-hop-depth"
                  />
                  <Badge variant="secondary" className="min-w-[3rem] justify-center">
                    {hopDepth[0]} hops
                  </Badge>
                </div>
              </div>

              <div className="w-full md:w-auto space-y-2">
                <Label className="text-xs font-medium flex items-center gap-1">
                  <Globe className="h-3 w-3" />
                  Query Blockchain API
                </Label>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={allowBlockchainApi}
                    onCheckedChange={setAllowBlockchainApi}
                    data-testid="switch-blockchain-api"
                  />
                  <span className="text-xs text-muted-foreground">
                    {allowBlockchainApi ? "Enabled" : "Local only"}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Info className="h-3 w-3" />
              <span>
                {allowBlockchainApi 
                  ? "Will query blockchain API if no local data exists. Uses your configured node settings."
                  : "Only searches local synced records. Enable API to fetch from blockchain."}
              </span>
            </div>
          </CardContent>
        </Card>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {dataSource && (
          <div className="flex items-center gap-2 text-sm">
            {dataSource === 'local' ? (
              <Badge variant="outline" className="gap-1">
                <Database className="h-3 w-3" />
                Data from local database
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1">
                <Globe className="h-3 w-3" />
                Data from blockchain API
              </Badge>
            )}
            <span className="text-muted-foreground">
              Found {inputNodes.length} inputs, {outputNodes.length} outputs
            </span>
          </div>
        )}

        {flowData && (
          <Tabs defaultValue="sankey" className="space-y-4">
            <TabsList className="grid w-full grid-cols-4" data-testid="tabs-visualization">
              <TabsTrigger value="sankey" className="flex items-center gap-2" data-testid="tab-sankey">
                <GitBranch className="h-4 w-4" />
                Sankey
              </TabsTrigger>
              <TabsTrigger value="timeline" className="flex items-center gap-2" data-testid="tab-timeline">
                <Clock className="h-4 w-4" />
                Timeline
              </TabsTrigger>
              <TabsTrigger value="hoppath" className="flex items-center gap-2" data-testid="tab-hoppath">
                <Route className="h-4 w-4" />
                Hop Path
              </TabsTrigger>
              <TabsTrigger value="linechart" className="flex items-center gap-2" data-testid="tab-linechart">
                <TrendingUp className="h-4 w-4" />
                Line Chart
              </TabsTrigger>
            </TabsList>

            <TabsContent value="sankey" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Badge variant="outline">VIZ-1</Badge>
                    Sankey Flow Diagram
                  </CardTitle>
                  <CardDescription>
                    Visual flow showing BTC moving between addresses. Band width represents value.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-[500px] bg-muted/20 rounded-lg p-6 relative overflow-hidden">
                    <svg viewBox="0 0 800 400" className="w-full h-full">
                      <defs>
                        <linearGradient id="inputGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                          <stop offset="0%" stopColor="hsl(var(--chart-1))" stopOpacity="0.8" />
                          <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0.6" />
                        </linearGradient>
                        <linearGradient id="outputGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                          <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0.6" />
                          <stop offset="100%" stopColor="hsl(var(--chart-2))" stopOpacity="0.8" />
                        </linearGradient>
                        <linearGradient id="ownedInputGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                          <stop offset="0%" stopColor="hsl(142, 76%, 36%)" stopOpacity="0.9" />
                          <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0.7" />
                        </linearGradient>
                        <linearGradient id="ownedOutputGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                          <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0.7" />
                          <stop offset="100%" stopColor="hsl(142, 76%, 36%)" stopOpacity="0.9" />
                        </linearGradient>
                      </defs>

                      {inputNodes.slice(0, 6).map((node, i) => {
                        const totalNodes = Math.min(inputNodes.length, 6);
                        const spacing = 350 / (totalNodes + 1);
                        const y = spacing * (i + 1);
                        const height = Math.max(20, Math.min(40, node.amount * 80));
                        const isOwned = node.isLabeled || !!node.owner;
                        return (
                          <g key={node.id} className="cursor-pointer" onClick={() => handleNodeClick(node.address)} data-testid={`sankey-input-${node.id}`}>
                            <path
                              d={`M 120 ${y} C 250 ${y}, 280 200, 350 ${180 + (i - totalNodes/2) * 20}`}
                              fill="none"
                              stroke={isOwned ? "url(#ownedInputGrad)" : "url(#inputGrad)"}
                              strokeWidth={height / 3}
                              opacity={isOwned ? "0.8" : "0.6"}
                            />
                            <rect
                              x="20"
                              y={y - height/2}
                              width="100"
                              height={height}
                              rx="4"
                              fill={isOwned ? "hsl(142, 76%, 36%)" : "hsl(var(--chart-1))"}
                              opacity={isOwned ? "0.95" : "0.8"}
                              className="hover:opacity-100 transition-opacity"
                            />
                            {isOwned && (
                              <rect
                                x="20"
                                y={y - height/2}
                                width="100"
                                height={height}
                                rx="4"
                                fill="none"
                                stroke="hsl(142, 76%, 50%)"
                                strokeWidth="2"
                              />
                            )}
                            <text x="70" y={y + 4} textAnchor="middle" className="fill-current text-xs font-mono pointer-events-none">
                              {node.address}
                            </text>
                            <text x="70" y={y + 18} textAnchor="middle" className="fill-muted-foreground text-xs pointer-events-none">
                              {node.amount.toFixed(4)} BTC
                            </text>
                          </g>
                        );
                      })}

                      {selectedNode && (
                        <g className="cursor-pointer" onClick={() => handleNodeClick(selectedNode.address)} data-testid="sankey-selected-node">
                          <rect
                            x="350"
                            y="150"
                            width="100"
                            height="100"
                            rx="8"
                            fill="hsl(var(--primary))"
                            opacity="0.9"
                            className="hover:opacity-100 transition-opacity"
                          />
                          <text x="400" y="195" textAnchor="middle" className="fill-primary-foreground text-xs font-bold pointer-events-none">
                            SELECTED
                          </text>
                          <text x="400" y="215" textAnchor="middle" className="fill-primary-foreground text-xs font-mono pointer-events-none">
                            {selectedNode.amount.toFixed(4)} BTC
                          </text>
                        </g>
                      )}

                      {outputNodes.slice(0, 6).map((node, i) => {
                        const totalNodes = Math.min(outputNodes.length, 6);
                        const spacing = 350 / (totalNodes + 1);
                        const y = spacing * (i + 1);
                        const height = Math.max(20, Math.min(40, node.amount * 80));
                        const isOwned = node.isLabeled || !!node.owner;
                        return (
                          <g key={node.id} className="cursor-pointer" onClick={() => handleNodeClick(node.address)} data-testid={`sankey-output-${node.id}`}>
                            <path
                              d={`M 450 ${200 + (i - totalNodes/2) * 20} C 520 ${200 + (i - totalNodes/2) * 20}, 550 ${y}, 680 ${y}`}
                              fill="none"
                              stroke={isOwned ? "url(#ownedOutputGrad)" : "url(#outputGrad)"}
                              strokeWidth={height / 3}
                              opacity={isOwned ? "0.8" : "0.6"}
                            />
                            <rect
                              x="680"
                              y={y - height/2}
                              width="100"
                              height={height}
                              rx="4"
                              fill={isOwned ? "hsl(142, 76%, 36%)" : "hsl(var(--chart-2))"}
                              opacity={isOwned ? "0.95" : "0.8"}
                              className="hover:opacity-100 transition-opacity"
                            />
                            {isOwned && (
                              <rect
                                x="680"
                                y={y - height/2}
                                width="100"
                                height={height}
                                rx="4"
                                fill="none"
                                stroke="hsl(142, 76%, 50%)"
                                strokeWidth="2"
                              />
                            )}
                            <text x="730" y={y + 4} textAnchor="middle" className="fill-current text-xs font-mono pointer-events-none">
                              {node.address}
                            </text>
                            <text x="730" y={y + 18} textAnchor="middle" className="fill-muted-foreground text-xs pointer-events-none">
                              {node.amount.toFixed(4)} BTC
                            </text>
                          </g>
                        );
                      })}
                    </svg>

                    <div className="absolute bottom-4 left-4 flex flex-col gap-2 text-xs">
                      <div className="flex items-center gap-4">
                        <div className="flex items-center gap-1">
                          <div className="w-3 h-3 rounded" style={{ background: "hsl(var(--chart-1))" }} />
                          <span>Inputs ({inputNodes.length})</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <div className="w-3 h-3 rounded" style={{ background: "hsl(var(--primary))" }} />
                          <span>Selected</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <div className="w-3 h-3 rounded" style={{ background: "hsl(var(--chart-2))" }} />
                          <span>Outputs ({outputNodes.length})</span>
                        </div>
                      </div>
                      {(ownedInputs.length > 0 || ownedOutputs.length > 0) && (
                        <div className="flex items-center gap-4 border-t pt-2 mt-1">
                          <div className="flex items-center gap-1">
                            <div className="w-3 h-3 rounded border-2" style={{ background: "hsl(142, 76%, 36%)", borderColor: "hsl(142, 76%, 50%)" }} />
                            <span className="text-green-600 dark:text-green-400 font-medium">
                              Owned ({ownedInputs.length + ownedOutputs.length})
                            </span>
                          </div>
                          <div className="flex items-center gap-1">
                            <div className="w-3 h-3 rounded opacity-70" style={{ background: "hsl(var(--muted-foreground))" }} />
                            <span className="text-muted-foreground">
                              External ({externalInputs.length + externalOutputs.length})
                            </span>
                          </div>
                        </div>
                      )}
                    </div>

                    {inputNodes.length > 6 || outputNodes.length > 6 ? (
                      <div className="absolute bottom-4 right-4 text-xs text-muted-foreground">
                        Showing top 6 of each. {inputNodes.length + outputNodes.length} total addresses.
                      </div>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="timeline" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Badge variant="outline">VIZ-2</Badge>
                    Timeline Swimlanes
                  </CardTitle>
                  <CardDescription>
                    UTXOs organized by time, with swim lanes showing address relationships.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 px-2 py-1 text-xs font-medium text-muted-foreground border-b">
                      <div className="w-8">Hop</div>
                      <div className="w-24">Date</div>
                      <div className="w-32">Address</div>
                      <div className="flex-1">Flow</div>
                      <div className="w-24 text-right">Amount</div>
                      <div className="w-24 text-right">Owner</div>
                    </div>
                    
                    <ScrollArea className="h-[400px]">
                      <div className="space-y-1">
                        {inputNodes.map((node) => {
                          const isOwned = node.isLabeled || !!node.owner;
                          return (
                            <div 
                              key={node.id}
                              className={`flex items-center gap-2 px-2 py-2 rounded hover-elevate cursor-pointer text-sm ${isOwned ? 'bg-green-500/5 border-l-2 border-green-500' : ''}`}
                              data-testid={`timeline-row-${node.id}`}
                              onClick={() => handleNodeClick(node.address)}
                            >
                              <Badge variant="outline" className="w-8 justify-center text-xs">
                                {node.hop}
                              </Badge>
                              <div className="w-24 text-xs text-muted-foreground">{node.timestamp}</div>
                              <div className="w-32 text-xs font-mono truncate">{node.address}</div>
                              <div className="flex-1 flex items-center gap-1">
                                <div 
                                  className="h-4 rounded"
                                  style={{ 
                                    width: `${Math.max(20, Math.min(150, node.amount * 150))}px`,
                                    background: getNodeColor(node.type, isOwned)
                                  }}
                                />
                                <ArrowRight className="h-3 w-3 text-muted-foreground" />
                              </div>
                              <div className="w-24 text-right font-mono text-xs">{node.amount.toFixed(4)} BTC</div>
                              <div className="w-24 text-right">
                                {node.owner && <Badge className="text-xs bg-green-600">{node.owner}</Badge>}
                                {node.isLabeled && !node.owner && <Badge variant="outline" className="text-xs border-green-500 text-green-600">Owned</Badge>}
                              </div>
                            </div>
                          );
                        })}

                        {selectedNode && (
                          <div 
                            className="flex items-center gap-2 px-2 py-3 rounded bg-primary/10 border border-primary/20 cursor-pointer hover-elevate"
                            onClick={() => handleNodeClick(selectedNode.address)}
                            data-testid="timeline-selected-row"
                          >
                            <Badge className="w-8 justify-center text-xs">0</Badge>
                            <div className="w-24 text-xs">{selectedNode.timestamp}</div>
                            <div className="w-32 text-xs font-bold font-mono truncate">{selectedNode.address}</div>
                            <div className="flex-1 flex items-center gap-1">
                              <div 
                                className="h-6 rounded flex items-center justify-center text-xs text-primary-foreground font-medium"
                                style={{ 
                                  width: "120px",
                                  background: "hsl(var(--primary))"
                                }}
                              >
                                SELECTED
                              </div>
                            </div>
                            <div className="w-24 text-right font-mono text-sm font-bold">{selectedNode.amount.toFixed(4)} BTC</div>
                            <div className="w-24 text-right">
                              {selectedNode.owner && <Badge>{selectedNode.owner}</Badge>}
                            </div>
                          </div>
                        )}

                        {outputNodes.map((node) => {
                          const isOwned = node.isLabeled || !!node.owner;
                          return (
                            <div 
                              key={node.id}
                              className={`flex items-center gap-2 px-2 py-2 rounded hover-elevate cursor-pointer text-sm ${isOwned ? 'bg-green-500/5 border-l-2 border-green-500' : ''}`}
                              data-testid={`timeline-row-${node.id}`}
                              onClick={() => handleNodeClick(node.address)}
                            >
                              <Badge variant="outline" className="w-8 justify-center text-xs">
                                +{node.hop}
                              </Badge>
                              <div className="w-24 text-xs text-muted-foreground">{node.timestamp}</div>
                              <div className="w-32 text-xs font-mono truncate">{node.address}</div>
                              <div className="flex-1 flex items-center gap-1">
                                <ArrowRight className="h-3 w-3 text-muted-foreground" />
                                <div 
                                  className="h-4 rounded"
                                  style={{ 
                                    width: `${Math.max(20, Math.min(150, node.amount * 150))}px`,
                                    background: getNodeColor(node.type, isOwned)
                                  }}
                                />
                              </div>
                              <div className="w-24 text-right font-mono text-xs">{node.amount.toFixed(4)} BTC</div>
                              <div className="w-24 text-right">
                                {node.owner && <Badge className="text-xs bg-green-600">{node.owner}</Badge>}
                                {node.isLabeled && !node.owner && <Badge variant="outline" className="text-xs border-green-500 text-green-600">Owned</Badge>}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </ScrollArea>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="hoppath" className="space-y-4">
              <HopPathExplorer
                nodes={flowData.nodes}
                links={flowData.links}
                centerAddress={searchAddress}
                isLoading={isLoading}
                onExploreAddress={(address) => {
                  setSearchAddress(address);
                  fetchFlow(address, hopDepth[0], allowBlockchainApi);
                }}
                onNodeClick={handleNodeClick}
              />
            </TabsContent>

            <TabsContent value="linechart" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Badge variant="outline">CHT-1</Badge>
                    Transaction Flow Paths
                  </CardTitle>
                  <CardDescription>
                    Visualize fund flow paths. Dot size represents BTC amount. Hover for details.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-[420px] bg-muted/10 rounded-lg relative overflow-hidden">
                    {flowPathData.nodes.length > 0 ? (
                      <svg viewBox="0 0 700 400" className="w-full h-full">
                        <defs>
                          <marker
                            id="arrowhead"
                            markerWidth="10"
                            markerHeight="7"
                            refX="9"
                            refY="3.5"
                            orient="auto"
                          >
                            <polygon
                              points="0 0, 10 3.5, 0 7"
                              fill="hsl(var(--muted-foreground))"
                              opacity="0.5"
                            />
                          </marker>
                        </defs>
                        
                        {flowPathData.links.map((link, i) => {
                          const dx = link.target.x - link.source.x;
                          const dy = link.target.y - link.source.y;
                          const dist = Math.sqrt(dx * dx + dy * dy);
                          const offsetX = (dx / dist) * link.target.radius;
                          const offsetY = (dy / dist) * link.target.radius;
                          
                          const midX = (link.source.x + link.target.x) / 2;
                          const curveOffset = link.source.type === "input" ? -20 : 20;
                          
                          return (
                            <path
                              key={i}
                              d={`M ${link.source.x} ${link.source.y} Q ${midX} ${(link.source.y + link.target.y) / 2 + curveOffset} ${link.target.x - offsetX} ${link.target.y - offsetY}`}
                              fill="none"
                              stroke={link.source.isOwned || link.target.isOwned ? "hsl(142, 60%, 45%)" : "hsl(var(--muted-foreground))"}
                              strokeWidth={Math.max(1, Math.min(3, link.source.amount * 4))}
                              strokeOpacity={0.4}
                              markerEnd="url(#arrowhead)"
                              className="transition-all duration-200"
                            />
                          );
                        })}
                        
                        {flowPathData.nodes.map((node) => {
                          const isHovered = hoveredNode?.id === node.id;
                          const fillColor = node.type === "selected" 
                            ? "hsl(var(--primary))"
                            : node.isOwned 
                              ? "hsl(142, 70%, 40%)"
                              : node.type === "input"
                                ? "hsl(var(--chart-1))"
                                : "hsl(var(--chart-2))";
                          
                          return (
                            <g key={node.id}>
                              <RadixTooltip>
                                <TooltipTrigger asChild>
                                  <circle
                                    cx={node.x}
                                    cy={node.y}
                                    r={isHovered ? node.radius * 1.3 : node.radius}
                                    fill={fillColor}
                                    stroke={node.type === "selected" ? "hsl(var(--primary-foreground))" : isHovered ? "hsl(var(--foreground))" : "transparent"}
                                    strokeWidth={2}
                                    className="cursor-pointer transition-all duration-200"
                                    onMouseEnter={() => setHoveredNode(node)}
                                    onMouseLeave={() => setHoveredNode(null)}
                                    onClick={() => handleNodeClick(node.address)}
                                    data-testid={`flow-node-${node.id}`}
                                  />
                                </TooltipTrigger>
                                <TooltipContent side="top" className="max-w-xs">
                                  <div className="space-y-1">
                                    <p className="font-mono text-xs break-all">{node.address}</p>
                                    <div className="flex items-center gap-2 text-xs">
                                      <span className="font-bold">{node.amount.toFixed(8)} BTC</span>
                                      <span className="text-muted-foreground">{node.timestamp}</span>
                                    </div>
                                    {node.owner && (
                                      <p className="text-xs text-green-500">Owner: {node.owner}</p>
                                    )}
                                    {node.type === "input" && <span className="text-xs text-blue-400">Source (Hop {node.hop})</span>}
                                    {node.type === "output" && <span className="text-xs text-purple-400">Destination (Hop +{node.hop})</span>}
                                    {node.type === "selected" && <span className="text-xs text-primary">Selected Address</span>}
                                    <p className="text-xs text-muted-foreground italic pt-1">Click to view record</p>
                                  </div>
                                </TooltipContent>
                              </RadixTooltip>
                              
                              {node.type === "selected" && (
                                <text
                                  x={node.x}
                                  y={node.y + 4}
                                  textAnchor="middle"
                                  className="fill-primary-foreground text-xs font-bold pointer-events-none"
                                >
                                  YOU
                                </text>
                              )}
                            </g>
                          );
                        })}
                        
                        <text x="80" y="20" className="fill-muted-foreground text-xs font-medium">
                          SOURCES (Inputs)
                        </text>
                        <text x="550" y="20" className="fill-muted-foreground text-xs font-medium">
                          DESTINATIONS (Outputs)
                        </text>
                      </svg>
                    ) : (
                      <div className="h-full flex items-center justify-center text-muted-foreground">
                        No flow path data available
                      </div>
                    )}
                    
                    {hoveredNode && (
                      <div className="absolute bottom-4 left-4 right-4 bg-card/95 backdrop-blur border rounded-lg p-3 shadow-lg">
                        <div className="flex items-start justify-between gap-4">
                          <div className="space-y-2 min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <p className="font-mono text-xs truncate flex-1">{hoveredNode.address}</p>
                              {hoveredNode.isOwned && (
                                <Badge className="bg-green-600 text-xs shrink-0">Owned</Badge>
                              )}
                            </div>
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                              <span className="text-muted-foreground">{hoveredNode.timestamp}</span>
                              <span className={hoveredNode.type === "input" ? "text-blue-500" : hoveredNode.type === "output" ? "text-purple-500" : "text-primary"}>
                                {hoveredNode.type === "input" ? `Source (Hop ${hoveredNode.hop})` : hoveredNode.type === "output" ? `Destination (Hop +${hoveredNode.hop})` : "Selected Address"}
                              </span>
                              {hoveredNode.owner && (
                                <span className="text-green-600">Owner: {hoveredNode.owner}</span>
                              )}
                              {hoveredNode.txid && (
                                <span className="text-muted-foreground font-mono truncate max-w-[200px]">TX: {hoveredNode.txid.slice(0, 12)}...</span>
                              )}
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <div className="text-lg font-bold">{hoveredNode.amount.toFixed(8)} BTC</div>
                            <div className="text-xs text-muted-foreground">
                              {hoveredNode.type === "input" ? "Received from" : hoveredNode.type === "output" ? "Sent to" : "Center"}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="mt-4 flex items-center justify-center gap-6 text-xs">
                    <div className="flex items-center gap-2">
                      <div className="w-4 h-4 rounded-full" style={{ background: "hsl(var(--chart-1))" }} />
                      <span>External Inputs</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-4 h-4 rounded-full" style={{ background: "hsl(var(--primary))" }} />
                      <span>Selected Address</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-4 h-4 rounded-full" style={{ background: "hsl(var(--chart-2))" }} />
                      <span>External Outputs</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-4 h-4 rounded-full border-2" style={{ background: "hsl(142, 70%, 40%)", borderColor: "hsl(142, 70%, 50%)" }} />
                      <span className="text-green-600 dark:text-green-400">Owned</span>
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-4 gap-4 text-center">
                    <div className="p-3 rounded-lg bg-muted/30">
                      <div className="text-2xl font-bold text-chart-1">{flowData?.stats.inputCount || 0}</div>
                      <div className="text-xs text-muted-foreground">Input Addresses</div>
                    </div>
                    <div className="p-3 rounded-lg bg-muted/30">
                      <div className="text-lg font-bold text-chart-1">{flowData?.stats.totalInputValue.toFixed(4) || 0} BTC</div>
                      <div className="text-xs text-muted-foreground">Total Received</div>
                    </div>
                    <div className="p-3 rounded-lg bg-muted/30">
                      <div className="text-lg font-bold text-chart-2">{flowData?.stats.totalOutputValue.toFixed(4) || 0} BTC</div>
                      <div className="text-xs text-muted-foreground">Total Sent</div>
                    </div>
                    <div className="p-3 rounded-lg bg-muted/30">
                      <div className="text-2xl font-bold text-chart-2">{flowData?.stats.outputCount || 0}</div>
                      <div className="text-xs text-muted-foreground">Output Addresses</div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        )}

        {!flowData && !isLoading && !error && (
          <Card className="border-dashed">
            <CardContent className="py-12 text-center">
              <SiBitcoin className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">Enter an Address to Begin</h3>
              <p className="text-sm text-muted-foreground max-w-md mx-auto">
                Enter a Bitcoin address above and click "Trace" to visualize its UTXO flow. 
                Data will be fetched from local records first, or from the blockchain API if not synced.
              </p>
            </CardContent>
          </Card>
        )}

        {isLoading && (
          <Card>
            <CardContent className="py-12 text-center">
              <Loader2 className="h-12 w-12 mx-auto text-primary animate-spin mb-4" />
              <h3 className="text-lg font-medium mb-2">Tracing Transaction Flow...</h3>
              <p className="text-sm text-muted-foreground">
                Fetching transaction history and building flow visualization
              </p>
            </CardContent>
          </Card>
        )}
      </div>
      
      <RecordDetailPanel
        open={recordPanelOpen}
        record={selectedRecord || undefined}
        onClose={() => setRecordPanelOpen(false)}
        onEdit={handleEditRecord}
      />
    </ScrollArea>
  );
}

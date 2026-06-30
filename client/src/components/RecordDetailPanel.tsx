import { Edit, Paperclip, Wallet as WalletIcon, User, Users, Upload, QrCode, Key, GitBranch, ArrowDownLeft, ArrowUpRight, Shield, ChevronDown, ChevronRight, Link2, Layers, FileInput, ExternalLink, AlertCircle, Network, Clock, Copy, Check, Activity, RefreshCw, Loader2 } from "lucide-react";
import { classifyBehavior, BEHAVIOR_LABEL_DISPLAY } from "@/lib/behavior-profile";
import { formatBTC } from "@/lib/bitcoin";
import DiscoveryTreeDialog from "./DiscoveryTreeDialog";
import { useLocation } from "wouter";
import { getRecordOrigins, getParticipantsByAddress, getParticipantsByTxid, getTransactionByTxid, getTransactionsByTxids } from "@/lib/dataFacade";
import { detectSingularFieldConflicts } from "@/lib/conflict-detection";
import { Link } from "wouter";
import { useState, useEffect, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import { useNodeSettings } from "@/hooks/use-node-settings";
import { transactionSyncService, type SyncProgress } from "@/lib/transaction-sync";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AddressLink } from "./AddressLink";
import { TxidLink } from "./TxidLink";
import { RecordTypeBadge } from "./RecordTypeBadge";
import { AttachmentList } from "./AttachmentList";
import { AttachmentUpload } from "./AttachmentUpload";
import { MetadataSourcesPanel } from "./MetadataSourcesPanel";
import { renderSourceNote } from "@/lib/renderSourceNote";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { 
  Attachment, 
  VaultMetadata, 
  AddressImportance, 
  ChainType,
  FlowType,
  AcquisitionMethod,
  DispositionType,
  CounterpartyType,
  BlockchainTransaction,
} from "@/lib/database";
import { 
  db,
  FLOW_TYPE_OPTIONS,
  ACQUISITION_METHOD_OPTIONS,
  DISPOSITION_TYPE_OPTIONS,
  COUNTERPARTY_TYPE_OPTIONS,
} from "@/lib/database";
import QRCode from "qrcode";

interface CustomFieldDef {
  id?: number;
  name: string;
  slug: string;
  enabled: boolean;
}

interface RecordDetailPanelProps {
  open: boolean;
  onClose: () => void;
  onEdit?: () => void;
  onSyncComplete?: () => void;
  record?: {
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
    customFields?: { [slug: string]: string };
    syncDepth?: number;
    maxSyncedDepth?: number;
    discoveredInTxid?: string;
    discoveredFromRecordId?: number;
    // Transaction metadata
    flowType?: FlowType;
    acquisitionMethod?: AcquisitionMethod;
    dispositionType?: DispositionType;
    costBasisUsd?: number;
    // Address metadata
    counterpartyType?: CounterpartyType;
    counterpartyName?: string;
    // Cached address stats (populated after sync/recompute)
    cachedBalanceSats?: number;
    cachedTxCount?: number;
    cachedLastActivityTime?: number;
    cachedUtxoCount?: number;
    statsComputedAt?: number;
  };
  attachments?: Attachment[];
  onAttachmentsChange?: () => void;
  customFieldDefs?: CustomFieldDef[];
}

function getImportanceBadgeVariant(importance?: AddressImportance): "default" | "secondary" | "outline" | "destructive" {
  switch (importance) {
    case 'verified':
      return 'default';
    case 'manual':
      return 'default';
    case 'wallet-import':
      return 'secondary';
    case 'xpub-derived':
      return 'secondary';
    case 'blockchain-discovered':
      return 'outline';
    case 'pending-review':
      return 'destructive';
    default:
      return 'outline';
  }
}

function getImportanceLabel(importance?: AddressImportance): string {
  switch (importance) {
    case 'verified':
      return 'Verified';
    case 'manual':
      return 'Manual Entry';
    case 'wallet-import':
      return 'Wallet Import';
    case 'xpub-derived':
      return 'XPUB Derived';
    case 'blockchain-discovered':
      return 'Blockchain Discovered';
    case 'pending-review':
      return 'Pending Review';
    default:
      return 'Unknown';
  }
}

function getSyncStatusText(progress: SyncProgress): string {
  switch (progress.phase) {
    case 'idle':
      return 'Preparing…';
    case 'fetching-height':
      return 'Getting current block height…';
    case 'syncing-addresses':
      return progress.transactionsFound > 0
        ? `Fetching transactions… ${progress.transactionsNew} / ${progress.transactionsFound}`
        : 'Fetching transactions…';
    case 'processing':
      return `Processing transactions… ${progress.transactionsNew} / ${progress.transactionsFound}`;
    case 'resolving-prevouts':
      return 'Resolving input details…';
    default:
      return '';
  }
}

function getSourceLabel(source?: string): string {
  switch (source) {
    case 'manual':
      return 'Manual Entry';
    case 'wallet-import':
      return 'Wallet Import';
    case 'xpub-import':
      return 'XPUB Import';
    case 'blockchain-sync':
      return 'Blockchain Sync';
    default:
      return source || 'Unknown';
  }
}

interface CosignerDetail {
  index: number;
  name: string;
  notes?: string;
  xpubPreview?: string;
}

interface ParsedVaultNotes {
  cosigners?: CosignerDetail[];
  scriptType?: string;
  userNotes?: string;
}

function parseVaultNotes(vaultNotes?: string | null): ParsedVaultNotes | null {
  if (!vaultNotes) return null;
  try {
    const parsed = JSON.parse(vaultNotes);
    if (parsed && typeof parsed === 'object') {
      const result: ParsedVaultNotes = {};
      if (Array.isArray(parsed.cosigners)) {
        result.cosigners = parsed.cosigners.map((c: CosignerDetail) => ({
          index: c.index ?? 0,
          name: c.name || `Cosigner ${c.index ?? 0}`,
          notes: c.notes,
          xpubPreview: c.xpubPreview,
        }));
      }
      if (parsed.scriptType) result.scriptType = String(parsed.scriptType);
      if (parsed.userNotes) result.userNotes = String(parsed.userNotes);
      if (result.cosigners || result.scriptType || result.userNotes) {
        return result;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function VaultInfoSection({ vault }: { vault: VaultMetadata }) {
  const [cosignersOpen, setCosignersOpen] = useState(false);
  const parsedNotes = parseVaultNotes(vault.vaultNotes);
  const hasStructuredCosigners = parsedNotes?.cosigners && parsedNotes.cosigners.length > 0;

  return (
    <div className="p-3 bg-muted/50 rounded-lg space-y-3" data-testid="section-vault-info">
      <h4 className="text-sm font-medium flex items-center gap-2">
        <Layers className="h-4 w-4" />
        Multisig Vault
      </h4>
      {vault.vaultName && (
        <div>
          <span className="text-xs text-muted-foreground">Vault Name:</span>
          <p className="text-sm" data-testid="text-vault-name">{vault.vaultName}</p>
        </div>
      )}
      {vault.m && vault.n && (
        <div>
          <span className="text-xs text-muted-foreground">Quorum:</span>
          <p className="text-sm" data-testid="text-vault-quorum">
            {vault.m} of {vault.n} signatures required
          </p>
        </div>
      )}
      {parsedNotes?.scriptType && (
        <div>
          <span className="text-xs text-muted-foreground">Script Type:</span>
          <p className="text-sm" data-testid="text-vault-script-type">{parsedNotes.scriptType}</p>
        </div>
      )}
      {hasStructuredCosigners && (
        <Collapsible open={cosignersOpen} onOpenChange={setCosignersOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="w-full justify-between text-xs gap-1" data-testid="button-toggle-cosigners">
              <span className="flex items-center gap-2">
                <Users className="h-3 w-3" />
                Cosigners ({parsedNotes.cosigners!.length})
              </span>
              {cosignersOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2 space-y-2">
            {parsedNotes.cosigners!.map((cosigner, idx) => (
              <div key={idx} className="pl-2 border-l-2 border-muted-foreground/30 space-y-1" data-testid={`cosigner-detail-${idx}`}>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium" data-testid={`text-cosigner-name-${idx}`}>{cosigner.name}</span>
                  {cosigner.xpubPreview && (
                    <code className="text-xs text-muted-foreground bg-muted px-1 rounded" data-testid={`text-cosigner-xpub-${idx}`}>
                      {cosigner.xpubPreview}
                    </code>
                  )}
                </div>
                {cosigner.notes && (
                  <p className="text-xs text-muted-foreground" data-testid={`text-cosigner-notes-${idx}`}>{renderSourceNote(cosigner.notes)}</p>
                )}
              </div>
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}
      {parsedNotes?.userNotes && (
        <div>
          <span className="text-xs text-muted-foreground">Notes:</span>
          <p className="text-sm text-muted-foreground whitespace-pre-wrap" data-testid="text-vault-user-notes">
            {parsedNotes.userNotes}
          </p>
        </div>
      )}
      {!hasStructuredCosigners && vault.vaultNotes && !parsedNotes && (
        <div>
          <span className="text-xs text-muted-foreground">Notes:</span>
          <p className="text-sm text-muted-foreground whitespace-pre-wrap" data-testid="text-vault-notes">
            {vault.vaultNotes}
          </p>
        </div>
      )}
    </div>
  );
}

interface TxHistoryEntry {
  txid: string;
  date: number;
  netAmount: number;
}

export function TransactionHistorySection({ address, refreshTrigger }: { address: string; refreshTrigger?: number }) {
  const [isOpen, setIsOpen] = useState(false);
  const [entries, setEntries] = useState<TxHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [expandedTxid, setExpandedTxid] = useState<string | null>(null);
  const { copy, copiedKey: copiedTxid } = useCopyToClipboard();

  useEffect(() => {
    setEntries([]);
    setLoaded(false);
    setExpandedTxid(null);
  }, [address, refreshTrigger]);

  useEffect(() => {
    if (!isOpen || loaded) return;

    async function loadHistory() {
      setLoading(true);
      try {
        const participants = await getParticipantsByAddress(address);

        if (participants.length === 0) {
          setEntries([]);
          setLoaded(true);
          setLoading(false);
          return;
        }

        const txidSet = new Set(participants.map(p => p.txid));
        const txids = Array.from(txidSet);

        const txMap = new Map<string, number>();
        const batchSize = 500;
        for (let i = 0; i < txids.length; i += batchSize) {
          const batch = txids.slice(i, i + batchSize);
          const txs = await getTransactionsByTxids(batch);
          for (const tx of txs) {
            txMap.set(tx.txid, tx.blockTime);
          }
        }

        const inputsNeedingLookup: Array<{ prevTxid: string; prevVout: number }> = [];
        for (const p of participants) {
          if (p.role === 'input' && (Number(p.amount) || 0) === 0 && p.prevTxid && p.prevVout !== undefined) {
            inputsNeedingLookup.push({ prevTxid: p.prevTxid, prevVout: p.prevVout });
          }
        }

        const resolvedInputAmounts = new Map<string, number>();
        for (const { prevTxid, prevVout } of inputsNeedingLookup) {
          const key = `${prevTxid}:${prevVout}`;
          if (resolvedInputAmounts.has(key)) continue;
          const prevTxParts = await getParticipantsByTxid(prevTxid);
          const spentOutputs = prevTxParts.filter(p => p.role === "output");
          const match = spentOutputs.find(o => o.vout === prevVout);
          resolvedInputAmounts.set(key, match ? (Number(match.amount) || 0) : 0);
        }

        const netByTxid = new Map<string, number>();
        const seen = new Set<string>();
        for (const p of participants) {
          if (p.role !== 'input' && p.role !== 'output') continue;
          const key = `${p.txid}:${p.role}:${p.vout ?? p.prevTxid ?? p.id ?? ''}:${p.prevVout ?? ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          let amount = Number(p.amount) || 0;
          if (p.role === 'input' && amount === 0 && p.prevTxid && p.prevVout !== undefined) {
            amount = resolvedInputAmounts.get(`${p.prevTxid}:${p.prevVout}`) || 0;
          }
          const current = netByTxid.get(p.txid) || 0;
          if (p.role === 'output') {
            netByTxid.set(p.txid, current + amount);
          } else {
            netByTxid.set(p.txid, current - amount);
          }
        }

        const result: TxHistoryEntry[] = [];
        netByTxid.forEach((netAmount, txid) => {
          result.push({
            txid,
            date: txMap.get(txid) || 0,
            netAmount,
          });
        });

        result.sort((a, b) => b.date - a.date);
        setEntries(result);
        setLoaded(true);
      } catch (error) {
        console.error("Failed to load transaction history:", error);
      }
      setLoading(false);
    }

    loadHistory();
  }, [isOpen, loaded, address]);

  const handleCopy = (txid: string) => {
    copy(txid, { label: "Transaction ID" });
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" className="w-full justify-between px-0" data-testid="button-toggle-tx-history">
          <span className="text-sm font-medium flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Transaction History
            {loaded && entries.length > 0 && (
              <Badge variant="secondary" className="ml-1">{entries.length}</Badge>
            )}
          </span>
          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        {loading && (
          <div className="text-sm text-muted-foreground py-4 text-center" data-testid="tx-history-loading">
            Loading transactions...
          </div>
        )}
        {loaded && entries.length === 0 && (
          <div className="text-sm text-muted-foreground py-4 text-center" data-testid="tx-history-empty">
            No synced transactions found
          </div>
        )}
        {loaded && entries.length > 0 && (
          <div className="space-y-1 max-h-[300px] overflow-y-auto" data-testid="tx-history-list">
            {entries.map((entry) => {
              const isReceive = entry.netAmount > 0;
              const dateStr = entry.date
                ? new Date(entry.date * 1000).toLocaleDateString(undefined, {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                  })
                : 'Unknown';
              const isExpanded = expandedTxid === entry.txid;

              return (
                <div key={entry.txid} data-testid={`tx-history-row-${entry.txid.slice(0, 8)}`}>
                  <div
                    role="button"
                    tabIndex={0}
                    className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors hover:bg-muted/60"
                    onClick={() => setExpandedTxid(isExpanded ? null : entry.txid)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setExpandedTxid(isExpanded ? null : entry.txid); }}
                    data-testid={`button-expand-tx-${entry.txid.slice(0, 8)}`}
                  >
                    <span className="text-xs text-muted-foreground shrink-0">{dateStr}</span>
                    <span className="text-xs font-mono text-muted-foreground truncate mx-1">
                      {entry.txid.slice(0, 8)}...
                    </span>
                    <span
                      className={`text-sm font-mono font-medium shrink-0 ${
                        isReceive ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
                      }`}
                      data-testid={`text-tx-amount-${entry.txid.slice(0, 8)}`}
                    >
                      {isReceive ? '+' : ''}{formatBTC(entry.netAmount)}
                    </span>
                  </div>
                  {isExpanded && (
                    <div className="flex items-center gap-1 px-2 py-1 bg-muted/50 rounded-md mt-0.5">
                      <span className="text-xs font-mono break-all flex-1" data-testid={`text-txid-full-${entry.txid.slice(0, 8)}`}>
                        {entry.txid}
                      </span>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => handleCopy(entry.txid)}
                        data-testid={`button-copy-txid-${entry.txid.slice(0, 8)}`}
                      >
                        {copiedTxid === entry.txid ? (
                          <Check className="h-3 w-3 text-green-600 dark:text-green-400" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function RecordDetailPanel({ 
  open, 
  onClose, 
  onEdit,
  onSyncComplete,
  record, 
  attachments = [], 
  onAttachmentsChange,
  customFieldDefs = [],
}: RecordDetailPanelProps) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { nodeSettings } = useNodeSettings();
  const [showUpload, setShowUpload] = useState(false);
  const [qrDialogOpen, setQrDialogOpen] = useState(false);
  const [discoveryTreeOpen, setDiscoveryTreeOpen] = useState(false);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const [conflictCount, setConflictCount] = useState(0);
  const [blockchainTx, setBlockchainTx] = useState<BlockchainTransaction | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [txHistoryRefreshTrigger, setTxHistoryRefreshTrigger] = useState(0);

  const handleSyncNow = useCallback(async () => {
    if (!record || record.type !== 'address' || isSyncing) return;
    setIsSyncing(true);
    setSyncProgress(null);
    transactionSyncService.updateProvider(nodeSettings);
    try {
      const result = await transactionSyncService.syncSingleAddress(
        record.inputString,
        (progress) => setSyncProgress(progress)
      );
      if (result.success) {
        toast({
          title: "Sync Complete",
          description: `Found ${result.transactionsImported} new transaction${result.transactionsImported === 1 ? '' : 's'}.`,
        });
        setTxHistoryRefreshTrigger(t => t + 1);
        onSyncComplete?.();
      } else {
        toast({
          title: "Sync Failed",
          description: result.errors[0] || "Unknown error",
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: "Sync Failed",
        description: error instanceof Error ? error.message : "An error occurred",
        variant: "destructive",
      });
    } finally {
      setIsSyncing(false);
      setSyncProgress(null);
    }
  }, [record, isSyncing, nodeSettings, toast]);

  useEffect(() => {
    if (qrDialogOpen && record?.inputString) {
      QRCode.toDataURL(record.inputString, {
        width: 256,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF',
        },
      })
        .then((url) => setQrCodeDataUrl(url))
        .catch((err) => console.error('Error generating QR code:', err));
    }
  }, [qrDialogOpen, record?.inputString]);

  useEffect(() => {
    async function checkConflicts() {
      if (!record?.id || !open) {
        setConflictCount(0);
        return;
      }
      try {
        const origins = await getRecordOrigins(Number(record.id));
        if (origins.length < 2) {
          setConflictCount(0);
          return;
        }
        const conflicts = detectSingularFieldConflicts(record as unknown as Parameters<typeof detectSingularFieldConflicts>[0], origins);
        setConflictCount(conflicts.length);
      } catch (error) {
        console.error("Failed to check conflicts:", error);
        setConflictCount(0);
      }
    }
    checkConflicts();
  }, [record?.id, open]);

  // Fetch blockchain transaction data for transaction records
  useEffect(() => {
    async function fetchBlockchainTx() {
      if (!record || record.type !== 'transaction' || !open) {
        setBlockchainTx(null);
        return;
      }
      try {
        const tx = await getTransactionByTxid(record.inputString);
        setBlockchainTx(tx ?? null);
      } catch (error) {
        console.error("Failed to fetch blockchain transaction:", error);
        setBlockchainTx(null);
      }
    }
    fetchBlockchainTx();
  }, [record?.inputString, record?.type, open]);

  if (!record) return null;

  const handleUploadComplete = () => {
    setShowUpload(false);
    onAttachmentsChange?.();
  };

  const handleOpenQrDialog = () => {
    setQrCodeDataUrl(null);
    setQrDialogOpen(true);
  };

  const hasWalletInfo = record.seedName || record.walletSoftware || record.derivationPath || record.chainType || record.privateKeyStatus;
  const hasVaultInfo = record.vault?.isVaultXpub;
  // Only show discovery info section for addresses discovered at deeper levels (syncDepth > 0)
  // or that have specific discovery metadata (discovered in transaction or from another record)
  const hasBlockchainDiscoveryInfo = (record.syncDepth !== undefined && record.syncDepth > 0) || record.discoveredInTxid || record.discoveredFromRecordId !== undefined;
  
  const customFieldsToShow = customFieldDefs.filter(
    def => def.enabled && record.customFields?.[def.slug]
  );

  return (
    <>
    <Sheet open={open} onOpenChange={onClose}>
      <SheetContent className="w-full sm:max-w-md flex flex-col p-0">
        <SheetHeader className="p-6 pb-4 space-y-0">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <SheetTitle className="text-xl mb-2">{record.label}</SheetTitle>
              <div className="flex flex-wrap items-center gap-2">
                <RecordTypeBadge type={record.type} />
                {record.addressImportance && (
                  <Badge 
                    variant={getImportanceBadgeVariant(record.addressImportance)}
                    data-testid="badge-importance"
                  >
                    <Shield className="h-3 w-3 mr-1" />
                    {getImportanceLabel(record.addressImportance)}
                  </Badge>
                )}
                {record.chainType && (
                  <Badge variant="outline" data-testid="badge-chain-type">
                    {record.chainType === 'receive' ? (
                      <><ArrowDownLeft className="h-3 w-3 mr-1" />Receive</>
                    ) : (
                      <><ArrowUpRight className="h-3 w-3 mr-1" />Change</>
                    )}
                  </Badge>
                )}
                {conflictCount > 0 && (
                  <Badge 
                    variant="outline" 
                    className="text-orange-600 border-orange-300 cursor-pointer hover-elevate"
                    onClick={() => navigate(`/conflict-resolution?recordId=${record.id}`)}
                    data-testid="badge-conflicts"
                  >
                    <AlertCircle className="h-3 w-3 mr-1" />
                    {conflictCount} Conflict{conflictCount > 1 ? 's' : ''}
                  </Badge>
                )}
                {record.type === 'address' && (() => {
                  const bp = classifyBehavior({
                    synced: record.statsComputedAt != null,
                    balanceSats: record.cachedBalanceSats ?? 0,
                    txCount: record.cachedTxCount ?? 0,
                    utxoCount: record.cachedUtxoCount ?? 0,
                    lastActivityTime: record.cachedLastActivityTime ?? 0,
                  });
                  return (
                    <Badge variant="secondary" data-testid="badge-behavior-profile">
                      <Activity className="h-3 w-3 mr-1" />
                      {BEHAVIOR_LABEL_DISPLAY[bp.label]}
                    </Badge>
                  );
                })()}
              </div>
            </div>
            <div className="flex gap-1">
              <Button size="icon" variant="ghost" onClick={onEdit} data-testid="button-edit-panel">
                <Edit className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </SheetHeader>

        <ScrollArea className="flex-1 px-6">
          <div className="space-y-6 pb-6">
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm font-medium">
                  {record.type === "address" ? "Bitcoin Address" : record.type === "transaction" ? "Transaction ID" : "Identifier"}
                </h4>
                {(record.type === "address" || record.type === "transaction") && (
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={handleOpenQrDialog}
                    data-testid="button-show-qr"
                  >
                    <QrCode className="h-4 w-4" />
                  </Button>
                )}
              </div>
              {record.type === "transaction" ? (
                <TxidLink
                  txid={record.inputString}
                  recordId={record.id ? Number(record.id) : null}
                  truncate={false}
                />
              ) : (
                <AddressLink
                  address={record.inputString}
                  recordId={record.id ? Number(record.id) : null}
                  truncate={false}
                />
              )}
            </div>

            {record.type === 'address' && (() => {
              const bp = classifyBehavior({
                synced: record.statsComputedAt != null,
                balanceSats: record.cachedBalanceSats ?? 0,
                txCount: record.cachedTxCount ?? 0,
                utxoCount: record.cachedUtxoCount ?? 0,
                lastActivityTime: record.cachedLastActivityTime ?? 0,
              });
              return (
                <div className="p-3 bg-muted/40 rounded-lg space-y-1.5" data-testid="section-behavior-profile">
                  <div className="flex items-center gap-2">
                    <Activity className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Behavior</span>
                    <Badge variant="secondary" className="text-xs" data-testid="badge-behavior-label">
                      {BEHAVIOR_LABEL_DISPLAY[bp.label]}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed" data-testid="text-behavior-summary">
                    {bp.summarySentence}
                  </p>
                  {bp.reasons.length > 0 && (
                    <ul className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                      {bp.reasons.map((r, i) => (
                        <li key={i} className="text-xs text-muted-foreground/70" data-testid={`text-behavior-reason-${i}`}>
                          · {r}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })()}

            {record.notes && (
              <div>
                <h4 className="text-sm font-medium mb-2">Notes</h4>
                <p className="text-sm text-muted-foreground whitespace-pre-wrap" data-testid="text-notes-detail">
                  {renderSourceNote(record.notes)}
                </p>
              </div>
            )}

            {record.source && (
              <div>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                  <FileInput className="h-4 w-4" />
                  Source
                </h4>
                <Badge variant="outline" data-testid="text-source-detail">
                  {getSourceLabel(record.source)}
                </Badge>
              </div>
            )}

            <Separator />

            {record.owner && (
              <div>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                  <User className="h-4 w-4" />
                  Owner
                </h4>
                <p className="text-sm" data-testid="text-owner-detail">{record.owner}</p>
              </div>
            )}

            {record.walletName && (
              <div>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                  <WalletIcon className="h-4 w-4" />
                  Wallet Name
                </h4>
                <p className="text-sm" data-testid="text-walletname-detail">{record.walletName}</p>
              </div>
            )}

            {hasWalletInfo && (
              <>
                {record.seedName && (
                  <div>
                    <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                      <Key className="h-4 w-4" />
                      Seed Name
                    </h4>
                    <p className="text-sm" data-testid="text-seed-detail">{record.seedName}</p>
                  </div>
                )}

                {record.walletSoftware && (
                  <div>
                    <h4 className="text-sm font-medium mb-2">Wallet Software</h4>
                    <p className="text-sm" data-testid="text-wallet-detail">{record.walletSoftware}</p>
                  </div>
                )}

                {record.derivationPath && (
                  <div>
                    <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                      <GitBranch className="h-4 w-4" />
                      Derivation Path
                    </h4>
                    <code className="text-sm bg-muted px-2 py-1 rounded" data-testid="text-derivation-detail">
                      {record.derivationPath}
                    </code>
                  </div>
                )}

                {record.privateKeyStatus && (
                  <div>
                    <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                      <Shield className="h-4 w-4" />
                      Private Key Status
                    </h4>
                    <p className="text-sm" data-testid="text-privatekey-detail">{record.privateKeyStatus}</p>
                  </div>
                )}
              </>
            )}

            {hasVaultInfo && record.vault && (
              <VaultInfoSection vault={record.vault} />
            )}

            {/* Transaction Metadata Section */}
            {record.type === 'transaction' && (record.flowType || record.acquisitionMethod || record.dispositionType || record.costBasisUsd !== undefined) && (
              <div className="p-3 bg-muted/50 rounded-lg space-y-2">
                <h4 className="text-sm font-medium flex items-center gap-2">
                  <ArrowUpRight className="h-4 w-4" />
                  Transaction Details
                </h4>
                {record.flowType && (
                  <div>
                    <span className="text-xs text-muted-foreground">Flow Type:</span>
                    <p className="text-sm" data-testid="text-flow-type">
                      {FLOW_TYPE_OPTIONS.find(o => o.value === record.flowType)?.label || record.flowType}
                    </p>
                  </div>
                )}
                {record.acquisitionMethod && (
                  <div>
                    <span className="text-xs text-muted-foreground">Acquisition Method:</span>
                    <p className="text-sm" data-testid="text-acquisition-method">
                      {ACQUISITION_METHOD_OPTIONS.find(o => o.value === record.acquisitionMethod)?.label || record.acquisitionMethod}
                    </p>
                  </div>
                )}
                {record.dispositionType && (
                  <div>
                    <span className="text-xs text-muted-foreground">Disposition Type:</span>
                    <p className="text-sm" data-testid="text-disposition-type">
                      {DISPOSITION_TYPE_OPTIONS.find(o => o.value === record.dispositionType)?.label || record.dispositionType}
                    </p>
                  </div>
                )}
                {record.costBasisUsd !== undefined && record.costBasisUsd !== null && (
                  <div>
                    <span className="text-xs text-muted-foreground">
                      {record.flowType === 'received' ? 'Cost Basis:' : 'Disposal Value:'}
                    </span>
                    <p className="text-sm font-medium" data-testid="text-cost-basis">
                      ${record.costBasisUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* OP_RETURN Data Section */}
            {record.type === 'transaction' && blockchainTx?.hasOpReturn && blockchainTx.opReturnData && blockchainTx.opReturnData.length > 0 && (
              <div className="p-3 bg-amber-500/10 dark:bg-amber-500/5 border border-amber-500/20 rounded-lg space-y-3">
                <h4 className="text-sm font-medium flex items-center gap-2">
                  <FileInput className="h-4 w-4" />
                  OP_RETURN Data
                </h4>
                {blockchainTx.opReturnData.map((opReturn, idx) => {
                  // Try to decode hex as readable text
                  let decodedText = '';
                  try {
                    const bytes = opReturn.dataHex.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || [];
                    const textChars = bytes.filter(b => b >= 32 && b < 127);
                    if (textChars.length > bytes.length * 0.7) {
                      decodedText = bytes.map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
                    }
                  } catch {
                    // Ignore decode errors
                  }
                  
                  return (
                    <div key={idx} className="space-y-1" data-testid={`op-return-${idx}`}>
                      <span className="text-xs text-muted-foreground">Output #{opReturn.vout}</span>
                      <div className="bg-muted/50 p-2 rounded">
                        <code className="text-xs break-all font-mono" data-testid={`op-return-hex-${idx}`}>
                          {opReturn.dataHex}
                        </code>
                      </div>
                      {decodedText && (
                        <div className="text-xs text-muted-foreground">
                          <span>Decoded: </span>
                          <span className="font-mono" data-testid={`op-return-text-${idx}`}>{decodedText}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Address Counterparty Type */}
            {record.type === 'address' && record.counterpartyType && (
              <div>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                  <User className="h-4 w-4" />
                  Counterparty Type
                </h4>
                <Badge variant="outline" data-testid="badge-counterparty-type">
                  {COUNTERPARTY_TYPE_OPTIONS.find(o => o.value === record.counterpartyType)?.label || record.counterpartyType}
                </Badge>
              </div>
            )}

            {/* Address Counterparty Name */}
            {record.type === 'address' && record.counterpartyName?.trim() && (
              <div>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                  <User className="h-4 w-4" />
                  Counterparty Name
                </h4>
                <p className="text-sm text-muted-foreground" data-testid="text-counterparty-name">
                  {record.counterpartyName}
                </p>
              </div>
            )}

            {record.type === 'address' && (
              <>
                <Separator />
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Transactions</span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleSyncNow}
                    disabled={isSyncing}
                    data-testid="button-sync-now"
                  >
                    {isSyncing ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                    )}
                    {isSyncing ? "Syncing…" : "Sync Now"}
                  </Button>
                </div>
                {isSyncing && syncProgress && getSyncStatusText(syncProgress) && (
                  <p className="text-xs text-muted-foreground" data-testid="text-sync-progress">
                    {getSyncStatusText(syncProgress)}
                  </p>
                )}
                <TransactionHistorySection address={record.inputString} refreshTrigger={txHistoryRefreshTrigger} />
              </>
            )}

            {customFieldsToShow.length > 0 && (
              <>
                <Separator />
                <div>
                  <h4 className="text-sm font-medium mb-3">Custom Fields</h4>
                  <div className="space-y-3">
                    {customFieldsToShow.map(field => (
                      <div key={field.slug}>
                        <span className="text-xs text-muted-foreground">{field.name}</span>
                        <p className="text-sm" data-testid={`text-custom-${field.slug}`}>
                          {record.customFields?.[field.slug]}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {record.tags.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-2">Tags</h4>
                <div className="flex flex-wrap gap-2">
                  {record.tags.map((tag) => (
                    <Badge key={tag} variant="secondary">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {record.categories.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-2">Categories</h4>
                <div className="flex flex-wrap gap-2">
                  {record.categories.map((category) => (
                    <Badge key={category} variant="outline">
                      {category}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            <MetadataSourcesPanel recordId={Number(record.id)} record={record} />

            {hasBlockchainDiscoveryInfo && (
              <Collapsible open={technicalOpen} onOpenChange={setTechnicalOpen}>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" className="w-full justify-between px-0" data-testid="button-toggle-technical">
                    <span className="text-sm font-medium flex items-center gap-2">
                      <Link2 className="h-4 w-4" />
                      Blockchain Discovery Info
                    </span>
                    {technicalOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-3 pt-2">
                  {record.syncDepth !== undefined && record.syncDepth > 0 && (
                    <div>
                      <span className="text-xs text-muted-foreground">Discovery Depth</span>
                      <p className="text-sm" data-testid="text-sync-depth">
                        {record.syncDepth === 1 
                          ? 'First hop (directly connected to your addresses)' 
                          : record.syncDepth === 2
                            ? 'Second hop (2 transactions from your addresses)'
                            : `${record.syncDepth} hops from your addresses`}
                      </p>
                    </div>
                  )}
                  {record.discoveredInTxid && (
                    <div>
                      <span className="text-xs text-muted-foreground">Discovered in Transaction</span>
                      <TxidLink txid={record.discoveredInTxid} truncate={true} />
                    </div>
                  )}
                  {record.discoveredFromRecordId !== undefined && (
                    <div>
                      <span className="text-xs text-muted-foreground">Discovered From Record</span>
                      <Link 
                        href={`/records?id=${record.discoveredFromRecordId}`}
                        className="flex items-center gap-1 text-sm text-primary hover:underline"
                        data-testid="link-discovered-from"
                      >
                        Record #{record.discoveredFromRecordId}
                        <ExternalLink className="h-3 w-3" />
                      </Link>
                    </div>
                  )}
                  {record.type === 'address' && record.id && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full mt-2"
                      onClick={() => setDiscoveryTreeOpen(true)}
                      data-testid="button-show-discovery-tree"
                    >
                      <Network className="h-4 w-4 mr-2" />
                      Show Discovered Records
                    </Button>
                  )}
                </CollapsibleContent>
              </Collapsible>
            )}

            {record.type === 'address' && record.id && !hasBlockchainDiscoveryInfo && (
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => setDiscoveryTreeOpen(true)}
                data-testid="button-show-discovery-tree"
              >
                <Network className="h-4 w-4 mr-2" />
                Show Discovered Records
              </Button>
            )}

            <Separator />

            <div>
              <div className="flex items-center justify-between mb-4">
                <h4 className="text-sm font-medium flex items-center gap-2">
                  <Paperclip className="h-4 w-4" />
                  Attachments ({attachments.length})
                </h4>
                {!showUpload && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setShowUpload(true)}
                    data-testid="button-show-upload"
                  >
                    <Upload className="h-4 w-4 mr-2" />
                    Upload
                  </Button>
                )}
              </div>

              {showUpload && (
                <div className="mb-4">
                  <AttachmentUpload
                    recordId={Number(record.id)}
                    identifier={record.inputString}
                    onUploadComplete={handleUploadComplete}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setShowUpload(false)}
                    className="mt-2"
                    data-testid="button-cancel-upload"
                  >
                    Cancel
                  </Button>
                </div>
              )}

              <AttachmentList
                attachments={attachments}
                onDelete={onAttachmentsChange}
              />
            </div>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>

    <Dialog open={qrDialogOpen} onOpenChange={setQrDialogOpen}>
      <DialogContent className="sm:max-w-[320px]">
        <DialogHeader>
          <DialogTitle className="text-center">
            {record.type === "address" ? "Address QR Code" : "Transaction ID QR Code"}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-4">
          {qrCodeDataUrl ? (
            <img
              src={qrCodeDataUrl}
              alt="QR Code"
              className="w-64 h-64"
              data-testid="img-qr-code"
            />
          ) : (
            <div className="w-64 h-64 flex items-center justify-center bg-muted rounded">
              <span className="text-muted-foreground">Generating...</span>
            </div>
          )}
          <p className="text-xs text-muted-foreground text-center break-all px-4" data-testid="text-qr-value">
            {record.inputString}
          </p>
        </div>
      </DialogContent>
    </Dialog>
    {record.type === 'address' && record.id && (
      <DiscoveryTreeDialog
        open={discoveryTreeOpen}
        onClose={() => setDiscoveryTreeOpen(false)}
        parentRecordId={parseInt(record.id)}
        parentAddress={record.inputString}
      />
    )}
    </>
  );
}

import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useAsyncMemo, yieldToUI, checkAbort } from "@/hooks/use-async-memo";
import { useDbChangeSignal } from "@/hooks/use-db-change-signal";
import { useLiveQuery } from "dexie-react-hooks";
import { format } from "date-fns";
import { 
  db, 
  BlockchainTransaction, 
  TransactionParticipant, 
  Record,
  FlowType,
  AcquisitionMethod,
  DispositionType,
  FLOW_TYPE_OPTIONS,
  ACQUISITION_METHOD_OPTIONS,
  DISPOSITION_TYPE_OPTIONS,
} from "@/lib/database";
import { updateRecord, createRecord, getParticipantsByAddresses } from "@/lib/dataFacade";
import { uploadAttachment } from "@/lib/attachments";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import { useToast } from "@/hooks/use-toast";
import { useTags } from "@/hooks/use-tags";
import { useCategories } from "@/hooks/use-categories";
import { useOwners } from "@/hooks/use-owners";
import { useWalletNames } from "@/hooks/use-wallet-names";
import { useSeedNames } from "@/hooks/use-seed-names";
import { useWalletSoftware } from "@/hooks/use-wallet-software";
import { useCustomFields } from "@/hooks/use-settings";
import { RecordFormDialog } from "@/components/RecordFormDialog";
import { ClickableAddress } from "@/components/ClickableAddress";
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
  Sparkles,
  Pencil,
  Tag as TagIcon,
  Folder,
  User,
  Wallet,
  Key,
  Shield,
  GitBranch,
  FileText,
  Lock,
  Upload,
  X,
  File as FileIcon
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
  const [notesInputs, setNotesInputs] = useState<Map<string, string>>(new Map());
  const [tagsInputs, setTagsInputs] = useState<Map<string, string[]>>(new Map());
  const [categoriesInputs, setCategoriesInputs] = useState<Map<string, string[]>>(new Map());
  const [filesInputs, setFilesInputs] = useState<Map<string, File[]>>(new Map());
  const [customFieldsInputs, setCustomFieldsInputs] = useState<Map<string, { [slug: string]: string }>>(new Map());
  // Transaction metadata inputs
  const [flowTypeInputs, setFlowTypeInputs] = useState<Map<string, FlowType | undefined>>(new Map());
  const [acquisitionMethodInputs, setAcquisitionMethodInputs] = useState<Map<string, AcquisitionMethod | undefined>>(new Map());
  const [dispositionTypeInputs, setDispositionTypeInputs] = useState<Map<string, DispositionType | undefined>>(new Map());
  const [costBasisInputs, setCostBasisInputs] = useState<Map<string, number | undefined>>(new Map());
  const [savingTxids, setSavingTxids] = useState<Set<string>>(new Set());
  const [editingRecord, setEditingRecord] = useState<Record | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);
  const fileInputRefs = useRef<Map<string, HTMLInputElement | null>>(new Map());
  const { toast } = useToast();

  const { tags } = useTags();
  const { categories } = useCategories();
  const { owners } = useOwners();
  const { walletNames } = useWalletNames();
  const { seedNames } = useSeedNames();
  const { walletSoftware } = useWalletSoftware();
  const { enabledCustomFields } = useCustomFields();

  const txDbSignal = useDbChangeSignal(['blockchainTransactions']);

  const [allTransactionsCount, setAllTransactionsCount] = useState(0);

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

  const addressRecords = rawAddressRecords ?? [];
  const transactionRecords = rawTransactionRecords ?? [];

  const { value: participants } = useAsyncMemo(
    async (signal) => {
      if (!addressRecords || addressRecords.length === 0) {
        return undefined;
      }
      const addresses = addressRecords
        .filter(r => r.type === 'address' && r.inputString)
        .map(r => r.inputString!);
      if (addresses.length === 0) {
        return [] as TransactionParticipant[];
      }
      checkAbort(signal);
      try {
        return await getParticipantsByAddresses(addresses, signal);
      } catch (e) {
        if (signal.aborted) throw e;
        return [] as TransactionParticipant[];
      }
    },
    [addressRecords],
    undefined as TransactionParticipant[] | undefined
  );

  useEffect(() => {
    db.blockchainTransactions.count().then(count => {
      setAllTransactionsCount(count);
    }).catch(() => {});
  }, [participants]);

  const { value: transactions } = useAsyncMemo(
    async (signal) => {
      if (!participants || participants.length === 0) {
        return participants === undefined ? undefined : [];
      }
      const txids = new Set<string>();
      for (const p of participants) txids.add(p.txid);
      if (txids.size === 0) {
        return [] as BlockchainTransaction[];
      }
      checkAbort(signal);
      try {
        const txidArray = Array.from(txids);
        const batchSize = 500;
        const results: BlockchainTransaction[] = [];
        for (let i = 0; i < txidArray.length; i += batchSize) {
          checkAbort(signal);
          const batch = txidArray.slice(i, i + batchSize);
          const txs = await db.blockchainTransactions.where('txid').anyOf(batch).toArray();
          results.push(...txs);
          if (i + batchSize < txidArray.length) {
            await yieldToUI();
          }
        }
        results.sort((a, b) => (b.blockTime ?? 0) - (a.blockTime ?? 0));
        return results;
      } catch (e) {
        if (signal.aborted) throw e;
        return [] as BlockchainTransaction[];
      }
    },
    [participants, txDbSignal],
    undefined as BlockchainTransaction[] | undefined
  );

  const addressToRecord = useMemo(() => {
    const map = new Map<string, Record>();
    addressRecords.forEach(record => {
      if (record.type === 'address' && record.inputString) {
        map.set(record.inputString, record);
      }
    });
    return map;
  }, [addressRecords]);

  const txidToRecord = useMemo(() => {
    const map = new Map<string, Record>();
    transactionRecords.forEach(record => {
      if (record.type === 'transaction' && record.inputString) {
        map.set(record.inputString, record);
      }
    });
    return map;
  }, [transactionRecords]);

  const { value: transactionsWithContext, isComputing: transactionsWithContextComputing } = useAsyncMemo(async (signal) => {
    if (!transactions || !participants) return [];
    
    const participantsByTxid = new Map<string, TransactionParticipant[]>();
    for (let i = 0; i < participants.length; i++) {
      const p = participants[i];
      const existing = participantsByTxid.get(p.txid) || [];
      existing.push(p);
      participantsByTxid.set(p.txid, existing);
      if (i % 1000 === 999) {
        checkAbort(signal);
        await yieldToUI();
      }
    }

    const results: TransactionWithContext[] = [];

    for (let ti = 0; ti < transactions.length; ti++) {
      const tx = transactions[ti];
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

      if (ti % 1000 === 999) {
        checkAbort(signal);
        await yieldToUI();
      }
    }

    return results;
  }, [transactions, participants, addressToRecord, txidToRecord, sourceFilter], [] as TransactionWithContext[]);

  const groupedTransactions = useMemo(() => {
    const selfTransfers = transactionsWithContext.filter(tx => tx.groupType === 'self-transfer');
    const knownCounterparties = transactionsWithContext.filter(tx => tx.groupType === 'known-counterparty');
    const unknowns = transactionsWithContext.filter(tx => tx.groupType === 'unknown');
    
    return { selfTransfers, knownCounterparties, unknowns };
  }, [transactionsWithContext]);

  const totalUnlabeled = transactionsWithContext.length;
  const labeledCount = allTransactionsCount - totalUnlabeled;
  const progressPercent = allTransactionsCount > 0 ? (labeledCount / allTransactionsCount) * 100 : 100;

  const handleLabelChange = (txid: string, value: string) => {
    setLabelInputs(prev => new Map(prev).set(txid, value));
  };

  const handleNotesChange = (txid: string, value: string) => {
    setNotesInputs(prev => new Map(prev).set(txid, value));
  };

  const handleTagsChange = (txid: string, value: string[]) => {
    setTagsInputs(prev => new Map(prev).set(txid, value));
  };

  const handleCategoriesChange = (txid: string, value: string[]) => {
    setCategoriesInputs(prev => new Map(prev).set(txid, value));
  };

  const handleCustomFieldChange = (txid: string, slug: string, value: string) => {
    setCustomFieldsInputs(prev => {
      const next = new Map(prev);
      const existing = next.get(txid) || {};
      next.set(txid, { ...existing, [slug]: value });
      return next;
    });
  };

  const handleFileSelect = (txid: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const newFiles = Array.from(e.target.files || []);
    if (newFiles.length > 0) {
      setFilesInputs(prev => {
        const next = new Map(prev);
        const existing = next.get(txid) || [];
        next.set(txid, [...existing, ...newFiles]);
        return next;
      });
    }
  };

  const removeFile = (txid: string, index: number) => {
    setFilesInputs(prev => {
      const next = new Map(prev);
      const existing = next.get(txid) || [];
      next.set(txid, existing.filter((_, i) => i !== index));
      return next;
    });
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const clearTxFormData = (txid: string) => {
    setLabelInputs(prev => { const next = new Map(prev); next.delete(txid); return next; });
    setNotesInputs(prev => { const next = new Map(prev); next.delete(txid); return next; });
    setTagsInputs(prev => { const next = new Map(prev); next.delete(txid); return next; });
    setCategoriesInputs(prev => { const next = new Map(prev); next.delete(txid); return next; });
    setFilesInputs(prev => { const next = new Map(prev); next.delete(txid); return next; });
    setCustomFieldsInputs(prev => { const next = new Map(prev); next.delete(txid); return next; });
    // Clear transaction metadata fields
    setFlowTypeInputs(prev => { const next = new Map(prev); next.delete(txid); return next; });
    setAcquisitionMethodInputs(prev => { const next = new Map(prev); next.delete(txid); return next; });
    setDispositionTypeInputs(prev => { const next = new Map(prev); next.delete(txid); return next; });
    setCostBasisInputs(prev => { const next = new Map(prev); next.delete(txid); return next; });
  };

  const availableTagNames = useMemo(() => 
    tags.map(t => t.name).filter(n => n),
    [tags]
  );

  const availableCategoryNames = useMemo(() => 
    categories.map(c => c.name).filter(n => n),
    [categories]
  );

  const handleSaveTransaction = async (tx: TransactionWithContext) => {
    const label = labelInputs.get(tx.txid) || '';
    if (!label.trim()) {
      toast({ title: "Label required", description: "Please enter a label for this transaction", variant: "destructive" });
      return;
    }

    const notes = notesInputs.get(tx.txid) || '';
    const txTags = tagsInputs.get(tx.txid) || [];
    const txCategories = categoriesInputs.get(tx.txid) || [];
    const files = filesInputs.get(tx.txid) || [];
    const customFields = customFieldsInputs.get(tx.txid) || {};
    // Transaction metadata fields
    const flowType = flowTypeInputs.get(tx.txid);
    const acquisitionMethod = acquisitionMethodInputs.get(tx.txid);
    const dispositionType = dispositionTypeInputs.get(tx.txid);
    const costBasisUsd = costBasisInputs.get(tx.txid);

    setSavingTxids(prev => new Set(prev).add(tx.txid));

    try {
      let recordId: number;

      if (tx.existingRecordId) {
        await updateRecord(tx.existingRecordId, { 
          label: label.trim(),
          notes: notes.trim(),
          tags: txTags,
          categories: txCategories,
          customFields,
          flowType,
          acquisitionMethod,
          dispositionType,
          costBasisUsd,
        });
        recordId = tx.existingRecordId;
      } else {
        recordId = await createRecord({
          type: 'transaction',
          inputString: tx.txid,
          label: label.trim(),
          notes: notes.trim(),
          tags: txTags,
          categories: txCategories,
          customFields,
          flowType,
          acquisitionMethod,
          dispositionType,
          costBasisUsd,
        });
      }

      if (files.length > 0) {
        setUploadProgress({ current: 0, total: files.length });
        let uploadedCount = 0;
        for (let i = 0; i < files.length; i++) {
          try {
            await uploadAttachment(recordId, files[i], tx.txid);
            uploadedCount++;
          } catch (error) {
            console.error(`Failed to upload ${files[i].name}:`, error);
          }
          setUploadProgress({ current: i + 1, total: files.length });
        }
        setUploadProgress(null);
        
        if (uploadedCount < files.length) {
          toast({ 
            title: "Partial Success", 
            description: `Transaction saved with ${uploadedCount}/${files.length} files uploaded`,
            variant: "default" 
          });
        } else {
          toast({ title: "Saved", description: `Transaction saved with ${uploadedCount} file(s)` });
        }
      } else {
        toast({ title: "Saved", description: "Transaction labeled successfully" });
      }

      clearTxFormData(tx.txid);

      if (viewMode === 'focus') {
        setFocusIndex(prev => Math.max(0, Math.min(prev, transactionsWithContext.length - 2)));
      }
    } catch (error) {
      console.error('Failed to save transaction:', error);
      toast({ title: "Error", description: "Failed to save transaction", variant: "destructive" });
      setUploadProgress(null);
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
        await createRecord({
          type: 'transaction',
          inputString: tx.txid,
          label: quickLabel,
          tags: [],
          categories: []
        });
      }

      toast({ title: "Saved", description: `Labeled as "${quickLabel}"` });
      clearTxFormData(tx.txid);

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

  const handleEditAddress = (record: Record) => {
    setEditingRecord(record);
  };

  const handleSaveEdit = async (data: any, _files: File[] = []) => {
    if (!editingRecord) return;
    
    setIsSubmitting(true);
    try {
      let addressImportance = editingRecord.addressImportance || 'pending-review';
      if (data.markAsVerified || data.addressImportance === 'verified') {
        addressImportance = 'verified';
      } else if (data.addressImportance) {
        addressImportance = data.addressImportance;
      }

      const recordData = {
        type: 'address' as const,
        inputString: data.inputString,
        label: data.label || '',
        notes: data.notes || '',
        tags: data.tags || [],
        categories: data.categories || [],
        owner: data.owner || '',
        walletName: data.walletName || '',
        seedName: data.seedName || '',
        walletSoftware: data.walletSoftware || '',
        privateKeyStatus: data.privateKeyStatus || '',
        addressImportance,
        customFields: data.customFields || {},
        source: editingRecord.source || 'manual',
      };

      if (editingRecord.id) {
        await updateRecord(editingRecord.id, recordData);
        toast({ title: "Saved", description: "Address updated successfully" });
      } else {
        await createRecord(recordData);
        toast({ title: "Created", description: "Address record created successfully" });
      }
      setEditingRecord(null);
    } catch (error) {
      console.error('Failed to save record:', error);
      toast({ title: "Error", description: "Failed to save address", variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  const uniqueSeedNames = seedNames.map(s => s.name).filter(n => n);
  const uniqueWalletSoftware = walletSoftware.map(w => w.name).filter(n => n);
  const uniqueOwners = owners.map(o => o.name).filter(n => n);
  const uniqueWalletNames = walletNames.map(w => w.name).filter(n => n);

  const handleCreateAddressRecord = async (address: string) => {
    const now = Date.now();
    const newRecord: Record = {
      type: 'address',
      inputString: address,
      label: '',
      tags: [],
      categories: [],
      source: 'manual',
      addressImportance: 'pending-review',
      createdAt: now,
      updatedAt: now,
    };
    setEditingRecord(newRecord);
  };

  const renderAddressCard = (addr: TransactionWithContext['yourAddresses'][0], isYours: boolean) => {
    const r = addr.record;
    const hasMetadata = r && (r.label || r.owner || r.walletName || r.seedName || r.walletSoftware || 
                              r.derivationPath || r.privateKeyStatus || (r.tags && r.tags.length > 0) || 
                              (r.categories && r.categories.length > 0) || r.notes || r.vault);
    
    return (
      <div 
        key={`${addr.address}-${addr.role}`}
        className={`p-3 rounded-md border ${isYours ? 'bg-primary/5 border-primary/20' : 'bg-muted/50 border-muted'}`}
      >
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {addr.role === 'input' ? (
              <ArrowUpRight className="h-3 w-3 text-destructive flex-shrink-0" />
            ) : (
              <ArrowDownLeft className="h-3 w-3 text-green-600 flex-shrink-0" />
            )}
            <ClickableAddress 
              address={addr.address} 
              className="text-xs truncate"
            />
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <span className="text-xs font-medium">{formatSats(addr.amount)}</span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={(e) => {
                e.stopPropagation();
                if (r) {
                  handleEditAddress(r);
                } else {
                  handleCreateAddressRecord(addr.address);
                }
              }}
              data-testid={`button-edit-address-${addr.address.slice(0, 8)}`}
            >
              <Pencil className="h-3 w-3" />
            </Button>
          </div>
        </div>

        {r && hasMetadata ? (
          <div className="text-xs space-y-1.5">
            {r.label && (
              <div className="font-medium text-foreground">{r.label}</div>
            )}
            
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-muted-foreground">
              {r.owner && (
                <div className="flex items-center gap-1">
                  <User className="h-3 w-3 flex-shrink-0" />
                  <span className="truncate">{r.owner}</span>
                </div>
              )}
              {r.walletName && (
                <div className="flex items-center gap-1">
                  <Wallet className="h-3 w-3 flex-shrink-0" />
                  <span className="truncate">{r.walletName}</span>
                </div>
              )}
              {r.seedName && (
                <div className="flex items-center gap-1">
                  <Key className="h-3 w-3 flex-shrink-0" />
                  <span className="truncate">{r.seedName}</span>
                </div>
              )}
              {r.walletSoftware && (
                <div className="flex items-center gap-1">
                  <FileText className="h-3 w-3 flex-shrink-0" />
                  <span className="truncate">{r.walletSoftware}</span>
                </div>
              )}
              {r.derivationPath && (
                <div className="flex items-center gap-1">
                  <GitBranch className="h-3 w-3 flex-shrink-0" />
                  <span className="font-mono truncate">{r.derivationPath}</span>
                </div>
              )}
              {r.chainType && (
                <div className="flex items-center gap-1">
                  <span className="text-muted-foreground">{r.chainType === 'receive' ? 'Receive' : 'Change'}</span>
                </div>
              )}
              {r.privateKeyStatus && (
                <div className="flex items-center gap-1">
                  <Lock className="h-3 w-3 flex-shrink-0" />
                  <span className="truncate">{r.privateKeyStatus}</span>
                </div>
              )}
              {r.addressImportance && (
                <div className="flex items-center gap-1">
                  <Shield className="h-3 w-3 flex-shrink-0" />
                  <span className="truncate capitalize">{r.addressImportance.replace('-', ' ')}</span>
                </div>
              )}
            </div>

            {r.vault && r.vault.isVaultXpub && (
              <div className="mt-1 p-1.5 bg-amber-500/10 rounded text-amber-600 dark:text-amber-400">
                <div className="flex items-center gap-1 font-medium">
                  <Shield className="h-3 w-3" />
                  Multisig {r.vault.m && r.vault.n ? `(${r.vault.m}-of-${r.vault.n})` : ''}
                </div>
                {r.vault.vaultName && <div className="ml-4">{r.vault.vaultName}</div>}
                {r.vault.vaultNotes && <div className="ml-4 text-[10px] opacity-80">{r.vault.vaultNotes}</div>}
              </div>
            )}

            {r.xpub && (
              <div className="mt-1 text-[10px] text-muted-foreground/60">
                <span className="font-mono">{truncate(r.xpub, 12, 8)}</span>
              </div>
            )}

            {r.customFields && Object.keys(r.customFields).length > 0 && (
              <div className="mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                {Object.entries(r.customFields).map(([key, value]) => (
                  value && (
                    <div key={key} className="truncate">
                      <span className="opacity-60">{key}:</span> {value}
                    </div>
                  )
                ))}
              </div>
            )}

            {((r.tags && r.tags.length > 0) || (r.categories && r.categories.length > 0)) && (
              <div className="flex flex-wrap gap-1 mt-1">
                {r.tags?.map((tag, i) => (
                  <Badge key={`tag-${i}`} variant="outline" className="text-[10px] h-4 px-1">
                    <TagIcon className="h-2 w-2 mr-0.5" />
                    {tag}
                  </Badge>
                ))}
                {r.categories?.map((cat, i) => (
                  <Badge key={`cat-${i}`} variant="secondary" className="text-[10px] h-4 px-1">
                    <Folder className="h-2 w-2 mr-0.5" />
                    {cat}
                  </Badge>
                ))}
              </div>
            )}

            {r.notes && (
              <div className="mt-1 p-1.5 bg-muted/50 rounded text-muted-foreground italic">
                {r.notes.length > 100 ? `${r.notes.slice(0, 100)}...` : r.notes}
              </div>
            )}

            {r.source && (
              <div className="text-[10px] text-muted-foreground/60 mt-1">
                Source: {r.source}
              </div>
            )}
          </div>
        ) : null}
      </div>
    );
  };

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
              <div className="mt-3 space-y-3">
                <div className="flex gap-2">
                  <Input
                    placeholder="Enter a label for this transaction..."
                    value={currentLabel}
                    onChange={(e) => handleLabelChange(tx.txid, e.target.value)}
                    className="flex-1"
                    disabled={isSaving}
                    data-testid={`input-label-${tx.txid}`}
                  />
                  <Button 
                    onClick={() => handleSaveTransaction(tx)} 
                    disabled={isSaving || !currentLabel.trim()}
                    data-testid={`button-save-${tx.txid}`}
                  >
                    {isSaving ? 'Saving...' : 'Save'}
                  </Button>
                </div>

                {tx.groupType === 'self-transfer' && (
                  <div className="flex gap-2 flex-wrap">
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

                <Textarea
                  placeholder="Notes (optional)..."
                  value={notesInputs.get(tx.txid) || ''}
                  onChange={(e) => handleNotesChange(tx.txid, e.target.value)}
                  disabled={isSaving}
                  rows={2}
                  className="text-sm"
                  data-testid={`input-notes-${tx.txid}`}
                />

                {/* Transaction Metadata Section */}
                <div className="p-3 bg-muted/30 rounded-lg border space-y-2">
                  <h5 className="font-medium text-xs flex items-center gap-1.5 text-muted-foreground">
                    <ArrowUpRight className="h-3 w-3" />
                    Transaction Details
                  </h5>
                  
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs text-muted-foreground mb-1 block">Flow Type</Label>
                      <Select
                        value={flowTypeInputs.get(tx.txid) || ""}
                        onValueChange={(value) => {
                          const newFlowType = value as FlowType;
                          setFlowTypeInputs(prev => new Map(prev).set(tx.txid, newFlowType));
                          // Clear both conditional fields when flow type changes
                          // Only the relevant one will be shown based on new flow type
                          setAcquisitionMethodInputs(prev => { const next = new Map(prev); next.delete(tx.txid); return next; });
                          setDispositionTypeInputs(prev => { const next = new Map(prev); next.delete(tx.txid); return next; });
                        }}
                        disabled={isSaving}
                      >
                        <SelectTrigger className="h-8 text-sm" data-testid={`select-flow-type-${tx.txid}`}>
                          <SelectValue placeholder="Select..." />
                        </SelectTrigger>
                        <SelectContent>
                          {FLOW_TYPE_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {flowTypeInputs.get(tx.txid) === 'received' && (
                      <div>
                        <Label className="text-xs text-muted-foreground mb-1 block">Acquisition Method</Label>
                        <Select
                          value={acquisitionMethodInputs.get(tx.txid) || ""}
                          onValueChange={(value) => setAcquisitionMethodInputs(prev => new Map(prev).set(tx.txid, value as AcquisitionMethod))}
                          disabled={isSaving}
                        >
                          <SelectTrigger className="h-8 text-sm" data-testid={`select-acquisition-${tx.txid}`}>
                            <SelectValue placeholder="How acquired?" />
                          </SelectTrigger>
                          <SelectContent>
                            {ACQUISITION_METHOD_OPTIONS.map((opt) => (
                              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    {flowTypeInputs.get(tx.txid) === 'sent' && (
                      <div>
                        <Label className="text-xs text-muted-foreground mb-1 block">Disposition Type</Label>
                        <Select
                          value={dispositionTypeInputs.get(tx.txid) || ""}
                          onValueChange={(value) => setDispositionTypeInputs(prev => new Map(prev).set(tx.txid, value as DispositionType))}
                          disabled={isSaving}
                        >
                          <SelectTrigger className="h-8 text-sm" data-testid={`select-disposition-${tx.txid}`}>
                            <SelectValue placeholder="Why sent?" />
                          </SelectTrigger>
                          <SelectContent>
                            {DISPOSITION_TYPE_OPTIONS.map((opt) => (
                              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </div>

                  {(flowTypeInputs.get(tx.txid) === 'received' || flowTypeInputs.get(tx.txid) === 'sent') && (
                    <div>
                      <Label className="text-xs text-muted-foreground mb-1 block">
                        {flowTypeInputs.get(tx.txid) === 'received' ? 'Cost Basis (USD)' : 'Disposal Value (USD)'}
                      </Label>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        value={costBasisInputs.get(tx.txid) || ""}
                        onChange={(e) => setCostBasisInputs(prev => 
                          new Map(prev).set(tx.txid, e.target.value ? parseFloat(e.target.value) : undefined)
                        )}
                        placeholder={flowTypeInputs.get(tx.txid) === 'received' ? "What you paid" : "Value received"}
                        disabled={isSaving}
                        className="h-8 text-sm"
                        data-testid={`input-cost-basis-${tx.txid}`}
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        Optional. Attach a receipt as proof.
                      </p>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs text-muted-foreground mb-1 block">Tags</Label>
                    <MultiSelectCombobox
                      values={tagsInputs.get(tx.txid) || []}
                      onChange={(vals) => handleTagsChange(tx.txid, vals)}
                      options={availableTagNames}
                      onAddNew={(val) => handleTagsChange(tx.txid, [...(tagsInputs.get(tx.txid) || []), val])}
                      placeholder="Tags..."
                      searchPlaceholder="Search or add..."
                      disabled={isSaving}
                      testId={`select-tags-${tx.txid}`}
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground mb-1 block">Categories</Label>
                    <MultiSelectCombobox
                      values={categoriesInputs.get(tx.txid) || []}
                      onChange={(vals) => handleCategoriesChange(tx.txid, vals)}
                      options={availableCategoryNames}
                      onAddNew={(val) => handleCategoriesChange(tx.txid, [...(categoriesInputs.get(tx.txid) || []), val])}
                      placeholder="Categories..."
                      searchPlaceholder="Search or add..."
                      disabled={isSaving}
                      testId={`select-categories-${tx.txid}`}
                    />
                  </div>
                </div>

                <div>
                  <Label className="text-xs text-muted-foreground mb-1 block">Attachments</Label>
                  <input
                    type="file"
                    multiple
                    ref={(el) => fileInputRefs.current.set(tx.txid, el)}
                    onChange={(e) => handleFileSelect(tx.txid, e)}
                    className="hidden"
                    id={`file-select-${tx.txid}`}
                    disabled={isSaving}
                  />
                  <label
                    htmlFor={`file-select-${tx.txid}`}
                    className={`flex items-center justify-center gap-2 border border-dashed rounded-md p-2 cursor-pointer transition-colors text-sm ${
                      isSaving ? "opacity-50 cursor-not-allowed" : "hover:bg-muted/50"
                    }`}
                  >
                    <Upload className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">Add files</span>
                  </label>
                  {(filesInputs.get(tx.txid) || []).length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {(filesInputs.get(tx.txid) || []).map((file, idx) => (
                        <Badge key={idx} variant="secondary" className="text-xs gap-1">
                          <FileIcon className="h-3 w-3" />
                          {file.name.length > 15 ? `${file.name.slice(0, 12)}...` : file.name}
                          <button 
                            onClick={() => removeFile(tx.txid, idx)}
                            className="ml-1 hover:text-destructive"
                            disabled={isSaving}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>

                {enabledCustomFields.length > 0 && (
                  <div className="grid grid-cols-2 gap-2">
                    {enabledCustomFields.map((field) => (
                      <div key={field.slug}>
                        <Label className="text-xs text-muted-foreground mb-1 block">{field.name}</Label>
                        <Input
                          value={(customFieldsInputs.get(tx.txid) || {})[field.slug] || ''}
                          onChange={(e) => handleCustomFieldChange(tx.txid, field.slug, e.target.value)}
                          disabled={isSaving}
                          className="h-8 text-sm"
                          data-testid={`input-custom-${field.slug}-${tx.txid}`}
                        />
                      </div>
                    ))}
                  </div>
                )}

                {uploadProgress && (
                  <div className="text-xs text-muted-foreground">
                    Uploading files... {uploadProgress.current}/{uploadProgress.total}
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
              <div className="space-y-4">
                <Input
                  placeholder="Enter a descriptive label..."
                  value={currentLabel}
                  onChange={(e) => handleLabelChange(tx.txid, e.target.value)}
                  disabled={isSaving}
                  className="text-lg"
                  data-testid="input-focus-label"
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

                <div>
                  <Label className="text-sm font-medium mb-2 block">Notes</Label>
                  <Textarea
                    placeholder="Add any additional context or details..."
                    value={notesInputs.get(tx.txid) || ''}
                    onChange={(e) => handleNotesChange(tx.txid, e.target.value)}
                    disabled={isSaving}
                    rows={3}
                    data-testid="input-focus-notes"
                  />
                </div>

                {/* Transaction Metadata Section */}
                <div className="p-4 bg-muted/30 rounded-lg border space-y-3">
                  <h5 className="font-medium text-sm flex items-center gap-2">
                    <ArrowUpRight className="h-4 w-4" />
                    Transaction Details
                  </h5>
                  
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label className="text-sm font-medium mb-2 block">Flow Type</Label>
                      <Select
                        value={flowTypeInputs.get(tx.txid) || ""}
                        onValueChange={(value) => {
                          const newFlowType = value as FlowType;
                          setFlowTypeInputs(prev => new Map(prev).set(tx.txid, newFlowType));
                          // Clear both conditional fields when flow type changes
                          // Only the relevant one will be shown based on new flow type
                          setAcquisitionMethodInputs(prev => { const next = new Map(prev); next.delete(tx.txid); return next; });
                          setDispositionTypeInputs(prev => { const next = new Map(prev); next.delete(tx.txid); return next; });
                        }}
                        disabled={isSaving}
                      >
                        <SelectTrigger data-testid="select-focus-flow-type">
                          <SelectValue placeholder="Select flow type..." />
                        </SelectTrigger>
                        <SelectContent>
                          {FLOW_TYPE_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {flowTypeInputs.get(tx.txid) === 'received' && (
                      <div>
                        <Label className="text-sm font-medium mb-2 block">Acquisition Method</Label>
                        <Select
                          value={acquisitionMethodInputs.get(tx.txid) || ""}
                          onValueChange={(value) => setAcquisitionMethodInputs(prev => new Map(prev).set(tx.txid, value as AcquisitionMethod))}
                          disabled={isSaving}
                        >
                          <SelectTrigger data-testid="select-focus-acquisition">
                            <SelectValue placeholder="How did you acquire this?" />
                          </SelectTrigger>
                          <SelectContent>
                            {ACQUISITION_METHOD_OPTIONS.map((opt) => (
                              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    {flowTypeInputs.get(tx.txid) === 'sent' && (
                      <div>
                        <Label className="text-sm font-medium mb-2 block">Disposition Type</Label>
                        <Select
                          value={dispositionTypeInputs.get(tx.txid) || ""}
                          onValueChange={(value) => setDispositionTypeInputs(prev => new Map(prev).set(tx.txid, value as DispositionType))}
                          disabled={isSaving}
                        >
                          <SelectTrigger data-testid="select-focus-disposition">
                            <SelectValue placeholder="Why was this sent?" />
                          </SelectTrigger>
                          <SelectContent>
                            {DISPOSITION_TYPE_OPTIONS.map((opt) => (
                              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </div>

                  {(flowTypeInputs.get(tx.txid) === 'received' || flowTypeInputs.get(tx.txid) === 'sent') && (
                    <div>
                      <Label className="text-sm font-medium mb-2 block">
                        {flowTypeInputs.get(tx.txid) === 'received' ? 'Cost Basis (USD)' : 'Disposal Value (USD)'}
                      </Label>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        value={costBasisInputs.get(tx.txid) || ""}
                        onChange={(e) => setCostBasisInputs(prev => 
                          new Map(prev).set(tx.txid, e.target.value ? parseFloat(e.target.value) : undefined)
                        )}
                        placeholder={flowTypeInputs.get(tx.txid) === 'received' ? "What you paid in USD" : "Value received in USD"}
                        disabled={isSaving}
                        data-testid="input-focus-cost-basis"
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        Optional. If left blank, historical market price data will be used. Attach a receipt as proof.
                      </p>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label className="text-sm font-medium mb-2 block">Tags</Label>
                    <MultiSelectCombobox
                      values={tagsInputs.get(tx.txid) || []}
                      onChange={(vals) => handleTagsChange(tx.txid, vals)}
                      options={availableTagNames}
                      onAddNew={(val) => handleTagsChange(tx.txid, [...(tagsInputs.get(tx.txid) || []), val])}
                      placeholder="Select or add tags..."
                      searchPlaceholder="Search or add new..."
                      disabled={isSaving}
                      testId="select-focus-tags"
                    />
                  </div>
                  <div>
                    <Label className="text-sm font-medium mb-2 block">Categories</Label>
                    <MultiSelectCombobox
                      values={categoriesInputs.get(tx.txid) || []}
                      onChange={(vals) => handleCategoriesChange(tx.txid, vals)}
                      options={availableCategoryNames}
                      onAddNew={(val) => handleCategoriesChange(tx.txid, [...(categoriesInputs.get(tx.txid) || []), val])}
                      placeholder="Select or add categories..."
                      searchPlaceholder="Search or add new..."
                      disabled={isSaving}
                      testId="select-focus-categories"
                    />
                  </div>
                </div>

                <div>
                  <Label className="text-sm font-medium mb-2 block">Attachments</Label>
                  <input
                    type="file"
                    multiple
                    ref={(el) => fileInputRefs.current.set(`focus-${tx.txid}`, el)}
                    onChange={(e) => handleFileSelect(tx.txid, e)}
                    className="hidden"
                    id={`file-select-focus-${tx.txid}`}
                    disabled={isSaving}
                  />
                  <label
                    htmlFor={`file-select-focus-${tx.txid}`}
                    className={`flex items-center justify-center gap-2 border-2 border-dashed rounded-md p-4 cursor-pointer transition-colors ${
                      isSaving ? "opacity-50 cursor-not-allowed" : "hover:bg-muted/50"
                    }`}
                  >
                    <Upload className="h-5 w-5 text-muted-foreground" />
                    <span className="text-muted-foreground">Click to attach receipts, invoices, or other files</span>
                  </label>
                  {(filesInputs.get(tx.txid) || []).length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {(filesInputs.get(tx.txid) || []).map((file, idx) => (
                        <div
                          key={idx}
                          className="flex items-center gap-2 p-2 bg-muted rounded-md"
                        >
                          <FileIcon className="h-4 w-4 text-muted-foreground" />
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate max-w-[150px]">{file.name}</p>
                            <p className="text-xs text-muted-foreground">{formatFileSize(file.size)}</p>
                          </div>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            onClick={() => removeFile(tx.txid, idx)}
                            disabled={isSaving}
                            className="h-6 w-6"
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {enabledCustomFields.length > 0 && (
                  <div>
                    <Label className="text-sm font-medium mb-2 block">Custom Fields</Label>
                    <div className="grid grid-cols-2 gap-4">
                      {enabledCustomFields.map((field) => (
                        <div key={field.slug}>
                          <Label className="text-xs text-muted-foreground mb-1 block">{field.name}</Label>
                          <Input
                            value={(customFieldsInputs.get(tx.txid) || {})[field.slug] || ''}
                            onChange={(e) => handleCustomFieldChange(tx.txid, field.slug, e.target.value)}
                            disabled={isSaving}
                            data-testid={`input-focus-custom-${field.slug}`}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {uploadProgress && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Progress value={(uploadProgress.current / uploadProgress.total) * 100} className="flex-1 h-2" />
                    <span>Uploading {uploadProgress.current}/{uploadProgress.total}</span>
                  </div>
                )}

                <Button 
                  onClick={() => handleSaveTransaction(tx)} 
                  disabled={isSaving || !currentLabel.trim()}
                  className="w-full"
                  data-testid="button-focus-save"
                >
                  {isSaving ? 'Saving...' : 'Save & Continue'}
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

      <RecordFormDialog
        open={editingRecord !== null}
        onClose={() => setEditingRecord(null)}
        onSave={handleSaveEdit}
        initialData={editingRecord ? {
          inputString: editingRecord.inputString,
          label: editingRecord.label || '',
          type: editingRecord.type,
          notes: editingRecord.notes || '',
          tags: editingRecord.tags || [],
          categories: editingRecord.categories || [],
          seedName: editingRecord.seedName || '',
          walletSoftware: editingRecord.walletSoftware || '',
          owner: editingRecord.owner || '',
          walletName: editingRecord.walletName || '',
          privateKeyStatus: editingRecord.privateKeyStatus || '',
          addressImportance: editingRecord.addressImportance,
          customFields: editingRecord.customFields || {},
        } : undefined}
        isSubmitting={isSubmitting}
        availableSeedNames={uniqueSeedNames}
        availableWalletSoftware={uniqueWalletSoftware}
        availableOwners={uniqueOwners}
        availableWalletNames={uniqueWalletNames}
        availableTags={availableTagNames}
        availableCategories={availableCategoryNames}
      />
    </div>
  );
}

import { useState, useEffect, useRef, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { 
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Trash2, Search, RefreshCw, AlertTriangle, CheckCircle2, Network, ArrowUpDown, Link2, Shield, XCircle, ChevronLeft, ChevronRight, Unplug } from "lucide-react";
import { db, Record, RecordOrigin } from "@/lib/database";
import { deleteRecord, getParticipantsByTxids, countAttachmentsByRecordIds } from "@/lib/dataFacade";
import { getRecord } from "@/lib/data/record-crud";
import { deleteRecordOriginsByRecordId } from "@/lib/data/record-origins-crud";
import { recomputeAddressStats } from "@/lib/data/address-stats";
import { yieldToUI } from "@/hooks/use-async-memo";

type Scope = 'addresses' | 'transactions' | 'both';
type ScanMode = 'blockchain-only' | 'discovery-origin' | 'unconnected';
type SortField = 'type' | 'address' | 'depth' | 'discoveredFrom';
type SortDirection = 'asc' | 'desc';

const PAGE_SIZE = 100;

interface CleanupCandidate {
  record: Record;
  origins: RecordOrigin[];
  hasOtherConnections: boolean;
  connectedToKnown: boolean;
}

const isBlockchainOnlyRecord = (record: Record, origins: RecordOrigin[]): boolean => {
  if (origins.length > 0) {
    if (origins.some(o => o.originType !== 'blockchain-sync')) return false;
  } else {
    const hasBlockchainSource = record.source === 'blockchain-sync';
    const hasBlockchainImportance = record.addressImportance !== undefined &&
      ['blockchain-discovered', 'pending-review'].includes(record.addressImportance);
    if (!hasBlockchainSource && !hasBlockchainImportance) return false;
  }
  if (record.source && !['blockchain-sync'].includes(record.source)) return false;
  if (record.addressImportance && !['blockchain-discovered', 'pending-review'].includes(record.addressImportance)) return false;
  if (record.syncDepth === 0) return false;
  return true;
};

// Placeholder values written by blockchain sync, NOT real user-entered metadata.
// A sync-discovered record is created with owner='Pending Review' (and older
// data may carry 'Pending Review' as a stale label/notes). Treating these
// sentinels as genuine user metadata wrongly shields auto-discovered records
// from cleanup, leaving the user unable to remove them.
const SYNC_PLACEHOLDER = 'Pending Review';

const isMeaningfulText = (value: string | undefined | null): boolean =>
  !!value && value.trim() !== '' && value.trim() !== SYNC_PLACEHOLDER;

const hasUserMetadata = (record: Record, origins: RecordOrigin[]): boolean => {
  if (isMeaningfulText(record.label)) return true;
  if (isMeaningfulText(record.notes)) return true;
  if (record.tags && record.tags.length > 0) return true;
  if (record.categories && record.categories.length > 0) return true;
  if (isMeaningfulText(record.owner)) return true;
  if (record.walletName) return true;
  if (record.seedName) return true;
  if (record.walletSoftware) return true;
  if (record.privateKeyStatus && record.privateKeyStatus !== 'unknown') return true;
  if (record.customFields && Object.keys(record.customFields).length > 0) return true;
  if (record.counterpartyType) return true;
  if (record.flowType) return true;
  if (record.acquisitionMethod) return true;
  if (record.dispositionType) return true;
  if (record.costBasisUsd !== undefined && record.costBasisUsd !== null) return true;
  for (const origin of origins) {
    if (isMeaningfulText(origin.label)) return true;
    if (isMeaningfulText(origin.notes)) return true;
    if (origin.tags && origin.tags.length > 0) return true;
    if (origin.categories && origin.categories.length > 0) return true;
    if (isMeaningfulText(origin.owner)) return true;
    if (origin.walletName) return true;
    if (origin.seedName) return true;
    if (origin.walletSoftware) return true;
    if (origin.privateKeyStatus && origin.privateKeyStatus !== 'unknown') return true;
    if (origin.source && origin.source.trim() !== '') return true;
    if (origin.xpub) return true;
    if (origin.derivationPath) return true;
  }
  return false;
};

async function bulkGetOriginsByRecordId(recordIds: Set<number>): Promise<Map<number, RecordOrigin[]>> {
  if (recordIds.size === 0) return new Map();
  const idsArray = Array.from(recordIds);
  const CHUNK = 200;
  const grouped = new Map<number, RecordOrigin[]>();
  const key = null;

  for (let i = 0; i < idsArray.length; i += CHUNK) {
    const chunk = idsArray.slice(i, i + CHUNK);
    const batch = await db.recordOrigins
      .where('recordId')
      .anyOf(chunk)
      .toArray();

    for (const origin of batch) {
      if (!grouped.has(origin.recordId)) {
        grouped.set(origin.recordId, []);
      }
      grouped.get(origin.recordId)!.push(origin);
    }
  }
  return grouped;
}

async function buildKnownRecordSets(onProgress: (msg: string) => void): Promise<{ knownAddresses: Set<string>; knownRecordIds: Set<number> }> {
  onProgress('Building known address index...');
  await yieldToUI();
  const knownRecords = await db.records
    .where('[type+addressImportance]')
    .anyOf([
      ['address', 'verified'],
      ['address', 'manual'],
      ['address', 'wallet-import'],
      ['address', 'xpub-derived'],
    ])
    .toArray();
  const knownAddresses = new Set<string>();
  const knownRecordIds = new Set<number>();
  for (const r of knownRecords) {
    if (r.inputString) {
      knownAddresses.add(r.inputString.trim().toLowerCase());
    }
    if (r.id) {
      knownRecordIds.add(r.id);
    }
  }
  return { knownAddresses, knownRecordIds };
}

async function checkTransactionConnections(
  candidateIds: Set<number>,
  onProgress: (msg: string) => void,
  signal: AbortSignal,
): Promise<Set<number>> {
  const { knownAddresses, knownRecordIds } = await buildKnownRecordSets(onProgress);
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

  onProgress('Finding candidate transactions...');
  await yieldToUI();

  const candidateRecordIds = Array.from(candidateIds);
  const candidateTxids = new Set<string>();
  const CHUNK = 500;
  for (let i = 0; i < candidateRecordIds.length; i += CHUNK) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const chunk = candidateRecordIds.slice(i, i + CHUNK);
    const participants = await db.transactionParticipants
      .where('recordId')
      .anyOf(chunk)
      .toArray();
    for (const p of participants) {
      candidateTxids.add(p.txid);
    }
    if (i % 2000 === 0) {
      onProgress(`Finding candidate transactions... ${Math.min(i + CHUNK, candidateRecordIds.length).toLocaleString()}/${candidateRecordIds.length.toLocaleString()}`);
      await yieldToUI();
    }
  }

  if (candidateTxids.size === 0) return new Set();

  onProgress(`Loading participants for ${candidateTxids.size.toLocaleString()} transactions...`);
  await yieldToUI();

  const relevantParticipants = await getParticipantsByTxids(Array.from(candidateTxids));
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

  onProgress('Analyzing transaction connections...');
  await yieldToUI();

  const txToParticipants = new Map<string, Array<{ address: string; recordId?: number }>>();
  for (const p of relevantParticipants) {
    if (!txToParticipants.has(p.txid)) {
      txToParticipants.set(p.txid, []);
    }
    txToParticipants.get(p.txid)!.push({ address: p.address, recordId: p.recordId });
  }

  const connectedCandidateIds = new Set<number>();
  const candidateIdSet = new Set<number>(candidateIds);

  const txEntries = Array.from(txToParticipants.entries());
  const totalTx = txEntries.length;
  for (let i = 0; i < totalTx; i++) {
    const participants = txEntries[i][1];
    const candidatesInTx: number[] = [];
    let hasKnownParticipant = false;

    for (const p of participants) {
      const normalizedAddr = p.address.trim().toLowerCase();
      if (p.recordId && candidateIdSet.has(p.recordId)) {
        candidatesInTx.push(p.recordId);
      }
      if (knownAddresses.has(normalizedAddr)) {
        hasKnownParticipant = true;
      }
      if (p.recordId && knownRecordIds.has(p.recordId)) {
        hasKnownParticipant = true;
      }
    }

    if (hasKnownParticipant) {
      for (const cid of candidatesInTx) {
        connectedCandidateIds.add(cid);
      }
    }

    if (i % 2000 === 1999) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      onProgress(`Analyzing transactions... ${Math.round((i / totalTx) * 100)}%`);
      await yieldToUI();
    }
  }

  return connectedCandidateIds;
}

export default function Cleanup() {
  const { toast } = useToast();
  const [scanMode, setScanMode] = useState<ScanMode>('blockchain-only');
  const [scope, setScope] = useState<Scope>('both');
  const [candidates, setCandidates] = useState<CleanupCandidate[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [isScanning, setIsScanning] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [attachmentImpact, setAttachmentImpact] = useState<number | null>(null);
  const [hasScanned, setHasScanned] = useState(false);
  const [originAddress, setOriginAddress] = useState('');
  const [sortField, setSortField] = useState<SortField>('depth');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [scanProgress, setScanProgress] = useState('');
  const [deleteProgress, setDeleteProgress] = useState({ current: 0, total: 0 });
  const [page, setPage] = useState(0);

  const [syncedAddresses, setSyncedAddresses] = useState<{ id: number; address: string }[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const loadSyncedAddresses = async () => {
      const allRecords = await db.records
        .where('[type+addressImportance]')
        .anyOf([
          ['address', 'verified'],
          ['address', 'manual'],
          ['address', 'wallet-import'],
          ['address', 'xpub-derived'],
        ])
        .toArray();
      const synced = allRecords
        .filter(r => r.id && (r.maxSyncedDepth !== undefined && r.maxSyncedDepth >= 0))
        .map(r => ({ id: r.id!, address: r.inputString }));
      setSyncedAddresses(synced);
    };
    loadSyncedAddresses();
  }, []);

  const cancelScan = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  const scanBlockchainOnly = async (signal: AbortSignal) => {
    setScanProgress('Loading candidate records...');
    await yieldToUI();

    let records: Record[] = [];
    const CANDIDATE_TIERS = ['blockchain-discovered', 'pending-review'];

    if (scope === 'addresses' || scope === 'both') {
      const addressRecords = await db.records
        .where('[type+addressImportance]')
        .anyOf(CANDIDATE_TIERS.map(tier => ['address', tier]))
        .toArray();
      for (const r of addressRecords) records.push(r);
    }
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    if (scope === 'transactions' || scope === 'both') {
      const txRecords = await db.records
        .where('[type+addressImportance]')
        .anyOf(CANDIDATE_TIERS.map(tier => ['transaction', tier]))
        .toArray();
      const txNoImportance = await db.records
        .where('type').equals('transaction')
        .filter(r => !r.addressImportance)
        .toArray();
      for (const r of txRecords) records.push(r);
      for (const r of txNoImportance) records.push(r);
    }
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    const potentialCandidates = records.filter(r => r.syncDepth !== 0);
    const total = potentialCandidates.length;

    const BATCH_SIZE = 200;
    const totalBatches = Math.ceil(total / BATCH_SIZE);
    const cleanupCandidates: CleanupCandidate[] = [];
    const candidateIds = new Set<number>();

    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const batchStart = batchIdx * BATCH_SIZE;
      const batch = potentialCandidates.slice(batchStart, batchStart + BATCH_SIZE);
      const processed = batchStart + batch.length;

      setScanProgress(`Checking records... ${processed.toLocaleString()}/${total.toLocaleString()} (${Math.round((processed / total) * 100)}%)`);
      await yieldToUI();

      const batchRecordIds = new Set<number>();
      for (const r of batch) {
        if (r.id) batchRecordIds.add(r.id);
      }
      const originsMap = await bulkGetOriginsByRecordId(batchRecordIds);

      for (const record of batch) {
        if (!record.id) continue;
        const origins = originsMap.get(record.id) || [];
        if (isBlockchainOnlyRecord(record, origins) && !hasUserMetadata(record, origins)) {
          cleanupCandidates.push({ record, origins, hasOtherConnections: false, connectedToKnown: false });
          candidateIds.add(record.id);
        }
      }
    }

    if (cleanupCandidates.length > 0 && !signal.aborted) {
      const connectedIds = await checkTransactionConnections(candidateIds, setScanProgress, signal);
      for (const candidate of cleanupCandidates) {
        if (candidate.record.id && connectedIds.has(candidate.record.id)) {
          candidate.connectedToKnown = true;
        }
      }
    }

    return cleanupCandidates;
  };

  const scanDiscoveryOrigin = async (signal: AbortSignal) => {
    const trimmed = originAddress.trim();
    if (!trimmed) {
      toast({ title: "No Address Selected", description: "Enter a parent address to filter by discovery origin", variant: "destructive" });
      return [];
    }

    setScanProgress('Finding parent address...');
    await yieldToUI();

    const parentRecords = await db.records
      .filter(r => r.inputString === trimmed && r.type === 'address')
      .toArray();

    if (parentRecords.length === 0) {
      toast({ title: "Address Not Found", description: "This address is not in your records", variant: "destructive" });
      return [];
    }

    const parentRecord = parentRecords[0];
    if (!parentRecord.id) return [];

    setScanProgress('Traversing discovery tree...');
    await yieldToUI();

    const allDiscovered: Record[] = [];
    let currentParentIds = [parentRecord.id];
    let depth = 0;

    while (currentParentIds.length > 0 && depth < 50) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const children = await db.records
        .where('discoveredFromRecordId')
        .anyOf(currentParentIds)
        .toArray();

      if (children.length === 0) break;
      for (const r of children) allDiscovered.push(r);
      setScanProgress(`Discovery tree depth ${depth + 1}: ${allDiscovered.length.toLocaleString()} records found...`);
      await yieldToUI();
      currentParentIds = children.map(r => r.id).filter((id): id is number => id !== undefined);
      depth++;
    }

    const discoveryTreeIds = new Set<number>([parentRecord.id, ...allDiscovered.map(r => r.id!).filter(Boolean)]);
    const recordIds = new Set<number>(allDiscovered.map(r => r.id!).filter(Boolean));

    setScanProgress(`Loading origins for ${allDiscovered.length.toLocaleString()} records...`);
    await yieldToUI();
    const originsMap = await bulkGetOriginsByRecordId(recordIds);

    const cleanupCandidates: CleanupCandidate[] = [];
    const candidateIds = new Set<number>();

    for (let i = 0; i < allDiscovered.length; i++) {
      const record = allDiscovered[i];
      if (!record.id) continue;
      const origins = originsMap.get(record.id) || [];

      let hasOtherConn = false;
      if (record.discoveredFromRecordId !== undefined && !discoveryTreeIds.has(record.discoveredFromRecordId)) {
        hasOtherConn = true;
      }
      if (!hasOtherConn) {
        const childrenOutside = await db.records
          .where('discoveredFromRecordId')
          .equals(record.id)
          .filter(r => r.id !== undefined && !discoveryTreeIds.has(r.id))
          .count();
        if (childrenOutside > 0) hasOtherConn = true;
      }

      cleanupCandidates.push({ record, origins, hasOtherConnections: hasOtherConn, connectedToKnown: false });
      candidateIds.add(record.id);

      if (i % 100 === 99) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        setScanProgress(`Checking connections... ${i + 1}/${allDiscovered.length}`);
        await yieldToUI();
      }
    }

    if (cleanupCandidates.length > 0 && !signal.aborted) {
      const connectedIds = await checkTransactionConnections(candidateIds, setScanProgress, signal);
      for (const candidate of cleanupCandidates) {
        if (candidate.record.id && connectedIds.has(candidate.record.id)) {
          candidate.connectedToKnown = true;
        }
      }
    }

    return cleanupCandidates;
  };

  const scanUnconnected = async (signal: AbortSignal) => {
    setScanProgress('Loading candidate records...');
    await yieldToUI();

    let records: Record[] = [];
    const CANDIDATE_TIERS = ['blockchain-discovered', 'pending-review'];

    if (scope === 'addresses' || scope === 'both') {
      const addressRecords = await db.records
        .where('[type+addressImportance]')
        .anyOf(CANDIDATE_TIERS.map(tier => ['address', tier]))
        .toArray();
      for (const r of addressRecords) records.push(r);
    }
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    if (scope === 'transactions' || scope === 'both') {
      const txRecords = await db.records
        .where('[type+addressImportance]')
        .anyOf(CANDIDATE_TIERS.map(tier => ['transaction', tier]))
        .toArray();
      const txNoImportance = await db.records
        .where('type').equals('transaction')
        .filter(r => !r.addressImportance)
        .toArray();
      for (const r of txRecords) records.push(r);
      for (const r of txNoImportance) records.push(r);
    }
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    const potentialCandidates = records.filter(r => r.syncDepth !== 0);
    const total = potentialCandidates.length;

    const BATCH_SIZE = 200;
    const totalBatches = Math.ceil(total / BATCH_SIZE);
    const allBlockchainOnly: CleanupCandidate[] = [];
    const allCandidateIds = new Set<number>();

    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const batchStart = batchIdx * BATCH_SIZE;
      const batch = potentialCandidates.slice(batchStart, batchStart + BATCH_SIZE);
      const processed = batchStart + batch.length;

      setScanProgress(`Checking records... ${processed.toLocaleString()}/${total.toLocaleString()} (${Math.round((processed / total) * 100)}%)`);
      await yieldToUI();

      const batchRecordIds = new Set<number>();
      for (const r of batch) {
        if (r.id) batchRecordIds.add(r.id);
      }
      const originsMap = await bulkGetOriginsByRecordId(batchRecordIds);

      for (const record of batch) {
        if (!record.id) continue;
        const origins = originsMap.get(record.id) || [];
        if (isBlockchainOnlyRecord(record, origins) && !hasUserMetadata(record, origins)) {
          allBlockchainOnly.push({ record, origins, hasOtherConnections: false, connectedToKnown: false });
          allCandidateIds.add(record.id);
        }
      }
    }

    if (allBlockchainOnly.length > 0 && !signal.aborted) {
      const connectedIds = await checkTransactionConnections(allCandidateIds, setScanProgress, signal);
      const unconnectedCandidates: CleanupCandidate[] = [];
      for (const candidate of allBlockchainOnly) {
        if (candidate.record.id && connectedIds.has(candidate.record.id)) {
          candidate.connectedToKnown = true;
        }
        if (!candidate.connectedToKnown) {
          unconnectedCandidates.push(candidate);
        }
      }
      return unconnectedCandidates;
    }

    return allBlockchainOnly;
  };

  const scanForCandidates = async () => {
    cancelScan();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsScanning(true);
    setCandidates([]);
    setSelectedIds(new Set());
    setHasScanned(false);
    setScanProgress('');
    setPage(0);

    try {
      let result: CleanupCandidate[] = [];

      if (scanMode === 'blockchain-only') {
        result = await scanBlockchainOnly(controller.signal);
      } else if (scanMode === 'discovery-origin') {
        result = await scanDiscoveryOrigin(controller.signal);
      } else if (scanMode === 'unconnected') {
        result = await scanUnconnected(controller.signal);
      }

      setCandidates(result);
      setHasScanned(true);

      const connectedCount = result.filter(c => c.connectedToKnown).length;
      const modeLabel = scanMode === 'unconnected' ? 'unconnected' : 'cleanup';
      toast({
        title: "Scan Complete",
        description: `Found ${result.length.toLocaleString()} ${modeLabel} candidates${connectedCount > 0 ? ` (${connectedCount.toLocaleString()} connected to known addresses)` : ''}`,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        toast({ title: "Scan Cancelled", description: "The scan was stopped" });
        return;
      }
      console.error('Error scanning for cleanup candidates:', error);
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      toast({ title: "Scan Failed", description: `An error occurred while scanning: ${errMsg}`, variant: "destructive" });
    } finally {
      setIsScanning(false);
      setScanProgress('');
      abortControllerRef.current = null;
    }
  };

  const toggleSelection = (id: number) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  const selectAll = () => {
    setSelectedIds(new Set(candidates.map(c => c.record.id!)));
  };

  const selectNone = () => {
    setSelectedIds(new Set());
  };

  const selectSafe = () => {
    const safeIds = new Set(
      candidates
        .filter(c => !c.hasOtherConnections && !c.connectedToKnown && !hasUserMetadata(c.record, c.origins))
        .map(c => c.record.id!)
    );
    setSelectedIds(safeIds);
  };

  const openConfirmDialog = async () => {
    setAttachmentImpact(null);
    setShowConfirmDialog(true);
    try {
      const count = await countAttachmentsByRecordIds(Array.from(selectedIds));
      setAttachmentImpact(count);
    } catch (error) {
      console.error('Failed to count affected attachments:', error);
      setAttachmentImpact(null);
    }
  };

  const handleDelete = async () => {
    setShowConfirmDialog(false);
    setIsDeleting(true);

    try {
      let deleted = 0;
      let skipped = 0;
      const idsToDelete = Array.from(selectedIds);
      setDeleteProgress({ current: 0, total: idsToDelete.length });

      // Track addresses whose cached stats may be affected by the deletion so we
      // can recompute them locally afterwards (no network access).
      const affectedAddresses = new Set<string>();
      const deletedTxids: string[] = [];

      for (let i = 0; i < idsToDelete.length; i++) {
        const id = idsToDelete[i];
        if (i % 10 === 0) {
          setDeleteProgress({ current: i + 1, total: idsToDelete.length });
          await yieldToUI();
        }

        const record = await getRecord(id);
        if (!record) { skipped++; continue; }

        if (scanMode === 'blockchain-only' || scanMode === 'unconnected') {
          const origins = await bulkGetOriginsByRecordId(new Set([id]));
          const recordOrigins = origins.get(id) || [];
          if (!isBlockchainOnlyRecord(record, recordOrigins) || hasUserMetadata(record, recordOrigins)) {
            skipped++;
            continue;
          }
        }

        if (record.type === 'address' && record.inputString) {
          affectedAddresses.add(record.inputString);
        } else if (record.type === 'transaction' && record.inputString) {
          deletedTxids.push(record.inputString);
        }

        await deleteRecordOriginsByRecordId(id);
        await deleteRecord(id);
        deleted++;
      }

      // Collect participant addresses of any deleted transaction records — these
      // are the addresses whose balances/counts could change.
      if (deletedTxids.length > 0) {
        const participants = await getParticipantsByTxids(deletedTxids);
        for (const p of participants) {
          if (p.address) affectedAddresses.add(p.address);
        }
      }

      setCandidates(prev => prev.filter(c => !selectedIds.has(c.record.id!)));
      setSelectedIds(new Set());

      if (affectedAddresses.size > 0) {
        try {
          await recomputeAddressStats({ addresses: Array.from(affectedAddresses), origin: "user" });
        } catch (statsError) {
          console.error('Failed to recompute address stats after cleanup:', statsError);
        }
      }

      const desc = skipped > 0
        ? `Deleted ${deleted} records. Skipped ${skipped} records that no longer qualify.`
        : `Successfully deleted ${deleted} records`;
      toast({ title: "Cleanup Complete", description: desc });
    } catch (error) {
      console.error('Error deleting records:', error);
      toast({ title: "Deletion Failed", description: "An error occurred while deleting records", variant: "destructive" });
    } finally {
      setIsDeleting(false);
      setDeleteProgress({ current: 0, total: 0 });
    }
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
    setPage(0);
  };

  const sortedCandidates = [...candidates].sort((a, b) => {
    const dir = sortDirection === 'asc' ? 1 : -1;
    switch (sortField) {
      case 'type':
        return dir * a.record.type.localeCompare(b.record.type);
      case 'address':
        return dir * a.record.inputString.localeCompare(b.record.inputString);
      case 'depth':
        return dir * ((a.record.syncDepth ?? 0) - (b.record.syncDepth ?? 0));
      case 'discoveredFrom':
        return dir * ((a.record.discoveredFromRecordId ?? 0) - (b.record.discoveredFromRecordId ?? 0));
      default:
        return 0;
    }
  });

  const totalPages = Math.max(1, Math.ceil(sortedCandidates.length / PAGE_SIZE));
  const pagedCandidates = sortedCandidates.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const addressCount = candidates.filter(c => c.record.type === 'address').length;
  const txCount = candidates.filter(c => c.record.type === 'transaction').length;
  const connectedCount = candidates.filter(c => c.hasOtherConnections || c.connectedToKnown).length;
  const selectedAddresses = Array.from(selectedIds).filter(id =>
    candidates.find(c => c.record.id === id && c.record.type === 'address')
  ).length;
  const selectedTxs = Array.from(selectedIds).filter(id =>
    candidates.find(c => c.record.id === id && c.record.type === 'transaction')
  ).length;

  const SortButton = ({ field, label }: { field: SortField; label: string }) => (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => handleSort(field)}
      className="gap-1"
      data-testid={`button-sort-${field}`}
    >
      {label}
      <ArrowUpDown className="h-3 w-3" />
    </Button>
  );

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold" data-testid="text-page-title">Database Cleanup</h1>
          <p className="text-muted-foreground mt-2">
            Find and remove blockchain-discovered records that have no user-added metadata,
            or review records discovered from a specific address.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Search className="h-5 w-5" />
              Scan Settings
            </CardTitle>
            <CardDescription>
              Choose a scan mode to find records for cleanup
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-3">
              <Label>Scan Mode</Label>
              <RadioGroup
                value={scanMode}
                onValueChange={(v) => {
                  setScanMode(v as ScanMode);
                  setHasScanned(false);
                  setCandidates([]);
                  setSelectedIds(new Set());
                  setPage(0);
                }}
                className="space-y-2"
              >
                <div className="flex items-start space-x-2">
                  <RadioGroupItem value="blockchain-only" id="mode-blockchain" data-testid="radio-mode-blockchain" />
                  <div className="grid gap-0.5">
                    <Label htmlFor="mode-blockchain">Blockchain-Only Records</Label>
                    <p className="text-xs text-muted-foreground">
                      Find records with no user metadata that were purely discovered via sync
                    </p>
                  </div>
                </div>
                <div className="flex items-start space-x-2">
                  <RadioGroupItem value="unconnected" id="mode-unconnected" data-testid="radio-mode-unconnected" />
                  <div className="grid gap-0.5">
                    <Label htmlFor="mode-unconnected" className="flex items-center gap-1.5">
                      <Unplug className="h-3.5 w-3.5" />
                      Unconnected Records
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Find blockchain-only records that don't connect any of your known addresses via shared transactions — safest to delete
                    </p>
                  </div>
                </div>
                <div className="flex items-start space-x-2">
                  <RadioGroupItem value="discovery-origin" id="mode-discovery" data-testid="radio-mode-discovery" />
                  <div className="grid gap-0.5">
                    <Label htmlFor="mode-discovery" className="flex items-center gap-1.5">
                      <Network className="h-3.5 w-3.5" />
                      Discovered From Address
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Find all records discovered from syncing a specific address (including records with metadata)
                    </p>
                  </div>
                </div>
              </RadioGroup>
            </div>

            {(scanMode === 'blockchain-only' || scanMode === 'unconnected') && (
              <>
                <div className="space-y-3">
                  <Label>Record Types to Scan</Label>
                  <RadioGroup
                    value={scope}
                    onValueChange={(v) => setScope(v as Scope)}
                    className="flex flex-wrap gap-4"
                  >
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="addresses" id="scope-addresses" data-testid="radio-scope-addresses" />
                      <Label htmlFor="scope-addresses">Addresses Only</Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="transactions" id="scope-transactions" data-testid="radio-scope-transactions" />
                      <Label htmlFor="scope-transactions">Transactions Only</Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="both" id="scope-both" data-testid="radio-scope-both" />
                      <Label htmlFor="scope-both">Both</Label>
                    </div>
                  </RadioGroup>
                </div>

                <div className="bg-muted/50 rounded-lg p-4 text-sm space-y-2">
                  <p className="font-medium">
                    {scanMode === 'unconnected' ? 'Unconnected records scan:' : 'Records eligible for cleanup:'}
                  </p>
                  <ul className="list-disc list-inside text-muted-foreground space-y-1">
                    <li>Have at least one origin, and all origins are "blockchain-sync" type</li>
                    <li>Were discovered via blockchain sync (not manually entered or imported)</li>
                    <li>Have no user-added metadata (labels, notes, tags, categories, etc.)</li>
                    <li>Have no classification data (flow type, cost basis, counterparty, etc.)</li>
                    {scanMode === 'unconnected' && (
                      <li className="font-medium text-foreground">
                        Do NOT share any transaction with your known/imported addresses — no bridge value
                      </li>
                    )}
                  </ul>
                  {scanMode === 'blockchain-only' && (
                    <div className="mt-3 pt-3 border-t border-muted">
                      <p className="font-medium flex items-center gap-1.5">
                        <Shield className="h-3.5 w-3.5" />
                        Relationship safety check:
                      </p>
                      <p className="text-muted-foreground mt-1">
                        Records that share transaction inputs or outputs with your known addresses (manually added, imported, verified, or labeled)
                        are flagged with a <Shield className="h-3 w-3 inline" /> icon so you can review them before deleting. Use "Select Safe" to skip these.
                      </p>
                    </div>
                  )}
                  {scanMode === 'unconnected' && (
                    <div className="mt-3 pt-3 border-t border-muted">
                      <p className="font-medium flex items-center gap-1.5">
                        <Unplug className="h-3.5 w-3.5" />
                        Pre-filtered for safety:
                      </p>
                      <p className="text-muted-foreground mt-1">
                        This mode only shows records that have zero transaction connections to any of your known addresses.
                        These are dead-end branches with no bridge value — safe to delete in bulk.
                      </p>
                    </div>
                  )}
                </div>
              </>
            )}

            {scanMode === 'discovery-origin' && (
              <div className="space-y-3">
                <Label>Parent Address</Label>
                <div className="space-y-2">
                  <Input
                    placeholder="Enter or paste a Bitcoin address..."
                    value={originAddress}
                    onChange={(e) => setOriginAddress(e.target.value)}
                    className="font-mono text-xs"
                    disabled={isScanning}
                    data-testid="input-origin-address"
                  />
                  {syncedAddresses.length > 0 && (
                    <div className="space-y-1">
                      <span className="text-xs text-muted-foreground">Or select a previously synced address:</span>
                      <div className="max-h-32 overflow-y-auto border rounded-lg divide-y">
                        {syncedAddresses.slice(0, 20).map(sa => (
                          <button
                            key={sa.id}
                            className="w-full text-left px-3 py-1.5 text-xs font-mono hover-elevate truncate"
                            onClick={() => setOriginAddress(sa.address)}
                            data-testid={`button-select-origin-${sa.id}`}
                          >
                            {sa.address}
                          </button>
                        ))}
                        {syncedAddresses.length > 20 && (
                          <div className="px-3 py-1.5 text-xs text-muted-foreground">
                            +{syncedAddresses.length - 20} more (paste address above)
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                <div className="bg-muted/50 rounded-lg p-4 text-sm space-y-2">
                  <p className="font-medium">Discovery origin scan:</p>
                  <ul className="list-disc list-inside text-muted-foreground space-y-1">
                    <li>Finds all records discovered by syncing the selected address</li>
                    <li>Includes records at all depths (direct and indirect discoveries)</li>
                    <li>Shows records with metadata too — review before deleting</li>
                    <li>Flags records that are also connected to other wanted addresses</li>
                    <li>Flags records that share transactions with your known addresses</li>
                  </ul>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={scanForCandidates}
                disabled={isScanning && false}
                className="sm:w-auto"
                data-testid="button-scan"
              >
                {isScanning ? (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                    {scanProgress || 'Scanning...'}
                  </>
                ) : (
                  <>
                    <Search className="h-4 w-4 mr-2" />
                    {scanMode === 'blockchain-only'
                      ? 'Scan for Cleanup Candidates'
                      : scanMode === 'unconnected'
                        ? 'Scan for Unconnected Records'
                        : 'Scan Discovery Tree'}
                  </>
                )}
              </Button>
              {isScanning && (
                <Button
                  variant="outline"
                  onClick={cancelScan}
                  data-testid="button-cancel-scan"
                >
                  <XCircle className="h-4 w-4 mr-2" />
                  Cancel
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {hasScanned && (
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <CardTitle>
                    {candidates.length === 0 ? (
                      <span className="flex items-center gap-2">
                        <CheckCircle2 className="h-5 w-5 text-green-500" />
                        {scanMode === 'blockchain-only' ? 'No Cleanup Needed' : scanMode === 'unconnected' ? 'No Unconnected Records' : 'No Discovered Records'}
                      </span>
                    ) : (
                      `${candidates.length.toLocaleString()} Records Found`
                    )}
                  </CardTitle>
                  <CardDescription>
                    {candidates.length > 0 ? (
                      <>
                        {addressCount.toLocaleString()} addresses, {txCount.toLocaleString()} transactions
                        {connectedCount > 0 && (
                          <span className="ml-2" data-testid="text-connected-count">
                            ({connectedCount.toLocaleString()} connected to known addresses or other trees)
                          </span>
                        )}
                        {selectedIds.size > 0 && (
                          <span className="ml-2 text-foreground">
                            — {selectedAddresses} addresses, {selectedTxs} transactions selected
                          </span>
                        )}
                      </>
                    ) : (
                      scanMode === 'blockchain-only'
                        ? "All records have user metadata or non-blockchain origins"
                        : scanMode === 'unconnected'
                          ? "All blockchain-only records are connected to your known addresses — they have bridge value"
                          : "No records were discovered from syncing this address"
                    )}
                  </CardDescription>
                </div>

                {candidates.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" size="sm" onClick={selectAll} data-testid="button-select-all">
                      Select All
                    </Button>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="outline" size="sm" onClick={selectSafe} data-testid="button-select-safe">
                          Select Safe
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        Select only records with no connections to known addresses, no other tree connections, and no user metadata
                      </TooltipContent>
                    </Tooltip>
                    <Button variant="outline" size="sm" onClick={selectNone} disabled={selectedIds.size === 0} data-testid="button-select-none">
                      Select None
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={openConfirmDialog}
                      disabled={selectedIds.size === 0 || isDeleting}
                      data-testid="button-delete-selected"
                    >
                      {isDeleting ? (
                        <>
                          <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                          Deleting {deleteProgress.current}/{deleteProgress.total}...
                        </>
                      ) : (
                        <>
                          <Trash2 className="h-4 w-4 mr-2" />
                          Delete Selected ({selectedIds.size.toLocaleString()})
                        </>
                      )}
                    </Button>
                  </div>
                )}
              </div>
            </CardHeader>

            {candidates.length > 0 && (
              <CardContent className="space-y-3">
                <div className="border rounded-lg overflow-hidden">
                  <div className="flex items-center gap-3 px-3 py-2 bg-muted/50 border-b text-xs">
                    <div className="w-6" />
                    <SortButton field="type" label="Type" />
                    <div className="flex-1">
                      <SortButton field="address" label="Address / TXID" />
                    </div>
                    <SortButton field="depth" label="Depth" />
                    <div className="w-28 text-center text-muted-foreground" data-testid="header-status">Status</div>
                  </div>
                  <div className="divide-y">
                    {pagedCandidates.map((candidate) => (
                      <div
                        key={candidate.record.id}
                        className="flex items-center gap-3 p-3 hover-elevate"
                        data-testid={`cleanup-row-${candidate.record.id}`}
                      >
                        <Checkbox
                          checked={selectedIds.has(candidate.record.id!)}
                          onCheckedChange={() => toggleSelection(candidate.record.id!)}
                          data-testid={`checkbox-${candidate.record.id}`}
                        />
                        <Badge variant={candidate.record.type === 'address' ? 'default' : 'secondary'} data-testid={`badge-type-${candidate.record.id}`}>
                          {candidate.record.type}
                        </Badge>
                        <span className="font-mono text-sm flex-1 truncate min-w-0" data-testid={`text-address-${candidate.record.id}`}>
                          {candidate.record.inputString}
                        </span>
                        {candidate.record.syncDepth !== undefined && (
                          <Badge variant="outline" className="shrink-0" data-testid={`badge-depth-${candidate.record.id}`}>
                            D{candidate.record.syncDepth}
                          </Badge>
                        )}
                        <div className="flex items-center gap-1 shrink-0 w-28 justify-end" data-testid={`status-${candidate.record.id}`}>
                          {hasUserMetadata(candidate.record, candidate.origins) && (
                            <Tooltip>
                              <TooltipTrigger>
                                <Badge variant="secondary" className="text-xs" data-testid={`badge-metadata-${candidate.record.id}`}>
                                  metadata
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent>Has user-added metadata (labels, tags, etc.)</TooltipContent>
                            </Tooltip>
                          )}
                          {candidate.connectedToKnown && (
                            <Tooltip>
                              <TooltipTrigger>
                                <Badge variant="outline" className="text-xs text-amber-600 border-amber-600/30" data-testid={`badge-known-${candidate.record.id}`}>
                                  <Shield className="h-3 w-3" />
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent>Shares a transaction with one of your known/imported addresses</TooltipContent>
                            </Tooltip>
                          )}
                          {candidate.hasOtherConnections && (
                            <Tooltip>
                              <TooltipTrigger>
                                <Badge variant="outline" className="text-xs" data-testid={`badge-connected-${candidate.record.id}`}>
                                  <Link2 className="h-3 w-3" />
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent>Also connected to other addresses outside this discovery tree</TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {totalPages > 1 && (
                  <div className="flex items-center justify-between pt-2">
                    <span className="text-sm text-muted-foreground" data-testid="text-page-info">
                      Showing {(page * PAGE_SIZE + 1).toLocaleString()}-{Math.min((page + 1) * PAGE_SIZE, sortedCandidates.length).toLocaleString()} of {sortedCandidates.length.toLocaleString()}
                    </span>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPage(p => Math.max(0, p - 1))}
                        disabled={page === 0}
                        data-testid="button-prev-page"
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </Button>
                      <span className="text-sm" data-testid="text-page-number">
                        Page {page + 1} of {totalPages}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                        disabled={page >= totalPages - 1}
                        data-testid="button-next-page"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            )}
          </Card>
        )}

        <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-destructive" />
                Confirm Deletion
              </AlertDialogTitle>
              <AlertDialogDescription>
                You are about to permanently delete {selectedIds.size.toLocaleString()} record{selectedIds.size === 1 ? '' : 's'}.
                {candidates.some(c => selectedIds.has(c.record.id!) && c.connectedToKnown) && (
                  <>
                    <br /><br />
                    <strong className="text-amber-600">Warning:</strong> Some selected records share transactions
                    with your known/imported addresses. Deleting them will remove transaction data linked to those addresses.
                  </>
                )}
                {candidates.some(c => selectedIds.has(c.record.id!) && c.hasOtherConnections) && (
                  <>
                    <br /><br />
                    <strong className="text-amber-600">Warning:</strong> Some selected records are also connected
                    to other addresses. Deleting them may affect data for those addresses.
                  </>
                )}
                {candidates.some(c => selectedIds.has(c.record.id!) && hasUserMetadata(c.record, c.origins)) && (
                  <>
                    <br /><br />
                    <strong className="text-amber-600">Warning:</strong> Some selected records have user-added
                    metadata that will be lost.
                  </>
                )}
                {attachmentImpact !== null && attachmentImpact > 0 && (
                  <>
                    <br /><br />
                    <strong>{attachmentImpact.toLocaleString()} attached file{attachmentImpact === 1 ? '' : 's'}</strong> on
                    these records will be kept on disk — not deleted — and can be recovered from
                    Settings &gt; Deleted Attachments.
                  </>
                )}
                <br /><br />
                <strong>This action cannot be undone.</strong> However, you can re-sync these
                records later from the blockchain if needed.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDelete}
                className="bg-destructive text-destructive-foreground"
                data-testid="button-confirm-delete"
              >
                Delete {selectedIds.size.toLocaleString()} Record{selectedIds.size === 1 ? '' : 's'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}

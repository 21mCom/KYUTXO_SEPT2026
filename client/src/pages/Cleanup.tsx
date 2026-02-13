import { useState, useEffect } from "react";
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
import { Trash2, Search, RefreshCw, AlertTriangle, CheckCircle2, Network, ArrowUpDown, Link2 } from "lucide-react";
import { db, Record, RecordOrigin } from "@/lib/database";
import { deleteRecord, decryptRecords, getDecryptedRecordOrigins } from "@/lib/encryptionFacade";

type Scope = 'addresses' | 'transactions' | 'both';
type ScanMode = 'blockchain-only' | 'discovery-origin';
type SortField = 'type' | 'address' | 'depth' | 'discoveredFrom';
type SortDirection = 'asc' | 'desc';

interface CleanupCandidate {
  record: Record;
  origins: RecordOrigin[];
  hasOtherConnections: boolean;
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
  const [hasScanned, setHasScanned] = useState(false);
  const [originAddress, setOriginAddress] = useState('');
  const [sortField, setSortField] = useState<SortField>('depth');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const [syncedAddresses, setSyncedAddresses] = useState<{ id: number; address: string }[]>([]);

  useEffect(() => {
    const loadSyncedAddresses = async () => {
      const allRecords = await db.records
        .where('type').equals('address')
        .toArray();
      const decrypted = await decryptRecords(allRecords);
      const synced = decrypted
        .filter(r => r.id && (r.maxSyncedDepth !== undefined && r.maxSyncedDepth >= 0))
        .map(r => ({ id: r.id!, address: r.inputString }));
      setSyncedAddresses(synced);
    };
    loadSyncedAddresses();
  }, []);

  const isBlockchainOnlyRecord = (record: Record, origins: RecordOrigin[]): boolean => {
    if (origins.length === 0) {
      return false;
    }
    
    const hasNonBlockchainOrigin = origins.some(o => o.originType !== 'blockchain-sync');
    if (hasNonBlockchainOrigin) {
      return false;
    }
    
    if (record.source && !['blockchain-sync'].includes(record.source)) {
      return false;
    }
    
    if (record.addressImportance && !['blockchain-discovered', 'pending-review'].includes(record.addressImportance)) {
      return false;
    }
    
    if (record.syncDepth === 0) {
      return false;
    }
    
    return true;
  };
  
  const hasUserMetadata = (record: Record, origins: RecordOrigin[]): boolean => {
    if (record.label && record.label.trim() !== '') return true;
    if (record.notes && record.notes.trim() !== '') return true;
    if (record.tags && record.tags.length > 0) return true;
    if (record.categories && record.categories.length > 0) return true;
    if (record.owner) return true;
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
      if (origin.label && origin.label.trim() !== '') return true;
      if (origin.notes && origin.notes.trim() !== '') return true;
      if (origin.tags && origin.tags.length > 0) return true;
      if (origin.categories && origin.categories.length > 0) return true;
      if (origin.owner) return true;
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

  const fetchDiscoveryTree = async (parentRecordId: number): Promise<Record[]> => {
    const allDiscovered: Record[] = [];
    let currentParentIds = [parentRecordId];
    let depth = 0;

    while (currentParentIds.length > 0 && depth < 50) {
      const children: Record[] = [];
      for (const pid of currentParentIds) {
        const batch = await db.records
          .filter((r) => r.discoveredFromRecordId === pid)
          .toArray();
        children.push(...batch);
      }

      if (children.length === 0) break;

      const decrypted = await decryptRecords(children);
      allDiscovered.push(...decrypted);

      currentParentIds = decrypted
        .map((r) => r.id)
        .filter((id): id is number => id !== undefined);
      depth++;
    }

    return allDiscovered;
  };

  const checkOtherConnections = async (recordId: number, discoveryTreeIds: Set<number>): Promise<boolean> => {
    const record = await db.records.get(recordId);
    if (!record) return false;

    if (record.discoveredFromRecordId !== undefined && !discoveryTreeIds.has(record.discoveredFromRecordId)) {
      return true;
    }

    const childrenOutsideTree = await db.records
      .filter(r => r.discoveredFromRecordId === recordId && r.id !== undefined && !discoveryTreeIds.has(r.id))
      .count();
    if (childrenOutsideTree > 0) return true;

    return false;
  };

  const scanForCandidates = async () => {
    setIsScanning(true);
    setCandidates([]);
    setSelectedIds(new Set());
    
    try {
      if (scanMode === 'blockchain-only') {
        let records: Record[] = [];
        
        if (scope === 'addresses') {
          records = await db.records.where('type').equals('address').toArray();
        } else if (scope === 'transactions') {
          records = await db.records.where('type').equals('transaction').toArray();
        } else {
          records = await db.records.where('type').anyOf(['address', 'transaction']).toArray();
        }
        
        const decrypted = await decryptRecords(records);
        
        const cleanupCandidates: CleanupCandidate[] = [];
        
        for (const record of decrypted) {
          if (!record.id) continue;
          
          const origins = await getDecryptedRecordOrigins(record.id);
          
          if (isBlockchainOnlyRecord(record, origins) && !hasUserMetadata(record, origins)) {
            cleanupCandidates.push({ record, origins, hasOtherConnections: false });
          }
        }
        
        setCandidates(cleanupCandidates);
        setHasScanned(true);
        
        toast({
          title: "Scan Complete",
          description: `Found ${cleanupCandidates.length} records eligible for cleanup`,
        });
      } else {
        const trimmed = originAddress.trim();
        if (!trimmed) {
          toast({
            title: "No Address Selected",
            description: "Enter a parent address to filter by discovery origin",
            variant: "destructive",
          });
          setIsScanning(false);
          return;
        }

        const parentRecords = await db.records
          .filter(r => r.inputString === trimmed && r.type === 'address')
          .toArray();
        
        if (parentRecords.length === 0) {
          toast({
            title: "Address Not Found",
            description: "This address is not in your records",
            variant: "destructive",
          });
          setIsScanning(false);
          return;
        }

        const parentRecord = parentRecords[0];
        if (!parentRecord.id) {
          setIsScanning(false);
          return;
        }

        const discoveredRecords = await fetchDiscoveryTree(parentRecord.id);
        const discoveryTreeIds = new Set<number>([parentRecord.id, ...discoveredRecords.map(r => r.id!).filter(Boolean)]);

        const cleanupCandidates: CleanupCandidate[] = [];

        for (const record of discoveredRecords) {
          if (!record.id) continue;

          const origins = await getDecryptedRecordOrigins(record.id);
          const otherConnections = await checkOtherConnections(record.id, discoveryTreeIds);

          cleanupCandidates.push({
            record,
            origins,
            hasOtherConnections: otherConnections,
          });
        }

        setCandidates(cleanupCandidates);
        setHasScanned(true);

        toast({
          title: "Discovery Scan Complete",
          description: `Found ${cleanupCandidates.length} records discovered from this address`,
        });
      }
    } catch (error) {
      console.error('Error scanning for cleanup candidates:', error);
      toast({
        title: "Scan Failed",
        description: "An error occurred while scanning records",
        variant: "destructive",
      });
    } finally {
      setIsScanning(false);
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
    const allIds = new Set(candidates.map(c => c.record.id!));
    setSelectedIds(allIds);
  };

  const selectNone = () => {
    setSelectedIds(new Set());
  };

  const selectSafe = () => {
    const safeIds = new Set(
      candidates
        .filter(c => !c.hasOtherConnections && !hasUserMetadata(c.record, c.origins))
        .map(c => c.record.id!)
    );
    setSelectedIds(safeIds);
  };

  const handleDelete = async () => {
    setShowConfirmDialog(false);
    setIsDeleting(true);
    
    try {
      let deleted = 0;
      let skipped = 0;
      const idsToDelete = Array.from(selectedIds);
      
      for (const id of idsToDelete) {
        const records = await db.records.where('id').equals(id).toArray();
        if (records.length === 0) {
          skipped++;
          continue;
        }
        
        if (scanMode === 'blockchain-only') {
          const decrypted = await decryptRecords(records);
          const record = decrypted[0];
          const origins = await getDecryptedRecordOrigins(id);
          
          if (!isBlockchainOnlyRecord(record, origins) || hasUserMetadata(record, origins)) {
            skipped++;
            continue;
          }
        }
        
        await db.recordOrigins.where('recordId').equals(id).delete();
        await deleteRecord(id);
        deleted++;
      }
      
      setCandidates(prev => prev.filter(c => !selectedIds.has(c.record.id!)));
      setSelectedIds(new Set());
      
      if (skipped > 0) {
        toast({
          title: "Cleanup Complete",
          description: `Deleted ${deleted} records. Skipped ${skipped} records that no longer qualify.`,
        });
      } else {
        toast({
          title: "Cleanup Complete",
          description: `Successfully deleted ${deleted} records`,
        });
      }
    } catch (error) {
      console.error('Error deleting records:', error);
      toast({
        title: "Deletion Failed",
        description: "An error occurred while deleting records",
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
    }
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
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

  const addressCount = candidates.filter(c => c.record.type === 'address').length;
  const txCount = candidates.filter(c => c.record.type === 'transaction').length;
  const connectedCount = candidates.filter(c => c.hasOtherConnections).length;
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
          <h1 className="text-3xl font-bold">Database Cleanup</h1>
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

            {scanMode === 'blockchain-only' && (
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
                  <p className="font-medium">Records eligible for cleanup:</p>
                  <ul className="list-disc list-inside text-muted-foreground space-y-1">
                    <li>Have at least one origin, and all origins are "blockchain-sync" type</li>
                    <li>Were discovered via blockchain sync (not manually entered or imported)</li>
                    <li>Have no user-added metadata (labels, notes, tags, categories, etc.)</li>
                    <li>Have no classification data (flow type, cost basis, counterparty, etc.)</li>
                  </ul>
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
                  </ul>
                </div>
              </div>
            )}

            <Button 
              onClick={scanForCandidates} 
              disabled={isScanning || (scanMode === 'discovery-origin' && !originAddress.trim())}
              className="w-full sm:w-auto"
              data-testid="button-scan"
            >
              {isScanning ? (
                <>
                  <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                  Scanning...
                </>
              ) : (
                <>
                  <Search className="h-4 w-4 mr-2" />
                  {scanMode === 'blockchain-only' ? 'Scan for Cleanup Candidates' : 'Scan Discovery Tree'}
                </>
              )}
            </Button>
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
                        {scanMode === 'blockchain-only' ? 'No Cleanup Needed' : 'No Discovered Records'}
                      </span>
                    ) : (
                      `${candidates.length} Records Found`
                    )}
                  </CardTitle>
                  <CardDescription>
                    {candidates.length > 0 ? (
                      <>
                        {addressCount} addresses, {txCount} transactions
                        {connectedCount > 0 && (
                          <span className="ml-2" data-testid="text-connected-count">
                            ({connectedCount} also connected elsewhere)
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
                        : "No records were discovered from syncing this address"
                    )}
                  </CardDescription>
                </div>
                
                {candidates.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button 
                      variant="outline" 
                      size="sm" 
                      onClick={selectAll}
                      data-testid="button-select-all"
                    >
                      Select All
                    </Button>
                    {scanMode === 'discovery-origin' && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button 
                            variant="outline" 
                            size="sm" 
                            onClick={selectSafe}
                            data-testid="button-select-safe"
                          >
                            Select Safe
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          Select only records with no other connections and no user metadata
                        </TooltipContent>
                      </Tooltip>
                    )}
                    <Button 
                      variant="outline" 
                      size="sm" 
                      onClick={selectNone}
                      disabled={selectedIds.size === 0}
                      data-testid="button-select-none"
                    >
                      Select None
                    </Button>
                    <Button 
                      variant="destructive" 
                      size="sm"
                      onClick={() => setShowConfirmDialog(true)}
                      disabled={selectedIds.size === 0 || isDeleting}
                      data-testid="button-delete-selected"
                    >
                      {isDeleting ? (
                        <>
                          <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                          Deleting...
                        </>
                      ) : (
                        <>
                          <Trash2 className="h-4 w-4 mr-2" />
                          Delete Selected ({selectedIds.size})
                        </>
                      )}
                    </Button>
                  </div>
                )}
              </div>
            </CardHeader>
            
            {candidates.length > 0 && (
              <CardContent>
                <div className="border rounded-lg overflow-hidden">
                  <div className="flex items-center gap-3 px-3 py-2 bg-muted/50 border-b text-xs">
                    <div className="w-6" />
                    <SortButton field="type" label="Type" />
                    <div className="flex-1">
                      <SortButton field="address" label="Address / TXID" />
                    </div>
                    <SortButton field="depth" label="Depth" />
                    {scanMode === 'discovery-origin' && (
                      <div className="w-24 text-center text-muted-foreground" data-testid="header-status">Status</div>
                    )}
                  </div>
                  <div className="divide-y max-h-[500px] overflow-y-auto">
                    {sortedCandidates.map((candidate) => (
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
                        {scanMode === 'discovery-origin' && (
                          <div className="flex items-center gap-1 shrink-0 w-24 justify-end" data-testid={`status-${candidate.record.id}`}>
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
                        )}
                      </div>
                    ))}
                  </div>
                </div>
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
                You are about to permanently delete {selectedIds.size} record{selectedIds.size === 1 ? '' : 's'}.
                {scanMode === 'discovery-origin' && candidates.some(c => selectedIds.has(c.record.id!) && c.hasOtherConnections) && (
                  <>
                    <br /><br />
                    <strong className="text-amber-600">Warning:</strong> Some selected records are also connected 
                    to other addresses. Deleting them may affect data for those addresses.
                  </>
                )}
                {scanMode === 'discovery-origin' && candidates.some(c => selectedIds.has(c.record.id!) && hasUserMetadata(c.record, c.origins)) && (
                  <>
                    <br /><br />
                    <strong className="text-amber-600">Warning:</strong> Some selected records have user-added 
                    metadata that will be lost.
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
                Delete {selectedIds.size} Record{selectedIds.size === 1 ? '' : 's'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}

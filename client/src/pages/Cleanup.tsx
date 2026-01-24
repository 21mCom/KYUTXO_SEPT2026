import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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
import { Trash2, Search, RefreshCw, AlertTriangle, CheckCircle2 } from "lucide-react";
import { db, Record, RecordOrigin } from "@/lib/database";
import { deleteRecord, decryptRecords, getDecryptedRecordOrigins } from "@/lib/encryptionFacade";

type Scope = 'addresses' | 'transactions' | 'both';

interface CleanupCandidate {
  record: Record;
  origins: RecordOrigin[];
}

export default function Cleanup() {
  const { toast } = useToast();
  const [scope, setScope] = useState<Scope>('both');
  const [candidates, setCandidates] = useState<CleanupCandidate[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [isScanning, setIsScanning] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [hasScanned, setHasScanned] = useState(false);

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

  const scanForCandidates = async () => {
    setIsScanning(true);
    setCandidates([]);
    setSelectedIds(new Set());
    
    try {
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
          cleanupCandidates.push({ record, origins });
        }
      }
      
      setCandidates(cleanupCandidates);
      setHasScanned(true);
      
      toast({
        title: "Scan Complete",
        description: `Found ${cleanupCandidates.length} records eligible for cleanup`,
      });
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
        
        const decrypted = await decryptRecords(records);
        const record = decrypted[0];
        const origins = await getDecryptedRecordOrigins(id);
        
        if (!isBlockchainOnlyRecord(record, origins) || hasUserMetadata(record, origins)) {
          skipped++;
          continue;
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

  const addressCount = candidates.filter(c => c.record.type === 'address').length;
  const txCount = candidates.filter(c => c.record.type === 'transaction').length;
  const selectedAddresses = Array.from(selectedIds).filter(id => 
    candidates.find(c => c.record.id === id && c.record.type === 'address')
  ).length;
  const selectedTxs = Array.from(selectedIds).filter(id => 
    candidates.find(c => c.record.id === id && c.record.type === 'transaction')
  ).length;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold">Database Cleanup</h1>
          <p className="text-muted-foreground mt-2">
            Find and remove blockchain-discovered records that have no user-added metadata.
            These records can be re-synced later if needed.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Search className="h-5 w-5" />
              Scan Settings
            </CardTitle>
            <CardDescription>
              Choose which types of records to scan for cleanup candidates
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
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

            <Button 
              onClick={scanForCandidates} 
              disabled={isScanning}
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
                  Scan for Cleanup Candidates
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
                        No Cleanup Needed
                      </span>
                    ) : (
                      `${candidates.length} Records Found`
                    )}
                  </CardTitle>
                  <CardDescription>
                    {candidates.length > 0 ? (
                      <>
                        {addressCount} addresses, {txCount} transactions
                        {selectedIds.size > 0 && (
                          <span className="ml-2 text-foreground">
                            ({selectedAddresses} addresses, {selectedTxs} transactions selected)
                          </span>
                        )}
                      </>
                    ) : (
                      "All records have user metadata or non-blockchain origins"
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
                <div className="border rounded-lg divide-y max-h-[500px] overflow-y-auto">
                  {candidates.map((candidate) => (
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
                      <Badge variant={candidate.record.type === 'address' ? 'default' : 'secondary'}>
                        {candidate.record.type}
                      </Badge>
                      <span className="font-mono text-sm flex-1 truncate">
                        {candidate.record.inputString}
                      </span>
                      {candidate.record.discoveredInTxid && (
                        <span className="text-xs text-muted-foreground">
                          via tx: {candidate.record.discoveredInTxid.substring(0, 8)}...
                        </span>
                      )}
                    </div>
                  ))}
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
                <br /><br />
                <strong>This action cannot be undone.</strong> However, you can re-sync these 
                records later from the blockchain if needed.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
              <AlertDialogAction 
                onClick={handleDelete}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
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

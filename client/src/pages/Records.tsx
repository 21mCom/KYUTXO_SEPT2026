import { useState, useEffect, useRef, useMemo } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Search as SearchIcon, Database, Hash, ExternalLink, AlertCircle, Trash2, X } from "lucide-react";
import { BlockchainToggle } from "@/components/BlockchainToggle";
import { db, subscribeToDbChanges, type Record as DbRecord, type VaultMetadata, type AddressImportance, type ChainType, type CustomField, type BlockchainTransaction, type TransactionParticipant } from "@/lib/database";
import { decryptRecords, isEncryptionReady, deleteRecord } from "@/lib/encryptionFacade";
import { RecordTable } from "@/components/RecordTable";
import { RecordDetailPanel } from "@/components/RecordDetailPanel";
import { ClickableAddress } from "@/components/ClickableAddress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { RecordFilters, ColumnFilter, applyColumnFilters, extractUniqueValues } from "@/components/RecordFilters";
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
import { useToast } from "@/hooks/use-toast";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { useSettings, useCustomFields, toggleTableColumn, toggleCustomFieldColumn } from "@/hooks/use-settings";
import { Settings2 } from "lucide-react";

// User-curated importance tiers (exclude blockchain-discovered and pending-review by default)
const USER_CURATED_TIERS: AddressImportance[] = ['verified', 'manual', 'wallet-import', 'xpub-derived'];
const ALL_TIERS: AddressImportance[] = ['verified', 'manual', 'wallet-import', 'xpub-derived', 'blockchain-discovered', 'pending-review'];

interface ConvertedRecord {
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
  customFields?: { [key: string]: string };
  derivationPath?: string;
  chainType?: ChainType;
  vault?: VaultMetadata;
  addressImportance?: AddressImportance;
  syncDepth?: number;
  maxSyncedDepth?: number;
  discoveredInTxid?: string;
  discoveredFromRecordId?: number;
}

export default function Records() {
  const [location, navigate] = useLocation();
  
  const [records, setRecords] = useState<ConvertedRecord[]>([]);
  const [filteredRecords, setFilteredRecords] = useState<ConvertedRecord[]>([]);
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [urlSearchQuery, setUrlSearchQuery] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [customFieldDefs, setCustomFieldDefs] = useState<CustomField[]>([]);
  
  // Filter state: by default, only show user-curated records (not blockchain-discovered)
  const [includeBlockchainDiscovered, setIncludeBlockchainDiscovered] = useState(false);
  const [totalBlockchainDiscovered, setTotalBlockchainDiscovered] = useState(0);
  
  // Column filters state
  const [columnFilters, setColumnFilters] = useState<ColumnFilter[]>([]);
  
  // Bulk selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  
  // Delete confirmation dialogs
  const [bulkDeleteDialogOpen, setBulkDeleteDialogOpen] = useState(false);
  const [singleDeleteTarget, setSingleDeleteTarget] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  
  const { toast } = useToast();
  
  // State for blockchain transaction search results
  const [matchingTxids, setMatchingTxids] = useState<string[]>([]);
  const [txidSearchResults, setTxidSearchResults] = useState<{
    txid: string;
    blockHeight: number;
    blockTime: number;
    participantAddresses: string[];
  }[]>([]);
  
  // Track database changes to trigger reloads
  const changeVersionRef = useRef(0);
  const [dbChangeSignal, setDbChangeSignal] = useState(0);
  
  useEffect(() => {
    // Subscribe to database changes
    const unsubscribe = subscribeToDbChanges((tables) => {
      // Check if any change affects the records table
      if (tables.includes('records') || tables.length === 0) {
        changeVersionRef.current += 1;
        setDbChangeSignal(changeVersionRef.current);
      }
    });
    
    return unsubscribe;
  }, []);

  // Parse query parameters from location - store them for later application
  useEffect(() => {
    try {
      const queryIndex = location.indexOf('?');
      const queryString = queryIndex >= 0 ? location.substring(queryIndex + 1) : '';
      const params = new URLSearchParams(queryString);
      
      const id = params.get("id");
      const search = params.get("search");
      
      if (id) {
        setSelectedRecordId(id);
        setUrlSearchQuery(null);
      } else if (search) {
        const decodedSearch = decodeURIComponent(search);
        setUrlSearchQuery(decodedSearch);
        setSelectedRecordId(null);
      } else {
        setUrlSearchQuery(null);
      }
    } catch (error) {
      console.error('[Records] Failed to parse query params:', error);
    }
  }, [location]);

  // Apply URL search query to input once records are loaded
  useEffect(() => {
    if (urlSearchQuery !== null && records.length > 0 && !isLoading) {
      setSearchQuery(urlSearchQuery);
      setUrlSearchQuery(null); // Clear after applying
    }
  }, [urlSearchQuery, records.length, isLoading]);

  const { tableColumns, customFieldColumns } = useSettings();
  const { enabledCustomFields } = useCustomFields();

  // Load records and custom field definitions with smart filtering
  useEffect(() => {
    const loadRecords = async () => {
      setIsLoading(true);
      try {
        // Load custom field definitions
        const fields = await db.customFields.toArray();
        setCustomFieldDefs(fields);
        
        // Count blockchain-discovered records for the toggle label
        const blockchainCount = await db.records
          .where('addressImportance')
          .anyOf(['blockchain-discovered', 'pending-review'])
          .count();
        setTotalBlockchainDiscovered(blockchainCount);
        
        // Query only the relevant importance tiers based on filter setting
        // Use indexed queries for performance - avoid full table scans
        let rawRecords: DbRecord[];
        
        if (includeBlockchainDiscovered) {
          // Load all records
          rawRecords = await db.records.toArray();
        } else {
          // Strategy: Use indexed queries only to avoid full table scans
          // 1. Get address records with user-curated importance tiers (indexed)
          const curatedAddresses = await db.records
            .where('addressImportance')
            .anyOf(USER_CURATED_TIERS)
            .toArray();
          
          // 2. Get legacy address records with null/undefined addressImportance (treat as manual)
          const legacyAddresses = await db.records
            .filter(r => r.type === 'address' && !r.addressImportance)
            .toArray();
          
          // 3. Get all transaction records (indexed by type)
          const transactions = await db.records
            .where('type')
            .equals('transaction')
            .toArray();
          
          // 4. Get all "other" type records (indexed by type)
          const otherRecords = await db.records
            .where('type')
            .equals('other')
            .toArray();
          
          rawRecords = [...curatedAddresses, ...legacyAddresses, ...transactions, ...otherRecords];
        }
        
        let decrypted: DbRecord[];
        
        if (isEncryptionReady()) {
          decrypted = await decryptRecords(rawRecords);
        } else {
          decrypted = rawRecords;
        }
        
        const convertedRecords: ConvertedRecord[] = decrypted.map(r => ({
          id: String(r.id),
          type: r.type as "address" | "transaction" | "other",
          inputString: r.inputString,
          label: r.label,
          notes: r.notes,
          tags: r.tags || [],
          categories: r.categories || [],
          seedName: r.seedName,
          walletSoftware: r.walletSoftware,
          owner: r.owner,
          walletName: r.walletName,
          privateKeyStatus: r.privateKeyStatus,
          source: r.source,
          customFields: r.customFields,
          derivationPath: r.derivationPath,
          chainType: r.chainType,
          vault: r.vault,
          addressImportance: r.addressImportance,
          syncDepth: r.syncDepth,
          maxSyncedDepth: r.maxSyncedDepth,
          discoveredInTxid: r.discoveredInTxid,
          discoveredFromRecordId: r.discoveredFromRecordId,
        }));
        
        setRecords(convertedRecords);
      } catch (error) {
        console.error('[Records] Failed to load records:', error);
      } finally {
        setIsLoading(false);
      }
    };
    
    loadRecords();
  }, [includeBlockchainDiscovered, dbChangeSignal]);

  // Extract unique values from records for filter dropdowns
  const uniqueFilterValues = useMemo(() => {
    return extractUniqueValues(records as unknown as Array<Record<string, unknown>>);
  }, [records]);

  // Filter records based on column filters, search query, including blockchain transaction search
  useEffect(() => {
    // First apply column filters
    const columnFiltered = applyColumnFilters(records as unknown as Array<Record<string, unknown>>, columnFilters) as unknown as ConvertedRecord[];
    
    if (!searchQuery) {
      setFilteredRecords(columnFiltered);
      setMatchingTxids([]);
      setTxidSearchResults([]);
      return;
    }

    const query = searchQuery.toLowerCase();
    
    // Then apply search query filter
    const filtered = columnFiltered.filter(record => 
      record.label?.toLowerCase().includes(query) ||
      record.inputString?.toLowerCase().includes(query) ||
      record.owner?.toLowerCase().includes(query) ||
      record.walletName?.toLowerCase().includes(query) ||
      record.notes?.toLowerCase().includes(query)
    );
    
    // Check if query looks like a transaction ID (64 hex characters)
    const isTxidSearch = /^[a-fA-F0-9]{8,64}$/.test(searchQuery.trim());
    
    if (isTxidSearch) {
      // Search blockchain transactions for matching txids
      const searchBlockchainTxs = async () => {
        try {
          const txQuery = searchQuery.toLowerCase().trim();
          
          // Search by txid prefix or full match
          const matchingTxs = await db.blockchainTransactions
            .filter(tx => tx.txid.toLowerCase().startsWith(txQuery) || tx.txid.toLowerCase().includes(txQuery))
            .toArray();
          
          if (matchingTxs.length > 0) {
            const txids = matchingTxs.map(tx => tx.txid);
            setMatchingTxids(txids);
            
            // Get participant addresses for matching transactions
            const participants = await db.transactionParticipants
              .where('txid')
              .anyOf(txids)
              .toArray();
            
            const txResults = matchingTxs.map(tx => ({
              txid: tx.txid,
              blockHeight: tx.blockHeight,
              blockTime: tx.blockTime,
              participantAddresses: participants
                .filter(p => p.txid === tx.txid)
                .map(p => p.address),
            }));
            
            setTxidSearchResults(txResults);
            
            // For txid searches, fetch ALL address records matching participant addresses
            // This overrides the blockchain toggle - we want to show all related addresses
            const participantAddresses = new Set(participants.map(p => p.address));
            
            // Fetch records for ALL participant addresses regardless of filter settings
            const allRelatedRawRecords = await db.records
              .where('inputString')
              .anyOf(Array.from(participantAddresses))
              .toArray();
            
            let relatedRecords: DbRecord[];
            if (isEncryptionReady()) {
              relatedRecords = await decryptRecords(allRelatedRawRecords);
            } else {
              relatedRecords = allRelatedRawRecords;
            }
            
            // Convert to display format
            const convertedRelated: ConvertedRecord[] = relatedRecords.map(r => ({
              id: String(r.id),
              type: r.type as "address" | "transaction" | "other",
              inputString: r.inputString,
              label: r.label,
              notes: r.notes,
              tags: r.tags || [],
              categories: r.categories || [],
              seedName: r.seedName,
              walletSoftware: r.walletSoftware,
              owner: r.owner,
              walletName: r.walletName,
              privateKeyStatus: r.privateKeyStatus,
              source: r.source,
              customFields: r.customFields,
              derivationPath: r.derivationPath,
              chainType: r.chainType,
              vault: r.vault,
              addressImportance: r.addressImportance,
              syncDepth: r.syncDepth,
              maxSyncedDepth: r.maxSyncedDepth,
              discoveredInTxid: r.discoveredInTxid,
              discoveredFromRecordId: r.discoveredFromRecordId,
            }));
            
            // Merge with any other filtered records (avoiding duplicates)
            const existingIds = new Set(convertedRelated.map(r => r.id));
            const additionalFromFilter = filtered.filter(r => !existingIds.has(r.id));
            
            setFilteredRecords([...convertedRelated, ...additionalFromFilter]);
          } else {
            setMatchingTxids([]);
            setTxidSearchResults([]);
            setFilteredRecords(filtered);
          }
        } catch (error) {
          console.error('[Records] Error searching blockchain transactions:', error);
          setMatchingTxids([]);
          setTxidSearchResults([]);
          setFilteredRecords(filtered);
        }
      };
      
      searchBlockchainTxs();
    } else {
      setMatchingTxids([]);
      setTxidSearchResults([]);
      setFilteredRecords(filtered);
    }
  }, [records, searchQuery, columnFilters]);

  // State for directly-loaded record (when accessed by URL but not in filtered view)
  const [directLoadedRecord, setDirectLoadedRecord] = useState<ConvertedRecord | null>(null);
  
  // Load specific record by ID if accessed via URL but not in filtered view
  useEffect(() => {
    if (!selectedRecordId || isLoading) return;
    
    // Check if record is already in the filtered list
    const existingRecord = records.find(r => r.id === selectedRecordId);
    if (existingRecord) {
      setDirectLoadedRecord(null);
      return;
    }
    
    // Record not in current view - load it directly
    const loadRecord = async () => {
      try {
        const record = await db.records.get(parseInt(selectedRecordId));
        if (!record) return;
        
        let decrypted: DbRecord[];
        if (isEncryptionReady()) {
          decrypted = await decryptRecords([record]);
        } else {
          decrypted = [record];
        }
        
        if (decrypted.length > 0) {
          const r = decrypted[0];
          setDirectLoadedRecord({
            id: String(r.id),
            type: r.type as "address" | "transaction" | "other",
            inputString: r.inputString,
            label: r.label,
            notes: r.notes,
            tags: r.tags || [],
            categories: r.categories || [],
            seedName: r.seedName,
            walletSoftware: r.walletSoftware,
            owner: r.owner,
            walletName: r.walletName,
            privateKeyStatus: r.privateKeyStatus,
            source: r.source,
            customFields: r.customFields,
            derivationPath: r.derivationPath,
            chainType: r.chainType,
            vault: r.vault,
            addressImportance: r.addressImportance,
            syncDepth: r.syncDepth,
            maxSyncedDepth: r.maxSyncedDepth,
            discoveredInTxid: r.discoveredInTxid,
            discoveredFromRecordId: r.discoveredFromRecordId,
          });
        }
      } catch (error) {
        console.error('[Records] Failed to load specific record:', error);
      }
    };
    
    loadRecord();
  }, [selectedRecordId, records, isLoading]);
  
  const selectedRecord = selectedRecordId 
    ? (records.find(r => r.id === selectedRecordId) || directLoadedRecord)
    : null;

  // Clear selection when records change (e.g., after delete)
  useEffect(() => {
    // Remove any selected IDs that are no longer in the records list
    const recordIds = new Set(records.map(r => r.id));
    setSelectedIds(prev => {
      const validSelected = new Set(Array.from(prev).filter(id => recordIds.has(id)));
      if (validSelected.size !== prev.size) {
        return validSelected;
      }
      return prev;
    });
  }, [records]);

  // Delete handlers
  const handleSingleDelete = async () => {
    if (!singleDeleteTarget) return;
    setIsDeleting(true);
    try {
      await deleteRecord(parseInt(singleDeleteTarget));
      toast({
        title: "Record deleted",
        description: "The record has been permanently deleted.",
      });
      setSingleDeleteTarget(null);
      if (selectedRecordId === singleDeleteTarget) {
        setSelectedRecordId(null);
      }
    } catch (error) {
      toast({
        title: "Delete failed",
        description: error instanceof Error ? error.message : "Failed to delete record",
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    setIsDeleting(true);
    try {
      const idsToDelete = Array.from(selectedIds);
      let successCount = 0;
      let failCount = 0;

      for (const id of idsToDelete) {
        try {
          await deleteRecord(parseInt(id));
          successCount++;
        } catch {
          failCount++;
        }
      }

      if (failCount === 0) {
        toast({
          title: "Records deleted",
          description: `Successfully deleted ${successCount} record${successCount !== 1 ? 's' : ''}.`,
        });
      } else {
        toast({
          title: "Partial deletion",
          description: `Deleted ${successCount} record${successCount !== 1 ? 's' : ''}, but ${failCount} failed.`,
          variant: "destructive",
        });
      }
      
      setSelectedIds(new Set());
      setBulkDeleteDialogOpen(false);
    } catch (error) {
      toast({
        title: "Delete failed",
        description: error instanceof Error ? error.message : "Failed to delete records",
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
    }
  };

  const handleDeleteRequest = (id: string) => {
    setSingleDeleteTarget(id);
  };

  // If viewing a specific record by ID, show detail-focused view
  if (selectedRecordId && selectedRecord && !searchQuery) {
    return (
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-2xl mx-auto space-y-6">
          <div className="flex items-center gap-4">
            <Button 
              variant="ghost" 
              size="icon" 
              onClick={() => navigate("/records")}
              data-testid="button-back"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <h1 className="text-2xl font-bold" data-testid="text-page-title">
                Record Details
              </h1>
              <p className="text-muted-foreground">
                View and edit metadata
              </p>
            </div>
          </div>

          <RecordDetailPanel
            open={true}
            record={selectedRecord}
            onClose={() => navigate("/records")}
            customFieldDefs={customFieldDefs}
          />
        </div>
      </div>
    );
  }

  // Default view: all records with search
  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center gap-4">
          <Button 
            variant="ghost" 
            size="icon" 
            onClick={() => navigate("/")}
            data-testid="button-back"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-page-title">
              Records
            </h1>
            <p className="text-muted-foreground">
              View and manage your Bitcoin metadata records
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <label htmlFor="search" className="text-sm font-medium">
                Search Records
              </label>
              <div className="mt-2 relative">
                <SearchIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="search"
                  placeholder="Search by label, address, txid, owner, wallet, or notes..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                  data-testid="input-search"
                />
              </div>
            </div>
            <div className="pt-6 flex items-center gap-2">
              <BlockchainToggle
                checked={includeBlockchainDiscovered}
                onCheckedChange={setIncludeBlockchainDiscovered}
                hiddenCount={totalBlockchainDiscovered}
              />
              
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-2" data-testid="button-column-settings">
                    <Settings2 className="h-4 w-4" />
                    Columns
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-64 max-h-[80vh] overflow-y-auto">
                  <div className="space-y-4">
                    <div>
                      <p className="text-sm font-semibold mb-2">Metadata Columns</p>
                      <div className="grid grid-cols-1 gap-2">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <Checkbox
                            checked={tableColumns.tags}
                            onCheckedChange={() => toggleTableColumn('tags')}
                            data-testid="checkbox-col-tags"
                          />
                          <span className="text-sm">Tags</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <Checkbox
                            checked={tableColumns.categories}
                            onCheckedChange={() => toggleTableColumn('categories')}
                            data-testid="checkbox-col-categories"
                          />
                          <span className="text-sm">Categories</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <Checkbox
                            checked={tableColumns.walletSoftware}
                            onCheckedChange={() => toggleTableColumn('walletSoftware')}
                            data-testid="checkbox-col-wallet"
                          />
                          <span className="text-sm">Wallet Software</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <Checkbox
                            checked={tableColumns.seedName}
                            onCheckedChange={() => toggleTableColumn('seedName')}
                            data-testid="checkbox-col-seed"
                          />
                          <span className="text-sm">Seed Name</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <Checkbox
                            checked={tableColumns.privateKeyStatus}
                            onCheckedChange={() => toggleTableColumn('privateKeyStatus')}
                            data-testid="checkbox-col-privatekey"
                          />
                          <span className="text-sm">Private Key</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <Checkbox
                            checked={tableColumns.hasAttachments}
                            onCheckedChange={() => toggleTableColumn('hasAttachments')}
                            data-testid="checkbox-col-attachments"
                          />
                          <span className="text-sm">Attachments</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <Checkbox
                            checked={tableColumns.source}
                            onCheckedChange={() => toggleTableColumn('source')}
                            data-testid="checkbox-col-source"
                          />
                          <span className="text-sm">Source</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <Checkbox
                            checked={tableColumns.owner}
                            onCheckedChange={() => toggleTableColumn('owner')}
                            data-testid="checkbox-col-owner"
                          />
                          <span className="text-sm">Owner</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <Checkbox
                            checked={tableColumns.walletName}
                            onCheckedChange={() => toggleTableColumn('walletName')}
                            data-testid="checkbox-col-walletname"
                          />
                          <span className="text-sm">Wallet Name</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <Checkbox
                            checked={tableColumns.firstSeen}
                            onCheckedChange={() => toggleTableColumn('firstSeen')}
                            data-testid="checkbox-col-firstseen"
                          />
                          <span className="text-sm">First Seen</span>
                        </label>
                      </div>
                    </div>

                    <Separator />

                    <div>
                      <p className="text-sm font-semibold mb-2">Blockchain Data</p>
                      <div className="grid grid-cols-1 gap-2">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <Checkbox
                            checked={tableColumns.balance}
                            onCheckedChange={() => toggleTableColumn('balance')}
                            data-testid="checkbox-col-balance"
                          />
                          <span className="text-sm">BTC Balance</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <Checkbox
                            checked={tableColumns.lastTxDate}
                            onCheckedChange={() => toggleTableColumn('lastTxDate')}
                            data-testid="checkbox-col-lasttxdate"
                          />
                          <span className="text-sm">Last Tx Date</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <Checkbox
                            checked={tableColumns.txCount}
                            onCheckedChange={() => toggleTableColumn('txCount')}
                            data-testid="checkbox-col-txcount"
                          />
                          <span className="text-sm">Tx Count</span>
                        </label>
                      </div>
                    </div>

                    {enabledCustomFields.length > 0 && (
                      <>
                        <Separator />
                        <div>
                          <p className="text-sm font-semibold mb-2">Custom Fields</p>
                          <div className="grid grid-cols-1 gap-2">
                            {enabledCustomFields.map((field) => (
                              <label key={field.slug} className="flex items-center gap-2 cursor-pointer">
                                <Checkbox
                                  checked={customFieldColumns[field.slug] || false}
                                  onCheckedChange={() => toggleCustomFieldColumn(field.slug)}
                                  data-testid={`checkbox-col-custom-${field.slug}`}
                                />
                                <span className="text-sm">{field.name}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          </div>
          
          <RecordFilters
            filters={columnFilters}
            onFiltersChange={setColumnFilters}
            uniqueValues={uniqueFilterValues}
          />
        </div>

        {/* Blockchain Transaction Search Results */}
        {txidSearchResults.length > 0 && (
          <Card className="border-primary/30 bg-primary/5">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Hash className="h-4 w-4" />
                Blockchain Transactions Found ({txidSearchResults.length})
              </CardTitle>
              <CardDescription>
                Synced transactions matching your search. Click to view on Transactions page.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {txidSearchResults.map((tx) => (
                <div 
                  key={tx.txid}
                  className="p-3 rounded-lg bg-background border hover-elevate cursor-pointer"
                  onClick={() => navigate(`/transactions?search=${tx.txid}`)}
                  data-testid={`tx-result-${tx.txid.slice(0, 8)}`}
                >
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <ClickableAddress 
                      address={tx.txid}
                      className="flex-1 min-w-0"
                    />
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="text-xs">
                        Block {tx.blockHeight.toLocaleString()}
                      </Badge>
                      <a
                        href={`https://mempool.space/tx/${tx.txid}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="text-muted-foreground hover:text-primary"
                        data-testid={`tx-explorer-${tx.txid.slice(0, 8)}`}
                      >
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(tx.blockTime * 1000).toLocaleDateString()} - {tx.participantAddresses.length} addresses involved
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Bulk Action Bar */}
        {selectedIds.size > 0 && (
          <div className="flex items-center justify-between p-3 rounded-lg bg-muted border">
            <div className="flex items-center gap-3">
              <Badge variant="secondary" className="text-sm">
                {selectedIds.size} selected
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedIds(new Set())}
                data-testid="button-clear-selection"
              >
                <X className="h-4 w-4 mr-1" />
                Clear
              </Button>
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setBulkDeleteDialogOpen(true)}
              data-testid="button-bulk-delete"
            >
              <Trash2 className="h-4 w-4 mr-1" />
              Delete Selected
            </Button>
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-3">
          {/* Records List */}
          <div className="lg:col-span-2">
            <Card>
              <CardHeader>
                <CardTitle>
                  {searchQuery 
                    ? txidSearchResults.length > 0 
                      ? `Related Address Records (${filteredRecords.length})`
                      : `Search Results (${filteredRecords.length})` 
                    : `All Records (${filteredRecords.length})`}
                </CardTitle>
                <CardDescription>
                  {txidSearchResults.length > 0 
                    ? "Addresses involved in the matching transactions"
                    : "Click on a record to view or edit details"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <div className="text-center py-8 text-muted-foreground">
                    Loading records...
                  </div>
                ) : filteredRecords.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    {searchQuery 
                      ? txidSearchResults.length > 0
                        ? "No address records found for this transaction. Addresses may not have been synced yet."
                        : "No records match your search"
                      : "No records found"}
                  </div>
                ) : (
                  <RecordTable 
                    records={filteredRecords}
                    onRowClick={setSelectedRecordId}
                    onDelete={handleDeleteRequest}
                    selectionEnabled={true}
                    selectedIds={selectedIds}
                    onSelectionChange={setSelectedIds}
                  />
                )}
              </CardContent>
            </Card>
          </div>

          {/* Detail Panel */}
          {selectedRecord && (
            <div className="lg:col-span-1">
              <RecordDetailPanel
                open={true}
                record={selectedRecord}
                onClose={() => setSelectedRecordId(null)}
                customFieldDefs={customFieldDefs}
              />
            </div>
          )}
        </div>
      </div>

      {/* Bulk Delete Confirmation Dialog */}
      <AlertDialog open={bulkDeleteDialogOpen} onOpenChange={setBulkDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedIds.size} Record{selectedIds.size !== 1 ? 's' : ''}?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete the selected record{selectedIds.size !== 1 ? 's' : ''} and all associated attachments.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting} data-testid="button-cancel-bulk-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-bulk-delete"
            >
              {isDeleting ? "Deleting..." : `Delete ${selectedIds.size} Record${selectedIds.size !== 1 ? 's' : ''}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Single Delete Confirmation Dialog */}
      <AlertDialog open={!!singleDeleteTarget} onOpenChange={(open) => !open && setSingleDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Record?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete this record and all associated attachments.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting} data-testid="button-cancel-single-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleSingleDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-single-delete"
            >
              {isDeleting ? "Deleting..." : "Delete Record"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

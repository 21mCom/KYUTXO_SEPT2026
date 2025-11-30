import { useState, useEffect } from "react";
import { Plus, Grid3x3, List, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchBar } from "@/components/SearchBar";
import { FilterBar } from "@/components/FilterBar";
import { RecordCard } from "@/components/RecordCard";
import { RecordTable } from "@/components/RecordTable";
import { RecordDetailPanel } from "@/components/RecordDetailPanel";
import { RecordFormDialog, type TransactionAddresses } from "@/components/RecordFormDialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRecords, createRecord, createRecordWithAttachments, updateRecord, deleteRecord, searchRecords, filterRecords } from "@/hooks/use-records";
import { useEncryptedTags, useEncryptedCategories } from "@/hooks/use-encrypted-records";
import { useOwners } from "@/hooks/use-owners";
import { useWalletNames } from "@/hooks/use-wallet-names";
import { useSeedNames } from "@/hooks/use-seed-names";
import { useWalletSoftware } from "@/hooks/use-wallet-software";
import { syncTagsToMaster, syncCategoriesToMaster, isEncryptionReady, findRecordByInputString } from "@/lib/encryptionFacade";
import { useCustomFields, useSettings } from "@/hooks/use-settings";
import { useToast } from "@/hooks/use-toast";
import { validateBitcoinInput } from "@/lib/bitcoin";
import { getRecordAttachments } from "@/lib/attachments";
import type { Record } from "@/lib/database";
import type { Attachment } from "@/lib/database";

export default function Dashboard() {
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"grid" | "table">("table");
  const [filter, setFilter] = useState<{
    type?: "address" | "transaction" | "other" | "all";
    tags: string[];
    categories: string[];
  }>({
    type: "all",
    tags: [],
    categories: [],
  });
  const [filteredRecords, setFilteredRecords] = useState<Record[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const ITEMS_PER_PAGE = 50;
  const [selectedRecordId, setSelectedRecordId] = useState<number | undefined>();
  const [selectedRecordAttachments, setSelectedRecordAttachments] = useState<Attachment[]>([]);
  const [showDetail, setShowDetail] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingRecord, setEditingRecord] = useState<Record | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);

  const { records, isLoading } = useRecords();
  const { tags } = useEncryptedTags();
  const { categories } = useEncryptedCategories();
  const { owners } = useOwners();
  const { walletNames } = useWalletNames();
  const { seedNames } = useSeedNames();
  const { walletSoftware } = useWalletSoftware();
  const { enabledCustomFields } = useCustomFields();
  const { settings } = useSettings();
  const { toast } = useToast();

  // Load attachments when selected record changes
  useEffect(() => {
    const loadAttachments = async () => {
      if (selectedRecordId !== undefined) {
        const attachments = await getRecordAttachments(selectedRecordId);
        setSelectedRecordAttachments(attachments);
      } else {
        setSelectedRecordAttachments([]);
      }
    };

    loadAttachments();
  }, [selectedRecordId]);

  // Apply search and filters
  useEffect(() => {
    const applyFilters = async () => {
      let results = [...records];

      // Apply type filter
      if (filter.type && filter.type !== "all") {
        results = results.filter(r => r.type === filter.type);
      }

      // Apply tag filter
      if (filter.tags.length > 0) {
        results = results.filter(r => 
          filter.tags.some(tag => r.tags.includes(tag))
        );
      }

      // Apply category filter
      if (filter.categories.length > 0) {
        results = results.filter(r => 
          filter.categories.some(cat => r.categories.includes(cat))
        );
      }

      // Apply search (on already filtered results)
      if (search.trim()) {
        const lowerQuery = search.toLowerCase();
        results = results.filter(record =>
          record.label.toLowerCase().includes(lowerQuery) ||
          record.inputString.toLowerCase().includes(lowerQuery) ||
          record.notes?.toLowerCase().includes(lowerQuery) ||
          record.tags.some(tag => tag.toLowerCase().includes(lowerQuery)) ||
          record.categories.some(cat => cat.toLowerCase().includes(lowerQuery))
        );
      }

      // Sort by updatedAt descending
      results.sort((a, b) => b.updatedAt - a.updatedAt);

      setFilteredRecords(results);
    };

    applyFilters();
  }, [search, filter, records]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [search, filter]);

  // Pagination calculations
  const totalPages = Math.max(1, Math.ceil(filteredRecords.length / ITEMS_PER_PAGE));
  // Clamp currentPage to valid range
  const safePage = Math.min(currentPage, totalPages);
  const startIndex = (safePage - 1) * ITEMS_PER_PAGE;
  const endIndex = startIndex + ITEMS_PER_PAGE;
  const paginatedRecords = filteredRecords.slice(startIndex, endIndex);
  
  // Auto-correct page if it's out of bounds (e.g., after filter changes)
  useEffect(() => {
    if (currentPage > totalPages && totalPages > 0) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const selectedRecord = records.find(r => r.id === selectedRecordId);

  // Compute unique values for dropdowns (combining existing record values with master lists)
  const uniqueSeedNames = Array.from(new Set([
    ...seedNames.map(s => s.name).filter(n => n && n !== '[encrypted]'),
    ...records.map(r => r.seedName).filter((s): s is string => !!s)
  ]));
  const uniqueWalletSoftware = Array.from(new Set([
    ...walletSoftware.map(w => w.name).filter(n => n && n !== '[encrypted]'),
    ...records.map(r => r.walletSoftware).filter((s): s is string => !!s)
  ]));
  const uniqueOwners = Array.from(new Set([
    ...owners.map(o => o.name).filter(n => n && n !== '[encrypted]'),
    ...records.map(r => r.owner).filter((s): s is string => !!s)
  ]));
  const uniqueWalletNames = Array.from(new Set([
    ...walletNames.map(w => w.name).filter(n => n && n !== '[encrypted]'),
    ...records.map(r => r.walletName).filter((s): s is string => !!s)
  ]));

  const handleRecordClick = (id: number) => {
    setSelectedRecordId(id);
    setShowDetail(true);
  };

  // Check for duplicate record by inputString
  const handleCheckDuplicate = async (inputString: string) => {
    if (!isEncryptionReady()) return undefined;
    try {
      return await findRecordByInputString(inputString);
    } catch (error) {
      console.error("Error checking for duplicate:", error);
      return undefined;
    }
  };

  const handleCreateRecord = async (data: any, files: File[] = [], transactionAddresses?: TransactionAddresses) => {
    try {
      let recordType = data.type;

      // For Bitcoin types, validate the input; for "other" type, skip validation
      if (data.type !== "other") {
        const validation = validateBitcoinInput(data.inputString);
        if (!validation.isValid) {
          toast({
            variant: "destructive",
            title: "Invalid Input",
            description: validation.error || "Please enter a valid Bitcoin address or transaction ID",
          });
          return;
        }
        // Auto-detect type if not specified
        recordType = validation.type || data.type;
      }

      setIsSubmitting(true);

      // Check if this is actually an update (duplicate was detected and user is editing)
      let existingRecord: Record | undefined;
      if (isEncryptionReady()) {
        try {
          existingRecord = await findRecordByInputString(data.inputString);
        } catch (error) {
          console.error("Error checking for duplicate:", error);
        }
      }

      // Handle addressImportance - verified if explicitly marked, otherwise manual for new records
      let addressImportance = data.addressImportance;
      if (data.markAsVerified) {
        addressImportance = 'verified';
      } else if (!addressImportance) {
        addressImportance = 'manual';
      }
      
      const recordData = {
        type: recordType,
        inputString: data.inputString,
        label: data.label,
        notes: data.notes || "",
        amount: data.amount ? parseFloat(data.amount) : undefined,
        date: data.date || "",
        tags: data.tags || [],
        categories: data.categories || [],
        seedName: data.seedName || "",
        walletSoftware: data.walletSoftware || "",
        owner: data.owner || "",
        walletName: data.walletName || "",
        privateKeyStatus: data.privateKeyStatus || "",
        source: data.source || 'manual',
        customFields: data.customFields,
        addressImportance,
      };

      // If record exists, update it instead of creating
      if (existingRecord?.id) {
        await updateRecord(existingRecord.id, recordData);
        
        // Upload any new files for existing record
        if (files.length > 0) {
          setUploadProgress({ current: 0, total: files.length });
          const { uploadAttachment } = await import("@/lib/attachments");
          
          let uploadedCount = 0;
          for (let i = 0; i < files.length; i++) {
            try {
              await uploadAttachment(existingRecord.id, files[i], data.inputString);
              uploadedCount++;
            } catch (error) {
              console.error(`Failed to upload ${files[i].name}:`, error);
            }
            setUploadProgress({ current: i + 1, total: files.length });
          }
          
          toast({
            title: "Record Updated",
            description: `${data.label} updated with ${uploadedCount} new file(s)`,
          });
        } else {
          // Also create address records for transactions when updating (in case they weren't created before)
          if (transactionAddresses && recordType === 'transaction') {
            let addressesCreated = 0;
            let addressesSkipped = 0;
            const txidShort = transactionAddresses.txid.substring(0, 8);
            const txDate = new Date(transactionAddresses.blockTime * 1000).toLocaleDateString();
            
            console.log(`[Update path] Creating address records from tx ${txidShort}: ${transactionAddresses.inputs.length} inputs, ${transactionAddresses.outputs.length} outputs`);
            
            for (const input of transactionAddresses.inputs) {
              let existingAddr: Record | undefined;
              try {
                existingAddr = await findRecordByInputString(input.address);
              } catch (e) { /* ignore */ }
              
              if (!existingAddr) {
                try {
                  await createRecord({
                    type: 'address',
                    inputString: input.address,
                    label: `TX Input ${txDate}`,
                    notes: `Input address from transaction ${txidShort}...`,
                    tags: [],
                    categories: [],
                    owner: 'Pending Review',
                    walletName: '',
                    source: `tx-import:${transactionAddresses.txid}`,
                    addressImportance: 'pending-review',
                  });
                  addressesCreated++;
                } catch (createError) {
                  console.error(`Failed to create input address record:`, createError);
                }
              } else {
                addressesSkipped++;
              }
            }
            
            for (const output of transactionAddresses.outputs) {
              let existingAddr: Record | undefined;
              try {
                existingAddr = await findRecordByInputString(output.address);
              } catch (e) { /* ignore */ }
              
              if (!existingAddr) {
                try {
                  await createRecord({
                    type: 'address',
                    inputString: output.address,
                    label: `TX Output ${txDate}`,
                    notes: `Output address from transaction ${txidShort}...`,
                    tags: [],
                    categories: [],
                    owner: 'Pending Review',
                    walletName: '',
                    source: `tx-import:${transactionAddresses.txid}`,
                    addressImportance: 'pending-review',
                  });
                  addressesCreated++;
                } catch (createError) {
                  console.error(`Failed to create output address record:`, createError);
                }
              } else {
                addressesSkipped++;
              }
            }
            
            console.log(`[Update path] Address creation complete: ${addressesCreated} created, ${addressesSkipped} skipped`);
            
            toast({
              title: "Record Updated",
              description: `${data.label} updated with ${addressesCreated} new address records`,
            });
          } else {
            toast({
              title: "Record Updated",
              description: `${data.label} has been updated successfully`,
            });
          }
        }
      } else {
        // Create new record
        if (files.length > 0) {
          setUploadProgress({ current: 0, total: files.length });
          
          const result = await createRecordWithAttachments(
            recordData,
            files,
            (current, total) => setUploadProgress({ current, total })
          );

          if (result.failedCount > 0) {
            toast({
              title: "Record Created",
              description: `${data.label} saved with ${result.uploadedCount} of ${files.length} files uploaded`,
            });
          } else {
            toast({
              title: "Record Created",
              description: `${data.label} saved with ${result.uploadedCount} file(s)`,
            });
          }
        } else {
          await createRecord(recordData);
          
          // If transaction addresses were fetched, create address records for inputs/outputs
          if (transactionAddresses && recordType === 'transaction') {
            let addressesCreated = 0;
            let addressesSkipped = 0;
            const txidShort = transactionAddresses.txid.substring(0, 8);
            const txDate = new Date(transactionAddresses.blockTime * 1000).toLocaleDateString();
            
            console.log(`Creating address records from tx ${txidShort}: ${transactionAddresses.inputs.length} inputs, ${transactionAddresses.outputs.length} outputs`);
            
            // Create input address records
            for (const input of transactionAddresses.inputs) {
              // Check if address already exists
              let existingAddr: Record | undefined;
              try {
                existingAddr = await findRecordByInputString(input.address);
              } catch (e) {
                console.log(`Error checking for existing address ${input.address}:`, e);
              }
              
              if (!existingAddr) {
                try {
                  await createRecord({
                    type: 'address',
                    inputString: input.address,
                    label: `TX Input ${txDate}`,
                    notes: `Input address from transaction ${txidShort}...`,
                    tags: [],
                    categories: [],
                    owner: 'Pending Review',
                    walletName: '',
                    source: `tx-import:${transactionAddresses.txid}`,
                    addressImportance: 'pending-review',
                  });
                  addressesCreated++;
                } catch (createError) {
                  console.error(`Failed to create input address record for ${input.address}:`, createError);
                }
              } else {
                addressesSkipped++;
              }
            }
            
            // Create output address records
            for (const output of transactionAddresses.outputs) {
              // Check if address already exists
              let existingAddr: Record | undefined;
              try {
                existingAddr = await findRecordByInputString(output.address);
              } catch (e) {
                console.log(`Error checking for existing address ${output.address}:`, e);
              }
              
              if (!existingAddr) {
                try {
                  await createRecord({
                    type: 'address',
                    inputString: output.address,
                    label: `TX Output ${txDate}`,
                    notes: `Output address from transaction ${txidShort}...`,
                    tags: [],
                    categories: [],
                    owner: 'Pending Review',
                    walletName: '',
                    source: `tx-import:${transactionAddresses.txid}`,
                    addressImportance: 'pending-review',
                  });
                  addressesCreated++;
                } catch (createError) {
                  console.error(`Failed to create output address record for ${output.address}:`, createError);
                }
              } else {
                addressesSkipped++;
              }
            }
            
            console.log(`Address creation complete: ${addressesCreated} created, ${addressesSkipped} skipped (already exist)`);
            
            toast({
              title: "Records Created",
              description: `Transaction saved with ${addressesCreated} new address records (${addressesSkipped} already existed)`,
            });
          } else {
            toast({
              title: "Record Created",
              description: `${data.label} has been saved successfully`,
            });
          }
        }
      }

      // Sync tags and categories to master tables for autosuggest
      // Wrapped in try/catch to ensure record save succeeds even if sync fails
      try {
        if (isEncryptionReady()) {
          if (recordData.tags.length > 0) {
            await syncTagsToMaster(recordData.tags);
          }
          if (recordData.categories.length > 0) {
            await syncCategoriesToMaster(recordData.categories);
          }
        }
      } catch (syncError) {
        console.error("Failed to sync tags/categories to master tables:", syncError);
      }

      setShowForm(false);
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to save record",
      });
    } finally {
      setIsSubmitting(false);
      setUploadProgress(null);
    }
  };

  const handleUpdateRecord = async (data: any, files: File[] = []) => {
    if (!editingRecord?.id) return;

    try {
      // For Bitcoin types, validate the input; for "other" type, skip validation
      if (data.type !== "other") {
        const validation = validateBitcoinInput(data.inputString);
        if (!validation.isValid) {
          toast({
            variant: "destructive",
            title: "Invalid Input",
            description: validation.error || "Please enter a valid Bitcoin address or transaction ID",
          });
          return;
        }
      }

      setIsSubmitting(true);

      // Handle addressImportance - can upgrade but never downgrade from verified
      let addressImportance = editingRecord.addressImportance;
      if (data.markAsVerified || data.addressImportance === 'verified') {
        addressImportance = 'verified';
      }
      
      await updateRecord(editingRecord.id, {
        inputString: data.inputString,
        label: data.label,
        notes: data.notes || "",
        amount: data.amount ? parseFloat(data.amount) : undefined,
        date: data.date || "",
        tags: data.tags || [],
        categories: data.categories || [],
        seedName: data.seedName || "",
        walletSoftware: data.walletSoftware || "",
        owner: data.owner || "",
        walletName: data.walletName || "",
        privateKeyStatus: data.privateKeyStatus || "",
        source: data.source || 'manual',
        customFields: data.customFields,
        addressImportance,
      });

      // Upload any new files for existing record
      if (files.length > 0) {
        setUploadProgress({ current: 0, total: files.length });
        const { uploadAttachment } = await import("@/lib/attachments");
        
        let uploadedCount = 0;
        for (let i = 0; i < files.length; i++) {
          try {
            await uploadAttachment(editingRecord.id, files[i], data.inputString);
            uploadedCount++;
          } catch (error) {
            console.error(`Failed to upload ${files[i].name}:`, error);
          }
          setUploadProgress({ current: i + 1, total: files.length });
        }

        toast({
          title: "Record Updated",
          description: `${data.label} updated with ${uploadedCount} new file(s)`,
        });
      } else {
        toast({
          title: "Record Updated",
          description: `${data.label} has been updated successfully`,
        });
      }

      // Sync tags and categories to master tables for autosuggest
      // Wrapped in try/catch to ensure record save succeeds even if sync fails
      try {
        if (isEncryptionReady()) {
          const updatedTags = data.tags || [];
          const updatedCategories = data.categories || [];
          if (updatedTags.length > 0) {
            await syncTagsToMaster(updatedTags);
          }
          if (updatedCategories.length > 0) {
            await syncCategoriesToMaster(updatedCategories);
          }
        }
      } catch (syncError) {
        console.error("Failed to sync tags/categories to master tables:", syncError);
      }

      setShowForm(false);
      setEditingRecord(undefined);
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to update record",
      });
    } finally {
      setIsSubmitting(false);
      setUploadProgress(null);
    }
  };

  const handleDeleteRecord = async (id: number) => {
    try {
      await deleteRecord(id);
      toast({
        title: "Record Deleted",
        description: "The record has been deleted successfully",
      });
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to delete record",
      });
    }
  };

  const handleEditRecord = (id: number) => {
    const record = records.find(r => r.id === id);
    if (record) {
      setEditingRecord(record);
      setShowForm(true);
      setShowDetail(false);
    }
  };

  const handleSyncDeeper = async (id: number) => {
    const record = records.find(r => r.id === id);
    if (!record || record.type !== 'address') return;

    // Calculate the target depth: one level deeper than current maxSyncedDepth
    // But ensure we at least sync the record itself (syncDepth) and one level of children
    const recordSyncDepth = record.syncDepth ?? 0;
    const currentMaxSynced = record.maxSyncedDepth ?? -1;
    
    // targetDepth must be at least recordSyncDepth + 1 to process this record and discover children
    // Then we add 1 more because maxDepth is exclusive
    const minTargetDepth = recordSyncDepth + 2;
    const targetFromSynced = currentMaxSynced + 2;
    const targetDepth = Math.max(minTargetDepth, targetFromSynced);
    
    const maxAllowedDepth = 5; // Hard ceiling to prevent runaway syncing

    if (currentMaxSynced >= maxAllowedDepth - 1) {
      toast({
        title: "Maximum Depth Reached",
        description: `This address has already been synced to the maximum depth (${maxAllowedDepth - 1}).`,
      });
      return;
    }

    // Display the actual depth we'll sync to (which is targetDepth - 1 since maxDepth is exclusive)
    const displayFromDepth = Math.max(recordSyncDepth, currentMaxSynced + 1);
    const displayToDepth = targetDepth - 1;

    toast({
      title: "Syncing...",
      description: `Starting deeper sync for ${record.label || record.inputString.substring(0, 12)} (depth ${displayFromDepth} → ${displayToDepth})...`,
    });

    try {
      const { transactionSyncService } = await import("@/lib/transaction-sync");
      
      transactionSyncService.setProgressCallback((progress) => {
        if (progress.phase === 'complete') {
          toast({
            title: "Sync Complete",
            description: `Found ${progress.transactionsNew || 0} new transactions, ${progress.newAddressRecords || 0} new addresses`,
          });
        }
      });

      await transactionSyncService.syncWithDepth({
        sourceFilter: 'all',
        maxDepth: Math.min(targetDepth, maxAllowedDepth), // Use the calculated target but cap at max
        specificRecordIds: [id],
      });
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Sync Failed",
        description: error instanceof Error ? error.message : "Failed to sync",
      });
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="border-b p-4 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <SearchBar
            value={search}
            onChange={setSearch}
            placeholder="Search records..."
            className="max-w-md"
          />
          <div className="flex items-center gap-2">
            <Tabs value={view} onValueChange={(v) => setView(v as "grid" | "table")}>
              <TabsList>
                <TabsTrigger value="table" data-testid="button-view-table">
                  <List className="h-4 w-4" />
                </TabsTrigger>
                <TabsTrigger value="grid" data-testid="button-view-grid">
                  <Grid3x3 className="h-4 w-4" />
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Button onClick={() => setShowForm(true)} data-testid="button-create-record">
              <Plus className="h-4 w-4 mr-2" />
              New Record
            </Button>
          </div>
        </div>

        <FilterBar
          filter={filter}
          onChange={setFilter}
          availableTags={tags.map(t => t.name).filter(n => n && n !== '[encrypted]')}
          availableCategories={categories.map(c => c.name).filter(n => n && n !== '[encrypted]')}
          tableColumns={settings?.tableColumns}
        />
      </div>

      <div className="flex-1 overflow-auto p-4">
        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <p className="text-muted-foreground">Loading records...</p>
          </div>
        ) : filteredRecords.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 space-y-4">
            <p className="text-muted-foreground">No records found</p>
            <Button onClick={() => setShowForm(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Create First Record
            </Button>
          </div>
        ) : (
          <>
            {view === "grid" ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {paginatedRecords.map((record) => {
                  const stringId = record.id !== undefined ? String(record.id) : "";
                  return (
                    <RecordCard
                      key={record.id}
                      {...record}
                      id={stringId}
                      attachmentCount={0}
                      onClick={() => handleRecordClick(record.id!)}
                      onEdit={() => handleEditRecord(record.id!)}
                      onDelete={() => handleDeleteRecord(record.id!)}
                    />
                  );
                })}
              </div>
            ) : (
              <RecordTable
                records={paginatedRecords.map(r => {
                  const stringId = r.id !== undefined ? String(r.id) : "";
                  return { ...r, id: stringId };
                })}
                onRowClick={(id) => handleRecordClick(Number(id))}
                onEdit={(id) => handleEditRecord(Number(id))}
                onDelete={(id) => handleDeleteRecord(Number(id))}
                onSyncDeeper={(id) => handleSyncDeeper(Number(id))}
              />
            )}

            {/* Pagination Controls */}
            {filteredRecords.length > ITEMS_PER_PAGE && (
              <div className="flex items-center justify-between border-t pt-4 mt-4">
                <div className="text-sm text-muted-foreground">
                  Showing {startIndex + 1}-{Math.min(endIndex, filteredRecords.length)} of {filteredRecords.length} records
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={safePage === 1}
                    data-testid="button-prev-page"
                  >
                    <ChevronLeft className="h-4 w-4 mr-1" />
                    Previous
                  </Button>
                  <span className="text-sm px-2">
                    Page {safePage} of {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={safePage === totalPages}
                    data-testid="button-next-page"
                  >
                    Next
                    <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <RecordDetailPanel
        open={showDetail}
        onClose={() => {
          setShowDetail(false);
          setSelectedRecordId(undefined);
        }}
        onEdit={() => {
          if (selectedRecordId) {
            handleEditRecord(selectedRecordId);
          }
        }}
        record={selectedRecord ? { ...selectedRecord, id: String(selectedRecord.id) } : undefined}
        attachments={selectedRecordAttachments}
        onAttachmentsChange={async () => {
          if (selectedRecordId !== undefined) {
            const attachments = await getRecordAttachments(selectedRecordId);
            setSelectedRecordAttachments(attachments);
          }
        }}
      />

      <RecordFormDialog
        open={showForm}
        onClose={() => {
          setShowForm(false);
          setEditingRecord(undefined);
        }}
        onSave={editingRecord ? handleUpdateRecord : handleCreateRecord}
        initialData={editingRecord ? {
          ...editingRecord,
          amount: editingRecord.amount?.toString() || "",
        } : undefined}
        isSubmitting={isSubmitting}
        uploadProgress={uploadProgress}
        availableSeedNames={uniqueSeedNames}
        availableWalletSoftware={uniqueWalletSoftware}
        availableOwners={uniqueOwners}
        availableWalletNames={uniqueWalletNames}
        availableTags={tags.map(t => t.name).filter(n => n && n !== '[encrypted]')}
        availableCategories={categories.map(c => c.name).filter(n => n && n !== '[encrypted]')}
        enabledCustomFields={enabledCustomFields}
        onCheckDuplicate={handleCheckDuplicate}
      />
    </div>
  );
}

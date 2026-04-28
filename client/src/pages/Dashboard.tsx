import { useState, useEffect, useMemo } from "react";
import { Plus, Grid3x3, List, ChevronLeft, ChevronRight, Trash2, X, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { BlockchainToggle } from "@/components/BlockchainToggle";
import { SearchBar } from "@/components/SearchBar";
import { FilterBar } from "@/components/FilterBar";
import { RecordFilters, ColumnFilter, applyColumnFilters } from "@/components/RecordFilters";
import { RecordCard } from "@/components/RecordCard";
import { RecordTable } from "@/components/RecordTable";
import { RecordDetailPanel } from "@/components/RecordDetailPanel";
import { RecordFormDialog, type TransactionAddresses } from "@/components/RecordFormDialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useFilteredRecords, createRecord, createRecordWithAttachments, updateRecord, deleteRecord, searchRecords, filterRecords } from "@/hooks/use-records";
import { useTags } from "@/hooks/use-tags";
import { useCategories } from "@/hooks/use-categories";
import { useOwners } from "@/hooks/use-owners";
import { useWalletNames } from "@/hooks/use-wallet-names";
import { useSeedNames } from "@/hooks/use-seed-names";
import { useWalletSoftware } from "@/hooks/use-wallet-software";
import { syncTagsToMaster, syncCategoriesToMaster } from "@/lib/dataFacade";
import { beginBulkOperation, endBulkOperation } from "@/lib/database";
import { useCustomFields, useSettings, toggleTableColumn, toggleCustomFieldColumn } from "@/hooks/use-settings";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { useAddressStats } from "@/hooks/use-address-stats";
import { validateBitcoinInput } from "@/lib/bitcoin";
import { getRecordAttachments } from "@/lib/attachments";
import type { Record } from "@/lib/database";
import type { Attachment } from "@/lib/database";

type SortDirection = "asc" | "desc" | null;
type SortColumn = "type" | "label" | "inputString" | "tags" | "categories" | "walletSoftware" | "seedName" | "privateKeyStatus" | "attachments" | "source" | "owner" | "walletName" | "balance" | "lastTxDate" | "txCount" | string;

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
  const [sortColumn, setSortColumn] = useState<SortColumn | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>(null);
  const [selectedRecordId, setSelectedRecordId] = useState<number | undefined>();
  const [selectedRecordAttachments, setSelectedRecordAttachments] = useState<Attachment[]>([]);
  const [showDetail, setShowDetail] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingRecord, setEditingRecord] = useState<Record | undefined>();
  const [editingRecordAttachments, setEditingRecordAttachments] = useState<Attachment[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);
  
  // Smart filtering: exclude blockchain-discovered records by default for performance
  // This filters at the DATABASE level, avoiding loading records we don't need
  const [includeBlockchainDiscovered, setIncludeBlockchainDiscovered] = useState(false);
  
  // Delete confirmation state
  const [deleteConfirmTarget, setDeleteConfirmTarget] = useState<number | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  
  // Bulk selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteDialogOpen, setBulkDeleteDialogOpen] = useState(false);
  
  // Column filters state
  const [columnFilters, setColumnFilters] = useState<ColumnFilter[]>([]);

  const hasClientSideFilters = search.trim() !== '' || 
    (filter.type !== undefined && filter.type !== 'all') || 
    filter.tags.length > 0 || 
    filter.categories.length > 0 || 
    columnFilters.length > 0 ||
    sortColumn !== null;

  const paginationOptions = useMemo(() => {
    if (hasClientSideFilters) return undefined;
    return { offset: (currentPage - 1) * ITEMS_PER_PAGE, limit: ITEMS_PER_PAGE };
  }, [hasClientSideFilters, currentPage, ITEMS_PER_PAGE]);

  const { records, isLoading, blockchainDiscoveredCount, totalCount } = useFilteredRecords(includeBlockchainDiscovered, paginationOptions);
  const { tags } = useTags();
  const { categories } = useCategories();
  const { owners } = useOwners();
  const { walletNames } = useWalletNames();
  const { seedNames } = useSeedNames();
  const { walletSoftware } = useWalletSoftware();
  const { enabledCustomFields } = useCustomFields();
  const { settings, tableColumns, customFieldColumns } = useSettings();
  const { toast } = useToast();

  const statsEnabled = tableColumns.balance || tableColumns.lastTxDate || tableColumns.txCount;
  const allAddressStats = useAddressStats(records, statsEnabled);

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

  // Load attachments when editing record changes
  useEffect(() => {
    const loadEditingAttachments = async () => {
      if (editingRecord?.id !== undefined) {
        const attachments = await getRecordAttachments(editingRecord.id);
        setEditingRecordAttachments(attachments);
      } else {
        setEditingRecordAttachments([]);
      }
    };

    loadEditingAttachments();
  }, [editingRecord?.id]);

  const uniqueFilterValues = useMemo((): Record<string, string[]> => {
    const clean = (names: string[]) =>
      names.filter(n => n && n.trim() && !n.includes('[encrypted]')).sort();
    return {
      tags: clean(tags.map(t => t.name)),
      categories: clean(categories.map(c => c.name)),
      owner: clean(owners.map(o => o.name)),
      walletName: clean(walletNames.map(w => w.name)),
      seedName: clean(seedNames.map(s => s.name)),
      walletSoftware: clean(walletSoftware.map(w => w.name)),
    };
  }, [tags, categories, owners, walletNames, seedNames, walletSoftware]);

  // Apply search and filters
  // Note: blockchain-discovered filtering is now done at the DATABASE level via useFilteredRecords
  useEffect(() => {
    const applyFiltersAsync = async () => {
      const enrichedRecords = records.map(r => {
        const stats = allAddressStats.get(String(r.id));
        return {
          ...r,
          balance: stats ? stats.balanceSats : undefined,
          lastTxDate: stats ? stats.lastTxDate : undefined,
          txCount: stats ? stats.txCount : undefined,
        };
      });
      let results = applyColumnFilters(enrichedRecords as unknown as Array<{ [key: string]: unknown }>, columnFilters) as unknown as typeof records;

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

    applyFiltersAsync();
  }, [search, filter, records, includeBlockchainDiscovered, columnFilters, allAddressStats]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [search, filter, includeBlockchainDiscovered, columnFilters]);
  
  // Handle sort column clicks from RecordTable
  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      if (sortDirection === "asc") {
        setSortDirection("desc");
      } else if (sortDirection === "desc") {
        setSortColumn(null);
        setSortDirection(null);
      } else {
        setSortDirection("asc");
      }
    } else {
      setSortColumn(column);
      setSortDirection("asc");
    }
  };
  
  // Sort filtered records BEFORE pagination
  const sortedFilteredRecords = useMemo(() => {
    if (!sortColumn || !sortDirection) {
      return filteredRecords; // Already sorted by updatedAt from filter effect
    }
    
    return [...filteredRecords].sort((a, b) => {
      let aVal: string | number = "";
      let bVal: string | number = "";

      switch (sortColumn) {
        case "type":
          aVal = a.type;
          bVal = b.type;
          break;
        case "label":
          aVal = a.label.toLowerCase();
          bVal = b.label.toLowerCase();
          break;
        case "inputString":
          aVal = a.inputString.toLowerCase();
          bVal = b.inputString.toLowerCase();
          break;
        case "tags":
          aVal = (a.tags[0] || "").toLowerCase();
          bVal = (b.tags[0] || "").toLowerCase();
          break;
        case "categories":
          aVal = ((a.categories || [])[0] || "").toLowerCase();
          bVal = ((b.categories || [])[0] || "").toLowerCase();
          break;
        case "walletSoftware":
          aVal = (a.walletSoftware || "").toLowerCase();
          bVal = (b.walletSoftware || "").toLowerCase();
          break;
        case "seedName":
          aVal = (a.seedName || "").toLowerCase();
          bVal = (b.seedName || "").toLowerCase();
          break;
        case "privateKeyStatus":
          aVal = (a.privateKeyStatus || "").toLowerCase();
          bVal = (b.privateKeyStatus || "").toLowerCase();
          break;
        case "source":
          aVal = (a.source || "").toLowerCase();
          bVal = (b.source || "").toLowerCase();
          break;
        case "owner":
          aVal = (a.owner || "").toLowerCase();
          bVal = (b.owner || "").toLowerCase();
          break;
        case "walletName":
          aVal = (a.walletName || "").toLowerCase();
          bVal = (b.walletName || "").toLowerCase();
          break;
        case "firstSeen":
          aVal = a.firstSeenBlockTime || 0;
          bVal = b.firstSeenBlockTime || 0;
          break;
        case "balance":
          aVal = allAddressStats.get(String(a.id))?.balanceSats || 0;
          bVal = allAddressStats.get(String(b.id))?.balanceSats || 0;
          break;
        case "lastTxDate":
          aVal = allAddressStats.get(String(a.id))?.lastTxDate || 0;
          bVal = allAddressStats.get(String(b.id))?.lastTxDate || 0;
          break;
        case "txCount":
          aVal = allAddressStats.get(String(a.id))?.txCount || 0;
          bVal = allAddressStats.get(String(b.id))?.txCount || 0;
          break;
        default:
          if (sortColumn.startsWith("custom_")) {
            const fieldSlug = sortColumn.replace("custom_", "");
            aVal = (a.customFields?.[fieldSlug] || "").toLowerCase();
            bVal = (b.customFields?.[fieldSlug] || "").toLowerCase();
          }
      }

      if (aVal < bVal) return sortDirection === "asc" ? -1 : 1;
      if (aVal > bVal) return sortDirection === "asc" ? 1 : -1;
      return 0;
    });
  }, [filteredRecords, sortColumn, sortDirection, allAddressStats]);

  // Pagination calculations - using sorted records
  // When DB-level pagination is active (no client-side filters), use totalCount from hook
  // When client-side filters are active, use the filtered records length
  const effectiveTotal = hasClientSideFilters ? sortedFilteredRecords.length : totalCount;
  const totalPages = Math.max(1, Math.ceil(effectiveTotal / ITEMS_PER_PAGE));
  // Clamp currentPage to valid range
  const safePage = Math.min(currentPage, totalPages);
  const startIndex = hasClientSideFilters ? (safePage - 1) * ITEMS_PER_PAGE : 0;
  const endIndex = hasClientSideFilters ? startIndex + ITEMS_PER_PAGE : sortedFilteredRecords.length;
  const paginatedRecords = sortedFilteredRecords.slice(startIndex, endIndex);
  
  // Auto-correct page if it's out of bounds (e.g., after filter changes)
  useEffect(() => {
    if (currentPage > totalPages && totalPages > 0) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const selectedRecord = records.find(r => r.id === selectedRecordId);

  // Compute unique values for dropdowns (combining existing record values with master lists)
  const uniqueSeedNames = Array.from(new Set([
    ...seedNames.map(s => s.name).filter(n => n),
    ...records.map(r => r.seedName).filter((s): s is string => !!s)
  ]));
  const uniqueWalletSoftware = Array.from(new Set([
    ...walletSoftware.map(w => w.name).filter(n => n),
    ...records.map(r => r.walletSoftware).filter((s): s is string => !!s)
  ]));
  const uniqueOwners = Array.from(new Set([
    ...owners.map(o => o.name).filter(n => n),
    ...records.map(r => r.owner).filter((s): s is string => !!s)
  ]));
  const uniqueWalletNames = Array.from(new Set([
    ...walletNames.map(w => w.name).filter(n => n),
    ...records.map(r => r.walletName).filter((s): s is string => !!s)
  ]));

  const handleRecordClick = (id: number) => {
    setSelectedRecordId(id);
    setShowDetail(true);
  };

  const recordLookupMap = useMemo(() => {
    const map = new Map<string, Record>();
    for (const r of records) {
      if (r.inputString) {
        map.set(r.inputString.trim().toLowerCase(), r);
      }
    }
    return map;
  }, [records]);

  const handleCheckDuplicate = async (inputString: string) => {
    return recordLookupMap.get(inputString.trim().toLowerCase());
  };

  const createAddressRecordsFromTx = async (
    transactionAddresses: TransactionAddresses,
    logPrefix: string
  ): Promise<{ created: number; skipped: number }> => {
    let addressesCreated = 0;
    let addressesSkipped = 0;
    const txidShort = transactionAddresses.txid.substring(0, 8);
    const txDate = new Date(transactionAddresses.blockTime * 1000).toLocaleDateString();
    const localLookup = new Map(recordLookupMap);

    console.log(`${logPrefix} Creating address records from tx ${txidShort}: ${transactionAddresses.inputs.length} inputs, ${transactionAddresses.outputs.length} outputs`);

    const allAddrs = [
      ...transactionAddresses.inputs.map(i => ({ address: i.address, role: 'Input' })),
      ...transactionAddresses.outputs.map(o => ({ address: o.address, role: 'Output' })),
    ];

    beginBulkOperation();
    try {
      for (let i = 0; i < allAddrs.length; i++) {
        const { address, role } = allAddrs[i];
        const key = address.trim().toLowerCase();

        if (localLookup.has(key)) {
          addressesSkipped++;
        } else {
          try {
            await createRecord({
              type: 'address',
              inputString: address,
              label: `TX ${role} ${txDate}`,
              notes: `${role} address from transaction ${txidShort}...`,
              tags: [],
              categories: [],
              owner: 'Pending Review',
              walletName: '',
              source: `tx-import:${transactionAddresses.txid}`,
              addressImportance: 'pending-review',
            });
            localLookup.set(key, { inputString: address } as Record);
            addressesCreated++;
          } catch (createError) {
            console.error(`Failed to create ${role.toLowerCase()} address record for ${address}:`, createError);
          }
        }
        if (i % 10 === 9) await new Promise(r => setTimeout(r, 0));
      }
    } finally {
      endBulkOperation();
    }

    console.log(`${logPrefix} Address creation complete: ${addressesCreated} created, ${addressesSkipped} skipped`);
    return { created: addressesCreated, skipped: addressesSkipped };
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

      const existingRecord = recordLookupMap.get(data.inputString.trim().toLowerCase());

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
        flowType: data.flowType,
        acquisitionMethod: data.acquisitionMethod,
        dispositionType: data.dispositionType,
        costBasisUsd: data.costBasisUsd,
        counterpartyType: data.counterpartyType,
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
          if (transactionAddresses && recordType === 'transaction') {
            const { created: addressesCreated } = await createAddressRecordsFromTx(transactionAddresses, '[Update path]');
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
          
          if (transactionAddresses && recordType === 'transaction') {
            const { created: addressesCreated, skipped: addressesSkipped } = await createAddressRecordsFromTx(transactionAddresses, '[Create path]');
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
        if (recordData.tags.length > 0) {
          await syncTagsToMaster(recordData.tags);
        }
        if (recordData.categories.length > 0) {
          await syncCategoriesToMaster(recordData.categories);
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
        flowType: data.flowType,
        acquisitionMethod: data.acquisitionMethod,
        dispositionType: data.dispositionType,
        costBasisUsd: data.costBasisUsd,
        counterpartyType: data.counterpartyType,
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
        const updatedTags = data.tags || [];
        const updatedCategories = data.categories || [];
        if (updatedTags.length > 0) {
          await syncTagsToMaster(updatedTags);
        }
        if (updatedCategories.length > 0) {
          await syncCategoriesToMaster(updatedCategories);
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

  const handleDeleteRequest = (id: number) => {
    setDeleteConfirmTarget(id);
  };

  const handleConfirmDelete = async () => {
    if (deleteConfirmTarget === null) return;
    
    setIsDeleting(true);
    try {
      await deleteRecord(deleteConfirmTarget);
      toast({
        title: "Record Deleted",
        description: "The record has been deleted successfully",
      });
      setDeleteConfirmTarget(null);
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to delete record",
      });
    } finally {
      setIsDeleting(false);
    }
  };

  // Clear selection when records change (e.g., after delete)
  useEffect(() => {
    const recordIds = new Set(filteredRecords.map(r => String(r.id)));
    setSelectedIds(prev => {
      const validSelected = new Set(Array.from(prev).filter(id => recordIds.has(id)));
      if (validSelected.size !== prev.size) {
        return validSelected;
      }
      return prev;
    });
  }, [filteredRecords]);

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    
    setIsDeleting(true);
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
    
    setSelectedIds(new Set());
    setBulkDeleteDialogOpen(false);
    setIsDeleting(false);
    
    if (failCount === 0) {
      toast({
        title: "Records deleted",
        description: `Successfully deleted ${successCount} record${successCount !== 1 ? 's' : ''}.`,
      });
    } else {
      toast({
        variant: "destructive",
        title: "Partial deletion",
        description: `Deleted ${successCount} record${successCount !== 1 ? 's' : ''}, ${failCount} failed.`,
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
            <BlockchainToggle
              checked={includeBlockchainDiscovered}
              onCheckedChange={setIncludeBlockchainDiscovered}
              hiddenCount={blockchainDiscoveredCount}
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
                        <Checkbox checked={tableColumns.tags} onCheckedChange={() => toggleTableColumn('tags')} data-testid="checkbox-col-tags" />
                        <span className="text-sm">Tags</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <Checkbox checked={tableColumns.categories} onCheckedChange={() => toggleTableColumn('categories')} data-testid="checkbox-col-categories" />
                        <span className="text-sm">Categories</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <Checkbox checked={tableColumns.walletSoftware} onCheckedChange={() => toggleTableColumn('walletSoftware')} data-testid="checkbox-col-wallet" />
                        <span className="text-sm">Wallet Software</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <Checkbox checked={tableColumns.seedName} onCheckedChange={() => toggleTableColumn('seedName')} data-testid="checkbox-col-seed" />
                        <span className="text-sm">Seed Name</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <Checkbox checked={tableColumns.privateKeyStatus} onCheckedChange={() => toggleTableColumn('privateKeyStatus')} data-testid="checkbox-col-privatekey" />
                        <span className="text-sm">Private Key</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <Checkbox checked={tableColumns.hasAttachments} onCheckedChange={() => toggleTableColumn('hasAttachments')} data-testid="checkbox-col-attachments" />
                        <span className="text-sm">Attachments</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <Checkbox checked={tableColumns.source} onCheckedChange={() => toggleTableColumn('source')} data-testid="checkbox-col-source" />
                        <span className="text-sm">Source</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <Checkbox checked={tableColumns.owner} onCheckedChange={() => toggleTableColumn('owner')} data-testid="checkbox-col-owner" />
                        <span className="text-sm">Owner</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <Checkbox checked={tableColumns.walletName} onCheckedChange={() => toggleTableColumn('walletName')} data-testid="checkbox-col-walletname" />
                        <span className="text-sm">Wallet Name</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <Checkbox checked={tableColumns.firstSeen} onCheckedChange={() => toggleTableColumn('firstSeen')} data-testid="checkbox-col-firstseen" />
                        <span className="text-sm">First Seen</span>
                      </label>
                    </div>
                  </div>
                  <Separator />
                  <div>
                    <p className="text-sm font-semibold mb-2">Blockchain Data</p>
                    <div className="grid grid-cols-1 gap-2">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <Checkbox checked={tableColumns.balance} onCheckedChange={() => toggleTableColumn('balance')} data-testid="checkbox-col-balance" />
                        <span className="text-sm">BTC Balance</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <Checkbox checked={tableColumns.lastTxDate} onCheckedChange={() => toggleTableColumn('lastTxDate')} data-testid="checkbox-col-lasttxdate" />
                        <span className="text-sm">Last Tx Date</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <Checkbox checked={tableColumns.txCount} onCheckedChange={() => toggleTableColumn('txCount')} data-testid="checkbox-col-txcount" />
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
                              <Checkbox checked={customFieldColumns[field.slug] || false} onCheckedChange={() => toggleCustomFieldColumn(field.slug)} data-testid={`checkbox-col-custom-${field.slug}`} />
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
          availableTags={tags.map(t => t.name).filter(n => n)}
          availableCategories={categories.map(c => c.name).filter(n => n)}
          tableColumns={settings?.tableColumns}
        />
        
        <RecordFilters
          filters={columnFilters}
          onFiltersChange={setColumnFilters}
          uniqueValues={uniqueFilterValues}
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
                      onDelete={() => handleDeleteRequest(record.id!)}
                    />
                  );
                })}
              </div>
            ) : (
              <>
                {selectedIds.size > 0 && (
                  <div className="mb-4 p-3 bg-muted rounded-md flex items-center justify-between gap-4">
                    <span className="text-sm font-medium">{selectedIds.size} selected</span>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelectedIds(new Set())}
                        data-testid="button-clear-selection"
                      >
                        <X className="h-4 w-4 mr-1" />
                        Clear
                      </Button>
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
                  </div>
                )}
                <RecordTable
                  records={paginatedRecords.map(r => {
                    const stringId = r.id !== undefined ? String(r.id) : "";
                    return { ...r, id: stringId };
                  })}
                  onRowClick={(id) => handleRecordClick(Number(id))}
                  onEdit={(id) => handleEditRecord(Number(id))}
                  onDelete={(id) => handleDeleteRequest(Number(id))}
                  onSyncDeeper={(id) => handleSyncDeeper(Number(id))}
                  externalSortColumn={sortColumn}
                  externalSortDirection={sortDirection}
                  onSortChange={handleSort}
                  selectionEnabled={true}
                  selectedIds={selectedIds}
                  onSelectionChange={setSelectedIds}
                  precomputedAddressStats={allAddressStats}
                />
              </>
            )}

            {/* Pagination Controls */}
            {effectiveTotal > ITEMS_PER_PAGE && (
              <div className="flex items-center justify-between border-t pt-4 mt-4">
                <div className="text-sm text-muted-foreground">
                  Showing {((safePage - 1) * ITEMS_PER_PAGE) + 1}-{Math.min(safePage * ITEMS_PER_PAGE, effectiveTotal)} of {effectiveTotal} records
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
        customFieldDefs={enabledCustomFields}
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
        availableTags={tags.map(t => t.name).filter(n => n)}
        availableCategories={categories.map(c => c.name).filter(n => n)}
        enabledCustomFields={enabledCustomFields}
        onCheckDuplicate={handleCheckDuplicate}
        existingAttachments={editingRecord ? editingRecordAttachments : []}
        onAttachmentDeleted={async () => {
          if (editingRecord?.id) {
            const attachments = await getRecordAttachments(editingRecord.id);
            setEditingRecordAttachments(attachments);
          }
        }}
      />

      <AlertDialog open={deleteConfirmTarget !== null} onOpenChange={(open) => !open && setDeleteConfirmTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Record?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete this record and all associated attachments.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting} data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-delete"
            >
              {isDeleting ? "Deleting..." : "Delete Record"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
    </div>
  );
}

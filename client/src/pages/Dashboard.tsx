import { useState, useEffect } from "react";
import { Plus, Grid3x3, List } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchBar } from "@/components/SearchBar";
import { FilterBar } from "@/components/FilterBar";
import { RecordCard } from "@/components/RecordCard";
import { RecordTable } from "@/components/RecordTable";
import { RecordDetailPanel } from "@/components/RecordDetailPanel";
import { RecordFormDialog } from "@/components/RecordFormDialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRecords, createRecord, createRecordWithAttachments, updateRecord, deleteRecord, searchRecords, filterRecords } from "@/hooks/use-records";
import { useEncryptedTags, useEncryptedCategories } from "@/hooks/use-encrypted-records";
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

  const selectedRecord = records.find(r => r.id === selectedRecordId);

  // Compute unique values for dropdowns
  const uniqueSeedNames = Array.from(new Set(records.map(r => r.seedName).filter((s): s is string => !!s)));
  const uniqueWalletSoftware = Array.from(new Set(records.map(r => r.walletSoftware).filter((s): s is string => !!s)));

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

  const handleCreateRecord = async (data: any, files: File[] = []) => {
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
        counterparty: data.counterparty || "",
        privateKeyStatus: data.privateKeyStatus || "",
        customFields: data.customFields,
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
          toast({
            title: "Record Updated",
            description: `${data.label} has been updated successfully`,
          });
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
          toast({
            title: "Record Created",
            description: `${data.label} has been saved successfully`,
          });
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
        counterparty: data.counterparty || "",
        privateKeyStatus: data.privateKeyStatus || "",
        customFields: data.customFields,
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
        ) : view === "grid" ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredRecords.map((record) => {
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
            records={filteredRecords.map(r => {
              const stringId = r.id !== undefined ? String(r.id) : "";
              return { ...r, id: stringId };
            })}
            onRowClick={(id) => handleRecordClick(Number(id))}
            onEdit={(id) => handleEditRecord(Number(id))}
            onDelete={(id) => handleDeleteRecord(Number(id))}
          />
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
        availableTags={tags.map(t => t.name).filter(n => n && n !== '[encrypted]')}
        availableCategories={categories.map(c => c.name).filter(n => n && n !== '[encrypted]')}
        enabledCustomFields={enabledCustomFields}
        onCheckDuplicate={handleCheckDuplicate}
      />
    </div>
  );
}

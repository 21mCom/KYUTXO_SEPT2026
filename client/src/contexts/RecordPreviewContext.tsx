import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import { useLocation } from "wouter";
import { type Record as DbRecord, type Attachment, type CustomField } from "@/lib/database";
import { type PanelRecord, toPanelRecord } from "@/lib/recordToPanel";
import { getAllCustomFields } from "@/lib/data/custom-fields-crud";
import { getAttachmentsByRecordIdOrIdentifier } from "@/lib/data/attachments-crud";
import { getRecord, getRecordsByInputString, updateRecord } from "@/lib/data/record-crud";
import { RecordDetailPanel } from "@/components/RecordDetailPanel";
import { RecordFormDialog } from "@/components/RecordFormDialog";
import { useToast } from "@/hooks/use-toast";
import { useTags } from "@/hooks/use-tags";
import { useCategories } from "@/hooks/use-categories";
import { useOwners } from "@/hooks/use-owners";
import { useWalletNames } from "@/hooks/use-wallet-names";
import { useSeedNames } from "@/hooks/use-seed-names";
import { useWalletSoftware } from "@/hooks/use-wallet-software";
import { useCustomFields } from "@/hooks/use-settings";
import { validateBitcoinInput } from "@/lib/bitcoin";
import { invalidateCachedRecord } from "@/lib/metadata-hover";

interface RecordPreviewContextType {
  openRecordPreview: (recordId: number) => Promise<void>;
  openRecordPreviewByAddress: (inputString: string) => Promise<void>;
  openRecordEdit: (recordId: number, scrollToSection?: "acquisition") => Promise<void>;
  closePreview: () => void;
  isOpen: boolean;
  isLoading: boolean;
}

const RecordPreviewContext = createContext<RecordPreviewContextType | null>(null);

// Priority ranking for addressImportance - higher number = better priority
const IMPORTANCE_PRIORITY: { [key: string]: number } = {
  'verified': 6,
  'manual': 5,
  'wallet-import': 4,
  'xpub-derived': 3,
  'blockchain-discovered': 2,
  'pending-review': 1,
};

// Score a record based on metadata richness - used to select best record when duplicates exist
function scoreRecordMetadata(record: DbRecord): number {
  let score = 0;
  
  // Priority based on addressImportance
  if (record.addressImportance) {
    score += (IMPORTANCE_PRIORITY[record.addressImportance] || 0) * 100;
  }
  
  // Prefer non-blockchain-sync sources
  if (record.source && record.source !== 'blockchain-sync') {
    score += 50;
  }
  
  // Score based on metadata presence
  if (record.label && record.label !== 'Unlabeled' && record.label !== '') score += 10;
  if (record.owner && record.owner !== 'Pending Review') score += 10;
  if (record.walletName) score += 10;
  if (record.seedName) score += 10;
  if (record.walletSoftware) score += 5;
  if (record.notes) score += 5;
  if (record.tags && record.tags.length > 0) score += 5;
  if (record.categories && record.categories.length > 0) score += 5;
  if (record.derivationPath) score += 5;
  if (record.counterpartyType) score += 5;
  
  return score;
}

// Select the best record from a list of duplicates based on metadata richness
function selectBestRecord(records: DbRecord[]): DbRecord {
  if (records.length === 1) return records[0];
  
  return records.reduce((best, current) => {
    const bestScore = scoreRecordMetadata(best);
    const currentScore = scoreRecordMetadata(current);
    return currentScore > bestScore ? current : best;
  });
}

export function RecordPreviewProvider({ children }: { children: ReactNode }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [record, setRecord] = useState<PanelRecord | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [customFieldDefs, setCustomFieldDefs] = useState<CustomField[]>([]);

  // Edit form state (shared across every surface that opens a preview)
  const [editingRecord, setEditingRecord] = useState<DbRecord | null>(null);
  const [editingAttachments, setEditingAttachments] = useState<Attachment[]>([]);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editScrollSection, setEditScrollSection] = useState<"acquisition" | undefined>(undefined);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);

  // Vocabulary lists power the edit form's autosuggest (small master tables).
  const { tags } = useTags();
  const { categories } = useCategories();
  const { owners } = useOwners();
  const { walletNames } = useWalletNames();
  const { seedNames } = useSeedNames();
  const { walletSoftware } = useWalletSoftware();
  const { enabledCustomFields } = useCustomFields();

  // Load custom field definitions once
  useEffect(() => {
    const loadCustomFields = async () => {
      try {
        const fields = await getAllCustomFields();
        setCustomFieldDefs(fields);
      } catch (error) {
        console.error('[RecordPreview] Failed to load custom fields:', error);
      }
    };
    loadCustomFields();
  }, []);

  const loadAttachments = useCallback(async (recordId: number, inputString: string) => {
    try {
      const atts = await getAttachmentsByRecordIdOrIdentifier(recordId, inputString);
      setAttachments(atts);
    } catch (error) {
      console.error('[RecordPreview] Failed to load attachments:', error);
      setAttachments([]);
    }
  }, []);

  const openRecordPreview = useCallback(async (recordId: number) => {
    setIsLoading(true);
    
    try {
      const rawRecord = await getRecord(recordId);
      if (!rawRecord) {
        setIsLoading(false);
        toast({
          title: "Record not found",
          description: "The record may have been deleted",
          variant: "destructive",
        });
        return;
      }

      const dbRecord: DbRecord = rawRecord;

      setRecord(toPanelRecord(dbRecord));
      setIsOpen(true);
      await loadAttachments(recordId, dbRecord.inputString || "");
    } catch (error) {
      console.error('[RecordPreview] Failed to load record:', error);
      toast({
        title: "Error loading record",
        description: "Failed to load record details",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }, [loadAttachments, toast]);

  const openRecordPreviewByAddress = useCallback(async (inputString: string) => {
    setIsLoading(true);
    
    try {
      const rawRecords = await getRecordsByInputString(inputString);
      if (rawRecords.length === 0) {
        // No record found - navigate to Records page with search
        setIsLoading(false);
        toast({
          title: "No record found",
          description: "Navigating to search for this address/transaction...",
        });
        navigate(`/records?search=${encodeURIComponent(inputString)}`);
        return;
      }

      const dbRecords: DbRecord[] = rawRecords;
      
      const dbRecord = selectBestRecord(dbRecords);

      setRecord(toPanelRecord(dbRecord));
      setIsOpen(true);
      await loadAttachments(dbRecord.id!, dbRecord.inputString || "");
    } catch (error) {
      console.error('[RecordPreview] Failed to load record by address:', error);
      toast({
        title: "Error loading record",
        description: "Failed to load record details",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }, [loadAttachments, navigate, toast]);

  const closePreview = useCallback(() => {
    setIsOpen(false);
    setRecord(null);
    setAttachments([]);
  }, []);

  const handleAttachmentsChange = useCallback(async () => {
    if (record) {
      await loadAttachments(Number(record.id), record.inputString);
    }
  }, [record, loadAttachments]);

  const openRecordEdit = useCallback(async (recordId: number, scrollToSection?: "acquisition") => {
    try {
      const raw = await getRecord(recordId);
      if (!raw) {
        toast({
          title: "Record not found",
          description: "The record may have been deleted",
          variant: "destructive",
        });
        return;
      }
      setEditingRecord(raw);
      setEditScrollSection(scrollToSection);
      setIsFormOpen(true);
      try {
        const atts = await getAttachmentsByRecordIdOrIdentifier(recordId, raw.inputString || "");
        setEditingAttachments(atts);
      } catch (error) {
        console.error('[RecordPreview] Failed to load attachments for edit:', error);
        setEditingAttachments([]);
      }
    } catch (error) {
      console.error('[RecordPreview] Failed to load record for edit:', error);
      toast({
        title: "Error loading record",
        description: "Failed to load record details",
        variant: "destructive",
      });
    }
  }, [toast]);

  const closeForm = useCallback(() => {
    if (isSubmitting) return;
    setIsFormOpen(false);
    setEditingRecord(null);
    setEditingAttachments([]);
    setEditScrollSection(undefined);
  }, [isSubmitting]);

  const refreshEditingAttachments = useCallback(async () => {
    if (!editingRecord?.id) return;
    try {
      const atts = await getAttachmentsByRecordIdOrIdentifier(editingRecord.id, editingRecord.inputString || "");
      setEditingAttachments(atts);
    } catch (error) {
      console.error('[RecordPreview] Failed to reload attachments for edit:', error);
      setEditingAttachments([]);
    }
  }, [editingRecord]);

  const handleCheckDuplicate = useCallback(async (inputString: string) => {
    const matches = await getRecordsByInputString(inputString);
    return matches.find((r) => r.id !== editingRecord?.id);
  }, [editingRecord]);

  const handleUpdateRecord = useCallback(async (data: any, files: File[] = []) => {
    if (!editingRecord?.id) return;

    try {
      // Bitcoin types must validate; "other" type skips validation
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

      // addressImportance can upgrade to verified but never downgrade
      let addressImportance = editingRecord.addressImportance;
      if (data.markAsVerified || data.addressImportance === 'verified') {
        addressImportance = 'verified';
      }

      const previousInputString = editingRecord.inputString || "";

      await updateRecord(editingRecord.id, {
        type: data.type,
        vault: data.vault,
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

      // Upload any new files for the existing record
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

      // Refresh the hover tooltip / note-icon cache for old and new identifiers
      if (previousInputString) invalidateCachedRecord(previousInputString);
      if (data.inputString) invalidateCachedRecord(data.inputString);

      // Refresh the open preview panel if it is showing this record
      if (isOpen && record && Number(record.id) === editingRecord.id) {
        await openRecordPreview(editingRecord.id);
      }

      setIsFormOpen(false);
      setEditingRecord(null);
      setEditingAttachments([]);
    } catch (error) {
      console.error('[RecordPreview] Failed to update record:', error);
      toast({
        variant: "destructive",
        title: "Update failed",
        description: "Failed to update the record. Please try again.",
      });
    } finally {
      setIsSubmitting(false);
      setUploadProgress(null);
    }
  }, [editingRecord, isOpen, record, openRecordPreview, toast]);

  return (
    <RecordPreviewContext.Provider
      value={{
        openRecordPreview,
        openRecordPreviewByAddress,
        openRecordEdit,
        closePreview,
        isOpen,
        isLoading,
      }}
    >
      {children}
      <RecordDetailPanel
        open={isOpen}
        onClose={closePreview}
        onEdit={record ? () => openRecordEdit(Number(record.id)) : undefined}
        record={record ?? undefined}
        attachments={attachments}
        onAttachmentsChange={handleAttachmentsChange}
        customFieldDefs={customFieldDefs}
      />
      <RecordFormDialog
        open={isFormOpen}
        onClose={closeForm}
        onSave={handleUpdateRecord}
        initialData={editingRecord ? {
          ...editingRecord,
          amount: editingRecord.amount?.toString() || "",
        } : undefined}
        isSubmitting={isSubmitting}
        uploadProgress={uploadProgress}
        availableSeedNames={seedNames.map((s) => s.name).filter((n) => n)}
        availableWalletSoftware={walletSoftware.map((w) => w.name).filter((n) => n)}
        availableOwners={owners.map((o) => o.name).filter((n) => n)}
        availableWalletNames={walletNames.map((w) => w.name).filter((n) => n)}
        availableTags={tags.map((t) => t.name).filter((n) => n)}
        availableCategories={categories.map((c) => c.name).filter((n) => n)}
        enabledCustomFields={enabledCustomFields}
        onCheckDuplicate={handleCheckDuplicate}
        existingAttachments={editingAttachments}
        onAttachmentDeleted={refreshEditingAttachments}
        scrollToSection={editScrollSection}
      />
    </RecordPreviewContext.Provider>
  );
}

export function useRecordPreview() {
  const context = useContext(RecordPreviewContext);
  if (!context) {
    throw new Error('useRecordPreview must be used within a RecordPreviewProvider');
  }
  return context;
}

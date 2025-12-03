import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import { useLocation } from "wouter";
import { db, type Record as DbRecord, type Attachment, type VaultMetadata, type AddressImportance, type ChainType, type CustomField } from "@/lib/database";
import { decryptRecords, isEncryptionReady } from "@/lib/encryptionFacade";
import { RecordDetailPanel } from "@/components/RecordDetailPanel";
import { useToast } from "@/hooks/use-toast";

interface RecordPreviewContextType {
  openRecordPreview: (recordId: number) => Promise<void>;
  openRecordPreviewByAddress: (inputString: string) => Promise<void>;
  closePreview: () => void;
  isOpen: boolean;
  isLoading: boolean;
}

const RecordPreviewContext = createContext<RecordPreviewContextType | null>(null);

interface RecordForPanel {
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
}

export function RecordPreviewProvider({ children }: { children: ReactNode }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [record, setRecord] = useState<RecordForPanel | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [customFieldDefs, setCustomFieldDefs] = useState<CustomField[]>([]);

  // Load custom field definitions once
  useEffect(() => {
    const loadCustomFields = async () => {
      try {
        const fields = await db.customFields.toArray();
        setCustomFieldDefs(fields);
      } catch (error) {
        console.error('[RecordPreview] Failed to load custom fields:', error);
      }
    };
    loadCustomFields();
  }, []);

  const loadAttachments = useCallback(async (recordId: number, inputString: string) => {
    try {
      const atts = await db.attachments
        .where('recordId')
        .equals(recordId)
        .or('identifier')
        .equals(inputString)
        .toArray();
      setAttachments(atts);
    } catch (error) {
      console.error('[RecordPreview] Failed to load attachments:', error);
      setAttachments([]);
    }
  }, []);

  const openRecordPreview = useCallback(async (recordId: number) => {
    setIsLoading(true);
    
    try {
      const rawRecord = await db.records.get(recordId);
      if (!rawRecord) {
        setIsLoading(false);
        toast({
          title: "Record not found",
          description: "The record may have been deleted",
          variant: "destructive",
        });
        return;
      }

      let decryptedRecord: DbRecord;
      if (isEncryptionReady()) {
        const decrypted = await decryptRecords([rawRecord]);
        decryptedRecord = decrypted[0];
      } else {
        decryptedRecord = rawRecord;
      }

      const panelRecord: RecordForPanel = {
        id: String(decryptedRecord.id),
        type: decryptedRecord.type as "address" | "transaction" | "other",
        inputString: decryptedRecord.inputString || "",
        label: decryptedRecord.label || "Unlabeled",
        notes: decryptedRecord.notes || undefined,
        tags: decryptedRecord.tags || [],
        categories: decryptedRecord.categories || [],
        seedName: decryptedRecord.seedName || undefined,
        walletSoftware: decryptedRecord.walletSoftware || undefined,
        owner: decryptedRecord.owner || undefined,
        walletName: decryptedRecord.walletName || undefined,
        privateKeyStatus: decryptedRecord.privateKeyStatus || undefined,
        source: decryptedRecord.source || undefined,
        derivationPath: decryptedRecord.derivationPath || undefined,
        chainType: decryptedRecord.chainType || undefined,
        vault: decryptedRecord.vault || undefined,
        addressImportance: decryptedRecord.addressImportance || undefined,
        customFields: decryptedRecord.customFields || undefined,
        syncDepth: decryptedRecord.syncDepth,
        maxSyncedDepth: decryptedRecord.maxSyncedDepth,
        discoveredInTxid: decryptedRecord.discoveredInTxid || undefined,
        discoveredFromRecordId: decryptedRecord.discoveredFromRecordId,
      };

      setRecord(panelRecord);
      setIsOpen(true);
      await loadAttachments(recordId, decryptedRecord.inputString || "");
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
      const rawRecords = await db.records.where('inputString').equals(inputString).toArray();
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

      let decryptedRecord: DbRecord;
      if (isEncryptionReady()) {
        const decrypted = await decryptRecords(rawRecords);
        decryptedRecord = decrypted[0];
      } else {
        decryptedRecord = rawRecords[0];
      }

      const panelRecord: RecordForPanel = {
        id: String(decryptedRecord.id),
        type: decryptedRecord.type as "address" | "transaction" | "other",
        inputString: decryptedRecord.inputString || "",
        label: decryptedRecord.label || "Unlabeled",
        notes: decryptedRecord.notes || undefined,
        tags: decryptedRecord.tags || [],
        categories: decryptedRecord.categories || [],
        seedName: decryptedRecord.seedName || undefined,
        walletSoftware: decryptedRecord.walletSoftware || undefined,
        owner: decryptedRecord.owner || undefined,
        walletName: decryptedRecord.walletName || undefined,
        privateKeyStatus: decryptedRecord.privateKeyStatus || undefined,
        source: decryptedRecord.source || undefined,
        derivationPath: decryptedRecord.derivationPath || undefined,
        chainType: decryptedRecord.chainType || undefined,
        vault: decryptedRecord.vault || undefined,
        addressImportance: decryptedRecord.addressImportance || undefined,
        customFields: decryptedRecord.customFields || undefined,
        syncDepth: decryptedRecord.syncDepth,
        maxSyncedDepth: decryptedRecord.maxSyncedDepth,
        discoveredInTxid: decryptedRecord.discoveredInTxid || undefined,
        discoveredFromRecordId: decryptedRecord.discoveredFromRecordId,
      };

      setRecord(panelRecord);
      setIsOpen(true);
      await loadAttachments(decryptedRecord.id!, decryptedRecord.inputString || "");
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

  return (
    <RecordPreviewContext.Provider
      value={{
        openRecordPreview,
        openRecordPreviewByAddress,
        closePreview,
        isOpen,
        isLoading,
      }}
    >
      {children}
      <RecordDetailPanel
        open={isOpen}
        onClose={closePreview}
        record={record ?? undefined}
        attachments={attachments}
        onAttachmentsChange={handleAttachmentsChange}
        customFieldDefs={customFieldDefs}
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

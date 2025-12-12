import { useState, useRef } from "react";
import { Moon, Eye, Database, Plus, Trash2, Pencil, AlertTriangle, Upload, RefreshCw, Loader2, Paperclip } from "lucide-react";
import { isElectron, getElectronAPI } from "@/lib/electron";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  useSettings,
  useCustomFields,
  toggleFieldVisibility,
  addCustomField,
  toggleCustomField,
  deleteCustomField,
  updateCustomField,
} from "@/hooks/use-settings";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
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
import { useAuth } from "@/contexts/AuthContext";
import { db } from "@/lib/database";
import { deriveKey, decrypt, base64ToBuffer, verifyPassword } from "@/lib/crypto";
import { getVaultSettings } from "@/lib/vault";
import { getEncryptionKey } from "@/lib/encryptionFacade";
import { 
  encryptRecord, 
  encryptTag, 
  encryptCategory, 
  encryptAttachment,
  encryptOwner,
  encryptWalletName,
  encryptSeedName,
  encryptWalletSoftware,
  encryptDerivationTemplate,
  encryptEvidence,
  encryptEvidenceAttachment,
  decryptTag,
  decryptCategory,
  decryptOwner,
  decryptWalletName,
  decryptSeedName,
  decryptWalletSoftware,
} from "@/lib/dbEncryption";
import JSZip from "jszip";

const DELETE_CONFIRMATION_PHRASE = "DELETE ALL DATA";

export default function SettingsPage() {
  const { fieldVisibility, isLoading: settingsLoading } = useSettings();
  const { customFields, isLoading: customFieldsLoading } = useCustomFields();
  const { toast } = useToast();
  const { encryptionKey } = useAuth();
  
  const [newFieldName, setNewFieldName] = useState("");
  const [isAddingField, setIsAddingField] = useState(false);
  const [editingField, setEditingField] = useState<{ id: number; name: string } | null>(null);
  const [deletingFieldId, setDeletingFieldId] = useState<number | null>(null);
  
  // Clear database state
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [clearPassword, setClearPassword] = useState("");
  const [clearPhrase, setClearPhrase] = useState("");
  const [isClearing, setIsClearing] = useState(false);
  
  // Restore state
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restorePassword, setRestorePassword] = useState("");
  const [restoreMode, setRestoreMode] = useState<"replace" | "merge">("replace");
  const [isRestoring, setIsRestoring] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState(0);
  const [restoreMessage, setRestoreMessage] = useState("");
  const [backupInfo, setBackupInfo] = useState<{ encrypted: boolean; date: string; recordCount: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleToggleBuiltInField = async (field: keyof typeof fieldVisibility) => {
    try {
      await toggleFieldVisibility(field);
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to update field visibility",
        variant: "destructive",
      });
    }
  };

  const handleAddCustomField = async () => {
    const trimmedName = newFieldName.trim();
    if (!trimmedName) {
      toast({
        title: "Error",
        description: "Please enter a field name",
        variant: "destructive",
      });
      return;
    }

    try {
      await addCustomField(trimmedName);
      setNewFieldName("");
      setIsAddingField(false);
      toast({
        title: "Success",
        description: `Custom field "${trimmedName}" added`,
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to add custom field",
        variant: "destructive",
      });
    }
  };

  const handleToggleCustomField = async (id: number) => {
    try {
      await toggleCustomField(id);
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to toggle custom field",
        variant: "destructive",
      });
    }
  };

  const handleUpdateCustomField = async () => {
    if (!editingField) return;
    
    const trimmedName = editingField.name.trim();
    if (!trimmedName) {
      toast({
        title: "Error",
        description: "Please enter a field name",
        variant: "destructive",
      });
      return;
    }

    try {
      await updateCustomField(editingField.id, { name: trimmedName });
      setEditingField(null);
      toast({
        title: "Success",
        description: "Custom field updated",
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to update custom field",
        variant: "destructive",
      });
    }
  };

  const handleDeleteCustomField = async () => {
    if (deletingFieldId === null) return;
    
    try {
      await deleteCustomField(deletingFieldId);
      setDeletingFieldId(null);
      toast({
        title: "Success",
        description: "Custom field deleted",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to delete custom field",
        variant: "destructive",
      });
    }
  };

  // Clear database handler
  const handleClearDatabase = async () => {
    if (clearPhrase !== DELETE_CONFIRMATION_PHRASE) {
      toast({
        variant: "destructive",
        title: "Incorrect Phrase",
        description: `Please type "${DELETE_CONFIRMATION_PHRASE}" exactly to confirm.`,
      });
      return;
    }

    setIsClearing(true);
    try {
      // Verify password
      const settings = await getVaultSettings();
      if (!settings) {
        throw new Error("Vault not initialized");
      }

      const salt = base64ToBuffer(settings.salt);
      const isValid = await verifyPassword(clearPassword, salt, settings.passwordHash);

      if (!isValid) {
        toast({
          variant: "destructive",
          title: "Invalid Password",
          description: "The password you entered is incorrect.",
        });
        setIsClearing(false);
        return;
      }

      // Clear all tables
      await db.records.clear();
      await db.tags.clear();
      await db.categories.clear();
      await db.attachments.clear();
      await db.recordOrigins.clear();
      await db.customFields.clear();
      
      // Clear blockchain sync data
      await db.blockchainTransactions.clear();
      await db.transactionParticipants.clear();
      await db.addressSyncState.clear();
      
      // Clear vocabulary tables
      await db.owners.clear();
      await db.walletNames.clear();
      await db.seedNames.clear();
      await db.walletSoftware.clear();
      
      // Clear price data
      await db.priceData.clear();

      // Reset settings to defaults (but keep them)
      await db.settings.update('default', {
        fieldVisibility: {
          seedName: true,
          walletSoftware: true,
          privateKeyStatus: false,
          owner: true,
          walletName: true,
          source: true,
        },
        tableColumns: {
          tags: true,
          categories: false,
          walletSoftware: false,
          seedName: false,
          privateKeyStatus: false,
          hasAttachments: true,
          owner: false,
          walletName: false,
          source: false,
        },
        customFieldColumns: {},
      });

      setClearDialogOpen(false);
      setClearPassword("");
      setClearPhrase("");
      
      toast({
        title: "Database Cleared",
        description: "All records, blockchain data, vocabularies, and attachments have been deleted.",
      });

      // Reload the page to reset all state
      window.location.reload();
    } catch (error) {
      console.error("Failed to clear database:", error);
      toast({
        variant: "destructive",
        title: "Clear Failed",
        description: error instanceof Error ? error.message : "Failed to clear database",
      });
    } finally {
      setIsClearing(false);
    }
  };

  // Handle file selection for restore
  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setRestoreFile(file);
    setBackupInfo(null);

    try {
      const zip = await JSZip.loadAsync(file);
      const backupFile = zip.file("backup.json");
      
      if (!backupFile) {
        throw new Error("Invalid backup file - missing backup.json");
      }

      const content = await backupFile.async("text");
      const backup = JSON.parse(content);
      
      setBackupInfo({
        encrypted: backup.encrypted || false,
        date: backup.exportDate || "Unknown",
        recordCount: backup.encrypted ? -1 : (backup.data?.records?.length || 0),
      });
    } catch (error) {
      console.error("Failed to read backup file:", error);
      toast({
        variant: "destructive",
        title: "Invalid Backup",
        description: "Could not read the backup file. Make sure it's a valid KYUTXO backup.",
      });
      setRestoreFile(null);
    }
  };

  // Restore from backup handler
  const handleRestore = async () => {
    // Get the current encryption key from the facade
    const currentKey = getEncryptionKey();
    if (!restoreFile || !currentKey) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Please log in first to restore data.",
      });
      return;
    }

    setIsRestoring(true);
    setRestoreProgress(0);
    setRestoreMessage("Reading backup file...");

    try {
      const zip = await JSZip.loadAsync(restoreFile);
      const backupFile = zip.file("backup.json");
      
      if (!backupFile) {
        throw new Error("Invalid backup file");
      }

      setRestoreProgress(10);
      const content = await backupFile.async("text");
      const backup = JSON.parse(content);

      let data = backup.data;

      // If backup is encrypted, decrypt it
      if (backup.encrypted) {
        setRestoreMessage("Decrypting backup...");
        setRestoreProgress(20);

        if (!restorePassword) {
          throw new Error("Password required for encrypted backup");
        }

        // Properly decode the salt from base64
        const salt = base64ToBuffer(backup.salt);
        const backupKey = await deriveKey(restorePassword, salt);

        try {
          const decrypted = await decrypt(backup.data, backupKey);
          data = JSON.parse(decrypted);
        } catch {
          throw new Error("Invalid password or corrupted backup");
        }
      }

      setRestoreProgress(30);
      setRestoreMessage("Processing data...");

      const { 
        records, 
        tags, 
        categories, 
        attachments, 
        recordOrigins, 
        customFields: backupCustomFields,
        owners = [],
        walletNames = [],
        seedNames = [],
        walletSoftware = [],
        derivationTemplates = [],
        evidence = [],
        evidenceAttachments = [],
        priceData = [],
        settings: backupSettings = [],
        nodeSettings: backupNodeSettings = [],
        utxoLineage = [],
        custodySegments = [],
      } = data;

      // If replace mode, clear existing data first
      if (restoreMode === "replace") {
        setRestoreMessage("Clearing existing data...");
        setRestoreProgress(40);
        
        await db.records.clear();
        await db.tags.clear();
        await db.categories.clear();
        await db.attachments.clear();
        await db.recordOrigins.clear();
        await db.customFields.clear();
        await db.owners.clear();
        await db.walletNames.clear();
        await db.seedNames.clear();
        await db.walletSoftware.clear();
        await db.derivationTemplates.clear();
        await db.evidence.clear();
        await db.evidenceAttachments.clear();
        await db.priceData.clear();
        await db.nodeSettings.clear();
        await db.utxoLineage.clear();
        await db.custodySegments.clear();
      }

      setRestoreProgress(50);
      setRestoreMessage("Restoring records...");

      // Track statistics
      let recordsAdded = 0;
      let recordsSkipped = 0;

      // Restore records
      if (records && records.length > 0) {
        // Build set of existing inputStrings for merge mode (need to decrypt them first)
        let existingInputStrings = new Set<string>();
        if (restoreMode === "merge") {
          const existingRecords = await db.records.toArray();
          existingInputStrings = new Set(existingRecords.map(r => r.inputString));
        }
        
        for (let i = 0; i < records.length; i++) {
          const record = records[i];
          const { id, encryptedPayload, isEncrypted, ...recordData } = record;
          
          // Skip duplicates in merge mode
          if (restoreMode === "merge" && existingInputStrings.has(recordData.inputString)) {
            recordsSkipped++;
            setRestoreProgress(50 + Math.floor((i / records.length) * 20));
            continue;
          }

          // Ensure addressImportance is set for compound index compatibility
          let addressImportance = recordData.addressImportance;
          if (!addressImportance) {
            const recType = recordData.type || "address";
            if (recType === 'transaction' || recType === 'other') {
              addressImportance = 'manual';
            } else if ((recordData.syncDepth !== undefined && recordData.syncDepth > 0) || 
                       recordData.source === 'blockchain-sync') {
              addressImportance = 'blockchain-discovered';
            } else if (recordData.source?.startsWith('walletImport-')) {
              addressImportance = 'wallet-import';
            } else if (recordData.source === 'xpub-import' || recordData.xpub || recordData.derivationPath) {
              addressImportance = 'xpub-derived';
            } else {
              addressImportance = 'manual';
            }
          }
          
          // Create a new record object with required fields
          const newRecord = {
            type: recordData.type || "address",
            inputString: recordData.inputString || "",
            label: recordData.label || "Restored Record",
            notes: recordData.notes,
            amount: recordData.amount,
            date: recordData.date,
            tags: recordData.tags || [],
            categories: recordData.categories || [],
            chainType: recordData.chainType,
            seedName: recordData.seedName,
            walletSoftware: recordData.walletSoftware,
            privateKeyStatus: recordData.privateKeyStatus,
            owner: recordData.owner,
            walletName: recordData.walletName,
            source: recordData.source,
            customFields: recordData.customFields,
            addressImportance,
            syncDepth: recordData.syncDepth,
            xpub: recordData.xpub,
            derivationPath: recordData.derivationPath,
            createdAt: recordData.createdAt || Date.now(),
            updatedAt: recordData.updatedAt || Date.now(),
          };

          // Encrypt using proper encryption utility
          const encrypted = await encryptRecord(newRecord as any, currentKey);
          await db.records.add(encrypted);
          recordsAdded++;
          setRestoreProgress(50 + Math.floor((i / records.length) * 20));
        }
      }

      setRestoreProgress(70);
      setRestoreMessage("Restoring tags and categories...");

      // Track existing tag/category names for merge mode
      let existingTagNames = new Set<string>();
      let existingCategoryNames = new Set<string>();
      
      if (restoreMode === "merge") {
        // Decrypt existing tags to get their names
        const existingTags = await db.tags.toArray();
        for (const tag of existingTags) {
          if (tag.isEncrypted && tag.encryptedPayload) {
            try {
              const decrypted = await decryptTag(tag, currentKey);
              existingTagNames.add(decrypted.name);
            } catch {
              // Keep the placeholder if decryption fails
              existingTagNames.add(tag.name);
            }
          } else {
            existingTagNames.add(tag.name);
          }
        }
        
        // Decrypt existing categories to get their names
        const existingCategories = await db.categories.toArray();
        for (const cat of existingCategories) {
          if (cat.isEncrypted && cat.encryptedPayload) {
            try {
              const decrypted = await decryptCategory(cat, currentKey);
              existingCategoryNames.add(decrypted.name);
            } catch {
              existingCategoryNames.add(cat.name);
            }
          } else {
            existingCategoryNames.add(cat.name);
          }
        }
      }

      let tagsAdded = 0;
      let categoriesAdded = 0;

      // Restore tags
      if (tags && tags.length > 0) {
        for (const tag of tags) {
          const { id, encryptedPayload, isEncrypted, ...tagData } = tag;
          const tagName = tagData.name || "";
          
          // Skip duplicates in merge mode
          if (restoreMode === "merge" && existingTagNames.has(tagName)) {
            continue;
          }
          
          const newTag = {
            name: tagName,
            color: tagData.color || "#888888",
            createdAt: tagData.createdAt || Date.now(),
          };
          
          const encrypted = await encryptTag(newTag as any, currentKey);
          await db.tags.add(encrypted);
          tagsAdded++;
        }
      }

      // Restore categories
      if (categories && categories.length > 0) {
        for (const category of categories) {
          const { id, encryptedPayload, isEncrypted, ...catData } = category;
          const catName = catData.name || "";
          
          // Skip duplicates in merge mode
          if (restoreMode === "merge" && existingCategoryNames.has(catName)) {
            continue;
          }
          
          const newCategory = {
            name: catName,
            createdAt: catData.createdAt || Date.now(),
          };
          
          const encrypted = await encryptCategory(newCategory as any, currentKey);
          await db.categories.add(encrypted);
          categoriesAdded++;
        }
      }

      setRestoreProgress(80);
      setRestoreMessage("Restoring attachments...");

      let attachmentsAdded = 0;

      // Restore attachments (metadata only - files would need separate handling)
      if (attachments && attachments.length > 0) {
        // Build set of existing attachments for merge mode (recordId + filename combo)
        let existingAttachmentKeys = new Set<string>();
        if (restoreMode === "merge") {
          const existingAttachments = await db.attachments.toArray();
          for (const att of existingAttachments) {
            const key = `${att.recordId}:${att.filename}`;
            existingAttachmentKeys.add(key);
          }
        }
        
        for (const attachment of attachments) {
          const { id, encryptedPayload, isEncrypted, ...attData } = attachment;
          const attKey = `${attData.recordId}:${attData.filename}`;
          
          // Skip duplicates in merge mode
          if (restoreMode === "merge" && existingAttachmentKeys.has(attKey)) {
            continue;
          }
          
          const newAttachment = {
            recordId: attData.recordId,
            filename: attData.filename || "unknown",
            mimeType: attData.mimeType || "application/octet-stream",
            size: attData.size || 0,
            objectStoragePath: attData.objectStoragePath || "",
            createdAt: attData.createdAt || Date.now(),
          };
          
          const encrypted = await encryptAttachment(newAttachment as any, currentKey);
          await db.attachments.add(encrypted);
          attachmentsAdded++;
        }
      }

      // Restore attachment files from ZIP
      setRestoreProgress(85);
      setRestoreMessage("Restoring attachment files...");
      
      let attachmentFilesRestored = 0;
      let attachmentFilesErrors = 0;
      const attachmentsFolder = zip.folder("attachments");
      if (attachmentsFolder) {
        const filePromises: Promise<void>[] = [];
        
        attachmentsFolder.forEach((relativePath, file) => {
          if (!file.dir) {
            filePromises.push((async () => {
              try {
                const fileData = await file.async("arraybuffer");
                
                if (isElectron()) {
                  const api = getElectronAPI();
                  const result = await api.writeAttachment(relativePath, fileData);
                  if (!result.success) {
                    console.error(`Failed to restore attachment file ${relativePath}:`, result.error);
                    attachmentFilesErrors++;
                    return;
                  }
                } else {
                  // Web mode: use API endpoint
                  const formData = new FormData();
                  formData.append('file', new Blob([fileData]));
                  formData.append('relativePath', relativePath);
                  
                  const response = await fetch('/api/attachments/write', {
                    method: 'POST',
                    body: formData,
                  });
                  
                  if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    console.error(`Failed to restore attachment file ${relativePath}:`, errorData.error || response.statusText);
                    attachmentFilesErrors++;
                    return;
                  }
                }
                
                attachmentFilesRestored++;
              } catch (err) {
                console.error(`Failed to restore attachment file ${relativePath}:`, err);
                attachmentFilesErrors++;
              }
            })());
          }
        });
        
        await Promise.all(filePromises);
      }

      setRestoreProgress(90);
      setRestoreMessage("Restoring custom fields...");

      let customFieldsAdded = 0;

      // Restore custom fields
      if (backupCustomFields && backupCustomFields.length > 0) {
        for (const field of backupCustomFields) {
          const { id, ...fieldData } = field;
          if (restoreMode === "merge") {
            const existing = await db.customFields.where('slug').equals(fieldData.slug).first();
            if (!existing) {
              await db.customFields.add({ ...fieldData, createdAt: fieldData.createdAt || Date.now() });
              customFieldsAdded++;
            }
          } else {
            await db.customFields.add({ ...fieldData, createdAt: fieldData.createdAt || Date.now() });
            customFieldsAdded++;
          }
        }
      }

      setRestoreProgress(92);
      setRestoreMessage("Restoring vocabulary items...");

      let vocabularyAdded = 0;

      // Track existing vocabulary names for merge mode
      let existingOwnerNames = new Set<string>();
      let existingWalletNameNames = new Set<string>();
      let existingSeedNameNames = new Set<string>();
      let existingWalletSoftwareNames = new Set<string>();
      
      if (restoreMode === "merge") {
        const existingOwners = await db.owners.toArray();
        for (const owner of existingOwners) {
          if (owner.isEncrypted && owner.encryptedPayload) {
            try {
              const decrypted = await decryptOwner(owner, currentKey);
              existingOwnerNames.add(decrypted.name);
            } catch {
              existingOwnerNames.add(owner.name);
            }
          } else {
            existingOwnerNames.add(owner.name);
          }
        }
        
        const existingWalletNames = await db.walletNames.toArray();
        for (const wn of existingWalletNames) {
          if (wn.isEncrypted && wn.encryptedPayload) {
            try {
              const decrypted = await decryptWalletName(wn, currentKey);
              existingWalletNameNames.add(decrypted.name);
            } catch {
              existingWalletNameNames.add(wn.name);
            }
          } else {
            existingWalletNameNames.add(wn.name);
          }
        }
        
        const existingSeedNames = await db.seedNames.toArray();
        for (const sn of existingSeedNames) {
          if (sn.isEncrypted && sn.encryptedPayload) {
            try {
              const decrypted = await decryptSeedName(sn, currentKey);
              existingSeedNameNames.add(decrypted.name);
            } catch {
              existingSeedNameNames.add(sn.name);
            }
          } else {
            existingSeedNameNames.add(sn.name);
          }
        }
        
        const existingWalletSoftware = await db.walletSoftware.toArray();
        for (const ws of existingWalletSoftware) {
          if (ws.isEncrypted && ws.encryptedPayload) {
            try {
              const decrypted = await decryptWalletSoftware(ws, currentKey);
              existingWalletSoftwareNames.add(decrypted.name);
            } catch {
              existingWalletSoftwareNames.add(ws.name);
            }
          } else {
            existingWalletSoftwareNames.add(ws.name);
          }
        }
      }

      // Restore owners
      if (owners && owners.length > 0) {
        for (const owner of owners) {
          const { id, encryptedPayload, isEncrypted, ...ownerData } = owner;
          const ownerName = ownerData.name || "";
          
          if (restoreMode === "merge" && existingOwnerNames.has(ownerName)) {
            continue;
          }
          
          const newOwner = {
            name: ownerName,
            createdAt: ownerData.createdAt || Date.now(),
          };
          
          const encrypted = await encryptOwner(newOwner as any, currentKey);
          await db.owners.add(encrypted);
          vocabularyAdded++;
        }
      }

      // Restore wallet names
      if (walletNames && walletNames.length > 0) {
        for (const wn of walletNames) {
          const { id, encryptedPayload, isEncrypted, ...wnData } = wn;
          const wnName = wnData.name || "";
          
          if (restoreMode === "merge" && existingWalletNameNames.has(wnName)) {
            continue;
          }
          
          const newWalletName = {
            name: wnName,
            createdAt: wnData.createdAt || Date.now(),
          };
          
          const encrypted = await encryptWalletName(newWalletName as any, currentKey);
          await db.walletNames.add(encrypted);
          vocabularyAdded++;
        }
      }

      // Restore seed names
      if (seedNames && seedNames.length > 0) {
        for (const sn of seedNames) {
          const { id, encryptedPayload, isEncrypted, ...snData } = sn;
          const snName = snData.name || "";
          
          if (restoreMode === "merge" && existingSeedNameNames.has(snName)) {
            continue;
          }
          
          const newSeedName = {
            name: snName,
            createdAt: snData.createdAt || Date.now(),
          };
          
          const encrypted = await encryptSeedName(newSeedName as any, currentKey);
          await db.seedNames.add(encrypted);
          vocabularyAdded++;
        }
      }

      // Restore wallet software
      if (walletSoftware && walletSoftware.length > 0) {
        for (const ws of walletSoftware) {
          const { id, encryptedPayload, isEncrypted, ...wsData } = ws;
          const wsName = wsData.name || "";
          
          if (restoreMode === "merge" && existingWalletSoftwareNames.has(wsName)) {
            continue;
          }
          
          const newWalletSoftware = {
            name: wsName,
            createdAt: wsData.createdAt || Date.now(),
          };
          
          const encrypted = await encryptWalletSoftware(newWalletSoftware as any, currentKey);
          await db.walletSoftware.add(encrypted);
          vocabularyAdded++;
        }
      }

      setRestoreProgress(96);
      setRestoreMessage("Restoring derivation templates...");

      let templatesAdded = 0;

      // Restore derivation templates
      if (derivationTemplates && derivationTemplates.length > 0) {
        // Track existing templates by fingerprint+scriptType for merge mode
        let existingTemplateKeys = new Set<string>();
        if (restoreMode === "merge") {
          const existingTemplates = await db.derivationTemplates.toArray();
          for (const t of existingTemplates) {
            existingTemplateKeys.add(`${t.fingerprint}:${t.scriptType}`);
          }
        }
        
        for (const template of derivationTemplates) {
          const { id, encryptedPayload, isEncrypted, ...templateData } = template;
          const templateKey = `${templateData.fingerprint}:${templateData.scriptType}`;
          
          if (restoreMode === "merge" && existingTemplateKeys.has(templateKey)) {
            continue;
          }
          
          const newTemplate = {
            fingerprint: templateData.fingerprint || "unknown",
            scriptType: templateData.scriptType || "P2WPKH",
            derivationPath: templateData.derivationPath || "m/84'/0'/0'",
            xpub: templateData.xpub,
            gapLimit: templateData.gapLimit || 20,
            network: templateData.network || "mainnet",
            owner: templateData.owner,
            walletName: templateData.walletName,
            seedName: templateData.seedName,
            notes: templateData.notes,
            createdAt: templateData.createdAt || Date.now(),
            updatedAt: templateData.updatedAt || Date.now(),
          };
          
          const encrypted = await encryptDerivationTemplate(newTemplate as any, currentKey);
          await db.derivationTemplates.add(encrypted);
          templatesAdded++;
        }
      }

      setRestoreProgress(97);
      setRestoreMessage("Restoring evidence and additional data...");

      let evidenceAdded = 0;
      let evidenceAttachmentsAdded = 0;
      let priceDataAdded = 0;
      let lineageDataAdded = 0;

      // Restore evidence documents (v2.2.0+)
      if (evidence && evidence.length > 0) {
        for (const ev of evidence) {
          const { id, encryptedPayload, isEncrypted, ...evData } = ev;
          
          const newEvidence = {
            title: evData.title || "Restored Evidence",
            documentType: evData.documentType || "other",
            originalDate: evData.originalDate,
            notes: evData.notes,
            tags: evData.tags || [],
            partiesInvolved: evData.partiesInvolved || [],
            source: evData.source,
            importance: evData.importance,
            createdAt: evData.createdAt || Date.now(),
            updatedAt: evData.updatedAt || Date.now(),
          };
          
          const encrypted = await encryptEvidence(newEvidence as any, currentKey);
          await db.evidence.add(encrypted);
          evidenceAdded++;
        }
      }

      // Restore evidence attachments (v2.2.0+)
      if (evidenceAttachments && evidenceAttachments.length > 0) {
        for (const ea of evidenceAttachments) {
          const { id, encryptedPayload, isEncrypted, ...eaData } = ea;
          
          const newEvidenceAttachment = {
            evidenceId: eaData.evidenceId,
            filename: eaData.filename || "unknown",
            mimeType: eaData.mimeType || "application/octet-stream",
            size: eaData.size || 0,
            objectStoragePath: eaData.objectStoragePath || "",
            createdAt: eaData.createdAt || Date.now(),
            isEncrypted: eaData.isEncrypted ?? true,
          };
          
          const encrypted = await encryptEvidenceAttachment(newEvidenceAttachment as any, currentKey);
          await db.evidenceAttachments.add(encrypted);
          evidenceAttachmentsAdded++;
        }
      }

      // Restore price data (v2.2.0+, not encrypted)
      if (priceData && priceData.length > 0) {
        for (const pd of priceData) {
          const { id, ...pdData } = pd;
          await db.priceData.add(pdData);
          priceDataAdded++;
        }
      }

      // Restore node settings (v2.2.0+, not encrypted)
      if (backupNodeSettings && backupNodeSettings.length > 0) {
        for (const ns of backupNodeSettings) {
          const { id, ...nsData } = ns;
          await db.nodeSettings.add(nsData);
        }
      }

      // Restore UTXO lineage data (v2.2.0+, not encrypted)
      if (utxoLineage && utxoLineage.length > 0) {
        for (const ul of utxoLineage) {
          const { id, ...ulData } = ul;
          await db.utxoLineage.add(ulData);
          lineageDataAdded++;
        }
      }

      // Restore custody segments (v2.2.0+, not encrypted)
      if (custodySegments && custodySegments.length > 0) {
        for (const cs of custodySegments) {
          const { id, ...csData } = cs;
          await db.custodySegments.add(csData);
        }
      }

      setRestoreProgress(100);
      setRestoreMessage("Restore complete!");

      let attachmentFilesMsg = "";
      if (attachmentFilesRestored > 0 && attachmentFilesErrors === 0) {
        attachmentFilesMsg = `, ${attachmentFilesRestored} attachment files`;
      } else if (attachmentFilesRestored > 0 && attachmentFilesErrors > 0) {
        attachmentFilesMsg = `, ${attachmentFilesRestored} attachment files (${attachmentFilesErrors} failed)`;
      } else if (attachmentFilesErrors > 0) {
        attachmentFilesMsg = ` (${attachmentFilesErrors} attachment files failed)`;
      }
      let additionalDataMsg = "";
      if (evidenceAdded > 0 || priceDataAdded > 0 || lineageDataAdded > 0) {
        const parts = [];
        if (evidenceAdded > 0) parts.push(`${evidenceAdded} evidence`);
        if (priceDataAdded > 0) parts.push(`${priceDataAdded} prices`);
        if (lineageDataAdded > 0) parts.push(`${lineageDataAdded} lineage`);
        additionalDataMsg = `, ${parts.join(", ")}`;
      }

      const message = restoreMode === "merge"
        ? `Added ${recordsAdded} records (${recordsSkipped} skipped), ${tagsAdded} tags, ${categoriesAdded} categories, ${vocabularyAdded} vocabulary items, ${templatesAdded} templates${attachmentFilesMsg}${additionalDataMsg}.`
        : `Restored ${recordsAdded} records, ${tagsAdded} tags, ${categoriesAdded} categories, ${vocabularyAdded} vocabulary items, ${templatesAdded} templates${attachmentFilesMsg}${additionalDataMsg}.`;

      toast({
        title: "Restore Successful",
        description: message,
      });

      // Close dialog and reset state
      setTimeout(() => {
        setRestoreDialogOpen(false);
        setRestoreFile(null);
        setRestorePassword("");
        setRestoreProgress(0);
        setRestoreMessage("");
        setBackupInfo(null);
        // Reload to refresh all data
        window.location.reload();
      }, 1500);

    } catch (error) {
      console.error("Restore failed:", error);
      toast({
        variant: "destructive",
        title: "Restore Failed",
        description: error instanceof Error ? error.message : "Failed to restore backup",
      });
      setRestoreProgress(0);
      setRestoreMessage("");
    } finally {
      setIsRestoring(false);
    }
  };

  const isLoading = settingsLoading || customFieldsLoading;

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold mb-2">Settings</h1>
          <p className="text-muted-foreground">
            Configure your KYUTXO application preferences
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Moon className="h-5 w-5" />
              Appearance
            </CardTitle>
            <CardDescription>
              Customize the look and feel of the application
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-base">Dark Mode</Label>
                <p className="text-sm text-muted-foreground">
                  Switch between light and dark theme
                </p>
              </div>
              <ThemeToggle />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Eye className="h-5 w-5" />
              Field Visibility
            </CardTitle>
            <CardDescription>
              Choose which fields to show in forms and tables
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-muted-foreground">Built-in Fields</h4>
              
              <div className="flex items-center justify-between">
                <Label>Seed Name</Label>
                <Switch
                  checked={fieldVisibility.seedName}
                  onCheckedChange={() => handleToggleBuiltInField('seedName')}
                  disabled={isLoading}
                  data-testid="switch-seed"
                />
              </div>
              
              <div className="flex items-center justify-between">
                <Label>Wallet Software</Label>
                <Switch
                  checked={fieldVisibility.walletSoftware}
                  onCheckedChange={() => handleToggleBuiltInField('walletSoftware')}
                  disabled={isLoading}
                  data-testid="switch-wallet"
                />
              </div>
              
              <div className="flex items-center justify-between">
                <Label>Owner</Label>
                <Switch
                  checked={fieldVisibility.owner}
                  onCheckedChange={() => handleToggleBuiltInField('owner')}
                  disabled={isLoading}
                  data-testid="switch-owner"
                />
              </div>
              
              <div className="flex items-center justify-between">
                <Label>Wallet Name</Label>
                <Switch
                  checked={fieldVisibility.walletName}
                  onCheckedChange={() => handleToggleBuiltInField('walletName')}
                  disabled={isLoading}
                  data-testid="switch-wallet-name"
                />
              </div>
              
              <div className="flex items-center justify-between">
                <Label>Private Key Status</Label>
                <Switch
                  checked={fieldVisibility.privateKeyStatus}
                  onCheckedChange={() => handleToggleBuiltInField('privateKeyStatus')}
                  disabled={isLoading}
                  data-testid="switch-private-key"
                />
              </div>
              
              <div className="flex items-center justify-between">
                <Label>Source</Label>
                <Switch
                  checked={fieldVisibility.source}
                  onCheckedChange={() => handleToggleBuiltInField('source')}
                  disabled={isLoading}
                  data-testid="switch-source"
                />
              </div>
            </div>

            <Separator className="my-4" />

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium text-muted-foreground">Custom Fields</h4>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setIsAddingField(true)}
                  data-testid="button-add-custom-field"
                >
                  <Plus className="h-4 w-4 mr-1" />
                  Add Field
                </Button>
              </div>

              {customFields.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  No custom fields defined. Add your own fields to track additional metadata.
                </p>
              ) : (
                <div className="space-y-2">
                  {customFields.map((field) => (
                    <div
                      key={field.id}
                      className="flex items-center justify-between py-2 px-3 rounded-md bg-muted/50"
                      data-testid={`custom-field-row-${field.id}`}
                    >
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={field.enabled}
                          onCheckedChange={() => handleToggleCustomField(field.id!)}
                          data-testid={`switch-custom-field-${field.id}`}
                        />
                        <span className={field.enabled ? "" : "text-muted-foreground"}>
                          {field.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setEditingField({ id: field.id!, name: field.name })}
                          data-testid={`button-edit-field-${field.id}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setDeletingFieldId(field.id!)}
                          data-testid={`button-delete-field-${field.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="h-5 w-5" />
              Storage
            </CardTitle>
            <CardDescription>
              Information about local data storage
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Storage Type</span>
              <Badge variant="secondary">IndexedDB (Offline)</Badge>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Data Location</span>
              <span className="text-sm font-mono">Local Device</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Storage Used</span>
              <span className="text-sm font-medium" data-testid="text-storage">2.1 MB</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5" />
              Data Management
            </CardTitle>
            <CardDescription>
              Clear or restore your database
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-base">Restore from Backup</Label>
                <p className="text-sm text-muted-foreground">
                  Import data from a previously exported backup file
                </p>
              </div>
              <Button
                variant="outline"
                onClick={() => setRestoreDialogOpen(true)}
                data-testid="button-open-restore"
              >
                <Upload className="h-4 w-4 mr-2" />
                Restore
              </Button>
            </div>

            <Separator />

            <div className="flex items-center justify-between">
              <div>
                <Label className="text-base text-destructive">Clear Database</Label>
                <p className="text-sm text-muted-foreground">
                  Permanently delete all records, tags, and categories
                </p>
              </div>
              <Button
                variant="destructive"
                onClick={() => setClearDialogOpen(true)}
                data-testid="button-open-clear"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Clear All
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>About KYUTXO</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Version</span>
              <span className="font-medium">1.0.0</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Type</span>
              <Badge variant="outline">Progressive Web App</Badge>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Privacy</span>
              <span className="font-medium">All data stored locally</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Add Custom Field Dialog */}
      <Dialog open={isAddingField} onOpenChange={setIsAddingField}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Custom Field</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="field-name">Field Name</Label>
            <Input
              id="field-name"
              value={newFieldName}
              onChange={(e) => setNewFieldName(e.target.value)}
              placeholder="e.g., Exchange, Account Number"
              className="mt-2"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleAddCustomField();
                }
              }}
              data-testid="input-new-field-name"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddingField(false)}>
              Cancel
            </Button>
            <Button onClick={handleAddCustomField} data-testid="button-confirm-add-field">
              Add Field
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Custom Field Dialog */}
      <Dialog open={editingField !== null} onOpenChange={(open) => !open && setEditingField(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Custom Field</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="edit-field-name">Field Name</Label>
            <Input
              id="edit-field-name"
              value={editingField?.name || ""}
              onChange={(e) => setEditingField(prev => prev ? { ...prev, name: e.target.value } : null)}
              placeholder="Field name"
              className="mt-2"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleUpdateCustomField();
                }
              }}
              data-testid="input-edit-field-name"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingField(null)}>
              Cancel
            </Button>
            <Button onClick={handleUpdateCustomField} data-testid="button-confirm-edit-field">
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deletingFieldId !== null} onOpenChange={(open) => !open && setDeletingFieldId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Custom Field</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this custom field? This will not remove existing data from records, but the field will no longer appear in forms.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteCustomField} data-testid="button-confirm-delete-field">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Clear Database Dialog */}
      <Dialog open={clearDialogOpen} onOpenChange={(open) => {
        if (!open && !isClearing) {
          setClearDialogOpen(false);
          setClearPassword("");
          setClearPhrase("");
        }
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Clear All Data
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="p-4 bg-destructive/10 rounded-lg border border-destructive/20">
              <p className="text-sm text-destructive font-medium">
                Warning: This action cannot be undone!
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                All records, tags, categories, attachments, and custom fields will be permanently deleted.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="clear-password">Enter your vault password</Label>
              <Input
                id="clear-password"
                type="password"
                value={clearPassword}
                onChange={(e) => setClearPassword(e.target.value)}
                placeholder="Your vault password"
                disabled={isClearing}
                data-testid="input-clear-password"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="clear-phrase">
                Type <span className="font-mono text-destructive">{DELETE_CONFIRMATION_PHRASE}</span> to confirm
              </Label>
              <Input
                id="clear-phrase"
                type="text"
                value={clearPhrase}
                onChange={(e) => setClearPhrase(e.target.value)}
                placeholder={DELETE_CONFIRMATION_PHRASE}
                disabled={isClearing}
                data-testid="input-clear-phrase"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setClearDialogOpen(false);
              setClearPassword("");
              setClearPhrase("");
            }} disabled={isClearing}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleClearDatabase}
              disabled={isClearing || !clearPassword || clearPhrase !== DELETE_CONFIRMATION_PHRASE}
              data-testid="button-confirm-clear"
            >
              {isClearing ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Clearing...
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4 mr-2" />
                  Clear All Data
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Restore Dialog */}
      <Dialog open={restoreDialogOpen} onOpenChange={(open) => {
        if (!open && !isRestoring) {
          setRestoreDialogOpen(false);
          setRestoreFile(null);
          setRestorePassword("");
          setRestoreProgress(0);
          setRestoreMessage("");
          setBackupInfo(null);
        }
      }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Upload className="h-5 w-5" />
              Restore from Backup
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Select backup file</Label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip"
                onChange={handleFileSelect}
                className="hidden"
                data-testid="input-restore-file"
              />
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isRestoring}
                >
                  {restoreFile ? restoreFile.name : "Choose ZIP file..."}
                </Button>
                {restoreFile && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setRestoreFile(null);
                      setBackupInfo(null);
                      if (fileInputRef.current) {
                        fileInputRef.current.value = "";
                      }
                    }}
                    disabled={isRestoring}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>

            {backupInfo && (
              <div className="p-3 bg-muted rounded-lg space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Backup Date:</span>
                  <span className="font-medium">
                    {new Date(backupInfo.date).toLocaleDateString()}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Encrypted:</span>
                  <Badge variant={backupInfo.encrypted ? "default" : "secondary"}>
                    {backupInfo.encrypted ? "Yes" : "No"}
                  </Badge>
                </div>
                {!backupInfo.encrypted && backupInfo.recordCount >= 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Records:</span>
                    <span className="font-medium">{backupInfo.recordCount}</span>
                  </div>
                )}
              </div>
            )}

            {backupInfo?.encrypted && (
              <div className="space-y-2">
                <Label htmlFor="restore-password">Backup password</Label>
                <Input
                  id="restore-password"
                  type="password"
                  value={restorePassword}
                  onChange={(e) => setRestorePassword(e.target.value)}
                  placeholder="Enter the password used to encrypt this backup"
                  disabled={isRestoring}
                  data-testid="input-restore-password"
                />
              </div>
            )}

            <div className="space-y-2">
              <Label>Restore mode</Label>
              <RadioGroup
                value={restoreMode}
                onValueChange={(value) => setRestoreMode(value as "replace" | "merge")}
                disabled={isRestoring}
              >
                <div className="flex items-start space-x-3 p-3 rounded-lg border bg-background hover-elevate">
                  <RadioGroupItem value="replace" id="mode-replace" data-testid="radio-replace" />
                  <div className="space-y-1">
                    <Label htmlFor="mode-replace" className="font-medium cursor-pointer">
                      Replace all data
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Delete all existing data and replace with backup contents
                    </p>
                  </div>
                </div>
                <div className="flex items-start space-x-3 p-3 rounded-lg border bg-background hover-elevate">
                  <RadioGroupItem value="merge" id="mode-merge" data-testid="radio-merge" />
                  <div className="space-y-1">
                    <Label htmlFor="mode-merge" className="font-medium cursor-pointer">
                      Merge with existing
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Add backup data to existing records, skipping duplicates
                    </p>
                  </div>
                </div>
              </RadioGroup>
            </div>

            {isRestoring && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span>{restoreMessage}</span>
                  <span>{restoreProgress}%</span>
                </div>
                <Progress value={restoreProgress} />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setRestoreDialogOpen(false);
              setRestoreFile(null);
              setRestorePassword("");
              setRestoreProgress(0);
              setRestoreMessage("");
              setBackupInfo(null);
            }} disabled={isRestoring}>
              Cancel
            </Button>
            <Button
              onClick={handleRestore}
              disabled={isRestoring || !restoreFile || (backupInfo?.encrypted && !restorePassword)}
              data-testid="button-confirm-restore"
            >
              {isRestoring ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Restoring...
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4 mr-2" />
                  Restore Backup
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

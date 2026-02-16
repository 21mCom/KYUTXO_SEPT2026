import { useState, useEffect, useCallback } from "react";
import { Edit, Tag, FolderOpen, Wallet, Sprout, Users, Plus, Trash2, RefreshCw, KeySquare, ArrowLeftRight, TrendingUp, TrendingDown, UserCheck, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useEncryptedTags, useEncryptedCategories } from "@/hooks/use-encrypted-records";
import { db, type Record as DbRecord } from "@/lib/database";
import { isEncryptionReady } from "@/lib/encryption/key-management";
import { decryptRecordsWithProgress } from "@/lib/encryption/record-encryption";
import type { DecryptProgress } from "@/lib/encryption/record-encryption";
import { useOwners } from "@/hooks/use-owners";
import { useWalletNames } from "@/hooks/use-wallet-names";
import { useSeedNames, SEED_NAME_MAX_LENGTH } from "@/hooks/use-seed-names";
import { useWalletSoftware } from "@/hooks/use-wallet-software";
import { 
  updateRecord, 
  createTag, 
  updateTag, 
  deleteTag, 
  createCategory, 
  updateCategory, 
  deleteCategory,
  createOwner,
  updateOwner,
  deleteOwner,
  createWalletNameEntry,
  updateWalletNameEntry,
  deleteWalletNameEntry,
  createSeedNameEntry,
  updateSeedNameEntry,
  deleteSeedNameEntry,
  createWalletSoftwareEntry,
  updateWalletSoftwareEntry,
  deleteWalletSoftwareEntry,
} from "@/lib/encryptionFacade";
import { useToast } from "@/hooks/use-toast";
import { 
  type Record,
  FLOW_TYPE_OPTIONS,
  ACQUISITION_METHOD_OPTIONS,
  DISPOSITION_TYPE_OPTIONS,
  COUNTERPARTY_TYPE_OPTIONS,
} from "@/lib/database";
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

type FieldType = 'tags' | 'categories' | 'walletSoftware' | 'seedName' | 'owner' | 'walletName' | 'flowType' | 'acquisitionMethod' | 'dispositionType' | 'counterpartyType';

interface UniqueValue {
  value: string;
  count: number;
}

interface FieldConfig {
  key: FieldType;
  label: string;
  icon: typeof Tag;
  description: string;
  isArray: boolean;
  hasMasterList: boolean;
  enumOptions?: { value: string; label: string }[];
}

const FIELD_CONFIGS: FieldConfig[] = [
  { 
    key: 'tags', 
    label: 'Tags', 
    icon: Tag, 
    description: 'Labels for organizing records',
    isArray: true,
    hasMasterList: true,
  },
  { 
    key: 'categories', 
    label: 'Categories', 
    icon: FolderOpen, 
    description: 'Group records into categories',
    isArray: true,
    hasMasterList: true,
  },
  { 
    key: 'owner', 
    label: 'Owner', 
    icon: Users, 
    description: 'Who owns/controls this address (e.g., Personal, Spouse, Acme Corp)',
    isArray: false,
    hasMasterList: true,
  },
  { 
    key: 'walletName', 
    label: 'Wallet Name', 
    icon: Wallet, 
    description: 'Specific wallet purpose within an owner (e.g., College Fund, Trading)',
    isArray: false,
    hasMasterList: true,
  },
  { 
    key: 'seedName', 
    label: 'Seed Name', 
    icon: Sprout, 
    description: 'Named seed phrases for wallet recovery',
    isArray: false,
    hasMasterList: true,
  },
  { 
    key: 'walletSoftware', 
    label: 'Wallet Software', 
    icon: KeySquare, 
    description: 'Wallet applications used (e.g., Trezor, Sparrow, Mycelium)',
    isArray: false,
    hasMasterList: true,
  },
  { 
    key: 'flowType', 
    label: 'Flow Type', 
    icon: ArrowLeftRight, 
    description: 'Transaction direction (received, sent, self-transfer, consolidation)',
    isArray: false,
    hasMasterList: false,
    enumOptions: FLOW_TYPE_OPTIONS,
  },
  { 
    key: 'acquisitionMethod', 
    label: 'Acquisition Method', 
    icon: TrendingUp, 
    description: 'How funds were acquired (purchase, mining, gift, salary, etc.)',
    isArray: false,
    hasMasterList: false,
    enumOptions: ACQUISITION_METHOD_OPTIONS,
  },
  { 
    key: 'dispositionType', 
    label: 'Disposition Type', 
    icon: TrendingDown, 
    description: 'How funds were disposed (sale, payment, gift, donation, etc.)',
    isArray: false,
    hasMasterList: false,
    enumOptions: DISPOSITION_TYPE_OPTIONS,
  },
  { 
    key: 'counterpartyType', 
    label: 'Counterparty Type', 
    icon: UserCheck, 
    description: 'Type of external party (exchange, individual, business, etc.)',
    isArray: false,
    hasMasterList: false,
    enumOptions: COUNTERPARTY_TYPE_OPTIONS,
  },
];

const PLAINTEXT_FIELDS_LIST: FieldType[] = ['tags', 'categories', 'flowType', 'acquisitionMethod', 'dispositionType', 'counterpartyType'];
const ENCRYPTED_FIELDS_LIST: FieldType[] = ['owner', 'walletName', 'seedName', 'walletSoftware'];
const PLAINTEXT_FIELDS = new Set<FieldType>(PLAINTEXT_FIELDS_LIST);
const ENCRYPTED_FIELDS = new Set<FieldType>(ENCRYPTED_FIELDS_LIST);

export default function ValueUpdaterPage() {
  const [plaintextValues, setPlaintextValues] = useState<Map<FieldType, UniqueValue[]>>(new Map());
  const [encryptedValues, setEncryptedValues] = useState<Map<FieldType, UniqueValue[]>>(new Map());
  const [decryptedRecords, setDecryptedRecords] = useState<DbRecord[] | null>(null);
  const [plaintextLoading, setPlaintextLoading] = useState(true);
  const [encryptedLoading, setEncryptedLoading] = useState(false);
  const [encryptedLoaded, setEncryptedLoaded] = useState(false);
  const { tags, isLoading: tagsLoading } = useEncryptedTags();
  const { categories, isLoading: categoriesLoading } = useEncryptedCategories();
  const { owners, isLoading: ownersLoading } = useOwners();
  const { walletNames, isLoading: walletNamesLoading } = useWalletNames();
  const { seedNames, isLoading: seedNamesLoading } = useSeedNames();
  const { walletSoftware, isLoading: walletSoftwareLoading } = useWalletSoftware();
  const { toast } = useToast();
  const [decryptProgress, setDecryptProgress] = useState<DecryptProgress | null>(null);

  const extractValuesFromRecords = useCallback((records: DbRecord[], fieldsList: FieldType[]): Map<FieldType, UniqueValue[]> => {
    const result = new Map<FieldType, UniqueValue[]>();
    const counters = new Map<FieldType, Map<string, number>>();
    for (const field of fieldsList) {
      counters.set(field, new Map());
    }

    for (const record of records) {
      for (const field of fieldsList) {
        const counter = counters.get(field)!;
        const config = FIELD_CONFIGS.find(f => f.key === field);
        if (config?.isArray) {
          const values = (record as any)[field] as string[] | undefined;
          if (values && Array.isArray(values)) {
            for (const v of values) {
              if (v && typeof v === 'string' && v.trim()) {
                const normalized = v.trim();
                counter.set(normalized, (counter.get(normalized) || 0) + 1);
              }
            }
          }
        } else {
          const value = (record as any)[field] as string | undefined;
          if (value && typeof value === 'string' && value.trim()) {
            const normalized = value.trim();
            counter.set(normalized, (counter.get(normalized) || 0) + 1);
          }
        }
      }
    }

    for (const field of fieldsList) {
      const counter = counters.get(field)!;
      result.set(field, Array.from(counter.entries())
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => a.value.localeCompare(b.value)));
    }
    return result;
  }, []);

  const loadPlaintextValues = useCallback(async () => {
    setPlaintextLoading(true);
    try {
      const rawRecords = await db.records.toArray();
      const values = extractValuesFromRecords(rawRecords, PLAINTEXT_FIELDS_LIST);
      setPlaintextValues(values);
    } catch (error) {
      console.error('Failed to load plaintext values:', error);
    } finally {
      setPlaintextLoading(false);
    }
  }, [extractValuesFromRecords]);

  const loadEncryptedValues = useCallback(async () => {
    if (encryptedLoaded || encryptedLoading) return;
    setEncryptedLoading(true);
    try {
      const rawRecords = await db.records.toArray();
      let records: DbRecord[];
      if (isEncryptionReady()) {
        records = await decryptRecordsWithProgress(rawRecords, setDecryptProgress);
        setDecryptProgress(null);
      } else {
        records = rawRecords;
      }
      setDecryptedRecords(records);
      const values = extractValuesFromRecords(records, ENCRYPTED_FIELDS_LIST);
      setEncryptedValues(values);
      setEncryptedLoaded(true);
    } catch (error) {
      console.error('Failed to load encrypted values:', error);
    } finally {
      setEncryptedLoading(false);
    }
  }, [encryptedLoaded, encryptedLoading, extractValuesFromRecords]);

  const reloadAll = useCallback(async () => {
    setEncryptedLoaded(false);
    setDecryptedRecords(null);
    await loadPlaintextValues();
  }, [loadPlaintextValues]);

  useEffect(() => {
    loadPlaintextValues();
  }, [loadPlaintextValues]);
  
  const [editingField, setEditingField] = useState<FieldType | null>(null);
  const [editingValue, setEditingValue] = useState<string>("");
  const [newValue, setNewValue] = useState<string>("");
  const [isUpdating, setIsUpdating] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ field: FieldType; value: string; count: number } | null>(null);
  const [newItemField, setNewItemField] = useState<FieldType | null>(null);
  const [newItemValue, setNewItemValue] = useState<string>("");
  const [editingUnusedField, setEditingUnusedField] = useState<FieldType | null>(null);
  const [editingUnusedValue, setEditingUnusedValue] = useState<string>("");
  const [newUnusedValue, setNewUnusedValue] = useState<string>("");
  const [activeTab, setActiveTab] = useState<FieldType>('tags');

  useEffect(() => {
    if (ENCRYPTED_FIELDS.has(activeTab) && !encryptedLoaded && !encryptedLoading) {
      loadEncryptedValues();
    }
  }, [activeTab, encryptedLoaded, encryptedLoading, loadEncryptedValues]);

  const getUniqueValues = (field: FieldType): UniqueValue[] => {
    if (PLAINTEXT_FIELDS.has(field)) {
      return plaintextValues.get(field) || [];
    }
    return encryptedValues.get(field) || [];
  };

  // Get display label for a value (enum label or original value for non-enum fields)
  const getDisplayLabel = (field: FieldType, value: string): string => {
    const config = FIELD_CONFIGS.find(f => f.key === field);
    if (config?.enumOptions) {
      const option = config.enumOptions.find(opt => opt.value === value);
      return option?.label || value;
    }
    return value;
  };

  // Check if a field uses predefined enum options (can't add new values)
  const hasEnumOptions = (field: FieldType): boolean => {
    const config = FIELD_CONFIGS.find(f => f.key === field);
    return !!config?.enumOptions;
  };

  const getUnusedMasterItems = (field: FieldType): string[] => {
    const usedValues = new Set(getUniqueValues(field).map(v => v.value.toLowerCase()));
    const config = FIELD_CONFIGS.find(f => f.key === field);
    
    // For enum-based fields, return unused enum option VALUES (not labels)
    // The getDisplayLabel function will convert to labels for display
    if (config?.enumOptions) {
      return config.enumOptions
        .filter(opt => !usedValues.has(opt.value.toLowerCase()))
        .map(opt => opt.value);
    }
    
    switch (field) {
      case 'tags':
        return tags
          .filter(t => !usedValues.has(t.name.toLowerCase()))
          .map(t => t.name);
      case 'categories':
        return categories
          .filter(c => !usedValues.has(c.name.toLowerCase()))
          .map(c => c.name);
      case 'owner':
        return owners
          .filter(o => !usedValues.has(o.name.toLowerCase()))
          .map(o => o.name);
      case 'walletName':
        return walletNames
          .filter(wn => !usedValues.has(wn.name.toLowerCase()))
          .map(wn => wn.name);
      case 'seedName':
        return seedNames
          .filter(sn => !usedValues.has(sn.name.toLowerCase()))
          .map(sn => sn.name);
      case 'walletSoftware':
        return walletSoftware
          .filter(ws => !usedValues.has(ws.name.toLowerCase()))
          .map(ws => ws.name);
      default:
        return [];
    }
  };

  const getRecordsForField = useCallback(async (field: FieldType): Promise<DbRecord[]> => {
    if (ENCRYPTED_FIELDS.has(field)) {
      if (decryptedRecords) return decryptedRecords;
      const rawRecords = await db.records.toArray();
      if (isEncryptionReady()) {
        const decrypted = await decryptRecordsWithProgress(rawRecords, setDecryptProgress);
        setDecryptProgress(null);
        setDecryptedRecords(decrypted);
        return decrypted;
      }
      return rawRecords;
    }
    return db.records.toArray();
  }, [decryptedRecords]);

  const handleUpdateValue = async (field: FieldType, oldValue: string, newValueInput: string) => {
    if (!newValueInput.trim() || newValueInput.trim() === oldValue) {
      setEditingField(null);
      setEditingValue("");
      setNewValue("");
      return;
    }

    setIsUpdating(true);
    const trimmedNewValue = newValueInput.trim();
    const config = FIELD_CONFIGS.find(f => f.key === field)!;
    
    if (config.enumOptions) {
      const validValues = config.enumOptions.map(opt => opt.value);
      if (!validValues.includes(trimmedNewValue)) {
        toast({
          variant: "destructive",
          title: "Invalid Value",
          description: `"${trimmedNewValue}" is not a valid ${config.label.toLowerCase()}. Valid options: ${validValues.join(', ')}`,
        });
        setIsUpdating(false);
        return;
      }
    }
    
    try {
      let updateCount = 0;
      const fieldRecords = await getRecordsForField(field);
      
      for (const record of fieldRecords) {
        let needsUpdate = false;
        let updatedData: Partial<Record> = {};
        
        if (config.isArray) {
          const currentValues = (record[field] as string[] | undefined) || [];
          if (currentValues.includes(oldValue)) {
            const newValues = currentValues.map(v => v === oldValue ? trimmedNewValue : v);
            const uniqueValues = Array.from(new Set(newValues));
            updatedData[field] = uniqueValues as any;
            needsUpdate = true;
          }
        } else {
          if (record[field] === oldValue) {
            updatedData[field] = trimmedNewValue as any;
            needsUpdate = true;
          }
        }
        
        if (needsUpdate && record.id) {
          await updateRecord(record.id, updatedData);
          updateCount++;
        }
      }

      if (config.hasMasterList) {
        switch (field) {
          case 'tags': {
            const tag = tags.find(t => t.name === oldValue);
            if (tag?.id) {
              await updateTag(tag.id, { name: trimmedNewValue });
            }
            break;
          }
          case 'categories': {
            const category = categories.find(c => c.name === oldValue);
            if (category?.id) {
              await updateCategory(category.id, { name: trimmedNewValue });
            }
            break;
          }
          case 'owner': {
            const owner = owners.find(o => o.name === oldValue);
            if (owner?.id) {
              await updateOwner(owner.id, { name: trimmedNewValue });
            }
            break;
          }
          case 'walletName': {
            const walletName = walletNames.find(wn => wn.name === oldValue);
            if (walletName?.id) {
              await updateWalletNameEntry(walletName.id, { name: trimmedNewValue });
            }
            break;
          }
          case 'seedName': {
            const seedName = seedNames.find(sn => sn.name === oldValue);
            if (seedName?.id) {
              await updateSeedNameEntry(seedName.id, { name: trimmedNewValue });
            }
            break;
          }
          case 'walletSoftware': {
            const ws = walletSoftware.find(w => w.name === oldValue);
            if (ws?.id) {
              await updateWalletSoftwareEntry(ws.id, { name: trimmedNewValue });
            }
            break;
          }
        }
      }

      toast({
        title: "Value Updated",
        description: `"${oldValue}" renamed to "${trimmedNewValue}" across ${updateCount} record${updateCount !== 1 ? 's' : ''}`,
      });
      
      setEditingField(null);
      setEditingValue("");
      setNewValue("");
      reloadAll();
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Update Failed",
        description: error instanceof Error ? error.message : "Failed to update value",
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleDeleteValue = async () => {
    if (!deleteTarget) return;
    
    setIsUpdating(true);
    const { field, value, count } = deleteTarget;
    
    try {
      let updateCount = 0;
      const config = FIELD_CONFIGS.find(f => f.key === field)!;
      const fieldRecords = await getRecordsForField(field);
      
      for (const record of fieldRecords) {
        let needsUpdate = false;
        let updatedData: Partial<Record> = {};
        
        if (config.isArray) {
          const currentValues = (record[field] as string[] | undefined) || [];
          if (currentValues.includes(value)) {
            updatedData[field] = currentValues.filter(v => v !== value) as any;
            needsUpdate = true;
          }
        } else {
          if (record[field] === value) {
            updatedData[field] = undefined as any;
            needsUpdate = true;
          }
        }
        
        if (needsUpdate && record.id) {
          await updateRecord(record.id, updatedData);
          updateCount++;
        }
      }

      if (config.hasMasterList) {
        switch (field) {
          case 'tags': {
            const tag = tags.find(t => t.name === value);
            if (tag?.id) {
              await deleteTag(tag.id);
            }
            break;
          }
          case 'categories': {
            const category = categories.find(c => c.name === value);
            if (category?.id) {
              await deleteCategory(category.id);
            }
            break;
          }
          case 'owner': {
            const owner = owners.find(o => o.name === value);
            if (owner?.id) {
              await deleteOwner(owner.id);
            }
            break;
          }
          case 'walletName': {
            const walletName = walletNames.find(wn => wn.name === value);
            if (walletName?.id) {
              await deleteWalletNameEntry(walletName.id);
            }
            break;
          }
          case 'seedName': {
            const seedName = seedNames.find(sn => sn.name === value);
            if (seedName?.id) {
              await deleteSeedNameEntry(seedName.id);
            }
            break;
          }
          case 'walletSoftware': {
            const ws = walletSoftware.find(w => w.name === value);
            if (ws?.id) {
              await deleteWalletSoftwareEntry(ws.id);
            }
            break;
          }
        }
      }

      toast({
        title: "Value Removed",
        description: `"${value}" removed from ${updateCount} record${updateCount !== 1 ? 's' : ''}`,
      });
      
      setDeleteDialogOpen(false);
      setDeleteTarget(null);
      reloadAll();
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Delete Failed",
        description: error instanceof Error ? error.message : "Failed to delete value",
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleAddItem = async (field: FieldType) => {
    if (!newItemValue.trim()) return;
    
    const trimmedValue = newItemValue.trim();
    const config = FIELD_CONFIGS.find(f => f.key === field);
    if (!config?.hasMasterList) return;
    
    try {
      switch (field) {
        case 'tags':
          await createTag(trimmedValue);
          break;
        case 'categories':
          await createCategory(trimmedValue);
          break;
        case 'owner':
          await createOwner(trimmedValue);
          break;
        case 'walletName':
          await createWalletNameEntry(trimmedValue);
          break;
        case 'seedName':
          if (trimmedValue.length > SEED_NAME_MAX_LENGTH) {
            toast({
              variant: "destructive",
              title: "Seed name too long",
              description: `Seed names are limited to ${SEED_NAME_MAX_LENGTH} characters to prevent accidental seed phrase entry`,
            });
            return;
          }
          await createSeedNameEntry(trimmedValue);
          break;
        case 'walletSoftware':
          await createWalletSoftwareEntry(trimmedValue);
          break;
      }
      
      toast({
        title: `${config.label} Created`,
        description: `"${trimmedValue}" has been created`,
      });
      
      setNewItemField(null);
      setNewItemValue("");
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Creation Failed",
        description: error instanceof Error ? error.message : "Failed to create item",
      });
    }
  };

  const handleDeleteUnused = async (field: FieldType, name: string) => {
    const config = FIELD_CONFIGS.find(f => f.key === field);
    if (!config?.hasMasterList) return;
    
    try {
      switch (field) {
        case 'tags': {
          const tag = tags.find(t => t.name === name);
          if (tag?.id) {
            await deleteTag(tag.id);
          }
          break;
        }
        case 'categories': {
          const category = categories.find(c => c.name === name);
          if (category?.id) {
            await deleteCategory(category.id);
          }
          break;
        }
        case 'owner': {
          const owner = owners.find(o => o.name === name);
          if (owner?.id) {
            await deleteOwner(owner.id);
          }
          break;
        }
        case 'walletName': {
          const walletName = walletNames.find(wn => wn.name === name);
          if (walletName?.id) {
            await deleteWalletNameEntry(walletName.id);
          }
          break;
        }
        case 'seedName': {
          const seedName = seedNames.find(sn => sn.name === name);
          if (seedName?.id) {
            await deleteSeedNameEntry(seedName.id);
          }
          break;
        }
        case 'walletSoftware': {
          const ws = walletSoftware.find(w => w.name === name);
          if (ws?.id) {
            await deleteWalletSoftwareEntry(ws.id);
          }
          break;
        }
      }
      
      toast({
        title: `${config.label} Deleted`,
        description: `"${name}" has been removed`,
      });
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Delete Failed",
        description: error instanceof Error ? error.message : "Failed to delete item",
      });
    }
  };

  const handleUpdateUnused = async (field: FieldType, oldName: string, newName: string) => {
    if (!newName.trim() || newName.trim() === oldName) {
      setEditingUnusedField(null);
      setEditingUnusedValue("");
      setNewUnusedValue("");
      return;
    }

    const config = FIELD_CONFIGS.find(f => f.key === field);
    if (!config?.hasMasterList) return;

    setIsUpdating(true);
    const trimmedNewValue = newName.trim();
    
    try {
      switch (field) {
        case 'tags': {
          const tag = tags.find(t => t.name === oldName);
          if (tag?.id) {
            await updateTag(tag.id, { name: trimmedNewValue });
          }
          break;
        }
        case 'categories': {
          const category = categories.find(c => c.name === oldName);
          if (category?.id) {
            await updateCategory(category.id, { name: trimmedNewValue });
          }
          break;
        }
        case 'owner': {
          const owner = owners.find(o => o.name === oldName);
          if (owner?.id) {
            await updateOwner(owner.id, { name: trimmedNewValue });
          }
          break;
        }
        case 'walletName': {
          const walletName = walletNames.find(wn => wn.name === oldName);
          if (walletName?.id) {
            await updateWalletNameEntry(walletName.id, { name: trimmedNewValue });
          }
          break;
        }
        case 'seedName': {
          if (trimmedNewValue.length > SEED_NAME_MAX_LENGTH) {
            toast({
              variant: "destructive",
              title: "Seed name too long",
              description: `Seed names are limited to ${SEED_NAME_MAX_LENGTH} characters to prevent accidental seed phrase entry`,
            });
            setIsUpdating(false);
            return;
          }
          const seedName = seedNames.find(sn => sn.name === oldName);
          if (seedName?.id) {
            await updateSeedNameEntry(seedName.id, { name: trimmedNewValue });
          }
          break;
        }
        case 'walletSoftware': {
          const ws = walletSoftware.find(w => w.name === oldName);
          if (ws?.id) {
            await updateWalletSoftwareEntry(ws.id, { name: trimmedNewValue });
          }
          break;
        }
      }
      
      toast({
        title: `${config.label} Renamed`,
        description: `"${oldName}" renamed to "${trimmedNewValue}"`,
      });
      
      setEditingUnusedField(null);
      setEditingUnusedValue("");
      setNewUnusedValue("");
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Update Failed",
        description: error instanceof Error ? error.message : "Failed to update item",
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const isLoading = plaintextLoading || tagsLoading || categoriesLoading || ownersLoading || walletNamesLoading || seedNamesLoading || walletSoftwareLoading;

  const renderFieldSection = (config: FieldConfig) => {
    const isEncryptedField = ENCRYPTED_FIELDS.has(config.key);
    if (isEncryptedField && !encryptedLoaded) {
      return (
        <Card key={config.key}>
          <CardContent className="py-8">
            <div className="flex items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>
                {encryptedLoading ? (
                  decryptProgress
                    ? `Decrypting records ${decryptProgress.current.toLocaleString()}/${decryptProgress.total.toLocaleString()}${decryptProgress.cached > 0 ? ` (${decryptProgress.cached.toLocaleString()} cached)` : ''}...`
                    : 'Loading encrypted values...'
                ) : 'Preparing to load...'}
              </span>
            </div>
          </CardContent>
        </Card>
      );
    }

    const values = getUniqueValues(config.key);
    const Icon = config.icon;
    const unusedItems = config.hasMasterList 
      ? getUnusedMasterItems(config.key)
      : [];

    return (
      <Card key={config.key}>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Icon className="h-5 w-5 text-muted-foreground" />
              <CardTitle>{config.label}</CardTitle>
            </div>
            {config.hasMasterList && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setNewItemField(config.key);
                  setNewItemValue("");
                }}
                data-testid={`button-add-${config.key}`}
              >
                <Plus className="h-4 w-4 mr-1" />
                Add New
              </Button>
            )}
          </div>
          <CardDescription>{config.description}</CardDescription>
        </CardHeader>
        <CardContent>
          {newItemField === config.key && (
            <div className="flex gap-2 mb-4 p-3 bg-muted/50 rounded-md">
              <Input
                value={newItemValue}
                onChange={(e) => setNewItemValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleAddItem(config.key);
                  } else if (e.key === 'Escape') {
                    setNewItemField(null);
                    setNewItemValue("");
                  }
                }}
                placeholder={`New ${config.label.toLowerCase()} name`}
                autoFocus
                data-testid={`input-new-${config.key}`}
              />
              <Button
                size="sm"
                onClick={() => handleAddItem(config.key)}
                data-testid={`button-save-new-${config.key}`}
              >
                Add
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setNewItemField(null);
                  setNewItemValue("");
                }}
              >
                Cancel
              </Button>
            </div>
          )}
          
          {values.length === 0 && unusedItems.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No {config.label.toLowerCase()} found in records
            </p>
          ) : (
            <div className="space-y-2">
              {values.map(({ value, count }) => (
                <div 
                  key={value} 
                  className="flex items-center justify-between p-3 rounded-md bg-muted/30 hover-elevate"
                  data-testid={`row-${config.key}-${value}`}
                >
                  {editingField === config.key && editingValue === value ? (
                    <div className="flex gap-2 flex-1">
                      <Input
                        value={newValue}
                        onChange={(e) => setNewValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            handleUpdateValue(config.key, value, newValue);
                          } else if (e.key === 'Escape') {
                            setEditingField(null);
                            setEditingValue("");
                            setNewValue("");
                          }
                        }}
                        autoFocus
                        disabled={isUpdating}
                        data-testid={`input-edit-${config.key}-${value}`}
                      />
                      <Button
                        size="sm"
                        onClick={() => handleUpdateValue(config.key, value, newValue)}
                        disabled={isUpdating}
                        data-testid={`button-save-${config.key}-${value}`}
                      >
                        {isUpdating ? <RefreshCw className="h-4 w-4 animate-spin" /> : "Save"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setEditingField(null);
                          setEditingValue("");
                          setNewValue("");
                        }}
                        disabled={isUpdating}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{getDisplayLabel(config.key, value)}</span>
                        {hasEnumOptions(config.key) && (
                          <Badge variant="outline" className="text-xs text-muted-foreground">
                            {value}
                          </Badge>
                        )}
                        <Badge variant="secondary" className="text-xs">
                          {count} record{count !== 1 ? 's' : ''}
                        </Badge>
                      </div>
                      <div className="flex gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => {
                            setEditingField(config.key);
                            setEditingValue(value);
                            setNewValue(value);
                          }}
                          data-testid={`button-edit-${config.key}-${value}`}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => {
                            setDeleteTarget({ field: config.key, value, count });
                            setDeleteDialogOpen(true);
                          }}
                          data-testid={`button-delete-${config.key}-${value}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              ))}

              {unusedItems.length > 0 && (
                <>
                  <div className="pt-2 mt-2 border-t">
                    <p className="text-xs text-muted-foreground mb-2">
                      {hasEnumOptions(config.key) ? 'Available options (not in use):' : 'Unused (not in any records):'}
                    </p>
                    {unusedItems.map((name) => (
                      <div 
                        key={name}
                        className="flex items-center justify-between p-2 rounded-md bg-muted/20"
                        data-testid={`row-unused-${config.key}-${name}`}
                      >
                        {/* Enum fields show as read-only since values are predefined */}
                        {hasEnumOptions(config.key) ? (
                          <span className="text-sm text-muted-foreground">{getDisplayLabel(config.key, name)}</span>
                        ) : editingUnusedField === config.key && editingUnusedValue === name ? (
                          <div className="flex gap-2 flex-1">
                            <Input
                              value={newUnusedValue}
                              onChange={(e) => setNewUnusedValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  handleUpdateUnused(config.key, name, newUnusedValue);
                                } else if (e.key === 'Escape') {
                                  setEditingUnusedField(null);
                                  setEditingUnusedValue("");
                                  setNewUnusedValue("");
                                }
                              }}
                              autoFocus
                              disabled={isUpdating}
                              data-testid={`input-edit-unused-${config.key}-${name}`}
                            />
                            <Button
                              size="sm"
                              onClick={() => handleUpdateUnused(config.key, name, newUnusedValue)}
                              disabled={isUpdating}
                              data-testid={`button-save-unused-${config.key}-${name}`}
                            >
                              {isUpdating ? <RefreshCw className="h-4 w-4 animate-spin" /> : "Save"}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setEditingUnusedField(null);
                                setEditingUnusedValue("");
                                setNewUnusedValue("");
                              }}
                              disabled={isUpdating}
                            >
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <>
                            <span className="text-sm text-muted-foreground">{name}</span>
                            <div className="flex gap-1">
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => {
                                  setEditingUnusedField(config.key);
                                  setEditingUnusedValue(name);
                                  setNewUnusedValue(name);
                                }}
                                data-testid={`button-edit-unused-${config.key}-${name}`}
                              >
                                <Edit className="h-4 w-4" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => handleDeleteUnused(config.key, name)}
                                data-testid={`button-delete-unused-${config.key}-${name}`}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  if (isLoading) {
    return (
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-4xl mx-auto">
          <div className="text-center py-8 text-muted-foreground">
            Loading values...
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold mb-2" data-testid="text-page-title">Value Updater</h1>
          <p className="text-muted-foreground">
            Edit values across all records at once. Changes apply everywhere that value is used.
          </p>
        </div>

        <Tabs value={activeTab} onValueChange={(val) => setActiveTab(val as FieldType)}>
          <TabsList className="flex-wrap h-auto gap-1">
            {FIELD_CONFIGS.map((config) => {
              const Icon = config.icon;
              return (
                <TabsTrigger 
                  key={config.key} 
                  value={config.key}
                  className="gap-1"
                  data-testid={`tab-${config.key}`}
                >
                  <Icon className="h-4 w-4" />
                  <span className="hidden sm:inline">{config.label}</span>
                </TabsTrigger>
              );
            })}
          </TabsList>

          {FIELD_CONFIGS.map((config) => (
            <TabsContent key={config.key} value={config.key} className="mt-4">
              {renderFieldSection(config)}
            </TabsContent>
          ))}
        </Tabs>

        <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove this value?</AlertDialogTitle>
              <AlertDialogDescription>
                This will remove "{deleteTarget?.value}" from {deleteTarget?.count} record{deleteTarget?.count !== 1 ? 's' : ''}.
                {deleteTarget && FIELD_CONFIGS.find(f => f.key === deleteTarget.field)?.hasMasterList 
                  ? ` The ${FIELD_CONFIGS.find(f => f.key === deleteTarget.field)?.label.toLowerCase()} entry will also be deleted from the master list.`
                  : ''
                }
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isUpdating}>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleDeleteValue} disabled={isUpdating}>
                {isUpdating ? "Removing..." : "Remove"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}

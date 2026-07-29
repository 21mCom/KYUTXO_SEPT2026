import { useState, useRef, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { X, Upload, File as FileIcon, Loader2, Plus, Check, ChevronsUpDown, AlertTriangle, Download, ArrowDownLeft, ArrowUpRight, Info, ExternalLink, ShieldCheck, Wallet, Layers } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import type { 
  AddressImportance, 
  FlowType, 
  AcquisitionMethod, 
  DispositionType, 
  CounterpartyType 
} from "@/lib/database";
import { 
  FLOW_TYPE_OPTIONS, 
  ACQUISITION_METHOD_OPTIONS, 
  DISPOSITION_TYPE_OPTIONS, 
  COUNTERPARTY_TYPE_OPTIONS 
} from "@/lib/database";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { formatFileSize } from "@/lib/attachments";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import { AttachmentList } from "./AttachmentList";
import type { Attachment } from "@/lib/database";
import { createProviderFromSettings, parseTransaction, type ParsedTransaction, MINIMUM_CONFIRMATIONS } from "@/lib/blockchain-api";
import { ConfirmationStatusUnknownError } from "@/lib/providers/electrum";
import { useNodeSettings } from "@/hooks/use-node-settings";
import { useToast } from "@/hooks/use-toast";
import { SEED_NAME_MAX_LENGTH } from "@/hooks/use-seed-names";

interface ExistingRecord {
  id?: number;
  type: string;
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
  customFields?: { [slug: string]: string };
  addressImportance?: AddressImportance;
}

interface CustomFieldDef {
  id?: number;
  name: string;
  slug: string;
  enabled: boolean;
}

export interface TransactionAddresses {
  inputs: Array<{ address: string; amount: number }>;
  outputs: Array<{ address: string; amount: number; vout: number }>;
  txid: string;
  blockHeight: number;
  blockTime: number;
  fee: number;
  feeRate: number;
}

interface RecordFormDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: any, files: File[], transactionAddresses?: TransactionAddresses) => Promise<void>;
  initialData?: any;
  isSubmitting?: boolean;
  uploadProgress?: { current: number; total: number } | null;
  availableSeedNames?: string[];
  availableWalletSoftware?: string[];
  availableOwners?: string[];
  availableWalletNames?: string[];
  availableTags?: string[];
  availableCategories?: string[];
  enabledCustomFields?: CustomFieldDef[];
  onCheckDuplicate?: (inputString: string) => Promise<ExistingRecord | undefined>;
  existingAttachments?: Attachment[];
  onAttachmentDeleted?: () => void;
  // When set, the dialog scrolls to the named section after it opens.
  scrollToSection?: "acquisition";
}

export function RecordFormDialog({ 
  open, 
  onClose, 
  onSave, 
  initialData,
  isSubmitting = false,
  uploadProgress = null,
  availableSeedNames = [],
  availableWalletSoftware = [],
  availableOwners = [],
  availableWalletNames = [],
  availableTags = [],
  availableCategories = [],
  enabledCustomFields = [],
  onCheckDuplicate,
  existingAttachments = [],
  onAttachmentDeleted,
  scrollToSection,
}: RecordFormDialogProps) {
  const getDefaultFormData = () => ({
    inputString: "",
    label: "",
    type: "address",
    notes: "",
    tags: [] as string[],
    categories: [] as string[],
    seedName: "",
    walletSoftware: "",
    owner: "",
    walletName: "",
    privateKeyStatus: "",
    customFields: {} as { [slug: string]: string },
    addressImportance: undefined as AddressImportance | undefined,
    markAsVerified: false,
    // Transaction-specific metadata
    flowType: undefined as FlowType | undefined,
    acquisitionMethod: undefined as AcquisitionMethod | undefined,
    dispositionType: undefined as DispositionType | undefined,
    costBasisUsd: undefined as number | undefined,
    // Address-specific metadata
    counterpartyType: undefined as CounterpartyType | undefined,
    counterpartyName: "",
  });

  const { toast } = useToast();
  const { nodeSettings } = useNodeSettings();
  const [formData, setFormData] = useState(initialData || getDefaultFormData());
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [ownerInput, setOwnerInput] = useState("");
  const [walletNameInput, setWalletNameInput] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [seedOpen, setSeedOpen] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [walletNameOpen, setWalletNameOpen] = useState(false);
  const [newSeedName, setNewSeedName] = useState("");
  const [newWalletSoftware, setNewWalletSoftware] = useState("");
  const [newOwner, setNewOwner] = useState("");
  const [newWalletName, setNewWalletName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const acquisitionSectionRef = useRef<HTMLDivElement>(null);
  
  // Duplicate detection state
  const [duplicateRecord, setDuplicateRecord] = useState<ExistingRecord | undefined>();
  const [isCheckingDuplicate, setIsCheckingDuplicate] = useState(false);
  const duplicateCheckTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Transaction lookup state
  const [isFetchingTx, setIsFetchingTx] = useState(false);
  const [txFetchError, setTxFetchError] = useState<string | null>(null);
  const [fetchedTxData, setFetchedTxData] = useState<ParsedTransaction | null>(null);

  // Multisig vault state
  const [isVault, setIsVault] = useState(false);
  const [vaultName, setVaultName] = useState('');
  const [vaultM, setVaultM] = useState<number | null>(null);
  const [vaultN, setVaultN] = useState<number | null>(null);
  const [vaultNotes, setVaultNotes] = useState('');

  // Reset form data when dialog opens or initialData changes
  useEffect(() => {
    if (open) {
      const data = initialData || getDefaultFormData();
      setFormData(data);
      setSelectedFiles([]);
      setSelectedTags(data.tags || []);
      setSelectedCategories(data.categories || []);
      setOwnerInput(data.owner || "");
      setWalletNameInput(data.walletName || "");
      setNewSeedName("");
      setNewWalletSoftware("");
      setNewOwner("");
      setNewWalletName("");
      setDuplicateRecord(undefined);
      setIsCheckingDuplicate(false);
      setFetchedTxData(null);
      setTxFetchError(null);
      // Initialize vault state from initialData
      setIsVault(data.vault?.isVaultXpub || false);
      setVaultName(data.vault?.vaultName || '');
      setVaultM(data.vault?.m || null);
      setVaultN(data.vault?.n || null);
      setVaultNotes(data.vault?.vaultNotes || '');
    }
  }, [open, initialData]);

  // Scroll to a requested section once the dialog has opened and rendered.
  useEffect(() => {
    if (open && scrollToSection === "acquisition") {
      const t = setTimeout(() => {
        acquisitionSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 150);
      return () => clearTimeout(t);
    }
  }, [open, scrollToSection, formData.type]);

  // Check for duplicate when inputString changes (debounced)
  const checkForDuplicate = useCallback(async (inputString: string) => {
    if (!onCheckDuplicate || !inputString.trim() || initialData) {
      setDuplicateRecord(undefined);
      return;
    }
    
    setIsCheckingDuplicate(true);
    try {
      const existing = await onCheckDuplicate(inputString.trim());
      setDuplicateRecord(existing);
      
      // If duplicate found, auto-populate the form
      if (existing) {
        setFormData({
          ...existing,
          type: existing.type,
        });
        setSelectedTags(existing.tags || []);
        setSelectedCategories(existing.categories || []);
        setOwnerInput(existing.owner || "");
        setWalletNameInput(existing.walletName || "");
      }
    } catch (error) {
      console.error("Error checking for duplicate:", error);
    } finally {
      setIsCheckingDuplicate(false);
    }
  }, [onCheckDuplicate, initialData]);

  // Debounced duplicate check on inputString change
  const handleInputStringChange = useCallback((value: string) => {
    setFormData((prev: any) => ({ ...prev, inputString: value }));
    // Clear fetched tx data when input changes
    setFetchedTxData(null);
    setTxFetchError(null);
    
    // Clear previous timeout
    if (duplicateCheckTimeoutRef.current) {
      clearTimeout(duplicateCheckTimeoutRef.current);
    }
    
    // Don't check for duplicates when editing an existing record
    if (initialData) return;
    
    // Debounce the duplicate check
    duplicateCheckTimeoutRef.current = setTimeout(() => {
      checkForDuplicate(value);
    }, 500);
  }, [checkForDuplicate, initialData]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (duplicateCheckTimeoutRef.current) {
        clearTimeout(duplicateCheckTimeoutRef.current);
      }
    };
  }, []);

  // Fetch transaction data from blockchain
  const handleFetchTransaction = async () => {
    const txid = formData.inputString.trim();
    if (!txid) return;

    setIsFetchingTx(true);
    setTxFetchError(null);
    setFetchedTxData(null);

    try {
      const provider = createProviderFromSettings(nodeSettings);
      const currentHeight = await provider.getBlockHeight();
      const rawTx = await provider.getTransaction(txid);
      
      if (!rawTx) {
        setTxFetchError("Transaction not found. Please check the transaction ID.");
        return;
      }

      if (!rawTx.status.confirmed) {
        setTxFetchError("Transaction is unconfirmed. Only confirmed transactions can be imported.");
        return;
      }

      // A tx in the tip block has 1 confirmation, hence the +1.
      const confirmations = currentHeight - (rawTx.status.block_height || 0) + 1;
      if (confirmations < MINIMUM_CONFIRMATIONS) {
        setTxFetchError(`Transaction has only ${confirmations} confirmations. Minimum ${MINIMUM_CONFIRMATIONS} required.`);
        return;
      }

      const parsed = parseTransaction(rawTx);
      if (!parsed) {
        setTxFetchError("Could not parse transaction data. The transaction may use non-standard scripts.");
        return;
      }

      // Check if we found any addresses
      if (parsed.inputs.length === 0 && parsed.outputs.length === 0) {
        setTxFetchError("No standard addresses found in this transaction. It may use non-standard scripts (e.g., coinbase or P2PK).");
        return;
      }

      setFetchedTxData(parsed);
      
      // Auto-fill label if empty
      if (!formData.label) {
        const date = new Date(parsed.blockTime * 1000);
        const dateStr = date.toLocaleDateString();
        setFormData((prev: any) => ({
          ...prev,
          label: `Transaction ${dateStr}`,
        }));
      }
    } catch (error) {
      if (error instanceof ConfirmationStatusUnknownError) {
        // The provider could not tell whether the transaction is confirmed
        // (server/tip failure or unsupported verbose response). This is NOT
        // the same as "unconfirmed" — surface an accurate connection error.
        setTxFetchError(error.message);
      } else {
        setTxFetchError(error instanceof Error ? error.message : "Failed to fetch transaction");
      }
    } finally {
      setIsFetchingTx(false);
    }
  };

  const formatSats = (sats: number) => {
    if (sats >= 100000000) {
      return `${(sats / 100000000).toFixed(8)} BTC`;
    }
    return `${sats.toLocaleString()} sats`;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Validate vault quorum if vault is enabled
    if (isVault && vaultM && vaultN && vaultM > vaultN) {
      toast({
        variant: "destructive",
        title: "Invalid vault configuration",
        description: "Required signatures (M) cannot exceed total keys (N)",
      });
      return;
    }

    // Get selected tags and categories from combobox state
    const parsedTags = selectedTags;
    const parsedCategories = selectedCategories;
    
    // Filter out empty custom field values
    const filteredCustomFields: { [slug: string]: string } = {};
    if (formData.customFields) {
      for (const [slug, value] of Object.entries(formData.customFields)) {
        if (value && typeof value === 'string' && value.trim()) {
          filteredCustomFields[slug] = value.trim();
        }
      }
    }
    
    // Prepare transaction addresses if we fetched tx data
    const transactionAddresses: TransactionAddresses | undefined = fetchedTxData ? {
      inputs: fetchedTxData.inputs,
      outputs: fetchedTxData.outputs,
      txid: fetchedTxData.txid,
      blockHeight: fetchedTxData.blockHeight,
      blockTime: fetchedTxData.blockTime,
      fee: fetchedTxData.fee,
      feeRate: fetchedTxData.feeRate,
    } : undefined;
    
    // Build vault metadata if enabled
    const vaultData = isVault ? {
      isVaultXpub: true,
      vaultName: vaultName || null,
      m: vaultM,
      n: vaultN,
      vaultNotes: vaultNotes || null,
    } : undefined;

    await onSave({
      ...formData,
      tags: parsedTags,
      categories: parsedCategories,
      owner: ownerInput,
      walletName: walletNameInput,
      source: formData.source || 'manual',
      customFields: Object.keys(filteredCustomFields).length > 0 ? filteredCustomFields : undefined,
      vault: vaultData,
    }, selectedFiles, transactionAddresses);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    setSelectedFiles(prev => [...prev, ...files]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const removeFile = (index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleClose = () => {
    if (!isSubmitting) {
      onClose();
    }
  };

  const addNewSeedName = () => {
    if (!newSeedName.trim()) return;
    if (newSeedName.trim().length > SEED_NAME_MAX_LENGTH) {
      toast({
        variant: "destructive",
        title: "Seed name too long",
        description: `Seed names are limited to ${SEED_NAME_MAX_LENGTH} characters to prevent accidental seed phrase entry`,
      });
      return;
    }
    setFormData({ ...formData, seedName: newSeedName.trim() });
    setNewSeedName("");
    setSeedOpen(false);
  };

  const addNewWalletSoftware = () => {
    if (newWalletSoftware.trim()) {
      setFormData({ ...formData, walletSoftware: newWalletSoftware.trim() });
      setNewWalletSoftware("");
      setWalletOpen(false);
    }
  };

  const addNewOwner = () => {
    if (newOwner.trim()) {
      setOwnerInput(newOwner.trim());
      setNewOwner("");
      setOwnerOpen(false);
    }
  };

  const addNewWalletName = () => {
    if (newWalletName.trim()) {
      setWalletNameInput(newWalletName.trim());
      setNewWalletName("");
      setWalletNameOpen(false);
    }
  };

  // Combine available values with any new value that's been set
  const allSeedNames = Array.from(new Set([...availableSeedNames, formData.seedName].filter(Boolean)));
  const allWalletSoftware = Array.from(new Set([...availableWalletSoftware, formData.walletSoftware].filter(Boolean)));
  const allOwners = Array.from(new Set([...availableOwners, ownerInput].filter(Boolean)));
  const allWalletNames = Array.from(new Set([...availableWalletNames, walletNameInput].filter(Boolean)));

  const getInputLabel = () => {
    switch (formData.type) {
      case "address": return "Bitcoin Address";
      case "transaction": return "Transaction ID";
      case "other": return "Identifier";
      default: return "Input";
    }
  };

  const getInputPlaceholder = () => {
    switch (formData.type) {
      case "address": return "bc1q...";
      case "transaction": return "Transaction hash (64 hex characters)";
      case "other": return "Any coin address or identifier";
      default: return "";
    }
  };

  // Check if txid looks valid (64 hex characters)
  const isValidTxidFormat = (txid: string) => {
    return /^[a-fA-F0-9]{64}$/.test(txid.trim());
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{initialData ? "Edit Record" : "Create New Record"}</DialogTitle>
          <DialogDescription>
            {initialData ? "Update record details below." : "Fill in the details to create a new record."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="type">Type</Label>
              <Select
                value={formData.type}
                onValueChange={(value) => {
                  setFormData({ ...formData, type: value });
                  setFetchedTxData(null);
                  setTxFetchError(null);
                }}
                disabled={isSubmitting}
              >
                <SelectTrigger id="type" data-testid="select-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="address">Bitcoin Address</SelectItem>
                  <SelectItem value="transaction">Transaction</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="label">Label *</Label>
              <Input
                id="label"
                value={formData.label}
                onChange={(e) => setFormData({ ...formData, label: e.target.value })}
                placeholder="My Wallet"
                required
                disabled={isSubmitting}
                data-testid="input-label"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="inputString">
              {getInputLabel()} *
            </Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  id="inputString"
                  value={formData.inputString}
                  onChange={(e) => handleInputStringChange(e.target.value)}
                  placeholder={getInputPlaceholder()}
                  required
                  disabled={isSubmitting}
                  className="font-mono"
                  data-testid="input-address"
                />
                {isCheckingDuplicate && (
                  <Loader2 className="absolute right-3 top-1/2 transform -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
                )}
              </div>
              {formData.type === "transaction" && !initialData && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleFetchTransaction}
                  disabled={isSubmitting || isFetchingTx || !isValidTxidFormat(formData.inputString)}
                  data-testid="button-fetch-tx"
                >
                  {isFetchingTx ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      <Download className="h-4 w-4 mr-2" />
                      Fetch Data
                    </>
                  )}
                </Button>
              )}
            </div>
            
            {duplicateRecord && !initialData && (
              <Alert className="mt-2">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  <span className="font-medium">This record already exists.</span>
                  <span className="block text-sm mt-1">
                    The form has been filled with the existing data for "{duplicateRecord.label}". 
                    You can modify the fields and save to update the existing record.
                  </span>
                </AlertDescription>
              </Alert>
            )}

            {txFetchError && (
              <Alert variant="destructive" className="mt-2">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>{txFetchError}</AlertDescription>
              </Alert>
            )}
          </div>

          {/* Transaction Preview Section */}
          {fetchedTxData && formData.type === "transaction" && (
            <Card className="border-primary/20 bg-primary/5">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Check className="h-4 w-4 text-green-600" />
                  Transaction Data Fetched
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-3 gap-2 text-sm">
                  <div>
                    <p className="text-muted-foreground">Block</p>
                    <p className="font-medium">{fetchedTxData.blockHeight.toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Date</p>
                    <p className="font-medium">
                      {new Date(fetchedTxData.blockTime * 1000).toLocaleDateString()}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Fee</p>
                    <p className="font-medium">{formatSats(fetchedTxData.fee)}</p>
                  </div>
                </div>

                <Alert>
                  <Info className="h-4 w-4" />
                  <AlertTitle className="text-sm">Address records will be created</AlertTitle>
                  <AlertDescription className="text-xs mt-1">
                    When you save, {fetchedTxData.inputs.length} input and {fetchedTxData.outputs.length} output address records will be created automatically with "Pending Review" owner.
                  </AlertDescription>
                </Alert>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <div className="flex items-center gap-1 text-sm font-medium mb-2">
                      <ArrowDownLeft className="h-4 w-4 text-red-500" />
                      Inputs ({fetchedTxData.inputs.length})
                    </div>
                    <ScrollArea className="h-32 border rounded-md p-2">
                      <div className="space-y-1">
                        {fetchedTxData.inputs.map((input, i) => (
                          <div key={i} className="text-xs">
                            <p className="font-mono truncate" title={input.address}>
                              {input.address.substring(0, 8)}...{input.address.substring(input.address.length - 6)}
                            </p>
                            <p className="text-muted-foreground">{formatSats(input.amount)}</p>
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  </div>
                  <div>
                    <div className="flex items-center gap-1 text-sm font-medium mb-2">
                      <ArrowUpRight className="h-4 w-4 text-green-500" />
                      Outputs ({fetchedTxData.outputs.length})
                    </div>
                    <ScrollArea className="h-32 border rounded-md p-2">
                      <div className="space-y-1">
                        {fetchedTxData.outputs.map((output, i) => (
                          <div key={i} className="text-xs">
                            <p className="font-mono truncate" title={output.address}>
                              {output.address.substring(0, 8)}...{output.address.substring(output.address.length - 6)}
                            </p>
                            <p className="text-muted-foreground">{formatSats(output.amount)}</p>
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  </div>
                </div>

                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => window.open(`https://mempool.space/tx/${fetchedTxData.txid}`, '_blank')}
                  >
                    <ExternalLink className="h-3 w-3 mr-1" />
                    View on mempool.space
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          <div className="space-y-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              value={formData.notes}
              onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
              placeholder="Additional details..."
              rows={3}
              disabled={isSubmitting}
              data-testid="input-notes"
            />
          </div>

          {/* Transaction Metadata Section */}
          {formData.type === "transaction" && (
            <div className="space-y-3 p-4 bg-muted/30 rounded-lg border">
              <h5 className="font-medium text-sm flex items-center gap-2">
                <ArrowUpRight className="h-4 w-4" />
                Transaction Details
              </h5>
              
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Flow Type</Label>
                  <Select
                    value={formData.flowType || ""}
                    onValueChange={(value) => {
                      setFormData({ 
                        ...formData, 
                        flowType: value as FlowType,
                        // Clear both conditional fields when flow type changes
                        // Only the relevant one will be shown based on new flow type
                        acquisitionMethod: undefined,
                        dispositionType: undefined,
                      });
                    }}
                    disabled={isSubmitting}
                  >
                    <SelectTrigger data-testid="select-flow-type">
                      <SelectValue placeholder="Select flow type..." />
                    </SelectTrigger>
                    <SelectContent>
                      {FLOW_TYPE_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {formData.flowType === 'received' && (
                  <div className="space-y-2">
                    <Label>Acquisition Method</Label>
                    <Select
                      value={formData.acquisitionMethod || ""}
                      onValueChange={(value) => setFormData({ ...formData, acquisitionMethod: value as AcquisitionMethod })}
                      disabled={isSubmitting}
                    >
                      <SelectTrigger data-testid="select-acquisition-method">
                        <SelectValue placeholder="How did you acquire this?" />
                      </SelectTrigger>
                      <SelectContent>
                        {ACQUISITION_METHOD_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {formData.flowType === 'sent' && (
                  <div className="space-y-2">
                    <Label>Disposition Type</Label>
                    <Select
                      value={formData.dispositionType || ""}
                      onValueChange={(value) => setFormData({ ...formData, dispositionType: value as DispositionType })}
                      disabled={isSubmitting}
                    >
                      <SelectTrigger data-testid="select-disposition-type">
                        <SelectValue placeholder="Why was this sent?" />
                      </SelectTrigger>
                      <SelectContent>
                        {DISPOSITION_TYPE_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>

              {(formData.flowType === 'received' || formData.flowType === 'sent') && (
                <div className="space-y-2">
                  <Label htmlFor="costBasisUsd">
                    {formData.flowType === 'received' ? 'Cost Basis (USD)' : 'Disposal Value (USD)'}
                  </Label>
                  <Input
                    id="costBasisUsd"
                    type="number"
                    step="0.01"
                    min="0"
                    value={formData.costBasisUsd || ""}
                    onChange={(e) => setFormData({ 
                      ...formData, 
                      costBasisUsd: e.target.value ? parseFloat(e.target.value) : undefined 
                    })}
                    placeholder={formData.flowType === 'received' ? "What you paid in USD" : "Value received in USD"}
                    disabled={isSubmitting}
                    data-testid="input-cost-basis"
                  />
                  <p className="text-xs text-muted-foreground">
                    Optional. If left blank, historical market price data will be used. Consider attaching a receipt or screenshot as proof.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Address Acquisition & Provenance Section */}
          {formData.type === "address" && (
            <div
              ref={acquisitionSectionRef}
              className="space-y-3 p-4 bg-muted/30 rounded-lg border scroll-mt-4"
              data-testid="section-acquisition"
            >
              <h5 className="font-medium text-sm flex items-center gap-2">
                <ArrowDownLeft className="h-4 w-4" />
                Acquisition &amp; Provenance
              </h5>
              <p className="text-xs text-muted-foreground">
                Record how this address acquired its Bitcoin. These details power the
                Acquisition &amp; Provenance appendix in the Proof of Funds declaration.
              </p>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="acquisitionDate">Acquisition Date</Label>
                  <Input
                    id="acquisitionDate"
                    type="date"
                    value={formData.date || ""}
                    onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                    disabled={isSubmitting}
                    data-testid="input-acquisition-date"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Acquisition Method</Label>
                  <Select
                    value={formData.acquisitionMethod || ""}
                    onValueChange={(value) => setFormData({ ...formData, acquisitionMethod: value as AcquisitionMethod })}
                    disabled={isSubmitting}
                  >
                    <SelectTrigger data-testid="select-address-acquisition-method">
                      <SelectValue placeholder="How was this acquired?" />
                    </SelectTrigger>
                    <SelectContent>
                      {ACQUISITION_METHOD_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Counterparty Type</Label>
                <Select
                  value={formData.counterpartyType || ""}
                  onValueChange={(value) => setFormData({ ...formData, counterpartyType: value as CounterpartyType })}
                  disabled={isSubmitting}
                >
                  <SelectTrigger data-testid="select-counterparty-type">
                    <SelectValue placeholder="What type of entity is this?" />
                  </SelectTrigger>
                  <SelectContent>
                    {COUNTERPARTY_TYPE_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Classify the source/counterparty: exchange, individual, business, etc.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="counterpartyName">Counterparty Name</Label>
                <Input
                  id="counterpartyName"
                  value={formData.counterpartyName || ""}
                  onChange={(e) => setFormData({ ...formData, counterpartyName: e.target.value })}
                  placeholder="e.g. Coinbase, Kraken, John Smith"
                  disabled={isSubmitting}
                  data-testid="input-counterparty-name"
                />
                <p className="text-xs text-muted-foreground">
                  Optional. The explicit source/counterparty name shown in the appendix.
                  If left blank, the Wallet Name, Label, or Counterparty Type is used instead.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="addressCostBasisUsd">Cost Basis (USD)</Label>
                <Input
                  id="addressCostBasisUsd"
                  type="number"
                  step="0.01"
                  min="0"
                  value={formData.costBasisUsd ?? ""}
                  onChange={(e) => setFormData({
                    ...formData,
                    costBasisUsd: e.target.value ? parseFloat(e.target.value) : undefined,
                  })}
                  placeholder="What you paid in USD"
                  disabled={isSubmitting}
                  data-testid="input-address-cost-basis"
                />
                <p className="text-xs text-muted-foreground">
                  Optional. If left blank, historical market price data is used for the appendix.
                </p>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label>Tags</Label>
            <MultiSelectCombobox
              values={selectedTags}
              onChange={setSelectedTags}
              options={availableTags}
              onAddNew={(value) => setSelectedTags([...selectedTags, value])}
              placeholder="Select tags..."
              searchPlaceholder="Search or add new tag..."
              disabled={isSubmitting}
              testId="select-tags"
            />
          </div>

          <div className="space-y-2">
            <Label>Categories</Label>
            <MultiSelectCombobox
              values={selectedCategories}
              onChange={setSelectedCategories}
              options={availableCategories}
              onAddNew={(value) => setSelectedCategories([...selectedCategories, value])}
              placeholder="Select categories..."
              searchPlaceholder="Search or add new category..."
              disabled={isSubmitting}
              testId="select-categories"
            />
          </div>

          {/* Ownership Section */}
          <div className="space-y-3 p-4 bg-muted/30 rounded-lg border">
            <h5 className="font-medium text-sm flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" />
              Ownership
            </h5>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Owner</Label>
                <Popover open={ownerOpen} onOpenChange={setOwnerOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={ownerOpen}
                      className="w-full justify-between font-normal"
                      disabled={isSubmitting}
                      data-testid="select-owner"
                    >
                      {ownerInput || "Select or add..."}
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-full p-0" align="start">
                    <Command>
                      <CommandInput 
                        placeholder="Search or add new..." 
                        value={newOwner}
                        onValueChange={setNewOwner}
                      />
                      <CommandList>
                        <CommandEmpty>
                          {newOwner && (
                            <Button
                              variant="ghost"
                              className="w-full justify-start"
                              onClick={addNewOwner}
                            >
                              <Plus className="mr-2 h-4 w-4" />
                              Add "{newOwner}"
                            </Button>
                          )}
                        </CommandEmpty>
                        <CommandGroup>
                          {allOwners.map((name) => (
                            <CommandItem
                              key={name}
                              value={name}
                              onSelect={() => {
                                setOwnerInput(name);
                                setOwnerOpen(false);
                              }}
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4",
                                  ownerInput === name ? "opacity-100" : "opacity-0"
                                )}
                              />
                              {name}
                            </CommandItem>
                          ))}
                          {newOwner && !allOwners.some(n => n.toLowerCase() === newOwner.toLowerCase()) && (
                            <CommandItem
                              value={`create-${newOwner}`}
                              onSelect={addNewOwner}
                            >
                              <Plus className="mr-2 h-4 w-4" />
                              Add "{newOwner}"
                            </CommandItem>
                          )}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>

              {/* Ownership Confirmed Toggle - next to Owner */}
              <div className="space-y-2">
                <Label htmlFor="markAsVerified" className="flex items-center gap-2">
                  Ownership Confirmed
                </Label>
                <div className="flex items-center gap-3 h-9">
                  <Switch
                    id="markAsVerified"
                    checked={formData.markAsVerified || formData.addressImportance === 'verified'}
                    onCheckedChange={(checked) => setFormData({ 
                      ...formData, 
                      markAsVerified: checked,
                      addressImportance: checked ? 'verified' : (initialData?.addressImportance || undefined)
                    })}
                    disabled={isSubmitting}
                    data-testid="switch-verified"
                  />
                  <span className="text-sm text-muted-foreground">
                    {formData.markAsVerified || formData.addressImportance === 'verified' 
                      ? "Ownership confirmed" 
                      : "Not verified"}
                  </span>
                </div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Turn on if you are certain about who owns this address. This confirms attribution certainty, not private key possession.
            </p>
          </div>

          {/* Wallet Details Section */}
          <div className="space-y-3 p-4 bg-muted/30 rounded-lg border">
            <h5 className="font-medium text-sm flex items-center gap-2">
              <Wallet className="h-4 w-4" />
              Wallet Details
            </h5>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Seed Name</Label>
                <Popover open={seedOpen} onOpenChange={setSeedOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={seedOpen}
                      className="w-full justify-between font-normal"
                      disabled={isSubmitting}
                      data-testid="select-seed"
                    >
                      {formData.seedName || "Select or add..."}
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-full p-0" align="start">
                    <Command>
                      <CommandInput 
                        placeholder="Search or add new..." 
                        value={newSeedName}
                        onValueChange={(val) => setNewSeedName(val.slice(0, SEED_NAME_MAX_LENGTH))}
                      />
                      <CommandList>
                        <CommandEmpty>
                          {newSeedName && (
                            <Button
                              variant="ghost"
                              className="w-full justify-start"
                              onClick={addNewSeedName}
                            >
                              <Plus className="mr-2 h-4 w-4" />
                              Add "{newSeedName}"
                            </Button>
                          )}
                        </CommandEmpty>
                        <CommandGroup>
                          {allSeedNames.map((name) => (
                            <CommandItem
                              key={name}
                              value={name}
                              onSelect={() => {
                                setFormData({ ...formData, seedName: name });
                                setSeedOpen(false);
                              }}
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4",
                                  formData.seedName === name ? "opacity-100" : "opacity-0"
                                )}
                              />
                              {name}
                            </CommandItem>
                          ))}
                          {newSeedName && !allSeedNames.some(n => n.toLowerCase() === newSeedName.toLowerCase()) && (
                            <CommandItem
                              value={`create-${newSeedName}`}
                              onSelect={addNewSeedName}
                            >
                              <Plus className="mr-2 h-4 w-4" />
                              Add "{newSeedName}"
                            </CommandItem>
                          )}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>

              <div className="space-y-2">
                <Label>Wallet Software</Label>
                <Popover open={walletOpen} onOpenChange={setWalletOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={walletOpen}
                      className="w-full justify-between font-normal"
                      disabled={isSubmitting}
                      data-testid="select-wallet"
                    >
                      {formData.walletSoftware || "Select or add..."}
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-full p-0" align="start">
                    <Command>
                      <CommandInput 
                        placeholder="Search or add new..." 
                        value={newWalletSoftware}
                        onValueChange={setNewWalletSoftware}
                      />
                      <CommandList>
                        <CommandEmpty>
                          {newWalletSoftware && (
                            <Button
                              variant="ghost"
                              className="w-full justify-start"
                              onClick={addNewWalletSoftware}
                            >
                              <Plus className="mr-2 h-4 w-4" />
                              Add "{newWalletSoftware}"
                            </Button>
                          )}
                        </CommandEmpty>
                        <CommandGroup>
                          {allWalletSoftware.map((name) => (
                            <CommandItem
                              key={name}
                              value={name}
                              onSelect={() => {
                                setFormData({ ...formData, walletSoftware: name });
                                setWalletOpen(false);
                              }}
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4",
                                  formData.walletSoftware === name ? "opacity-100" : "opacity-0"
                                )}
                              />
                              {name}
                            </CommandItem>
                          ))}
                          {newWalletSoftware && !allWalletSoftware.some(n => n.toLowerCase() === newWalletSoftware.toLowerCase()) && (
                            <CommandItem
                              value={`create-${newWalletSoftware}`}
                              onSelect={addNewWalletSoftware}
                            >
                              <Plus className="mr-2 h-4 w-4" />
                              Add "{newWalletSoftware}"
                            </CommandItem>
                          )}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>

              <div className="space-y-2">
                <Label>Wallet Name</Label>
                <Popover open={walletNameOpen} onOpenChange={setWalletNameOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={walletNameOpen}
                      className="w-full justify-between font-normal"
                      disabled={isSubmitting}
                      data-testid="select-wallet-name"
                    >
                      {walletNameInput || "Select or add..."}
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-full p-0" align="start">
                    <Command>
                      <CommandInput 
                        placeholder="Search or add new..." 
                        value={newWalletName}
                        onValueChange={setNewWalletName}
                      />
                      <CommandList>
                        <CommandEmpty>
                          {newWalletName && (
                            <Button
                              variant="ghost"
                              className="w-full justify-start"
                              onClick={addNewWalletName}
                            >
                              <Plus className="mr-2 h-4 w-4" />
                              Add "{newWalletName}"
                            </Button>
                          )}
                        </CommandEmpty>
                        <CommandGroup>
                          {allWalletNames.map((name) => (
                            <CommandItem
                              key={name}
                              value={name}
                              onSelect={() => {
                                setWalletNameInput(name);
                                setWalletNameOpen(false);
                              }}
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4",
                                  walletNameInput === name ? "opacity-100" : "opacity-0"
                                )}
                              />
                              {name}
                            </CommandItem>
                          ))}
                          {newWalletName && !allWalletNames.some(n => n.toLowerCase() === newWalletName.toLowerCase()) && (
                            <CommandItem
                              value={`create-${newWalletName}`}
                              onSelect={addNewWalletName}
                            >
                              <Plus className="mr-2 h-4 w-4" />
                              Add "{newWalletName}"
                            </CommandItem>
                          )}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>

              <div className="space-y-2">
                <Label htmlFor="privateKeyStatus">Private Key Available</Label>
                <Select
                  value={formData.privateKeyStatus || ""}
                  onValueChange={(value) => setFormData({ ...formData, privateKeyStatus: value })}
                  disabled={isSubmitting}
                >
                  <SelectTrigger id="privateKeyStatus" data-testid="select-private-key">
                    <SelectValue placeholder="Select status..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="yes">Yes - I have the keys</SelectItem>
                    <SelectItem value="no">No - Third party controls</SelectItem>
                    <SelectItem value="unsure">Unsure</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Do you have the private keys to spend from this address?
            </p>
          </div>

          {/* Multisig Vault Section */}
          <div className="space-y-3 p-4 bg-muted/30 rounded-lg border">
            <div className="flex items-center justify-between">
              <h5 className="font-medium text-sm flex items-center gap-2">
                <Layers className="h-4 w-4" />
                Multisig Vault (Optional)
              </h5>
              <Switch
                id="is-vault"
                checked={isVault}
                onCheckedChange={setIsVault}
                disabled={isSubmitting}
                data-testid="switch-is-vault"
              />
            </div>
            {isVault && (
              <div className="space-y-4 mt-3">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="vault-name">Vault Name (optional)</Label>
                    <Input
                      id="vault-name"
                      value={vaultName}
                      onChange={(e) => setVaultName(e.target.value)}
                      placeholder="e.g., Family Cold Vault"
                      disabled={isSubmitting}
                      data-testid="input-vault-name"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>M-of-N Signature Requirement</Label>
                    <div className="flex items-center gap-2">
                      <Select
                        value={vaultM?.toString() || ""}
                        onValueChange={(value) => setVaultM(value ? parseInt(value) : null)}
                        disabled={isSubmitting}
                      >
                        <SelectTrigger className="w-20" data-testid="select-vault-m">
                          <SelectValue placeholder="M" />
                        </SelectTrigger>
                        <SelectContent>
                          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((num) => (
                            <SelectItem key={num} value={num.toString()}>{num}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <span className="text-muted-foreground">of</span>
                      <Select
                        value={vaultN?.toString() || ""}
                        onValueChange={(value) => setVaultN(value ? parseInt(value) : null)}
                        disabled={isSubmitting}
                      >
                        <SelectTrigger className="w-20" data-testid="select-vault-n">
                          <SelectValue placeholder="N" />
                        </SelectTrigger>
                        <SelectContent>
                          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((num) => (
                            <SelectItem key={num} value={num.toString()}>{num}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {vaultM && vaultN && vaultM > vaultN && (
                      <p className="text-xs text-destructive">Required signatures (M) cannot exceed total keys (N)</p>
                    )}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="vault-notes">Vault Notes (optional)</Label>
                  <Input
                    id="vault-notes"
                    value={vaultNotes}
                    onChange={(e) => setVaultNotes(e.target.value)}
                    placeholder="e.g., Cosigners: Alice, Bob, Carol"
                    disabled={isSubmitting}
                    data-testid="input-vault-notes"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Custom Fields Section */}
          {enabledCustomFields.length > 0 && (
            <div className="space-y-4 pt-2 border-t">
              <Label className="text-sm font-medium text-muted-foreground">Custom Fields</Label>
              <div className="grid grid-cols-2 gap-4">
                {enabledCustomFields.map((field) => (
                  <div key={field.slug} className="space-y-2">
                    <Label htmlFor={`custom-${field.slug}`}>{field.name}</Label>
                    <Input
                      id={`custom-${field.slug}`}
                      value={formData.customFields?.[field.slug] || ""}
                      onChange={(e) => setFormData({
                        ...formData,
                        customFields: {
                          ...formData.customFields,
                          [field.slug]: e.target.value,
                        },
                      })}
                      disabled={isSubmitting}
                      data-testid={`input-custom-${field.slug}`}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label>Attachments {existingAttachments.length > 0 && `(${existingAttachments.length} existing)`}</Label>
            
            {existingAttachments.length > 0 && (
              <div className="mb-3">
                <AttachmentList 
                  attachments={existingAttachments} 
                  onDelete={onAttachmentDeleted}
                />
              </div>
            )}

            <Label className="text-sm text-muted-foreground">Add new files</Label>
            <input
              type="file"
              multiple
              ref={fileInputRef}
              onChange={handleFileSelect}
              className="hidden"
              id="file-select"
              disabled={isSubmitting}
              data-testid="input-file-select"
            />
            <label
              htmlFor="file-select"
              className={`flex items-center justify-center gap-2 border-2 border-dashed rounded-md p-4 cursor-pointer transition-colors ${
                isSubmitting ? "opacity-50 cursor-not-allowed" : "hover:bg-muted/50"
              }`}
            >
              <Upload className="h-5 w-5 text-muted-foreground" />
              <span className="text-muted-foreground">Click to select files</span>
            </label>

            {selectedFiles.length > 0 && (
              <div className="space-y-2 mt-2">
                {selectedFiles.map((file, index) => (
                  <div
                    key={`${file.name}-${index}`}
                    className="flex items-center justify-between p-2 bg-muted rounded-md"
                    data-testid={`file-item-${index}`}
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <FileIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{file.name}</p>
                        <p className="text-xs text-muted-foreground">{formatFileSize(file.size)}</p>
                      </div>
                    </div>
                    {!isSubmitting && (
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={() => removeFile(index)}
                        data-testid={`button-remove-file-${index}`}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {uploadProgress && (
              <div className="space-y-1 mt-2">
                <div className="flex justify-between text-sm text-muted-foreground">
                  <span>Uploading files...</span>
                  <span>{uploadProgress.current} / {uploadProgress.total}</span>
                </div>
                <Progress value={(uploadProgress.current / uploadProgress.total) * 100} />
              </div>
            )}
          </div>

          <DialogFooter>
            <Button 
              type="button" 
              variant="outline" 
              onClick={handleClose} 
              disabled={isSubmitting}
              data-testid="button-cancel"
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting} data-testid="button-save">
              {isSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {uploadProgress ? "Uploading..." : "Saving..."}
                </>
              ) : (
                <>
                  {initialData ? "Save Changes" : (
                    fetchedTxData ? `Create ${1 + fetchedTxData.inputs.length + fetchedTxData.outputs.length} Records` : "Create Record"
                  )}
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

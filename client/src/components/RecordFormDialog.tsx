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
import { X, Upload, File as FileIcon, Loader2, Plus, Check, ChevronsUpDown, AlertTriangle, Download, ArrowDownLeft, ArrowUpRight, Info, ExternalLink } from "lucide-react";
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
import { createProvider, parseTransaction, type ParsedTransaction, MINIMUM_CONFIRMATIONS } from "@/lib/blockchain-api";

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
  availableTags?: string[];
  availableCategories?: string[];
  enabledCustomFields?: CustomFieldDef[];
  onCheckDuplicate?: (inputString: string) => Promise<ExistingRecord | undefined>;
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
  availableTags = [],
  availableCategories = [],
  enabledCustomFields = [],
  onCheckDuplicate,
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
  });

  const [formData, setFormData] = useState(initialData || getDefaultFormData());
  const [tagInput, setTagInput] = useState("");
  const [categoryInput, setCategoryInput] = useState("");
  const [ownerInput, setOwnerInput] = useState("");
  const [walletNameInput, setWalletNameInput] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [seedOpen, setSeedOpen] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const [newSeedName, setNewSeedName] = useState("");
  const [newWalletSoftware, setNewWalletSoftware] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // Duplicate detection state
  const [duplicateRecord, setDuplicateRecord] = useState<ExistingRecord | undefined>();
  const [isCheckingDuplicate, setIsCheckingDuplicate] = useState(false);
  const duplicateCheckTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Transaction lookup state
  const [isFetchingTx, setIsFetchingTx] = useState(false);
  const [txFetchError, setTxFetchError] = useState<string | null>(null);
  const [fetchedTxData, setFetchedTxData] = useState<ParsedTransaction | null>(null);

  // Reset form data when dialog opens or initialData changes
  useEffect(() => {
    if (open) {
      const data = initialData || getDefaultFormData();
      setFormData(data);
      setSelectedFiles([]);
      setTagInput(data.tags?.join(", ") || "");
      setCategoryInput(data.categories?.join(", ") || "");
      setOwnerInput(data.owner || "");
      setWalletNameInput(data.walletName || "");
      setNewSeedName("");
      setNewWalletSoftware("");
      setDuplicateRecord(undefined);
      setIsCheckingDuplicate(false);
      setFetchedTxData(null);
      setTxFetchError(null);
    }
  }, [open, initialData]);

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
        setTagInput(existing.tags?.join(", ") || "");
        setCategoryInput(existing.categories?.join(", ") || "");
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
      const provider = createProvider('mempool');
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

      const confirmations = currentHeight - (rawTx.status.block_height || 0);
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
      setTxFetchError(error instanceof Error ? error.message : "Failed to fetch transaction");
    } finally {
      setIsFetchingTx(false);
    }
  };

  // Parse comma-separated values into array
  const parseCommaSeparated = (value: string): string[] => {
    return value
      .split(",")
      .map(s => s.trim())
      .filter(s => s.length > 0);
  };

  const formatSats = (sats: number) => {
    if (sats >= 100000000) {
      return `${(sats / 100000000).toFixed(8)} BTC`;
    }
    return `${sats.toLocaleString()} sats`;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Parse tags and categories from comma-separated input
    const parsedTags = parseCommaSeparated(tagInput);
    const parsedCategories = parseCommaSeparated(categoryInput);
    
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
    
    await onSave({
      ...formData,
      tags: parsedTags,
      categories: parsedCategories,
      owner: ownerInput,
      walletName: walletNameInput,
      source: formData.source || 'manual',
      customFields: Object.keys(filteredCustomFields).length > 0 ? filteredCustomFields : undefined,
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
    if (newSeedName.trim()) {
      setFormData({ ...formData, seedName: newSeedName.trim() });
      setNewSeedName("");
      setSeedOpen(false);
    }
  };

  const addNewWalletSoftware = () => {
    if (newWalletSoftware.trim()) {
      setFormData({ ...formData, walletSoftware: newWalletSoftware.trim() });
      setNewWalletSoftware("");
      setWalletOpen(false);
    }
  };

  // Combine available values with any new value that's been set
  const allSeedNames = Array.from(new Set([...availableSeedNames, formData.seedName].filter(Boolean)));
  const allWalletSoftware = Array.from(new Set([...availableWalletSoftware, formData.walletSoftware].filter(Boolean)));

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

          <div className="space-y-2">
            <Label htmlFor="tags">Tags (comma-separated)</Label>
            <Input
              id="tags"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              placeholder="cold storage, hardware wallet, savings"
              disabled={isSubmitting}
              data-testid="input-tags"
            />
            {availableTags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {availableTags.slice(0, 8).map((tag) => (
                  <Badge
                    key={tag}
                    variant="outline"
                    className="cursor-pointer text-xs"
                    onClick={() => {
                      const current = parseCommaSeparated(tagInput);
                      if (!current.includes(tag)) {
                        setTagInput(current.length > 0 ? `${tagInput}, ${tag}` : tag);
                      }
                    }}
                    data-testid={`badge-tag-${tag}`}
                  >
                    + {tag}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="categories">Categories (comma-separated)</Label>
            <Input
              id="categories"
              value={categoryInput}
              onChange={(e) => setCategoryInput(e.target.value)}
              placeholder="Personal, Business, Investment"
              disabled={isSubmitting}
              data-testid="input-categories"
            />
            {availableCategories.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {availableCategories.slice(0, 8).map((cat) => (
                  <Badge
                    key={cat}
                    variant="outline"
                    className="cursor-pointer text-xs"
                    onClick={() => {
                      const current = parseCommaSeparated(categoryInput);
                      if (!current.includes(cat)) {
                        setCategoryInput(current.length > 0 ? `${categoryInput}, ${cat}` : cat);
                      }
                    }}
                    data-testid={`badge-category-${cat}`}
                  >
                    + {cat}
                  </Badge>
                ))}
              </div>
            )}
          </div>

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
                      onValueChange={setNewSeedName}
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
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="owner">Owner</Label>
              <Input
                id="owner"
                value={ownerInput}
                onChange={(e) => setOwnerInput(e.target.value)}
                placeholder="e.g., Personal, Company ABC"
                disabled={isSubmitting}
                data-testid="input-owner"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="walletName">Wallet Name</Label>
              <Input
                id="walletName"
                value={walletNameInput}
                onChange={(e) => setWalletNameInput(e.target.value)}
                placeholder="e.g., College Fund, Trading"
                disabled={isSubmitting}
                data-testid="input-wallet-name"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
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
                  <SelectItem value="yes">Yes</SelectItem>
                  <SelectItem value="no">No</SelectItem>
                  <SelectItem value="unsure">Unsure</SelectItem>
                </SelectContent>
              </Select>
            </div>
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
            <Label>Attachments</Label>
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

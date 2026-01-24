import { useState } from "react";
import { Tag, Layers, ChevronRight, Check, Loader2, AlertCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import { useEncryptedTags, useEncryptedCategories, createEncryptedTag, createEncryptedCategory } from "@/hooks/use-encrypted-records";
import { useAuth } from "@/contexts/AuthContext";
import { useRecords, createRecord, updateRecord } from "@/hooks/use-records";
import { useOwners, createOwner } from "@/hooks/use-owners";
import { useWalletNames, createWalletName } from "@/hooks/use-wallet-names";
import { useSeedNames, createSeedName } from "@/hooks/use-seed-names";
import { useWalletSoftware, createWalletSoftware } from "@/hooks/use-wallet-software";
import { syncTagsToMaster, syncCategoriesToMaster, findRecordByInputString, createRecordOrigin, isEncryptionReady } from "@/lib/encryptionFacade";
import { validateBitcoinInput } from "@/lib/bitcoin";
import { 
  COUNTERPARTY_TYPE_OPTIONS,
  FLOW_TYPE_OPTIONS,
  ACQUISITION_METHOD_OPTIONS,
  DISPOSITION_TYPE_OPTIONS,
  type AddressImportance,
  type CounterpartyType,
  type FlowType,
  type AcquisitionMethod,
  type DispositionType,
} from "@/lib/database";

// Address importance options for dropdown
const ADDRESS_IMPORTANCE_OPTIONS: { value: AddressImportance; label: string }[] = [
  { value: 'verified', label: 'Verified' },
  { value: 'manual', label: 'Manual' },
  { value: 'wallet-import', label: 'Wallet Import' },
  { value: 'xpub-derived', label: 'XPUB Derived' },
  { value: 'blockchain-discovered', label: 'Blockchain Discovered' },
  { value: 'pending-review', label: 'Pending Review' },
];

interface ParsedEntry {
  raw: string;
  normalized: string;
  type: 'address' | 'transaction' | 'invalid';
  existingRecordId?: number;
  selected: boolean;
}

type Step = 'paste' | 'review' | 'metadata' | 'complete';

export default function QuickTagger() {
  const { toast } = useToast();
  const { encryptionKey } = useAuth();
  const [step, setStep] = useState<Step>('paste');
  const [pastedText, setPastedText] = useState("");
  const [entries, setEntries] = useState<ParsedEntry[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [createNewRecords, setCreateNewRecords] = useState(true);

  // Metadata state - shared fields
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [owner, setOwner] = useState("");
  const [walletName, setWalletName] = useState("");
  const [seedName, setSeedName] = useState("");
  const [walletSoftware, setWalletSoftware] = useState("");
  const [privateKeyStatus, setPrivateKeyStatus] = useState("");
  const [label, setLabel] = useState("");
  const [notes, setNotes] = useState("");

  // Address-specific fields
  const [addressImportance, setAddressImportance] = useState<AddressImportance | "">("");
  const [counterpartyType, setCounterpartyType] = useState<CounterpartyType | "">("");

  // Transaction-specific fields
  const [flowType, setFlowType] = useState<FlowType | "">("");
  const [acquisitionMethod, setAcquisitionMethod] = useState<AcquisitionMethod | "">("");
  const [dispositionType, setDispositionType] = useState<DispositionType | "">("");
  const [costBasisUsd, setCostBasisUsd] = useState("");

  // Hooks for vocabulary and records
  const { tags } = useEncryptedTags();
  const { categories } = useEncryptedCategories();
  const { records } = useRecords();
  const { owners } = useOwners();
  const { walletNames } = useWalletNames();
  const { seedNames } = useSeedNames();
  const { walletSoftware: walletSoftwareList } = useWalletSoftware();

  // Parse pasted text into entries
  const parseEntries = async () => {
    // Check both auth context and encryption facade readiness
    if (!encryptionKey || !isEncryptionReady()) {
      toast({
        title: "Please wait",
        description: "Encryption is still initializing. Try again in a moment.",
        variant: "destructive",
      });
      return;
    }
    
    setIsProcessing(true);
    const lines = pastedText
      .split(/[\n,;]+/)
      .map(line => line.trim())
      .filter(line => line.length > 0);

    const seen = new Set<string>();
    const parsed: ParsedEntry[] = [];

    for (const line of lines) {
      const normalized = line.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      const validation = validateBitcoinInput(line);
      let entryType: 'address' | 'transaction' | 'invalid' = 'invalid';
      
      if (validation.isValid && validation.type) {
        entryType = validation.type;
      }

      // Check if record exists - use encrypted DB lookup for accuracy
      let existingRecordId: number | undefined;
      if (entryType !== 'invalid') {
        try {
          const existing = await findRecordByInputString(line);
          if (existing) {
            existingRecordId = existing.id;
          }
        } catch {
          // Fallback to hook cache if DB lookup fails
          const cached = records.find(r => r.inputString.toLowerCase() === line.toLowerCase());
          if (cached) {
            existingRecordId = cached.id;
          }
        }
      }

      parsed.push({
        raw: line,
        normalized,
        type: entryType,
        existingRecordId,
        selected: entryType !== 'invalid',
      });
    }

    setEntries(parsed);
    setIsProcessing(false);
    if (parsed.length > 0) {
      setStep('review');
    } else {
      toast({
        title: "No entries found",
        description: "Please paste some addresses or transaction IDs.",
        variant: "destructive",
      });
    }
  };

  // Computed counts - derived directly each render for immediate reactivity
  const selected = entries.filter(e => e.selected);
  const addressCount = selected.filter(e => e.type === 'address').length;
  const transactionCount = selected.filter(e => e.type === 'transaction').length;
  const invalidCount = entries.filter(e => e.type === 'invalid').length;
  const existingCount = selected.filter(e => e.existingRecordId !== undefined).length;
  const newCount = selected.filter(e => e.existingRecordId === undefined).length;
  const totalCount = selected.length;

  // Toggle entry selection
  const toggleEntry = (index: number) => {
    setEntries(prev => prev.map((e, i) => 
      i === index ? { ...e, selected: !e.selected } : e
    ));
  };

  // Select/deselect all
  const selectAll = (selected: boolean) => {
    setEntries(prev => prev.map(e => 
      e.type !== 'invalid' ? { ...e, selected } : e
    ));
  };

  // Apply metadata to all selected entries
  const applyMetadata = async () => {
    // Verify encryption is fully ready before applying metadata
    if (!encryptionKey || !isEncryptionReady()) {
      toast({ title: "Encryption not ready", variant: "destructive" });
      return;
    }

    setIsProcessing(true);
    const entriesToProcess = entries.filter(e => e.selected);
    let created = 0;
    let updated = 0;
    let skipped = 0;

    try {
      // Sync new tags and categories
      if (selectedTags.length > 0) {
        const existingTagNames = tags.map(t => t.name);
        for (const tagName of selectedTags) {
          if (!existingTagNames.includes(tagName)) {
            await createEncryptedTag(tagName, undefined, encryptionKey);
          }
        }
        await syncTagsToMaster(selectedTags);
      }

      if (selectedCategories.length > 0) {
        const existingCatNames = categories.map(c => c.name);
        for (const catName of selectedCategories) {
          if (!existingCatNames.includes(catName)) {
            await createEncryptedCategory(catName, encryptionKey);
          }
        }
        await syncCategoriesToMaster(selectedCategories);
      }

      // Ensure owner exists
      if (owner && !owners.find(o => o.name === owner)) {
        await createOwner(owner);
      }

      // Ensure wallet name exists
      if (walletName && !walletNames.find(w => w.name === walletName)) {
        await createWalletName(walletName);
      }

      // Ensure seed name exists
      if (seedName && !seedNames.find(s => s.name === seedName)) {
        try {
          await createSeedName(seedName);
        } catch {
          // May already exist
        }
      }

      // Ensure wallet software exists
      if (walletSoftware && !walletSoftwareList.find(w => w.name === walletSoftware)) {
        try {
          await createWalletSoftware(walletSoftware);
        } catch {
          // May already exist
        }
      }

      for (const entry of entriesToProcess) {
        const isAddress = entry.type === 'address';
        const isTransaction = entry.type === 'transaction';

        // Re-check for existing record right before write to ensure accurate dedupe
        let currentRecordId = entry.existingRecordId;
        if (!currentRecordId) {
          try {
            const existing = await findRecordByInputString(entry.raw);
            if (existing) {
              currentRecordId = existing.id;
            }
          } catch {
            // Continue with entry.existingRecordId
          }
        }

        // Build update object
        const updateData: any = {};
        
        // Shared fields - only add if value provided
        if (selectedTags.length > 0) updateData.tags = selectedTags;
        if (selectedCategories.length > 0) updateData.categories = selectedCategories;
        if (owner) updateData.owner = owner;
        if (walletName) updateData.walletName = walletName;
        if (seedName) updateData.seedName = seedName;
        if (walletSoftware) updateData.walletSoftware = walletSoftware;
        if (privateKeyStatus) updateData.privateKeyStatus = privateKeyStatus;
        if (label) updateData.label = label;
        if (notes) updateData.notes = notes;

        // Address-specific fields
        if (isAddress) {
          if (addressImportance) updateData.addressImportance = addressImportance;
          if (counterpartyType) updateData.counterpartyType = counterpartyType;
        }

        // Transaction-specific fields
        if (isTransaction) {
          if (flowType) updateData.flowType = flowType;
          if (acquisitionMethod) updateData.acquisitionMethod = acquisitionMethod;
          if (dispositionType) updateData.dispositionType = dispositionType;
          if (costBasisUsd) updateData.costBasisUsd = parseFloat(costBasisUsd);
        }

        if (currentRecordId) {
          // Update existing record - merge tags/categories
          const existingRecord = records.find(r => r.id === currentRecordId);
          if (existingRecord) {
            const mergedTags = Array.from(new Set([...existingRecord.tags, ...selectedTags]));
            const mergedCategories = Array.from(new Set([...existingRecord.categories, ...selectedCategories]));
            
            await updateRecord(currentRecordId, {
              ...updateData,
              tags: mergedTags,
              categories: mergedCategories,
            });
            updated++;
          }
        } else if (createNewRecords) {
          // Create new record
          const newRecord = await createRecord({
            type: entry.type as 'address' | 'transaction',
            inputString: entry.raw,
            label: label || "",
            notes: notes || "",
            tags: selectedTags,
            categories: selectedCategories,
            owner: owner || undefined,
            walletName: walletName || undefined,
            seedName: seedName || undefined,
            walletSoftware: walletSoftware || undefined,
            privateKeyStatus: privateKeyStatus || undefined,
            addressImportance: isAddress ? (addressImportance as AddressImportance || 'manual') : undefined,
            counterpartyType: isAddress ? (counterpartyType as CounterpartyType || undefined) : undefined,
            flowType: isTransaction ? (flowType as FlowType || undefined) : undefined,
            acquisitionMethod: isTransaction ? (acquisitionMethod as AcquisitionMethod || undefined) : undefined,
            dispositionType: isTransaction ? (dispositionType as DispositionType || undefined) : undefined,
            costBasisUsd: isTransaction && costBasisUsd ? parseFloat(costBasisUsd) : undefined,
          });

          // Create origin record
          if (newRecord?.id) {
            await createRecordOrigin({
              recordId: newRecord.id,
              originType: 'bulk-import',
              source: 'quick-tagger',
            });
          }
          created++;
        } else {
          skipped++;
        }
      }

      toast({
        title: "Metadata applied",
        description: `Updated ${updated} records, created ${created} new records${skipped > 0 ? `, skipped ${skipped}` : ''}.`,
      });

      setStep('complete');
    } catch (error) {
      console.error('Error applying metadata:', error);
      toast({
        title: "Error applying metadata",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsProcessing(false);
    }
  };

  // Reset to start
  const reset = () => {
    setPastedText("");
    setEntries([]);
    setStep('paste');
    setSelectedTags([]);
    setSelectedCategories([]);
    setOwner("");
    setWalletName("");
    setSeedName("");
    setWalletSoftware("");
    setPrivateKeyStatus("");
    setLabel("");
    setNotes("");
    setAddressImportance("");
    setCounterpartyType("");
    setFlowType("");
    setAcquisitionMethod("");
    setDispositionType("");
    setCostBasisUsd("");
    setCreateNewRecords(true);
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Tag className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Quick Tagger</h1>
            <p className="text-muted-foreground">
              Paste a list of addresses or transaction IDs to tag them all at once
            </p>
          </div>
        </div>

        {/* Progress indicator */}
        <div className="flex items-center gap-2 text-sm">
          <Badge variant={step === 'paste' ? 'default' : 'secondary'}>1. Paste</Badge>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
          <Badge variant={step === 'review' ? 'default' : 'secondary'}>2. Review</Badge>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
          <Badge variant={step === 'metadata' ? 'default' : 'secondary'}>3. Metadata</Badge>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
          <Badge variant={step === 'complete' ? 'default' : 'secondary'}>4. Done</Badge>
        </div>

        {/* Step 1: Paste */}
        {step === 'paste' && (
          <Card>
            <CardHeader>
              <CardTitle>Paste Addresses or TXIDs</CardTitle>
              <CardDescription>
                Paste one item per line. You can mix addresses and transaction IDs - they'll be automatically detected.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Textarea
                placeholder="bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh
bc1q...
a1075db55d416d3ca199f55b6084e2115b9345e16c5cf302fc80e9d5fbf5d48d
..."
                className="min-h-[200px] font-mono text-sm"
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                data-testid="textarea-paste-input"
              />
              <div className="flex justify-end">
                <Button
                  onClick={parseEntries}
                  disabled={!pastedText.trim() || isProcessing}
                  data-testid="button-parse-entries"
                >
                  {isProcessing ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Parsing...
                    </>
                  ) : (
                    <>
                      Continue
                      <ChevronRight className="h-4 w-4 ml-2" />
                    </>
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 2: Review */}
        {step === 'review' && (
          <Card>
            <CardHeader>
              <CardTitle>Review Entries</CardTitle>
              <CardDescription>
                Found {totalCount} valid items ({addressCount} addresses, {transactionCount} transactions).
                {existingCount > 0 && ` ${existingCount} already exist in your database.`}
                {newCount > 0 && ` ${newCount} are new.`}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {invalidCount > 0 && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    {invalidCount} entries could not be recognized as valid addresses or transaction IDs and will be skipped.
                  </AlertDescription>
                </Alert>
              )}

              <div className="flex items-center gap-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => selectAll(true)}
                  data-testid="button-select-all"
                >
                  Select All
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => selectAll(false)}
                  data-testid="button-deselect-all"
                >
                  Deselect All
                </Button>
                <div className="flex items-center gap-2 ml-auto">
                  <Checkbox
                    id="create-new"
                    checked={createNewRecords}
                    onCheckedChange={(checked) => setCreateNewRecords(!!checked)}
                  />
                  <Label htmlFor="create-new" className="text-sm">
                    Create records for new items
                  </Label>
                </div>
              </div>

              <div className="max-h-[300px] overflow-y-auto border rounded-md">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-background border-b">
                    <tr>
                      <th className="p-2 text-left w-10"></th>
                      <th className="p-2 text-left">Entry</th>
                      <th className="p-2 text-left w-24">Type</th>
                      <th className="p-2 text-left w-24">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry, index) => (
                      <tr
                        key={index}
                        className={`border-b ${entry.type === 'invalid' ? 'opacity-50' : ''}`}
                      >
                        <td className="p-2">
                          <Checkbox
                            checked={entry.selected}
                            disabled={entry.type === 'invalid'}
                            onCheckedChange={() => toggleEntry(index)}
                            data-testid={`checkbox-entry-${index}`}
                          />
                        </td>
                        <td className="p-2 font-mono text-xs truncate max-w-[300px]" title={entry.raw}>
                          {entry.raw}
                        </td>
                        <td className="p-2">
                          <Badge variant={entry.type === 'invalid' ? 'destructive' : 'secondary'}>
                            {entry.type === 'address' ? 'Address' : entry.type === 'transaction' ? 'TXID' : 'Invalid'}
                          </Badge>
                        </td>
                        <td className="p-2">
                          {entry.type !== 'invalid' && (
                            <Badge variant={entry.existingRecordId ? 'outline' : 'default'}>
                              {entry.existingRecordId ? 'Exists' : 'New'}
                            </Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setStep('paste')} data-testid="button-back-to-paste">
                  Back
                </Button>
                <Button
                  onClick={() => setStep('metadata')}
                  disabled={totalCount === 0}
                  data-testid="button-continue-to-metadata"
                >
                  Continue
                  <ChevronRight className="h-4 w-4 ml-2" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 3: Metadata */}
        {step === 'metadata' && (
          <Card>
            <CardHeader>
              <CardTitle>Apply Metadata</CardTitle>
              <CardDescription>
                Choose which metadata to apply. All fields are optional.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Shared Metadata */}
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Layers className="h-5 w-5" />
                  <h3 className="font-semibold">
                    Shared Metadata
                    <span className="text-muted-foreground font-normal ml-2">
                      (applies to all {totalCount} items)
                    </span>
                  </h3>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Tags</Label>
                    <MultiSelectCombobox
                      options={tags.map(t => t.name)}
                      values={selectedTags}
                      onChange={setSelectedTags}
                      placeholder="Select or create tags..."
                      onAddNew={(name) => {
                        if (encryptionKey) createEncryptedTag(name, undefined, encryptionKey);
                      }}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Categories</Label>
                    <MultiSelectCombobox
                      options={categories.map(c => c.name)}
                      values={selectedCategories}
                      onChange={setSelectedCategories}
                      placeholder="Select or create categories..."
                      onAddNew={(name) => {
                        if (encryptionKey) createEncryptedCategory(name, encryptionKey);
                      }}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Owner</Label>
                    <Select value={owner} onValueChange={setOwner}>
                      <SelectTrigger data-testid="select-owner">
                        <SelectValue placeholder="Select owner..." />
                      </SelectTrigger>
                      <SelectContent>
                        {owners.map(o => (
                          <SelectItem key={o.id} value={o.name}>{o.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Wallet Name</Label>
                    <Select value={walletName} onValueChange={setWalletName}>
                      <SelectTrigger data-testid="select-wallet-name">
                        <SelectValue placeholder="Select wallet..." />
                      </SelectTrigger>
                      <SelectContent>
                        {walletNames.map(w => (
                          <SelectItem key={w.id} value={w.name}>{w.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Seed Name</Label>
                    <Select value={seedName} onValueChange={setSeedName}>
                      <SelectTrigger data-testid="select-seed-name">
                        <SelectValue placeholder="Select seed..." />
                      </SelectTrigger>
                      <SelectContent>
                        {seedNames.map(s => (
                          <SelectItem key={s.id} value={s.name}>{s.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Wallet Software</Label>
                    <Select value={walletSoftware} onValueChange={setWalletSoftware}>
                      <SelectTrigger data-testid="select-wallet-software">
                        <SelectValue placeholder="Select software..." />
                      </SelectTrigger>
                      <SelectContent>
                        {walletSoftwareList.map(ws => (
                          <SelectItem key={ws.id} value={ws.name}>{ws.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Private Key Status</Label>
                    <Select value={privateKeyStatus} onValueChange={setPrivateKeyStatus}>
                      <SelectTrigger data-testid="select-private-key-status">
                        <SelectValue placeholder="Select status..." />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="has-private-key">Has Private Key</SelectItem>
                        <SelectItem value="no-private-key">No Private Key</SelectItem>
                        <SelectItem value="unknown">Unknown</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Label</Label>
                    <Input
                      placeholder="Optional label..."
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      data-testid="input-label"
                    />
                  </div>

                  <div className="space-y-2 md:col-span-2">
                    <Label>Notes</Label>
                    <Textarea
                      placeholder="Optional notes..."
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      data-testid="textarea-notes"
                    />
                  </div>
                </div>
              </div>

              {/* Address-Specific Metadata */}
              {addressCount > 0 && (
                <>
                  <Separator />
                  <div className="space-y-4">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">Address</Badge>
                      <h3 className="font-semibold">
                        Address-Specific
                        <span className="text-muted-foreground font-normal ml-2">
                          (applies to {addressCount} addresses)
                        </span>
                      </h3>
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label>Address Importance</Label>
                        <Select value={addressImportance} onValueChange={(v) => setAddressImportance(v as AddressImportance)}>
                          <SelectTrigger data-testid="select-address-importance">
                            <SelectValue placeholder="Select importance..." />
                          </SelectTrigger>
                          <SelectContent>
                            {ADDRESS_IMPORTANCE_OPTIONS.map(opt => (
                              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-2">
                        <Label>Counterparty Type</Label>
                        <Select value={counterpartyType} onValueChange={(v) => setCounterpartyType(v as CounterpartyType)}>
                          <SelectTrigger data-testid="select-counterparty-type">
                            <SelectValue placeholder="Select type..." />
                          </SelectTrigger>
                          <SelectContent>
                            {COUNTERPARTY_TYPE_OPTIONS.map(opt => (
                              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </div>
                </>
              )}

              {/* Transaction-Specific Metadata */}
              {transactionCount > 0 && (
                <>
                  <Separator />
                  <div className="space-y-4">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">TXID</Badge>
                      <h3 className="font-semibold">
                        Transaction-Specific
                        <span className="text-muted-foreground font-normal ml-2">
                          (applies to {transactionCount} transactions)
                        </span>
                      </h3>
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label>Flow Type</Label>
                        <Select value={flowType} onValueChange={(v) => setFlowType(v as FlowType)}>
                          <SelectTrigger data-testid="select-flow-type">
                            <SelectValue placeholder="Select flow type..." />
                          </SelectTrigger>
                          <SelectContent>
                            {FLOW_TYPE_OPTIONS.map(opt => (
                              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-2">
                        <Label>Acquisition Method</Label>
                        <Select value={acquisitionMethod} onValueChange={(v) => setAcquisitionMethod(v as AcquisitionMethod)}>
                          <SelectTrigger data-testid="select-acquisition-method">
                            <SelectValue placeholder="Select method..." />
                          </SelectTrigger>
                          <SelectContent>
                            {ACQUISITION_METHOD_OPTIONS.map(opt => (
                              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-2">
                        <Label>Disposition Type</Label>
                        <Select value={dispositionType} onValueChange={(v) => setDispositionType(v as DispositionType)}>
                          <SelectTrigger data-testid="select-disposition-type">
                            <SelectValue placeholder="Select type..." />
                          </SelectTrigger>
                          <SelectContent>
                            {DISPOSITION_TYPE_OPTIONS.map(opt => (
                              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-2">
                        <Label>Cost Basis (USD)</Label>
                        <Input
                          type="number"
                          step="0.01"
                          placeholder="Enter cost basis..."
                          value={costBasisUsd}
                          onChange={(e) => setCostBasisUsd(e.target.value)}
                          data-testid="input-cost-basis"
                        />
                      </div>
                    </div>
                  </div>
                </>
              )}

              <Separator />

              {/* Summary */}
              <Alert>
                <Layers className="h-4 w-4" />
                <AlertDescription>
                  <strong>Summary:</strong> Will apply metadata to {totalCount} items
                  {existingCount > 0 && ` (${existingCount} existing`}
                  {newCount > 0 && createNewRecords && `, ${newCount} new`}
                  {newCount > 0 && !createNewRecords && `, ${newCount} skipped`}
                  {(existingCount > 0 || newCount > 0) && ')'}
                </AlertDescription>
              </Alert>

              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setStep('review')} data-testid="button-back-to-review">
                  Back
                </Button>
                <Button
                  onClick={applyMetadata}
                  disabled={isProcessing}
                  data-testid="button-apply-metadata"
                >
                  {isProcessing ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Applying...
                    </>
                  ) : (
                    <>
                      <Check className="h-4 w-4 mr-2" />
                      Apply Metadata
                    </>
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 4: Complete */}
        {step === 'complete' && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Check className="h-6 w-6 text-green-500" />
                Complete
              </CardTitle>
              <CardDescription>
                Metadata has been applied successfully.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={reset} data-testid="button-tag-more">
                Tag More Items
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

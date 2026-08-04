import { useState, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Tag, Layers, ChevronRight, Check, Loader2, AlertCircle, X, ChevronsUpDown, Plus } from "lucide-react";
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
import { ScrollPositionIndicator } from "@/components/ScrollPositionIndicator";
import { useTags, createTag } from "@/hooks/use-tags";
import { useCategories, createCategory } from "@/hooks/use-categories";
import { createRecord, updateRecord, lookupRecordsByInputStrings } from "@/hooks/use-records";
import { useOwners, createOwner } from "@/hooks/use-owners";
import { useWalletNames, createWalletName } from "@/hooks/use-wallet-names";
import { useSeedNames, createSeedName } from "@/hooks/use-seed-names";
import { useWalletSoftware, createWalletSoftware } from "@/hooks/use-wallet-software";
import { syncTagsToMaster, syncCategoriesToMaster, createRecordOrigin, captureMergeOrigin, getRecord } from "@/lib/dataFacade";
import { beginBulkOperation, endBulkOperation } from "@/lib/database";
import { validateBitcoinInput, canonicalizeRecordIdentifier, isMixedCaseBech32 } from "@/lib/bitcoin";
import {
  type TaggerMode,
  classifyForMode,
  isSharedFieldVisible,
  buildUpdateData,
  buildCreateFields,
  type MetadataValues,
} from "./quick-tagger/quick-tagger-mode";
import { 
  COUNTERPARTY_TYPE_OPTIONS,
  FLOW_TYPE_OPTIONS,
  ACQUISITION_METHOD_OPTIONS,
  DISPOSITION_TYPE_OPTIONS,
  getImportanceTierOptions,
  type AddressImportance,
  type CounterpartyType,
  type FlowType,
  type AcquisitionMethod,
  type DispositionType,
} from "@/lib/database";

// Address importance options for dropdown (derived from the shared tier set)
const ADDRESS_IMPORTANCE_OPTIONS: { value: AddressImportance; label: string }[] = getImportanceTierOptions();

interface ParsedEntry {
  raw: string;
  normalized: string;
  type: 'address' | 'transaction' | 'invalid';
  existingRecordId?: number;
  selected: boolean;
  /** True when saving will change the entry (mixed-case bech32 or uppercase hex folded to lowercase). */
  caseFolded: boolean;
  /** True when the entry is a 64-char hex string (saved as a transaction ID; could be an x-only pubkey). */
  hex64: boolean;
}

type Step = 'paste' | 'review' | 'metadata' | 'complete';

export default function QuickTagger() {
  const { toast } = useToast();
  const [step, setStep] = useState<Step>('paste');
  const [mode, setMode] = useState<TaggerMode>('address');
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

  // Combobox state for vocabulary fields (allows adding new values)
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [walletNameOpen, setWalletNameOpen] = useState(false);
  const [seedNameOpen, setSeedNameOpen] = useState(false);
  const [walletSoftwareOpen, setWalletSoftwareOpen] = useState(false);
  const [newOwner, setNewOwner] = useState("");
  const [newWalletName, setNewWalletName] = useState("");
  const [newSeedName, setNewSeedName] = useState("");
  const [newWalletSoftware, setNewWalletSoftware] = useState("");

  const { tags } = useTags();
  const { categories } = useCategories();
  const { owners } = useOwners();
  const { walletNames } = useWalletNames();
  const { seedNames } = useSeedNames();
  const { walletSoftware: walletSoftwareList } = useWalletSoftware();

  const reviewScrollRef = useRef<HTMLDivElement>(null);
  const reviewVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => reviewScrollRef.current,
    estimateSize: () => 41,
    overscan: 20,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  // Build combined lists for comboboxes (existing + currently selected)
  const allOwners = Array.from(new Set([...owners.map(o => o.name), owner].filter(Boolean)));
  const allWalletNames = Array.from(new Set([...walletNames.map(w => w.name), walletName].filter(Boolean)));
  const allSeedNames = Array.from(new Set([...seedNames.map(s => s.name), seedName].filter(Boolean)));
  const allWalletSoftware = Array.from(new Set([...walletSoftwareList.map(ws => ws.name), walletSoftware].filter(Boolean)));

  // Helper functions for adding new vocabulary items
  const addNewOwnerValue = () => {
    if (newOwner.trim()) {
      const name = newOwner.trim();
      setOwner(name);
      createOwner(name);
      setNewOwner("");
      setOwnerOpen(false);
    }
  };

  const addNewWalletNameValue = () => {
    if (newWalletName.trim()) {
      const name = newWalletName.trim();
      setWalletName(name);
      createWalletName(name);
      setNewWalletName("");
      setWalletNameOpen(false);
    }
  };

  const addNewSeedNameValue = () => {
    if (newSeedName.trim()) {
      const name = newSeedName.trim();
      setSeedName(name);
      createSeedName(name);
      setNewSeedName("");
      setSeedNameOpen(false);
    }
  };

  const addNewWalletSoftwareValue = () => {
    if (newWalletSoftware.trim()) {
      const name = newWalletSoftware.trim();
      setWalletSoftware(name);
      createWalletSoftware(name);
      setNewWalletSoftware("");
      setWalletSoftwareOpen(false);
    }
  };

  // Parse pasted text into entries
  const parseEntries = async () => {
    
    setIsProcessing(true);
    const lines = pastedText
      .split(/[\n,;]+/)
      .map(line => line.trim())
      .filter(line => line.length > 0);

    const recordLookup = await lookupRecordsByInputStrings(lines);

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

      let existingRecordId: number | undefined;
      if (entryType !== 'invalid') {
        const cached = recordLookup.get(line.toLowerCase());
        if (cached) {
          existingRecordId = cached.id;
        }
      }

      parsed.push({
        raw: line,
        normalized,
        type: entryType,
        existingRecordId,
        selected: classifyForMode(entryType, mode) === 'match',
        caseFolded:
          entryType !== 'invalid' &&
          (isMixedCaseBech32(line) || canonicalizeRecordIdentifier(line) !== line),
        hex64: /^[a-fA-F0-9]{64}$/.test(line),
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

  // Switch mode: clear mode-inapplicable field state and re-validate entries so
  // no stale entries of the other type carry into the apply step.
  const handleModeChange = (newMode: TaggerMode) => {
    if (newMode === mode) return;
    setMode(newMode);
    setEntries(prev => prev.map(e => ({
      ...e,
      selected: classifyForMode(e.type, newMode) === 'match',
    })));
    if (newMode === 'transaction') {
      // Address-only + address-centric shared fields don't apply to transactions
      setAddressImportance("");
      setCounterpartyType("");
      setWalletName("");
      setSeedName("");
      setWalletSoftware("");
      setPrivateKeyStatus("");
    } else {
      setFlowType("");
      setAcquisitionMethod("");
      setDispositionType("");
      setCostBasisUsd("");
    }
  };

  // Computed counts - derived directly each render for immediate reactivity
  const selected = entries.filter(e => e.selected && e.type === mode);
  const invalidCount = entries.filter(e => e.type === 'invalid').length;
  const mismatchedCount = entries.filter(e => classifyForMode(e.type, mode) === 'mismatch').length;
  const existingCount = selected.filter(e => e.existingRecordId !== undefined).length;
  const newCount = selected.filter(e => e.existingRecordId === undefined).length;
  const totalCount = selected.length;
  // Canonicalization heads-up (mirrors the single-record form's identifier warning):
  // count only entries of the active mode — those are the ones that will be saved.
  const caseFoldedCount = entries.filter(e => e.type === mode && e.caseFolded).length;
  const hex64TxidCount = entries.filter(e => e.type === 'transaction' && e.hex64).length;

  // Toggle entry selection (only entries matching the active mode are selectable)
  const toggleEntry = (index: number) => {
    setEntries(prev => prev.map((e, i) => 
      i === index && e.type === mode ? { ...e, selected: !e.selected } : e
    ));
  };

  // Select/deselect all (only entries matching the active mode)
  const selectAll = (selected: boolean) => {
    setEntries(prev => prev.map(e => 
      e.type === mode ? { ...e, selected } : { ...e, selected: false }
    ));
  };

  // Apply metadata to all selected entries
  const applyMetadata = async () => {
    setIsProcessing(true);
    // Only ever process entries of the active mode's type
    const entriesToProcess = entries.filter(e => e.selected && e.type === mode);
    const metadataValues: MetadataValues = {
      selectedTags,
      selectedCategories,
      owner,
      walletName,
      seedName,
      walletSoftware,
      privateKeyStatus,
      label,
      notes,
      addressImportance,
      counterpartyType,
      flowType,
      acquisitionMethod,
      dispositionType,
      costBasisUsd,
    };
    let created = 0;
    let updated = 0;
    let skipped = 0;

    beginBulkOperation();
    try {
      // Sync new tags and categories
      if (selectedTags.length > 0) {
        const existingTagNames = tags.map(t => t.name);
        for (const tagName of selectedTags) {
          if (!existingTagNames.includes(tagName)) {
            await createTag(tagName);
          }
        }
        await syncTagsToMaster(selectedTags);
      }

      if (selectedCategories.length > 0) {
        const existingCatNames = categories.map(c => c.name);
        for (const catName of selectedCategories) {
          if (!existingCatNames.includes(catName)) {
            await createCategory(catName);
          }
        }
        await syncCategoriesToMaster(selectedCategories);
      }

      // Ensure owner exists
      if (owner && !owners.find(o => o.name === owner)) {
        await createOwner(owner);
      }

      // Wallet/seed/software vocab only applies in Addresses mode
      if (mode === 'address') {
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
      }

      const applyLookup = await lookupRecordsByInputStrings(entriesToProcess.map(e => e.raw));

      for (const entry of entriesToProcess) {
        let currentRecordId = entry.existingRecordId;
        if (!currentRecordId) {
          const cached = applyLookup.get(entry.raw.trim().toLowerCase());
          if (cached) {
            currentRecordId = cached.id;
          }
        }

        // Build update object with only mode-appropriate fields
        const updateData: any = buildUpdateData(mode, metadataValues);

        if (currentRecordId) {
          const existingRecord = await getRecord(currentRecordId);
          if (existingRecord) {
            const mergedTags = Array.from(new Set([...existingRecord.tags, ...selectedTags]));
            const mergedCategories = Array.from(new Set([...existingRecord.categories, ...selectedCategories]));
            
            await updateRecord(currentRecordId, {
              ...updateData,
              tags: mergedTags,
              categories: mergedCategories,
            });
            // Record the incoming metadata as an origin (backfilling a
            // baseline first when the record has none) so differing values
            // surface on the Conflict Resolution page. Non-fatal.
            await captureMergeOrigin(existingRecord, {
              originType: 'bulk-import',
              source: 'quick-tagger',
              label: updateData.label || undefined,
              notes: updateData.notes || undefined,
              owner: updateData.owner || undefined,
              walletName: updateData.walletName || undefined,
              seedName: updateData.seedName || undefined,
              walletSoftware: updateData.walletSoftware || undefined,
              privateKeyStatus: updateData.privateKeyStatus || undefined,
              tags: selectedTags.length > 0 ? [...selectedTags] : undefined,
              categories: selectedCategories.length > 0 ? [...selectedCategories] : undefined,
            });
            updated++;
          }
        } else if (createNewRecords) {
          const newRecordId = await createRecord({
            ...(buildCreateFields(mode, metadataValues) as any),
            inputString: entry.raw,
          });
          if (newRecordId) {
            applyLookup.set(entry.raw.trim().toLowerCase(), { id: newRecordId as number, inputString: entry.raw } as any);
            try {
              await createRecordOrigin({
                recordId: newRecordId as number,
                originType: 'bulk-import',
                source: 'quick-tagger',
              });
            } catch (e) {
              console.error('Failed to create record origin:', e);
            }
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
      endBulkOperation();
      setIsProcessing(false);
    }
  };

  // Reset to start
  const reset = () => {
    setMode('address');
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
              <CardTitle>{mode === 'address' ? 'Paste Addresses' : 'Paste Transaction IDs'}</CardTitle>
              <CardDescription>
                Choose what you're tagging, then paste one item per line. Entries of the other type will be flagged and skipped.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Mode</Label>
                <div className="inline-flex rounded-md border p-1 gap-1">
                  <Button
                    size="sm"
                    variant={mode === 'address' ? 'default' : 'ghost'}
                    onClick={() => handleModeChange('address')}
                    data-testid="button-mode-address"
                  >
                    Addresses
                  </Button>
                  <Button
                    size="sm"
                    variant={mode === 'transaction' ? 'default' : 'ghost'}
                    onClick={() => handleModeChange('transaction')}
                    data-testid="button-mode-transaction"
                  >
                    Transactions
                  </Button>
                </div>
              </div>
              <Textarea
                placeholder={mode === 'address'
                  ? "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh\nbc1q...\n..."
                  : "a1075db55d416d3ca199f55b6084e2115b9345e16c5cf302fc80e9d5fbf5d48d\n..."}
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
                Found {totalCount} valid {mode === 'address' ? 'addresses' : 'transactions'}.
                {existingCount > 0 && ` ${existingCount} already exist in your database.`}
                {newCount > 0 && ` ${newCount} are new.`}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {mismatchedCount > 0 && (
                <Alert data-testid="alert-mismatched-entries">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription className="flex items-center justify-between gap-2 flex-wrap">
                    <span>
                      {mode === 'address'
                        ? `${mismatchedCount} transaction ID${mismatchedCount === 1 ? '' : 's'} ignored — switch to Transactions mode to tag them.`
                        : `${mismatchedCount} address${mismatchedCount === 1 ? '' : 'es'} ignored — switch to Addresses mode to tag them.`}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleModeChange(mode === 'address' ? 'transaction' : 'address')}
                      data-testid="button-switch-mode"
                    >
                      Switch to {mode === 'address' ? 'Transactions' : 'Addresses'}
                    </Button>
                  </AlertDescription>
                </Alert>
              )}

              {(caseFoldedCount > 0 || (mode === 'transaction' && hex64TxidCount > 0)) && (
                <Alert data-testid="alert-identifier-warning">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    {caseFoldedCount > 0 && (
                      <span className="block">
                        <span className="font-medium">
                          {caseFoldedCount} {caseFoldedCount === 1 ? 'entry' : 'entries'} will be saved in lowercase.
                        </span>
                        <span className="block text-sm mt-1">
                          Bech32 addresses mixing upper- and lowercase letters are usually a paste
                          mistake; they will be stored in their canonical lowercase form.
                        </span>
                      </span>
                    )}
                    {mode === 'transaction' && hex64TxidCount > 0 && (
                      <span className={cn("block", caseFoldedCount > 0 && "mt-2")}>
                        <span className="font-medium">
                          {hex64TxidCount} {hex64TxidCount === 1 ? 'entry' : 'entries'} will be saved as transaction IDs.
                        </span>
                        <span className="block text-sm mt-1">
                          A 64-character hex string could also be an x-only public key pasted by
                          accident — public keys are not tracked, only addresses and transaction IDs.
                          Double-check what you copied before applying.
                        </span>
                      </span>
                    )}
                  </AlertDescription>
                </Alert>
              )}

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

              <div ref={reviewScrollRef} className="max-h-[300px] overflow-y-auto border rounded-md">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-background border-b z-10">
                    <tr>
                      <th className="p-2 text-left w-10"></th>
                      <th className="p-2 text-left">Entry</th>
                      <th className="p-2 text-left w-24">Type</th>
                      <th className="p-2 text-left w-24">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reviewVirtualizer.getVirtualItems().length > 0 && reviewVirtualizer.getVirtualItems()[0].start > 0 && (
                      <tr><td colSpan={4} style={{ height: reviewVirtualizer.getVirtualItems()[0].start, padding: 0 }} /></tr>
                    )}
                    {reviewVirtualizer.getVirtualItems().map(virtualRow => {
                      const entry = entries[virtualRow.index];
                      const index = virtualRow.index;
                      const modeStatus = classifyForMode(entry.type, mode);
                      return (
                        <tr
                          key={virtualRow.key}
                          ref={reviewVirtualizer.measureElement}
                          data-index={virtualRow.index}
                          className={`border-b ${modeStatus !== 'match' ? 'opacity-50' : ''}`}
                        >
                          <td className="p-2">
                            <Checkbox
                              checked={entry.selected && modeStatus === 'match'}
                              disabled={modeStatus !== 'match'}
                              onCheckedChange={() => toggleEntry(index)}
                              data-testid={`checkbox-entry-${index}`}
                            />
                          </td>
                          <td className="p-2 font-mono text-xs truncate max-w-[300px]" title={entry.raw}>
                            {entry.raw}
                          </td>
                          <td className="p-2">
                            <Badge
                              variant={entry.type === 'invalid' ? 'destructive' : modeStatus === 'mismatch' ? 'outline' : 'secondary'}
                              data-testid={`badge-type-${index}`}
                            >
                              {entry.type === 'invalid'
                                ? 'Invalid'
                                : modeStatus === 'mismatch'
                                  ? (entry.type === 'address' ? 'Address — wrong mode' : 'TXID — wrong mode')
                                  : (entry.type === 'address' ? 'Address' : 'TXID')}
                            </Badge>
                          </td>
                          <td className="p-2">
                            {modeStatus === 'match' && (
                              <Badge variant={entry.existingRecordId ? 'outline' : 'default'}>
                                {entry.existingRecordId ? 'Exists' : 'New'}
                              </Badge>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {reviewVirtualizer.getVirtualItems().length > 0 && (() => {
                      const lastItem = reviewVirtualizer.getVirtualItems().at(-1)!;
                      const remaining = reviewVirtualizer.getTotalSize() - lastItem.end;
                      return remaining > 0 ? <tr><td colSpan={4} style={{ height: remaining, padding: 0 }} /></tr> : null;
                    })()}
                  </tbody>
                </table>
                <ScrollPositionIndicator
                  virtualItems={reviewVirtualizer.getVirtualItems()}
                  totalCount={entries.length}
                  scrollElement={reviewScrollRef.current}
                  label="entries"
                  variant="table"
                />
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
                        createTag(name);
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
                        createCategory(name);
                      }}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Owner</Label>
                    <Popover open={ownerOpen} onOpenChange={setOwnerOpen}>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          role="combobox"
                          aria-expanded={ownerOpen}
                          className="w-full justify-between font-normal"
                          data-testid="select-owner"
                        >
                          {owner || "Select or add..."}
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
                                  onClick={addNewOwnerValue}
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
                                    setOwner(name);
                                    setNewOwner("");
                                    setOwnerOpen(false);
                                  }}
                                >
                                  <Check className={cn("mr-2 h-4 w-4", owner === name ? "opacity-100" : "opacity-0")} />
                                  {name}
                                </CommandItem>
                              ))}
                              {newOwner && !allOwners.some(n => n.toLowerCase() === newOwner.toLowerCase()) && (
                                <CommandItem value={`create-${newOwner}`} onSelect={addNewOwnerValue} data-testid="add-new-owner">
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

                  {isSharedFieldVisible('walletName', mode) && (
                  <div className="space-y-2">
                    <Label>Wallet Name</Label>
                    <Popover open={walletNameOpen} onOpenChange={setWalletNameOpen}>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          role="combobox"
                          aria-expanded={walletNameOpen}
                          className="w-full justify-between font-normal"
                          data-testid="select-wallet-name"
                        >
                          {walletName || "Select or add..."}
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
                                  onClick={addNewWalletNameValue}
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
                                    setWalletName(name);
                                    setNewWalletName("");
                                    setWalletNameOpen(false);
                                  }}
                                >
                                  <Check className={cn("mr-2 h-4 w-4", walletName === name ? "opacity-100" : "opacity-0")} />
                                  {name}
                                </CommandItem>
                              ))}
                              {newWalletName && !allWalletNames.some(n => n.toLowerCase() === newWalletName.toLowerCase()) && (
                                <CommandItem value={`create-${newWalletName}`} onSelect={addNewWalletNameValue} data-testid="add-new-wallet-name">
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
                  )}

                  {isSharedFieldVisible('seedName', mode) && (
                  <div className="space-y-2">
                    <Label>Seed Name</Label>
                    <Popover open={seedNameOpen} onOpenChange={setSeedNameOpen}>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          role="combobox"
                          aria-expanded={seedNameOpen}
                          className="w-full justify-between font-normal"
                          data-testid="select-seed-name"
                        >
                          {seedName || "Select or add..."}
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
                                  onClick={addNewSeedNameValue}
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
                                    setSeedName(name);
                                    setNewSeedName("");
                                    setSeedNameOpen(false);
                                  }}
                                >
                                  <Check className={cn("mr-2 h-4 w-4", seedName === name ? "opacity-100" : "opacity-0")} />
                                  {name}
                                </CommandItem>
                              ))}
                              {newSeedName && !allSeedNames.some(n => n.toLowerCase() === newSeedName.toLowerCase()) && (
                                <CommandItem value={`create-${newSeedName}`} onSelect={addNewSeedNameValue} data-testid="add-new-seed-name">
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
                  )}

                  {isSharedFieldVisible('walletSoftware', mode) && (
                  <div className="space-y-2">
                    <Label>Wallet Software</Label>
                    <Popover open={walletSoftwareOpen} onOpenChange={setWalletSoftwareOpen}>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          role="combobox"
                          aria-expanded={walletSoftwareOpen}
                          className="w-full justify-between font-normal"
                          data-testid="select-wallet-software"
                        >
                          {walletSoftware || "Select or add..."}
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
                                  onClick={addNewWalletSoftwareValue}
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
                                    setWalletSoftware(name);
                                    setNewWalletSoftware("");
                                    setWalletSoftwareOpen(false);
                                  }}
                                >
                                  <Check className={cn("mr-2 h-4 w-4", walletSoftware === name ? "opacity-100" : "opacity-0")} />
                                  {name}
                                </CommandItem>
                              ))}
                              {newWalletSoftware && !allWalletSoftware.some(n => n.toLowerCase() === newWalletSoftware.toLowerCase()) && (
                                <CommandItem value={`create-${newWalletSoftware}`} onSelect={addNewWalletSoftwareValue} data-testid="add-new-wallet-software">
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
                  )}

                  {isSharedFieldVisible('privateKeyStatus', mode) && (
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
                  )}

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
              {mode === 'address' && (
                <>
                  <Separator />
                  <div className="space-y-4">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">Address</Badge>
                      <h3 className="font-semibold">
                        Address-Specific
                        <span className="text-muted-foreground font-normal ml-2">
                          (applies to {totalCount} addresses)
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
              {mode === 'transaction' && (
                <>
                  <Separator />
                  <div className="space-y-4">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">TXID</Badge>
                      <h3 className="font-semibold">
                        Transaction-Specific
                        <span className="text-muted-foreground font-normal ml-2">
                          (applies to {totalCount} transactions)
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

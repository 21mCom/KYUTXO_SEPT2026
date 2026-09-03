import { useState } from "react";
import { Check, Plus, ChevronsUpDown, AlertTriangle, ShieldCheck, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import { useTags } from "@/hooks/use-tags";
import { useCategories } from "@/hooks/use-categories";
import { useOwners, createOwner } from "@/hooks/use-owners";
import { useWalletNames, createWalletName } from "@/hooks/use-wallet-names";
import { useSeedNames, createSeedName } from "@/hooks/use-seed-names";
import { useWalletSoftware, createWalletSoftware } from "@/hooks/use-wallet-software";
import { hasTokens, previewLabelTemplate, AVAILABLE_TOKENS } from "@/lib/label-tokens";
import { SEED_NAME_MAX_LENGTH } from "@/hooks/use-seed-names";
import type { XpubInfo } from "@/lib/xpub";

export interface MetadataFormProps {
  seedName: string;
  setSeedName: (value: string) => void;
  walletSoftware: string;
  setWalletSoftware: (value: string) => void;
  notes: string;
  setNotes: (value: string) => void;
  privateKeyStatus: string;
  setPrivateKeyStatus: (value: string) => void;
  selectedTags: string[];
  setSelectedTags: (value: string[]) => void;
  selectedCategories: string[];
  setSelectedCategories: (value: string[]) => void;
  ownerInput: string;
  setOwnerInput: (value: string) => void;
  walletNameInput: string;
  setWalletNameInput: (value: string) => void;
  labelTemplate: string;
  setLabelTemplate: (value: string) => void;
  markAsVerified: boolean;
  setMarkAsVerified: (value: boolean) => void;
  saveTemplate: boolean;
  setSaveTemplate: (value: boolean) => void;
  receiveStartIndex: number;
  receiveEndIndex: number;
  changeStartIndex: number;
  changeEndIndex: number;
  isMultisigMode: boolean;
  xpubInfo: XpubInfo | null;
}

export default function MetadataForm({
  seedName,
  setSeedName,
  walletSoftware,
  setWalletSoftware,
  notes,
  setNotes,
  privateKeyStatus,
  setPrivateKeyStatus,
  selectedTags,
  setSelectedTags,
  selectedCategories,
  setSelectedCategories,
  ownerInput,
  setOwnerInput,
  walletNameInput,
  setWalletNameInput,
  labelTemplate,
  setLabelTemplate,
  markAsVerified,
  setMarkAsVerified,
  saveTemplate,
  setSaveTemplate,
  receiveStartIndex,
  receiveEndIndex,
  changeStartIndex,
  changeEndIndex,
  isMultisigMode,
  xpubInfo,
}: MetadataFormProps) {
  const { toast } = useToast();
  const { tags } = useTags();
  const { categories } = useCategories();
  const { owners: existingOwners } = useOwners();
  const { walletNames: existingWalletNames } = useWalletNames();
  const { seedNames: existingSeedNames } = useSeedNames();
  const { walletSoftware: existingWalletSoftware } = useWalletSoftware();

  const [seedOpen, setSeedOpen] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [walletNameOpen, setWalletNameOpen] = useState(false);
  const [newSeedName, setNewSeedName] = useState("");
  const [newWalletSoftware, setNewWalletSoftware] = useState("");
  const [newOwner, setNewOwner] = useState("");
  const [newWalletName, setNewWalletName] = useState("");

  const allOwners = Array.from(new Set([
    ...existingOwners.map(o => o.name).filter(n => n),
    ownerInput
  ].filter(Boolean)));
  const allWalletNames = Array.from(new Set([
    ...existingWalletNames.map(wn => wn.name).filter(n => n),
    walletNameInput
  ].filter(Boolean)));
  const allSeedNames = Array.from(new Set([
    ...existingSeedNames.map(sn => sn.name).filter(n => n),
    seedName
  ].filter(Boolean)));
  const allWalletSoftwareList = Array.from(new Set([
    ...existingWalletSoftware.map(ws => ws.name).filter(n => n),
    walletSoftware
  ].filter(Boolean)));

  const availableTags = tags
    .map(t => t.name)
    .filter(name => name);

  const availableCategories = categories
    .map(c => c.name)
    .filter(name => name);

  const addNewSeedName = async () => {
    if (!newSeedName.trim()) return;
    if (newSeedName.trim().length > SEED_NAME_MAX_LENGTH) {
      toast({
        variant: "destructive",
        title: "Seed name too long",
        description: `Seed names are limited to ${SEED_NAME_MAX_LENGTH} characters to prevent accidental seed phrase entry`,
      });
      return;
    }
    try {
      await createSeedName(newSeedName.trim());
    } catch (e) {
    }
    setSeedName(newSeedName.trim());
    setSeedOpen(false);
    setNewSeedName("");
  };

  const addNewWalletSoftware = async () => {
    if (newWalletSoftware.trim()) {
      try {
        await createWalletSoftware(newWalletSoftware.trim());
      } catch (e) {
      }
      setWalletSoftware(newWalletSoftware.trim());
      setWalletOpen(false);
      setNewWalletSoftware("");
    }
  };

  const addNewOwner = async () => {
    if (newOwner.trim()) {
      try {
        await createOwner(newOwner.trim());
      } catch (e) {
      }
      setOwnerInput(newOwner.trim());
      setOwnerOpen(false);
      setNewOwner("");
    }
  };

  const addNewWalletNameEntry = async () => {
    if (newWalletName.trim()) {
      try {
        await createWalletName(newWalletName.trim());
      } catch (e) {
      }
      setWalletNameInput(newWalletName.trim());
      setWalletNameOpen(false);
      setNewWalletName("");
    }
  };

  return (
    <div className="space-y-4 pt-4 border-t">
      <h4 className="font-medium">Metadata (applied to all addresses)</h4>

      <div className="p-3 bg-muted/50 rounded-md border border-muted-foreground/20 mb-4">
        <p className="text-sm text-muted-foreground">
          <strong>What gets applied where:</strong> Owner and wallet name will be applied to all derived addresses (all from your xpub). Tags and categories will be added to all addresses.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="label-template">Label Template</Label>
        <Input
          id="label-template"
          value={labelTemplate}
          onChange={(e) => setLabelTemplate(e.target.value)}
          placeholder="e.g., [wallet] [#] or Savings-[#]"
          data-testid="input-label-template"
        />
        <div className="text-xs text-muted-foreground space-y-1">
          <p>Available tokens:</p>
          <ul className="list-disc list-inside ml-2">
            {AVAILABLE_TOKENS.map(t => (
              <li key={t.token}><code className="bg-muted px-1 rounded">{t.token}</code> {t.description}</li>
            ))}
          </ul>
          {hasTokens(labelTemplate) && (
            <div className="mt-2 p-2 bg-muted/50 rounded">
              <p className="font-medium mb-1">Preview:</p>
              {previewLabelTemplate(
                labelTemplate, 
                Math.max(1, (receiveEndIndex - receiveStartIndex + 1) + (changeEndIndex - changeStartIndex + 1)),
                walletNameInput || seedName || 'Derived'
              ).map((preview, idx) => (
                <span key={idx} className="font-mono text-sm">
                  {idx > 0 && <span className="text-muted-foreground mx-1">...</span>}
                  {preview}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

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
          <div className="space-y-2">
            <Label htmlFor="mark-verified" className="flex items-center gap-2">
              Ownership Confirmed
            </Label>
            <div className="flex items-center gap-3 h-9">
              <Switch
                id="mark-verified"
                checked={markAsVerified}
                onCheckedChange={setMarkAsVerified}
                data-testid="switch-verified"
              />
              <span className="text-sm text-muted-foreground">
                {markAsVerified ? "Ownership confirmed" : "Not verified"}
              </span>
            </div>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Turn on if you are certain about who owns these addresses. This confirms attribution certainty, not private key possession.
        </p>
      </div>

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
                  data-testid="select-seed"
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
                            setSeedName(name);
                            setSeedOpen(false);
                          }}
                        >
                          <Check
                            className={cn(
                              "mr-2 h-4 w-4",
                              seedName === name ? "opacity-100" : "opacity-0"
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
                  data-testid="select-wallet"
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
                          onClick={addNewWalletSoftware}
                        >
                          <Plus className="mr-2 h-4 w-4" />
                          Add "{newWalletSoftware}"
                        </Button>
                      )}
                    </CommandEmpty>
                    <CommandGroup>
                      {allWalletSoftwareList.map((name) => (
                        <CommandItem
                          key={name}
                          value={name}
                          onSelect={() => {
                            setWalletSoftware(name);
                            setWalletOpen(false);
                          }}
                        >
                          <Check
                            className={cn(
                              "mr-2 h-4 w-4",
                              walletSoftware === name ? "opacity-100" : "opacity-0"
                            )}
                          />
                          {name}
                        </CommandItem>
                      ))}
                      {newWalletSoftware && !allWalletSoftwareList.some(n => n.toLowerCase() === newWalletSoftware.toLowerCase()) && (
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
                          onClick={addNewWalletNameEntry}
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
                          onSelect={addNewWalletNameEntry}
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
            <Label htmlFor="private-key-status">Private Key Available</Label>
            <Select value={privateKeyStatus} onValueChange={setPrivateKeyStatus}>
              <SelectTrigger id="private-key-status" data-testid="select-private-key">
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
          Do you have the private keys to spend from these addresses?
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="notes">Notes</Label>
        <Textarea
          id="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional notes for all imported addresses..."
          className="min-h-[60px]"
          data-testid="input-notes"
        />
      </div>
      
      <div className="space-y-2">
        <Label>Tags</Label>
        <MultiSelectCombobox
          values={selectedTags}
          onChange={setSelectedTags}
          options={availableTags}
          onAddNew={(value) => setSelectedTags([...selectedTags, value])}
          placeholder="Select tags..."
          searchPlaceholder="Search or add new tag..."
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
          testId="select-categories"
        />
      </div>

      <div className="space-y-3 p-4 bg-amber-50 dark:bg-amber-950/30 rounded-lg border border-amber-200 dark:border-amber-800">
        <div className="flex items-start gap-3">
          <div className="pt-0.5">
            <Checkbox
              id="save-template"
              checked={saveTemplate}
              onCheckedChange={(checked) => setSaveTemplate(checked === true)}
              data-testid="checkbox-save-template"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="save-template" className="cursor-pointer font-medium">
              Save template for future derivations
            </Label>
            <p className="text-xs text-muted-foreground">
              Store this xpub in your local vault to easily derive more addresses later without re-entering it.
            </p>
          </div>
        </div>
        
        {saveTemplate && (
          <div className="mt-3 p-3 bg-amber-100/50 dark:bg-amber-900/30 rounded border border-amber-300/50 dark:border-amber-700/50">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
              <div className="text-xs text-amber-800 dark:text-amber-300 space-y-1">
                <p className="font-medium">Privacy Note:</p>
                <p>
                  Storing an xpub doesn't risk your funds (no private keys), but it does reveal 
                  your wallet structure and all derived addresses. Vault data is stored
                  plaintext on disk, so use an encrypted disk or container if this
                  information needs at-rest protection.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

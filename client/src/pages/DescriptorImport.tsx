import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { 
  Key, 
  ChevronRight, 
  ChevronLeft, 
  Check, 
  Loader2, 
  Plus, 
  X, 
  AlertCircle, 
  AlertTriangle, 
  Info, 
  ChevronsUpDown, 
  ShieldCheck, 
  Wallet,
  Upload,
  FileText,
  Copy,
  CheckCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
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
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
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
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import { useTags, createTag as createTagHook } from "@/hooks/use-tags";
import { useCategories, createCategory as createCategoryHook } from "@/hooks/use-categories";
import { saveDescriptorAddresses, type DescriptorSaveResult } from "@/pages/descriptor-import/save-addresses";
import { beginBulkOperation, endBulkOperation } from "@/lib/database";
import { useOwners, createOwner } from "@/hooks/use-owners";
import { useWalletNames, createWalletName } from "@/hooks/use-wallet-names";
import { useSeedNames, createSeedName } from "@/hooks/use-seed-names";
import { useWalletSoftware, createWalletSoftware } from "@/hooks/use-wallet-software";
import { 
  deriveMultisigDualChain,
  deriveTaprootDualChain,
  type DerivedMultisigAddress,
  type MultisigDualChainResult,
  type MultisigScriptType,
  type MultisigXpubEntry,
  type TaprootDualChainResult,
  type TaprootDerivedAddress,
  hasNonStandardHeader,
} from "@/lib/xpub";
import {
  descriptorKeysToXpubEntries,
  getDescriptorSummary,
  isSparrowWalletFile,
  SPARROW_WALLET_FILE_MESSAGE,
  type ParsedDescriptor,
} from "@/lib/descriptor-parser";
import {
  analyzeDescriptorInput,
  describeKeptFieldCounts,
} from "@/lib/descriptor-import-utils";
import { SEED_NAME_MAX_LENGTH } from "@/hooks/use-seed-names";
import { useDropzone } from "react-dropzone";
import { ScrollArea } from "@/components/ui/scroll-area";

export default function DescriptorImport() {
  const [, navigate] = useLocation();
  const [step, setStep] = useState(1);
  
  const [descriptorInput, setDescriptorInput] = useState("");
  const [parsedDescriptor, setParsedDescriptor] = useState<ParsedDescriptor | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [walletLabel, setWalletLabel] = useState("");
  const [bsmsFirstAddress, setBsmsFirstAddress] = useState<string | null>(null);
  
  const [receiveStartIndex, setReceiveStartIndex] = useState(0);
  const [receiveEndIndex, setReceiveEndIndex] = useState(99);
  const [changeStartIndex, setChangeStartIndex] = useState(0);
  const [changeEndIndex, setChangeEndIndex] = useState(99);
  
  const [multisigResult, setMultisigResult] = useState<MultisigDualChainResult | null>(null);
  const [taprootResult, setTaprootResult] = useState<TaprootDualChainResult | null>(null);
  const [selectedReceiveAddresses, setSelectedReceiveAddresses] = useState<Set<number>>(new Set());
  const [selectedChangeAddresses, setSelectedChangeAddresses] = useState<Set<number>>(new Set());
  const [showChangeAddresses, setShowChangeAddresses] = useState(false);
  const [isDerivingAddresses, setIsDerivingAddresses] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  /** Set when BSMS address verification fails; cleared when going back to step 1. */
  const [bsmsMismatch, setBsmsMismatch] = useState<{ bsms: string; derived: string } | null>(null);
  const [saveProgress, setSaveProgress] = useState({ current: 0, total: 0 });
  /** Populated after a save so Step 3 can report results + merged-vs-kept metadata. */
  const [saveResult, setSaveResult] = useState<DescriptorSaveResult | null>(null);

  const [seedName, setSeedName] = useState("");
  const [walletSoftware, setWalletSoftware] = useState("Sparrow");
  const [notes, setNotes] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [ownerInput, setOwnerInput] = useState("");
  const [walletNameInput, setWalletNameInput] = useState("");
  const [seedOpen, setSeedOpen] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [walletNameOpen, setWalletNameOpen] = useState(false);
  const [newSeedName, setNewSeedName] = useState("");
  const [newWalletSoftware, setNewWalletSoftware] = useState("");
  const [newOwner, setNewOwner] = useState("");
  const [newWalletName, setNewWalletName] = useState("");
  
  const [markAsVerified, setMarkAsVerified] = useState(false);

  const { tags } = useTags();
  const { categories } = useCategories();
  const { toast } = useToast();
  const { copy } = useCopyToClipboard();

  const { owners: existingOwners } = useOwners();
  const { walletNames: existingWalletNames } = useWalletNames();
  const { seedNames: existingSeedNames } = useSeedNames();
  const { walletSoftware: existingWalletSoftware } = useWalletSoftware();

  const allOwners = Array.from(new Set([
    ...existingOwners.map(o => o.name).filter(n => n),
    ownerInput
  ].filter(Boolean)));
  
  const allWalletNames = Array.from(new Set([
    ...existingWalletNames.map(w => w.name).filter(n => n),
    walletNameInput
  ].filter(Boolean)));
  
  const allSeedNames = Array.from(new Set([
    ...existingSeedNames.map(s => s.name).filter(n => n),
    seedName
  ].filter(Boolean)));
  
  const allWalletSoftware = Array.from(new Set([
    ...existingWalletSoftware.map(w => w.name).filter(n => n),
    walletSoftware
  ].filter(Boolean)));

  const availableTags = tags
    .map(t => t.name)
    .filter(n => n);
    
  const availableCategories = categories
    .map(c => c.name)
    .filter(n => n);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0) return;
    
    const file = acceptedFiles[0];

    if (isSparrowWalletFile(file.name)) {
      setParsedDescriptor(null);
      setParseError(SPARROW_WALLET_FILE_MESSAGE);
      toast({
        title: "Sparrow wallet file detected",
        description: SPARROW_WALLET_FILE_MESSAGE,
        variant: "destructive",
      });
      return;
    }

    const reader = new FileReader();
    
    reader.onerror = () => {
      setParseError(`Could not read file "${file.name}"`);
      toast({
        title: "File read error",
        description: `Could not read file "${file.name}"`,
        variant: "destructive",
      });
    };
    
    reader.onload = (e) => {
      const content = e.target?.result as string;
      if (!content) {
        setParseError(`File "${file.name}" is empty`);
        toast({
          title: "Empty file",
          description: `File "${file.name}" contains no content`,
          variant: "destructive",
        });
        return;
      }
      
      const analysis = analyzeDescriptorInput(content, file.name);
      
      if (analysis.rawDescriptor) {
        setDescriptorInput(analysis.rawDescriptor);
      }
      setBsmsFirstAddress(analysis.firstAddress || null);
      if (analysis.walletLabel) {
        setWalletLabel(analysis.walletLabel);
      }
      
      if (analysis.ok && analysis.descriptor) {
        setParsedDescriptor(analysis.descriptor);
        setParseError(null);
        if (analysis.suggestedSoftware) {
          setWalletSoftware(analysis.suggestedSoftware);
        }
        if (analysis.walletLabel && !walletNameInput) {
          setWalletNameInput(analysis.walletLabel);
        }
        toast({
          title: analysis.source === 'bsms' ? "BSMS file loaded" : "Descriptor loaded",
          description: `${getDescriptorSummary(analysis.descriptor)}${analysis.firstAddress ? ` (will verify first address)` : ''}`,
        });
      } else {
        setParsedDescriptor(null);
        setParseError(analysis.error || "Could not parse file");
        toast({
          title: analysis.source === 'bsms' ? "BSMS parse error" : "Parse error",
          description: analysis.error,
          variant: "destructive",
        });
      }
    };
    
    reader.readAsText(file);
  }, [walletNameInput, toast]);
  
  const onDropRejected = useCallback((rejections: { file: File }[]) => {
    const rejected = rejections[0]?.file;
    if (rejected && isSparrowWalletFile(rejected.name)) {
      setParsedDescriptor(null);
      setParseError(SPARROW_WALLET_FILE_MESSAGE);
      toast({
        title: "Sparrow wallet file detected",
        description: SPARROW_WALLET_FILE_MESSAGE,
        variant: "destructive",
      });
    }
  }, [toast]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    onDropRejected,
    accept: {
      'application/json': ['.json'],
      'text/plain': ['.txt', '.bsms'],
      // Sparrow's internal wallet file — accepted only so we can show a
      // tailored message pointing to Sparrow's supported exports.
      'application/octet-stream': ['.mv', '.db'],
    },
    multiple: false,
  });

  const handleDescriptorChange = (value: string) => {
    setDescriptorInput(value);
    
    if (!value.trim()) {
      setParsedDescriptor(null);
      setParseError(null);
      return;
    }
    
    const analysis = analyzeDescriptorInput(value, '');
    
    setBsmsFirstAddress(analysis.firstAddress || null);
    if (analysis.walletLabel) {
      setWalletLabel(analysis.walletLabel);
    }
    
    if (analysis.ok && analysis.descriptor) {
      setParsedDescriptor(analysis.descriptor);
      setParseError(null);
      if (analysis.suggestedSoftware) {
        setWalletSoftware(analysis.suggestedSoftware);
      }
    } else {
      setParsedDescriptor(null);
      setParseError(analysis.error || "Unknown parse error");
    }
  };

  const handleDeriveAddresses = async () => {
    if (!parsedDescriptor) return;
    
    setIsDerivingAddresses(true);
    try {
      if (parsedDescriptor.isTaproot) {
        const key = parsedDescriptor.keys[0];
        const chainType = parsedDescriptor.chainType;
        
        // Only derive the chains that the descriptor supports
        const deriveReceive = chainType === 'dual-chain' || chainType === 'receive-only';
        const deriveChange = chainType === 'dual-chain' || chainType === 'change-only';
        
        // Detect if xpub is already at chain level (chainPath is /*)
        const rawPath = key.rawChainPath || key.chainPath || '/*';
        const skipChainDerivation = rawPath === '/*';
        
        const result = await deriveTaprootDualChain(
          key.xpub,
          key.fingerprint,
          key.derivationPath,
          deriveReceive ? receiveStartIndex : 0,
          deriveReceive ? receiveEndIndex : -1,
          deriveChange ? changeStartIndex : 0,
          deriveChange ? changeEndIndex : -1,
          parsedDescriptor.network,
          skipChainDerivation
        );
        
        // Clear addresses that aren't supported by this descriptor
        if (!deriveReceive) {
          result.receive = [];
        }
        if (!deriveChange) {
          result.change = [];
        }
        
        setTaprootResult(result);
        setMultisigResult(null);
        
        const receiveSet = new Set<number>();
        if (deriveReceive) {
          for (let i = receiveStartIndex; i <= receiveEndIndex; i++) {
            receiveSet.add(i);
          }
        }
        setSelectedReceiveAddresses(receiveSet);
        
        const changeSet = new Set<number>();
        if (deriveChange) {
          for (let i = changeStartIndex; i <= changeEndIndex; i++) {
            changeSet.add(i);
          }
        }
        setSelectedChangeAddresses(changeSet);
        
        setStep(2);
        
        // Verify BSMS first address if available (only when starting at index 0)
        if (bsmsFirstAddress && result.receive.length > 0 && receiveStartIndex === 0) {
          const derivedFirst = result.receive[0].address;
          if (derivedFirst === bsmsFirstAddress) {
            setBsmsMismatch(null);
            toast({
              title: "Address verification passed",
              description: `First derived address matches BSMS file: ${bsmsFirstAddress.slice(0, 12)}...`,
            });
          } else {
            setBsmsMismatch({ bsms: bsmsFirstAddress, derived: derivedFirst });
            toast({
              title: "Address verification failed",
              description: `First address mismatch! BSMS: ${bsmsFirstAddress.slice(0, 12)}... Derived: ${derivedFirst.slice(0, 12)}...`,
              variant: "destructive",
            });
          }
        } else if (bsmsFirstAddress && result.receive.length === 0) {
          // Can't verify - no receive addresses derived
          setBsmsMismatch(null);
          toast({
            title: "Taproot addresses derived",
            description: `Generated ${result.change.length} change addresses. BSMS verification skipped (no receive addresses)`,
          });
        } else if (bsmsFirstAddress && receiveStartIndex !== 0) {
          // Derived addresses but not starting from 0 - warn user
          setBsmsMismatch(null);
          toast({
            title: "Taproot addresses derived",
            description: `Generated ${result.receive.length} addresses. BSMS verification skipped (start index is not 0)`,
          });
        } else {
          // Inform user about what was derived based on descriptor type
          let description = '';
          if (chainType === 'receive-only') {
            description = `Generated ${result.receive.length} receive addresses (descriptor is receive-only)`;
          } else if (chainType === 'change-only') {
            description = `Generated ${result.change.length} change addresses (descriptor is change-only)`;
          } else {
            description = `Generated ${result.receive.length} receive and ${result.change.length} change addresses`;
          }
          
          toast({
            title: "Taproot addresses derived",
            description,
          });
        }
      } else {
        const xpubEntries = descriptorKeysToXpubEntries(parsedDescriptor.keys);
        const chainType = parsedDescriptor.chainType;
        
        // Only derive the chains that the descriptor supports
        const deriveReceive = chainType === 'dual-chain' || chainType === 'receive-only';
        const deriveChange = chainType === 'dual-chain' || chainType === 'change-only';
        
        const result = await deriveMultisigDualChain(
          {
            xpubs: xpubEntries,
            m: parsedDescriptor.threshold,
            n: parsedDescriptor.keys.length,
            scriptType: parsedDescriptor.scriptType as MultisigScriptType,
          },
          deriveReceive ? receiveStartIndex : 0,
          deriveReceive ? receiveEndIndex : -1, // -1 means empty range
          deriveChange ? changeStartIndex : 0,
          deriveChange ? changeEndIndex : -1
        );
        
        // Clear addresses that aren't supported by this descriptor
        if (!deriveReceive) {
          result.receive = [];
        }
        if (!deriveChange) {
          result.change = [];
        }
        
        setMultisigResult(result);
        setTaprootResult(null);
        
        const receiveSet = new Set<number>();
        if (deriveReceive) {
          for (let i = receiveStartIndex; i <= receiveEndIndex; i++) {
            receiveSet.add(i);
          }
        }
        setSelectedReceiveAddresses(receiveSet);
        
        const changeSet = new Set<number>();
        if (deriveChange) {
          for (let i = changeStartIndex; i <= changeEndIndex; i++) {
            changeSet.add(i);
          }
        }
        setSelectedChangeAddresses(changeSet);
        
        setStep(2);
        
        // Verify BSMS first address if available (only when starting at index 0)
        if (bsmsFirstAddress && result.receive.length > 0 && receiveStartIndex === 0) {
          const derivedFirst = result.receive[0].address;
          if (derivedFirst === bsmsFirstAddress) {
            setBsmsMismatch(null);
            toast({
              title: "Address verification passed",
              description: `First derived address matches BSMS file: ${bsmsFirstAddress.slice(0, 12)}...`,
            });
          } else {
            setBsmsMismatch({ bsms: bsmsFirstAddress, derived: derivedFirst });
            toast({
              title: "Address verification failed",
              description: `First address mismatch! BSMS: ${bsmsFirstAddress.slice(0, 12)}... Derived: ${derivedFirst.slice(0, 12)}...`,
              variant: "destructive",
            });
          }
        } else if (bsmsFirstAddress && result.receive.length === 0) {
          // Can't verify - no receive addresses derived
          setBsmsMismatch(null);
          toast({
            title: "Addresses derived",
            description: `Generated ${result.change.length} change addresses. BSMS verification skipped (no receive addresses)`,
          });
        } else if (bsmsFirstAddress && receiveStartIndex !== 0) {
          // Derived addresses but not starting from 0 - warn user
          setBsmsMismatch(null);
          toast({
            title: "Addresses derived",
            description: `Generated ${result.receive.length} addresses. BSMS verification skipped (start index is not 0)`,
          });
        } else {
          // Inform user about what was derived based on descriptor type
          let description = '';
          if (chainType === 'receive-only') {
            description = `Generated ${result.receive.length} receive addresses (descriptor is receive-only)`;
          } else if (chainType === 'change-only') {
            description = `Generated ${result.change.length} change addresses (descriptor is change-only)`;
          } else {
            description = `Generated ${result.receive.length} receive and ${result.change.length} change addresses`;
          }
          
          toast({
            title: "Addresses derived",
            description,
          });
        }
      }
    } catch (error) {
      toast({
        title: "Derivation failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsDerivingAddresses(false);
    }
  };

  const handleSaveAddresses = async () => {
    const hasResult = multisigResult || taprootResult;
    if (!hasResult || !parsedDescriptor) {
      toast({
        title: "Error",
        description: "Missing data for save",
        variant: "destructive",
      });
      return;
    }
    
    setIsSaving(true);
    setSaveProgress({ current: 0, total: 0 });
    setSaveResult(null);
    beginBulkOperation();
    
    try {
      let allSelected: Array<{ address: string; chainType: string; index: number }> = [];
      
      if (taprootResult) {
        const selectedReceive = taprootResult.receive.filter(a => selectedReceiveAddresses.has(a.index));
        const selectedChange = taprootResult.change.filter(a => selectedChangeAddresses.has(a.index));
        allSelected = [...selectedReceive, ...selectedChange];
      } else if (multisigResult) {
        const selectedReceive = multisigResult.receive.filter(a => selectedReceiveAddresses.has(a.index));
        const selectedChange = multisigResult.change.filter(a => selectedChangeAddresses.has(a.index));
        allSelected = [...selectedReceive, ...selectedChange];
      }
      
      if (allSelected.length === 0) {
        toast({
          title: "No addresses selected",
          description: "Please select at least one address to import",
          variant: "destructive",
        });
        setIsSaving(false);
        return;
      }

      setSaveProgress({ current: 0, total: allSelected.length });
      
      const sourcePrefix = walletNameInput || seedName || 'descriptor-import';
      const now = new Date();
      const dateStr = now.toISOString().split('T')[0];
      const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '');
      const sourceName = `descriptorImport-${sourcePrefix}_${dateStr}_${timeStr}`;
      
      const result = await saveDescriptorAddresses(
        allSelected,
        {
          isMultisig: parsedDescriptor.isMultisig,
          isTaproot: !!parsedDescriptor.isTaproot,
          threshold: parsedDescriptor.threshold,
          keysCount: parsedDescriptor.keys.length,
          scriptType: parsedDescriptor.scriptType,
          tags: selectedTags,
          categories: selectedCategories,
          notes: notes || undefined,
          seedName: seedName || undefined,
          walletSoftware: walletSoftware || undefined,
          owner: ownerInput || undefined,
          walletName: walletNameInput || undefined,
          markAsVerified,
          sourceName,
        },
        (current, total) => setSaveProgress({ current, total }),
      );

      setSaveResult(result);

      const problemCount = result.failures.length + result.missing.length;
      if (problemCount > 0) {
        const problemAddrs = [
          ...result.failures.map(f => f.address),
          ...result.missing,
        ];
        toast({
          title: "Import finished with problems",
          description:
            `Saved ${result.verifiedCount} of ${allSelected.length} addresses (verified in database). ` +
            `${problemCount} not saved: ${problemAddrs.slice(0, 3).join(', ')}` +
            (problemAddrs.length > 3 ? ` and ${problemAddrs.length - 3} more` : '') +
            '. See the details on the completion screen.',
          variant: "destructive",
        });
      } else {
        toast({
          title: "Import complete",
          description: `Created ${result.created} new, updated ${result.updated} addresses (${result.verifiedCount} verified in database)`,
        });
      }
      if (result.warnings.length > 0) {
        console.warn('[DescriptorImport] Non-fatal import warnings:', result.warnings);
      }
      
      setStep(3);
    } catch (error) {
      toast({
        title: "Save failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      endBulkOperation();
      setIsSaving(false);
    }
  };

  const toggleReceiveAddress = (index: number) => {
    setSelectedReceiveAddresses(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const toggleChangeAddress = (index: number) => {
    setSelectedChangeAddresses(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const activeReceiveAddresses = taprootResult?.receive || multisigResult?.receive || [];
  const activeChangeAddresses = taprootResult?.change || multisigResult?.change || [];

  const selectAllReceive = () => {
    const all = new Set(activeReceiveAddresses.map(a => a.index));
    setSelectedReceiveAddresses(all);
  };

  const deselectAllReceive = () => {
    setSelectedReceiveAddresses(new Set());
  };

  const selectAllChange = () => {
    const all = new Set(activeChangeAddresses.map(a => a.index));
    setSelectedChangeAddresses(all);
  };

  const deselectAllChange = () => {
    setSelectedChangeAddresses(new Set());
  };

  const copyAddress = (address: string) => {
    copy(address, { label: "Address" });
  };

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-4xl mx-auto">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <Key className="h-8 w-8 text-primary" />
          <h1 className="text-2xl font-bold">Descriptor Import</h1>
        </div>
        <p className="text-muted-foreground">
          Import multisig or taproot addresses from a Bitcoin output descriptor (Sparrow wallet exports — JSON / descriptor)
        </p>
      </div>
      
      <div className="flex items-center justify-between mb-8">
        {[
          { num: 1, label: "Parse Descriptor" },
          { num: 2, label: "Select & Configure" },
          { num: 3, label: "Complete" },
        ].map((s, index) => (
          <div key={s.num} className="flex items-center">
            <div className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-lg",
              step >= s.num ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
            )}>
              <span className="font-medium">{s.num}. {s.label}</span>
            </div>
            {index < 2 && (
              <ChevronRight className="h-4 w-4 mx-2 text-muted-foreground" />
            )}
          </div>
        ))}
      </div>
      
      {step === 1 && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Upload Descriptor File</CardTitle>
              <CardDescription>
                Upload a Sparrow wallet export (JSON or output descriptor) or paste the multisig/taproot descriptor directly. Sparrow's internal wallet file (.mv.db) is not supported — use File → Export in Sparrow.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div
                {...getRootProps()}
                className={cn(
                  "border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors",
                  isDragActive ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-primary/50"
                )}
                data-testid="dropzone-descriptor"
              >
                <input {...getInputProps()} data-testid="input-file-descriptor" />
                <Upload className="h-10 w-10 mx-auto mb-4 text-muted-foreground" />
                <p className="font-medium">Drop your Sparrow wallet export (JSON / descriptor) here</p>
                <p className="text-sm text-muted-foreground mt-1">or click to browse (.json, .txt, .bsms)</p>
              </div>
              
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-background px-2 text-muted-foreground">or paste descriptor</span>
                </div>
              </div>
              
              <Textarea
                value={descriptorInput}
                onChange={(e) => handleDescriptorChange(e.target.value)}
                placeholder="wsh(sortedmulti(2,[fp1/48'/0'/0'/2']xpub1...,[fp2/48'/0'/0'/2']xpub2...))#checksum"
                className="font-mono text-sm min-h-[120px]"
                data-testid="textarea-descriptor"
              />
              
              {parseError && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Parse Error</AlertTitle>
                  <AlertDescription>{parseError}</AlertDescription>
                </Alert>
              )}
              
              {parsedDescriptor && (
                <Alert>
                  <CheckCircle className="h-4 w-4 text-green-600" />
                  <AlertTitle>Descriptor Parsed Successfully</AlertTitle>
                  <AlertDescription>
                    <div className="mt-2 space-y-1">
                      <p><strong>Type:</strong> {getDescriptorSummary(parsedDescriptor)}</p>
                      <p><strong>Threshold:</strong> {parsedDescriptor.threshold} of {parsedDescriptor.keys.length}</p>
                      <p><strong>Script Type:</strong> {parsedDescriptor.scriptType}</p>
                      <p><strong>Network:</strong> {parsedDescriptor.network}</p>
                      {walletLabel && <p><strong>Wallet Label:</strong> {walletLabel}</p>}
                    </div>
                    
                    <div className="mt-4">
                      <p className="font-medium mb-2">Cosigner Keys:</p>
                      <div className="space-y-1 text-sm font-mono">
                        {parsedDescriptor.keys.map((key, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <Badge variant="outline" className="font-mono">{key.fingerprint}</Badge>
                            <span className="truncate">{key.xpub.substring(0, 20)}...</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </AlertDescription>
                </Alert>
              )}
              
              {parsedDescriptor && parsedDescriptor.keys.some(k => hasNonStandardHeader(k.xpub)) && (
                <Alert data-testid="alert-nonstandard-header">
                  <Info className="h-4 w-4" />
                  <AlertTitle>Non-standard key metadata</AlertTitle>
                  <AlertDescription>
                    One or more keys have non-standard header metadata (common with older Coinomi exports).
                    They were treated as account-level keys, so displayed paths and fingerprints may be approximate.
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
          
          {parsedDescriptor && (
            <Card>
              <CardHeader>
                <CardTitle>Derivation Range</CardTitle>
                <CardDescription>
                  Specify how many addresses to derive
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Receive Start Index</Label>
                    <Input
                      type="number"
                      value={receiveStartIndex}
                      onChange={(e) => setReceiveStartIndex(parseInt(e.target.value) || 0)}
                      min={0}
                      data-testid="input-receive-start"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Receive End Index</Label>
                    <Input
                      type="number"
                      value={receiveEndIndex}
                      onChange={(e) => setReceiveEndIndex(parseInt(e.target.value) || 99)}
                      min={0}
                      data-testid="input-receive-end"
                    />
                  </div>
                </div>
                
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Change Start Index</Label>
                    <Input
                      type="number"
                      value={changeStartIndex}
                      onChange={(e) => setChangeStartIndex(parseInt(e.target.value) || 0)}
                      min={0}
                      data-testid="input-change-start"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Change End Index</Label>
                    <Input
                      type="number"
                      value={changeEndIndex}
                      onChange={(e) => setChangeEndIndex(parseInt(e.target.value) || 99)}
                      min={0}
                      data-testid="input-change-end"
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
          
          <div className="flex justify-end">
            <Button
              onClick={handleDeriveAddresses}
              disabled={!parsedDescriptor || isDerivingAddresses}
              data-testid="button-derive-addresses"
            >
              {isDerivingAddresses ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Deriving...
                </>
              ) : (
                <>
                  Derive Addresses
                  <ChevronRight className="h-4 w-4 ml-2" />
                </>
              )}
            </Button>
          </div>
        </div>
      )}
      
      {step === 2 && (multisigResult || taprootResult) && parsedDescriptor && (
        <div className="space-y-6">
          {bsmsMismatch && (
            <Alert variant="destructive" data-testid="alert-bsms-mismatch">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Address verification failed</AlertTitle>
              <AlertDescription>
                <p className="mb-1">
                  The first derived receive address does not match the BSMS file. Your
                  descriptor or BSMS file may belong to different wallets.
                </p>
                <div className="mt-2 space-y-1 font-mono text-xs break-all">
                  <p><span className="font-semibold">BSMS: </span>{bsmsMismatch.bsms}</p>
                  <p><span className="font-semibold">Derived: </span>{bsmsMismatch.derived}</p>
                </div>
                <p className="mt-2 text-xs">
                  You can still import if you know why they differ (e.g. custom derivation start index),
                  but verify carefully before importing.
                </p>
              </AlertDescription>
            </Alert>
          )}
          <Card>
            <CardHeader>
              <CardTitle>Metadata</CardTitle>
              <CardDescription>
                Configure metadata to apply to all imported addresses
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Owner</Label>
                  <Popover open={ownerOpen} onOpenChange={setOwnerOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={ownerOpen}
                        className="w-full justify-between"
                        data-testid="select-owner"
                      >
                        {ownerInput || "Select or add..."}
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-full p-0">
                      <Command>
                        <CommandInput
                          placeholder="Search or add owner..."
                          value={newOwner}
                          onValueChange={setNewOwner}
                        />
                        <CommandList>
                          <CommandEmpty>
                            {newOwner && (
                              <Button
                                variant="ghost"
                                className="w-full justify-start"
                                onClick={async () => {
                                  await createOwner(newOwner);
                                  setOwnerInput(newOwner);
                                  setNewOwner("");
                                  setOwnerOpen(false);
                                }}
                              >
                                <Plus className="h-4 w-4 mr-2" />
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
                                <Check className={cn("mr-2 h-4 w-4", ownerInput === name ? "opacity-100" : "opacity-0")} />
                                {name}
                              </CommandItem>
                            ))}
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
                        className="w-full justify-between"
                        data-testid="select-wallet-name"
                      >
                        {walletNameInput || "Select or add..."}
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-full p-0">
                      <Command>
                        <CommandInput
                          placeholder="Search or add wallet name..."
                          value={newWalletName}
                          onValueChange={setNewWalletName}
                        />
                        <CommandList>
                          <CommandEmpty>
                            {newWalletName && (
                              <Button
                                variant="ghost"
                                className="w-full justify-start"
                                onClick={async () => {
                                  await createWalletName(newWalletName);
                                  setWalletNameInput(newWalletName);
                                  setNewWalletName("");
                                  setWalletNameOpen(false);
                                }}
                              >
                                <Plus className="h-4 w-4 mr-2" />
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
                                <Check className={cn("mr-2 h-4 w-4", walletNameInput === name ? "opacity-100" : "opacity-0")} />
                                {name}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>
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
                        className="w-full justify-between"
                        data-testid="select-seed-name"
                      >
                        {seedName || "Select or add..."}
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-full p-0">
                      <Command>
                        <CommandInput
                          placeholder="Search or add seed name..."
                          value={newSeedName}
                          onValueChange={setNewSeedName}
                        />
                        <CommandList>
                          <CommandEmpty>
                            {newSeedName && newSeedName.length <= SEED_NAME_MAX_LENGTH && (
                              <Button
                                variant="ghost"
                                className="w-full justify-start"
                                onClick={async () => {
                                  await createSeedName(newSeedName);
                                  setSeedName(newSeedName);
                                  setNewSeedName("");
                                  setSeedOpen(false);
                                }}
                              >
                                <Plus className="h-4 w-4 mr-2" />
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
                                <Check className={cn("mr-2 h-4 w-4", seedName === name ? "opacity-100" : "opacity-0")} />
                                {name}
                              </CommandItem>
                            ))}
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
                        className="w-full justify-between"
                        data-testid="select-wallet-software"
                      >
                        {walletSoftware || "Select or add..."}
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-full p-0">
                      <Command>
                        <CommandInput
                          placeholder="Search or add software..."
                          value={newWalletSoftware}
                          onValueChange={setNewWalletSoftware}
                        />
                        <CommandList>
                          <CommandEmpty>
                            {newWalletSoftware && (
                              <Button
                                variant="ghost"
                                className="w-full justify-start"
                                onClick={async () => {
                                  await createWalletSoftware(newWalletSoftware);
                                  setWalletSoftware(newWalletSoftware);
                                  setNewWalletSoftware("");
                                  setWalletOpen(false);
                                }}
                              >
                                <Plus className="h-4 w-4 mr-2" />
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
                                  setWalletOpen(false);
                                }}
                              >
                                <Check className={cn("mr-2 h-4 w-4", walletSoftware === name ? "opacity-100" : "opacity-0")} />
                                {name}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Tags</Label>
                  <MultiSelectCombobox
                    options={availableTags}
                    values={selectedTags}
                    onChange={setSelectedTags}
                    onAddNew={async (value) => {
                      await createTagHook(value);
                      setSelectedTags([...selectedTags, value]);
                    }}
                    placeholder="Select tags..."
                    testId="multiselect-tags"
                  />
                </div>
                
                <div className="space-y-2">
                  <Label>Categories</Label>
                  <MultiSelectCombobox
                    options={availableCategories}
                    values={selectedCategories}
                    onChange={setSelectedCategories}
                    onAddNew={async (value) => {
                      await createCategoryHook(value);
                      setSelectedCategories([...selectedCategories, value]);
                    }}
                    placeholder="Select categories..."
                    testId="multiselect-categories"
                  />
                </div>
              </div>
              
              <div className="space-y-2">
                <Label>Notes</Label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional notes about this import..."
                  data-testid="textarea-notes"
                />
              </div>
              
              <div className="flex items-center gap-2">
                <Switch
                  checked={markAsVerified}
                  onCheckedChange={setMarkAsVerified}
                  data-testid="switch-verified"
                />
                <Label className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4" />
                  Mark addresses as verified
                </Label>
              </div>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>Receive Addresses ({activeReceiveAddresses.length})</span>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={selectAllReceive} data-testid="button-select-all-receive">
                    Select All
                  </Button>
                  <Button variant="outline" size="sm" onClick={deselectAllReceive} data-testid="button-deselect-all-receive">
                    Deselect All
                  </Button>
                </div>
              </CardTitle>
              <CardDescription>
                {selectedReceiveAddresses.size} of {activeReceiveAddresses.length} selected
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[250px]">
                <div className="space-y-1">
                  {activeReceiveAddresses.map((addr) => (
                    <div
                      key={addr.index}
                      className={cn(
                        "flex items-center gap-3 p-2 rounded-lg hover-elevate cursor-pointer",
                        selectedReceiveAddresses.has(addr.index) && "bg-primary/10"
                      )}
                      onClick={() => toggleReceiveAddress(addr.index)}
                    >
                      <Checkbox
                        checked={selectedReceiveAddresses.has(addr.index)}
                        onCheckedChange={() => toggleReceiveAddress(addr.index)}
                        data-testid={`checkbox-receive-${addr.index}`}
                      />
                      <Badge variant="outline" className="w-12 justify-center">
                        #{addr.index}
                      </Badge>
                      <span className="font-mono text-sm flex-1 truncate">{addr.address}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          copyAddress(addr.address);
                        }}
                        data-testid={`button-copy-receive-${addr.index}`}
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span>Change Addresses ({activeChangeAddresses.length})</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowChangeAddresses(!showChangeAddresses)}
                    data-testid="button-toggle-change"
                  >
                    {showChangeAddresses ? "Hide" : "Show"}
                  </Button>
                </div>
                {showChangeAddresses && (
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={selectAllChange} data-testid="button-select-all-change">
                      Select All
                    </Button>
                    <Button variant="outline" size="sm" onClick={deselectAllChange} data-testid="button-deselect-all-change">
                      Deselect All
                    </Button>
                  </div>
                )}
              </CardTitle>
              <CardDescription>
                {selectedChangeAddresses.size} of {activeChangeAddresses.length} selected
              </CardDescription>
            </CardHeader>
            {showChangeAddresses && (
              <CardContent>
                <ScrollArea className="h-[250px]">
                  <div className="space-y-1">
                    {activeChangeAddresses.map((addr) => (
                      <div
                        key={addr.index}
                        className={cn(
                          "flex items-center gap-3 p-2 rounded-lg hover-elevate cursor-pointer",
                          selectedChangeAddresses.has(addr.index) && "bg-primary/10"
                        )}
                        onClick={() => toggleChangeAddress(addr.index)}
                      >
                        <Checkbox
                          checked={selectedChangeAddresses.has(addr.index)}
                          onCheckedChange={() => toggleChangeAddress(addr.index)}
                          data-testid={`checkbox-change-${addr.index}`}
                        />
                        <Badge variant="outline" className="w-12 justify-center">
                          #{addr.index}
                        </Badge>
                        <span className="font-mono text-sm flex-1 truncate">{addr.address}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={(e) => {
                            e.stopPropagation();
                            copyAddress(addr.address);
                          }}
                          data-testid={`button-copy-change-${addr.index}`}
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </CardContent>
            )}
          </Card>
          
          <div className="flex justify-between">
            <Button variant="outline" onClick={() => { setStep(1); setBsmsMismatch(null); }} data-testid="button-back-step1">
              <ChevronLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
            <Button
              onClick={handleSaveAddresses}
              disabled={isSaving || (selectedReceiveAddresses.size === 0 && selectedChangeAddresses.size === 0)}
              data-testid="button-import-addresses"
            >
              {isSaving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Importing {saveProgress.current} of {saveProgress.total}...
                </>
              ) : (
                <>
                  <Check className="h-4 w-4 mr-2" />
                  Import {selectedReceiveAddresses.size + selectedChangeAddresses.size} Addresses
                </>
              )}
            </Button>
          </div>
        </div>
      )}
      
      {step === 3 && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CheckCircle className="h-5 w-5 text-green-500" />
                Import Complete
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {saveResult && (saveResult.failures.length > 0 || saveResult.missing.length > 0) ? (
                <Alert variant="destructive" data-testid="alert-save-problems">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>
                    {saveResult.failures.length + saveResult.missing.length} address(es) were NOT saved
                  </AlertTitle>
                  <AlertDescription>
                    <p className="mb-2">
                      {saveResult.verifiedCount} address(es) verified in the database
                      ({saveResult.created} created, {saveResult.updated} updated).
                      The following could not be written:
                    </p>
                    <ScrollArea className="max-h-40">
                      <ul className="space-y-1 font-mono text-xs">
                        {saveResult.failures.map((f) => (
                          <li key={f.address} data-testid={`text-failed-${f.address.slice(0, 8)}`}>
                            {f.address} — {f.reason}
                          </li>
                        ))}
                        {saveResult.missing.map((a) => (
                          <li key={a} data-testid={`text-missing-${a.slice(0, 8)}`}>
                            {a} — reported saved but not found in the database
                          </li>
                        ))}
                      </ul>
                    </ScrollArea>
                  </AlertDescription>
                </Alert>
              ) : (
                <p data-testid="text-save-summary">
                  {saveResult
                    ? `${saveResult.verifiedCount} address(es) imported and verified in the database (${saveResult.created} created, ${saveResult.updated} updated).`
                    : 'Your addresses have been imported successfully.'}
                </p>
              )}

              {saveResult && (
                <div className="text-sm text-muted-foreground" data-testid="text-import-summary">
                  Created {saveResult.created} new, updated {saveResult.updated} existing,
                  skipped {saveResult.failures.length + saveResult.missing.length} address
                  {saveResult.failures.length + saveResult.missing.length === 1 ? '' : 'es'}.
                </div>
              )}

              {saveResult && describeKeptFieldCounts(saveResult.keptFieldCounts).length > 0 && (
                <Alert data-testid="alert-metadata-kept">
                  <Info className="h-4 w-4" />
                  <AlertTitle>Some existing metadata was kept</AlertTitle>
                  <AlertDescription>
                    <p className="mb-2">
                      For addresses that already existed in your vault, the values below were
                      already set, so your entries were not applied to them (tags and categories
                      were merged everywhere):
                    </p>
                    <ul className="list-disc list-inside space-y-1 text-sm">
                      {describeKeptFieldCounts(saveResult.keptFieldCounts).map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                    <p className="mt-2 text-xs">
                      Use the Bulk Editor if you want to overwrite existing values.
                    </p>
                  </AlertDescription>
                </Alert>
              )}
              
              <div className="flex gap-4">
                <Button onClick={() => navigate("/records")} data-testid="button-view-records">
                  View Records
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setStep(1);
                    setDescriptorInput("");
                    setParsedDescriptor(null);
                    setMultisigResult(null);
                    setTaprootResult(null);
                    setSaveResult(null);
                    setSelectedReceiveAddresses(new Set());
                    setSelectedChangeAddresses(new Set());
                    setBsmsMismatch(null);
                    setBsmsFirstAddress(null);
                  }}
                  data-testid="button-import-another"
                >
                  Import Another
                </Button>
                <Button variant="outline" onClick={() => navigate("/vaults")} data-testid="button-view-vaults">
                  <Wallet className="h-4 w-4 mr-2" />
                  View Vaults
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
      </div>
    </div>
  );
}

import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { Key, ChevronRight, ChevronLeft, Check, Loader2, ChevronDown, ChevronUp, AlertCircle, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { useRecords, createRecord } from "@/hooks/use-records";
import { syncTagsToMaster, syncCategoriesToMaster, isEncryptionReady, findRecordByInputString, createRecordOrigin, saveDerivationTemplate } from "@/lib/encryptionFacade";
import { updateRecord } from "@/hooks/use-records";
import { 
  deriveDualChainAddresses,
  deriveDualChainAdvanced,
  deriveMultisigDualChain,
  analyzeXpub, 
  validateExtendedPublicKey,
  validateMultisigXpubs,
  getBipDescription,
  getDepthDescription,
  getMultisigScriptTypeDescription,
  type DualChainResult,
  type MultisigDualChainResult,
  type MultisigScriptType,
  type MultisigXpubEntry,
  type XpubInfo 
} from "@/lib/xpub";
import { expandLabelTokens } from "@/lib/label-tokens";
import MultisigConfigPanel from "./bulk-import/MultisigConfigPanel";
import AddressPreviewTable from "./bulk-import/AddressPreviewTable";
import MetadataForm from "./bulk-import/MetadataForm";

export default function BulkImport() {
  const [, navigate] = useLocation();
  const [step, setStep] = useState(1);
  const [xpub, setXpub] = useState("");
  const [xpubInfo, setXpubInfo] = useState<XpubInfo | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  
  const [advancedMode, setAdvancedMode] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [customPathReceive, setCustomPathReceive] = useState("0");
  const [customPathChange, setCustomPathChange] = useState("1");
  const [receiveStartIndex, setReceiveStartIndex] = useState(0);
  const [receiveEndIndex, setReceiveEndIndex] = useState(99);
  const [changeStartIndex, setChangeStartIndex] = useState(0);
  const [changeEndIndex, setChangeEndIndex] = useState(99);
  
  const [dualChainResult, setDualChainResult] = useState<DualChainResult | null>(null);
  const [selectedReceiveAddresses, setSelectedReceiveAddresses] = useState<Set<number>>(new Set());
  const [selectedChangeAddresses, setSelectedChangeAddresses] = useState<Set<number>>(new Set());
  const [showChangeAddresses, setShowChangeAddresses] = useState(false);
  const [isDerivingAddresses, setIsDerivingAddresses] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const [seedName, setSeedName] = useState("");
  const [walletSoftware, setWalletSoftware] = useState("");
  const [notes, setNotes] = useState("");
  const [privateKeyStatus, setPrivateKeyStatus] = useState<string>("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [ownerInput, setOwnerInput] = useState("");
  const [walletNameInput, setWalletNameInput] = useState("");
  const [labelTemplate, setLabelTemplate] = useState("[wallet] [#]");

  // Vault metadata state (for singlesig xpub that's part of a multisig)
  const [isVaultXpub, setIsVaultXpub] = useState(false);
  const [vaultName, setVaultName] = useState("");
  const [vaultM, setVaultM] = useState<number | null>(null);
  const [vaultN, setVaultN] = useState<number | null>(null);
  const [vaultNotes, setVaultNotes] = useState("");
  
  // Multisig mode state
  const [isMultisigMode, setIsMultisigMode] = useState(false);
  const [multisigXpubs, setMultisigXpubs] = useState<MultisigXpubEntry[]>([
    { xpub: '', derivationPath: '' },
    { xpub: '', derivationPath: '' },
  ]);
  const [multisigM, setMultisigM] = useState<number>(2);
  const [multisigScriptType, setMultisigScriptType] = useState<MultisigScriptType>('p2wsh');
  const [multisigValidationError, setMultisigValidationError] = useState<string | null>(null);
  const [multisigResult, setMultisigResult] = useState<MultisigDualChainResult | null>(null);
  
  // Verified status
  const [markAsVerified, setMarkAsVerified] = useState(false);
  
  // Save template for future derivations (xpub storage)
  const [saveTemplate, setSaveTemplate] = useState(false);

  const { records, isLoading: isLoadingRecords } = useRecords();
  const { encryptionKey } = useAuth();
  const { toast } = useToast();

  const analyzeXpubInput = useCallback((input: string) => {
    if (!input.trim()) {
      setXpubInfo(null);
      setValidationError(null);
      return;
    }

    const validation = validateExtendedPublicKey(input);
    if (!validation.valid) {
      setValidationError(validation.error || 'Invalid extended public key');
      setXpubInfo(null);
      return;
    }

    try {
      const info = analyzeXpub(input);
      setXpubInfo(info);
      setValidationError(null);
      
      if (info.needsAdvancedMode) {
        setAdvancedMode(true);
        setAdvancedOpen(true);
      }
      
      setCustomPathReceive(info.suggestedPath || "0");
      setCustomPathChange("1");
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : 'Failed to analyze key');
      setXpubInfo(null);
    }
  }, []);

  useEffect(() => {
    const debounceTimer = setTimeout(() => {
      analyzeXpubInput(xpub);
    }, 300);
    return () => clearTimeout(debounceTimer);
  }, [xpub, analyzeXpubInput]);

  useEffect(() => {
    if (step === 3) {
      if (isMultisigMode) {
        deriveMultisigAddressesHandler();
      } else if (xpub && xpubInfo) {
        deriveAddresses();
      }
    }
  }, [step]);

  const deriveAddresses = async () => {
    if (!xpubInfo) return;
    
    setIsDerivingAddresses(true);
    try {
      let result: DualChainResult;
      
      if (advancedMode) {
        result = await deriveDualChainAdvanced(
          xpub,
          customPathReceive,
          customPathChange,
          receiveStartIndex,
          receiveEndIndex,
          changeStartIndex,
          changeEndIndex
        );
      } else {
        result = await deriveDualChainAddresses(
          xpub,
          receiveStartIndex,
          receiveEndIndex,
          changeStartIndex,
          changeEndIndex
        );
      }
      
      setDualChainResult(result);
      setSelectedReceiveAddresses(new Set(result.receive.map((_, i) => i)));
      setSelectedChangeAddresses(new Set(result.change.map((_, i) => i)));
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Derivation Failed",
        description: error instanceof Error ? error.message : "Failed to derive addresses",
      });
      setStep(2);
    } finally {
      setIsDerivingAddresses(false);
    }
  };
  
  const deriveMultisigAddressesHandler = async () => {
    const filledXpubs = multisigXpubs.filter(x => x.xpub.trim());
    if (filledXpubs.length < 2) return;
    
    setIsDerivingAddresses(true);
    try {
      const result = await deriveMultisigDualChain(
        {
          xpubs: filledXpubs,
          m: effectiveM,
          n: filledXpubs.length,
          scriptType: multisigScriptType,
        },
        receiveStartIndex,
        receiveEndIndex,
        changeStartIndex,
        changeEndIndex
      );
      
      setMultisigResult(result);
      setSelectedReceiveAddresses(new Set(result.receive.map((_, i) => i)));
      setSelectedChangeAddresses(new Set(result.change.map((_, i) => i)));
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Multisig Derivation Failed",
        description: error instanceof Error ? error.message : "Failed to derive multisig addresses",
      });
      setStep(2);
    } finally {
      setIsDerivingAddresses(false);
    }
  };

  const toggleReceiveSelection = (index: number) => {
    const newSelected = new Set(selectedReceiveAddresses);
    if (newSelected.has(index)) {
      newSelected.delete(index);
    } else {
      newSelected.add(index);
    }
    setSelectedReceiveAddresses(newSelected);
  };

  const toggleChangeSelection = (index: number) => {
    const newSelected = new Set(selectedChangeAddresses);
    if (newSelected.has(index)) {
      newSelected.delete(index);
    } else {
      newSelected.add(index);
    }
    setSelectedChangeAddresses(newSelected);
  };

  const toggleAllReceiveAddresses = () => {
    const receiveList = isMultisigMode ? multisigResult?.receive : dualChainResult?.receive;
    if (!receiveList) return;
    if (selectedReceiveAddresses.size === receiveList.length) {
      setSelectedReceiveAddresses(new Set());
    } else {
      setSelectedReceiveAddresses(new Set(receiveList.map((_, i) => i)));
    }
  };

  const toggleAllChangeAddresses = () => {
    const changeList = isMultisigMode ? multisigResult?.change : dualChainResult?.change;
    if (!changeList) return;
    if (selectedChangeAddresses.size === changeList.length) {
      setSelectedChangeAddresses(new Set());
    } else {
      setSelectedChangeAddresses(new Set(changeList.map((_, i) => i)));
    }
  };

  const totalSelectedAddresses = selectedReceiveAddresses.size + selectedChangeAddresses.size;

  const validateRange = (): boolean => {
    if (receiveStartIndex < 0 || changeStartIndex < 0) {
      toast({
        variant: "destructive",
        title: "Invalid Range",
        description: "Start index must be 0 or greater",
      });
      return false;
    }
    if (receiveEndIndex < receiveStartIndex || changeEndIndex < changeStartIndex) {
      toast({
        variant: "destructive",
        title: "Invalid Range",
        description: "End index must be greater than or equal to start index",
      });
      return false;
    }
    if (receiveEndIndex - receiveStartIndex > 500 || changeEndIndex - changeStartIndex > 500) {
      toast({
        variant: "destructive",
        title: "Invalid Range",
        description: "Maximum 500 addresses per chain can be derived at once",
      });
      return false;
    }
    return true;
  };

  const handleSaveAddresses = async () => {
    if (totalSelectedAddresses === 0) {
      toast({
        variant: "destructive",
        title: "No Addresses Selected",
        description: "Please select at least one address to save",
      });
      return;
    }

    // Get active result based on mode
    const activeReceive = isMultisigMode ? multisigResult?.receive : dualChainResult?.receive;
    const activeChange = isMultisigMode ? multisigResult?.change : dualChainResult?.change;
    
    if (!activeReceive) return;

    setIsSaving(true);
    try {
      const receiveToSave = activeReceive.filter((_, i) => selectedReceiveAddresses.has(i));
      const changeToSave = (activeChange || []).filter((_, i) => selectedChangeAddresses.has(i));
      const allAddresses = [...receiveToSave, ...changeToSave];
      
      // Build multisig vault notes with cosigner details as structured JSON
      const buildMultisigVaultNotes = () => {
        // Extract cosigner metadata (names, notes)
        const cosignerDetails = multisigXpubs
          .filter(x => x.xpub.trim())
          .map((x, idx) => ({
            index: idx + 1,
            name: x.name || `Cosigner ${idx + 1}`,
            notes: x.notes || undefined,
            // Include truncated xpub preview for visual reference (not a cryptographic fingerprint)
            xpubPreview: x.xpub.substring(0, 12) + '...',
          }));
        
        const structuredData = {
          cosigners: cosignerDetails,
          scriptType: multisigScriptType,
          userNotes: notes || undefined,
        };
        
        return JSON.stringify(structuredData, null, 2);
      };
      
      const parsedTags = selectedTags;
      const parsedCategories = selectedCategories;

      // Build vault metadata object for all derived addresses
      const vaultMetadata = isVaultXpub ? {
        isVaultXpub: true,
        vaultName: vaultName || null,
        m: vaultM,
        n: vaultN,
        vaultNotes: vaultNotes || null,
      } : {
        isVaultXpub: false,
        vaultName: null,
        m: null,
        n: null,
        vaultNotes: null,
      };

      let createdCount = 0;
      let mergedCount = 0;
      let errorCount = 0;

      for (let i = 0; i < allAddresses.length; i++) {
        const addr = allAddresses[i];
        const chainSuffix = addr.chainType === 'receive' ? ' (Receive)' : ' (Change)';
        // Get derivation path (singlesig has path, multisig uses index)
        const derivationPath = 'path' in addr ? addr.path : `multisig:${addr.index}`;
        // Human-readable source: wallet name or seed name with derivation path
        const sourcePrefix = walletNameInput || seedName || (isMultisigMode ? 'multisig-import' : 'xpub-import');
        const addressSource = `${sourcePrefix} (${derivationPath})`;
        
        // Generate label from template with token expansion
        const generatedLabel = expandLabelTokens(labelTemplate, {
          index: i,
          totalCount: allAddresses.length,
          walletName: walletNameInput || seedName || 'Derived',
        }) + chainSuffix;
        
        try {
          // Check if this address already exists
          let existingRecord = null;
          if (isEncryptionReady()) {
            try {
              existingRecord = await findRecordByInputString(addr.address);
            } catch (e) {
              console.error("Error checking for duplicate:", e);
            }
          }

          if (existingRecord?.id) {
            // Address exists - merge metadata
            // Union tags and categories
            const existingTags = existingRecord.tags || [];
            const existingCategories = existingRecord.categories || [];
            const mergedTags = Array.from(new Set([...existingTags, ...parsedTags]));
            const mergedCategories = Array.from(new Set([...existingCategories, ...parsedCategories]));

            // Handle addressImportance - can upgrade but never downgrade from verified
            // If markAsVerified is set, upgrade to verified; otherwise upgrade to xpub-derived if lower
            let newImportance = existingRecord.addressImportance;
            if (markAsVerified) {
              // Only upgrade to verified if not already verified
              if (existingRecord.addressImportance !== 'verified') {
                newImportance = 'verified';
              }
            } else if (existingRecord.addressImportance !== 'verified' && 
                       existingRecord.addressImportance !== 'manual' && 
                       existingRecord.addressImportance !== 'wallet-import') {
              // Upgrade from blockchain-discovered or pending-review to xpub-derived
              newImportance = 'xpub-derived';
            }

            // Update the record with merged metadata
            // Keep existing values if they exist, otherwise use new values
            await updateRecord(existingRecord.id, {
              tags: mergedTags,
              categories: mergedCategories,
              // Only update empty fields with new xpub-derived data
              seedName: existingRecord.seedName || seedName || undefined,
              walletSoftware: existingRecord.walletSoftware || walletSoftware || undefined,
              privateKeyStatus: existingRecord.privateKeyStatus || privateKeyStatus || undefined,
              notes: existingRecord.notes || notes || undefined,
              // Always update xpub-related metadata (more specific info)
              chainType: addr.chainType,
              derivationPath: derivationPath,
              xpub: isMultisigMode ? undefined : xpub,
              source: addressSource,
              // Add vault metadata (overwrite with new vault info if provided, use multisig config in multisig mode)
              vault: isMultisigMode ? {
                isVaultXpub: true,
                vaultName: walletNameInput || seedName || 'Multisig Vault',
                m: multisigResult?.m ?? null,
                n: multisigResult?.n ?? null,
                vaultNotes: buildMultisigVaultNotes(),
              } : vaultMetadata,
              // Handle addressImportance upgrade
              addressImportance: newImportance,
            });

            // Create a record origin entry to track xpub metadata
            if (isEncryptionReady()) {
              try {
                await createRecordOrigin({
                  recordId: existingRecord.id,
                  originType: 'xpub-derived',
                  label: generatedLabel,
                  notes: notes || undefined,
                  tags: parsedTags,
                  categories: parsedCategories,
                  seedName: seedName || undefined,
                  walletSoftware: walletSoftware || undefined,
                  privateKeyStatus: privateKeyStatus || undefined,
                  owner: ownerInput || undefined,
                  walletName: walletNameInput || undefined,
                  xpub: isMultisigMode ? undefined : xpub,
                  derivationPath: derivationPath,
                  chainType: addr.chainType,
                });
              } catch (originError) {
                console.error("Failed to create record origin:", originError);
              }
            }

            mergedCount++;
          } else {
            // New address - create record with vault metadata
            await createRecord({
              type: "address",
              inputString: addr.address,
              label: generatedLabel,
              notes: notes || undefined,
              tags: parsedTags,
              categories: parsedCategories,
              seedName: seedName || undefined,
              walletSoftware: walletSoftware || undefined,
              privateKeyStatus: privateKeyStatus || undefined,
              owner: ownerInput || undefined,
              walletName: walletNameInput || undefined,
              source: addressSource,
              chainType: addr.chainType,
              derivationPath: derivationPath,
              xpub: isMultisigMode ? undefined : xpub,
              vault: isMultisigMode ? {
                isVaultXpub: true,
                vaultName: walletNameInput || seedName || 'Multisig Vault',
                m: multisigResult?.m ?? null,
                n: multisigResult?.n ?? null,
                vaultNotes: buildMultisigVaultNotes(),
              } : vaultMetadata,
              addressImportance: markAsVerified ? 'verified' : 'xpub-derived',
            });
            createdCount++;
          }
        } catch (error) {
          console.error(`Failed to save address ${addr.address}:`, error);
          errorCount++;
        }
      }

      // Sync tags and categories to master tables for autosuggest
      // Wrapped in try/catch to ensure import succeeds even if sync fails
      try {
        if (isEncryptionReady()) {
          if (parsedTags.length > 0) {
            await syncTagsToMaster(parsedTags);
          }
          if (parsedCategories.length > 0) {
            await syncCategoriesToMaster(parsedCategories);
          }
        }
      } catch (syncError) {
        console.error("Failed to sync tags/categories to master tables:", syncError);
      }

      // Save derivation template if requested
      if (saveTemplate && xpubInfo) {
        try {
          if (isEncryptionReady()) {
            // Extract fingerprint from xpub info (first 8 hex characters of parent fingerprint)
            const fingerprint = xpubInfo.parentFingerprint || 'unknown';
            
            // Map BIP standard to script type
            const scriptTypeMap: Record<string, 'P2WPKH' | 'P2PKH' | 'P2SH-P2WPKH' | 'P2TR'> = {
              'BIP84': 'P2WPKH',
              'BIP44': 'P2PKH',
              'BIP49': 'P2SH-P2WPKH',
              'BIP86': 'P2TR',
            };
            const scriptType = scriptTypeMap[xpubInfo.bipStandard] || 'P2WPKH';
            
            // Build derivation path from depth info
            const derivationPath = xpubInfo.depth === 3 
              ? `m/${xpubInfo.bipStandard === 'BIP84' ? '84' : xpubInfo.bipStandard === 'BIP49' ? '49' : xpubInfo.bipStandard === 'BIP86' ? '86' : '44'}'/0'/0'`
              : `m/${xpubInfo.bipStandard === 'BIP84' ? '84' : xpubInfo.bipStandard === 'BIP49' ? '49' : xpubInfo.bipStandard === 'BIP86' ? '86' : '44'}'/0'/0'/0`;

            await saveDerivationTemplate({
              fingerprint,
              scriptType,
              derivationPath,
              xpub,
              gapLimit: Math.max(receiveEndIndex, changeEndIndex) + 1,
              network: xpubInfo.network === 'mainnet' ? 'mainnet' : 'testnet',
              owner: ownerInput || undefined,
              walletName: walletNameInput || undefined,
              seedName: seedName || undefined,
              notes: notes || undefined,
            });
          }
        } catch (templateError) {
          console.error("Failed to save derivation template:", templateError);
          // Don't fail the import, just log the error
        }
      }

      // Build result message
      const messages = [];
      if (createdCount > 0) messages.push(`${createdCount} new`);
      if (mergedCount > 0) messages.push(`${mergedCount} merged`);
      if (errorCount > 0) messages.push(`${errorCount} failed`);

      toast({
        title: "Import Complete",
        description: messages.length > 0 
          ? `Addresses: ${messages.join(", ")} (${receiveToSave.length} receive, ${changeToSave.length} change)`
          : `${allAddresses.length} addresses processed`,
      });

      navigate("/");
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Save Failed",
        description: error instanceof Error ? error.message : "Failed to save addresses",
      });
    } finally {
      setIsSaving(false);
    }
  };

  // Multisig helper functions
  const addMultisigXpub = () => {
    if (multisigXpubs.length < 15) {
      setMultisigXpubs([...multisigXpubs, { xpub: '', derivationPath: '' }]);
    }
  };
  
  const removeMultisigXpub = (index: number) => {
    if (multisigXpubs.length > 2) {
      setMultisigXpubs(multisigXpubs.filter((_, i) => i !== index));
    }
  };
  
  const updateMultisigXpub = (index: number, field: 'xpub' | 'derivationPath' | 'name' | 'notes', value: string) => {
    const updated = [...multisigXpubs];
    updated[index] = { ...updated[index], [field]: value };
    setMultisigXpubs(updated);
    
    // Validate multisig xpubs when changed (only for xpub field changes)
    if (field === 'xpub') {
      const filledXpubs = updated.filter(x => x.xpub.trim()).map(x => x.xpub);
      if (filledXpubs.length >= 2) {
        const validation = validateMultisigXpubs(filledXpubs);
        setMultisigValidationError(validation.valid ? null : (validation.error || 'Invalid xpubs'));
      } else {
        setMultisigValidationError(null);
      }
    }
  };
  
  // Ensure M is always valid for current N
  const multisigN = multisigXpubs.filter(x => x.xpub.trim()).length;
  const effectiveM = Math.min(multisigM, multisigN);
  
  // Validation for multisig mode
  const validMultisigXpubs = multisigXpubs.filter(x => x.xpub.trim());
  const canProceedMultisig = validMultisigXpubs.length >= 2 && 
    effectiveM >= 1 && 
    effectiveM <= validMultisigXpubs.length &&
    !multisigValidationError;
  
  const canProceedToStep2 = isMultisigMode 
    ? canProceedMultisig 
    : (xpub.trim() && xpubInfo && !validationError);

  // Unified result for step 3 preview - works with both singlesig and multisig
  const activeReceiveAddresses = isMultisigMode ? multisigResult?.receive : dualChainResult?.receive;
  const activeChangeAddresses = isMultisigMode ? multisigResult?.change : dualChainResult?.change;
  const hasActiveResult = isMultisigMode ? !!multisigResult : !!dualChainResult;

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold mb-2">Bulk Address Import</h1>
          <p className="text-muted-foreground">
            Derive multiple addresses from an extended public key (xpub/ypub/zpub)
          </p>
        </div>

        <div className="flex items-center gap-2 mb-6">
          <div className={`flex items-center gap-2 ${step >= 1 ? "text-primary" : "text-muted-foreground"}`}>
            <div className={`w-8 h-8 rounded-full flex items-center justify-center ${step >= 1 ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
              {step > 1 ? <Check className="h-4 w-4" /> : "1"}
            </div>
            <span className="text-sm font-medium">Paste Key</span>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
          <div className={`flex items-center gap-2 ${step >= 2 ? "text-primary" : "text-muted-foreground"}`}>
            <div className={`w-8 h-8 rounded-full flex items-center justify-center ${step >= 2 ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
              {step > 2 ? <Check className="h-4 w-4" /> : "2"}
            </div>
            <span className="text-sm font-medium">Configure</span>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
          <div className={`flex items-center gap-2 ${step >= 3 ? "text-primary" : "text-muted-foreground"}`}>
            <div className={`w-8 h-8 rounded-full flex items-center justify-center ${step >= 3 ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
              3
            </div>
            <span className="text-sm font-medium">Preview & Save</span>
          </div>
        </div>

        {step === 1 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Key className="h-5 w-5" />
                {isMultisigMode ? 'Import Multisig Wallet' : 'Paste Your Extended Public Key'}
              </CardTitle>
              <CardDescription>
                {isMultisigMode 
                  ? 'Enter all cosigner xpubs to derive correct multisig addresses'
                  : 'Just paste your xpub/ypub/zpub - everything will be auto-detected'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Mode Selector */}
              <div className="space-y-3 pb-4 border-b">
                <Label className="text-base font-medium">Import Type</Label>
                <RadioGroup
                  value={isMultisigMode ? "multisig" : "singlesig"}
                  onValueChange={(value) => setIsMultisigMode(value === "multisig")}
                  className="flex gap-4 flex-wrap"
                >
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="singlesig" id="mode-singlesig" data-testid="radio-mode-singlesig" />
                    <Label htmlFor="mode-singlesig" className="font-normal cursor-pointer">Single-signature wallet</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="multisig" id="mode-multisig" data-testid="radio-mode-multisig" />
                    <Label htmlFor="mode-multisig" className="font-normal cursor-pointer">Multisig wallet (multiple xpubs)</Label>
                  </div>
                </RadioGroup>
              </div>

              {/* Single-sig Mode */}
              {!isMultisigMode && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="xpub">Extended Public Key</Label>
                    <Textarea
                      id="xpub"
                      value={xpub}
                      onChange={(e) => setXpub(e.target.value)}
                      placeholder="xpub6D... / ypub6D... / zpub6D..."
                      className="font-mono text-sm min-h-[100px]"
                      data-testid="input-xpub"
                    />
                  </div>

                  {validationError && (
                    <Alert variant="destructive">
                      <AlertCircle className="h-4 w-4" />
                      <AlertTitle>Invalid Key</AlertTitle>
                      <AlertDescription>{validationError}</AlertDescription>
                    </Alert>
                  )}

                  {xpubInfo && !validationError && (
                    <Alert>
                      <Info className="h-4 w-4" />
                      <AlertTitle>Key Detected</AlertTitle>
                      <AlertDescription className="space-y-2">
                        <div className="flex flex-wrap gap-2 mt-2">
                          <Badge variant="secondary">{xpubInfo.prefix.toUpperCase()}</Badge>
                          <Badge variant="outline">{xpubInfo.bipStandard}</Badge>
                          <Badge variant="outline">{xpubInfo.network}</Badge>
                          <Badge variant="outline">{getDepthDescription(xpubInfo.depth)}</Badge>
                        </div>
                        <p className="text-sm mt-2">{getBipDescription(xpubInfo.bipStandard)}</p>
                        {xpubInfo.needsAdvancedMode && xpubInfo.reason && (
                          <p className="text-sm text-amber-600 dark:text-amber-400 mt-2">
                            {xpubInfo.reason}
                          </p>
                        )}
                      </AlertDescription>
                    </Alert>
                  )}

                  <p className="text-xs text-muted-foreground">
                    Supported formats: xpub (Legacy), ypub (Nested SegWit), zpub (Native SegWit), 
                    tpub/upub/vpub (Testnet)
                  </p>

                  {xpubInfo && !validationError && (
                    <div className="space-y-4 pt-4 border-t">
                      <div className="space-y-3">
                        <Label className="text-base font-medium">Is this XPUB from a multisig vault?</Label>
                        <RadioGroup
                          value={isVaultXpub ? "yes" : "no"}
                          onValueChange={(value) => setIsVaultXpub(value === "yes")}
                          className="flex gap-4"
                        >
                          <div className="flex items-center gap-2">
                            <RadioGroupItem value="no" id="vault-no" data-testid="radio-vault-no" />
                            <Label htmlFor="vault-no" className="font-normal cursor-pointer">No</Label>
                          </div>
                          <div className="flex items-center gap-2">
                            <RadioGroupItem value="yes" id="vault-yes" data-testid="radio-vault-yes" />
                            <Label htmlFor="vault-yes" className="font-normal cursor-pointer">Yes - add vault metadata</Label>
                          </div>
                        </RadioGroup>
                      </div>

                      {isVaultXpub && (
                        <div className="space-y-4 p-4 bg-muted/50 rounded-lg border">
                          <div className="space-y-2">
                            <Label htmlFor="vault-name">Vault Name (optional)</Label>
                            <Input
                              id="vault-name"
                              value={vaultName}
                              onChange={(e) => setVaultName(e.target.value)}
                              placeholder="e.g., Family Cold Vault"
                              data-testid="input-vault-name"
                            />
                          </div>

                          <div className="space-y-2">
                            <Label>M-of-N Signature Requirement (optional)</Label>
                            <div className="flex items-center gap-2 flex-wrap">
                              <Select
                                value={vaultM?.toString() || ""}
                                onValueChange={(value) => setVaultM(value ? parseInt(value) : null)}
                              >
                                <SelectTrigger className="w-24" data-testid="select-vault-m">
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
                              >
                                <SelectTrigger className="w-24" data-testid="select-vault-n">
                                  <SelectValue placeholder="N" />
                                </SelectTrigger>
                                <SelectContent>
                                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((num) => (
                                    <SelectItem key={num} value={num.toString()}>{num}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <span className="text-sm text-muted-foreground">signatures required</span>
                            </div>
                            {vaultM && vaultN && vaultM > vaultN && (
                              <p className="text-xs text-destructive">Required signatures (M) cannot exceed total keys (N)</p>
                            )}
                          </div>

                          <div className="space-y-2">
                            <Label htmlFor="vault-notes">Vault Notes (optional)</Label>
                            <Textarea
                              id="vault-notes"
                              value={vaultNotes}
                              onChange={(e) => setVaultNotes(e.target.value)}
                              placeholder="Additional notes about this vault XPUB..."
                              className="min-h-[80px]"
                              data-testid="input-vault-notes"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {isMultisigMode && (
                <MultisigConfigPanel
                  multisigXpubs={multisigXpubs}
                  multisigM={multisigM}
                  multisigScriptType={multisigScriptType}
                  multisigValidationError={multisigValidationError}
                  multisigN={multisigN}
                  effectiveM={effectiveM}
                  validMultisigXpubs={validMultisigXpubs}
                  onAddXpub={addMultisigXpub}
                  onRemoveXpub={removeMultisigXpub}
                  onUpdateXpub={updateMultisigXpub}
                  onSetMultisigM={setMultisigM}
                  onSetMultisigScriptType={setMultisigScriptType}
                />
              )}
              
              <Button
                className="w-full"
                onClick={() => setStep(2)}
                disabled={!canProceedToStep2}
                data-testid="button-next-step1"
              >
                Continue
                <ChevronRight className="h-4 w-4 ml-2" />
              </Button>
            </CardContent>
          </Card>
        )}

        {step === 2 && (
          <Card>
            <CardHeader>
              <CardTitle>Derivation & Metadata</CardTitle>
              <CardDescription>
                Configure address generation and add metadata to all imported addresses
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Singlesig auto-detected settings */}
              {!isMultisigMode && xpubInfo && (
                <div className="p-4 bg-muted rounded-lg space-y-3">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <h4 className="font-medium">Auto-Detected Settings</h4>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="secondary">{xpubInfo.bipStandard}</Badge>
                      <Badge variant="outline">{xpubInfo.network}</Badge>
                      <Badge variant="outline">{getDepthDescription(xpubInfo.depth)}</Badge>
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {getBipDescription(xpubInfo.bipStandard)}
                  </p>
                  {!advancedMode && (
                    xpubInfo.depth === 4 ? (
                      <div className="text-sm space-y-1">
                        <p className="text-amber-600 dark:text-amber-400">Chain-level key detected (single chain only):</p>
                        <ul className="list-disc list-inside text-muted-foreground">
                          <li>Addresses {receiveStartIndex}-{receiveEndIndex}</li>
                        </ul>
                        <p className="text-xs text-muted-foreground mt-1">
                          This key is already at chain level (depth 4). Only one chain can be derived. 
                          For dual-chain derivation, use an account-level (depth 3) key.
                        </p>
                      </div>
                    ) : (
                      <div className="text-sm space-y-1">
                        <p>Will generate both chains:</p>
                        <ul className="list-disc list-inside text-muted-foreground">
                          <li>Receive addresses {receiveStartIndex}-{receiveEndIndex} (external chain /0/n)</li>
                          <li>Change addresses {changeStartIndex}-{changeEndIndex} (internal chain /1/n)</li>
                        </ul>
                      </div>
                    )
                  )}
                </div>
              )}

              {/* Multisig configuration summary */}
              {isMultisigMode && validMultisigXpubs.length >= 2 && (
                <div className="p-4 bg-muted rounded-lg space-y-3">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <h4 className="font-medium">Multisig Configuration</h4>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="secondary">{effectiveM}-of-{multisigN}</Badge>
                      <Badge variant="outline">{multisigScriptType.toUpperCase()}</Badge>
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {getMultisigScriptTypeDescription(multisigScriptType)}
                  </p>
                  <div className="text-sm space-y-1">
                    <p>Will generate both chains:</p>
                    <ul className="list-disc list-inside text-muted-foreground">
                      <li>Receive addresses {receiveStartIndex}-{receiveEndIndex} (external chain /0/n)</li>
                      <li>Change addresses {changeStartIndex}-{changeEndIndex} (internal chain /1/n)</li>
                    </ul>
                  </div>
                </div>
              )}

              {/* Advanced settings only for singlesig mode */}
              {!isMultisigMode && (
                <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
                  <CollapsibleTrigger asChild>
                    <Button variant="outline" className="w-full justify-between" data-testid="button-toggle-advanced">
                      <span className="flex items-center gap-2">
                        Advanced Settings
                        {advancedMode && <Badge variant="secondary" className="text-xs">Active</Badge>}
                      </span>
                      {advancedOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="pt-4 space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <Label htmlFor="advanced-mode">Use Custom Derivation Paths</Label>
                        <p className="text-xs text-muted-foreground">
                          Override the auto-detected paths with custom ones
                        </p>
                      </div>
                      <Switch
                        id="advanced-mode"
                        checked={advancedMode}
                        onCheckedChange={setAdvancedMode}
                        data-testid="switch-advanced-mode"
                      />
                    </div>

                    {advancedMode && (
                      <div className="space-y-4 pl-4 border-l-2 border-primary/20">
                        <div className="space-y-2">
                          <Label htmlFor="custom-path-receive">Receive Chain Path</Label>
                          <Input
                            id="custom-path-receive"
                            value={customPathReceive}
                            onChange={(e) => setCustomPathReceive(e.target.value)}
                            placeholder="e.g., 0"
                            className="font-mono"
                            data-testid="input-custom-path-receive"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="custom-path-change">Change Chain Path</Label>
                          <Input
                            id="custom-path-change"
                            value={customPathChange}
                            onChange={(e) => setCustomPathChange(e.target.value)}
                            placeholder="e.g., 1"
                          className="font-mono"
                          data-testid="input-custom-path-change"
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Paths relative to the XPUB. Standard: "0" for receive, "1" for change.
                      </p>
                    </div>
                  )}

                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label>Receive Address Range (External Chain)</Label>
                      <div className="flex items-center gap-2">
                        <div className="flex-1">
                          <Label htmlFor="receive-start-index" className="text-xs text-muted-foreground">Start Index</Label>
                          <Input
                            id="receive-start-index"
                            type="number"
                            value={receiveStartIndex}
                            onChange={(e) => setReceiveStartIndex(Math.max(0, Number(e.target.value)))}
                            min={0}
                            data-testid="input-receive-start-index"
                          />
                        </div>
                        <span className="text-muted-foreground mt-5">to</span>
                        <div className="flex-1">
                          <Label htmlFor="receive-end-index" className="text-xs text-muted-foreground">End Index</Label>
                          <Input
                            id="receive-end-index"
                            type="number"
                            value={receiveEndIndex}
                            onChange={(e) => setReceiveEndIndex(Math.max(0, Number(e.target.value)))}
                            min={0}
                            data-testid="input-end-index"
                          />
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Will generate {Math.max(0, receiveEndIndex - receiveStartIndex + 1)} receive addresses (max 500)
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label>Change Address Range (Internal Chain)</Label>
                      <div className="flex items-center gap-2">
                        <div className="flex-1">
                          <Label htmlFor="change-start-index" className="text-xs text-muted-foreground">Start Index</Label>
                          <Input
                            id="change-start-index"
                            type="number"
                            value={changeStartIndex}
                            onChange={(e) => setChangeStartIndex(Math.max(0, Number(e.target.value)))}
                            min={0}
                            data-testid="input-change-start-index"
                          />
                        </div>
                        <span className="text-muted-foreground mt-5">to</span>
                        <div className="flex-1">
                          <Label htmlFor="change-end-index" className="text-xs text-muted-foreground">End Index</Label>
                          <Input
                            id="change-end-index"
                            type="number"
                            value={changeEndIndex}
                            onChange={(e) => setChangeEndIndex(Math.max(0, Number(e.target.value)))}
                            min={0}
                            data-testid="input-change-end-index"
                          />
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Will generate {Math.max(0, changeEndIndex - changeStartIndex + 1)} change addresses (max 500)
                      </p>
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
              )}

              <MetadataForm
                seedName={seedName}
                setSeedName={setSeedName}
                walletSoftware={walletSoftware}
                setWalletSoftware={setWalletSoftware}
                notes={notes}
                setNotes={setNotes}
                privateKeyStatus={privateKeyStatus}
                setPrivateKeyStatus={setPrivateKeyStatus}
                selectedTags={selectedTags}
                setSelectedTags={setSelectedTags}
                selectedCategories={selectedCategories}
                setSelectedCategories={setSelectedCategories}
                ownerInput={ownerInput}
                setOwnerInput={setOwnerInput}
                walletNameInput={walletNameInput}
                setWalletNameInput={setWalletNameInput}
                labelTemplate={labelTemplate}
                setLabelTemplate={setLabelTemplate}
                markAsVerified={markAsVerified}
                setMarkAsVerified={setMarkAsVerified}
                saveTemplate={saveTemplate}
                setSaveTemplate={setSaveTemplate}
                receiveStartIndex={receiveStartIndex}
                receiveEndIndex={receiveEndIndex}
                changeStartIndex={changeStartIndex}
                changeEndIndex={changeEndIndex}
                isMultisigMode={isMultisigMode}
                xpubInfo={xpubInfo}
              />

              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep(1)} data-testid="button-back">
                  <ChevronLeft className="h-4 w-4 mr-2" />
                  Back
                </Button>
                <Button 
                  className="flex-1" 
                  onClick={() => {
                    if (validateRange()) {
                      setStep(3);
                    }
                  }} 
                  data-testid="button-next-step2"
                >
                  Generate Preview
                  <ChevronRight className="h-4 w-4 ml-2" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {step === 3 && (
          <Card>
            <CardHeader>
              <CardTitle>Preview Addresses</CardTitle>
              <CardDescription>
                Review the generated addresses and select which ones to save
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {isDerivingAddresses ? (
                <div className="flex flex-col items-center justify-center py-12">
                  <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
                  <p className="text-muted-foreground">Deriving addresses...</p>
                </div>
              ) : (isMultisigMode ? multisigResult : dualChainResult) && (
                <>
                  <AddressPreviewTable
                    isMultisigMode={isMultisigMode}
                    multisigResult={multisigResult}
                    activeReceiveAddresses={activeReceiveAddresses}
                    activeChangeAddresses={activeChangeAddresses}
                    selectedReceiveAddresses={selectedReceiveAddresses}
                    selectedChangeAddresses={selectedChangeAddresses}
                    totalSelectedAddresses={totalSelectedAddresses}
                    showChangeAddresses={showChangeAddresses}
                    onSetShowChangeAddresses={setShowChangeAddresses}
                    onToggleReceiveSelection={toggleReceiveSelection}
                    onToggleChangeSelection={toggleChangeSelection}
                    onToggleAllReceiveAddresses={toggleAllReceiveAddresses}
                    onToggleAllChangeAddresses={toggleAllChangeAddresses}
                  />

                  {(seedName || walletSoftware || notes || privateKeyStatus || ownerInput || walletNameInput || selectedTags.length > 0 || selectedCategories.length > 0) && (
                    <div className="p-3 bg-muted rounded-md">
                      <p className="text-sm font-medium mb-2">Applied Metadata:</p>
                      <div className="text-sm text-muted-foreground space-y-1">
                        {seedName && <p>Seed Name: {seedName}</p>}
                        {walletSoftware && <p>Wallet Software: {walletSoftware}</p>}
                        {ownerInput && <p>Owner: {ownerInput}</p>}
                        {walletNameInput && <p>Wallet Name: {walletNameInput}</p>}
                        {privateKeyStatus && <p>Private Key: {privateKeyStatus}</p>}
                        {notes && <p>Notes: {notes.substring(0, 50)}{notes.length > 50 ? "..." : ""}</p>}
                        {selectedTags.length > 0 && (
                          <div className="flex items-center gap-1 flex-wrap">
                            Tags: {selectedTags.map(t => <Badge key={t} variant="secondary" className="text-xs">{t}</Badge>)}
                          </div>
                        )}
                        {selectedCategories.length > 0 && (
                          <div className="flex items-center gap-1 flex-wrap">
                            Categories: {selectedCategories.map(c => <Badge key={c} variant="outline" className="text-xs">{c}</Badge>)}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => setStep(2)} data-testid="button-back-step3">
                      <ChevronLeft className="h-4 w-4 mr-2" />
                      Back
                    </Button>
                    <Button
                      className="flex-1"
                      onClick={handleSaveAddresses}
                      disabled={isSaving || totalSelectedAddresses === 0}
                      data-testid="button-save-addresses"
                    >
                      {isSaving ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin mr-2" />
                          Saving...
                        </>
                      ) : (
                        <>
                          Save {totalSelectedAddresses} Addresses
                          <Check className="h-4 w-4 ml-2" />
                        </>
                      )}
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { Key, ChevronRight, ChevronLeft, Check, Loader2, Plus, X, ChevronDown, ChevronUp, AlertCircle, Info } from "lucide-react";
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
import { useTags, createTag } from "@/hooks/use-tags";
import { useCategories, createCategory } from "@/hooks/use-categories";
import { createRecord } from "@/hooks/use-records";
import { 
  deriveDualChainAddresses,
  deriveDualChainAdvanced,
  analyzeXpub, 
  validateExtendedPublicKey,
  getBipDescription,
  getDepthDescription,
  type DerivedAddress,
  type DualChainResult,
  type XpubInfo 
} from "@/lib/xpub";

export default function BulkImport() {
  const [, navigate] = useLocation();
  const [step, setStep] = useState(1);
  const [xpub, setXpub] = useState("");
  const [xpubLabel, setXpubLabel] = useState("");
  const [xpubInfo, setXpubInfo] = useState<XpubInfo | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  
  const [advancedMode, setAdvancedMode] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [customPathReceive, setCustomPathReceive] = useState("0");
  const [customPathChange, setCustomPathChange] = useState("1");
  const [receiveStartIndex, setReceiveStartIndex] = useState(0);
  const [receiveEndIndex, setReceiveEndIndex] = useState(19);
  const [changeStartIndex, setChangeStartIndex] = useState(0);
  const [changeEndIndex, setChangeEndIndex] = useState(19);
  
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
  const [newTagInput, setNewTagInput] = useState("");
  const [newCategoryInput, setNewCategoryInput] = useState("");

  const { tags } = useTags();
  const { categories } = useCategories();
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
    if (step === 3 && xpub && xpubInfo) {
      deriveAddresses();
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
    if (!dualChainResult) return;
    if (selectedReceiveAddresses.size === dualChainResult.receive.length) {
      setSelectedReceiveAddresses(new Set());
    } else {
      setSelectedReceiveAddresses(new Set(dualChainResult.receive.map((_, i) => i)));
    }
  };

  const toggleAllChangeAddresses = () => {
    if (!dualChainResult) return;
    if (selectedChangeAddresses.size === dualChainResult.change.length) {
      setSelectedChangeAddresses(new Set());
    } else {
      setSelectedChangeAddresses(new Set(dualChainResult.change.map((_, i) => i)));
    }
  };

  const totalSelectedAddresses = selectedReceiveAddresses.size + selectedChangeAddresses.size;

  const handleAddTag = async () => {
    const trimmed = newTagInput.trim();
    if (!trimmed) return;
    
    const existingTag = tags.find(t => t.name.toLowerCase() === trimmed.toLowerCase());
    if (existingTag) {
      if (!selectedTags.includes(existingTag.name)) {
        setSelectedTags(prev => [...prev, existingTag.name]);
      }
    } else {
      try {
        await createTag(trimmed);
        setSelectedTags(prev => [...prev, trimmed]);
      } catch (error) {
        toast({
          variant: "destructive",
          title: "Error",
          description: "Failed to create tag",
        });
      }
    }
    setNewTagInput("");
  };

  const handleAddCategory = async () => {
    const trimmed = newCategoryInput.trim();
    if (!trimmed) return;
    
    const existingCategory = categories.find(c => c.name.toLowerCase() === trimmed.toLowerCase());
    if (existingCategory) {
      if (!selectedCategories.includes(existingCategory.name)) {
        setSelectedCategories(prev => [...prev, existingCategory.name]);
      }
    } else {
      try {
        await createCategory(trimmed);
        setSelectedCategories(prev => [...prev, trimmed]);
      } catch (error) {
        toast({
          variant: "destructive",
          title: "Error",
          description: "Failed to create category",
        });
      }
    }
    setNewCategoryInput("");
  };

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

    if (!dualChainResult) return;

    setIsSaving(true);
    try {
      const receiveToSave = dualChainResult.receive.filter((_, i) => selectedReceiveAddresses.has(i));
      const changeToSave = dualChainResult.change.filter((_, i) => selectedChangeAddresses.has(i));
      const allAddresses = [...receiveToSave, ...changeToSave];
      
      for (const addr of allAddresses) {
        const labelPrefix = xpubLabel || seedName || "Derived";
        const chainSuffix = addr.chainType === 'receive' ? ' (Receive)' : ' (Change)';
        await createRecord({
          type: "address",
          inputString: addr.address,
          label: `${labelPrefix} #${addr.index}${chainSuffix}`,
          notes: notes || undefined,
          tags: selectedTags,
          categories: selectedCategories,
          seedName: seedName || undefined,
          walletSoftware: walletSoftware || undefined,
          privateKeyStatus: privateKeyStatus || undefined,
          source: `${xpub.substring(0, 20)}... (${addr.path})`,
          chainType: addr.chainType,
          derivationPath: addr.path,
          xpub: xpub,
        });
      }

      toast({
        title: "Addresses Saved",
        description: `${allAddresses.length} addresses saved (${receiveToSave.length} receive, ${changeToSave.length} change)`,
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

  const canProceedToStep2 = xpub.trim() && xpubInfo && !validationError;

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
                Paste Your Extended Public Key
              </CardTitle>
              <CardDescription>
                Just paste your xpub/ypub/zpub - everything will be auto-detected
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="xpub-label">Label (optional)</Label>
                <Input
                  id="xpub-label"
                  value={xpubLabel}
                  onChange={(e) => setXpubLabel(e.target.value)}
                  placeholder="e.g., Savings Wallet, Trezor Main"
                  data-testid="input-xpub-label"
                />
              </div>
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
              {xpubInfo && (
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

              <div className="space-y-4 pt-4 border-t">
                <h4 className="font-medium">Metadata (applied to all addresses)</h4>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="seed-name">Seed Name</Label>
                    <Input
                      id="seed-name"
                      value={seedName}
                      onChange={(e) => setSeedName(e.target.value)}
                      placeholder="e.g., Hardware Wallet #1"
                      data-testid="input-seed-name"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="wallet-software">Wallet Software</Label>
                    <Input
                      id="wallet-software"
                      value={walletSoftware}
                      onChange={(e) => setWalletSoftware(e.target.value)}
                      placeholder="e.g., Sparrow, Electrum"
                      data-testid="input-wallet-software"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="private-key-status">Private Key Available</Label>
                  <Select value={privateKeyStatus} onValueChange={setPrivateKeyStatus}>
                    <SelectTrigger id="private-key-status" data-testid="select-private-key">
                      <SelectValue placeholder="Select status..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="yes">Yes</SelectItem>
                      <SelectItem value="no">No</SelectItem>
                      <SelectItem value="unsure">Unsure</SelectItem>
                    </SelectContent>
                  </Select>
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
                  <div className="flex gap-2">
                    <Input
                      value={newTagInput}
                      onChange={(e) => setNewTagInput(e.target.value)}
                      placeholder="Add or create tag..."
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleAddTag();
                        }
                      }}
                      data-testid="input-new-tag"
                    />
                    <Button type="button" size="icon" onClick={handleAddTag} data-testid="button-add-tag">
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                  {tags.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {tags.map((tag) => (
                        <Badge
                          key={tag.id}
                          variant={selectedTags.includes(tag.name) ? "default" : "outline"}
                          className="cursor-pointer"
                          onClick={() => {
                            setSelectedTags(prev =>
                              prev.includes(tag.name)
                                ? prev.filter(t => t !== tag.name)
                                : [...prev, tag.name]
                            );
                          }}
                          data-testid={`tag-${tag.name}`}
                        >
                          {tag.name}
                          {selectedTags.includes(tag.name) && (
                            <X className="h-3 w-3 ml-1" />
                          )}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {selectedTags.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Selected: {selectedTags.join(", ")}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label>Categories</Label>
                  <div className="flex gap-2">
                    <Input
                      value={newCategoryInput}
                      onChange={(e) => setNewCategoryInput(e.target.value)}
                      placeholder="Add or create category..."
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleAddCategory();
                        }
                      }}
                      data-testid="input-new-category"
                    />
                    <Button type="button" size="icon" onClick={handleAddCategory} data-testid="button-add-category">
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                  {categories.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {categories.map((cat) => (
                        <Badge
                          key={cat.id}
                          variant={selectedCategories.includes(cat.name) ? "default" : "outline"}
                          className="cursor-pointer"
                          onClick={() => {
                            setSelectedCategories(prev =>
                              prev.includes(cat.name)
                                ? prev.filter(c => c !== cat.name)
                                : [...prev, cat.name]
                            );
                          }}
                          data-testid={`category-${cat.name}`}
                        >
                          {cat.name}
                          {selectedCategories.includes(cat.name) && (
                            <X className="h-3 w-3 ml-1" />
                          )}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {selectedCategories.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Selected: {selectedCategories.join(", ")}
                    </p>
                  )}
                </div>
              </div>

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
              ) : dualChainResult && (
                <>
                  <div className="p-3 bg-muted rounded-md mb-4">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium">
                        Total: {totalSelectedAddresses} addresses selected
                      </p>
                      <div className="flex gap-2">
                        {dualChainResult.change.length > 0 ? (
                          <>
                            <Badge variant="secondary">{selectedReceiveAddresses.size} receive</Badge>
                            <Badge variant="outline">{selectedChangeAddresses.size} change</Badge>
                          </>
                        ) : (
                          <Badge variant="secondary">{selectedReceiveAddresses.size} addresses</Badge>
                        )}
                      </div>
                    </div>
                    {dualChainResult.change.length === 0 && (
                      <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">
                        Chain-level key: only single chain derivation available
                      </p>
                    )}
                  </div>

                  <div className="space-y-4">
                    <div className="border rounded-lg overflow-hidden">
                      <div className="bg-primary/10 p-3 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            checked={selectedReceiveAddresses.size === dualChainResult.receive.length}
                            onCheckedChange={toggleAllReceiveAddresses}
                            data-testid="checkbox-select-all-receive"
                          />
                          <Label className="cursor-pointer font-medium" onClick={toggleAllReceiveAddresses}>
                            {dualChainResult.change.length > 0 ? 'Receive Addresses (External)' : 'Derived Addresses'}
                          </Label>
                          <Badge variant="secondary" className="text-xs">
                            {selectedReceiveAddresses.size}/{dualChainResult.receive.length}
                          </Badge>
                        </div>
                      </div>
                      <div className="space-y-2 max-h-[200px] overflow-y-auto p-2">
                        {dualChainResult.receive.map((addr, index) => (
                          <div
                            key={`receive-${index}`}
                            className={`flex items-center gap-3 p-3 border rounded hover-elevate ${
                              selectedReceiveAddresses.has(index) ? "bg-primary/5 border-primary/30" : ""
                            }`}
                            data-testid={`address-preview-receive-${index}`}
                          >
                            <Checkbox
                              checked={selectedReceiveAddresses.has(index)}
                              onCheckedChange={() => toggleReceiveSelection(index)}
                              data-testid={`checkbox-receive-${index}`}
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1">
                                <Badge variant="outline" className="text-xs">
                                  #{addr.index}
                                </Badge>
                                <code className="text-xs text-muted-foreground">{addr.path}</code>
                              </div>
                              <code className="text-sm font-mono break-all">{addr.address}</code>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {dualChainResult.change.length > 0 && (
                      <div className="border rounded-lg overflow-hidden">
                        <div 
                          className="bg-muted p-3 flex items-center justify-between cursor-pointer hover-elevate"
                          onClick={() => setShowChangeAddresses(!showChangeAddresses)}
                          data-testid="toggle-change-addresses"
                        >
                          <div className="flex items-center gap-2">
                            <Checkbox
                              checked={selectedChangeAddresses.size === dualChainResult.change.length}
                              onCheckedChange={() => toggleAllChangeAddresses()}
                              onClick={(e) => e.stopPropagation()}
                              data-testid="checkbox-select-all-change"
                            />
                            <Label className="cursor-pointer font-medium">
                              Change Addresses (Internal)
                            </Label>
                            <Badge variant="outline" className="text-xs">
                              {selectedChangeAddresses.size}/{dualChainResult.change.length}
                            </Badge>
                          </div>
                          <Button variant="ghost" size="sm">
                            {showChangeAddresses ? (
                              <>Hide <ChevronUp className="h-4 w-4 ml-1" /></>
                            ) : (
                              <>Show <ChevronDown className="h-4 w-4 ml-1" /></>
                            )}
                          </Button>
                        </div>
                        {showChangeAddresses && (
                          <div className="space-y-2 max-h-[200px] overflow-y-auto p-2">
                            {dualChainResult.change.map((addr, index) => (
                              <div
                                key={`change-${index}`}
                                className={`flex items-center gap-3 p-3 border rounded hover-elevate ${
                                  selectedChangeAddresses.has(index) ? "bg-primary/5 border-primary/30" : ""
                                }`}
                                data-testid={`address-preview-change-${index}`}
                              >
                                <Checkbox
                                  checked={selectedChangeAddresses.has(index)}
                                  onCheckedChange={() => toggleChangeSelection(index)}
                                  data-testid={`checkbox-change-${index}`}
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-1">
                                    <Badge variant="outline" className="text-xs">
                                      #{addr.index}
                                    </Badge>
                                    <code className="text-xs text-muted-foreground">{addr.path}</code>
                                  </div>
                                  <code className="text-sm font-mono break-all">{addr.address}</code>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {(seedName || walletSoftware || notes || privateKeyStatus || selectedTags.length > 0 || selectedCategories.length > 0) && (
                    <div className="p-3 bg-muted rounded-md">
                      <p className="text-sm font-medium mb-2">Applied Metadata:</p>
                      <div className="text-sm text-muted-foreground space-y-1">
                        {seedName && <p>Seed Name: {seedName}</p>}
                        {walletSoftware && <p>Wallet: {walletSoftware}</p>}
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

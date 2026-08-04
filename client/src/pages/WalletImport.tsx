import { useState, useCallback, useEffect } from 'react';
import { useDropzone } from 'react-dropzone';
import { 
  Upload, 
  FileText, 
  Settings2, 
  Eye, 
  CheckCircle, 
  AlertCircle, 
  ArrowRight, 
  ArrowLeft,
  Plus,
  RefreshCw,
  FileJson,
  FileSpreadsheet,
  ShieldCheck,
  Info,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { describeKeptFieldCounts } from '@/lib/descriptor-import-utils';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  Select, 
  SelectContent, 
  SelectItem, 
  SelectTrigger, 
  SelectValue 
} from '@/components/ui/select';
import { MultiSelectCombobox } from '@/components/ui/multi-select-combobox';
import { useToast } from '@/hooks/use-toast';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/database';
import { useSeedNames, createSeedName, SEED_NAME_MAX_LENGTH } from '@/hooks/use-seed-names';
import { useOwners, createOwner } from '@/hooks/use-owners';
import { useWalletNames, createWalletName } from '@/hooks/use-wallet-names';
import { useWalletSoftware, createWalletSoftware } from '@/hooks/use-wallet-software';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Check, ChevronsUpDown, Wallet } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  detectWalletType,
  parseFile,
  analyzeRecords,
  executeImport,
  getSupportedWallets,
  getWalletName,
  scanForPrivateKeys,
  type WalletType,
  type FileFormat,
  type ParsedRecord,
  type DuplicateInfo,
  type ImportResult,
  type DetectionResult,
} from '@/lib/wallet-import/import-manager';
import { getImportSummary } from '@/lib/wallet-import/merge-utils';
import { expandLabelTokens, hasTokens, AVAILABLE_TOKENS } from '@/lib/label-tokens';

type WizardStep = 'upload' | 'setup' | 'preview' | 'import';

const generateSourceName = (walletType: WalletType): string => {
  const walletName = getWalletName(walletType);
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const time = now.toTimeString().split(' ')[0].replace(/:/g, '');
  return `walletImport-${walletName}_${date}_${time}`;
};

const STEPS: { key: WizardStep; label: string; icon: typeof Upload }[] = [
  { key: 'upload', label: 'Upload', icon: Upload },
  { key: 'setup', label: 'Setup', icon: Settings2 },
  { key: 'preview', label: 'Preview', icon: Eye },
  { key: 'import', label: 'Import', icon: CheckCircle },
];

export default function WalletImport() {
  const { toast } = useToast();
  
  const [currentStep, setCurrentStep] = useState<WizardStep>('upload');
  const [fileContent, setFileContent] = useState<string>('');
  const [fileName, setFileName] = useState<string>('');
  const [detectionResult, setDetectionResult] = useState<DetectionResult | null>(null);
  const [selectedWalletType, setSelectedWalletType] = useState<WalletType>('unknown');
  const [selectedFileFormat, setSelectedFileFormat] = useState<FileFormat>('csv');
  
  const [ownerInput, setOwnerInput] = useState<string>('');
  const [walletNameInput, setWalletNameInput] = useState<string>('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  
  const [parsedRecords, setParsedRecords] = useState<ParsedRecord[]>([]);
  const [duplicateInfos, setDuplicateInfos] = useState<DuplicateInfo[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  
  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(0);
  const [importStatus, setImportStatus] = useState('');
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  
  const [markInputsAsVerified, setMarkInputsAsVerified] = useState(false);
  const [privateKeyStatus, setPrivateKeyStatus] = useState<string>('');
  const [labelPrefix, setLabelPrefix] = useState<string>('');
  
  // Vault metadata state
  const [isVaultImport, setIsVaultImport] = useState(false);
  const [vaultName, setVaultName] = useState('');
  const [vaultM, setVaultM] = useState<number | null>(null);
  const [vaultN, setVaultN] = useState<number | null>(null);
  const [vaultNotes, setVaultNotes] = useState('');
  
  // Seed name state
  const [seedNameInput, setSeedNameInput] = useState<string>('');
  const [seedNameOpen, setSeedNameOpen] = useState(false);
  const [newSeedName, setNewSeedName] = useState<string>('');
  const { seedNames } = useSeedNames();
  const allSeedNames = Array.from(new Set([
    ...seedNames.map(s => s.name).filter(n => n),
    seedNameInput
  ].filter(Boolean)));
  
  // Owner state
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [newOwnerName, setNewOwnerName] = useState<string>('');
  const { owners } = useOwners();
  const allOwners = Array.from(new Set([
    ...owners.map(o => o.name).filter(n => n),
    ownerInput
  ].filter(Boolean)));
  
  // Wallet name state
  const [walletNameOpen, setWalletNameOpen] = useState(false);
  const [newWalletNameValue, setNewWalletNameValue] = useState<string>('');
  const { walletNames } = useWalletNames();
  const allWalletNames = Array.from(new Set([
    ...walletNames.map(wn => wn.name).filter(n => n),
    walletNameInput
  ].filter(Boolean)));
  
  // Wallet software state (with override capability)
  const [walletSoftwareInput, setWalletSoftwareInput] = useState<string>('');
  const [walletSoftwareOpen, setWalletSoftwareOpen] = useState(false);
  const [newWalletSoftwareName, setNewWalletSoftwareName] = useState<string>('');
  const { walletSoftware: existingWalletSoftware } = useWalletSoftware();
  
  const addNewSeedName = async () => {
    if (!newSeedName.trim()) return;
    if (newSeedName.trim().length > SEED_NAME_MAX_LENGTH) {
      toast({
        title: 'Seed name too long',
        description: `Seed names are limited to ${SEED_NAME_MAX_LENGTH} characters to prevent accidental seed phrase entry`,
        variant: 'destructive',
      });
      return;
    }
    try {
      await createSeedName(newSeedName.trim());
      setSeedNameInput(newSeedName.trim());
      setNewSeedName('');
      setSeedNameOpen(false);
    } catch (e) {
      toast({
        title: 'Error',
        description: e instanceof Error ? e.message : 'Failed to add seed name',
        variant: 'destructive',
      });
    }
  };
  
  const addNewOwner = async () => {
    if (!newOwnerName.trim()) return;
    try {
      await createOwner(newOwnerName.trim());
      setOwnerInput(newOwnerName.trim());
      setNewOwnerName('');
      setOwnerOpen(false);
    } catch (e) {
      toast({
        title: 'Error',
        description: e instanceof Error ? e.message : 'Failed to add owner',
        variant: 'destructive',
      });
    }
  };
  
  const addNewWalletName = async () => {
    if (!newWalletNameValue.trim()) return;
    try {
      await createWalletName(newWalletNameValue.trim());
      setWalletNameInput(newWalletNameValue.trim());
      setNewWalletNameValue('');
      setWalletNameOpen(false);
    } catch (e) {
      toast({
        title: 'Error',
        description: e instanceof Error ? e.message : 'Failed to add wallet name',
        variant: 'destructive',
      });
    }
  };
  
  const addNewWalletSoftware = async () => {
    if (!newWalletSoftwareName.trim()) return;
    try {
      await createWalletSoftware(newWalletSoftwareName.trim());
      setWalletSoftwareInput(newWalletSoftwareName.trim());
      setNewWalletSoftwareName('');
      setWalletSoftwareOpen(false);
    } catch (e) {
      toast({
        title: 'Error',
        description: e instanceof Error ? e.message : 'Failed to add wallet software',
        variant: 'destructive',
      });
    }
  };
  
  // Build wallet software options: detected + existing + current input
  const detectedWalletSoftware = getWalletName(selectedWalletType);
  const allWalletSoftwareOptions = Array.from(new Set([
    detectedWalletSoftware,
    ...existingWalletSoftware.map(ws => ws.name).filter(n => n),
    walletSoftwareInput
  ].filter(Boolean)));
  
  
  const encryptedTags = useLiveQuery(() => db.tags.toArray());
  const encryptedCategories = useLiveQuery(() => db.categories.toArray());
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [availableCategories, setAvailableCategories] = useState<string[]>([]);
  
  useEffect(() => {
    if (encryptedTags) {
      setAvailableTags(encryptedTags.map(t => t.name));
    }
    
    if (encryptedCategories) {
      setAvailableCategories(encryptedCategories.map(c => c.name));
    }
  }, [encryptedTags, encryptedCategories]);
  
  const supportedWallets = getSupportedWallets();
  
  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0) return;
    
    const file = acceptedFiles[0];
    setFileName(file.name);
    
    try {
      const content = await file.text();
      
      const privateKeyScan = scanForPrivateKeys(content);
      if (privateKeyScan.hasPrivateKeys) {
        toast({
          title: 'Security Warning - File Rejected',
          description: `This file appears to contain private key material and cannot be imported. ${privateKeyScan.warnings.join('. ')}. Please use a transaction history or label export instead.`,
          variant: 'destructive',
        });
        setFileName('');
        setFileContent('');
        return;
      }
      
      setFileContent(content);
      
      const detection = detectWalletType(content, file.name);
      setDetectionResult(detection);
      setSelectedWalletType(detection.walletType);
      setSelectedFileFormat(detection.fileFormat);
      
      // Auto-set wallet software from detection only if not already set (preserves manual overrides)
      if (detection.walletType !== 'unknown' && !walletSoftwareInput) {
        setWalletSoftwareInput(getWalletName(detection.walletType));
      }
      
      toast({
        title: 'File loaded',
        description: detection.walletType !== 'unknown'
          ? `Detected ${getWalletName(detection.walletType)} ${detection.fileFormat.toUpperCase()} export`
          : 'Please select the source type manually',
      });
    } catch (e) {
      toast({
        title: 'Error reading file',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  }, [toast, walletSoftwareInput]);
  
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'text/csv': ['.csv'],
      'application/json': ['.json', '.jsonl'],
      'text/plain': ['.txt', '.jsonl'],
    },
    multiple: false,
  });
  
  const handleNextStep = async () => {
    const stepIndex = STEPS.findIndex(s => s.key === currentStep);
    
    if (currentStep === 'upload') {
      if (!fileContent) {
        toast({
          title: 'No file selected',
          description: 'Please upload a label or transaction export file',
          variant: 'destructive',
        });
        return;
      }
      if (selectedWalletType === 'unknown') {
        toast({
          title: 'Source type required',
          description: 'Please select the source type',
          variant: 'destructive',
        });
        return;
      }
      setCurrentStep('setup');
    } else if (currentStep === 'setup') {
      setIsAnalyzing(true);
      try {
        const parseResult = parseFile(fileContent, selectedWalletType, selectedFileFormat);
        
        if (!parseResult.success) {
          toast({
            title: 'Parse error',
            description: parseResult.errors.join(', ') || 'Failed to parse file',
            variant: 'destructive',
          });
          setIsAnalyzing(false);
          return;
        }
        
        if (parseResult.records.length === 0) {
          toast({
            title: 'No records found',
            description: 'The file appears to be empty or has no valid records',
            variant: 'destructive',
          });
          setIsAnalyzing(false);
          return;
        }
        
        setParsedRecords(parseResult.records);
        
        const duplicates = await analyzeRecords(parseResult.records);
        setDuplicateInfos(duplicates);
        
        setCurrentStep('preview');
      } catch (e) {
        toast({
          title: 'Analysis error',
          description: e instanceof Error ? e.message : 'Unknown error',
          variant: 'destructive',
        });
      } finally {
        setIsAnalyzing(false);
      }
    } else if (currentStep === 'preview') {
      setCurrentStep('import');
      handleImport();
    }
  };
  
  const handlePrevStep = () => {
    const stepIndex = STEPS.findIndex(s => s.key === currentStep);
    if (stepIndex > 0) {
      setCurrentStep(STEPS[stepIndex - 1].key);
    }
  };
  
  const handleImport = async () => {
    setIsImporting(true);
    setImportProgress(0);
    setImportStatus('Starting import...');
    
    try {
      const sourceName = generateSourceName(selectedWalletType);
      const effectiveWalletSoftware = walletSoftwareInput || getWalletName(selectedWalletType);
      const result = await executeImport(
        duplicateInfos,
        {
          sourceName,
          owner: ownerInput || undefined,
          walletName: walletNameInput || undefined,
          defaultTags: selectedTags,
          defaultCategories: selectedCategories,
          walletSoftware: effectiveWalletSoftware,
          seedName: seedNameInput || undefined,
          markInputsAsVerified,
          privateKeyStatus: privateKeyStatus || undefined,
          labelPrefix: labelPrefix || undefined,
          vault: isVaultImport ? {
            isVaultXpub: true,
            vaultName: vaultName || null,
            m: vaultM,
            n: vaultN,
            vaultNotes: vaultNotes || null,
          } : undefined,
        },
        (current, total, status) => {
          setImportProgress(Math.round((current / total) * 100));
          setImportStatus(status);
        }
      );
      
      setImportResult(result);
      setImportProgress(100);
      setImportStatus('Import complete!');
      
      toast({
        title: 'Import complete',
        description:
          `Created ${result.newRecords} new, updated ${result.updatedRecords} existing records` +
          (result.reattributedRecords > 0
            ? ` — ${result.reattributedRecords} re-attributed from other wallets`
            : ''),
      });
    } catch (e) {
      toast({
        title: 'Import failed',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setIsImporting(false);
    }
  };
  
  const handleReset = () => {
    setCurrentStep('upload');
    setFileContent('');
    setFileName('');
    setDetectionResult(null);
    setSelectedWalletType('unknown');
    setSelectedFileFormat('csv');
    setOwnerInput('');
    setWalletNameInput('');
    setSeedNameInput('');
    setWalletSoftwareInput('');
    setSelectedTags([]);
    setSelectedCategories([]);
    setParsedRecords([]);
    setDuplicateInfos([]);
    setImportResult(null);
    setImportProgress(0);
    setImportStatus('');
    setMarkInputsAsVerified(false);
    setPrivateKeyStatus('');
    setLabelPrefix('');
    setIsVaultImport(false);
    setVaultName('');
    setVaultM(null);
    setVaultN(null);
    setVaultNotes('');
  };
  
  
  const summary = duplicateInfos.length > 0 ? getImportSummary(duplicateInfos) : null;
  
  const renderStepIndicator = () => (
    <div className="flex items-center justify-center mb-8">
      {STEPS.map((step, index) => {
        const isActive = step.key === currentStep;
        const isPast = STEPS.findIndex(s => s.key === currentStep) > index;
        const Icon = step.icon;
        
        return (
          <div key={step.key} className="flex items-center">
            <div
              className={`flex items-center justify-center w-10 h-10 rounded-full border-2 transition-colors ${
                isActive
                  ? 'border-primary bg-primary text-primary-foreground'
                  : isPast
                  ? 'border-primary bg-primary/20 text-primary'
                  : 'border-muted-foreground/30 text-muted-foreground'
              }`}
            >
              <Icon className="w-5 h-5" />
            </div>
            <span className={`ml-2 text-sm font-medium ${isActive ? 'text-foreground' : 'text-muted-foreground'}`}>
              {step.label}
            </span>
            {index < STEPS.length - 1 && (
              <div className={`w-12 h-0.5 mx-4 ${isPast ? 'bg-primary' : 'bg-muted-foreground/30'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
  
  const renderUploadStep = () => (
    <div className="space-y-6">
      <Card className="border-amber-500/50 bg-amber-500/5">
        <CardContent className="pt-4">
          <div className="flex gap-3">
            <ShieldCheck className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
            <div className="text-sm space-y-2">
              <p className="font-medium text-amber-700 dark:text-amber-400">Safe Export Instructions</p>
              <ul className="text-muted-foreground space-y-1 list-disc list-inside">
                <li><strong>Sparrow:</strong> Use File &rarr; Export Wallet &rarr; Wallet Labels (BIP-329 .jsonl)</li>
                <li><strong>Trezor Suite:</strong> Use the transaction history CSV export</li>
                <li><strong>Mycelium:</strong> Use the transaction history export</li>
              </ul>
              <p className="text-xs text-muted-foreground/80">
                Never import wallet backup files. Files containing private keys will be rejected.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div
        {...getRootProps()}
        className={`border-2 border-dashed rounded-lg p-12 text-center cursor-pointer transition-colors ${
          isDragActive ? 'border-primary bg-primary/10' : 'border-muted-foreground/30 hover:border-primary/50'
        }`}
        data-testid="dropzone-wallet-import"
      >
        <input {...getInputProps()} data-testid="input-file-upload" />
        <Upload className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
        <p className="text-lg font-medium mb-2">
          {isDragActive ? 'Drop the file here' : 'Drag & drop label or transaction export file'}
        </p>
        <p className="text-sm text-muted-foreground">
          Supports BIP-329 labels (.jsonl), CSV and JSON exports from Trezor Suite, Sparrow Wallet, and Mycelium
        </p>
      </div>
      
      {fileName && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              {selectedFileFormat === 'json' ? (
                <FileJson className="w-5 h-5 text-primary" />
              ) : (
                <FileSpreadsheet className="w-5 h-5 text-primary" />
              )}
              {fileName}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="wallet-type">Wallet Type</Label>
                <Select
                  value={selectedWalletType}
                  onValueChange={(value) => {
                    setSelectedWalletType(value as WalletType);
                  }}
                >
                  <SelectTrigger id="wallet-type" data-testid="select-wallet-type">
                    <SelectValue placeholder="Select wallet" />
                  </SelectTrigger>
                  <SelectContent>
                    {supportedWallets.map(wallet => (
                      <SelectItem key={wallet.type} value={wallet.type}>
                        {wallet.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="file-format">File Format</Label>
                <Select
                  value={selectedFileFormat}
                  onValueChange={(value) => setSelectedFileFormat(value as FileFormat)}
                >
                  <SelectTrigger id="file-format" data-testid="select-file-format">
                    <SelectValue placeholder="Select format" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="csv">CSV</SelectItem>
                    <SelectItem value="json">JSON</SelectItem>
                    <SelectItem value="jsonl">JSONL (BIP-329)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            
            {detectionResult && detectionResult.confidence > 0.5 && (
              <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle className="w-4 h-4 text-green-500" />
                Auto-detected as {getWalletName(detectionResult.walletType)} {detectionResult.fileFormat.toUpperCase()} 
                ({Math.round(detectionResult.confidence * 100)}% confidence)
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
  
  const renderSetupStep = () => (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Import Settings</CardTitle>
          <CardDescription>Configure how the records will be imported</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="p-3 bg-muted/50 rounded-md border border-muted-foreground/20 mb-4">
            <p className="text-sm text-muted-foreground">
              <strong>What gets applied where:</strong> Owner, wallet name, tags, and categories apply only to input addresses (your addresses that received funds). Output addresses (counterparties) get owner='Unknown' and can be tagged individually later.
            </p>
          </div>

          {/* Label Prefix Section */}
          <div className="space-y-2">
            <Label htmlFor="label-prefix">Label Prefix (optional)</Label>
            <Input
              id="label-prefix"
              value={labelPrefix}
              onChange={(e) => setLabelPrefix(e.target.value)}
              placeholder="e.g., [wallet] - or [date] Import"
              data-testid="input-label-prefix"
            />
            <div className="text-xs text-muted-foreground">
              <p>Add a prefix to all imported labels. Available tokens:</p>
              <ul className="list-disc list-inside ml-2 mt-1">
                <li><code className="bg-muted px-1 rounded">[date]</code> Today's date (YYYY-MM-DD)</li>
                <li><code className="bg-muted px-1 rounded">[wallet]</code> Wallet name from below</li>
                <li><code className="bg-muted px-1 rounded">[id]</code> First 8 characters of address/txid</li>
              </ul>
              {labelPrefix && (
                <p className="mt-2">
                  Preview: <span className="font-mono">{expandLabelTokens(labelPrefix, { index: 0, totalCount: 1, walletName: walletNameInput || 'MyWallet', recordId: 'bc1qexample123456789' })}</span>
                </p>
              )}
            </div>
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
                        value={newOwnerName}
                        onValueChange={setNewOwnerName}
                      />
                      <CommandList>
                        <CommandEmpty>
                          {newOwnerName && (
                            <Button
                              variant="ghost"
                              className="w-full justify-start"
                              onClick={addNewOwner}
                            >
                              <Plus className="mr-2 h-4 w-4" />
                              Add "{newOwnerName}"
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
                          {newOwnerName && !allOwners.some(n => n.toLowerCase() === newOwnerName.toLowerCase()) && (
                            <CommandItem
                              value={`create-${newOwnerName}`}
                              onSelect={addNewOwner}
                            >
                              <Plus className="mr-2 h-4 w-4" />
                              Add "{newOwnerName}"
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
                    checked={markInputsAsVerified}
                    onCheckedChange={setMarkInputsAsVerified}
                    data-testid="switch-mark-verified"
                  />
                  <span className="text-sm text-muted-foreground">
                    {markInputsAsVerified ? "Ownership confirmed" : "Not verified"}
                  </span>
                </div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Turn on if you are certain about who owns these addresses. This confirms attribution certainty, not private key possession.
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
                <Popover open={seedNameOpen} onOpenChange={setSeedNameOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={seedNameOpen}
                      className="w-full justify-between font-normal"
                      data-testid="select-seed-name"
                    >
                      {seedNameInput || "Select or add..."}
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-full p-0" align="start">
                    <Command>
                      <CommandInput 
                        placeholder="Search or add new..." 
                        value={newSeedName}
                        onValueChange={(val) => setNewSeedName(val.slice(0, SEED_NAME_MAX_LENGTH))}
                        maxLength={SEED_NAME_MAX_LENGTH}
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
                                setSeedNameInput(name);
                                setSeedNameOpen(false);
                              }}
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4",
                                  seedNameInput === name ? "opacity-100" : "opacity-0"
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
                <Popover open={walletSoftwareOpen} onOpenChange={setWalletSoftwareOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={walletSoftwareOpen}
                      className="w-full justify-between font-normal"
                      data-testid="select-wallet-software"
                    >
                      {walletSoftwareInput || detectedWalletSoftware || "Select or add..."}
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-full p-0" align="start">
                    <Command>
                      <CommandInput 
                        placeholder="Search or add new..." 
                        value={newWalletSoftwareName}
                        onValueChange={setNewWalletSoftwareName}
                      />
                      <CommandList>
                        <CommandEmpty>
                          {newWalletSoftwareName && (
                            <Button
                              variant="ghost"
                              className="w-full justify-start"
                              onClick={addNewWalletSoftware}
                            >
                              <Plus className="mr-2 h-4 w-4" />
                              Add "{newWalletSoftwareName}"
                            </Button>
                          )}
                        </CommandEmpty>
                        <CommandGroup>
                          {allWalletSoftwareOptions.map((name) => (
                            <CommandItem
                              key={name}
                              value={name}
                              onSelect={() => {
                                setWalletSoftwareInput(name);
                                setWalletSoftwareOpen(false);
                              }}
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4",
                                  (walletSoftwareInput || detectedWalletSoftware) === name ? "opacity-100" : "opacity-0"
                                )}
                              />
                              {name}
                              {name === detectedWalletSoftware && !walletSoftwareInput && (
                                <span className="ml-2 text-xs text-muted-foreground">(detected)</span>
                              )}
                            </CommandItem>
                          ))}
                          {newWalletSoftwareName && !allWalletSoftwareOptions.some(n => n.toLowerCase() === newWalletSoftwareName.toLowerCase()) && (
                            <CommandItem
                              value={`create-${newWalletSoftwareName}`}
                              onSelect={addNewWalletSoftware}
                            >
                              <Plus className="mr-2 h-4 w-4" />
                              Add "{newWalletSoftwareName}"
                            </CommandItem>
                          )}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                {!walletSoftwareInput && detectedWalletSoftware && (
                  <p className="text-xs text-muted-foreground">Auto-detected from file. Select to override.</p>
                )}
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
                        value={newWalletNameValue}
                        onValueChange={setNewWalletNameValue}
                      />
                      <CommandList>
                        <CommandEmpty>
                          {newWalletNameValue && (
                            <Button
                              variant="ghost"
                              className="w-full justify-start"
                              onClick={addNewWalletName}
                            >
                              <Plus className="mr-2 h-4 w-4" />
                              Add "{newWalletNameValue}"
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
                          {newWalletNameValue && !allWalletNames.some(n => n.toLowerCase() === newWalletNameValue.toLowerCase()) && (
                            <CommandItem
                              value={`create-${newWalletNameValue}`}
                              onSelect={addNewWalletName}
                            >
                              <Plus className="mr-2 h-4 w-4" />
                              Add "{newWalletNameValue}"
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
                  value={privateKeyStatus}
                  onValueChange={setPrivateKeyStatus}
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
              Do you have the private keys to spend from these addresses?
            </p>
          </div>

          {/* Vault Metadata Section */}
          <div className="space-y-3 p-4 bg-muted/30 rounded-lg border">
            <div className="flex items-center justify-between">
              <h5 className="font-medium text-sm flex items-center gap-2">
                <ShieldCheck className="h-4 w-4" />
                Multisig Vault (Optional)
              </h5>
              <Switch
                id="is-vault"
                checked={isVaultImport}
                onCheckedChange={setIsVaultImport}
                data-testid="switch-is-vault"
              />
            </div>
            {isVaultImport && (
              <div className="space-y-4 mt-3">
                <div className="grid grid-cols-2 gap-4">
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
                    <Label>M-of-N Signature Requirement</Label>
                    <div className="flex items-center gap-2">
                      <Select
                        value={vaultM?.toString() || ""}
                        onValueChange={(value) => setVaultM(value ? parseInt(value) : null)}
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
                    data-testid="input-vault-notes"
                  />
                </div>
              </div>
            )}
          </div>
          
          <div className="space-y-2">
            <Label>Default Tags</Label>
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
            <Label>Default Categories</Label>
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

        </CardContent>
      </Card>
    </div>
  );
  
  const renderPreviewStep = () => (
    <div className="space-y-6">
      {summary && (
        <div className="grid grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold text-green-600">{summary.newCount}</div>
              <div className="text-sm text-muted-foreground">New Records</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold text-blue-600">{summary.mergeCount}</div>
              <div className="text-sm text-muted-foreground">Will Merge</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold">{summary.transactionCount}</div>
              <div className="text-sm text-muted-foreground">Transactions</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold">{summary.addressCount}</div>
              <div className="text-sm text-muted-foreground">Addresses</div>
            </CardContent>
          </Card>
        </div>
      )}
      
      <Card>
        <CardHeader>
          <CardTitle>Records to Import</CardTitle>
          <CardDescription>
            Review the records that will be created or updated
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[400px]">
            <div className="space-y-2">
              {duplicateInfos.map((info, index) => (
                <div
                  key={index}
                  className={`p-3 rounded-lg border ${
                    info.isNew ? 'border-green-500/30 bg-green-500/5' : 'border-blue-500/30 bg-blue-500/5'
                  }`}
                  data-testid={`preview-record-${index}`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant={info.parsedRecord.type === 'transaction' ? 'default' : 'secondary'}>
                          {info.parsedRecord.type}
                        </Badge>
                        <Badge variant={info.isNew ? 'outline' : 'secondary'} className={info.isNew ? 'border-green-500 text-green-600' : 'border-blue-500 text-blue-600'}>
                          {info.isNew ? 'New' : 'Merge'}
                        </Badge>
                      </div>
                      <div className="font-mono text-sm truncate" title={info.parsedRecord.inputString}>
                        {info.parsedRecord.inputString}
                      </div>
                      {info.parsedRecord.label && (
                        <div className="text-sm text-muted-foreground mt-1">
                          {info.parsedRecord.label}
                        </div>
                      )}
                    </div>
                    <div className="text-right text-sm">
                      {info.parsedRecord.amount !== undefined && (
                        <div className="font-medium">
                          {info.parsedRecord.direction === 'outgoing' ? '-' : ''}
                          {info.parsedRecord.amount.toFixed(8)} BTC
                        </div>
                      )}
                      {info.parsedRecord.date && (
                        <div className="text-muted-foreground">{info.parsedRecord.date}</div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
  
  const renderImportStep = () => (
    <div className="space-y-6">
      {isImporting && (
        <Card>
          <CardContent className="pt-6">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Importing records...</span>
                <span className="text-sm text-muted-foreground">{importProgress}%</span>
              </div>
              <Progress value={importProgress} />
              <p className="text-sm text-muted-foreground">{importStatus}</p>
            </div>
          </CardContent>
        </Card>
      )}
      
      {importResult && (
        <div className="space-y-6">
          <div className="text-center py-8">
            <CheckCircle className="w-16 h-16 mx-auto text-green-500 mb-4" />
            <h2 className="text-2xl font-bold mb-2">Import Complete!</h2>
            <p className="text-muted-foreground">Your wallet data has been imported successfully</p>
          </div>
          
          <div className="grid grid-cols-4 gap-4">
            <Card>
              <CardContent className="pt-4">
                <div className="text-2xl font-bold text-green-600">{importResult.newRecords}</div>
                <div className="text-sm text-muted-foreground">Created</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <div className="text-2xl font-bold text-blue-600">{importResult.updatedRecords}</div>
                <div className="text-sm text-muted-foreground">Updated</div>
              </CardContent>
            </Card>
            {importResult.reattributedRecords > 0 && (
              <Card className="border-orange-500/50" data-testid="card-reattributed">
                <CardContent className="pt-4">
                  <div className="text-2xl font-bold text-orange-600" data-testid="text-reattributed-count">{importResult.reattributedRecords}</div>
                  <div className="text-sm text-muted-foreground">Re-attributed</div>
                  <div className="text-xs text-muted-foreground mt-1">Moved from another wallet</div>
                </CardContent>
              </Card>
            )}
            <Card>
              <CardContent className="pt-4">
                <div className="text-2xl font-bold text-yellow-600">{importResult.skippedRecords}</div>
                <div className="text-sm text-muted-foreground">Skipped</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <div className="text-2xl font-bold text-red-600">{importResult.failedRecords}</div>
                <div className="text-sm text-muted-foreground">Failed</div>
              </CardContent>
            </Card>
          </div>
          
          {describeKeptFieldCounts(importResult.keptFieldCounts).length > 0 && (
            <Alert data-testid="alert-metadata-kept">
              <Info className="h-4 w-4" />
              <AlertTitle>Some existing metadata was kept</AlertTitle>
              <AlertDescription>
                <p className="mb-2">
                  For records that already existed in your vault, the values below were
                  already set, so your entries were not applied to them (tags and categories
                  were merged everywhere):
                </p>
                <ul className="list-disc list-inside space-y-1 text-sm">
                  {describeKeptFieldCounts(importResult.keptFieldCounts).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                <p className="mt-2 text-xs">
                  Use the Bulk Editor if you want to overwrite existing values.
                </p>
              </AlertDescription>
            </Alert>
          )}
          
          {importResult.errors.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-red-500" />
                  Errors
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[150px]">
                  <ul className="space-y-1 text-sm text-muted-foreground">
                    {importResult.errors.map((error, i) => (
                      <li key={i}>{error}</li>
                    ))}
                  </ul>
                </ScrollArea>
              </CardContent>
            </Card>
          )}
          
          <div className="flex justify-center">
            <Button onClick={handleReset} className="gap-2" data-testid="button-import-another">
              <RefreshCw className="w-4 h-4" />
              Import Another File
            </Button>
          </div>
        </div>
      )}
    </div>
  );
  
  const canProceed = () => {
    switch (currentStep) {
      case 'upload':
        return fileContent && selectedWalletType !== 'unknown';
      case 'setup':
        return true;
      case 'preview':
        return duplicateInfos.length > 0;
      default:
        return false;
    }
  };
  
  return (
    <div className="flex-1 p-6 overflow-auto">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <h1 className="text-2xl font-bold">Wallet Data Sync</h1>
          <p className="text-muted-foreground">
            Import labels and transaction history from popular Bitcoin wallet software
          </p>
        </div>
        
        {renderStepIndicator()}
        
        {currentStep === 'upload' && renderUploadStep()}
        {currentStep === 'setup' && renderSetupStep()}
        {currentStep === 'preview' && renderPreviewStep()}
        {currentStep === 'import' && renderImportStep()}
        
        {currentStep !== 'import' && (
          <div className="flex justify-between mt-8">
            <Button
              variant="outline"
              onClick={handlePrevStep}
              disabled={currentStep === 'upload'}
              className="gap-2"
              data-testid="button-prev-step"
            >
              <ArrowLeft className="w-4 h-4" />
              Back
            </Button>
            <Button
              onClick={handleNextStep}
              disabled={!canProceed() || isAnalyzing}
              className="gap-2"
              data-testid="button-next-step"
            >
              {isAnalyzing ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Analyzing...
                </>
              ) : currentStep === 'preview' ? (
                <>
                  Start Import
                  <CheckCircle className="w-4 h-4" />
                </>
              ) : (
                <>
                  Next
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

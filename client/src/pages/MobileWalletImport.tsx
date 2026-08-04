import { useState, useCallback, useEffect } from 'react';
import { Link } from 'wouter';
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
  FileSpreadsheet,
  ShieldCheck,
  Smartphone,
  Zap,
  Info,
} from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { useSeedNames, SEED_NAME_MAX_LENGTH } from '@/hooks/use-seed-names';
import { useOwners } from '@/hooks/use-owners';
import { useWalletNames } from '@/hooks/use-wallet-names';
import { useWalletSoftware } from '@/hooks/use-wallet-software';
import { ensureOwner, ensureWalletName, ensureSeedName } from '@/lib/data/vocabulary-crud';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Check, ChevronsUpDown, Wallet } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  detectWalletType,
  parseFile,
  analyzeRecords,
  executeImport,
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
import { describeKeptFieldCounts } from '@/lib/descriptor-import-utils';

type WizardStep = 'upload' | 'setup' | 'preview' | 'import';

const MOBILE_WALLET_TYPES: { type: WalletType; name: string; description: string }[] = [
  { type: 'phoenix', name: 'Phoenix Wallet', description: 'Lightning wallet by ACINQ - imports on-chain transactions only (swaps, channel operations)' },
  { type: 'wallet-of-satoshi', name: 'Wallet of Satoshi', description: 'Custodial Lightning wallet - imports on-chain deposits and withdrawals only' },
  { type: 'mycelium', name: 'Mycelium', description: 'Bitcoin wallet with full transaction history export' },
  { type: 'nunchuk', name: 'Nunchuk', description: 'Multisig wallet - imports CSV transaction history. For BSMS wallet backup, use Descriptor Import instead' },
];

const generateSourceName = (walletType: WalletType): string => {
  const walletName = getWalletName(walletType);
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const time = now.toTimeString().split(' ')[0].replace(/:/g, '');
  return `mobileImport-${walletName}_${date}_${time}`;
};

const STEPS: { key: WizardStep; label: string; icon: typeof Upload }[] = [
  { key: 'upload', label: 'Upload', icon: Upload },
  { key: 'setup', label: 'Setup', icon: Settings2 },
  { key: 'preview', label: 'Preview', icon: Eye },
  { key: 'import', label: 'Import', icon: CheckCircle },
];

export default function MobileWalletImport() {
  const { toast } = useToast();
  
  const [currentStep, setCurrentStep] = useState<WizardStep>('upload');
  const [fileContent, setFileContent] = useState<string>('');
  const [fileName, setFileName] = useState<string>('');
  const [detectionResult, setDetectionResult] = useState<DetectionResult | null>(null);
  const [selectedWalletType, setSelectedWalletType] = useState<WalletType>('phoenix');
  const [selectedFileFormat, setSelectedFileFormat] = useState<FileFormat>('csv');
  
  const [ownerInput, setOwnerInput] = useState<string>('');
  const [walletNameInput, setWalletNameInput] = useState<string>('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  
  const [parsedRecords, setParsedRecords] = useState<ParsedRecord[]>([]);
  const [duplicateInfos, setDuplicateInfos] = useState<DuplicateInfo[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  
  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(0);
  const [importStatus, setImportStatus] = useState('');
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  
  const [privateKeyWarnings, setPrivateKeyWarnings] = useState<string[]>([]);
  const [acknowledgedWarning, setAcknowledgedWarning] = useState(false);
  
  const [selectedSeedName, setSelectedSeedName] = useState<string>('');
  const [selectedWalletSoftware, setSelectedWalletSoftware] = useState<string>('');
  const [markInputsAsVerified, setMarkInputsAsVerified] = useState(false);
  
  const { seedNames: rawSeedNames } = useSeedNames();
  const { owners: rawOwners } = useOwners();
  const { walletNames: rawWalletNames } = useWalletNames();
  const { walletSoftware: rawWalletSoftwareList } = useWalletSoftware();
  
  const seedNames = rawSeedNames.map(s => s.name).filter(n => n);
  const owners = rawOwners.map(o => o.name).filter(n => n);
  const walletNames = rawWalletNames.map(w => w.name).filter(n => n);
  
  const rawTags = useLiveQuery(() => db.tags.toArray(), []);
  const rawCategories = useLiveQuery(() => db.categories.toArray(), []);
  const [tags, setTags] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  
  useEffect(() => {
    if (rawTags) {
      setTags(rawTags.map(t => t.name));
    }
    if (rawCategories) {
      setCategories(rawCategories.map(c => c.name));
    }
  }, [rawTags, rawCategories]);
  
  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0) return;
    
    const file = acceptedFiles[0];
    setFileName(file.name);
    
    try {
      const content = await file.text();
      setFileContent(content);
      
      const pkResult = scanForPrivateKeys(content);
      if (pkResult.hasPrivateKeys) {
        setPrivateKeyWarnings(pkResult.warnings);
        setAcknowledgedWarning(false);
      } else {
        setPrivateKeyWarnings([]);
        setAcknowledgedWarning(true);
      }
      
      const detection = detectWalletType(content, file.name);
      setDetectionResult(detection);
      
      if (detection.fileFormat === 'bsms') {
        toast({
          title: 'BSMS wallet backup detected',
          description: 'BSMS files describe a wallet, not transaction history. Use the Descriptor Import page to import its addresses with metadata.',
          variant: 'destructive',
        });
        return;
      }
      
      if (MOBILE_WALLET_TYPES.some(w => w.type === detection.walletType)) {
        setSelectedWalletType(detection.walletType);
      }
      setSelectedFileFormat(detection.fileFormat);
      
      toast({
        title: 'File loaded',
        description: `Detected format: ${getWalletName(detection.walletType)} (${detection.fileFormat.toUpperCase()})`,
      });
    } catch (error) {
      toast({
        title: 'Error reading file',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  }, [toast]);
  
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'text/csv': ['.csv'],
      'application/json': ['.json'],
      'text/plain': ['.bsms', '.txt'],
    },
    multiple: false,
  });
  
  const handleProceedToSetup = async () => {
    if (privateKeyWarnings.length > 0 && !acknowledgedWarning) {
      toast({
        title: 'Warning',
        description: 'Please acknowledge the private key warning before proceeding',
        variant: 'destructive',
      });
      return;
    }
    
    setIsAnalyzing(true);
    try {
      const result = parseFile(fileContent, selectedWalletType, selectedFileFormat);
      
      if (!result.success && result.records.length === 0) {
        setParseErrors(result.errors);
        toast({
          title: 'Parse failed',
          description: result.errors.join(', '),
          variant: 'destructive',
        });
        setIsAnalyzing(false);
        return;
      }
      
      setParsedRecords(result.records);
      setParseErrors(result.errors);
      
      if (result.records.length === 0) {
        toast({
          title: 'No records found',
          description: 'No on-chain transactions were found in this file. This may contain only Lightning payments.',
          variant: 'destructive',
        });
        setIsAnalyzing(false);
        return;
      }
      
      setSelectedWalletSoftware(getWalletName(selectedWalletType));
      setCurrentStep('setup');
    } finally {
      setIsAnalyzing(false);
    }
  };
  
  const handleProceedToPreview = async () => {
    setIsAnalyzing(true);
    try {
      const duplicates = await analyzeRecords(parsedRecords);
      setDuplicateInfos(duplicates);
      setCurrentStep('preview');
    } finally {
      setIsAnalyzing(false);
    }
  };
  
  const handleStartImport = async () => {
    setIsImporting(true);
    setImportProgress(0);
    setImportStatus('Starting import...');
    
    try {
      const result = await executeImport(
        duplicateInfos,
        {
          sourceName: generateSourceName(selectedWalletType),
          owner: ownerInput || undefined,
          walletName: walletNameInput || undefined,
          defaultTags: selectedTags,
          defaultCategories: selectedCategories,
          walletSoftware: selectedWalletSoftware || undefined,
          seedName: selectedSeedName || undefined,
          markInputsAsVerified,
        },
        (current, total, status) => {
          setImportProgress((current / total) * 100);
          setImportStatus(status);
        }
      );
      
      setImportResult(result);
      setCurrentStep('import');
      
      toast({
        title: 'Import complete',
        description:
          `${result.newRecords} new, ${result.updatedRecords} updated, ${result.skippedRecords} skipped` +
          (result.reattributedRecords > 0
            ? ` — ${result.reattributedRecords} re-attributed from other wallets`
            : ''),
      });
    } catch (error) {
      toast({
        title: 'Import failed',
        description: error instanceof Error ? error.message : 'Unknown error',
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
    setSelectedWalletType('phoenix');
    setSelectedFileFormat('csv');
    setParsedRecords([]);
    setDuplicateInfos([]);
    setParseErrors([]);
    setImportResult(null);
    setPrivateKeyWarnings([]);
    setAcknowledgedWarning(false);
    setOwnerInput('');
    setWalletNameInput('');
    setSelectedTags([]);
    setSelectedCategories([]);
    setSelectedSeedName('');
    setSelectedWalletSoftware('');
    setMarkInputsAsVerified(false);
  };
  
  const currentStepIndex = STEPS.findIndex(s => s.key === currentStep);
  
  const summary = duplicateInfos.length > 0 ? getImportSummary(duplicateInfos) : null;
  
  return (
    <ScrollArea className="h-full">
      <div className="container mx-auto p-6 max-w-4xl">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <Smartphone className="h-8 w-8 text-primary" />
          <h1 className="text-2xl font-bold">Mobile Wallet Import</h1>
        </div>
        <p className="text-muted-foreground">
          Import on-chain transaction history from mobile Lightning wallets
        </p>
      </div>
      
      <div className="flex items-center justify-between mb-8">
        {STEPS.map((step, index) => (
          <div key={step.key} className="flex items-center">
            <div className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-lg",
              index <= currentStepIndex ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
            )}>
              <step.icon className="h-4 w-4" />
              <span className="font-medium">{step.label}</span>
            </div>
            {index < STEPS.length - 1 && (
              <ArrowRight className="h-4 w-4 mx-2 text-muted-foreground" />
            )}
          </div>
        ))}
      </div>
      
      {currentStep === 'upload' && (
        <div className="space-y-6">
          <Alert>
            <Info className="h-4 w-4" />
            <AlertTitle>About Mobile Wallet Import</AlertTitle>
            <AlertDescription>
              Import transaction history from mobile Bitcoin and Lightning wallets. 
              For Lightning wallets (Phoenix, Wallet of Satoshi), this extracts only <strong>on-chain transactions</strong> (swaps, deposits, withdrawals) 
              which have proper Bitcoin transaction IDs. Lightning-only payments are skipped.
              Mycelium and Nunchuk imports include full transaction history.
            </AlertDescription>
          </Alert>
          
          <Card>
            <CardHeader>
              <CardTitle>Supported Wallets</CardTitle>
              <CardDescription>Select your mobile wallet and upload the export file</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4">
                {MOBILE_WALLET_TYPES.map((wallet) => (
                  <div 
                    key={wallet.type}
                    className={cn(
                      "flex items-start gap-4 p-4 rounded-lg border cursor-pointer hover-elevate",
                      selectedWalletType === wallet.type && "border-primary bg-primary/5"
                    )}
                    onClick={() => setSelectedWalletType(wallet.type)}
                    data-testid={`wallet-option-${wallet.type}`}
                  >
                    <div className="flex-shrink-0 p-2 rounded-lg bg-orange-500/10">
                      <Zap className="h-6 w-6 text-orange-500" />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium">{wallet.name}</h3>
                        {selectedWalletType === wallet.type && (
                          <Badge variant="secondary">Selected</Badge>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground mt-1">{wallet.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader>
              <CardTitle>Upload Export File</CardTitle>
              <CardDescription>
                Export your transaction history from {getWalletName(selectedWalletType)} and upload the CSV file
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {selectedWalletType === 'phoenix' && (
                <Alert>
                  <FileSpreadsheet className="h-4 w-4" />
                  <AlertTitle>How to export from Phoenix</AlertTitle>
                  <AlertDescription>
                    <ol className="list-decimal list-inside mt-2 space-y-1 text-sm">
                      <li>Open Phoenix wallet on your phone</li>
                      <li>Go to payment history (bottom of home screen)</li>
                      <li>Tap the export icon (top right)</li>
                      <li>Save the CSV file and transfer to this device</li>
                    </ol>
                  </AlertDescription>
                </Alert>
              )}
              
              {selectedWalletType === 'wallet-of-satoshi' && (
                <Alert>
                  <FileSpreadsheet className="h-4 w-4" />
                  <AlertTitle>How to export from Wallet of Satoshi</AlertTitle>
                  <AlertDescription>
                    <ol className="list-decimal list-inside mt-2 space-y-1 text-sm">
                      <li>Open Wallet of Satoshi app</li>
                      <li>Tap Menu (top right) &gt; Settings</li>
                      <li>Select "History CSV File"</li>
                      <li>Confirm your email - download link will be sent</li>
                      <li>Download CSV from email and upload here</li>
                    </ol>
                  </AlertDescription>
                </Alert>
              )}
              
              {selectedWalletType === 'mycelium' && (
                <Alert>
                  <FileSpreadsheet className="h-4 w-4" />
                  <AlertTitle>How to export from Mycelium</AlertTitle>
                  <AlertDescription>
                    <ol className="list-decimal list-inside mt-2 space-y-1 text-sm">
                      <li>Go to wallet.mycelium.com and log in</li>
                      <li>Open the TRANSACTIONS tab</li>
                      <li>Click "Export transaction history"</li>
                      <li>Download the CSV file and upload here</li>
                    </ol>
                    <p className="mt-2 text-xs text-muted-foreground">Note: Mobile app exports may require the web wallet interface.</p>
                  </AlertDescription>
                </Alert>
              )}
              
              {selectedWalletType === 'nunchuk' && (
                <Alert>
                  <FileSpreadsheet className="h-4 w-4" />
                  <AlertTitle>How to export from Nunchuk</AlertTitle>
                  <AlertDescription>
                    <ol className="list-decimal list-inside mt-2 space-y-1 text-sm">
                      <li>Open Nunchuk app and select your wallet</li>
                      <li>Tap Settings (gear icon)</li>
                      <li>Select "Export transaction history"</li>
                      <li>Choose CSV format and save</li>
                      <li>Transfer the file to this device</li>
                    </ol>
                    <p className="mt-2 text-xs text-muted-foreground">
                      <strong>Tip:</strong> For multisig wallet backup (BSMS files), use the{' '}
                      <Link href="/descriptor-import" className="underline" data-testid="link-descriptor-import">
                        Descriptor Import
                      </Link>{' '}
                      page instead.
                    </p>
                  </AlertDescription>
                </Alert>
              )}
              
              <div
                {...getRootProps()}
                className={cn(
                  "border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors",
                  isDragActive ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-primary/50"
                )}
                data-testid="dropzone-mobile-wallet"
              >
                <input {...getInputProps()} data-testid="input-file-mobile-wallet" />
                <Upload className="h-10 w-10 mx-auto mb-4 text-muted-foreground" />
                {fileName ? (
                  <div className="space-y-2">
                    <p className="font-medium">{fileName}</p>
                    <Badge variant="outline">{selectedFileFormat.toUpperCase()}</Badge>
                  </div>
                ) : (
                  <div>
                    <p className="font-medium">Drop your export file here</p>
                    <p className="text-sm text-muted-foreground mt-1">or click to browse</p>
                  </div>
                )}
              </div>
              
              {privateKeyWarnings.length > 0 && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Security Warning</AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc list-inside mt-2">
                      {privateKeyWarnings.map((warning, i) => (
                        <li key={i}>{warning}</li>
                      ))}
                    </ul>
                    <div className="flex items-center gap-2 mt-4">
                      <Switch
                        checked={acknowledgedWarning}
                        onCheckedChange={setAcknowledgedWarning}
                        data-testid="switch-acknowledge-warning"
                      />
                      <Label>I understand and want to proceed anyway</Label>
                    </div>
                  </AlertDescription>
                </Alert>
              )}
              
              {parseErrors.length > 0 && (
                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Parse Notes</AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc list-inside mt-2">
                      {parseErrors.map((error, i) => (
                        <li key={i}>{error}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
          
          <div className="flex justify-end">
            <Button 
              onClick={handleProceedToSetup}
              disabled={!fileContent || isAnalyzing || (privateKeyWarnings.length > 0 && !acknowledgedWarning)}
              data-testid="button-proceed-setup"
            >
              {isAnalyzing ? (
                <>
                  <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                  Parsing...
                </>
              ) : (
                <>
                  Next: Setup
                  <ArrowRight className="h-4 w-4 ml-2" />
                </>
              )}
            </Button>
          </div>
        </div>
      )}
      
      {currentStep === 'setup' && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Import Settings</CardTitle>
              <CardDescription>
                Configure metadata for the {parsedRecords.length} on-chain transaction{parsedRecords.length !== 1 ? 's' : ''} found
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="owner">Owner</Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        className="w-full justify-between"
                        data-testid="select-owner"
                      >
                        {ownerInput || "Select owner..."}
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-full p-0">
                      <Command>
                        <CommandInput placeholder="Search or add owner..." />
                        <CommandList>
                          <CommandEmpty>
                            <Button
                              variant="ghost"
                              className="w-full"
                              onClick={async () => {
                                const input = document.querySelector<HTMLInputElement>('[cmdk-input]');
                                const value = input?.value;
                                if (value) {
                                  await ensureOwner(value);
                                  setOwnerInput(value);
                                }
                              }}
                            >
                              <Plus className="h-4 w-4 mr-2" />
                              Add new owner
                            </Button>
                          </CommandEmpty>
                          <CommandGroup>
                            {owners.map((owner) => (
                              <CommandItem
                                key={owner}
                                value={owner}
                                onSelect={() => setOwnerInput(owner)}
                              >
                                <Check className={cn("mr-2 h-4 w-4", ownerInput === owner ? "opacity-100" : "opacity-0")} />
                                {owner}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="walletName">Wallet Name</Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        className="w-full justify-between"
                        data-testid="select-wallet-name"
                      >
                        {walletNameInput || "Select wallet name..."}
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-full p-0">
                      <Command>
                        <CommandInput placeholder="Search or add wallet name..." />
                        <CommandList>
                          <CommandEmpty>
                            <Button
                              variant="ghost"
                              className="w-full"
                              onClick={async () => {
                                const input = document.querySelector<HTMLInputElement>('[cmdk-input]');
                                const value = input?.value;
                                if (value) {
                                  await ensureWalletName(value);
                                  setWalletNameInput(value);
                                }
                              }}
                            >
                              <Plus className="h-4 w-4 mr-2" />
                              Add new wallet name
                            </Button>
                          </CommandEmpty>
                          <CommandGroup>
                            {walletNames.map((name) => (
                              <CommandItem
                                key={name}
                                value={name}
                                onSelect={() => setWalletNameInput(name)}
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
                  <Label>Wallet Software</Label>
                  <Input
                    value={selectedWalletSoftware}
                    onChange={(e) => setSelectedWalletSoftware(e.target.value)}
                    placeholder="e.g., Phoenix Wallet"
                    data-testid="input-wallet-software"
                  />
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="seedName">Seed Name</Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        className="w-full justify-between"
                        data-testid="select-seed-name"
                      >
                        {selectedSeedName || "Select seed name..."}
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-full p-0">
                      <Command>
                        <CommandInput placeholder="Search or add seed name..." />
                        <CommandList>
                          <CommandEmpty>
                            <Button
                              variant="ghost"
                              className="w-full"
                              onClick={async () => {
                                const input = document.querySelector<HTMLInputElement>('[cmdk-input]');
                                const value = input?.value;
                                if (value && value.length <= SEED_NAME_MAX_LENGTH) {
                                  await ensureSeedName(value);
                                  setSelectedSeedName(value);
                                }
                              }}
                            >
                              <Plus className="h-4 w-4 mr-2" />
                              Add new seed name
                            </Button>
                          </CommandEmpty>
                          <CommandGroup>
                            {seedNames.map((name) => (
                              <CommandItem
                                key={name}
                                value={name}
                                onSelect={() => setSelectedSeedName(name)}
                              >
                                <Check className={cn("mr-2 h-4 w-4", selectedSeedName === name ? "opacity-100" : "opacity-0")} />
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
                  <Label>Default Tags</Label>
                  <MultiSelectCombobox
                    options={tags}
                    values={selectedTags}
                    onChange={setSelectedTags}
                    placeholder="Select tags..."
                    testId="multiselect-tags"
                  />
                </div>
                
                <div className="space-y-2">
                  <Label>Default Categories</Label>
                  <MultiSelectCombobox
                    options={categories}
                    values={selectedCategories}
                    onChange={setSelectedCategories}
                    placeholder="Select categories..."
                    testId="multiselect-categories"
                  />
                </div>
              </div>
              
              <div className="flex items-center gap-2">
                <Switch
                  checked={markInputsAsVerified}
                  onCheckedChange={setMarkInputsAsVerified}
                  data-testid="switch-mark-verified"
                />
                <Label className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4" />
                  Mark transactions as verified
                </Label>
              </div>
            </CardContent>
          </Card>
          
          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setCurrentStep('upload')} data-testid="button-back-upload">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
            <Button onClick={handleProceedToPreview} disabled={isAnalyzing} data-testid="button-proceed-preview">
              {isAnalyzing ? (
                <>
                  <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                  Analyzing...
                </>
              ) : (
                <>
                  Next: Preview
                  <ArrowRight className="h-4 w-4 ml-2" />
                </>
              )}
            </Button>
          </div>
        </div>
      )}
      
      {currentStep === 'preview' && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Import Preview</CardTitle>
              <CardDescription>Review what will be imported</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {summary && (
                <div className="grid grid-cols-3 gap-4">
                  <div className="text-center p-4 bg-green-500/10 rounded-lg">
                    <div className="text-2xl font-bold text-green-600">{summary.newCount}</div>
                    <div className="text-sm text-muted-foreground">New Records</div>
                  </div>
                  <div className="text-center p-4 bg-blue-500/10 rounded-lg">
                    <div className="text-2xl font-bold text-blue-600">{summary.mergeCount}</div>
                    <div className="text-sm text-muted-foreground">Will Merge</div>
                  </div>
                  <div className="text-center p-4 bg-muted rounded-lg">
                    <div className="text-2xl font-bold">{duplicateInfos.length - summary.newCount - summary.mergeCount}</div>
                    <div className="text-sm text-muted-foreground">Skipped</div>
                  </div>
                </div>
              )}
              
              <ScrollArea className="h-[300px] rounded-lg border">
                <div className="p-4 space-y-2">
                  {duplicateInfos.map((info, index) => (
                    <div 
                      key={index}
                      className={cn(
                        "flex items-center justify-between p-3 rounded-lg",
                        info.isNew ? "bg-green-500/10" : info.willMerge ? "bg-blue-500/10" : "bg-muted"
                      )}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline">{info.parsedRecord.type}</Badge>
                          <span className="font-mono text-sm truncate">
                            {info.parsedRecord.inputString.substring(0, 16)}...
                          </span>
                        </div>
                        <div className="text-sm text-muted-foreground truncate mt-1">
                          {info.parsedRecord.label}
                        </div>
                      </div>
                      <Badge variant={info.isNew ? "default" : info.willMerge ? "secondary" : "outline"}>
                        {info.isNew ? "New" : info.willMerge ? "Merge" : "Skip"}
                      </Badge>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
          
          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setCurrentStep('setup')} data-testid="button-back-setup">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
            <Button onClick={handleStartImport} disabled={isImporting} data-testid="button-start-import">
              {isImporting ? (
                <>
                  <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                  Importing...
                </>
              ) : (
                <>
                  <CheckCircle className="h-4 w-4 mr-2" />
                  Start Import
                </>
              )}
            </Button>
          </div>
          
          {isImporting && (
            <Card>
              <CardContent className="pt-6">
                <Progress value={importProgress} className="mb-2" />
                <p className="text-sm text-muted-foreground text-center">{importStatus}</p>
              </CardContent>
            </Card>
          )}
        </div>
      )}
      
      {currentStep === 'import' && importResult && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CheckCircle className="h-5 w-5 text-green-500" />
                Import Complete
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-4 gap-4">
                <div className="text-center p-4 bg-green-500/10 rounded-lg">
                  <div className="text-2xl font-bold text-green-600">{importResult.newRecords}</div>
                  <div className="text-sm text-muted-foreground">New Records</div>
                </div>
                <div className="text-center p-4 bg-blue-500/10 rounded-lg">
                  <div className="text-2xl font-bold text-blue-600">{importResult.updatedRecords}</div>
                  <div className="text-sm text-muted-foreground">Updated</div>
                </div>
                {importResult.reattributedRecords > 0 && (
                  <div className="text-center p-4 bg-orange-500/10 rounded-lg" data-testid="card-reattributed">
                    <div className="text-2xl font-bold text-orange-600" data-testid="text-reattributed-count">{importResult.reattributedRecords}</div>
                    <div className="text-sm text-muted-foreground">Re-attributed</div>
                    <div className="text-xs text-muted-foreground mt-1">Moved from another wallet</div>
                  </div>
                )}
                <div className="text-center p-4 bg-muted rounded-lg">
                  <div className="text-2xl font-bold">{importResult.skippedRecords}</div>
                  <div className="text-sm text-muted-foreground">Skipped</div>
                </div>
                <div className="text-center p-4 bg-red-500/10 rounded-lg">
                  <div className="text-2xl font-bold text-red-600">{importResult.failedRecords}</div>
                  <div className="text-sm text-muted-foreground">Failed</div>
                </div>
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
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Errors</AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc list-inside mt-2">
                      {importResult.errors.map((error, i) => (
                        <li key={i}>{error}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
          
          <div className="flex justify-center">
            <Button onClick={handleReset} data-testid="button-import-another">
              <RefreshCw className="h-4 w-4 mr-2" />
              Import Another File
            </Button>
          </div>
        </div>
      )}
      </div>
    </ScrollArea>
  );
}

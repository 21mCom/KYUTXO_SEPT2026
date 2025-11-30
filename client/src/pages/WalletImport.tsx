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
  X,
  RefreshCw,
  FileJson,
  FileSpreadsheet,
  ShieldCheck,
} from 'lucide-react';
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
import { useToast } from '@/hooks/use-toast';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/database';
import { isEncryptionReady } from '@/lib/encryptionFacade';
import { decryptTag, decryptCategory } from '@/lib/dbEncryption';
import { getEncryptionKey } from '@/lib/encryptionFacade';
import {
  detectWalletType,
  parseFile,
  analyzeRecords,
  executeImport,
  getSupportedWallets,
  getWalletName,
  type WalletType,
  type FileFormat,
  type ParsedRecord,
  type DuplicateInfo,
  type ImportResult,
  type DetectionResult,
} from '@/lib/wallet-import/import-manager';
import { getImportSummary } from '@/lib/wallet-import/merge-utils';

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
  const [newTag, setNewTag] = useState<string>('');
  const [newCategory, setNewCategory] = useState<string>('');
  
  const [parsedRecords, setParsedRecords] = useState<ParsedRecord[]>([]);
  const [duplicateInfos, setDuplicateInfos] = useState<DuplicateInfo[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  
  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(0);
  const [importStatus, setImportStatus] = useState('');
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  
  const [markInputsAsVerified, setMarkInputsAsVerified] = useState(false);
  
  const encryptedTags = useLiveQuery(() => db.tags.toArray());
  const encryptedCategories = useLiveQuery(() => db.categories.toArray());
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [availableCategories, setAvailableCategories] = useState<string[]>([]);
  
  useEffect(() => {
    const decryptItems = async () => {
      const key = getEncryptionKey();
      if (!key) return;
      
      if (encryptedTags) {
        const decryptedTags: string[] = [];
        for (const tag of encryptedTags) {
          try {
            const decrypted = tag.isEncrypted ? await decryptTag(tag, key) : tag;
            decryptedTags.push(decrypted.name);
          } catch {
            // Skip failed decryptions
          }
        }
        setAvailableTags(decryptedTags);
      }
      
      if (encryptedCategories) {
        const decryptedCategories: string[] = [];
        for (const cat of encryptedCategories) {
          try {
            const decrypted = cat.isEncrypted ? await decryptCategory(cat, key) : cat;
            decryptedCategories.push(decrypted.name);
          } catch {
            // Skip failed decryptions
          }
        }
        setAvailableCategories(decryptedCategories);
      }
    };
    
    decryptItems();
  }, [encryptedTags, encryptedCategories]);
  
  const supportedWallets = getSupportedWallets();
  
  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0) return;
    
    const file = acceptedFiles[0];
    setFileName(file.name);
    
    try {
      const content = await file.text();
      setFileContent(content);
      
      const detection = detectWalletType(content, file.name);
      setDetectionResult(detection);
      setSelectedWalletType(detection.walletType);
      setSelectedFileFormat(detection.fileFormat);
      
      
      toast({
        title: 'File loaded',
        description: detection.walletType !== 'unknown'
          ? `Detected ${getWalletName(detection.walletType)} ${detection.fileFormat.toUpperCase()} export`
          : 'Please select the wallet type manually',
      });
    } catch (e) {
      toast({
        title: 'Error reading file',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  }, [toast]);
  
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'text/csv': ['.csv'],
      'application/json': ['.json'],
      'text/plain': ['.txt'],
    },
    multiple: false,
  });
  
  const handleNextStep = async () => {
    const stepIndex = STEPS.findIndex(s => s.key === currentStep);
    
    if (currentStep === 'upload') {
      if (!fileContent) {
        toast({
          title: 'No file selected',
          description: 'Please upload a wallet export file',
          variant: 'destructive',
        });
        return;
      }
      if (selectedWalletType === 'unknown') {
        toast({
          title: 'Wallet type required',
          description: 'Please select the wallet type',
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
      const result = await executeImport(
        duplicateInfos,
        {
          sourceName,
          owner: ownerInput || undefined,
          walletName: walletNameInput || undefined,
          defaultTags: selectedTags,
          defaultCategories: selectedCategories,
          walletSoftware: getWalletName(selectedWalletType),
          markInputsAsVerified,
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
        description: `Created ${result.newRecords} new, updated ${result.updatedRecords} existing records`,
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
    setSelectedTags([]);
    setSelectedCategories([]);
    setParsedRecords([]);
    setDuplicateInfos([]);
    setImportResult(null);
    setImportProgress(0);
    setImportStatus('');
  };
  
  const addTag = () => {
    if (newTag.trim() && !selectedTags.includes(newTag.trim())) {
      setSelectedTags([...selectedTags, newTag.trim()]);
      setNewTag('');
    }
  };
  
  const removeTag = (tag: string) => {
    setSelectedTags(selectedTags.filter(t => t !== tag));
  };
  
  const addCategory = () => {
    if (newCategory.trim() && !selectedCategories.includes(newCategory.trim())) {
      setSelectedCategories([...selectedCategories, newCategory.trim()]);
      setNewCategory('');
    }
  };
  
  const removeCategory = (category: string) => {
    setSelectedCategories(selectedCategories.filter(c => c !== category));
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
          {isDragActive ? 'Drop the file here' : 'Drag & drop wallet export file'}
        </p>
        <p className="text-sm text-muted-foreground">
          Supports CSV and JSON exports from Trezor Suite, Sparrow Wallet, and Mycelium
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

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="owner">Owner</Label>
              <Input
                id="owner"
                value={ownerInput}
                onChange={(e) => setOwnerInput(e.target.value)}
                placeholder="e.g., Personal, Spouse"
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
                data-testid="input-wallet-name"
              />
            </div>
          </div>
          
          <div>
            <Label>Default Tags</Label>
            <div className="flex flex-wrap gap-2 mb-2">
              {selectedTags.map(tag => (
                <Badge key={tag} variant="secondary" className="gap-1">
                  {tag}
                  <button onClick={() => removeTag(tag)} className="ml-1">
                    <X className="w-3 h-3" />
                  </button>
                </Badge>
              ))}
            </div>
            <div className="flex gap-2">
              <Select onValueChange={(value) => {
                if (value && !selectedTags.includes(value)) {
                  setSelectedTags([...selectedTags, value]);
                }
              }}>
                <SelectTrigger className="flex-1" data-testid="select-existing-tag">
                  <SelectValue placeholder="Add existing tag" />
                </SelectTrigger>
                <SelectContent>
                  {availableTags.filter(t => !selectedTags.includes(t)).map(tag => (
                    <SelectItem key={tag} value={tag}>{tag}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                placeholder="New tag"
                className="flex-1"
                onKeyDown={(e) => e.key === 'Enter' && addTag()}
                data-testid="input-new-tag"
              />
              <Button size="icon" variant="outline" onClick={addTag} data-testid="button-add-tag">
                <Plus className="w-4 h-4" />
              </Button>
            </div>
          </div>
          
          <div>
            <Label>Default Categories</Label>
            <div className="flex flex-wrap gap-2 mb-2">
              {selectedCategories.map(cat => (
                <Badge key={cat} variant="secondary" className="gap-1">
                  {cat}
                  <button onClick={() => removeCategory(cat)} className="ml-1">
                    <X className="w-3 h-3" />
                  </button>
                </Badge>
              ))}
            </div>
            <div className="flex gap-2">
              <Select onValueChange={(value) => {
                if (value && !selectedCategories.includes(value)) {
                  setSelectedCategories([...selectedCategories, value]);
                }
              }}>
                <SelectTrigger className="flex-1" data-testid="select-existing-category">
                  <SelectValue placeholder="Add existing category" />
                </SelectTrigger>
                <SelectContent>
                  {availableCategories.filter(c => !selectedCategories.includes(c)).map(cat => (
                    <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                placeholder="New category"
                className="flex-1"
                onKeyDown={(e) => e.key === 'Enter' && addCategory()}
                data-testid="input-new-category"
              />
              <Button size="icon" variant="outline" onClick={addCategory} data-testid="button-add-category">
                <Plus className="w-4 h-4" />
              </Button>
            </div>
          </div>

          <div className="pt-4 border-t">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <Label htmlFor="mark-verified" className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-green-600" />
                  Mark input addresses as verified
                </Label>
                <p className="text-sm text-muted-foreground">
                  Confirms you control these addresses. Only applies to input addresses (your receiving addresses).
                </p>
              </div>
              <Switch
                id="mark-verified"
                checked={markInputsAsVerified}
                onCheckedChange={setMarkInputsAsVerified}
                data-testid="switch-mark-verified"
              />
            </div>
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
          <h1 className="text-2xl font-bold">Wallet Import</h1>
          <p className="text-muted-foreground">
            Import transaction history from popular Bitcoin wallet software
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

import { useState, useCallback, useEffect } from 'react';
import { useDropzone } from 'react-dropzone';
import { 
  Upload, 
  FileJson, 
  CheckCircle, 
  AlertCircle, 
  ArrowRight, 
  ArrowLeft,
  Tag,
  RefreshCw,
  Info,
  Hash,
  FileText,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { describeKeptFieldCounts } from '@/lib/descriptor-import-utils';
import { useToast } from '@/hooks/use-toast';
import {
  analyzeRecords,
  executeImport,
  scanForPrivateKeys,
  type DuplicateInfo,
  type ImportResult,
} from '@/lib/wallet-import/import-manager';
import { getImportSummary } from '@/lib/wallet-import/merge-utils';
import { parseJsonLines, convertToImportRecords, type BIP329Record } from '@/lib/bip329';
import { canonicalizeRecordIdentifier, isMixedCaseBech32 } from '@/lib/bitcoin';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type WizardStep = 'upload' | 'preview' | 'import';

const STEPS: { key: WizardStep; label: string; icon: typeof Upload }[] = [
  { key: 'upload', label: 'Upload', icon: Upload },
  { key: 'preview', label: 'Preview', icon: Tag },
  { key: 'import', label: 'Import', icon: CheckCircle },
];

const generateSourceName = (): string => {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const time = now.toTimeString().split(' ')[0].replace(/:/g, '');
  return `bip329Import_${date}_${time}`;
};

export default function BIP329Import() {
  const { toast } = useToast();
  
  const [currentStep, setCurrentStep] = useState<WizardStep>('upload');
  const [fileName, setFileName] = useState<string>('');
  const [bip329Records, setBip329Records] = useState<BIP329Record[]>([]);
  const [duplicateInfos, setDuplicateInfos] = useState<DuplicateInfo[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  
  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(0);
  const [importStatus, setImportStatus] = useState('');
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  
  const stats = {
    addresses: bip329Records.filter(r => r.type === 'addr').length,
    transactions: bip329Records.filter(r => r.type === 'tx').length,
    inputs: bip329Records.filter(r => r.type === 'input').length,
    outputs: bip329Records.filter(r => r.type === 'output').length,
    xpubs: bip329Records.filter(r => r.type === 'xpub' || r.type === 'pubkey').length,
  };
  
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
          description: `This file appears to contain private key material. ${privateKeyScan.warnings.join('. ')}`,
          variant: 'destructive',
        });
        setFileName('');
        setBip329Records([]);
        return;
      }
      
      const records = parseJsonLines(content);
      
      if (records.length === 0) {
        toast({
          title: 'Invalid file',
          description: 'No valid BIP-329 records found in file',
          variant: 'destructive',
        });
        setFileName('');
        return;
      }
      
      setBip329Records(records);
      
      toast({
        title: 'File loaded',
        description: `Found ${records.length} BIP-329 label entries`,
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
      'application/json': ['.jsonl'],
      'text/plain': ['.jsonl', '.txt'],
    },
    multiple: false,
  });
  
  const handleNextStep = async () => {
    if (currentStep === 'upload') {
      if (bip329Records.length === 0) {
        toast({
          title: 'No file selected',
          description: 'Please upload a BIP-329 label export file (.jsonl)',
          variant: 'destructive',
        });
        return;
      }
      
      setIsAnalyzing(true);
      try {
        const converted = convertToImportRecords(bip329Records);
        const duplicates = await analyzeRecords(converted);
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
    if (currentStep === 'preview') {
      setCurrentStep('upload');
    }
  };
  
  const handleImport = async () => {
    setIsImporting(true);
    setImportProgress(0);
    setImportStatus('Starting import...');
    
    try {
      const sourceName = generateSourceName();
      const result = await executeImport(
        duplicateInfos,
        {
          sourceName,
          walletSoftware: 'BIP-329 Export',
          defaultTags: [],
          defaultCategories: [],
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
    setFileName('');
    setBip329Records([]);
    setDuplicateInfos([]);
    setImportResult(null);
    setImportProgress(0);
    setImportStatus('');
  };
  
  const summary = duplicateInfos.length > 0 ? getImportSummary(duplicateInfos) : null;

  // Canonicalization heads-up (mirrors Quick Tagger's paste-flow warning):
  // identifiers in the file that will be stored case-folded (mixed-case
  // bech32 or uppercase hex txids/outpoints) get a non-blocking notice so
  // importers of files produced by other wallets aren't surprised when the
  // saved identifier differs from the file's.
  const caseFoldedCount = duplicateInfos.filter(info => {
    const raw = (info.parsedRecord.inputString || '').trim();
    return isMixedCaseBech32(raw) || canonicalizeRecordIdentifier(raw) !== raw;
  }).length;
  
  const renderStepIndicator = () => (
    <div className="flex flex-wrap items-center justify-center gap-2 mb-8" data-testid="step-indicator">
      {STEPS.map((step, index) => {
        const isActive = step.key === currentStep;
        const isPast = STEPS.findIndex(s => s.key === currentStep) > index;
        const Icon = step.icon;
        
        return (
          <div key={step.key} className="flex items-center" data-testid={`step-${step.key}`}>
            <div
              className={`flex items-center justify-center w-10 h-10 rounded-full border-2 transition-colors ${
                isActive
                  ? 'border-primary bg-primary text-primary-foreground'
                  : isPast
                  ? 'border-primary bg-primary/20 text-primary'
                  : 'border-muted-foreground/30 text-muted-foreground'
              }`}
              data-testid={`step-icon-${step.key}`}
            >
              <Icon className="w-5 h-5" />
            </div>
            <span className={`ml-2 text-sm font-medium ${isActive ? 'text-foreground' : 'text-muted-foreground'}`} data-testid={`step-label-${step.key}`}>
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
      <Alert data-testid="alert-bip329-info">
        <Info className="h-4 w-4" />
        <AlertDescription data-testid="text-bip329-info">
          <strong>BIP-329</strong> is a standard format for wallet label exports. 
          Export labels from Sparrow Wallet using File → Export Wallet → Wallet Labels (BIP-329).
        </AlertDescription>
      </Alert>

      <div
        {...getRootProps()}
        className={`border-2 border-dashed rounded-lg p-12 text-center cursor-pointer transition-colors ${
          isDragActive ? 'border-primary bg-primary/10' : 'border-muted-foreground/30 hover:border-primary/50'
        }`}
        data-testid="dropzone-bip329-import"
      >
        <input {...getInputProps()} data-testid="input-bip329-file" />
        <FileJson className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
        <p className="text-lg font-medium mb-2" data-testid="text-dropzone-title">
          {isDragActive ? 'Drop the file here' : 'Drag & drop BIP-329 label file'}
        </p>
        <p className="text-sm text-muted-foreground" data-testid="text-dropzone-description">
          Accepts .jsonl files containing BIP-329 formatted labels
        </p>
      </div>
      
      {fileName && bip329Records.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2" data-testid="text-file-name">
              <FileJson className="w-5 h-5 text-primary" />
              {fileName}
            </CardTitle>
            <CardDescription data-testid="text-file-entries-count">
              {bip329Records.length} label entries found
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {stats.addresses > 0 && (
                <Badge variant="secondary" className="gap-1" data-testid="badge-stat-addresses">
                  <Hash className="w-3 h-3" />
                  {stats.addresses} addresses
                </Badge>
              )}
              {stats.transactions > 0 && (
                <Badge variant="secondary" className="gap-1" data-testid="badge-stat-transactions">
                  <FileText className="w-3 h-3" />
                  {stats.transactions} transactions
                </Badge>
              )}
              {stats.inputs > 0 && (
                <Badge variant="outline" className="gap-1" data-testid="badge-stat-inputs">
                  {stats.inputs} inputs
                </Badge>
              )}
              {stats.outputs > 0 && (
                <Badge variant="outline" className="gap-1" data-testid="badge-stat-outputs">
                  {stats.outputs} outputs
                </Badge>
              )}
              {stats.xpubs > 0 && (
                <Badge variant="outline" className="gap-1 text-muted-foreground" data-testid="badge-stat-xpubs">
                  {stats.xpubs} xpubs (skipped)
                </Badge>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
  
  const renderPreviewStep = () => (
    <div className="space-y-6">
      {summary && (
        <div className="grid grid-cols-3 gap-4" data-testid="preview-summary">
          <Card data-testid="card-new-count">
            <CardContent className="pt-6">
              <div className="text-2xl font-bold text-green-600" data-testid="text-new-count">{summary.newCount}</div>
              <div className="text-sm text-muted-foreground" data-testid="label-new-count">New records to create</div>
            </CardContent>
          </Card>
          <Card data-testid="card-update-count">
            <CardContent className="pt-6">
              <div className="text-2xl font-bold text-blue-600" data-testid="text-update-count">{summary.mergeCount}</div>
              <div className="text-sm text-muted-foreground" data-testid="label-update-count">Existing to update</div>
            </CardContent>
          </Card>
          <Card data-testid="card-total-count">
            <CardContent className="pt-6">
              <div className="text-2xl font-bold" data-testid="text-total-count">{summary.newCount + summary.mergeCount}</div>
              <div className="text-sm text-muted-foreground" data-testid="label-total-count">Total labels</div>
            </CardContent>
          </Card>
        </div>
      )}
      
      {caseFoldedCount > 0 && (
        <Alert data-testid="alert-identifier-warning">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            <span className="font-medium">
              {caseFoldedCount} {caseFoldedCount === 1 ? 'identifier' : 'identifiers'} will be saved in lowercase.
            </span>
            <span className="block text-sm mt-1">
              Mixed-case bech32 addresses and uppercase transaction IDs are stored
              in their canonical lowercase form, so the saved identifiers will
              differ from this file's exact text.
            </span>
          </AlertDescription>
        </Alert>
      )}

      <Card data-testid="card-preview-table">
        <CardHeader>
          <CardTitle className="text-base" data-testid="text-preview-title">Labels to Import</CardTitle>
          <CardDescription data-testid="text-preview-description">
            Review the labels that will be imported
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[400px]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[80px]" data-testid="th-type">Type</TableHead>
                  <TableHead data-testid="th-reference">Reference</TableHead>
                  <TableHead data-testid="th-label">Label</TableHead>
                  <TableHead className="w-[100px]" data-testid="th-status">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {duplicateInfos.slice(0, 100).map((info, index) => (
                  <TableRow key={index} data-testid={`row-label-${index}`}>
                    <TableCell>
                      <Badge variant={info.parsedRecord.type === 'address' ? 'default' : 'secondary'} data-testid={`badge-type-${index}`}>
                        {info.parsedRecord.type === 'address' ? 'addr' : 'tx'}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs max-w-[200px] truncate" data-testid={`text-ref-${index}`}>
                      {info.parsedRecord.inputString}
                    </TableCell>
                    <TableCell className="max-w-[200px] truncate" data-testid={`text-label-${index}`}>
                      {info.parsedRecord.label}
                    </TableCell>
                    <TableCell>
                      {info.isNew ? (
                        <Badge variant="outline" className="text-green-600 border-green-600" data-testid={`badge-status-${index}`}>New</Badge>
                      ) : (
                        <Badge variant="outline" className="text-blue-600 border-blue-600" data-testid={`badge-status-${index}`}>Update</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {duplicateInfos.length > 100 && (
              <div className="text-center text-sm text-muted-foreground py-4" data-testid="text-more-entries">
                ... and {duplicateInfos.length - 100} more entries
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
  
  const renderImportStep = () => (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2" data-testid="text-import-title">
            {isImporting ? (
              <RefreshCw className="w-5 h-5 animate-spin" />
            ) : importResult ? (
              <CheckCircle className="w-5 h-5 text-green-500" />
            ) : (
              <AlertCircle className="w-5 h-5" />
            )}
            {isImporting ? 'Importing Labels...' : importResult ? 'Import Complete' : 'Import'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Progress value={importProgress} data-testid="progress-import" />
          <p className="text-sm text-muted-foreground" data-testid="text-import-status">{importStatus}</p>
          
          {importResult && (
            <div className="grid grid-cols-2 gap-4 mt-6" data-testid="import-result-summary">
              <div className="p-4 bg-green-500/10 rounded-lg" data-testid="card-result-new">
                <div className="text-2xl font-bold text-green-600" data-testid="text-result-new">{importResult.newRecords}</div>
                <div className="text-sm text-muted-foreground" data-testid="label-result-new">New records created</div>
              </div>
              <div className="p-4 bg-blue-500/10 rounded-lg" data-testid="card-result-updated">
                <div className="text-2xl font-bold text-blue-600" data-testid="text-result-updated">{importResult.updatedRecords}</div>
                <div className="text-sm text-muted-foreground" data-testid="label-result-updated">Records updated</div>
              </div>
              {importResult.skippedRecords > 0 && (
                <div className="p-4 bg-muted rounded-lg" data-testid="card-result-skipped">
                  <div className="text-2xl font-bold" data-testid="text-result-skipped">{importResult.skippedRecords}</div>
                  <div className="text-sm text-muted-foreground" data-testid="label-result-skipped">Skipped</div>
                </div>
              )}
              {importResult.failedRecords > 0 && (
                <div className="p-4 bg-destructive/10 rounded-lg" data-testid="card-result-failed">
                  <div className="text-2xl font-bold text-destructive" data-testid="text-result-failed">{importResult.failedRecords}</div>
                  <div className="text-sm text-muted-foreground" data-testid="label-result-failed">Failed</div>
                </div>
              )}
            </div>
          )}
          
          {importResult && describeKeptFieldCounts(importResult.keptFieldCounts).length > 0 && (
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
          
          {importResult?.errors && importResult.errors.length > 0 && (
            <div className="mt-4">
              <p className="text-sm font-medium text-destructive mb-2" data-testid="label-errors">Errors:</p>
              <ScrollArea className="h-[100px]">
                <ul className="text-sm text-muted-foreground space-y-1">
                  {importResult.errors.map((error, i) => (
                    <li key={i} className="flex items-start gap-2" data-testid={`text-error-${i}`}>
                      <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
                      {error}
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
  
  return (
    <div className="flex-1 p-6 overflow-auto">
      <div className="max-w-4xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold" data-testid="text-page-title">BIP-329 Label Import</h1>
          <p className="text-muted-foreground" data-testid="text-page-description">
            Import wallet labels from BIP-329 compatible exports
          </p>
        </div>
        
        {renderStepIndicator()}
        
        {currentStep === 'upload' && renderUploadStep()}
        {currentStep === 'preview' && renderPreviewStep()}
        {currentStep === 'import' && renderImportStep()}
        
        <div className="flex justify-between gap-4 mt-8">
          <Button
            variant="outline"
            onClick={currentStep === 'upload' ? handleReset : handlePrevStep}
            disabled={isImporting || (currentStep === 'import' && importResult !== null)}
            data-testid="button-prev-step"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            {currentStep === 'upload' ? 'Reset' : 'Back'}
          </Button>
          
          {currentStep === 'import' && importResult ? (
            <Button onClick={handleReset} data-testid="button-import-another">
              <RefreshCw className="w-4 h-4 mr-2" />
              Import Another
            </Button>
          ) : (
            <Button
              onClick={handleNextStep}
              disabled={isAnalyzing || isImporting || (currentStep === 'upload' && bip329Records.length === 0)}
              data-testid="button-next-step"
            >
              {isAnalyzing ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  Analyzing...
                </>
              ) : currentStep === 'preview' ? (
                <>
                  Import Labels
                  <ArrowRight className="w-4 h-4 ml-2" />
                </>
              ) : (
                <>
                  Continue
                  <ArrowRight className="w-4 h-4 ml-2" />
                </>
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

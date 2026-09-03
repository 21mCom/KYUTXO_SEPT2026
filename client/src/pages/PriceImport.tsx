import { useState, useCallback, useEffect } from "react";
import { useLocation } from "wouter";
import { useDropzone } from "react-dropzone";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { 
  Upload, 
  FileText, 
  ExternalLink, 
  Check, 
  AlertCircle, 
  ArrowLeft,
  ArrowRight,
  Trash2,
  TrendingUp,
  Database
} from "lucide-react";
import { parsePriceCSV, DATA_SOURCE_URL, getSourceDisplayName, type ParseResult } from "@/lib/price-parser";
import { type PriceData } from "@/lib/database";
import {
  addPriceData,
  updatePriceData,
  clearPriceData,
  countPriceData,
  getPriceDataByKey,
  getPriceDataByAsset,
} from "@/lib/data/price-data-crud";
import { useNodeSettings } from "@/hooks/use-node-settings";
import { isNetworkAccessEnabled } from "@/lib/network-privacy";

export default function PriceImport() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { nodeSettings } = useNodeSettings();
  const networkEnabled = isNetworkAccessEnabled(nodeSettings);
  
  const [step, setStep] = useState(1);
  const [file, setFile] = useState<File | null>(null);
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [asset, setAsset] = useState("BTC");
  const [currency, setCurrency] = useState("USD");
  const [isImporting, setIsImporting] = useState(false);
  const [existingCount, setExistingCount] = useState<number | null>(null);
  const [existingDateRange, setExistingDateRange] = useState<{ first: string; last: string } | null>(null);
  
  const loadExistingDataInfo = useCallback(async (targetAsset: string, targetCurrency: string) => {
    const existing = await getPriceDataByAsset(targetAsset, targetCurrency);
    
    setExistingCount(existing.length);
    
    if (existing.length > 0) {
      const dates = existing.map(p => p.date).sort();
      setExistingDateRange({ first: dates[0], last: dates[dates.length - 1] });
    } else {
      setExistingDateRange(null);
    }
  }, []);

  useEffect(() => {
    loadExistingDataInfo(asset, currency);
  }, [loadExistingDataInfo, asset, currency]);
  
  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0) return;
    
    const selectedFile = acceptedFiles[0];
    setFile(selectedFile);
    
    const content = await selectedFile.text();
    const result = parsePriceCSV(content, asset, currency);
    setParseResult(result);
    
    await loadExistingDataInfo(asset, currency);
  }, [asset, currency, loadExistingDataInfo]);
  
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'text/csv': ['.csv'],
      'text/plain': ['.txt'],
    },
    multiple: false,
  });
  
  const handleAssetChange = async (newAsset: string) => {
    setAsset(newAsset);
    await loadExistingDataInfo(newAsset, currency);
    if (file) {
      const content = await file.text();
      const result = parsePriceCSV(content, newAsset, currency);
      setParseResult(result);
    }
  };
  
  const handleCurrencyChange = async (newCurrency: string) => {
    setCurrency(newCurrency);
    await loadExistingDataInfo(asset, newCurrency);
    if (file) {
      const content = await file.text();
      const result = parsePriceCSV(content, asset, newCurrency);
      setParseResult(result);
    }
  };
  
  const handleClearFile = () => {
    setFile(null);
    setParseResult(null);
  };
  
  const handleImport = async () => {
    if (!networkEnabled) {
      toast({
        title: "Network Offline",
        description: "Enable networking before importing externally-sourced price data.",
        variant: "destructive",
      });
      return;
    }
    if (!parseResult || !parseResult.success) return;
    
    setIsImporting(true);
    
    try {
      const now = Date.now();
      const priceDataToInsert: PriceData[] = parseResult.data.map(d => ({
        ...d,
        importedAt: now,
      }));
      
      let inserted = 0;
      let updated = 0;
      
      for (const pricePoint of priceDataToInsert) {
        const existing = await getPriceDataByKey(
          pricePoint.date,
          pricePoint.currency,
          pricePoint.asset,
        );
        
        if (existing) {
          await updatePriceData(existing.id!, pricePoint);
          updated++;
        } else {
          await addPriceData(pricePoint);
          inserted++;
        }
      }
      
      toast({
        title: "Import Complete",
        description: `Added ${inserted} new price points${updated > 0 ? `, updated ${updated} existing` : ''}.`,
      });
      
      setStep(3);
    } catch (error) {
      console.error('Import error:', error);
      toast({
        title: "Import Failed",
        description: error instanceof Error ? error.message : "An error occurred during import",
        variant: "destructive",
      });
    } finally {
      setIsImporting(false);
    }
  };
  
  const handleDeleteAllPriceData = async () => {
    try {
      const count = await countPriceData();
      await clearPriceData();
      toast({
        title: "Price Data Cleared",
        description: `Deleted ${count} price records.`,
      });
      setExistingCount(0);
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to clear price data",
        variant: "destructive",
      });
    }
  };
  
  const formatDate = (dateStr: string) => {
    const [year, month, day] = dateStr.split('-');
    return `${month}/${day}/${year}`;
  };
  
  const formatPrice = (price: number | undefined) => {
    if (price === undefined) return '-';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(price);
  };

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate("/")} data-testid="button-back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-page-title">Historical Price Import</h1>
            <p className="text-muted-foreground">Import Bitcoin price history for future reporting</p>
          </div>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-2">
          <Badge variant={step >= 1 ? "default" : "outline"} data-testid="badge-step-1">1. Upload</Badge>
          <div className="h-px w-8 bg-border" />
          <Badge variant={step >= 2 ? "default" : "outline"} data-testid="badge-step-2">2. Review</Badge>
          <div className="h-px w-8 bg-border" />
          <Badge variant={step >= 3 ? "default" : "outline"} data-testid="badge-step-3">3. Done</Badge>
        </div>

        {step === 1 && (
          <div className="space-y-6">
            {/* Data Source Card */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ExternalLink className="h-5 w-5" />
                  Download Price Data
                </CardTitle>
                <CardDescription>
                  Download historical Bitcoin price data from Investing.com, then upload the CSV file below.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <a
                  href={networkEnabled ? DATA_SOURCE_URL : undefined}
                  target={networkEnabled ? "_blank" : undefined}
                  rel={networkEnabled ? "noopener noreferrer" : undefined}
                  aria-disabled={!networkEnabled}
                  onClick={(event) => {
                    if (!networkEnabled) {
                      event.preventDefault();
                      toast({
                        title: "Network Offline",
                        description: "Use the header privacy control before opening a price-data provider.",
                      });
                    }
                  }}
                  className={`flex items-center justify-between p-4 rounded-lg border transition-colors ${networkEnabled ? 'hover-elevate' : 'opacity-60 cursor-not-allowed'}`}
                  data-testid="link-source-investing"
                >
                  <div>
                    <div className="font-medium">Investing.com</div>
                    <p className="text-sm text-muted-foreground mt-1">
                      Historical data back to 2010. Click "Download Data" on the page to get a CSV file.
                    </p>
                    <Badge variant="outline" className="mt-2 text-xs">CSV with Date, Price, Open, High, Low, Vol.</Badge>
                  </div>
                  <ExternalLink className="h-5 w-5 text-muted-foreground flex-shrink-0 ml-4" />
                </a>
              </CardContent>
            </Card>

            {/* Asset & Currency Selection */}
            <Card>
              <CardHeader>
                <CardTitle>Import Settings</CardTitle>
                <CardDescription>Configure what asset and currency this price data represents</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="asset">Asset</Label>
                    <Select value={asset} onValueChange={handleAssetChange}>
                      <SelectTrigger id="asset" data-testid="select-asset">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="BTC">Bitcoin (BTC)</SelectItem>
                        <SelectItem value="ETH">Ethereum (ETH)</SelectItem>
                        <SelectItem value="LTC">Litecoin (LTC)</SelectItem>
                        <SelectItem value="XMR">Monero (XMR)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="currency">Currency</Label>
                    <Select value={currency} onValueChange={handleCurrencyChange}>
                      <SelectTrigger id="currency" data-testid="select-currency">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="USD">US Dollar (USD)</SelectItem>
                        <SelectItem value="EUR">Euro (EUR)</SelectItem>
                        <SelectItem value="GBP">British Pound (GBP)</SelectItem>
                        <SelectItem value="JPY">Japanese Yen (JPY)</SelectItem>
                        <SelectItem value="CAD">Canadian Dollar (CAD)</SelectItem>
                        <SelectItem value="AUD">Australian Dollar (AUD)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Existing Data Summary */}
            {existingCount !== null && existingCount > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Database className="h-5 w-5" />
                    Current Price Data
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col gap-1 text-sm">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{asset}/{currency}</Badge>
                      <span className="text-muted-foreground">
                        {existingCount.toLocaleString()} records
                      </span>
                    </div>
                    {existingDateRange && (
                      <p className="text-muted-foreground">
                        Date range: <span className="font-medium text-foreground">{formatDate(existingDateRange.first)}</span> to <span className="font-medium text-foreground">{formatDate(existingDateRange.last)}</span>
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* File Upload */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Upload className="h-5 w-5" />
                  Upload CSV File
                </CardTitle>
                <CardDescription>
                  Drag and drop a CSV file, or click to select one
                </CardDescription>
              </CardHeader>
              <CardContent>
                {!file ? (
                  <div
                    {...getRootProps()}
                    className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
                      isDragActive ? 'border-primary bg-primary/5' : 'border-muted-foreground/25 hover:border-primary/50'
                    }`}
                    data-testid="dropzone-file"
                  >
                    <input {...getInputProps()} data-testid="input-file" />
                    <FileText className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                    <p className="text-lg font-medium">
                      {isDragActive ? 'Drop the file here' : 'Drop CSV file here or click to browse'}
                    </p>
                    <p className="text-sm text-muted-foreground mt-1">
                      Supports Investing.com CSV format
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between p-4 rounded-lg bg-muted/50">
                      <div className="flex items-center gap-3">
                        <FileText className="h-8 w-8 text-primary" />
                        <div>
                          <p className="font-medium">{file.name}</p>
                          <p className="text-sm text-muted-foreground">
                            {(file.size / 1024).toFixed(1)} KB
                          </p>
                        </div>
                      </div>
                      <Button variant="ghost" size="icon" onClick={handleClearFile} data-testid="button-clear-file">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                    
                    {parseResult && (
                      <div className="space-y-3">
                        {parseResult.success ? (
                          <Alert>
                            <Check className="h-4 w-4" />
                            <AlertTitle>File parsed successfully</AlertTitle>
                            <AlertDescription>
                              Found {parseResult.data.length} price records from{' '}
                              <strong>{getSourceDisplayName(parseResult.source)}</strong> format
                              {parseResult.skipped > 0 && ` (${parseResult.skipped} rows skipped)`}
                            </AlertDescription>
                          </Alert>
                        ) : (
                          <Alert variant="destructive">
                            <AlertCircle className="h-4 w-4" />
                            <AlertTitle>Parse Error</AlertTitle>
                            <AlertDescription>
                              {parseResult.errors[0] || 'Could not parse the file'}
                            </AlertDescription>
                          </Alert>
                        )}
                        
                        {parseResult.errors.length > 0 && parseResult.success && (
                          <Alert>
                            <AlertCircle className="h-4 w-4" />
                            <AlertTitle>Warnings</AlertTitle>
                            <AlertDescription>
                              <ul className="list-disc list-inside mt-1 text-sm">
                                {parseResult.errors.slice(0, 5).map((err, i) => (
                                  <li key={i}>{err}</li>
                                ))}
                                {parseResult.errors.length > 5 && (
                                  <li>...and {parseResult.errors.length - 5} more</li>
                                )}
                              </ul>
                            </AlertDescription>
                          </Alert>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
              {parseResult?.success && (
                <CardFooter className="flex justify-between gap-2">
                  <div className="text-sm text-muted-foreground">
                    {existingCount !== null && existingCount > 0 && (
                      <span>You have {existingCount} existing {asset}/{currency} price records</span>
                    )}
                  </div>
                  <Button onClick={() => setStep(2)} data-testid="button-continue">
                    Continue <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                </CardFooter>
              )}
            </Card>
            
            {/* Data Management */}
            {existingCount !== null && existingCount > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Trash2 className="h-5 w-5" />
                    Data Management
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Button 
                    variant="destructive" 
                    onClick={handleDeleteAllPriceData}
                    data-testid="button-delete-all-prices"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Clear All Price Data
                  </Button>
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {step === 2 && parseResult?.success && (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="h-5 w-5" />
                  Review Import
                </CardTitle>
                <CardDescription>
                  Importing {parseResult.data.length} price records for {asset}/{currency}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {existingDateRange && existingCount && existingCount > 0 && (
                  <Alert className="mb-6">
                    <Database className="h-4 w-4" />
                    <AlertTitle>Existing Data</AlertTitle>
                    <AlertDescription>
                      You have {existingCount.toLocaleString()} existing records covering{' '}
                      {formatDate(existingDateRange.first)} to {formatDate(existingDateRange.last)}.
                      Importing will update overlapping dates and add new ones.
                    </AlertDescription>
                  </Alert>
                )}
                <div className="grid gap-4 sm:grid-cols-3 mb-6">
                  <div className="p-4 rounded-lg bg-muted/50">
                    <p className="text-sm text-muted-foreground">Date Range</p>
                    <p className="font-medium">
                      {formatDate(parseResult.data[0]?.date || '')} - {formatDate(parseResult.data[parseResult.data.length - 1]?.date || '')}
                    </p>
                  </div>
                  <div className="p-4 rounded-lg bg-muted/50">
                    <p className="text-sm text-muted-foreground">Total Records</p>
                    <p className="font-medium">{parseResult.data.length.toLocaleString()}</p>
                  </div>
                  <div className="p-4 rounded-lg bg-muted/50">
                    <p className="text-sm text-muted-foreground">Source</p>
                    <p className="font-medium">{getSourceDisplayName(parseResult.source)}</p>
                  </div>
                </div>
                
                <div className="border rounded-lg">
                  <div className="p-2 bg-muted/30 text-sm font-medium">
                    Preview (first 10 and last 5 records)
                  </div>
                  <ScrollArea className="h-80">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Date</TableHead>
                          <TableHead className="text-right">Close</TableHead>
                          <TableHead className="text-right">Open</TableHead>
                          <TableHead className="text-right">High</TableHead>
                          <TableHead className="text-right">Low</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {parseResult.data.slice(0, 10).map((row, i) => (
                          <TableRow key={`start-${i}`}>
                            <TableCell>{formatDate(row.date)}</TableCell>
                            <TableCell className="text-right font-mono">{formatPrice(row.close)}</TableCell>
                            <TableCell className="text-right font-mono text-muted-foreground">{formatPrice(row.open)}</TableCell>
                            <TableCell className="text-right font-mono text-muted-foreground">{formatPrice(row.high)}</TableCell>
                            <TableCell className="text-right font-mono text-muted-foreground">{formatPrice(row.low)}</TableCell>
                          </TableRow>
                        ))}
                        {parseResult.data.length > 15 && (
                          <TableRow>
                            <TableCell colSpan={5} className="text-center text-muted-foreground py-4">
                              ... {parseResult.data.length - 15} more records ...
                            </TableCell>
                          </TableRow>
                        )}
                        {parseResult.data.slice(-5).map((row, i) => (
                          <TableRow key={`end-${i}`}>
                            <TableCell>{formatDate(row.date)}</TableCell>
                            <TableCell className="text-right font-mono">{formatPrice(row.close)}</TableCell>
                            <TableCell className="text-right font-mono text-muted-foreground">{formatPrice(row.open)}</TableCell>
                            <TableCell className="text-right font-mono text-muted-foreground">{formatPrice(row.high)}</TableCell>
                            <TableCell className="text-right font-mono text-muted-foreground">{formatPrice(row.low)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </ScrollArea>
                </div>
              </CardContent>
              <CardFooter className="flex justify-between gap-2">
                <Button variant="outline" onClick={() => setStep(1)} data-testid="button-back-step">
                  <ArrowLeft className="mr-2 h-4 w-4" /> Back
                </Button>
                <Button onClick={handleImport} disabled={isImporting} data-testid="button-import">
                  {isImporting ? 'Importing...' : `Import ${parseResult.data.length.toLocaleString()} Records`}
                </Button>
              </CardFooter>
            </Card>
          </div>
        )}

        {step === 3 && (
          <Card>
            <CardContent className="pt-6">
              <div className="text-center space-y-4">
                <div className="mx-auto w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                  <Check className="h-8 w-8 text-green-600 dark:text-green-400" />
                </div>
                <h2 className="text-xl font-semibold">Import Complete!</h2>
                <p className="text-muted-foreground">
                  Your historical price data has been imported and is ready for use in future reporting features.
                </p>
                <div className="flex justify-center gap-4 pt-4">
                  <Button variant="outline" onClick={() => { setStep(1); handleClearFile(); }} data-testid="button-import-more">
                    Import More Data
                  </Button>
                  <Button onClick={() => navigate("/")} data-testid="button-done">
                    Done
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

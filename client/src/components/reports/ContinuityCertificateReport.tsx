import { useState, useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, type CustodySegment, type UtxoLineage } from "@/lib/database";
import { 
  generateEvidenceBundle, 
  downloadEvidenceBundle,
  downloadEvidenceBundlePdf,
  type EvidenceBundleOptions,
  type ProgressCallback
} from "@/lib/lineageEngine";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { format } from "date-fns";
import { 
  CalendarIcon, Shield, Clock, Coins, 
  ArrowRight, Filter, FileJson, FileText, Lock, Eye,
  AlertTriangle, RefreshCw
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { AddressLink } from "@/components/AddressLink";
import { TxidLink } from "@/components/TxidLink";

interface CertificateData {
  segment: CustodySegment;
  lineageChain: UtxoLineage[];
  totalDuration: number;
  originDate: Date;
  currentDate: Date;
}

const formatBtc = (sats: number): string => {
  return (sats / 100000000).toFixed(8);
};

const formatDuration = (days: number): string => {
  if (days < 30) return `${days} days`;
  if (days < 365) return `${Math.floor(days / 30)} months`;
  return `${(days / 365).toFixed(1)} years`;
};

export function ContinuityCertificateReport() {
  const [dateRange, setDateRange] = useState<{ from: Date | undefined; to: Date | undefined }>({
    from: undefined,
    to: undefined
  });
  const [minAmount, setMinAmount] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedCertificates, setSelectedCertificates] = useState<Set<number>>(new Set());
  
  // Disclosure options for selective export
  const [includeAddresses, setIncludeAddresses] = useState(true);
  const [includeTxids, setIncludeTxids] = useState(true);
  const [includeLineageChain, setIncludeLineageChain] = useState(true);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ current: number; total: number } | null>(null);
  const [exportError, setExportError] = useState<{ message: string; format: 'json' | 'pdf' } | null>(null);
  const { toast } = useToast();

  const segments = useLiveQuery(async () => {
    return await db.custodySegments.toArray();
  }, []);

  const lineageRecords = useLiveQuery(async () => {
    return await db.utxoLineage.toArray();
  }, []);

  const certificateData = useMemo((): CertificateData[] => {
    if (!segments || !lineageRecords) return [];

    return segments.map(segment => {
      const chain = lineageRecords.filter(l => 
        l.createdAddress === segment.originAddress || 
        l.createdAddress === segment.currentAddress ||
        l.spentAddress === segment.originAddress ||
        l.spentAddress === segment.currentAddress
      );

      const originDateVal = new Date(segment.originDate * 1000);
      const currentDate = new Date();
      
      const totalDuration = Math.floor((currentDate.getTime() - originDateVal.getTime()) / (1000 * 60 * 60 * 24));

      return {
        segment,
        lineageChain: chain,
        totalDuration,
        originDate: originDateVal,
        currentDate
      };
    });
  }, [segments, lineageRecords]);

  const filteredCertificates = useMemo(() => {
    return certificateData.filter(cert => {
      if (dateRange.from && cert.originDate < dateRange.from) return false;
      if (dateRange.to && cert.originDate > dateRange.to) return false;
      
      if (minAmount) {
        const minSats = parseFloat(minAmount) * 100000000;
        if (cert.segment.currentAmount < minSats) return false;
      }
      
      if (statusFilter !== "all" && cert.segment.status !== statusFilter) return false;
      
      return true;
    });
  }, [certificateData, dateRange, minAmount, statusFilter]);

  const toggleCertificate = (id: number) => {
    setSelectedCertificates(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelectedCertificates(new Set(filteredCertificates.map(c => c.segment.id!)));
  };

  const clearSelection = () => {
    setSelectedCertificates(new Set());
  };

  const exportSelectedCertificates = async (exportFormat: 'json' | 'pdf') => {
    const selected = filteredCertificates.filter(c => selectedCertificates.has(c.segment.id!));
    const selectedSegmentIds = selected.map(c => c.segment.segmentId);
    
    setIsExporting(true);
    setExportError(null);
    setExportProgress({ current: 0, total: selectedSegmentIds.length });
    try {
      const options: EvidenceBundleOptions = {
        includeAddresses,
        includeTxids,
        includeLineageChain,
        redactExternalAddresses: false,
        selectedSegmentIds
      };

      const handleProgress: ProgressCallback = (current, total) => {
        setExportProgress({ current, total });
      };
      
      const bundle = await generateEvidenceBundle(options, handleProgress);
      const dateStr = format(new Date(), 'yyyy-MM-dd');
      
      if (exportFormat === 'pdf') {
        await downloadEvidenceBundlePdf(bundle, `evidence-bundle-${dateStr}.pdf`);
      } else {
        downloadEvidenceBundle(bundle, `evidence-bundle-${dateStr}.json`);
      }
      setExportProgress(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "An unexpected error occurred during export";
      setExportError({ message, format: exportFormat });
      toast({
        title: "Export failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'held':
        return <Badge className="bg-green-600">Held</Badge>;
      case 'spent':
        return <Badge variant="secondary">Spent</Badge>;
      case 'split':
        return <Badge variant="outline">Split</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-4 p-4 bg-muted/30 rounded-lg">
        <div className="space-y-2">
          <Label className="text-xs font-medium flex items-center gap-1">
            <CalendarIcon className="h-3 w-3" />
            Origin Date Range
          </Label>
          <div className="flex items-center gap-2">
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="w-[130px] justify-start text-left font-normal">
                  <CalendarIcon className="mr-2 h-3 w-3" />
                  {dateRange.from ? format(dateRange.from, "MMM d, yyyy") : "From"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={dateRange.from}
                  onSelect={(date) => setDateRange(prev => ({ ...prev, from: date }))}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
            <span className="text-muted-foreground">to</span>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="w-[130px] justify-start text-left font-normal">
                  <CalendarIcon className="mr-2 h-3 w-3" />
                  {dateRange.to ? format(dateRange.to, "MMM d, yyyy") : "To"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={dateRange.to}
                  onSelect={(date) => setDateRange(prev => ({ ...prev, to: date }))}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
          </div>
        </div>

        <div className="space-y-2">
          <Label className="text-xs font-medium flex items-center gap-1">
            <Coins className="h-3 w-3" />
            Min Amount (BTC)
          </Label>
          <Input
            type="number"
            step="0.00000001"
            placeholder="0.0"
            value={minAmount}
            onChange={(e) => setMinAmount(e.target.value)}
            className="w-32"
            data-testid="input-min-amount"
          />
        </div>

        <div className="space-y-2">
          <Label className="text-xs font-medium flex items-center gap-1">
            <Filter className="h-3 w-3" />
            Status
          </Label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-32" data-testid="select-status">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="held">Held</SelectItem>
              <SelectItem value="spent">Spent</SelectItem>
              <SelectItem value="split">Split</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Button 
            variant="outline" 
            size="sm"
            onClick={selectAll}
            data-testid="button-select-all"
          >
            Select All
          </Button>
          <Button 
            variant="outline" 
            size="sm"
            onClick={clearSelection}
            disabled={selectedCertificates.size === 0}
            data-testid="button-clear-selection"
          >
            Clear
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-6 p-4 bg-muted/20 rounded-lg border">
        <div className="flex items-center gap-2">
          <Lock className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Disclosure Controls:</span>
        </div>
        
        <div className="flex items-center gap-2">
          <Switch
            id="include-addresses"
            checked={includeAddresses}
            onCheckedChange={setIncludeAddresses}
            data-testid="switch-include-addresses"
          />
          <Label htmlFor="include-addresses" className="text-sm cursor-pointer">
            {includeAddresses ? <Eye className="h-3 w-3 inline mr-1" /> : <Lock className="h-3 w-3 inline mr-1" />}
            Addresses
          </Label>
        </div>
        
        <div className="flex items-center gap-2">
          <Switch
            id="include-txids"
            checked={includeTxids}
            onCheckedChange={setIncludeTxids}
            data-testid="switch-include-txids"
          />
          <Label htmlFor="include-txids" className="text-sm cursor-pointer">
            {includeTxids ? <Eye className="h-3 w-3 inline mr-1" /> : <Lock className="h-3 w-3 inline mr-1" />}
            Transaction IDs
          </Label>
        </div>
        
        <div className="flex items-center gap-2">
          <Switch
            id="include-lineage"
            checked={includeLineageChain}
            onCheckedChange={setIncludeLineageChain}
            data-testid="switch-include-lineage"
          />
          <Label htmlFor="include-lineage" className="text-sm cursor-pointer">
            {includeLineageChain ? <Eye className="h-3 w-3 inline mr-1" /> : <Lock className="h-3 w-3 inline mr-1" />}
            Lineage Chain
          </Label>
        </div>
        
        <div className="ml-auto flex items-center gap-2">
          <Button 
            variant="outline"
            onClick={() => exportSelectedCertificates('json')}
            disabled={selectedCertificates.size === 0 || isExporting}
            data-testid="button-export-json"
          >
            <FileJson className="h-4 w-4 mr-2" />
            {isExporting ? "..." : "JSON"}
          </Button>
          <Button 
            onClick={() => exportSelectedCertificates('pdf')}
            disabled={selectedCertificates.size === 0 || isExporting}
            data-testid="button-export-pdf"
          >
            <FileText className="h-4 w-4 mr-2" />
            {isExporting ? "Exporting..." : `Export PDF (${selectedCertificates.size})`}
          </Button>
        </div>
      </div>

      {exportError && !isExporting && (
        <div className="flex items-center gap-3 p-3 bg-destructive/10 border border-destructive/30 rounded-lg" data-testid="export-error">
          <AlertTriangle className="h-5 w-5 text-destructive shrink-0" />
          <div className="flex-1 space-y-1">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="text-destructive font-medium">
                Export failed
              </span>
              <span className="text-muted-foreground text-xs truncate max-w-[300px]">
                {exportError.message}
              </span>
            </div>
            <Progress
              value={exportProgress && exportProgress.total > 0
                ? (exportProgress.current / exportProgress.total) * 100
                : 0}
              className="h-2 [&>div]:bg-destructive"
              data-testid="progress-bar-error"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => exportSelectedCertificates(exportError.format)}
            disabled={selectedCertificates.size === 0}
            data-testid="button-retry-export"
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Retry
          </Button>
        </div>
      )}

      {isExporting && exportProgress && exportProgress.total > 0 && (
        <div className="flex items-center gap-3 p-3 bg-muted/30 rounded-lg" data-testid="export-progress">
          <div className="flex-1 space-y-1">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                Processing segment {exportProgress.current} of {exportProgress.total}
              </span>
              <span className="font-medium tabular-nums">
                {exportProgress.total > 0
                  ? Math.round((exportProgress.current / exportProgress.total) * 100)
                  : 0}%
              </span>
            </div>
            <Progress
              value={exportProgress.total > 0
                ? (exportProgress.current / exportProgress.total) * 100
                : 0}
              className="h-2"
              data-testid="progress-bar"
            />
          </div>
        </div>
      )}

      <div className="text-sm text-muted-foreground">
        Showing {filteredCertificates.length} of {certificateData.length} custody segments
      </div>

      <ScrollArea className="h-[500px]">
        <div className="space-y-4">
          {filteredCertificates.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Shield className="h-12 w-12 mx-auto mb-4 opacity-30" />
              <p>No custody segments found matching your filters.</p>
              <p className="text-sm mt-2">
                Use the Continuity Proof tool on the Provenance page to generate lineage data first.
              </p>
            </div>
          ) : (
            filteredCertificates.map((cert) => (
              <div 
                key={cert.segment.id}
                className={`p-4 rounded-lg border transition-colors cursor-pointer ${
                  selectedCertificates.has(cert.segment.id!) 
                    ? 'border-primary bg-primary/5' 
                    : 'hover-elevate'
                }`}
                onClick={() => toggleCertificate(cert.segment.id!)}
                data-testid={`certificate-${cert.segment.id}`}
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Shield className="h-5 w-5 text-primary" />
                    <span className="font-medium">Continuity Certificate</span>
                    {getStatusBadge(cert.segment.status)}
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Clock className="h-4 w-4" />
                    <span>{formatDuration(cert.totalDuration)} custody</span>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-3">
                  <div className="space-y-2">
                    <div className="text-xs font-medium text-muted-foreground">ORIGIN</div>
                    <div className="flex items-center gap-2">
                      <AddressLink address={cert.segment.originAddress} truncate />
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {format(cert.originDate, "MMM d, yyyy")}
                    </div>
                    <TxidLink txid={cert.segment.originTxid} />
                  </div>

                  <div className="space-y-2">
                    <div className="text-xs font-medium text-muted-foreground">CURRENT</div>
                    <div className="flex items-center gap-2">
                      {cert.segment.currentAddress ? (
                        <AddressLink address={cert.segment.currentAddress} truncate />
                      ) : (
                        <span className="text-muted-foreground">Same as origin</span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {cert.segment.status === 'spent' ? "Spent" : "Active"}
                    </div>
                    <div className="font-mono text-sm font-medium">
                      {formatBtc(cert.segment.currentAmount)} BTC
                    </div>
                  </div>
                </div>

                {cert.segment.acquisitionMethod && (
                  <div className="bg-muted/30 rounded p-3 text-sm">
                    <span className="text-muted-foreground">Acquisition: </span>
                    {cert.segment.acquisitionMethod}
                    {cert.segment.costBasisUsd && (
                      <span className="ml-2">(${cert.segment.costBasisUsd.toFixed(2)} USD cost basis)</span>
                    )}
                  </div>
                )}

                {cert.lineageChain.length > 0 && (
                  <div className="mt-3 pt-3 border-t">
                    <div className="text-xs font-medium text-muted-foreground mb-2">
                      LINEAGE CHAIN ({cert.lineageChain.length} links)
                    </div>
                    <div className="flex flex-wrap items-center gap-1 text-xs">
                      {cert.lineageChain.slice(0, 5).map((link, idx) => (
                        <span key={`${link.createdTxid}-${idx}`} className="flex items-center gap-1">
                          <Badge variant="outline" className="text-xs">
                            {link.spentAddress.slice(0, 8)}...
                          </Badge>
                          <ArrowRight className="h-3 w-3 text-muted-foreground" />
                        </span>
                      ))}
                      {cert.lineageChain.length > 5 && (
                        <Badge variant="secondary" className="text-xs">
                          +{cert.lineageChain.length - 5} more
                        </Badge>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

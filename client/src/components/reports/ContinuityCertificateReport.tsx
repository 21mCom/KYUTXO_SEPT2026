import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, type CustodySegment, type UtxoLineage } from "@/lib/database";
import { 
  generateEvidenceBundle, 
  downloadEvidenceBundle,
  downloadEvidenceBundlePdf,
  PartialBundleError,
  type EvidenceBundle,
  type EvidenceBundleOptions,
  type ProgressCallback
} from "@/lib/lineageEngine";
import {
  savePartialBundle,
  loadPartialBundle,
  clearPartialBundle,
} from "@/lib/partialBundleStore";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { format } from "date-fns";
import { 
  CalendarIcon, Shield, Clock, Coins, 
  ArrowRight, Filter, FileJson, FileText, Lock, Eye,
  AlertTriangle, RefreshCw, X, Download, Loader2, Ban, ChevronDown, ChevronRight
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
  const [resumedFromCount, setResumedFromCount] = useState(0);
  const [resumedSegmentIds, setResumedSegmentIds] = useState<string[]>([]);
  const [showResumedDetails, setShowResumedDetails] = useState(false);
  const [exportError, setExportError] = useState<{ message: string; format: 'json' | 'pdf'; partialBundle?: EvidenceBundle } | null>(null);
  const [cancelledPartial, setCancelledPartial] = useState<{ bundle: EvidenceBundle; format: 'json' | 'pdf'; totalRequested: number } | null>(null);
  const [isDownloadingPartial, setIsDownloadingPartial] = useState(false);
  const exportAbortRef = useRef<AbortController | null>(null);
  const { toast } = useToast();

  const handleCancelExport = useCallback(() => {
    if (exportAbortRef.current) {
      exportAbortRef.current.abort();
    }
  }, []);

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

  const currentSelectedSegmentIds = useMemo(() => {
    return filteredCertificates
      .filter(c => selectedCertificates.has(c.segment.id!))
      .map(c => c.segment.segmentId);
  }, [filteredCertificates, selectedCertificates]);

  const segmentLabelMap = useMemo(() => {
    const map = new Map<string, string>();
    if (!segments) return map;
    for (const seg of segments) {
      const prefix = seg.originAddress.slice(0, 8);
      map.set(seg.segmentId, `${prefix}\u2026`);
    }
    return map;
  }, [segments]);

  const getSegmentLabel = useCallback((segmentId: string): string => {
    return segmentLabelMap.get(segmentId) || segmentId.slice(0, 12) + '\u2026';
  }, [segmentLabelMap]);

  useEffect(() => {
    if (currentSelectedSegmentIds.length === 0 || isExporting) return;
    let cancelled = false;
    loadPartialBundle(currentSelectedSegmentIds).then(persisted => {
      if (cancelled || !persisted) return;
      const processed = persisted.bundle.summary.totalSegments;
      const total = persisted.bundle.requestedSegments ?? currentSelectedSegmentIds.length;
      setExportError({
        message: `Previous incomplete export found (${processed} of ${total} segments).`,
        format: persisted.format,
        partialBundle: persisted.bundle,
      });
      setExportProgress({
        current: processed,
        total,
      });
      toast({
        title: "Incomplete export restored",
        description: `${processed} of ${total} segments were previously processed. You can resume or download the partial results.`,
      });
    });
    return () => { cancelled = true; };
  }, [currentSelectedSegmentIds, isExporting]);

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

  const exportSelectedCertificates = async (exportFormat: 'json' | 'pdf', resumeFromBundle?: EvidenceBundle) => {
    const selected = filteredCertificates.filter(c => selectedCertificates.has(c.segment.id!));
    const selectedSegmentIds = selected.map(c => c.segment.segmentId);
    
    const controller = new AbortController();
    exportAbortRef.current = controller;
    setIsExporting(true);
    setExportError(null);
    setCancelledPartial(null);
    const priorCount = resumeFromBundle ? resumeFromBundle.segments.length : 0;
    const priorIds = resumeFromBundle ? resumeFromBundle.segments.map(s => s.segmentId) : [];
    setResumedFromCount(priorCount);
    setResumedSegmentIds(priorIds);
    setShowResumedDetails(false);
    setExportProgress({ current: priorCount, total: selectedSegmentIds.length });
    try {
      const options: EvidenceBundleOptions = {
        includeAddresses,
        includeTxids,
        includeLineageChain,
        redactExternalAddresses: false,
        selectedSegmentIds,
        resumeFromBundle
      };

      const handleProgress: ProgressCallback = (current, total) => {
        setExportProgress({ current, total });
      };
      
      const bundle = await generateEvidenceBundle(options, handleProgress, controller.signal);
      const dateStr = format(new Date(), 'yyyy-MM-dd');

      if (controller.signal.aborted) {
        if (bundle.isPartial && bundle.summary.totalSegments > 0) {
          setCancelledPartial({
            bundle,
            format: exportFormat,
            totalRequested: bundle.requestedSegments ?? selectedSegmentIds.length
          });
          await savePartialBundle(bundle, exportFormat, selectedSegmentIds);
          toast({
            title: "Export cancelled",
            description: `${bundle.summary.totalSegments} of ${bundle.requestedSegments ?? selectedSegmentIds.length} segments processed. You can download the partial results.`,
          });
        } else {
          toast({
            title: "Export cancelled",
            description: "Evidence bundle generation was cancelled.",
          });
        }
        setExportProgress(null);
        return;
      }
      
      if (exportFormat === 'pdf') {
        await downloadEvidenceBundlePdf(bundle, `evidence-bundle-${dateStr}.pdf`);
      } else {
        downloadEvidenceBundle(bundle, `evidence-bundle-${dateStr}.json`);
      }
      await clearPartialBundle(selectedSegmentIds);
      setExportProgress(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "An unexpected error occurred during export";
      const partialBundle = err instanceof PartialBundleError ? err.partialBundle : undefined;
      setExportError({ message, format: exportFormat, partialBundle });
      if (partialBundle) {
        await savePartialBundle(partialBundle, exportFormat, selectedSegmentIds);
      }
      toast({
        title: partialBundle ? "Export partially completed" : "Export failed",
        description: partialBundle
          ? `${partialBundle.summary.totalSegments} of ${partialBundle.requestedSegments} segments processed. You can download the partial results or resume.`
          : message,
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
      exportAbortRef.current = null;
    }
  };

  const downloadPartialBundle = async (bundle: EvidenceBundle, exportFormat: 'json' | 'pdf') => {
    setIsDownloadingPartial(true);
    try {
      const dateStr = format(new Date(), 'yyyy-MM-dd');
      if (exportFormat === 'pdf') {
        await downloadEvidenceBundlePdf(bundle, `evidence-bundle-partial-${dateStr}.pdf`);
      } else {
        downloadEvidenceBundle(bundle, `evidence-bundle-partial-${dateStr}.json`);
      }
      toast({
        title: "Partial download complete",
        description: `Downloaded ${bundle.summary.totalSegments} of ${bundle.requestedSegments} segments.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to generate partial download";
      toast({
        title: "Partial download failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsDownloadingPartial(false);
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
        <div className="flex flex-col gap-2 p-3 bg-destructive/10 border border-destructive/30 rounded-lg" data-testid="export-error">
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-destructive shrink-0" />
            <div className="flex-1 space-y-1">
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="text-destructive font-medium">
                  {exportError.partialBundle ? "Export partially completed" : "Export failed"}
                </span>
                <span className="text-muted-foreground text-xs truncate max-w-[300px]">
                  {exportError.message}
                </span>
              </div>
              {(() => {
                const errorClamped = exportProgress && exportProgress.total > 0
                  ? Math.min(resumedFromCount, exportProgress.total)
                  : 0;
                return errorClamped > 0 && exportProgress && exportProgress.total > 0 ? (
                  <div
                    className="relative h-2 w-full overflow-hidden rounded-full bg-secondary"
                    data-testid="progress-bar-error"
                  >
                    <div
                      className="absolute left-0 h-full bg-destructive/30 transition-all"
                      style={{ width: `${(errorClamped / exportProgress.total) * 100}%` }}
                    />
                    <div
                      className="absolute h-full bg-destructive transition-all"
                      style={{
                        left: `${(errorClamped / exportProgress.total) * 100}%`,
                        width: `${(Math.max(0, exportProgress.current - errorClamped) / exportProgress.total) * 100}%`
                      }}
                    />
                  </div>
                ) : (
                  <Progress
                    value={exportProgress && exportProgress.total > 0
                      ? (exportProgress.current / exportProgress.total) * 100
                      : 0}
                    className="h-2 [&>div]:bg-destructive"
                    data-testid="progress-bar-error"
                  />
                );
              })()}
            </div>
            <div className="flex items-center gap-2">
              {exportError.partialBundle && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => downloadPartialBundle(exportError.partialBundle!, exportError.format)}
                    disabled={isDownloadingPartial}
                    data-testid="button-download-partial"
                  >
                    {isDownloadingPartial ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4 mr-2" />
                    )}
                    {isDownloadingPartial
                      ? "Downloading..."
                      : `Download partial (${exportError.partialBundle.summary.totalSegments}/${exportError.partialBundle.requestedSegments})`}
                  </Button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span tabIndex={isDownloadingPartial ? 0 : undefined}>
                        <Button
                          size="sm"
                          onClick={() => exportSelectedCertificates(exportError.format, exportError.partialBundle!)}
                          disabled={selectedCertificates.size === 0 || isDownloadingPartial}
                          data-testid="button-resume-export"
                        >
                          <ArrowRight className="h-4 w-4 mr-2" />
                          Resume
                        </Button>
                      </span>
                    </TooltipTrigger>
                    {isDownloadingPartial && (
                      <TooltipContent>Download in progress…</TooltipContent>
                    )}
                  </Tooltip>
                </>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={isDownloadingPartial ? 0 : undefined}>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => exportSelectedCertificates(exportError.format)}
                      disabled={selectedCertificates.size === 0 || isDownloadingPartial}
                      data-testid="button-retry-export"
                    >
                      <RefreshCw className="h-4 w-4 mr-2" />
                      Retry
                    </Button>
                  </span>
                </TooltipTrigger>
                {isDownloadingPartial && (
                  <TooltipContent>Download in progress…</TooltipContent>
                )}
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={isDownloadingPartial ? 0 : undefined}>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        setExportError(null);
                        clearPartialBundle(currentSelectedSegmentIds);
                      }}
                      disabled={isDownloadingPartial}
                      data-testid="button-dismiss-export-error"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </span>
                </TooltipTrigger>
                {isDownloadingPartial && (
                  <TooltipContent>Download in progress…</TooltipContent>
                )}
              </Tooltip>
            </div>
          </div>
          {exportError.partialBundle && (
            <div className="flex items-center gap-2 ml-8 text-xs text-muted-foreground" data-testid="text-partial-info">
              <Badge variant="outline" className="text-xs">INCOMPLETE</Badge>
              {exportError.partialBundle.summary.totalSegments} of {exportError.partialBundle.requestedSegments} segments were successfully processed. Resume to continue from where it left off.
            </div>
          )}
        </div>
      )}

      {cancelledPartial && !isExporting && (
        <div className="flex flex-col gap-2 p-3 bg-muted/30 border rounded-lg" data-testid="cancelled-partial">
          <div className="flex items-center gap-3">
            <Ban className="h-5 w-5 text-muted-foreground shrink-0" />
            <div className="flex-1 space-y-1">
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="font-medium">
                  Export cancelled
                </span>
                <span className="text-muted-foreground text-xs">
                  {cancelledPartial.bundle.summary.totalSegments} of {cancelledPartial.totalRequested} segments completed
                </span>
              </div>
              <Progress
                value={(cancelledPartial.bundle.summary.totalSegments / cancelledPartial.totalRequested) * 100}
                className="h-2"
                data-testid="progress-bar-cancelled"
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => downloadPartialBundle(cancelledPartial.bundle, 'json')}
                disabled={isDownloadingPartial}
                data-testid="button-cancelled-download-json"
              >
                {isDownloadingPartial ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <FileJson className="h-4 w-4 mr-2" />
                )}
                JSON
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => downloadPartialBundle(cancelledPartial.bundle, 'pdf')}
                disabled={isDownloadingPartial}
                data-testid="button-cancelled-download-pdf"
              >
                {isDownloadingPartial ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <FileText className="h-4 w-4 mr-2" />
                )}
                PDF
              </Button>
              <Button
                size="sm"
                onClick={() => exportSelectedCertificates(cancelledPartial.format, cancelledPartial.bundle)}
                disabled={selectedCertificates.size === 0 || isDownloadingPartial}
                data-testid="button-cancelled-resume"
              >
                <ArrowRight className="h-4 w-4 mr-2" />
                Resume
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setCancelledPartial(null)}
                disabled={isDownloadingPartial}
                data-testid="button-dismiss-cancelled"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="flex items-center gap-2 ml-8 text-xs text-muted-foreground" data-testid="text-cancelled-partial-info">
            <Badge variant="outline" className="text-xs">PARTIAL</Badge>
            {cancelledPartial.bundle.summary.totalSegments} of {cancelledPartial.totalRequested} segments were processed before cancellation. Download partial results or resume to continue.
          </div>
        </div>
      )}

      {isExporting && exportProgress && exportProgress.total > 0 && (() => {
        const clampedResumed = Math.min(resumedFromCount, exportProgress.total);
        return (
        <div className="flex items-center gap-3 p-3 bg-muted/30 rounded-lg" data-testid="export-progress">
          <div className="flex-1 space-y-1">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="text-muted-foreground">
                {clampedResumed > 0 ? (
                  exportProgress.current <= clampedResumed
                    ? `Skipping ${clampedResumed} previously completed segment${clampedResumed !== 1 ? 's' : ''}...`
                    : `Processing segment ${exportProgress.current} of ${exportProgress.total}`
                ) : (
                  `Processing segment ${exportProgress.current} of ${exportProgress.total}`
                )}
              </span>
              <span className="font-medium tabular-nums">
                {exportProgress.total > 0
                  ? Math.round((exportProgress.current / exportProgress.total) * 100)
                  : 0}%
              </span>
            </div>
            {clampedResumed > 0 ? (
              <div
                className="relative h-2 w-full overflow-hidden rounded-full bg-secondary"
                data-testid="progress-bar"
              >
                <div
                  className="absolute left-0 h-full bg-primary/30 transition-all"
                  style={{ width: `${(clampedResumed / exportProgress.total) * 100}%` }}
                  data-testid="progress-bar-resumed"
                />
                <div
                  className="absolute h-full bg-primary transition-all"
                  style={{
                    left: `${(clampedResumed / exportProgress.total) * 100}%`,
                    width: `${(Math.max(0, exportProgress.current - clampedResumed) / exportProgress.total) * 100}%`
                  }}
                  data-testid="progress-bar-new"
                />
              </div>
            ) : (
              <Progress
                value={exportProgress.total > 0
                  ? (exportProgress.current / exportProgress.total) * 100
                  : 0}
                className="h-2"
                data-testid="progress-bar"
              />
            )}
            {clampedResumed > 0 && (
              <div className="flex flex-col gap-1 text-xs text-muted-foreground" data-testid="text-resumed-info">
                <div className="flex items-center gap-3">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="flex items-center gap-1 rounded px-1 cursor-pointer"
                        onClick={() => setShowResumedDetails(v => !v)}
                        data-testid="button-toggle-resumed-details"
                      >
                        <span className="inline-block h-2 w-2 rounded-full bg-primary/30 shrink-0" />
                        {clampedResumed} previously completed
                        {resumedSegmentIds.length > 0 && (
                          showResumedDetails
                            ? <ChevronDown className="h-3 w-3 shrink-0" />
                            : <ChevronRight className="h-3 w-3 shrink-0" />
                        )}
                      </button>
                    </TooltipTrigger>
                    {resumedSegmentIds.length > 0 && (
                      <TooltipContent side="bottom" className="max-w-xs">
                        <p className="font-medium mb-1">Previously completed segments:</p>
                        <ul className="space-y-0.5">
                          {resumedSegmentIds.slice(0, 5).map(id => (
                            <li key={id} className="font-mono text-xs">{getSegmentLabel(id)}</li>
                          ))}
                          {resumedSegmentIds.length > 5 && (
                            <li className="text-muted-foreground">and {resumedSegmentIds.length - 5} more</li>
                          )}
                        </ul>
                      </TooltipContent>
                    )}
                  </Tooltip>
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-full bg-primary shrink-0" />
                    {Math.max(0, exportProgress.current - clampedResumed)} newly processed
                  </span>
                </div>
                {showResumedDetails && resumedSegmentIds.length > 0 && (
                  <div className="ml-4 flex flex-wrap gap-1" data-testid="list-resumed-segments">
                    {resumedSegmentIds.map(id => (
                      <Badge key={id} variant="outline" className="text-xs font-mono">
                        {getSegmentLabel(id)}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleCancelExport}
            data-testid="button-cancel-export"
          >
            <Ban className="h-4 w-4 mr-1" />
            Cancel
          </Button>
        </div>
        );
      })()}

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

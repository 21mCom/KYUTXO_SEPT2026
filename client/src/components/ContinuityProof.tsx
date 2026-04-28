import { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import { AddressLink } from "@/components/AddressLink";
import { TxidLink } from "@/components/TxidLink";
import {
  Loader2,
  CheckCircle2,
  Clock,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  FileText,
  Download,
  RefreshCw,
  Shield,
  Calendar,
  Wallet,
  Coins,
  AlertCircle,
  AlertTriangle,
  GitBranch,
  MapPin,
  XCircle
} from "lucide-react";
import { 
  buildAllLineage,
  buildAllCustodySegments,
  getSegmentsForAddress,
  getLineageChainForAddress,
  getCustodyDuration,
  type CustodySegment,
  type UtxoLineage
} from "@/lib/lineageEngine";
import { db } from "@/lib/database";
import { format, formatDistanceToNow } from "date-fns";

interface ContinuityProofProps {
  selectedAddress?: string;
  onAddressSelect?: (address: string) => void;
}

const LAST_BUILD_DURATION_KEY = 'kyutxo_last_build_duration_seconds';
const LAST_BUILD_META_KEY = 'kyutxo_last_build_meta';
const CANCEL_CONFIRM_THRESHOLD = 75;

interface LastBuildMeta {
  durationSeconds: number;
  transactionCount: number;
}

function loadLastBuildMeta(): LastBuildMeta | null {
  try {
    const stored = localStorage.getItem(LAST_BUILD_META_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed && typeof parsed.durationSeconds === 'number' && parsed.durationSeconds > 0) {
        return {
          durationSeconds: parsed.durationSeconds,
          transactionCount: typeof parsed.transactionCount === 'number' ? parsed.transactionCount : 0,
        };
      }
    }
    const oldStored = localStorage.getItem(LAST_BUILD_DURATION_KEY);
    if (oldStored !== null) {
      const parsed = parseInt(oldStored, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return { durationSeconds: parsed, transactionCount: 0 };
      }
    }
  } catch {}
  return null;
}

export function ContinuityProof({ selectedAddress, onAddressSelect }: ContinuityProofProps) {
  const { toast } = useToast();
  
  const [isBuilding, setIsBuilding] = useState(false);
  const [buildProgress, setBuildProgress] = useState({ current: 0, total: 0, phase: '', step: 0, totalSteps: 2, unit: '' });
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [segments, setSegments] = useState<CustodySegment[]>([]);
  const [lineage, setLineage] = useState<UtxoLineage[]>([]);
  const [lineageTruncated, setLineageTruncated] = useState(false);
  const [expandedSegments, setExpandedSegments] = useState<Set<string>>(new Set());
  const [stats, setStats] = useState<{
    lineageCount: number;
    segmentCount: number;
    lastBuilt?: number;
  }>({ lineageCount: 0, segmentCount: 0 });
  const [currentTransactionCount, setCurrentTransactionCount] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const buildStartTimeRef = useRef<number>(0);
  const phaseStartTimeRef = useRef<number>(0);
  const phaseStartCountRef = useRef<number>(0);
  const [lastBuildMeta, setLastBuildMeta] = useState<LastBuildMeta | null>(loadLastBuildMeta);

  useEffect(() => {
    if (!isBuilding) {
      setElapsedSeconds(0);
      return;
    }
    const interval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - buildStartTimeRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [isBuilding]);

  const formatDuration = (totalSeconds: number): string => {
    if (totalSeconds < 1) return "0s";
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts: string[] = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
    return parts.join(' ');
  };

  const getProcessingRate = (): number | null => {
    const { current, total } = buildProgress;
    if (current <= 0 || total <= 0) return null;
    const processed = current - phaseStartCountRef.current;
    if (processed <= 0) return null;
    const phaseElapsed = (Date.now() - phaseStartTimeRef.current) / 1000;
    if (phaseElapsed < 2) return null;
    return processed / phaseElapsed;
  };

  const formatRate = (rate: number): string => {
    if (rate >= 1000) return `~${(rate / 1000).toFixed(1)}k`;
    if (rate >= 100) return `~${Math.round(rate)}`;
    if (rate >= 10) return `~${rate.toFixed(1)}`;
    return `~${rate.toFixed(2)}`;
  };

  const getEstimatedRemaining = (): string | null => {
    const rate = getProcessingRate();
    const { current, total } = buildProgress;
    if (!rate || current >= total) return null;
    const remaining = (total - current) / rate;
    if (remaining < 1) return null;
    return formatDuration(Math.ceil(remaining));
  };
  
  // Load stats on mount
  const loadStats = useCallback(async () => {
    const lineageCount = await db.utxoLineage.count();
    const segmentCount = await db.custodySegments.count();
    const txCount = await db.blockchainTransactions.count();
    setStats({ lineageCount, segmentCount });
    setCurrentTransactionCount(txCount);
  }, []);
  
  useEffect(() => {
    loadStats();
  }, [loadStats]);
  
  // Load data for selected address
  useEffect(() => {
    if (selectedAddress) {
      loadAddressData(selectedAddress);
    }
  }, [selectedAddress]);
  
  const loadAddressData = async (address: string) => {
    const addressSegments = await getSegmentsForAddress(address);
    setSegments(addressSegments);
    
    const result = await getLineageChainForAddress(address, 20, 2000);
    setLineage(result.chain);
    setLineageTruncated(result.truncated);
  };
  
  const getOverallProgress = useCallback((): number => {
    const { current, total, step, totalSteps } = buildProgress;
    if (totalSteps <= 0 || step <= 0) return 0;
    const stepFraction = total > 0 ? current / total : 0;
    return ((step - 1 + stepFraction) / totalSteps) * 100;
  }, [buildProgress]);

  const handleCancelBuild = useCallback(() => {
    if (!abortControllerRef.current) return;
    const progress = getOverallProgress();
    if (progress >= CANCEL_CONFIRM_THRESHOLD) {
      setShowCancelConfirm(true);
    } else {
      abortControllerRef.current.abort();
    }
  }, [getOverallProgress]);

  const handleConfirmCancel = useCallback(() => {
    setShowCancelConfirm(false);
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  }, []);

  const handleBuildLineage = async () => {
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const now = Date.now();
    buildStartTimeRef.current = now;
    phaseStartTimeRef.current = now;
    phaseStartCountRef.current = 0;
    setIsBuilding(true);
    setBuildProgress({ current: 0, total: 0, phase: 'Scanning transactions...', step: 1, totalSteps: 2, unit: 'transactions' });
    
    try {
      const lineageResult = await buildAllLineage((current, total) => {
        setBuildProgress({ current, total, phase: 'Building UTXO lineage', step: 1, totalSteps: 2, unit: 'transactions' });
      }, controller.signal);
      
      if (controller.signal.aborted) {
        toast({
          title: "Build Cancelled",
          description: `Cancelled during lineage phase. ${lineageResult.processed} transactions processed, ${lineageResult.created} links created before cancellation.`,
        });
        return;
      }

      toast({
        title: "Lineage Built",
        description: `Processed ${lineageResult.processed} transactions, created ${lineageResult.created} lineage links.`,
      });
      
      phaseStartTimeRef.current = Date.now();
      phaseStartCountRef.current = 0;
      setBuildProgress({ current: 0, total: 0, phase: 'Scanning origin UTXOs...', step: 2, totalSteps: 2, unit: 'origins' });
      
      const segmentResult = await buildAllCustodySegments((current, total) => {
        setBuildProgress({ current, total, phase: 'Compiling custody segments', step: 2, totalSteps: 2, unit: 'origins' });
      }, controller.signal);
      
      if (controller.signal.aborted) {
        toast({
          title: "Build Cancelled",
          description: `Cancelled during custody phase. ${segmentResult.processed} origins processed, ${segmentResult.created} segments created before cancellation.`,
        });
        return;
      }

      toast({
        title: "Custody Segments Compiled",
        description: `Created ${segmentResult.created} custody segments from ${segmentResult.processed} origins.`,
      });

      const totalSeconds = Math.round((Date.now() - buildStartTimeRef.current) / 1000);
      if (totalSeconds > 0) {
        const txCount = await db.blockchainTransactions.count();
        const meta: LastBuildMeta = {
          durationSeconds: totalSeconds,
          transactionCount: txCount,
        };
        try {
          localStorage.setItem(LAST_BUILD_META_KEY, JSON.stringify(meta));
        } catch {}
        setLastBuildMeta(meta);
      }
      
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Build Failed",
        description: error instanceof Error ? error.message : "An error occurred",
      });
    } finally {
      abortControllerRef.current = null;
      setIsBuilding(false);
      setBuildProgress({ current: 0, total: 0, phase: '', step: 0, totalSteps: 2, unit: '' });
      await loadStats();
      if (selectedAddress) {
        await loadAddressData(selectedAddress);
      }
    }
  };
  
  const toggleSegment = (segmentId: string) => {
    const newSet = new Set(expandedSegments);
    if (newSet.has(segmentId)) {
      newSet.delete(segmentId);
    } else {
      newSet.add(segmentId);
    }
    setExpandedSegments(newSet);
  };
  
  const formatBtc = (sats: number) => {
    return (sats / 100_000_000).toFixed(8);
  };
  
  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'active':
        return <Badge variant="default" className="bg-green-500/10 text-green-700 border-green-500/20">Active</Badge>;
      case 'spent':
        return <Badge variant="secondary" className="bg-red-500/10 text-red-700 border-red-500/20">Spent</Badge>;
      case 'split':
        return <Badge variant="outline" className="bg-yellow-500/10 text-yellow-700 border-yellow-500/20">Partial</Badge>;
      case 'consolidated':
        return <Badge variant="outline" className="bg-blue-500/10 text-blue-700 border-blue-500/20">Merged</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };
  
  const getConfidenceBadge = (confidence: string) => {
    switch (confidence) {
      case 'verified':
        return <Badge variant="default" className="bg-green-500/10 text-green-700 border-green-500/20">Verified</Badge>;
      case 'high':
        return <Badge variant="secondary" className="bg-blue-500/10 text-blue-700 border-blue-500/20">High</Badge>;
      case 'medium':
        return <Badge variant="outline" className="bg-yellow-500/10 text-yellow-700 border-yellow-500/20">Medium</Badge>;
      case 'low':
        return <Badge variant="outline" className="bg-orange-500/10 text-orange-700 border-orange-500/20">Low</Badge>;
      default:
        return <Badge variant="outline" className="text-muted-foreground">Unknown</Badge>;
    }
  };
  
  const handleExportSegment = (segment: CustodySegment) => {
    const exportData = {
      segmentId: segment.segmentId,
      origin: {
        txid: segment.originTxid,
        vout: segment.originVout,
        address: segment.originAddress,
        date: new Date(segment.originDate).toISOString(),
        amount: formatBtc(segment.originAmount) + ' BTC',
      },
      current: segment.currentAddress ? {
        address: segment.currentAddress,
        amount: formatBtc(segment.currentAmount) + ' BTC',
      } : null,
      custody: {
        status: segment.status,
        hopCount: segment.hopCount,
        narrative: segment.narrative,
      },
      evidence: {
        txids: segment.evidenceTxids,
      },
      metadata: {
        owner: segment.owner,
        walletName: segment.walletName,
        seedName: segment.seedName,
        acquisitionMethod: segment.acquisitionMethod,
        costBasisUsd: segment.costBasisUsd,
      },
      generatedAt: new Date().toISOString(),
    };
    
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `custody-proof-${segment.segmentId}.json`;
    a.click();
    URL.revokeObjectURL(url);
    
    toast({
      title: "Exported",
      description: "Custody proof exported to JSON file.",
    });
  };
  
  const renderSegmentCard = (segment: CustodySegment) => {
    const isExpanded = expandedSegments.has(segment.segmentId);
    const duration = getCustodyDuration([segment]);
    
    return (
      <Collapsible
        key={segment.segmentId}
        open={isExpanded}
        onOpenChange={() => toggleSegment(segment.segmentId)}
      >
        <Card className="border">
          <CollapsibleTrigger asChild>
            <CardHeader className="cursor-pointer hover-elevate pb-3">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-2">
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  )}
                  <div>
                    <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                      <Coins className="h-4 w-4 text-primary" />
                      {formatBtc(segment.originAmount)} BTC
                      {getStatusBadge(segment.status)}
                      {segment.lineageTruncated && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge variant="outline" className="bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/20" data-testid={`badge-truncated-${segment.segmentId}`}>
                              <AlertTriangle className="h-3 w-3 mr-1" />
                              Partial
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>Custody trail may be incomplete — lineage data was truncated due to traversal limits.</p>
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </CardTitle>
                    <CardDescription className="mt-1">
                      {segment.narrative || `Custody from ${format(segment.originDate, 'MMM d, yyyy')}`}
                    </CardDescription>
                  </div>
                </div>
                <div className="text-right text-sm text-muted-foreground">
                  <div className="flex items-center gap-1">
                    <Calendar className="h-3 w-3" />
                    {formatDistanceToNow(segment.originDate, { addSuffix: true })}
                  </div>
                  {duration.totalDays > 0 && (
                    <div className="text-xs">{duration.totalDays} days custody</div>
                  )}
                </div>
              </div>
            </CardHeader>
          </CollapsibleTrigger>
          
          <CollapsibleContent>
            <CardContent className="pt-0 space-y-4">
              <Separator />
              
              {/* Origin Details */}
              <div className="space-y-2">
                <h4 className="text-sm font-medium flex items-center gap-2">
                  <MapPin className="h-3 w-3 text-green-500" />
                  Origin
                </h4>
                <div className="grid gap-2 text-sm pl-5">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Address:</span>
                    <AddressLink address={segment.originAddress} />
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Transaction:</span>
                    <TxidLink txid={segment.originTxid} />
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Date:</span>
                    <span>{format(segment.originDate, 'MMM d, yyyy HH:mm')}</span>
                  </div>
                  {segment.acquisitionMethod && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Acquisition:</span>
                      <Badge variant="outline">{segment.acquisitionMethod}</Badge>
                    </div>
                  )}
                  {segment.costBasisUsd && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Cost Basis:</span>
                      <span>${segment.costBasisUsd.toLocaleString()}</span>
                    </div>
                  )}
                </div>
              </div>
              
              {/* Current State (if still held) */}
              {segment.currentAddress && (
                <div className="space-y-2">
                  <h4 className="text-sm font-medium flex items-center gap-2">
                    <Wallet className="h-3 w-3 text-blue-500" />
                    Current Location
                  </h4>
                  <div className="grid gap-2 text-sm pl-5">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Address:</span>
                      <AddressLink address={segment.currentAddress} />
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Amount:</span>
                      <span className="font-mono">{formatBtc(segment.currentAmount)} BTC</span>
                    </div>
                  </div>
                </div>
              )}
              
              {/* Transfer History */}
              {segment.hopCount > 0 && (
                <div className="space-y-2">
                  <h4 className="text-sm font-medium flex items-center gap-2">
                    <GitBranch className="h-3 w-3 text-purple-500" />
                    Transfer History ({segment.hopCount} hop{segment.hopCount !== 1 ? 's' : ''})
                  </h4>
                  <div className="pl-5">
                    <ScrollArea className="max-h-32">
                      <div className="space-y-1">
                        {segment.evidenceTxids.map((txid, idx) => (
                          <div key={txid} className="flex items-center gap-2 text-xs">
                            <span className="text-muted-foreground">{idx + 1}.</span>
                            <TxidLink txid={txid} />
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  </div>
                </div>
              )}
              
              {/* Metadata */}
              {(segment.owner || segment.walletName || segment.seedName) && (
                <div className="space-y-2">
                  <h4 className="text-sm font-medium flex items-center gap-2">
                    <Shield className="h-3 w-3 text-primary" />
                    Metadata
                  </h4>
                  <div className="flex flex-wrap gap-2 pl-5">
                    {segment.owner && (
                      <Badge variant="outline">{segment.owner}</Badge>
                    )}
                    {segment.walletName && (
                      <Badge variant="secondary">{segment.walletName}</Badge>
                    )}
                    {segment.seedName && (
                      <Badge variant="outline" className="text-muted-foreground">{segment.seedName}</Badge>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
            
            <CardFooter className="pt-0">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleExportSegment(segment)}
                data-testid={`button-export-segment-${segment.segmentId}`}
              >
                <Download className="h-3 w-3 mr-1" />
                Export Proof
              </Button>
            </CardFooter>
          </CollapsibleContent>
        </Card>
      </Collapsible>
    );
  };
  
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="h-5 w-5" />
          Continuity Proof
        </CardTitle>
        <CardDescription>
          Build and export ownership proofs showing the chain of custody for your Bitcoin.
          Demonstrates long-term holding through address changes and partial spends.
        </CardDescription>
      </CardHeader>
      
      <CardContent className="space-y-4">
        {/* Stats */}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="text-center p-3 bg-muted/50 rounded-lg">
            <div className="text-2xl font-bold" data-testid="text-lineage-count">
              {stats.lineageCount}
            </div>
            <div className="text-xs text-muted-foreground">Lineage Links</div>
          </div>
          <div className="text-center p-3 bg-muted/50 rounded-lg">
            <div className="text-2xl font-bold" data-testid="text-segment-count">
              {stats.segmentCount}
            </div>
            <div className="text-xs text-muted-foreground">Custody Segments</div>
          </div>
          <div className="text-center p-3 bg-muted/50 rounded-lg">
            <Button
              onClick={handleBuildLineage}
              disabled={isBuilding}
              className="w-full"
              data-testid="button-build-lineage"
            >
              {isBuilding ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Building...
                </>
              ) : (
                <>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Build Lineage
                </>
              )}
            </Button>
            {!isBuilding && lastBuildMeta !== null && (
              <div className="text-xs text-muted-foreground mt-1.5" data-testid="text-last-build-duration">
                <Clock className="h-3 w-3 inline-block mr-1 align-text-bottom" />
                {lastBuildMeta.transactionCount > 0 ? (
                  currentTransactionCount > lastBuildMeta.transactionCount * 1.2 ? (
                    <span data-testid="text-build-size-warning">
                      Last build: {formatDuration(lastBuildMeta.durationSeconds)} with {lastBuildMeta.transactionCount.toLocaleString()} transactions {'\u2014'} now {currentTransactionCount.toLocaleString()} transactions, may take longer
                    </span>
                  ) : (
                    <span>
                      Last build: {formatDuration(lastBuildMeta.durationSeconds)} with {lastBuildMeta.transactionCount.toLocaleString()} transactions
                    </span>
                  )
                ) : (
                  <span>Last build: {formatDuration(lastBuildMeta.durationSeconds)}</span>
                )}
              </div>
            )}
          </div>
        </div>
        
        {isBuilding && (
          <div className="space-y-2 p-3 bg-muted/30 rounded-lg" data-testid="lineage-build-progress">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="font-medium flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" />
                Step {buildProgress.step} of {buildProgress.totalSteps}: {buildProgress.phase}
              </span>
              <div className="flex items-center gap-2">
                {buildProgress.total > 0 && (
                  <span className="text-muted-foreground tabular-nums" data-testid="text-build-counter">
                    {buildProgress.current.toLocaleString()} of {buildProgress.total.toLocaleString()} {buildProgress.unit}
                  </span>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCancelBuild}
                  data-testid="button-cancel-build"
                >
                  <XCircle className="h-3 w-3 mr-1" />
                  Cancel
                </Button>
              </div>
            </div>
            <Progress
              value={buildProgress.total > 0 ? (buildProgress.current / buildProgress.total) * 100 : undefined}
              data-testid="progress-lineage-build"
            />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1 tabular-nums" data-testid="text-build-elapsed">
                  <Clock className="h-3 w-3" />
                  {formatDuration(elapsedSeconds)} elapsed
                </span>
                {(() => {
                  const rate = getProcessingRate();
                  return rate ? (
                    <span className="tabular-nums" data-testid="text-build-rate">
                      {formatRate(rate)} {buildProgress.unit}/sec
                    </span>
                  ) : null;
                })()}
              </div>
              <div className="flex items-center gap-3">
                {(() => {
                  const eta = getEstimatedRemaining();
                  return eta ? (
                    <span className="tabular-nums" data-testid="text-build-eta">
                      ~{eta} remaining
                    </span>
                  ) : null;
                })()}
                {buildProgress.total > 0 && (
                  <span data-testid="text-build-percent">
                    {Math.round((buildProgress.current / buildProgress.total) * 100)}% complete
                  </span>
                )}
              </div>
            </div>
          </div>
        )}
        
        <Separator />
        
        {/* Segments for selected address or all segments */}
        <div className="space-y-3">
          <h3 className="text-sm font-medium">
            {selectedAddress ? (
              <>Custody History for Selected Address</>
            ) : (
              <>All Custody Segments</>
            )}
          </h3>
          
          {segments.length === 0 ? (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>No Segments Found</AlertTitle>
              <AlertDescription>
                {stats.lineageCount === 0 ? (
                  <>Click "Build Lineage" to analyze your transaction history and create custody segments.</>
                ) : selectedAddress ? (
                  <>No custody segments found for this address. The address may not have any tracked transactions.</>
                ) : (
                  <>No custody segments built yet. This may indicate no owned addresses received funds in synced transactions.</>
                )}
              </AlertDescription>
            </Alert>
          ) : (
            <ScrollArea className="max-h-[500px]">
              <div className="space-y-3 pr-4">
                {segments.map(segment => renderSegmentCard(segment))}
              </div>
            </ScrollArea>
          )}
        </div>
        
        {/* Lineage chain visualization (if selected address) */}
        {selectedAddress && lineage.length > 0 && (
          <>
            <Separator />
            <div className="space-y-3">
              <h3 className="text-sm font-medium">Lineage Chain ({lineage.length} links)</h3>
              {lineageTruncated && (
                <Alert variant="default" data-testid="alert-lineage-truncated">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>Results Truncated</AlertTitle>
                  <AlertDescription>
                    Showing first {lineage.length.toLocaleString()} of many results. The full lineage chain exceeds traversal limits.
                  </AlertDescription>
                </Alert>
              )}
              <ScrollArea className="max-h-48">
                <div className="space-y-2">
                  {lineage.map((link, idx) => (
                    <div 
                      key={`${link.createdTxid}-${link.createdVout}-${idx}`}
                      className="flex items-center gap-2 text-sm p-2 bg-muted/30 rounded"
                    >
                      <span className="text-muted-foreground w-6">{idx + 1}.</span>
                      <AddressLink address={link.spentAddress} truncate={true} />
                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                      <AddressLink address={link.createdAddress} truncate={true} />
                      <span className="text-muted-foreground ml-auto">{formatBtc(link.createdAmount)} BTC</span>
                      {getConfidenceBadge(link.confidence)}
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          </>
        )}
      </CardContent>

      <AlertDialog open={showCancelConfirm} onOpenChange={setShowCancelConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel Build?</AlertDialogTitle>
            <AlertDialogDescription>
              This build is {Math.round(getOverallProgress())}% complete.
              {buildProgress.step >= 2
                ? " Lineage data from step 1 is already saved, and custody segments created so far will be kept. However, the remaining items won't be processed."
                : " Data processed so far will be kept, but the remaining items won't be processed."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-build-dismiss">Continue Building</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmCancel}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-cancel-build-confirm"
            >
              Cancel Build
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

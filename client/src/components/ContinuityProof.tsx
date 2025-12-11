import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
  GitBranch,
  MapPin
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

export function ContinuityProof({ selectedAddress, onAddressSelect }: ContinuityProofProps) {
  const { toast } = useToast();
  
  const [isBuilding, setIsBuilding] = useState(false);
  const [buildProgress, setBuildProgress] = useState({ current: 0, total: 0, phase: '' });
  const [segments, setSegments] = useState<CustodySegment[]>([]);
  const [lineage, setLineage] = useState<UtxoLineage[]>([]);
  const [expandedSegments, setExpandedSegments] = useState<Set<string>>(new Set());
  const [stats, setStats] = useState<{
    lineageCount: number;
    segmentCount: number;
    lastBuilt?: number;
  }>({ lineageCount: 0, segmentCount: 0 });
  
  // Load stats on mount
  const loadStats = useCallback(async () => {
    const lineageCount = await db.utxoLineage.count();
    const segmentCount = await db.custodySegments.count();
    setStats({ lineageCount, segmentCount });
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
    
    const addressLineage = await getLineageChainForAddress(address, 20);
    setLineage(addressLineage);
  };
  
  const handleBuildLineage = async () => {
    setIsBuilding(true);
    setBuildProgress({ current: 0, total: 0, phase: 'Building UTXO lineage...' });
    
    try {
      // Phase 1: Build lineage from transactions
      const lineageResult = await buildAllLineage((current, total) => {
        setBuildProgress({ current, total, phase: 'Building UTXO lineage...' });
      });
      
      toast({
        title: "Lineage Built",
        description: `Processed ${lineageResult.processed} transactions, created ${lineageResult.created} lineage links.`,
      });
      
      // Phase 2: Build custody segments
      setBuildProgress({ current: 0, total: 0, phase: 'Compiling custody segments...' });
      
      const segmentResult = await buildAllCustodySegments((current, total) => {
        setBuildProgress({ current, total, phase: 'Compiling custody segments...' });
      });
      
      toast({
        title: "Custody Segments Compiled",
        description: `Created ${segmentResult.created} custody segments from ${segmentResult.processed} origins.`,
      });
      
      // Reload stats
      await loadStats();
      
      // Reload address data if selected
      if (selectedAddress) {
        await loadAddressData(selectedAddress);
      }
      
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Build Failed",
        description: error instanceof Error ? error.message : "An error occurred",
      });
    } finally {
      setIsBuilding(false);
      setBuildProgress({ current: 0, total: 0, phase: '' });
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
                    <CardTitle className="text-base flex items-center gap-2">
                      <Coins className="h-4 w-4 text-primary" />
                      {formatBtc(segment.originAmount)} BTC
                      {getStatusBadge(segment.status)}
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
          </div>
        </div>
        
        {/* Progress */}
        {isBuilding && buildProgress.total > 0 && (
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span>{buildProgress.phase}</span>
              <span>{buildProgress.current} / {buildProgress.total}</span>
            </div>
            <Progress value={(buildProgress.current / buildProgress.total) * 100} />
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
    </Card>
  );
}

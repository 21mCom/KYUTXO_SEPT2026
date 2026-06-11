import { useState, useMemo } from "react";
import { type Record as DBRecord, type TransactionParticipant, type BlockchainTransaction, type AddressImportance } from "@/lib/database";
import { useAddressRecords } from "@/hooks/use-address-records";
import { getParticipantsByAddress, getParticipantsByTxid } from "@/lib/dataFacade";
import { useRecordPreview } from "@/contexts/RecordPreviewContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AlertCircle, ArrowLeftRight, Check, ExternalLink, GitBranch, RefreshCw, Search, Tag, UserCheck } from "lucide-react";
import { truncateAddress } from "@/lib/bitcoin";
import { IMPORTANCE_TIERS } from "@/lib/provenance";

interface HopPoint {
  address: string;
  recordId?: number;
  label?: string;
  owner?: string;
  addressImportance?: AddressImportance;
  incomingFromKnown: string[];
  outgoingToKnown: string[];
  totalConnections: number;
  transactionCount: number;
  suggestedClassification: 'likely-own' | 'likely-counterparty' | 'needs-review';
  confidence: number;
  connectingTxids: string[];
}

interface ConnectionContext {
  fromAddress: string;
  fromLabel?: string;
  toAddress: string;
  toLabel?: string;
  txid: string;
  direction: 'incoming' | 'outgoing';
}

export function HopPointReport() {
  const { openRecordPreviewByAddress } = useRecordPreview();
  const [hopPoints, setHopPoints] = useState<HopPoint[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [maxDepth, setMaxDepth] = useState(2);
  const [selectedHopPoint, setSelectedHopPoint] = useState<HopPoint | null>(null);
  const [connections, setConnections] = useState<ConnectionContext[]>([]);
  const [minTierFilter, setMinTierFilter] = useState<AddressImportance>('xpub-derived');

  const { records: rawRecords } = useAddressRecords();
  const records = rawRecords;

  const knownAddresses = useMemo(() => {
    if (!records) return new Set<string>();
    return new Set(
      records
        .filter(r => 
          r.addressImportance && 
          IMPORTANCE_TIERS[r.addressImportance] >= IMPORTANCE_TIERS[minTierFilter]
        )
        .map(r => r.inputString)
    );
  }, [records, minTierFilter]);

  const addressMap = useMemo(() => {
    if (!records) return new Map<string, DBRecord>();
    const map = new Map<string, DBRecord>();
    for (const r of records) {
      map.set(r.inputString, r);
    }
    return map;
  }, [records]);

  async function analyzeHopPoints() {
    if (!records || knownAddresses.size === 0) return;

    setIsAnalyzing(true);
    setHopPoints([]);
    setSelectedHopPoint(null);
    setConnections([]);

    try {
      const pendingReviewAddresses = new Set(
        records
          .filter(r => r.addressImportance === 'pending-review' || !r.addressImportance)
          .map(r => r.inputString)
      );

      const unknownAddresses = new Map<string, {
        incomingFromKnown: Set<string>;
        outgoingToKnown: Set<string>;
        txids: Set<string>;
      }>();

      for (const knownAddress of Array.from(knownAddresses)) {
        const participants = await getParticipantsByAddress(knownAddress);

        for (const participant of participants) {
          const txParticipants = await getParticipantsByTxid(participant.txid);

          for (const other of txParticipants) {
            if (other.address === knownAddress) continue;
            if (knownAddresses.has(other.address)) continue;

            if (!unknownAddresses.has(other.address)) {
              unknownAddresses.set(other.address, {
                incomingFromKnown: new Set(),
                outgoingToKnown: new Set(),
                txids: new Set(),
              });
            }

            const data = unknownAddresses.get(other.address)!;
            data.txids.add(participant.txid);

            if (participant.role === 'input' && other.role === 'output') {
              data.incomingFromKnown.add(knownAddress);
            }
            if (other.role === 'input' && participant.role === 'output') {
              data.outgoingToKnown.add(knownAddress);
            }
          }
        }
      }

      const hopPointList: HopPoint[] = [];

      for (const [address, data] of Array.from(unknownAddresses)) {
        if (data.incomingFromKnown.size === 0 && data.outgoingToKnown.size === 0) continue;

        const record = addressMap.get(address);
        const totalConnections = data.incomingFromKnown.size + data.outgoingToKnown.size;

        let suggestedClassification: HopPoint['suggestedClassification'] = 'needs-review';
        let confidence = 0.5;

        if (data.incomingFromKnown.size > 0 && data.outgoingToKnown.size > 0) {
          suggestedClassification = 'likely-own';
          confidence = Math.min(0.9, 0.6 + (totalConnections * 0.05));
        } else if (data.incomingFromKnown.size > 1 || data.outgoingToKnown.size > 1) {
          suggestedClassification = 'likely-own';
          confidence = 0.7;
        } else {
          suggestedClassification = 'likely-counterparty';
          confidence = 0.6;
        }

        hopPointList.push({
          address,
          recordId: record?.id,
          label: record?.label,
          owner: record?.owner,
          addressImportance: record?.addressImportance,
          incomingFromKnown: Array.from(data.incomingFromKnown),
          outgoingToKnown: Array.from(data.outgoingToKnown),
          totalConnections,
          transactionCount: data.txids.size,
          suggestedClassification,
          confidence,
          connectingTxids: Array.from(data.txids),
        });
      }

      hopPointList.sort((a, b) => {
        if (a.suggestedClassification === 'likely-own' && b.suggestedClassification !== 'likely-own') return -1;
        if (b.suggestedClassification === 'likely-own' && a.suggestedClassification !== 'likely-own') return 1;
        return b.totalConnections - a.totalConnections;
      });

      setHopPoints(hopPointList);

    } catch (error) {
      console.error('Error analyzing hop points:', error);
    } finally {
      setIsAnalyzing(false);
    }
  }

  async function loadConnectionDetails(hopPoint: HopPoint) {
    setSelectedHopPoint(hopPoint);
    const connectionList: ConnectionContext[] = [];

    for (const txid of hopPoint.connectingTxids) {
      const participants = await getParticipantsByTxid(txid);

      const inputs = participants.filter(p => p.role === 'input');
      const outputs = participants.filter(p => p.role === 'output');

      for (const input of inputs) {
        for (const output of outputs) {
          if (input.address === hopPoint.address && knownAddresses.has(output.address)) {
            const toRecord = addressMap.get(output.address);
            connectionList.push({
              fromAddress: input.address,
              fromLabel: hopPoint.label,
              toAddress: output.address,
              toLabel: toRecord?.label,
              txid,
              direction: 'outgoing',
            });
          }
          if (output.address === hopPoint.address && knownAddresses.has(input.address)) {
            const fromRecord = addressMap.get(input.address);
            connectionList.push({
              fromAddress: input.address,
              fromLabel: fromRecord?.label,
              toAddress: output.address,
              toLabel: hopPoint.label,
              txid,
              direction: 'incoming',
            });
          }
        }
      }
    }

    const uniqueConnections = connectionList.filter((c, idx, arr) => 
      arr.findIndex(x => x.txid === c.txid && x.fromAddress === c.fromAddress && x.toAddress === c.toAddress) === idx
    );

    setConnections(uniqueConnections);
  }

  function getClassificationBadge(classification: HopPoint['suggestedClassification']) {
    switch (classification) {
      case 'likely-own':
        return <Badge variant="default" className="bg-green-600">Likely Own Wallet</Badge>;
      case 'likely-counterparty':
        return <Badge variant="secondary">Likely Counterparty</Badge>;
      default:
        return <Badge variant="outline">Needs Review</Badge>;
    }
  }

  function getImportanceBadge(importance?: AddressImportance) {
    if (!importance) return <Badge variant="outline">Unknown</Badge>;
    
    const colors: Record<AddressImportance, string> = {
      'verified': 'bg-green-600',
      'manual': 'bg-blue-600',
      'wallet-import': 'bg-purple-600',
      'xpub-derived': 'bg-indigo-600',
      'blockchain-discovered': 'bg-amber-600',
      'pending-review': 'bg-gray-500',
    };

    return (
      <Badge className={colors[importance] || 'bg-gray-500'}>
        {importance.replace('-', ' ')}
      </Badge>
    );
  }

  const summaryStats = useMemo(() => {
    const likelyOwn = hopPoints.filter(h => h.suggestedClassification === 'likely-own').length;
    const likelyCounterparty = hopPoints.filter(h => h.suggestedClassification === 'likely-counterparty').length;
    const needsReview = hopPoints.filter(h => h.suggestedClassification === 'needs-review').length;
    return { likelyOwn, likelyCounterparty, needsReview, total: hopPoints.length };
  }, [hopPoints]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Minimum Address Tier for "Known" Status</Label>
          <Select value={minTierFilter} onValueChange={(v) => setMinTierFilter(v as AddressImportance)}>
            <SelectTrigger data-testid="select-min-tier">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="verified">Verified Only</SelectItem>
              <SelectItem value="manual">Manual & Above</SelectItem>
              <SelectItem value="wallet-import">Wallet Data Sync & Above</SelectItem>
              <SelectItem value="xpub-derived">XPUB Derived & Above</SelectItem>
              <SelectItem value="blockchain-discovered">Blockchain Discovered & Above</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Addresses at or above this tier are considered "known". Addresses below are analyzed as potential hop points.
          </p>
        </div>

        <div className="space-y-2">
          <Label>Known Addresses: {knownAddresses.size}</Label>
          <div className="text-sm text-muted-foreground">
            Addresses that meet your "known" criteria based on importance tier.
          </div>
        </div>
      </div>

      <Button
        onClick={analyzeHopPoints}
        disabled={isAnalyzing || knownAddresses.size === 0}
        data-testid="button-analyze-hop-points"
      >
        {isAnalyzing ? (
          <>
            <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
            Analyzing...
          </>
        ) : (
          <>
            <Search className="h-4 w-4 mr-2" />
            Analyze Hop Points
          </>
        )}
      </Button>

      {hopPoints.length > 0 && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Total Hop Points</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold" data-testid="text-total-hop-points">{summaryStats.total}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Likely Own Wallet</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-green-600" data-testid="text-likely-own">{summaryStats.likelyOwn}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Likely Counterparty</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold" data-testid="text-likely-counterparty">{summaryStats.likelyCounterparty}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Needs Review</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-amber-600" data-testid="text-needs-review">{summaryStats.needsReview}</div>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Detected Hop Points</CardTitle>
                <CardDescription>
                  Unclassified addresses that connect your known addresses. Click to view details.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[400px]">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Address</TableHead>
                        <TableHead>Connections</TableHead>
                        <TableHead>Classification</TableHead>
                        <TableHead>Confidence</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {hopPoints.slice(0, 50).map((hp, idx) => (
                        <TableRow
                          key={hp.address}
                          className={`cursor-pointer ${selectedHopPoint?.address === hp.address ? 'bg-muted' : ''}`}
                          onClick={() => loadConnectionDetails(hp)}
                          data-testid={`row-hop-point-${idx}`}
                        >
                          <TableCell>
                            <div className="flex flex-col gap-1">
                              <span className="font-mono text-sm">{truncateAddress(hp.address, 8, 8)}</span>
                              {hp.label && <span className="text-xs text-muted-foreground">{hp.label}</span>}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <span className="text-sm">{hp.incomingFromKnown.length}</span>
                              <ArrowLeftRight className="h-3 w-3" />
                              <span className="text-sm">{hp.outgoingToKnown.length}</span>
                            </div>
                          </TableCell>
                          <TableCell>{getClassificationBadge(hp.suggestedClassification)}</TableCell>
                          <TableCell>
                            <span className="text-sm">{Math.round(hp.confidence * 100)}%</span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollArea>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Connection Details</CardTitle>
                <CardDescription>
                  {selectedHopPoint
                    ? `Transactions involving ${truncateAddress(selectedHopPoint.address, 10, 10)}`
                    : 'Select a hop point to view its connections'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {selectedHopPoint ? (
                  <div className="space-y-4">
                    <div className="p-3 bg-muted rounded-md space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">Address</span>
                        <span className="font-mono text-sm">{truncateAddress(selectedHopPoint.address, 12, 12)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="font-medium">Current Status</span>
                        {getImportanceBadge(selectedHopPoint.addressImportance)}
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="font-medium">Suggestion</span>
                        {getClassificationBadge(selectedHopPoint.suggestedClassification)}
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="font-medium">Total Transactions</span>
                        <span>{selectedHopPoint.transactionCount}</span>
                      </div>
                    </div>

                    <div className="text-sm font-medium">Transaction Flow</div>
                    <ScrollArea className="h-[250px]">
                      <div className="space-y-2">
                        {connections.map((conn, idx) => (
                          <div
                            key={`${conn.txid}-${idx}`}
                            className="p-2 border rounded-md text-sm"
                            data-testid={`connection-${idx}`}
                          >
                            <div className="flex items-center gap-2 mb-1">
                              {conn.direction === 'incoming' ? (
                                <Badge variant="outline" className="text-xs">Received From</Badge>
                              ) : (
                                <Badge variant="outline" className="text-xs">Sent To</Badge>
                              )}
                              <a
                                href={`https://mempool.space/tx/${conn.txid}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs font-mono text-primary hover:underline flex items-center gap-1"
                              >
                                {truncateAddress(conn.txid, 6, 6)}
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            </div>
                            <div className="flex items-center gap-2 text-muted-foreground">
                              <span className="font-mono">{truncateAddress(conn.fromAddress, 6, 6)}</span>
                              {conn.fromLabel && <span className="text-xs">({conn.fromLabel})</span>}
                              <GitBranch className="h-3 w-3" />
                              <span className="font-mono">{truncateAddress(conn.toAddress, 6, 6)}</span>
                              {conn.toLabel && <span className="text-xs">({conn.toLabel})</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    </ScrollArea>

                    <div className="flex gap-2 pt-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          if (selectedHopPoint) {
                            openRecordPreviewByAddress(selectedHopPoint.address);
                          }
                        }}
                        data-testid="button-view-record"
                      >
                        <UserCheck className="h-4 w-4 mr-1" />
                        View/Edit Record
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center h-[300px] text-muted-foreground">
                    <GitBranch className="h-12 w-12 mb-4 opacity-50" />
                    <p>Select a hop point from the list to view connection details</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}

      {!isAnalyzing && hopPoints.length === 0 && knownAddresses.size > 0 && (
        <Card>
          <CardContent className="flex items-center gap-2 p-6 text-muted-foreground">
            <AlertCircle className="h-4 w-4" />
            Click "Analyze Hop Points" to detect unclassified addresses that connect your known addresses.
          </CardContent>
        </Card>
      )}

      {knownAddresses.size === 0 && (
        <Card>
          <CardContent className="flex items-center gap-2 p-6 text-muted-foreground">
            <AlertCircle className="h-4 w-4" />
            No known addresses found. Import addresses or run a transaction sync first.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

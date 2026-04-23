import { useState, useMemo, useEffect } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { format } from "date-fns";
import { db } from "@/lib/database";
import { 
  scanForLightningActivity, 
  LightningDetectionResult,
  getClassificationLabel,
  getClassificationBadgeVariant
} from "@/lib/lightning-detection";
import { getOwners, getWalletNames } from "@/lib/dataFacade";
import { ClickableAddress } from "@/components/ClickableAddress";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { 
  Zap, 
  Search, 
  ChevronDown, 
  ChevronUp,
  ExternalLink,
  ArrowDownLeft,
  ArrowUpRight,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Loader2
} from "lucide-react";

function satsToBtc(sats: number | undefined): string {
  if (sats === undefined || sats === null) return "0.00000000";
  return (sats / 100_000_000).toFixed(8);
}

function formatSats(sats: number | undefined): string {
  if (sats === undefined || sats === null || sats === 0) return "0 sats";
  if (sats >= 100_000_000) {
    return `${satsToBtc(sats)} BTC`;
  } else if (sats >= 1_000_000) {
    return `${(sats / 1_000_000).toFixed(2)}M sats`;
  } else if (sats >= 1_000) {
    return `${(sats / 1_000).toFixed(1)}k sats`;
  }
  return `${sats.toLocaleString()} sats`;
}

function truncate(str: string, start = 8, end = 8): string {
  if (str.length <= start + end + 3) return str;
  return `${str.slice(0, start)}...${str.slice(-end)}`;
}

function getClassificationIcon(classification: string) {
  switch (classification) {
    case 'likely-channel-open':
      return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    case 'likely-cooperative-close':
      return <CheckCircle2 className="h-4 w-4 text-blue-500" />;
    case 'likely-force-close':
      return <AlertTriangle className="h-4 w-4 text-orange-500" />;
    case 'possibly-ln-related':
      return <HelpCircle className="h-4 w-4 text-yellow-500" />;
    default:
      return <XCircle className="h-4 w-4 text-muted-foreground" />;
  }
}

function getProbabilityColor(probability: number): string {
  if (probability >= 70) return "bg-green-500";
  if (probability >= 50) return "bg-yellow-500";
  if (probability >= 30) return "bg-orange-500";
  return "bg-muted";
}

export default function LightningSpeculator() {
  const [selectedOwner, setSelectedOwner] = useState<string>("all");
  const [selectedWallet, setSelectedWallet] = useState<string>("all");
  const [minProbability, setMinProbability] = useState<number>(30);
  const [isScanning, setIsScanning] = useState(false);
  const [results, setResults] = useState<LightningDetectionResult[]>([]);
  const [expandedTxs, setExpandedTxs] = useState<Set<string>>(new Set());
  const [hasScanned, setHasScanned] = useState(false);

  const [owners, setOwners] = useState<string[]>([]);
  const [walletNames, setWalletNames] = useState<string[]>([]);

  useEffect(() => {
    const loadVocabulary = async () => {
      try {
        const [allOwners, allWallets] = await Promise.all([
          getOwners(),
          getWalletNames()
        ]);
        setOwners(allOwners.map(o => o.name).filter(Boolean).sort());
        setWalletNames(allWallets.map(w => w.name).filter(Boolean).sort());
      } catch (error) {
        console.error('Failed to load vocabulary:', error);
      }
    };
    loadVocabulary();
  }, []);

  const transactionCount = useLiveQuery(
    () => db.blockchainTransactions.count(),
    []
  );

  const handleScan = async () => {
    setIsScanning(true);
    setHasScanned(true);
    try {
      const scanResults = await scanForLightningActivity({
        owner: selectedOwner === "all" ? undefined : selectedOwner,
        walletName: selectedWallet === "all" ? undefined : selectedWallet,
        minProbability
      });
      setResults(scanResults);
    } catch (error) {
      console.error('Lightning scan failed:', error);
      setResults([]);
    } finally {
      setIsScanning(false);
    }
  };

  const toggleExpanded = (txid: string) => {
    setExpandedTxs(prev => {
      const newSet = new Set(prev);
      if (newSet.has(txid)) {
        newSet.delete(txid);
      } else {
        newSet.add(txid);
      }
      return newSet;
    });
  };

  const stats = useMemo(() => {
    const channelOpens = results.filter(r => r.classification === 'likely-channel-open').length;
    const coopCloses = results.filter(r => r.classification === 'likely-cooperative-close').length;
    const forceCloses = results.filter(r => r.classification === 'likely-force-close').length;
    const uncertain = results.filter(r => r.classification === 'possibly-ln-related').length;
    return { channelOpens, coopCloses, forceCloses, uncertain, total: results.length };
  }, [results]);

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Zap className="h-8 w-8 text-yellow-500" />
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Lightning Speculator</h1>
            <p className="text-muted-foreground">
              Scan transactions for possible Lightning Network channel activity
            </p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Search className="h-5 w-5" />
              Scan Configuration
            </CardTitle>
            <CardDescription>
              Filter by owner/wallet and set detection sensitivity
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="owner-select">Owner Filter</Label>
                <Select value={selectedOwner} onValueChange={setSelectedOwner}>
                  <SelectTrigger id="owner-select" data-testid="select-owner">
                    <SelectValue placeholder="All owners" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Owners</SelectItem>
                    {owners.map(owner => (
                      <SelectItem key={owner} value={owner}>{owner}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="wallet-select">Wallet Filter</Label>
                <Select value={selectedWallet} onValueChange={setSelectedWallet}>
                  <SelectTrigger id="wallet-select" data-testid="select-wallet">
                    <SelectValue placeholder="All wallets" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Wallets</SelectItem>
                    {walletNames.map(wallet => (
                      <SelectItem key={wallet} value={wallet}>{wallet}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Minimum Probability: {minProbability}%</Label>
                <Slider
                  value={[minProbability]}
                  onValueChange={(value) => setMinProbability(value[0])}
                  min={10}
                  max={90}
                  step={5}
                  className="py-2"
                  data-testid="slider-probability"
                />
                <p className="text-xs text-muted-foreground">
                  Higher values show only stronger matches
                </p>
              </div>
            </div>

            <div className="flex items-center gap-4">
              <Button 
                onClick={handleScan} 
                disabled={isScanning || !transactionCount}
                data-testid="button-scan"
              >
                {isScanning ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Scanning...
                  </>
                ) : (
                  <>
                    <Zap className="mr-2 h-4 w-4" />
                    Scan Transactions
                  </>
                )}
              </Button>
              <span className="text-sm text-muted-foreground">
                {transactionCount ?? 0} transactions in database
              </span>
            </div>
          </CardContent>
        </Card>

        {hasScanned && (
          <>
            <div className="grid gap-4 md:grid-cols-4">
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-5 w-5 text-green-500" />
                    <div>
                      <p className="text-2xl font-bold">{stats.channelOpens}</p>
                      <p className="text-xs text-muted-foreground">Channel Opens</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-5 w-5 text-blue-500" />
                    <div>
                      <p className="text-2xl font-bold">{stats.coopCloses}</p>
                      <p className="text-xs text-muted-foreground">Coop Closes</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-5 w-5 text-orange-500" />
                    <div>
                      <p className="text-2xl font-bold">{stats.forceCloses}</p>
                      <p className="text-xs text-muted-foreground">Force Closes</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-2">
                    <HelpCircle className="h-5 w-5 text-yellow-500" />
                    <div>
                      <p className="text-2xl font-bold">{stats.uncertain}</p>
                      <p className="text-xs text-muted-foreground">Possibly LN</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Detection Results</CardTitle>
                <CardDescription>
                  {results.length === 0 
                    ? "No Lightning-related transactions found with current filters"
                    : `Found ${results.length} potential Lightning transaction${results.length !== 1 ? 's' : ''}`
                  }
                </CardDescription>
              </CardHeader>
              <CardContent>
                {results.length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground">
                    <Zap className="h-12 w-12 mx-auto mb-4 opacity-30" />
                    <p>No matches found</p>
                    <p className="text-sm mt-1">
                      Try lowering the probability threshold or adjusting filters
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {results.map((result) => (
                      <Collapsible
                        key={result.txid}
                        open={expandedTxs.has(result.txid)}
                        onOpenChange={() => toggleExpanded(result.txid)}
                      >
                        <div className="border rounded-lg">
                          <CollapsibleTrigger asChild>
                            <div 
                              className="flex items-center justify-between p-4 cursor-pointer hover-elevate"
                              data-testid={`row-tx-${result.txid.slice(0, 8)}`}
                            >
                              <div className="flex items-center gap-3">
                                {getClassificationIcon(result.classification)}
                                <div>
                                  <div className="flex items-center gap-2">
                                    <ClickableAddress 
                                      address={result.txid}
                                      className="flex-1 min-w-0"
                                    />
                                    <Badge variant={getClassificationBadgeVariant(result.classification)}>
                                      {getClassificationLabel(result.classification)}
                                    </Badge>
                                  </div>
                                  <p className="text-xs text-muted-foreground mt-1">
                                    {result.explanation}
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-center gap-4">
                                <div className="text-right">
                                  <p className="text-sm font-medium">
                                    {Math.max(result.openProbability, result.coopCloseProbability, result.forceCloseProbability)}%
                                  </p>
                                  <p className="text-xs text-muted-foreground">confidence</p>
                                </div>
                                {expandedTxs.has(result.txid) ? (
                                  <ChevronUp className="h-4 w-4" />
                                ) : (
                                  <ChevronDown className="h-4 w-4" />
                                )}
                              </div>
                            </div>
                          </CollapsibleTrigger>
                          
                          <CollapsibleContent>
                            <div className="px-4 pb-4 space-y-4 border-t pt-4">
                              <div className="grid gap-4 md:grid-cols-3">
                                <div className="space-y-2">
                                  <Label className="text-xs">Channel Open</Label>
                                  <div className="flex items-center gap-2">
                                    <Progress 
                                      value={result.openProbability} 
                                      className="flex-1 h-2"
                                    />
                                    <span className="text-sm w-10 text-right">{result.openProbability}%</span>
                                  </div>
                                </div>
                                <div className="space-y-2">
                                  <Label className="text-xs">Coop Close</Label>
                                  <div className="flex items-center gap-2">
                                    <Progress 
                                      value={result.coopCloseProbability} 
                                      className="flex-1 h-2"
                                    />
                                    <span className="text-sm w-10 text-right">{result.coopCloseProbability}%</span>
                                  </div>
                                </div>
                                <div className="space-y-2">
                                  <Label className="text-xs">Force Close</Label>
                                  <div className="flex items-center gap-2">
                                    <Progress 
                                      value={result.forceCloseProbability} 
                                      className="flex-1 h-2"
                                    />
                                    <span className="text-sm w-10 text-right">{result.forceCloseProbability}%</span>
                                  </div>
                                </div>
                              </div>

                              <div className="grid gap-4 md:grid-cols-2">
                                <div>
                                  <Label className="text-xs mb-2 block">
                                    <ArrowDownLeft className="inline h-3 w-3 mr-1" />
                                    Inputs ({result.inputs.length})
                                  </Label>
                                  <div className="space-y-1 max-h-32 overflow-auto">
                                    {result.inputs.map((input, idx) => (
                                      <div 
                                        key={`${input.address}-${idx}`}
                                        className="flex items-center justify-between text-sm bg-muted/50 rounded px-2 py-1"
                                      >
                                        <ClickableAddress 
                                          address={input.address}
                                          className="text-xs flex-1 min-w-0"
                                        />
                                        <span className="text-muted-foreground">
                                          {formatSats(input.amount)}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                </div>

                                <div>
                                  <Label className="text-xs mb-2 block">
                                    <ArrowUpRight className="inline h-3 w-3 mr-1" />
                                    Outputs ({result.outputs.length})
                                  </Label>
                                  <div className="space-y-1 max-h-32 overflow-auto">
                                    {result.outputs.map((output, idx) => (
                                      <div 
                                        key={`${output.address}-${idx}`}
                                        className="flex items-center justify-between text-sm bg-muted/50 rounded px-2 py-1"
                                      >
                                        <ClickableAddress 
                                          address={output.address}
                                          className="text-xs flex-1 min-w-0"
                                        />
                                        <span className="text-muted-foreground">
                                          {formatSats(output.amount)}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              </div>

                              <div>
                                <Label className="text-xs mb-2 block">Detection Signals</Label>
                                <div className="flex flex-wrap gap-2">
                                  {result.signals.filter(s => s.triggered).map((signal) => (
                                    <Badge 
                                      key={signal.name} 
                                      variant="outline"
                                      title={signal.description}
                                    >
                                      {signal.name}
                                      <span className="ml-1 text-muted-foreground">
                                        ({signal.weight})
                                      </span>
                                    </Badge>
                                  ))}
                                </div>
                              </div>

                              <div className="flex items-center gap-4 pt-2">
                                <div className="text-xs text-muted-foreground">
                                  Block: {result.transaction.blockHeight.toLocaleString()}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  {format(result.transaction.blockTime * 1000, "MMM d, yyyy h:mm a")}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  Fee: {result.transaction.feeRate} sat/vB
                                </div>
                                <a
                                  href={`https://mempool.space/tx/${result.txid}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-xs text-primary flex items-center gap-1 ml-auto"
                                  data-testid={`link-mempool-${result.txid.slice(0, 8)}`}
                                >
                                  View on Mempool
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                              </div>

                              {result.linkedRecords.length > 0 && (
                                <div>
                                  <Label className="text-xs mb-2 block">Linked Records</Label>
                                  <div className="flex flex-wrap gap-2">
                                    {result.linkedRecords.map((record) => (
                                      <Badge key={record.id} variant="secondary">
                                        {record.label || truncate(record.inputString, 8, 4)}
                                        {record.owner && (
                                          <span className="ml-1 text-muted-foreground">
                                            ({record.owner})
                                          </span>
                                        )}
                                      </Badge>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          </CollapsibleContent>
                        </div>
                      </Collapsible>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HelpCircle className="h-5 w-5" />
              How Detection Works
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm text-muted-foreground">
            <p>
              This tool analyzes on-chain transactions for patterns commonly associated with 
              Lightning Network channel operations. It cannot definitively identify LN transactions,
              but provides probability scores based on multiple heuristics.
            </p>
            
            <div className="grid gap-4 md:grid-cols-3">
              <div>
                <h4 className="font-medium text-foreground mb-2">Channel Opens</h4>
                <ul className="space-y-1 text-xs">
                  <li>P2WSH outputs (multisig)</li>
                  <li>Single output transactions</li>
                  <li>Typical channel amounts (100k-10M sats)</li>
                  <li>Round amounts</li>
                </ul>
              </div>
              <div>
                <h4 className="font-medium text-foreground mb-2">Cooperative Closes</h4>
                <ul className="space-y-1 text-xs">
                  <li>P2WSH input spending</li>
                  <li>Exactly 2 outputs</li>
                  <li>Balanced output amounts</li>
                  <li>Moderate fee rates</li>
                </ul>
              </div>
              <div>
                <h4 className="font-medium text-foreground mb-2">Force Closes</h4>
                <ul className="space-y-1 text-xs">
                  <li>P2WSH input (commitment tx)</li>
                  <li>Multiple outputs with timelocks</li>
                  <li>High fee rates (urgency)</li>
                  <li>Anchor outputs present</li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

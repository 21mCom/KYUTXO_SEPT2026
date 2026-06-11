import { useState, useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { type Record as DBRecord, type TransactionParticipant, type BlockchainTransaction, type PriceData } from "@/lib/database";
import { getParticipantsByAddress, getParticipantsByTxid, getRecordsByType, getTransactionByTxid } from "@/lib/dataFacade";
import { getPriceDataByKey, getLatestPriceOnOrBefore } from "@/lib/data/price-data-crud";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AlertCircle, ArrowRight, Check, Download, ExternalLink, RefreshCw, Wallet } from "lucide-react";
import { formatBTC, truncateAddress } from "@/lib/bitcoin";

interface FundingSource {
  txid: string;
  date: string;
  blockHeight: number;
  amountSats: number;
  fromAddress: string;
  fromLabel?: string;
  fromOwner?: string;
  isInternalTransfer: boolean;
  priceAtTime?: number;
  costBasisUSD?: number;
}

interface SourceOfFundsData {
  address: string;
  label: string;
  owner?: string;
  walletName?: string;
  currentBalanceSats: number;
  totalReceivedSats: number;
  fundingSources: FundingSource[];
  currentPriceUSD?: number;
  currentValueUSD?: number;
  totalCostBasisUSD?: number;
  unrealizedGainUSD?: number;
  internalTransferCount: number;
  externalFundingCount: number;
}

export function SourceOfFundsReport() {
  const [selectedAddress, setSelectedAddress] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [reportData, setReportData] = useState<SourceOfFundsData | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [currency, setCurrency] = useState("USD");

  const rawRecords = useLiveQuery(
    () => getRecordsByType('address'),
    []
  );

  const records = useLiveQuery(
    async () => {
      if (!rawRecords) return [];
      return rawRecords;
    },
    [rawRecords],
    []
  );

  const ownedRecords = useMemo(() => {
    if (!records) return [];
    return records.filter(r => 
      r.addressImportance && 
      ['verified', 'manual', 'wallet-import', 'xpub-derived'].includes(r.addressImportance)
    ).sort((a, b) => (a.label || '').localeCompare(b.label || ''));
  }, [records]);

  const filteredRecords = useMemo(() => {
    if (!searchQuery) return ownedRecords.slice(0, 50);
    const query = searchQuery.toLowerCase();
    return ownedRecords.filter(r =>
      r.inputString.toLowerCase().includes(query) ||
      r.label?.toLowerCase().includes(query) ||
      r.owner?.toLowerCase().includes(query) ||
      r.walletName?.toLowerCase().includes(query)
    ).slice(0, 50);
  }, [ownedRecords, searchQuery]);

  async function generateReport() {
    if (!selectedAddress || !records) return;

    setIsGenerating(true);
    try {
      const record = records.find(r => r.inputString === selectedAddress);
      if (!record) {
        setReportData(null);
        return;
      }

      const participants = await getParticipantsByAddress(selectedAddress);

      const inputTxids = Array.from(new Set(participants.filter(p => p.role === 'output').map(p => p.txid)));

      let totalReceivedSats = 0;
      let currentBalanceSats = 0;
      const fundingSources: FundingSource[] = [];
      const spentTxids = new Set(participants.filter(p => p.role === 'input').map(p => p.txid));

      const currentOwner = record.owner;

      for (const txid of inputTxids) {
        const tx = await getTransactionByTxid(txid);
        if (!tx) continue;

        const txParticipants = await getParticipantsByTxid(txid);
        
        const myOutput = txParticipants.find(p => p.role === 'output' && p.address === selectedAddress);
        if (!myOutput) continue;

        totalReceivedSats += myOutput.amount;

        const isSpent = spentTxids.has(txid);
        if (!isSpent) {
          currentBalanceSats += myOutput.amount;
        }

        const inputs = txParticipants.filter(p => p.role === 'input');
        
        const inputRecords = inputs.map(input => ({
          input,
          record: records.find(r => r.inputString === input.address)
        }));

        const isInternalTransfer = currentOwner && inputRecords.some(({ record: ir }) =>
          ir?.owner === currentOwner &&
          ir?.addressImportance &&
          ['verified', 'manual', 'wallet-import', 'xpub-derived'].includes(ir.addressImportance)
        );

        const primaryInput = inputRecords[0];
        
        const txDate = new Date(tx.blockTime * 1000).toISOString().split('T')[0];
        const priceData = await getPriceDataByKey(txDate, currency, 'BTC');

        const amountBTC = myOutput.amount / 100000000;
        const costBasisUSD = priceData?.close ? amountBTC * priceData.close : undefined;

        fundingSources.push({
          txid,
          date: txDate,
          blockHeight: tx.blockHeight,
          amountSats: myOutput.amount,
          fromAddress: primaryInput?.input.address || 'Unknown',
          fromLabel: primaryInput?.record?.label || (inputs.length > 1 ? `(${inputs.length} inputs)` : undefined),
          fromOwner: primaryInput?.record?.owner,
          isInternalTransfer: !!isInternalTransfer,
          priceAtTime: priceData?.close,
          costBasisUSD,
        });
      }

      fundingSources.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      const today = new Date().toISOString().split('T')[0];
      const currentPrice = await getLatestPriceOnOrBefore(today, currency, 'BTC');

      const currentValueUSD = currentPrice?.close 
        ? (currentBalanceSats / 100000000) * currentPrice.close 
        : undefined;

      const externalSources = fundingSources.filter(s => !s.isInternalTransfer);
      const totalCostBasisUSD = externalSources.reduce((sum, s) => sum + (s.costBasisUSD || 0), 0);

      const unrealizedGainUSD = currentValueUSD !== undefined && totalCostBasisUSD > 0
        ? currentValueUSD - totalCostBasisUSD
        : undefined;

      setReportData({
        address: selectedAddress,
        label: record.label || 'Unlabeled',
        owner: record.owner,
        walletName: record.walletName,
        currentBalanceSats,
        totalReceivedSats,
        fundingSources,
        currentPriceUSD: currentPrice?.close,
        currentValueUSD,
        totalCostBasisUSD: totalCostBasisUSD > 0 ? totalCostBasisUSD : undefined,
        unrealizedGainUSD,
        internalTransferCount: fundingSources.filter(s => s.isInternalTransfer).length,
        externalFundingCount: fundingSources.filter(s => !s.isInternalTransfer).length,
      });

    } catch (error) {
      console.error('Error generating source of funds report:', error);
    } finally {
      setIsGenerating(false);
    }
  }

  function exportReport() {
    if (!reportData) return;

    const lines: string[] = [
      'SOURCE OF FUNDS DECLARATION',
      '=' .repeat(50),
      '',
      `Address: ${reportData.address}`,
      `Label: ${reportData.label}`,
      reportData.owner ? `Owner: ${reportData.owner}` : '',
      reportData.walletName ? `Wallet: ${reportData.walletName}` : '',
      '',
      'SUMMARY',
      '-'.repeat(30),
      `Current Balance: ${formatBTC(reportData.currentBalanceSats)} BTC`,
      `Total Received: ${formatBTC(reportData.totalReceivedSats)} BTC`,
      reportData.currentValueUSD ? `Current Value: $${reportData.currentValueUSD.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}` : '',
      reportData.totalCostBasisUSD ? `Cost Basis (External): $${reportData.totalCostBasisUSD.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}` : '',
      reportData.unrealizedGainUSD !== undefined ? `Unrealized Gain/Loss: $${reportData.unrealizedGainUSD.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}` : '',
      '',
      `Internal Transfers: ${reportData.internalTransferCount}`,
      `External Funding Events: ${reportData.externalFundingCount}`,
      '',
      'FUNDING SOURCES',
      '-'.repeat(30),
      '',
    ];

    for (const source of reportData.fundingSources) {
      lines.push(`Date: ${source.date}`);
      lines.push(`Transaction: ${source.txid}`);
      lines.push(`Amount: ${formatBTC(source.amountSats)} BTC`);
      lines.push(`From: ${source.fromLabel || truncateAddress(source.fromAddress, 15, 15)}`);
      if (source.fromOwner) lines.push(`From Owner: ${source.fromOwner}`);
      lines.push(`Type: ${source.isInternalTransfer ? 'INTERNAL TRANSFER (Non-taxable)' : 'EXTERNAL FUNDING'}`);
      if (source.priceAtTime) lines.push(`Price at Time: $${source.priceAtTime.toLocaleString()} ${currency}`);
      if (source.costBasisUSD) lines.push(`Cost Basis: $${source.costBasisUSD.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`);
      lines.push('');
    }

    lines.push('');
    lines.push(`Generated: ${new Date().toISOString()}`);

    const blob = new Blob([lines.filter(l => l !== '').join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `source-of-funds-${reportData.address.substring(0, 10)}-${new Date().toISOString().split('T')[0]}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="md:col-span-2 space-y-2">
          <Label htmlFor="address-search">Select Address</Label>
          <Input
            id="address-search"
            placeholder="Search by address, label, owner, or wallet..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            data-testid="input-address-search"
          />
          {searchQuery && filteredRecords.length > 0 && (
            <ScrollArea className="h-40 border rounded-md">
              <div className="p-2 space-y-1">
                {filteredRecords.map((record) => (
                  <Button
                    key={record.id}
                    variant={selectedAddress === record.inputString ? "secondary" : "ghost"}
                    className="w-full justify-start text-left h-auto py-2"
                    onClick={() => {
                      setSelectedAddress(record.inputString);
                      setSearchQuery('');
                    }}
                    data-testid={`button-select-address-${record.id}`}
                  >
                    <div className="flex flex-col items-start gap-1">
                      <span className="font-medium">{record.label || 'Unlabeled'}</span>
                      <span className="text-xs text-muted-foreground font-mono">
                        {truncateAddress(record.inputString, 12, 12)}
                      </span>
                      <div className="flex gap-1">
                        {record.owner && <Badge variant="outline" className="text-xs">{record.owner}</Badge>}
                        {record.walletName && <Badge variant="secondary" className="text-xs">{record.walletName}</Badge>}
                      </div>
                    </div>
                  </Button>
                ))}
              </div>
            </ScrollArea>
          )}
          {selectedAddress && (
            <div className="p-2 bg-muted rounded-md">
              <span className="text-sm font-medium">Selected: </span>
              <span className="text-sm font-mono">{truncateAddress(selectedAddress, 15, 15)}</span>
            </div>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="currency">Currency</Label>
          <Select value={currency} onValueChange={setCurrency}>
            <SelectTrigger id="currency" data-testid="select-currency">
              <SelectValue placeholder="Select currency" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="USD">USD</SelectItem>
              <SelectItem value="EUR">EUR</SelectItem>
              <SelectItem value="GBP">GBP</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex gap-2">
        <Button
          onClick={generateReport}
          disabled={!selectedAddress || isGenerating}
          data-testid="button-generate-report"
        >
          {isGenerating ? (
            <>
              <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
              Generating...
            </>
          ) : (
            'Generate Report'
          )}
        </Button>
        {reportData && (
          <Button variant="outline" onClick={exportReport} data-testid="button-export-report">
            <Download className="h-4 w-4 mr-2" />
            Export
          </Button>
        )}
      </div>

      {reportData && (
        <div className="space-y-6">
          <Separator />

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Current Balance</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold" data-testid="text-current-balance">
                  {formatBTC(reportData.currentBalanceSats)} BTC
                </div>
                {reportData.currentValueUSD !== undefined && (
                  <div className="text-sm text-muted-foreground">
                    ${reportData.currentValueUSD.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {currency}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Cost Basis (External)</CardTitle>
              </CardHeader>
              <CardContent>
                {reportData.totalCostBasisUSD !== undefined ? (
                  <div className="text-2xl font-bold" data-testid="text-cost-basis">
                    ${reportData.totalCostBasisUSD.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </div>
                ) : (
                  <div className="text-lg text-muted-foreground">No price data</div>
                )}
                <div className="text-sm text-muted-foreground">
                  {reportData.externalFundingCount} external funding event(s)
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Unrealized Gain/Loss</CardTitle>
              </CardHeader>
              <CardContent>
                {reportData.unrealizedGainUSD !== undefined ? (
                  <div className={`text-2xl font-bold ${reportData.unrealizedGainUSD >= 0 ? 'text-green-600' : 'text-red-600'}`} data-testid="text-unrealized-gain">
                    {reportData.unrealizedGainUSD >= 0 ? '+' : ''}${reportData.unrealizedGainUSD.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </div>
                ) : (
                  <div className="text-lg text-muted-foreground">Cannot calculate</div>
                )}
                <div className="text-sm text-muted-foreground">
                  {reportData.internalTransferCount} internal transfer(s) excluded
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Funding Sources</CardTitle>
            </CardHeader>
            <CardContent>
              {reportData.fundingSources.length === 0 ? (
                <div className="flex items-center gap-2 text-muted-foreground p-4">
                  <AlertCircle className="h-4 w-4" />
                  No transaction data available. Run a transaction sync first.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>From</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Cost Basis</TableHead>
                      <TableHead>Transaction</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reportData.fundingSources.map((source, idx) => (
                      <TableRow key={`${source.txid}-${idx}`} data-testid={`row-funding-source-${idx}`}>
                        <TableCell className="font-mono text-sm">{source.date}</TableCell>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="font-medium">{source.fromLabel || truncateAddress(source.fromAddress, 8, 8)}</span>
                            {source.fromOwner && (
                              <span className="text-xs text-muted-foreground">{source.fromOwner}</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="font-mono">{formatBTC(source.amountSats)}</TableCell>
                        <TableCell>
                          {source.isInternalTransfer ? (
                            <Badge variant="secondary" className="flex items-center gap-1 w-fit">
                              <Wallet className="h-3 w-3" />
                              Internal
                            </Badge>
                          ) : (
                            <Badge variant="default" className="flex items-center gap-1 w-fit">
                              <ArrowRight className="h-3 w-3" />
                              External
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {source.isInternalTransfer ? (
                            <span className="text-muted-foreground text-sm">N/A (Non-taxable)</span>
                          ) : source.costBasisUSD !== undefined ? (
                            <span className="font-mono">${source.costBasisUSD.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                          ) : (
                            <span className="text-muted-foreground text-sm">No price data</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <a
                            href={`https://mempool.space/tx/${source.txid}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs font-mono text-primary hover:underline flex items-center gap-1"
                          >
                            {truncateAddress(source.txid, 8, 8)}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

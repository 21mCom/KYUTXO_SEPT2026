import { useState, useEffect, useMemo } from "react";
import { format } from "date-fns";
import { Link } from "wouter";
import { 
  ExternalLink, 
  User, 
  Wallet as WalletIcon,
  Tag,
  FolderOpen,
  ArrowDownLeft,
  TrendingUp,
  TrendingDown,
  Coins,
  ChevronDown,
  ChevronRight
} from "lucide-react";
import { SiBitcoin } from "react-icons/si";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Record as DbRecord, TransactionParticipant, BlockchainTransaction, PriceData } from "@/lib/database";
import { getParticipantsByTxid, getTransactionByTxid, getRecordsByType } from "@/lib/dataFacade";
import { cn } from "@/lib/utils";
import { AddressLink } from "@/components/AddressLink";
import { TxidLink } from "@/components/TxidLink";
import { useRecordPreview } from "@/contexts/RecordPreviewContext";

interface UTXO {
  id: string;
  txid: string;
  vout: number;
  address: string;
  amountSats: number;
  blockTime: number;
  blockHeight: number;
  recordId?: number;
  label?: string;
  owner?: string;
  walletName?: string;
  tags?: string[];
  categories?: string[];
  valueAtReceipt?: number;
  priceAtReceipt?: number;
}

interface FundingInput {
  address: string;
  amount: number;
  record?: DbRecord;
}

interface UTXODetailPanelProps {
  open: boolean;
  onClose: () => void;
  utxo: UTXO | null;
  latestPrice?: { date: string; price: number } | null;
}

function satsToBtc(sats: number): string {
  return (sats / 100_000_000).toFixed(8);
}

function formatUsdValue(value: number | undefined): string {
  if (value === undefined) return "-";
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

export function UTXODetailPanel({ open, onClose, utxo, latestPrice }: UTXODetailPanelProps) {
  const { openTransactionAnnotation, openIdentifierAnnotation } = useRecordPreview();
  const [fundingInputs, setFundingInputs] = useState<FundingInput[]>([]);
  const [fundingTx, setFundingTx] = useState<BlockchainTransaction | null>(null);
  const [fundingOpen, setFundingOpen] = useState(true);
  const [isLoadingFunding, setIsLoadingFunding] = useState(false);

  useEffect(() => {
    if (!open || !utxo) {
      setFundingInputs([]);
      setFundingTx(null);
      return;
    }

    const loadFundingTransaction = async () => {
      setIsLoadingFunding(true);
      try {
        const tx = await getTransactionByTxid(utxo.txid);
        setFundingTx(tx || null);

        const txParticipants = await getParticipantsByTxid(utxo.txid);
        const inputs = txParticipants.filter(p => p.role === 'input');

        const addressSet = new Set(inputs.map(i => i.address));
        const allAddressRecords = await getRecordsByType('address');
        const records = allAddressRecords.filter(r => Boolean(r.inputString && addressSet.has(r.inputString)));

        const recordMap = new Map<string, DbRecord>();
        records.forEach(r => {
          if (r.inputString) {
            recordMap.set(r.inputString, r);
          }
        });

        const fundingData: FundingInput[] = inputs.map(input => ({
          address: input.address,
          amount: input.amount,
          record: recordMap.get(input.address)
        }));

        setFundingInputs(fundingData);
      } catch (error) {
        console.error('Failed to load funding transaction:', error);
      } finally {
        setIsLoadingFunding(false);
      }
    };

    loadFundingTransaction();
  }, [open, utxo]);

  const currentValue = useMemo(() => {
    if (!utxo || !latestPrice) return undefined;
    const btcAmount = utxo.amountSats / 100_000_000;
    return btcAmount * latestPrice.price;
  }, [utxo, latestPrice]);

  const gain = useMemo(() => {
    if (currentValue === undefined || utxo?.valueAtReceipt === undefined) return undefined;
    return currentValue - utxo.valueAtReceipt;
  }, [currentValue, utxo?.valueAtReceipt]);

  const gainPercent = useMemo(() => {
    if (gain === undefined || !utxo?.valueAtReceipt || utxo.valueAtReceipt === 0) return undefined;
    return (gain / utxo.valueAtReceipt) * 100;
  }, [gain, utxo?.valueAtReceipt]);

  if (!utxo) return null;

  return (
    <Sheet open={open} onOpenChange={onClose}>
      <SheetContent className="w-full sm:max-w-md overflow-hidden flex flex-col p-0">
        <SheetHeader className="p-6 pb-4 space-y-0">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <SheetTitle className="text-xl mb-2 flex items-center gap-2">
                <Coins className="h-5 w-5" />
                UTXO Details
              </SheetTitle>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className="font-mono">
                  <SiBitcoin className="h-3 w-3 mr-1" />
                  {satsToBtc(utxo.amountSats)} BTC
                </Badge>
              </div>
            </div>
          </div>
        </SheetHeader>

        <ScrollArea className="flex-1 px-6 pb-6">
          <div className="space-y-6">
            <div>
              <h4 className="text-sm font-medium mb-3">Transaction Output</h4>
              <div className="space-y-3">
                 {fundingTx && <Button variant="outline" size="sm" onClick={() => void openTransactionAnnotation(fundingTx)} data-testid="button-annotate-utxo-transaction">
                   Annotate transaction
                 </Button>}
                <div>
                  <span className="text-xs text-muted-foreground">Transaction ID</span>
                  <div className="flex items-center gap-2 mt-1" data-testid="text-txid">
                    <TxidLink
                      txid={utxo.txid}
                      truncate={false}
                      showExternalLink={true}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <span className="text-xs text-muted-foreground">Output Index</span>
                    <p className="text-sm font-mono" data-testid="text-vout">{utxo.vout}</p>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground">Block Height</span>
                    <p className="text-sm font-mono" data-testid="text-block-height">{utxo.blockHeight.toLocaleString()}</p>
                  </div>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">Received Date</span>
                  <p className="text-sm" data-testid="text-date">
                    {format(new Date(utxo.blockTime * 1000), "MMMM d, yyyy 'at' h:mm a")}
                  </p>
                </div>
              </div>
            </div>

            <Separator />

            <div>
              <h4 className="text-sm font-medium mb-3">Value Information</h4>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <span className="text-xs text-muted-foreground">Amount</span>
                    <div className="flex flex-col">
                      <p className="text-sm font-mono" data-testid="text-amount-btc">{satsToBtc(utxo.amountSats)} BTC</p>
                      <p className="text-xs text-muted-foreground">{utxo.amountSats.toLocaleString()} sats</p>
                    </div>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground">Value at Receipt</span>
                    <p className="text-sm" data-testid="text-value-receipt">
                      {formatUsdValue(utxo.valueAtReceipt)}
                    </p>
                    {utxo.priceAtReceipt && (
                      <p className="text-xs text-muted-foreground">
                        @ {formatUsdValue(utxo.priceAtReceipt)}/BTC
                      </p>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <span className="text-xs text-muted-foreground">Current Value</span>
                    <p className="text-sm" data-testid="text-value-current">
                      {formatUsdValue(currentValue)}
                    </p>
                    {latestPrice && (
                      <p className="text-xs text-muted-foreground">
                        @ {formatUsdValue(latestPrice.price)}/BTC
                      </p>
                    )}
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground">Unrealized Gain/Loss</span>
                    <div className={cn(
                      "flex items-center gap-1",
                      gain !== undefined && gain > 0 ? "text-green-600 dark:text-green-400" : 
                      gain !== undefined && gain < 0 ? "text-red-600 dark:text-red-400" : ""
                    )} data-testid="text-gain">
                      {gain !== undefined && gain > 0 && <TrendingUp className="h-3 w-3" />}
                      {gain !== undefined && gain < 0 && <TrendingDown className="h-3 w-3" />}
                      <span className="text-sm">{formatUsdValue(gain)}</span>
                    </div>
                    {gainPercent !== undefined && (
                      <p className="text-xs text-muted-foreground">
                        {gainPercent > 0 ? '+' : ''}{gainPercent.toFixed(1)}%
                      </p>
                    )}
                  </div>
                </div>
                {latestPrice && (
                  <p className="text-xs text-muted-foreground">
                    Price data as of {format(new Date(latestPrice.date), "MMM d, yyyy")}
                  </p>
                )}
              </div>
            </div>

            <Separator />

            <div>
              <h4 className="text-sm font-medium mb-3">Address Information</h4>
              <div className="space-y-3">
                <div>
                  <span className="text-xs text-muted-foreground">Address</span>
                  <div className="flex items-center gap-2 mt-1" data-testid="text-address">
                    <AddressLink
                      address={utxo.address}
                      recordId={utxo.recordId}
                      truncate={false}
                    />
                    <Button size="sm" variant="outline" onClick={() => void openIdentifierAnnotation(utxo.address)} data-testid="button-annotate-utxo-address">Annotate</Button>
                  </div>
                </div>
                {utxo.label && (
                  <div>
                    <span className="text-xs text-muted-foreground">Label</span>
                    <p className="text-sm" data-testid="text-label">{utxo.label}</p>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-4">
                  {utxo.owner && (
                    <div>
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <User className="h-3 w-3" /> Owner
                      </span>
                      <Badge variant="secondary" className="mt-1" data-testid="badge-owner">{utxo.owner}</Badge>
                    </div>
                  )}
                  {utxo.walletName && (
                    <div>
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <WalletIcon className="h-3 w-3" /> Wallet
                      </span>
                      <Badge variant="outline" className="mt-1" data-testid="badge-wallet">{utxo.walletName}</Badge>
                    </div>
                  )}
                </div>
                {utxo.tags && utxo.tags.length > 0 && (
                  <div>
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Tag className="h-3 w-3" /> Tags
                    </span>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {utxo.tags.map(tag => (
                        <Badge key={tag} variant="outline" className="text-xs">{tag}</Badge>
                      ))}
                    </div>
                  </div>
                )}
                {utxo.categories && utxo.categories.length > 0 && (
                  <div>
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <FolderOpen className="h-3 w-3" /> Categories
                    </span>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {utxo.categories.map(cat => (
                        <Badge key={cat} variant="outline" className="text-xs">{cat}</Badge>
                      ))}
                    </div>
                  </div>
                )}
                {utxo.recordId && (
                  <Link href={`/records?id=${utxo.recordId}`}>
                    <Button variant="outline" size="sm" className="w-full" data-testid="link-view-record">
                      View Full Record
                      <ExternalLink className="h-3 w-3 ml-2" />
                    </Button>
                  </Link>
                )}
              </div>
            </div>

            <Separator />

            <Collapsible open={fundingOpen} onOpenChange={setFundingOpen}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" className="w-full justify-between px-0" data-testid="button-toggle-funding">
                  <span className="text-sm font-medium flex items-center gap-2">
                    <ArrowDownLeft className="h-4 w-4" />
                    Funding Transaction Inputs ({fundingInputs.length})
                  </span>
                  {fundingOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-3 pt-2">
                {isLoadingFunding ? (
                  <div className="flex items-center justify-center py-4">
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary" />
                  </div>
                ) : fundingInputs.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-2">
                    No input data available. This may be a coinbase transaction or the transaction data hasn't been synced.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {fundingInputs.map((input, idx) => (
                      <div key={`${input.address}-${idx}`} className="border rounded-md p-3 space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <AddressLink
                              address={input.address}
                              recordId={input.record?.id}
                              truncate={false}
                            />
                            {input.record?.label && (
                              <p className="text-xs text-muted-foreground mt-1">{input.record.label}</p>
                            )}
                          </div>
                          <Badge variant="secondary" className="font-mono text-xs flex-shrink-0">
                            {satsToBtc(input.amount)} BTC
                          </Badge>
                        </div>
                        {input.record && (
                          <div className="flex flex-wrap gap-2 text-xs">
                            {input.record.owner && (
                              <Badge variant="outline" className="gap-1">
                                <User className="h-2 w-2" />
                                {input.record.owner}
                              </Badge>
                            )}
                            {input.record.walletName && (
                              <Badge variant="outline" className="gap-1">
                                <WalletIcon className="h-2 w-2" />
                                {input.record.walletName}
                              </Badge>
                            )}
                          </div>
                        )}
                        {input.record?.id && (
                          <Link href={`/records?id=${input.record.id}`}>
                            <Button variant="ghost" size="sm" className="h-6 text-xs p-0 text-primary hover:underline">
                              View record
                              <ExternalLink className="h-2 w-2 ml-1" />
                            </Button>
                          </Link>
                        )}
                        {!input.record && (
                          <p className="text-xs text-muted-foreground">No record found for this address</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CollapsibleContent>
            </Collapsible>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ChevronDown,
  ChevronRight,
  Coins,
  Copy,
  Loader2,
  Waypoints,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  ANY_DATE_RANGE_FILTER,
  DateRangeFilter,
  dateRangeFilterToUnixRange,
  isDateRangeFilterActive,
  type DateRangeFilterValue,
} from "@/components/DateRangeFilter";
import { useToast } from "@/hooks/use-toast";
import { useAsyncMemo, yieldToUI, checkAbort } from "@/hooks/use-async-memo";
import { useDbChangeSignal } from "@/hooks/use-db-change-signal";
import { useAddressRecords } from "@/hooks/use-address-records";
import { getDustFlaggedOutpointSet } from "@/lib/data/dust-flags-crud";
import {
  getParticipantsByAddresses,
  getSpendInputsByOutpoints,
  getParticipantsByTxids,
  getTransactionsByTxids,
} from "@/lib/dataFacade";
import type { BlockchainTransaction, TransactionParticipant } from "@/lib/database";
import {
  computeUnspentUtxos,
  filterProvenanceResultsByDust,
  traceUtxoProvenance,
  type HopClassification,
  type ProvenanceHop,
  type ProvenanceUtxo,
  type ProvenanceWalkContext,
  type UtxoProvenanceResult,
} from "@/lib/utxo-provenance";
import { formatUnixSeconds } from "@/lib/unix-seconds";

const PAGE_SIZE = 100;
const ALL_WALLETS = "__all_wallets__";
/** Max ancestor transactions pulled from the DB while widening the walk. */
const MAX_ANCESTOR_FETCH = 50_000;

const CLASSIFICATION_META: Record<HopClassification, { label: string; className: string }> = {
  'origin': { label: 'External origin', className: 'bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30' },
  'partial-spend': { label: 'Partial spend', className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30' },
  'wallet-reorg': { label: 'Wallet reorg', className: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30' },
  'coinbase': { label: 'Coinbase', className: 'bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30' },
  'unknown': { label: 'Unknown', className: 'bg-muted text-muted-foreground border-border' },
};

function formatSats(sats: number): string {
  return sats.toLocaleString() + " sats";
}

function shortAddress(address: string): string {
  if (address.length <= 18) return address;
  return `${address.slice(0, 10)}…${address.slice(-6)}`;
}

function shortTxid(txid: string): string {
  return `${txid.slice(0, 10)}…${txid.slice(-6)}`;
}

interface LoadedData {
  results: UtxoProvenanceResult[];
  txByTxid: Map<string, BlockchainTransaction>;
  participantsByTxid: Map<string, { inputs: TransactionParticipant[]; outputs: TransactionParticipant[] }>;
  ownedAddresses: Set<string>;
  addressLabels: Map<string, string>;
}

async function loadProvenanceData(
  records: { inputString?: string; label?: string }[],
  signal: AbortSignal,
): Promise<LoadedData> {
  const addresses = records.map((r) => r.inputString!).filter(Boolean);
  const ownedAddresses = new Set(addresses);
  const addressLabels = new Map<string, string>();
  for (const r of records) {
    if (r.inputString && r.label) addressLabels.set(r.inputString, r.label);
  }
  const empty: LoadedData = {
    results: [],
    txByTxid: new Map(),
    participantsByTxid: new Map(),
    ownedAddresses,
    addressLabels,
  };
  if (addresses.length === 0) return empty;

  // Owned participants plus spend inputs that reference owned outpoints but
  // carry no address (Electrum syncs store inputs without prevout addresses).
  const byAddress = await getParticipantsByAddresses(addresses, signal);
  const seenIds = new Set<number>();
  const ownedOutpoints: Array<[string, number]> = [];
  for (const p of byAddress) {
    if (p.id !== undefined) seenIds.add(p.id);
    if (p.role === 'output' && p.vout != null) ownedOutpoints.push([p.txid, p.vout]);
  }
  const spendInputs = await getSpendInputsByOutpoints(ownedOutpoints, signal);
  const participants = byAddress.slice();
  for (const p of spendInputs) {
    if (p.id === undefined || !seenIds.has(p.id)) participants.push(p);
  }

  const txids = Array.from(new Set(participants.map((p) => p.txid)));
  const transactions = await getTransactionsByTxids(txids);
  checkAbort(signal);

  const txByTxid = new Map<string, BlockchainTransaction>();
  for (const tx of transactions) txByTxid.set(tx.txid, tx);

  // Hop classification needs COMPLETE transactions: the owned-side load above
  // only returns participants whose address is owned, so e.g. the merchant
  // output of a partial spend would be invisible and the tx would misclassify
  // as a wallet reorg. Re-fetch the full participant set for every tx that
  // touches the wallet (chunked — anyOf keys are bounded).
  const participantsByTxid = new Map<string, { inputs: TransactionParticipant[]; outputs: TransactionParticipant[] }>();
  const ingest = (rows: TransactionParticipant[]) => {
    for (const p of rows) {
      let entry = participantsByTxid.get(p.txid);
      if (!entry) {
        entry = { inputs: [], outputs: [] };
        participantsByTxid.set(p.txid, entry);
      }
      if (p.role === 'input') entry.inputs.push(p);
      else entry.outputs.push(p);
    }
  };
  const FULL_CHUNK = 500;
  for (let i = 0; i < txids.length; i += FULL_CHUNK) {
    checkAbort(signal);
    ingest(await getParticipantsByTxids(txids.slice(i, i + FULL_CHUNK)));
    if (i + FULL_CHUNK < txids.length) await yieldToUI();
  }

  const isWalletAddress = (a: string) => ownedAddresses.has(a);
  const utxos = computeUnspentUtxos(participants, txByTxid, isWalletAddress);
  checkAbort(signal);

  // Widen: fetch ancestor transactions the walker can still reach, level by
  // level. Every loaded tx's inputs are scanned for prevTxids we don't have
  // yet — an ancestor that never paid an owned address directly (e.g. the
  // tx that funded the external party who later paid us) is only discoverable
  // this way. The cap counts ancestor pulls only, never the initial
  // wallet-touching set; the walker itself caps depth.
  let ancestorFetched = 0;
  for (;;) {
    checkAbort(signal);
    const missing = new Set<string>();
    for (const entry of participantsByTxid.values()) {
      for (const input of entry.inputs) {
        if (input.prevTxid != null && !txByTxid.has(input.prevTxid)) missing.add(input.prevTxid);
      }
    }
    if (missing.size === 0 || ancestorFetched >= MAX_ANCESTOR_FETCH) break;
    const batch = Array.from(missing).slice(0, MAX_ANCESTOR_FETCH - ancestorFetched);
    const [txs, parts] = await Promise.all([
      getTransactionsByTxids(batch),
      getParticipantsByTxids(batch),
    ]);
    for (const tx of txs) txByTxid.set(tx.txid, tx);
    ingest(parts);
    ancestorFetched += txs.length;
    if (txs.length === 0) break; // referenced but not on record anywhere
    await yieldToUI();
  }

  const ctx: ProvenanceWalkContext = { txByTxid, participantsByTxid, isWalletAddress };
  const results: UtxoProvenanceResult[] = [];
  const CHUNK = 250;
  const cache = new Map<string, HopClassification>();
  for (let i = 0; i < utxos.length; i += CHUNK) {
    checkAbort(signal);
    const chunk = utxos.slice(i, i + CHUNK);
    for (const u of chunk) {
      results.push(traceUtxoProvenance(u, ctx, cache));
    }
    if (i + CHUNK < utxos.length) await yieldToUI();
  }

  return { results, txByTxid, participantsByTxid, ownedAddresses, addressLabels };
}

function HopChip({
  hop,
  onOpen,
}: {
  hop: ProvenanceHop;
  onOpen: (hop: ProvenanceHop) => void;
}) {
  const meta = CLASSIFICATION_META[hop.classification];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid={`hop-chip-${hop.txid.slice(0, 8)}`}
          onClick={(e) => {
            // Don't let the click bubble to the row toggle — opening the
            // dialog must not collapse the trail underneath it.
            e.stopPropagation();
            onOpen(hop);
          }}
          className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-mono transition-colors hover:opacity-80 ${meta.className}`}
        >
          <span className="font-semibold">H{hop.depth}</span>
          <span>{formatUnixSeconds(hop.blockTime, "yyyy-MM-dd")}</span>
          <span className="hidden sm:inline">{meta.label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-sm font-mono text-xs">
        <div className="space-y-1">
          <div className="break-all">{hop.txid}</div>
          <div>
            Block {hop.blockHeight > 0 ? hop.blockHeight.toLocaleString() : "unconfirmed"} · {formatUnixSeconds(hop.blockTime, "yyyy-MM-dd HH:mm")}
          </div>
          <div>
            {hop.inputCount} in ({formatSats(hop.totalInputSats)}) → {hop.outputCount} out ({formatSats(hop.totalOutputSats)})
          </div>
          <div>Fee {formatSats(hop.feeSats)} · {meta.label}</div>
          {hop.stopReason && <div className="text-muted-foreground">Trail ends here: {hop.stopReason.replace(/-/g, ' ')}</div>}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function HopDetailsDialog({
  hop,
  data,
  onClose,
}: {
  hop: ProvenanceHop | null;
  data: LoadedData | undefined;
  onClose: () => void;
}) {
  const { toast } = useToast();
  if (!hop || !data) return null;
  const parts = data.participantsByTxid.get(hop.txid) ?? { inputs: [], outputs: [] };
  const meta = CLASSIFICATION_META[hop.classification];

  const copyTxid = async () => {
    try {
      await navigator.clipboard.writeText(hop.txid);
      toast({ title: "Copied", description: "Transaction ID copied to clipboard" });
    } catch {
      toast({ title: "Copy failed", description: "Could not copy the transaction ID", variant: "destructive" });
    }
  };

  const renderSide = (title: string, rows: TransactionParticipant[]) => (
    <div>
      <h4 className="mb-1 text-sm font-semibold">{title} ({rows.length})</h4>
      <div className="max-h-48 overflow-y-auto rounded-md border">
        {rows.length === 0 ? (
          <div className="p-2 text-xs text-muted-foreground">No {title.toLowerCase()} on record.</div>
        ) : (
          rows.map((p, i) => (
            <div key={i} className="flex items-center justify-between gap-2 border-b px-2 py-1 font-mono text-xs last:border-b-0">
              <span className="break-all">
                {p.address ? shortAddress(p.address) : <span className="text-muted-foreground">(no address)</span>}
                {p.address && data.ownedAddresses.has(p.address) && (
                  <Badge variant="outline" className="ml-1 text-[10px]">owned</Badge>
                )}
              </span>
              <span className="whitespace-nowrap">{formatSats(p.amount)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl" data-testid="hop-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Hop {hop.depth} transaction
            <Badge variant="outline" className={meta.className}>{meta.label}</Badge>
          </DialogTitle>
          <DialogDescription className="break-all font-mono text-xs">{hop.txid}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <div><div className="text-xs text-muted-foreground">Date</div>{formatUnixSeconds(hop.blockTime, "yyyy-MM-dd HH:mm")}</div>
          <div><div className="text-xs text-muted-foreground">Block</div>{hop.blockHeight > 0 ? hop.blockHeight.toLocaleString() : "Unconfirmed"}</div>
          <div><div className="text-xs text-muted-foreground">Fee</div>{formatSats(hop.feeSats)}</div>
          <div><div className="text-xs text-muted-foreground">Net through wallet</div>{formatSats(hop.totalOutputSats - hop.totalInputSats)}</div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {renderSide("Inputs", parts.inputs)}
          {renderSide("Outputs", parts.outputs)}
        </div>
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={copyTxid} data-testid="hop-dialog-copy">
            <Copy className="mr-1 h-3 w-3" /> Copy txid
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function UtxoProvenancePage() {
  const { records, isLoading: recordsLoading } = useAddressRecords({ includeBlockchainDiscovered: false });
  const txDbSignal = useDbChangeSignal(['blockchainTransactions', 'transactionParticipants']);

  const walletOptions = useMemo(
    () => Array.from(new Set(records.map((record) => record.walletName).filter((name): name is string => Boolean(name))))
      .sort((a, b) => a.localeCompare(b)),
    [records],
  );
  const [selectedWallet, setSelectedWallet] = useState(ALL_WALLETS);
  const effectiveWallet = selectedWallet === ALL_WALLETS || walletOptions.includes(selectedWallet)
    ? selectedWallet
    : ALL_WALLETS;
  const scopedRecords = useMemo(
    () => effectiveWallet === ALL_WALLETS
      ? records
      : records.filter((record) => record.walletName === effectiveWallet),
    [records, effectiveWallet],
  );

  const [search, setSearch] = useState("");
  const [classFilter, setClassFilter] = useState<string>("any");
  const [minHops, setMinHops] = useState<string>("0");
  const [dateRange, setDateRange] = useState<DateRangeFilterValue>(ANY_DATE_RANGE_FILTER);
  const [ignoreDust, setIgnoreDust] = useState(false);
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [openHop, setOpenHop] = useState<ProvenanceHop | null>(null);

  const dustFlaggedOutpoints = useLiveQuery(
    () => getDustFlaggedOutpointSet(),
    [],
  );

  const { value: data, isComputing } = useAsyncMemo(
    async (signal) => loadProvenanceData(scopedRecords, signal),
    [scopedRecords, txDbSignal],
    undefined as LoadedData | undefined,
  );

  const dateScopedResults = useMemo(() => {
    const unixRange = dateRangeFilterToUnixRange(dateRange);
    return (data?.results ?? []).filter((r) => {
      if (unixRange?.start !== undefined && r.utxo.blockTime < unixRange.start) return false;
      if (unixRange?.end !== undefined && r.utxo.blockTime > unixRange.end) return false;
      return true;
    });
  }, [data, dateRange]);

  const visibleResults = useMemo(() => {
    return filterProvenanceResultsByDust(dateScopedResults, dustFlaggedOutpoints, ignoreDust);
  }, [dateScopedResults, ignoreDust, dustFlaggedOutpoints]);

  const hiddenDustCount = dateScopedResults.length - visibleResults.length;

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    const minH = parseInt(minHops, 10) || 0;
    return visibleResults.filter((r) => {
      if (r.hopsBack < minH) return false;
      if (classFilter !== 'any' && !r.classifications.includes(classFilter as HopClassification)) return false;
      if (q) {
        const label = data.addressLabels.get(r.utxo.address) ?? '';
        const haystack = `${r.utxo.address} ${r.utxo.txid} ${label}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [data, visibleResults, search, classFilter, minHops]);

  const stats = useMemo(() => {
    if (!data) return { total: 0, withHistory: 0, partialSpend: 0, reorg: 0 };
    let withHistory = 0, partialSpend = 0, reorg = 0;
    for (const r of visibleResults) {
      if (r.hopsBack > 1) withHistory++;
      if (r.classifications.includes('partial-spend')) partialSpend++;
      if (r.classifications.includes('wallet-reorg')) reorg++;
    }
    return { total: visibleResults.length, withHistory, partialSpend, reorg };
  }, [data, visibleResults]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE);

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const loading = recordsLoading || isComputing;

  useEffect(() => {
    setPage(0);
    setExpanded(new Set());
    setOpenHop(null);
  }, [effectiveWallet, ignoreDust, dateRange]);

  return (
    <TooltipProvider>
      <div className="container mx-auto space-y-4 p-4" data-testid="utxo-provenance-page">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Waypoints className="h-6 w-6" /> UTXO Provenance
          </h1>
          <p className="text-sm text-muted-foreground">
            Every unspent output in your wallet, traced backwards through the transactions you have on record.
            Each hop is classified as a partial spend or a wallet reorganization.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card><CardHeader className="p-3 pb-1"><CardDescription>Unspent UTXOs</CardDescription><CardTitle className="text-xl">{stats.total.toLocaleString()}</CardTitle></CardHeader></Card>
          <Card><CardHeader className="p-3 pb-1"><CardDescription>History beyond 1 hop</CardDescription><CardTitle className="text-xl">{stats.withHistory.toLocaleString()}</CardTitle></CardHeader></Card>
          <Card><CardHeader className="p-3 pb-1"><CardDescription>Partial spends seen</CardDescription><CardTitle className="text-xl">{stats.partialSpend.toLocaleString()}</CardTitle></CardHeader></Card>
          <Card><CardHeader className="p-3 pb-1"><CardDescription>Wallet reorgs seen</CardDescription><CardTitle className="text-xl">{stats.reorg.toLocaleString()}</CardTitle></CardHeader></Card>
        </div>

        <Card>
          <CardHeader className="p-4 pb-2">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <Label htmlFor="prov-wallet-filter">Wallet</Label>
                <Select
                  value={effectiveWallet}
                  onValueChange={(value) => {
                    setSelectedWallet(value);
                    setPage(0);
                    setExpanded(new Set());
                    setOpenHop(null);
                  }}
                >
                  <SelectTrigger id="prov-wallet-filter" aria-label="Wallet" className="w-44" data-testid="prov-wallet-filter"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_WALLETS}>All wallets</SelectItem>
                    {walletOptions.map((wallet) => (
                      <SelectItem key={wallet} value={wallet}>{wallet}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-52 flex-1">
                <Label htmlFor="prov-search">Search</Label>
                <Input
                  id="prov-search"
                  data-testid="prov-search"
                  placeholder="Address, txid or label…"
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                />
              </div>
              <DateRangeFilter
                value={dateRange}
                onChange={setDateRange}
                label="Date Range"
                testId="utxo-provenance-date-range"
              />
              <div>
                <Label>Pattern</Label>
                <Select value={classFilter} onValueChange={(v) => { setClassFilter(v); setPage(0); }}>
                  <SelectTrigger className="w-44" data-testid="prov-class-filter"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">Any pattern</SelectItem>
                    <SelectItem value="partial-spend">Has partial spend</SelectItem>
                    <SelectItem value="wallet-reorg">Has wallet reorg</SelectItem>
                    <SelectItem value="origin">External origin only</SelectItem>
                    <SelectItem value="coinbase">Coinbase origin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Min hops back</Label>
                <Select value={minHops} onValueChange={(v) => { setMinHops(v); setPage(0); }}>
                  <SelectTrigger className="w-28" data-testid="prov-min-hops"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {['0', '1', '2', '3', '5', '10'].map((v) => (
                      <SelectItem key={v} value={v}>{v === '0' ? 'Any' : `≥ ${v}`}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex min-h-9 items-center gap-2">
                <Switch
                  id="switch-ignore-prov-dust"
                  checked={ignoreDust}
                  onCheckedChange={(checked) => {
                    setIgnoreDust(checked);
                    setPage(0);
                    setExpanded(new Set());
                    setOpenHop(null);
                  }}
                  data-testid="switch-ignore-prov-dust"
                />
                <Label htmlFor="switch-ignore-prov-dust" className="cursor-pointer whitespace-nowrap text-sm">
                  Hide dust
                </Label>
              </div>
            </div>
            {ignoreDust && hiddenDustCount > 0 && (
              <div className="pt-2">
                <Badge variant="secondary" data-testid="prov-dust-status">
                  Hiding {hiddenDustCount.toLocaleString()} flagged dust UTXO{hiddenDustCount === 1 ? "" : "s"}
                </Badge>
              </div>
            )}
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <div className="flex items-center justify-center gap-2 p-10 text-muted-foreground" data-testid="prov-loading">
                <Loader2 className="h-4 w-4 animate-spin" /> Tracing provenance…
              </div>
            ) : !data || data.results.length === 0 ? (
              <div className="flex flex-col items-center gap-2 p-10 text-center text-muted-foreground" data-testid="prov-empty">
                <Coins className="h-8 w-8" />
                <p>{effectiveWallet === ALL_WALLETS
                  ? "No unspent UTXOs found. Sync your wallet addresses first."
                  : `No unspent UTXOs found in ${effectiveWallet}.`}</p>
              </div>
            ) : visibleResults.length === 0 ? (
              <div className="flex flex-col items-center gap-2 p-10 text-center text-muted-foreground" data-testid="prov-empty">
                <Coins className="h-8 w-8" />
                {dateScopedResults.length === 0 ? (
                  <p>No unspent UTXOs match the selected date range.</p>
                ) : (
                  <>
                    <p>All unspent UTXOs in this view are flagged as dust.</p>
                    <p className="text-xs">Turn off “Hide dust” to show them.</p>
                  </>
                )}
              </div>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8"></TableHead>
                      <TableHead>Address</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Received</TableHead>
                      <TableHead className="text-center">Hops back</TableHead>
                      <TableHead>History span</TableHead>
                      <TableHead>Patterns</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRows.map((r) => {
                      const isOpen = expanded.has(r.utxo.id);
                      const label = data.addressLabels.get(r.utxo.address);
                      return (
                        <FragmentRow
                          key={r.utxo.id}
                          result={r}
                          label={label}
                          isOpen={isOpen}
                          onToggle={() => toggleExpanded(r.utxo.id)}
                          onOpenHop={setOpenHop}
                          dateFilterActive={isDateRangeFilterActive(dateRange)}
                        />
                      );
                    })}
                  </TableBody>
                </Table>
                <div className="flex items-center justify-between p-3 text-sm text-muted-foreground">
                  <span data-testid="prov-count">{filtered.length.toLocaleString()} UTXOs</span>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" disabled={clampedPage === 0} onClick={() => setPage(clampedPage - 1)} data-testid="prov-prev">Previous</Button>
                    <span>Page {clampedPage + 1} of {pageCount}</span>
                    <Button variant="outline" size="sm" disabled={clampedPage >= pageCount - 1} onClick={() => setPage(clampedPage + 1)} data-testid="prov-next">Next</Button>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <HopDetailsDialog hop={openHop} data={data} onClose={() => setOpenHop(null)} />
      </div>
    </TooltipProvider>
  );
}

function FragmentRow({
  result,
  label,
  isOpen,
  onToggle,
  onOpenHop,
  dateFilterActive,
}: {
  result: UtxoProvenanceResult;
  label: string | undefined;
  isOpen: boolean;
  onToggle: () => void;
  onOpenHop: (hop: ProvenanceHop) => void;
  dateFilterActive: boolean;
}) {
  const r = result;
  return (
    <>
      <TableRow data-testid={`utxo-prov-row-${r.utxo.txid.slice(0, 8)}-${r.utxo.vout}`} className="cursor-pointer" onClick={onToggle}>
        <TableCell>{isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</TableCell>
        <TableCell className="font-mono text-xs">
          <div>{shortAddress(r.utxo.address)}</div>
          {label && <div className="text-muted-foreground">{label}</div>}
        </TableCell>
        <TableCell className="text-right font-mono text-xs">{formatSats(r.utxo.amountSats)}</TableCell>
        <TableCell className="text-xs">{formatUnixSeconds(r.utxo.blockTime, "yyyy-MM-dd")}</TableCell>
        <TableCell className="text-center">
          <Badge variant="secondary" data-testid={`hops-back-${r.utxo.txid.slice(0, 8)}-${r.utxo.vout}`}>
            {r.hopsBack}{r.truncated ? '+' : ''}
          </Badge>
        </TableCell>
        <TableCell className="text-xs">
          {r.oldestHopTime > 0
            ? `${formatUnixSeconds(r.oldestHopTime, "yyyy-MM-dd")} → ${formatUnixSeconds(r.newestHopTime, "yyyy-MM-dd")}`
            : '—'}
        </TableCell>
        <TableCell>
          <div className="flex flex-wrap gap-1">
            {r.classifications.map((c) => (
              <Badge key={c} variant="outline" className={`text-[10px] ${CLASSIFICATION_META[c].className}`}>
                {CLASSIFICATION_META[c].label}
              </Badge>
            ))}
          </div>
        </TableCell>
      </TableRow>
      {isOpen && (
        <TableRow>
          <TableCell colSpan={7} className="bg-muted/30 p-3">
            <div className="space-y-2">
              <div className="font-mono text-xs text-muted-foreground">
                Outpoint {r.utxo.txid}:{r.utxo.vout}
              </div>
              <div className="flex flex-wrap gap-1.5" data-testid={`hop-list-${r.utxo.txid.slice(0, 8)}-${r.utxo.vout}`}>
                {r.hops.map((h) => (
                  <HopChip key={`${h.txid}-${h.depth}`} hop={h} onOpen={onOpenHop} />
                ))}
                {r.hops.length === 0 && (
                  <span className="text-xs text-muted-foreground">No transaction details on record for this output.</span>
                )}
              </div>
              {dateFilterActive && (
                <p className="text-xs italic text-muted-foreground" data-testid={`prov-ancestor-unscoped-note-${r.utxo.txid.slice(0, 8)}-${r.utxo.vout}`}>
                  Ancestor spend history above shows the full trail and is not limited by the selected date range.
                </p>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

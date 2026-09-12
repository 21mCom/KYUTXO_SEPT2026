import { useEffect, useMemo, useState } from "react";
import { Download, FileText, Loader2, Route, ShieldQuestion } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAddressRecords } from "@/hooks/use-address-records";
import { useDbChangeSignal } from "@/hooks/use-db-change-signal";
import { useToast } from "@/hooks/use-toast";
import { evaluateEngineFreshness } from "@/lib/engine/engine-freshness";
import { engineGetCoinOrigins, engineGetCoinOriginsPage } from "@/lib/engine/engine-client";
import {
  buildCoinOriginsCsv,
  buildCoinOriginsExportPayload,
  buildCoinOriginsPdf,
} from "@/lib/coin-origins-export";
import { downloadBlob } from "@/lib/backup/sink";
import { formatUnixSeconds } from "@/lib/unix-seconds";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import { UNASSIGNED_OWNER_OPTION, UNASSIGNED_OWNER_VALUE } from "@/lib/owner-constants";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { assertOwnerCostBasisCheckpoint, loadCoinOrigins, loadCoinOriginsPage, loadOwnerCostBasisSnapshot, type CoinOriginOutpoint, type CoinOriginsLedger, type CoinOriginsPage } from "@/lib/coin-origins";
import { buildOwnerCostBasisPageCsv, type OwnerCostBasisEditorRow, type OwnerCostBasisPage } from "@/lib/owner-cost-basis-core";
import { ensureRecordEntity, getTransactionLegMetadataByTxid, getTransactionMetadataByTxid, putTransactionLegMetadata } from "@/lib/data/record-model-crud";

const ALL_WALLETS = "__all_wallets__";

const ORIGINS_PAGE_SIZE = 100;

const finiteNonNegative = (value: string, label: string): number | undefined => {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be a finite nonnegative number`);
  return parsed;
};
function short(value: string): string {
  return value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
}

function boundaryBadge(boundary: string) {
  if (boundary === "mixed") return <Badge variant="outline" className="text-amber-600">Mixed boundary</Badge>;
  if (boundary === "unknown") return <Badge variant="secondary">Unknown origin</Badge>;
  return <Badge variant="outline" className="text-emerald-600">Reconciled</Badge>;
}

function CostBasisEditor({ rows, expectedCheckpointKey, selectedOwner, onSaved }: {
  rows: OwnerCostBasisEditorRow[];
  expectedCheckpointKey?: string;
  selectedOwner?: string;
  onSaved: () => void;
}) {
  const [selected, setSelected] = useState<OwnerCostBasisEditorRow>();
  const [proceeds, setProceeds] = useState("");
  const [proceedsKind, setProceedsKind] = useState<"provided" | "estimated">("provided");
  const [legOwner, setLegOwner] = useState("");
  const [rule, setRule] = useState<"carry-over" | "market-value-step-up">("carry-over");
  const [marketValue, setMarketValue] = useState("");
  const [marketValueKind, setMarketValueKind] = useState<"provided" | "estimated">("provided");
  const [lotIds, setLotIds] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!selected) return;
    void Promise.all([getTransactionMetadataByTxid(selected.txid), getTransactionLegMetadataByTxid(selected.txid)]).then(([tx, legs]) => {
      const leg = legs.find(item => item.legKey === selected.legKey);
      setProceeds(String(leg?.proceedsUsd ?? leg?.estimatedProceedsUsd ?? tx?.proceedsUsd ?? tx?.estimatedProceedsUsd ?? ""));
      setProceedsKind(
        (leg?.estimatedProceedsUsd !== undefined && leg.proceedsUsd === undefined) ||
        (leg?.proceedsUsd === undefined && leg?.estimatedProceedsUsd === undefined && tx?.estimatedProceedsUsd !== undefined && tx.proceedsUsd === undefined)
          ? "estimated" : "provided",
      );
      setLegOwner(selected.owner);
      setRule(leg?.transferBasisRule ?? "carry-over");
      setMarketValue(String(leg?.marketValueUsd ?? leg?.estimatedMarketValueUsd ?? ""));
      setMarketValueKind(leg?.estimatedMarketValueUsd !== undefined && leg.marketValueUsd === undefined ? "estimated" : "provided");
      setLotIds(leg?.specificLotIds?.join(", ") ?? "");
    });
  }, [selected]);
  const save = async () => {
    if (!selected) return;
    try {
      setSaving(true);
      if (!expectedCheckpointKey) throw new Error("Cost-basis report is unavailable; reload before saving.");
      await assertOwnerCostBasisCheckpoint(expectedCheckpointKey, selectedOwner);
      const legs = await getTransactionLegMetadataByTxid(selected.txid);
      const existingLeg = legs.find(item => item.legKey === selected.legKey);
      const proceedsValue = finiteNonNegative(proceeds, "Transaction proceeds");
      const marketValueUsd = finiteNonNegative(marketValue, "Market value");
      const owner = legOwner.trim();
      const entityId = owner ? (await ensureRecordEntity(owner)).id : undefined;
      const specificLotIds = [...new Set(lotIds.split(",").map(value => value.trim()).filter(Boolean))];
      await putTransactionLegMetadata({
        ...(existingLeg ? metadataInput(existingLeg) : { txid: selected.txid, legKey: selected.legKey, direction: selected.direction }),
        direction: selected.direction, entityId, transferBasisRule: rule,
        proceedsUsd: proceedsKind === "provided" ? proceedsValue : undefined,
        estimatedProceedsUsd: proceedsKind === "estimated" ? proceedsValue : undefined,
        marketValueUsd: marketValueKind === "provided" ? marketValueUsd : undefined,
        estimatedMarketValueUsd: marketValueKind === "estimated" ? marketValueUsd : undefined,
        specificLotIds,
      });
      setSelected(undefined);
      onSaved();
    } catch (error) {
      // Keep the dialog open so the user can correct an invalid value.
      window.alert(error instanceof Error ? error.message : "Could not save cost-basis metadata");
    } finally { setSaving(false); }
  };
  return <Card data-testid="owner-cost-basis-editor">
    <CardHeader><CardTitle>Cost-Basis Metadata</CardTitle><CardDescription>Review the first {ORIGINS_PAGE_SIZE} relevant disposal or owner-transfer legs from this owner report. Values are USD and estimates remain explicitly marked.</CardDescription></CardHeader>
    <CardContent>
      <Table><TableHeader><TableRow><TableHead>Transaction / leg</TableHead><TableHead>Owner</TableHead><TableHead>Type</TableHead><TableHead className="text-right">Sats</TableHead><TableHead /></TableRow></TableHeader><TableBody>
        {rows.map(row => <TableRow key={`${row.txid}|${row.legKey}`}><TableCell className="font-mono text-xs">{short(row.txid)} · {row.legKey}</TableCell><TableCell>{row.owner}</TableCell><TableCell>{row.kind === "external" ? "Disposal" : "Owner transfer"}</TableCell><TableCell className="text-right">{row.sats.toLocaleString()}</TableCell><TableCell><Button size="sm" variant="outline" onClick={() => setSelected(row)} data-testid={`edit-cost-basis-${row.txid}-${row.legKey}`}>Edit</Button></TableCell></TableRow>)}
      </TableBody></Table>
      {!rows.length && <div className="py-6 text-center text-sm text-muted-foreground">No report disposal or owner-transfer legs are available in this scope.</div>}
    </CardContent>
    <Dialog open={!!selected} onOpenChange={open => !open && setSelected(undefined)}><DialogContent><DialogHeader><DialogTitle>Edit cost-basis metadata</DialogTitle><DialogDescription>{selected?.txid} · {selected?.legKey}</DialogDescription></DialogHeader>
      <div className="grid gap-3"><div><Label>Transaction proceeds (USD)</Label><Input value={proceeds} inputMode="decimal" onChange={event => setProceeds(event.target.value)} data-testid="cost-basis-proceeds" /></div><div><Label>Proceeds source</Label><Select value={proceedsKind} onValueChange={value => setProceedsKind(value as "provided" | "estimated")}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="provided">Provided</SelectItem><SelectItem value="estimated">Estimated</SelectItem></SelectContent></Select></div><div><Label>Leg owner</Label><Input value={legOwner} onChange={event => setLegOwner(event.target.value)} data-testid="cost-basis-leg-owner" /></div><div><Label>Transfer basis rule</Label><Select value={rule} onValueChange={value => setRule(value as "carry-over" | "market-value-step-up")}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="carry-over">Carry-over</SelectItem><SelectItem value="market-value-step-up">Market-value step-up</SelectItem></SelectContent></Select></div><div><Label>Market value (USD)</Label><Input value={marketValue} inputMode="decimal" onChange={event => setMarketValue(event.target.value)} data-testid="cost-basis-market-value" /></div><div><Label>Market value source</Label><Select value={marketValueKind} onValueChange={value => setMarketValueKind(value as "provided" | "estimated")}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="provided">Provided</SelectItem><SelectItem value="estimated">Estimated</SelectItem></SelectContent></Select></div><div><Label>Specific lot IDs (comma-separated)</Label><Input value={lotIds} onChange={event => setLotIds(event.target.value)} data-testid="cost-basis-lot-ids" /></div></div>
      <DialogFooter><Button variant="outline" onClick={() => setSelected(undefined)}>Cancel</Button><Button onClick={() => void save()} disabled={saving} data-testid="save-cost-basis-metadata">Save metadata</Button></DialogFooter>
    </DialogContent></Dialog>
  </Card>;
}
function CoinPassport({
  output,
  ledger,
  onExport,
  page,
  onAllocationPageChange,
  onHopPageChange,
}: {
  output: CoinOriginOutpoint;
  ledger: CoinOriginsLedger;
  onExport: (kind: "csv" | "pdf", outpoint: string) => void;
  page?: CoinOriginsPage;
  onAllocationPageChange: (delta: number) => void;
  onHopPageChange: (delta: number) => void;
}) {
  const hopByTxid = new Map(ledger.hops.map((hop) => [hop.txid, hop]));
  const lotById = new Map(ledger.lots.map((lot) => [lot.lotId, lot]));
  const holdings = output.allocations.map((allocation) => {
    const holding = ledger.holdings.find((row) => row.lotId === allocation.lotId);
    return { allocation, holding };
  });
  const outpoint = `${output.txid}:${output.vout}`;
  return (
    <Card data-testid="coin-passport">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2"><Route className="h-5 w-5" /> Coin Passport</CardTitle>
            <CardDescription className="break-all font-mono">{outpoint}</CardDescription>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onExport("csv", outpoint)} data-testid="coin-passport-csv"><Download className="mr-1 h-4 w-4" /> CSV</Button>
            <Button variant="outline" size="sm" onClick={() => onExport("pdf", outpoint)} data-testid="coin-passport-pdf"><FileText className="mr-1 h-4 w-4" /> PDF</Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <div><div className="text-xs text-muted-foreground">Current value</div><div className="font-mono font-semibold">{output.amountSats.toLocaleString()} sats</div></div>
          <div><div className="text-xs text-muted-foreground">Address</div><div className="break-all font-mono text-xs">{output.address}</div></div>
          <div><div className="text-xs text-muted-foreground">Boundary</div>{boundaryBadge(output.boundary)}</div>
        </div>
        <div className="rounded-md border p-3 text-sm" data-testid="coin-passport-recipe">
          <div className="font-semibold">Recipe</div>
          <div className="text-muted-foreground">
            {output.allocations.length} origin {output.allocations.length === 1 ? "batch" : "batches"} ·
            {" "}{output.allocations.some((allocation) => lotById.get(allocation.lotId)?.costProvenance === "provided")
              ? "includes user-provided acquisition cost metadata"
              : "no acquisition cost metadata"}
          </div>
        </div>
        {output.preMixTxids && output.preMixTxids.length > 0 && (
          <div className="rounded-md border border-amber-500/40 bg-amber-50 p-3 text-sm dark:bg-amber-950/20" data-testid="coin-passport-coinjoin-boundary">
            CoinJoin boundary: this recipe deliberately stops at the mix. Pre-mix history is retained separately and is not attributed to this output.
          </div>
        )}
        <div>
          <h3 className="mb-2 font-semibold">Origin breakdown</h3>
          <Table>
            <TableHeader><TableRow><TableHead>Origin recipe</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Satoshis</TableHead></TableRow></TableHeader>
            <TableBody>
              {holdings.map(({ allocation, holding }) => (
                <TableRow key={allocation.lotId} data-testid={`coin-passport-allocation-${allocation.lotId}`}>
                  <TableCell>
                    <div>{holding?.label ?? "Unknown origin"}</div>
                    {holding?.acquiredTxid && <div className="font-mono text-xs text-muted-foreground">{short(`${holding.acquiredTxid}:${holding.acquiredVout}`)}</div>}
                  </TableCell>
                  <TableCell>{boundaryBadge(allocation.lotId === "unknown" ? "unknown" : output.boundary)}</TableCell>
                  <TableCell className="text-right font-mono">{allocation.sats.toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {page?.detail && page.detail.allocationsTotal > ORIGINS_PAGE_SIZE && (
            <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
              <span>{page.detail.allocationsOffset + 1}–{Math.min(page.detail.allocationsOffset + output.allocations.length, page.detail.allocationsTotal)} of {page.detail.allocationsTotal.toLocaleString()} origins</span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={page.detail.allocationsOffset === 0} onClick={() => onAllocationPageChange(-1)}>Previous</Button>
                <Button size="sm" variant="outline" disabled={!page.detail.allocationsHasMore} onClick={() => onAllocationPageChange(1)}>Next</Button>
              </div>
            </div>
          )}
        </div>
        <div>
          <h3 className="mb-2 font-semibold">Hop timeline</h3>
          <div className="space-y-2">
            {output.hopTxids.map((txid, index) => {
              const hop = hopByTxid.get(txid);
              if (!hop) return null;
              return (
                <div key={txid} className="flex gap-3 rounded-md border p-3" data-testid={`coin-passport-hop-${index}`}>
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">{index + 1}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium capitalize">{hop.kind.replace("-", " ")}</span>
                      {boundaryBadge(hop.boundary)}
                    </div>
                    <div className="break-all font-mono text-xs">{txid}</div>
                    <div className="text-xs text-muted-foreground">
                      {hop.blockTime ? formatUnixSeconds(hop.blockTime, "yyyy-MM-dd HH:mm") : "Date unknown"} · fee {hop.feeSats.toLocaleString()} sats
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {page?.detail && page.detail.hopsTotal > ORIGINS_PAGE_SIZE && (
            <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
              <span>{page.detail.hopsOffset + 1}–{Math.min(page.detail.hopsOffset + output.hopTxids.length, page.detail.hopsTotal)} of {page.detail.hopsTotal.toLocaleString()} hops</span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={page.detail.hopsOffset === 0} onClick={() => onHopPageChange(-1)}>Previous</Button>
                <Button size="sm" variant="outline" disabled={!page.detail.hopsHasMore} onClick={() => onHopPageChange(1)}>Next</Button>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/*
export default function CoinOriginsPage() {
  const { toast } = useToast();
  const { records, isLoading: recordsLoading } = useAddressRecords({ includeBlockchainDiscovered: false });
  const dbSignal = useDbChangeSignal(["records", "blockchainTransactions", "transactionParticipants", "transactionMetadata"]);
  const walletOptions = useMemo(
    () => [...new Set(records.map((r) => r.walletName).filter((v): v is string => !!v))].sort(),
    [records],
  );
  const ownerOptions = useMemo(
    () => [...new Set(records.map((r) => r.owner?.trim()).filter((v): v is string => !!v))].sort(),
    [records],
  );
  const [wallet, setWallet] = useState(ALL_WALLETS);
  const [owners, setOwners] = useState<string[]>([]);
  const [ledger, setLedger] = useState<CoinOriginsLedger>();
  const [nativePage, setNativePage] = useState<CoinOriginsPage>();
  const [nativeBacked, setNativeBacked] = useState(false);
  const [passportPage, setPassportPage] = useState<CoinOriginsPage>();
  const [holdingsPageIndex, setHoldingsPageIndex] = useState(0);
  const [outpointsPageIndex, setOutpointsPageIndex] = useState(0);
  const [allocationsPageIndex, setAllocationsPageIndex] = useState(0);
  const [hopsPageIndex, setHopsPageIndex] = useState(0);
  const [passportLoading, setPassportLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const initialOutpoint = useMemo(() => new URLSearchParams(window.location.search).get("outpoint") ?? "", []);
  const [selectedOutpoint, setSelectedOutpoint] = useState(initialOutpoint);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setPassportPage(undefined);
    setNativePage(undefined);
    const walletName = wallet === ALL_WALLETS ? undefined : wallet;
    void (async () => {
      const gate = await evaluateEngineFreshness("coinOrigins");
      if (gate.useEngine) {
        const next = await engineGetCoinOriginsPage({
          walletName,
          owners,
          holdingsOffset: holdingsPageIndex * ORIGINS_PAGE_SIZE,
          outpointsOffset: outpointsPageIndex * ORIGINS_PAGE_SIZE,
          limit: ORIGINS_PAGE_SIZE,
        });
        if (!cancelled) {
          setNativePage(next);
          setNativeBacked(true);
          setLedger(undefined);
        }
      } else {
        const next = await loadCoinOriginsPage({
          walletName,
          owners,
          holdingsOffset: holdingsPageIndex * ORIGINS_PAGE_SIZE,
          outpointsOffset: outpointsPageIndex * ORIGINS_PAGE_SIZE,
          limit: ORIGINS_PAGE_SIZE,
        });
        if (!cancelled) {
          setLedger(next.ledger);
          setNativePage(next.page);
          setNativeBacked(false);
        }
      }
    })().catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : "Could not build the origin ledger");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [wallet, owners, holdingsPageIndex, outpointsPageIndex, dbSignal]);

  const selected = (passportPage && passportPage.checkpointKey === nativePage?.checkpointKey
    ? passportPage.outpoints.find((row) => `${row.txid}:${row.vout}` === selectedOutpoint)
    : undefined)
    ?? nativePage?.outpoints.find((row) => `${row.txid}:${row.vout}` === selectedOutpoint)
    ?? ledger?.outpoints.find((row) => `${row.txid}:${row.vout}` === selectedOutpoint);

  useEffect(() => {
    let cancelled = false;
    if (!nativePage || !selectedOutpoint) {
      setPassportPage(undefined);
      setPassportLoading(false);
      return;
    }
    setPassportLoading(true);
    setPassportPage(undefined);
    if (!nativeBacked && ledger) {
      setPassportPage(pageCoinOriginsLedger(ledger, nativePage.checkpointKey, {
        walletName: wallet === ALL_WALLETS ? undefined : wallet,
        outpoint: selectedOutpoint,
        allocationsOffset: allocationsPageIndex * ORIGINS_PAGE_SIZE,
        hopsOffset: hopsPageIndex * ORIGINS_PAGE_SIZE,
        limit: ORIGINS_PAGE_SIZE,
      }));
      setPassportLoading(false);
      return;
    }
    void engineGetCoinOriginsPage({
      walletName: wallet === ALL_WALLETS ? undefined : wallet,
        owners,
      outpoint: selectedOutpoint,
      expectedCheckpointKey: nativePage.checkpointKey,
      allocationsOffset: allocationsPageIndex * ORIGINS_PAGE_SIZE,
      hopsOffset: hopsPageIndex * ORIGINS_PAGE_SIZE,
      limit: ORIGINS_PAGE_SIZE,
    }).then((next) => {
      if (!cancelled && next.checkpointKey === nativePage.checkpointKey) setPassportPage(next);
    }).catch((err) => {
      if (!cancelled) {
        setPassportPage(undefined);
        setError(err instanceof Error ? err.message : "Could not load the selected passport");
      }
    }).finally(() => {
      if (!cancelled) setPassportLoading(false);
    });
    return () => { cancelled = true; };
  }, [nativePage, nativeBacked, ledger, selectedOutpoint, wallet, owners, allocationsPageIndex, hopsPageIndex]);

  const exportLedger = async (kind: "csv" | "pdf", outpoint?: string) => {
    try {
      const exportSource = ledger ?? await engineGetCoinOrigins({
        walletName: wallet === ALL_WALLETS ? undefined : wallet,
          owners,
      });
      const payload = buildCoinOriginsExportPayload(exportSource, {
        walletName: wallet === ALL_WALLETS ? undefined : wallet,
        outpoint,
      });
      const stamp = new Date().toISOString().slice(0, 10);
      if (kind === "csv") {
        downloadBlob(new Blob([buildCoinOriginsCsv(payload)], { type: "text/csv;charset=utf-8" }), `kyutxo-coin-origins-${stamp}.csv`);
      } else {
        downloadBlob(await buildCoinOriginsPdf(payload), `kyutxo-coin-origins-${stamp}.pdf`);
      }
      toast({ title: `${payload.title} exported`, description: `${kind.toUpperCase()} generated locally.` });
    } catch (err) {
      toast({ title: "Export failed", description: err instanceof Error ? err.message : "Could not generate export", variant: "destructive" });
    }
  };

  return (
    <div className="container mx-auto space-y-4 p-4" data-testid="coin-origins-page">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold"><Route className="h-6 w-6" /> Coin Origins</h1>
        <p className="text-sm text-muted-foreground">A deterministic per-outpoint lot ledger. Unresolved prevouts stay visibly unknown.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <Card><CardHeader className="p-3"><CardDescription>Current holdings</CardDescription><CardTitle data-testid="origin-total">{(nativePage?.summary.currentSats ?? ledger?.summary.currentSats ?? 0).toLocaleString()} sats</CardTitle></CardHeader></Card>
        <Card><CardHeader className="p-3"><CardDescription>Acquisition lots</CardDescription><CardTitle data-testid="origin-lots">{(nativePage?.lotsTotal ?? ledger?.lots.length ?? 0).toLocaleString()}</CardTitle></CardHeader></Card>
        <Card><CardHeader className="p-3"><CardDescription>Unknown origin</CardDescription><CardTitle data-testid="origin-unknown">{(nativePage?.summary.unknownSats ?? ledger?.summary.unknownSats ?? 0).toLocaleString()} sats</CardTitle></CardHeader></Card>
        <Card><CardHeader className="p-3"><CardDescription>Exact reconciliation</CardDescription><CardTitle data-testid="origin-reconciled">{(nativePage?.summary.reconciled ?? ledger?.summary.reconciled) ? "Yes" : "No"}</CardTitle></CardHeader></Card>
      </div>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <Label>Wallet scope</Label>
              <Select value={wallet} onValueChange={(value) => {
                setWallet(value);
                setHoldingsPageIndex(0);
                setOutpointsPageIndex(0);
                setAllocationsPageIndex(0);
                setHopsPageIndex(0);
                setSelectedOutpoint("");
              }}>
                <SelectTrigger className="w-52" data-testid="coin-origin-wallet"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_WALLETS}>Entire vault</SelectItem>
                  {walletOptions.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Owner scope</Label>
              <MultiSelectCombobox
                className="w-52"
                values={owners}
                onChange={(values) => {
                setOwners(values);
                setHoldingsPageIndex(0);
                setOutpointsPageIndex(0);
                setAllocationsPageIndex(0);
                setHopsPageIndex(0);
                setSelectedOutpoint("");
                }}
                options={[UNASSIGNED_OWNER_VALUE, ...ownerOptions.filter((value) => value !== UNASSIGNED_OWNER_VALUE)]}
                placeholder="All owners"
                searchPlaceholder="Search owners..."
                optionLabels={{ [UNASSIGNED_OWNER_VALUE]: UNASSIGNED_OWNER_OPTION.label }}
                testId="coin-origin-owner"
              />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => void exportLedger("csv")} disabled={(!ledger && !nativePage) || loading} data-testid="coin-origins-csv"><Download className="mr-1 h-4 w-4" /> Export CSV</Button>
              <Button variant="outline" onClick={() => void exportLedger("pdf")} disabled={(!ledger && !nativePage) || loading} data-testid="coin-origins-pdf"><FileText className="mr-1 h-4 w-4" /> Export PDF</Button>
            </div>
          </div>
        </CardHeader>
      </Card>
      {loading || recordsLoading ? (
        <div className="flex items-center justify-center gap-2 p-12 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /> Building origin ledger…</div>
      ) : error ? (
        <Card><CardContent className="flex items-center gap-2 p-6 text-destructive"><ShieldQuestion className="h-5 w-5" /> {error}</CardContent></Card>
      ) : (
        <>
          <Card>
             <CardHeader><CardTitle>Holdings by Origin</CardTitle><CardDescription>Current balance grouped by acquisition recipe, without double-counting consolidations.</CardDescription></CardHeader>
            <CardContent>
              <Table>
                <TableHeader><TableRow><TableHead>Origin</TableHead><TableHead>Owner</TableHead><TableHead>Acquired</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Outpoints</TableHead><TableHead className="text-right">Current sats</TableHead></TableRow></TableHeader>
                <TableBody>
                  {(nativePage?.holdings ?? ledger?.holdings ?? []).map((row) => (
                    <TableRow key={row.lotId} data-testid={`origin-holding-${row.lotId}`}>
                      <TableCell><div>{row.label}</div><div className="font-mono text-xs text-muted-foreground">{row.acquiredTxid ? short(`${row.acquiredTxid}:${row.acquiredVout}`) : "Unresolved prevout boundary"}</div></TableCell>
                       <TableCell>{row.ownerMixed ? "Mixed" : row.owner || "Unassigned"}</TableCell>
                      <TableCell>{row.acquiredAt ? formatUnixSeconds(row.acquiredAt, "yyyy-MM-dd") : "Unknown"}</TableCell>
                      <TableCell>{boundaryBadge(row.boundary)}</TableCell>
                      <TableCell className="text-right">{row.outpointCount}</TableCell>
                      <TableCell className="text-right font-mono">{row.sats.toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {(nativePage?.holdings ?? ledger?.holdings ?? []).length === 0 && <div className="p-8 text-center text-muted-foreground">No current owned outpoints were found.</div>}
              {nativePage && nativePage.holdingsTotal > ORIGINS_PAGE_SIZE && (
                <div className="mt-4 flex items-center justify-between gap-3 text-sm text-muted-foreground" data-testid="coin-origins-holdings-pagination">
                  <span>{nativePage.holdingsOffset + 1}–{Math.min(nativePage.holdingsOffset + nativePage.holdings.length, nativePage.holdingsTotal)} of {nativePage.holdingsTotal.toLocaleString()} origins</span>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" disabled={holdingsPageIndex === 0 || loading} onClick={() => setHoldingsPageIndex((index) => Math.max(0, index - 1))}>Previous</Button>
                    <Button size="sm" variant="outline" disabled={!nativePage.holdingsHasMore || loading} onClick={() => setHoldingsPageIndex((index) => index + 1)}>Next</Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Current outpoints</CardTitle><CardDescription>Open a Coin Passport for the composition and hop timeline.</CardDescription></CardHeader>
            <CardContent>
              <Table>
                <TableHeader><TableRow><TableHead>Outpoint</TableHead><TableHead>Address</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Satoshis</TableHead><TableHead /></TableRow></TableHeader>
                <TableBody>
                  {(nativePage?.outpoints ?? ledger?.outpoints ?? []).map((row) => (
                    <TableRow key={`${row.txid}:${row.vout}`} data-testid={`origin-outpoint-${row.txid}:${row.vout}`}>
                      <TableCell className="font-mono text-xs">{short(`${row.txid}:${row.vout}`)}</TableCell>
                      <TableCell className="font-mono text-xs">{short(row.address)}</TableCell>
                      <TableCell>{boundaryBadge(row.boundary)}</TableCell>
                      <TableCell className="text-right font-mono">{row.amountSats.toLocaleString()}</TableCell>
                      <TableCell className="text-right"><Button size="sm" variant="outline" onClick={() => {
                        setAllocationsPageIndex(0);
                        setHopsPageIndex(0);
                        setSelectedOutpoint(`${row.txid}:${row.vout}`);
                      }}>Open passport</Button></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {nativePage && (
                <div className="mt-4 flex items-center justify-between gap-3 text-sm text-muted-foreground" data-testid="coin-origins-pagination">
                  <span>
                    Showing {nativePage.outpointsTotal === 0 ? 0 : Math.min(nativePage.outpointsOffset + 1, nativePage.outpointsTotal)}–{Math.min(nativePage.outpointsOffset + nativePage.outpoints.length, nativePage.outpointsTotal)} of {nativePage.outpointsTotal.toLocaleString()} outpoints
                  </span>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={outpointsPageIndex === 0 || loading}
                      onClick={() => { setSelectedOutpoint(""); setOutpointsPageIndex((index) => Math.max(0, index - 1)); }}
                      data-testid="coin-origins-previous"
                    >
                      Previous
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!nativePage.outpointsHasMore || loading}
                      onClick={() => { setSelectedOutpoint(""); setOutpointsPageIndex((index) => index + 1); }}
                      data-testid="coin-origins-next"
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
          {selected && nativePage && passportLoading && (
            <Card><CardContent className="flex items-center gap-2 p-6 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading passport ancestry…</CardContent></Card>
          )}
          {selected && (ledger || passportPage) && (
            <CoinPassport
              output={selected}
              ledger={ledger ?? {
                version: 1,
                outpoints: [selected],
                lots: passportPage?.detail?.lots ?? [],
                disposals: [],
                hops: passportPage?.detail?.hops ?? [],
                holdings: passportPage?.holdings ?? [],
                summary: passportPage?.summary ?? nativePage!.summary,
              }}
              onExport={(kind, outpoint) => void exportLedger(kind, outpoint)}
              page={passportPage}
              onAllocationPageChange={(delta) => setAllocationsPageIndex((index) => Math.max(0, index + delta))}
              onHopPageChange={(delta) => setHopsPageIndex((index) => Math.max(0, index + delta))}
            />
          )}
          {selectedOutpoint && !selected && <Card><CardContent className="p-6 text-muted-foreground">That outpoint is not current in this wallet scope.</CardContent></Card>}
        </>
      )}
    </div>
  );
}
*/
export default function CoinOriginsPage() {
  const { toast } = useToast();
  const { records, isLoading: recordsLoading } = useAddressRecords({ includeBlockchainDiscovered: false });
  const dbSignal = useDbChangeSignal(["records", "blockchainTransactions", "transactionParticipants", "transactionMetadata", "transactionLegMetadata", "owners", "ownerResidencies"]);
  const walletOptions = useMemo(
    () => [...new Set(records.map((r) => r.walletName).filter((v): v is string => !!v))].sort(),
    [records],
  );
  const ownerOptions = useMemo(
    () => [...new Set(records.map((r) => r.owner?.trim()).filter((v): v is string => !!v))].sort(),
    [records],
  );
  const [wallet, setWallet] = useState(ALL_WALLETS);
  const [owners, setOwners] = useState<string[]>([]);
  const [ledger, setLedger] = useState<CoinOriginsLedger>();
  const [costBasis, setCostBasis] = useState<OwnerCostBasisPage>();
  const [costBasisRevision, setCostBasisRevision] = useState(0);
  const [loadRetry, setLoadRetry] = useState(0);
  const [nativePage, setNativePage] = useState<CoinOriginsPage>();
  const [nativeBacked, setNativeBacked] = useState(false);
  const [passportPage, setPassportPage] = useState<CoinOriginsPage>();
  const [holdingsPageIndex, setHoldingsPageIndex] = useState(0);
  const [outpointsPageIndex, setOutpointsPageIndex] = useState(0);
  const [allocationsPageIndex, setAllocationsPageIndex] = useState(0);
  const [hopsPageIndex, setHopsPageIndex] = useState(0);
  const [passportLoading, setPassportLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const initialOutpoint = useMemo(() => new URLSearchParams(window.location.search).get("outpoint") ?? "", []);
  const [selectedOutpoint, setSelectedOutpoint] = useState(initialOutpoint);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setPassportPage(undefined);
    setNativePage(undefined);
    const walletName = wallet === ALL_WALLETS ? undefined : wallet;
    const selectedOwner = owners.length === 1
      ? (owners[0] === UNASSIGNED_OWNER_VALUE ? "" : owners[0])
      : undefined;
    void (async () => {
      // The owner book is calculated from normalized policy/leg rows and never
      // changes the Coin Origins recipe.  It remains local when the engine only
      // mirrors the physical-source tables.
      const ownerSnapshot = await loadOwnerCostBasisSnapshot(selectedOwner);
      const gate = await evaluateEngineFreshness("coinOrigins");
      if (gate.useEngine) {
        const next = await engineGetCoinOriginsPage({
          walletName,
          owners,
          holdingsOffset: holdingsPageIndex * ORIGINS_PAGE_SIZE,
          outpointsOffset: outpointsPageIndex * ORIGINS_PAGE_SIZE,
          limit: ORIGINS_PAGE_SIZE,
        });
        if (!cancelled) {
          setNativePage(next);
          setNativeBacked(true);
          setLedger(undefined);
           setCostBasis(ownerSnapshot.page);
        }
      } else {
        const next = await loadCoinOriginsPage({
          walletName,
          owners,
          holdingsOffset: holdingsPageIndex * ORIGINS_PAGE_SIZE,
          outpointsOffset: outpointsPageIndex * ORIGINS_PAGE_SIZE,
          limit: ORIGINS_PAGE_SIZE,
        });
        if (!cancelled) {
          setLedger(next.ledger);
          setNativePage(next.page);
          setNativeBacked(false);
           setCostBasis(ownerSnapshot.page);
        }
      }
    })().catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : "Could not build the origin ledger");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [wallet, owners, holdingsPageIndex, outpointsPageIndex, dbSignal, costBasisRevision, loadRetry]);

  const selected = (passportPage && passportPage.checkpointKey === nativePage?.checkpointKey
    ? passportPage.outpoints.find((row) => `${row.txid}:${row.vout}` === selectedOutpoint)
    : undefined)
    ?? nativePage?.outpoints.find((row) => `${row.txid}:${row.vout}` === selectedOutpoint)
    ?? ledger?.outpoints.find((row) => `${row.txid}:${row.vout}` === selectedOutpoint);

  useEffect(() => {
    let cancelled = false;
    if (!nativePage || !selectedOutpoint) {
      setPassportPage(undefined);
      setPassportLoading(false);
      return;
    }
    setPassportLoading(true);
    setPassportPage(undefined);
    if (!nativeBacked && ledger) {
      void loadCoinOriginsPage({
        walletName: wallet === ALL_WALLETS ? undefined : wallet,
        owners,
        outpoint: selectedOutpoint,
        expectedCheckpointKey: nativePage.checkpointKey,
        allocationsOffset: allocationsPageIndex * ORIGINS_PAGE_SIZE,
        hopsOffset: hopsPageIndex * ORIGINS_PAGE_SIZE,
        limit: ORIGINS_PAGE_SIZE,
      }).then(next => {
        if (cancelled) return;
        setLedger(next.ledger);
        setPassportPage(next.page);
      }).catch(err => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Coin Origins changed; reloading.");
          setCostBasisRevision(value => value + 1);
        }
      }).finally(() => { if (!cancelled) setPassportLoading(false); });
      return () => { cancelled = true; };
    }
    void engineGetCoinOriginsPage({
      walletName: wallet === ALL_WALLETS ? undefined : wallet,
        owners,
      outpoint: selectedOutpoint,
      expectedCheckpointKey: nativePage.checkpointKey,
      allocationsOffset: allocationsPageIndex * ORIGINS_PAGE_SIZE,
      hopsOffset: hopsPageIndex * ORIGINS_PAGE_SIZE,
      limit: ORIGINS_PAGE_SIZE,
    }).then((next) => {
      if (!cancelled && next.checkpointKey === nativePage.checkpointKey) setPassportPage(next);
    }).catch((err) => {
      if (!cancelled) {
        setPassportPage(undefined);
        setError(err instanceof Error ? err.message : "Could not load the selected passport");
      }
    }).finally(() => {
      if (!cancelled) setPassportLoading(false);
    });
    return () => { cancelled = true; };
  }, [nativePage, nativeBacked, ledger, selectedOutpoint, wallet, owners, allocationsPageIndex, hopsPageIndex]);

  const exportLedger = async (kind: "csv" | "pdf", outpoint?: string) => {
    try {
      const scope = {
        walletName: wallet === ALL_WALLETS ? undefined : wallet,
        owners,
      };
      // Re-open the source with the visible checkpoint immediately before a
      // download. Both native and fallback paths reject a changed snapshot.
      const exportSource = ledger
        ? (await loadCoinOriginsPage({ ...scope, expectedCheckpointKey: nativePage?.checkpointKey })).ledger
        : await engineGetCoinOrigins({ ...scope, expectedCheckpointKey: nativePage?.checkpointKey });
      const payload = buildCoinOriginsExportPayload(exportSource, {
        walletName: scope.walletName,
        outpoint,
      });
      const stamp = new Date().toISOString().slice(0, 10);
      if (kind === "csv") {
        downloadBlob(new Blob([buildCoinOriginsCsv(payload)], { type: "text/csv;charset=utf-8" }), `kyutxo-coin-origins-${stamp}.csv`);
      } else {
        downloadBlob(await buildCoinOriginsPdf(payload), `kyutxo-coin-origins-${stamp}.pdf`);
      }
      toast({ title: `${payload.title} exported`, description: `${kind.toUpperCase()} generated locally.` });
    } catch (err) {
      toast({ title: "Export failed", description: err instanceof Error ? err.message : "Could not generate export", variant: "destructive" });
    }
  };
  const exportOwnerBook = async () => {
    if (!costBasis) return;
    try {
      const selectedOwner = owners.length === 1
        ? (owners[0] === UNASSIGNED_OWNER_VALUE ? "" : owners[0])
        : undefined;
      await assertOwnerCostBasisCheckpoint(costBasis.checkpointKey, selectedOwner);
      const stamp = new Date().toISOString().slice(0, 10);
      downloadBlob(new Blob([buildOwnerCostBasisPageCsv(costBasis)], { type: 'text/csv;charset=utf-8' }), `kyutxo-owner-cost-basis-${stamp}.csv`);
      toast({ title: 'Owner cost-basis report exported', description: 'CSV generated locally.' });
    } catch (err) {
      toast({ title: 'Report changed', description: err instanceof Error ? err.message : 'Reload before exporting.', variant: 'destructive' });
      setCostBasisRevision(value => value + 1);
    }
  };

  return (
    <div className="container mx-auto space-y-4 p-4" data-testid="coin-origins-page" data-navigation-ready={!loading && !recordsLoading && !error ? "true" : "false"}>
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold"><Route className="h-6 w-6" /> Coin Origins</h1>
        <p className="text-sm text-muted-foreground">A deterministic per-outpoint lot ledger. Unresolved prevouts stay visibly unknown.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <Card><CardHeader className="p-3"><CardDescription>Current holdings</CardDescription><CardTitle data-testid="origin-total">{(nativePage?.summary.currentSats ?? ledger?.summary.currentSats ?? 0).toLocaleString()} sats</CardTitle></CardHeader></Card>
        <Card><CardHeader className="p-3"><CardDescription>Acquisition lots</CardDescription><CardTitle data-testid="origin-lots">{(nativePage?.lotsTotal ?? ledger?.lots.length ?? 0).toLocaleString()}</CardTitle></CardHeader></Card>
        <Card><CardHeader className="p-3"><CardDescription>Unknown origin</CardDescription><CardTitle data-testid="origin-unknown">{(nativePage?.summary.unknownSats ?? ledger?.summary.unknownSats ?? 0).toLocaleString()} sats</CardTitle></CardHeader></Card>
        <Card><CardHeader className="p-3"><CardDescription>Exact reconciliation</CardDescription><CardTitle data-testid="origin-reconciled">{(nativePage?.summary.reconciled ?? ledger?.summary.reconciled) ? "Yes" : "No"}</CardTitle></CardHeader></Card>
      </div>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <Label>Wallet scope</Label>
              <Select value={wallet} onValueChange={(value) => {
                setWallet(value);
                setHoldingsPageIndex(0);
                setOutpointsPageIndex(0);
                setAllocationsPageIndex(0);
                setHopsPageIndex(0);
                setSelectedOutpoint("");
              }}>
                <SelectTrigger className="w-52" data-testid="coin-origin-wallet"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_WALLETS}>Entire vault</SelectItem>
                  {walletOptions.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Owner scope</Label>
              <MultiSelectCombobox
                className="w-52"
                values={owners}
                onChange={(values) => {
                  setOwners(values);
                  setHoldingsPageIndex(0);
                  setOutpointsPageIndex(0);
                  setAllocationsPageIndex(0);
                  setHopsPageIndex(0);
                  setSelectedOutpoint("");
                }}
                options={[UNASSIGNED_OWNER_VALUE, ...ownerOptions.filter((value) => value !== UNASSIGNED_OWNER_VALUE)]}
                placeholder="All owners"
                searchPlaceholder="Search owners..."
                optionLabels={{ [UNASSIGNED_OWNER_VALUE]: UNASSIGNED_OWNER_OPTION.label }}
                testId="coin-origin-owner"
              />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => void exportLedger("csv")} disabled={(!ledger && !nativePage) || loading} data-testid="coin-origins-csv"><Download className="mr-1 h-4 w-4" /> Export CSV</Button>
              <Button variant="outline" onClick={() => void exportLedger("pdf")} disabled={(!ledger && !nativePage) || loading} data-testid="coin-origins-pdf"><FileText className="mr-1 h-4 w-4" /> Export PDF</Button>
              <Button variant="outline" onClick={() => void exportOwnerBook()} disabled={!costBasis || loading} data-testid="owner-cost-basis-csv"><Download className="mr-1 h-4 w-4" /> Cost basis CSV</Button>
            </div>
          </div>
        </CardHeader>
      </Card>
      {loading || recordsLoading ? (
        <div className="flex items-center justify-center gap-2 p-12 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /> Building origin ledger…</div>
      ) : error ? (
        <Card className="border-destructive/50" data-testid="coin-origins-load-error"><CardContent className="flex flex-wrap items-center justify-between gap-3 p-6">
          <div className="flex items-start gap-2"><ShieldQuestion className="mt-0.5 h-5 w-5 text-destructive" /><div><p className="font-medium text-destructive">Could not load Coin Origins</p><p className="text-sm text-muted-foreground">{error}</p></div></div>
          <Button variant="outline" onClick={() => setLoadRetry(value => value + 1)} data-testid="button-coin-origins-retry">Retry</Button>
        </CardContent></Card>
      ) : (
        <>
          <Card>
             <CardHeader><CardTitle>Holdings by Origin</CardTitle><CardDescription>Current balance grouped by acquisition recipe, without double-counting consolidations.</CardDescription></CardHeader>
            <CardContent>
              <Table>
                <TableHeader><TableRow><TableHead>Origin</TableHead><TableHead>Owner</TableHead><TableHead>Acquired</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Outpoints</TableHead><TableHead className="text-right">Current sats</TableHead></TableRow></TableHeader>
                <TableBody>
                  {(nativePage?.holdings ?? ledger?.holdings ?? []).map((row) => (
                    <TableRow key={row.lotId} data-testid={`origin-holding-${row.lotId}`}>
                      <TableCell><div>{row.label}</div><div className="font-mono text-xs text-muted-foreground">{row.acquiredTxid ? short(`${row.acquiredTxid}:${row.acquiredVout}`) : "Unresolved prevout boundary"}</div></TableCell>
                       <TableCell>{row.ownerMixed ? "Mixed" : row.owner || "Unassigned"}</TableCell>
                      <TableCell>{row.acquiredAt ? formatUnixSeconds(row.acquiredAt, "yyyy-MM-dd") : "Unknown"}</TableCell>
                      <TableCell>{boundaryBadge(row.boundary)}</TableCell>
                      <TableCell className="text-right">{row.outpointCount}</TableCell>
                      <TableCell className="text-right font-mono">{row.sats.toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {(nativePage?.holdings ?? ledger?.holdings ?? []).length === 0 && <div className="p-8 text-center text-muted-foreground">No current owned outpoints were found.</div>}
              {nativePage && nativePage.holdingsTotal > ORIGINS_PAGE_SIZE && (
                <div className="mt-4 flex items-center justify-between gap-3 text-sm text-muted-foreground" data-testid="coin-origins-holdings-pagination">
                  <span>{nativePage.holdingsOffset + 1}–{Math.min(nativePage.holdingsOffset + nativePage.holdings.length, nativePage.holdingsTotal)} of {nativePage.holdingsTotal.toLocaleString()} origins</span>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" disabled={holdingsPageIndex === 0 || loading} onClick={() => setHoldingsPageIndex((index) => Math.max(0, index - 1))}>Previous</Button>
                    <Button size="sm" variant="outline" disabled={!nativePage.holdingsHasMore || loading} onClick={() => setHoldingsPageIndex((index) => index + 1)}>Next</Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
          <Card data-testid="owner-cost-basis-report">
            <CardHeader>
              <CardTitle>Owner Cost-Basis Report</CardTitle>
              <CardDescription>Tax-lot book, separate from the physical coin-origin recipe. It is calculated from a local atomic source checkpoint and does not claim parity with a native-only origins mirror. All owners are shown unless an owner scope is selected.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {costBasis?.warnings.map((warning, index) => (
                <div key={`${warning.code}-${warning.owner}-${warning.date}-${index}`} className="rounded border border-amber-500/40 p-2 text-sm text-amber-700 dark:text-amber-300" data-testid="owner-cost-basis-warning">{warning.message}</div>
              ))}
              <Table>
                <TableHeader><TableRow><TableHead>Owner</TableHead><TableHead className="text-right">Disposed</TableHead><TableHead className="text-right">Fees</TableHead><TableHead className="text-right">Open sats</TableHead><TableHead className="text-right">Cost / proceeds provenance</TableHead></TableRow></TableHeader>
                <TableBody>
                  {(costBasis?.byOwner ?? []).map(row => (
                    <TableRow key={row.owner} data-testid={`owner-cost-basis-${row.owner}`}>
                      <TableCell>{row.owner === "__unassigned__" ? "Unassigned" : row.owner}</TableCell>
                      <TableCell className="text-right font-mono">{row.disposedSats.toLocaleString()}</TableCell>
                      <TableCell className="text-right font-mono">{row.feeSats.toLocaleString()}</TableCell>
                      <TableCell className="text-right font-mono">{row.openSats.toLocaleString()}</TableCell>
                      <TableCell className="text-right text-xs">{row.costUsd === undefined ? "cost unknown" : `cost $${row.costUsd.toFixed(2)}`} · {row.proceedsUsd === undefined ? "proceeds unknown" : `proceeds $${row.proceedsUsd.toFixed(2)}`}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {(costBasis?.assumptions.length ?? 0) > 0 && <div className="text-xs text-muted-foreground" data-testid="owner-cost-basis-assumptions">Policy assumptions: {costBasis!.assumptions.map(a => `${a.owner}: ${a.residency ? `${a.residency.jurisdiction} (${a.matchingMethod})` : `FIFO fallback (${a.matchingMethod})`}`).join("; ")} · policy revision {costBasis!.policyRevision || "none"}</div>}
              {costBasis && <div className="text-xs text-muted-foreground font-mono" data-testid="owner-cost-basis-checkpoint">Source checkpoint: {costBasis.checkpointKey}</div>}
            </CardContent>
          </Card>
           <CostBasisEditor
             rows={costBasis?.editorRows ?? []}
              expectedCheckpointKey={costBasis?.checkpointKey}
              selectedOwner={owners.length === 1
                ? (owners[0] === UNASSIGNED_OWNER_VALUE ? "" : owners[0])
                : undefined}
             onSaved={() => {
               setCostBasisRevision(revision => revision + 1);
               toast({ title: "Cost-basis metadata saved", description: "The owner cost-basis report has been refreshed." });
             }}
           />
          <Card>
            <CardHeader><CardTitle>Current outpoints</CardTitle><CardDescription>Open a Coin Passport for the composition and hop timeline.</CardDescription></CardHeader>
            <CardContent>
              <Table>
                <TableHeader><TableRow><TableHead>Outpoint</TableHead><TableHead>Address</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Satoshis</TableHead><TableHead /></TableRow></TableHeader>
                <TableBody>
                  {(nativePage?.outpoints ?? ledger?.outpoints ?? []).map((row) => (
                    <TableRow key={`${row.txid}:${row.vout}`} data-testid={`origin-outpoint-${row.txid}:${row.vout}`}>
                      <TableCell className="font-mono text-xs">{short(`${row.txid}:${row.vout}`)}</TableCell>
                      <TableCell className="font-mono text-xs">{short(row.address)}</TableCell>
                      <TableCell>{boundaryBadge(row.boundary)}</TableCell>
                      <TableCell className="text-right font-mono">{row.amountSats.toLocaleString()}</TableCell>
                      <TableCell className="text-right"><Button size="sm" variant="outline" onClick={() => {
                        setAllocationsPageIndex(0);
                        setHopsPageIndex(0);
                        setSelectedOutpoint(`${row.txid}:${row.vout}`);
                      }}>Open passport</Button></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {nativePage && (
                <div className="mt-4 flex items-center justify-between gap-3 text-sm text-muted-foreground" data-testid="coin-origins-pagination">
                  <span>
                    Showing {nativePage.outpointsTotal === 0 ? 0 : Math.min(nativePage.outpointsOffset + 1, nativePage.outpointsTotal)}–{Math.min(nativePage.outpointsOffset + nativePage.outpoints.length, nativePage.outpointsTotal)} of {nativePage.outpointsTotal.toLocaleString()} outpoints
                  </span>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={outpointsPageIndex === 0 || loading}
                      onClick={() => { setSelectedOutpoint(""); setOutpointsPageIndex((index) => Math.max(0, index - 1)); }}
                      data-testid="coin-origins-previous"
                    >
                      Previous
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!nativePage.outpointsHasMore || loading}
                      onClick={() => { setSelectedOutpoint(""); setOutpointsPageIndex((index) => index + 1); }}
                      data-testid="coin-origins-next"
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
          {selected && nativePage && passportLoading && (
            <Card><CardContent className="flex items-center gap-2 p-6 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading passport ancestry…</CardContent></Card>
          )}
          {selected && (ledger || passportPage) && (
            <CoinPassport
              output={selected}
              ledger={ledger ?? {
                version: 1,
                outpoints: [selected],
                lots: passportPage?.detail?.lots ?? [],
                disposals: [],
                hops: passportPage?.detail?.hops ?? [],
                holdings: passportPage?.holdings ?? [],
                summary: passportPage?.summary ?? nativePage!.summary,
              }}
              onExport={(kind, outpoint) => void exportLedger(kind, outpoint)}
              page={passportPage}
              onAllocationPageChange={(delta) => setAllocationsPageIndex((index) => Math.max(0, index + delta))}
              onHopPageChange={(delta) => setHopsPageIndex((index) => Math.max(0, index + delta))}
            />
          )}
          {selectedOutpoint && !selected && <Card><CardContent className="p-6 text-muted-foreground">That outpoint is not current in this wallet scope.</CardContent></Card>}
        </>
      )}
    </div>
  );
}
/*
export default function CoinOriginsPage() {
  const { toast } = useToast();
  const { records, isLoading: recordsLoading } = useAddressRecords({ includeBlockchainDiscovered: false });
  const dbSignal = useDbChangeSignal(["records", "blockchainTransactions", "transactionParticipants"]);
  const walletOptions = useMemo(
    () => [...new Set(records.map((r) => r.walletName).filter((v): v is string => !!v))].sort(),
    [records],
  );
  const ownerOptions = useMemo(
    () => [...new Set(records.map((r) => r.owner).filter((v): v is string => !!v?.trim()))].sort(),
    [records],
  );
  const [wallet, setWallet] = useState(ALL_WALLETS);
  const [owners, setOwners] = useState<string[]>([]);
  const [ledger, setLedger] = useState<CoinOriginsLedger>();
  const [nativePage, setNativePage] = useState<CoinOriginsPage>();
  const [passportPage, setPassportPage] = useState<CoinOriginsPage>();
  const [holdingsPageIndex, setHoldingsPageIndex] = useState(0);
  const [outpointsPageIndex, setOutpointsPageIndex] = useState(0);
  const [allocationsPageIndex, setAllocationsPageIndex] = useState(0);
  const [hopsPageIndex, setHopsPageIndex] = useState(0);
  const [passportLoading, setPassportLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const initialOutpoint = useMemo(() => new URLSearchParams(window.location.search).get("outpoint") ?? "", []);
  const [selectedOutpoint, setSelectedOutpoint] = useState(initialOutpoint);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setPassportPage(undefined);
    setNativePage(undefined);
    const walletName = wallet === ALL_WALLETS ? undefined : wallet;
    void (async () => {
      const gate = await evaluateEngineFreshness("allMirrors");
      if (gate.useEngine) {
        const next = await engineGetCoinOriginsPage({
          walletName,
          owners: owners.length ? owners : undefined,
          holdingsOffset: holdingsPageIndex * ORIGINS_PAGE_SIZE,
          outpointsOffset: outpointsPageIndex * ORIGINS_PAGE_SIZE,
          limit: ORIGINS_PAGE_SIZE,
        });
        if (!cancelled) {
          setNativePage(next);
          setLedger(undefined);
        }
      } else {
        const next = await loadCoinOrigins(walletName, owners.length ? owners : undefined);
        if (!cancelled) {
          setLedger(next);
          setNativePage(undefined);
        }
      }
    })().catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : "Could not build the origin ledger");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [wallet, owners, holdingsPageIndex, outpointsPageIndex, dbSignal]);

  const selected = (passportPage && passportPage.checkpointKey === nativePage?.checkpointKey
    ? passportPage.outpoints.find((row) => `${row.txid}:${row.vout}` === selectedOutpoint)
    : undefined)
    ?? nativePage?.outpoints.find((row) => `${row.txid}:${row.vout}` === selectedOutpoint)
    ?? ledger?.outpoints.find((row) => `${row.txid}:${row.vout}` === selectedOutpoint);

  useEffect(() => {
    let cancelled = false;
    if (!nativePage || !selectedOutpoint) {
      setPassportPage(undefined);
      setPassportLoading(false);
      return;
    }
    setPassportLoading(true);
    setPassportPage(undefined);
    void engineGetCoinOriginsPage({
      walletName: wallet === ALL_WALLETS ? undefined : wallet,
      owners: owners.length ? owners : undefined,
      outpoint: selectedOutpoint,
      expectedCheckpointKey: nativePage.checkpointKey,
      allocationsOffset: allocationsPageIndex * ORIGINS_PAGE_SIZE,
      hopsOffset: hopsPageIndex * ORIGINS_PAGE_SIZE,
      limit: ORIGINS_PAGE_SIZE,
    }).then((next) => {
      if (!cancelled && next.checkpointKey === nativePage.checkpointKey) setPassportPage(next);
    }).catch((err) => {
      if (!cancelled) {
        setPassportPage(undefined);
        setError(err instanceof Error ? err.message : "Could not load the selected passport");
      }
    }).finally(() => {
      if (!cancelled) setPassportLoading(false);
    });
    return () => { cancelled = true; };
  }, [nativePage, selectedOutpoint, wallet, owners, allocationsPageIndex, hopsPageIndex]);

  const exportLedger = async (kind: "csv" | "pdf", outpoint?: string) => {
    try {
      const exportSource = ledger ?? await engineGetCoinOrigins({
        walletName: wallet === ALL_WALLETS ? undefined : wallet,
          owners: owners.length ? owners : undefined,
      });
      const payload = buildCoinOriginsExportPayload(exportSource, {
        walletName: wallet === ALL_WALLETS ? undefined : wallet,
        outpoint,
      });
      const stamp = new Date().toISOString().slice(0, 10);
      if (kind === "csv") {
        downloadBlob(new Blob([buildCoinOriginsCsv(payload)], { type: "text/csv;charset=utf-8" }), `kyutxo-coin-origins-${stamp}.csv`);
      } else {
        downloadBlob(await buildCoinOriginsPdf(payload), `kyutxo-coin-origins-${stamp}.pdf`);
      }
      toast({ title: `${payload.title} exported`, description: `${kind.toUpperCase()} generated locally.` });
    } catch (err) {
      toast({ title: "Export failed", description: err instanceof Error ? err.message : "Could not generate export", variant: "destructive" });
    }
  };

  return (
    <div className="container mx-auto space-y-4 p-4" data-testid="coin-origins-page">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold"><Route className="h-6 w-6" /> Coin Origins</h1>
        <p className="text-sm text-muted-foreground">A deterministic per-outpoint lot ledger. Unresolved prevouts stay visibly unknown.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <Card><CardHeader className="p-3"><CardDescription>Current holdings</CardDescription><CardTitle data-testid="origin-total">{(nativePage?.summary.currentSats ?? ledger?.summary.currentSats ?? 0).toLocaleString()} sats</CardTitle></CardHeader></Card>
        <Card><CardHeader className="p-3"><CardDescription>Acquisition lots</CardDescription><CardTitle data-testid="origin-lots">{(nativePage?.lotsTotal ?? ledger?.lots.length ?? 0).toLocaleString()}</CardTitle></CardHeader></Card>
        <Card><CardHeader className="p-3"><CardDescription>Unknown origin</CardDescription><CardTitle data-testid="origin-unknown">{(nativePage?.summary.unknownSats ?? ledger?.summary.unknownSats ?? 0).toLocaleString()} sats</CardTitle></CardHeader></Card>
        <Card><CardHeader className="p-3"><CardDescription>Exact reconciliation</CardDescription><CardTitle data-testid="origin-reconciled">{(nativePage?.summary.reconciled ?? ledger?.summary.reconciled) ? "Yes" : "No"}</CardTitle></CardHeader></Card>
      </div>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <Label>Wallet scope</Label>
              <Select value={wallet} onValueChange={(value) => {
                setWallet(value);
                setHoldingsPageIndex(0);
                setOutpointsPageIndex(0);
                setAllocationsPageIndex(0);
                setHopsPageIndex(0);
                setSelectedOutpoint("");
              }}>
                <SelectTrigger className="w-52" data-testid="coin-origin-wallet"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_WALLETS}>Entire vault</SelectItem>
                  {walletOptions.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Owner scope</Label>
              <MultiSelectCombobox
                className="w-52"
                values={owners}
                onChange={(values) => {
                  setOwners(values);
                  setHoldingsPageIndex(0);
                  setOutpointsPageIndex(0);
                  setSelectedOutpoint("");
                }}
                options={[UNASSIGNED_OWNER_VALUE, ...ownerOptions.filter(value => value !== UNASSIGNED_OWNER_VALUE)]}
                placeholder="All owners"
                searchPlaceholder="Search owners..."
                optionLabels={{ [UNASSIGNED_OWNER_VALUE]: UNASSIGNED_OWNER_OPTION.label }}
                testId="coin-origin-owner"
              />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => void exportLedger("csv")} disabled={(!ledger && !nativePage) || loading} data-testid="coin-origins-csv"><Download className="mr-1 h-4 w-4" /> Export CSV</Button>
              <Button variant="outline" onClick={() => void exportLedger("pdf")} disabled={(!ledger && !nativePage) || loading} data-testid="coin-origins-pdf"><FileText className="mr-1 h-4 w-4" /> Export PDF</Button>
            </div>
          </div>
        </CardHeader>
      </Card>
      {loading || recordsLoading ? (
        <div className="flex items-center justify-center gap-2 p-12 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /> Building origin ledger…</div>
      ) : error ? (
        <Card><CardContent className="flex items-center gap-2 p-6 text-destructive"><ShieldQuestion className="h-5 w-5" /> {error}</CardContent></Card>
      ) : (
        <>
          <Card>
            <CardHeader><CardTitle>Holdings by Origin</CardTitle><CardDescription>Current balance grouped by acquisition lot, without double-counting consolidations.</CardDescription></CardHeader>
            <CardContent>
              <Table>
                <TableHeader><TableRow><TableHead>Origin</TableHead><TableHead>Acquired</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Outpoints</TableHead><TableHead className="text-right">Current sats</TableHead></TableRow></TableHeader>
                <TableBody>
                  {(nativePage?.holdings ?? ledger?.holdings ?? []).map((row) => (
                    <TableRow key={row.lotId} data-testid={`origin-holding-${row.lotId}`}>
                      <TableCell><div>{row.label}</div><div className="font-mono text-xs text-muted-foreground">{row.acquiredTxid ? short(`${row.acquiredTxid}:${row.acquiredVout}`) : "Unresolved prevout boundary"}</div></TableCell>
                      <TableCell>{row.acquiredAt ? formatUnixSeconds(row.acquiredAt, "yyyy-MM-dd") : "Unknown"}</TableCell>
                      <TableCell>{boundaryBadge(row.boundary)}</TableCell>
                      <TableCell className="text-right">{row.outpointCount}</TableCell>
                      <TableCell className="text-right font-mono">{row.sats.toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {(nativePage?.holdings ?? ledger?.holdings ?? []).length === 0 && <div className="p-8 text-center text-muted-foreground">No current owned outpoints were found.</div>}
              {nativePage && nativePage.holdingsTotal > ORIGINS_PAGE_SIZE && (
                <div className="mt-4 flex items-center justify-between gap-3 text-sm text-muted-foreground" data-testid="coin-origins-holdings-pagination">
                  <span>{nativePage.holdingsOffset + 1}–{Math.min(nativePage.holdingsOffset + nativePage.holdings.length, nativePage.holdingsTotal)} of {nativePage.holdingsTotal.toLocaleString()} origins</span>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" disabled={holdingsPageIndex === 0 || loading} onClick={() => setHoldingsPageIndex((index) => Math.max(0, index - 1))}>Previous</Button>
                    <Button size="sm" variant="outline" disabled={!nativePage.holdingsHasMore || loading} onClick={() => setHoldingsPageIndex((index) => index + 1)}>Next</Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Current outpoints</CardTitle><CardDescription>Open a Coin Passport for the composition and hop timeline.</CardDescription></CardHeader>
            <CardContent>
              <Table>
                <TableHeader><TableRow><TableHead>Outpoint</TableHead><TableHead>Address</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Satoshis</TableHead><TableHead /></TableRow></TableHeader>
                <TableBody>
                  {(nativePage?.outpoints ?? ledger?.outpoints ?? []).map((row) => (
                    <TableRow key={`${row.txid}:${row.vout}`} data-testid={`origin-outpoint-${row.txid}:${row.vout}`}>
                      <TableCell className="font-mono text-xs">{short(`${row.txid}:${row.vout}`)}</TableCell>
                      <TableCell className="font-mono text-xs">{short(row.address)}</TableCell>
                      <TableCell>{boundaryBadge(row.boundary)}</TableCell>
                      <TableCell className="text-right font-mono">{row.amountSats.toLocaleString()}</TableCell>
                      <TableCell className="text-right"><Button size="sm" variant="outline" onClick={() => {
                        setAllocationsPageIndex(0);
                        setHopsPageIndex(0);
                        setSelectedOutpoint(`${row.txid}:${row.vout}`);
                      }}>Open passport</Button></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {nativePage && (
                <div className="mt-4 flex items-center justify-between gap-3 text-sm text-muted-foreground" data-testid="coin-origins-pagination">
                  <span>
                    Showing {nativePage.outpointsTotal === 0 ? 0 : Math.min(nativePage.outpointsOffset + 1, nativePage.outpointsTotal)}–{Math.min(nativePage.outpointsOffset + nativePage.outpoints.length, nativePage.outpointsTotal)} of {nativePage.outpointsTotal.toLocaleString()} outpoints
                  </span>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={outpointsPageIndex === 0 || loading}
                      onClick={() => { setSelectedOutpoint(""); setOutpointsPageIndex((index) => Math.max(0, index - 1)); }}
                      data-testid="coin-origins-previous"
                    >
                      Previous
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!nativePage.outpointsHasMore || loading}
                      onClick={() => { setSelectedOutpoint(""); setOutpointsPageIndex((index) => index + 1); }}
                      data-testid="coin-origins-next"
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
          {selected && nativePage && passportLoading && (
            <Card><CardContent className="flex items-center gap-2 p-6 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading passport ancestry…</CardContent></Card>
          )}
          {selected && (ledger || passportPage) && (
            <CoinPassport
              output={selected}
              ledger={ledger ?? {
                version: 1,
                outpoints: [selected],
                lots: passportPage?.detail?.lots ?? [],
                disposals: [],
                hops: passportPage?.detail?.hops ?? [],
                holdings: passportPage?.holdings ?? [],
                summary: passportPage?.summary ?? nativePage!.summary,
              }}
              onExport={(kind, outpoint) => void exportLedger(kind, outpoint)}
              page={passportPage}
              onAllocationPageChange={(delta) => setAllocationsPageIndex((index) => Math.max(0, index + delta))}
              onHopPageChange={(delta) => setHopsPageIndex((index) => Math.max(0, index + delta))}
            />
          )}
          {selectedOutpoint && !selected && <Card><CardContent className="p-6 text-muted-foreground">That outpoint is not current in this wallet scope.</CardContent></Card>}
        </>
      )}
    </div>
  );
}
*/

const metadataInput = <T extends { id?: number; createdAt?: number; updatedAt?: number }>(row: T) => {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = row;
  return input;
};

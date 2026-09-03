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
import { engineGetCoinOrigins } from "@/lib/engine/engine-client";
import { loadCoinOrigins, type CoinOriginOutpoint, type CoinOriginsLedger } from "@/lib/coin-origins";
import {
  buildCoinOriginsCsv,
  buildCoinOriginsExportPayload,
  buildCoinOriginsPdf,
} from "@/lib/coin-origins-export";
import { downloadBlob } from "@/lib/backup/sink";
import { formatUnixSeconds } from "@/lib/unix-seconds";

const ALL_WALLETS = "__all_wallets__";

function short(value: string): string {
  return value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
}

function boundaryBadge(boundary: string) {
  if (boundary === "mixed") return <Badge variant="outline" className="text-amber-600">Mixed boundary</Badge>;
  if (boundary === "unknown") return <Badge variant="secondary">Unknown origin</Badge>;
  return <Badge variant="outline" className="text-emerald-600">Reconciled</Badge>;
}

function CoinPassport({
  output,
  ledger,
  onExport,
}: {
  output: CoinOriginOutpoint;
  ledger: CoinOriginsLedger;
  onExport: (kind: "csv" | "pdf", outpoint: string) => void;
}) {
  const hopByTxid = new Map(ledger.hops.map((hop) => [hop.txid, hop]));
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
        <div>
          <h3 className="mb-2 font-semibold">Origin breakdown</h3>
          <Table>
            <TableHeader><TableRow><TableHead>Origin</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Satoshis</TableHead></TableRow></TableHeader>
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
        </div>
      </CardContent>
    </Card>
  );
}

export default function CoinOriginsPage() {
  const { toast } = useToast();
  const { records, isLoading: recordsLoading } = useAddressRecords({ includeBlockchainDiscovered: false });
  const dbSignal = useDbChangeSignal(["records", "blockchainTransactions", "transactionParticipants"]);
  const walletOptions = useMemo(
    () => [...new Set(records.map((r) => r.walletName).filter((v): v is string => !!v))].sort(),
    [records],
  );
  const [wallet, setWallet] = useState(ALL_WALLETS);
  const [ledger, setLedger] = useState<CoinOriginsLedger>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const initialOutpoint = useMemo(() => new URLSearchParams(window.location.search).get("outpoint") ?? "", []);
  const [selectedOutpoint, setSelectedOutpoint] = useState(initialOutpoint);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    const walletName = wallet === ALL_WALLETS ? undefined : wallet;
    void (async () => {
      const gate = await evaluateEngineFreshness("allMirrors");
      const next = gate.useEngine
        ? await engineGetCoinOrigins({ walletName })
        : await loadCoinOrigins(walletName);
      if (!cancelled) setLedger(next);
    })().catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : "Could not build the origin ledger");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [wallet, dbSignal]);

  const selected = ledger?.outpoints.find((row) => `${row.txid}:${row.vout}` === selectedOutpoint);

  const exportLedger = async (kind: "csv" | "pdf", outpoint?: string) => {
    if (!ledger) return;
    try {
      const payload = buildCoinOriginsExportPayload(ledger, {
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
        <Card><CardHeader className="p-3"><CardDescription>Current holdings</CardDescription><CardTitle data-testid="origin-total">{(ledger?.summary.currentSats ?? 0).toLocaleString()} sats</CardTitle></CardHeader></Card>
        <Card><CardHeader className="p-3"><CardDescription>Acquisition lots</CardDescription><CardTitle>{ledger?.lots.length.toLocaleString() ?? "0"}</CardTitle></CardHeader></Card>
        <Card><CardHeader className="p-3"><CardDescription>Unknown origin</CardDescription><CardTitle>{(ledger?.summary.unknownSats ?? 0).toLocaleString()} sats</CardTitle></CardHeader></Card>
        <Card><CardHeader className="p-3"><CardDescription>Exact reconciliation</CardDescription><CardTitle>{ledger?.summary.reconciled ? "Yes" : "No"}</CardTitle></CardHeader></Card>
      </div>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <Label>Wallet scope</Label>
              <Select value={wallet} onValueChange={(value) => { setWallet(value); setSelectedOutpoint(""); }}>
                <SelectTrigger className="w-52" data-testid="coin-origin-wallet"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_WALLETS}>Entire vault</SelectItem>
                  {walletOptions.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => void exportLedger("csv")} disabled={!ledger || loading}><Download className="mr-1 h-4 w-4" /> Export CSV</Button>
              <Button variant="outline" onClick={() => void exportLedger("pdf")} disabled={!ledger || loading}><FileText className="mr-1 h-4 w-4" /> Export PDF</Button>
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
                  {(ledger?.holdings ?? []).map((row) => (
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
              {ledger?.holdings.length === 0 && <div className="p-8 text-center text-muted-foreground">No current owned outpoints were found.</div>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Current outpoints</CardTitle><CardDescription>Open a Coin Passport for the composition and hop timeline.</CardDescription></CardHeader>
            <CardContent>
              <Table>
                <TableHeader><TableRow><TableHead>Outpoint</TableHead><TableHead>Address</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Satoshis</TableHead><TableHead /></TableRow></TableHeader>
                <TableBody>
                  {(ledger?.outpoints ?? []).map((row) => (
                    <TableRow key={`${row.txid}:${row.vout}`}>
                      <TableCell className="font-mono text-xs">{short(`${row.txid}:${row.vout}`)}</TableCell>
                      <TableCell className="font-mono text-xs">{short(row.address)}</TableCell>
                      <TableCell>{boundaryBadge(row.boundary)}</TableCell>
                      <TableCell className="text-right font-mono">{row.amountSats.toLocaleString()}</TableCell>
                      <TableCell className="text-right"><Button size="sm" variant="outline" onClick={() => setSelectedOutpoint(`${row.txid}:${row.vout}`)}>Open passport</Button></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          {selected && <CoinPassport output={selected} ledger={ledger!} onExport={(kind, outpoint) => void exportLedger(kind, outpoint)} />}
          {selectedOutpoint && !selected && <Card><CardContent className="p-6 text-muted-foreground">That outpoint is not current in this wallet scope.</CardContent></Card>}
        </>
      )}
    </div>
  );
}
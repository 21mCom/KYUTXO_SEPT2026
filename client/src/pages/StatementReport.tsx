import { useState, useMemo, useCallback, useRef } from "react";
import { AlertTriangle, FileDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBTC } from "@/lib/bitcoin";
import { sanitizePdfText } from "@/lib/pdfText";
import { useTags } from "@/hooks/use-tags";
import { useOwners } from "@/hooks/use-owners";
import { useWalletNames } from "@/hooks/use-wallet-names";
import { getParticipantsByTxids, getParticipantsByAddresses } from "@/lib/dataFacade";
import { getRecordsByType } from "@/lib/data/record-crud";
import {
  getTransactionsByTxids,
  getParticipantsByPrevOutKeys,
} from "@/lib/data/transaction-crud";
import { getPriceDataByDateCurrencyAssetKeys } from "@/lib/data/price-data-crud";
import type { TransactionParticipant, BlockchainTransaction } from "@/lib/database";

type BalanceMode = "modeA" | "modeB" | "modeC";

interface StatementRow {
  txid: string;
  blockTime: number;
  dateStr: string;
  netSats: number;
  runningBalanceSats: number;
  usdPrice: number | null;
  netUsd: number | null;
  runningBalanceUsd: number | null;
  participants: TransactionParticipant[];
}

function formatDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function toDateStr(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatUsd(amount: number): string {
  return amount.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

export default function StatementReport() {
  const [addressMode, setAddressMode] = useState<string>("paste");
  const [pastedAddresses, setPastedAddresses] = useState("");
  const [filterOwner, setFilterOwner] = useState<string>("");
  const [filterWallet, setFilterWallet] = useState<string>("");
  const [filterTag, setFilterTag] = useState<string>("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [currency, setCurrency] = useState<"BTC" | "USD">("BTC");
  const [balanceMode, setBalanceMode] = useState<BalanceMode>("modeA");
  const [showTxids, setShowTxids] = useState(false);
  const [showAddresses, setShowAddresses] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [rows, setRows] = useState<StatementRow[]>([]);
  const [hasGenerated, setHasGenerated] = useState(false);
  const [usedAddresses, setUsedAddresses] = useState<string[]>([]);
  const { tags } = useTags();
  const { owners } = useOwners();
  const { walletNames } = useWalletNames();

  const generateAbortRef = useRef<AbortController | null>(null);
  const filteredTags = useMemo(() => tags.filter(t => t.name), [tags]);
  const filteredOwners = useMemo(() => owners.filter(o => o.name), [owners]);
  const filteredWalletNames = useMemo(() => walletNames.filter(w => w.name), [walletNames]);

  const resolveAddresses = useCallback(async (): Promise<string[]> => {
    if (addressMode === "paste") {
      return pastedAddresses
        .split(/[\n,;]+/)
        .map(a => a.trim())
        .filter(a => a.length > 0);
    }

    const rawRecords = await getRecordsByType('address');
    let records = rawRecords;
    if (filterOwner) {
      records = records.filter(r => r.owner === filterOwner);
    }
    if (filterWallet) {
      records = records.filter(r => r.walletName === filterWallet);
    }
    if (filterTag) {
      records = records.filter(r => r.tags && r.tags.includes(filterTag));
    }
    return records.map(r => r.inputString).filter(s => s.length > 0);
  }, [addressMode, pastedAddresses, filterOwner, filterWallet, filterTag]);

  const batchLookupPrices = useCallback(async (dateStrings: string[]): Promise<Map<string, number>> => {
    const priceCache = new Map<string, number>();
    const uniqueDates = Array.from(new Set(dateStrings));

    const allSearchDates = new Set<string>();
    for (const ds of uniqueDates) {
      allSearchDates.add(ds);
      for (let offset = 1; offset <= 3; offset++) {
        const d1 = new Date(ds);
        d1.setDate(d1.getDate() - offset);
        allSearchDates.add(`${d1.getFullYear()}-${String(d1.getMonth() + 1).padStart(2, "0")}-${String(d1.getDate()).padStart(2, "0")}`);
        const d2 = new Date(ds);
        d2.setDate(d2.getDate() + offset);
        allSearchDates.add(`${d2.getFullYear()}-${String(d2.getMonth() + 1).padStart(2, "0")}-${String(d2.getDate()).padStart(2, "0")}`);
      }
    }

    const allDateKeys = Array.from(allSearchDates);
    const pricesByDate = new Map<string, number>();
    for (let i = 0; i < allDateKeys.length; i += 500) {
      const batch = allDateKeys.slice(i, i + 500);
      const keys = batch.map(d => [d, "USD", "BTC"] as [string, string, string]);
      const results = await getPriceDataByDateCurrencyAssetKeys(keys);
      for (const r of results) {
        pricesByDate.set(r.date, r.close);
      }
    }

    for (const ds of uniqueDates) {
      if (pricesByDate.has(ds)) {
        priceCache.set(ds, pricesByDate.get(ds)!);
        continue;
      }
      let found = false;
      for (let offset = 1; offset <= 3 && !found; offset++) {
        const d1 = new Date(ds);
        d1.setDate(d1.getDate() - offset);
        const tryDate1 = `${d1.getFullYear()}-${String(d1.getMonth() + 1).padStart(2, "0")}-${String(d1.getDate()).padStart(2, "0")}`;
        if (pricesByDate.has(tryDate1)) {
          priceCache.set(ds, pricesByDate.get(tryDate1)!);
          found = true;
          break;
        }
        const d2 = new Date(ds);
        d2.setDate(d2.getDate() + offset);
        const tryDate2 = `${d2.getFullYear()}-${String(d2.getMonth() + 1).padStart(2, "0")}-${String(d2.getDate()).padStart(2, "0")}`;
        if (pricesByDate.has(tryDate2)) {
          priceCache.set(ds, pricesByDate.get(tryDate2)!);
          found = true;
          break;
        }
      }
    }

    return priceCache;
  }, []);

  const generateReport = useCallback(async () => {
    generateAbortRef.current?.abort();
    const abortController = new AbortController();
    generateAbortRef.current = abortController;
    setIsGenerating(true);
    setHasGenerated(false);
    setRows([]);

    try {
      const addresses = await resolveAddresses();
      if (addresses.length === 0) {
        setHasGenerated(true);
        setUsedAddresses([]);
        return;
      }
      setUsedAddresses(addresses);

      const addressSet = new Set(addresses);

      const allParticipants = await getParticipantsByAddresses(addresses, abortController.signal);

      const txidSet = new Set(allParticipants.map(p => p.txid));

      const ourOutputs: Array<{ txid: string; vout: number; amount: number; address: string }> = [];
      for (const p of allParticipants) {
        if (p.role === "output" && p.vout !== undefined) {
          ourOutputs.push({ txid: p.txid, vout: p.vout, amount: Number(p.amount) || 0, address: p.address });
        }
      }

      const spendingTxids = new Set<string>();
      const spentOutputAmounts = new Map<string, { amount: number; address: string; spendingTxid: string }>();

      if (ourOutputs.length > 0) {
        const allSpendingInputs: TransactionParticipant[] = [];
        for (let i = 0; i < ourOutputs.length; i += 500) {
          const batch = ourOutputs.slice(i, i + 500);
          const keys = batch.map(o => [o.txid, o.vout] as [string, number]);
          const raw = await getParticipantsByPrevOutKeys(keys);
          const spendingInputs = raw;
          allSpendingInputs.push(...spendingInputs);
          if (i + 500 < ourOutputs.length) {
            await new Promise(r => setTimeout(r, 0));
          }
        }

        const outputLookup = new Map<string, { amount: number; address: string }>();
        for (const o of ourOutputs) {
          outputLookup.set(`${o.txid}:${o.vout}`, { amount: o.amount, address: o.address });
        }

        for (const inp of allSpendingInputs) {
          if (!txidSet.has(inp.txid)) {
            spendingTxids.add(inp.txid);
          }
          if (inp.prevTxid && inp.prevVout !== undefined) {
            const output = outputLookup.get(`${inp.prevTxid}:${inp.prevVout}`);
            if (output) {
              spentOutputAmounts.set(`${inp.txid}:${inp.prevTxid}:${inp.prevVout}`, {
                amount: output.amount,
                address: output.address,
                spendingTxid: inp.txid,
              });
            }
          }
        }
      }

      Array.from(spendingTxids).forEach(stxid => {
        txidSet.add(stxid);
      });

      const txids = Array.from(txidSet);

      const txMap = new Map<string, BlockchainTransaction>();
      for (let i = 0; i < txids.length; i += 500) {
        const batch = txids.slice(i, i + 500);
        const txs = await getTransactionsByTxids(batch);
        for (const tx of txs) {
          txMap.set(tx.txid, tx);
        }
      }

      const allTxParticipants = new Map<string, TransactionParticipant[]>();
      for (let i = 0; i < txids.length; i += 500) {
        const batch = txids.slice(i, i + 500);
        const parts = await getParticipantsByTxids(batch);
        for (const p of parts) {
          const list = allTxParticipants.get(p.txid) || [];
          list.push(p);
          allTxParticipants.set(p.txid, list);
        }
      }

      const outputAmountLookup = new Map<string, number>();
      for (const [, participants] of Array.from(allTxParticipants)) {
        for (const p of participants) {
          if (p.role === "output" && p.vout !== undefined) {
            const key = `${p.txid}:${p.vout}`;
            outputAmountLookup.set(key, Number(p.amount) || 0);
          }
        }
      }

      const unresolvedPrevOuts = new Set<string>();
      for (const [, participants] of Array.from(allTxParticipants)) {
        for (const p of participants) {
          if (p.role !== "input") continue;
          if (!addressSet.has(p.address)) continue;
          const amt = Number(p.amount) || 0;
          if (amt === 0 && p.prevTxid && p.prevVout !== undefined) {
            const lookupKey = `${p.prevTxid}:${p.prevVout}`;
            if (!outputAmountLookup.has(lookupKey)) {
              unresolvedPrevOuts.add(lookupKey);
            }
          }
        }
      }

      if (unresolvedPrevOuts.size > 0) {
        const lookupKeys = Array.from(unresolvedPrevOuts);
        const prevTxids = Array.from(new Set(lookupKeys.map(k => k.split(":")[0])));
        for (let i = 0; i < prevTxids.length; i += 500) {
          const batch = prevTxids.slice(i, i + 500);
          const prevOutputs = (await getParticipantsByTxids(batch))
            .filter(p => p.role === "output");
          for (const po of prevOutputs) {
            if (po.vout !== undefined) {
              const key = `${po.txid}:${po.vout}`;
              if (!outputAmountLookup.has(key)) {
                outputAmountLookup.set(key, Number(po.amount) || 0);
              }
            }
          }
        }
      }

      const netByTxid = new Map<string, number>();

      for (const [txid, participants] of Array.from(allTxParticipants)) {
        const seen = new Set<string>();
        let net = 0;
        let hasOurInputOrOutput = false;

        for (const p of participants) {
          if (p.role !== "input" && p.role !== "output") continue;
          if (!addressSet.has(p.address)) continue;

          hasOurInputOrOutput = true;

          const dedupKey = p.role === "input"
            ? `in:${p.prevTxid ?? ""}:${p.prevVout ?? p.id ?? ""}`
            : `out:${p.vout ?? p.id ?? ""}`;
          if (seen.has(dedupKey)) continue;
          seen.add(dedupKey);

          let amount = Number(p.amount) || 0;
          if (p.role === "input" && amount === 0 && p.prevTxid && p.prevVout !== undefined) {
            amount = outputAmountLookup.get(`${p.prevTxid}:${p.prevVout}`) || 0;
          }

          if (p.role === "output") {
            net += amount;
          } else {
            net -= amount;
          }
        }

        if (!hasOurInputOrOutput && spendingTxids.has(txid)) {
          const spentEntries = Array.from(spentOutputAmounts.entries())
            .filter(([key]) => key.startsWith(`${txid}:`));
          for (const [, info] of spentEntries) {
            net -= info.amount;
          }
          const ourChangeOutputs = participants.filter(
            (p: TransactionParticipant) => p.role === "output" && addressSet.has(p.address)
          );
          for (const co of ourChangeOutputs) {
            const coAmount = Number(co.amount) || 0;
            const coDedupKey = `out:${co.vout ?? co.id ?? ""}`;
            if (!seen.has(coDedupKey)) {
              seen.add(coDedupKey);
              net += coAmount;
            }
          }
          hasOurInputOrOutput = true;
        }

        if (hasOurInputOrOutput) {
          netByTxid.set(txid, net);
        }
      }

      let entries = Array.from(netByTxid.entries())
        .map(([txid, netSats]) => ({
          txid,
          netSats,
          tx: txMap.get(txid),
        }))
        .filter(e => e.tx !== undefined)
        .sort((a, b) => a.tx!.blockTime - b.tx!.blockTime);

      if (startDate) {
        const startUnix = new Date(startDate).getTime() / 1000;
        entries = entries.filter(e => e.tx!.blockTime >= startUnix);
      }
      if (endDate) {
        const endUnix = new Date(endDate + "T23:59:59").getTime() / 1000;
        entries = entries.filter(e => e.tx!.blockTime <= endUnix);
      }

      let priceCache = new Map<string, number>();
      if (currency === "USD") {
        const datesToLookup = entries.map(e => toDateStr(e.tx!.blockTime));
        priceCache = await batchLookupPrices(datesToLookup);
      }

      let runningBalance = 0;
      const resultRows: StatementRow[] = [];

      for (const entry of entries) {
        runningBalance += entry.netSats;
        const blockTime = entry.tx!.blockTime;
        const dateString = toDateStr(blockTime);
        let usdPrice: number | null = null;
        let netUsd: number | null = null;
        let runningBalanceUsd: number | null = null;

        if (currency === "USD") {
          usdPrice = priceCache.get(dateString) ?? null;
          if (usdPrice !== null) {
            const btcAmount = entry.netSats / 100_000_000;
            netUsd = btcAmount * usdPrice;
            const btcBalance = runningBalance / 100_000_000;
            runningBalanceUsd = btcBalance * usdPrice;
          }
        }

        resultRows.push({
          txid: entry.txid,
          blockTime,
          dateStr: formatDate(blockTime),
          netSats: entry.netSats,
          runningBalanceSats: runningBalance,
          usdPrice,
          netUsd,
          runningBalanceUsd,
          participants: allTxParticipants.get(entry.txid) || [],
        });
      }

      const incoming = resultRows.filter(r => r.netSats > 0).length;
      const outgoing = resultRows.filter(r => r.netSats < 0).length;
      const zero = resultRows.filter(r => r.netSats === 0).length;
      console.log(`[Statement] Generated ${resultRows.length} rows: ${incoming} incoming, ${outgoing} outgoing, ${zero} zero-net`);

      if (generateAbortRef.current === abortController) {
        setRows(resultRows);
        setHasGenerated(true);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      console.error("Failed to generate report:", error);
      if (generateAbortRef.current === abortController) {
        setHasGenerated(true);
      }
    } finally {
      if (generateAbortRef.current === abortController) {
        setIsGenerating(false);
      }
    }
  }, [resolveAddresses, startDate, endDate, currency, batchLookupPrices]);

  const exportPdf = useCallback(async () => {
    try {
      const jsPDFModule = await import("jspdf");
      const autoTableModule = await import("jspdf-autotable");
      const jsPDF = jsPDFModule.default;
      const autoTable = autoTableModule.default;

      const doc = new jsPDF();
      doc.setFontSize(18);
      doc.text("Bitcoin Statement Report", 14, 20);

      doc.setFontSize(10);
      let subtitle = "";
      if (startDate || endDate) {
        subtitle += `Date Range: ${startDate || "start"} to ${endDate || "present"}`;
      }
      if (usedAddresses.length > 0) {
        const addrText = usedAddresses.length <= 3
          ? usedAddresses.join(", ")
          : `${usedAddresses.slice(0, 3).join(", ")} (+${usedAddresses.length - 3} more)`;
        subtitle += subtitle ? " | " : "";
        subtitle += `Addresses: ${sanitizePdfText(addrText)}`;
      }
      if (subtitle) {
        doc.text(subtitle, 14, 28);
      }

      const headers: string[] = ["Date"];
      if (showTxids) headers.push("TXID");
      if (showAddresses) headers.push("Addresses");

      if (currency === "BTC") {
        headers.push("Net Amount (BTC)");
        headers.push("Balance (BTC)");
      } else {
        headers.push("Net Amount (USD)");
        if (balanceMode === "modeB") {
          headers.push("Balance (BTC)");
          headers.push("USD Value");
        } else if (balanceMode === "modeC") {
          headers.push("Balance (BTC)");
        }
      }

      const body = rows.map(row => {
        const r: string[] = [row.dateStr];
        if (showTxids) r.push(sanitizePdfText(row.txid.slice(0, 16)) + "...");
        if (showAddresses) {
          const addrs = Array.from(new Set(row.participants.map(p => p.address)));
          r.push(sanitizePdfText(addrs.length <= 2 ? addrs.join(", ") : `${addrs[0]}, +${addrs.length - 1}`));
        }

        if (currency === "BTC") {
          const prefix = row.netSats >= 0 ? "+" : "";
          r.push(prefix + formatBTC(row.netSats));
          r.push(formatBTC(row.runningBalanceSats));
        } else {
          if (row.netUsd !== null) {
            const prefix = row.netUsd >= 0 ? "+" : "";
            r.push(prefix + formatUsd(row.netUsd));
          } else {
            r.push("N/A");
          }
          if (balanceMode === "modeB") {
            r.push(formatBTC(row.runningBalanceSats));
            r.push(row.runningBalanceUsd !== null ? formatUsd(row.runningBalanceUsd) : "N/A");
          } else if (balanceMode === "modeC") {
            r.push(formatBTC(row.runningBalanceSats));
          }
        }
        return r;
      });

      autoTable(doc, {
        startY: subtitle ? 34 : 26,
        head: [headers],
        body,
        styles: { fontSize: 7, cellPadding: 2 },
        headStyles: { fillColor: [41, 128, 185] },
      });

      const pageHeight = doc.internal.pageSize.getHeight();
      doc.setFontSize(8);
      doc.text(`Generated: ${new Date().toLocaleString()}`, 14, pageHeight - 10);

      const today = new Date().toISOString().split("T")[0];
      const pdfBlob = doc.output("blob");
      const url = URL.createObjectURL(pdfBlob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `btc-statement-${today}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Failed to generate PDF:", error);
    }
  }, [rows, showTxids, showAddresses, currency, balanceMode, startDate, endDate, usedAddresses]);

  const showRunningBtcBalance = currency === "BTC" || balanceMode === "modeB" || balanceMode === "modeC";
  const showUsdValue = currency === "USD" && balanceMode === "modeB";

  return (
    <div className="p-4 space-y-4 max-w-[1200px] mx-auto">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
          <CardTitle data-testid="text-page-title">Statement Report</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Tabs value={addressMode} onValueChange={setAddressMode}>
            <TabsList data-testid="tabs-address-mode">
              <TabsTrigger value="paste" data-testid="tab-paste-addresses">Paste Addresses</TabsTrigger>
              <TabsTrigger value="filter" data-testid="tab-filter-vocabulary">Filter by Vocabulary</TabsTrigger>
            </TabsList>
            <TabsContent value="paste">
              <Textarea
                placeholder="Paste one or more Bitcoin addresses, one per line"
                value={pastedAddresses}
                onChange={e => setPastedAddresses(e.target.value)}
                rows={4}
                data-testid="textarea-paste-addresses"
              />
            </TabsContent>
            <TabsContent value="filter">
              <div className="flex flex-wrap gap-3">
                <div className="space-y-1 min-w-[180px]">
                  <Label data-testid="label-filter-owner">Owner</Label>
                  <Select value={filterOwner} onValueChange={(v) => setFilterOwner(v === "__all__" ? "" : v)}>
                    <SelectTrigger data-testid="select-filter-owner">
                      <SelectValue placeholder="All owners" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__" data-testid="select-item-owner-all">All owners</SelectItem>
                      {filteredOwners.map(o => (
                        <SelectItem key={o.name} value={o.name} data-testid={`select-item-owner-${o.name}`}>{o.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1 min-w-[180px]">
                  <Label data-testid="label-filter-wallet">Wallet Name</Label>
                  <Select value={filterWallet} onValueChange={(v) => setFilterWallet(v === "__all__" ? "" : v)}>
                    <SelectTrigger data-testid="select-filter-wallet">
                      <SelectValue placeholder="All wallets" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__" data-testid="select-item-wallet-all">All wallets</SelectItem>
                      {filteredWalletNames.map(w => (
                        <SelectItem key={w.name} value={w.name} data-testid={`select-item-wallet-${w.name}`}>{w.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1 min-w-[180px]">
                  <Label data-testid="label-filter-tag">Tag</Label>
                  <Select value={filterTag} onValueChange={(v) => setFilterTag(v === "__all__" ? "" : v)}>
                    <SelectTrigger data-testid="select-filter-tag">
                      <SelectValue placeholder="All tags" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__" data-testid="select-item-tag-all">All tags</SelectItem>
                      {filteredTags.map(t => (
                        <SelectItem key={t.name} value={t.name} data-testid={`select-item-tag-${t.name}`}>{t.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </TabsContent>
          </Tabs>

          <Separator />

          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1">
              <Label data-testid="label-start-date">Start Date</Label>
              <input
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                data-testid="input-start-date"
              />
            </div>
            <div className="space-y-1">
              <Label data-testid="label-end-date">End Date</Label>
              <input
                type="date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                data-testid="input-end-date"
              />
            </div>
            <div className="space-y-1">
              <Label data-testid="label-currency">Currency</Label>
              <Select value={currency} onValueChange={(v) => setCurrency(v as "BTC" | "USD")}>
                <SelectTrigger className="w-[100px]" data-testid="select-currency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="BTC" data-testid="select-item-btc">BTC</SelectItem>
                  <SelectItem value="USD" data-testid="select-item-usd">USD</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {currency === "USD" && (
              <div className="space-y-1">
                <Label data-testid="label-balance-mode">Balance Mode</Label>
                <Select value={balanceMode} onValueChange={(v) => setBalanceMode(v as BalanceMode)}>
                  <SelectTrigger className="w-[200px]" data-testid="select-balance-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="modeA" data-testid="select-item-modeA">Mode A - USD only</SelectItem>
                    <SelectItem value="modeB" data-testid="select-item-modeB">Mode B - BTC + USD value</SelectItem>
                    <SelectItem value="modeC" data-testid="select-item-modeC">Mode C - Dual columns</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Checkbox
                id="showTxids"
                checked={showTxids}
                onCheckedChange={(v) => setShowTxids(!!v)}
                data-testid="checkbox-show-txids"
              />
              <Label htmlFor="showTxids" className="cursor-pointer" data-testid="label-show-txids">Show TXIDs</Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="showAddresses"
                checked={showAddresses}
                onCheckedChange={(v) => setShowAddresses(!!v)}
                data-testid="checkbox-show-addresses"
              />
              <Label htmlFor="showAddresses" className="cursor-pointer" data-testid="label-show-addresses">Show Addresses</Label>
            </div>
            <Button
              variant="default"
              onClick={generateReport}
              disabled={isGenerating}
              data-testid="button-generate-report"
            >
              {isGenerating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Generate Report
            </Button>
          </div>
        </CardContent>
      </Card>

      {isGenerating && (
        <div className="flex items-center justify-center py-12" data-testid="loading-report">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <span className="ml-3 text-muted-foreground">Generating report...</span>
        </div>
      )}

      {hasGenerated && !isGenerating && rows.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground" data-testid="text-no-transactions">No transactions found for the selected addresses and date range.</p>
          </CardContent>
        </Card>
      )}

      {hasGenerated && !isGenerating && rows.length > 0 && rows.every(r => r.netSats >= 0) && rows.length > 2 && (
        <Card className="border-amber-500/40">
          <CardContent className="py-3 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
            <p className="text-sm text-muted-foreground" data-testid="text-data-warning">
              All transactions show as incoming. This may indicate that input prevout data
              has not been resolved yet. Re-syncing these addresses will automatically resolve
              prevout data and show correct incoming/outgoing amounts.
            </p>
          </CardContent>
        </Card>
      )}

      {hasGenerated && !isGenerating && rows.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <div className="flex items-center gap-2 flex-wrap">
              <CardTitle data-testid="text-report-title">Transaction Statement</CardTitle>
              <Badge variant="secondary" data-testid="badge-tx-count">{rows.length} transactions</Badge>
              {rows.filter(r => r.netSats > 0).length > 0 && (
                <Badge variant="outline" className="text-green-600 dark:text-green-400 border-green-600/30" data-testid="badge-incoming-count">
                  {rows.filter(r => r.netSats > 0).length} incoming
                </Badge>
              )}
              {rows.filter(r => r.netSats < 0).length > 0 && (
                <Badge variant="outline" className="text-red-600 dark:text-red-400 border-red-600/30" data-testid="badge-outgoing-count">
                  {rows.filter(r => r.netSats < 0).length} outgoing
                </Badge>
              )}
            </div>
            <Button variant="outline" onClick={exportPdf} data-testid="button-export-pdf">
              <FileDown className="mr-2 h-4 w-4" />
              Export PDF
            </Button>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table data-testid="table-statement">
                <TableHeader>
                  <TableRow>
                    <TableHead data-testid="th-date">Date</TableHead>
                    {showTxids && <TableHead data-testid="th-txid">TXID</TableHead>}
                    {showAddresses && <TableHead data-testid="th-addresses">Addresses</TableHead>}
                    <TableHead className="text-right" data-testid="th-net-amount">
                      {currency === "BTC" ? "Net Amount (BTC)" : "Net Amount (USD)"}
                    </TableHead>
                    {showRunningBtcBalance && (
                      <TableHead className="text-right" data-testid="th-balance-btc">Balance (BTC)</TableHead>
                    )}
                    {showUsdValue && (
                      <TableHead className="text-right" data-testid="th-usd-value">USD Value</TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row, idx) => {
                    const isPositive = row.netSats >= 0;
                    const amountClass = isPositive
                      ? "text-green-600 dark:text-green-400"
                      : "text-red-600 dark:text-red-400";

                    let netDisplay: string;
                    if (currency === "BTC") {
                      netDisplay = (isPositive ? "+" : "") + formatBTC(row.netSats);
                    } else {
                      if (row.netUsd !== null) {
                        netDisplay = (row.netUsd >= 0 ? "+" : "") + formatUsd(row.netUsd);
                      } else {
                        netDisplay = "N/A";
                      }
                    }

                    const participantAddrs = Array.from(new Set(row.participants.map(p => p.address)));

                    return (
                      <TableRow key={row.txid} data-testid={`row-tx-${idx}`}>
                        <TableCell data-testid={`cell-date-${idx}`}>{row.dateStr}</TableCell>
                        {showTxids && (
                          <TableCell data-testid={`cell-txid-${idx}`}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="font-mono text-xs cursor-default">
                                  {row.txid.slice(0, 12)}...
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p className="font-mono text-xs break-all max-w-[400px]">{row.txid}</p>
                              </TooltipContent>
                            </Tooltip>
                          </TableCell>
                        )}
                        {showAddresses && (
                          <TableCell data-testid={`cell-addresses-${idx}`}>
                            <div className="text-xs font-mono space-y-0.5 max-w-[200px]">
                              {participantAddrs.slice(0, 3).map(a => (
                                <div key={a} className="truncate">{a}</div>
                              ))}
                              {participantAddrs.length > 3 && (
                                <div className="text-muted-foreground">+{participantAddrs.length - 3} more</div>
                              )}
                            </div>
                          </TableCell>
                        )}
                        <TableCell className={`text-right font-mono ${amountClass}`} data-testid={`cell-net-${idx}`}>
                          {netDisplay}
                        </TableCell>
                        {showRunningBtcBalance && (
                          <TableCell className="text-right font-mono" data-testid={`cell-balance-${idx}`}>
                            {formatBTC(row.runningBalanceSats)}
                          </TableCell>
                        )}
                        {showUsdValue && (
                          <TableCell className="text-right font-mono" data-testid={`cell-usd-value-${idx}`}>
                            {row.runningBalanceUsd !== null ? formatUsd(row.runningBalanceUsd) : "N/A"}
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

import { useState, useMemo, useRef, useCallback } from "react";
import { Loader2, ChevronDown, ChevronRight, AlertCircle, CalendarRange } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBTC } from "@/lib/bitcoin";
import { getParticipantsByAddresses, getParticipantsByTxids } from "@/lib/dataFacade";
import { getTransactionsByTxids, getParticipantsByPrevOutKeys } from "@/lib/data/transaction-crud";
import { AddressLink } from "@/components/AddressLink";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { TransactionParticipant, BlockchainTransaction } from "@/lib/database";

interface YearRow {
  year: number;
  txCount: number;
  receivedSats: number;
  spentSats: number;
}

interface AddressActivity {
  address: string;
  yearRows: YearRow[];
  hasData: boolean;
}

interface CounterpartyEntry {
  address: string;
  txCount: number;
}

interface ReportData {
  combinedYearRows: YearRow[];
  perAddress: AddressActivity[];
  receivedFrom: CounterpartyEntry[];
  sentTo: CounterpartyEntry[];
  unresolvedReceivedFromCount: number;
  unresolvedSentToCount: number;
  noDataAddresses: string[];
}

function buildYearRowsFromMaps(
  txids: string[],
  txMap: Map<string, BlockchainTransaction>,
  receivedSatsByTxid: Map<string, number>,
  spentSatsByTxid: Map<string, number>,
): YearRow[] {
  const byYear = new Map<number, { txCount: number; receivedSats: number; spentSats: number }>();
  for (const txid of txids) {
    const tx = txMap.get(txid);
    if (!tx || !tx.blockTime) continue;
    const received = receivedSatsByTxid.get(txid) ?? 0;
    const spent = spentSatsByTxid.get(txid) ?? 0;
    if (received === 0 && spent === 0) continue;
    const year = new Date(tx.blockTime * 1000).getUTCFullYear();
    let row = byYear.get(year);
    if (!row) {
      row = { txCount: 0, receivedSats: 0, spentSats: 0 };
      byYear.set(year, row);
    }
    row.txCount += 1;
    row.receivedSats += received;
    row.spentSats += spent;
  }
  return Array.from(byYear.entries())
    .map(([year, data]) => ({ year, ...data }))
    .sort((a, b) => a.year - b.year);
}

function TotalsRow({ rows }: { rows: YearRow[] }) {
  const total = useMemo(() => {
    return rows.reduce(
      (acc, r) => ({
        txCount: acc.txCount + r.txCount,
        receivedSats: acc.receivedSats + r.receivedSats,
        spentSats: acc.spentSats + r.spentSats,
      }),
      { txCount: 0, receivedSats: 0, spentSats: 0 },
    );
  }, [rows]);
  return (
    <TableRow className="font-semibold border-t-2 bg-muted/30">
      <TableCell>All Time</TableCell>
      <TableCell className="text-right">{total.txCount.toLocaleString()}</TableCell>
      <TableCell className="text-right font-mono">{formatBTC(total.receivedSats)}</TableCell>
      <TableCell className="text-right font-mono">{formatBTC(total.spentSats)}</TableCell>
    </TableRow>
  );
}

function YearTable({ rows, "data-testid": testId }: { rows: YearRow[]; "data-testid"?: string }) {
  if (rows.length === 0) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm py-2">
        <AlertCircle className="h-4 w-4" />
        No synced transaction data for this address.
      </div>
    );
  }
  return (
    <Table data-testid={testId}>
      <TableHeader>
        <TableRow>
          <TableHead>Year</TableHead>
          <TableHead className="text-right">Transactions</TableHead>
          <TableHead className="text-right">BTC Received</TableHead>
          <TableHead className="text-right">BTC Spent</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.year} data-testid={`row-year-${r.year}`}>
            <TableCell>{r.year}</TableCell>
            <TableCell className="text-right">{r.txCount.toLocaleString()}</TableCell>
            <TableCell className="text-right font-mono">{formatBTC(r.receivedSats)}</TableCell>
            <TableCell className="text-right font-mono">{formatBTC(r.spentSats)}</TableCell>
          </TableRow>
        ))}
        <TotalsRow rows={rows} />
      </TableBody>
    </Table>
  );
}

function CounterpartyList({
  entries,
  minTx,
  unresolvedCount,
  "data-testid": testId,
}: {
  entries: CounterpartyEntry[];
  minTx: number;
  unresolvedCount: number;
  "data-testid"?: string;
}) {
  const filtered = useMemo(
    () => entries.filter((e) => e.txCount >= minTx),
    [entries, minTx],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 36,
    overscan: 10,
  });

  return (
    <div className="space-y-2">
      {unresolvedCount > 0 && (
        <div className="text-xs text-muted-foreground bg-muted/50 rounded px-2 py-1.5">
          {unresolvedCount.toLocaleString()} transaction
          {unresolvedCount !== 1 ? "s" : ""} had input sources that could not be resolved to an
          address (omitted from the list below).
        </div>
      )}
      {filtered.length === 0 ? (
        <div className="text-sm text-muted-foreground py-2">
          No counterparties meet the minimum of {minTx} transaction{minTx !== 1 ? "s" : ""}.
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="max-h-72 overflow-auto border rounded-md"
          data-testid={testId}
        >
          <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualizer.getVirtualItems()[0]?.start ?? 0}px)`,
              }}
            >
              {virtualizer.getVirtualItems().map((vi) => {
                const entry = filtered[vi.index];
                return (
                  <div
                    key={entry.address}
                    data-index={vi.index}
                    ref={virtualizer.measureElement}
                    className="flex items-center justify-between px-3 py-2 text-sm border-b last:border-b-0"
                  >
                    <AddressLink address={entry.address} showCopy={false} />
                    <Badge variant="secondary" className="ml-2 flex-none">
                      {entry.txCount.toLocaleString()} tx{entry.txCount !== 1 ? "s" : ""}
                    </Badge>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AnnualActivityReport() {
  const [pastedText, setPastedText] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [reportData, setReportData] = useState<ReportData | null>(null);
  const [hasGenerated, setHasGenerated] = useState(false);
  const [minTx, setMinTx] = useState(5);
  const [expandedAddresses, setExpandedAddresses] = useState<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);

  const toggleAddress = useCallback((addr: string) => {
    setExpandedAddresses((prev) => {
      const next = new Set(prev);
      if (next.has(addr)) next.delete(addr);
      else next.add(addr);
      return next;
    });
  }, []);

  async function generate() {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    const addresses = pastedText
      .split(/[\n,;]+/)
      .map((a) => a.trim())
      .filter((a) => a.length > 0);

    if (addresses.length === 0) {
      setHasGenerated(true);
      setReportData(null);
      return;
    }

    setIsGenerating(true);
    setHasGenerated(false);
    setExpandedAddresses(new Set());

    try {
      const addressSet = new Set(addresses);

      // ── Step 1: fetch all participants for the pasted addresses ──────────
      const allParticipants = await getParticipantsByAddresses(addresses, abort.signal);
      if (abort.signal.aborted) return;

      const txidSet = new Set(allParticipants.map((p) => p.txid));

      // ── Step 2: find our outputs (to detect spending txs via prevout) ────
      // "Our outputs" = instances where a pasted address appears as an output
      // with a vout, meaning a UTXO is created for that address.
      const ourOutputs: Array<{ txid: string; vout: number }> = [];
      for (const p of allParticipants) {
        if (p.role === "output" && p.vout !== undefined) {
          ourOutputs.push({ txid: p.txid, vout: p.vout });
        }
      }

      // ── Step 3: find transactions that SPEND our outputs ─────────────────
      // An input participant references prevTxid:prevVout. When the input address
      // is blank (unresolved), getParticipantsByAddresses misses this tx entirely.
      // Querying prevout keys captures those spending transactions.
      const spendingTxids = new Set<string>();
      // Maps "spendingTxid:prevTxid:prevVout" → { amount, address }
      // so we can recover spent amounts even when the input row has amount=0.
      const spentOutputAmounts = new Map<string, { amount: number; address: string }>();

      if (ourOutputs.length > 0) {
        // Build a lookup: "prevTxid:prevVout" → output amount/address from allParticipants
        const outputLookup = new Map<string, { amount: number; address: string }>();
        for (const p of allParticipants) {
          if (p.role === "output" && p.vout !== undefined) {
            outputLookup.set(`${p.txid}:${p.vout}`, {
              amount: Number(p.amount) || 0,
              address: p.address,
            });
          }
        }

        for (let i = 0; i < ourOutputs.length; i += 500) {
          if (abort.signal.aborted) return;
          const batch = ourOutputs.slice(i, i + 500);
          const keys = batch.map((o) => [o.txid, o.vout] as [string, number]);
          const spendingInputs = await getParticipantsByPrevOutKeys(keys);
          for (const inp of spendingInputs) {
            if (inp.prevTxid && inp.prevVout !== undefined) {
              const out = outputLookup.get(`${inp.prevTxid}:${inp.prevVout}`);
              if (out) {
                spentOutputAmounts.set(`${inp.txid}:${inp.prevTxid}:${inp.prevVout}`, {
                  amount: out.amount,
                  address: out.address,
                });
                // Mark as needing unresolved-prevout fallback attribution.
                // IMPORTANT: do NOT gate on txidSet membership here — a
                // spend-with-change tx is already in txidSet (pasted address
                // has a change output), but its input may still be blank/unresolved
                // and still needs the fallback path to count the spent amount.
                spendingTxids.add(inp.txid);
              }
            }
            // Add genuinely new txids (not reachable via address index) for fetching.
            if (!txidSet.has(inp.txid)) {
              txidSet.add(inp.txid);
            }
          }
          if (i + 500 < ourOutputs.length) await new Promise((r) => setTimeout(r, 0));
        }
      }
      const txids = Array.from(txidSet);

      // ── Step 4: fetch all transactions ───────────────────────────────────
      const txMap = new Map<string, BlockchainTransaction>();
      for (let i = 0; i < txids.length; i += 500) {
        if (abort.signal.aborted) return;
        const batch = txids.slice(i, i + 500);
        const txs = await getTransactionsByTxids(batch);
        for (const tx of txs) txMap.set(tx.txid, tx);
        if (i + 500 < txids.length) await new Promise((r) => setTimeout(r, 0));
      }

      // ── Step 5: fetch all participants for all txids ─────────────────────
      const allTxParticipants = new Map<string, TransactionParticipant[]>();
      for (let i = 0; i < txids.length; i += 500) {
        if (abort.signal.aborted) return;
        const batch = txids.slice(i, i + 500);
        const parts = await getParticipantsByTxids(batch);
        for (const p of parts) {
          const list = allTxParticipants.get(p.txid) ?? [];
          list.push(p);
          allTxParticipants.set(p.txid, list);
        }
        if (i + 500 < txids.length) await new Promise((r) => setTimeout(r, 0));
      }

      // ── Step 6: build output-amount lookup for prevout resolution ─────────
      // Used to resolve input amounts that are stored as 0 (unresolved prevout).
      const outputAmountLookup = new Map<string, number>();
      for (const [, participants] of allTxParticipants) {
        for (const p of participants) {
          if (p.role === "output" && p.vout !== undefined) {
            outputAmountLookup.set(`${p.txid}:${p.vout}`, Number(p.amount) || 0);
          }
        }
      }

      // Resolve any inputs that still have amount=0 and point to a prevout
      // not yet in outputAmountLookup (referenced tx not in our txid set).
      const unresolvedPrevOuts = new Set<string>();
      for (const [, participants] of allTxParticipants) {
        for (const p of participants) {
          if (p.role !== "input") continue;
          if (!addressSet.has(p.address)) continue;
          const amt = Number(p.amount) || 0;
          if (amt === 0 && p.prevTxid && p.prevVout !== undefined) {
            const key = `${p.prevTxid}:${p.prevVout}`;
            if (!outputAmountLookup.has(key)) unresolvedPrevOuts.add(key);
          }
        }
      }
      if (unresolvedPrevOuts.size > 0) {
        const prevTxids = Array.from(
          new Set(Array.from(unresolvedPrevOuts).map((k) => k.split(":")[0])),
        );
        for (let i = 0; i < prevTxids.length; i += 500) {
          if (abort.signal.aborted) return;
          const prevOutputs = (await getParticipantsByTxids(prevTxids.slice(i, i + 500))).filter(
            (p) => p.role === "output",
          );
          for (const po of prevOutputs) {
            if (po.vout !== undefined) {
              const key = `${po.txid}:${po.vout}`;
              if (!outputAmountLookup.has(key)) {
                outputAmountLookup.set(key, Number(po.amount) || 0);
              }
            }
          }
          if (i + 500 < prevTxids.length) await new Promise((r) => setTimeout(r, 0));
        }
      }

      // ── Step 7: compute per-txid received/spent for each address ─────────
      // combined maps: txid → sats (across all pasted addresses)
      const combinedReceivedByTxid = new Map<string, number>();
      const combinedSpentByTxid = new Map<string, number>();
      // per-address: address → (txid → sats)
      const perAddrReceived = new Map<string, Map<string, number>>();
      const perAddrSpent = new Map<string, Map<string, number>>();
      for (const addr of addresses) {
        perAddrReceived.set(addr, new Map());
        perAddrSpent.set(addr, new Map());
      }

      // Pre-index spentOutputAmounts by spending txid: O(1) lookup per tx
      // instead of scanning the full map with a string-prefix filter.
      // Key format in spentOutputAmounts: "spendingTxid:prevTxid:prevVout"
      // (txids are 64-char hex, no colons, so split gives exactly 3 parts).
      const spentByTxid = new Map<string, Array<{ key: string; amount: number; address: string }>>();
      for (const [key, info] of spentOutputAmounts) {
        const spendingTxid = key.substring(0, key.indexOf(":"));
        const list = spentByTxid.get(spendingTxid) ?? [];
        list.push({ key, ...info });
        spentByTxid.set(spendingTxid, list);
      }

      // Derive resolved amounts from participants
      const resolveInputAmount = (p: TransactionParticipant): number => {
        let amt = Number(p.amount) || 0;
        if (amt === 0 && p.prevTxid && p.prevVout !== undefined) {
          amt = outputAmountLookup.get(`${p.prevTxid}:${p.prevVout}`) ?? 0;
        }
        return amt;
      };

      for (const [txid, participants] of allTxParticipants) {
        const seen = new Set<string>();
        // Track prevTxid:prevVout pairs already accounted for via direct
        // (address-resolved) participants so unresolved-prevout fallback
        // below doesn't double-count the same prevout.
        const seenPrevouts = new Set<string>();

        for (const p of participants) {
          if (p.role !== "input" && p.role !== "output") continue;
          if (!addressSet.has(p.address)) continue;

          const dedupKey =
            p.role === "input"
              ? `in:${p.prevTxid ?? ""}:${p.prevVout ?? p.id ?? ""}`
              : `out:${p.vout ?? p.id ?? ""}`;
          if (seen.has(dedupKey)) continue;
          seen.add(dedupKey);

          const addr = p.address;
          const amt =
            p.role === "input" ? resolveInputAmount(p) : Number(p.amount) || 0;

          if (p.role === "output") {
            perAddrReceived.get(addr)!.set(txid, (perAddrReceived.get(addr)!.get(txid) ?? 0) + amt);
            combinedReceivedByTxid.set(txid, (combinedReceivedByTxid.get(txid) ?? 0) + amt);
          } else {
            if (p.prevTxid && p.prevVout !== undefined) {
              seenPrevouts.add(`${p.prevTxid}:${p.prevVout}`);
            }
            perAddrSpent.get(addr)!.set(txid, (perAddrSpent.get(addr)!.get(txid) ?? 0) + amt);
            combinedSpentByTxid.set(txid, (combinedSpentByTxid.get(txid) ?? 0) + amt);
          }
        }

        // Handle spending txids where the pasted address isn't directly in
        // participants (blank-address input recovered via spentOutputAmounts).
        // Sum ALL matching prevouts — do NOT gate on whether addr already has
        // an entry for this txid (multiple prevouts per address per tx are valid).
        if (spendingTxids.has(txid)) {
          const spentEntries = spentByTxid.get(txid) ?? [];
          const processedKeys = new Set<string>();
          let addedAnySpend = false;

          for (const entry of spentEntries) {
            if (processedKeys.has(entry.key)) continue; // dedupe duplicate keys
            processedKeys.add(entry.key);
            if (!addressSet.has(entry.address)) continue;
            // Skip prevouts already counted via a resolved direct input participant
            const firstColon = entry.key.indexOf(":");
            const prevOutRef = entry.key.substring(firstColon + 1); // "prevTxid:prevVout"
            if (seenPrevouts.has(prevOutRef)) continue;
            const addr = entry.address;
            // Accumulate: no has(txid) guard — multiple prevouts for same addr OK
            perAddrSpent.get(addr)!.set(txid, (perAddrSpent.get(addr)!.get(txid) ?? 0) + entry.amount);
            combinedSpentByTxid.set(txid, (combinedSpentByTxid.get(txid) ?? 0) + entry.amount);
            addedAnySpend = true;
          }

          // Change outputs back to pasted address inside spending tx.
          // Process once per tx (after all prevouts are summed), not per prevout.
          if (addedAnySpend) {
            const changeOutputs = participants.filter(
              (cp) => cp.role === "output" && addressSet.has(cp.address),
            );
            for (const co of changeOutputs) {
              const coAmt = Number(co.amount) || 0;
              const coDedupKey = `out:${co.vout ?? co.id ?? ""}`;
              if (!seen.has(coDedupKey)) {
                seen.add(coDedupKey);
                const coAddr = co.address;
                perAddrReceived.get(coAddr)!.set(txid, (perAddrReceived.get(coAddr)!.get(txid) ?? 0) + coAmt);
                combinedReceivedByTxid.set(txid, (combinedReceivedByTxid.get(txid) ?? 0) + coAmt);
              }
            }
          }
        }
      }

      // ── Step 8: build year rows ──────────────────────────────────────────
      const combinedYearRows = buildYearRowsFromMaps(
        txids,
        txMap,
        combinedReceivedByTxid,
        combinedSpentByTxid,
      );

      const perAddress: AddressActivity[] = addresses.map((addr) => {
        const received = perAddrReceived.get(addr) ?? new Map<string, number>();
        const spent = perAddrSpent.get(addr) ?? new Map<string, number>();
        const addrTxids = Array.from(new Set([...received.keys(), ...spent.keys()]));
        const yearRows = buildYearRowsFromMaps(addrTxids, txMap, received, spent);
        return { address: addr, yearRows, hasData: addrTxids.length > 0 };
      });

      // ── Step 9: build counterparty lists ─────────────────────────────────
      // "Received from" = input-side addresses in txs where a pasted addr received
      // "Sent to" = output-side addresses in txs where a pasted addr spent
      // Unresolved inputs (blank address + prevout) are counted separately.
      const receivedFromTxCounts = new Map<string, Set<string>>();
      const sentToTxCounts = new Map<string, Set<string>>();
      // Track txids with unresolved (blank-address) input sources
      const unresolvedReceivedFromTxids = new Set<string>();
      const unresolvedSentToTxids = new Set<string>();

      for (const txid of txids) {
        const parts = allTxParticipants.get(txid) ?? [];
        const hasPastedOutput = parts.some((p) => p.role === "output" && addressSet.has(p.address));
        const hasPastedInput = parts.some((p) => p.role === "input" && addressSet.has(p.address));
        // Also check spending txids: pasted addr may be input via blank participant
        const isSpendingTx = spendingTxids.has(txid);

        if (hasPastedOutput) {
          // This tx delivered BTC to a pasted address → inputs are "received from"
          for (const p of parts) {
            if (p.role !== "input") continue;
            if (addressSet.has(p.address)) continue;
            if (p.address) {
              const s = receivedFromTxCounts.get(p.address) ?? new Set<string>();
              s.add(txid);
              receivedFromTxCounts.set(p.address, s);
            } else if (p.prevTxid) {
              // Blank address = unresolved input source
              unresolvedReceivedFromTxids.add(txid);
            }
          }
        }

        if (hasPastedInput || isSpendingTx) {
          // This tx spent BTC from a pasted address → outputs are "sent to"
          for (const p of parts) {
            if (p.role !== "output") continue;
            if (addressSet.has(p.address)) continue;
            if (p.address) {
              const s = sentToTxCounts.get(p.address) ?? new Set<string>();
              s.add(txid);
              sentToTxCounts.set(p.address, s);
            }
          }
          // For spending txids where pasted addr is blank-input, flag unresolved sent-to
          if (isSpendingTx && !hasPastedInput) {
            unresolvedSentToTxids.add(txid);
          }
        }
      }

      const receivedFrom: CounterpartyEntry[] = Array.from(receivedFromTxCounts.entries())
        .map(([address, txSet]) => ({ address, txCount: txSet.size }))
        .sort((a, b) => b.txCount - a.txCount);

      const sentTo: CounterpartyEntry[] = Array.from(sentToTxCounts.entries())
        .map(([address, txSet]) => ({ address, txCount: txSet.size }))
        .sort((a, b) => b.txCount - a.txCount);

      const noDataAddresses = perAddress.filter((pa) => !pa.hasData).map((pa) => pa.address);

      setReportData({
        combinedYearRows,
        perAddress,
        receivedFrom,
        sentTo,
        unresolvedReceivedFromCount: unresolvedReceivedFromTxids.size,
        unresolvedSentToCount: unresolvedSentToTxids.size,
        noDataAddresses,
      });
      setHasGenerated(true);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") return;
      console.error("Annual activity report error:", err);
    } finally {
      setIsGenerating(false);
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-none px-6 pt-6 pb-4 border-b">
        <div className="flex items-center gap-2 mb-1">
          <CalendarRange className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Annual Activity Report</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Paste Bitcoin addresses to see year-by-year transaction counts, BTC received and spent,
          and common counterparties — all from locally synced data.
        </p>
      </div>

      <div className="flex-1 overflow-auto px-6 py-4 space-y-6">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Addresses</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="address-input">
                Paste addresses (one per line, or comma / semicolon separated)
              </Label>
              <Textarea
                id="address-input"
                placeholder={"bc1q...\nbc1q...\n1A1z..."}
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                rows={5}
                className="font-mono text-xs"
                data-testid="textarea-addresses"
              />
            </div>
            <Button
              onClick={generate}
              disabled={isGenerating || pastedText.trim().length === 0}
              data-testid="button-generate"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Generating…
                </>
              ) : (
                "Generate"
              )}
            </Button>
          </CardContent>
        </Card>

        {hasGenerated && !reportData && (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <AlertCircle className="h-4 w-4" />
            No addresses provided.
          </div>
        )}

        {reportData && (
          <>
            {reportData.noDataAddresses.length > 0 && (
              <div
                className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400"
                data-testid="warning-no-data"
              >
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium mb-1">
                    {reportData.noDataAddresses.length} address
                    {reportData.noDataAddresses.length !== 1 ? "es have" : " has"} no locally
                    synced data and
                    {reportData.noDataAddresses.length !== 1 ? " are" : " is"} excluded from the
                    report:
                  </p>
                  <ul className="space-y-0.5">
                    {reportData.noDataAddresses.map((a) => (
                      <li key={a} className="font-mono text-xs break-all">
                        {a}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            <Card data-testid="card-combined-activity">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">
                  Combined Annual Activity
                  <Badge variant="secondary" className="ml-2 text-xs">
                    {reportData.perAddress.filter((p) => p.hasData).length} address
                    {reportData.perAddress.filter((p) => p.hasData).length !== 1 ? "es" : ""}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {reportData.combinedYearRows.length === 0 ? (
                  <div className="flex items-center gap-2 text-muted-foreground text-sm">
                    <AlertCircle className="h-4 w-4" />
                    No synced transaction data for any of the provided addresses.
                  </div>
                ) : (
                  <YearTable rows={reportData.combinedYearRows} data-testid="table-combined" />
                )}
              </CardContent>
            </Card>

            {reportData.perAddress.length > 1 && (
              <Card data-testid="card-per-address">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Per-Address Breakdown</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {reportData.perAddress.map((pa) => (
                    <div key={pa.address} className="border rounded-md overflow-hidden">
                      <button
                        className="w-full flex items-center justify-between px-3 py-2.5 text-sm font-medium hover-elevate active-elevate-2 text-left"
                        onClick={() => toggleAddress(pa.address)}
                        data-testid={`button-toggle-address-${pa.address}`}
                      >
                        <span className="font-mono text-xs break-all">{pa.address}</span>
                        <div className="flex items-center gap-2 flex-none ml-2">
                          {!pa.hasData && (
                            <Badge
                              variant="outline"
                              className="text-xs border-amber-500/60 text-amber-700 dark:text-amber-400"
                            >
                              No data
                            </Badge>
                          )}
                          {expandedAddresses.has(pa.address) ? (
                            <ChevronDown className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          )}
                        </div>
                      </button>
                      {expandedAddresses.has(pa.address) && (
                        <div className="px-3 pb-3 pt-1">
                          <YearTable
                            rows={pa.yearRows}
                            data-testid={`table-address-${pa.address}`}
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            <Separator />

            <Card data-testid="card-counterparties">
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-center gap-3">
                  <CardTitle className="text-base">Common Counterparties</CardTitle>
                  <div className="flex items-center gap-2">
                    <Label
                      htmlFor="min-tx"
                      className="text-sm text-muted-foreground whitespace-nowrap"
                    >
                      Min transactions:
                    </Label>
                    <Input
                      id="min-tx"
                      type="number"
                      min={1}
                      value={minTx}
                      onChange={(e) =>
                        setMinTx(Math.max(1, parseInt(e.target.value, 10) || 1))
                      }
                      className="w-20"
                      data-testid="input-min-tx"
                    />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <h3 className="text-sm font-medium">Received From</h3>
                  <p className="text-xs text-muted-foreground">
                    Input-side addresses that funded transactions where the pasted addresses
                    received BTC.
                  </p>
                  <CounterpartyList
                    entries={reportData.receivedFrom}
                    minTx={minTx}
                    unresolvedCount={reportData.unresolvedReceivedFromCount}
                    data-testid="list-received-from"
                  />
                </div>
                <div className="space-y-2">
                  <h3 className="text-sm font-medium">Sent To</h3>
                  <p className="text-xs text-muted-foreground">
                    Output-side addresses that received BTC in transactions where the pasted
                    addresses spent.
                  </p>
                  <CounterpartyList
                    entries={reportData.sentTo}
                    minTx={minTx}
                    unresolvedCount={reportData.unresolvedSentToCount}
                    data-testid="list-sent-to"
                  />
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

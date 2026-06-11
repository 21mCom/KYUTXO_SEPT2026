import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useDbChangeSignal } from "@/hooks/use-db-change-signal";
import { useLiveQuery } from "dexie-react-hooks";
import { BlockchainTransaction, TransactionParticipant, Record as DbRecord } from "@/lib/database";
import { getRecordsByType } from "@/lib/data/record-crud";
import { getTransactionsByTxids } from "@/lib/data/transaction-crud";
import { getBtcUsdPriceData } from "@/lib/data/price-data-crud";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Loader2,
  ChevronDown,
  ChevronRight,
  Wallet,
  Copy,
  Check,
} from "lucide-react";
import { SiBitcoin } from "react-icons/si";
import { getParticipantsByAddresses } from "@/lib/dataFacade";

type GroupBy = "wallet" | "seed" | "owner" | "tag" | "category";
type SortBy = "balance-desc" | "balance-asc" | "name-asc" | "name-desc" | "addresses-desc";
type DisplayUnit = "btc" | "sats";

interface GroupBalance {
  name: string;
  totalSats: number;
  addressCount: number;
  utxoCount: number;
  addresses: { address: string; sats: number; utxoCount: number; label?: string }[];
}

function formatBtc(sats: number, unit: DisplayUnit): string {
  if (unit === "sats") {
    return sats.toLocaleString() + " sats";
  }
  return (sats / 100_000_000).toFixed(8) + " BTC";
}

function formatUsd(amount: number): string {
  return "$" + amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getGroupKeys(record: DbRecord, groupBy: GroupBy): string[] {
  switch (groupBy) {
    case "wallet":
      return [record.walletName || "Unassigned"];
    case "seed":
      return [record.seedName || "Unassigned"];
    case "owner":
      return [record.owner || "Unassigned"];
    case "tag":
      return record.tags && record.tags.length > 0 ? record.tags : ["Untagged"];
    case "category":
      return record.categories && record.categories.length > 0 ? record.categories : ["Uncategorized"];
  }
}

function computeBalancesForRecords(
  records: DbRecord[],
  participants: TransactionParticipant[],
  txidToTx: Map<string, BlockchainTransaction>,
): Map<number, { sats: number; count: number; record: DbRecord; address: string }> {
  const addressToRec = new Map<string, DbRecord>();
  const recordIdToRec = new Map<number, DbRecord>();
  for (const record of records) {
    if (record.inputString) addressToRec.set(record.inputString, record);
    if (record.id !== undefined) recordIdToRec.set(record.id, record);
  }

  const findRecord = (p: TransactionParticipant): DbRecord | undefined => {
    return addressToRec.get(p.address)
      || (p.recordId ? recordIdToRec.get(p.recordId) : undefined);
  };

  const outputs: TransactionParticipant[] = [];
  const spentOutpoints = new Set<string>();

  for (const p of participants) {
    if (p.role === 'output') {
      outputs.push(p);
    } else if (p.role === 'input') {
      if (p.prevTxid !== undefined && p.prevVout !== undefined) {
        spentOutpoints.add(`${p.prevTxid}:${p.prevVout}`);
      }
    }
  }

  const balanceMap = new Map<number, { sats: number; count: number; record: DbRecord; address: string }>();

  const addToBalance = (output: TransactionParticipant, record: DbRecord) => {
    const rid = record.id!;
    const existing = balanceMap.get(rid);
    if (existing) {
      existing.sats += output.amount;
      existing.count += 1;
    } else {
      balanceMap.set(rid, {
        sats: output.amount,
        count: 1,
        record,
        address: record.inputString || output.address,
      });
    }
  };

  const hasExactData = spentOutpoints.size > 0;

  if (hasExactData) {
    for (const output of outputs) {
      const tx = txidToTx.get(output.txid);
      if (!tx || tx.blockTime <= 0) continue;
      const outpoint = `${output.txid}:${output.vout ?? 0}`;
      if (spentOutpoints.has(outpoint)) continue;
      const record = findRecord(output);
      if (!record || record.id === undefined) continue;
      addToBalance(output, record);
    }
    return balanceMap;
  }

  const outputsWithTime = outputs.map(output => {
    const tx = txidToTx.get(output.txid);
    return { output, blockTime: tx?.blockTime ?? 0 };
  }).filter(o => o.blockTime > 0);

  outputsWithTime.sort((a, b) => a.blockTime - b.blockTime);

  const inputs = participants.filter(p => p.role === 'input');
  const inputsWithTime = inputs.map(input => {
    const tx = txidToTx.get(input.txid);
    return { input, blockTime: tx?.blockTime ?? 0 };
  }).filter(i => i.blockTime > 0);

  inputsWithTime.sort((a, b) => a.blockTime - b.blockTime);

  const inputsByAddressAmount = new Map<string, { input: TransactionParticipant; blockTime: number }[]>();
  for (const item of inputsWithTime) {
    const key = `${item.input.address}:${item.input.amount}`;
    const existing = inputsByAddressAmount.get(key) || [];
    existing.push(item);
    inputsByAddressAmount.set(key, existing);
  }

  const matchedInputIndices = new Map<string, number>();

  for (const { output, blockTime } of outputsWithTime) {
    const key = `${output.address}:${output.amount}`;
    const matchingInputs = inputsByAddressAmount.get(key) || [];
    const currentIndex = matchedInputIndices.get(key) || 0;

    const spendingInput = matchingInputs.find((item, idx) =>
      idx >= currentIndex && item.blockTime > blockTime
    );

    if (spendingInput) {
      const spendIdx = matchingInputs.indexOf(spendingInput);
      matchedInputIndices.set(key, spendIdx + 1);
    } else {
      const record = findRecord(output);
      if (record && record.id !== undefined) {
        addToBalance(output, record);
      }
    }
  }

  return balanceMap;
}

export default function BalanceOverview() {
  const [groupBy, setGroupBy] = useState<GroupBy>("wallet");
  const [sortBy, setSortBy] = useState<SortBy>("balance-desc");
  const [displayUnit, setDisplayUnit] = useState<DisplayUnit>("btc");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const txDbSignal = useDbChangeSignal(['blockchainTransactions']);
  const computationId = useRef(0);

  const [groupBalances, setGroupBalances] = useState<Map<string, GroupBalance>>(new Map());
  const [uniqueAddressBalances, setUniqueAddressBalances] = useState<Map<number, { sats: number; count: number }>>(new Map());
  const [computingGroup, setComputingGroup] = useState<string | null>(null);
  const [computedCount, setComputedCount] = useState(0);

  const rawRecords = useLiveQuery(
    () => getRecordsByType('address'),
    []
  );

  const priceData = useLiveQuery(
    () => getBtcUsdPriceData(),
    []
  );

  const processedRecords = rawRecords ?? [];

  const recordGroups = useMemo(() => {
    const groupMap = new Map<string, DbRecord[]>();
    for (const record of processedRecords) {
      if (record.type !== 'address' || !record.inputString) continue;
      const keys = getGroupKeys(record, groupBy);
      for (const key of keys) {
        const existing = groupMap.get(key) || [];
        existing.push(record);
        groupMap.set(key, existing);
      }
    }
    return groupMap;
  }, [processedRecords, groupBy]);

  useEffect(() => {
    computationId.current += 1;
    const thisId = computationId.current;
    const abortController = new AbortController();
    setGroupBalances(new Map());
    setUniqueAddressBalances(new Map());
    setComputingGroup(null);
    setComputedCount(0);

    if (recordGroups.size === 0) return () => { abortController.abort(); };

    const computeGroups = async () => {
      const entries = Array.from(recordGroups.entries());

      for (let gi = 0; gi < entries.length; gi++) {
        const [groupName, records] = entries[gi];
        if (thisId !== computationId.current) return;
        setComputingGroup(groupName);

        const addresses = records.map(r => r.inputString!);
        let participants: TransactionParticipant[];
        try {
          participants = await getParticipantsByAddresses(addresses, abortController.signal);
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') return;
          participants = [];
        }
        if (thisId !== computationId.current) return;

        const txids = new Set<string>();
        for (const p of participants) txids.add(p.txid);

        const txidToTx = new Map<string, BlockchainTransaction>();
        if (txids.size > 0) {
          const txidArray = Array.from(txids);
          const batchSize = 500;
          for (let i = 0; i < txidArray.length; i += batchSize) {
            const batch = txidArray.slice(i, i + batchSize);
            const txs = await getTransactionsByTxids(batch);
            for (const tx of txs) txidToTx.set(tx.txid, tx);
            if (thisId !== computationId.current) return;
          }
        }

        const balanceMap = computeBalancesForRecords(records, participants, txidToTx);
        if (thisId !== computationId.current) return;

        const groupBalance: GroupBalance = {
          name: groupName,
          totalSats: 0,
          addressCount: 0,
          utxoCount: 0,
          addresses: [],
        };

        for (const { sats, count, record, address } of balanceMap.values()) {
          groupBalance.totalSats += sats;
          groupBalance.utxoCount += count;
          groupBalance.addressCount += 1;
          groupBalance.addresses.push({
            address,
            sats,
            utxoCount: count,
            label: record.label || undefined,
          });
        }

        if (balanceMap.size === 0) {
          setComputedCount(gi + 1);
          await new Promise(r => setTimeout(r, 0));
          continue;
        }

        groupBalance.addresses.sort((a, b) => b.sats - a.sats);

        setGroupBalances(prev => {
          const next = new Map(prev);
          next.set(groupName, groupBalance);
          return next;
        });

        setUniqueAddressBalances(prev => {
          const next = new Map(prev);
          for (const [recordId, bal] of balanceMap.entries()) {
            if (!next.has(recordId)) {
              next.set(recordId, { sats: bal.sats, count: bal.count });
            }
          }
          return next;
        });

        setComputedCount(gi + 1);

        await new Promise(r => setTimeout(r, 0));
      }

      setComputingGroup(null);
    };

    computeGroups();
    return () => { abortController.abort(); };
  }, [recordGroups, txDbSignal]);

  const latestPrice = useMemo(() => {
    if (!priceData || priceData.length === 0) return null;
    const sorted = [...priceData].sort((a, b) => b.date.localeCompare(a.date));
    return { date: sorted[0].date, price: sorted[0].close };
  }, [priceData]);

  const groups = useMemo(() => {
    const result = Array.from(groupBalances.values());

    switch (sortBy) {
      case "balance-desc":
        result.sort((a, b) => b.totalSats - a.totalSats);
        break;
      case "balance-asc":
        result.sort((a, b) => a.totalSats - b.totalSats);
        break;
      case "name-asc":
        result.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "name-desc":
        result.sort((a, b) => b.name.localeCompare(a.name));
        break;
      case "addresses-desc":
        result.sort((a, b) => b.addressCount - a.addressCount);
        break;
    }

    return result;
  }, [groupBalances, sortBy]);

  const { totalBalance, totalAddresses } = useMemo(() => {
    let total = 0;
    for (const { sats } of uniqueAddressBalances.values()) {
      total += sats;
    }
    return { totalBalance: total, totalAddresses: uniqueAddressBalances.size };
  }, [uniqueAddressBalances]);

  const toggleGroup = useCallback((name: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }, []);

  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const copyAddress = useCallback((address: string) => {
    navigator.clipboard.writeText(address);
    setCopiedAddress(address);
    setTimeout(() => setCopiedAddress(null), 2000);
  }, []);

  const isLoading = !rawRecords;
  const isComputing = computingGroup !== null;
  const totalGroupCount = recordGroups.size;

  const groupByLabel: Record<GroupBy, string> = {
    wallet: "Wallet",
    seed: "Seed",
    owner: "Owner",
    tag: "Tag",
    category: "Category",
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-none p-4 pb-2 border-b">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <SiBitcoin className="h-5 w-5 text-[hsl(var(--primary))]" />
            <h1 className="text-lg font-semibold" data-testid="text-page-title">Balance</h1>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Select value={groupBy} onValueChange={(v) => setGroupBy(v as GroupBy)}>
              <SelectTrigger className="w-[140px]" data-testid="select-group-by">
                <SelectValue placeholder="Group by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="wallet">By Wallet</SelectItem>
                <SelectItem value="seed">By Seed</SelectItem>
                <SelectItem value="owner">By Owner</SelectItem>
                <SelectItem value="tag">By Tag</SelectItem>
                <SelectItem value="category">By Category</SelectItem>
              </SelectContent>
            </Select>

            <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortBy)}>
              <SelectTrigger className="w-[160px]" data-testid="select-sort-by">
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="balance-desc">Highest Balance</SelectItem>
                <SelectItem value="balance-asc">Lowest Balance</SelectItem>
                <SelectItem value="name-asc">Name A-Z</SelectItem>
                <SelectItem value="name-desc">Name Z-A</SelectItem>
                <SelectItem value="addresses-desc">Most Addresses</SelectItem>
              </SelectContent>
            </Select>

            <Button
              variant="outline"
              size="sm"
              onClick={() => setDisplayUnit(u => u === "btc" ? "sats" : "btc")}
              data-testid="button-toggle-unit"
            >
              {displayUnit === "btc" ? "BTC" : "sats"}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Loading data...</p>
          </div>
        ) : processedRecords.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <Wallet className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No address records found</p>
            <p className="text-xs text-muted-foreground/60">
              Add addresses first to see balances
            </p>
          </div>
        ) : groups.length === 0 && !isComputing ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <Wallet className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No UTXO data found</p>
            <p className="text-xs text-muted-foreground/60">
              Sync your addresses first to see balances
            </p>
          </div>
        ) : (
          <div className="space-y-3 max-w-3xl mx-auto">
            <Card data-testid="card-total-balance">
              <CardContent className="py-4 px-5">
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
                      Total Balance
                      {isComputing && (
                        <span className="ml-2 text-muted-foreground/60">
                          ({computedCount}/{totalGroupCount})
                        </span>
                      )}
                    </p>
                    <div className="flex items-center gap-2">
                      <p className="text-2xl font-bold font-mono" data-testid="text-total-balance">
                        {formatBtc(totalBalance, displayUnit)}
                      </p>
                      {isComputing && (
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      )}
                    </div>
                    {latestPrice && (
                      <p className="text-sm text-muted-foreground mt-0.5" data-testid="text-total-usd">
                        {formatUsd((totalBalance / 100_000_000) * latestPrice.price)}
                      </p>
                    )}
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">{groups.length} {groupByLabel[groupBy].toLowerCase()}{groups.length !== 1 ? 's' : ''}</p>
                    <p className="text-xs text-muted-foreground">{totalAddresses} addresses</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {groups.map((group) => {
              const isExpanded = expandedGroups.has(group.name);
              const percentage = totalBalance > 0 ? (group.totalSats / totalBalance) * 100 : 0;
              const usdValue = latestPrice ? (group.totalSats / 100_000_000) * latestPrice.price : null;

              return (
                <Card key={group.name} data-testid={`card-group-${group.name}`}>
                  <div
                    className="flex items-center gap-3 py-3 px-4 cursor-pointer hover-elevate rounded-md"
                    onClick={() => toggleGroup(group.name)}
                    data-testid={`button-expand-${group.name}`}
                  >
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground flex-none" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground flex-none" />
                    )}

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium truncate" data-testid={`text-group-name-${group.name}`}>
                          {group.name}
                        </span>
                        <Badge variant="secondary" className="text-xs flex-none">
                          {group.addressCount} addr
                        </Badge>
                        <Badge variant="outline" className="text-xs flex-none">
                          {group.utxoCount} UTXO{group.utxoCount !== 1 ? 's' : ''}
                        </Badge>
                      </div>
                    </div>

                    <div className="flex-none text-right">
                      <p className="font-mono text-sm font-medium" data-testid={`text-group-balance-${group.name}`}>
                        {formatBtc(group.totalSats, displayUnit)}
                      </p>
                      <div className="flex items-center gap-1.5 justify-end">
                        {usdValue !== null && (
                          <span className="text-xs text-muted-foreground">
                            {formatUsd(usdValue)}
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground/60">
                          {percentage.toFixed(1)}%
                        </span>
                      </div>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="border-t px-4 py-2">
                      <div className="space-y-1">
                        {group.addresses.map((addr) => {
                          return (
                            <div
                              key={addr.address}
                              className="flex items-center gap-2 py-1.5 text-sm"
                              data-testid={`row-address-${addr.address}`}
                            >
                              <div className="flex-1 min-w-0 flex items-center gap-2">
                                <span className="font-mono text-xs text-muted-foreground truncate max-w-[200px]">
                                  {addr.address}
                                </span>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    copyAddress(addr.address);
                                  }}
                                  className="flex-none text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                                  data-testid={`button-copy-${addr.address}`}
                                >
                                  {copiedAddress === addr.address ? (
                                    <Check className="h-3 w-3" />
                                  ) : (
                                    <Copy className="h-3 w-3" />
                                  )}
                                </button>
                                {addr.label && (
                                  <span className="text-xs text-muted-foreground/70 truncate max-w-[120px]">
                                    {addr.label}
                                  </span>
                                )}
                              </div>

                              <div className="flex-none flex items-center gap-2">
                                <span className="text-xs text-muted-foreground/50">
                                  {addr.utxoCount} UTXO{addr.utxoCount !== 1 ? 's' : ''}
                                </span>
                                <span className="font-mono text-xs font-medium w-[130px] text-right">
                                  {formatBtc(addr.sats, displayUnit)}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </Card>
              );
            })}

            {isComputing && computingGroup && (
              <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Computing {computingGroup}...</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

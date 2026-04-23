import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useAsyncMemo, yieldToUI, checkAbort } from "@/hooks/use-async-memo";
import { db, BlockchainTransaction, TransactionParticipant, Record as DbRecord } from "@/lib/database";

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

interface AddressBalance {
  sats: number;
  count: number;
  record: DbRecord;
  address: string;
}

function formatUsd(amount: number): string {
  return "$" + amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function BalanceOverview() {
  const [groupBy, setGroupBy] = useState<GroupBy>("wallet");
  const [sortBy, setSortBy] = useState<SortBy>("balance-desc");
  const [displayUnit, setDisplayUnit] = useState<DisplayUnit>("btc");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const transactions = useLiveQuery(
    () => db.blockchainTransactions.toArray(),
    []
  );

  const [participants, setParticipants] = useState<TransactionParticipant[] | undefined>(undefined);
  const participantsRequestId = useRef(0);

  const rawRecords = useLiveQuery(
    () => db.records.where('type').equals('address').toArray(),
    []
  );

  const priceData = useLiveQuery(
    () => db.priceData
      .where('asset').equals('BTC')
      .filter(p => p.currency === 'USD')
      .toArray(),
    []
  );

  const processedRecords = rawRecords ?? [];

  useEffect(() => {
    if (!processedRecords || processedRecords.length === 0) {
      setParticipants(undefined);
      return;
    }

    const addresses = processedRecords
      .filter(r => r.type === 'address' && r.inputString)
      .map(r => r.inputString!);

    if (addresses.length === 0) {
      setParticipants([]);
      return;
    }

    participantsRequestId.current += 1;
    const thisRequestId = participantsRequestId.current;

    getParticipantsByAddresses(addresses)
      .then(result => {
        if (thisRequestId === participantsRequestId.current) {
          setParticipants(result);
        }
      })
      .catch(() => {
        if (thisRequestId === participantsRequestId.current) {
          setParticipants([]);
        }
      });
  }, [processedRecords]);

  const addressToRecord = useMemo(() => {
    const map = new Map<string, DbRecord>();
    processedRecords.forEach(record => {
      if (record.type === 'address' && record.inputString) {
        map.set(record.inputString, record);
      }
    });
    return map;
  }, [processedRecords]);

  const recordIdToRecord = useMemo(() => {
    const map = new Map<number, DbRecord>();
    processedRecords.forEach(record => {
      if (record.type === 'address' && record.id !== undefined) {
        map.set(record.id, record);
      }
    });
    return map;
  }, [processedRecords]);

  const txidToTx = useMemo(() => {
    const map = new Map<string, BlockchainTransaction>();
    transactions?.forEach(tx => {
      map.set(tx.txid, tx);
    });
    return map;
  }, [transactions]);

  const latestPrice = useMemo(() => {
    if (!priceData || priceData.length === 0) return null;
    const sorted = [...priceData].sort((a, b) => b.date.localeCompare(a.date));
    return { date: sorted[0].date, price: sorted[0].close };
  }, [priceData]);

  const { value: addressBalances, isComputing } = useAsyncMemo(async (signal) => {
    if (!participants || !transactions) return [] as AddressBalance[];

    const findRecord = (p: TransactionParticipant): DbRecord | undefined => {
      return addressToRecord.get(p.address)
        || (p.recordId ? recordIdToRecord.get(p.recordId) : undefined);
    };

    const outputs: TransactionParticipant[] = [];
    const spentOutpoints = new Set<string>();

    for (let i = 0; i < participants.length; i++) {
      const p = participants[i];
      if (p.role === 'output') {
        outputs.push(p);
      } else if (p.role === 'input') {
        if (p.prevTxid !== undefined && p.prevVout !== undefined) {
          spentOutpoints.add(`${p.prevTxid}:${p.prevVout}`);
        }
      }
      if (i % 2000 === 1999) {
        checkAbort(signal);
        await yieldToUI();
      }
    }

    const hasExactData = spentOutpoints.size > 0;
    const balanceMap = new Map<number, AddressBalance>();

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

    if (hasExactData) {
      for (let i = 0; i < outputs.length; i++) {
        const output = outputs[i];
        const tx = txidToTx.get(output.txid);
        if (!tx || tx.blockTime <= 0) continue;

        const outpoint = `${output.txid}:${output.vout ?? 0}`;
        if (spentOutpoints.has(outpoint)) continue;

        const record = findRecord(output);
        if (!record || record.id === undefined) continue;

        addToBalance(output, record);

        if (i % 2000 === 1999) {
          checkAbort(signal);
          await yieldToUI();
        }
      }
      return Array.from(balanceMap.values());
    }

    const outputsWithTime = outputs.map(output => {
      const tx = txidToTx.get(output.txid);
      return { output, blockTime: tx?.blockTime ?? 0 };
    }).filter(o => o.blockTime > 0);

    outputsWithTime.sort((a, b) => a.blockTime - b.blockTime);

    checkAbort(signal);
    await yieldToUI();

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

    checkAbort(signal);
    await yieldToUI();

    const matchedInputIndices = new Map<string, number>();

    for (let i = 0; i < outputsWithTime.length; i++) {
      const { output, blockTime } = outputsWithTime[i];
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

      if (i % 2000 === 1999) {
        checkAbort(signal);
        await yieldToUI();
      }
    }

    return Array.from(balanceMap.values());
  }, [participants, transactions, txidToTx, addressToRecord, recordIdToRecord], [] as AddressBalance[]);

  const groups = useMemo(() => {
    if (addressBalances.length === 0) return [];

    const groupMap = new Map<string, GroupBalance>();

    for (const { address, sats, count, record } of addressBalances) {
      let groupKeys: string[] = [];

      switch (groupBy) {
        case "wallet":
          groupKeys = [record.walletName || "Unassigned"];
          break;
        case "seed":
          groupKeys = [record.seedName || "Unassigned"];
          break;
        case "owner":
          groupKeys = [record.owner || "Unassigned"];
          break;
        case "tag":
          groupKeys = record.tags && record.tags.length > 0 ? record.tags : ["Untagged"];
          break;
        case "category":
          groupKeys = record.categories && record.categories.length > 0 ? record.categories : ["Uncategorized"];
          break;
      }

      for (const key of groupKeys) {
        const existing = groupMap.get(key) || {
          name: key,
          totalSats: 0,
          addressCount: 0,
          utxoCount: 0,
          addresses: [],
        };

        existing.totalSats += sats;
        existing.utxoCount += count;
        existing.addressCount += 1;
        existing.addresses.push({
          address,
          sats,
          utxoCount: count,
          label: record.label || undefined,
        });

        groupMap.set(key, existing);
      }
    }

    const result = Array.from(groupMap.values());

    result.forEach(g => {
      g.addresses.sort((a, b) => b.sats - a.sats);
    });

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
  }, [addressBalances, groupBy, sortBy]);

  const totalBalance = useMemo(() => {
    let total = 0;
    for (const { sats } of addressBalances) {
      total += sats;
    }
    return total;
  }, [addressBalances]);

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

  const isLoading = !participants || !transactions || !rawRecords;

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
        ) : isComputing ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Computing balances...</p>
          </div>
        ) : addressBalances.length === 0 ? (
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
                    <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Total Balance</p>
                    <p className="text-2xl font-bold font-mono" data-testid="text-total-balance">
                      {formatBtc(totalBalance, displayUnit)}
                    </p>
                    {latestPrice && (
                      <p className="text-sm text-muted-foreground mt-0.5" data-testid="text-total-usd">
                        {formatUsd((totalBalance / 100_000_000) * latestPrice.price)}
                      </p>
                    )}
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">{groups.length} {groupByLabel[groupBy].toLowerCase()}{groups.length !== 1 ? 's' : ''}</p>
                    <p className="text-xs text-muted-foreground">{addressBalances.length} addresses</p>
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
                          const addrPercentage = group.totalSats > 0
                            ? (addr.sats / group.totalSats) * 100
                            : 0;

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
          </div>
        )}
      </div>
    </div>
  );
}

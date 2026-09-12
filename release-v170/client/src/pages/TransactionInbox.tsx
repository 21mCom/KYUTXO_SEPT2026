import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useVirtualizer } from "@tanstack/react-virtual";
import { addMonths, endOfDay, format, formatDistanceToNow } from "date-fns";
import { Archive, Clock3, Inbox, RotateCcw, Search } from "lucide-react";
import { type BlockchainTransaction, type Record, type TransactionCurationState, type TransactionParticipant } from "@/lib/database";
import { bulkGetRecords, createRecord, getRecordsByInputStrings, updateRecord } from "@/lib/data/record-crud";
import {
  countTransactionCurations,
  getTransactionsByCurationState,
  updateTransactionCuration,
  sanitizeSavedInboxViews,
} from "@/lib/data/transaction-crud";
import { ensureSettings, getSettings, updateSettings } from "@/lib/data/settings-crud";
import type { SavedInboxView, SavedInboxViewFilters } from "@/lib/db-types";
import { fetchParticipantsByTxids } from "@/lib/participant-repo";
import { useDbChangeSignal } from "@/hooks/use-db-change-signal";
import { TransactionCard } from "@/pages/Transactions";
import {
  TransactionSearchFilters,
  defaultFilters,
  filterByDateAndAmount,
  UNASSIGNED_OWNER_VALUE,
  type SearchFilters,
  type EntityFilterOptions,
} from "@/components/TransactionSearchFilters";
import { getCategories, getOwners, getRecordEntityValues, getSeedNames, getTags, getWalletNames } from "@/lib/data/vocabulary-crud";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useRecordPreview } from "@/contexts/RecordPreviewContext";

type InboxTab = TransactionCurationState;
type UndoEntry = Array<{
  txid: string;
  state: TransactionCurationState;
  snoozedUntil?: number;
}>;

const PAGE_LIMIT = 500;
const SNOOZE_WEEK = 7 * 24 * 60 * 60 * 1000;

function serializeInboxFilters(filters: SearchFilters): SavedInboxViewFilters {
  return {
    dateMode: filters.dateMode,
    dateStart: filters.dateStart?.toISOString(),
    dateEnd: filters.dateEnd?.toISOString(),
    dateExact: filters.dateExact?.toISOString(),
    amountMode: filters.amountMode,
    amountMinBtc: filters.amountMinBtc,
    amountMaxBtc: filters.amountMaxBtc,
    amountExactBtc: filters.amountExactBtc,
    entityAddress: filters.entityAddress,
    entityWallet: filters.entityWallet,
    entitySeed: filters.entitySeed,
    entityOwner: filters.entityOwner,
    entityTag: filters.entityTag,
    entityCategory: filters.entityCategory,
  };
}

function parseSavedDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function deserializeInboxFilters(filters: SavedInboxViewFilters): SearchFilters {
  return {
    dateMode: filters.dateMode,
    dateStart: parseSavedDate(filters.dateStart),
    dateEnd: parseSavedDate(filters.dateEnd),
    dateExact: parseSavedDate(filters.dateExact),
    amountMode: filters.amountMode,
    amountMinBtc: filters.amountMinBtc,
    amountMaxBtc: filters.amountMaxBtc,
    amountExactBtc: filters.amountExactBtc,
    entityAddress: filters.entityAddress,
    entityWallet: filters.entityWallet,
    entitySeed: filters.entitySeed,
    entityOwner: filters.entityOwner,
    entityTag: filters.entityTag,
    entityCategory: filters.entityCategory,
  };
}

function dateInputValue(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

function dateInputToEndOfDay(value: string): number | undefined {
  const [year, month, day] = value.split("-").map(Number);
  if (![year, month, day].every(Number.isFinite)) return undefined;
  const date = endOfDay(new Date(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? undefined : date.getTime();
}

function SnoozePicker({
  disabled,
  onSnooze,
  testId,
}: {
  disabled?: boolean;
  onSnooze: (until: number) => void;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const [customDate, setCustomDate] = useState("");
  const today = dateInputValue(new Date());
  const choose = (until: number) => {
    onSnooze(until);
    setOpen(false);
  };
  const chooseCustom = () => {
    const until = dateInputToEndOfDay(customDate);
    if (until === undefined || until <= Date.now()) return;
    choose(until);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" disabled={disabled} data-testid={testId}>
          <Clock3 className="h-4 w-4 mr-1" />Snooze
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 space-y-3" align="end">
        <div>
          <p className="font-medium text-sm">Snooze until</p>
          <p className="text-xs text-muted-foreground">The transaction stays in the queue and becomes due later.</p>
        </div>
        <div className="grid gap-2">
          <Button variant="outline" className="justify-start" onClick={() => choose(Date.now() + 24 * 60 * 60 * 1000)} data-testid={`${testId}-tomorrow`}>
            Tomorrow
          </Button>
          <Button variant="outline" className="justify-start" onClick={() => choose(Date.now() + SNOOZE_WEEK)} data-testid={`${testId}-week`}>
            1 week
          </Button>
          <Button variant="outline" className="justify-start" onClick={() => choose(addMonths(new Date(), 1).getTime())} data-testid={`${testId}-month`}>
            1 month
          </Button>
        </div>
        <div className="space-y-2 border-t pt-3">
          <label htmlFor={`${testId}-date`} className="text-sm font-medium">Custom date</label>
          <Input
            id={`${testId}-date`}
            type="date"
            min={today}
            value={customDate}
            onChange={event => setCustomDate(event.target.value)}
            data-testid={`${testId}-date`}
          />
          <Button className="w-full" disabled={!customDate} onClick={chooseCustom} data-testid={`${testId}-custom`}>
            Snooze until date
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default function TransactionInbox() {
  const { toast } = useToast();
  const { openTransactionAnnotation } = useRecordPreview();
  const [tab, setTab] = useState<InboxTab>("new");
  const [rows, setRows] = useState<BlockchainTransaction[]>([]);
  const [nextBeforeId, setNextBeforeId] = useState<number | undefined>();
  const [hasMore, setHasMore] = useState(true);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<SearchFilters>(defaultFilters);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [undo, setUndo] = useState<UndoEntry | null>(null);
  const [viewName, setViewName] = useState("");
  const [activeViewId, setActiveViewId] = useState("");
  const [initialPageLoading, setInitialPageLoading] = useState(true);
  const [initialPageFailed, setInitialPageFailed] = useState(false);
  const [loadRetry, setLoadRetry] = useState(0);
  const dbSignal = useDbChangeSignal(["blockchainTransactions", "transactionParticipants", "records", "settings"], 100);
  const mountedRef = useRef(false);
  const loadGeneration = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const settings = useLiveQuery(() => getSettings("default"), [dbSignal]);
  const savedViews = useMemo(
    () => sanitizeSavedInboxViews(settings?.savedInboxViews) ?? [],
    [settings?.savedInboxViews],
  );

  const counts = useLiveQuery(async () => {
    const [fresh, snoozed, annotated, ignored] = await Promise.all([
      countTransactionCurations(["new"]),
      countTransactionCurations(["snoozed"]),
      countTransactionCurations(["annotated"]),
      countTransactionCurations(["ignored"]),
    ]);
    return { new: fresh, snoozed, annotated, ignored };
  }, [dbSignal], { new: 0, snoozed: 0, annotated: 0, ignored: 0 });

  const loadPage = useCallback(async (reset = false) => {
    const generation = ++loadGeneration.current;
    const isCurrent = () => mountedRef.current && loadGeneration.current === generation;
    const beforeId = reset ? undefined : nextBeforeId;
    const page = await getTransactionsByCurationState(tab, PAGE_LIMIT, beforeId);
    if (!isCurrent()) return;
    setRows(current => {
      const combined = reset ? page : [...current, ...page];
      // Keep dependent participant/record reads bounded while allowing users
      // to traverse arbitrarily deep queues.
      return combined.slice(-PAGE_LIMIT * 4);
    });
    setNextBeforeId(page.length ? page[page.length - 1].id : beforeId);
    setHasMore(page.length === PAGE_LIMIT);
  }, [tab, nextBeforeId]);

  useEffect(() => {
    const generation = ++loadGeneration.current;
    const isCurrent = () => mountedRef.current && loadGeneration.current === generation;
    setInitialPageLoading(true);
    setInitialPageFailed(false);
    void getTransactionsByCurationState(tab, PAGE_LIMIT).then(page => {
      if (!isCurrent()) return;
      setRows(page);
      setNextBeforeId(page.length ? page[page.length - 1].id : undefined);
      setHasMore(page.length === PAGE_LIMIT);
    }).catch(() => {
      if (isCurrent()) setInitialPageFailed(true);
    }).finally(() => {
      if (isCurrent()) setInitialPageLoading(false);
    });
  }, [tab, dbSignal, loadRetry]);
  const txids = useMemo(() => rows.map(row => row.txid), [rows]);
  const participants = useLiveQuery(
    () => txids.length ? fetchParticipantsByTxids(txids) : Promise.resolve([]),
    [txids.join("|"), dbSignal],
    [] as TransactionParticipant[],
  );
  const transactionRecords = useLiveQuery(
    async (): Promise<Record[]> => txids.length
      ? getRecordsByInputStrings(txids)
      : [],
    [txids.join("|"), dbSignal],
    [] as Record[],
  );
  const addressRecords = useLiveQuery(async () => {
    const ids = Array.from(new Set(participants
      .map(participant => participant.recordId)
      .filter((id): id is number => typeof id === "number")));
    return ids.length ? (await bulkGetRecords(ids)).filter((row): row is Record => !!row) : [];
  }, [participants, dbSignal], [] as Record[]);

  const participantsByTxid = useMemo(() => {
    const map = new Map<string, TransactionParticipant[]>();
    for (const participant of participants) {
      const current = map.get(participant.txid) ?? [];
      current.push(participant);
      map.set(participant.txid, current);
    }
    return map;
  }, [participants]);
  const txRecordByTxid = useMemo(
    () => new Map(transactionRecords.map(record => [record.inputString, record])),
    [transactionRecords],
  );
  const addressToRecord = useMemo(
    () => new Map(addressRecords.filter(r => r.inputString).map(r => [r.inputString, r])),
    [addressRecords],
  );
  // Keep the Inbox's local (bounded) filter control aligned with Transactions.
  // Vocabulary and stored record values are merged because older imports may
  // contain an owner that was never added to vocabulary.
  const entityOptions = useLiveQuery(async (): Promise<EntityFilterOptions> => {
    const [wallets, seeds, owners, tags, categories, values] = await Promise.all([
      getWalletNames(), getSeedNames(), getOwners(), getTags(), getCategories(), getRecordEntityValues(),
    ]);
    const merge = (vocab: string[], stored: string[]) => {
      const seen = new Set<string>();
      return [...vocab, ...stored].filter(value => {
        const key = value.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    return {
      wallets: merge(wallets.map(value => value.name), values.wallets),
      seeds: merge(seeds.map(value => value.name), values.seeds),
      owners: merge(owners.map(value => value.name), values.owners),
      tags: merge(tags.map(value => value.name), values.tags),
      categories: merge(categories.map(value => value.name), values.categories),
    };
  }, [dbSignal]);

  const visibleRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    let filtered = filterByDateAndAmount(
      rows,
      filters,
      tx => tx.blockTime,
      tx => (participantsByTxid.get(tx.txid) ?? [])
        .filter(p => p.role === "output")
        .reduce((sum, p) => sum + p.amount, 0),
    );
    const matchesAny = (value: string | undefined, selected: string[] | undefined, unassigned = false) =>
      !selected?.length || selected.some(candidate =>
        (unassigned && candidate === UNASSIGNED_OWNER_VALUE && !value?.trim()) ||
        candidate === value,
      );
    const matchesArray = (values: string[] | undefined, selected: string[] | undefined) =>
      !selected?.length || values?.some(value => selected.includes(value)) === true;
    if (filters.entityAddress?.trim() || filters.entityWallet?.length || filters.entitySeed?.length ||
      filters.entityOwner?.length || filters.entityTag?.length || filters.entityCategory?.length) {
      filtered = filtered.filter(tx => {
        const txParticipants = participantsByTxid.get(tx.txid) ?? [];
        const linked = txParticipants
          .map(participant => addressToRecord.get(participant.address))
          .filter((record): record is Record => !!record);
        return (!filters.entityAddress?.trim() || txParticipants.some(p => p.address === filters.entityAddress!.trim())) &&
          (!filters.entityWallet?.length || linked.some(r => matchesAny(r.walletName, filters.entityWallet))) &&
          (!filters.entitySeed?.length || linked.some(r => matchesAny(r.seedName, filters.entitySeed))) &&
          (!filters.entityOwner?.length || linked.some(r => matchesAny(r.owner, filters.entityOwner, true))) &&
          (!filters.entityTag?.length || linked.some(r => matchesArray(r.tags, filters.entityTag))) &&
          (!filters.entityCategory?.length || linked.some(r => matchesArray(r.categories, filters.entityCategory)));
      });
    }
    if (needle) {
      filtered = filtered.filter(tx => {
        const record = txRecordByTxid.get(tx.txid);
        return tx.txid.toLowerCase().includes(needle) ||
          record?.label?.toLowerCase().includes(needle) ||
          record?.notes?.toLowerCase().includes(needle) ||
          (participantsByTxid.get(tx.txid) ?? []).some(p => p.address?.toLowerCase().includes(needle));
      });
    }
    return filtered;
  }, [rows, filters, search, participantsByTxid, txRecordByTxid, addressToRecord]);

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 245,
    overscan: 6,
  });

  const applyState = useCallback(async (
    targetTxids: string[],
    state: TransactionCurationState,
    snoozedUntil?: number,
  ) => {
    if (targetTxids.length === 0) return;
    const previous: UndoEntry = [];
    for (const txid of targetTxids) {
      const row = rows.find(tx => tx.txid === txid);
      if (!row?.curationState) continue;
      previous.push({ txid, state: row.curationState, snoozedUntil: row.snoozedUntil });
      await updateTransactionCuration(txid, state, { snoozedUntil });
    }
    setUndo(previous);
    setSelected(new Set());
  }, [rows]);

  const saveView = async () => {
    const name = viewName.trim();
    if (!name) {
      toast({
        variant: "destructive",
        title: "Name required",
        description: "Give this inbox view a name before saving it.",
      });
      return;
    }
    const existing = savedViews.find(view => view.name.toLowerCase() === name.toLowerCase());
    const savedView: SavedInboxView = {
      id: existing?.id ?? `inbox-view-${Date.now()}-${savedViews.length}`,
      name,
      tab,
      search,
      filters: serializeInboxFilters(filters),
      createdAt: existing?.createdAt ?? Date.now(),
    };
    const nextViews = existing
      ? savedViews.map(view => view.id === existing.id ? savedView : view)
      : [...savedViews, savedView];
    await ensureSettings("default");
    await updateSettings("default", { savedInboxViews: nextViews });
    setActiveViewId(savedView.id);
    setViewName("");
    toast({
      title: existing ? "Inbox view updated" : "Inbox view saved",
      description: `"${name}" is available on this device and in backups.`,
    });
  };

  const loadSavedView = (viewId: string) => {
    setActiveViewId(viewId);
    const view = savedViews.find(candidate => candidate.id === viewId);
    if (!view) return;
    setTab(view.tab);
    setSearch(view.search);
    setFilters(deserializeInboxFilters(view.filters));
    setSelected(new Set());
  };

  const deleteSavedView = async () => {
    const view = savedViews.find(candidate => candidate.id === activeViewId);
    if (!view) return;
    await updateSettings("default", {
      savedInboxViews: savedViews.filter(candidate => candidate.id !== activeViewId),
    });
    setActiveViewId("");
    toast({
      title: "Inbox view deleted",
      description: `"${view.name}" was removed from this device.`,
    });
  };

  const undoLast = async () => {
    if (!undo) return;
    for (const entry of undo) {
      await updateTransactionCuration(entry.txid, entry.state, { snoozedUntil: entry.snoozedUntil });
    }
    setUndo(null);
  };

  const allVisibleSelected = visibleRows.length > 0 && visibleRows.every(tx => selected.has(tx.txid));

  return (
    <div
      className="h-full flex flex-col gap-4 p-4 md:p-6"
      data-testid="transaction-curation-inbox"
      data-navigation-ready={!initialPageLoading && !initialPageFailed ? "true" : "false"}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Inbox className="h-6 w-6" />Transaction Inbox</h1>
          <p className="text-sm text-muted-foreground">Review newly synced owned transactions. Nothing is removed automatically.</p>
        </div>
        {undo && <Button variant="outline" onClick={undoLast} data-testid="button-inbox-undo"><RotateCcw className="h-4 w-4 mr-2" />Undo last action</Button>}
      </div>

      <Tabs value={tab} onValueChange={value => { setTab(value as InboxTab); setSelected(new Set()); }}>
        <TabsList className="flex flex-wrap h-auto">
          {(["new", "snoozed", "annotated", "ignored"] as InboxTab[]).map(state => (
            <TabsTrigger key={state} value={state} data-testid={`tab-inbox-${state}`}>
              {state === "new" ? "New" : state[0].toUpperCase() + state.slice(1)}
              <Badge variant="secondary" className="ml-2">{counts[state]}</Badge>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-64 flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input className="pl-9" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search txid, address, label, or notes…" data-testid="input-inbox-search" />
        </div>
        <TransactionSearchFilters filters={filters} onChange={setFilters} onClear={() => setFilters(defaultFilters)} entityOptions={entityOptions} />
      </div>

      <Card>
        <CardContent className="py-3">
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="h-9 min-w-48 rounded-md border border-input bg-background px-3 text-sm"
              value={activeViewId}
              onChange={event => loadSavedView(event.target.value)}
              aria-label="Saved inbox views"
              data-testid="select-inbox-saved-view"
            >
              <option value="">Saved views…</option>
              {savedViews.map(view => <option key={view.id} value={view.id}>{view.name}</option>)}
            </select>
            <Input
              className="min-w-48 flex-1"
              value={viewName}
              maxLength={100}
              onChange={event => setViewName(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Enter") void saveView();
              }}
              placeholder="Name current view"
              aria-label="Saved view name"
              data-testid="input-inbox-view-name"
            />
            <Button variant="outline" onClick={() => void saveView()} data-testid="button-inbox-save-view">
              Save view
            </Button>
            <Button variant="ghost" disabled={!activeViewId} onClick={() => void deleteSavedView()} data-testid="button-inbox-delete-view">
              Delete view
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Saved views remember this tab, search, and all advanced filters.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">{visibleRows.length.toLocaleString()} loaded</CardTitle>
              <CardDescription>Newest {tab} transactions; the list is capped at {PAGE_LIMIT.toLocaleString()} per view for responsiveness.</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox checked={allVisibleSelected} onCheckedChange={checked => setSelected(checked ? new Set(visibleRows.map(tx => tx.txid)) : new Set())} aria-label="Select all loaded transactions" />
              <Button size="sm" variant="outline" disabled={!selected.size} onClick={() => applyState(Array.from(selected), "ignored")}><Archive className="h-4 w-4 mr-1" />Ignore</Button>
              <SnoozePicker disabled={!selected.size} onSnooze={until => applyState(Array.from(selected), "snoozed", until)} testId="button-inbox-snooze" />
              <Button size="sm" variant="outline" disabled={!selected.size} onClick={() => applyState(Array.from(selected), "new")}>Mark New</Button>
            </div>
          </div>
        </CardHeader>
      </Card>

      {initialPageFailed ? (
        <Card className="border-destructive/50" data-testid="inbox-load-error">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-6">
            <div>
              <p className="font-medium text-destructive">Could not load Transaction Inbox</p>
              <p className="text-sm text-muted-foreground">The local data query failed. Try loading this page again.</p>
            </div>
            <Button variant="outline" onClick={() => setLoadRetry(value => value + 1)} data-testid="button-inbox-retry">
              <RotateCcw className="mr-2 h-4 w-4" />Retry
            </Button>
          </CardContent>
        </Card>
      ) : <div ref={parentRef} className="flex-1 min-h-0 overflow-y-auto" data-testid="inbox-virtual-scroll">
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map(item => {
            const tx = visibleRows[item.index];
            const txParticipants = participantsByTxid.get(tx.txid) ?? [];
            const inputs = txParticipants.filter(p => p.role === "input");
            const outputs = txParticipants.filter(p => p.role === "output");
            return (
              <div key={tx.txid} ref={virtualizer.measureElement} data-index={item.index} className="absolute left-0 right-0 pb-3" style={{ transform: `translateY(${item.start}px)` }}>
                <div className="flex items-start gap-2">
                  <Checkbox className="mt-5" checked={selected.has(tx.txid)} onCheckedChange={checked => setSelected(current => {
                    const next = new Set(current);
                    checked ? next.add(tx.txid) : next.delete(tx.txid);
                    return next;
                  })} aria-label={`Select ${tx.txid}`} />
                  <div className="min-w-0 flex-1 space-y-2">
                    <TransactionCard
                      tx={tx}
                      inputs={inputs}
                      outputs={outputs}
                      totalOutputValue={outputs.reduce((sum, p) => sum + p.amount, 0)}
                      isExpanded={expanded.has(tx.txid)}
                      onToggleExpand={() => setExpanded(current => {
                        const next = new Set(current);
                        next.has(tx.txid) ? next.delete(tx.txid) : next.add(tx.txid);
                        return next;
                      })}
                      addressToRecord={addressToRecord}
                      onAnnotate={() => void openTransactionAnnotation(tx)}
                    />
                    {tab === "new" && (
                      <Card>
                        <CardContent className="pt-4 flex flex-wrap gap-2">
                            <Button size="sm" onClick={() => void openTransactionAnnotation(tx)} data-testid={`button-inbox-annotate-${tx.txid}`}>Annotate</Button>
                            <Button size="sm" variant="outline" onClick={() => applyState([tx.txid], "ignored")}>Ignore</Button>
                            <SnoozePicker onSnooze={until => applyState([tx.txid], "snoozed", until)} testId={`button-inbox-snooze-${tx.txid}`} />
                        </CardContent>
                      </Card>
                    )}
                    {tx.curationUpdatedAt && <p className="text-xs text-muted-foreground px-1">Updated {formatDistanceToNow(tx.curationUpdatedAt, { addSuffix: true })}</p>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {hasMore && (
          <div className="flex justify-center py-4">
            <Button variant="outline" onClick={() => loadPage(false)} data-testid="button-inbox-load-more">
              Load {PAGE_LIMIT.toLocaleString()} more
            </Button>
          </div>
        )}
      </div>}
    </div>
  );
}
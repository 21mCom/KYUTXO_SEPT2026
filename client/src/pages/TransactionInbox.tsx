import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useVirtualizer } from "@tanstack/react-virtual";
import { formatDistanceToNow } from "date-fns";
import { Archive, Clock3, Inbox, RotateCcw, Search } from "lucide-react";
import { type BlockchainTransaction, type Record, type TransactionCurationState, type TransactionParticipant } from "@/lib/database";
import { bulkGetRecords, createRecord, getRecordsByInputStrings, updateRecord } from "@/lib/data/record-crud";
import {
  countTransactionCurations,
  getTransactionsByCurationState,
  updateTransactionCuration,
} from "@/lib/data/transaction-crud";
import { fetchParticipantsByTxids } from "@/lib/participant-repo";
import { useDbChangeSignal } from "@/hooks/use-db-change-signal";
import { TransactionCard } from "@/pages/Transactions";
import {
  TransactionSearchFilters,
  defaultFilters,
  filterByDateAndAmount,
  type SearchFilters,
} from "@/components/TransactionSearchFilters";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";

type InboxTab = TransactionCurationState;
type UndoEntry = Array<{
  txid: string;
  state: TransactionCurationState;
  snoozedUntil?: number;
}>;

const PAGE_LIMIT = 500;
const SNOOZE_WEEK = 7 * 24 * 60 * 60 * 1000;

export default function TransactionInbox() {
  const { toast } = useToast();
  const [tab, setTab] = useState<InboxTab>("new");
  const [rows, setRows] = useState<BlockchainTransaction[]>([]);
  const [nextBeforeId, setNextBeforeId] = useState<number | undefined>();
  const [hasMore, setHasMore] = useState(true);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<SearchFilters>(defaultFilters);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Map<string, { label: string; notes: string }>>(new Map());
  const [undo, setUndo] = useState<UndoEntry | null>(null);
  const dbSignal = useDbChangeSignal(["blockchainTransactions", "transactionParticipants", "records"], 100);

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
    const beforeId = reset ? undefined : nextBeforeId;
    const page = await getTransactionsByCurationState(tab, PAGE_LIMIT, beforeId);
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
    let cancelled = false;
    void getTransactionsByCurationState(tab, PAGE_LIMIT).then(page => {
      if (cancelled) return;
      setRows(page);
      setNextBeforeId(page.length ? page[page.length - 1].id : undefined);
      setHasMore(page.length === PAGE_LIMIT);
    });
    return () => { cancelled = true; };
  }, [tab, dbSignal]);
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
  }, [rows, filters, search, participantsByTxid, txRecordByTxid]);

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

  const annotate = async (txid: string) => {
    const draft = drafts.get(txid) ?? { label: "", notes: "" };
    if (!draft.label.trim() && !draft.notes.trim()) {
      toast({ title: "Add a label or note first", variant: "destructive" });
      return;
    }
    const record = txRecordByTxid.get(txid);
    if (record?.id) {
      await updateRecord(record.id, { label: draft.label.trim(), notes: draft.notes.trim() });
    } else {
      await createRecord({
        type: "transaction",
        inputString: txid,
        label: draft.label.trim(),
        notes: draft.notes.trim(),
        tags: [],
        categories: [],
      });
    }
    await applyState([txid], "annotated");
    setDrafts(current => {
      const next = new Map(current);
      next.delete(txid);
      return next;
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
    <div className="h-full flex flex-col gap-4 p-4 md:p-6" data-testid="transaction-curation-inbox">
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
        <TransactionSearchFilters filters={filters} onChange={setFilters} onClear={() => setFilters(defaultFilters)} showEntityFilters={false} />
      </div>

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
              <Button size="sm" variant="outline" disabled={!selected.size} onClick={() => applyState(Array.from(selected), "snoozed", Date.now() + SNOOZE_WEEK)}><Clock3 className="h-4 w-4 mr-1" />Snooze 1 week</Button>
              <Button size="sm" variant="outline" disabled={!selected.size} onClick={() => applyState(Array.from(selected), "new")}>Mark New</Button>
            </div>
          </div>
        </CardHeader>
      </Card>

      <div ref={parentRef} className="flex-1 min-h-0 overflow-y-auto" data-testid="inbox-virtual-scroll">
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map(item => {
            const tx = visibleRows[item.index];
            const txParticipants = participantsByTxid.get(tx.txid) ?? [];
            const inputs = txParticipants.filter(p => p.role === "input");
            const outputs = txParticipants.filter(p => p.role === "output");
            const draft = drafts.get(tx.txid) ?? { label: "", notes: "" };
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
                    />
                    {tab === "new" && (
                      <Card>
                        <CardContent className="pt-4 grid gap-2 md:grid-cols-[1fr_1fr_auto]">
                          <Input value={draft.label} onChange={event => setDrafts(current => new Map(current).set(tx.txid, { ...draft, label: event.target.value }))} placeholder="Label" data-testid={`input-inbox-label-${tx.txid}`} />
                          <Textarea className="min-h-9 h-9" value={draft.notes} onChange={event => setDrafts(current => new Map(current).set(tx.txid, { ...draft, notes: event.target.value }))} placeholder="Notes" />
                          <div className="flex gap-2">
                            <Button size="sm" onClick={() => annotate(tx.txid)}>Save annotation</Button>
                            <Button size="sm" variant="outline" onClick={() => applyState([tx.txid], "ignored")}>Ignore</Button>
                            <Button size="sm" variant="outline" onClick={() => applyState([tx.txid], "snoozed", Date.now() + SNOOZE_WEEK)}>Snooze</Button>
                          </div>
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
      </div>
    </div>
  );
}
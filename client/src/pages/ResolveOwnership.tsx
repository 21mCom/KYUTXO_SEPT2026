import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, RotateCcw, Search, ShieldQuestion } from "lucide-react";
import { useDbChangeSignal } from "@/hooks/use-db-change-signal";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { AddressOwnership, OwnershipReviewDecision, Record as DbRecord, RecordEntity, TransactionParticipant } from "@/lib/db-types";
import {
  decideOwnership, generateOwnershipSuggestions, listRows, OWNERSHIP_REVIEW_LIMITS,
  decideWalletOwnership, undoOwnershipDecision, visibleOwnershipSuggestions, type OwnershipSuggestion,
} from "@/lib/ownership-resolution";
import { getVaultRepository } from "@/lib/repository";
import { useToast } from "@/hooks/use-toast";

type LoadedOwnershipData = {
  records: DbRecord[];
  ownership: AddressOwnership[];
  participants: TransactionParticipant[];
  decisions: OwnershipReviewDecision[];
  entities: RecordEntity[];
};

const emptyData: LoadedOwnershipData = { records: [], ownership: [], participants: [], decisions: [], entities: [] };

/** Value is locally cached satoshis only; no heuristic ever changes this ranking. */
export function ownershipSuggestionValue(suggestion: OwnershipSuggestion, records: DbRecord[]) {
  const recordMap = new Map(records.map(record => [record.id, record]));
  return ownershipSuggestionValueFromMap(suggestion, recordMap);
}

function ownershipSuggestionValueFromMap(suggestion: OwnershipSuggestion, recordMap: Map<number | undefined, DbRecord>) {
  return suggestion.recordIds.reduce((total, id) => total + Math.max(0, recordMap.get(id)?.cachedBalanceSats ?? 0), 0);
}

function short(value: string) {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

export default function ResolveOwnership() {
  const { toast } = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const dbSignal = useDbChangeSignal(["records", "entities", "addressOwnership", "transactionParticipants", "ownershipReviewDecisions"], 100);
  const [data, setData] = useState<LoadedOwnershipData>(emptyData);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<"all" | OwnershipSuggestion["kind"]>("all");
  const [ownerOverrides, setOwnerOverrides] = useState<globalThis.Record<string, string>>({});
  const [inspect, setInspect] = useState<string | null>(null);
  const [pending, setPending] = useState<{ suggestion: OwnershipSuggestion; action: "assign-cluster" | "assign-wallet" | "not-ours"; recordIds?: number[] } | null>(null);
  const [undoToken, setUndoToken] = useState<string | null>(null);
  const [suggestionOffset, setSuggestionOffset] = useState(0);
  const [scopePages, setScopePages] = useState(1);
  const ignoreNextDbSignal = useRef(false);
  const lastDbSignal = useRef(dbSignal);
  const mountedRef = useRef(false);
  const loadGeneration = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    const isCurrent = () => mountedRef.current && loadGeneration.current === generation;
    setLoading(true);
    setLoadFailed(false);
    try {
      const repository = getVaultRepository();
      const [records, ownership, participants, decisions] = await Promise.all([
        listRows<DbRecord>(repository, "records", OWNERSHIP_REVIEW_LIMITS.records * scopePages),
        listRows<AddressOwnership>(repository, "addressOwnership", OWNERSHIP_REVIEW_LIMITS.records * scopePages),
        listRows<TransactionParticipant>(repository, "transactionParticipants", OWNERSHIP_REVIEW_LIMITS.participants * scopePages),
        // Rejections must be complete: a rejected fingerprint may otherwise
        // reappear merely because it fell after an arbitrary page boundary.
        listRows<OwnershipReviewDecision>(repository, "ownershipReviewDecisions", Number.MAX_SAFE_INTEGER),
      ]);
      // Evidence fingerprints use stable entity natural keys, never restore-local
      // surrogate ids. Fetch exactly the owners/counterparties referenced by the
      // bounded ownership scope instead of an arbitrary prefix of the entity table.
      const entityIds = [...new Set(ownership.flatMap(row => [row.entityId, row.counterpartyEntityId])
        .filter((id): id is number => Number.isSafeInteger(id)))];
      const entities = (await Promise.all(entityIds.map(id => repository.get("entities", id))))
        .filter((entity): entity is RecordEntity => !!entity);
      if (!isCurrent()) return;
      setData({ records, ownership, participants, decisions, entities });
      const undoable = decisions
        .filter(decision => !!decision.undoToken)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      setUndoToken(undoable?.undoToken ?? null);
    } catch (error) {
      if (!isCurrent()) return;
      setLoadFailed(true);
      toastRef.current({ title: "Could not load ownership review", description: error instanceof Error ? error.message : "Try again.", variant: "destructive" });
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [scopePages]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (lastDbSignal.current === dbSignal) return;
    lastDbSignal.current = dbSignal;
    if (ignoreNextDbSignal.current) {
      ignoreNextDbSignal.current = false;
      return;
    }
    void load();
  }, [dbSignal, load]);

  const entityById = useMemo(() => new Map(data.entities.map(entity => [entity.id, entity])), [data.entities]);
  const recordById = useMemo(() => new Map(data.records.map(record => [record.id, record])), [data.records]);
  const ownershipByRecordId = useMemo(() => new Map(data.ownership.map(row => [row.recordId, row])), [data.ownership]);
  const walletRecordIds = useMemo(() => {
    const rows = new Map<number, number[]>();
    for (const row of data.ownership) {
      if (!Number.isSafeInteger(row.walletId) || (row.state !== "undetermined" && row.state !== "ours-owner-unknown")) continue;
      const ids = rows.get(row.walletId!) ?? [];
      ids.push(row.recordId);
      rows.set(row.walletId!, ids);
    }
    return rows;
  }, [data.ownership]);
  const suggestions = useMemo(() => {
    const all = visibleOwnershipSuggestions(generateOwnershipSuggestions({
      records: data.records, ownership: data.ownership, participants: data.participants,
      entities: data.entities,
      offset: 0,
      limit: Number.MAX_SAFE_INTEGER,
      participantLimit: OWNERSHIP_REVIEW_LIMITS.participants * scopePages,
    }), data.decisions);
    const needle = search.trim().toLowerCase();
    return all.filter(suggestion => {
      const record = recordById.get(suggestion.recordId);
      const owner = suggestion.entityId === undefined ? "unassigned" : entityById.get(suggestion.entityId)?.name ?? "Unknown entity";
      return (kind === "all" || suggestion.kind === kind) && (!needle ||
        [record?.inputString, record?.label, owner, suggestion.explanation, ...suggestion.transactionIds].filter(Boolean)
          .join(" ").toLowerCase().includes(needle));
    }).sort((a, b) => ownershipSuggestionValueFromMap(b, recordById) - ownershipSuggestionValueFromMap(a, recordById) ||
      a.fingerprint.localeCompare(b.fingerprint))
      .slice(suggestionOffset, suggestionOffset + OWNERSHIP_REVIEW_LIMITS.suggestions);
  }, [data, entityById, kind, recordById, search, suggestionOffset]);

  const ownerId = (suggestion: OwnershipSuggestion) => {
    const value = ownerOverrides[suggestion.fingerprint];
    return value === undefined ? suggestion.entityId : value === "" ? undefined : Number(value);
  };
  const save = async (suggestion: OwnershipSuggestion, action: "assign" | "assign-cluster" | "assign-wallet" | "not-ours" | "reject" | "undecided", walletRecordIds?: number[]) => {
    try {
      const decision = action === "assign-wallet"
        ? await decideWalletOwnership({ suggestion, action, entityId: ownerId(suggestion), recordIds: walletRecordIds ?? [] })
        : await decideOwnership({ suggestion, action, entityId: action.startsWith("assign") ? ownerId(suggestion) : undefined });
      ignoreNextDbSignal.current = true;
      if (decision.undoToken) setUndoToken(decision.undoToken);
      setPending(null);
      setData(current => {
        const decisions = [...current.decisions.filter(row => row.id !== decision.id), decision];
        if (decision.state !== "accepted" && decision.state !== "not-ours") return { ...current, decisions };
        const recordIds = new Set(decision.recordIds);
        const existingByRecordId = new Map(current.ownership.map(row => [row.recordId, row]));
        const changed = decision.recordIds.map(recordId => {
          const existing = existingByRecordId.get(recordId);
          return {
            ...existing,
            recordId,
            state: decision.state === "not-ours" ? "not-ours" as const : "assigned" as const,
            entityId: decision.state === "accepted" ? decision.entityId : undefined,
            createdAt: existing?.createdAt ?? decision.createdAt,
            updatedAt: decision.updatedAt,
          };
        });
        return { ...current, decisions, ownership: [...current.ownership.filter(row => !recordIds.has(row.recordId)), ...changed] };
      });
      toast({ title: action === "reject" ? "Suggestion rejected" : action === "undecided" ? "Left undecided" : "Ownership decision saved" });
    } catch (error) {
      toast({ title: "Could not save decision", description: error instanceof Error ? error.message : "Try selecting an owner.", variant: "destructive" });
    }
  };
  const undo = async () => {
    if (!undoToken) return;
    const undone = data.decisions.find(decision => decision.undoToken === undoToken);
    if (await undoOwnershipDecision(undoToken)) {
      ignoreNextDbSignal.current = true;
      setUndoToken(null);
      if (undone?.previousOwnership) {
        setData(current => {
          const restoredIds = new Set(undone.previousOwnership!.map(row => row.recordId));
          const createdIds = new Set(undone.createdOwnershipRecordIds ?? []);
          return {
            ...current,
            ownership: [
              ...current.ownership.filter(row => !restoredIds.has(row.recordId) && !createdIds.has(row.recordId)),
              ...undone.previousOwnership!,
            ],
            decisions: current.decisions.map(decision =>
              decision.id === undone.id ? { ...decision, undoToken: undefined } : decision),
          };
        });
      }
      toast({ title: "Last ownership change undone" });
    }
  };

  const ownerEntities = data.entities.filter(entity => entity.id !== undefined && entity.kind !== "counterparty");
  const walletCascade = (suggestion: OwnershipSuggestion) => {
    const walletId = ownershipByRecordId.get(suggestion.recordId)?.walletId;
    if (!Number.isSafeInteger(walletId)) return undefined;
    const recordIds = walletRecordIds.get(walletId!) ?? [];
    return recordIds.length ? {
      walletId: walletId!,
      recordIds,
      exceedsAtomicLimit: recordIds.length > OWNERSHIP_REVIEW_LIMITS.records,
    } : undefined;
  };
  return (
    <div
      className="h-full overflow-y-auto p-4 md:p-6 space-y-4"
      data-testid="ownership-resolution-page"
      data-navigation-ready={!loading && !loadFailed ? "true" : "false"}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold"><ShieldQuestion className="h-6 w-6" />Resolve Ownership</h1>
          <p className="text-sm text-muted-foreground">Review local evidence before it affects ownership. Suggestions are never accepted automatically.</p>
        </div>
        {undoToken && <Button variant="outline" onClick={() => void undo()} data-testid="button-ownership-undo"><RotateCcw className="mr-2 h-4 w-4" />Undo last accepted change</Button>}
      </div>
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-64 flex-1"><Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input className="pl-9" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search address, label, owner, or transaction…" data-testid="input-ownership-search" />
        </div>
        <select value={kind} onChange={event => setKind(event.target.value as typeof kind)} className="h-9 rounded-md border bg-background px-3 text-sm" data-testid="select-ownership-filter">
          <option value="all">All evidence</option><option value="propagation">Propagation</option><option value="common-input-cluster">Common input cluster</option><option value="address-reuse">Address reuse</option><option value="elimination">Elimination</option>
        </select>
      </div>
      <Card className="border-dashed" data-testid="ownership-scope-notice"><CardContent className="py-3 text-xs text-muted-foreground">
        This bounded review scope currently covers up to {(OWNERSHIP_REVIEW_LIMITS.records * scopePages).toLocaleString()} address/ownership rows and {(OWNERSHIP_REVIEW_LIMITS.participants * scopePages).toLocaleString()} participant rows loaded locally. Showing value-ranked suggestion page {Math.floor(suggestionOffset / OWNERSHIP_REVIEW_LIMITS.suggestions) + 1}; load another page to traverse more derived suggestions. Decisions are read across all pages.
        <Button className="ml-2 h-7 text-xs" variant="outline" onClick={() => { setSuggestionOffset(0); setScopePages(current => current + 1); }} data-testid="button-ownership-load-more-scope">Load more local review scope</Button>
      </CardContent></Card>
      {loading ? <p className="text-sm text-muted-foreground" data-testid="ownership-loading">Loading ownership review…</p> : loadFailed ? (
        <Card className="border-destructive/50" data-testid="ownership-load-error"><CardContent className="flex flex-wrap items-center justify-between gap-3 py-6">
          <div><p className="font-medium text-destructive">Could not load ownership review</p><p className="text-sm text-muted-foreground">The local data query failed. Try loading this review again.</p></div>
          <Button variant="outline" onClick={() => void load()} data-testid="button-ownership-retry"><RotateCcw className="mr-2 h-4 w-4" />Retry</Button>
        </CardContent></Card>
      ) : suggestions.length === 0 ? (
        <Card data-testid="ownership-empty"><CardContent className="py-8 text-center"><Check className="mx-auto mb-2 h-7 w-7 text-muted-foreground" /><p className="font-medium">No ownership suggestions to review</p><p className="text-sm text-muted-foreground">Rejected unchanged evidence stays out of this queue.</p></CardContent></Card>
      ) : suggestions.map(suggestion => {
        const record = recordById.get(suggestion.recordId);
        const assignedOwner = ownerId(suggestion);
        const ownerName = assignedOwner === undefined || !entityById.has(assignedOwner) ? "Unassigned" : entityById.get(assignedOwner)?.name ?? "Unassigned";
        const value = ownershipSuggestionValueFromMap(suggestion, recordById);
        const open = inspect === suggestion.fingerprint;
        const cascade = walletCascade(suggestion);
        return <Card key={suggestion.fingerprint} data-testid={`ownership-suggestion-${suggestion.recordId}`}>
          <CardHeader className="pb-3"><div className="flex flex-wrap items-start justify-between gap-2"><div>
            <CardTitle className="text-base">{record?.label || short(record?.inputString ?? `Record #${suggestion.recordId}`)}</CardTitle>
            <CardDescription>{record?.inputString || `Record #${suggestion.recordId}`}</CardDescription>
          </div><div className="flex gap-1"><Badge variant="secondary">{suggestion.kind.replaceAll("-", " ")}</Badge><Badge variant={suggestion.confidence === "medium" ? "default" : "outline"}>{suggestion.confidence} confidence</Badge><Badge variant="outline">{value.toLocaleString()} sats</Badge></div></div></CardHeader>
          <CardContent className="space-y-3"><p className="text-sm">{suggestion.explanation}</p>
            <div className="flex flex-wrap items-center gap-2 text-sm"><span className="text-muted-foreground">Suggested owner:</span><Badge variant={assignedOwner === undefined ? "outline" : "secondary"} data-testid={`ownership-owner-${suggestion.recordId}`}>{ownerName}</Badge>
              {suggestion.suggestedState === "assigned" && <select value={assignedOwner ?? ""} onChange={event => setOwnerOverrides(current => ({ ...current, [suggestion.fingerprint]: event.target.value }))} className="h-8 rounded border bg-background px-2 text-sm" aria-label={`Owner for ${record?.inputString ?? suggestion.recordId}`} data-testid={`select-ownership-owner-${suggestion.recordId}`}><option value="">Unassigned</option>{ownerEntities.map(entity => <option key={entity.id} value={entity.id}>{entity.name}</option>)}</select>}
            </div>
            <Button size="sm" variant="ghost" onClick={() => setInspect(open ? null : suggestion.fingerprint)} data-testid={`button-ownership-inspect-${suggestion.recordId}`}>{open ? "Hide evidence" : "Inspect evidence"}</Button>
            {open && <div className="rounded-md border bg-muted/30 p-3 text-sm space-y-1" data-testid={`ownership-evidence-${suggestion.recordId}`}><p><strong>Addresses:</strong> {suggestion.recordIds.map(id => recordById.get(id)?.inputString ?? `Record #${id}`).join(", ")}</p><p><strong>Transactions:</strong> {suggestion.transactionIds.length ? suggestion.transactionIds.join(", ") : "No transaction evidence for this suggestion."}</p><p className="text-xs text-muted-foreground">Evidence fingerprint: {suggestion.fingerprint}</p></div>}
            <div className="flex flex-wrap gap-2 border-t pt-3">
              {suggestion.suggestedState === "assigned" && <><Button size="sm" onClick={() => void save(suggestion, "assign")} data-testid={`button-ownership-assign-${suggestion.recordId}`}>Assign one</Button>
                <Button size="sm" variant="outline" disabled={suggestion.recordIds.length < 2} onClick={() => setPending({ suggestion, action: "assign-cluster" })} data-testid={`button-ownership-cluster-${suggestion.recordId}`}>Assign entire cluster ({suggestion.recordIds.length})</Button>
                {cascade && <Button size="sm" variant="outline" disabled={cascade.exceedsAtomicLimit}
                  title={cascade.exceedsAtomicLimit ? `This loaded wallet has ${cascade.recordIds.length.toLocaleString()} unresolved addresses, above the ${OWNERSHIP_REVIEW_LIMITS.records.toLocaleString()}-address atomic review limit. Review a smaller bounded scope.` : undefined}
                  onClick={() => setPending({ suggestion, action: "assign-wallet", recordIds: cascade.recordIds })}
                  data-testid={`button-ownership-wallet-${suggestion.recordId}`}>
                  {cascade.exceedsAtomicLimit ? `Wallet exceeds atomic limit (${cascade.recordIds.length})` : `Assign wallet (${cascade.recordIds.length} addresses)`}
                </Button>}</>}
              <Button size="sm" variant="outline" onClick={() => setPending({ suggestion, action: "not-ours" })} data-testid={`button-ownership-not-ours-${suggestion.recordId}`}>Mark not ours</Button>
              <Button size="sm" variant="ghost" onClick={() => void save(suggestion, "reject")} data-testid={`button-ownership-reject-${suggestion.recordId}`}>Reject suggestion</Button>
              <Button size="sm" variant="ghost" onClick={() => void save(suggestion, "undecided")} data-testid={`button-ownership-undecided-${suggestion.recordId}`}>Leave undecided</Button>
            </div>
          </CardContent>
        </Card>;
      })}
      {suggestions.length === OWNERSHIP_REVIEW_LIMITS.suggestions && <div className="flex justify-center"><Button variant="outline" onClick={() => setSuggestionOffset(current => current + OWNERSHIP_REVIEW_LIMITS.suggestions)} data-testid="button-ownership-load-more">Load next {OWNERSHIP_REVIEW_LIMITS.suggestions} suggestions</Button></div>}
      <AlertDialog open={!!pending} onOpenChange={open => !open && setPending(null)}><AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{pending?.action === "assign-cluster" ? "Assign entire address cluster?" : pending?.action === "assign-wallet" ? "Assign normalized wallet addresses?" : "Mark address not ours?"}</AlertDialogTitle>
          <AlertDialogDescription>{pending?.action === "assign-cluster" ? `This explicitly assigns ${pending.suggestion.recordIds.length} address records to ${entityById.get(ownerId(pending.suggestion) ?? -1)?.name ?? "the selected owner"}.` : pending?.action === "assign-wallet" ? (() => { const ids = pending.recordIds ?? []; const idSet = new Set(ids); const txs = new Set(data.participants.filter(row => idSet.has(row.recordId ?? -1)).map(row => row.txid)).size; const addresses = ids.map(id => recordById.get(id)?.inputString ?? `Record #${id}`).join(", "); return `This explicitly assigns exactly ${ids.length} unresolved addresses (${addresses}) in this normalized wallet, with ${txs} related local transactions/batches, to ${entityById.get(ownerId(pending.suggestion) ?? -1)?.name ?? "the selected owner"}.`; })() : "This explicitly excludes this address from your ownership. It can be changed later only by a new review decision."}</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel data-testid="button-ownership-cancel-confirmation">Cancel</AlertDialogCancel><AlertDialogAction onClick={() => pending && void save(pending.suggestion, pending.action, pending.recordIds)} data-testid="button-ownership-confirm-action">Confirm</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent></AlertDialog>
    </div>
  );
}
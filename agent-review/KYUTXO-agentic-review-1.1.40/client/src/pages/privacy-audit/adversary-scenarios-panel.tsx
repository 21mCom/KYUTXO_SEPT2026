import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  Plus,
  Play,
  Pencil,
  Trash2,
  Loader2,
  ChevronDown,
  X,
  UserSearch,
  ShieldAlert,
  Merge,
  Split,
  AlertTriangle,
  ScanSearch,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { renderSourceNote } from "@/lib/renderSourceNote";
import { AddressLink } from "@/components/AddressLink";
import { TxidLink } from "@/components/TxidLink";
import { searchRecordsForPicker } from "@/lib/data/record-crud";
import { getTransactionsByTxidStartsWith } from "@/lib/data/transaction-crud";
import {
  getAllAdversaryScenarios,
  saveAdversaryScenario,
  updateAdversaryScenario,
  deleteAdversaryScenario,
} from "@/lib/data/adversary-scenarios-crud";
import type { AdversaryScenario } from "@/lib/database";
import {
  runAdversaryScenario,
  resolveScenarioReferences,
  type AdversaryScenarioDelta,
  type ScenarioReferenceResolution,
} from "@/lib/adversary-scenario";
import type { AdversaryConfidence } from "@/lib/adversary-view";

const CONFIDENCE_BADGE_CLASS: Record<AdversaryConfidence, string> = {
  certain: "bg-slate-500 text-white no-default-hover-elevate no-default-active-elevate",
  likely: "bg-blue-500 text-white no-default-hover-elevate no-default-active-elevate",
  speculative: "bg-muted text-muted-foreground no-default-hover-elevate no-default-active-elevate",
};

interface ScenarioFormState {
  name: string;
  counterpartyName: string;
  knownAddresses: string[];
  knownTxids: string[];
}

const EMPTY_FORM: ScenarioFormState = {
  name: "",
  counterpartyName: "",
  knownAddresses: [],
  knownTxids: [],
};

// ─── Searchable multi-select pickers ─────────────────────────────────────────

function useDebouncedValue(value: string, delayMs = 200): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

function AddressPicker({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const debounced = useDebouncedValue(query);

  useEffect(() => {
    let cancelled = false;
    const q = debounced.trim();
    if (!q) {
      setResults([]);
      return;
    }
    searchRecordsForPicker(q, 15)
      .then((rows) => {
        if (cancelled) return;
        setResults(
          rows
            .filter((r) => r.type === "address" && r.inputString)
            .map((r) => r.inputString),
        );
      })
      .catch((err) => console.error("Scenario address search failed:", err));
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  const add = (addr: string) => {
    if (!selected.includes(addr)) onChange([...selected, addr]);
    setQuery("");
    setResults([]);
  };

  return (
    <div className="space-y-2">
      <Label htmlFor="input-scenario-address-search">Known addresses</Label>
      <Input
        id="input-scenario-address-search"
        data-testid="input-scenario-address-search"
        placeholder="Search your address records…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {results.length > 0 && (
        <div
          className="border rounded-md divide-y max-h-40 overflow-y-auto"
          data-testid="list-scenario-address-results"
        >
          {results.map((addr) => (
            <button
              key={addr}
              type="button"
              className="w-full text-left px-2 py-1.5 text-xs font-mono hover-elevate"
              data-testid={`button-add-known-address-${addr.slice(0, 10)}`}
              onClick={() => add(addr)}
            >
              {addr}
            </button>
          ))}
        </div>
      )}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1" data-testid="chips-scenario-addresses">
          {selected.map((addr) => (
            <Badge key={addr} variant="secondary" className="font-mono text-[10px]">
              {addr.length > 16 ? `${addr.slice(0, 8)}…${addr.slice(-4)}` : addr}
              <button
                type="button"
                className="ml-1"
                aria-label={`Remove ${addr}`}
                data-testid={`button-remove-known-address-${addr.slice(0, 10)}`}
                onClick={() => onChange(selected.filter((a) => a !== addr))}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">
        Addresses from your vault the counterparty is assumed to know are yours
        — even if nothing on-chain links them.
      </p>
    </div>
  );
}

function TxidPicker({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const debounced = useDebouncedValue(query);

  useEffect(() => {
    let cancelled = false;
    const q = debounced.trim();
    if (!q) {
      setResults([]);
      return;
    }
    getTransactionsByTxidStartsWith(q.toLowerCase(), 15)
      .then((rows) => {
        if (cancelled) return;
        setResults(rows.map((t) => t.txid));
      })
      .catch((err) => console.error("Scenario transaction search failed:", err));
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  const add = (txid: string) => {
    if (!selected.includes(txid)) onChange([...selected, txid]);
    setQuery("");
    setResults([]);
  };

  return (
    <div className="space-y-2">
      <Label htmlFor="input-scenario-txid-search">Known transactions</Label>
      <Input
        id="input-scenario-txid-search"
        data-testid="input-scenario-txid-search"
        placeholder="Search synced history by txid…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {results.length > 0 && (
        <div
          className="border rounded-md divide-y max-h-40 overflow-y-auto"
          data-testid="list-scenario-txid-results"
        >
          {results.map((txid) => (
            <button
              key={txid}
              type="button"
              className="w-full text-left px-2 py-1.5 text-xs font-mono hover-elevate"
              data-testid={`button-add-known-txid-${txid.slice(0, 10)}`}
              onClick={() => add(txid)}
            >
              {txid}
            </button>
          ))}
        </div>
      )}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1" data-testid="chips-scenario-txids">
          {selected.map((txid) => (
            <Badge key={txid} variant="secondary" className="font-mono text-[10px]">
              {txid.slice(0, 10)}…
              <button
                type="button"
                className="ml-1"
                aria-label={`Remove ${txid}`}
                data-testid={`button-remove-known-txid-${txid.slice(0, 10)}`}
                onClick={() => onChange(selected.filter((t) => t !== txid))}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">
        Transactions the counterparty is assumed to know involve you. Their
        full participant graphs become adversary-visible evidence.
      </p>
    </div>
  );
}

// ─── Delta results ────────────────────────────────────────────────────────────

function unresolvedNoticeText(count: number): string {
  return `${count} saved ${count === 1 ? "assumption" : "assumptions"} no longer ${
    count === 1 ? "matches" : "match"
  } anything in this vault`;
}

/**
 * Informational (never blocking) notice that some of the scenario's saved
 * assumed addresses/txids no longer resolve against the vault — the run
 * proceeds with the references that do resolve, so the delta may understate
 * what the counterparty could unravel with the full saved assumption set.
 */
function UnresolvedReferencesNotice({
  resolution,
}: {
  resolution: ScenarioReferenceResolution;
}) {
  if (resolution.unresolvedCount === 0) return null;
  return (
    <div
      className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2"
      data-testid="notice-scenario-unresolved-refs"
    >
      <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
      <p className="text-[11px] text-muted-foreground">
        {unresolvedNoticeText(resolution.unresolvedCount)}
        {" — the scenario runs with the "}
        {resolution.unresolvedAddresses.length > 0 &&
          `${resolution.unresolvedAddresses.length} ${
            resolution.unresolvedAddresses.length === 1 ? "address" : "addresses"
          }`}
        {resolution.unresolvedAddresses.length > 0 &&
          resolution.unresolvedTxids.length > 0 &&
          " and "}
        {resolution.unresolvedTxids.length > 0 &&
          `${resolution.unresolvedTxids.length} ${
            resolution.unresolvedTxids.length === 1 ? "transaction" : "transactions"
          }`}
        {" excluded, so its results may understate what this counterparty can unravel."}
      </p>
    </div>
  );
}

function ScenarioDeltaView({ delta }: { delta: AdversaryScenarioDelta }) {
  const { summary } = delta;
  const [open, setOpen] = useState(true);
  const isNoDelta =
    summary.newlyExposedCount === 0 &&
    summary.mergedClusterCount === 0 &&
    summary.brokenSeparationCount === 0 &&
    summary.newContextMergeCount === 0;

  return (
    <div
      className="border rounded-md p-3 space-y-3 bg-muted/30"
      data-testid="container-scenario-delta"
    >
      <div className="flex items-start gap-2 flex-wrap">
        {isNoDelta ? (
          <Badge
            className="bg-green-600 text-white no-default-hover-elevate no-default-active-elevate"
            data-testid="badge-scenario-no-delta"
          >
            no additional exposure
          </Badge>
        ) : (
          <>
            {summary.newlyExposedCount > 0 && (
              <Badge
                className="bg-red-500 text-white no-default-hover-elevate no-default-active-elevate"
                data-testid="badge-scenario-newly-exposed-count"
              >
                <ShieldAlert className="h-3 w-3 mr-1" />
                {summary.newlyExposedCount} newly linked
              </Badge>
            )}
            {summary.mergedClusterCount > 0 && (
              <Badge
                className="bg-amber-500 text-white no-default-hover-elevate no-default-active-elevate"
                data-testid="badge-scenario-merged-clusters-count"
              >
                <Merge className="h-3 w-3 mr-1" />
                {summary.mergedClusterCount} cluster
                {summary.mergedClusterCount !== 1 ? "s" : ""} merged
              </Badge>
            )}
            {summary.brokenSeparationCount > 0 && (
              <Badge
                className="bg-orange-500 text-white no-default-hover-elevate no-default-active-elevate"
                data-testid="badge-scenario-broken-separations-count"
              >
                <Split className="h-3 w-3 mr-1" />
                {summary.brokenSeparationCount} separation
                {summary.brokenSeparationCount !== 1 ? "s" : ""} broken
              </Badge>
            )}
          </>
        )}
        <span className="text-[11px] text-muted-foreground">
          baseline exposed: {summary.baselineExposed} → with knowledge:{" "}
          {summary.scenarioExposed}
        </span>
      </div>

      <p className="text-sm" data-testid="text-scenario-narrative">
        {renderSourceNote(delta.narrative)}
      </p>

      {delta.scenario.degradation && (
        <div
          className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2"
          data-testid="banner-scenario-degradation"
        >
          <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
          <p className="text-[11px] text-muted-foreground">
            {delta.scenario.degradation.message}
          </p>
        </div>
      )}

      {!isNoDelta && (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" data-testid="button-toggle-scenario-details">
              <ChevronDown
                className={`h-3 w-3 mr-1 transition-transform ${open ? "rotate-180" : ""}`}
              />
              {open ? "Hide" : "Show"} Details
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-3 mt-2 pl-2 border-l-2 border-muted">
              {delta.newlyExposedAddresses.length > 0 && (
                <div>
                  <span className="text-xs font-medium text-muted-foreground">
                    Newly linked addresses:
                  </span>
                  <div className="flex flex-wrap gap-x-2 gap-y-1 mt-1">
                    {delta.newlyExposedAddresses.slice(0, 20).map((e) => (
                      <span key={e.address} className="inline-flex items-center gap-1">
                        <AddressLink address={e.address} />
                        <Badge
                          className={`text-[9px] ${CONFIDENCE_BADGE_CLASS[e.confidence]}`}
                          data-testid="badge-scenario-address-confidence"
                        >
                          {e.confidence}
                        </Badge>
                      </span>
                    ))}
                    {delta.newlyExposedAddresses.length > 20 && (
                      <span className="text-xs text-muted-foreground">
                        +{delta.newlyExposedAddresses.length - 20} more
                      </span>
                    )}
                  </div>
                </div>
              )}

              {delta.mergedClusters.length > 0 && (
                <div>
                  <span className="text-xs font-medium text-muted-foreground">
                    Merged clusters:
                  </span>
                  <div className="space-y-1 mt-1">
                    {delta.mergedClusters.slice(0, 5).map((c, i) => (
                      <p key={i} className="text-xs" data-testid="text-scenario-merged-cluster">
                        {c.baselineClusterCount} previously separate clusters collapse into one{" "}
                        {c.addresses.length}-address cluster ({c.confidence}).
                      </p>
                    ))}
                  </div>
                </div>
              )}

              {delta.brokenSeparations.length > 0 && (
                <div>
                  <span className="text-xs font-medium text-muted-foreground">
                    Broken separations:
                  </span>
                  <div className="space-y-2 mt-1">
                    {delta.brokenSeparations.slice(0, 5).map((f, i) => (
                      <div key={i}>
                        <p className="text-xs" data-testid="text-scenario-broken-separation">
                          {renderSourceNote(f.narrative)}
                        </p>
                        <div className="flex flex-wrap gap-x-2 gap-y-1 mt-1">
                          {f.addresses.slice(0, 8).map((a) => (
                            <AddressLink key={a} address={a} />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {delta.newContextMerges.length > 0 && (
                <div>
                  <span className="text-xs font-medium text-muted-foreground">
                    New context merges:
                  </span>
                  <div className="space-y-1 mt-1">
                    {delta.newContextMerges.slice(0, 5).map((w) => (
                      <div key={w.txid} className="flex items-center gap-2 flex-wrap">
                        <TxidLink txid={w.txid} />
                        <span className="text-[11px] text-muted-foreground">
                          {w.contexts.map((c) => c.label).join(" + ")}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function AdversaryScenariosPanel({
  loadUserAddresses,
}: {
  /** Loads the vault's owned addresses (same source the audit itself uses). */
  loadUserAddresses: (onProgress?: (msg: string) => void) => Promise<string[]>;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(true);
  const scenarios = useLiveQuery(() => getAllAdversaryScenarios());

  // Which saved assumed references still resolve against the vault. Live so
  // deleting a record / clearing synced transactions surfaces the notice
  // without a re-run; failures fall back to "no notice" (informational only).
  const resolutions = useLiveQuery(async () => {
    if (!scenarios) return undefined;
    const map: Record<number, ScenarioReferenceResolution> = {};
    for (const s of scenarios) {
      if (s.id == null) continue;
      try {
        map[s.id] = await resolveScenarioReferences(s);
      } catch (err) {
        console.error("Scenario reference resolution failed:", err);
      }
    }
    return map;
  }, [scenarios]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<ScenarioFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AdversaryScenario | null>(null);

  const [runningId, setRunningId] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const [deltas, setDeltas] = useState<Record<number, AdversaryScenarioDelta>>({});

  // Abort an in-flight run if the panel unmounts.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (scenario: AdversaryScenario) => {
    setEditingId(scenario.id ?? null);
    setForm({
      name: scenario.name,
      counterpartyName: scenario.counterpartyName,
      knownAddresses: [...scenario.knownAddresses],
      knownTxids: [...scenario.knownTxids],
    });
    setDialogOpen(true);
  };

  const saveScenario = async () => {
    if (form.knownAddresses.length === 0 && form.knownTxids.length === 0) {
      toast({
        variant: "destructive",
        title: "Nothing Assumed",
        description:
          "Add at least one known address or known transaction — the scenario simulates what that knowledge unravels.",
      });
      return;
    }
    setSaving(true);
    try {
      if (editingId != null) {
        await updateAdversaryScenario(editingId, form);
        // A changed assumption invalidates the previously computed delta.
        setDeltas((prev) => {
          const next = { ...prev };
          delete next[editingId];
          return next;
        });
      } else {
        await saveAdversaryScenario(form);
      }
      setDialogOpen(false);
      setForm(EMPTY_FORM);
      setEditingId(null);
    } catch (err) {
      console.error("Failed to save adversary scenario:", err);
      toast({
        variant: "destructive",
        title: "Save Failed",
        description: err instanceof Error ? err.message : "Could not save the scenario.",
      });
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target || target.id == null) return;
    try {
      await deleteAdversaryScenario(target.id);
      setDeltas((prev) => {
        const next = { ...prev };
        delete next[target.id!];
        return next;
      });
    } catch (err) {
      console.error("Failed to delete adversary scenario:", err);
      toast({
        variant: "destructive",
        title: "Delete Failed",
        description: err instanceof Error ? err.message : "Could not delete the scenario.",
      });
    }
  };

  const cancelRun = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const runScenario = async (scenario: AdversaryScenario) => {
    if (scenario.id == null || runningId != null) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunningId(scenario.id);
    setStatus("Loading address records…");
    try {
      const userAddresses = await loadUserAddresses((msg) => {
        if (!controller.signal.aborted) setStatus(msg);
      });
      const delta = await runAdversaryScenario(
        userAddresses,
        {
          knownAddresses: scenario.knownAddresses,
          knownTxids: scenario.knownTxids,
        },
        { counterpartyName: scenario.counterpartyName },
        (msg) => {
          if (!controller.signal.aborted) setStatus(msg);
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setDeltas((prev) => ({ ...prev, [scenario.id!]: delta }));
    } catch (err) {
      const aborted =
        controller.signal.aborted ||
        (err instanceof DOMException && err.name === "AbortError");
      if (!aborted) {
        console.error("Adversary scenario run failed:", err);
        toast({
          variant: "destructive",
          title: "Scenario Run Failed",
          description: err instanceof Error ? err.message : "The scenario analysis failed.",
        });
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setRunningId(null);
      setStatus("");
    }
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid="container-adversary-scenarios">
      <Card>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer flex flex-row items-center justify-between gap-2 py-3 px-4">
            <div className="flex items-center gap-2 flex-wrap">
              <UserSearch className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <span className="font-medium text-sm" data-testid="text-adversary-scenarios-title">
                Adversary Knowledge Scenarios
              </span>
              <span className="text-xs text-muted-foreground">
                what if a counterparty knew?
              </span>
              {scenarios && scenarios.length > 0 && (
                <Badge variant="secondary" data-testid="badge-scenario-count">
                  {scenarios.length}
                </Badge>
              )}
            </div>
            <ChevronDown
              className={`h-4 w-4 text-muted-foreground transition-transform flex-shrink-0 ${
                open ? "rotate-180" : ""
              }`}
            />
          </CardHeader>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <CardContent className="pt-0 pb-4 px-4 space-y-3">
            <p className="text-xs text-muted-foreground">
              Name a counterparty (exchange, merchant, ex-employer — anyone) and
              the addresses or transactions they plausibly know are yours. The
              analysis re-runs offline with that assumed knowledge and shows
              what one disclosure unravels beyond a blind chain analyst.
            </p>

            <div>
              <Button size="sm" onClick={openCreate} data-testid="button-new-scenario">
                <Plus className="h-3 w-3 mr-1" />
                New Scenario
              </Button>
            </div>

            {scenarios && scenarios.length === 0 && (
              <p
                className="text-xs text-muted-foreground italic"
                data-testid="text-no-scenarios"
              >
                No scenarios yet. Create one to simulate what a specific
                counterparty can unravel from what they know.
              </p>
            )}

            {scenarios?.map((scenario) => {
              const id = scenario.id!;
              const isRunning = runningId === id;
              const delta = deltas[id];
              const resolution = resolutions?.[id];
              return (
                <div
                  key={id}
                  className="border rounded-md p-3 space-y-2"
                  data-testid={`card-scenario-${id}`}
                >
                  <div className="flex items-start gap-2 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium" data-testid="text-scenario-name">
                          {scenario.name}
                        </span>
                        {scenario.counterpartyName && (
                          <Badge variant="outline" data-testid="badge-scenario-counterparty">
                            {scenario.counterpartyName}
                          </Badge>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        assumes knowledge of {scenario.knownAddresses.length}{" "}
                        {scenario.knownAddresses.length === 1 ? "address" : "addresses"}
                        {scenario.knownTxids.length > 0 &&
                          ` and ${scenario.knownTxids.length} ${
                            scenario.knownTxids.length === 1 ? "transaction" : "transactions"
                          }`}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {isRunning ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={cancelRun}
                          data-testid={`button-cancel-scenario-${id}`}
                        >
                          <X className="h-3 w-3 mr-1" />
                          Cancel
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => runScenario(scenario)}
                          disabled={runningId != null}
                          data-testid={`button-run-scenario-${id}`}
                        >
                          <Play className="h-3 w-3 mr-1" />
                          {delta ? "Re-run" : "Run"}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(scenario)}
                        data-testid={`button-edit-scenario-${id}`}
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeleteTarget(scenario)}
                        data-testid={`button-delete-scenario-${id}`}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>

                  {resolution && <UnresolvedReferencesNotice resolution={resolution} />}

                  {isRunning && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin flex-shrink-0" />
                      <span data-testid="text-scenario-status">{status || "Running…"}</span>
                    </div>
                  )}

                  {delta && !isRunning && <ScenarioDeltaView delta={delta} />}
                </div>
              );
            })}
          </CardContent>
        </CollapsibleContent>
      </Card>

      {/* Create / edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent data-testid="dialog-scenario-editor">
          <DialogHeader>
            <DialogTitle>
              {editingId != null ? "Edit Scenario" : "New Adversary Knowledge Scenario"}
            </DialogTitle>
            <DialogDescription>
              Assume one counterparty knows specific addresses and/or
              transactions are yours. The scenario shows what that single
              disclosure unravels.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="input-scenario-name">Scenario name</Label>
              <Input
                id="input-scenario-name"
                data-testid="input-scenario-name"
                placeholder="e.g. Exchange KYC leak"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="input-scenario-counterparty">Counterparty</Label>
              <Input
                id="input-scenario-counterparty"
                data-testid="input-scenario-counterparty"
                placeholder="e.g. Bitstamp, my old employer"
                value={form.counterpartyName}
                onChange={(e) =>
                  setForm((f) => ({ ...f, counterpartyName: e.target.value }))
                }
              />
            </div>
            <AddressPicker
              selected={form.knownAddresses}
              onChange={(next) => setForm((f) => ({ ...f, knownAddresses: next }))}
            />
            <TxidPicker
              selected={form.knownTxids}
              onChange={(next) => setForm((f) => ({ ...f, knownTxids: next }))}
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => setDialogOpen(false)}
                data-testid="button-cancel-scenario-edit"
              >
                Cancel
              </Button>
              <Button
                onClick={saveScenario}
                disabled={saving}
                data-testid="button-save-scenario"
              >
                {saving && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                {editingId != null ? "Save Changes" : "Create Scenario"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={deleteTarget != null} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <AlertDialogContent data-testid="dialog-delete-scenario">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete scenario?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? `"${deleteTarget.name}" will be permanently deleted. This does not affect your address or transaction records.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-scenario">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              data-testid="button-confirm-delete-scenario"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Collapsible>
  );
}

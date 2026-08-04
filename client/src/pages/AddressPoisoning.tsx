import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Biohazard, Loader2, X, Play, Tag, ShieldAlert } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { AddressLink } from "@/components/AddressLink";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import { useWalletNames } from "@/hooks/use-wallet-names";
import { useOwners } from "@/hooks/use-owners";
import { useTags } from "@/hooks/use-tags";
import { createTag } from "@/lib/data/vocabulary-crud";
import { getRecordsByInputStrings } from "@/lib/data/record-crud";
import { applyPoisoningTags } from "@/lib/data/poisoning-tagging";
import {
  scanAddressPoisoning,
  DEFAULT_DUST_THRESHOLD_SATS,
  DEFAULT_MATCH_LENGTH,
  type PoisoningSuspect,
  type PoisoningHeuristic,
} from "@/lib/address-poisoning";
import type { Record as DbRecord } from "@/lib/database";
import { useVirtualizer } from "@tanstack/react-virtual";

const HEURISTIC_LABELS: Record<PoisoningHeuristic, string> = {
  "dust-sized": "Dust-sized inbound",
  lookalike: "Lookalike match",
  "unknown-sender": "Unknown sender",
  "one-time-counterparty": "One-time counterparty",
};

const CONFIDENCE_VARIANT: Record<string, "destructive" | "secondary" | "outline"> = {
  high: "destructive",
  medium: "secondary",
  low: "outline",
};

type ScopeKind = "all" | "wallet" | "owner";

/** Renders an address with the shared leading/trailing runs highlighted. */
function HighlightedAddress({
  address,
  leading,
  trailing,
}: {
  address: string;
  leading: number;
  trailing: number;
}) {
  const lead = address.slice(0, leading);
  const middle = address.slice(leading, address.length - trailing);
  const trail = address.slice(address.length - trailing);
  return (
    <span className="font-mono text-xs break-all" data-testid={`highlight-${address}`}>
      <mark className="bg-amber-500/30 text-foreground rounded-sm px-0">{lead}</mark>
      <span className="text-muted-foreground">{middle}</span>
      <mark className="bg-amber-500/30 text-foreground rounded-sm px-0">{trail}</mark>
    </span>
  );
}

export default function AddressPoisoning() {
  const [scopeKind, setScopeKind] = useState<ScopeKind>("all");
  const [scopeValue, setScopeValue] = useState<string>("");
  const [thresholdInput, setThresholdInput] = useState<string>(String(DEFAULT_DUST_THRESHOLD_SATS));
  const [matchInput, setMatchInput] = useState<string>(String(DEFAULT_MATCH_LENGTH));

  const [phase, setPhase] = useState<"idle" | "computing" | "done">("idle");
  const [results, setResults] = useState<PoisoningSuspect[] | null>(null);
  const [progressMsg, setProgressMsg] = useState<string>("");
  const [cancelling, setCancelling] = useState(false);

  const [selectedTags, setSelectedTags] = useState<string[]>(["suspected-poisoning"]);
  const [targetTags, setTargetTags] = useState<string[]>(["poisoning-target"]);
  const [tagBusy, setTagBusy] = useState<string | null>(null);
  const [taggingAll, setTaggingAll] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  const { walletNames } = useWalletNames();
  const { owners } = useOwners();
  const { tags } = useTags();

  const scopeValueOptions =
    scopeKind === "wallet"
      ? walletNames.map((w) => w.name)
      : scopeKind === "owner"
        ? owners.map((o) => o.name)
        : [];

  // Live lookup of existing records for every suspect/target address so rows
  // show current tags and already-tagged state refreshes after tagging.
  const involvedAddresses = useMemo(() => {
    if (!results) return [];
    const set = new Set<string>();
    for (const r of results) {
      set.add(r.suspectAddress);
      set.add(r.targetAddress);
    }
    return Array.from(set);
  }, [results]);

  const recordByAddress = useLiveQuery(async () => {
    const map = new Map<string, DbRecord>();
    if (involvedAddresses.length === 0) return map;
    for (let i = 0; i < involvedAddresses.length; i += 500) {
      const recs = await getRecordsByInputStrings(involvedAddresses.slice(i, i + 500));
      for (const rec of recs) {
        if (!map.has(rec.inputString)) map.set(rec.inputString, rec);
      }
    }
    return map;
  }, [involvedAddresses]);

  const tagsFor = useCallback(
    (address: string): string[] => recordByAddress?.get(address)?.tags ?? [],
    [recordByAddress],
  );

  const hasAllTags = useCallback(
    (address: string, wanted: string[]): boolean => {
      const current = new Set(tagsFor(address));
      return wanted.every((t) => current.has(t));
    },
    [tagsFor],
  );

  const handleRun = useCallback(async () => {
    const threshold = parseInt(thresholdInput, 10);
    const matchLength = parseInt(matchInput, 10);
    if (isNaN(threshold) || threshold <= 0) {
      toast({ title: "Invalid threshold", description: "Dust threshold must be a positive number of sats.", variant: "destructive" });
      return;
    }
    if (isNaN(matchLength) || matchLength <= 0) {
      toast({ title: "Invalid match length", description: "Match length must be a positive number of characters.", variant: "destructive" });
      return;
    }

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setPhase("computing");
    setResults(null);
    setProgressMsg("");
    setCancelling(false);

    const outcome = await scanAddressPoisoning(
      scopeKind,
      scopeValue,
      { dustThresholdSats: threshold, matchLength },
      ctrl.signal,
      (count, scanPhase) => {
        if (ctrl.signal.aborted) return;
        setProgressMsg(
          scanPhase === "addresses"
            ? `Scanning address records… ${count.toLocaleString()} checked`
            : scanPhase === "transactions"
              ? `Scanning transactions… ${count.toLocaleString()} addresses checked`
              : `Collecting counterparties… ${count.toLocaleString()} transactions checked`,
        );
      },
    ).catch((err) => {
      if (!ctrl.signal.aborted) {
        toast({
          title: "Scan failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      }
      return null;
    });

    if (ctrl.signal.aborted) {
      setPhase("idle");
      setCancelling(false);
      return;
    }
    if (outcome) {
      setResults(outcome.results);
      setPhase("done");
    } else {
      setPhase("idle");
    }
  }, [scopeKind, scopeValue, thresholdInput, matchInput, toast]);

  const handleCancel = () => {
    setCancelling(true);
    abortRef.current?.abort();
  };

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // ── Tag application ────────────────────────────────────────────────────────
  const tagSuspects = useCallback(
    async (entries: Array<{ address: string; discoveredInTxid?: string }>, busyKey: string) => {
      if (selectedTags.length === 0) {
        toast({ title: "No tags selected", description: "Pick at least one tag to apply.", variant: "destructive" });
        return;
      }
      setTagBusy(busyKey);
      try {
        const summary = await applyPoisoningTags(entries, selectedTags);
        toast({
          title: "Tags applied",
          description:
            `Tagged ${summary.tagged} record${summary.tagged !== 1 ? "s" : ""}` +
            (summary.created > 0 ? `, created ${summary.created} new record${summary.created !== 1 ? "s" : ""}` : "") +
            (summary.alreadyTagged > 0 ? `, ${summary.alreadyTagged} already tagged` : "") +
            ".",
        });
      } catch (err) {
        toast({
          title: "Failed to apply tags",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      } finally {
        setTagBusy(null);
      }
    },
    [selectedTags, toast],
  );

  const tagTargets = useCallback(
    async (entries: Array<{ address: string; discoveredInTxid?: string }>, busyKey: string) => {
      if (targetTags.length === 0) {
        toast({ title: "No target tags selected", description: "Pick at least one tag to apply to targeted addresses.", variant: "destructive" });
        return;
      }
      setTagBusy(busyKey);
      try {
        const summary = await applyPoisoningTags(entries, targetTags);
        toast({
          title: "Target tags applied",
          description:
            `Tagged ${summary.tagged} record${summary.tagged !== 1 ? "s" : ""}` +
            (summary.created > 0 ? `, created ${summary.created} new record${summary.created !== 1 ? "s" : ""}` : "") +
            (summary.alreadyTagged > 0 ? `, ${summary.alreadyTagged} already tagged` : "") +
            ".",
        });
      } catch (err) {
        toast({
          title: "Failed to apply target tags",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      } finally {
        setTagBusy(null);
      }
    },
    [targetTags, toast],
  );

  const untaggedSuspects = useMemo(() => {
    if (!results || selectedTags.length === 0) return [];
    const seen = new Map<string, string>(); // address -> txid
    for (const r of results) {
      if (!seen.has(r.suspectAddress)) seen.set(r.suspectAddress, r.txid);
    }
    return Array.from(seen.entries())
      .filter(([addr]) => !hasAllTags(addr, selectedTags))
      .map(([address, txid]) => ({ address, discoveredInTxid: txid }));
  }, [results, selectedTags, hasAllTags]);

  const untaggedTargets = useMemo(() => {
    if (!results || targetTags.length === 0) return [];
    const seen = new Map<string, string>();
    for (const r of results) {
      if (!seen.has(r.targetAddress)) seen.set(r.targetAddress, r.txid);
    }
    return Array.from(seen.entries())
      .filter(([addr]) => !hasAllTags(addr, targetTags))
      .map(([address, txid]) => ({ address, discoveredInTxid: txid }));
  }, [results, targetTags, hasAllTags]);

  const handleTagAllSuspects = useCallback(async () => {
    if (taggingAll || untaggedSuspects.length === 0) return;
    setTaggingAll(true);
    try {
      await tagSuspects(untaggedSuspects, "all-suspects");
    } finally {
      setTaggingAll(false);
    }
  }, [taggingAll, untaggedSuspects, tagSuspects]);

  const handleTagAllTargets = useCallback(async () => {
    if (taggingAll || untaggedTargets.length === 0) return;
    setTaggingAll(true);
    try {
      await tagTargets(untaggedTargets, "all-targets");
    } finally {
      setTaggingAll(false);
    }
  }, [taggingAll, untaggedTargets, tagTargets]);

  // ── Grouped + virtualized rows ─────────────────────────────────────────────
  const groups = useMemo(() => {
    if (!results) return [];
    const map = new Map<string, PoisoningSuspect[]>();
    for (const r of results) {
      const list = map.get(r.targetAddress);
      if (list) list.push(r);
      else map.set(r.targetAddress, [r]);
    }
    return Array.from(map.entries()).map(([targetAddress, suspects]) => ({
      targetAddress,
      suspects,
    }));
  }, [results]);

  type FlatRow =
    | { type: "group"; targetAddress: string; count: number }
    | { type: "suspect"; suspect: PoisoningSuspect };

  const flatRows = useMemo<FlatRow[]>(() => {
    const rows: FlatRow[] = [];
    for (const g of groups) {
      rows.push({ type: "group", targetAddress: g.targetAddress, count: g.suspects.length });
      for (const s of g.suspects) rows.push({ type: "suspect", suspect: s });
    }
    return rows;
  }, [groups]);

  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => (flatRows[index]?.type === "group" ? 44 : 132),
    overscan: 10,
  });

  const isRunDisabled = phase === "computing" || (scopeKind !== "all" && !scopeValue);

  const summary = useMemo(() => {
    if (!results) return null;
    return {
      suspects: new Set(results.map((r) => r.suspectAddress)).size,
      targets: groups.length,
      high: results.filter((r) => r.confidence === "high").length,
    };
  }, [results, groups]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex-none p-4 pb-2 border-b">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <Biohazard className="h-5 w-5 text-[hsl(var(--primary))]" />
            <h1 className="text-lg font-semibold" data-testid="text-page-title">Address Poisoning</h1>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Select
              value={scopeKind}
              onValueChange={(v) => {
                setScopeKind(v as ScopeKind);
                setScopeValue("");
              }}
            >
              <SelectTrigger className="w-[150px]" data-testid="select-scope-type">
                <SelectValue placeholder="Scope" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Addresses</SelectItem>
                <SelectItem value="wallet">By Wallet</SelectItem>
                <SelectItem value="owner">By Owner</SelectItem>
              </SelectContent>
            </Select>

            {scopeKind !== "all" && (
              <Select value={scopeValue} onValueChange={setScopeValue}>
                <SelectTrigger className="w-[180px]" data-testid="select-scope-value">
                  <SelectValue placeholder={`Select ${scopeKind === "wallet" ? "Wallet" : "Owner"}`} />
                </SelectTrigger>
                <SelectContent>
                  {scopeValueOptions.length === 0 ? (
                    <SelectItem value="__none__" disabled>No values found</SelectItem>
                  ) : (
                    scopeValueOptions.map((v) => (
                      <SelectItem key={v} value={v}>{v}</SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            )}

            <div className="flex items-center gap-1">
              <span className="text-sm text-muted-foreground whitespace-nowrap">Dust ≤</span>
              <Input
                data-testid="input-dust-threshold"
                className="w-[90px]"
                value={thresholdInput}
                onChange={(e) => setThresholdInput(e.target.value)}
                type="number"
                min={1}
              />
              <span className="text-sm text-muted-foreground">sats</span>
            </div>

            <div className="flex items-center gap-1">
              <span className="text-sm text-muted-foreground whitespace-nowrap">Match ≥</span>
              <Input
                data-testid="input-match-length"
                className="w-[70px]"
                value={matchInput}
                onChange={(e) => setMatchInput(e.target.value)}
                type="number"
                min={1}
              />
              <span className="text-sm text-muted-foreground">chars</span>
            </div>

            {phase === "computing" ? (
              <Button
                variant="outline"
                size="default"
                onClick={handleCancel}
                disabled={cancelling}
                data-testid="button-cancel-scan"
              >
                {cancelling ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                ) : (
                  <X className="h-4 w-4 mr-1" />
                )}
                {cancelling ? "Cancelling…" : "Cancel"}
              </Button>
            ) : (
              <Button
                size="default"
                onClick={handleRun}
                disabled={isRunDisabled}
                data-testid="button-run-scan"
              >
                <Play className="h-4 w-4 mr-1" />
                {phase === "done" ? "Re-scan" : "Scan"}
              </Button>
            )}
          </div>
        </div>

        {phase === "computing" && (
          <div className="mt-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span className="flex-1" data-testid="text-progress">{progressMsg || "Scanning…"}</span>
            </div>
            <Progress value={undefined} className="h-1" />
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        {phase === "idle" && (
          <div
            className="flex flex-col items-center justify-center flex-1 gap-3 text-muted-foreground"
            data-testid="state-idle"
          >
            <Biohazard className="h-10 w-10 opacity-30" />
            <p className="text-sm max-w-md text-center">
              Pick a scope, dust threshold, and lookalike match length, then click{" "}
              <strong>Scan</strong> to hunt for address-poisoning attempts — dust sent from
              addresses that look like your own.
            </p>
          </div>
        )}

        {phase === "computing" && (
          <div
            className="flex flex-col items-center justify-center flex-1 gap-3 text-muted-foreground"
            data-testid="state-computing"
          >
            <Loader2 className="h-8 w-8 animate-spin opacity-40" />
            <p className="text-sm">Scanning for poisoning attempts…</p>
          </div>
        )}

        {phase === "done" && results !== null && results.length === 0 && (
          <div
            className="flex flex-col items-center justify-center flex-1 gap-3 text-muted-foreground"
            data-testid="state-empty"
          >
            <ShieldAlert className="h-10 w-10 opacity-30" />
            <p className="text-sm font-medium">No suspected address poisoning found.</p>
            <p className="text-xs max-w-md text-center">
              No dust-sized inbound outputs came from an address sharing at least the configured
              leading/trailing characters with one of your addresses.
            </p>
          </div>
        )}

        {phase === "done" && results !== null && results.length > 0 && summary && (
          <>
            <div
              className="flex-none mx-4 mt-3 px-3 py-2 rounded-md border flex items-center gap-3 flex-wrap"
              data-testid="banner-summary"
            >
              <Biohazard className="h-4 w-4 text-amber-500 flex-none" />
              <span className="text-sm flex-1 min-w-0" data-testid="text-summary">
                <span className="font-medium">{summary.suspects.toLocaleString()}</span> suspect
                address{summary.suspects !== 1 ? "es" : ""} targeting{" "}
                <span className="font-medium">{summary.targets.toLocaleString()}</span> of your
                address{summary.targets !== 1 ? "es" : ""}
                {summary.high > 0 && (
                  <>
                    {" — "}
                    <span className="font-medium text-amber-500">
                      {summary.high.toLocaleString()} high-confidence
                    </span>
                  </>
                )}
                .
              </span>

              <div className="flex items-center gap-2 flex-wrap">
                <MultiSelectCombobox
                  options={tags.map((t) => t.name)}
                  values={selectedTags}
                  onChange={setSelectedTags}
                  placeholder="Suspect tags…"
                  onAddNew={(name) => {
                    createTag(name).catch(() => {});
                  }}
                  testId="select-suspect-tags"
                  className="w-[220px]"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleTagAllSuspects}
                  disabled={taggingAll || untaggedSuspects.length === 0 || selectedTags.length === 0}
                  data-testid="button-tag-all-suspects"
                >
                  {taggingAll ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-1" />
                  ) : (
                    <Tag className="h-4 w-4 mr-1" />
                  )}
                  Tag all suspects ({untaggedSuspects.length})
                </Button>

                <MultiSelectCombobox
                  options={tags.map((t) => t.name)}
                  values={targetTags}
                  onChange={setTargetTags}
                  placeholder="Target tags…"
                  onAddNew={(name) => {
                    createTag(name).catch(() => {});
                  }}
                  testId="select-target-tags"
                  className="w-[200px]"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleTagAllTargets}
                  disabled={taggingAll || untaggedTargets.length === 0 || targetTags.length === 0}
                  data-testid="button-tag-all-targets"
                >
                  {taggingAll ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-1" />
                  ) : (
                    <Tag className="h-4 w-4 mr-1" />
                  )}
                  Tag all targets ({untaggedTargets.length})
                </Button>
              </div>
            </div>

            <div ref={parentRef} className="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
              <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                {virtualizer.getVirtualItems().map((vi) => {
                  const row = flatRows[vi.index];
                  if (!row) return null;
                  return (
                    <div
                      key={vi.key}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${vi.start}px)`,
                      }}
                    >
                      {row.type === "group" ? (
                        <div
                          className="flex items-center gap-2 pt-3 pb-1"
                          data-testid={`group-${row.targetAddress}`}
                        >
                          <span className="text-sm font-medium">Target:</span>
                          <AddressLink address={row.targetAddress} />
                          <Badge variant="secondary">{row.count} suspect{row.count !== 1 ? "s" : ""}</Badge>
                          <div className="flex gap-1 flex-wrap">
                            {tagsFor(row.targetAddress).map((t) => (
                              <Badge key={t} variant="outline" className="text-xs" data-testid={`badge-target-tag-${row.targetAddress}-${t}`}>
                                {t}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div
                          className="border rounded-md p-2 mb-1 ml-4"
                          data-testid={`row-suspect-${row.suspect.suspectAddress}`}
                        >
                          <div className="flex items-start justify-between gap-3 flex-wrap">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <Badge variant={CONFIDENCE_VARIANT[row.suspect.confidence]} data-testid={`badge-confidence-${row.suspect.suspectAddress}`}>
                                  {row.suspect.confidence}
                                </Badge>
                                <HighlightedAddress
                                  address={row.suspect.suspectAddress}
                                  leading={row.suspect.leadingMatch}
                                  trailing={row.suspect.trailingMatch}
                                />
                              </div>
                              <div className="text-xs text-muted-foreground mt-1 font-mono break-all" data-testid={`text-dust-${row.suspect.suspectAddress}`}>
                                dust {row.suspect.amountSats.toLocaleString()} sats →{" "}
                                {row.suspect.dustRecipient.slice(0, 16)}… via{" "}
                                {row.suspect.txid.slice(0, 12)}…:{row.suspect.vout}
                              </div>
                              <div className="flex gap-1 flex-wrap mt-1">
                                {row.suspect.heuristics.map((h) => (
                                  <Badge key={h} variant="outline" className="text-xs" data-testid={`badge-heuristic-${row.suspect.suspectAddress}-${h}`}>
                                    {HEURISTIC_LABELS[h]}
                                  </Badge>
                                ))}
                                {tagsFor(row.suspect.suspectAddress).map((t) => (
                                  <Badge key={t} variant="secondary" className="text-xs" data-testid={`badge-tag-${row.suspect.suspectAddress}-${t}`}>
                                    {t}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                            <div className="flex flex-col gap-1 flex-none">
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={
                                  tagBusy !== null ||
                                  selectedTags.length === 0 ||
                                  hasAllTags(row.suspect.suspectAddress, selectedTags)
                                }
                                onClick={() =>
                                  tagSuspects(
                                    [{ address: row.suspect.suspectAddress, discoveredInTxid: row.suspect.txid }],
                                    `suspect-${row.suspect.suspectAddress}`,
                                  )
                                }
                                data-testid={`button-tag-suspect-${row.suspect.suspectAddress}`}
                              >
                                {tagBusy === `suspect-${row.suspect.suspectAddress}` ? (
                                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                ) : (
                                  <Tag className="h-3 w-3 mr-1" />
                                )}
                                {hasAllTags(row.suspect.suspectAddress, selectedTags) ? "Tagged" : "Tag suspect"}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={
                                  tagBusy !== null ||
                                  targetTags.length === 0 ||
                                  hasAllTags(row.suspect.targetAddress, targetTags)
                                }
                                onClick={() =>
                                  tagTargets(
                                    [{ address: row.suspect.targetAddress, discoveredInTxid: row.suspect.txid }],
                                    `target-${row.suspect.suspectAddress}`,
                                  )
                                }
                                data-testid={`button-tag-target-${row.suspect.suspectAddress}`}
                              >
                                {tagBusy === `target-${row.suspect.suspectAddress}` ? (
                                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                ) : (
                                  <Tag className="h-3 w-3 mr-1" />
                                )}
                                {hasAllTags(row.suspect.targetAddress, targetTags) ? "Target tagged" : "Tag target"}
                              </Button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

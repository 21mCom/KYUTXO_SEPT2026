import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Droplets, Loader2, X, RefreshCw, Flag, FlagOff, ChevronRight, ChevronDown } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { markOutpointsAsDust, unmarkDustOutpoints, getAllDustFlags, toOutpoint } from "@/lib/data/dust-flags-crud";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { AddressLink } from "@/components/AddressLink";
import { useDbChangeSignal } from "@/hooks/use-db-change-signal";
import { useWalletNames } from "@/hooks/use-wallet-names";
import { useOwners } from "@/hooks/use-owners";
import { useSeedNames } from "@/hooks/use-seed-names";
import { useTags } from "@/hooks/use-tags";
import { useCategories } from "@/hooks/use-categories";
import { getRecordsPageByTypeIdReverseKeyset } from "@/lib/data/record-crud";
import { db, type Record as DbRecord } from "@/lib/database";
import { getGroupKeys, type GroupBy } from "@/lib/balance-grouping";
import { useVirtualizer } from "@tanstack/react-virtual";

const DEFAULT_DUST_THRESHOLD = 1000;
const AGG_BATCH = 500;
const PARTICIPANT_BATCH = 500;

interface DustingResult {
  recordId: number;
  address: string;
  totalCount: number;
  spentCount: number;
  unspentCount: number;
  /** Unspent dust outputs for this address, used by the "Mark as dust" action. */
  unspentOutputs: Array<{ txid: string; vout: number; amountSats: number }>;
}

type ScopeType = "all" | GroupBy;

/**
 * Two-pass dusting computation so spent/unspent classification is always correct.
 *
 * Pass 1 — address gathering: page through every address record and collect
 * those matching the chosen scope. Yields between batches for responsiveness.
 *
 * Pass 2 — participant scan: for each batch of in-scope addresses, fetch ALL
 * their participant rows (inputs + outputs) and accumulate them. After ALL
 * batches are done, build the complete spent-outpoints set from inputs, then
 * classify dust outputs against that complete set. This guarantees that a spend
 * seen in a later batch cannot misclassify an output that was seen in an earlier
 * batch.
 *
 * Returns null when cancelled.
 */
interface DustScanOutcome {
  results: DustingResult[];
  /** Every address that was in scope for this scan (used for stale-flag detection). */
  scannedAddresses: Set<string>;
}

export async function computeDustings(
  scopeType: ScopeType,
  scopeValue: string,
  threshold: number,
  signal: AbortSignal,
  onProgress: (processed: number, phase: "addresses" | "participants") => void,
): Promise<DustScanOutcome | null> {
  // ── Pass 1: collect in-scope address strings + their record ids ──────────
  const addressMap = new Map<string, { recordId: number }>();
  let beforeIdExclusive: number | undefined = undefined;
  let addrProcessed = 0;

  while (true) {
    if (signal.aborted) return null;
    const batch = await getRecordsPageByTypeIdReverseKeyset("address", {
      limit: AGG_BATCH,
      beforeIdExclusive,
    });
    if (batch.length === 0) break;

    for (const rec of batch) {
      if (rec.id == null) continue;
      const addr = rec.inputString;
      if (!addr) continue;

      if (scopeType === "all") {
        addressMap.set(addr, { recordId: rec.id });
      } else {
        const keys = getGroupKeys(rec as DbRecord, scopeType as GroupBy);
        if (keys.includes(scopeValue)) {
          addressMap.set(addr, { recordId: rec.id });
        }
      }
    }

    addrProcessed += batch.length;
    onProgress(addrProcessed, "addresses");

    beforeIdExclusive = batch[batch.length - 1].id ?? undefined;
    if (batch.length < AGG_BATCH || beforeIdExclusive == null) break;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  if (signal.aborted) return null;
  const scannedAddresses = new Set(addressMap.keys());
  if (addressMap.size === 0) return { results: [], scannedAddresses };

  // ── Pass 2: gather ALL participant rows for in-scope addresses ───────────
  //
  // We accumulate every participant row before doing any classification so that
  // the full spent-outpoints set is available before we look at any output.
  const addresses = Array.from(addressMap.keys());
  const allInputs: Array<{ prevTxid: string; prevVout: number }> = [];
  const allDustOutputs: Array<{ address: string; txid: string; vout: number; amountSats: number }> = [];
  let partProcessed = 0;

  for (let i = 0; i < addresses.length; i += PARTICIPANT_BATCH) {
    if (signal.aborted) return null;
    const batch = addresses.slice(i, i + PARTICIPANT_BATCH);

    const participants = await db.transactionParticipants
      .where("address")
      .anyOf(batch)
      .toArray();

    for (const p of participants) {
      if (p.role === "input") {
        if (p.prevTxid !== undefined && p.prevVout !== undefined) {
          allInputs.push({ prevTxid: p.prevTxid, prevVout: p.prevVout });
        }
      } else {
        // output — only accumulate if it's a dust candidate
        const sats = Math.round(p.amount);
        if (sats > 0 && sats < threshold) {
          allDustOutputs.push({ address: p.address, txid: p.txid, vout: p.vout ?? 0, amountSats: sats });
        }
      }
    }

    partProcessed += batch.length;
    onProgress(partProcessed, "participants");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  if (signal.aborted) return null;

  // ── Classify: build complete spent set, then count ───────────────────────
  const spentOutpoints = new Set<string>();
  for (const inp of allInputs) {
    spentOutpoints.add(`${inp.prevTxid}:${inp.prevVout}`);
  }

  const dustByAddress = new Map<
    string,
    { spent: number; unspent: number; unspentOutputs: Array<{ txid: string; vout: number; amountSats: number }> }
  >();
  for (const out of allDustOutputs) {
    if (!addressMap.has(out.address)) continue;
    const outpoint = `${out.txid}:${out.vout}`;
    const isSpent = spentOutpoints.has(outpoint);
    const entry = dustByAddress.get(out.address) ?? { spent: 0, unspent: 0, unspentOutputs: [] };
    if (isSpent) {
      entry.spent += 1;
    } else {
      entry.unspent += 1;
      entry.unspentOutputs.push({ txid: out.txid, vout: out.vout, amountSats: out.amountSats });
    }
    dustByAddress.set(out.address, entry);
  }

  const results: DustingResult[] = [];
  for (const [address, counts] of dustByAddress) {
    const meta = addressMap.get(address);
    if (!meta) continue;
    const total = counts.spent + counts.unspent;
    if (total === 0) continue;
    results.push({
      recordId: meta.recordId,
      address,
      totalCount: total,
      spentCount: counts.spent,
      unspentCount: counts.unspent,
      unspentOutputs: counts.unspentOutputs,
    });
  }

  results.sort((a, b) => b.totalCount - a.totalCount || a.address.localeCompare(b.address));
  return { results, scannedAddresses };
}

export default function DustedPage() {
  const [scopeType, setScopeType] = useState<ScopeType>("all");
  const [scopeValue, setScopeValue] = useState<string>("");
  const [thresholdInput, setThresholdInput] = useState<string>(String(DEFAULT_DUST_THRESHOLD));
  const [threshold, setThreshold] = useState<number>(DEFAULT_DUST_THRESHOLD);

  const [phase, setPhase] = useState<"idle" | "computing" | "done">("idle");
  const [scanOutcome, setScanOutcome] = useState<DustScanOutcome | null>(null);
  const results = scanOutcome?.results ?? null;
  const [progressMsg, setProgressMsg] = useState<string>("");
  const [cancelling, setCancelling] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  // Live set of already-flagged outpoints so each row can show Mark vs Unmark.
  const dustFlags = useLiveQuery(() => getAllDustFlags());
  const flaggedOutpoints = useMemo(
    () => new Set((dustFlags ?? []).map((f) => f.outpoint)),
    [dustFlags],
  );
  const [flagBusyAddress, setFlagBusyAddress] = useState<string | null>(null);
  const [cleaningStale, setCleaningStale] = useState(false);
  const [flagBusyOutpoint, setFlagBusyOutpoint] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  const toggleExpanded = useCallback((recordId: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(recordId)) {
        next.delete(recordId);
      } else {
        next.add(recordId);
      }
      return next;
    });
  }, []);

  // ── Stale-flag detection ───────────────────────────────────────────────────
  //
  // A dust flag is "stale" when its address was covered by the last scan but
  // its outpoint is no longer an unspent dust output under the current
  // threshold/scope (e.g. it got spent, or the threshold was lowered). Flags on
  // addresses OUTSIDE the scanned scope are never considered stale — we simply
  // don't know their status.
  const staleFlags = useMemo(() => {
    if (!scanOutcome || !dustFlags) return [];
    const liveOutpoints = new Set<string>();
    for (const row of scanOutcome.results) {
      for (const o of row.unspentOutputs) {
        liveOutpoints.add(toOutpoint(o.txid, o.vout));
      }
    }
    return dustFlags.filter(
      (f) => scanOutcome.scannedAddresses.has(f.address) && !liveOutpoints.has(f.outpoint),
    );
  }, [scanOutcome, dustFlags]);

  const handleCleanStaleFlags = useCallback(async () => {
    if (staleFlags.length === 0) return;
    setCleaningStale(true);
    try {
      const removed = await unmarkDustOutpoints(staleFlags.map((f) => f.outpoint));
      toast({
        title: "Stale dust flags removed",
        description: `${removed} flag${removed !== 1 ? "s" : ""} no longer matching an unspent dust output ${removed !== 1 ? "were" : "was"} removed.`,
      });
    } catch (err) {
      toast({
        title: "Failed to remove stale flags",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setCleaningStale(false);
    }
  }, [staleFlags, toast]);

  const handleMarkAsDust = useCallback(
    async (row: DustingResult) => {
      setFlagBusyAddress(row.address);
      try {
        const added = await markOutpointsAsDust(
          row.unspentOutputs.map((o) => ({
            txid: o.txid,
            vout: o.vout,
            address: row.address,
            amountSats: o.amountSats,
          })),
        );
        toast({
          title: "Marked as dust",
          description:
            added > 0
              ? `${added} unspent output${added !== 1 ? "s" : ""} flagged as dust for this address.`
              : "All unspent dust outputs for this address were already flagged.",
        });
      } catch (err) {
        toast({
          title: "Failed to mark as dust",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      } finally {
        setFlagBusyAddress(null);
      }
    },
    [toast],
  );

  const handleUnmarkDust = useCallback(
    async (row: DustingResult) => {
      setFlagBusyAddress(row.address);
      try {
        const removed = await unmarkDustOutpoints(
          row.unspentOutputs.map((o) => toOutpoint(o.txid, o.vout)),
        );
        toast({
          title: "Dust flags removed",
          description: `${removed} output${removed !== 1 ? "s" : ""} unflagged for this address.`,
        });
      } catch (err) {
        toast({
          title: "Failed to remove dust flags",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      } finally {
        setFlagBusyAddress(null);
      }
    },
    [toast],
  );

  const handleMarkOutput = useCallback(
    async (row: DustingResult, output: { txid: string; vout: number; amountSats: number }) => {
      const outpoint = toOutpoint(output.txid, output.vout);
      setFlagBusyOutpoint(outpoint);
      try {
        const added = await markOutpointsAsDust([
          { txid: output.txid, vout: output.vout, address: row.address, amountSats: output.amountSats },
        ]);
        toast({
          title: "Marked as dust",
          description:
            added > 0
              ? "Output flagged as dust."
              : "This output was already flagged as dust.",
        });
      } catch (err) {
        toast({
          title: "Failed to mark as dust",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      } finally {
        setFlagBusyOutpoint(null);
      }
    },
    [toast],
  );

  const handleUnmarkOutput = useCallback(
    async (output: { txid: string; vout: number }) => {
      const outpoint = toOutpoint(output.txid, output.vout);
      setFlagBusyOutpoint(outpoint);
      try {
        const removed = await unmarkDustOutpoints([outpoint]);
        toast({
          title: removed > 0 ? "Dust flag removed" : "Nothing to remove",
          description:
            removed > 0
              ? "Output unflagged."
              : "This output was not flagged as dust.",
        });
      } catch (err) {
        toast({
          title: "Failed to remove dust flag",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      } finally {
        setFlagBusyOutpoint(null);
      }
    },
    [toast],
  );

  const { walletNames } = useWalletNames();
  const { owners } = useOwners();
  const { seedNames } = useSeedNames();
  const { tags } = useTags();
  const { categories } = useCategories();

  const dbSignal = useDbChangeSignal(["records", "transactionParticipants"]);

  const scopeOptions: Record<GroupBy, { label: string; values: string[] }> = {
    wallet: { label: "Wallet", values: walletNames.map((w) => w.name) },
    seed: { label: "Seed", values: seedNames.map((s) => s.name) },
    owner: { label: "Owner", values: owners.map((o) => o.name) },
    tag: { label: "Tag", values: tags.map((t) => t.name) },
    category: { label: "Category", values: categories.map((c) => c.name) },
  };

  const scopeValueOptions =
    scopeType !== "all" ? scopeOptions[scopeType as GroupBy].values : [];

  const handleScopeTypeChange = (val: string) => {
    setScopeType(val as ScopeType);
    setScopeValue("");
  };

  const commitThreshold = (raw: string) => {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n > 0) {
      setThreshold(n);
    } else {
      setThresholdInput(String(threshold));
    }
  };

  const handleThresholdBlur = () => commitThreshold(thresholdInput);

  const handleThresholdKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") commitThreshold(thresholdInput);
  };

  // ── Core computation runner ────────────────────────────────────────────────
  const runComputation = useCallback(
    async (scopeTypeArg: ScopeType, scopeValueArg: string, thresholdArg: number) => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      setPhase("computing");
      setProgressMsg("");
      setCancelling(false);

      const result = await computeDustings(
        scopeTypeArg,
        scopeValueArg,
        thresholdArg,
        ctrl.signal,
        (count, phaseLabel) => {
          if (!ctrl.signal.aborted) {
            setProgressMsg(
              phaseLabel === "addresses"
                ? `Scanning addresses… ${count.toLocaleString()} checked`
                : `Scanning transactions… ${count.toLocaleString()} participant rows loaded`,
            );
          }
        },
      );

      if (ctrl.signal.aborted) {
        setPhase("idle");
        setCancelling(false);
        return;
      }

      setScanOutcome(result);
      setPhase("done");
    },
    [],
  );

  // ── Auto-recompute when threshold, scope, or underlying data changes ──────
  //
  // We always kick off a scan so the list stays in sync without the user
  // needing to press a button each time a filter changes.
  useEffect(() => {
    // Don't compute when a scoped filter has no value selected yet.
    if (scopeType !== "all" && !scopeValue) return;
    runComputation(scopeType, scopeValue, threshold);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeType, scopeValue, threshold, dbSignal]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handleCancel = () => {
    setCancelling(true);
    abortRef.current?.abort();
  };

  const handleManualRescan = () => {
    if (scopeType !== "all" && !scopeValue) return;
    runComputation(scopeType, scopeValue, threshold);
  };

  type FlatRow =
    | { type: "address"; row: DustingResult }
    | { type: "output"; row: DustingResult; output: { txid: string; vout: number; amountSats: number } };

  const flatRows = useMemo<FlatRow[]>(() => {
    if (!results) return [];
    const rows: FlatRow[] = [];
    for (const row of results) {
      rows.push({ type: "address", row });
      if (expandedIds.has(row.recordId)) {
        for (const output of row.unspentOutputs) {
          rows.push({ type: "output", row, output });
        }
      }
    }
    return rows;
  }, [results, expandedIds]);

  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => (flatRows[index]?.type === "output" ? 44 : 56),
    overscan: 10,
  });

  const isRunDisabled = phase === "computing" || (scopeType !== "all" && !scopeValue);

  return (
    <div className="flex flex-col h-full">
      <div className="flex-none p-4 pb-2 border-b">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <Droplets className="h-5 w-5 text-[hsl(var(--primary))]" />
            <h1 className="text-lg font-semibold" data-testid="text-page-title">Dusted</h1>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Select value={scopeType} onValueChange={handleScopeTypeChange}>
              <SelectTrigger className="w-[160px]" data-testid="select-scope-type">
                <SelectValue placeholder="Scope" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Addresses</SelectItem>
                <SelectItem value="wallet">By Wallet</SelectItem>
                <SelectItem value="seed">By Seed</SelectItem>
                <SelectItem value="owner">By Owner</SelectItem>
                <SelectItem value="tag">By Tag</SelectItem>
                <SelectItem value="category">By Category</SelectItem>
              </SelectContent>
            </Select>

            {scopeType !== "all" && (
              <Select value={scopeValue} onValueChange={setScopeValue}>
                <SelectTrigger className="w-[180px]" data-testid="select-scope-value">
                  <SelectValue placeholder={`Select ${scopeOptions[scopeType as GroupBy].label}`} />
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
              <span className="text-sm text-muted-foreground whitespace-nowrap">Dust threshold:</span>
              <Input
                data-testid="input-dust-threshold"
                className="w-[90px]"
                value={thresholdInput}
                onChange={(e) => setThresholdInput(e.target.value)}
                onBlur={handleThresholdBlur}
                onKeyDown={handleThresholdKeyDown}
                type="number"
                min={1}
              />
              <span className="text-sm text-muted-foreground">sats</span>
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
                onClick={handleManualRescan}
                disabled={isRunDisabled}
                data-testid="button-run-scan"
              >
                <RefreshCw className="h-4 w-4 mr-1" />
                {phase === "done" ? "Re-scan" : "Scan"}
              </Button>
            )}
          </div>
        </div>

        {phase === "computing" && (
          <div className="mt-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span className="flex-1">{progressMsg || "Scanning…"}</span>
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
            <Droplets className="h-10 w-10 opacity-30" />
            <p className="text-sm">
              Select a scope and threshold, then click <strong>Scan</strong> to detect dusting attempts.
            </p>
          </div>
        )}

        {phase === "computing" && results === null && (
          <div
            className="flex flex-col items-center justify-center flex-1 gap-3 text-muted-foreground"
            data-testid="state-computing"
          >
            <Loader2 className="h-8 w-8 animate-spin opacity-40" />
            <p className="text-sm">Computing dustings…</p>
          </div>
        )}

        {phase === "done" && results !== null && results.length === 0 && (
          <div
            className="flex flex-col items-center justify-center flex-1 gap-3 text-muted-foreground"
            data-testid="state-empty"
          >
            <Droplets className="h-10 w-10 opacity-30" />
            <p className="text-sm font-medium">No dusting detected for this scope.</p>
            <p className="text-xs">
              No tracked address received an output strictly below{" "}
              {threshold.toLocaleString()} sats.
            </p>
          </div>
        )}

        {phase === "done" && staleFlags.length > 0 && (
          <div
            className="flex-none mx-4 mt-3 px-3 py-2 rounded-md border flex items-center gap-3 flex-wrap"
            data-testid="banner-stale-flags"
          >
            <FlagOff className="h-4 w-4 text-muted-foreground flex-none" />
            <span className="text-sm flex-1 min-w-0" data-testid="text-stale-flags-summary">
              <span className="font-medium">{staleFlags.length.toLocaleString()}</span> dust flag
              {staleFlags.length !== 1 ? "s" : ""} no longer match{staleFlags.length === 1 ? "es" : ""} an
              unspent dust output under the current threshold and scope.
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={cleaningStale}
              onClick={handleCleanStaleFlags}
              data-testid="button-clean-stale-flags"
            >
              {cleaningStale ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              ) : (
                <FlagOff className="h-3 w-3 mr-1" />
              )}
              Remove stale flags
            </Button>
          </div>
        )}

        {phase === "done" && results !== null && results.length > 0 && (
          <div className="flex flex-col flex-1 min-h-0">
            <div
              className="flex-none px-4 py-2 border-b text-xs text-muted-foreground flex items-center gap-2"
              data-testid="text-results-summary"
            >
              <span>
                <span className="font-medium text-foreground">
                  {results.length.toLocaleString()}
                </span>{" "}
                address{results.length !== 1 ? "es" : ""} with dustings strictly below{" "}
                <span className="font-medium text-foreground">
                  {threshold.toLocaleString()}
                </span>{" "}
                sats
              </span>
            </div>

            <div className="flex-none px-4 py-2 border-b grid grid-cols-[1fr_auto_auto_auto_auto] gap-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">
              <span>Address</span>
              <span className="w-20 text-right">Total</span>
              <span className="w-20 text-right">Unspent</span>
              <span className="w-20 text-right">Spent</span>
              <span className="w-32 text-right">Action</span>
            </div>

            <div
              ref={parentRef}
              className="flex-1 min-h-0 overflow-y-auto"
              data-testid="list-dusted-results"
            >
              <div
                style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}
              >
                {virtualizer.getVirtualItems().map((vItem) => {
                  const flatRow = flatRows[vItem.index];
                  if (!flatRow) return null;

                  if (flatRow.type === "output") {
                    const { row, output } = flatRow;
                    const outpoint = toOutpoint(output.txid, output.vout);
                    const isFlagged = flaggedOutpoints.has(outpoint);
                    const busy = flagBusyOutpoint === outpoint || flagBusyAddress === row.address;
                    return (
                      <div
                        key={`${row.recordId}-${outpoint}`}
                        data-testid={`row-dust-output-${row.recordId}-${output.txid}-${output.vout}`}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          height: `${vItem.size}px`,
                          transform: `translateY(${vItem.start}px)`,
                        }}
                        className="flex items-center gap-4 pl-12 pr-4 border-b last:border-b-0 bg-muted/30"
                      >
                        <span
                          className="flex-1 min-w-0 truncate font-mono text-xs text-muted-foreground"
                          data-testid={`text-outpoint-${row.recordId}-${output.txid}-${output.vout}`}
                          title={outpoint}
                        >
                          {output.txid}:{output.vout}
                        </span>
                        <span
                          className="text-xs tabular-nums text-muted-foreground whitespace-nowrap"
                          data-testid={`text-output-sats-${row.recordId}-${output.txid}-${output.vout}`}
                        >
                          {output.amountSats.toLocaleString()} sats
                        </span>
                        <div className="w-32 flex justify-end">
                          {isFlagged ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() => handleUnmarkOutput(output)}
                              data-testid={`button-unmark-output-${row.recordId}-${output.txid}-${output.vout}`}
                            >
                              {flagBusyOutpoint === outpoint ? (
                                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                              ) : (
                                <FlagOff className="h-3 w-3 mr-1" />
                              )}
                              Unmark
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() => handleMarkOutput(row, output)}
                              data-testid={`button-mark-output-${row.recordId}-${output.txid}-${output.vout}`}
                            >
                              {flagBusyOutpoint === outpoint ? (
                                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                              ) : (
                                <Flag className="h-3 w-3 mr-1" />
                              )}
                              Mark
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  }

                  const row = flatRow.row;
                  const isExpanded = expandedIds.has(row.recordId);
                  return (
                    <div
                      key={row.recordId}
                      data-testid={`row-dusted-${row.recordId}`}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        height: `${vItem.size}px`,
                        transform: `translateY(${vItem.start}px)`,
                      }}
                      className="flex items-center px-4 border-b last:border-b-0"
                    >
                      <div className="flex-1 min-w-0 flex items-center gap-1">
                        {row.unspentOutputs.length > 0 ? (
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => toggleExpanded(row.recordId)}
                            data-testid={`button-toggle-outputs-${row.recordId}`}
                            aria-label={isExpanded ? "Collapse outputs" : "Expand outputs"}
                          >
                            {isExpanded ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                          </Button>
                        ) : (
                          <span className="w-9 flex-none" />
                        )}
                        <div className="flex-1 min-w-0">
                          <AddressLink
                            address={row.address}
                            recordId={row.recordId}
                            truncate
                            showCopy={false}
                          />
                        </div>
                      </div>

                      <div className="w-20 text-right">
                        <Badge
                          variant="secondary"
                          className="no-default-hover-elevate no-default-active-elevate tabular-nums"
                          data-testid={`badge-total-${row.recordId}`}
                        >
                          {row.totalCount}
                        </Badge>
                      </div>

                      <div className="w-20 text-right">
                        {row.unspentCount > 0 ? (
                          <Badge
                            className="no-default-hover-elevate no-default-active-elevate tabular-nums bg-orange-500 text-white"
                            data-testid={`badge-unspent-${row.recordId}`}
                          >
                            {row.unspentCount}
                          </Badge>
                        ) : (
                          <span
                            className="text-xs text-muted-foreground"
                            data-testid={`badge-unspent-${row.recordId}`}
                          >
                            —
                          </span>
                        )}
                      </div>

                      <div className="w-20 text-right">
                        {row.spentCount > 0 ? (
                          <span
                            className="text-sm text-muted-foreground tabular-nums"
                            data-testid={`badge-spent-${row.recordId}`}
                          >
                            {row.spentCount}
                          </span>
                        ) : (
                          <span
                            className="text-xs text-muted-foreground"
                            data-testid={`badge-spent-${row.recordId}`}
                          >
                            —
                          </span>
                        )}
                      </div>

                      <div className="w-32 flex justify-end">
                        {(() => {
                          if (row.unspentOutputs.length === 0) {
                            return (
                              <span
                                className="text-xs text-muted-foreground"
                                data-testid={`text-no-action-${row.recordId}`}
                              >
                                —
                              </span>
                            );
                          }
                          const flaggedCount = row.unspentOutputs.filter((o) =>
                            flaggedOutpoints.has(toOutpoint(o.txid, o.vout)),
                          ).length;
                          const allFlagged = flaggedCount === row.unspentOutputs.length;
                          const busy = flagBusyAddress === row.address;
                          return allFlagged ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() => handleUnmarkDust(row)}
                              data-testid={`button-unmark-dust-${row.recordId}`}
                            >
                              {busy ? (
                                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                              ) : (
                                <FlagOff className="h-3 w-3 mr-1" />
                              )}
                              Unmark
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() => handleMarkAsDust(row)}
                              data-testid={`button-mark-dust-${row.recordId}`}
                            >
                              {busy ? (
                                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                              ) : (
                                <Flag className="h-3 w-3 mr-1" />
                              )}
                              Mark as dust
                            </Button>
                          );
                        })()}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

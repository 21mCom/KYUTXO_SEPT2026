import { useState, useRef, useEffect } from "react";
import { RefreshCw, Loader2 } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useSettings, updateDisableOrphanCheck } from "@/hooks/use-settings";
import { recomputeAddressStats } from "@/lib/data/address-stats";
import {
  detectAndBackfill,
  resolveAllBlankInputAddresses,
  formatSkippedReasons,
  type BackfillResult,
} from "@/lib/txid-backfill";
import { describeResolveError } from "@/lib/resolve-error";

// Maintenance tooling for the Data Management card: recompute cached address
// stats, rebuild missing (orphaned) transactions, the startup missing-data
// reminder toggle, and the whole-database resolve-blank-input-addresses pass.
// Split out of data-management-section.tsx so each flow stays reviewable.
export function MaintenanceToolsSection() {
  const { toast } = useToast();
  const { disableOrphanCheck, isLoading: settingsLoading } = useSettings();

  const [isRecomputingStats, setIsRecomputingStats] = useState(false);
  const [recomputeProgress, setRecomputeProgress] = useState(0);
  const [recomputeMessage, setRecomputeMessage] = useState("");
  const recomputeAbortRef = useRef<AbortController | null>(null);

  // Txid backfill state (post-restore and manual)
  const [isBackfilling, setIsBackfilling] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState(0);
  const [backfillMessage, setBackfillMessage] = useState("");
  const [backfillResult, setBackfillResult] = useState<BackfillResult | null>(null);
  const backfillAbortRef = useRef<AbortController | null>(null);
  const rebuildSectionRef = useRef<HTMLDivElement | null>(null);
  // Mirrors isBackfilling so the autoBackfill consumer (an event listener added
  // once) can read the live value without stale-closure issues.
  const isBackfillingRef = useRef(false);
  // Set when "Fix now" arrives while a rebuild is already running, so the
  // rebuild restarts once the current one finishes instead of being dropped.
  const autoBackfillQueuedRef = useRef(false);
  // Keep the ref in lockstep with the state so the once-added event listener
  // always reads the live in-progress value.
  isBackfillingRef.current = isBackfilling;

  // Resolve blank input addresses (whole-database one-off pass) state
  const [isResolvingInputs, setIsResolvingInputs] = useState(false);
  const [resolveInputsProgress, setResolveInputsProgress] = useState(0);
  const [resolveInputsMessage, setResolveInputsMessage] = useState("");
  const resolveInputsAbortRef = useRef<AbortController | null>(null);

  const handleRecomputeStats = async () => {
    const controller = new AbortController();
    recomputeAbortRef.current = controller;
    setIsRecomputingStats(true);
    setRecomputeProgress(0);
    setRecomputeMessage("Preparing...");
    try {
      const result = await recomputeAddressStats({
        origin: "user",
        signal: controller.signal,
        onProgress: ({ processed, total }) => {
          const pct = total > 0 ? Math.round((processed / total) * 100) : 100;
          setRecomputeProgress(pct);
          setRecomputeMessage(
            total > 0
              ? `Processed ${processed.toLocaleString()} of ${total.toLocaleString()} addresses...`
              : "No address records to process.",
          );
        },
      });
      if (result.cancelled) {
        toast({
          title: "Recompute Cancelled",
          description: `Stopped after updating ${result.updated.toLocaleString()} address${result.updated !== 1 ? "es" : ""}.`,
        });
      } else {
        toast({
          title: "Stats Recomputed",
          description: `Updated cached stats for ${result.updated.toLocaleString()} address${result.updated !== 1 ? "es" : ""}.`,
        });
      }
    } catch (error) {
      console.error("Recompute address stats failed:", error);
      toast({
        variant: "destructive",
        title: "Recompute Failed",
        description: error instanceof Error ? error.message : "An error occurred while recomputing stats.",
      });
    } finally {
      recomputeAbortRef.current = null;
      setIsRecomputingStats(false);
      setRecomputeProgress(0);
      setRecomputeMessage("");
    }
  };

  const handleCancelRecompute = () => {
    recomputeAbortRef.current?.abort();
    setRecomputeMessage("Cancelling...");
  };

  // Manual backfill: detect orphaned txids and fetch their on-chain data
  const handleManualBackfill = async () => {
    const controller = new AbortController();
    backfillAbortRef.current = controller;
    isBackfillingRef.current = true;
    setIsBackfilling(true);
    setBackfillProgress(0);
    setBackfillMessage("Scanning for orphaned transaction records...");
    setBackfillResult(null);

    try {
      const result = await detectAndBackfill({
        signal: controller.signal,
        onProgress: (p) => {
          if (p.phase === 'scanning') {
            setBackfillProgress(2);
            setBackfillMessage("Scanning for orphaned transaction records...");
          } else if (p.phase === 'fetching') {
            const pct = p.orphansFound > 0
              ? Math.round(4 + (p.processed / p.orphansFound) * 94)
              : 98;
            setBackfillProgress(pct);
            setBackfillMessage(
              `Rebuilding ${p.processed.toLocaleString()} of ${p.orphansFound.toLocaleString()} transactions...`
            );
          } else if (p.phase === 'resolving') {
            if (p.fetchTotal && p.fetchTotal > 0) {
              // Fetch sub-phase occupies the first half of the resolving bar.
              const pct = Math.round((p.fetchProcessed ?? 0) / p.fetchTotal * 50);
              setBackfillProgress(pct);
              setBackfillMessage(
                `Fetching previous transactions... ${(p.fetchProcessed ?? 0).toLocaleString()} of ${p.fetchTotal.toLocaleString()}`
              );
            } else if (p.resolveTotal && p.resolveTotal > 0) {
              // Write sub-phase occupies the second half of the resolving bar.
              const pct = 50 + Math.round((p.resolveProcessed ?? 0) / p.resolveTotal * 50);
              setBackfillProgress(pct);
              setBackfillMessage(
                `Resolving input addresses... ${(p.resolveProcessed ?? 0).toLocaleString()} of ${p.resolveTotal.toLocaleString()}`
              );
            } else {
              setBackfillProgress(99);
              setBackfillMessage("Resolving input addresses...");
            }
          } else if (p.phase === 'complete' || p.phase === 'deferred') {
            setBackfillProgress(100);
            setBackfillMessage("Done.");
          }
        },
      });

      setBackfillResult(result);

      if (result.deferred) {
        toast({
          title: "Transaction Rebuild Deferred",
          description: result.deferReason ?? "No connectivity. Run again when a blockchain node is reachable.",
        });
      } else if (result.orphansFound === 0) {
        toast({
          title: "No Orphaned Transactions",
          description: "All transaction records already have on-chain data.",
        });
      } else {
        const parts: string[] = [];
        if (result.rebuilt > 0) parts.push(`${result.rebuilt} rebuilt`);
        if (result.skipped > 0) {
          const skippedDetail = formatSkippedReasons(result.skippedReasons);
          parts.push(skippedDetail || `${result.skipped} skipped`);
        }
        if (result.failed > 0) parts.push(`${result.failed} failed`);
        toast({
          title: "Transaction Rebuild Complete",
          description: `Found ${result.orphansFound} orphaned transaction${result.orphansFound !== 1 ? "s" : ""}. ${parts.join("; ")}.`,
        });
      }
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Transaction Rebuild Failed",
        description: err instanceof Error ? err.message : "An error occurred.",
      });
    } finally {
      backfillAbortRef.current = null;
      isBackfillingRef.current = false;
      setIsBackfilling(false);
      setBackfillProgress(0);
      setBackfillMessage("");
      // A "Fix now" that arrived mid-rebuild was queued rather than dropped;
      // start it now that the current rebuild has finished.
      if (autoBackfillQueuedRef.current) {
        autoBackfillQueuedRef.current = false;
        rebuildSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        void handleManualBackfill();
      }
    }
  };

  const handleCancelBackfill = () => {
    backfillAbortRef.current?.abort();
    setBackfillMessage("Cancelling...");
  };

  // One-off pass: resolve blank input addresses across the entire database, not
  // just txids rebuilt in the current run. Covers transactions rebuilt by older
  // backfills before automatic prevout resolution existed.
  const handleResolveInputs = async () => {
    const controller = new AbortController();
    resolveInputsAbortRef.current = controller;
    setIsResolvingInputs(true);
    setResolveInputsProgress(2);
    setResolveInputsMessage("Scanning for inputs missing addresses...");

    try {
      const result = await resolveAllBlankInputAddresses({
        signal: controller.signal,
        onProgress: (p) => {
          if (p.phase === "scanning") {
            setResolveInputsProgress(5);
            setResolveInputsMessage(
              `Scanning for inputs missing addresses... (${p.unresolvedFound.toLocaleString()} found)`,
            );
          } else if (p.phase === "resolving") {
            const pct = p.totalToFetch > 0
              ? Math.round(10 + (p.fetched / p.totalToFetch) * 88)
              : 50;
            setResolveInputsProgress(pct);
            setResolveInputsMessage(
              p.totalToFetch > 0
                ? `Resolving addresses... fetched ${p.fetched.toLocaleString()} of ${p.totalToFetch.toLocaleString()} prior transactions`
                : "Resolving addresses from local data...",
            );
          } else if (p.phase === "recomputing") {
            if (p.recomputeTotal && p.recomputeTotal > 0) {
              const pct = Math.round(
                (p.recomputeProcessed ?? 0) / p.recomputeTotal * 100,
              );
              setResolveInputsProgress(pct);
              setResolveInputsMessage(
                `Updating balances... ${(p.recomputeProcessed ?? 0).toLocaleString()} of ${p.recomputeTotal.toLocaleString()} addresses`,
              );
            } else {
              setResolveInputsProgress(99);
              setResolveInputsMessage("Updating balances...");
            }
          } else if (p.phase === "complete") {
            setResolveInputsProgress(100);
            setResolveInputsMessage("Done.");
          }
        },
      });

      if (result.deferred) {
        toast({
          title: "Resolution Deferred",
          description: result.deferReason ?? "No connectivity. Try again when a blockchain node is reachable.",
        });
      } else if (result.cancelled) {
        const recomputeNote =
          result.recomputed > 0
            ? ` Updated balances for ${result.recomputed.toLocaleString()} address${result.recomputed !== 1 ? "es" : ""}.`
            : "";
        toast({
          title: "Resolution Cancelled",
          description: `Cancelled after resolving ${result.resolved.toLocaleString()} input address${result.resolved !== 1 ? "es" : ""}.${recomputeNote}`,
        });
      } else if (result.errors.length > 0) {
        toast({
          variant: "destructive",
          title: "Resolution Finished With Errors",
          description: `Resolved ${result.resolved.toLocaleString()} input address${result.resolved !== 1 ? "es" : ""}. ${result.errors[0]}`,
        });
      } else if (result.unresolvedFound === 0) {
        toast({
          title: "No Missing Input Addresses",
          description: "All transaction inputs already have resolved addresses.",
        });
      } else {
        const recomputeNote =
          result.recomputed > 0
            ? ` Updated balances for ${result.recomputed.toLocaleString()} address${result.recomputed !== 1 ? "es" : ""}.`
            : "";
        toast({
          title: "Input Addresses Resolved",
          description: `Resolved ${result.resolved.toLocaleString()} of ${result.unresolvedFound.toLocaleString()} blank input address${result.unresolvedFound !== 1 ? "es" : ""}.${recomputeNote}`,
        });
      }
    } catch (err) {
      console.warn("[SettingsPage] Resolve input addresses failed:", err);
      toast({
        variant: "destructive",
        title: "Resolution Failed",
        description: describeResolveError(err),
      });
    } finally {
      resolveInputsAbortRef.current = null;
      setIsResolvingInputs(false);
      setResolveInputsProgress(0);
      setResolveInputsMessage("");
    }
  };

  const handleCancelResolveInputs = () => {
    resolveInputsAbortRef.current?.abort();
    setResolveInputsMessage("Cancelling...");
  };

  // When the user opens Settings via the startup "missing transaction data"
  // notification, a one-shot sessionStorage flag is set. Consume it here to
  // scroll to and automatically start the rebuild.
  //
  // The flag can be set in two ways:
  //  1. The user is NOT on Settings — "Fix now" navigates here and this effect
  //     consumes the flag on mount.
  //  2. The user is ALREADY on Settings — no remount happens, so OrphanedTxNotifier
  //     dispatches a `kyutxo:autoBackfill` window event that this effect also
  //     listens for. Without it, the flag would sit unconsumed and the rebuild
  //     would silently never auto-start.
  //
  // A rebuild already in progress doesn't drop the request: the flag is still
  // consumed and the rebuild is queued to restart when the current one finishes.
  const consumeAutoBackfillRef = useRef<() => void>(() => {});
  consumeAutoBackfillRef.current = () => {
    if (sessionStorage.getItem("kyutxo:autoBackfill") !== "1") return;
    sessionStorage.removeItem("kyutxo:autoBackfill");
    rebuildSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (isBackfillingRef.current) {
      autoBackfillQueuedRef.current = true;
      toast({
        title: "Rebuild Queued",
        description: "A transaction rebuild is already running. It will restart automatically once the current one finishes.",
      });
      return;
    }
    void handleManualBackfill();
  };

  useEffect(() => {
    consumeAutoBackfillRef.current();
    const onAutoBackfill = () => consumeAutoBackfillRef.current();
    window.addEventListener("kyutxo:autoBackfill", onAutoBackfill);
    return () => window.removeEventListener("kyutxo:autoBackfill", onAutoBackfill);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <Label className="text-base">Recompute Address Stats</Label>
                <p className="text-sm text-muted-foreground">
                  Rebuild cached balances, transaction counts, and last-activity dates from locally stored data. No network access.
                </p>
              </div>
              <Button
                variant="outline"
                onClick={handleRecomputeStats}
                disabled={isRecomputingStats}
                data-testid="button-recompute-stats"
              >
                {isRecomputingStats ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Recomputing...
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Recompute
                  </>
                )}
              </Button>
            </div>

      <Separator />

            <div ref={rebuildSectionRef} className="space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <Label className="text-base">Rebuild Missing Transactions</Label>
                  <p className="text-sm text-muted-foreground">
                    Fetch on-chain data for transaction records that were restored from an older backup or added manually without syncing. Requires a connected blockchain provider.
                  </p>
                </div>
                <Button
                  variant="outline"
                  onClick={handleManualBackfill}
                  disabled={isBackfilling}
                  data-testid="button-rebuild-transactions"
                >
                  {isBackfilling ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Rebuilding...
                    </>
                  ) : (
                    <>
                      <RefreshCw className="h-4 w-4 mr-2" />
                      Rebuild
                    </>
                  )}
                </Button>
              </div>
              {backfillResult && !isBackfilling && !backfillResult.deferred && (
                <div className="rounded-md border bg-muted/40 px-4 py-3 space-y-1 text-sm" data-testid="rebuild-result-summary">
                  <div className="font-medium text-foreground">Last rebuild result</div>
                  <div className="text-muted-foreground space-y-0.5">
                    {backfillResult.orphansFound === 0 ? (
                      <p>No orphaned transactions found — everything is up to date.</p>
                    ) : (
                      <>
                        <p>
                          Found {backfillResult.orphansFound.toLocaleString()} orphaned transaction{backfillResult.orphansFound !== 1 ? "s" : ""}.
                          {backfillResult.rebuilt > 0 && ` ${backfillResult.rebuilt.toLocaleString()} rebuilt.`}
                          {backfillResult.failed > 0 && ` ${backfillResult.failed.toLocaleString()} failed.`}
                          {backfillResult.prevoutsResolved > 0 && ` ${backfillResult.prevoutsResolved.toLocaleString()} input address${backfillResult.prevoutsResolved !== 1 ? "es" : ""} resolved.`}
                        </p>
                        {backfillResult.skipped > 0 && (() => {
                          const skippedText = formatSkippedReasons(backfillResult.skippedReasons);
                          const hasNotFound = (backfillResult.skippedReasons['not-found'] ?? 0) > 0;
                          return (
                            <>
                              <p>Skipped: {skippedText || `${backfillResult.skipped.toLocaleString()} skipped`}.</p>
                              {hasNotFound && (
                                <p className="text-muted-foreground/80 text-xs mt-1">
                                  Transactions not found on your provider usually mean a network mismatch (e.g. testnet IDs against a mainnet node) or a node that does not carry the full transaction history.
                                </p>
                              )}
                            </>
                          );
                        })()}
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>

      <Separator />

            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <Label className="text-base">Startup Missing-Data Reminder</Label>
                <p className="text-sm text-muted-foreground">
                  Show a one-per-session reminder when transaction records are missing on-chain data. Turn this off if you knowingly keep records without on-chain data.
                </p>
              </div>
              <Switch
                checked={!disableOrphanCheck}
                onCheckedChange={async (checked) => {
                  await updateDisableOrphanCheck(!checked);
                }}
                disabled={settingsLoading}
                data-testid="switch-orphan-check"
              />
            </div>

      <Separator />

            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <Label className="text-base">Resolve Input Addresses</Label>
                <p className="text-sm text-muted-foreground">
                  Fill in missing input addresses across all transactions, including ones rebuilt by earlier imports. Requires a connected blockchain provider.
                </p>
              </div>
              <Button
                variant="outline"
                onClick={handleResolveInputs}
                disabled={isResolvingInputs}
                data-testid="button-resolve-inputs"
              >
                {isResolvingInputs ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Resolving...
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Resolve
                  </>
                )}
              </Button>
            </div>

      <Dialog open={isRecomputingStats}>
        <DialogContent className="sm:max-w-md" data-testid="dialog-recompute-stats">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5" />
              Recomputing Address Stats
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <Progress value={recomputeProgress} data-testid="progress-recompute-stats" />
            <p className="text-sm text-muted-foreground" data-testid="text-recompute-message">
              {recomputeMessage}
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={handleCancelRecompute}
              data-testid="button-cancel-recompute"
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isBackfilling}>
        <DialogContent className="sm:max-w-md" data-testid="dialog-backfill-transactions">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5" />
              Rebuilding Missing Transaction Data
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <Progress value={backfillProgress} data-testid="progress-backfill" />
            <p className="text-sm text-muted-foreground" data-testid="text-backfill-message">
              {backfillMessage}
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={handleCancelBackfill}
              data-testid="button-cancel-backfill"
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isResolvingInputs}>
        <DialogContent className="sm:max-w-md" data-testid="dialog-resolve-inputs">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5" />
              Resolving Input Addresses
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <Progress value={resolveInputsProgress} data-testid="progress-resolve-inputs" />
            <p className="text-sm text-muted-foreground" data-testid="text-resolve-inputs-message">
              {resolveInputsMessage}
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={handleCancelResolveInputs}
              data-testid="button-cancel-resolve-inputs"
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

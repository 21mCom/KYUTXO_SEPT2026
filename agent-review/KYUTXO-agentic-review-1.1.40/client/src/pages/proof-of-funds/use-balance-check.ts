// Balance-resolution state and logic for the Proof of Funds page (Steps 1-2 +
// the results table). Extracted from ProofOfFundsDeclaration.tsx with zero
// behavior change so the page stays a thin orchestrator.
import { useState, useRef, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import {
  createProviderFromSettings,
  isNodeUnreachableError,
  NODE_PROBE_TIMEOUT_MS,
  NODE_UNREACHABLE_CONSECUTIVE_LIMIT,
} from "@/lib/blockchain-api";
import { computeStatsForAddresses } from "@/lib/data/address-stats";
import { getRecordsByType } from "@/lib/data/record-crud";
import { msToUnixSeconds } from "@/lib/unix-seconds";
import {
  type BalanceSource,
  type AddressRow,
  type BalanceSummary,
  parseAddressInput,
  formatUnix,
} from "./address-helpers";

export interface UseBalanceCheckParams {
  nodeSettings: Parameters<typeof createProviderFromSettings>[0];
  /** Called by handleReset alongside clearing balance state (e.g. to clear proof-of-control states). */
  onReset: () => void;
}

export function useBalanceCheck({ nodeSettings, onReset }: UseBalanceCheckParams) {
  const { toast } = useToast();

  // Address input
  const [addressTab, setAddressTab] = useState<"paste" | "vault">("paste");
  const [pastedText, setPastedText] = useState("");
  const [filterOwner, setFilterOwner] = useState<string>("all");
  const [filterWallet, setFilterWallet] = useState<string>("all");

  // Balance resolution
  const [balanceSource, setBalanceSource] = useState<BalanceSource>("offline");
  const [rows, setRows] = useState<AddressRow[]>([]);
  const [dupes, setDupes] = useState(0);
  const [isChecking, setIsChecking] = useState(false);
  const [summary, setSummary] = useState<BalanceSummary | null>(null);
  const [providerError, setProviderError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const resolveAddresses = useCallback(async (): Promise<string[]> => {
    if (addressTab === "paste") {
      return pastedText
        .split(/[\n,;]+/)
        .map((a) => a.trim())
        .filter((a) => a.length > 0);
    }
    const allRecords = await getRecordsByType("address");
    let filtered = allRecords;
    if (filterOwner !== "all") filtered = filtered.filter((r) => r.owner === filterOwner);
    if (filterWallet !== "all") filtered = filtered.filter((r) => r.walletName === filterWallet);
    return filtered.map((r) => r.inputString).filter((s) => s.length > 0);
  }, [addressTab, pastedText, filterOwner, filterWallet]);

  const runCheck = useCallback(async () => {
    setProviderError(null);
    setSummary(null);

    const rawAddresses = await resolveAddresses();
    if (rawAddresses.length === 0) {
      toast({ title: "No Addresses", description: "Please enter or select at least one address." });
      return;
    }

    const { rows: parsed, dupes: d } = parseAddressInput(rawAddresses.join("\n"));
    setRows(parsed);
    setDupes(d);
    setIsChecking(true);
    cancelledRef.current = false;

    const validIndices = parsed
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => !r.isInvalid);

    if (balanceSource === "live") {
      let provider: ReturnType<typeof createProviderFromSettings>;
      try {
        provider = createProviderFromSettings(nodeSettings);
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Failed to create provider.";
        setProviderError(msg);
        setIsChecking(false);
        return;
      }

      let blockHeight: number | undefined;
      try {
        blockHeight = await provider.getBlockHeight();
      } catch {
        // Non-fatal — still proceed without block height
      }

      const nowTs = Math.floor(Date.now() / 1000);

      const fetchBalanceSats = async (
        address: string,
        signal?: AbortSignal,
      ): Promise<number> => {
        if (provider.getAddressCoreStats) {
          const info = await provider.getAddressCoreStats(address, signal);
          return info.balanceSats ?? 0;
        } else if (provider.getAddressInfo) {
          const info = await provider.getAddressInfo(address);
          return info.balanceSats ?? 0;
        } else {
          const { computeHistoryFromTxs } = await import("@/lib/providers/address-history");
          const txs = await provider.getAddressTransactions(address);
          const history = computeHistoryFromTxs(address, txs);
          return (history.receivedSats ?? 0) - (history.sentSats ?? 0);
        }
      };

      let isFirstAttempt = true;
      let hadSuccess = false;
      let consecutiveNodeFailures = 0;
      for (const { i } of validIndices) {
        if (cancelledRef.current) break;
        setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, status: "loading" } : r)));
        const address = parsed[i].raw;
        const attemptIsFirst = isFirstAttempt;
        try {
          let balanceSats: number;
          if (attemptIsFirst) {
            // Cap the very first attempt so an unreachable node fails fast instead
            // of hanging for the full per-request timeout on every address. Abort
            // the in-flight request and reject the race once the cap is hit.
            const controller = new AbortController();
            let probeTimer: ReturnType<typeof setTimeout> | undefined;
            try {
              balanceSats = await Promise.race([
                fetchBalanceSats(address, controller.signal),
                new Promise<number>((_, reject) => {
                  probeTimer = setTimeout(() => {
                    controller.abort(
                      new DOMException("Node probe timed out", "TimeoutError"),
                    );
                    reject(
                      new Error(
                        `Node unreachable — no response within ${NODE_PROBE_TIMEOUT_MS / 1000}s.`,
                      ),
                    );
                  }, NODE_PROBE_TIMEOUT_MS);
                }),
              ]);
            } finally {
              if (probeTimer) clearTimeout(probeTimer);
            }
          } else {
            balanceSats = await fetchBalanceSats(address);
          }
          isFirstAttempt = false;
          hadSuccess = true;
          consecutiveNodeFailures = 0;
          setRows((prev) =>
            prev.map((r, idx) =>
              idx === i
                ? { ...r, status: balanceSats === 0 ? "empty" : "done", balanceSats }
                : r
            )
          );
        } catch (err) {
          if (cancelledRef.current) break;
          const nodeUnreachable = isNodeUnreachableError(err);
          // On the first attempt, a node-level connectivity failure means the
          // node is unreachable: fail the whole check immediately rather than
          // grinding through every address. Transient/per-address errors still
          // surface per-row (here and on later addresses).
          if (attemptIsFirst && nodeUnreachable) {
            setProviderError(
              "Node unreachable — the on-chain balance check could not reach your node.",
            );
            setRows((prev) =>
              prev.map((r) => (r.status === "loading" ? { ...r, status: "pending" } : r))
            );
            setIsChecking(false);
            return;
          }
          isFirstAttempt = false;
          // After a successful start, the node going down partway through shows up
          // as a run of consecutive node-unreachable failures. Short-circuit the
          // whole check rather than grinding through the rest one timeout at a
          // time. A single transient failure (or any non-node error) stays below
          // the threshold and resets the run, so isolated 429/500/404s continue.
          if (nodeUnreachable) {
            consecutiveNodeFailures += 1;
          } else {
            consecutiveNodeFailures = 0;
          }
          if (
            hadSuccess &&
            nodeUnreachable &&
            consecutiveNodeFailures >= NODE_UNREACHABLE_CONSECUTIVE_LIMIT
          ) {
            setProviderError(
              "Node unreachable — the on-chain balance check could not reach your node.",
            );
            setRows((prev) =>
              prev.map((r) =>
                r.status === "loading" ? { ...r, status: "pending" } : r,
              ),
            );
            setIsChecking(false);
            return;
          }
          setRows((prev) =>
            prev.map((r, idx) =>
              idx === i
                ? { ...r, status: "error", error: err instanceof Error ? err.message : "Lookup failed" }
                : r
            )
          );
        }
      }

      if (!cancelledRef.current) {
        const asOfLabel = blockHeight
          ? `Live on-chain check — block ${blockHeight.toLocaleString()} (${formatUnix(nowTs)})`
          : `Live on-chain check — ${formatUnix(nowTs)}`;
        setSummary({
          totalSats: 0,
          source: "live",
          asOfLabel,
          blockHeight,
          timestamp: nowTs,
        });
      }
    } else {
      const validAddresses = validIndices.map(({ r }) => r.raw);
      setRows((prev) =>
        prev.map((r) => (!r.isInvalid ? { ...r, status: "loading" } : r))
      );

      try {
        const statsMap = await computeStatsForAddresses(validAddresses);

        let lastSyncTime: number | undefined;
        try {
          const allRecords = await getRecordsByType("address");
          const relevantRecords = allRecords.filter((rec) =>
            validAddresses.includes(rec.inputString)
          );
          const syncTimes = relevantRecords
            .map((r) => r.statsComputedAt)
            .filter((t): t is number => t !== undefined && t > 0);
          if (syncTimes.length > 0) {
            // statsComputedAt is stored in MILLISECONDS (Date.now()), but the
            // summary timestamp contract — shared with the live path's nowTs
            // and rendered via formatUnix (which multiplies by 1000) — is
            // Unix SECONDS. Convert, or the "last synced" date renders
            // millennia in the future.
            lastSyncTime = msToUnixSeconds(Math.max(...syncTimes));
          }
        } catch {
          // Non-fatal
        }

        setRows((prev) =>
          prev.map((r) => {
            if (r.isInvalid) return r;
            const stats = statsMap.get(r.raw);
            const balanceSats = stats ? stats.balanceSats : 0;
            return { ...r, status: balanceSats === 0 ? "empty" : "done", balanceSats };
          })
        );

        const asOfLabel = lastSyncTime
          ? `Offline vault data — last synced ${formatUnix(lastSyncTime)}`
          : "Offline vault data (sync time unavailable)";

        setSummary({
          totalSats: 0,
          source: "offline",
          asOfLabel,
          timestamp: lastSyncTime,
        });
      } catch (err) {
        toast({
          variant: "destructive",
          title: "Offline Balance Failed",
          description: err instanceof Error ? err.message : "Failed to compute balances from vault.",
        });
        setRows((prev) =>
          prev.map((r) =>
            !r.isInvalid
              ? { ...r, status: "error", error: "Failed to compute offline balance" }
              : r
          )
        );
      }
    }

    setIsChecking(false);
  }, [resolveAddresses, balanceSource, nodeSettings, toast]);

  const handleCancel = () => {
    cancelledRef.current = true;
    setIsChecking(false);
  };

  const handleReset = () => {
    cancelledRef.current = true;
    setIsChecking(false);
    setRows([]);
    setDupes(0);
    setSummary(null);
    setProviderError(null);
    setPastedText("");
    onReset();
  };

  return {
    addressTab,
    setAddressTab,
    pastedText,
    setPastedText,
    filterOwner,
    setFilterOwner,
    filterWallet,
    setFilterWallet,
    balanceSource,
    setBalanceSource,
    rows,
    dupes,
    isChecking,
    summary,
    providerError,
    runCheck,
    handleCancel,
    handleReset,
  };
}

// Shared post-restore txid backfill step, used by BOTH the v3 streaming
// restore and the legacy whole-file JSON restore. After a restore completes,
// transaction records may reference txids whose on-chain data is missing
// (orphaned). This detects them and, when a node/provider is reachable,
// rebuilds their on-chain data immediately; otherwise it defers with a
// plain-language suffix for the success toast. Never throws — a backfill
// failure must not turn a successful restore into an error.
import {
  detectOrphanedTxRecords,
  runTxidBackfill,
  formatSkippedReasons,
} from "@/lib/txid-backfill";
import { getNodeSettings } from "@/lib/data/node-settings-crud";
import { createProviderFromSettings } from "@/lib/blockchain-api";

export interface PostRestoreBackfillCallbacks {
  onMessage: (message: string) => void;
  onPercent: (percent: number) => void;
}

export interface PostRestoreBackfillResult {
  /** Suffix to append to the restore-success toast ("" when nothing to say). */
  suffix: string;
  /** Whether any orphaned transaction records were found at all. */
  orphansFound: boolean;
}

export async function runPostRestoreTxidBackfill(
  cb: PostRestoreBackfillCallbacks,
): Promise<PostRestoreBackfillResult> {
  try {
    const { txids } = await detectOrphanedTxRecords();
    if (txids.length === 0) return { suffix: "", orphansFound: false };

    cb.onMessage(
      `Rebuilding on-chain data for ${txids.length} transaction${txids.length !== 1 ? "s" : ""}…`,
    );
    // With a single affected transaction, name its txid so the user can
    // identify the record straight from the restore summary.
    const singleTxidNote =
      txids.length === 1 ? ` (${txids[0].slice(0, 8)}…${txids[0].slice(-6)})` : "";
    const deferSuffix = ` ${txids.length} transaction${txids.length !== 1 ? "s" : ""}${singleTxidNote} ${txids.length !== 1 ? "need" : "needs"} on-chain data — run "Rebuild Missing Transactions" in Settings when connected.`;

    const nodeSettings = await getNodeSettings("default");
    if (!nodeSettings) return { suffix: deferSuffix, orphansFound: true };

    try {
      const provider = createProviderFromSettings(nodeSettings);
      await provider.getBlockHeight(); // connectivity probe
      const bfResult = await runTxidBackfill(provider, txids, {
        onProgress: (p) => {
          const pct =
            p.orphansFound > 0
              ? Math.round((p.processed / p.orphansFound) * 100)
              : 100;
          cb.onMessage(
            `Rebuilding ${p.processed.toLocaleString()} of ${p.orphansFound.toLocaleString()} transactions…`,
          );
          cb.onPercent(pct);
        },
      });
      const parts: string[] = [];
      if (bfResult.rebuilt > 0) parts.push(`${bfResult.rebuilt} rebuilt`);
      if (bfResult.skipped > 0) {
        const skippedDetail = formatSkippedReasons(bfResult.skippedReasons);
        parts.push(skippedDetail || `${bfResult.skipped} skipped`);
      }
      if (bfResult.failed > 0) parts.push(`${bfResult.failed} failed`);
      if (bfResult.prevoutsResolved > 0)
        parts.push(`${bfResult.prevoutsResolved} input addresses resolved`);
      return {
        suffix:
          parts.length > 0
            ? ` Transaction data${singleTxidNote}: ${parts.join("; ")}.`
            : "",
        orphansFound: true,
      };
    } catch {
      // Provider unreachable (or backfill blew up) — defer gracefully.
      return { suffix: deferSuffix, orphansFound: true };
    }
  } catch {
    // Backfill detection failure is non-fatal.
    return { suffix: "", orphansFound: false };
  }
}

import { useEffect } from "react";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { detectOrphanedTxRecords } from "@/lib/txid-backfill";
import { subscribeToDbChanges } from "@/lib/database";
import { ORPHAN_CHECK_DONE_KEY, ORPHANS_AWAITING_PROVIDER_KEY } from "@/lib/orphan-check-session";

// Once per browser session, silently scan for transaction records that are
// missing their on-chain data ("orphaned" txids) and, if any are found, show a
// non-intrusive toast that lets the user jump to Settings and rebuild them.
export function OrphanedTxNotifier() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  useEffect(() => {
    const SESSION_KEY = ORPHAN_CHECK_DONE_KEY;
    // Set once the startup check finds orphans but no provider is configured.
    // While set, a later provider configuration re-triggers the orphan check.
    const AWAITING_PROVIDER_KEY = ORPHANS_AWAITING_PROVIDER_KEY;

    let cancelled = false;

    // Shows the "Fix now" toast that kicks off the auto-backfill path. Only used
    // when a blockchain provider is configured (otherwise a backfill can only
    // defer). Reused by both the startup check and the post-configure re-check.
    const showRebuildToast = (count: number) => {
      const plural = count !== 1;
      toast({
        title: "Missing transaction data",
        description: `${count.toLocaleString()} transaction${plural ? "s" : ""} ${plural ? "are" : "is"} missing on-chain data. Rebuild ${plural ? "them" : "it"} from Settings.`,
        duration: 15000,
        action: (
          <ToastAction
            altText="Open Settings to rebuild missing transactions"
            onClick={() => {
              sessionStorage.setItem("kyutxo:autoBackfill", "1");
              setLocation("/settings");
              // If the user is ALREADY on /settings, the navigation above is a
              // no-op and SettingsPage never remounts, so its mount effect would
              // never consume the flag. Dispatch an event the page also listens
              // for so "Fix now" works regardless of the current route.
              window.dispatchEvent(new Event("kyutxo:autoBackfill"));
            }}
            data-testid="button-rebuild-missing-transactions"
          >
            Fix now
          </ToastAction>
        ),
      });
    };

    // Startup check: runs at most once per browser session.
    (async () => {
      if (sessionStorage.getItem(SESSION_KEY)) return;
      sessionStorage.setItem(SESSION_KEY, "1");

      try {
        const { getSettings } = await import("@/lib/data/settings-crud");
        const settings = await getSettings("default");
        if (cancelled || settings?.disableOrphanCheck) return;

        const { txids } = await detectOrphanedTxRecords();
        if (cancelled || txids.length === 0) return;

        // Rebuilding missing transaction data requires a connected blockchain
        // provider. If none is configured, an auto-triggered backfill would
        // immediately defer with a "no node configured" message — a dead end.
        // Detect that case up front and guide the user to configure a provider
        // first instead of kicking off a backfill that can only defer.
        const { getNodeSettings } = await import("@/lib/data/node-settings-crud");
        const nodeSettings = await getNodeSettings("default");
        if (cancelled) return;
        const hasNode = !!nodeSettings;

        const count = txids.length;
        const plural = count !== 1;

        if (!hasNode) {
          // Remember that orphans are waiting on a provider so we can prompt
          // again as soon as one is configured later in the same session.
          sessionStorage.setItem(AWAITING_PROVIDER_KEY, "1");
          toast({
            title: "Missing transaction data",
            description: `${count.toLocaleString()} transaction${plural ? "s" : ""} ${plural ? "are" : "is"} missing on-chain data. Configure a blockchain provider in Settings to rebuild ${plural ? "them" : "it"}.`,
            duration: 15000,
            action: (
              <ToastAction
                altText="Open Settings to configure a blockchain provider"
                onClick={() => {
                  setLocation("/settings");
                }}
                data-testid="button-configure-provider"
              >
                Configure
              </ToastAction>
            ),
          });
          return;
        }

        showRebuildToast(count);
      } catch {
        // Silent: detection failures must never disrupt app startup.
      }
    })();

    // Re-check once a blockchain provider is configured for the first time.
    // The startup check only runs once per session, so without this a user who
    // configures a provider after seeing the "Configure" prompt would never be
    // reminded that transactions are still missing. We only act when orphans
    // were previously found awaiting a provider, and we consume that flag on the
    // first configuration so the prompt can't loop on later nodeSettings writes
    // (e.g. connection-status updates during a sync).
    const unsubscribe = subscribeToDbChanges((tables) => {
      if (cancelled) return;
      if (!tables.includes("nodeSettings")) return;
      if (sessionStorage.getItem(AWAITING_PROVIDER_KEY) !== "1") return;

      (async () => {
        try {
          const { getNodeSettings } = await import("@/lib/data/node-settings-crud");
          const nodeSettings = await getNodeSettings("default");
          if (cancelled || !nodeSettings) return;

          // A provider now exists — consume the gate immediately so subsequent
          // nodeSettings writes in this session can't re-trigger the prompt.
          sessionStorage.removeItem(AWAITING_PROVIDER_KEY);

          const { getSettings } = await import("@/lib/data/settings-crud");
          const settings = await getSettings("default");
          if (cancelled || settings?.disableOrphanCheck) return;

          const { txids } = await detectOrphanedTxRecords();
          if (cancelled || txids.length === 0) return;

          showRebuildToast(txids.length);
        } catch {
          // Silent: re-check failures must never disrupt the app.
        }
      })();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [toast, setLocation]);

  return null;
}

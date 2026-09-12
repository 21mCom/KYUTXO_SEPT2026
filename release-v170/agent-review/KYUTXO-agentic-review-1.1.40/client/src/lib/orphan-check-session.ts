// Session-scoped keys that gate the startup "missing transaction data" (orphaned
// txid) check in OrphanedTxNotifier (see App.tsx). They live here so non-startup
// code paths (e.g. backup restore) can reset the gate without duplicating the
// raw string literals.

// Set once the startup orphan check has run; prevents it from re-running on every
// re-render within the same browser session.
export const ORPHAN_CHECK_DONE_KEY = "kyutxo:orphanCheckDone";

// Set when the startup check finds orphans but no provider is configured. While
// set, configuring a provider later in the session re-triggers the orphan check.
export const ORPHANS_AWAITING_PROVIDER_KEY = "kyutxo:orphansAwaitingProvider";

// Clears the orphan-check session gate so the startup check in OrphanedTxNotifier
// re-evaluates on the next page load. Used after a backup restore — which can
// introduce transaction records missing on-chain data — so the user is re-prompted
// (or auto-backfilled) via the normal path. The startup check sets the gate again
// on the next load, so this cannot cause looping prompts.
export function resetOrphanCheckGate(): void {
  try {
    sessionStorage.removeItem(ORPHAN_CHECK_DONE_KEY);
    sessionStorage.removeItem(ORPHANS_AWAITING_PROVIDER_KEY);
  } catch {
    // Ignore storage access failures (e.g. disabled sessionStorage).
  }
}

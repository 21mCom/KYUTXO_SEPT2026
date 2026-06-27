import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getSettings } from '@/lib/data/settings-crud';
import { countRecordsByType } from '@/lib/data/record-crud';
import { materializeBehaviorTally } from '@/lib/data/address-stats';
import type { BehaviorTallyCounts } from '@/lib/behavior-profile';

/**
 * Maximum age a persisted tally may reach before it is treated as stale and a
 * background recompute is triggered. The tally embeds time-relative behavior
 * labels (e.g. Dormant vs Active) frozen as of `computedAt`; as wall-clock time
 * advances, addresses silently cross the dormancy threshold but the persisted
 * counts do not move until the next recompute. Re-materializing roughly once a
 * day keeps those time-driven label transitions reflected without churn.
 */
export const BEHAVIOR_TALLY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * How often a mounted hook re-evaluates the age-based staleness so a
 * long-running session (no settings/address changes to re-render it) still
 * notices the tally has aged past `BEHAVIOR_TALLY_MAX_AGE_MS`.
 */
const STALENESS_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export interface UseBehaviorTallyResult {
  /** Per-label totals across the whole vault, or null until first computed. */
  counts: BehaviorTallyCounts | null;
  /** True while the background pass is recomputing the tally. */
  computing: boolean;
  /** True when the persisted tally is missing or its fingerprint is stale. */
  stale: boolean;
  /** When the persisted tally was last materialized (ms epoch), or null. */
  computedAt: number | null;
}

/**
 * Load the persisted vault-wide behavior tally and keep it fresh.
 *
 * The tally is materialized by a streamed background pass (see
 * `materializeBehaviorTally`). This hook reads the persisted result and, when it
 * is missing or its address-count fingerprint no longer matches the live vault,
 * kicks off a single background recompute. The pass yields between batches and
 * only reads cached stat columns, so it never freezes large vaults. Concurrent
 * recomputes are guarded so at most one runs at a time.
 *
 * @param enabled When false, no background recompute is triggered (the last
 *   persisted tally is still returned). Useful to defer work until needed.
 */
export function useBehaviorTally(enabled: boolean = true): UseBehaviorTallyResult {
  const settings = useLiveQuery(() => getSettings('default'));
  const liveAddressCount = useLiveQuery(() => countRecordsByType('address'));
  const [computing, setComputing] = useState(false);
  const inFlightRef = useRef(false);

  // A ticking clock so a long-running mount re-evaluates age-based staleness even
  // when nothing else (settings/address count) changes to re-render the hook.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), STALENESS_CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [enabled]);

  const persisted = settings?.behaviorTally ?? null;
  const settingsLoaded = settings !== undefined;
  const countLoaded = liveAddressCount !== undefined;
  // The persisted tally freezes time-relative labels at `computedAt`; once it
  // ages past the window, addresses may have crossed the dormancy threshold, so
  // treat it as stale to pick up those time-driven transitions.
  const aged =
    persisted != null && now - persisted.computedAt > BEHAVIOR_TALLY_MAX_AGE_MS;
  const stale =
    settingsLoaded &&
    countLoaded &&
    (persisted == null || persisted.addressCount !== liveAddressCount || aged);

  useEffect(() => {
    if (!enabled) return;
    if (!stale) return;
    if (inFlightRef.current) return;

    inFlightRef.current = true;
    setComputing(true);
    const controller = new AbortController();

    (async () => {
      try {
        await materializeBehaviorTally({ signal: controller.signal });
      } catch (err) {
        if (!controller.signal.aborted) {
          console.error('[use-behavior-tally] compute failed', err);
        }
      } finally {
        inFlightRef.current = false;
        setComputing(false);
      }
    })();

    return () => {
      controller.abort();
    };
    // `stale` already folds in addressCount, persisted fingerprint, and age.
  }, [enabled, stale]);

  return {
    counts: (persisted?.counts as BehaviorTallyCounts | undefined) ?? null,
    computing,
    stale,
    computedAt: persisted?.computedAt ?? null,
  };
}

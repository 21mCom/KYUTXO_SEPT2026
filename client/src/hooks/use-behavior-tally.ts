import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getSettings } from '@/lib/data/settings-crud';
import { countRecordsByType } from '@/lib/data/record-crud';
import { materializeBehaviorTally } from '@/lib/data/address-stats';
import type { BehaviorTallyCounts } from '@/lib/behavior-profile';

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

  const persisted = settings?.behaviorTally ?? null;
  const settingsLoaded = settings !== undefined;
  const countLoaded = liveAddressCount !== undefined;
  const stale =
    settingsLoaded &&
    countLoaded &&
    (persisted == null || persisted.addressCount !== liveAddressCount);

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
    // `stale` already folds in addressCount + persisted fingerprint changes.
  }, [enabled, stale]);

  return {
    counts: (persisted?.counts as BehaviorTallyCounts | undefined) ?? null,
    computing,
    stale,
    computedAt: persisted?.computedAt ?? null,
  };
}

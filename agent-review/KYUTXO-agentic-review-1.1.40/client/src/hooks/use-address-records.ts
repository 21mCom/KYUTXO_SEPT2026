import { useEffect, useState } from "react";
import { type Record as DbRecord, USER_CURATED_TIERS } from "@/lib/database";
import { getRecordsByType, getRecordsByTypeAndImportanceTiers } from "@/lib/data/record-crud";
import { useDbChangeSignal } from "./use-db-change-signal";

/**
 * Shared loader for address-type records used by the analysis pages.
 *
 * Centralises the narrowed Dexie query (via the `type` / `[type+addressImportance]`
 * indexes) so the various reports don't each re-implement it, and reacts to
 * record changes through the debounced db-change signal bus instead of a raw
 * `useLiveQuery`. This lets us *scope* high-frequency blockchain-sync writes:
 * when a page only shows user-curated addresses we skip the sync-origin pulses
 * entirely, and even when we don't, the 250ms debounce collapses a sync flood
 * into a single reload. Read-only and offline — never touches the network.
 */

export interface UseAddressRecordsOptions {
  /** When false, only user-curated tiers are loaded and sync pulses are ignored. */
  includeBlockchainDiscovered?: boolean;
  /** When false, skips loading entirely and returns an empty set. */
  enabled?: boolean;
}

export interface UseAddressRecordsResult {
  records: DbRecord[];
  isLoading: boolean;
}

export function useAddressRecords(
  options: UseAddressRecordsOptions = {}
): UseAddressRecordsResult {
  const { includeBlockchainDiscovered = true, enabled = true } = options;
  const [records, setRecords] = useState<DbRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const signal = useDbChangeSignal(['records'], 250, {
    filter: (_tables, meta) => {
      if (meta?.origin === 'blockchain-sync' && !includeBlockchainDiscovered) {
        return false;
      }
      return true;
    },
  });

  useEffect(() => {
    if (!enabled) {
      setRecords([]);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);

    (async () => {
      try {
        const recs = includeBlockchainDiscovered
          ? await getRecordsByType('address')
          : await getRecordsByTypeAndImportanceTiers('address', USER_CURATED_TIERS);
        if (!cancelled) setRecords(recs);
      } catch (e) {
        console.warn('[useAddressRecords] load failed:', e);
        if (!cancelled) setRecords([]);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [signal, includeBlockchainDiscovered, enabled]);

  return { records, isLoading };
}

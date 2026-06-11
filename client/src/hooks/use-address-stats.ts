import { useMemo } from "react";

export interface AddressStats {
  balanceSats: number;
  lastTxDate: number;
  txCount: number;
  /** Whether this address has had its stats computed from fetched tx data. */
  synced: boolean;
}

type StatsRecord = {
  id?: number | string;
  type: string;
  inputString: string;
  cachedBalanceSats?: number;
  cachedTxCount?: number;
  cachedLastActivityTime?: number;
  statsComputedAt?: number;
};

/**
 * Reads per-address stats from the cache stored on each address record. The
 * cache is maintained locally during user-initiated sync and via the manual
 * recompute lever — this hook performs NO database scans and NO network access,
 * so it is fully synchronous and cheap.
 *
 * Addresses whose `statsComputedAt` is undefined are returned with
 * `synced: false` so the UI can show a "not synced" marker instead of a
 * misleading zero balance.
 */
export function useAddressStats(
  records: Array<StatsRecord>,
  enabled: boolean = true
): Map<string, AddressStats> {
  return useAddressStatsWithLoading(records, enabled).stats;
}

export function useAddressStatsWithLoading(
  records: Array<StatsRecord>,
  enabled: boolean = true
): { stats: Map<string, AddressStats>; isLoading: boolean } {
  const stats = useMemo(() => {
    const result = new Map<string, AddressStats>();
    if (!enabled) return result;
    for (const record of records) {
      if (record.type !== 'address' || !record.inputString || record.id == null) continue;
      const synced = record.statsComputedAt != null;
      result.set(String(record.id), {
        balanceSats: record.cachedBalanceSats ?? 0,
        lastTxDate: record.cachedLastActivityTime ?? 0,
        txCount: record.cachedTxCount ?? 0,
        synced,
      });
    }
    return result;
  }, [records, enabled]);

  return { stats, isLoading: false };
}

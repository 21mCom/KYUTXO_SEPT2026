/**
 * Shared helpers for rendering stored Unix-SECONDS timestamps.
 *
 * Several stored fields hold Unix seconds, not milliseconds — e.g.
 * blockchainTransactions.blockTime, utxoLineage.blockTime,
 * CustodySegment.originDate (set from blockTime). JavaScript Date and
 * date-fns' format()/formatDistanceToNow() expect MILLISECONDS, so feeding
 * a raw seconds value in renders dates near Jan 1970. The reverse mistake
 * (feeding a Date.now() milliseconds value to a seconds-based formatter)
 * renders dates in the far future.
 *
 * Use these helpers at every render/export site instead of ad-hoc `* 1000`
 * conversions:
 *  - unixSecondsToDate(sec)   → Date | null (null for 0/undefined/invalid —
 *    a missing block time means "unconfirmed or unknown", never the epoch)
 *  - formatUnixSeconds(sec, fmt) → formatted string or "Unknown"
 *  - msToUnixSeconds(ms)      → convert a Date.now()-style value for APIs
 *    that expect Unix seconds
 */
import { format, fromUnixTime } from "date-fns";

export function unixSecondsToDate(seconds: number | undefined | null): Date | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  return fromUnixTime(seconds);
}

export function formatUnixSeconds(
  seconds: number | undefined | null,
  fmt: string,
  fallback = "Unknown",
): string {
  const d = unixSecondsToDate(seconds);
  return d ? format(d, fmt) : fallback;
}

/** Convert a milliseconds timestamp (e.g. Date.now()) to Unix seconds. */
export function msToUnixSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

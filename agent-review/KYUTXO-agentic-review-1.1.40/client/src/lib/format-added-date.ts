/**
 * Human-readable "Added" timestamp for records (based on createdAt, ms).
 * Recent items render relative ("3h ago"), older items render an absolute
 * locale date — per the Recently Added view spec.
 */
export function formatAddedDate(createdAtMs: number | undefined, nowMs: number = Date.now()): string {
  if (!createdAtMs || !Number.isFinite(createdAtMs)) return "-";
  const diff = nowMs - createdAtMs;
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return new Date(createdAtMs).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

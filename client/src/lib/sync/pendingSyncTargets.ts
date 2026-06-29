/**
 * In-memory handoff for "sync these specific addresses" requests.
 *
 * Lets one page (e.g. the Annual Activity Report's unresolved-inputs list) queue
 * a set of owning addresses to sync, then navigate to the Transaction Sync page,
 * which consumes the queue on mount and runs a targeted sync. Kept purely
 * in-memory (no network, no persistence) to honor the offline-first design — the
 * handoff only needs to survive a single client-side navigation.
 */

let pendingAddresses: string[] | null = null;

/**
 * Queue a set of addresses for the Transaction Sync page to sync. Trims, drops
 * blanks, and de-duplicates (case-insensitively, preserving first-seen casing).
 * Passing an empty/blank-only list clears any pending request.
 */
export function setPendingSyncAddresses(addresses: string[]): void {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const raw of addresses) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(trimmed);
  }
  pendingAddresses = unique.length > 0 ? unique : null;
}

/**
 * Return the queued addresses (if any) and clear the queue. Returns null when
 * nothing is pending.
 */
export function consumePendingSyncAddresses(): string[] | null {
  const result = pendingAddresses;
  pendingAddresses = null;
  return result;
}

/** Whether any addresses are currently queued, without consuming them. */
export function hasPendingSyncAddresses(): boolean {
  return pendingAddresses !== null && pendingAddresses.length > 0;
}

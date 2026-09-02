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

/** Result of splitting flagged addresses into those with/without a DB record. */
export interface TargetedAddressPartition {
  /** Lowercased, de-duplicated addresses requested (drops blanks). */
  requested: string[];
  /** Original-casing addresses that had no matching address record. */
  skipped: string[];
}

/**
 * Split a set of flagged owning addresses into the ones that matched an address
 * record and the ones that did not. De-duplicates case-insensitively while
 * preserving each address's first-seen original casing for display. `matchedLower`
 * is the set of `inputStringLower` values found in the database.
 *
 * Used by the targeted sync to tell the auditor which funding addresses were
 * skipped because they were never imported.
 */
export function partitionTargetedAddresses(
  addresses: string[],
  matchedLower: Set<string>,
): TargetedAddressPartition {
  const originalByLower = new Map<string, string>();
  for (const raw of addresses) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!originalByLower.has(key)) originalByLower.set(key, trimmed);
  }
  const requested = Array.from(originalByLower.keys());
  const skipped = requested
    .filter((key) => !matchedLower.has(key))
    .map((key) => originalByLower.get(key) ?? key);
  return { requested, skipped };
}

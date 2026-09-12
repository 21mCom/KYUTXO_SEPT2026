import { db, notifyDbChange, type PrivacyAuditHistoryEntry } from '../database';
import { getSettings } from './settings-crud';

// Default number of audit snapshots to keep. Users can override this via
// Settings > Privacy Audit (settings.privacyHistoryLimit).
export const DEFAULT_PRIVACY_HISTORY_LIMIT = 30;

export type CreatePrivacyAuditHistoryEntry = Omit<PrivacyAuditHistoryEntry, 'id'>;

export interface PrivacyHistoryWriteOptions {
  skipNotification?: boolean;
}

/**
 * Resolve the configured retention limit, falling back to the default when no
 * (or an invalid) value is stored.
 */
async function getPrivacyHistoryLimit(): Promise<number> {
  const settings = await getSettings('default');
  const limit = settings?.privacyHistoryLimit;
  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
    return Math.floor(limit);
  }
  return DEFAULT_PRIVACY_HISTORY_LIMIT;
}

/**
 * Return the total number of stored audit snapshots. Useful for previewing how
 * many runs a retention-limit change would remove before committing it.
 */
export async function getPrivacyAuditHistoryCount(): Promise<number> {
  return db.privacyAuditHistory.count();
}

/**
 * Trim the audit history table down to the most recent `retentionLimit`
 * entries, removing the oldest first. When `retentionLimit` is omitted the
 * configured limit (or default) is used. Returns the number of entries removed.
 */
export async function trimPrivacyAuditHistory(
  retentionLimit?: number,
  options?: PrivacyHistoryWriteOptions
): Promise<number> {
  const limit = retentionLimit ?? (await getPrivacyHistoryLimit());
  const total = await db.privacyAuditHistory.count();
  let removed = 0;
  if (total > limit) {
    const excess = total - limit;
    const oldestIds = await db.privacyAuditHistory
      .orderBy('timestamp')
      .limit(excess)
      .primaryKeys();
    if (oldestIds.length > 0) {
      await db.privacyAuditHistory.bulkDelete(oldestIds as number[]);
      removed = oldestIds.length;
    }
  }

  if (removed > 0 && !options?.skipNotification) {
    notifyDbChange('privacyAuditHistory');
  }

  return removed;
}

/**
 * Append a new audit snapshot and trim the table to the most recent
 * configured number of entries (oldest removed first).
 *
 * The add and trim are executed inside a single Dexie read-write transaction
 * so the table can never transiently exceed the retention limit — even if two
 * tabs run an audit simultaneously, the isolation guarantee of IndexedDB means
 * one transaction commits first and the other sees the already-trimmed state.
 */
export async function addPrivacyAuditHistoryEntry(
  entry: CreatePrivacyAuditHistoryEntry,
  options?: PrivacyHistoryWriteOptions
): Promise<number> {
  // Resolve the limit outside the transaction (reads are cheaper outside and
  // the limit itself rarely changes mid-operation).
  const limit = await getPrivacyHistoryLimit();

  let newId: number;
  await db.transaction('rw', db.privacyAuditHistory, async () => {
    newId = (await db.privacyAuditHistory.add(entry as PrivacyAuditHistoryEntry)) as number;

    // Trim within the same transaction so add + delete are atomic.
    const total = await db.privacyAuditHistory.count();
    if (total > limit) {
      const excess = total - limit;
      const oldestIds = await db.privacyAuditHistory
        .orderBy('timestamp')
        .limit(excess)
        .primaryKeys();
      if (oldestIds.length > 0) {
        await db.privacyAuditHistory.bulkDelete(oldestIds as number[]);
      }
    }
  });

  if (!options?.skipNotification) {
    notifyDbChange('privacyAuditHistory');
  }

  return newId!;
}

/**
 * Attach (or replace) the Adversary View summary on an existing audit
 * snapshot. The adversary analysis runs asynchronously after the main audit,
 * so its summary is written as a follow-up update to the entry created by
 * addPrivacyAuditHistoryEntry. No-ops silently if the entry has since been
 * trimmed away (returns false in that case).
 */
export async function setPrivacyAuditHistoryAdversary(
  id: number,
  adversary: NonNullable<PrivacyAuditHistoryEntry['adversary']>,
  options?: PrivacyHistoryWriteOptions
): Promise<boolean> {
  const updated = await db.privacyAuditHistory.update(id, { adversary });

  if (updated > 0 && !options?.skipNotification) {
    notifyDbChange('privacyAuditHistory');
  }

  return updated > 0;
}

/**
 * Return audit snapshots ordered oldest → newest (suitable for a timeline /
 * sparkline). Pass a limit to cap the number of most-recent runs returned.
 */
export async function getPrivacyAuditHistory(
  limit?: number
): Promise<PrivacyAuditHistoryEntry[]> {
  if (limit != null) {
    // Take the most recent `limit` entries, then return them oldest → newest.
    const recent = await db.privacyAuditHistory
      .orderBy('timestamp')
      .reverse()
      .limit(limit)
      .toArray();
    return recent.reverse();
  }
  return db.privacyAuditHistory.orderBy('timestamp').toArray();
}

/**
 * Delete all stored audit snapshots.
 */
export async function clearPrivacyAuditHistory(
  options?: PrivacyHistoryWriteOptions
): Promise<void> {
  await db.privacyAuditHistory.clear();

  if (!options?.skipNotification) {
    notifyDbChange('privacyAuditHistory');
  }
}

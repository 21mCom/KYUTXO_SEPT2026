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
 * Append a new audit snapshot and trim the table to the most recent
 * configured number of entries (oldest removed first).
 */
export async function addPrivacyAuditHistoryEntry(
  entry: CreatePrivacyAuditHistoryEntry,
  options?: PrivacyHistoryWriteOptions
): Promise<number> {
  const id = await db.privacyAuditHistory.add(entry as PrivacyAuditHistoryEntry);

  // Trim oldest entries beyond the retention limit.
  const retentionLimit = await getPrivacyHistoryLimit();
  const total = await db.privacyAuditHistory.count();
  if (total > retentionLimit) {
    const excess = total - retentionLimit;
    const oldestIds = await db.privacyAuditHistory
      .orderBy('timestamp')
      .limit(excess)
      .primaryKeys();
    if (oldestIds.length > 0) {
      await db.privacyAuditHistory.bulkDelete(oldestIds as number[]);
    }
  }

  if (!options?.skipNotification) {
    notifyDbChange('privacyAuditHistory');
  }

  return id as number;
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

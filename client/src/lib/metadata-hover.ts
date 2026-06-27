import { type Record as DbRecord } from './database';
import { getRecordsByInputString, getRecordsByInputStrings } from './data/record-crud';

export interface HoverTooltipPrefs {
  showLabel: boolean;
  showWalletName: boolean;
  showOwner: boolean;
  showCategory: boolean;
  showTags: boolean;
  showNotes: boolean;
  showSeedName: boolean;
  showSoftware: boolean;
  showPrivateKeyStatus: boolean;
  includeSystemTags: boolean;
}

export const DEFAULT_HOVER_TOOLTIP_PREFS: HoverTooltipPrefs = {
  showLabel: true,
  showWalletName: true,
  showOwner: true,
  showCategory: true,
  showTags: true,
  showNotes: true,
  showSeedName: true,
  showSoftware: true,
  showPrivateKeyStatus: true,
  includeSystemTags: false,
};

export function isSystemTag(tag: string): boolean {
  return tag.includes(':');
}

export interface HoverMetadataField {
  label: string;
  value: string;
}

export function getHoverLabel(
  record: DbRecord,
  prefs: Partial<HoverTooltipPrefs> = {}
): string | null {
  const p: HoverTooltipPrefs = { ...DEFAULT_HOVER_TOOLTIP_PREFS, ...prefs };
  if (p.showLabel && record.label && record.label !== 'Unlabeled') {
    return record.label;
  }
  return null;
}

export function getHoverMetadataFields(
  record: DbRecord,
  prefs: Partial<HoverTooltipPrefs> = {}
): HoverMetadataField[] {
  const p: HoverTooltipPrefs = { ...DEFAULT_HOVER_TOOLTIP_PREFS, ...prefs };
  const fields: HoverMetadataField[] = [];

  if (p.showWalletName && record.walletName) {
    fields.push({ label: 'Wallet', value: record.walletName });
  }
  if (
    p.showOwner &&
    record.owner &&
    record.owner !== 'Pending Review' &&
    record.owner !== 'Unknown'
  ) {
    fields.push({ label: 'Owner', value: record.owner });
  }
  if (p.showSeedName && record.seedName) {
    fields.push({ label: 'Seed', value: record.seedName });
  }
  if (p.showSoftware && record.walletSoftware) {
    fields.push({ label: 'Software', value: record.walletSoftware });
  }
  if (p.showCategory && record.categories && record.categories.length > 0) {
    fields.push({ label: 'Category', value: record.categories.join(', ') });
  }
  if (p.showTags && record.tags && record.tags.length > 0) {
    const userTags = p.includeSystemTags
      ? record.tags
      : record.tags.filter((t) => !isSystemTag(t));
    if (userTags.length > 0) {
      const display = userTags.length > 5
        ? userTags.slice(0, 5).join(', ') + ` +${userTags.length - 5} more`
        : userTags.join(', ');
      fields.push({ label: 'Tags', value: display });
    }
  }
  if (p.showPrivateKeyStatus && record.privateKeyStatus) {
    fields.push({ label: 'Key Status', value: record.privateKeyStatus });
  }
  if (p.showNotes && record.notes) {
    const clipped =
      record.notes.length > 120
        ? record.notes.slice(0, 120) + '\u2026'
        : record.notes;
    fields.push({ label: 'Notes', value: clipped });
  }

  return fields;
}

export function hasHoverMetadata(
  record: DbRecord,
  prefs: Partial<HoverTooltipPrefs> = {}
): boolean {
  return (
    getHoverLabel(record, prefs) !== null ||
    getHoverMetadataFields(record, prefs).length > 0
  );
}

const IMPORTANCE_PRIORITY: Record<string, number> = {
  verified: 6,
  manual: 5,
  'wallet-import': 4,
  'xpub-derived': 3,
  'blockchain-discovered': 2,
  'pending-review': 1,
};

function scoreRecord(record: DbRecord): number {
  let score = (IMPORTANCE_PRIORITY[record.addressImportance ?? ''] ?? 0) * 100;
  if (record.source && record.source !== 'blockchain-sync') score += 50;
  if (record.label && record.label !== 'Unlabeled') score += 10;
  if (record.owner && record.owner !== 'Pending Review') score += 10;
  if (record.walletName) score += 10;
  if (record.seedName) score += 10;
  if (record.walletSoftware) score += 5;
  if (record.notes) score += 5;
  if (record.tags && record.tags.length > 0) score += 5;
  if (record.categories && record.categories.length > 0) score += 5;
  return score;
}

function selectBestRecord(records: DbRecord[]): DbRecord {
  if (records.length === 1) return records[0];
  return records.reduce((best, cur) =>
    scoreRecord(cur) > scoreRecord(best) ? cur : best
  );
}

interface CacheEntry {
  record: DbRecord | null;
  resolvedAt: number;
}

const _cache = new Map<string, CacheEntry>();
const _inFlight = new Map<string, Promise<DbRecord | null>>();

const CACHE_TTL_MS = 5 * 60 * 1000;
/**
 * Maximum number of entries the hover-metadata cache may hold. When a new
 * entry would exceed this limit the oldest 20 % of entries are swept out
 * first so a long scrolling session through tens of thousands of distinct
 * addresses can't grow the cache without bound.
 */
const MAX_CACHE_SIZE = 2000;
const CACHE_EVICT_TO = Math.floor(MAX_CACHE_SIZE * 0.8);

/**
 * Subscribers notified when a cache entry is populated (by resolveIdentifier
 * or batchPreloadIdentifiers). Key is the lowercased identifier.
 */
const _subscribers = new Map<string, Set<(record: DbRecord | null) => void>>();

/**
 * Subscribe to be notified when the cache entry for `identifier` is populated.
 * Returns an unsubscribe function. The callback fires once when the entry is
 * resolved; callers that still need updates should re-subscribe (or just read
 * the cache directly on future renders).
 */
export function subscribeCacheEntry(
  identifier: string,
  callback: (record: DbRecord | null) => void
): () => void {
  const key = identifier.toLowerCase();
  if (!_subscribers.has(key)) _subscribers.set(key, new Set());
  _subscribers.get(key)!.add(callback);
  return () => {
    const subs = _subscribers.get(key);
    if (subs) {
      subs.delete(callback);
      if (subs.size === 0) _subscribers.delete(key);
    }
  };
}

function notifySubscribers(key: string, record: DbRecord | null): void {
  const subs = _subscribers.get(key);
  if (!subs || subs.size === 0) return;
  for (const cb of Array.from(subs)) cb(record);
}

function evictOldestEntries(): void {
  if (_cache.size <= CACHE_EVICT_TO) return;
  // Map iterates in insertion order; collect entries sorted by resolvedAt so
  // the stalest are removed first, which is more useful than pure FIFO.
  const entries = Array.from(_cache.entries()).sort(
    (a, b) => a[1].resolvedAt - b[1].resolvedAt
  );
  const toRemove = _cache.size - CACHE_EVICT_TO;
  for (let i = 0; i < toRemove; i++) {
    _cache.delete(entries[i][0]);
  }
}

export function getCachedRecord(identifier: string): DbRecord | null | undefined {
  const key = identifier.toLowerCase();
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.resolvedAt > CACHE_TTL_MS) {
    _cache.delete(key);
    return undefined;
  }
  return entry.record;
}

export async function resolveIdentifier(identifier: string): Promise<DbRecord | null> {
  const key = identifier.toLowerCase();

  const cached = getCachedRecord(identifier);
  if (cached !== undefined) return cached;

  if (_inFlight.has(key)) return _inFlight.get(key)!;

  const promise = (async (): Promise<DbRecord | null> => {
    try {
      const records = await getRecordsByInputString(identifier);
      const best = records.length > 0 ? selectBestRecord(records) : null;
      if (_cache.size >= MAX_CACHE_SIZE) evictOldestEntries();
      _cache.set(key, { record: best, resolvedAt: Date.now() });
      notifySubscribers(key, best);
      return best;
    } catch {
      return null;
    } finally {
      _inFlight.delete(key);
    }
  })();

  _inFlight.set(key, promise);
  return promise;
}

export function invalidateCachedRecord(identifier: string): void {
  _cache.delete(identifier.toLowerCase());
}

/**
 * Batch-preload cache entries for a list of identifiers. Uses a single DB
 * query per batch (up to 50 identifiers) instead of one query per identifier.
 * Identifiers already cached or in-flight are skipped. Notifies any
 * subscribers once each entry is resolved so AddressLink/TxidLink components
 * can show the indicator without a hover.
 */
const PRELOAD_BATCH_SIZE = 50;

export function batchPreloadIdentifiers(identifiers: string[]): void {
  const toFetch: string[] = [];
  const seen = new Set<string>();
  for (const id of identifiers) {
    if (!id) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (getCachedRecord(id) !== undefined) continue;
    if (_inFlight.has(key)) continue;
    toFetch.push(id);
  }
  if (toFetch.length === 0) return;

  for (let i = 0; i < toFetch.length; i += PRELOAD_BATCH_SIZE) {
    void _runBatchFetch(toFetch.slice(i, i + PRELOAD_BATCH_SIZE));
  }
}

async function _runBatchFetch(ids: string[]): Promise<void> {
  type Resolver = (r: DbRecord | null) => void;
  const resolvers = new Map<string, Resolver>();
  const validIds: string[] = [];

  for (const id of ids) {
    const key = id.toLowerCase();
    if (_inFlight.has(key)) continue;
    if (getCachedRecord(id) !== undefined) continue;
    const p = new Promise<DbRecord | null>(resolve => {
      resolvers.set(key, resolve);
    });
    _inFlight.set(key, p);
    validIds.push(id);
  }

  if (validIds.length === 0) return;

  try {
    const records = await getRecordsByInputStrings(validIds);

    const byKey = new Map<string, DbRecord[]>();
    for (const r of records) {
      const key = r.inputString?.toLowerCase();
      if (!key) continue;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(r);
    }

    for (const id of validIds) {
      const key = id.toLowerCase();
      const recs = byKey.get(key) ?? [];
      const best = recs.length > 0 ? selectBestRecord(recs) : null;
      if (_cache.size >= MAX_CACHE_SIZE) evictOldestEntries();
      _cache.set(key, { record: best, resolvedAt: Date.now() });
      notifySubscribers(key, best);
      resolvers.get(key)?.(best);
    }
  } catch {
    for (const [, resolve] of resolvers) {
      resolve(null);
    }
  } finally {
    for (const id of validIds) {
      _inFlight.delete(id.toLowerCase());
    }
  }
}

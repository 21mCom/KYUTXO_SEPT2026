import type { Record } from '../database';

const MAX_ENTRIES = 10000;
const TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  record: Record;
  accessedAt: number;
}

const _cache = new Map<number, CacheEntry>();

export function getCachedRecord(id: number): Record | undefined {
  const entry = _cache.get(id);
  if (!entry) return undefined;
  if (Date.now() - entry.accessedAt > TTL_MS) {
    _cache.delete(id);
    return undefined;
  }
  entry.accessedAt = Date.now();
  return entry.record;
}

export function setCachedRecord(record: Record): void {
  if (record.id === undefined) return;
  if (_cache.size >= MAX_ENTRIES && !_cache.has(record.id)) {
    evictOldest();
  }
  _cache.set(record.id, { record, accessedAt: Date.now() });
}

export function invalidateCachedRecord(id: number): void {
  _cache.delete(id);
}

export function invalidateCachedRecords(ids: number[]): void {
  for (const id of ids) {
    _cache.delete(id);
  }
}

export function clearDecryptCache(): void {
  _cache.clear();
}

export function getCacheStats(): { size: number; maxSize: number } {
  return { size: _cache.size, maxSize: MAX_ENTRIES };
}

function evictOldest(): void {
  let oldestKey: number | undefined;
  let oldestTime = Infinity;
  _cache.forEach((entry, key) => {
    if (entry.accessedAt < oldestTime) {
      oldestTime = entry.accessedAt;
      oldestKey = key;
    }
  });
  if (oldestKey !== undefined) {
    _cache.delete(oldestKey);
  }
}

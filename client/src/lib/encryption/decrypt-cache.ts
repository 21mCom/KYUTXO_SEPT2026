import type { Record } from '../database';

const MAX_ENTRIES = 50000;
const TTL_MS = 30 * 60 * 1000;

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
  _cache.delete(id);
  entry.accessedAt = Date.now();
  _cache.set(id, entry);
  return entry.record;
}

export function setCachedRecord(record: Record): void {
  if (record.id === undefined) return;
  const exists = _cache.has(record.id);
  if (_cache.size >= MAX_ENTRIES && !exists) {
    evictOldest();
  }
  if (exists) {
    _cache.delete(record.id);
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
  const oldestKey = _cache.keys().next().value;
  if (oldestKey !== undefined) {
    _cache.delete(oldestKey);
  }
}

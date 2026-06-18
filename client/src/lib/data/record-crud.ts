import Dexie from 'dexie';
import { db, notifyDbChange, type Record, type Attachment, type RecordOrigin, type RecordOriginType, type DerivationTemplate, type AddressImportance } from '../database';
import { ensureOwner, ensureWalletName, ensureSeedName, ensureWalletSoftware } from './vocabulary-crud';
import { getActivityBus } from '../activity-bus';
import { type GroupBy, GROUP_EMPTY_KEY, addressMatchesGroup, type AddressBalanceRow } from '../balance-grouping';

async function syncRecordVocabulary(
  data: Partial<Record>
): Promise<void> {
  const syncTasks: Promise<void>[] = [];

  if (data.owner && data.owner !== 'Unknown') {
    syncTasks.push(ensureOwner(data.owner));
  }

  if (data.walletName) {
    syncTasks.push(ensureWalletName(data.walletName));
  }

  if (data.seedName) {
    syncTasks.push(ensureSeedName(data.seedName));
  }

  if (data.walletSoftware) {
    syncTasks.push(ensureWalletSoftware(data.walletSoftware));
  }

  await Promise.all(syncTasks);
}

export type CreateRecordData = Omit<Record, 'id' | 'createdAt' | 'updatedAt'> & {
  createdAt?: number;
  updatedAt?: number;
};

export interface CreateRecordOptions {
  skipNotification?: boolean;
  skipVocabularySync?: boolean;
}

function deriveAddressImportance(data: CreateRecordData): AddressImportance {
  if (data.addressImportance) return data.addressImportance;
  if (data.syncDepth !== undefined && data.syncDepth > 0) return 'blockchain-discovered';
  if (data.source === 'blockchain-sync') return 'blockchain-discovered';
  if (data.source?.startsWith('walletImport-')) return 'wallet-import';
  if (data.source === 'xpub-import' || data.xpub || data.derivationPath) return 'xpub-derived';
  return 'manual';
}

function buildFullRecord(data: CreateRecordData): Record {
  const now = Date.now();
  return {
    ...data,
    addressImportance: deriveAddressImportance(data),
    inputStringLower: data.inputString ? data.inputString.toLowerCase() : '',
    createdAt: data.createdAt ?? now,
    updatedAt: data.updatedAt ?? now,
  };
}

export async function createRecord(
  data: CreateRecordData,
  options?: CreateRecordOptions
): Promise<number> {
  const record = buildFullRecord(data);

  console.log(`[createRecord] Creating record: type=${data.type}, inputString=${data.inputString?.substring(0, 20)}...`);
  
  if (!options?.skipVocabularySync) {
    syncRecordVocabulary(data).catch((err) => {
      console.warn('[createRecord] Vocabulary sync failed:', err);
    });
  }
  
  const id = await db.records.add(record);
  
  if (!options?.skipNotification) {
    notifyDbChange('records');
  }
  
  console.log(`[createRecord] Record created with id=${id}`);
  
  return id as number;
}

export async function bulkCreateRecords(
  records: CreateRecordData[],
  options?: CreateRecordOptions
): Promise<number[]> {
  if (records.length === 0) return [];

  console.log(`[bulkCreateRecords] Creating ${records.length} records...`);
  const startTime = performance.now();
  try {
    getActivityBus().publishTask({
      id: 'bulk-create-records',
      label: 'Creating Records',
      phase: `Inserting ${records.length} records`,
      current: 0,
      total: records.length,
    });
  } catch {}

  try {
    const fullRecords = records.map(buildFullRecord);

    try {
      getActivityBus().publishTask({
        id: 'bulk-create-records',
        label: 'Creating Records',
        phase: `Writing ${records.length} records`,
        current: fullRecords.length,
        total: records.length,
      });
    } catch {}

    const ids = await db.transaction('rw', db.records, async () => {
      return await db.records.bulkAdd(fullRecords, { allKeys: true });
    });

    if (!options?.skipVocabularySync) {
      const vocabularyValues = {
        owners: new Set<string>(),
        walletNames: new Set<string>(),
        seedNames: new Set<string>(),
        walletSoftware: new Set<string>(),
      };

      for (const data of records) {
        if (data.owner && data.owner !== 'Unknown') vocabularyValues.owners.add(data.owner);
        if (data.walletName) vocabularyValues.walletNames.add(data.walletName);
        if (data.seedName) vocabularyValues.seedNames.add(data.seedName);
        if (data.walletSoftware) vocabularyValues.walletSoftware.add(data.walletSoftware);
      }

      batchSyncVocabulary(vocabularyValues).catch((err) => {
        console.warn('[bulkCreateRecords] Vocabulary sync failed:', err);
      });
    }

    if (!options?.skipNotification) {
      notifyDbChange('records');
    }

    const duration = performance.now() - startTime;
    console.log(`[bulkCreateRecords] Created ${ids.length} records in ${duration.toFixed(0)}ms`);

    return ids as number[];
  } finally {
    try { getActivityBus().completeTask('bulk-create-records'); } catch {}
  }
}

export interface UpdateRecordOptions {
  skipNotification?: boolean;
  skipVocabularySync?: boolean;
}

export async function updateRecord(
  id: number,
  updates: Partial<Record>,
  options?: UpdateRecordOptions
): Promise<void> {
  const existing = await db.records.get(id);
  if (!existing) throw new Error('Record not found');

  const merged = {
    ...existing,
    ...updates,
    id,
    updatedAt: Date.now(),
  };
  if (updates.inputString !== undefined) {
    merged.inputStringLower = updates.inputString ? updates.inputString.toLowerCase() : '';
  }
  const updated: Record = merged;

  if (!options?.skipVocabularySync) {
    syncRecordVocabulary(updates).catch((err) => {
      console.warn('[updateRecord] Vocabulary sync failed:', err);
    });
  }

  await db.records.put(updated);
  
  if (!options?.skipNotification) {
    notifyDbChange('records');
  }
}

function deduplicateByNormalizedKey(values: Set<string>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  Array.from(values).forEach(name => {
    const key = name.trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      unique.push(name);
    }
  });
  return unique;
}

async function ensureAllSequentially(
  names: string[],
  ensureFn: (name: string) => Promise<void>
): Promise<void> {
  for (let i = 0; i < names.length; i++) {
    await ensureFn(names[i]);
  }
}

async function batchSyncVocabulary(
  values: {
    owners: Set<string>;
    walletNames: Set<string>;
    seedNames: Set<string>;
    walletSoftware: Set<string>;
  }
): Promise<void> {
  const tasks: Promise<void>[] = [];

  const owners = deduplicateByNormalizedKey(values.owners);
  const walletNames = deduplicateByNormalizedKey(values.walletNames);
  const seedNames = deduplicateByNormalizedKey(values.seedNames);
  const walletSoftwareNames = deduplicateByNormalizedKey(values.walletSoftware);

  if (owners.length > 0) tasks.push(ensureAllSequentially(owners, ensureOwner));
  if (walletNames.length > 0) tasks.push(ensureAllSequentially(walletNames, ensureWalletName));
  if (seedNames.length > 0) tasks.push(ensureAllSequentially(seedNames, ensureSeedName));
  if (walletSoftwareNames.length > 0) tasks.push(ensureAllSequentially(walletSoftwareNames, ensureWalletSoftware));

  await Promise.all(tasks);
}

export async function bulkUpdateRecords(
  updates: Array<{ id: number; changes: Partial<Record> }>,
  options?: UpdateRecordOptions
): Promise<{ successCount: number; errorCount: number }> {
  const now = Date.now();
  
  if (updates.length === 0) {
    return { successCount: 0, errorCount: 0 };
  }
  
  console.log(`[bulkUpdateRecords] Processing ${updates.length} records...`);
  const startTime = performance.now();
  try {
    getActivityBus().publishTask({
      id: 'bulk-update-records',
      label: 'Updating Records',
      phase: `Updating ${updates.length} records`,
      current: 0,
      total: updates.length,
    });
  } catch {}
  
  try {
    const ids = updates.map(u => u.id);
    const existingRecords = await db.records.where('id').anyOf(ids).toArray();
    try {
      getActivityBus().publishTask({
        id: 'bulk-update-records',
        label: 'Updating Records',
        phase: `Writing ${updates.length} records`,
        current: existingRecords.length,
        total: updates.length,
      });
    } catch {}

    const existingMap = new Map<number, Record>();
    for (const record of existingRecords) {
      existingMap.set(record.id!, record);
    }
    
    const recordsToSave: Record[] = [];
    const allChanges: Partial<Record>[] = [];
    let errorCount = 0;
    
    for (const { id, changes } of updates) {
      const existing = existingMap.get(id);
      if (!existing) {
        console.warn(`[bulkUpdateRecords] Record ${id} not found, skipping`);
        errorCount++;
        continue;
      }
      
      const merged = {
        ...existing,
        ...changes,
        id,
        updatedAt: now,
      };
      if (changes.inputString !== undefined) {
        merged.inputStringLower = changes.inputString ? changes.inputString.toLowerCase() : '';
      }
      const updated: Record = merged;
      
      recordsToSave.push(updated);
      allChanges.push(changes);
    }
    
    await db.transaction('rw', db.records, async () => {
      await db.records.bulkPut(recordsToSave);
    });
    
    if (!options?.skipVocabularySync) {
      const vocabularyValues = {
        owners: new Set<string>(),
        walletNames: new Set<string>(),
        seedNames: new Set<string>(),
        walletSoftware: new Set<string>(),
      };
      
      for (const changes of allChanges) {
        if (changes.owner && changes.owner !== 'Unknown') {
          vocabularyValues.owners.add(changes.owner);
        }
        if (changes.walletName) {
          vocabularyValues.walletNames.add(changes.walletName);
        }
        if (changes.seedName) {
          vocabularyValues.seedNames.add(changes.seedName);
        }
        if (changes.walletSoftware) {
          vocabularyValues.walletSoftware.add(changes.walletSoftware);
        }
      }
      
      batchSyncVocabulary(vocabularyValues).catch((err) => {
        console.warn('[bulkUpdateRecords] Vocabulary sync failed:', err);
      });
    }
    
    if (!options?.skipNotification) {
      notifyDbChange('records');
    }
    
    const duration = performance.now() - startTime;
    console.log(`[bulkUpdateRecords] Completed: ${recordsToSave.length} records in ${duration.toFixed(0)}ms (${(duration / recordsToSave.length).toFixed(1)}ms/record)`);

    return { successCount: recordsToSave.length, errorCount };
  } finally {
    try { getActivityBus().completeTask('bulk-update-records'); } catch {}
  }
}

export interface AddressStatsCacheValues {
  cachedBalanceSats: number;
  cachedTxCount: number;
  cachedLastActivityTime: number;
  cachedUtxoCount: number;
  statsComputedAt: number;
}

export interface BulkUpdateAddressStatsOptions {
  skipNotification?: boolean;
  origin?: 'user' | 'blockchain-sync' | string;
}

/**
 * Write per-address stats cache values onto address records. This is the only
 * sanctioned path for persisting the stats cache (CRUD-guard compliant). It uses
 * Dexie's bulkPut after merging, so it never clobbers other fields.
 */
export async function bulkUpdateAddressStats(
  updates: Array<{ id: number; stats: AddressStatsCacheValues | null }>,
  options?: BulkUpdateAddressStatsOptions
): Promise<number> {
  if (updates.length === 0) return 0;

  const ids = updates.map(u => u.id);
  const existing = await db.records.where('id').anyOf(ids).toArray();
  const existingMap = new Map<number, Record>();
  for (const r of existing) {
    if (r.id != null) existingMap.set(r.id, r);
  }

  const toSave: Record[] = [];
  for (const { id, stats } of updates) {
    const current = existingMap.get(id);
    if (!current) continue;
    if (stats === null) {
      // Reset to "not synced" — strip the cache fields entirely.
      const cleared = { ...current };
      delete cleared.cachedBalanceSats;
      delete cleared.cachedTxCount;
      delete cleared.cachedLastActivityTime;
      delete cleared.cachedUtxoCount;
      delete cleared.statsComputedAt;
      toSave.push(cleared);
    } else {
      toSave.push({
        ...current,
        cachedBalanceSats: stats.cachedBalanceSats,
        cachedTxCount: stats.cachedTxCount,
        cachedLastActivityTime: stats.cachedLastActivityTime,
        cachedUtxoCount: stats.cachedUtxoCount,
        statsComputedAt: stats.statsComputedAt,
      });
    }
  }

  if (toSave.length === 0) return 0;

  await db.transaction('rw', db.records, async () => {
    await db.records.bulkPut(toSave);
  });

  if (!options?.skipNotification) {
    notifyDbChange('records', options?.origin ? { origin: options.origin } : undefined);
  }

  return toSave.length;
}

export interface DeleteRecordOptions {
  skipNotification?: boolean;
}

export async function deleteRecord(id: number, options?: DeleteRecordOptions): Promise<void> {
  const { getAttachmentsByRecordId, deleteAttachmentsByRecordId } = await import('./attachments-crud');
  const { archiveAttachments } = await import('./trash-crud');
  const attachments = await getAttachmentsByRecordId(id);

  // Deleting a record must NOT destroy its attachment files. Instead we archive
  // the attachment metadata so the file (which is intentionally left on disk)
  // stays recoverable from Settings > Deleted Attachments, and is reported as
  // recoverable by the read-only "Check Attachments" audit. Archiving happens
  // before any rows are removed; if it throws we abort so nothing becomes
  // unrecoverable. The raw file-DELETE that used to run here was removed.
  if (attachments.length > 0) {
    await archiveAttachments(attachments, 'record-delete', { skipNotification: true });
  }

  await deleteAttachmentsByRecordId(id, { skipNotification: true });
  await db.records.delete(id);

  if (!options?.skipNotification) {
    notifyDbChange('records');
    if (attachments.length > 0) {
      notifyDbChange('trashedAttachments');
    }
  }
}

export interface ClearAllRecordsOptions {
  skipNotification?: boolean;
}

export async function clearAllRecords(options?: ClearAllRecordsOptions): Promise<void> {
  await db.records.clear();

  if (!options?.skipNotification) {
    notifyDbChange('records');
  }
}

// =============================================================================
// READ HELPERS
// =============================================================================

export async function getRecord(id: number): Promise<Record | undefined> {
  return db.records.get(id);
}

export async function bulkGetRecords(ids: number[]): Promise<(Record | undefined)[]> {
  return db.records.bulkGet(ids);
}

export async function getRecordsByIds(ids: number[]): Promise<Record[]> {
  if (ids.length === 0) return [];
  return db.records.where('id').anyOf(ids).toArray();
}

export async function getAllRecords(): Promise<Record[]> {
  return db.records.toArray();
}

export async function countRecords(): Promise<number> {
  return db.records.count();
}

/**
 * Count of blockchain-discovered / pending-review records. Used only for UI
 * display (the "hidden records" badge and pagination math when those records
 * are excluded). Callers MUST run this in the background (never awaited before
 * the first page fetch): on very large vaults this indexed anyOf().count() can
 * still take a long time, and awaiting it was leaving the Records page stuck on
 * "Loading records…".
 */
export async function countBlockchainDiscovered(): Promise<number> {
  return db.records
    .where('addressImportance')
    .anyOf(['blockchain-discovered', 'pending-review'])
    .count();
}

/**
 * One-time repair for vaults migrated off field-level encryption. The legacy
 * decryption restored `inputString` but (in older builds) left `inputStringLower`
 * empty, so the case-insensitive / fast-path index silently missed those rows.
 * Walks every record via keyset iteration (abort-safe on large 5GB+ vaults —
 * never a single full-table .modify) and rewrites only the rows whose
 * `inputStringLower` is out of sync, preserving every other field including
 * updatedAt.
 *
 * Returns counts plus `ok`; callers should only persist a "done" flag when `ok`
 * is true, so a partial failure retries on next login instead of leaving rows
 * unsearchable.
 */
export async function repairInputStringLower(
  onProgress?: (scanned: number, fixed: number) => void,
): Promise<{ scanned: number; fixed: number; ok: boolean }> {
  const BATCH = 1000;
  let lastId = 0;
  let scanned = 0;
  let fixed = 0;
  let ok = true;

  try {
    for (;;) {
      const chunk = await db.records
        .where('id')
        .above(lastId)
        .limit(BATCH)
        .toArray();
      if (chunk.length === 0) break;
      lastId = chunk[chunk.length - 1].id!;
      scanned += chunk.length;

      const toFix: Record[] = [];
      for (const r of chunk) {
        const expected = r.inputString ? r.inputString.toLowerCase() : '';
        if (r.inputStringLower !== expected) {
          toFix.push({ ...r, inputStringLower: expected });
        }
      }

      if (toFix.length > 0) {
        await db.records.bulkPut(toFix);
        fixed += toFix.length;
      }

      onProgress?.(scanned, fixed);
      if (chunk.length < BATCH) break;
      // Yield between batches so a huge vault does not freeze the renderer.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } catch (err) {
    ok = false;
    console.error(
      '[repairInputStringLower] Failed:',
      err instanceof Error ? err.message : err,
    );
  }

  if (fixed > 0) {
    notifyDbChange('records');
  }

  return { scanned, fixed, ok };
}

export async function countRecordsByType(type: string): Promise<number> {
  return db.records.where('type').equals(type).count();
}

export async function countRecordsByImportance(tier: AddressImportance): Promise<number> {
  return db.records.where('addressImportance').equals(tier).count();
}

export async function countRecordsByImportanceTiers(tiers: AddressImportance[]): Promise<number> {
  if (tiers.length === 0) return 0;
  return db.records.where('addressImportance').anyOf(tiers).count();
}

export async function getRecordsByType(type: string): Promise<Record[]> {
  return db.records.where('type').equals(type).toArray();
}

export async function getRecordsByInputString(inputString: string): Promise<Record[]> {
  return db.records.where('inputString').equals(inputString).toArray();
}

export async function getRecordsByInputStrings(values: string[]): Promise<Record[]> {
  if (values.length === 0) return [];
  return db.records.where('inputString').anyOf(values).toArray();
}

export async function getAddressRecordsByImportanceTiers(
  tiers: AddressImportance[]
): Promise<Record[]> {
  if (tiers.length === 0) return [];
  return db.records
    .where('[type+addressImportance]')
    .anyOf(tiers.map(t => ['address', t]))
    .toArray();
}

export async function getAddressRecordsByImportanceTiersFiltered(
  tiers: AddressImportance[],
  filter: (r: Record) => boolean
): Promise<Record[]> {
  if (tiers.length === 0) return [];
  return db.records
    .where('[type+addressImportance]')
    .anyOf(tiers.map(t => ['address', t]))
    .filter(filter)
    .toArray();
}

export async function getRecordsByIndexedFieldAnyOfFiltered(
  field: string,
  values: string[],
  filter: (r: Record) => boolean,
  limit: number
): Promise<Record[]> {
  if (values.length === 0) return [];
  return db.records
    .where(field)
    .anyOf(values)
    .filter(filter)
    .limit(limit)
    .toArray();
}

export async function countRecordsByImportanceTiersDirect(
  tiers: AddressImportance[]
): Promise<number> {
  if (tiers.length === 0) return 0;
  return db.records.where('addressImportance').anyOf(tiers).count();
}

export async function countAddressRecordsByImportanceTiers(
  tiers: AddressImportance[]
): Promise<number> {
  if (tiers.length === 0) return 0;
  return db.records
    .where('[type+addressImportance]')
    .anyOf(tiers.map(t => ['address', t]))
    .count();
}

export async function getRecentRecordsByUpdatedAt(limit: number): Promise<Record[]> {
  return db.records.orderBy('updatedAt').reverse().limit(limit).toArray();
}

export async function getRecordsPageByUpdatedAt(
  offset: number,
  limit: number
): Promise<Record[]> {
  return db.records.orderBy('updatedAt').reverse().offset(offset).limit(limit).toArray();
}

export async function getRecordsPageByUpdatedAtFiltered(
  offset: number,
  limit: number,
  filter: (r: Record) => boolean
): Promise<Record[]> {
  return db.records
    .orderBy('updatedAt')
    .reverse()
    .filter(filter)
    .offset(offset)
    .limit(limit)
    .toArray();
}

export async function getRecordsPageByIdReverse(
  offset: number,
  limit: number
): Promise<Record[]> {
  return db.records.orderBy('id').reverse().offset(offset).limit(limit).toArray();
}

export async function getAddressRecordsByImportanceTierLimited(
  tier: AddressImportance,
  limit: number
): Promise<Record[]> {
  return db.records
    .where('[addressImportance+id]')
    .between([tier, Dexie.minKey], [tier, Dexie.maxKey])
    .reverse()
    .limit(limit)
    .toArray();
}

export async function getRecordsPageByTypeIdReverse(
  type: string,
  offset: number,
  limit: number
): Promise<Record[]> {
  return db.records
    .where('[type+id]')
    .between([type, Dexie.minKey], [type, Dexie.maxKey])
    .reverse()
    .offset(offset)
    .limit(limit)
    .toArray();
}

export async function getRecordsByTypeAndImportanceLimited(
  type: string,
  tier: AddressImportance,
  limit: number
): Promise<Record[]> {
  return db.records
    .where('[type+addressImportance]')
    .equals([type, tier])
    .reverse()
    .limit(limit)
    .toArray();
}

// ---------------------------------------------------------------------------
// Keyset (cursor) pagination.
//
// The `.offset(n)` paths above are O(n): Dexie walks and discards every row
// before the requested page, so deep pages take minutes on a 100k+ vault.
// Records are ordered id-descending and `id` is the unique primary key, so we
// can page by an exclusive id boundary instead: each page fetches only
// PAGE_SIZE rows below the previous page's smallest id. The caller (Records.tsx)
// caches the per-page boundary as the user navigates Next/Previous, so adjacent
// navigation is O(PAGE_SIZE) regardless of depth. A rare non-adjacent jump
// (e.g. the clamp-to-last-page after a count shrink) falls back to the offset
// helpers above.
// ---------------------------------------------------------------------------

export interface RecordsKeysetPageOptions {
  limit: number;
  /** Exclusive upper id bound: only rows with id strictly below this are returned. Omit for the first page. */
  beforeIdExclusive?: number;
}

export async function getRecordsPageByIdReverseKeyset(
  opts: RecordsKeysetPageOptions
): Promise<Record[]> {
  const { limit, beforeIdExclusive } = opts;
  if (beforeIdExclusive == null) {
    return db.records.orderBy('id').reverse().limit(limit).toArray();
  }
  return db.records
    .where('id')
    .below(beforeIdExclusive)
    .reverse()
    .limit(limit)
    .toArray();
}

export async function getAddressRecordsByImportanceTierPage(
  tier: AddressImportance,
  opts: RecordsKeysetPageOptions
): Promise<Record[]> {
  const { limit, beforeIdExclusive } = opts;
  return db.records
    .where('[addressImportance+id]')
    .between(
      [tier, Dexie.minKey],
      [tier, beforeIdExclusive ?? Dexie.maxKey],
      true,
      beforeIdExclusive == null
    )
    .reverse()
    .limit(limit)
    .toArray();
}

export async function getRecordsPageByTypeIdReverseKeyset(
  type: string,
  opts: RecordsKeysetPageOptions
): Promise<Record[]> {
  const { limit, beforeIdExclusive } = opts;
  return db.records
    .where('[type+id]')
    .between(
      [type, Dexie.minKey],
      [type, beforeIdExclusive ?? Dexie.maxKey],
      true,
      beforeIdExclusive == null
    )
    .reverse()
    .limit(limit)
    .toArray();
}

export async function getRecordsPageByTypeAndImportanceTiersKeyset(
  type: string,
  tiers: AddressImportance[],
  opts: RecordsKeysetPageOptions
): Promise<Record[]> {
  if (tiers.length === 0) return [];
  const { limit, beforeIdExclusive } = opts;
  // The [type+addressImportance] index can't keyset by id (it has no id
  // component), so walk the [type+id] index id-desc from the boundary and keep
  // only rows in the requested tiers, stopping once we have a full page.
  const tierSet = new Set(tiers);
  return db.records
    .where('[type+id]')
    .between(
      [type, Dexie.minKey],
      [type, beforeIdExclusive ?? Dexie.maxKey],
      true,
      beforeIdExclusive == null
    )
    .reverse()
    .and((r) => tierSet.has(r.addressImportance as AddressImportance))
    .limit(limit)
    .toArray();
}

export async function countRecordsByTypeAndImportanceTiers(
  type: string,
  tiers: AddressImportance[]
): Promise<number> {
  if (tiers.length === 0) return 0;
  return db.records
    .where('[type+addressImportance]')
    .anyOf(tiers.map(t => [type, t]))
    .count();
}

export async function getRecordsByTypeAndImportanceTiers(
  type: string,
  tiers: AddressImportance[]
): Promise<Record[]> {
  if (tiers.length === 0) return [];
  return db.records
    .where('[type+addressImportance]')
    .anyOf(tiers.map(t => [type, t]))
    .toArray();
}

/**
 * Fetch the lightweight per-address rows (id, address, balance, utxo count,
 * label) belonging to a single balance-overview group, reading only the cached
 * stats fields — never participants or transactions. Used when the user expands
 * one group, so the page never holds every address in memory.
 *
 * For non-empty buckets we use the appropriate index (walletName / seedName /
 * owner / *tags / *categories). The "empty" bucket (e.g. "Unassigned") can't be
 * indexed and must also absorb any record literally named the sentinel, so it
 * scans the address table in id-keyset batches, yielding between batches.
 * Only addresses with a positive cachedUtxoCount are returned.
 */
export async function getAddressBalanceRowsForGroup(
  groupBy: GroupBy,
  groupKey: string,
): Promise<AddressBalanceRow[]> {
  const rows: AddressBalanceRow[] = [];
  const pushIfUtxo = (r: Record): void => {
    if (r.id == null || !r.inputString) return;
    const utxoCount = r.cachedUtxoCount ?? 0;
    if (utxoCount <= 0) return;
    rows.push({
      id: r.id,
      address: r.inputString,
      sats: r.cachedBalanceSats ?? 0,
      utxoCount,
      label: r.label || undefined,
    });
  };

  if (groupKey !== GROUP_EMPTY_KEY[groupBy]) {
    const indexField =
      groupBy === 'wallet' ? 'walletName'
      : groupBy === 'seed' ? 'seedName'
      : groupBy === 'owner' ? 'owner'
      : groupBy === 'tag' ? 'tags'
      : 'categories';
    await db.records
      .where(indexField)
      .equals(groupKey)
      .each((r) => { if (r.type === 'address') pushIfUtxo(r); });
    return rows;
  }

  const BATCH = 1000;
  let beforeIdExclusive: number | undefined = undefined;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await getRecordsPageByTypeIdReverseKeyset('address', { limit: BATCH, beforeIdExclusive });
    if (batch.length === 0) break;
    for (const r of batch) {
      if (addressMatchesGroup(r, groupBy, groupKey)) pushIfUtxo(r);
    }
    beforeIdExclusive = batch[batch.length - 1].id ?? undefined;
    if (batch.length < BATCH || beforeIdExclusive == null) break;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return rows;
}

export async function getRecordsByDiscoveredFromIds(
  parentIds: number[]
): Promise<Record[]> {
  if (parentIds.length === 0) return [];
  return db.records
    .where('discoveredFromRecordId')
    .anyOf(parentIds)
    .toArray();
}

export async function countRecordsByDiscoveredFromIdFiltered(
  parentId: number,
  filter: (r: Record) => boolean
): Promise<number> {
  return db.records
    .where('discoveredFromRecordId')
    .equals(parentId)
    .filter(filter)
    .count();
}

export async function getRecordsByTypeFilteredAll(
  type: string,
  filter: (r: Record) => boolean
): Promise<Record[]> {
  return db.records
    .where('type')
    .equals(type)
    .filter(filter)
    .toArray();
}

export async function getRecordsByFilter(
  filter: (r: Record) => boolean
): Promise<Record[]> {
  return db.records.filter(filter).toArray();
}

export async function getRecordsAfterId(afterId: number, limit: number): Promise<Record[]> {
  return db.records.where('id').above(afterId).limit(limit).toArray();
}

export async function getRecordsByOffsetLimit(
  offset: number,
  limit: number
): Promise<Record[]> {
  return db.records.offset(offset).limit(limit).toArray();
}

export async function eachAddressRecord(
  callback: (record: Record) => void
): Promise<void> {
  return db.records.where('type').equals('address').each(callback);
}

export async function getRecordsByTypeFiltered(
  type: string,
  filter: (r: Record) => boolean,
  limit: number
): Promise<Record[]> {
  return db.records
    .where('type')
    .equals(type)
    .filter(filter)
    .limit(limit)
    .toArray();
}

export async function getRecentRecordsFiltered(
  filter: (r: Record) => boolean,
  limit: number
): Promise<Record[]> {
  return db.records
    .orderBy('updatedAt')
    .reverse()
    .filter(filter)
    .limit(limit)
    .toArray();
}

export async function searchRecordsByQuery(
  query: string,
  limit: number = 200
): Promise<Record[]> {
  if (!query.trim()) {
    return db.records.orderBy('updatedAt').reverse().limit(limit).toArray();
  }

  const lowerQuery = query.toLowerCase();

  return db.records
    .orderBy('updatedAt')
    .reverse()
    .filter(record =>
      record.label.toLowerCase().includes(lowerQuery) ||
      record.inputString.toLowerCase().includes(lowerQuery) ||
      (record.notes?.toLowerCase().includes(lowerQuery) ?? false) ||
      (record.tags?.some(t => t.toLowerCase().includes(lowerQuery)) ?? false) ||
      (record.categories?.some(c => c.toLowerCase().includes(lowerQuery)) ?? false)
    )
    .limit(limit)
    .toArray();
}

export async function findRecordByInputString(inputString: string): Promise<Record | undefined> {
  if (!inputString) return undefined;

  const trimmed = inputString.trim();

  const exactMatch = await db.records.where('inputString').equals(trimmed).first();
  if (exactMatch) return exactMatch;

  return await db.records.where('inputStringLower').equals(trimmed.toLowerCase()).first();
}

export async function createRecordOrigin(
  data: Omit<RecordOrigin, 'id' | 'createdAt'>
): Promise<number> {
  const { addRecordOrigin } = await import('./record-origins-crud');
  return addRecordOrigin(data, { skipNotification: true });
}

export async function getRecordOrigins(recordId: number): Promise<RecordOrigin[]> {
  const { getRecordOriginsByRecordId } = await import('./record-origins-crud');
  return getRecordOriginsByRecordId(recordId);
}

export function mergeRecordWithOrigins(
  record: Record, 
  origins: RecordOrigin[]
): Record {
  if (origins.length === 0) return record;
  
  const priorityOrder: { [key in RecordOriginType]: number } = {
    'manual': 0,
    'wallet-sync': 1,
    'xpub-derived': 2,
    'bulk-import': 3,
    'blockchain-sync': 4,
  };
  
  const sortedOrigins = [...origins].sort(
    (a, b) => priorityOrder[a.originType] - priorityOrder[b.originType]
  );
  
  const merged = { ...record };
  
  const allTags = new Set(record.tags || []);
  const allCategories = new Set(record.categories || []);
  
  for (const origin of sortedOrigins) {
    if (origin.tags) {
      origin.tags.forEach(t => allTags.add(t));
    }
    if (origin.categories) {
      origin.categories.forEach(c => allCategories.add(c));
    }
  }
  
  for (const origin of sortedOrigins) {
    if (!merged.label && origin.label) merged.label = origin.label;
    if (!merged.notes && origin.notes) merged.notes = origin.notes;
    if (!merged.seedName && origin.seedName) merged.seedName = origin.seedName;
    if (!merged.walletSoftware && origin.walletSoftware) merged.walletSoftware = origin.walletSoftware;
    if (!merged.privateKeyStatus && origin.privateKeyStatus) merged.privateKeyStatus = origin.privateKeyStatus;
    if (!merged.owner && origin.owner) merged.owner = origin.owner;
    if (!merged.walletName && origin.walletName) merged.walletName = origin.walletName;
    if (!merged.source && origin.source) merged.source = origin.source;
    if (!merged.xpub && origin.xpub) merged.xpub = origin.xpub;
    if (!merged.derivationPath && origin.derivationPath) merged.derivationPath = origin.derivationPath;
    if (!merged.chainType && origin.chainType) merged.chainType = origin.chainType;
  }
  
  merged.tags = Array.from(allTags);
  merged.categories = Array.from(allCategories);
  
  return merged;
}

export async function saveDerivationTemplate(template: {
  fingerprint: string;
  scriptType: 'P2WPKH' | 'P2PKH' | 'P2SH-P2WPKH' | 'P2TR';
  derivationPath: string;
  xpub: string;
  gapLimit: number;
  network: 'mainnet' | 'testnet';
  owner?: string;
  walletName?: string;
  seedName?: string;
  notes?: string;
}): Promise<number> {
  const { addDerivationTemplate } = await import('./derivation-templates-crud');
  return await addDerivationTemplate({
    fingerprint: template.fingerprint,
    scriptType: template.scriptType,
    derivationPath: template.derivationPath,
    xpub: template.xpub,
    gapLimit: template.gapLimit,
    network: template.network,
    owner: template.owner,
    walletName: template.walletName,
    seedName: template.seedName,
    notes: template.notes,
  }, { skipNotification: true });
}

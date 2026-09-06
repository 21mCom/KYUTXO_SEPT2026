import Dexie from 'dexie';
import { db, notifyDbChange, isUserCuratedImportance, type Record, type Attachment, type RecordOrigin, type RecordOriginType, type DerivationTemplate, type AddressImportance } from '../database';
import { getVaultRepository } from '../repository';
import { isValidImportanceTier, isHiddenDiscoveryTier, HIDDEN_DISCOVERY_TIERS } from '../db-types';
import { ensureOwner, ensureWalletName, ensureSeedName, ensureWalletSoftware } from './vocabulary-crud';
import { canonicalizeRecordIdentifier } from '../bitcoin';
import { getStaleTypeSpecificFields } from '../record-type-clears';
import { getActivityBus } from '../activity-bus';
import { type GroupBy, GROUP_EMPTY_KEY, addressMatchesGroup, type AddressBalanceRow } from '../balance-grouping';
import {
  beginRecordSearchIndexMutation,
  beginRecordSearchIndexRebuild,
  clearRecordSearchIndex,
  completeRecordSearchIndexMutation,
  failRecordSearchIndexMutation,
  getRecordSearchIndexState,
  getRecordIdsFromSearchIndex,
  persistRecordSearchIndexReadyState,
  removeRecordsFromSearchIndex,
  resetRecordSearchIndexForRebuild,
  syncRecordSearchIndex,
  syncRecordSearchIndexBatch,
  type RecordSearchIndexFingerprint,
} from './record-search-index';

async function getRecordSearchIndexFingerprint(): Promise<RecordSearchIndexFingerprint> {
  if (getVaultRepository().kind === 'protected') {
    // The derived Dexie search index is disabled for protected vaults.
    const recordCount = await getVaultRepository().count('records');
    return { recordCount, maxId: 0, maxUpdatedAt: 0 };
  }
  const [recordCount, newestById, newestByUpdatedAt] = await Promise.all([
    db.records.count(),
    db.records.orderBy('id').reverse().first(),
    db.records.orderBy('updatedAt').reverse().first(),
  ]);
  return {
    recordCount,
    maxId: newestById?.id ?? 0,
    maxUpdatedAt: newestByUpdatedAt?.updatedAt ?? 0,
  };
}

async function safelySyncRecordSearchIndex(record: Record): Promise<void> {
  if (getVaultRepository().kind === 'protected') return;
  try {
    const current = record.id == null ? undefined : await db.records.get(record.id);
    if (current) await syncRecordSearchIndex(current);
    else if (record.id != null) await removeRecordsFromSearchIndex([record.id]);
    await completeRecordSearchIndexMutation(await getRecordSearchIndexFingerprint());
  } catch (error) {
    // Records are authoritative. The persisted fingerprint makes the next
    // search rebuild this derived index after an interrupted/failed update.
    try {
      await failRecordSearchIndexMutation();
    } catch (releaseError) {
      console.warn('[record-search-index] Failed to release record mutation:', releaseError);
    }
    console.warn('[record-search-index] Record index update failed:', error);
  }
}

async function safelySyncRecordSearchIndexBatch(records: Record[]): Promise<void> {
  if (getVaultRepository().kind === 'protected') return;
  try {
    const ids = records.map((record) => record.id).filter((id): id is number => id != null);
    const current = (await db.records.bulkGet(ids)).filter((record): record is Record => !!record);
    await syncRecordSearchIndexBatch(current);
    await completeRecordSearchIndexMutation(await getRecordSearchIndexFingerprint());
  } catch (error) {
    try {
      await failRecordSearchIndexMutation();
    } catch (releaseError) {
      console.warn('[record-search-index] Failed to release batch mutation:', releaseError);
    }
    console.warn('[record-search-index] Batch index update failed:', error);
  }
}

async function safelyRemoveRecordsFromSearchIndex(ids: number[]): Promise<void> {
  if (getVaultRepository().kind === 'protected') return;
  try {
    await removeRecordsFromSearchIndex(ids);
    await completeRecordSearchIndexMutation(await getRecordSearchIndexFingerprint());
  } catch (error) {
    try {
      await failRecordSearchIndexMutation();
    } catch (releaseError) {
      console.warn('[record-search-index] Failed to release removal mutation:', releaseError);
    }
    console.warn('[record-search-index] Record index removal failed:', error);
  }
}

let recordSearchIndexRebuild: Promise<void> | undefined;

async function rebuildRecordSearchIndex(): Promise<void> {
  if (recordSearchIndexRebuild) return recordSearchIndexRebuild;
  recordSearchIndexRebuild = (async () => {
    for (;;) {
      const before = await getRecordSearchIndexFingerprint();
      const generation = await beginRecordSearchIndexRebuild(before);
      if (generation === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        continue;
      }
      await resetRecordSearchIndexForRebuild();

      const BATCH = 500;
      let lastId = 0;
      for (;;) {
        const records = await db.records.where('id').above(lastId).limit(BATCH).toArray();
        if (records.length === 0) break;
        lastId = records[records.length - 1].id ?? lastId;
        const currentRecords = (
          await db.records.bulkGet(
            records.map((record) => record.id).filter((id): id is number => id != null),
          )
        ).filter((record): record is Record => !!record);
        await syncRecordSearchIndexBatch(currentRecords);
        if (records.length < BATCH) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      const ready = await persistRecordSearchIndexReadyState(
        await getRecordSearchIndexFingerprint(),
        generation,
      );
      if (ready) break;
    }
  })().finally(() => {
    recordSearchIndexRebuild = undefined;
  });
  return recordSearchIndexRebuild;
}

async function ensureRecordSearchIndex(): Promise<void> {
  if (recordSearchIndexRebuild) return recordSearchIndexRebuild;
  const [state, fingerprint] = await Promise.all([
    getRecordSearchIndexState(),
    getRecordSearchIndexFingerprint(),
  ]);
  const current =
    state?.version === 1 &&
    state.status === 'ready' &&
    state.recordCount === fingerprint.recordCount &&
    state.maxId === fingerprint.maxId &&
    state.maxUpdatedAt === fingerprint.maxUpdatedAt;
  if (!current) await rebuildRecordSearchIndex();
}

export function warmRecordSearchIndex(): void {
  void ensureRecordSearchIndex().catch((error) => {
    console.warn('[record-search-index] Background rebuild failed:', error);
  });
}

async function isRecordSearchIndexReady(): Promise<boolean> {
  const [state, fingerprint] = await Promise.all([
    getRecordSearchIndexState(),
    getRecordSearchIndexFingerprint(),
  ]);
  return (
    state?.version === 1 &&
    state.status === 'ready' &&
    state.recordCount === fingerprint.recordCount &&
    state.maxId === fingerprint.maxId &&
    state.maxUpdatedAt === fingerprint.maxUpdatedAt
  );
}

/**
 * Drop the hover-metadata cache entry for `identifier` after a record write so a
 * visible AddressLink/TxidLink's orange FileText indicator / tooltip refreshes
 * immediately instead of showing stale data for up to the cache TTL. Loaded
 * lazily to avoid a static import cycle (metadata-hover imports this module);
 * fire-and-forget since the module is already resident and invalidation is
 * non-critical to the write completing.
 */
function invalidateHoverCache(identifier: string): void {
  void import('../metadata-hover')
    .then((m) => m.invalidateCachedRecord(identifier))
    .catch(() => {});
}

/**
 * Bulk variant of {@link invalidateHoverCache} for write paths that touch many
 * records at once (e.g. the Bulk Editor). Re-resolution stays bounded because
 * the underlying invalidateCachedRecords only re-resolves identifiers that are
 * currently subscribed (visible on screen); off-screen ones are cleared and
 * resolve lazily on the next hover/preload.
 */
function invalidateHoverCacheMany(identifiers: string[]): void {
  if (identifiers.length === 0) return;
  void import('../metadata-hover')
    .then((m) => m.invalidateCachedRecords(identifiers))
    .catch(() => {});
}

/**
 * Drop the entire hover-metadata cache after a full wipe of the records table
 * so no orange FileText indicator / tooltip lingers for up to the cache TTL.
 */
function clearHoverCache(): void {
  void import('../metadata-hover')
    .then((m) => m.clearCachedRecords())
    .catch(() => {});
}

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

// Source-string markers written by the wallet/label import flows
// (generateSourceName in WalletImport / MobileWalletImport / BIP329Import).
// Matched with .includes() because merges concatenate sources with "; "
// (merge-utils mergedSource), so an import marker can appear anywhere in the
// string, not just at the start.
const WALLET_IMPORT_SOURCE_MARKERS = ['walletImport-', 'mobileImport-', 'bip329Import'] as const;
// Descriptor imports derive their addresses from a descriptor/xpub, so their
// marker maps to the xpub-derived tier (those rows normally also carry a
// derivationPath, which is the primary signal — the marker is a backstop).
const DERIVED_SOURCE_MARKERS = ['descriptorImport-', 'xpub-import'] as const;

function hasSourceMarker(source: string | undefined, markers: readonly string[]): boolean {
  if (!source) return false;
  return markers.some((m) => source.includes(m));
}

export function deriveAddressImportance(data: CreateRecordData): AddressImportance {
  // Only honor a provided tier when it is one of the six recognized values.
  // Restores of old backups can carry legacy/unknown tier strings verbatim;
  // letting those through recreates rows that index-based tier queries (the
  // Dexie anyOf narrowing on Records browse/search) silently skip. Fall
  // through to provenance-based derivation instead, so every inserted row
  // lands on a recognized tier. (The v29 migration normalized rows that
  // already existed; this guards the insert path so restores cannot
  // reintroduce the class. repairAddressImportanceTiers re-derives existing
  // invalid rows through this same function.)
  if (data.addressImportance && isValidImportanceTier(data.addressImportance)) {
    return data.addressImportance;
  }
  // Sync provenance wins: rows discovered by blockchain sync must land back
  // on a hidden discovery tier, never a curated one, or they would inflate
  // the curated-tier balance surfaces (owned totals).
  if (data.syncDepth !== undefined && data.syncDepth > 0) return 'blockchain-discovered';
  if (data.source === 'blockchain-sync') return 'blockchain-discovered';
  // Wallet/label imports are user-owned metadata. Checked before the exactly
  // 'blockchain-sync' fallback above would ever match a merged string like
  // "blockchain-sync; walletImport-…" — a row the user imported is theirs.
  if (hasSourceMarker(data.source, WALLET_IMPORT_SOURCE_MARKERS)) return 'wallet-import';
  if (
    hasSourceMarker(data.source, DERIVED_SOURCE_MARKERS) ||
    data.xpub ||
    data.derivationPath
  ) {
    return 'xpub-derived';
  }
  return 'manual';
}

function buildFullRecord(data: CreateRecordData): Record {
  const now = Date.now();
  // Store identifiers in canonical form (trimmed; bech32/txid lowercased) so
  // every exact-match lookup — sync find-or-create, import merges, provenance,
  // fund-trail, fast-path search — agrees on record identity no matter how the
  // identifier was typed.
  const canonicalInput = data.inputString
    ? canonicalizeRecordIdentifier(data.inputString)
    : data.inputString;
  return {
    ...data,
    inputString: canonicalInput,
    addressImportance: deriveAddressImportance(data),
    inputStringLower: canonicalInput ? canonicalInput.toLowerCase() : '',
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
  
  await beginRecordSearchIndexMutation();
  const id = await getVaultRepository().add('records', record);
  record.id = id as number;
  await safelySyncRecordSearchIndex(record);

  // Drop any cached "no record" hover-metadata entry for this identifier so a
  // visible AddressLink/TxidLink (e.g. a transaction counterparty rendered
  // before this record existed) shows its orange FileText indicator / tooltip
  // immediately instead of staying absent for up to the cache TTL.
  if (record.inputString) invalidateHoverCache(record.inputString);

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

    await beginRecordSearchIndexMutation();
    const ids = await getVaultRepository().bulkPut('records', fullRecords);
    fullRecords.forEach((record, index) => {
      record.id = ids[index] as number;
    });
    await safelySyncRecordSearchIndexBatch(fullRecords);

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

    // Drop any cached "no record" hover-metadata entries for the newly created
    // identifiers so visible AddressLink/TxidLinks (e.g. transaction
    // counterparties rendered before these records existed) show their orange
    // FileText indicator / tooltip immediately instead of staying absent for up
    // to the cache TTL.
    invalidateHoverCacheMany(
      fullRecords
        .map((r) => r.inputString)
        .filter((s): s is string => !!s),
    );

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
  const existing = await getVaultRepository().get('records', id);
  if (!existing) throw new Error('Record not found');

  const merged = {
    ...existing,
    ...updates,
    id,
    updatedAt: Date.now(),
  };
  if (updates.inputString !== undefined) {
    // Same canonicalization as the create path: an edit can never reintroduce
    // a padded / differently-cased identifier.
    const canonicalInput = updates.inputString
      ? canonicalizeRecordIdentifier(updates.inputString)
      : updates.inputString;
    merged.inputString = canonicalInput;
    merged.inputStringLower = canonicalInput ? canonicalInput.toLowerCase() : '';
  }
  const updated: Record = merged;

  if (!options?.skipVocabularySync) {
    syncRecordVocabulary(updates).catch((err) => {
      console.warn('[updateRecord] Vocabulary sync failed:', err);
    });
  }

  await beginRecordSearchIndexMutation();
  await getVaultRepository().put('records', updated);
  await safelySyncRecordSearchIndex(updated);

  // Drop the hover-metadata cache so the orange FileText indicator / tooltip on
  // any visible AddressLink/TxidLink refreshes immediately instead of showing
  // stale data for up to the cache TTL. Invalidate both the old and (if it
  // changed) the new identifier.
  if (existing.inputString) invalidateHoverCache(existing.inputString);
  if (updates.inputString && updates.inputString !== existing.inputString) {
    invalidateHoverCache(updates.inputString);
  }

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
    const existingRecords = (await Promise.all(ids.map((id) => getVaultRepository().get('records', id)))).filter((row): row is Record => !!row);
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
    // Identifiers whose hover-metadata cache must be dropped so the orange
    // FileText indicator / tooltip on any visible AddressLink/TxidLink refreshes
    // immediately. Collect both the old inputString and (when it changes) the
    // new one. Deduplicated via a Set so a large run doesn't queue redundant
    // re-resolves.
    const identifiersToInvalidate = new Set<string>();
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

      if (existing.inputString) identifiersToInvalidate.add(existing.inputString);
      if (changes.inputString && changes.inputString !== existing.inputString) {
        identifiersToInvalidate.add(changes.inputString);
      }
    }
    
    await beginRecordSearchIndexMutation();
    await getVaultRepository().bulkPut('records', recordsToSave);
    await safelySyncRecordSearchIndexBatch(recordsToSave);
    
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
    
    // Drop the hover-metadata cache for every changed identifier so the orange
    // FileText indicator / tooltip on visible AddressLink/TxidLinks refreshes
    // immediately instead of lingering for up to the cache TTL.
    invalidateHoverCacheMany(Array.from(identifiersToInvalidate));

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
  const existing = (await Promise.all(ids.map((id) => getVaultRepository().get('records', id)))).filter((row): row is Record => !!row);
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

  await getVaultRepository().bulkPut('records', toSave);

  // NOTE: intentionally no hover-cache invalidation here. This path only writes
  // the per-address stats cache fields (cachedBalanceSats, cachedTxCount,
  // cachedLastActivityTime, cachedUtxoCount, statsComputedAt), none of which
  // feed the orange FileText indicator / hover tooltip (label, owner, wallet,
  // seed, software, categories, tags, key status, notes). Invalidating here
  // would needlessly re-resolve identifiers on every stats refresh.

  if (!options?.skipNotification) {
    notifyDbChange('records', options?.origin ? { origin: options.origin } : undefined);
  }

  return toSave.length;
}

// Bulk delete by primary key, WITHOUT the attachment-archiving cascade that
// deleteRecord performs. Used ONLY by the merge-cancel undo pass in the v3
// restore: the rows (and their attachment rows) were inserted by the merge
// itself moments earlier and are removed together, so archiving their
// attachments as "recoverable" would be noise, not safety.
export async function bulkDeleteRecords(
  ids: number[],
  options?: DeleteRecordOptions
): Promise<void> {
  if (ids.length === 0) return;

  const existing = await Promise.all(ids.map((id) => getVaultRepository().get('records', id)));
  await beginRecordSearchIndexMutation();
  await getVaultRepository().deleteOrArchiveRecords({
    recordIds: ids,
    mode: 'delete',
  });
  await safelyRemoveRecordsFromSearchIndex(ids);

  // Drop hover-metadata cache entries so any visible AddressLink/TxidLink for
  // a removed record clears immediately instead of lingering for the TTL.
  for (const r of existing) {
    if (r?.inputString) invalidateHoverCache(r.inputString);
  }

  if (!options?.skipNotification) {
    notifyDbChange('records');
  }
}

export interface DeleteRecordOptions {
  skipNotification?: boolean;
}

// Bulk delete WITH the attachment-archiving cascade that deleteRecord performs
// per-record (unlike bulkDeleteRecords above, which is merge-cancel-undo-only
// and skips archiving). Used by user-initiated multi-record deletes (Dashboard
// bulk delete) so a many-thousand-record selection doesn't serialize one
// IndexedDB round-trip per record — attachments for every id are archived in a
// single bulkAdd, then attachment rows and record rows are each removed in one
// bulkDelete. Same fix pattern as bulkCreateRecords/bulkUpdateRecords (Task
// #2129): callers should chunk `ids` themselves and fall back to per-record
// deleteRecord() for any chunk that throws.
export async function bulkDeleteRecordsWithArchiving(
  ids: number[],
  options?: DeleteRecordOptions
): Promise<void> {
  if (ids.length === 0) return;

  const { archiveAttachments } = await import('./trash-crud');
  const existing = await Promise.all(ids.map((id) => getVaultRepository().get('records', id)));
  const wantedRecordIds = new Set(ids);
  const attachmentRows: Attachment[] = [];
  let attachmentCursor: string | number | undefined;
  do {
    const page = await getVaultRepository().list('attachments', { cursor: attachmentCursor, limit: 500 });
    attachmentRows.push(...page.rows.filter((attachment) => wantedRecordIds.has(attachment.recordId)));
    attachmentCursor = page.cursor;
  } while (attachmentCursor !== undefined);
  const attachments = attachmentRows;

  // Archiving happens before any rows are removed; if it throws we abort so
  // nothing becomes unrecoverable (same ordering as deleteRecord).
  if (attachments.length > 0) {
    await archiveAttachments(attachments, 'record-delete', { skipNotification: true });
  }

  await getVaultRepository().bulkDelete('attachments', attachments.map((attachment) => attachment.id!).filter((id) => id !== undefined));
  await beginRecordSearchIndexMutation();
  await getVaultRepository().deleteOrArchiveRecords({
    recordIds: ids,
    mode: 'delete',
  });
  await safelyRemoveRecordsFromSearchIndex(ids);

  // Drop the hover-metadata cache for every deleted record so a visible
  // AddressLink/TxidLink's orange FileText indicator / tooltip clears
  // immediately instead of lingering for up to the cache TTL.
  invalidateHoverCacheMany(
    existing
      .filter((r): r is Record => !!r?.inputString)
      .map((r) => r.inputString)
  );

  if (!options?.skipNotification) {
    notifyDbChange('records');
    if (attachments.length > 0) {
      notifyDbChange('trashedAttachments');
    }
  }
}

export async function deleteRecord(id: number, options?: DeleteRecordOptions): Promise<void> {
  const { getAttachmentsByRecordId, deleteAttachmentsByRecordId } = await import('./attachments-crud');
  const { archiveAttachments } = await import('./trash-crud');
  const existing = await getVaultRepository().get('records', id);
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
  await beginRecordSearchIndexMutation();
  await getVaultRepository().deleteOrArchiveRecords({
    recordIds: [id],
    mode: 'delete',
  });
  await safelyRemoveRecordsFromSearchIndex([id]);

  // Drop the hover-metadata cache so a deleted record's orange FileText
  // indicator / tooltip on any visible AddressLink/TxidLink clears immediately
  // instead of lingering for up to the cache TTL.
  if (existing?.inputString) invalidateHoverCache(existing.inputString);

  if (!options?.skipNotification) {
    notifyDbChange('records');
    if (attachments.length > 0) {
      notifyDbChange('trashedAttachments');
    }
  }
}

// Restore-only pointer fixup: re-points `discoveredFromRecordId` on rows a
// backup restore just inserted, after the old→new record id map is complete.
// Deliberately does NOT bump `updatedAt` (restore must preserve the backup's
// timestamps byte-for-byte) and does NOT touch any other field. Rows that no
// longer exist are silently skipped (a cancelled restore may have removed them).
export async function bulkSetDiscoveredFromRecordId(
  updates: Array<{ id: number; discoveredFromRecordId: number }>,
  options?: { skipNotification?: boolean },
): Promise<void> {
  if (updates.length === 0) return;
  const ids = updates.map((u) => u.id);
  const existing = await Promise.all(ids.map((id) => getVaultRepository().get('records', id)));
  const toPut: Record[] = [];
  for (let i = 0; i < updates.length; i++) {
    const row = existing[i];
    if (!row) continue;
    toPut.push({ ...row, discoveredFromRecordId: updates[i].discoveredFromRecordId });
  }
  if (toPut.length === 0) return;
  await getVaultRepository().bulkPut('records', toPut);
  if (!options?.skipNotification) {
    notifyDbChange('records');
  }
}

export interface ClearAllRecordsOptions {
  skipNotification?: boolean;
}

export async function clearAllRecords(options?: ClearAllRecordsOptions): Promise<void> {
  await getVaultRepository().clear('records');
  try {
    await clearRecordSearchIndex();
  } catch (error) {
    console.warn('[record-search-index] Clear failed:', error);
  }

  // Wipe the entire hover-metadata cache so no orange FileText indicator /
  // tooltip lingers for up to the cache TTL after every record is gone.
  clearHoverCache();

  if (!options?.skipNotification) {
    notifyDbChange('records');
  }
}

// -----------------------------------------------------------------------------
// READ HELPERS
// -----------------------------------------------------------------------------

export async function getRecord(id: number): Promise<Record | undefined> {
  return getVaultRepository().get('records', id);
}

export async function bulkGetRecords(ids: number[]): Promise<(Record | undefined)[]> {
  return Promise.all(ids.map((id) => getVaultRepository().get('records', id)));
}

export async function getRecordsByIds(ids: number[]): Promise<Record[]> {
  if (ids.length === 0) return [];
  return (await bulkGetRecords(ids)).filter((row): row is Record => !!row);
}

export async function getAllRecords(): Promise<Record[]> {
  const records: Record[] = [];
  let cursor: string | number | undefined;
  do {
    const page = await getVaultRepository().list('records', { cursor, limit: 500 });
    records.push(...page.rows);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return records;
}

/** Legacy category values are free-form strings, so this intentionally groups
 * case variants rather than relying on Dexie's case-sensitive multi-entry
 * index. Kept here so consumers do not bypass the records CRUD boundary. */
export async function getRecordCategoryKeys(): Promise<string[]> {
  const keys = await db.records.orderBy('categories').uniqueKeys();
  return keys.filter((key): key is string => typeof key === 'string' && key.trim() !== '');
}
/**
 * Lightweight record search for pickers (e.g. re-attaching an orphaned file to a
 * record). Matches the trimmed query case-insensitively against the address /
 * txid (inputString) prefix and the label substring, capped at `limit` results.
 * Read-only; safe to call directly without going through a write CRUD path.
 */
export async function searchRecordsForPicker(query: string, limit = 25): Promise<Record[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const byInput = await db.records
    .where('inputStringLower')
    .startsWith(q)
    .limit(limit)
    .toArray();
  if (byInput.length >= limit) return byInput;
  const seen = new Set<number>(byInput.map((r) => r.id!).filter((id) => id !== undefined));
  const byLabel = await db.records
    .filter((r) => typeof r.label === 'string' && r.label.toLowerCase().includes(q))
    .limit(limit)
    .toArray();
  const merged = [...byInput];
  for (const r of byLabel) {
    if (merged.length >= limit) break;
    if (r.id !== undefined && seen.has(r.id)) continue;
    merged.push(r);
  }
  return merged.slice(0, limit);
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

/**
 * Re-runnable repair for rows whose `addressImportance` is missing or an
 * unrecognized legacy value (e.g. restored verbatim from a backup written
 * before the tier vocabulary settled). Such rows silently drop out of every
 * index-narrowed tier query (Dexie anyOf) even though the exclusion-based
 * paths (engine SQL, residual filters) still show them.
 *
 * Normalization is provenance-aware — the same derivation used at insert time
 * (sync provenance → blockchain-discovered, wallet import → wallet-import,
 * xpub → xpub-derived, otherwise manual) — NOT the v29 migration's blanket
 * 'manual'. Blanket 'manual' would promote sync-discovered rows into the
 * user-curated tier allowlists that balance surfaces rely on, silently
 * inflating "owned" totals; provenance derivation cannot.
 *
 * Fixed rows get a fresh `updatedAt`. This is deliberate: the native engine
 * mirror's freshness fingerprint is (count, maxId, maxUpdatedAt) — a repair
 * that preserved updatedAt would be invisible to the gate, leaving a
 * CURRENT-looking mirror serving the old tiers until an unrelated write.
 *
 * Keyset iteration, abort-safe on huge vaults; safe to run any number of
 * times (valid-tier rows are never touched).
 */
export async function repairAddressImportanceTiers(
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

      const now = Date.now();
      const toFix: Record[] = [];
      for (const r of chunk) {
        if (isValidImportanceTier(r.addressImportance)) continue;
        const normalized = deriveAddressImportance({ ...r, addressImportance: undefined });
        toFix.push({ ...r, addressImportance: normalized, updatedAt: now });
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
      '[repairAddressImportanceTiers] Failed:',
      err instanceof Error ? err.message : err,
    );
  }

  if (fixed > 0) {
    notifyDbChange('records');
  }

  return { scanned, fixed, ok };
}

/**
 * One-time (re-runnable) repair for rows written before identifiers were
 * canonicalized at the CRUD boundary. Such rows store a padded, uppercase
 * bech32, or uppercase-hex `inputString` verbatim, which makes them invisible
 * to the case-sensitive exact-match lookups sync/import/provenance use and
 * drops them from the fast-path `inputStringLower` search (their lowercase
 * key carries the padding).
 *
 * Two keyset-batched passes (abort-safe on huge vaults, yields between
 * batches):
 *   1. Count how many records share each canonical key. This needs
 *      whole-vault key multiplicity, so the counts live in one in-memory map
 *      (a few MB even on very large vaults) — there is no index that can
 *      answer "would this rewrite collide?" without it.
 *   2. Rewrite non-canonical rows whose canonical key is claimed by exactly
 *      one record. Rows whose canonical key collides with another record are
 *      left UNTOUCHED (rewriting them would fabricate a duplicate) and
 *      counted in `skippedCollisions` so the Database Doctor can surface them.
 *
 * Fixed rows get a fresh `updatedAt` so the engine mirror's freshness
 * fingerprint (count, maxId, maxUpdatedAt) observes the change. Re-running is
 * safe: normalized rows no longer qualify, and collision rows are re-skipped.
 *
 * Returns counts plus `ok`; callers should only persist a "done" flag when
 * `ok` is true, so a partial failure retries on next login.
 */
export async function repairCanonicalInputStrings(
  onProgress?: (scanned: number, fixed: number, skippedCollisions: number) => void,
): Promise<{ scanned: number; fixed: number; skippedCollisions: number; ok: boolean }> {
  const BATCH = 1000;
  let lastId = 0;
  let scanned = 0;
  let fixed = 0;
  let skippedCollisions = 0;
  let ok = true;
  const canonicalKeyCounts = new Map<string, number>();

  try {
    // Pass 1: canonical-key multiplicity across the whole table.
    for (;;) {
      const chunk = await db.records
        .where('id')
        .above(lastId)
        .limit(BATCH)
        .toArray();
      if (chunk.length === 0) break;
      lastId = chunk[chunk.length - 1].id!;

      for (const r of chunk) {
        if (!r.inputString) continue;
        const key = canonicalizeRecordIdentifier(r.inputString);
        canonicalKeyCounts.set(key, (canonicalKeyCounts.get(key) ?? 0) + 1);
      }

      if (chunk.length < BATCH) break;
      // Yield between batches so a huge vault does not freeze the renderer.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // Pass 2: rewrite non-colliding non-canonical rows.
    lastId = 0;
    for (;;) {
      const chunk = await db.records
        .where('id')
        .above(lastId)
        .limit(BATCH)
        .toArray();
      if (chunk.length === 0) break;
      lastId = chunk[chunk.length - 1].id!;
      scanned += chunk.length;

      const now = Date.now();
      const toFix: Record[] = [];
      for (const r of chunk) {
        if (!r.inputString) continue;
        const canonical = canonicalizeRecordIdentifier(r.inputString);
        if (canonical === r.inputString) continue;
        if ((canonicalKeyCounts.get(canonical) ?? 0) > 1) {
          skippedCollisions++;
          continue;
        }
        toFix.push({
          ...r,
          inputString: canonical,
          inputStringLower: canonical.toLowerCase(),
          updatedAt: now,
        });
      }

      if (toFix.length > 0) {
        await db.records.bulkPut(toFix);
        fixed += toFix.length;
      }

      onProgress?.(scanned, fixed, skippedCollisions);
      if (chunk.length < BATCH) break;
      // Yield between batches so a huge vault does not freeze the renderer.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } catch (err) {
    ok = false;
    console.error(
      '[repairCanonicalInputStrings] Failed:',
      err instanceof Error ? err.message : err,
    );
  }

  if (fixed > 0) {
    notifyDbChange('records');
  }

  return { scanned, fixed, skippedCollisions, ok };
}
/**
 * Re-runnable repair for records still carrying type-specific metadata their
 * CURRENT type can no longer show or edit (flowType/dispositionType on
 * addresses, counterpartyType/counterpartyName on transactions, all six
 * type-specific fields on 'other'). The edit form now clears these on a Type
 * switch, but rows whose Type was switched before that fix keep the orphaned
 * values, which can surface in reports and exports.
 *
 * Uses the exact same mapping the form uses (getStaleTypeSpecificFields /
 * getTypeSwitchClears in lib/record-type-clears), so scan, repair, and the
 * live edit path can never disagree about which fields are stale.
 *
 * Fixed rows get a fresh `updatedAt` so the engine mirror's freshness
 * fingerprint observes the change. Keyset-batched with yields; safe to run
 * any number of times (healthy rows are never touched).
 */
export async function repairStaleTypeSpecificFields(
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

      const now = Date.now();
      const toFix: Record[] = [];
      for (const r of chunk) {
        const staleKeys = getStaleTypeSpecificFields(r);
        if (staleKeys.length === 0) continue;
        const repaired: Record = { ...r, updatedAt: now };
        for (const key of staleKeys) {
          // Delete (not set-to-undefined) so the stored row truly drops the
          // field, matching what IndexedDB's structured clone does on the
          // live edit path.
          delete (repaired as unknown as globalThis.Record<string, unknown>)[key];
        }
        toFix.push(repaired);
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
      '[repairStaleTypeSpecificFields] Failed:',
      err instanceof Error ? err.message : err,
    );
  }

  if (fixed > 0) {
    notifyDbChange('records');
  }

  return { scanned, fixed, ok };
}

export interface SearchVisibilityIssues {
  /** At least one row has a missing or unrecognized importance tier. */
  tiersAffected: boolean;
  /** At least one row's inputStringLower is out of sync with inputString. */
  searchKeysAffected: boolean;
}

/**
 * Detect whether either data class that makes old records unfindable in
 * Records search is present: missing/invalid importance tiers (dropped by the
 * Dexie anyOf tier narrowings) or a desynced `inputStringLower` search key.
 * Uses the exact same predicates as the Database Doctor's health check and
 * the corresponding repairs (repairAddressImportanceTiers /
 * repairInputStringLower), so a positive detection is always repairable.
 *
 * Keyset-batched with yields (safe on huge vaults); short-circuits as soon as
 * both classes are seen. Read-only.
 */
export async function detectSearchVisibilityIssues(
  onProgress?: (scanned: number) => void,
): Promise<SearchVisibilityIssues> {
  const BATCH = 1000;
  let lastId = 0;
  let scanned = 0;
  let tiersAffected = false;
  let searchKeysAffected = false;

  for (;;) {
    const chunk = await db.records
      .where('id')
      .above(lastId)
      .limit(BATCH)
      .toArray();
    if (chunk.length === 0) break;
    lastId = chunk[chunk.length - 1].id!;
    scanned += chunk.length;

    for (const r of chunk) {
      if (!tiersAffected && !isValidImportanceTier(r.addressImportance)) {
        tiersAffected = true;
      }
      if (!searchKeysAffected) {
        const expected = r.inputString ? r.inputString.toLowerCase() : '';
        if (r.inputStringLower !== expected) searchKeysAffected = true;
      }
      if (tiersAffected && searchKeysAffected) break;
    }

    onProgress?.(scanned);
    if (tiersAffected && searchKeysAffected) break;
    if (chunk.length < BATCH) break;
    // Yield between batches so a huge vault does not freeze the renderer.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return { tiersAffected, searchKeysAffected };
}

export interface HiddenTierMatchCount {
  /** Number of hidden-tier rows matching the current filters (up to matchCap). */
  count: number;
  /** True when counting stopped at matchCap — render as "cap+". */
  capped: boolean;
  /** True when the scan cap was hit before matchCap — the count is a lower bound. */
  scanCapped: boolean;
}

export interface HiddenTierMatchRows {
  /** Matching hidden-tier rows, in scan order, up to matchCap. */
  rows: Record[];
  /** True when the fetch stopped at matchCap — more matches exist than rows. */
  capped: boolean;
  /** True when the scan cap was hit before matchCap — the set is partial. */
  scanCapped: boolean;
}

export interface HiddenTierMatchScanOptions {
  matches: (record: Record) => boolean;
  identifier?: string | null;
  matchCap?: number;
  scanCap?: number;
  isCancelled?: () => boolean;
}

/**
 * Single bounded hidden-tier scan shared by countHiddenTierMatches and
 * getHiddenTierMatches, so the "N matches are hidden" count and the rows the
 * one-click reveal surfaces can never drift apart: same tier narrowing, same
 * predicate, same match/scan caps, same cancellation contract. `onMatch`
 * collects rows when the caller wants them; otherwise only the count is
 * computed (the identifier fast path then stays a pure indexed `.count()`).
 */
async function scanHiddenTierMatches(
  opts: HiddenTierMatchScanOptions,
  onMatch?: (record: Record) => void,
): Promise<HiddenTierMatchCount> {
  const matchCap = opts.matchCap ?? 1000;
  const scanCap = opts.scanCap ?? 200_000;

  if (opts.identifier) {
    const query = db.records
      .where('inputStringLower')
      .equals(opts.identifier.toLowerCase())
      .filter((r) => isHiddenDiscoveryTier(r.addressImportance) && opts.matches(r));
    if (onMatch) {
      const rows = await query.toArray();
      rows.forEach(onMatch);
      return { count: rows.length, capped: false, scanCapped: false };
    }
    const count = await query.count();
    return { count, capped: false, scanCapped: false };
  }

  let scanned = 0;
  let count = 0;
  await db.records
    .where('addressImportance')
    .anyOf([...HIDDEN_DISCOVERY_TIERS])
    .until(() => count >= matchCap || scanned >= scanCap || (opts.isCancelled?.() ?? false))
    .each((r) => {
      scanned++;
      if (opts.matches(r)) {
        count++;
        onMatch?.(r);
      }
    });

  return {
    count: Math.min(count, matchCap),
    capped: count >= matchCap,
    scanCapped: scanned >= scanCap && count < matchCap,
  };
}

/**
 * Count blockchain-discovered / pending-review rows that match the current
 * Records-page filters (minus the tier exclusion itself). Powers the
 * "N matches hidden among discovered records" hint, so a search over the
 * default view never dead-ends silently when the only matches are rows the
 * discovered-records toggle hides.
 *
 * Runs as a deferred background count and is bounded on both sides: it stops
 * after `matchCap` matches (UI shows "cap+") and after scanning `scanCap`
 * hidden rows (a multi-million-row discovered set is never walked end to end
 * just to render a hint). `isCancelled` lets a superseded page load abort the
 * walk early. When `identifier` is set (the exact address/txid fast path) the
 * count uses the inputStringLower index instead of walking hidden rows.
 */
export async function countHiddenTierMatches(
  opts: HiddenTierMatchScanOptions,
): Promise<HiddenTierMatchCount> {
  return scanHiddenTierMatches(opts);
}

/**
 * Row-returning sibling of countHiddenTierMatches: fetches the actual
 * hidden-tier rows matching the current filters (up to matchCap) instead of
 * counting them. Powers the Dashboard's "Show hidden matches" reveal, which
 * must surface rows that fall outside the loaded 5,000-record window —
 * flipping the discovered-records toggle alone only reloads that same window.
 *
 * Shares the exact scan/predicate/cap implementation with the count via
 * scanHiddenTierMatches, so the notice and the reveal can never disagree.
 */
export async function getHiddenTierMatches(
  opts: HiddenTierMatchScanOptions,
): Promise<HiddenTierMatchRows> {
  const rows: Record[] = [];
  const { capped, scanCapped } = await scanHiddenTierMatches(opts, (r) => {
    rows.push(r);
  });
  return { rows, capped, scanCapped };
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
  const repository = getVaultRepository();
  if (repository.kind === 'protected') {
    // Keep the packaged renderer on the finite native query vocabulary. This
    // finder is intentionally bounded by the repository's 1,000-row maximum;
    // callers that need to walk a complete table must use a keyset CRUD helper.
    return repository.query<Record>('records', 'records.byRecordType', type, 1000);
  }
  return db.records.where('type').equals(type).toArray();
}

export async function getRecordsByInputString(inputString: string): Promise<Record[]> {
  // Canonicalize the lookup key: stored identifiers are canonical, so a
  // padded / differently-cased query must match them.
  const value = canonicalizeRecordIdentifier(inputString);
  const repository = getVaultRepository();
  if (repository.kind === 'protected') {
    return repository.query<Record>('records', 'records.byInputStringLower', value.toLowerCase(), 100);
  }
  return db.records.where('inputString').equals(value).toArray();
}

export async function getRecordsByInputStrings(values: string[]): Promise<Record[]> {
  if (values.length === 0) return [];
  const canonical = values.map(canonicalizeRecordIdentifier);
  const repository = getVaultRepository();
  if (repository.kind === 'protected') {
    return repository.query<Record>('records', 'records.byInputStrings', canonical, Math.min(canonical.length, 1000));
  }
  return db.records.where('inputString').anyOf(canonical).toArray();
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

export interface BoundedRecordSearchOptions {
  /** Maximum rows returned from each indexed prefix lookup. */
  perIndexLimit?: number;
  /** Maximum recent rows inspected for contains-only metadata fields. */
  recentScanLimit?: number;
  isCancelled?: () => boolean;
  /** Optional observation hook used by scale regression tests. */
  onRecentRecordInspected?: () => void;
}

function recordContainsLocalSearch(record: Record, query: string): boolean {
  const searchText = [
    record.label,
    record.inputString,
    record.owner,
    record.walletName,
    record.seedName,
    record.walletSoftware,
    record.notes,
    record.source,
    record.privateKeyStatus,
    ...(record.tags ?? []),
    ...(record.categories ?? []),
    ...Object.values(record.customFields ?? {}),
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  return searchText.includes(query);
}

/**
 * Bounded, entirely-local candidate search for the global command palette.
 *
 * High-value metadata fields use their existing indexes and prefix matching.
 * Notes/custom fields use the device-local derived trigram index when it is
 * ready; cold/stale indexes rebuild in the background while the current search
 * keeps using the fixed newest-first window. Both posting reads and record
 * hydration are capped before materialization.
 *
 * Visibility uses exclusion semantics instead of addressImportance.anyOf:
 * hidden discovery tiers are removed, while legacy rows with no tier remain
 * visible exactly as they are in the app's default Records view.
 */
export async function searchVisibleRecordsBounded(
  rawQuery: string,
  options: BoundedRecordSearchOptions = {},
): Promise<Record[]> {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];

  const perIndexLimit = Math.max(1, options.perIndexLimit ?? 50);
  const recentScanLimit = Math.max(1, options.recentScanLimit ?? 2_000);
  const isCancelled = options.isCancelled ?? (() => false);
  const matches = new Map<number, Record>();

  const addIfVisibleMatch = (record: Record) => {
    if (
      record.id == null ||
      isHiddenDiscoveryTier(record.addressImportance) ||
      !recordContainsLocalSearch(record, query)
    ) return;
    matches.set(record.id, record);
  };

  const plainPrefixFields = [
    'inputStringLower',
    'label',
    'owner',
    'walletName',
    'seedName',
    'walletSoftware',
  ];
  const multiEntryPrefixFields = ['tags', 'categories'];

  const indexedGroups = await Promise.all([
    ...plainPrefixFields.map((field) =>
      db.records.where(field).startsWithIgnoreCase(query).limit(perIndexLimit).toArray()
    ),
    ...multiEntryPrefixFields.map((field) =>
      db.records.where(field).startsWithIgnoreCase(query).limit(perIndexLimit).toArray()
    ),
  ]);
  if (isCancelled()) return [];
  indexedGroups.flat().forEach(addIfVisibleMatch);

  if (query.length >= 3 && await isRecordSearchIndexReady()) {
    const metadataIds = await getRecordIdsFromSearchIndex(query);
    const HYDRATE_BATCH = 250;
    for (let offset = 0; offset < metadataIds.length; offset += HYDRATE_BATCH) {
      const records = await db.records.bulkGet(metadataIds.slice(offset, offset + HYDRATE_BATCH));
      records.forEach((record) => {
        if (record) addIfVisibleMatch(record);
      });
      if (isCancelled()) return [];
    }
  } else if (query.length >= 3) {
    // Cold/stale vaults keep the current bounded recent-window behavior while
    // a single background rebuild makes older metadata available. Search
    // never waits for a full-vault scan on an interactive keystroke.
    warmRecordSearchIndex();
  }

  let inspected = 0;
  await db.records
    .orderBy('updatedAt')
    .reverse()
    .until(() => inspected >= recentScanLimit || isCancelled())
    .each((record) => {
      inspected += 1;
      options.onRecentRecordInspected?.();
      addIfVisibleMatch(record);
    });

  if (isCancelled()) return [];
  return [...matches.values()];
}

/**
 * Freshness fingerprint for the live `records` table — total count, the max id,
 * and the max updatedAt. Compared against the native engine mirror's fingerprint
 * to decide whether the mirror is current enough to serve a read. Any create
 * bumps count + maxId; any delete lowers count; any edit bumps updatedAt — so a
 * mismatch in any field means the mirror is stale. Uses index-only reads (no
 * full table scan): a count plus the first row of two ordered indexes.
 */
export async function getRecordsFingerprint(): Promise<{
  count: number;
  maxId: number;
  maxUpdatedAt: number;
}> {
  const [count, newestById, newestByUpdatedAt] = await Promise.all([
    db.records.count(),
    db.records.orderBy('id').last(),
    db.records.orderBy('updatedAt').last(),
  ]);
  return {
    count,
    maxId: newestById?.id ?? 0,
    maxUpdatedAt: newestByUpdatedAt?.updatedAt ?? 0,
  };
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

// NOTE: the tier params below are deliberately `string`, not AddressImportance.
// The Records page's default view resolves the visible tier list dynamically
// (every distinct stored tier minus the hidden discovery tiers), so vaults
// holding legacy/unrecognized tier strings still browse & search those rows
// (parity with the engine's exclusion SQL). Index keys are plain strings, so
// this is purely a type widening.
export async function getAddressRecordsByImportanceTierLimited(
  tier: string,
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
  tier: string,
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
  tier: string,
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
  const repository = getVaultRepository();
  if (repository.kind === 'protected') {
    return repository.query<Record>('records', 'records.byTypeIdReverseKeyset', {
      type, beforeIdExclusive,
    }, limit);
  }
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
  tiers: string[],
  opts: RecordsKeysetPageOptions
): Promise<Record[]> {
  if (tiers.length === 0) return [];
  const { limit, beforeIdExclusive } = opts;
  const repository = getVaultRepository();
  if (repository.kind === 'protected') {
    return repository.query<Record>('records', 'records.byTypeAndImportanceTiersKeyset', {
      type, tiers, beforeIdExclusive,
    }, limit);
  }
  // The [type+addressImportance] index can't keyset by id (it has no id
  // component), so walk the [type+id] index id-desc from the boundary and keep
  // only rows in the requested tiers, stopping once we have a full page.
  const tierSet = new Set<string>(tiers);
  return db.records
    .where('[type+id]')
    .between(
      [type, Dexie.minKey],
      [type, beforeIdExclusive ?? Dexie.maxKey],
      true,
      beforeIdExclusive == null
    )
    .reverse()
    .and((r) => r.addressImportance != null && tierSet.has(r.addressImportance))
    .limit(limit)
    .toArray();
}

/** Bounded exact lookup used by discovery-origin cleanup. */
export async function getRecordsByInputStringAndType(
  inputString: string,
  type: string,
): Promise<Record[]> {
  const repository = getVaultRepository();
  if (repository.kind === 'protected') {
    return repository.query<Record>('records', 'records.byInputStringAndType', { inputString, type }, 1000);
  }
  return db.records.where('inputString').equals(inputString).and((record) => record.type === type).toArray();
}

/** Bounded child lookup used while walking a discovery tree. */
export async function getRecordsByDiscoveredFromRecordIds(
  parentRecordIds: number[],
  limit = 1000,
): Promise<Record[]> {
  if (parentRecordIds.length === 0) return [];
  const repository = getVaultRepository();
  if (repository.kind === 'protected') {
    return repository.query<Record>('records', 'records.byDiscoveredFromRecordIds', parentRecordIds, limit);
  }
  return db.records.where('discoveredFromRecordId').anyOf(parentRecordIds).limit(limit).toArray();
}

// ---------------------------------------------------------------------------
// Date-added (createdAt) keyset pagination + recency window (Task: Recently
// Added view). Uses the existing `createdAt` index. Within equal createdAt
// values the index iterates by primary key (id) ascending, so plain index
// iteration gives (createdAt asc, id asc) and `.reverse()` gives
// (createdAt desc, id desc) — a deterministic id tiebreaker for free. The
// cursor is therefore a (createdAt, id) pair and ties are resolved with a
// small equals() query before continuing strictly past the boundary.
//
// NOTE: this ordering is ALSO expressible on the native engine fast path
// (getRecordPage's createdAtSort/createdAtCursor/addedSince options, Task
// #1561); the Records page prefers the engine when READY + CURRENT and uses
// this Dexie path as the fallback per the freshness-gate pattern. The two
// paths must stay ordering-equivalent — see the read-equivalence suite.
// ---------------------------------------------------------------------------

export interface CreatedAtCursor {
  createdAt: number;
  /** id of the last row of the previous page (exclusive boundary within ties). */
  id: number;
}

export interface CreatedAtPageOptions {
  limit: number;
  /** 'newest' = createdAt desc (id desc within ties); 'oldest' = asc/asc. */
  direction: 'newest' | 'oldest';
  /** Inclusive lower bound on createdAt (ms). Omit for no recency window. */
  addedSince?: number;
  /** Exclusive keyset boundary from the previous page. Omit for the first page. */
  cursor?: CreatedAtCursor;
  /** Residual predicate (type/tags/search/tier-exclude) applied during iteration. */
  filter?: (r: Record) => boolean;
}

export async function getRecordsPageByCreatedAtKeyset(
  opts: CreatedAtPageOptions
): Promise<Record[]> {
  const { limit, direction, addedSince, cursor, filter } = opts;
  const residual = filter ?? (() => true);
  const rows: Record[] = [];

  if (cursor) {
    // Rows sharing the boundary createdAt: keep only those strictly past the
    // boundary id in iteration order.
    let tie = db.records.where('createdAt').equals(cursor.createdAt);
    if (direction === 'newest') tie = tie.reverse();
    const tieRows = await tie
      .and((r) => {
        const id = r.id ?? 0;
        const pastBoundary = direction === 'newest' ? id < cursor.id : id > cursor.id;
        return pastBoundary && residual(r);
      })
      .limit(limit)
      .toArray();
    rows.push(...tieRows);
  }

  if (rows.length < limit) {
    const remaining = limit - rows.length;
    let coll: Dexie.Collection<Record, number>;
    if (direction === 'newest') {
      coll = db.records
        .where('createdAt')
        .between(
          addedSince ?? Dexie.minKey,
          cursor ? cursor.createdAt : Dexie.maxKey,
          true,
          cursor == null // upper bound exclusive when continuing past a cursor
        )
        .reverse();
    } else {
      // Ascending: the cursor (when present) is always >= addedSince because it
      // came from inside the window, so it supersedes addedSince as lower bound.
      coll = db.records
        .where('createdAt')
        .between(
          cursor ? cursor.createdAt : (addedSince ?? Dexie.minKey),
          Dexie.maxKey,
          cursor == null,
          true
        );
    }
    const more = await coll.and(residual).limit(remaining).toArray();
    rows.push(...more);
  }

  return rows;
}

export interface CreatedAtWindowCount {
  count: number;
  /** True when counting stopped at `cap`; UI should render "cap+" semantics. */
  truncated: boolean;
}

/**
 * Count records with createdAt >= addedSince matching the residual predicate,
 * stopping early at `cap` so a broad window over a huge vault never walks
 * millions of rows just to render a number.
 */
export async function countRecordsByCreatedAtWindow(
  addedSince: number | undefined,
  filter: ((r: Record) => boolean) | undefined,
  cap: number
): Promise<CreatedAtWindowCount> {
  let count = 0;
  const residual = filter ?? (() => true);
  await db.records
    .where('createdAt')
    .between(addedSince ?? Dexie.minKey, Dexie.maxKey, true, true)
    .until(() => count >= cap)
    .each((r) => {
      if (residual(r)) count++;
    });
  return { count: Math.min(count, cap), truncated: count >= cap };
}

export async function countRecordsByTypeAndImportanceTiers(
  type: string,
  tiers: string[]
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
 * Only addresses with a positive cachedUtxoCount are returned, and — unless
 * `includeDiscovered` is set — only user-curated addresses (blockchain-discovered
 * counterparty records are excluded, matching the page's aggregation pass).
 */
export async function getAddressBalanceRowsForGroup(
  groupBy: GroupBy,
  groupKey: string,
  opts?: { includeDiscovered?: boolean },
): Promise<AddressBalanceRow[]> {
  const rows: AddressBalanceRow[] = [];
  const includeDiscovered = opts?.includeDiscovered ?? false;
  const pushIfUtxo = (r: Record): void => {
    if (r.id == null || !r.inputString) return;
    if (!includeDiscovered && !isUserCuratedImportance(r.addressImportance)) return;
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
  if (getVaultRepository().kind === 'protected') return (await getAllRecords()).filter(filter);
  return db.records.filter(filter).toArray();
}

export async function getRecordsAfterId(afterId: number, limit: number): Promise<Record[]> {
  if (getVaultRepository().kind === 'protected') {
    return (await getVaultRepository().list('records', { cursor: afterId, limit: Math.min(limit, 1000) })).rows;
  }
  return db.records.where('id').above(afterId).limit(limit).toArray();
}

export async function getRecordsByOffsetLimit(
  offset: number,
  limit: number
): Promise<Record[]> {
  if (getVaultRepository().kind === 'protected') {
    return (await getAllRecords()).slice(offset, offset + limit);
  }
  return db.records.offset(offset).limit(limit).toArray();
}

// Iterate every record with a Dexie cursor (no full-table array in memory).
// Cursor iteration yields between rows via IndexedDB events, so a full-table
// pass that only inspects rows (e.g. the BIP-329 filter match count) stays
// responsive. For walks that also build large output (the label export
// itself), prefer keyset batching via getRecordsAfterId — see bip329-export.ts.
export async function eachRecord(
  callback: (record: Record) => void
): Promise<void> {
  if (getVaultRepository().kind === 'protected') {
    let cursor = 0;
    for (;;) {
      const rows = await getRecordsAfterId(cursor, 500);
      if (!rows.length) break;
      rows.forEach(callback);
      cursor = rows[rows.length - 1].id ?? cursor;
    }
    return;
  }
  return db.records.each(callback);
}

// Iterate every address record with a Dexie cursor (no full-table array in
// memory).
export async function eachAddressRecord(
  callback: (record: Record) => void
): Promise<void> {
  if (getVaultRepository().kind === 'protected') {
    await eachRecord((record) => { if (record.type === 'address') callback(record); });
    return;
  }
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

  const canonical = canonicalizeRecordIdentifier(inputString);

  const exactMatch = await db.records.where('inputString').equals(canonical).first();
  if (exactMatch) return exactMatch;

  return await db.records.where('inputStringLower').equals(canonical.toLowerCase()).first();
}

/** One saved-address match from getSavedAddressRecordLookup. */
export interface SavedAddressRecordMatch {
  /** Saved record's label, or null when the record has no label. */
  label: string | null;
  /** Record id, so a click target can open the record without a per-row query. */
  recordId: number;
}
/**
 * Batched vault-membership lookup for the Address Checker: given a list of
 * pasted addresses, return a Map from lowercased address to the saved address
 * record's label + id for every address that exists as a `type: 'address'`
 * record. Matching is case-insensitive via the indexed `inputStringLower`
 * column, and the whole list resolves in ONE `anyOf` query so even a
 * 5,000-address run issues a single DB round-trip.
 *
 * Read-only best-effort: any failure degrades to an empty Map (with a
 * console warning) so a DB hiccup can never break a check run.
 */
export async function getSavedAddressRecordLookup(
  addresses: string[]
): Promise<Map<string, SavedAddressRecordMatch>> {
  const keys = [...new Set(
    addresses
      .map(a => a.trim().toLowerCase())
      .filter(a => a.length > 0)
  )];
  const membership = new Map<string, SavedAddressRecordMatch>();
  if (keys.length === 0) return membership;

  try {
    const matches = await db.records
      .where('inputStringLower')
      .anyOf(keys)
      .filter(r => r.type === 'address' && r.id !== undefined)
      .toArray();
    for (const record of matches) {
      const key = record.inputStringLower ?? record.inputString.toLowerCase();
      const label = record.label?.trim() ? record.label : null;
      const existing = membership.get(key);
      // Prefer a labeled record when duplicates of the same address exist.
      if (existing === undefined || (existing.label === null && label !== null)) {
        membership.set(key, { label, recordId: record.id! });
      }
    }
  } catch (err) {
    console.warn('[getSavedAddressRecordLookup] Vault membership lookup failed:', err);
  }
  return membership;
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

export async function getRecordsByCategoryCaseInsensitive(category: string): Promise<Record[]> {
  const normalized = category.trim().toLocaleLowerCase();
  if (!normalized) return [];
  return (await db.records.toArray()).filter((record) =>
    record.categories.some((value) => value.trim().toLocaleLowerCase() === normalized));
}

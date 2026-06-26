/**
 * Offline import path for the Privacy Audit entity list.
 *
 * KYUTXO is strictly offline, so the entity list ships as a bundled in-repo
 * dataset. Public attribution sources (WalletExplorer, GraphSense TagPacks,
 * OFAC SDN designations) change over time, so this module lets a user supply an
 * updated snapshot as a local JSON file. The snapshot is validated (valid
 * addresses, known categories, optional sourceNote) and, on success, replaces
 * the active list at runtime and is persisted to the settings record so it
 * survives a page refresh. The bundled list always remains the fallback and can
 * be restored at any time. Nothing here touches the network.
 */

import { getSettings, updateSettings } from './settings-crud';
import { validateAddress } from '../bitcoin';
import {
  type EntityEntry,
  type EntityCategory,
  ENTITY_CATEGORY_LABELS,
  setActiveEntityList,
  resetActiveEntityList,
  getActiveEntityCount,
  getActiveEntitySource,
  getBundledEntityCount,
  getActiveEntityList,
  mergeWithBundled,
} from '../privacy-entity-list';

/**
 * How an imported snapshot is applied to the active list:
 *  - 'replace': the snapshot becomes the entire active list.
 *  - 'merge': the snapshot is unioned on top of the bundled list, with the
 *    snapshot winning on duplicate addresses. Only the user-supplied entries
 *    are persisted, so bundled updates still flow through.
 */
export type EntityListMode = 'replace' | 'merge';

const VALID_CATEGORIES = new Set<string>(Object.keys(ENTITY_CATEGORY_LABELS));

export interface EntitySnapshotError {
  /** Zero-based index of the offending entry within the parsed array. */
  index: number;
  message: string;
}

export interface EntitySnapshotValidation {
  valid: boolean;
  /** Valid, normalized entries (only meaningful when `valid` is true). */
  entries: EntityEntry[];
  errors: EntitySnapshotError[];
  /** Total number of entries seen in the input. */
  total: number;
}

export interface EntityListStatus {
  source: 'bundled' | 'imported';
  activeCount: number;
  bundledCount: number;
  importedAt?: number;
  sourceLabel?: string;
}

/**
 * Validate a parsed JSON value as an entity-list snapshot. Accepts either a
 * bare array of entries or an object of the form `{ entries: [...] }`. Returns
 * the normalized valid entries plus a list of per-entry errors. The snapshot is
 * only considered importable when there are zero errors and at least one entry.
 */
export function validateEntitySnapshot(raw: unknown): EntitySnapshotValidation {
  const errors: EntitySnapshotError[] = [];

  let rawEntries: unknown;
  if (Array.isArray(raw)) {
    rawEntries = raw;
  } else if (raw && typeof raw === 'object' && Array.isArray((raw as any).entries)) {
    rawEntries = (raw as any).entries;
  } else {
    return {
      valid: false,
      entries: [],
      errors: [{ index: -1, message: 'Expected a JSON array of entries or an object with an "entries" array.' }],
      total: 0,
    };
  }

  const arr = rawEntries as unknown[];
  const entries: EntityEntry[] = [];
  const seen = new Set<string>();

  arr.forEach((item, index) => {
    if (!item || typeof item !== 'object') {
      errors.push({ index, message: 'Entry must be an object.' });
      return;
    }
    const obj = item as Record<string, unknown>;

    const address = typeof obj.address === 'string' ? obj.address.trim() : '';
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    const category = typeof obj.category === 'string' ? obj.category.trim() : '';
    const sourceNote = obj.sourceNote;

    if (!address) {
      errors.push({ index, message: 'Missing "address".' });
    } else if (!validateAddress(address).isValid) {
      errors.push({ index, message: `Invalid Bitcoin address "${address}".` });
    } else if (seen.has(address)) {
      errors.push({ index, message: `Duplicate address "${address}".` });
    }

    if (!name) {
      errors.push({ index, message: 'Missing "name".' });
    }

    if (!category) {
      errors.push({ index, message: 'Missing "category".' });
    } else if (!VALID_CATEGORIES.has(category)) {
      errors.push({
        index,
        message: `Unknown category "${category}". Valid: ${Array.from(VALID_CATEGORIES).join(', ')}.`,
      });
    }

    if (sourceNote !== undefined && typeof sourceNote !== 'string') {
      errors.push({ index, message: '"sourceNote" must be a string when present.' });
    }

    // Only collect when this entry itself is fully valid.
    if (
      address &&
      validateAddress(address).isValid &&
      !seen.has(address) &&
      name &&
      category &&
      VALID_CATEGORIES.has(category) &&
      (sourceNote === undefined || typeof sourceNote === 'string')
    ) {
      seen.add(address);
      entries.push({
        address,
        name,
        category: category as EntityCategory,
        ...(typeof sourceNote === 'string' && sourceNote.trim()
          ? { sourceNote: sourceNote.trim() }
          : {}),
      });
    }
  });

  if (entries.length === 0 && errors.length === 0) {
    errors.push({ index: -1, message: 'Snapshot contains no entries.' });
  }

  return {
    valid: errors.length === 0 && entries.length > 0,
    entries,
    errors,
    total: arr.length,
  };
}

export interface ImportEntitySnapshotResult {
  valid: boolean;
  /** Number of valid entries in the imported snapshot. */
  count: number;
  /** Number of entries in the resulting active list (merged count for merge). */
  activeCount: number;
  total: number;
  mode: EntityListMode;
  errors: EntitySnapshotError[];
}

/** Per-category breakdown comparing an incoming snapshot to the current list. */
export interface EntityCategoryDiff {
  category: EntityCategory;
  label: string;
  /** Entry count for this category in the incoming snapshot. */
  incoming: number;
  /** Entry count for this category in the currently active list. */
  current: number;
}

/**
 * An address present in BOTH lists whose name and/or category differs between
 * the current and incoming snapshot. Surfaced so users can review meaningful
 * re-categorizations / renames, not just pure adds and removes.
 */
export interface EntityChange {
  address: string;
  /** The entry as it exists in the currently active list. */
  current: EntityEntry;
  /** The entry as it appears in the incoming snapshot. */
  incoming: EntityEntry;
  /** True when the display name differs between current and incoming. */
  nameChanged: boolean;
  /** True when the category differs between current and incoming. */
  categoryChanged: boolean;
}

/**
 * A validated, not-yet-applied snapshot together with a comparison against the
 * currently active list. Built after validation succeeds so the UI can show a
 * confirmation before anything is replaced.
 */
export interface EntitySnapshotPreview {
  /** Normalized, validated entries ready to be applied on confirmation. */
  entries: EntityEntry[];
  /** Total entries in the incoming snapshot (== entries.length when valid). */
  incomingCount: number;
  /** Entry count in the currently active list. */
  currentCount: number;
  /** Addresses present in the incoming snapshot but not in the current list. */
  added: number;
  /** Addresses present in the current list but not in the incoming snapshot. */
  removed: number;
  /** Addresses present in both lists with identical name and category. */
  unchanged: number;
  /** Addresses present in both lists whose name and/or category differs. */
  changed: number;
  /** Per-category breakdown (only categories with at least one entry on either side). */
  categories: EntityCategoryDiff[];
  /** The actual entries being added (incoming addresses not in the current list). */
  addedEntries: EntityEntry[];
  /** The actual entries being removed (current addresses not in the incoming snapshot). */
  removedEntries: EntityEntry[];
  /** Entries present in both lists whose name and/or category changed. */
  changedEntries: EntityChange[];
}

/**
 * Build a preview comparing a set of validated incoming entries against the
 * currently active list. Pure computation — applies nothing.
 */
export function buildEntitySnapshotPreview(entries: EntityEntry[]): EntitySnapshotPreview {
  const current = getActiveEntityList();
  const currentByAddr = new Map(current.map((e) => [e.address, e]));
  const incomingAddrs = new Set(entries.map((e) => e.address));

  const addedEntries = entries.filter((e) => !currentByAddr.has(e.address));
  const removedEntries = current.filter((e) => !incomingAddrs.has(e.address));
  const added = addedEntries.length;
  const removed = removedEntries.length;

  // Addresses present in both lists: split into truly unchanged vs. changed
  // (same address but a different name and/or category).
  const changedEntries: EntityChange[] = [];
  let unchanged = 0;
  for (const inc of entries) {
    const cur = currentByAddr.get(inc.address);
    if (!cur) continue;
    const nameChanged = cur.name !== inc.name;
    const categoryChanged = cur.category !== inc.category;
    if (nameChanged || categoryChanged) {
      changedEntries.push({
        address: inc.address,
        current: cur,
        incoming: inc,
        nameChanged,
        categoryChanged,
      });
    } else {
      unchanged += 1;
    }
  }
  const changed = changedEntries.length;

  const incomingByCat = new Map<EntityCategory, number>();
  for (const e of entries) {
    incomingByCat.set(e.category, (incomingByCat.get(e.category) ?? 0) + 1);
  }
  const currentByCat = new Map<EntityCategory, number>();
  for (const e of current) {
    currentByCat.set(e.category, (currentByCat.get(e.category) ?? 0) + 1);
  }

  const categories: EntityCategoryDiff[] = (Object.keys(ENTITY_CATEGORY_LABELS) as EntityCategory[])
    .map((category) => ({
      category,
      label: ENTITY_CATEGORY_LABELS[category],
      incoming: incomingByCat.get(category) ?? 0,
      current: currentByCat.get(category) ?? 0,
    }))
    .filter((c) => c.incoming > 0 || c.current > 0);

  return {
    entries,
    incomingCount: entries.length,
    currentCount: current.length,
    added,
    removed,
    unchanged,
    changed,
    categories,
    addedEntries,
    removedEntries,
    changedEntries,
  };
}

export interface PrepareEntitySnapshotResult {
  valid: boolean;
  total: number;
  errors: EntitySnapshotError[];
  /** Only present when `valid` is true. */
  preview?: EntitySnapshotPreview;
}

/**
 * Validate a parsed snapshot and, when valid, build a preview comparing it to
 * the active list. Nothing is applied — call `applyEntitySnapshot` after the
 * user confirms. Invalid snapshots are reported back without any change.
 */
export function prepareEntitySnapshot(raw: unknown): PrepareEntitySnapshotResult {
  const result = validateEntitySnapshot(raw);
  if (!result.valid) {
    return { valid: false, total: result.total, errors: result.errors };
  }
  return {
    valid: true,
    total: result.total,
    errors: [],
    preview: buildEntitySnapshotPreview(result.entries),
  };
}

/**
 * Apply a set of validated entries to the active entity list and persist them
 * to the settings record. Use after the user confirms a previewed snapshot.
 */
export async function applyEntitySnapshot(
  entries: EntityEntry[],
  sourceLabel?: string,
  mode: EntityListMode = 'replace',
): Promise<number> {
  const applied = mode === 'merge' ? mergeWithBundled(entries) : entries;
  setActiveEntityList(applied);
  await updateSettings('default', {
    entityListSnapshot: {
      importedAt: Date.now(),
      sourceLabel,
      mode,
      entries,
    },
  });
  return applied.length;
}

/**
 * Validate a parsed snapshot and, when valid, apply it to the active entity
 * list and persist it to the settings record. Invalid snapshots are reported
 * back without applying any change.
 *
 * `mode` controls how the snapshot is applied:
 *  - 'replace' (default): the snapshot becomes the entire active list.
 *  - 'merge': the snapshot is unioned on top of the bundled list (snapshot wins
 *    on duplicate addresses). Only the user-supplied entries are persisted so
 *    future bundled updates still flow through.
 */
export async function importEntitySnapshot(
  raw: unknown,
  sourceLabel?: string,
  mode: EntityListMode = 'replace',
): Promise<ImportEntitySnapshotResult> {
  const result = validateEntitySnapshot(raw);
  if (!result.valid) {
    return {
      valid: false,
      count: 0,
      activeCount: 0,
      total: result.total,
      mode,
      errors: result.errors,
    };
  }

  const activeCount = await applyEntitySnapshot(result.entries, sourceLabel, mode);

  return {
    valid: true,
    count: result.entries.length,
    activeCount,
    total: result.total,
    mode,
    errors: [],
  };
}

/**
 * Restore the bundled list as the active list and remove any persisted
 * snapshot from the settings record.
 */
export async function resetEntitySnapshot(): Promise<void> {
  resetActiveEntityList();
  // Setting the field to undefined deletes it from the stored record (Dexie).
  await updateSettings('default', { entityListSnapshot: undefined });
}

/**
 * Read any persisted snapshot from storage and apply it to the active list.
 * Called once at app startup. Falls back silently to the bundled list on any
 * error so startup is never disrupted.
 */
export async function loadEntitySnapshotFromStorage(): Promise<EntityListStatus> {
  try {
    const settings = await getSettings('default');
    const snap = settings?.entityListSnapshot;
    if (snap && Array.isArray(snap.entries) && snap.entries.length > 0) {
      const result = validateEntitySnapshot(snap.entries);
      if (result.valid) {
        // Re-apply with the same mode the snapshot was imported under so a
        // merge stays merged across refreshes (default to 'replace' for
        // snapshots persisted before merge support existed).
        const applied =
          snap.mode === 'merge' ? mergeWithBundled(result.entries) : result.entries;
        setActiveEntityList(applied);
      } else {
        // Persisted snapshot is somehow corrupt — fall back to bundled.
        resetActiveEntityList();
      }
    }
  } catch {
    resetActiveEntityList();
  }
  return getEntityListStatus();
}

/** Current status of the active entity list (bundled vs imported). */
export function getEntityListStatus(): EntityListStatus {
  return {
    source: getActiveEntitySource(),
    activeCount: getActiveEntityCount(),
    bundledCount: getBundledEntityCount(),
  };
}

/** Serialize the currently active list to a pretty-printed JSON string. */
export function serializeActiveEntityList(): string {
  return JSON.stringify(
    {
      generatedBy: 'KYUTXO',
      generatedAt: new Date().toISOString(),
      entries: getActiveEntityList(),
    },
    null,
    2,
  );
}

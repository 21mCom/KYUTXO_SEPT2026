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
} from '../privacy-entity-list';

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
  count: number;
  total: number;
  errors: EntitySnapshotError[];
}

/**
 * Validate a parsed snapshot and, when valid, apply it to the active entity
 * list and persist it to the settings record. Invalid snapshots are reported
 * back without applying any change.
 */
export async function importEntitySnapshot(
  raw: unknown,
  sourceLabel?: string,
): Promise<ImportEntitySnapshotResult> {
  const result = validateEntitySnapshot(raw);
  if (!result.valid) {
    return { valid: false, count: 0, total: result.total, errors: result.errors };
  }

  setActiveEntityList(result.entries);
  await updateSettings('default', {
    entityListSnapshot: {
      importedAt: Date.now(),
      sourceLabel,
      entries: result.entries,
    },
  });

  return { valid: true, count: result.entries.length, total: result.total, errors: [] };
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
        setActiveEntityList(result.entries);
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

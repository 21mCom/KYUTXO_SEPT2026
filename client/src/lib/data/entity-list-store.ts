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
  getBundledEntityList,
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

/**
 * A stable discriminator describing *what kind* of problem an error reports,
 * independent of the human-readable (and often value-interpolated) `message`.
 * The UI uses this to group many similar failures (e.g. dozens of typo'd
 * categories) under a single expandable heading rather than a flat list.
 */
export type EntitySnapshotErrorKind =
  | 'invalid-structure'
  | 'entry-not-object'
  | 'missing-address'
  | 'invalid-address'
  | 'duplicate-address'
  | 'missing-name'
  | 'missing-category'
  | 'unknown-category'
  | 'invalid-source-note'
  | 'no-entries';

/** Human-readable group headings for each {@link EntitySnapshotErrorKind}. */
export const ENTITY_ERROR_KIND_LABELS: Record<EntitySnapshotErrorKind, string> = {
  'invalid-structure': 'Invalid file structure',
  'entry-not-object': 'Entry is not an object',
  'missing-address': 'Missing address',
  'invalid-address': 'Invalid Bitcoin address',
  'duplicate-address': 'Duplicate address',
  'missing-name': 'Missing name',
  'missing-category': 'Missing category',
  'unknown-category': 'Unknown category',
  'invalid-source-note': 'Invalid source note',
  'no-entries': 'No entries',
};

export interface EntitySnapshotError {
  /** Zero-based index of the offending entry within the parsed array. */
  index: number;
  /** Stable problem type, used to group similar errors in the UI. */
  kind: EntitySnapshotErrorKind;
  message: string;
}

/**
 * A non-fatal advisory about an otherwise-valid entry. Warnings never block an
 * import; they surface likely mistakes (e.g. a sourceNote URL that cites a
 * different address than the entry itself) so the user can review them first.
 */
export interface EntitySnapshotWarning {
  /** Zero-based index of the entry within the parsed array. */
  index: number;
  message: string;
}

export interface EntitySnapshotValidation {
  valid: boolean;
  /** Valid, normalized entries (only meaningful when `valid` is true). */
  entries: EntityEntry[];
  errors: EntitySnapshotError[];
  /** Non-fatal advisories about valid entries (e.g. mismatched citations). */
  warnings: EntitySnapshotWarning[];
  /** Total number of entries seen in the input. */
  total: number;
}

/**
 * Matches WalletExplorer-style address citations embedded in a sourceNote URL,
 * e.g. https://www.walletexplorer.com/address/<addr>. The captured group is the
 * cited Bitcoin address. The character class is the union of base58 (legacy)
 * and bech32/bech32m (`bc1...` segwit/taproot) alphabets — i.e. any
 * alphanumeric run with the `i` flag — so a modern bech32 citation is captured
 * in full rather than truncated at its first `0` (which base58 excludes).
 * Mirrors the build-time guard in `privacy-entity-list.test.ts` so user imports
 * are held to the same standard.
 */
const CITATION_RE = /address\/([0-9a-z]+)/gi;

/**
 * Scan a sourceNote for embedded `address/<addr>` citations and return any
 * cited address that differs from the entry's own `address`. An empty array
 * means every citation (if any) matched, or there were no citations at all.
 */
export function findMismatchedCitations(sourceNote: string, address: string): string[] {
  const mismatched: string[] = [];
  CITATION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CITATION_RE.exec(sourceNote)) !== null) {
    if (match[1] !== address) mismatched.push(match[1]);
  }
  return mismatched;
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
      errors: [
        {
          index: -1,
          kind: 'invalid-structure',
          message: 'Expected a JSON array of entries or an object with an "entries" array.',
        },
      ],
      warnings: [],
      total: 0,
    };
  }

  const arr = rawEntries as unknown[];
  const entries: EntityEntry[] = [];
  const warnings: EntitySnapshotWarning[] = [];
  const seen = new Set<string>();

  arr.forEach((item, index) => {
    if (!item || typeof item !== 'object') {
      errors.push({ index, kind: 'entry-not-object', message: 'Entry must be an object.' });
      return;
    }
    const obj = item as Record<string, unknown>;

    const address = typeof obj.address === 'string' ? obj.address.trim() : '';
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    const category = typeof obj.category === 'string' ? obj.category.trim() : '';
    const sourceNote = obj.sourceNote;

    if (!address) {
      errors.push({ index, kind: 'missing-address', message: 'Missing "address".' });
    } else if (!validateAddress(address).isValid) {
      errors.push({ index, kind: 'invalid-address', message: `Invalid Bitcoin address "${address}".` });
    } else if (seen.has(address)) {
      errors.push({ index, kind: 'duplicate-address', message: `Duplicate address "${address}".` });
    }

    if (!name) {
      errors.push({ index, kind: 'missing-name', message: 'Missing "name".' });
    }

    if (!category) {
      errors.push({ index, kind: 'missing-category', message: 'Missing "category".' });
    } else if (!VALID_CATEGORIES.has(category)) {
      errors.push({
        index,
        kind: 'unknown-category',
        message: `Unknown category "${category}". Valid: ${Array.from(VALID_CATEGORIES).join(', ')}.`,
      });
    }

    if (sourceNote !== undefined && typeof sourceNote !== 'string') {
      errors.push({ index, kind: 'invalid-source-note', message: '"sourceNote" must be a string when present.' });
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
      const trimmedNote =
        typeof sourceNote === 'string' && sourceNote.trim() ? sourceNote.trim() : undefined;
      entries.push({
        address,
        name,
        category: category as EntityCategory,
        ...(trimmedNote ? { sourceNote: trimmedNote } : {}),
      });

      // Non-fatal: a sourceNote whose embedded citation points at a different
      // address than the entry itself is almost always a copy/paste mistake.
      if (trimmedNote) {
        const cited = findMismatchedCitations(trimmedNote, address);
        if (cited.length > 0) {
          const unique = Array.from(new Set(cited));
          warnings.push({
            index,
            message: `Source note for "${address}" cites a different address (${unique.join(', ')}).`,
          });
        }
      }
    }
  });

  if (entries.length === 0 && errors.length === 0) {
    errors.push({ index: -1, kind: 'no-entries', message: 'Snapshot contains no entries.' });
  }

  return {
    valid: errors.length === 0 && entries.length > 0,
    entries,
    errors,
    warnings,
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
  /** Non-fatal advisories about the imported entries (e.g. mismatched citations). */
  warnings: EntitySnapshotWarning[];
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
 * An address present in BOTH lists whose name, category, and/or source note
 * differs between the current and incoming snapshot. Surfaced so users can
 * review meaningful re-categorizations / renames / re-attributions, not just
 * pure adds and removes.
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
  /** True when the source note differs (including added/removed) between current and incoming. */
  sourceNoteChanged: boolean;
}

/**
 * A bundled entry that an incoming merge snapshot will overwrite, paired with
 * the incoming entry that replaces it. Only populated for merge previews.
 */
export interface EntityOverride {
  /** The existing bundled entry that will be overwritten. */
  previous: EntityEntry;
  /** The incoming entry that wins on this duplicate address. */
  incoming: EntityEntry;
  /**
   * True when the incoming entry actually differs from the bundled one
   * (name, category, or sourceNote). Identical re-imports are no-ops.
   */
  changed: boolean;
}

/**
 * A validated, not-yet-applied snapshot together with a comparison against the
 * baseline list. Built after validation succeeds so the UI can show a
 * confirmation before anything changes.
 *
 * The baseline depends on `mode`:
 *  - 'replace': compared against the currently active list (added/removed/unchanged).
 *  - 'merge': compared against the bundled list, since a merge always unions on
 *    top of the bundled defaults. Merge never removes; instead some incoming
 *    addresses *override* existing bundled entries (see `overrides`).
 */
export interface EntitySnapshotPreview {
  /** Which import mode this preview was computed for. */
  mode: EntityListMode;
  /** Normalized, validated entries ready to be applied on confirmation. */
  entries: EntityEntry[];
  /** Total entries in the incoming snapshot (== entries.length when valid). */
  incomingCount: number;
  /** Entry count in the baseline list (active for replace, bundled for merge). */
  currentCount: number;
  /** Entry count in the active list after applying (== incomingCount for replace). */
  resultingCount: number;
  /** Addresses present in the incoming snapshot but not in the baseline list. */
  added: number;
  /** Addresses present in the baseline but not in the incoming snapshot (replace only; 0 for merge). */
  removed: number;
  /** Addresses present in both lists with identical name and category. */
  unchanged: number;
  /** Addresses present in both lists whose name and/or category differs (replace only). */
  changed: number;
  /** Incoming addresses that overwrite an existing bundled entry (merge only; 0 for replace). */
  overridden: number;
  /** Per-category breakdown (only categories with at least one entry on either side). */
  categories: EntityCategoryDiff[];
  /** The actual entries being added (incoming addresses not in the baseline list). */
  addedEntries: EntityEntry[];
  /** The actual entries being removed (baseline addresses not in the incoming snapshot; replace only). */
  removedEntries: EntityEntry[];
  /** Entries present in both lists whose name and/or category changed (replace only). */
  changedEntries: EntityChange[];
  /** The bundled entries being overwritten, paired with their replacements (merge only). */
  overrides: EntityOverride[];
}

/**
 * Build a preview comparing a set of validated incoming entries against the
 * relevant baseline. Pure computation — applies nothing.
 *
 * For 'merge' the baseline is the bundled list (a merge always unions onto the
 * bundled defaults), so the preview reports brand-new entries vs. entries that
 * will overwrite existing bundled ones. For 'replace' the baseline is the
 * currently active list, reported as added/removed/unchanged.
 */
export function buildEntitySnapshotPreview(
  entries: EntityEntry[],
  mode: EntityListMode = 'replace',
): EntitySnapshotPreview {
  const current = mode === 'merge' ? getBundledEntityList() : getActiveEntityList();
  const currentByAddr = new Map(current.map((e) => [e.address, e]));
  const incomingAddrs = new Set(entries.map((e) => e.address));

  const addedEntries = entries.filter((e) => !currentByAddr.has(e.address));
  const added = addedEntries.length;

  // Incoming addresses that already exist in the baseline.
  const overlapping = entries.filter((e) => currentByAddr.has(e.address));

  let removed = 0;
  let removedEntries: EntityEntry[] = [];
  let overridden = 0;
  let overrides: EntityOverride[] = [];
  let changed = 0;
  const changedEntries: EntityChange[] = [];
  let unchanged = 0;

  if (mode === 'merge') {
    // A merge never removes bundled entries; overlapping addresses overwrite.
    overrides = overlapping.map((incoming) => {
      const previous = currentByAddr.get(incoming.address)!;
      return { previous, incoming, changed: !entriesEqual(previous, incoming) };
    });
    overridden = overrides.length;
    unchanged = overlapping.length;
  } else {
    removedEntries = current.filter((e) => !incomingAddrs.has(e.address));
    removed = removedEntries.length;

    // Addresses present in both lists: split into truly unchanged vs. changed
    // (same address but a different name, category, and/or source note).
    for (const inc of overlapping) {
      const cur = currentByAddr.get(inc.address)!;
      const nameChanged = cur.name !== inc.name;
      const categoryChanged = cur.category !== inc.category;
      const sourceNoteChanged = (cur.sourceNote ?? '') !== (inc.sourceNote ?? '');
      if (nameChanged || categoryChanged || sourceNoteChanged) {
        changedEntries.push({
          address: inc.address,
          current: cur,
          incoming: inc,
          nameChanged,
          categoryChanged,
          sourceNoteChanged,
        });
      } else {
        unchanged += 1;
      }
    }
    changed = changedEntries.length;
  }

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

  const resultingCount = mode === 'merge' ? current.length + added : entries.length;

  return {
    mode,
    entries,
    incomingCount: entries.length,
    currentCount: current.length,
    resultingCount,
    added,
    removed,
    unchanged,
    changed,
    overridden,
    categories,
    addedEntries,
    removedEntries,
    changedEntries,
    overrides,
  };
}

/** Shallow equality of the meaningful fields of two entity entries. */
function entriesEqual(a: EntityEntry, b: EntityEntry): boolean {
  return (
    a.address === b.address &&
    a.name === b.name &&
    a.category === b.category &&
    (a.sourceNote ?? '') === (b.sourceNote ?? '')
  );
}

export interface PrepareEntitySnapshotResult {
  valid: boolean;
  total: number;
  errors: EntitySnapshotError[];
  /** Non-fatal advisories about the snapshot (e.g. mismatched citations). */
  warnings: EntitySnapshotWarning[];
  /** Only present when `valid` is true. */
  preview?: EntitySnapshotPreview;
}

/**
 * Validate a parsed snapshot and, when valid, build a preview comparing it to
 * the baseline for `mode`. Nothing is applied — call `applyEntitySnapshot`
 * after the user confirms. Invalid snapshots are reported back without change.
 */
export function prepareEntitySnapshot(
  raw: unknown,
  mode: EntityListMode = 'replace',
): PrepareEntitySnapshotResult {
  const result = validateEntitySnapshot(raw);
  if (!result.valid) {
    return { valid: false, total: result.total, errors: result.errors, warnings: result.warnings };
  }
  return {
    valid: true,
    total: result.total,
    errors: [],
    warnings: result.warnings,
    preview: buildEntitySnapshotPreview(result.entries, mode),
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
      warnings: result.warnings,
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
    warnings: result.warnings,
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

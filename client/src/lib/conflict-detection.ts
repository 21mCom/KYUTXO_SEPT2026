import type {
  Record,
  RecordOrigin,
  ConflictResolutionMap,
} from './database';

export type FieldType = 'union' | 'singular';

export interface FieldConfig {
  key: keyof RecordOrigin;
  label: string;
  type: FieldType;
  recordKey?: keyof Record;
}

// Structural view of the record fields conflict detection needs. Full DB
// `Record`s, the detail panel's stringified-id record shape, and
// MetadataSourcesPanel's `RecordFields` are all assignable without casts.
export interface ConflictRecordFields {
  label?: string;
  owner?: string;
  seedName?: string;
  walletName?: string;
  walletSoftware?: string;
  privateKeyStatus?: string;
  conflictResolutions?: ConflictResolutionMap;
}

export const FIELD_CLASSIFICATIONS: FieldConfig[] = [
  { key: 'label', label: 'Label', type: 'singular', recordKey: 'label' },
  { key: 'owner', label: 'Owner', type: 'singular', recordKey: 'owner' },
  { key: 'seedName', label: 'Seed Name', type: 'singular', recordKey: 'seedName' },
  { key: 'walletName', label: 'Wallet Name', type: 'singular', recordKey: 'walletName' },
  { key: 'walletSoftware', label: 'Wallet Software', type: 'singular', recordKey: 'walletSoftware' },
  { key: 'privateKeyStatus', label: 'Private Key Status', type: 'singular', recordKey: 'privateKeyStatus' },
  { key: 'tags', label: 'Tags', type: 'union', recordKey: 'tags' },
  { key: 'categories', label: 'Categories', type: 'union', recordKey: 'categories' },
];

export const SINGULAR_FIELDS = FIELD_CLASSIFICATIONS.filter(f => f.type === 'singular');
export const UNION_FIELDS = FIELD_CLASSIFICATIONS.filter(f => f.type === 'union');

export interface FieldConflict {
  field: FieldConfig;
  activeValue: string | undefined;
  originValues: { originId: number; originType: string; value: string; createdAt: number }[];
}

export interface RecordConflictInfo {
  recordId: number;
  inputString: string;
  label?: string;
  conflicts: FieldConflict[];
  hasConflicts: boolean;
}

// A singular field is in conflict when two or more origins carry distinct
// non-empty values for it AND the disagreement has not been explicitly
// resolved. Resolution state lives on the record (`conflictResolutions`) and
// is written by the Conflict Resolution dialog; a newer origin that
// introduces a different value after the resolution re-opens the conflict.
//
// NOTE: this intentionally does NOT auto-hide a conflict just because the
// record's active value matches one of the origin values — every merge keeps
// either the existing or the incoming value active, so that heuristic hid
// virtually all real merge disagreements.
export function detectSingularFieldConflicts(
  record: ConflictRecordFields,
  origins: RecordOrigin[]
): FieldConflict[] {
  const conflicts: FieldConflict[] = [];

  for (const field of SINGULAR_FIELDS) {
    const activeValue = record[field.recordKey as keyof ConflictRecordFields] as
      | string
      | undefined;

    const originValues: FieldConflict['originValues'] = [];
    const seenValues = new Set<string>();

    for (const origin of origins) {
      const originValue = origin[field.key] as string | undefined;
      if (originValue && originValue.trim() !== '') {
        const normalizedValue = originValue.trim();
        if (!seenValues.has(normalizedValue)) {
          seenValues.add(normalizedValue);
          originValues.push({
            originId: origin.id!,
            originType: origin.originType,
            value: normalizedValue,
            createdAt: origin.createdAt,
          });
        }
      }
    }

    if (originValues.length > 1 && !isFieldResolved(record, field, origins)) {
      conflicts.push({
        field,
        activeValue: activeValue?.trim(),
        originValues: originValues.sort((a, b) => b.createdAt - a.createdAt),
      });
    }
  }

  return conflicts;
}

// A field counts as resolved when a resolution was recorded for it and no
// origin added AFTER the resolution carries a different value. Origins that
// re-assert the resolved value (or carry no value) do not re-open it.
function isFieldResolved(
  record: ConflictRecordFields,
  field: FieldConfig,
  origins: RecordOrigin[]
): boolean {
  const resolution = record.conflictResolutions?.[field.key];
  if (!resolution) return false;

  const resolvedValue = (resolution.value || '').trim();
  for (const origin of origins) {
    if (origin.createdAt <= resolution.resolvedAt) continue;
    const originValue = (origin[field.key] as string | undefined)?.trim();
    if (originValue && originValue !== resolvedValue) {
      return false;
    }
  }
  return true;
}

// Merge a new per-field resolution into an existing map (immutable). Keeps
// the trim normalization in one place so detection and writers agree.
export function withFieldResolution(
  existing: ConflictResolutionMap | undefined,
  fieldKey: string,
  value: string,
  resolvedAt: number = Date.now()
): ConflictResolutionMap {
  return {
    ...(existing || {}),
    [fieldKey]: { value: (value || '').trim(), resolvedAt },
  };
}

export function getConflictingOriginsForField(
  origins: RecordOrigin[],
  fieldKey: keyof RecordOrigin,
  activeValue: string | undefined
): { originId: number; originType: string; value: string; createdAt: number; isDifferent: boolean }[] {
  const result: { originId: number; originType: string; value: string; createdAt: number; isDifferent: boolean }[] = [];

  for (const origin of origins) {
    const originValue = origin[fieldKey] as string | undefined;
    if (originValue && originValue.trim() !== '') {
      const normalizedValue = originValue.trim();
      const normalizedActive = activeValue?.trim() || '';
      result.push({
        originId: origin.id!,
        originType: origin.originType,
        value: normalizedValue,
        createdAt: origin.createdAt,
        isDifferent: normalizedValue !== normalizedActive,
      });
    }
  }

  return result.sort((a, b) => b.createdAt - a.createdAt);
}

export function hasAnyConflicts(
  record: ConflictRecordFields,
  origins: RecordOrigin[]
): boolean {
  return detectSingularFieldConflicts(record, origins).length > 0;
}

export function getConflictCount(
  record: ConflictRecordFields,
  origins: RecordOrigin[]
): number {
  return detectSingularFieldConflicts(record, origins).length;
}

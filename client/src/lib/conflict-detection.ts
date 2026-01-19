import type { Record, RecordOrigin } from './database';

export type FieldType = 'union' | 'singular';

export interface FieldConfig {
  key: keyof RecordOrigin;
  label: string;
  type: FieldType;
  recordKey?: keyof Record;
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

export function detectSingularFieldConflicts(
  record: Record,
  origins: RecordOrigin[]
): FieldConflict[] {
  const conflicts: FieldConflict[] = [];

  for (const field of SINGULAR_FIELDS) {
    const activeValue = record[field.recordKey as keyof Record] as string | undefined;
    
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

    // A conflict exists only if there are multiple distinct origin values
    // AND the active value doesn't match any of them (meaning user hasn't resolved it yet)
    if (originValues.length > 1) {
      const normalizedActive = activeValue?.trim() || '';
      const isResolved = normalizedActive !== '' && 
        originValues.some(ov => ov.value === normalizedActive);
      
      // Only add as conflict if not resolved
      if (!isResolved) {
        conflicts.push({
          field,
          activeValue: activeValue?.trim(),
          originValues: originValues.sort((a, b) => b.createdAt - a.createdAt),
        });
      }
    }
  }

  return conflicts;
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

export function hasAnyConflicts(record: Record, origins: RecordOrigin[]): boolean {
  return detectSingularFieldConflicts(record, origins).length > 0;
}

export function getConflictCount(record: Record, origins: RecordOrigin[]): number {
  return detectSingularFieldConflicts(record, origins).length;
}

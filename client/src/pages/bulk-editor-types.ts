import type { Record } from "@/lib/database";
import {
  FLOW_TYPE_OPTIONS,
  COUNTERPARTY_TYPE_OPTIONS,
  ACQUISITION_METHOD_OPTIONS,
  DISPOSITION_TYPE_OPTIONS,
  getImportanceTierOptions,
} from "@/lib/database";

type FieldType = 'text' | 'select' | 'array' | 'enum';

interface FieldDef {
  key: keyof Record;
  label: string;
  type: FieldType;
  options?: { value: string; label: string }[];
  vocabularyKey?: 'owners' | 'walletNames' | 'seedNames' | 'walletSoftware' | 'tags' | 'categories';
}

const ADDRESS_IMPORTANCE_OPTIONS = getImportanceTierOptions();

const CHAIN_TYPE_OPTIONS = [
  { value: 'receive', label: 'Receive (External)' },
  { value: 'change', label: 'Change (Internal)' },
];

const TYPE_OPTIONS = [
  { value: 'address', label: 'Address' },
  { value: 'transaction', label: 'Transaction' },
  { value: 'other', label: 'Other' },
];

const SOURCE_OPTIONS = [
  { value: 'manual', label: 'Manual' },
  { value: 'xpub-import', label: 'XPUB Import' },
  { value: 'wallet-import', label: 'Wallet Import' },
  { value: 'blockchain-sync', label: 'Blockchain Sync' },
];

const FIELD_DEFS: FieldDef[] = [
  { key: 'type', label: 'Type', type: 'enum', options: TYPE_OPTIONS },
  { key: 'owner', label: 'Owner', type: 'select', vocabularyKey: 'owners' },
  { key: 'walletName', label: 'Wallet Name', type: 'select', vocabularyKey: 'walletNames' },
  { key: 'seedName', label: 'Seed Name', type: 'select', vocabularyKey: 'seedNames' },
  { key: 'walletSoftware', label: 'Wallet Software', type: 'select', vocabularyKey: 'walletSoftware' },
  { key: 'privateKeyStatus', label: 'Private Key Status', type: 'text' },
  { key: 'tags', label: 'Tags', type: 'array', vocabularyKey: 'tags' },
  { key: 'categories', label: 'Categories', type: 'array', vocabularyKey: 'categories' },
  { key: 'label', label: 'Label', type: 'text' },
  { key: 'notes', label: 'Notes', type: 'text' },
  { key: 'source', label: 'Source', type: 'enum', options: SOURCE_OPTIONS },
  { key: 'chainType', label: 'Chain Type', type: 'enum', options: CHAIN_TYPE_OPTIONS },
  { key: 'addressImportance', label: 'Address Importance', type: 'enum', options: ADDRESS_IMPORTANCE_OPTIONS },
  { key: 'flowType', label: 'Flow Type', type: 'enum', options: FLOW_TYPE_OPTIONS },
  { key: 'acquisitionMethod', label: 'Acquisition Method', type: 'enum', options: ACQUISITION_METHOD_OPTIONS },
  { key: 'dispositionType', label: 'Disposition Type', type: 'enum', options: DISPOSITION_TYPE_OPTIONS },
  { key: 'counterpartyType', label: 'Counterparty Type', type: 'enum', options: COUNTERPARTY_TYPE_OPTIONS },
  { key: 'counterpartyName', label: 'Counterparty Name', type: 'text' },
];

type Operator = 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'starts_with' | 'is_empty' | 'is_not_empty';

const OPERATORS: { value: Operator; label: string; needsValue: boolean }[] = [
  { value: 'equals', label: 'equals', needsValue: true },
  { value: 'not_equals', label: 'does not equal', needsValue: true },
  { value: 'contains', label: 'contains', needsValue: true },
  { value: 'not_contains', label: 'does not contain', needsValue: true },
  { value: 'starts_with', label: 'starts with', needsValue: true },
  { value: 'is_empty', label: 'is empty', needsValue: false },
  { value: 'is_not_empty', label: 'is not empty', needsValue: false },
];

type ActionType = 'set' | 'add' | 'remove' | 'clear' | 'append' | 'prepend' | 'attach_file';

const ACTION_TYPES: { value: ActionType; label: string; description: string }[] = [
  { value: 'set', label: 'Set', description: 'Replace the value' },
  { value: 'append', label: 'Append', description: 'Append to end of existing text' },
  { value: 'prepend', label: 'Prepend', description: 'Prepend to start of existing text' },
  { value: 'add', label: 'Add', description: 'Add to array (tags/categories)' },
  { value: 'remove', label: 'Remove', description: 'Remove from array (tags/categories)' },
  { value: 'clear', label: 'Clear', description: 'Set to empty' },
  { value: 'attach_file', label: 'Attach File', description: 'Attach file(s) to matching records' },
];

interface FilterCondition {
  id: string;
  field: keyof Record;
  operator: Operator;
  value: string;
  values: string[];
}

interface ActionDef {
  id: string;
  type: ActionType;
  field: keyof Record;
  value: string;
  files?: File[];
}

interface UndoRecordSnapshot {
  id: number;
  /** Field values as they were BEFORE the bulk apply (what Undo restores). */
  before: Partial<Record>;
  /** Field values the bulk apply wrote (what we expect to still find at Undo time). */
  after: Partial<Record>;
}

interface UndoSnapshot {
  timestamp: number;
  recordSnapshots: UndoRecordSnapshot[];
  description: string;
  recordCount: number;
  actionsApplied: { type: ActionType; field: string; value?: string }[];
}

/**
 * Value equivalence for staleness detection. Text fields treat
 * undefined/null/'' as the same "empty"; array fields compare element-wise.
 */
function undoValuesEquivalent(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    const aa = Array.isArray(a) ? a : (a === undefined || a === null || a === '' ? [] : [a]);
    const bb = Array.isArray(b) ? b : (b === undefined || b === null || b === '' ? [] : [b]);
    return aa.length === bb.length && aa.every((v, i) => v === bb[i]);
  }
  const na = a === undefined || a === null ? '' : a;
  const nb = b === undefined || b === null ? '' : b;
  return na === nb;
}

interface UndoPartitionResult {
  /** Snapshots whose records still hold exactly what the bulk apply wrote — safe to restore. */
  restorable: UndoRecordSnapshot[];
  /** Records whose relevant fields were edited after the apply — restoring would clobber the newer edit. */
  stale: { id: number; changedFields: string[] }[];
  /** Records that no longer exist (deleted since the apply). */
  missing: number[];
}

/**
 * Splits an undo snapshot list into records that are still safe to restore
 * and records whose relevant fields changed since the bulk apply (or which
 * were deleted). Undo must ONLY write back the restorable set, otherwise it
 * silently discards edits made between Apply and Undo.
 */
function partitionUndoSnapshots(
  snapshots: UndoRecordSnapshot[],
  currentById: Map<number, Record>,
): UndoPartitionResult {
  const restorable: UndoRecordSnapshot[] = [];
  const stale: { id: number; changedFields: string[] }[] = [];
  const missing: number[] = [];

  for (const snap of snapshots) {
    const current = currentById.get(snap.id);
    if (!current) {
      missing.push(snap.id);
      continue;
    }
    const changedFields = (Object.keys(snap.after) as (keyof Record)[])
      .filter((field) => !undoValuesEquivalent(current[field], snap.after[field]))
      .map((field) => field as string);
    if (changedFields.length > 0) {
      stale.push({ id: snap.id, changedFields });
    } else {
      restorable.push(snap);
    }
  }

  return { restorable, stale, missing };
}

interface UndoSkipPreview {
  /** How many snapshot records are still safe to restore right now. */
  restorableCount: number;
  /** Records that would be skipped because their fields changed since the apply. */
  stale: { id: number; identifier: string; changedFields: string[] }[];
  /** Records that would be skipped because they were deleted since the apply. */
  missing: { id: number }[];
}

/**
 * Builds the pre-confirm skip preview shown in the Undo popover. Runs the
 * same partitionUndoSnapshots check the actual Undo uses, then decorates
 * stale entries with a human-readable identifier from the current record.
 * This is advisory only — undoChanges re-runs the partition at confirm time,
 * which remains the authoritative guard.
 */
function buildUndoSkipPreview(
  snapshots: UndoRecordSnapshot[],
  currentById: Map<number, Record>,
): UndoSkipPreview {
  const { restorable, stale, missing } = partitionUndoSnapshots(snapshots, currentById);
  return {
    restorableCount: restorable.length,
    stale: stale.map(({ id, changedFields }) => ({
      id,
      identifier: currentById.get(id)?.inputString || `Record #${id}`,
      changedFields,
    })),
    missing: missing.map((id) => ({ id })),
  };
}

/**
 * Joins new text onto an existing text value for append/prepend actions.
 * The empty-value guard lives here (and ONLY here): when the existing value
 * is empty, no newline separator is added, so empty notes never gain a
 * stray blank line. Both the preview column and applyChanges must use this.
 */
function applyTextJoin(type: 'append' | 'prepend', existing: string | undefined | null, value: string): string {
  const current = existing || '';
  if (!current) return value;
  return type === 'append' ? current + '\n' + value : value + '\n' + current;
}

/**
 * Whether an action type may be offered for a given field definition.
 * Append/Prepend are text-only; Add/Remove are array-only.
 */
function isActionTypeAllowedForField(actionType: ActionType, fieldDef: FieldDef | undefined): boolean {
  if (actionType === 'attach_file') return true;
  if (actionType === 'add' || actionType === 'remove') {
    return fieldDef?.type === 'array';
  }
  if (actionType === 'append' || actionType === 'prepend') {
    return fieldDef?.type === 'text';
  }
  return true;
}

export type { FieldType, FieldDef, Operator, ActionType, FilterCondition, ActionDef, UndoSnapshot, UndoRecordSnapshot, UndoPartitionResult, UndoSkipPreview };
export { FIELD_DEFS, OPERATORS, ACTION_TYPES, applyTextJoin, isActionTypeAllowedForField, undoValuesEquivalent, partitionUndoSnapshots, buildUndoSkipPreview };

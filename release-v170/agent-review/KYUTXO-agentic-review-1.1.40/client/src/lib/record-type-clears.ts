import type { Record as DbRecord } from './db-types';

// Type-specific metadata clearing when a record's Type is switched.
//
// The edit form only renders the metadata section matching the current type
// (RecordFormDialog: "Transaction Details" for 'transaction', "Acquisition &
// Provenance" for 'address', neither for 'other'), so after a Type switch the
// now-hidden fields would silently persist and could surface in reports and
// exports. Mirror the form's per-type field groupings here and clear whatever
// the new type can no longer show/edit:
//   - transaction-only: flowType, dispositionType
//   - address-only:     counterpartyType, counterpartyName
//   - shared by address AND transaction (intentionally retained across a
//     switch between those two): acquisitionMethod, costBasisUsd — both
//     sections render these fields, so the value stays visible and editable.
//   - 'other' renders none of them, so all six are cleared.
// Returned undefined values overwrite the merged row in updateRecord and are
// dropped by IndexedDB's structured clone, i.e. the fields are truly removed.
//
// This mapping is also the single source of truth for the Database Doctor's
// stale-field scan/repair (records whose Type was switched BEFORE this
// clearing existed still carry orphaned values) — keep the two in lockstep by
// changing only this function.
export type TypeSpecificClearField =
  | 'flowType'
  | 'acquisitionMethod'
  | 'dispositionType'
  | 'costBasisUsd'
  | 'counterpartyType'
  | 'counterpartyName';

export function getTypeSwitchClears(
  newType: DbRecord['type'],
): Partial<Pick<DbRecord, TypeSpecificClearField>> {
  if (newType === 'transaction') {
    return { counterpartyType: undefined, counterpartyName: undefined };
  }
  if (newType === 'address') {
    return { flowType: undefined, dispositionType: undefined };
  }
  // 'other' has no type-specific metadata sections at all.
  return {
    flowType: undefined,
    acquisitionMethod: undefined,
    dispositionType: undefined,
    costBasisUsd: undefined,
    counterpartyType: undefined,
    counterpartyName: undefined,
  };
}

// A stored value counts as "present" (and therefore stale when its key is in
// the clear-set for the row's type) when it is not undefined/null and not a
// blank string. Numbers (costBasisUsd) count whenever defined — 0 is a real
// user-entered cost basis.
function hasValue(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  return true;
}

/**
 * The exact detection predicate behind the Database Doctor's "stale
 * type-specific fields" scan and repair: which of the row's stored
 * type-specific metadata fields the row's CURRENT type can no longer
 * show/edit (per getTypeSwitchClears). Empty array = healthy row.
 */
export function getStaleTypeSpecificFields(
  row: Partial<Pick<DbRecord, TypeSpecificClearField>> & { type?: unknown },
): TypeSpecificClearField[] {
  const type = row.type;
  if (type !== 'address' && type !== 'transaction' && type !== 'other') return [];
  const clears = getTypeSwitchClears(type);
  const stale: TypeSpecificClearField[] = [];
  for (const key of Object.keys(clears) as TypeSpecificClearField[]) {
    if (hasValue((row as globalThis.Record<string, unknown>)[key])) stale.push(key);
  }
  return stale;
}

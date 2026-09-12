// Pure helpers for the Quick Tagger's single-mode (Addresses OR Transactions) behavior.
// The page component delegates classification, field visibility, and payload
// construction to these functions so they can be unit tested in isolation.

export type TaggerMode = 'address' | 'transaction';
export type EntryType = 'address' | 'transaction' | 'invalid';

/** How an entry relates to the currently active mode. */
export type EntryModeStatus = 'match' | 'mismatch' | 'invalid';

export function classifyForMode(type: EntryType, mode: TaggerMode): EntryModeStatus {
  if (type === 'invalid') return 'invalid';
  return type === mode ? 'match' : 'mismatch';
}

/** Shared fields that make no sense for transaction records (address-centric). */
export const TRANSACTION_HIDDEN_SHARED_FIELDS = [
  'walletName',
  'seedName',
  'walletSoftware',
  'privateKeyStatus',
] as const;

export type SharedField =
  | 'tags'
  | 'categories'
  | 'owner'
  | 'walletName'
  | 'seedName'
  | 'walletSoftware'
  | 'privateKeyStatus'
  | 'label'
  | 'notes';

export function isSharedFieldVisible(field: SharedField, mode: TaggerMode): boolean {
  if (mode === 'transaction') {
    return !(TRANSACTION_HIDDEN_SHARED_FIELDS as readonly string[]).includes(field);
  }
  return true;
}

export interface MetadataValues {
  selectedTags: string[];
  selectedCategories: string[];
  owner: string;
  walletName: string;
  seedName: string;
  walletSoftware: string;
  privateKeyStatus: string;
  label: string;
  notes: string;
  // Address-only
  addressImportance: string;
  counterpartyType: string;
  // Transaction-only
  flowType: string;
  acquisitionMethod: string;
  dispositionType: string;
  costBasisUsd: string;
}

/**
 * Build the update payload for an existing record. Only includes fields that
 * are set AND applicable to the active mode — never fields of the other type,
 * and never address-centric shared fields in transaction mode.
 */
export function buildUpdateData(mode: TaggerMode, v: MetadataValues): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  if (v.selectedTags.length > 0) data.tags = v.selectedTags;
  if (v.selectedCategories.length > 0) data.categories = v.selectedCategories;
  if (v.owner) data.owner = v.owner;
  if (v.label) data.label = v.label;
  if (v.notes) data.notes = v.notes;

  if (mode === 'address') {
    if (v.walletName) data.walletName = v.walletName;
    if (v.seedName) data.seedName = v.seedName;
    if (v.walletSoftware) data.walletSoftware = v.walletSoftware;
    if (v.privateKeyStatus) data.privateKeyStatus = v.privateKeyStatus;
    if (v.addressImportance) data.addressImportance = v.addressImportance;
    if (v.counterpartyType) data.counterpartyType = v.counterpartyType;
  } else {
    if (v.flowType) data.flowType = v.flowType;
    if (v.acquisitionMethod) data.acquisitionMethod = v.acquisitionMethod;
    if (v.dispositionType) data.dispositionType = v.dispositionType;
    if (v.costBasisUsd) data.costBasisUsd = parseFloat(v.costBasisUsd);
  }

  return data;
}

/**
 * Build the field payload for creating a new record of the active mode's type.
 * Mode-inapplicable fields are always undefined.
 */
export function buildCreateFields(mode: TaggerMode, v: MetadataValues): Record<string, unknown> {
  const isAddress = mode === 'address';
  return {
    type: mode,
    label: v.label || "",
    notes: v.notes || "",
    tags: v.selectedTags,
    categories: v.selectedCategories,
    owner: v.owner || undefined,
    walletName: isAddress ? (v.walletName || undefined) : undefined,
    seedName: isAddress ? (v.seedName || undefined) : undefined,
    walletSoftware: isAddress ? (v.walletSoftware || undefined) : undefined,
    privateKeyStatus: isAddress ? (v.privateKeyStatus || undefined) : undefined,
    addressImportance: isAddress ? (v.addressImportance || 'manual') : undefined,
    counterpartyType: isAddress ? (v.counterpartyType || undefined) : undefined,
    flowType: !isAddress ? (v.flowType || undefined) : undefined,
    acquisitionMethod: !isAddress ? (v.acquisitionMethod || undefined) : undefined,
    dispositionType: !isAddress ? (v.dispositionType || undefined) : undefined,
    costBasisUsd: !isAddress && v.costBasisUsd ? parseFloat(v.costBasisUsd) : undefined,
  };
}

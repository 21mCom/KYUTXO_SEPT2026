import type { Record } from "@/lib/database";
import {
  FLOW_TYPE_OPTIONS,
  COUNTERPARTY_TYPE_OPTIONS,
  ACQUISITION_METHOD_OPTIONS,
  DISPOSITION_TYPE_OPTIONS,
} from "@/lib/database";

type FieldType = 'text' | 'select' | 'array' | 'enum';

interface FieldDef {
  key: keyof Record;
  label: string;
  type: FieldType;
  options?: { value: string; label: string }[];
  vocabularyKey?: 'owners' | 'walletNames' | 'seedNames' | 'walletSoftware' | 'tags' | 'categories';
}

const ADDRESS_IMPORTANCE_OPTIONS = [
  { value: 'verified', label: 'Verified' },
  { value: 'manual', label: 'Manual' },
  { value: 'wallet-import', label: 'Wallet Import' },
  { value: 'xpub-derived', label: 'XPUB Derived' },
  { value: 'blockchain-discovered', label: 'Blockchain Discovered' },
  { value: 'pending-review', label: 'Pending Review' },
];

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

type ActionType = 'set' | 'add' | 'remove' | 'clear';

const ACTION_TYPES: { value: ActionType; label: string; description: string }[] = [
  { value: 'set', label: 'Set', description: 'Replace the value' },
  { value: 'add', label: 'Add', description: 'Add to array (tags/categories)' },
  { value: 'remove', label: 'Remove', description: 'Remove from array (tags/categories)' },
  { value: 'clear', label: 'Clear', description: 'Set to empty' },
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
}

interface UndoSnapshot {
  timestamp: number;
  recordSnapshots: { id: number; before: Partial<Record> }[];
  description: string;
  recordCount: number;
  actionsApplied: { type: ActionType; field: string; value?: string }[];
}

export type { FieldType, FieldDef, Operator, ActionType, FilterCondition, ActionDef, UndoSnapshot };
export { FIELD_DEFS, OPERATORS, ACTION_TYPES };

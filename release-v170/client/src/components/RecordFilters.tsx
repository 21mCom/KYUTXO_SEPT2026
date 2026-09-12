import { useState, useMemo, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Filter, Plus, X, ChevronDown, ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import { UNASSIGNED_OWNER_OPTION, UNASSIGNED_OWNER_VALUE } from "@/lib/owner-constants";
import { type AddressImportance, ALL_IMPORTANCE_TIERS } from "@/lib/database";

export interface ColumnFilter {
  id: string;
  field: string;
  operator: string;
  value: string;
}

export interface FilterableField {
  key: string;
  label: string;
  type: 'text' | 'enum' | 'boolean' | 'array';
  options?: string[];
}

// Type/tags/categories/owner/wallet/seed are surfaced as dedicated controls
// (below) rather than through the generic field/operator/value builder, so a
// vault's record type or high-cardinality lists aren't filterable two
// different ways at once. They are still stored as ordinary ColumnFilter
// entries (under reserved ids, see TYPE_FILTER_ID/FACET_FILTER_ID) so every
// existing consumer of `filters`/`applyColumnFilters`/the residual predicate
// picks them up automatically.
const FILTERABLE_FIELDS: FilterableField[] = [
  { key: 'label', label: 'Label', type: 'text' },
  { key: 'inputString', label: 'Address/Txid', type: 'text' },
  { key: 'walletSoftware', label: 'Wallet Software', type: 'text' },
  { key: 'privateKeyStatus', label: 'Private Key', type: 'enum', options: ['has-private-key', 'no-private-key', 'unknown'] },
  { key: 'source', label: 'Source', type: 'text' },
  { key: 'addressImportance', label: 'Importance', type: 'enum', options: ALL_IMPORTANCE_TIERS },
  { key: 'chainType', label: 'Chain', type: 'enum', options: ['mainnet', 'testnet', 'signet', 'regtest'] },
  { key: 'hasNotes', label: 'Has Notes', type: 'boolean' },
];

const TEXT_OPERATORS = [
  { value: 'contains', label: 'contains' },
  { value: 'equals', label: 'equals' },
  { value: 'startsWith', label: 'starts with' },
  { value: 'endsWith', label: 'ends with' },
  { value: 'isEmpty', label: 'is empty' },
  { value: 'isNotEmpty', label: 'is not empty' },
];

const ENUM_OPERATORS = [
  { value: 'equals', label: 'is' },
  { value: 'notEquals', label: 'is not' },
  { value: 'isEmpty', label: 'is empty' },
  { value: 'isNotEmpty', label: 'is not empty' },
];

const ARRAY_OPERATORS = [
  { value: 'includes', label: 'includes' },
  { value: 'excludes', label: 'does not include' },
  { value: 'isEmpty', label: 'is empty' },
  { value: 'isNotEmpty', label: 'has any' },
];

const BOOLEAN_OPERATORS = [
  { value: 'isTrue', label: 'yes' },
  { value: 'isFalse', label: 'no' },
];

function getOperatorsForField(field: FilterableField) {
  switch (field.type) {
    case 'enum': return ENUM_OPERATORS;
    case 'array': return ARRAY_OPERATORS;
    case 'boolean': return BOOLEAN_OPERATORS;
    default: return TEXT_OPERATORS;
  }
}

function needsValueInput(operator: string): boolean {
  return !['isEmpty', 'isNotEmpty', 'isTrue', 'isFalse'].includes(operator);
}

// ---------------------------------------------------------------------------
// Record type ("kind") filter — the single canonical address/transaction/
// other set shared with the rest of the app. Stored as an ordinary equals
// ColumnFilter under a reserved id so the Dexie/engine fast paths (which
// pattern-match on field+operator, never on id) keep working unmodified.
// ---------------------------------------------------------------------------
export type RecordKindFilterValue = 'all' | 'address' | 'transaction' | 'other';

export const TYPE_FILTER_ID = 'facet-type';

export const TYPE_FILTER_LABELS: Record<RecordKindFilterValue, string> = {
  all: 'All Types',
  address: 'Bitcoin Addresses',
  transaction: 'Transactions',
  other: 'Other',
};

export function getTypeFilterValue(filters: ColumnFilter[]): RecordKindFilterValue {
  const entry = filters.find((f) => f.id === TYPE_FILTER_ID);
  if (entry?.value === 'address' || entry?.value === 'transaction' || entry?.value === 'other') {
    return entry.value;
  }
  return 'all';
}

export function setTypeFilterValue(filters: ColumnFilter[], value: RecordKindFilterValue): ColumnFilter[] {
  const rest = filters.filter((f) => f.id !== TYPE_FILTER_ID);
  if (value === 'all') return rest;
  return [...rest, { id: TYPE_FILTER_ID, field: 'type', operator: 'equals', value }];
}

// ---------------------------------------------------------------------------
// High-cardinality facets (tags/categories/owner/wallet/seed) — dedicated
// searchable multi-selects. Each is stored as a single ColumnFilter entry
// under a reserved id with the new 'isAnyOf' operator (JSON-encoded array of
// selected values), so `applyColumnFilters` / the residual predicate handle
// them exactly like any other column filter with zero extra plumbing.
// ---------------------------------------------------------------------------
export const FACET_KEYS = ['tags', 'categories', 'owner', 'walletName', 'seedName'] as const;
export type FacetKey = typeof FACET_KEYS[number];

export const FACET_FILTER_ID: Record<FacetKey, string> = {
  tags: 'facet-tags',
  categories: 'facet-categories',
  owner: 'facet-owner',
  walletName: 'facet-walletName',
  seedName: 'facet-seedName',
};

export const FACET_LABELS: Record<FacetKey, string> = {
  tags: 'Tag',
  categories: 'Category',
  owner: 'Owner',
  walletName: 'Wallet',
  seedName: 'Seed',
};
/** Stable filter token for records with no owner (not a vocabulary value). */
export { UNASSIGNED_OWNER_VALUE };

export function getFacetValues(filters: ColumnFilter[], key: FacetKey): string[] {
  const entry = filters.find((f) => f.id === FACET_FILTER_ID[key]);
  if (!entry) return [];
  try {
    const parsed = JSON.parse(entry.value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function setFacetValues(filters: ColumnFilter[], key: FacetKey, values: string[]): ColumnFilter[] {
  const rest = filters.filter((f) => f.id !== FACET_FILTER_ID[key]);
  if (values.length === 0) return rest;
  return [...rest, { id: FACET_FILTER_ID[key], field: key, operator: 'isAnyOf', value: JSON.stringify(values) }];
}

const RESERVED_FILTER_IDS = new Set<string>([TYPE_FILTER_ID, ...FACET_KEYS.map((k) => FACET_FILTER_ID[k])]);

export function isReservedFilterId(id: string): boolean {
  return RESERVED_FILTER_IDS.has(id);
}

/** The subset of `filters` the generic field/operator/value builder owns. */
export function genericFilters(filters: ColumnFilter[]): ColumnFilter[] {
  return filters.filter((f) => !isReservedFilterId(f.id));
}

/** Human-readable summary of a single generic column filter, e.g. `Label contains "foo"`. */
export function describeColumnFilter(filter: ColumnFilter): string {
  const field = FILTERABLE_FIELDS.find((f) => f.key === filter.field);
  const operators = field ? getOperatorsForField(field) : TEXT_OPERATORS;
  const operator = operators.find((op) => op.value === filter.operator);
  const label = field?.label ?? filter.field;
  const opLabel = operator?.label ?? filter.operator;
  return needsValueInput(filter.operator) ? `${label} ${opLabel} "${filter.value}"` : `${label} ${opLabel}`;
}

/** Total number of active record-type/facet/generic filters in `filters`. */
export function countActiveRecordFilters(filters: ColumnFilter[]): number {
  let count = getTypeFilterValue(filters) === 'all' ? 0 : 1;
  for (const key of FACET_KEYS) count += getFacetValues(filters, key).length;
  count += genericFilters(filters).length;
  return count;
}

interface FilterRowProps {
  filter: ColumnFilter;
  onUpdate: (filter: ColumnFilter) => void;
  onRemove: () => void;
  uniqueValues: Record<string, string[]>;
}

function FilterRow({ filter, onUpdate, onRemove, uniqueValues }: FilterRowProps) {
  const field = FILTERABLE_FIELDS.find(f => f.key === filter.field) || FILTERABLE_FIELDS[0];
  const operators = getOperatorsForField(field);
  const showValueInput = needsValueInput(filter.operator);
  
  const suggestions = useMemo(() => {
    if (field.options) return field.options;
    return uniqueValues[filter.field] || [];
  }, [field, filter.field, uniqueValues]);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Select
        value={filter.field}
        onValueChange={(value) => {
          const newField = FILTERABLE_FIELDS.find(f => f.key === value);
          const newOperators = newField ? getOperatorsForField(newField) : TEXT_OPERATORS;
          onUpdate({ ...filter, field: value, operator: newOperators[0].value, value: '' });
        }}
      >
        <SelectTrigger className="w-[140px]" data-testid={`select-filter-field-${filter.id}`}>
          <SelectValue placeholder="Field" />
        </SelectTrigger>
        <SelectContent>
          {FILTERABLE_FIELDS.map((f) => (
            <SelectItem key={f.key} value={f.key}>{f.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={filter.operator}
        onValueChange={(value) => onUpdate({ ...filter, operator: value })}
      >
        <SelectTrigger className="w-[130px]" data-testid={`select-filter-operator-${filter.id}`}>
          <SelectValue placeholder="Operator" />
        </SelectTrigger>
        <SelectContent>
          {operators.map((op) => (
            <SelectItem key={op.value} value={op.value}>{op.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {showValueInput && (
        field.type === 'enum' || (field.type === 'array' && suggestions.length > 0) ? (
          <Select
            value={filter.value}
            onValueChange={(value) => onUpdate({ ...filter, value })}
          >
            <SelectTrigger className="w-[180px]" data-testid={`select-filter-value-${filter.id}`}>
              <SelectValue placeholder="Select value..." />
            </SelectTrigger>
            <SelectContent>
              {suggestions.map((opt) => (
                <SelectItem key={opt} value={opt}>{opt}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            value={filter.value}
            onChange={(e) => onUpdate({ ...filter, value: e.target.value })}
            placeholder="Value..."
            className="w-[180px]"
            data-testid={`input-filter-value-${filter.id}`}
          />
        )
      )}

      <Button
        variant="ghost"
        size="icon"
        onClick={onRemove}
        data-testid={`button-remove-filter-${filter.id}`}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

export interface RecordFiltersTableColumns {
  tags?: boolean;
  categories?: boolean;
  owner?: boolean;
  walletName?: boolean;
  seedName?: boolean;
}

interface RecordFiltersProps {
  filters: ColumnFilter[];
  onFiltersChange: (filters: ColumnFilter[]) => void;
  uniqueValues: Record<string, string[]>;
  /** Optional column-visibility gating (Dashboard only — Records has no table-column settings). */
  tableColumns?: RecordFiltersTableColumns;
}

const FACET_UI: Record<FacetKey, { placeholder: string; searchPlaceholder: string; testId: string }> = {
  tags: { placeholder: 'Filter by tags...', searchPlaceholder: 'Search tags...', testId: 'select-tag-filter' },
  categories: { placeholder: 'Filter by category...', searchPlaceholder: 'Search categories...', testId: 'select-category-filter' },
  owner: { placeholder: 'Filter by owner...', searchPlaceholder: 'Search owners...', testId: 'select-owner-filter' },
  walletName: { placeholder: 'Filter by wallet...', searchPlaceholder: 'Search wallets...', testId: 'select-wallet-filter' },
  seedName: { placeholder: 'Filter by seed...', searchPlaceholder: 'Search seeds...', testId: 'select-seed-filter' },
};

/**
 * Single consolidated filter surface for Dashboard and Records: record type,
 * the high-cardinality facets (tags/categories/owner/wallet/seed — searchable
 * multi-selects), and the generic column-condition builder. Type and facets
 * are stored as reserved-id entries in the same `filters` array the generic
 * builder edits, so every caller only has to track one array.
 */
export function RecordFilters({ filters, onFiltersChange, uniqueValues, tableColumns }: RecordFiltersProps) {
  const generic = genericFilters(filters);
  const [isOpen, setIsOpen] = useState(generic.length > 0);

  const showFacet: Record<FacetKey, boolean> = {
    tags: tableColumns?.tags !== false,
    categories: tableColumns?.categories !== false,
    owner: tableColumns?.owner !== false,
    walletName: tableColumns?.walletName !== false,
    seedName: tableColumns?.seedName !== false,
  };

  // Mirrors the legacy FilterBar behavior: if a table column backing a facet
  // is toggled off while that facet has an active selection, clear it so the
  // filter can't silently keep narrowing on a hidden column.
  const prevShowFacet = useRef(showFacet);
  useEffect(() => {
    let next = filters;
    for (const key of FACET_KEYS) {
      if (prevShowFacet.current[key] && !showFacet[key] && getFacetValues(next, key).length > 0) {
        next = setFacetValues(next, key, []);
      }
    }
    if (next !== filters) onFiltersChange(next);
    prevShowFacet.current = showFacet;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showFacet.tags, showFacet.categories, showFacet.owner, showFacet.walletName, showFacet.seedName]);

  const addFilter = () => {
    const defaultField = FILTERABLE_FIELDS[0];
    const newFilter: ColumnFilter = {
      id: `filter-${Date.now()}`,
      field: defaultField.key,
      operator: getOperatorsForField(defaultField)[0].value,
      value: '',
    };
    onFiltersChange([...filters, newFilter]);
    setIsOpen(true);
  };

  const updateFilter = (id: string, updated: ColumnFilter) => {
    onFiltersChange(filters.map(f => f.id === id ? updated : f));
  };

  const removeFilter = (id: string) => {
    onFiltersChange(filters.filter(f => f.id !== id));
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={getTypeFilterValue(filters)}
          onValueChange={(value) => onFiltersChange(setTypeFilterValue(filters, value as RecordKindFilterValue))}
        >
          <SelectTrigger className="w-[160px]" data-testid="select-type-filter">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{TYPE_FILTER_LABELS.all}</SelectItem>
            <SelectItem value="address">{TYPE_FILTER_LABELS.address}</SelectItem>
            <SelectItem value="transaction">{TYPE_FILTER_LABELS.transaction}</SelectItem>
            <SelectItem value="other">{TYPE_FILTER_LABELS.other}</SelectItem>
          </SelectContent>
        </Select>

        {FACET_KEYS.map((key) => {
          const options = key === 'owner'
            ? [UNASSIGNED_OWNER_VALUE, ...(uniqueValues[key] || []).filter(v => v !== UNASSIGNED_OWNER_VALUE)]
            : (uniqueValues[key] || []);
          if (!showFacet[key] || options.length === 0) return null;
          const ui = FACET_UI[key];
          return (
            <div key={key} className="w-[180px]">
              <MultiSelectCombobox
                values={getFacetValues(filters, key)}
                onChange={(values) => onFiltersChange(setFacetValues(filters, key, values))}
                options={options}
                placeholder={ui.placeholder}
                searchPlaceholder={ui.searchPlaceholder}
                testId={ui.testId}
                optionLabels={key === 'owner' ? { [UNASSIGNED_OWNER_VALUE]: UNASSIGNED_OWNER_OPTION.label } : undefined}
              />
            </div>
          );
        })}
      </div>

      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <div className="flex items-center gap-2">
          <CollapsibleTrigger asChild>
            <Button variant="outline" size="sm" data-testid="button-toggle-filters">
              {isOpen ? <ChevronDown className="h-4 w-4 mr-1" /> : <ChevronRight className="h-4 w-4 mr-1" />}
              <Filter className="h-4 w-4 mr-1" />
              More Filters
              {generic.length > 0 && (
                <Badge variant="secondary" className="ml-2">{generic.length}</Badge>
              )}
            </Button>
          </CollapsibleTrigger>
          <Button
            variant="ghost"
            size="sm"
            onClick={addFilter}
            data-testid="button-add-filter"
          >
            <Plus className="h-4 w-4 mr-1" />
            Add Filter
          </Button>
        </div>

        <CollapsibleContent className="pt-3">
          {generic.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No column filters active. Click "Add Filter" to filter by label, address/txid, wallet software, private key status, source, importance, chain, or notes.
            </p>
          ) : (
            <div className="space-y-2">
              {generic.map((filter) => (
                <FilterRow
                  key={filter.id}
                  filter={filter}
                  onUpdate={(updated) => updateFilter(filter.id, updated)}
                  onRemove={() => removeFilter(filter.id)}
                  uniqueValues={uniqueValues}
                />
              ))}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

export function applyColumnFilters<T extends Record<string, unknown>>(
  records: T[],
  filters: ColumnFilter[]
): T[] {
  if (filters.length === 0) return records;

  return records.filter((record) => {
    return filters.every((filter) => {
      let value: unknown;
      
      if (filter.field === 'hasNotes') {
        value = Boolean(record.notes && String(record.notes).trim() !== '');
      } else {
        value = record[filter.field];
      }
      
      const normalizedFilterValue = filter.value?.toLowerCase().trim() || '';
      
      switch (filter.operator) {
        case 'contains':
          return String(value || '').toLowerCase().includes(normalizedFilterValue);
        case 'equals':
          return String(value || '').toLowerCase() === normalizedFilterValue;
        case 'notEquals':
          return String(value || '').toLowerCase() !== normalizedFilterValue;
        case 'startsWith':
          return String(value || '').toLowerCase().startsWith(normalizedFilterValue);
        case 'endsWith':
          return String(value || '').toLowerCase().endsWith(normalizedFilterValue);
        case 'isEmpty':
          if (Array.isArray(value)) return value.length === 0;
          return !value || String(value).trim() === '';
        case 'isNotEmpty':
          if (Array.isArray(value)) return value.length > 0;
          return Boolean(value) && String(value).trim() !== '';
        case 'includes':
          if (Array.isArray(value)) {
            return value.some(v => String(v).toLowerCase() === normalizedFilterValue);
          }
          return false;
        case 'excludes':
          if (Array.isArray(value)) {
            return !value.some(v => String(v).toLowerCase() === normalizedFilterValue);
          }
          return true;
        case 'isTrue':
          return Boolean(value);
        case 'isFalse':
          return !value;
        case 'isAnyOf': {
          let allowed: string[] = [];
          try {
            const parsed = JSON.parse(filter.value);
            if (Array.isArray(parsed)) allowed = parsed.filter((v): v is string => typeof v === 'string');
          } catch {
            allowed = [];
          }
          if (allowed.length === 0) return true;
          const normalizedAllowed = allowed.map((v) => v.toLowerCase());
          if (Array.isArray(value)) {
            return value.some((v) => normalizedAllowed.includes(String(v).toLowerCase()));
          }
          return normalizedAllowed.includes(String(value ?? '').toLowerCase());
        }
        default:
          return true;
      }
    });
  });
}

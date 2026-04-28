import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Filter, Plus, X, ChevronDown, ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { AddressImportance } from "@/lib/database";

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

const FILTERABLE_FIELDS: FilterableField[] = [
  { key: 'type', label: 'Type', type: 'enum', options: ['address', 'transaction', 'other'] },
  { key: 'label', label: 'Label', type: 'text' },
  { key: 'inputString', label: 'Address/Txid', type: 'text' },
  { key: 'owner', label: 'Owner', type: 'text' },
  { key: 'walletName', label: 'Wallet Name', type: 'text' },
  { key: 'seedName', label: 'Seed Name', type: 'text' },
  { key: 'walletSoftware', label: 'Wallet Software', type: 'text' },
  { key: 'privateKeyStatus', label: 'Private Key', type: 'enum', options: ['has-private-key', 'no-private-key', 'unknown'] },
  { key: 'tags', label: 'Tags', type: 'array' },
  { key: 'categories', label: 'Categories', type: 'array' },
  { key: 'source', label: 'Source', type: 'text' },
  { key: 'addressImportance', label: 'Importance', type: 'enum', options: ['verified', 'manual', 'wallet-import', 'xpub-derived', 'blockchain-discovered', 'pending-review'] as AddressImportance[] },
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

interface RecordFiltersProps {
  filters: ColumnFilter[];
  onFiltersChange: (filters: ColumnFilter[]) => void;
  uniqueValues: Record<string, string[]>;
}

export function RecordFilters({ filters, onFiltersChange, uniqueValues }: RecordFiltersProps) {
  const [isOpen, setIsOpen] = useState(filters.length > 0);

  const addFilter = () => {
    const newFilter: ColumnFilter = {
      id: `filter-${Date.now()}`,
      field: 'type',
      operator: 'equals',
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

  const clearAllFilters = () => {
    onFiltersChange([]);
  };

  return (
    <div className="space-y-2">
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <div className="flex items-center gap-2">
          <CollapsibleTrigger asChild>
            <Button variant="outline" size="sm" data-testid="button-toggle-filters">
              {isOpen ? <ChevronDown className="h-4 w-4 mr-1" /> : <ChevronRight className="h-4 w-4 mr-1" />}
              <Filter className="h-4 w-4 mr-1" />
              Filters
              {filters.length > 0 && (
                <Badge variant="secondary" className="ml-2">{filters.length}</Badge>
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
          {filters.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearAllFilters}
              data-testid="button-clear-filters"
            >
              Clear All
            </Button>
          )}
        </div>

        <CollapsibleContent className="pt-3">
          {filters.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No filters active. Click "Add Filter" to filter records by column values.
            </p>
          ) : (
            <div className="space-y-2">
              {filters.map((filter) => (
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

      {!isOpen && filters.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {filters.map((filter) => {
            const field = FILTERABLE_FIELDS.find(f => f.key === filter.field);
            const operators = field ? getOperatorsForField(field) : TEXT_OPERATORS;
            const operator = operators.find(op => op.value === filter.operator);
            return (
              <Badge 
                key={filter.id} 
                variant="secondary" 
                className="text-xs cursor-pointer"
                onClick={() => setIsOpen(true)}
              >
                {field?.label} {operator?.label} {needsValueInput(filter.operator) ? `"${filter.value}"` : ''}
                <X 
                  className="h-3 w-3 ml-1" 
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFilter(filter.id);
                  }}
                />
              </Badge>
            );
          })}
        </div>
      )}
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
        default:
          return true;
      }
    });
  });
}


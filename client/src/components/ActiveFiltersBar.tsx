import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  type ColumnFilter,
  FACET_KEYS,
  FACET_LABELS,
  TYPE_FILTER_LABELS,
  countActiveRecordFilters,
  describeColumnFilter,
  genericFilters,
  getFacetValues,
  getTypeFilterValue,
  setFacetValues,
  setTypeFilterValue,
  UNASSIGNED_OWNER_VALUE,
} from "@/components/RecordFilters";

interface ActiveFiltersBarProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  filters: ColumnFilter[];
  onFiltersChange: (filters: ColumnFilter[]) => void;
  /** Count contributed by page-specific filters (e.g. Records' date-added / behavior). */
  extraActiveCount?: number;
  /** Resets page-specific filters (e.g. Records' date-added / behavior) as part of "Clear all". */
  onClearExtra?: () => void;
}

/**
 * Unified "how many filters are active" summary + single Clear-all control +
 * removable-chip row, shared by Dashboard and Records. Search text, record
 * type, every selected tag/category/owner/wallet/seed value, and every
 * generic column condition each render as one Badge+X chip in the same
 * style DateAddedFilter/BehaviorFilter already use for their own chips.
 */
export function ActiveFiltersBar({
  searchValue,
  onSearchChange,
  filters,
  onFiltersChange,
  extraActiveCount = 0,
  onClearExtra,
}: ActiveFiltersBarProps) {
  const searchActive = searchValue.trim() !== "";
  const typeValue = getTypeFilterValue(filters);
  const generic = genericFilters(filters);
  const totalActive = countActiveRecordFilters(filters) + (searchActive ? 1 : 0) + extraActiveCount;

  const clearAll = () => {
    onSearchChange("");
    onFiltersChange([]);
    onClearExtra?.();
  };

  const removeFacetValue = (key: (typeof FACET_KEYS)[number], value: string) => {
    const current = getFacetValues(filters, key);
    onFiltersChange(setFacetValues(filters, key, current.filter((v) => v !== value)));
  };

  const hasChips = searchActive || typeValue !== "all" || generic.length > 0 ||
    FACET_KEYS.some((key) => getFacetValues(filters, key).length > 0);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm text-muted-foreground" data-testid="text-active-filter-count">
          {totalActive} {totalActive === 1 ? "filter" : "filters"} active
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={clearAll}
          disabled={totalActive === 0}
          data-testid="button-clear-all-filters"
        >
          <X className="h-4 w-4 mr-1" />
          Clear all filters
        </Button>
      </div>

      {hasChips && (
        <div className="flex flex-wrap gap-1">
          {searchActive && (
            <Badge
              variant="secondary"
              className="text-xs cursor-pointer"
              onClick={() => onSearchChange("")}
              data-testid="chip-search"
            >
              Search: "{searchValue}"
              <X className="h-3 w-3 ml-1" />
            </Badge>
          )}

          {typeValue !== "all" && (
            <Badge
              variant="secondary"
              className="text-xs cursor-pointer"
              onClick={() => onFiltersChange(setTypeFilterValue(filters, "all"))}
              data-testid="chip-type-filter"
            >
              Type: {TYPE_FILTER_LABELS[typeValue]}
              <X className="h-3 w-3 ml-1" />
            </Badge>
          )}

          {FACET_KEYS.map((key) =>
            getFacetValues(filters, key).map((value) => (
              <Badge
                key={`${key}-${value}`}
                variant="secondary"
                className="text-xs cursor-pointer"
                onClick={() => removeFacetValue(key, value)}
                data-testid={`chip-facet-${key}`}
              >
                {FACET_LABELS[key]}: {key === 'owner' && value === UNASSIGNED_OWNER_VALUE ? 'Unassigned' : value}
                <X className="h-3 w-3 ml-1" />
              </Badge>
            )),
          )}

          {generic.map((filter) => (
            <Badge
              key={filter.id}
              variant="secondary"
              className="text-xs cursor-pointer"
              onClick={() => onFiltersChange(filters.filter((f) => f.id !== filter.id))}
              data-testid={`chip-column-filter-${filter.id}`}
            >
              {describeColumnFilter(filter)}
              <X className="h-3 w-3 ml-1" />
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
